// Codex CLI authoring driver (container authoring-worker only).
//
// This is the real agentic-coding integration required by the redesign: the
// *coding* is performed by the OpenAI Codex CLI, while the deterministic
// AuthoringHarness owns everything that must never be flaky — bundling, running
// the capability against the live page, the fixtures, the self-verification
// gate and delivery. Codex edits files in a materialized workspace; the harness
// runs them and feeds structured results back for the next round.
//
// The CLI invocation is injected (CodexRunner) so the entire driver loop is
// unit-testable with a scripted runner, isolating Codex's non-determinism.
//
// Runtime scope: this needs a filesystem and a child process, so it runs only
// in the container authoring-worker.

import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm, stat, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { CodingAgentDriver, AuthoringHarness, AuthoringSessionContext } from "../lib/site-knowledge/authoring-harness";
import type { CodingAgentKind, AuthoringWorkspaceFile, JsonValue } from "../lib/site-knowledge/protocol";
import { ENTRY_PATH, FIXTURES_PATH, WORKSPACE_LIMITS, normalizeVfsPath } from "../lib/site-knowledge/authoring-workspace";

export type CodexRunner = (args: {
  dir: string;
  prompt: string;
  model?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  sandbox?: "workspace-write" | "danger-full-access";
}) => Promise<{ ok: boolean; output?: string; error?: string }>;

export type CodexDriverOptions = {
  runCodex?: CodexRunner;
  rounds?: number;
  model?: string;
  codexBin?: string;
  seedObservation?: boolean;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxToolCalls?: number;
  seedSource?: string;
  signal?: AbortSignal;
};

export type CodexProviderConfig = { model: string; baseUrl: string; apiKeyEnv: string };

export function resolveCodexProviderConfig(env: Record<string, string | undefined>): CodexProviderConfig | undefined {
  // Behind the control plane's internal model proxy (lib/model-config.ts) the
  // runner has no provider key: Codex presents the internal token, and the
  // control plane substitutes the real model name on the way through.
  const proxy = (env.SITEWAKE_MODEL_PROXY_URL || "").trim().replace(/\/+$/, "");
  if (proxy) {
    if (!(env.CAPABILITY_V2_DISPATCH_TOKEN || "").trim()) return undefined;
    return { model: "proxy", baseUrl: `${proxy}/execution/v1`, apiKeyEnv: "CAPABILITY_V2_DISPATCH_TOKEN" };
  }
  // Same precedence as lib/model-config.ts: MODEL_* is canonical, OPENAI_* is
  // the read-only alias. The authoring runner uses the execution tier.
  const model = (env.MODEL_EXECUTION || env.MODEL || env.OPENAI_MODEL || "").trim();
  const configuredBaseUrl = (env.MODEL_BASE_URL || env.OPENAI_BASE_URL || "").trim().replace(/\/$/, "");
  const apiKey = (env.MODEL_API_KEY || env.OPENAI_API_KEY || "").trim();
  if (!model || !configuredBaseUrl || !apiKey) return undefined;
  // SiteWake accepts gateway roots and appends `/v1` in its normal model
  // client. Preserve provider-specific versioned endpoints such as Ark's
  // `/api/coding/v3`; Codex expects the provider base URL to already include
  // the version segment.
  const baseUrl = /\/v\d+$/i.test(configuredBaseUrl) ? configuredBaseUrl : `${configuredBaseUrl}/v1`;
  return { model, baseUrl, apiKeyEnv: "MODEL_API_KEY" };
}

const toml = (value: string) => JSON.stringify(value);

