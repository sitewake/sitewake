/**
 * The real PageAgent run. Only the input file is written by hand.
 *
 * This is a smaller harness than the user Agent's, and deliberately so. It
 * does not load the widget, does not create a task session, does not decide a
 * route and does not compose an answer. It loads exactly one bundle — the
 * shipped `public/sitewake-adaptive.js` — and calls the same entry point the
 * production port calls:
 *
 *     window.SiteWakeAdaptive.run(options) -> { success, text, output, episode }
 *
 * Everything PageAgent needs arrives through that options object and nothing
 * else, which is why this unit exists at all: the boundary is already real.
 *
 * Two things the input file does not carry, because they belong to the
 * environment rather than to the task:
 *
 *   - the control plane, which is the production `app/api/**` handlers running
 *     in this process on memory stores (see control-plane.ts);
 *   - an AgentRun, because PageAgent's model requests authenticate with a run
 *     token and every request is charged to that run's model budget. The run
 *     is created here through the real endpoint, and is host plumbing — it is
 *     not part of what PageAgent produces, so it is not in the output.
 */
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { PageAgentObservation, TaskEpisode } from "../site-knowledge/protocol";
import type { PageAgentModuleInput, PageAgentModuleOutput, PageAgentResult } from "./module-contract";
import { PAGE_AGENT_MODULE_SCHEMA_VERSION } from "./module-contract";
import { startModuleControlPlane } from "./control-plane";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/**
 * Served to the page from this origin. It has to be HTTPS: a real site is
 * HTTPS, and a browser refuses to load a script or run a fetch from an HTTP
 * origin on an HTTPS page. Nothing is ever sent to this host — every request
 * is intercepted and forwarded to the in-process server, so no certificate and
 * no real DNS name are involved.
 */
const CONTROL_PLANE_ORIGIN = "https://sitewake-control-plane.invalid";
/** Only for the reachability probe; the run itself uses Chromium's own. */
const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
/** Where `browserSessionId()` looks. Keeping the original spelling is deliberate. */
const BROWSER_SESSION_KEY = "sitewake:v5:browser-session";
const DEFAULT_MAX_STEPS = 24;

export type PageAgentRunOptions = {
  headed?: boolean;
  timeoutMs?: number;
  port?: number;
  onProgress?: (message: string) => void;
};

/**
 * NOT module output — how this particular run was performed. Nothing here is
 * handed to the caller, the capability centre or the evidence store. The CLI
 * prints it; it never reaches the output file.
 */
export type PageAgentRunDiagnostics = {
  implementation: "real";
  browser: string;
  model: { source: string; model: string };
  controlPlane: "in-process-production-routes";
  /** The host plumbing this run borrowed. Proof the model requests were charged. */
  agentRunId: string;
  /** Which tools the case's `services` left available to the model. */
  services: { askUser: boolean };
  startedAt: string;
  endedAt: string;
  durationMs: number;
  modelCalls: Array<{ stage: string; status: number; durationMs: number }>;
  /** Control-plane requests that were rejected. Empty is the healthy case. */
  failures: Array<{ method: string; path: string; status: number; detail: string }>;
};

export type PageAgentRealRun = { output: PageAgentModuleOutput; diagnostics: PageAgentRunDiagnostics };

/** The one argument crossing into the page. Flat on purpose — see its use site. */
type PageAgentCall = {
  siteAgentId: string;
  endpoint: string;
  agentRunToken: string;
  runId: string;
  maxSteps: number;
  goal: string;
  input: Record<string, unknown>;
  conversation: unknown[];
  release: Record<string, unknown>;
  brief: unknown;
  budget: unknown;
  runtimeMode: "full" | "read-only";
  readOnlySource?: "site-config" | "runtime-derived";
  requiredActionEvidence?: "material" | "input";
  runtimeV2: boolean;
  evidenceV2: boolean;
  askUserAnswer?: string;
};

/**
 * Preconditions belong to the environment, not to the module input. Each one
 * is reported as the single sentence that tells the operator what to fix.
 */
async function assertReady(url: string) {
  await access(resolve(root, "public/sitewake-adaptive.js")).catch(() => {
    throw new Error("PageAgent 包还没构建：先运行 npm run sdk:build。");
  });
  const { getModelConfig } = await import("../model-config");
  const model = getModelConfig("execution");
  if (!model.configured) {
    throw new Error("模型 API 没配置好，请先配置 API：在 .env.local 配置 OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL，然后用 npm run check:model-compat 确认页面执行阶段通过。");
  }
  try {
    // Any HTTP answer means the host is up; Chromium does the real navigation
    // and is what decides whether the page loads. A site behind UA filtering
    // answers this probe with 403 while opening perfectly in a real browser.
    await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: "follow", headers: { "user-agent": BROWSER_USER_AGENT } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`目标站点打不开：${url}（${detail}）。先把它跑起来，或改输入里的 request.url。`);
  }
  return model;
}