export function buildCodexConfig(provider: CodexProviderConfig, mcp: { command: string; args: string[]; bridgeUrl: string; bridgeToken: string }): string {
  return [
    `model = ${toml(provider.model)}`,
    `model_provider = "sitewake"`,
    ``,
    `[model_providers.sitewake]`,
    `name = "SiteWake OpenAI-compatible model gateway"`,
    `base_url = ${toml(provider.baseUrl)}`,
    `env_key = ${toml(provider.apiKeyEnv)}`,
    `wire_api = "responses"`,
    ``,
    `[mcp_servers.sitewake_authoring]`,
    `command = ${toml(mcp.command)}`,
    `args = [${mcp.args.map(toml).join(", ")}]`,
    `env = { SITEWAKE_AUTHORING_BRIDGE_URL = ${toml(mcp.bridgeUrl)}, SITEWAKE_AUTHORING_BRIDGE_TOKEN = ${toml(mcp.bridgeToken)} }`,
    `enabled_tools = ["get_dom", "execute_js", "write_file", "run_draft"]`,
    `required = true`,
    `startup_timeout_sec = 15`,
    `tool_timeout_sec = 120`,
    ``,
  ].join("\n");
}

export function buildAuthoringCliSource(): string {
  return [
    `import { writeFile, readFile, rm } from "node:fs/promises";`,
    `import { randomUUID } from "node:crypto";`,
    `import { join } from "node:path";`,
    `const allowed = new Set(["get_dom", "execute_js", "write_file", "run_draft"]);`,
    `const tool = String(process.argv[2] || "");`,
    `if (!allowed.has(tool)) throw new Error("authoring_tool_invalid:" + tool);`,
    `const rawInput = process.argv[3] || "{}";`,
    `if (rawInput.length > 200000) throw new Error("authoring_tool_input_too_large");`,
    `const input = JSON.parse(rawInput);`,
    `const queueDir = String(process.env.SITEWAKE_AUTHORING_QUEUE_DIR || "");`,
    `if (!queueDir) throw new Error("authoring_queue_missing");`,
    `const id = randomUUID();`,
    `const requestPath = join(queueDir, id + ".request.json");`,
    `const responsePath = join(queueDir, id + ".response.json");`,
    `await writeFile(requestPath, JSON.stringify({ tool, input }), "utf8");`,
    `const deadline = Date.now() + 120000;`,
    `let result;`,
    `while (Date.now() < deadline) {`,
    `  try { result = JSON.parse(await readFile(responsePath, "utf8")); break; } catch (error) {`,
    `    if (error?.code !== "ENOENT") throw error;`,
    `    await new Promise((resolve) => setTimeout(resolve, 50));`,
    `  }`,
    `}`,
    `await rm(responsePath, { force: true });`,
    `if (!result) throw new Error("authoring_queue_timeout");`,
    `if (!result.ok) throw new Error(String(result.error || "authoring_tool_failed"));`,
    `console.log(JSON.stringify(result.payload, null, 2));`,
    ``,
  ].join("\n");
}

/**
 * Build the task brief Codex works from. Deterministic and testable. It states
 * the contract, the tool boundaries, the workspace layout and — on later rounds
 * — the exact structured failures from the previous run so Codex fixes rather
 * than rewrites.
 */
export function buildCodexPrompt(context: AuthoringSessionContext, feedback?: string): string {
  const core = context.coreFieldIds.length ? context.coreFieldIds.join(", ") : "(none specified)";
  const spec = context.specDoc;
  const lines = [
    `You are implementing a web capability as native browser JavaScript stages. Goal: ${context.goal}.`,
    context.intent ? `Intent: ${context.intent}` : "",
    context.reviewFeedback
      ? `Human review ${context.reviewFeedback.reviewId} rejected the previous implementation. Required correction: ${context.reviewFeedback.text}`
      : "",
    context.startUrl ? `The capability starts from: ${context.startUrl}` : "",
    context.observedSuccessUrl ? `A successful demonstration ended at: ${context.observedSuccessUrl}` : "",
    spec ? `When to use: ${spec.whenToUse}` : "",
    spec ? `Inputs: ${spec.inputsNarrative}` : "",
    spec ? `Expected result: ${spec.resultNarrative}` : "",
    spec?.scenarios.length ? `Smoke scenarios: ${JSON.stringify(spec.scenarios.map((scenario) => ({ title: scenario.title, input: scenario.sampleInput, outcome: scenario.expectedOutcome || "success" })))}` : "",
    "",
    "Workspace layout:",
    `- ${ENTRY_PATH}: export one \`capability\` object with \`version: 1\` and ordered \`stages\`.`,
    `  Every stage is \`{ id, async run({ input, state }) }\` and executes inside the target page.`,
    `  Use native window/document/DOM APIs. Return \`{ state }\` or final \`{ output }\`.`,
    `  If a stage triggers navigation, navigation must be its final action; continue in a new stage.`,
    `  Do not import Playwright, PageAgent, SiteWake SDKs or npm packages.`,
    `- ${FIXTURES_PATH}: generated acceptance cases owned by the deterministic harness. Do not edit this file.`,
    "",
    `Required (core) result fields: ${core}.`,
    "",
    "Rules:",
    "- Edit capability.ts only. fixtures.json is generated from the contract and is read-only for this task.",
    "- Do not use eval or the Function constructor.",
    "- Keep the module small and focused.",
    "- Use get_dom progressively: start with the semantic overview, then request a selector for raw HTML details.",
    "- Do not make four consecutive get_dom calls without testing or writing. Repeated observation without action ends the round.",
    "- Write the finished source with the sitewake_authoring.write_file tool (path must be capability.ts). Do not depend on a shell or a private patch tool being available through the model gateway.",
    "- Use execute_js to test the same native JavaScript you place in a stage.",
    "- Use run_draft to execute the exact bundled stages from a clean start. It is the only proving run.",
    "- Treat the contract's public inputs as the only business variables. Read every input directly from `input` (including target text, facets such as color, and quantity); never copy the demonstration product name, URL, category, or a concrete result into the module.",
    "- This is a reusable site-global commerce capability: static category/CMS/footer navigation is Knowledge/Navigation, not a capability step. A dynamic product-detail transition discovered from a result card is allowed, but it must be selected at runtime from the current search results.",
    "- For search-and-add flows, first search with the target input, then select a matching product entity using the target and every supplied facet. Do not choose the first card merely because its title contains the keyword. If a card has no facet text, open its dynamic product link and verify the detail title/attributes before writing. Never silently fall back when a facet is contradicted.",
    "- Before clicking Add to cart, verify the current product detail's own enabled Add to cart control (a related-card button does not count). If the detail control is disabled or absent, treat that candidate as unusable and select another matching result; do not submit a false success. Set quantity before the click, dispatch the page's input/change events, and verify the resulting cart quantity after the click.",
    "- Put every cross-document navigation as the last statement of its stage and continue only in a later stage after the new document is loaded. Use native location/navigation APIs; do not rely on a hard-coded product URL.",
    "- Call run_draft with the concrete sample input shown in the smoke scenario (not an empty object), then use its structured failure and page evidence to repair the same workspace.",
    "- If those four MCP tools are absent from your function list, use only the equivalent task-local bridge commands:",
    `  \`node .sitewake-authoring.mjs get_dom '{}'\``,
    `  \`node .sitewake-authoring.mjs execute_js '{"source":"..."}'\``,
    `  \`node .sitewake-authoring.mjs write_file '{"path":"capability.ts","content":"..."}'\``,
    `  \`node .sitewake-authoring.mjs run_draft '{"input":{}}'\``,
    "- Do not inspect files outside the current workspace. Host application source is not browser evidence.",
    "- Focus on writing the implementation; once the files are ready, finish your turn.",
    "- The deterministic harness will automatically run the smoke case and submit after your turn.",
    "",
    "After your turn the harness performs one deterministic fixture run and publishes only if it passes.",
  ];
  if (feedback) {
    lines.push("", "Previous round results (fix these, do not start over):", feedback);
  }
  return lines.filter((line) => line !== undefined).join("\n");
}

const isWithinLimits = (bytes: number) => bytes <= WORKSPACE_LIMITS.maxFileBytes;