export async function runPageAgentModuleForReal(
  input: PageAgentModuleInput,
  options: PageAgentRunOptions = {},
): Promise<PageAgentRealRun> {
  const progress = options.onProgress || (() => {});
  const timeoutMs = options.timeoutMs || 180_000;
  const model = await assertReady(input.request.url);

  const plane = await startModuleControlPlane({
    siteAgentId: input.release.siteAgentId,
    url: input.request.url,
    origin: input.request.origin,
    visibility: input.runtime?.visibility,
    runtimeFeatures: {
      pageAgentRuntimeV2: input.runtime?.runtimeV2 !== false,
      pageAgentEvidenceV2: input.runtime?.evidenceV2 !== false,
      capabilityExperienceOutbox: true,
    },
    release: { id: input.release.id, profile: input.release.profile, scenes: input.release.scenes },
  }, { port: options.port });
  progress(`控制面（生产路由 · 内存存储）: ${plane.origin}`);

  const browser = await chromium.launch({ headless: !options.headed });
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const pageErrors: string[] = [];
  /** A bare timeout says nothing. Hand back what the run actually produced. */
  const diagnose = (error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    const rejected = plane.capture.failures.map((item) => `${item.status} ${item.method} ${item.path} ${item.detail.slice(0, 160)}`);
    return new Error([
      reason,
      `模型请求 ${plane.capture.modelCalls.length} 次`,
      rejected.length ? `控制面拒绝的请求：\n  ${rejected.join("\n  ")}` : "控制面没有拒绝任何请求",
      pageErrors.length ? `页面报错：\n  ${[...new Set(pageErrors)].slice(0, 6).join("\n  ")}` : "页面没有报错",
    ].join("\n"));
  };

  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    // The callbacks below are handed to PageAgent from inside `page.evaluate`,
    // which means this file's own source is serialised into the browser. tsx
    // compiles it with esbuild's keepNames on, so every arrow function assigned
    // to a property arrives wrapped in an `__name(...)` helper that only exists
    // back in Node. Injected as a literal string so the shim itself cannot be
    // rewritten into the very call it is there to satisfy.
    await context.addInitScript({ content: "globalThis.__name = globalThis.__name || function (value) { return value; };" });
    await context.addInitScript(() => {
      if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: {} });
      if (!globalThis.crypto.randomUUID) {
        globalThis.crypto.randomUUID = () => `run-${Date.now()}-${Math.random().toString(36).slice(2)}` as `${string}-${string}-${string}-${string}-${string}`;
      }
    });
    await context.route(`${CONTROL_PLANE_ORIGIN}/**`, async (route) => {
      const request = route.request();
      const target = new URL(request.url());
      const body = request.postData();
      try {
        const response = await fetch(`${plane.origin}${target.pathname}${target.search}`, {
          method: request.method(),
          headers: request.headers(),
          body: body ?? undefined,
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          // The body is delivered whole; the upstream framing headers no longer describe it.
          if (name === "content-encoding" || name === "content-length" || name === "transfer-encoding") return;
          headers[name] = value;
        });
        await route.fulfill({ status: response.status, headers, body: buffer });
      } catch (error) {
        await route.fulfill({
          status: 502,
          headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
          body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        });
      }
    });

    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 300)));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(`console: ${message.text().slice(0, 300)}`);
    });
    await page.goto(input.request.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    progress(`已打开页面: ${input.request.url}`);

    // The browser derives both identifiers itself — `browserSessionId()` from
    // localStorage, `documentId()` from a window property. Setting them here,
    // on this document only, means the AgentRun created below describes the
    // same browser and the same page PageAgent will report in its Episode. A
    // navigation mid-run correctly produces a fresh document id, exactly as in
    // production.
    const browserSessionId = `browser_unit_${Date.now().toString(36)}`;
    const documentId = `document_unit_${Date.now().toString(36)}`;
    await page.evaluate(([key, session, document]) => {
      try { localStorage.setItem(key, session); } catch { /* private mode */ }
      (window as typeof window & { __SITEWAKE_DOCUMENT_ID__?: string }).__SITEWAKE_DOCUMENT_ID__ = document;
    }, [BROWSER_SESSION_KEY, browserSessionId, documentId] as const);

    // Host plumbing, through the real endpoint. PageAgent authenticates its
    // model requests with this token and every request is charged to this run.
    const created = await fetch(`${plane.origin}/api/agent-runs`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: input.request.origin },
      body: JSON.stringify({
        siteAgentId: input.release.siteAgentId,
        origin: input.request.origin,
        url: input.request.url,
        goal: input.request.goal,
        input: input.request.input,
        conversation: input.request.conversation,
        documentId,
        browserSessionId,
        controller: "page-agent",
      }),
    });
    if (!created.ok) throw diagnose(new Error(`宿主的 AgentRun 建不起来：${created.status} ${(await created.text()).slice(0, 300)}`));
    const run = await created.json() as { run: { id: string }; resumeToken: string };
    progress(`宿主 AgentRun: ${run.run.id}`);

    const observations: PageAgentObservation[] = [];
    await page.exposeFunction("__unitObservation", (observation: PageAgentObservation) => {
      observations.push(observation);
    });

    await page.evaluate(async (endpoint) => {
      await new Promise<void>((ready, failed) => {
        const script = document.createElement("script");
        script.src = `${endpoint}/sitewake-adaptive.js`;
        script.onload = () => ready();
        script.onerror = () => failed(new Error("adaptive_bundle_load_failed"));
        document.head.appendChild(script);
      });
    }, CONTROL_PLANE_ORIGIN);
    await page.waitForFunction(() => Boolean((window as unknown as { SiteWakeAdaptive?: unknown }).SiteWakeAdaptive), undefined, { timeout: 20_000 });
    progress("PageAgent 已就绪，开始在页面上执行");

    // Typed explicitly: Playwright infers the evaluate argument structurally,
    // and a Release-shaped literal is deep enough to blow its instantiation limit.
    const call: PageAgentCall = {
      siteAgentId: input.release.siteAgentId,
      endpoint: CONTROL_PLANE_ORIGIN,
      agentRunToken: run.resumeToken,
      runId: run.run.id,
      maxSteps: input.runtime?.maxSteps || DEFAULT_MAX_STEPS,
      goal: input.request.goal,
      input: input.request.input,
      conversation: input.request.conversation,
      // The Release the control plane stored, not a hand-assembled one. The
      // input states the knowledge; the store is what fills in the structural
      // fields a runtime Release must carry (scene verifiers, evidence status,
      // link references) — exactly as it does for a real browser.
      release: {
        ...(plane.release as unknown as Record<string, unknown>),
        ...(input.release.targets ? { targets: input.release.targets } : {}),
        ...(input.release.capabilities ? { capabilities: input.release.capabilities } : {}),
      },
      brief: input.execution.brief,
      budget: input.execution.budget,
      runtimeMode: input.runtime?.mode === "read-only" ? "read-only" as const : "full" as const,
      readOnlySource: input.runtime?.readOnlySource,
      requiredActionEvidence: input.runtime?.requiredActionEvidence,
      runtimeV2: input.runtime?.runtimeV2 !== false,
      evidenceV2: input.runtime?.evidenceV2 !== false,
      askUserAnswer: input.services?.askUser?.answer,
    };

    const finished = await Promise.race([
      page.evaluate(async (options) => {
        const adaptive = (window as unknown as {
          SiteWakeAdaptive: { run(config: Record<string, unknown>): Promise<Record<string, unknown>> };
        }).SiteWakeAdaptive;
        const bridge = window as unknown as { __unitObservation: (observation: unknown) => void };
        const result = await adaptive.run({
          siteAgentId: options.siteAgentId,
          endpoint: options.endpoint,
          agentRunToken: options.agentRunToken,
          maxSteps: options.maxSteps,
          goal: options.goal,
          input: options.input,
          release: options.release,
          // PageAgent reads only `id` and `conversation` off the session; the
          // id must be the AgentRun's, because that is what the Episode files
          // itself under.
          session: { id: options.runId, conversation: options.conversation },
          mode: "adaptive",
          runtimeMode: options.runtimeMode,
          readOnlySource: options.readOnlySource,
          requiredActionEvidence: options.requiredActionEvidence,
          runtimeV2: options.runtimeV2,
          evidenceV2: options.evidenceV2,
          pageExecutionBrief: options.brief,
          pageExecutionBudget: options.budget,
          // Declared services. Omitting a callback withdraws the tool, which is
          // exactly what the real host does when it does not pass one.
          ...(options.askUserAnswer === undefined ? {} : {
            onAskUser: async () => options.askUserAnswer as string,
          }),
          // Always no. Saying yes means "I will carry this task onto the next
          // document", which only a host can do — PageAgent parks the instant
          // it hears yes. A unit has no host, so it never claims to be one.
          onNavigateAction: async () => false,
          onObservation: (observation: unknown) => { bridge.__unitObservation(observation); },
        });
        return JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
      }, call),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("PageAgent 一直没有返回")), timeoutMs)),
    ]).catch((error) => { throw diagnose(error); });

    const episode = finished.episode as TaskEpisode | undefined;
    if (!episode) throw diagnose(new Error("PageAgent 返回了结果但没有 Episode"));
    progress(`完成: ${episode.outcome?.status} · ${observations.length} 个观察`);

    return {
      output: {
        schemaVersion: PAGE_AGENT_MODULE_SCHEMA_VERSION,
        result: {
          success: Boolean(finished.success),
          text: String(finished.text || ""),
          output: (finished.output || {}) as PageAgentResult["output"],
        },
        episode,
        evidence: { observations },
      },
      diagnostics: {
        implementation: "real",
        browser: `chromium ${browser.version()}`,
        model: { source: model.source, model: model.model },
        controlPlane: "in-process-production-routes",
        agentRunId: run.run.id,
        services: { askUser: input.services?.askUser !== undefined },
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        modelCalls: plane.capture.modelCalls,
        failures: plane.capture.failures,
      },
    };
  } finally {
    await browser.close().catch(() => undefined);
    await plane.close().catch(() => undefined);
  }
}

/** Read one module input file. Exported so the CLI and tests share the parse. */
export async function readPageAgentInput(path: string) {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(path, "utf8")) as PageAgentModuleInput;
}