/** Write the VFS files to a real directory Codex can edit. */
export async function materializeWorkspaceToDir(dir: string, files: AuthoringWorkspaceFile[]): Promise<void> {
  for (const file of files) {
    const target = join(dir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

/** Read Codex's edits back, keeping only valid VFS files within limits. */
export async function collectWorkspaceFromDir(dir: string): Promise<AuthoringWorkspaceFile[]> {
  const now = new Date().toISOString();
  const out: AuthoringWorkspaceFile[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "runs") continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = relative(dir, full).split(sep).join("/");
      let normalized: string;
      try {
        normalized = normalizeVfsPath(rel);
      } catch {
        continue; // ignore files Codex created outside the allowed shape
      }
      const info = await stat(full);
      if (!isWithinLimits(info.size)) continue;
      out.push({ path: normalized, content: await readFile(full, "utf8"), updatedAt: now });
    }
  };
  await walk(dir);
  return out;
}

export function resolveCodexInvocation(
  bin = "codex",
  cwd = process.cwd(),
): { command: string; prefixArgs: string[] } {
  const configured = bin.trim() || "codex";
  if (configured === "codex") {
    // Codex Desktop can put its private packaged WindowsApps resource binary
    // on PATH. Ordinary child processes cannot execute that binary. Prefer the
    // project-pinned CLI entry point on every platform so authoring uses the
    // same tested Codex version as the application.
    const localEntrypoint = resolve(cwd, "node_modules/@openai/codex/bin/codex.js");
    if (existsSync(localEntrypoint)) {
      return { command: process.execPath, prefixArgs: [localEntrypoint] };
    }
  }
  if (/\.(?:cjs|mjs|js)$/i.test(configured) && existsSync(configured)) {
    return { command: process.execPath, prefixArgs: [configured] };
  }
  return { command: configured, prefixArgs: [] };
}

const DESKTOP_CONTEXT_ENV_KEYS = [
  "CODEX_INTERNAL_ORIGINATOR_OVERRIDE",
  "CODEX_PERMISSION_PROFILE",
  "CODEX_THREAD_ID",
] as const;

/**
 * A Runner-spawned CLI is an isolated authoring worker, not a child turn of
 * the Codex Desktop task that launched the local server. Inheriting Desktop's
 * managed read-only permission profile cancels every task-scoped MCP call.
 */
export function standaloneCodexEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const isolated = { ...env };
  for (const key of DESKTOP_CONTEXT_ENV_KEYS) delete isolated[key];
  return isolated;
}

/** Default CodexRunner: spawn `codex exec` non-interactively against the dir. */
export function defaultCodexRunner(bin = "codex"): CodexRunner {
  return ({ dir, prompt, model, signal, env, sandbox = "workspace-write" }) =>
    new Promise((resolve) => {
      const invocation = resolveCodexInvocation(bin);
      const args = [...invocation.prefixArgs, "exec", "--cd", dir, "--skip-git-repo-check", "--sandbox", sandbox];
      if (model) args.push("--model", model);
      args.push(prompt);
      // Codex appends piped stdin to the prompt. Node's default `pipe` stdin
      // stays open unless the parent writes or closes it, so a non-interactive
      // authoring run would otherwise wait forever at
      // "Reading additional input from stdin...".
      const child = spawn(invocation.command, args, {
        env: standaloneCodexEnv(env || process.env),
        signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let error = "";
      child.stdout?.on("data", (chunk) => (output += String(chunk)));
      child.stderr?.on("data", (chunk) => (error += String(chunk)));
      child.on("error", (err) => resolve({ ok: false, error: err.message }));
      child.on("close", (code) => resolve({ ok: code === 0, output, error: code === 0 ? undefined : error || `codex exited with ${code}` }));
    });
}

export function conciseCodexOutput(value: string | undefined) {
  return String(value || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .filter((line) => !/codex_core_plugins|curated plugin sync|backup_archive_api_url/i.test(line))
    .join(" ")
    .replace(/(https?:\/\/[^\s"'`?]+)\?[^\s"'`]+/gi, "$1?[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(-1_000);
}

type HarnessToolName = "get_dom" | "execute_js" | "write_file" | "run_draft";

async function startHarnessToolBridge(
  harness: AuthoringHarness,
  context: AuthoringSessionContext,
  dir: string,
  maxToolCalls: number,
  onBudgetExceeded: (error: Error) => void,
  onRoundStalled: (error: Error) => void,
) {
  const token = randomBytes(24).toString("hex");
  const calls: HarnessToolName[] = [];
  const evidence: string[] = [];
  let consecutiveObservationCount = 0;
  let observationAllowed = true;
  let lockedObservationAttempts = 0;
  const queueDir = join(dir, ".sitewake-queue");
  await mkdir(queueDir, { recursive: true });
  const resetRound = (options: { allowObservation?: boolean } = {}) => {
    consecutiveObservationCount = 0;
    lockedObservationAttempts = 0;
    observationAllowed = options.allowObservation ?? observationAllowed;
  };
  const rememberEvidence = (tool: HarnessToolName, input: Record<string, unknown>, payload: unknown) => {
    const serialized = JSON.stringify({ tool, input, payload });
    evidence.push(serialized.length > 5_000 ? `${serialized.slice(0, 5_000)}…` : serialized);
    while (evidence.length > 6) evidence.shift();
  };
  const recentEvidence = () => evidence.join("\n").slice(-24_000);
  const syncWorkspace = async () => {
    const edited = await collectWorkspaceFromDir(dir);
    const entry = edited.find((file) => file.path === ENTRY_PATH);
    if (entry) harness.writeFile(entry.path, entry.content);
  };
  const invoke = async (tool: HarnessToolName, input: Record<string, unknown>) => {
    const budgetError = calls.length >= maxToolCalls ? new Error(`authoring_tool_budget_exceeded:total:${maxToolCalls}`) : undefined;
    if (budgetError) {
      onBudgetExceeded(budgetError);
      throw budgetError;
    }
    calls.push(tool);
    if (tool === "get_dom") {
      if (!observationAllowed) {
        lockedObservationAttempts += 1;
        const locked = new Error("authoring_observation_locked:use_collected_evidence_and_edit_capability.ts_now");
        if (lockedObservationAttempts >= 3) onRoundStalled(locked);
        throw locked;
      }
      const request = {
        selector: typeof input.selector === "string" ? input.selector : undefined,
        snapshotId: typeof input.snapshotId === "string" ? input.snapshotId : undefined,
        cursor: typeof input.cursor === "string" ? input.cursor : undefined,
      };
      consecutiveObservationCount += 1;
      if (consecutiveObservationCount >= 4) {
        const stalled = new Error("authoring_observation_stalled:get_dom_without_action:4");
        onRoundStalled(stalled);
        throw stalled;
      }
      const payload = await harness.getDom(request);
      rememberEvidence(tool, request, payload);
      return payload;
    }
    consecutiveObservationCount = 0;
    if (tool === "execute_js") {
      const request = { source: String(input.source || ""), args: input.args as JsonValue | undefined };
      const payload = await harness.executeJs(request);
      rememberEvidence(tool, input, payload);
      return payload;
    }
    if (tool === "write_file") {
      const path = String(input.path || "");
      const content = String(input.content || "");
      if (path !== ENTRY_PATH) throw new Error(`authoring_workspace_path_rejected:${path}`);
      if (!content.trim()) throw new Error("authoring_workspace_content_required");
      if (!isWithinLimits(Buffer.byteLength(content, "utf8"))) throw new Error("authoring_workspace_file_too_large");
      await writeFile(join(dir, ENTRY_PATH), content, "utf8");
      harness.writeFile(ENTRY_PATH, content);
      return { ok: true, path: ENTRY_PATH, bytes: Buffer.byteLength(content, "utf8") };
    }
    await syncWorkspace();
    return harness.runDraft((input.input || {}) as Record<string, JsonValue>);
  };
  const server: Server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/tool" || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(404).end(); return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tool?: HarnessToolName; input?: Record<string, unknown> };
      if (!body.tool) throw new Error("authoring_tool_missing");
      const payload = await invoke(body.tool, body.input || {});
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  let queueScanning = false;
  const scanQueue = async () => {
    if (queueScanning) return;
    queueScanning = true;
    try {
      const entries = (await readdir(queueDir)).filter((name) => /^[a-f0-9-]+\.request\.json$/i.test(name));
      for (const name of entries) {
        const requestPath = join(queueDir, name);
        const base = name.slice(0, -".request.json".length);
        const processingPath = join(queueDir, `${base}.processing.json`);
        const responsePath = join(queueDir, `${base}.response.json`);
        try {
          await rename(requestPath, processingPath);
        } catch {
          continue;
        }
        try {
          const body = JSON.parse(await readFile(processingPath, "utf8")) as { tool?: HarnessToolName; input?: Record<string, unknown> };
          if (!body.tool) throw new Error("authoring_tool_missing");
          const payload = await invoke(body.tool, body.input || {});
          await writeFile(responsePath, JSON.stringify({ ok: true, payload }), "utf8");
        } catch (error) {
          await writeFile(responsePath, JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }), "utf8");
        } finally {
          await rm(processingPath, { force: true });
        }
      }
    } finally {
      queueScanning = false;
    }
  };
  const queueTimer = setInterval(() => void scanQueue(), 25);
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("authoring_bridge_address_missing");
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    queueDir,
    calls,
    resetRound,
    recentEvidence,
    close: async () => {
      clearInterval(queueTimer);
      while (queueScanning) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

function summarizeFeedback(reasons: string[] | undefined, report: AuthoringHarness["report"]): string {
  const lines: string[] = [];
  if (report) {
    lines.push(`Fixtures: ${report.passed}/${report.total} passing.`);
    for (const testCase of report.cases) {
      if (!testCase.passed) lines.push(`- ${testCase.fixtureId}: ${testCase.gaps.join("; ")}`);
    }
  }
  for (const reason of reasons ?? []) lines.push(`- gate: ${reason}`);
  return lines.join("\n");
}

/**
 * Drives an authoring session with the Codex CLI performing the coding and the
 * deterministic harness performing the running, testing and gating.
 */
export class CodexAuthoringDriver implements CodingAgentDriver {
  readonly kind: CodingAgentKind = "codex";
  private readonly runCodex: CodexRunner;
  private readonly rounds: number;
  private readonly model?: string;
  private readonly seedObservation: boolean;
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;
  private readonly maxToolCalls: number;
  private readonly seedSource?: string;
  private readonly signal?: AbortSignal;

  constructor(options: CodexDriverOptions = {}) {
    this.runCodex = options.runCodex ?? defaultCodexRunner(options.codexBin);
    // One continuation is reserved for the valid observe -> write transition.
    // Smoke failures never consume it and fail the authoring job immediately.
    this.rounds = Math.max(1, options.rounds ?? 2);
    this.model = options.model;
    this.seedObservation = options.seedObservation ?? true;
    this.env = options.env ?? process.env;
    this.timeoutMs = Math.max(100, options.timeoutMs ?? (Number(this.env.SITEWAKE_CODEX_AUTHORING_TIMEOUT_MS) || 5 * 60_000));
    this.maxToolCalls = Math.max(8, options.maxToolCalls ?? (Number(this.env.SITEWAKE_CODEX_AUTHORING_MAX_TOOL_CALLS) || 48));
    this.seedSource = options.seedSource;
    this.signal = options.signal;
  }

  async drive(harness: AuthoringHarness, context: AuthoringSessionContext): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "lc-authoring-"));
    const codexHome = await mkdtemp(join(tmpdir(), "lc-codex-home-"));
    let bridge: Awaited<ReturnType<typeof startHarnessToolBridge>> | undefined;
    let activeController: AbortController | undefined;
    let budgetFailure: Error | undefined;
    let roundStalled: Error | undefined;
    const abortActiveController = () => activeController?.abort(this.signal?.reason);
    this.signal?.addEventListener("abort", abortActiveController);
    try {
      if (this.seedSource) {
        const written = harness.writeFile(ENTRY_PATH, this.seedSource);
        if (written.ok) {
          const report = await harness.runTests();
          if (report.ok && report.data.failed === 0) {
            const submitted = await harness.submit();
            if (submitted.ok) return;
          }
        }
      }
      if (this.seedObservation) {
        await harness.getDom();
        this.signal?.throwIfAborted();
      }
      const configuredProvider = resolveCodexProviderConfig(this.env);
      if (!configuredProvider) throw new Error("codex_model_provider_missing");
      // Codex encodes MCP servers as Responses namespace tools. Several
      // OpenAI-compatible gateways accept ordinary function tools but silently
      // ignore namespace tools. The task-scoped Responses adapter flattens
      // those namespaces for the gateway and restores them on continuation.
      const provider = context.modelProxyBaseUrl
        ? { ...configuredProvider, baseUrl: context.modelProxyBaseUrl.replace(/\/$/, "") }
        : configuredProvider;
      bridge = await startHarnessToolBridge(
        harness,
        context,
        dir,
        this.maxToolCalls,
        (error) => {
          budgetFailure = error;
          activeController?.abort(error);
        },
        (error) => {
          roundStalled = error;
          activeController?.abort(error);
        },
      );
      await writeFile(join(dir, ".sitewake-authoring.mjs"), buildAuthoringCliSource(), "utf8");
      const tsx = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
      const mcpServer = resolve(process.cwd(), "runner/authoring-mcp-server.ts");
      await writeFile(join(codexHome, "config.toml"), buildCodexConfig(provider, { command: process.execPath, args: [tsx, mcpServer], bridgeUrl: bridge.url, bridgeToken: bridge.token }), "utf8");
      let feedback: string | undefined;
      let correctionWithoutObservation = false;
      const finalizeWorkspace = async (roundStartHash: string, codexOutput?: string) => {
        const edited = await collectWorkspaceFromDir(dir);
        const entry = edited.find((file) => file.path === ENTRY_PATH);
        if (entry) harness.writeFile(entry.path, entry.content);
        if ((await harness.workspace.snapshot()).hash === roundStartHash) {
          const diagnostic = conciseCodexOutput(codexOutput);
          feedback = `Codex did not change the scaffolded workspace.${diagnostic ? ` CLI output: ${diagnostic}` : ""}`;
          return "unchanged" as const;
        }
        const report = await harness.runTests();
        if (!report.ok) {
          feedback = `Automatic smoke run failed: ${report.message}`;
          return "failed" as const;
        }
        if (report.data.failed > 0) {
          const gaps = report.data.cases.filter((item) => !item.passed).map((item) => `${item.fixtureId}: ${item.gaps.join("; ")}`);
          feedback = `Automatic smoke run failed: ${gaps.join(" | ")}`;
          return "failed" as const;
        }
        const submitted = await harness.submit();
        if (!submitted.ok) {
          feedback = `Automatic submit failed: ${submitted.message}${submitted.diagnostics?.length ? ` (${submitted.diagnostics.join("; ")})` : ""}`;
          return "failed" as const;
        }
        return "submitted" as const;
      };
      const deadline = Date.now() + this.timeoutMs;
      for (let round = 0; round < this.rounds; round += 1) {
        this.signal?.throwIfAborted();
        if (budgetFailure) throw budgetFailure;
        // The stall is reported from a callback, which control-flow analysis
        // cannot see, so keep the declared type across this reset.
        roundStalled = undefined as Error | undefined;
        bridge.resetRound({ allowObservation: !correctionWithoutObservation });
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error(`authoring_time_budget_exceeded:${this.timeoutMs}`);
        await materializeWorkspaceToDir(dir, harness.workspace.toFiles());
        const roundStartHash = (await harness.workspace.snapshot()).hash;
        const prompt = buildCodexPrompt(context, feedback);
        const childEnv = {
          ...process.env,
          ...this.env,
          CODEX_HOME: codexHome,
          PWD: dir,
          OLDPWD: dir,
          MODEL_API_KEY: this.env.MODEL_API_KEY || this.env.OPENAI_API_KEY || "",
          SITEWAKE_AUTHORING_QUEUE_DIR: bridge.queueDir,
        };
        const controller = new AbortController();
        activeController = controller;
        if (this.signal?.aborted) controller.abort(this.signal.reason);
        const timeout = setTimeout(() => controller.abort(new Error(`authoring_time_budget_exceeded:${this.timeoutMs}`)), remainingMs);
        // Codex 0.145 on Windows maps workspace-write to a managed read-only
        // profile that cancels MCP calls. This broader local sandbox is safe
        // only with the task-scoped proxy above: it forwards exactly the four
        // bounded authoring tools and the workspace itself is a fresh temp dir.
        const sandbox = process.platform === "win32" && context.modelProxyBaseUrl
          ? "danger-full-access" as const
          : "workspace-write" as const;
        const outcome = await this.runCodex({
          dir,
          prompt,
          model: this.model || provider.model,
          env: childEnv,
          signal: controller.signal,
          sandbox,
        }).finally(() => {
          clearTimeout(timeout);
          activeController = undefined;
        });
        this.signal?.throwIfAborted();
        if (controller.signal.aborted) {
          this.signal?.throwIfAborted();
          if (budgetFailure) throw budgetFailure;
          const finalized = await finalizeWorkspace(roundStartHash, outcome.output || outcome.error);
          if (finalized === "submitted") return;
          const stalledError = roundStalled as unknown as Error | undefined;
          if (stalledError && round + 1 < this.rounds) {
            const collectedEvidence = bridge.recentEvidence();
            feedback = [
              `${stalledError.message}. ${feedback || "No implementation was written."}`,
              collectedEvidence ? `Collected page evidence from the previous round:\n${collectedEvidence}` : "",
              "This is the final correction round. Page observation is now locked: use the collected evidence, edit capability.ts immediately, then finish.",
            ].filter(Boolean).join("\n");
            correctionWithoutObservation = true;
            continue;
          }
          if (stalledError) throw new Error(`${stalledError.message}:${feedback || "no passing workspace"}`);
          throw new Error(`authoring_time_budget_exceeded:${this.timeoutMs}:${feedback || "no passing workspace"}`);
        }
        if (!outcome.ok) {
          feedback = `Codex CLI did not complete: ${outcome.error ?? "unknown error"}`;
          if (await finalizeWorkspace(roundStartHash, outcome.error || outcome.output) === "submitted") return;
          throw new Error(`codex_cli_failed:${feedback}`);
        }
        if (harness.result) return;
        const finalized = await finalizeWorkspace(roundStartHash, outcome.output);
        if (finalized === "submitted") return;
        const observedWithoutWriting = finalized === "unchanged" && bridge.calls.includes("get_dom");
        if (observedWithoutWriting && round + 1 < this.rounds) {
          feedback = `${feedback || "Codex observed the page but did not write code."} Continue the same workspace now: implement capability.ts, then finish.`;
          continue;
        }
        throw new Error(`codex_authoring_failed:${feedback || summarizeFeedback([], harness.report) || "no passing workspace"}`);
      }
      throw new Error(`codex_rounds_exhausted:${feedback || "no passing workspace"}`);
    } finally {
      this.signal?.removeEventListener("abort", abortActiveController);
      activeController?.abort(this.signal?.reason);
      await bridge?.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      await rm(codexHome, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** True only when the Codex CLI author can actually run here (FS + credentials). */
export function codexAuthoringAvailable(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(resolveCodexProviderConfig(env));
}
