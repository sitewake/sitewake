import { mkdir, readFile, rm } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  AuthoringDraft, AuthoringProof, BrowserArtifact, BrowserRun, BrowserStepReceipt, CapabilityDefinition, CapabilityRevision, CapabilityRun, CompletionVerifier, CrawlJob, DomReplayChunk, DomReplayFrame, JsonValue, KnowledgeCandidate, LocatorVariant,
  JsonPrimitive, OperationDefinition, OutcomeReceipt, PageProgram, PageProgramStep, PersistedAuthoringWorkspace, ProgramModuleRef, RunnerLease, SerializedNode, SiteAgentReleaseV2, SitePreviewJob, TargetSpec, ValueExpression,
} from "../lib/site-knowledge/protocol";
import { stableHash } from "../lib/site-knowledge/protocol";
import { collectPolicyViolations, serveWithInstallSnippet } from "./site-preview-rehearsal";
import { buildSceneUrl, matchUrlTemplate, recognizeScene, sceneFromSnapshot } from "../lib/site-knowledge/url-scene";
import { navigationCompletionVerified, navigationTargetEvidence, navigationTargetTerm } from "../lib/site-knowledge/navigation-authoring";
import { runAuthoringSession } from "../lib/site-knowledge/authoring-harness";
import type { BrowserBridge, HarnessDeps, AuthoringSessionContext, HarnessEvent } from "../lib/site-knowledge/authoring-harness";
import type { EsbuildBuild } from "../lib/site-knowledge/authoring-bundler";
import { CodexAuthoringDriver, codexAuthoringAvailable } from "./codex-authoring-driver";
import { compileVerifiedEntryCapability } from "../lib/site-knowledge/verified-entry-compiler";
import { assertCapabilityOutput, PlaywrightStageRunError, runPlaywrightCapabilityStages } from "./playwright-stage-runner";
import {
  deterministicNavigationOutputPlan,
  exploreNavigationWithAI,
  navigationModuleSource,
  type NavigationOutputPlan,
} from "./navigation-ai-author";
import {
  createCoalescingAsyncQueue,
  isRunnerLeaseLostError,
  retryRunnerCompletion,
  RunnerLeaseGuard,
  RunnerLeaseLostError,
  sanitizeRunnerMessage,
} from "./runtime-safety";
import { CrawlFrontier } from "../lib/site-knowledge/crawl-frontier";
import { crawlProfileGenerator, crawlSiteKnowledge } from "../lib/site-knowledge/crawl-knowledge";
import { installCrawlBrowserNetworkGuards, playwrightRenderPage } from "../lib/site-knowledge/crawl-render";
import { normalizeDetectedSiteAgentIds } from "../lib/site-knowledge/site-preview-detection";
import { DEFAULT_UA, parseRobots, robotsAllows } from "../lib/site-knowledge/crawl-politeness";
import { fetchSameOriginText, seedFromSitemap } from "../lib/site-knowledge/sitemap-seed";
import { validateCrawlJobLimits } from "../lib/site-knowledge/crawl-limits";
import {
  chromiumPinnedOriginArgs,
  pinnedOriginFetch,
  resolvePinnedCrawlOrigin,
} from "./crawl-network-policy";
import { crawlAuthorizationHeaders } from "./crawl-authorization";
import { applyEntryFeedback, sampleEntryBindings, verifyEntry } from "../lib/site-knowledge/entry-verification";
import type { SceneDefinition } from "../lib/site-knowledge/protocol";
import { validationArtifactEvidence, validationArtifactLabels, type ValidationArtifactRole } from "../lib/site-knowledge/validation-evidence";

const endpoint = (process.env.SITEWAKE_CONTROL_PLANE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const localControlPlane = (() => {
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1"
        || url.hostname === "localhost"
        || url.hostname === "::1");
  } catch {
    return false;
  }
})();
const allowPrivateCrawlNetwork = localControlPlane
  && process.env.SITEWAKE_CRAWL_ALLOW_PRIVATE_NETWORK === "1";
// API calls can use the container network. Code imported by a website cannot:
// it needs a publicly reachable HTTPS origin, never `control-plane:3000`.
const browserPublicEndpoint = (process.env.SITEWAKE_BROWSER_PUBLIC_URL || endpoint).replace(/\/$/, "");
const legacyRunnerProtocol = process.env.SITEWAKE_LEGACY_RUNNER_PROTOCOL === "true";
const runnerServiceToken = process.env.SITEWAKE_RUNNER_TOKEN || "";
const runnerEnrollmentToken = process.env.SITEWAKE_RUNNER_ENROLLMENT_TOKEN
  || (legacyRunnerProtocol ? runnerServiceToken : "")
  || "";
const runnerName = process.env.SITEWAKE_RUNNER_NAME || `Chromium · ${process.platform}`;
const browserChannel = process.env.SITEWAKE_BROWSER_CHANNEL?.trim();
const once = process.argv.includes("--once");
const artifactDirectory = ".artifacts/browser-runs";
const prewarmCapacity = Math.max(0, Math.min(8, Number(process.env.SITEWAKE_RUNNER_PREWARM || 2) || 0));
const runnerConcurrency = Math.max(1, Math.min(4, Number(process.env.SITEWAKE_RUNNER_CONCURRENCY || prewarmCapacity || 2) || 1));
const runnerConsumerCount = once ? 1 : runnerConcurrency;
type RunnerQueue = "any" | "interactive" | "background" | "author" | "validate";
const configuredRunnerRole = process.env.SITEWAKE_RUNNER_ROLE;
const runnerRole: RunnerQueue | undefined = configuredRunnerRole && ["any", "interactive", "background", "author", "validate"].includes(configuredRunnerRole)
  ? configuredRunnerRole as RunnerQueue
  : undefined;
const runnerId = process.env.SITEWAKE_RUNNER_ID?.trim() || undefined;
const runnerVersion = process.env.SITEWAKE_RUNNER_VERSION || process.env.npm_package_version || "development";
const runnerWorkKinds = runnerRole === "interactive"
  ? ["execute"]
  : runnerRole === "author"
    ? ["author"]
    : runnerRole === "validate"
      ? ["validate"]
      : runnerRole === "background"
        ? ["author", "validate"]
        : ["execute", "author", "validate"];
let draining = false;
let shuttingDown = false;
let resolveShutdownRequest: (() => void) | undefined;
const shutdownRequested = new Promise<void>((resolve) => {
  resolveShutdownRequest = resolve;
});
let runnerSessionId = "";
let registeredRunnerIdForHeaders = "";
let runnerSessionToken = "";
let runnerLastError: { code: string; message: string; phase: string } | undefined;

async function waitForShutdownOrDelay(delayMs: number) {
  if (shuttingDown) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delay = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, delayMs);
  });
  await Promise.race([delay, shutdownRequested]);
  if (timer) clearTimeout(timer);
  return shuttingDown;
}

type EvidenceMode = "light" | "debug" | "full";
type ReadyBrowserSlot = { context: BrowserContext; page: Page; readyAt: number; evidenceMode: EvidenceMode };
type ControlLeaseIdentity = { leaseId: string; fence: number; token: string; runnerSessionId: string; expiresAt: string };
const controlLeaseByToken = new Map<string, ControlLeaseIdentity>();

class BrowserReadyPool {
  private readonly slots: ReadyBrowserSlot[] = [];
  private readonly creating: Record<EvidenceMode, number> = { light: 0, debug: 0, full: 0 };
  private closed = false;

  constructor(private readonly browser: Browser, readonly capacity: number) {}

  private async createSlot(evidenceMode: EvidenceMode) {
    const recordVideo = evidenceMode === "debug" ? { dir: artifactDirectory, size: { width: 640, height: 360 } } : evidenceMode === "full" ? { dir: artifactDirectory, size: { width: 800, height: 450 } } : undefined;
    const context = await this.browser.newContext({ viewport: { width: 1280, height: 800 }, ...(recordVideo ? { recordVideo } : {}) });
    const page = await context.newPage();
    return { context, page, readyAt: Date.now(), evidenceMode } satisfies ReadyBrowserSlot;
  }

  refill() {
    if (this.closed) return;
    const lightTarget = this.capacity > 0 ? Math.ceil(this.capacity / 2) : 0;
    for (const mode of ["light", "debug", "full"] as const) {
      const target = mode === "light" ? lightTarget : mode === "full" ? this.capacity - lightTarget : 0;
      while (this.slots.filter((slot) => slot.evidenceMode === mode).length + this.creating[mode] < target) {
        this.creating[mode] += 1;
        void this.createSlot(mode).then((slot) => {
          if (this.closed) return slot.context.close();
          this.slots.push(slot);
        }).catch((error) => console.warn(`browser_prewarm_failed:${mode}:${error instanceof Error ? error.message : String(error)}`)).finally(() => {
          this.creating[mode] -= 1;
          this.refill();
        });
      }
    }
  }

  async start() {
    await mkdir(artifactDirectory, { recursive: true });
    if (!this.capacity) return;
    const initial = await Promise.all(Array.from({ length: this.capacity }, (_, index) => this.createSlot(index < Math.ceil(this.capacity / 2) ? "light" : "full")));
    this.slots.push(...initial);
  }

  async acquire(evidenceMode: EvidenceMode) {
    const index = this.slots.findIndex((slot) => slot.evidenceMode === evidenceMode);
    const slot = index >= 0 ? this.slots.splice(index, 1)[0] : await this.createSlot(evidenceMode);
    this.refill();
    return { ...slot, prewarmed: Date.now() - slot.readyAt > 25 };
  }

  async close() {
    this.closed = true;
    await Promise.all(this.slots.splice(0).map((slot) => slot.context.close().catch(() => undefined)));
  }

  get ready() { return this.slots.length; }
}

let browserReadyPool: BrowserReadyPool | undefined;
const closedRecordedContexts = new WeakSet<BrowserContext>();

async function closeRecordedContext(context: BrowserContext) {
  if (closedRecordedContexts.has(context)) return;
  closedRecordedContexts.add(context);
  await context.close().catch(() => undefined);
  browserReadyPool?.refill();
}

async function removeLocalMedia(paths: Array<string | undefined>) {
  await Promise.all(paths.filter((path): path is string => Boolean(path)).map((path) => rm(path, { force: true }).catch(() => undefined)));
}

async function cleanupRecordedContext(context: BrowserContext, paths: Array<string | undefined>) {
  const videos = context.pages().map((item) => item.video()).filter((video): video is NonNullable<ReturnType<Page["video"]>> => Boolean(video));
  await closeRecordedContext(context);
  const videoPaths = await Promise.all(videos.map((video) => video.path().catch(() => undefined)));
  await removeLocalMedia([...paths, ...videoPaths]);
}

function headers(extra: Record<string, string> = {}) {
  const controlLease = extra["x-sitewake-lease-token"] ? controlLeaseByToken.get(extra["x-sitewake-lease-token"]) : undefined;
  return {
    "content-type": "application/json",
    ...(runnerServiceToken ? { authorization: `Bearer ${runnerServiceToken}` } : {}),
    ...(runnerSessionId ? { "x-sitewake-runner-id": registeredRunnerIdForHeaders } : {}),
    ...(runnerSessionId ? { "x-sitewake-runner-session-id": runnerSessionId } : {}),
    ...(runnerSessionToken ? { "x-sitewake-runner-session-token": runnerSessionToken } : {}),
    ...(controlLease ? {
      "x-sitewake-control-lease-id": controlLease.leaseId,
      "x-sitewake-control-lease-fence": String(controlLease.fence),
    } : {}),
    ...extra,
  };
}
class RunnerApiError extends Error {
  constructor(readonly status: number, readonly responseBody: string) {
    super(`${status}:${responseBody}`);
    this.name = "RunnerApiError";
  }
}
async function api<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${endpoint}${path}`, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  if (!response.ok) throw new RunnerApiError(response.status, await response.text());
  return response.json() as Promise<T>;
}
function uid(prefix: string) { return `${prefix}_${crypto.randomUUID()}`; }
function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Error && error.name === "TimeoutError") return message.includes("goto") ? "navigation_timeout" : "timeout";
  if (/\b(?:net::ERR_[A-Z0-9_]+|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN)\b/i.test(message)) return "network_error";
  if (/target_not_found|target_definition_missing/.test(message)) return "target_not_found";
  if (/input_value_mismatch/.test(message)) return "input_value_mismatch";
  if (/scene_assertion_failed/.test(message)) return "scene_assertion_failed";
  return message.split(":")[0] || "browser_run_failed";
}
async function snapshot(page: Page) {
  const links = await page.locator("a[href]").evaluateAll((anchors) => anchors.slice(0, 400).flatMap((anchor) => {
    if (!(anchor instanceof HTMLAnchorElement) || !anchor.href) return [];
    const url = anchor.href;
    if (url.startsWith("javascript:")) return [];
    return [{
      text: (anchor.innerText || anchor.getAttribute("aria-label") || anchor.textContent || "").trim().slice(0, 120),
      url,
    }];
  })).catch(() => [] as Array<{ text: string; url: string }>);
  return {
    id: uid("snapshot"),
    sessionId: "browser-runner",
    documentId: "browser-runner",
    sequence: 1,
    url: page.url(),
    title: await page.title(),
    heading: await page.locator("h1").first().textContent().catch(() => "") || "",
    visibleText: (await page.locator("body").evaluate((body) => {
      const overlay = document.querySelector<HTMLElement>('[data-sitewake-validation-overlay="runner-owned"]');
      const display = overlay?.style.display;
      if (overlay) overlay.style.display = "none";
      try { return (body as HTMLElement).innerText; }
      finally { if (overlay) overlay.style.display = display || ""; }
    }).catch(() => "")).slice(0, 12_000),
    links,
    capturedAt: new Date().toISOString(),
  };
}

type ValidationPresentationPhase = "before" | "running" | "completed" | "failed";
type ValidationPresentationConfig = { capabilityName: string; capabilityEnglishName: string; runId: string; phase: ValidationPresentationPhase };

function validationPresentationBootstrap(config: ValidationPresentationConfig) {
  const runtimeWindow = window as typeof window & {
    __SITEWAKE_RUNNER_VALIDATION_PRESENTATION__?: ValidationPresentationConfig;
    __SITEWAKE_RUNNER_VALIDATION_OBSERVER__?: MutationObserver;
  };
  runtimeWindow.__SITEWAKE_RUNNER_VALIDATION_PRESENTATION__ = config;
  const phaseLabels: Record<ValidationPresentationPhase, string> = {
    before: "执行前 · Before",
    running: "执行中 · Running",
    completed: "执行完成 · Completed",
    failed: "执行失败 · Failed",
  };
  const hideSiteAgentWidgets = () => {
    let style = document.querySelector<HTMLStyleElement>("style[data-sitewake-validation-style]");
    if (!style) {
      style = document.createElement("style");
      style.dataset.sitewakeValidationStyle = "runner-owned";
      style.textContent = "[data-sitewake-agent]{display:none!important;visibility:hidden!important}";
      (document.head || document.documentElement).appendChild(style);
    }
    for (const element of document.querySelectorAll<HTMLElement>("[data-sitewake-agent]")) {
      element.style.setProperty("display", "none", "important");
      element.style.setProperty("visibility", "hidden", "important");
    }
  };
  const ensureOverlay = () => {
    const current = runtimeWindow.__SITEWAKE_RUNNER_VALIDATION_PRESENTATION__ || config;
    let host = document.querySelector<HTMLElement>('[data-sitewake-validation-overlay="runner-owned"]');
    if (!host) {
      host = document.createElement("div");
      host.dataset.sitewakeValidationOverlay = "runner-owned";
      host.dataset.pageAgentIgnore = "true";
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "position:fixed;left:18px;right:18px;top:16px;z-index:2147483647;pointer-events:none;font-synthesis:none";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<style>:host{all:initial}.card{display:flex;align-items:center;gap:12px;max-width:min(760px,calc(100vw - 36px));padding:11px 14px;border:1px solid rgba(255,255,255,.22);border-radius:14px;color:#f8fafc;background:rgba(15,23,42,.92);box-shadow:0 14px 44px rgba(15,23,42,.28);backdrop-filter:blur(12px);font:12px/1.35 Inter,ui-sans-serif,system-ui,"PingFang SC",sans-serif;pointer-events:none}.dot{width:9px;height:9px;flex:none;border-radius:50%;background:#fbbf24;box-shadow:0 0 0 5px rgba(251,191,36,.14)}:host([data-phase="running"]) .dot{background:#60a5fa;box-shadow:0 0 0 5px rgba(96,165,250,.14)}:host([data-phase="completed"]) .dot{background:#34d399;box-shadow:0 0 0 5px rgba(52,211,153,.14)}:host([data-phase="failed"]) .dot{background:#fb7185;box-shadow:0 0 0 5px rgba(251,113,133,.14)}.copy{min-width:0;flex:1}.title,.meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.title{font-weight:800}.meta{margin-top:2px;color:#cbd5e1;font-size:10px}.phase{flex:none;padding:4px 8px;border-radius:999px;color:#e2e8f0;background:rgba(255,255,255,.09);font-size:10px;font-weight:800}</style><div class="card"><i class="dot"></i><div class="copy"><div class="title"></div><div class="meta"></div></div><span class="phase"></span></div>`;
      document.documentElement.appendChild(host);
    }
    host.dataset.phase = current.phase;
    const root = host.shadowRoot;
    if (root) {
      const title = root.querySelector<HTMLElement>(".title");
      const meta = root.querySelector<HTMLElement>(".meta");
      const phase = root.querySelector<HTMLElement>(".phase");
      if (title) title.textContent = `能力：${current.capabilityName} · Capability: ${current.capabilityEnglishName}`;
      if (meta) meta.textContent = `Runner-owned validation · Run ID: ${current.runId}`;
      if (phase) phase.textContent = phaseLabels[current.phase];
    }
  };
  const apply = () => { hideSiteAgentWidgets(); ensureOverlay(); };
  if (document.documentElement) apply();
  else document.addEventListener("DOMContentLoaded", apply, { once: true });
  if (!runtimeWindow.__SITEWAKE_RUNNER_VALIDATION_OBSERVER__) {
    const observer = new MutationObserver(() => apply());
    observer.observe(document, { subtree: true, childList: true });
    runtimeWindow.__SITEWAKE_RUNNER_VALIDATION_OBSERVER__ = observer;
  }
}

function capabilityEnglishName(capability: CapabilityDefinition) {
  return [capability.normalizedGoal, ...capability.aliases, capability.id]
    .find((value) => /[a-z]/i.test(value) && !/[\u3400-\u9fff]/.test(value))
    || capability.id;
}

async function createValidationPresentation(context: BrowserContext, capability: CapabilityDefinition, runId: string) {
  let phase: ValidationPresentationPhase = "before";
  const base = { capabilityName: capability.name, capabilityEnglishName: capabilityEnglishName(capability), runId };
  await context.addInitScript(validationPresentationBootstrap, { ...base, phase });
  const setPagePhase = async (page: Page) => {
    await page.evaluate(validationPresentationBootstrap, { ...base, phase }).catch(() => undefined);
  };
  const preparePage = (page: Page) => {
    page.on("domcontentloaded", () => { void setPagePhase(page); });
  };
  for (const page of context.pages()) preparePage(page);
  context.on("page", preparePage);
  return {
    async setPhase(nextPhase: ValidationPresentationPhase, page: Page) {
      phase = nextPhase;
      await Promise.all(context.pages().map((item) => setPagePhase(item)));
      if (!context.pages().includes(page)) await setPagePhase(page);
    },
  };
}

async function captureValidationFrame(page: Page, path: string) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("[data-sitewake-agent]")) element.remove();
  }).catch(() => undefined);
  return page.screenshot({ path, type: "jpeg", quality: 65, fullPage: true }).then(() => true).catch(() => false);
}
function inputForCandidate(candidate: KnowledgeCandidate, fallback: Record<string, JsonValue>) {
  const result = { ...fallback };
  for (const field of candidate.authoring?.requiredInputs || []) if (result[field.id] === undefined && field.value !== undefined) result[field.id] = field.value;
  return result;
}
function goalForCandidate(candidate: KnowledgeCandidate, input: Record<string, JsonValue>) {
  return (candidate.authoring?.goalTemplate || candidate.capability.name).replace(/\{([^}]+)\}/g, (_, key: string) => String(input[key] ?? key));
}
async function uploadArtifact(path: string, metadata: { siteAgentId: string; learningJobId: string; runId: string; ownerKind?: BrowserArtifact["ownerKind"]; kind: BrowserArtifact["kind"]; role?: BrowserArtifact["role"]; label: string; contentType: string; signal?: AbortSignal }, signal = metadata.signal) {
  signal?.throwIfAborted();
  try {
    const response = await fetch(`${endpoint}/api/artifacts?siteAgentId=${encodeURIComponent(metadata.siteAgentId)}`, {
      method: "POST", headers: headers({ "content-type": metadata.contentType, "x-sitewake-learning-job-id": metadata.learningJobId, "x-sitewake-run-id": metadata.runId, "x-sitewake-artifact-kind": metadata.kind, ...(metadata.ownerKind ? { "x-sitewake-artifact-owner-kind": metadata.ownerKind } : {}), ...(metadata.role ? { "x-sitewake-artifact-role": metadata.role } : {}), "x-sitewake-artifact-label": encodeURIComponent(metadata.label) }), body: await readFile(path), signal,
    });
    if (!response.ok) { console.warn(`artifact_upload_failed:${metadata.kind}:${response.status}:${await response.text()}`); return undefined; }
    return (await response.json() as { artifact: BrowserArtifact }).artifact;
  } catch (error) {
    signal?.throwIfAborted();
    console.warn(`artifact_upload_failed:${metadata.kind}:${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}
async function createRecordedContext(browser: Browser, runId: string, evidenceMode: EvidenceMode = "full") {
  await mkdir(artifactDirectory, { recursive: true });
  const slot = browserReadyPool ? await browserReadyPool.acquire(evidenceMode) : undefined;
  const recordVideo = evidenceMode === "debug" ? { dir: artifactDirectory, size: { width: 640, height: 360 } } : evidenceMode === "full" ? { dir: artifactDirectory, size: { width: 800, height: 450 } } : undefined;
  const context = slot?.context || await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(recordVideo ? { recordVideo } : {}) });
  if (evidenceMode === "full") await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = slot?.page || await context.newPage();
  return {
    context,
    page,
    evidenceMode,
    prewarmed: slot?.prewarmed || false,
    tracePath: `${artifactDirectory}/${runId}.zip`,
    screenshotPath: `${artifactDirectory}/${runId}.jpg`,
    beforeScreenshotPath: `${artifactDirectory}/${runId}-before.jpg`,
    afterScreenshotPath: `${artifactDirectory}/${runId}-after.jpg`,
    keyframePaths: [] as string[],
  };
}
async function finishArtifacts(context: BrowserContext, page: Page, paths: { tracePath: string; screenshotPath: string; beforeScreenshotPath?: string; afterScreenshotPath?: string; keyframePaths?: string[]; evidenceMode?: EvidenceMode }, run: BrowserRun, onScreenshot?: (artifact: BrowserArtifact) => Promise<void>, signal?: AbortSignal) {
  const video = page.video();
  const contextVideos = context.pages().map((item) => item.video()).filter((item): item is NonNullable<ReturnType<Page["video"]>> => Boolean(item));
  let videoPath: string | undefined;
  let contextVideoPaths: Array<string | undefined> = [];
  try {
    signal?.throwIfAborted();
    const validationFrames = run.mode === "validate"
      ? [
        paths.beforeScreenshotPath ? { path: paths.beforeScreenshotPath, role: "before-screenshot" as const } : undefined,
        paths.afterScreenshotPath ? { path: paths.afterScreenshotPath, role: "after-screenshot" as const } : undefined,
      ].filter((item): item is { path: string; role: Extract<ValidationArtifactRole, "before-screenshot" | "after-screenshot"> } => Boolean(item))
      : [];
    if (!validationFrames.length) await page.screenshot({ path: paths.screenshotPath, type: "jpeg", quality: paths.evidenceMode === "full" ? 65 : 48, fullPage: paths.evidenceMode === "full" }).catch(() => undefined);
    if (paths.evidenceMode === "full") await context.tracing.stop({ path: paths.tracePath }).catch(() => undefined);
    await closeRecordedContext(context);
    signal?.throwIfAborted();
    videoPath = await video?.path().catch(() => undefined);
    contextVideoPaths = await Promise.all(contextVideos.map((item) => item.path().catch(() => undefined)));
    const metadata = { siteAgentId: run.siteAgentId, learningJobId: run.learningJobId, runId: run.id, signal };
    const artifacts: BrowserArtifact[] = [];
    for (const frame of validationFrames) {
      const screenshot = await uploadArtifact(frame.path, { ...metadata, kind: "screenshot", role: frame.role, label: validationArtifactLabels[frame.role], contentType: "image/jpeg" }).catch(() => undefined);
      if (screenshot) { artifacts.push(screenshot); await onScreenshot?.(screenshot); }
    }
    for (const [index, keyframePath] of (paths.keyframePaths || []).entries()) {
      const screenshot = await uploadArtifact(keyframePath, { ...metadata, kind: "screenshot", role: "keyframe", label: `${validationArtifactLabels.keyframe} ${index + 1}`, contentType: "image/jpeg" }).catch(() => undefined);
      if (screenshot) { artifacts.push(screenshot); await onScreenshot?.(screenshot); }
    }
    if (!validationFrames.length) {
      const screenshot = await uploadArtifact(paths.screenshotPath, { ...metadata, kind: "screenshot", label: run.status === "passed" ? "结果截图" : "失败现场", contentType: "image/jpeg" }).catch(() => undefined);
      if (screenshot) { artifacts.push(screenshot); await onScreenshot?.(screenshot); }
    }
    if (paths.evidenceMode === "light") return artifacts;
    const recordingPaths = run.mode === "validate"
      ? [...new Set(contextVideoPaths.filter((path): path is string => Boolean(path)))]
      : videoPath ? [videoPath] : [];
    for (const recordingPath of recordingPaths) {
      const recording = await uploadArtifact(recordingPath, { ...metadata, kind: "video", ...(run.mode === "validate" ? { role: "validation-video" as const } : {}), label: run.mode === "author" ? "AI 程序编写录屏" : run.mode === "validate" ? validationArtifactLabels["validation-video"] : run.mode === "debug" ? "实时调试录屏" : "能力运行录屏", contentType: "video/webm" }).catch(() => undefined);
      if (recording) artifacts.push(recording);
    }
    if (paths.evidenceMode === "full") {
      const trace = await uploadArtifact(paths.tracePath, { ...metadata, kind: "trace", ...(run.mode === "validate" ? { role: "trace" as const } : {}), label: run.mode === "validate" ? validationArtifactLabels.trace : "浏览器执行 Trace", contentType: "application/zip" }).catch(() => undefined);
      if (trace) artifacts.push(trace);
    }
    return artifacts;
  } finally {
    await closeRecordedContext(context);
    videoPath ||= await video?.path().catch(() => undefined);
    if (!contextVideoPaths.length) contextVideoPaths = await Promise.all(contextVideos.map((item) => item.path().catch(() => undefined)));
    await removeLocalMedia([paths.screenshotPath, paths.beforeScreenshotPath, paths.afterScreenshotPath, ...(paths.keyframePaths || []), paths.tracePath, videoPath, ...contextVideoPaths]);
  }
}
function safeRunnerMessage(value: string) {
  return sanitizeRunnerMessage(value);
}

function runnerActivity(
  stage: NonNullable<BrowserRun["progress"]>["stage"],
  message: string,
  learningJobId: string,
) {
  const phase = stage === "planning"
    ? "preparing"
    : stage === "authoring"
      ? "coding"
      : stage === "executing" || stage === "judging" || stage === "validating"
        ? "testing"
        : stage === "complete"
          ? "completed"
          : "observing";
  return {
    stage,
    phase,
    message: safeRunnerMessage(message),
    learningJobId: safeRunnerMessage(learningJobId),
  };
}

async function heartbeat(runnerId: string, status: "online" | "offline" | "busy", activity?: Record<string, unknown> | null) {
  return api<{ desiredState?: "active" | "draining"; heartbeatIntervalMs?: number }>(`/api/validation/runners/${encodeURIComponent(runnerId)}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({
      sessionId: runnerSessionId,
      sessionToken: runnerSessionToken,
      status,
      readySlots: Math.min(browserReadyPool?.ready || 0, runnerConsumerCount),
      ...(activity !== undefined ? { activity } : {}),
      ...(runnerLastError ? { lastError: runnerLastError } : {}),
    }),
  });
}

async function reportRunnerFailure(runnerId: string, phase: string, error: unknown, learningJobId?: string) {
  const code = safeRunnerMessage(errorCode(error)) || "runner_task_failed";
  const message = safeRunnerMessage(error instanceof Error ? error.message : String(error)) || code;
  runnerLastError = { code, message, phase: safeRunnerMessage(phase) || "runner" };
  await heartbeat(runnerId, "busy", {
    stage: "failed",
    phase: "failed",
    message,
    ...(learningJobId ? { learningJobId: safeRunnerMessage(learningJobId) } : {}),
  }).catch(() => undefined);
}
function controlLeaseIdentity(lease: RunnerLease): ControlLeaseIdentity | undefined {
  const job = lease.job;
  const owned = job.lease as (typeof job.lease & { id?: string; leaseId?: string; fence?: number; runnerSessionId?: string }) | undefined;
  const leaseId = owned?.leaseId || owned?.id;
  if (!owned?.token || !leaseId || owned.fence === undefined || !owned.expiresAt) return undefined;
  return { leaseId, fence: owned.fence, token: owned.token, runnerSessionId: owned.runnerSessionId || runnerSessionId, expiresAt: owned.expiresAt };
}

function startLeaseRenewal(runnerId: string, identity: ControlLeaseIdentity | undefined) {
  let stopped = false;
  let completing = false;
  let inFlight: Promise<unknown> | undefined;
  let requestController: AbortController | undefined;
  if (!identity) {
    return {
      signal: undefined,
      assertActive() {},
      bindContext() {},
      async beginCompletion() {},
      async stop() {},
    };
  }
  const guard = new RunnerLeaseGuard(identity.expiresAt);
  if (identity.runnerSessionId !== runnerSessionId) {
    guard.invalidate(new RunnerLeaseLostError("runner_lease_session_rejected", "Runner lease belongs to a different session."));
  }
  const renew = () => {
    if (stopped || completing || inFlight || guard.signal.aborted) return;
    requestController = new AbortController();
    const abortRequest = () => requestController?.abort(guard.signal.reason);
    guard.signal.addEventListener("abort", abortRequest, { once: true });
    inFlight = api<{ lease?: { expiresAt?: string } }>(`/api/validation/runners/${encodeURIComponent(runnerId)}/leases/${encodeURIComponent(identity.leaseId)}/renew`, {
      method: "POST",
      body: JSON.stringify({
        sessionId: runnerSessionId,
        sessionToken: runnerSessionToken,
        token: identity.token,
        fence: identity.fence,
      }),
      signal: requestController.signal,
    }).then((result) => {
      const expiresAt = result.lease?.expiresAt;
      if (!expiresAt || !guard.updateExpiry(expiresAt)) {
        guard.invalidate(new RunnerLeaseLostError("runner_lease_renewal_invalid", "Runner lease renewal returned no usable expiry."));
      }
    }).catch((error) => {
      if (stopped || guard.signal.aborted) return;
      const fatal = error instanceof RunnerApiError
        ? [401, 403, 409].includes(error.status)
        : /(?:session|fence).*(?:reject|invalid|mismatch)|(?:reject|invalid|mismatch).*(?:session|fence)/i.test(error instanceof Error ? error.message : String(error));
      if (fatal) {
        guard.invalidate(new RunnerLeaseLostError("runner_lease_renewal_rejected", "Runner lease renewal was rejected by the control plane.", { cause: error }));
        return;
      }
      console.warn(`runner_lease_renew_failed:${identity.leaseId}:${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      guard.signal.removeEventListener("abort", abortRequest);
      requestController = undefined;
      inFlight = undefined;
    });
  };
  const timer = setInterval(renew, 30_000);
  return {
    signal: guard.signal,
    assertActive() {
      guard.assertActive();
    },
    bindContext(context: BrowserContext) {
      guard.onInvalidate(() => closeRecordedContext(context));
      guard.assertActive();
    },
    async beginCompletion() {
      completing = true;
      clearInterval(timer);
      await inFlight?.catch(() => undefined);
      guard.assertActive();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      requestController?.abort();
      await inFlight?.catch(() => undefined);
      await guard.dispose();
    },
  };
}
type LeaseRuntimeGuard = ReturnType<typeof startLeaseRenewal>;

function startCrawlLeaseRenewal(runnerId: string, job: CrawlJob | SitePreviewJob, workload: "crawl" | "site-preview" = "crawl") {
  const owned = job.lease;
  if (!owned) return startLeaseRenewal(runnerId, undefined);
  let stopped = false;
  let completing = false;
  let inFlight: Promise<unknown> | undefined;
  const guard = new RunnerLeaseGuard(owned.expiresAt);
  const renew = () => {
    if (stopped || completing || inFlight || guard.signal.aborted) return;
    inFlight = api<{ expiresAt?: string }>(
      `/api/validation/runners/${encodeURIComponent(runnerId)}/${workload}/renew`,
      {
        method: "POST",
        headers: headers({ "x-sitewake-lease-token": owned.token }),
        body: JSON.stringify({ jobId: job.id }),
        signal: guard.signal,
      },
    ).then((result) => {
      if (!result.expiresAt || !guard.updateExpiry(result.expiresAt)) {
        guard.invalidate(new RunnerLeaseLostError(
          `${workload}_lease_renewal_invalid`,
          "Background lease renewal returned no usable expiry.",
        ));
      }
    }).catch((error) => {
      if (stopped || guard.signal.aborted) return;
      if (error instanceof RunnerApiError
        && [401, 403, 409].includes(error.status)) {
        guard.invalidate(new RunnerLeaseLostError(
          `${workload}_lease_renewal_rejected`,
          "Background lease renewal was rejected by the control plane.",
          { cause: error },
        ));
        return;
      }
      console.warn(`${workload}_lease_renew_failed:${job.id}:${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      inFlight = undefined;
    });
  };
  const timer = setInterval(renew, 30_000);
  return {
    signal: guard.signal,
    assertActive() {
      guard.assertActive();
    },
    bindContext(context: BrowserContext) {
      guard.onInvalidate(() => closeRecordedContext(context));
      guard.assertActive();
    },
    async beginCompletion() {
      completing = true;
      clearInterval(timer);
      await inFlight?.catch(() => undefined);
      guard.assertActive();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight?.catch(() => undefined);
      await guard.dispose();
    },
  };
}

function startAuthoringKeyframes(page: Page, runnerId: string, run: BrowserRun, leaseGuard: LeaseRuntimeGuard) {
  let stopped = false; let uploading = false; let sequence = 0;
  const capture = async () => {
    if (stopped || uploading || page.isClosed() || leaseGuard.signal?.aborted) return;
    uploading = true;
    let path: string | undefined;
    try {
      sequence += 1;
      path = `${artifactDirectory}/${run.id}-live-${sequence}.jpg`;
      await page.screenshot({ path, type: "jpeg", quality: 32, fullPage: false });
      const artifact = await uploadArtifact(path, { siteAgentId: run.siteAgentId, learningJobId: run.learningJobId, runId: run.id, kind: "screenshot", label: `AI 编程现场 · ${sequence}`, contentType: "image/jpeg" });
      if (artifact) await heartbeat(runnerId, "busy", { learningJobId: run.learningJobId, phase: run.progress?.stage === "executing" || run.progress?.stage === "judging" ? "testing" : run.progress?.stage === "authoring" ? "coding" : "observing", message: run.progress?.message || "AI Program Author 正在浏览器中工作", artifactIds: [artifact.id] }).catch(() => undefined);
    } catch { /* A live keyframe must never fail the authoring task. */ }
    finally { await removeLocalMedia([path]); uploading = false; }
  };
  const timer = setInterval(() => void capture(), 10_000);
  return async () => { stopped = true; clearInterval(timer); while (uploading) await new Promise((resolve) => setTimeout(resolve, 25)); };
}
async function startRun(runnerId: string, token: string, run: BrowserRun, leaseGuard: LeaseRuntimeGuard) {
  leaseGuard.assertActive();
  await api(`/api/validation/runners/${encodeURIComponent(runnerId)}/runs/start`, { method: "POST", headers: headers({ "x-sitewake-lease-token": token }), body: JSON.stringify(run), signal: leaseGuard.signal });
}
async function reportProgress(runnerId: string, token: string, run: BrowserRun, stage: NonNullable<BrowserRun["progress"]>["stage"], message: string, current: number | undefined, total: number | undefined, leaseGuard: LeaseRuntimeGuard) {
  leaseGuard.assertActive();
  run.progress = { stage, message, current, total, updatedAt: new Date().toISOString() };
  await Promise.all([
    startRun(runnerId, token, run, leaseGuard).catch(() => undefined),
    heartbeat(runnerId, "busy", runnerActivity(stage, message, run.learningJobId)).catch(() => undefined),
  ]);
  leaseGuard.assertActive();
}
async function completeRun(runnerId: string, token: string, run: BrowserRun, leaseGuard: LeaseRuntimeGuard, candidate?: KnowledgeCandidate) {
  leaseGuard.assertActive();
  await leaseGuard.beginCompletion();
  return retryRunnerCompletion(
    () => api(`/api/validation/runners/${encodeURIComponent(runnerId)}/runs/complete`, {
      method: "POST",
      headers: headers({ "x-sitewake-lease-token": token }),
      body: JSON.stringify({ run, candidate }),
      signal: leaseGuard.signal,
    }),
    {
      signal: leaseGuard.signal,
      shouldRetry: (error) => error instanceof RunnerApiError
        ? error.status === 408 || error.status === 429 || error.status >= 500
        : true,
    },
  );
}
type RawAuthoringDraft = {
  rationale?: string;
  alternatives?: Array<{ id?: string; kind?: string; label?: string; rationale?: string; selected?: boolean }>;
  targets?: Array<{ key?: string; name?: string; purpose?: string; sceneIds?: string[]; role?: string; accessibleNames?: string[]; locators?: Array<{ strategy?: string; value?: string; role?: string; score?: number }> }>;
  implementation?: { kind?: string; steps?: Array<Record<string, unknown>>; moduleSource?: string };
  outputBindings?: Record<string, unknown>;
  verifier?: CompletionVerifier;
};

function authoringReceipt(run: BrowserRun, label: string, status: BrowserStepReceipt["status"], evidence: Record<string, JsonValue> = {}, error?: { code: string; message: string }) {
  const at = new Date().toISOString();
  run.steps.push({ stepId: uid("authoring_step"), op: "adaptive", label, status, startedAt: at, endedAt: at, evidence, error });
}

function expression(value: unknown) {
  if (!value || typeof value !== "object") return { source: "literal" as const, value: (value ?? null) as JsonValue };
  const raw = value as Record<string, unknown>;
  if (raw.source === "input" || raw.source === "state" || raw.source === "step") return { source: raw.source, path: String(raw.path || "") } as const;
  return { source: "literal" as const, value: (raw.value ?? null) as JsonValue };
}

function normalizeVerifier(raw: CompletionVerifier | undefined, targetIds: Map<string, string>): CompletionVerifier {
  const map = (items: CompletionVerifier["success"] | undefined) => (items || []).flatMap((item) => {
    if (!item || !["scene", "url", "text", "target", "input-visible"].includes(item.kind) || !String(item.value || "").trim()) return [];
    return [{ ...item, value: item.kind === "target" ? targetIds.get(item.value) || item.value : String(item.value).slice(0, 300) }];
  });
  const business = (items: CompletionVerifier["businessRejection"] | undefined) => (items || []).flatMap((item) => item && ["url", "text", "target"].includes(item.kind) && String(item.value || "").trim() ? [{ ...item, value: item.kind === "target" ? targetIds.get(item.value) || item.value : String(item.value).slice(0, 300) }] : []);
  return { success: map(raw?.success), noResult: business(raw?.noResult), businessRejection: business(raw?.businessRejection) };
}

function parameterizeVerifier(verifier: CompletionVerifier, candidate: KnowledgeCandidate) {
  const sampleValues = (candidate.authoring?.requiredInputs || [])
    .map((field) => field.value)
    .filter((value): value is JsonValue => value !== undefined && value !== null && String(value).length > 1);
  const hasDynamicInput = verifier.success.some((item) => item.kind === "input-visible");
  if (!hasDynamicInput || !sampleValues.length) return verifier;
  const sampleBound = (value: string) => sampleValues.some((sample) => value.normalize("NFKC").includes(String(sample).normalize("NFKC")));
  return {
    ...verifier,
    success: verifier.success.filter((item) => !((item.kind === "text" || item.kind === "url") && sampleBound(item.value))),
  };
}

function normalizeDraft(raw: RawAuthoringDraft, lease: Extract<RunnerLease, { kind: "author" }>, moduleRef?: ProgramModuleRef): { draft: AuthoringDraft; candidate: KnowledgeCandidate } {
  const now = new Date().toISOString();
  const scenes = [...lease.candidate.scenes, ...lease.release.scenes];
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const targets: TargetSpec[] = (raw.targets || []).flatMap((item) => {
    const key = String(item.key || item.name || "").trim();
    const locators = (item.locators || []).flatMap((variant) => {
      const strategy = String(variant.strategy || "") as LocatorVariant["strategy"];
      const value = String(variant.value || "").trim();
      if (!value || !["role", "label", "placeholder", "name", "text", "href-template", "css"].includes(strategy)) return [];
      return [{ id: `locator_${stableHash(`${strategy}:${variant.role || ""}:${value}`)}`, strategy, value: value.slice(0, 500), role: variant.role?.slice(0, 60), score: Math.max(0.5, Math.min(0.99, Number(variant.score || 0.75))), successes: 0, failures: 0, lastSeenAt: now }];
    });
    if (!key || !locators.length) return [];
    const id = `target_${stableHash(`${lease.candidate.id}:${key}`)}`;
    return [{ id, name: String(item.name || key).slice(0, 120), purpose: String(item.purpose || "").slice(0, 240), sceneIds: (item.sceneIds || []).filter((id) => sceneIds.has(id)), role: item.role?.slice(0, 60), accessibleNames: [...new Set([...(item.accessibleNames || []), ...locators.map((item) => item.value)])].filter(Boolean).slice(0, 12), attributes: {}, locatorVariants: locators, updatedAt: now }];
  });
  const targetIds = new Map((raw.targets || []).flatMap((item) => {
    const key = String(item.key || item.name || "").trim();
    const id = `target_${stableHash(`${lease.candidate.id}:${key}`)}`;
    return key && targets.some((target) => target.id === id) ? [[key, id] as [string, string]] : [];
  }));
  const rawSteps = raw.implementation?.steps || [];
  const startSceneId = lease.candidate.scenes[0]?.id;
  const inferredToSceneId = lease.candidate.scenes.at(-1)?.id;
  const expectedOrigin = new URL(lease.episode.startSnapshot.url).origin;
  const transitionFor = (rawStep: Record<string, unknown>, fallback = false) => {
    const kind = String(rawStep.transitionKind || "");
    const sceneId = String(rawStep.transitionSceneId || (fallback ? inferredToSceneId || "" : ""));
    if (!["spa", "document", "new-tab"].includes(kind) && !fallback) return undefined;
    if (!sceneId || !sceneIds.has(sceneId)) return undefined;
    return { kind: (["spa", "document", "new-tab"].includes(kind) ? kind : "document") as "spa" | "document" | "new-tab", expectedSceneIds: [sceneId], expectedOrigin };
  };
  const steps: PageProgramStep[] = rawSteps.flatMap((rawStep, index) => {
    const op = String(rawStep.op || ""); const id = `step_${stableHash(`${lease.candidate.id}:${index}:${op}`)}`; const timeoutMs = Math.max(1000, Math.min(30000, Number(rawStep.timeoutMs || 8000)));
    if (op === "navigate" && sceneIds.has(String(rawStep.sceneId || ""))) return [{ id, op, sceneId: String(rawStep.sceneId), bindings: Object.fromEntries(Object.entries((rawStep.bindings || {}) as Record<string, unknown>).map(([key, value]) => [key, expression(value)])), timeoutMs, transition: transitionFor(rawStep, true) }];
    const targetId = targetIds.get(String(rawStep.targetKey || rawStep.targetId || ""));
    if (op === "click" && targetId) return [{ id, op, targetId, timeoutMs, transition: transitionFor(rawStep, index === rawSteps.length - 1 && Boolean(inferredToSceneId && inferredToSceneId !== startSceneId)) }];
    if ((op === "fill" || op === "type" || op === "select") && targetId) return [{ id, op, targetId, value: expression(rawStep.value), timeoutMs } as PageProgramStep];
    if (op === "extract" && targetId) {
      const saveAs = String(rawStep.saveAs || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
      const schemaType = ["string", "number", "boolean", "object", "array"].includes(String(rawStep.schemaType)) ? String(rawStep.schemaType) as "string" | "number" | "boolean" | "object" | "array" : "string";
      return saveAs ? [{ id, op, targetId, attribute: typeof rawStep.attribute === "string" ? rawStep.attribute.slice(0, 100) : undefined, schema: { type: schemaType }, saveAs, timeoutMs }] : [];
    }
    if (op === "press") return [{ id, op, targetId, key: String(rawStep.key || "Enter"), timeoutMs }];
    if (op === "waitForTarget" && targetId) return [{ id, op, targetId, timeoutMs }];
    if ((op === "waitForScene" || op === "assertScene") && sceneIds.has(String(rawStep.sceneId || ""))) return [{ id, op, sceneId: String(rawStep.sceneId), timeoutMs } as PageProgramStep];
    if (op === "waitForCondition") return [{ id, op, text: typeof rawStep.text === "string" ? rawStep.text : undefined, urlPattern: typeof rawStep.urlPattern === "string" ? rawStep.urlPattern : undefined, timeoutMs }];
    return [];
  });
  const program: PageProgram = { version: 2, steps };
  const capabilityInputIds = new Set(Object.keys(lease.candidate.capability.inputs.properties || {}));
  for (const step of steps) {
    if (step.op !== "navigate") continue;
    const scene = scenes.find((item) => item.id === step.sceneId);
    if (!scene) throw new Error(`author_scene_missing:${step.sceneId}`);
    for (const parameter of scene.parameters.filter((item) => item.required)) {
      const binding = step.bindings[parameter.id];
      if (!binding) throw new Error(`author_scene_binding_missing:${scene.id}:${parameter.id}`);
      if (binding.source === "input" && (!binding.path || !capabilityInputIds.has(binding.path))) {
        throw new Error(`author_scene_input_binding_invalid:${scene.id}:${parameter.id}:${binding.path || "missing"}`);
      }
    }
  }
  const verifier = parameterizeVerifier(normalizeVerifier(raw.verifier, targetIds), lease.candidate);
  if (!verifier.success.length) throw new Error("author_verifier_missing");
  if (raw.implementation?.kind !== "module" && !steps.length) throw new Error("author_program_empty");
  if (raw.implementation?.kind === "module" && !moduleRef) throw new Error("author_module_missing");
  const iterationId = uid("authoring_iteration");
  const implementationId = `implementation_${stableHash(`${lease.candidate.id}:${JSON.stringify(raw.implementation)}`)}`;
  const authored = raw.implementation?.kind === "module"
    ? { kind: "module" as const, module: moduleRef!, proof: { version: 1 as const, iterationId, author: "ai-program-author" as const, rationale: String(raw.rationale || "AI selected module implementation").slice(0, 800), alternativeIds: (raw.alternatives || []).map((item) => String(item.id || "")).filter(Boolean), verifier, groundedTargetIds: [], createdAt: now } }
    : { kind: "page-program" as const, program, proof: { version: 1 as const, iterationId, author: "ai-program-author" as const, rationale: String(raw.rationale || "AI selected PageProgram implementation").slice(0, 800), alternativeIds: (raw.alternatives || []).map((item) => String(item.id || "")).filter(Boolean), verifier, groundedTargetIds: [], createdAt: now } };
  const alternatives = (raw.alternatives || []).slice(0, 6).map((item, index) => ({ id: String(item.id || `alternative-${index}`).slice(0, 80), kind: item.kind === "module" ? "module" as const : "page-program" as const, label: String(item.label || `方案 ${index + 1}`).slice(0, 120), rationale: String(item.rationale || "").slice(0, 500), selected: item.selected === true })).map((item, index, all) => ({ ...item, selected: all.some((entry) => entry.selected) ? item.selected : index === 0 }));
  const classifiers = (items: CompletionVerifier["success"]) => items.filter((item) => item.kind === "url" || item.kind === "text" || item.kind === "target").map((item) => ({ kind: item.kind as "url" | "text" | "target", value: item.value }));
  const outcomes = [
    { id: `outcome_${stableHash(`${lease.candidate.id}:success`)}`, status: "success" as const, code: "authored_success", description: `已完成：${lease.candidate.capability.name}`, classifiers: classifiers(verifier.success) },
    ...(verifier.noResult.length ? [{ id: `outcome_${stableHash(`${lease.candidate.id}:no-result`)}`, status: "no-result" as const, code: "no_result", description: "查询完成，但没有符合条件的结果", classifiers: classifiers(verifier.noResult) }] : []),
    ...(verifier.businessRejection.length ? [{ id: `outcome_${stableHash(`${lease.candidate.id}:business-rejection`)}`, status: "business-rejection" as const, code: "business_rejection", description: "网站拒绝了当前业务请求", classifiers: classifiers(verifier.businessRejection) }] : []),
  ];
  const operationId = `operation_${stableHash(`${lease.candidate.id}:${implementationId}`)}`;
  const directlyAddressable = program.steps.length > 0 && program.steps[0].op === "navigate";
  const fromScene = directlyAddressable ? "*" : startSceneId || "*"; const toScene = inferredToSceneId;
  const defaultOutputBindings: CapabilityDefinition["plans"][number]["outputBindings"] = Object.fromEntries((lease.candidate.authoring?.resultFields || []).map((field) => {
    if (field.source === "page-url") return [field.id, { source: "state", path: "__pageUrl" }];
    if (field.source === "page-title") return [field.id, { source: "state", path: "__pageTitle" }];
    if (field.source === "page-heading") return [field.id, { source: "state", path: "__pageHeading" }];
    if (field.source === "input") return [field.id, { source: "input", path: field.inputId || field.id }];
    return [field.id, { source: "state", path: field.id }];
  })) as CapabilityDefinition["plans"][number]["outputBindings"];
  const outputBindings: CapabilityDefinition["plans"][number]["outputBindings"] = { ...defaultOutputBindings, ...Object.fromEntries(Object.entries(raw.outputBindings || {}).map(([key, value]) => [key, expression(value)])) };
  const operation = {
    id: operationId, name: lease.candidate.capability.name, description: String(raw.rationale || "").slice(0, 300), kind: directlyAddressable ? "navigation" as const : "task" as const, evidenceSource: "ai-authored" as const,
    applicability: directlyAddressable
      ? { scope: "any-scene" as const, evidenceSceneIds: [lease.candidate.scenes[0]?.id].filter(Boolean) as string[] }
      : { scope: "scene-set" as const, sceneIds: [fromScene].filter((id) => id !== "*"), evidenceSceneIds: [fromScene].filter((id) => id !== "*") },
    fromSceneId: fromScene, toSceneId: toScene, inputs: lease.candidate.capability.inputs, outputs: lease.candidate.capability.outputs,
    preconditions: fromScene === "*" ? [] : [`scene:${fromScene}`], effects: toScene ? [`scene:${toScene}`] : [],
    implementations: [{ id: implementationId, program, authored, conditions: [], successes: 0, failures: 0, sourceEpisodeIds: lease.candidate.sourceEpisodeIds }],
    verification: { sceneId: toScene, targetIds: verifier.success.filter((item) => item.kind === "target").map((item) => item.value), textIncludes: verifier.success.filter((item) => item.kind === "text").map((item) => item.value), outcomeIds: outcomes.map((item) => item.id) }, status: "candidate" as const, updatedAt: now,
  };
  const candidate: KnowledgeCandidate = {
    ...lease.candidate, targets, operations: [operation],
    capability: { ...lease.candidate.capability, module: moduleRef, exposure: "public", resultKind: lease.candidate.capability.resultKind || ((lease.candidate.authoring?.resultFields || []).some((field) => !["pageUrl", "pageTitle", "pageHeading"].includes(field.id)) ? "data" : "page"), outcomes, plans: [{ id: `plan_${stableHash(operationId)}`, entrySceneIds: [fromScene], steps: [{ operationId, bindings: {} }], outputBindings }], status: "learning", updatedAt: now },
    authoring: { ...lease.candidate.authoring!, stage: "authored", reusableTrace: false, selectedImplementationId: implementationId, alternatives, iterations: [...(lease.candidate.authoring?.iterations || []), { id: iterationId, attempt: (lease.candidate.authoring?.iterations?.length || 0) + 1, status: "proposed", createdAt: now }] }, updatedAt: now,
  };
  const draft: AuthoringDraft = { id: uid("authoring_draft"), version: 1, capabilityId: candidate.capability.id, rationale: authored.proof.rationale, alternatives, targets, implementation: authored, createdAt: now };
  return { draft, candidate };
}

async function persistModule(siteAgentId: string, source: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const response = await fetch(`${endpoint}/api/programs`, { method: "POST", headers: headers(), body: JSON.stringify({ siteAgentId, source }), signal });
  if (!response.ok) throw new Error(`program_module_save_failed:${response.status}:${await response.text()}`);
  signal?.throwIfAborted();
  return (await response.json() as { module: ProgramModuleRef }).module;
}

function mapHarnessPhase(phase: HarnessEvent["phase"]): NonNullable<BrowserRun["progress"]>["stage"] {
  if (phase === "coding" || phase === "proposing") return "authoring";
  if (phase === "running" || phase === "testing") return "executing";
  return "observing";
}

// Serialize the live DOM into an inert `full` replay frame. Scripts are kept as
// empty placeholders and sensitive inputs are redacted, matching the browser
// recorder contract so the same DomReplayPlayer can replay coding sessions.
async function serializeAuthorDom(page: Page): Promise<SerializedNode | null> {
  return page.evaluate(() => {
    const MAX_NODES = 8000; const MAX_ATTR = 2000; const MAX_TEXT = 4000;
    let counter = 0; const budget = { count: 0 };
    const truncate = (value: string | null | undefined, max: number) => { const text = value ?? ""; return text.length > max ? `${text.slice(0, max)}…` : text; };
    const isSensitive = (element: Element) => {
      const type = (element.getAttribute("type") || "").toLowerCase();
      const name = `${element.getAttribute("name") || ""} ${element.getAttribute("autocomplete") || ""}`.toLowerCase();
      return type === "password" || /otp|one-time|totp|cvv|card/.test(name);
    };
    type Node2 = { id: number; type: "element" | "text" | "comment"; tag?: string; attrs?: Record<string, string>; text?: string; children?: Node2[]; masked?: boolean };
    const serialize = (node: Node): Node2 | null => {
      if (budget.count >= MAX_NODES) return null;
      budget.count += 1; const id = ++counter;
      if (node.nodeType === 3) return { id, type: "text", text: truncate(node.textContent, MAX_TEXT) };
      if (node.nodeType === 8) return { id, type: "comment", text: truncate(node.textContent, 400) };
      if (node.nodeType !== 1) return null;
      const element = node as Element; const tag = element.tagName.toLowerCase();
      if (tag === "script") return { id, type: "element", tag, attrs: {}, children: [] };
      const masked = isSensitive(element);
      const attrs: Record<string, string> = {};
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name.startsWith("on")) continue;
        if (masked && (attribute.name === "value" || attribute.name === "placeholder")) continue;
        attrs[attribute.name] = truncate(attribute.value, MAX_ATTR);
      }
      if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
        if (masked) attrs.value = ""; else if (element.value) attrs.value = truncate(element.value, MAX_ATTR);
      }
      const out: Node2 = { id, type: "element", tag, attrs }; if (masked) out.masked = true;
      const children: Node2[] = [];
      for (const child of Array.from(element.childNodes)) { if (budget.count >= MAX_NODES) break; const c = serialize(child); if (c) children.push(c); }
      out.children = children; return out;
    };
    return serialize(document.documentElement) as unknown as SerializedNode | null;
  }).catch(() => null);
}

/**
 * Collects `full` DOM replay frames while the coding agent works and streams
 * them to the control plane as author-run chunks (origin "run", tagged with the
 * BrowserRun id). Best-effort: a capture or upload failure never fails coding.
 */
function createAuthorReplayCollector(page: Page, run: BrowserRun, leaseGuard: LeaseRuntimeGuard) {
  const sessionId = uid("codexreplay"); const documentId = uid("codexdoc");
  let seq = 0; let frames: DomReplayFrame[] = []; let capturing = false;
  const flush = async () => {
    leaseGuard.assertActive();
    if (!frames.length) return; const batch = frames; frames = [];
    const chunk: DomReplayChunk = { id: uid("domchunk"), siteAgentId: run.siteAgentId, sessionId, documentId, runId: run.id, origin: "run", seqStart: batch[0].seq, seqEnd: batch[batch.length - 1].seq, frames: batch, createdAt: new Date().toISOString() };
    await api(`/api/site-agents/${encodeURIComponent(run.siteAgentId)}/dom-replay`, { method: "POST", body: JSON.stringify({ chunk }), signal: leaseGuard.signal }).catch((error) => {
      leaseGuard.assertActive();
      console.warn(`author_replay_upload_failed:${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const capture = async () => {
    leaseGuard.assertActive();
    if (capturing || page.isClosed()) return; capturing = true;
    try {
      const full = await serializeAuthorDom(page);
      leaseGuard.assertActive();
      if (full) { seq += 1; frames.push({ seq, at: new Date().toISOString(), kind: "full", full, url: page.url() }); }
      if (frames.length >= 12) await flush();
    } catch {
      leaseGuard.assertActive();
      /* replay is best-effort evidence */
    } finally { capturing = false; }
  };
  return { capture, flush };
}

function createPlaywrightAuthoringBridge(options: {
  page: Page;
  startUrl: string;
  outputSchema: CapabilityDefinition["outputs"];
  persistBundle(source: string): Promise<ProgramModuleRef>;
  leaseGuard: LeaseRuntimeGuard;
}) {
  let activePage = options.page;
  let snapshotSequence = 0;
  const bridge: BrowserBridge = {
    getDom: async (request = {}) => {
      options.leaseGuard.assertActive();
      const snapshotId = request.snapshotId || `dom_${++snapshotSequence}_${stableHash(`${activePage.url()}:${Date.now()}`)}`;
      if (!request.selector) {
        const semantic = await activePage.locator("body").ariaSnapshot({ timeout: 10_000 }).catch(async () => {
          const title = await activePage.title().catch(() => "");
          const text = await activePage.locator("body").innerText().catch(() => "");
          return `${title}\n${text}`;
        });
        options.leaseGuard.assertActive();
        return { snapshotId, url: activePage.url(), kind: "semantic" as const, content: semantic.slice(0, 16_000) };
      }
      const cursor = Math.max(0, Number(request.cursor || 0) || 0);
      const payload = await activePage.locator(request.selector).first().evaluate((element, start) => {
        const children = Array.from(element.children);
        if (!children.length) {
          const html = element.outerHTML;
          return { content: html.slice(start, start + 16_000), next: start + 16_000 < html.length ? String(start + 16_000) : undefined };
        }
        const chunks: string[] = [];
        let bytes = 0;
        let index = start;
        while (index < children.length) {
          const html = children[index].outerHTML;
          if (chunks.length && bytes + html.length > 16_000) break;
          chunks.push(html); bytes += html.length; index += 1;
        }
        return { content: chunks.join("\n"), next: index < children.length ? String(index) : undefined };
      }, cursor);
      options.leaseGuard.assertActive();
      return { snapshotId, url: activePage.url(), kind: "html" as const, content: payload.content, nextCursor: payload.next };
    },
    executeJs: async ({ source, args }) => {
      options.leaseGuard.assertActive();
      const before = activePage.url();
      let openedPage: Page | undefined;
      let navigated = false;
      const context = activePage.context();
      const sourcePage = activePage;
      const onPage = (candidate: Page) => { if (candidate !== sourcePage) openedPage = candidate; };
      const onFrame = (frame: import("playwright").Frame) => { if (frame === sourcePage.mainFrame()) navigated = true; };
      context.on("page", onPage); sourcePage.on("framenavigated", onFrame);
      let result: JsonValue | undefined;
      try {
        await sourcePage.evaluate<void, unknown>((value) => { (globalThis as typeof globalThis & { __sitewakeArgs?: unknown }).__sitewakeArgs = value; }, args);
        try { result = await sourcePage.evaluate(source) as JsonValue; }
        catch (error) { if (!/execution context was destroyed|frame was detached/i.test(error instanceof Error ? error.message : String(error))) throw error; }
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (openedPage) {
          activePage = openedPage;
          await activePage.waitForLoadState("domcontentloaded", { timeout: 20_000 });
        } else if (navigated) await sourcePage.waitForLoadState("domcontentloaded", { timeout: 20_000 });
      } finally {
        context.off("page", onPage); sourcePage.off("framenavigated", onFrame);
      }
      options.leaseGuard.assertActive();
      return { url: activePage.url(), result, transition: openedPage ? "new-page" as const : navigated || activePage.url() !== before ? "navigation" as const : "none" as const };
    },
    runDraft: async ({ source, input, runId }) => {
      options.leaseGuard.assertActive();
      const moduleRef = await options.persistBundle(source);
      options.leaseGuard.assertActive();
      await activePage.goto(options.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      try {
        const result = await runPlaywrightCapabilityStages({ page: activePage, moduleUrl: new URL(moduleRef.moduleUrl, browserPublicEndpoint).href, input, outputSchema: options.outputSchema });
        options.leaseGuard.assertActive();
        activePage = result.page;
        return { fixtureId: runId, outcome: "success" as const, producedFieldIds: Object.keys(result.output), producedValues: result.output, runId };
      } catch (error) {
        options.leaseGuard.assertActive();
        const message = error instanceof Error ? error.message : String(error);
        const receipts = error instanceof PlaywrightStageRunError
          ? error.receipts.slice(-3).map((receipt) => ({
            stageId: receipt.stageId,
            transition: receipt.transition,
            urlBefore: receipt.urlBefore,
            urlAfter: receipt.urlAfter,
          }))
          : [];
        return {
          fixtureId: runId,
          outcome: "execution-fault" as const,
          producedFieldIds: [],
          error: receipts.length ? `${message}; receipts=${JSON.stringify(receipts)}` : message,
          runId,
        };
      }
    },
  };
  return { bridge, get activePage() { return activePage; } };
}

function matchesDeclaredNavigationTarget(candidate: KnowledgeCandidate, url: string) {
  let actual: URL;
  try {
    actual = new URL(url);
  } catch {
    return false;
  }
  return candidate.capability.outcomes
    .flatMap((outcome) => outcome.classifiers)
    .filter((classifier) => classifier.kind === "url")
    .some((classifier) => {
      try {
        const expected = new URL(classifier.value, actual.origin);
        return actual.origin === expected.origin
          && actual.pathname === expected.pathname
          && actual.search === expected.search;
      } catch {
        return false;
      }
    });
}

// The only production authoring path: Codex CLI writes a small workspace, the
// deterministic harness runs its smoke case in the real page, then persists the
// authored module and proof. Failures stay explicit and are retried as Codex jobs.
async function runCodexAuthoringSession(page: Page, lease: Extract<RunnerLease, { kind: "author" }>, run: BrowserRun, runnerId: string, token: string, input: Record<string, JsonValue>, goal: string, leaseGuard: LeaseRuntimeGuard): Promise<KnowledgeCandidate> {
  leaseGuard.assertActive();
  const contract = lease.candidate.authoring;
  const coreFieldIds = (contract?.resultFields || []).filter((field) => field.importance === "core").map((field) => field.id);
  const siteAgentId = lease.job.siteAgentId;
  const startOrigin = new URL(run.startUrl).origin;
  const autonomousNavigation = lease.candidate.capability.kind === "navigation" && lease.episode.mode === "author-request";
  const targetTerm = autonomousNavigation ? navigationTargetTerm(goal) : "";
  await page.goto(run.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const verifier: CompletionVerifier = {
    success: autonomousNavigation && targetTerm ? [{ kind: "text", value: targetTerm }] : [{ kind: "url", value: startOrigin }],
    noResult: [],
    businessRejection: [],
  };
  const { build } = await import("esbuild");
  const esbuildBuild: EsbuildBuild = async (options) => {
    const result = await build(options as Parameters<typeof build>[0]);
    return { outputFiles: result.outputFiles?.map((file) => ({ text: file.text })), errors: result.errors?.map((error) => ({ text: error.text })) };
  };
  const persistedBundles = new Map<string, ProgramModuleRef>();
  const replay = createAuthorReplayCollector(page, run, leaseGuard);
  const persistBundle = async (source: string) => {
    const cached = persistedBundles.get(source);
    if (cached) return cached;
    leaseGuard.assertActive();
    const moduleRef = await persistModule(siteAgentId, source, leaseGuard.signal);
    leaseGuard.assertActive();
    persistedBundles.set(source, moduleRef);
    return moduleRef;
  };
  const authoringBrowser = createPlaywrightAuthoringBridge({ page, startUrl: run.startUrl, outputSchema: lease.candidate.capability.outputs, persistBundle, leaseGuard });
  const bridge = authoringBrowser.bridge;
  const progressEvents = createCoalescingAsyncQueue<HarnessEvent>(
    async (event) => {
      leaseGuard.assertActive();
      await reportProgress(runnerId, token, run, mapHarnessPhase(event.phase), `Codex · ${event.message}`, undefined, undefined, leaseGuard);
    },
    (error) => {
      if (!isRunnerLeaseLostError(error)) console.warn(`authoring_progress_failed:${error instanceof Error ? error.message : String(error)}`);
    },
  );
  const deps: HarnessDeps = {
    build: esbuildBuild,
    bridge,
    persistModule: (source) => persistModule(siteAgentId, source, leaseGuard.signal),
    verifier,
    coreFieldIds,
    onEvent: (event) => { progressEvents.push(event); },
    makeRunId: () => uid("codex_run"),
  };
  const context: AuthoringSessionContext = {
    goal,
    intent: contract?.reason,
    reviewFeedback: lease.reviewFeedback,
    startUrl: run.startUrl,
    ...(lease.episode.mode !== "author-request" ? { observedSuccessUrl: lease.episode.endSnapshot.url } : {}),
    modelProxyBaseUrl: `${endpoint}/api/site-agents/${encodeURIComponent(siteAgentId)}/model/v2`,
    sampleInput: input,
    coreFieldIds,
    specDoc: lease.specDoc,
  };
  let session: Awaited<ReturnType<typeof runAuthoringSession>>;
  try {
    await reportProgress(runnerId, token, run, "authoring", "Codex CLI 正在工程目录中面向目标编写能力", undefined, undefined, leaseGuard);
    session = await runAuthoringSession(new CodexAuthoringDriver({
      codexBin: process.env.SITEWAKE_CODEX_BIN,
      seedSource: compileVerifiedEntryCapability(lease.candidate),
      signal: leaseGuard.signal,
    }), context, deps);
  } finally {
    await progressEvents.close();
  }
  leaseGuard.assertActive();
  const projectId = lease.specDoc?.projectId || (typeof lease.job.result?.projectId === "string" ? lease.job.result.projectId : undefined);
  if (!session.ok || session.implementation.kind !== "module") {
    if (projectId) {
      const failedWorkspace: PersistedAuthoringWorkspace = {
        id: uid("workspace"), siteAgentId, projectId, learningJobId: lease.job.id, runId: run.id,
        hash: session.workspace.hash, files: session.workspace.files,
        report: session.report ? { total: session.report.total, passed: session.report.passed, failed: session.report.failed, coveredFieldIds: session.report.coveredFieldIds } : undefined,
        provingRuns: 0, codingAgent: "codex", createdAt: new Date().toISOString(),
      };
      await api(`/api/site-agents/${encodeURIComponent(siteAgentId)}/authoring-workspaces`, { method: "POST", body: JSON.stringify({ workspace: failedWorkspace }), signal: leaseGuard.signal }).catch((error) => {
        leaseGuard.assertActive();
        console.warn(`authoring_workspace_save_failed:${error instanceof Error ? error.message : String(error)}`);
      });
    }
    authoringReceipt(run, "Codex 会话未产出通过自证的模块", "failed", { phase: "codex", reasons: (session.ok ? [] : session.reasons) as JsonValue }, { code: "codex_no_submit", message: session.ok ? "non-module implementation" : session.reasons.join("; ") });
    throw new Error(`codex_no_submit:${session.ok ? "non-module implementation" : session.reasons.join("; ")}`);
  }
  const moduleRef = session.implementation.module;
  authoringReceipt(run, "Codex 完成编写并通过自证门禁", "passed", { phase: "codex", workspaceHash: session.workspace.hash, provingRuns: (session.implementation.proof.provingRuns || []).length, fixtures: session.report?.total ?? 0 });
  const raw: RawAuthoringDraft = { rationale: session.implementation.proof.rationale, alternatives: [], targets: [], implementation: { kind: "module" }, outputBindings: {}, verifier };
  const normalized = normalizeDraft(raw, lease, moduleRef);
  let authored = normalized.candidate;
  const implementation = authored.operations[0]?.implementations[0];
  if (!implementation?.authored) throw new Error("author_implementation_missing");
  await reportProgress(runnerId, token, run, "executing", "正在从洁净起点复算 Codex 编写的能力", undefined, undefined, leaseGuard);
  await authoringBrowser.activePage.goto(run.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const before = await snapshot(authoringBrowser.activePage);
  const finalRun = await runPlaywrightCapabilityStages({ page: authoringBrowser.activePage, moduleUrl: new URL(moduleRef.moduleUrl, browserPublicEndpoint).href, input, outputSchema: authored.capability.outputs });
  await finalRun.page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
  await replay.capture();
  const after = await snapshot(finalRun.page);
  let provenNavigationRules: CompletionVerifier["success"] | undefined;
  if (authored.capability.kind === "navigation") {
    provenNavigationRules = navigationTargetEvidence(goal, before, after, {
      semanticJudged: matchesDeclaredNavigationTarget(lease.candidate, after.url),
    });
    if (!provenNavigationRules) throw new Error("scene_assertion_failed");
    const targetScene = sceneFromSnapshot(after, after.heading || after.title || authored.capability.name);
    authored = {
      ...authored,
      scenes: [...authored.scenes.filter((scene) => scene.id !== targetScene.id), targetScene],
      operations: authored.operations.map((operation) => ({
        ...operation,
        kind: "navigation",
        toSceneId: targetScene.id,
        effects: [`scene:${targetScene.id}`],
        verification: { ...operation.verification, sceneId: targetScene.id },
      })),
    };
  }
  const mergedProof: AuthoringProof = {
    ...implementation.authored.proof,
    ...(provenNavigationRules ? { verifier: { ...implementation.authored.proof.verifier, success: provenNavigationRules } } : {}),
    provingRuns: session.implementation.proof.provingRuns || [],
    workspaceHash: session.workspace.hash,
    codingAgent: "codex",
    rationale: session.implementation.proof.rationale,
  };
  const iterationId = authored.authoring?.iterations?.at(-1)?.id;
  authored = {
    ...authored,
    operations: authored.operations.map((operation) => ({ ...operation, implementations: operation.implementations.map((item) => item.id === implementation.id && item.authored ? { ...item, authored: { ...item.authored, proof: mergedProof } } : item) })),
    authoring: { ...authored.authoring!, stage: "authored", selectedImplementationId: implementation.id, iterations: (authored.authoring?.iterations || []).map((item) => item.id === iterationId ? { ...item, status: "passed", runId: run.id, endedAt: new Date().toISOString(), draft: { ...normalized.draft, implementation: { kind: "module", module: moduleRef, proof: mergedProof } } } : item) },
  };
  run.status = "passed";
  run.outcome = { status: "success", code: "authored_codex_success", summary: `Codex 已编写并真实试跑「${authored.capability.name}」（${(mergedProof.provingRuns || []).length} 次成功运行、${session.report?.total ?? 0} 条冒烟用例）。`, evaluatedAt: new Date().toISOString(), evidence: { source: "codex-authoring", confidence: 1, selectedImplementationId: implementation.id, workspaceHash: session.workspace.hash, producedFieldIds: Object.keys(finalRun.output), urlChanged: before.url !== after.url } };
  // Persist authoring-craft evidence (the VFS the coding agent wrote + how it
  // proved itself) and flush the author-run DOM replay. Both are best-effort and
  // must never fail a successfully authored capability.
  if (projectId) {
    const workspace: PersistedAuthoringWorkspace = {
      id: uid("workspace"), siteAgentId, projectId, learningJobId: lease.job.id, runId: run.id,
      hash: session.workspace.hash, files: session.workspace.files,
      report: session.report ? { total: session.report.total, passed: session.report.passed, failed: session.report.failed, coveredFieldIds: session.report.coveredFieldIds } : undefined,
      provingRuns: (mergedProof.provingRuns || []).length, codingAgent: "codex", moduleContentHash: moduleRef.contentHash, createdAt: new Date().toISOString(),
    };
    await api(`/api/site-agents/${encodeURIComponent(siteAgentId)}/authoring-workspaces`, { method: "POST", body: JSON.stringify({ workspace }), signal: leaseGuard.signal }).catch((error) => {
      leaseGuard.assertActive();
      console.warn(`authoring_workspace_save_failed:${error instanceof Error ? error.message : String(error)}`);
    });
  }
  leaseGuard.assertActive();
  await replay.flush();
  leaseGuard.assertActive();
  return authored;
}

async function runNavigationAIAuthoringSession(
  page: Page,
  lease: Extract<RunnerLease, { kind: "author" }>,
  run: BrowserRun,
  runnerId: string,
  token: string,
  input: Record<string, JsonValue>,
  goal: string,
  leaseGuard: LeaseRuntimeGuard,
  outputPlan: NavigationOutputPlan,
): Promise<KnowledgeCandidate> {
  leaseGuard.assertActive();
  const siteAgentId = lease.job.siteAgentId;
  await reportProgress(runnerId, token, run, "observing", "AI 正在独立浏览器中探索导航目标", undefined, undefined, leaseGuard);
  const exploration = await exploreNavigationWithAI(page, goal, run.startUrl);
  leaseGuard.assertActive();
  const targetScene = sceneFromSnapshot(exploration.after, exploration.after.heading || exploration.after.title || lease.candidate.capability.name);
  const source = navigationModuleSource(run.startUrl, exploration.targetUrl, outputPlan);
  const moduleRef = await persistModule(siteAgentId, source);
  const candidateWithTarget = {
    ...lease.candidate,
    scenes: [...lease.candidate.scenes.filter((scene) => scene.id !== targetScene.id), targetScene],
  };
  const normalized = normalizeDraft({
    rationale: `AI 自主探索后确认 ${exploration.targetUrl} 为“${goal}”的目标页面：${exploration.semanticEvidence}`,
    alternatives: [{ id: "ai-explored-direct-entry", kind: "module", label: "AI 探索后的直接入口", rationale: "使用 AI 在真实浏览器中确认的目标 URL。", selected: true }],
    implementation: { kind: "module" },
    verifier: { success: navigationTargetEvidence(goal, lease.episode.startSnapshot, exploration.after, { semanticJudged: true }) || [], noResult: [], businessRejection: [] },
  }, { ...lease, candidate: candidateWithTarget }, moduleRef);
  let authored = normalized.candidate;
  const implementation = authored.operations[0]?.implementations[0];
  if (!implementation?.authored) throw new Error("author_implementation_missing");

  await reportProgress(runnerId, token, run, "executing", "正在从干净起点独立重放 AI 生成的导航程序", undefined, undefined, leaseGuard);
  await page.goto(run.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const before = await snapshot(page);
  const finalRun = await runPlaywrightCapabilityStages({ page, moduleUrl: new URL(moduleRef.moduleUrl, browserPublicEndpoint).href, input, outputSchema: authored.capability.outputs });
  await finalRun.page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
  const after = await snapshot(finalRun.page);
  leaseGuard.assertActive();
  const provenNavigationRules = navigationTargetEvidence(goal, before, after, { semanticJudged: true });
  if (!provenNavigationRules || after.url.replace(/#.*$/, "") !== exploration.targetUrl.replace(/#.*$/, "")) throw new Error("scene_assertion_failed");

  run.steps.push(...finalRun.receipts.map((receipt) => ({
    stepId: receipt.stageId,
    op: "adaptive" as const,
    label: receipt.stageId,
    status: "passed" as const,
    startedAt: run.startedAt,
    endedAt: new Date().toISOString(),
    evidence: { moduleUrl: moduleRef.moduleUrl, contentHash: moduleRef.contentHash, transition: receipt.transition, url: receipt.urlAfter },
  })));
  const mergedProof: AuthoringProof = {
    ...implementation.authored.proof,
    verifier: { ...implementation.authored.proof.verifier, success: provenNavigationRules },
    provingRuns: [{
      runId: run.id,
      input,
      outcome: "success",
      producedFieldIds: Object.keys(finalRun.output),
      producedValues: finalRun.output,
      at: new Date().toISOString(),
    }],
    workspaceHash: moduleRef.contentHash,
    codingAgent: "navigation-ai",
    rationale: `AI 在真实浏览器中探索到 ${exploration.targetUrl}（${exploration.semanticEvidence}），随后由确定性生成器创建并独立重放导航程序。`,
  };
  const iterationId = authored.authoring?.iterations?.at(-1)?.id;
  authored = {
    ...authored,
    scenes: [...authored.scenes.filter((scene) => scene.id !== targetScene.id), targetScene],
    operations: authored.operations.map((operation) => ({
      ...operation,
      kind: "navigation",
      toSceneId: targetScene.id,
      effects: [`scene:${targetScene.id}`],
      verification: { ...operation.verification, sceneId: targetScene.id },
      implementations: operation.implementations.map((item) => item.id === implementation.id && item.authored
        ? { ...item, authored: { ...item.authored, proof: mergedProof } }
        : item),
    })),
    authoring: {
      ...authored.authoring!,
      stage: "authored",
      selectedImplementationId: implementation.id,
      iterations: (authored.authoring?.iterations || []).map((item) => item.id === iterationId
        ? { ...item, status: "passed", runId: run.id, endedAt: new Date().toISOString(), draft: { ...normalized.draft, implementation: { kind: "module", module: moduleRef, proof: mergedProof } } }
        : item),
    },
  };
  authoringReceipt(run, "AI 已自主探索目标并通过独立重放门禁", "passed", {
    phase: "navigation-ai",
    targetUrl: exploration.targetUrl,
    semanticEvidence: exploration.semanticEvidence,
    actions: exploration.actions,
    workspaceHash: moduleRef.contentHash,
  });
  run.status = "passed";
  run.outcome = {
    status: "success",
    code: "authored_navigation_ai_success",
    summary: `AI 已自主探索、生成并真实重放“${authored.capability.name}”。`,
    evaluatedAt: new Date().toISOString(),
    evidence: { source: "navigation-ai-authoring", confidence: 1, targetUrl: exploration.targetUrl, semanticEvidence: exploration.semanticEvidence, workspaceHash: moduleRef.contentHash },
  };
  const projectId = lease.specDoc?.projectId || (typeof lease.job.result?.projectId === "string" ? lease.job.result.projectId : undefined);
  if (projectId) {
    const now = new Date().toISOString();
    const workspace: PersistedAuthoringWorkspace = {
      id: uid("workspace"),
      siteAgentId,
      projectId,
      learningJobId: lease.job.id,
      runId: run.id,
      hash: moduleRef.contentHash,
      files: [{ path: "capability.ts", content: source, updatedAt: now }],
      report: { total: 1, passed: 1, failed: 0, coveredFieldIds: Object.keys(finalRun.output) },
      provingRuns: 1,
      codingAgent: "navigation-ai",
      moduleContentHash: moduleRef.contentHash,
      createdAt: now,
    };
    await api(`/api/site-agents/${encodeURIComponent(siteAgentId)}/authoring-workspaces`, { method: "POST", body: JSON.stringify({ workspace }) }).catch(() => undefined);
  }
  return authored;
}

async function runAuthoring(browser: Browser, runnerId: string, lease: Extract<RunnerLease, { kind: "author" }>, leaseGuard: LeaseRuntimeGuard) {
  leaseGuard.assertActive();
  const token = lease.job.lease!.token;
  const runId = uid("browser_run");
  const setup = await createRecordedContext(browser, runId, "debug");
  leaseGuard.bindContext(setup.context);
  const { page } = setup;
  let stopKeyframes: (() => Promise<void>) | undefined;
  try {
    const input = inputForCandidate(lease.candidate, lease.episode.input);
    const goal = goalForCandidate(lease.candidate, input);
    const requestedStartUrl = typeof lease.job.result?.authoringStartUrl === "string"
      ? lease.job.result.authoringStartUrl
      : undefined;
    const authoringStartUrl = requestedStartUrl
      ? trustedReleaseStartUrl(lease.release, requestedStartUrl, true)
      : lease.job.result?.source === "capability-control"
        && lease.candidate.capability.kind === "navigation"
        ? independentNavigationAuthoringStartUrl(
          lease.release,
          lease.candidate,
          lease.episode.startSnapshot.url,
        )
        : lease.episode.startSnapshot.url;
    const run: BrowserRun = { id: runId, learningJobId: lease.job.id, siteAgentId: lease.job.siteAgentId, candidateId: lease.candidate.id, runnerId, mode: "author", status: "running", browser: { name: "chromium", version: browser.version(), headless: true }, startedAt: new Date().toISOString(), startUrl: authoringStartUrl, steps: [] };
    await startRun(runnerId, token, run, leaseGuard);
    stopKeyframes = startAuthoringKeyframes(page, runnerId, run, leaseGuard);
    let authored = lease.candidate;
    const navigationRequest = lease.candidate.capability.kind === "navigation" && lease.episode.mode === "author-request";
    const navigationOutputPlan = navigationRequest
      ? deterministicNavigationOutputPlan(
          lease.candidate.capability.inputs,
          lease.candidate.capability.outputs,
          lease.candidate.authoring?.resultFields,
        )
      : undefined;
    const authoringPath = navigationRequest && navigationOutputPlan
      ? "navigation-ai" as const
      : "codex" as const;
    try {
      if (authoringPath === "navigation-ai") {
        authored = await runNavigationAIAuthoringSession(
          page,
          lease,
          run,
          runnerId,
          token,
          input,
          goal,
          leaseGuard,
          navigationOutputPlan!,
        );
      } else {
        if (navigationRequest) {
          authoringReceipt(
            run,
            "导航契约包含无法由确定性导航生成器证明的必填输出，改由 Codex 编写",
            "passed",
            {
              phase: "authoring-route",
              selectedPath: "codex",
              reason: "navigation_required_output_not_deterministic",
            },
          );
        }
        if (!codexAuthoringAvailable()) throw new Error("codex_authoring_not_configured");
        await reportProgress(runnerId, token, run, "observing", "正在打开独立浏览器并准备 Codex 编写环境", undefined, undefined, leaseGuard);
        authored = await runCodexAuthoringSession(page, lease, run, runnerId, token, input, goal, leaseGuard);
      }
    } catch (error) {
      leaseGuard.assertActive();
      run.status = "failed";
      run.outcome = { status: "execution-fault", code: errorCode(error), summary: error instanceof Error ? error.message : String(error), evaluatedAt: new Date().toISOString(), evidence: { source: authoringPath === "navigation-ai" ? "navigation-ai-authoring" : "codex-authoring" } };
      await reportRunnerFailure(runnerId, "authoring", error, run.learningJobId);
    }
    await reportProgress(runnerId, token, run, "recording", "正在保存 AI 编写与浏览器验证证据", undefined, undefined, leaseGuard);
    await stopKeyframes();
    stopKeyframes = undefined;
    run.endUrl = page.url();
    run.endedAt = new Date().toISOString();
    const artifacts = await finishArtifacts(setup.context, page, setup, run, undefined, leaseGuard.signal);
    run.artifactIds = artifacts.map((artifact) => artifact.id);
    leaseGuard.assertActive();
    await completeRun(runnerId, token, run, leaseGuard, authored);
  } finally {
    await stopKeyframes?.().catch(() => undefined);
    await cleanupRecordedContext(setup.context, [setup.screenshotPath, setup.tracePath]);
  }
}
async function runValidation(browser: Browser, runnerId: string, lease: Extract<RunnerLease, { kind: "validate" }>, leaseGuard: LeaseRuntimeGuard) {
  leaseGuard.assertActive();
  const token = lease.job.lease!.token; const runId = uid("browser_run"); const setup = await createRecordedContext(browser, runId); let { page } = setup;
  leaseGuard.bindContext(setup.context);
  try {
    const run: BrowserRun = { id: runId, learningJobId: lease.learningJob.id, validationJobId: lease.job.id, siteAgentId: lease.job.siteAgentId, candidateId: lease.candidate.id, runnerId, mode: "validate", status: "running", browser: { name: "chromium", version: browser.version(), headless: true }, startedAt: new Date().toISOString(), startUrl: lease.job.validationCase.startUrl, steps: [] };
    const presentation = await createValidationPresentation(setup.context, lease.candidate.capability, run.id);
    await startRun(runnerId, token, run, leaseGuard);
    let outcome: OutcomeReceipt;
    let beforeEvidence: Record<string, JsonValue> | undefined;
    let afterEvidence: Record<string, JsonValue> | undefined;
    let validationOutput: Record<string, JsonValue> = {};
    let assertions: Array<{ kind: string; expected: string; actual: string; passed: boolean }> = [];
    const captureKeyframe = async (currentPage: Page) => {
      if (setup.keyframePaths.length >= 6) return;
      const path = `${artifactDirectory}/${run.id}-keyframe-${setup.keyframePaths.length + 1}.jpg`;
      if (await captureValidationFrame(currentPage, path)) setup.keyframePaths.push(path);
    };
    try {
      await reportProgress(runnerId, token, run, "validating", "正在全新浏览器上下文中独立重放能力", 0, 1, leaseGuard);
      const validationOrigin = new URL(run.startUrl).origin;
      await installPinnedPageNavigationGuard(page, validationOrigin);
      await page.goto(run.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      assertReleasePageOrigin(page, validationOrigin);
      const before = await snapshot(page);
      beforeEvidence = { url: before.url, title: before.title, heading: before.heading };
      await presentation.setPhase("before", page);
      await page.waitForTimeout(1_000);
      await captureValidationFrame(page, setup.beforeScreenshotPath);
      await presentation.setPhase("running", page);
      const moduleRef = lease.candidate.capability.module;
      const executionSource = moduleRef ? "module" as const : "release-operation" as const;
      if (moduleRef) {
        const result = await runPlaywrightCapabilityStages({ page, moduleUrl: new URL(moduleRef.moduleUrl, browserPublicEndpoint).href, input: lease.job.validationCase.input, outputSchema: lease.candidate.capability.outputs, onStage: captureKeyframe });
        page = result.page;
        await presentation.setPhase("running", page);
        validationOutput = result.output;
        run.steps.push(...result.receipts.map((receipt) => ({ stepId: receipt.stageId, op: "adaptive" as const, label: receipt.stageId, status: "passed" as const, startedAt: run.startedAt, endedAt: new Date().toISOString(), evidence: { moduleUrl: moduleRef.moduleUrl, contentHash: moduleRef.contentHash, transition: receipt.transition, url: receipt.urlAfter } })));
      } else {
        const result = await runVerifiedReleaseOperationCapability({
          page,
          capability: lease.candidate.capability,
          release: lease.release,
          revision: lease.revision,
          requiredRevisionStatus: "building",
          input: lease.job.validationCase.input,
          signal: leaseGuard.signal,
          onReceipt: captureKeyframe,
        });
        page = result.page;
        await presentation.setPhase("running", page);
        validationOutput = result.output;
        run.steps.push(...result.receipts);
      }
      const after = await snapshot(page);
      afterEvidence = { url: after.url, title: after.title, heading: after.heading };
      if (executionSource === "module"
        && lease.candidate.capability.kind === "navigation"
        && !navigationCompletionVerified(lease.candidate, before, after)) {
        throw new Error("scene_assertion_failed");
      }
      const revisionImplementation = lease.revision.implementation;
      const implementationProof = revisionImplementation && "proof" in revisionImplementation
        ? revisionImplementation.proof
        : undefined;
      const successRules = lease.revision.verifier?.success?.length
        ? lease.revision.verifier.success
        : implementationProof?.verifier.success || [];
      const normalizedAfterText = `${after.title}\n${after.heading}\n${after.visibleText}`.normalize("NFKC").toLowerCase();
      assertions = successRules
        .filter((rule) => rule.kind === "url" || rule.kind === "text")
        .map((rule) => {
          if (rule.kind === "url") {
            let passed = false;
            try {
              const actual = new URL(after.url);
              const expected = new URL(rule.value, actual.origin);
              passed = actual.origin === expected.origin && actual.pathname === expected.pathname && actual.search === expected.search;
            } catch {}
            return { kind: rule.kind, expected: rule.value, actual: after.url, passed };
          }
          const expectedText = rule.value.normalize("NFKC").toLowerCase();
          const passed = normalizedAfterText.includes(expectedText);
          return { kind: rule.kind, expected: rule.value, actual: passed ? rule.value : "未命中", passed };
        });
      if (executionSource === "module") {
        outcome = { status: "success", code: "module_smoke_passed", summary: `Codex 模块已通过页面 SDK 完成一次真实试跑：${lease.candidate.capability.name}`, evaluatedAt: new Date().toISOString(), evidence: { source: "sdk-executor-smoke", urlChanged: before.url !== after.url } };
        run.status = "passed";
      } else {
        outcome = { status: "success", code: "release_operation_smoke_passed", summary: `已通过 Release Operation 独立试跑：${lease.candidate.capability.name}`, evaluatedAt: new Date().toISOString(), evidence: { source: "release-operation-smoke", urlChanged: before.url !== after.url } };
        run.status = "passed";
      }
    } catch (error) {
      leaseGuard.assertActive();
      if (error instanceof ReleaseOperationRunError) run.steps.push(...error.receipts);
      outcome = { status: "execution-fault", code: errorCode(error), summary: error instanceof Error ? error.message : String(error), evaluatedAt: new Date().toISOString(), evidence: { source: "independent-validation-browser" } }; run.status = "failed";
      await reportRunnerFailure(runnerId, "validating", error, run.learningJobId);
    }
    if (!afterEvidence) {
      const after = await snapshot(page).catch(() => undefined);
      if (after) afterEvidence = { url: after.url, title: after.title, heading: after.heading };
    }
    await presentation.setPhase(run.status === "passed" ? "completed" : "failed", page);
    await captureValidationFrame(page, setup.afterScreenshotPath);
    await page.waitForTimeout(2_000);
    outcome!.evidence = {
      ...outcome!.evidence,
      ...(beforeEvidence ? { before: beforeEvidence } : {}),
      ...(afterEvidence ? { after: afterEvidence } : {}),
      output: validationOutput,
      assertions,
    };
    await reportProgress(runnerId, token, run, "recording", "正在保存独立验证证据", undefined, undefined, leaseGuard);
    run.outcome = outcome!; run.endUrl = page.url(); run.endedAt = new Date().toISOString();
    const artifacts = await finishArtifacts(setup.context, page, setup, run, undefined, leaseGuard.signal); run.artifactIds = artifacts.map((artifact) => artifact.id);
    run.outcome.evidence.artifacts = validationArtifactEvidence(artifacts);
    leaseGuard.assertActive();
    await completeRun(runnerId, token, run, leaseGuard);
  } finally {
    await cleanupRecordedContext(setup.context, [setup.screenshotPath, setup.beforeScreenshotPath, setup.afterScreenshotPath, ...setup.keyframePaths, setup.tracePath]);
  }
}

async function updateExecution(runnerId: string, token: string, run: CapabilityRun, leaseGuard: LeaseRuntimeGuard, browserRun?: BrowserRun) {
  leaseGuard.assertActive();
  const terminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled";
  const shouldComplete = terminal && run.progress?.stage !== "recording";
  const payload = JSON.stringify({
    status: run.status,
    steps: run.steps,
    timings: run.timings,
    artifactIds: run.artifactIds,
    progress: run.progress,
    startedAt: run.startedAt,
    ...(terminal ? {
      output: run.output,
      outcome: run.outcome,
      resultUrl: run.resultUrl,
      error: run.error,
      completedAt: run.completedAt,
      ...(browserRun ? { browserRun } : {}),
    } : {}),
  });
  const submit = () => api(`/api/validation/runners/${encodeURIComponent(runnerId)}/capability-runs/${encodeURIComponent(run.id)}`, {
    method: "PATCH",
    headers: headers({ "x-sitewake-lease-token": token }),
    body: payload,
    signal: leaseGuard.signal,
  });
  if (shouldComplete) await leaseGuard.beginCompletion();
  const result = shouldComplete
    ? await retryRunnerCompletion(submit, {
      signal: leaseGuard.signal,
      shouldRetry: (error) => error instanceof RunnerApiError
        ? error.status === 408 || error.status === 429 || error.status >= 500
        : true,
    })
    : await submit();
  if (run.progress) {
    await heartbeat(runnerId, "busy", runnerActivity(run.progress.stage, run.progress.message, `capability_run:${run.id}`)).catch(() => undefined);
  }
  leaseGuard.assertActive();
  return result;
}

function trustedReleaseOrigins(release: SiteAgentReleaseV2) {
  const allowedOrigins = (release.profile.allowedOrigins || []).flatMap((value) => {
    try { return [new URL(value).origin]; } catch { return []; }
  });
  const entryOrigins = release.profile.entryUrl ? (() => {
    try { return [new URL(release.profile.entryUrl!).origin]; } catch { return []; }
  })() : [];
  const sceneOrigins = release.scenes.flatMap((scene) => scene.urlTemplates.flatMap((template) => {
    try { return template.originPattern === "*" ? [] : [new URL(template.originPattern).origin]; } catch { return []; }
  }));
  // Explicitly configured origins are authoritative. Legacy Releases without
  // that list are anchored to the semantic entry origin; only if neither is
  // available do we accept a single unambiguous Scene origin.
  return [...new Set(
    allowedOrigins.length
      ? allowedOrigins
      : entryOrigins.length
        ? entryOrigins
        : [...new Set(sceneOrigins)].length === 1
          ? sceneOrigins
          : [],
  )];
}

function trustedReleaseStartUrl(release: SiteAgentReleaseV2, preferredUrl?: string, requirePreferred = false) {
  const trustedOrigins = trustedReleaseOrigins(release);
  if (preferredUrl) {
    try {
      const parsed = new URL(preferredUrl);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:")
        && !parsed.username
        && !parsed.password
        && trustedOrigins.includes(parsed.origin)) {
        return parsed.toString();
      }
    } catch { /* Invalid Revision evidence must never steer a browser. */ }
    if (requirePreferred) throw new Error("capability_run_start_url_untrusted");
  }
  if (requirePreferred) throw new Error("capability_run_start_url_missing");
  const entryUrl = release.profile.entryUrl;
  if (entryUrl) {
    try {
      const parsed = new URL(entryUrl);
      if (trustedOrigins.includes(parsed.origin)) return parsed.toString();
    } catch { /* Invalid semantic profile data must never steer a browser. */ }
  }
  const observedUrl = release.scenes.flatMap((scene) => scene.evidence?.observedUrls || []).find((value) => {
    try { return trustedOrigins.includes(new URL(value).origin); } catch { return false; }
  });
  if (observedUrl) return observedUrl;
  if (trustedOrigins[0]) return `${trustedOrigins[0]}/`;
  throw new Error("trusted_execution_origin_missing");
}

function trustedReleasePageOrigin(release: SiteAgentReleaseV2, pageUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    throw new Error("capability_release_operation_live_origin_untrusted");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || !trustedReleaseOrigins(release).includes(parsed.origin)) {
    throw new Error("capability_release_operation_live_origin_untrusted");
  }
  return parsed.origin;
}

function assertReleasePageOrigin(page: Page, expectedOrigin: string) {
  let parsed: URL;
  try {
    parsed = new URL(page.url());
  } catch {
    throw new Error("capability_release_operation_cross_origin");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.origin !== expectedOrigin) {
    throw new Error("capability_release_operation_cross_origin");
  }
}

async function installPinnedPageNavigationGuard(page: Page, expectedOrigin: string) {
  // Playwright routing does not intercept the second request in an HTTP
  // redirect chain. Chromium Fetch interception does, so a trusted URL cannot
  // redirect the browser into contacting an attacker origin even once.
  const session = await page.context().newCDPSession(page);
  const frameTree = await session.send("Page.getFrameTree") as {
    frameTree: { frame: { id: string } };
  };
  const mainFrameId = frameTree.frameTree.frame.id;
  let disposed = false;
  const onPaused = (event: {
    requestId: string;
    request: { url: string };
    resourceType?: string;
    frameId?: string;
  }) => {
    void (async () => {
      if (disposed) return;
      const mainDocument = event.resourceType === "Document"
        && event.frameId === mainFrameId;
      if (!mainDocument) {
        await session.send("Fetch.continueRequest", {
          requestId: event.requestId,
        });
        return;
      }
      let allowed = false;
      try {
        allowed = new URL(event.request.url).origin === expectedOrigin;
      } catch {
        allowed = false;
      }
      await session.send(
        allowed ? "Fetch.continueRequest" : "Fetch.failRequest",
        allowed
          ? { requestId: event.requestId }
          : { requestId: event.requestId, errorReason: "BlockedByClient" },
      );
    })().catch(() => undefined);
  };
  session.on("Fetch.requestPaused", onPaused);
  try {
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
  } catch (error) {
    session.off("Fetch.requestPaused", onPaused);
    await session.detach().catch(() => undefined);
    throw error;
  }
  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      session.off("Fetch.requestPaused", onPaused);
      await session.send("Fetch.disable").catch(() => undefined);
      await session.detach().catch(() => undefined);
    },
  };
}

function independentNavigationAuthoringStartUrl(
  release: SiteAgentReleaseV2,
  candidate: KnowledgeCandidate,
  fallbackUrl: string,
) {
  const normalizedUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return undefined;
    }
  };
  const targetUrls = new Set(candidate.capability.outcomes
    .flatMap((outcome) => outcome.classifiers)
    .filter((classifier) => classifier.kind === "url")
    .map((classifier) => normalizedUrl(classifier.value))
    .filter((value): value is string => Boolean(value)));
  const configuredOrigins = (release.profile.allowedOrigins || []).flatMap((value) => {
    try { return [new URL(value).origin]; } catch { return []; }
  });
  const anchorOrigins = configuredOrigins.length
    ? configuredOrigins
    : [release.profile.entryUrl, fallbackUrl].flatMap((value) => {
      try { return value ? [new URL(value).origin] : []; } catch { return []; }
    });
  const trustedOrigins = new Set(anchorOrigins);
  const candidates = release.scenes
    .flatMap((scene) => (scene.evidence?.observedUrls || [])
      .map(normalizedUrl)
      .filter((value): value is string => Boolean(value))
      .map((url) => ({ scene, url })))
    .filter(({ url }) => trustedOrigins.has(new URL(url).origin))
    .filter(({ url }) => !targetUrls.has(url))
    .sort((left, right) =>
      Number(right.scene.directEntry === "verified") - Number(left.scene.directEntry === "verified")
      || Number(right.scene.evidenceStatus === "entry-verified") - Number(left.scene.evidenceStatus === "entry-verified"));
  return trustedReleaseStartUrl(release, candidates[0]?.url || fallbackUrl, true);
}

type ResolvedReleaseOperationStep = {
  planStep: CapabilityDefinition["plans"][number]["steps"][number];
  operation: OperationDefinition;
  implementation: OperationDefinition["implementations"][number];
};

type ResolvedReleaseOperationPlan = {
  plan: CapabilityDefinition["plans"][number];
  steps: ResolvedReleaseOperationStep[];
};

type SharedOperationSnapshot = {
  url: string;
  title: string;
  heading: string;
  visibleText: string;
};

type ReleaseOperationRunResult = {
  page: Page;
  output: Record<string, JsonValue>;
  receipts: BrowserStepReceipt[];
};

const supportedReleaseOperationSteps = new Set<PageProgramStep["op"]>([
  "navigate",
  "waitForScene",
  "waitForCondition",
  "assertScene",
]);

class ReleaseOperationRunError extends Error {
  constructor(message: string, readonly receipts: BrowserStepReceipt[]) {
    super(message);
    this.name = "ReleaseOperationRunError";
  }
}

function pinnedNavigationToolOperationIds(
  capability: CapabilityDefinition,
  release: SiteAgentReleaseV2,
  revision: CapabilityRevision | undefined,
  requiredStatus: "building" | "published" | undefined,
) {
  if (!revision) {
    if (requiredStatus) throw new Error("capability_release_operation_revision_pin_required");
    return undefined;
  }
  const implementation = revision.implementation;
  if ((requiredStatus && revision.status !== requiredStatus)
    || capability.kind !== "navigation"
    || capability.resultKind !== "page"
    || implementation?.kind !== "navigation-tool") {
    throw new Error("capability_release_operation_revision_pin_invalid");
  }
  const pin = implementation.toolRef;
  const tool = (release.navigationTools || []).find((candidate) =>
    candidate.id === pin.toolId);
  if (!tool
    || tool.status !== "verified"
    || tool.siteAgentId !== release.siteAgentId
    || tool.source.knowledgeRevision !== pin.knowledgeRevision
    || tool.source.dependencyHash !== pin.dependencyHash
    || !release.scenes.some((scene) => scene.id === tool.targetSceneId)
    || !release.scenes.some((scene) => scene.id === tool.verifier.sceneId)) {
    throw new Error("capability_release_operation_navigation_tool_pin_mismatch");
  }
  const operationIds = new Set(
    tool.strategies.map((strategy) => strategy.operationId),
  );
  if (!operationIds.size) {
    throw new Error("capability_release_operation_navigation_tool_empty");
  }
  return operationIds;
}

function releaseOperationPlan(
  capability: CapabilityDefinition,
  release: SiteAgentReleaseV2,
  currentSceneIds: ReadonlySet<string>,
  revision?: CapabilityRevision,
  requiredRevisionStatus?: "building" | "published",
): ResolvedReleaseOperationPlan {
  const operations = new Map(release.operations.map((operation) => [operation.id, operation]));
  const pinnedOperationIds = pinnedNavigationToolOperationIds(
    capability,
    release,
    revision,
    requiredRevisionStatus,
  );
  const failures: string[] = [];
  for (const plan of capability.plans) {
    if (!plan.entrySceneIds.length
      || (!plan.entrySceneIds.includes("*")
        && !plan.entrySceneIds.some((sceneId) => currentSceneIds.has(sceneId)))) {
      failures.push(`capability_release_operation_entry_scene_mismatch:${plan.id}`);
      continue;
    }
    if (!plan.steps.length) {
      failures.push(`capability_release_operation_plan_empty:${plan.id}`);
      continue;
    }
    const resolved: ResolvedReleaseOperationStep[] = [];
    let failure: string | undefined;
    for (const planStep of plan.steps) {
      if (pinnedOperationIds && !pinnedOperationIds.has(planStep.operationId)) {
        failure = `capability_release_operation_navigation_tool_plan_mismatch:${planStep.operationId}`;
        break;
      }
      const operation = operations.get(planStep.operationId);
      if (!operation || (operation.status !== "verified" && operation.status !== "published")) {
        failure = `capability_release_operation_unavailable:${planStep.operationId}`;
        break;
      }
      if (operation.verification.targetIds?.length || operation.verification.outcomeIds?.length) {
        failure = `capability_release_operation_verifier_unsupported:${operation.id}`;
        break;
      }
      const implementation = operation.implementations.find((candidate) =>
        candidate.program.version === 2
        && candidate.program.steps.length > 0
        && candidate.program.steps.every((step) => supportedReleaseOperationSteps.has(step.op))
        && candidate.program.steps.every((step) =>
          !("sceneId" in step) || release.scenes.some((scene) => scene.id === step.sceneId)));
      if (!implementation) {
        failure = `capability_release_operation_implementation_unavailable:${operation.id}`;
        break;
      }
      resolved.push({ planStep, operation, implementation });
    }
    if (!failure && resolved.length === plan.steps.length) return { plan, steps: resolved };
    if (failure) failures.push(failure);
  }
  throw new Error(failures[0] || "capability_release_operation_plan_required");
}

function releaseValueAt(record: Record<string, JsonValue>, path: string): JsonValue | undefined {
  if (!path) return undefined;
  let current: JsonValue | undefined = record;
  for (const segment of path.split(".").filter(Boolean)) {
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") return undefined;
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function resolveReleaseValue(
  expression: ValueExpression,
  input: Record<string, JsonValue>,
  state: Record<string, JsonValue>,
  stepState: Record<string, JsonValue>,
): JsonValue | undefined {
  if (expression.source === "literal") return expression.value;
  if (expression.source === "input") return releaseValueAt(input, expression.path);
  if (expression.source === "state") return releaseValueAt(state, expression.path);
  return releaseValueAt(stepState, expression.path);
}

function releaseOperationInput(
  resolved: ResolvedReleaseOperationStep,
  capabilityInput: Record<string, JsonValue>,
  state: Record<string, JsonValue>,
  stepState: Record<string, JsonValue>,
) {
  if (resolved.operation.inputs.type !== "object") {
    throw new Error(`capability_release_operation_input_schema_unsupported:${resolved.operation.id}`);
  }
  const operationInput: Record<string, JsonValue> = {};
  for (const key of Object.keys(resolved.operation.inputs.properties || {})) {
    const binding = resolved.planStep.bindings[key];
    const value = binding
      ? resolveReleaseValue(binding, capabilityInput, state, stepState)
      : capabilityInput[key];
    if (value !== undefined) operationInput[key] = value;
  }
  const missing = (resolved.operation.inputs.required || []).filter((key) =>
    !Object.prototype.hasOwnProperty.call(operationInput, key));
  if (missing.length) {
    throw new Error(`capability_release_operation_input_required:${resolved.operation.id}:${missing.join(",")}`);
  }
  return operationInput;
}

async function releaseOperationSnapshot(page: Page): Promise<SharedOperationSnapshot> {
  return {
    url: page.url(),
    title: await page.title(),
    heading: await page.locator("h1").first().textContent().catch(() => "") || "",
    visibleText: (await page.locator("body").innerText().catch(() => "")).slice(0, 12_000),
  };
}

function releaseSceneMatches(
  release: SiteAgentReleaseV2,
  sceneId: string,
  current: SharedOperationSnapshot,
  expectedOrigin: string,
) {
  const scene = release.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) return false;
  try {
    const parsed = new URL(current.url);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username
      || parsed.password
      || parsed.origin !== expectedOrigin) return false;
  } catch {
    return false;
  }
  // Scene routes are portable across an explicitly trusted live Site origin.
  // Verification therefore uses the same live-origin projection as navigation,
  // rather than rejecting a localhost/LAN alias learned under another host.
  const liveScene = {
    ...scene,
    urlTemplates: scene.urlTemplates.map((template) => ({
      ...template,
      originPattern: expectedOrigin,
    })),
  };
  return recognizeScene([liveScene], current)?.sceneId === sceneId;
}

async function waitForReleaseScene(
  page: Page,
  release: SiteAgentReleaseV2,
  sceneId: string,
  timeoutMs: number,
  expectedOrigin: string,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    const current = await releaseOperationSnapshot(page);
    if (releaseSceneMatches(release, sceneId, current, expectedOrigin)) return current;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw new Error(`scene_assertion_failed:${sceneId}`);
}

function releaseStepTimeout(timeoutMs: number) {
  return Math.max(250, Math.min(30_000, Number(timeoutMs) || 8_000));
}

function primitiveSceneBindings(
  step: Extract<PageProgramStep, { op: "navigate" }>,
  operationInput: Record<string, JsonValue>,
  state: Record<string, JsonValue>,
  stepState: Record<string, JsonValue>,
) {
  const bindings: Record<string, JsonPrimitive> = {};
  for (const [key, expression] of Object.entries(step.bindings)) {
    const value = resolveReleaseValue(expression, operationInput, state, stepState);
    if (value === undefined) continue;
    if (typeof value === "object" && value !== null) {
      throw new Error(`capability_release_operation_scene_binding_invalid:${step.sceneId}:${key}`);
    }
    bindings[key] = value;
  }
  return bindings;
}

async function executeReleaseOperationStep(
  page: Page,
  release: SiteAgentReleaseV2,
  step: PageProgramStep,
  operationInput: Record<string, JsonValue>,
  state: Record<string, JsonValue>,
  stepState: Record<string, JsonValue>,
  expectedOrigin: string,
) {
  assertReleasePageOrigin(page, expectedOrigin);
  const timeout = releaseStepTimeout("timeoutMs" in step ? step.timeoutMs : 8_000);
  if (step.op === "navigate") {
    const scene = release.scenes.find((candidate) => candidate.id === step.sceneId);
    if (!scene) throw new Error(`capability_release_operation_scene_missing:${step.sceneId}`);
    const targetUrl = buildSceneUrl(
      scene,
      primitiveSceneBindings(step, operationInput, state, stepState),
      expectedOrigin,
    );
    const target = new URL(targetUrl);
    if (target.origin !== expectedOrigin || (target.protocol !== "http:" && target.protocol !== "https:")) {
      throw new Error("capability_release_operation_cross_origin");
    }
    await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout });
    assertReleasePageOrigin(page, expectedOrigin);
    return;
  }
  if (step.op === "waitForScene") {
    await waitForReleaseScene(page, release, step.sceneId, timeout, expectedOrigin);
    return;
  }
  if (step.op === "assertScene") {
    const current = await releaseOperationSnapshot(page);
    if (!releaseSceneMatches(release, step.sceneId, current, expectedOrigin)) {
      throw new Error(`scene_assertion_failed:${step.sceneId}`);
    }
    return;
  }
  if (step.op === "waitForCondition") {
    if (!step.text && !step.urlPattern) {
      throw new Error(`capability_release_operation_wait_condition_empty:${step.id}`);
    }
    if (step.urlPattern) {
      await page.waitForURL((url) => url.href.includes(step.urlPattern!), { timeout });
    }
    if (step.text) {
      await page.getByText(step.text, { exact: false }).first().waitFor({ state: "visible", timeout });
    }
    return;
  }
  throw new Error(`capability_release_operation_step_unsupported:${step.op}`);
}

function updateReleaseOperationPageState(
  state: Record<string, JsonValue>,
  current: SharedOperationSnapshot,
  sceneId?: string,
) {
  state.__pageUrl = current.url;
  state.__pageTitle = current.title;
  state.__pageHeading = current.heading;
  state.pageUrl = current.url;
  state.pageTitle = current.title;
  state.pageHeading = current.heading;
  if (sceneId) {
    state.__sceneId = sceneId;
    state.sceneId = sceneId;
  }
}

async function verifyReleaseOperation(
  page: Page,
  release: SiteAgentReleaseV2,
  operation: OperationDefinition,
  expectedOrigin: string,
) {
  assertReleasePageOrigin(page, expectedOrigin);
  const current = await releaseOperationSnapshot(page);
  const expectedSceneId = operation.verification.sceneId || operation.toSceneId;
  if (expectedSceneId && !releaseSceneMatches(release, expectedSceneId, current, expectedOrigin)) {
    throw new Error(`scene_assertion_failed:${expectedSceneId}`);
  }
  if (operation.verification.textIncludes?.some((text) => !current.visibleText.includes(text))) {
    throw new Error(`capability_release_operation_text_assertion_failed:${operation.id}`);
  }
  return { current, expectedSceneId };
}

function releaseOperationOutput(
  capability: CapabilityDefinition,
  plan: CapabilityDefinition["plans"][number],
  input: Record<string, JsonValue>,
  state: Record<string, JsonValue>,
  stepState: Record<string, JsonValue>,
) {
  if (capability.outputs.type !== "object") {
    throw new Error("capability_release_operation_output_schema_unsupported");
  }
  const output: Record<string, JsonValue> = {};
  for (const key of Object.keys(capability.outputs.properties || {})) {
    const binding = plan.outputBindings[key];
    const value = binding
      ? resolveReleaseValue(binding, input, state, stepState)
      : state[key] ?? state[`__${key}`];
    if (value !== undefined) output[key] = value;
  }
  assertCapabilityOutput(capability.outputs, output);
  return output;
}

/**
 * Executes a module-less Capability exclusively through immutable Release
 * Operations. The complete plan is resolved before the first browser side
 * effect, so an unverified/missing/unsupported later step cannot produce a
 * partial run.
 */
async function runVerifiedReleaseOperationCapability(options: {
  page: Page;
  capability: CapabilityDefinition;
  release: SiteAgentReleaseV2;
  revision?: CapabilityRevision;
  requiredRevisionStatus?: "building" | "published";
  input: Record<string, JsonValue>;
  signal?: AbortSignal;
  onReceipt?: (page: Page, receipt: BrowserStepReceipt) => void | Promise<void>;
}): Promise<ReleaseOperationRunResult> {
  const executionOrigin = trustedReleasePageOrigin(
    options.release,
    options.page.url(),
  );
  const entrySnapshot = await releaseOperationSnapshot(options.page);
  const currentSceneIds = new Set(
    options.release.scenes
      .filter((scene) => releaseSceneMatches(
        options.release,
        scene.id,
        entrySnapshot,
        executionOrigin,
      ))
      .map((scene) => scene.id),
  );
  const resolved = releaseOperationPlan(
    options.capability,
    options.release,
    currentSceneIds,
    options.revision,
    options.requiredRevisionStatus,
  );
  const receipts: BrowserStepReceipt[] = [];
  const state: Record<string, JsonValue> = {};
  const stepState: Record<string, JsonValue> = {};
  const navigationGuard = await installPinnedPageNavigationGuard(
    options.page,
    executionOrigin,
  );
  try {
    for (const resolvedStep of resolved.steps) {
      options.signal?.throwIfAborted();
      const operationInput = releaseOperationInput(resolvedStep, options.input, state, stepState);
      for (const programStep of resolvedStep.implementation.program.steps) {
        options.signal?.throwIfAborted();
        const startedAt = new Date().toISOString();
        try {
          await executeReleaseOperationStep(
            options.page,
            options.release,
            programStep,
            operationInput,
            state,
            stepState,
            executionOrigin,
          );
          assertReleasePageOrigin(options.page, executionOrigin);
          const current = await releaseOperationSnapshot(options.page);
          updateReleaseOperationPageState(state, current);
          stepState[programStep.id] = {
            pageUrl: current.url,
            pageTitle: current.title,
            pageHeading: current.heading,
          };
          receipts.push({
            stepId: programStep.id,
            op: programStep.op,
            label: `${resolvedStep.operation.name} · ${programStep.op}`,
            status: "passed",
            startedAt,
            endedAt: new Date().toISOString(),
            evidence: {
              operationId: resolvedStep.operation.id,
              implementationId: resolvedStep.implementation.id,
              url: current.url,
            },
          });
          await options.onReceipt?.(options.page, receipts.at(-1)!);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          receipts.push({
            stepId: programStep.id,
            op: programStep.op,
            label: `${resolvedStep.operation.name} · ${programStep.op}`,
            status: "failed",
            startedAt,
            endedAt: new Date().toISOString(),
            evidence: {
              operationId: resolvedStep.operation.id,
              implementationId: resolvedStep.implementation.id,
              url: options.page.url(),
            },
            error: { code: message.split(":")[0] || "capability_release_operation_failed", message },
          });
          throw error;
        }
      }
      const verifyStartedAt = new Date().toISOString();
      try {
        const verified = await verifyReleaseOperation(
          options.page,
          options.release,
          resolvedStep.operation,
          executionOrigin,
        );
        updateReleaseOperationPageState(state, verified.current, verified.expectedSceneId);
        stepState[resolvedStep.operation.id] = {
          pageUrl: verified.current.url,
          pageTitle: verified.current.title,
          pageHeading: verified.current.heading,
          ...(verified.expectedSceneId ? { sceneId: verified.expectedSceneId } : {}),
        };
        receipts.push({
          stepId: `${resolvedStep.operation.id}:verify`,
          op: verified.expectedSceneId ? "assertScene" : "adaptive",
          label: `验证 ${resolvedStep.operation.name}`,
          status: "passed",
          startedAt: verifyStartedAt,
          endedAt: new Date().toISOString(),
          evidence: {
            operationId: resolvedStep.operation.id,
            implementationId: resolvedStep.implementation.id,
            url: verified.current.url,
            ...(verified.expectedSceneId ? { sceneId: verified.expectedSceneId } : {}),
          },
        });
        await options.onReceipt?.(options.page, receipts.at(-1)!);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        receipts.push({
          stepId: `${resolvedStep.operation.id}:verify`,
          op: resolvedStep.operation.verification.sceneId || resolvedStep.operation.toSceneId ? "assertScene" : "adaptive",
          label: `验证 ${resolvedStep.operation.name}`,
          status: "failed",
          startedAt: verifyStartedAt,
          endedAt: new Date().toISOString(),
          evidence: {
            operationId: resolvedStep.operation.id,
            implementationId: resolvedStep.implementation.id,
            url: options.page.url(),
          },
          error: { code: message.split(":")[0] || "capability_release_operation_verification_failed", message },
        });
        throw error;
      }
    }
    options.signal?.throwIfAborted();
    return {
      page: options.page,
      output: releaseOperationOutput(options.capability, resolved.plan, options.input, state, stepState),
      receipts,
    };
  } catch (error) {
    if (error instanceof ReleaseOperationRunError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ReleaseOperationRunError(
      message.includes("ERR_BLOCKED_BY_CLIENT")
        ? "capability_release_operation_cross_origin"
        : message,
      receipts,
    );
  } finally {
    await navigationGuard.dispose();
  }
}

async function runSitePreview(
  _browser: Browser,
  runnerId: string,
  lease: Extract<RunnerLease, { kind: "site-preview" }>,
  leaseGuard: LeaseRuntimeGuard,
) {
  leaseGuard.assertActive();
  const { job } = lease;
  const token = job.lease?.token || "";
  const screenshotPath = `${artifactDirectory}/${job.id}.jpg`;
  let previewBrowser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    const pin = await resolvePinnedCrawlOrigin(job.origin, { allowPrivateNetwork: allowPrivateCrawlNetwork, signal: leaseGuard.signal });
    const authHeaders = crawlAuthorizationHeaders(job.origin);
    previewBrowser = await chromium.launch({ headless: true, ...(browserChannel ? { channel: browserChannel } : {}), args: chromiumPinnedOriginArgs(pin, { allowPrivateNetwork: allowPrivateCrawlNetwork }) });
    context = await previewBrowser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: DEFAULT_UA, serviceWorkers: "block", ...(Object.keys(authHeaders).length ? { extraHTTPHeaders: authHeaders } : {}) });
    leaseGuard.bindContext(context);
    await installCrawlBrowserNetworkGuards(context);
    const page = await context.newPage();
    // What the browser itself refused. Registered before anything is fetched,
    // because a violation is reported as the resource is requested — a listener
    // added later misses the install tag entirely (measured).
    const violations = await collectPolicyViolations(page);
    // A rehearsal: the page is served with the exact markup the reader would
    // paste, so the browser — not an analysis of the policy text — decides
    // whether it would have worked. Only the main document is touched, and
    // only in this browser.
    const rehearsal = job.mode === "try-install" && job.installSnippet ? job.installSnippet : "";
    const injection = rehearsal ? await serveWithInstallSnippet(page, rehearsal) : undefined;
    // The preview must answer "is the agent on this page", and the SDK loads from the
    // control plane and handshakes back to it. Pinning only the site's own origin would
    // make the guard block the SDK script and `agentDetected` would always be false.
    // Only our own origin is allowed, and only for sub-resources: navigation stays
    // pinned to the site.
    const render = playwrightRenderPage(page, {
      timeoutMs: 15_000,
      allowedOrigin: pin.origin,
      additionalRequestOrigins: [browserPublicEndpoint],
    });
    const snapshot = await render(job.url);
    if (!snapshot) throw new Error("site_preview_navigation_failed");
    leaseGuard.assertActive();
    await Promise.race([
      page.evaluate(() => document.fonts?.ready).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    const selector = "[data-sitewake-agent], sitewake-agent";
    await page.locator(selector).first().waitFor({ state: "attached", timeout: 5_000 }).catch(() => undefined);
    const runtimeMounted = await page.locator(selector).count().then((count) => count > 0).catch(() => false);
    // Site ids are read from the script tags in the HTML, not from SDK runtime traces:
    // when the script does not run (CSP, wrong endpoint) the tag is still there, which
    // is exactly what separates "not installed" from "installed but not connecting".
    // Values come from a third-party page; clamp before sending.
    const detectedSiteAgentIds = await page.evaluate(() =>
      Array.from(document.querySelectorAll("script[data-site-agent]"))
        .map((element) => (element.getAttribute("data-site-agent") || "").trim())
    ).catch(() => [] as string[]);
    const observedSiteAgentIds = normalizeDetectedSiteAgentIds(detectedSiteAgentIds);
    const agentDetected = runtimeMounted || observedSiteAgentIds.length > 0;
    await mkdir(artifactDirectory, { recursive: true });
    await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 78, fullPage: false });
    leaseGuard.assertActive();
    const artifact = await uploadArtifact(screenshotPath, {
      siteAgentId: job.siteAgentId,
      learningJobId: job.id,
      runId: job.id,
      ownerKind: "preview-job",
      kind: "screenshot",
      role: "site-preview",
      label: "网站首屏预览",
      contentType: "image/jpeg",
      signal: leaseGuard.signal,
    });
    if (!artifact) throw new Error("site_preview_upload_failed");
    await leaseGuard.beginCompletion();
    await retryRunnerCompletion(() => api(`/api/validation/runners/${encodeURIComponent(runnerId)}/site-preview/complete`, {
      method: "POST",
      headers: headers({ "x-sitewake-lease-token": token }),
      body: JSON.stringify({
        jobId: job.id,
        preview: {
          artifactId: artifact.id, url: artifact.url, pageUrl: page.url(), capturedAt: new Date().toISOString(),
          width: 1440, height: 900, agentDetected, detectedSiteAgentIds: observedSiteAgentIds,
          mode: job.mode === "try-install" ? "try-install" : "live",
          violations,
          installConnected: runtimeMounted,
          // A rehearsal that could not place the snippet proves nothing about
          // the policy, and must not be read as if it had.
          ...(injection && !injection.injected ? { rehearsalUnavailable: "not-injectable" as const } : {}),
        },
      }),
    }), { signal: leaseGuard.signal });
  } catch (error) {
    if (isRunnerLeaseLostError(error)) throw error;
    await leaseGuard.beginCompletion().catch(() => undefined);
    await api(`/api/validation/runners/${encodeURIComponent(runnerId)}/site-preview/complete`, {
      method: "POST",
      headers: headers({ "x-sitewake-lease-token": token }),
      body: JSON.stringify({ jobId: job.id, error: safeRunnerMessage(error instanceof Error ? error.message : String(error)) }),
    }).catch(() => undefined);
  } finally {
    await context?.close().catch(() => undefined);
    await previewBrowser?.close().catch(() => undefined);
    await removeLocalMedia([screenshotPath]);
  }
}

async function runCrawl(
  _browser: Browser,
  runnerId: string,
  lease: Extract<RunnerLease, { kind: "crawl" }>,
  leaseGuard: LeaseRuntimeGuard,
) {
  leaseGuard.assertActive();
  const { job } = lease;
  const token = job.lease?.token || "";
  let crawlBrowser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let document: Awaited<ReturnType<typeof crawlSiteKnowledge>> | undefined;
  // The site-wide index-filter conclusion is recorded with job completion — the console only sees the job result.
  let contentFilterSummary: NonNullable<CrawlJob["result"]>["contentFilter"];
  let failed = false;
  let failure: unknown;
  try {
    const pin = await resolvePinnedCrawlOrigin(job.origin, {
      allowPrivateNetwork: allowPrivateCrawlNetwork,
      signal: leaseGuard.signal,
    });
    leaseGuard.assertActive();
    const crawlAuthHeaders = crawlAuthorizationHeaders(job.origin);
    const basePinnedFetch = pinnedOriginFetch(pin);
    const pinnedFetch: typeof fetch = (input, init = {}) => basePinnedFetch(input, {
      ...init,
      headers: { ...Object.fromEntries(new Headers(init.headers).entries()), ...crawlAuthHeaders },
    });
    crawlBrowser = await chromium.launch({
      headless: true,
      ...(browserChannel ? { channel: browserChannel } : {}),
      args: chromiumPinnedOriginArgs(pin, { allowPrivateNetwork: allowPrivateCrawlNetwork }),
    });
    context = await crawlBrowser.newContext({
      userAgent: DEFAULT_UA,
      serviceWorkers: "block",
      ...(Object.keys(crawlAuthHeaders).length ? { extraHTTPHeaders: crawlAuthHeaders } : {}),
    });
    leaseGuard.bindContext(context);
    await installCrawlBrowserNetworkGuards(context);
    page = await context.newPage();
    // Politeness: fetch robots.txt, obey it, seed sitemaps it advertises.
    const robotsResult = await fetchSameOriginText(
      new URL("/robots.txt", job.origin).toString(),
      pin.origin,
      { fetchImpl: pinnedFetch, signal: leaseGuard.signal },
    );
    const robotsTxt = robotsResult?.ok ? robotsResult.text : "";
    const rules = parseRobots(robotsTxt);
    leaseGuard.assertActive();
    const seeded = await seedFromSitemap(pin.origin, {
      robotsSitemaps: rules.sitemaps,
      signal: leaseGuard.signal,
      fetchText: (url) => fetchSameOriginText(
        url,
        pin.origin,
        { fetchImpl: pinnedFetch, signal: leaseGuard.signal },
      ),
    });
    leaseGuard.assertActive();
    const crawlLimits = validateCrawlJobLimits(job.limits) || {};
    const frontier = new CrawlFrontier({
      origin: job.origin,
      ...crawlLimits,
      maxRenders: crawlLimits.maxRenders ?? 120,
      isAllowed: (url) => robotsAllows(rules, url),
    });
    const crawlOrigin = new URL(job.origin).origin;
    const explicitSeeds = job.seeds.filter((value) => {
      try { return new URL(value).origin === crawlOrigin; } catch { return false; }
    });
    const render = playwrightRenderPage(page, { timeoutMs: 15_000, allowedOrigin: crawlOrigin });
    // Cache every page the content crawl renders (by requested + final URL). Phase-1 entry
    // verification reuses these instead of cold-opening a fresh probe — the proof it needs is
    // usually already in hand, so it neither wastes a render nor risks a transient miss.
    const renderCache = new Map<string, NonNullable<Awaited<ReturnType<typeof render>>>>();
    const cachingRender: typeof render = async (url) => {
      const snapshot = await render(url);
      if (snapshot) for (const candidate of [url, snapshot.url]) {
        try { renderCache.set(new URL(candidate).toString(), snapshot); } catch { /* non-absolute URL */ }
      }
      return snapshot;
    };
    // Cross-time baseline: observation records from the previous (and the one before)
    // crawl, shipped with the lease. Absent means first crawl; the layer is inactive.
    const priorObservations = lease.priorObservations;
    document = await crawlSiteKnowledge({
      siteAgentId: job.siteAgentId,
      origin: job.origin,
      crawledAt: new Date().toISOString(),
      priorObservations,
      seeds: [...(explicitSeeds.length ? explicitSeeds : [job.origin]), ...seeded.urls],
      frontier,
      renderPage: cachingRender,
      generateProfile: crawlProfileGenerator(),
      signal: leaseGuard.signal,
      // Onboarding crawl auto-populates the content index (build-knowledge-center-v1);
      // manual re-crawl refreshes it. Additive and non-fatal to the crawl.
      onContent: async (pages) => {
        // The indexing conclusion must be recorded: the console only sees the job result,
        // and the hint "one more crawl removes more dynamic content" is as good as
        // unwritten unless it lands there.
        contentFilterSummary = await api<{
          indexed?: number; skipped?: number;
          contentFilter?: { purgedPages?: number; writtenChars?: number; health?: { recrawlHint?: string; recrawlStage?: "first-crawl" | "needs-one-more" | "ready"; recrawlPagesNeedingMore?: number; recrawlShortestIntervalMinutes?: number; baselineIntervalMs?: number | null; warnings?: string[]; removed?: { shapeChars: number; dataPages: number; changingLines: number; keptChars: number } } };
        }>(`/api/site-agents/${encodeURIComponent(job.siteAgentId)}/content`, {
          method: "POST",
          headers: headers({ "x-sitewake-lease-token": token }),
          body: JSON.stringify({ pages }),
        }).then((payload) => payload && {
          indexed: payload.indexed ?? 0,
          skipped: payload.skipped ?? 0,
          purgedPages: payload.contentFilter?.purgedPages ?? 0,
          writtenChars: payload.contentFilter?.writtenChars ?? 0,
          recrawlHint: payload.contentFilter?.health?.recrawlHint,
          // Bring the structured form too: the console renders the hint in the current locale instead of the Chinese baked in at generation.
          recrawlStage: payload.contentFilter?.health?.recrawlStage,
          recrawlPagesNeedingMore: payload.contentFilter?.health?.recrawlPagesNeedingMore,
          recrawlShortestIntervalMinutes: payload.contentFilter?.health?.recrawlShortestIntervalMinutes,
          baselineIntervalMs: payload.contentFilter?.health?.baselineIntervalMs ?? null,
          warnings: payload.contentFilter?.health?.warnings,
          removed: payload.contentFilter?.health?.removed,
        }).catch(() => undefined);
      },
    });
    leaseGuard.assertActive();
    // Phase 1 (build-knowledge-center-v1): verify direct entries so navigate_scene can route
    // to a scene — what lifts verifiedScenes off 0. PREFER a page the content crawl already
    // rendered (renderCache): that page loaded and was NOT an error page (crawlSiteKnowledge
    // drops those), so a template match IS the direct-entry proof — no re-render to flake on
    // and no slug assertion needed. Only when nothing is cached do we cold-open a probe, and
    // then we retry across the parameter's examples so one transient render miss can't leave a
    // scene permanently unverified (the /guides/{path1} bug). A no-param scene is probed only
    // if the crawl actually rendered it. Sequential (one shared page), capped for the small host.
    const verifiedAt = new Date().toISOString();
    const PROBE_CAP = 80;
    const verifiedScenes: SceneDefinition[] = [];
    let probes = 0;
    // Borrow the sample value as a content assertion ONLY for a cold probe — it rejects a
    // soft-404 / login redirect that merely kept the URL. A cached hit is already error-filtered
    // by the content crawl, so asserting the (possibly English) slug appears in the (Chinese)
    // page text would falsely fail it — verify a cached hit against the scene's own verifier.
    const verifyWith = (scene: SceneDefinition, snapshot: Parameters<typeof verifyEntry>[1], values: Record<string, unknown>, borrow: boolean) => {
      let probeScene = scene;
      const verifier = scene.verifier || {};
      if (borrow && !verifier.titleIncludes?.length && !verifier.headingIncludes?.length && !verifier.textIncludes?.length) {
        const borrowed = Object.values(values).map(String).filter((value) => value.length >= 2 && value.length <= 40);
        if (borrowed.length) probeScene = { ...scene, verifier: { ...verifier, textIncludes: borrowed } };
      }
      return applyEntryFeedback(scene, verifyEntry(probeScene, snapshot, verifiedAt));
    };
    for (const scene of document.scenes) {
      leaseGuard.assertActive();
      const template = scene.urlTemplates[0];
      if (!template || scene.directEntry === "verified") { verifiedScenes.push(scene); continue; }
      // (a) Reuse an already-rendered page whose URL matches this scene's template — no render.
      let reused: { snapshot: NonNullable<Awaited<ReturnType<typeof render>>>; values: Record<string, unknown> } | undefined;
      for (const [cachedUrl, snapshot] of renderCache) {
        const values = matchUrlTemplate(template, cachedUrl);
        if (values) { reused = { snapshot, values }; break; }
      }
      if (reused) { verifiedScenes.push(verifyWith(scene, reused.snapshot, reused.values, false)); continue; }
      if (probes >= PROBE_CAP) { verifiedScenes.push(scene); continue; }
      // (b) No cached proof — cold-open a probe, retrying across the parameter's examples.
      const parameterized = template.pathnamePattern.includes("{") || scene.parameters.length > 0;
      const attempts: Array<{ url: string; values: Record<string, unknown> }> = [];
      if (parameterized) {
        const primary = sampleEntryBindings(scene);
        if (!primary) { verifiedScenes.push(scene); continue; }
        const varied = scene.parameters.find((parameter) => parameter.required && (parameter.examples?.length || 0) > 1);
        const bindingSets = varied
          ? [primary, ...(varied.examples || []).slice(1, 3).map((example) => ({ ...primary, [varied.id]: example }))]
          : [primary];
        for (const bindings of bindingSets) {
          try { attempts.push({ url: buildSceneUrl(scene, bindings, job.origin), values: bindings }); } catch { /* unbuildable */ }
        }
      } else {
        if (scene.evidenceStatus !== "crawled") { verifiedScenes.push(scene); continue; }
        attempts.push({ url: new URL(template.pathnamePattern, job.origin).toString(), values: {} });
      }
      let settled: SceneDefinition | undefined;
      for (const attempt of attempts.slice(0, 3)) {
        if (probes >= PROBE_CAP) break;
        probes += 1;
        const snapshot = await cachingRender(attempt.url).catch(() => null);
        if (!snapshot) continue; // transient render miss → try the next example
        settled = verifyWith(scene, snapshot, attempt.values, true);
        break;
      }
      verifiedScenes.push(settled ?? scene);
    }
    document = { ...document, scenes: verifiedScenes };
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    await page?.close().catch(() => undefined);
    await context?.close().catch(() => undefined);
    await crawlBrowser?.close().catch(() => undefined);
  }
  leaseGuard.assertActive();
  await leaseGuard.beginCompletion();
  if (failed) {
    // Setup/render failures are fatal. Clean up the browser first, then durably
    // resolve the leased job as failed so it cannot become a zero-page success.
    await retryRunnerCompletion(
      () => api(`/api/validation/runners/${encodeURIComponent(runnerId)}/crawl/complete`, {
        method: "POST",
        headers: headers({ "x-sitewake-lease-token": token }),
        body: JSON.stringify({
          siteAgentId: job.siteAgentId,
          jobId: job.id,
          error: sanitizeRunnerMessage(failure instanceof Error ? failure.message : String(failure)) || "crawl_failed",
        }),
        signal: leaseGuard.signal,
      }),
      {
        signal: leaseGuard.signal,
        shouldRetry: (completionError) => !(completionError instanceof RunnerApiError)
          || completionError.status === 408
          || completionError.status === 429
          || completionError.status >= 500,
      },
    );
    return;
  }
  // Report success outside the failure path so a transient error on THIS POST
  // never misreports a genuinely successful crawl as failed (it just propagates
  // to the loop, exactly as before).
  if (document) {
    await retryRunnerCompletion(
      () => api(`/api/validation/runners/${encodeURIComponent(runnerId)}/crawl/complete`, {
        method: "POST",
        headers: headers({ "x-sitewake-lease-token": token }),
        body: JSON.stringify({ siteAgentId: job.siteAgentId, jobId: job.id, document, contentFilter: contentFilterSummary }),
        signal: leaseGuard.signal,
      }),
      {
        signal: leaseGuard.signal,
        shouldRetry: (completionError) => !(completionError instanceof RunnerApiError)
          || completionError.status === 408
          || completionError.status === 429
          || completionError.status >= 500,
      },
    );
  }
}

async function runCapabilityExecution(browser: Browser, runnerId: string, lease: Extract<RunnerLease, { kind: "execute" }>, leaseGuard: LeaseRuntimeGuard) {
  leaseGuard.assertActive();
  const token = lease.job.lease!.token;
  const setupStartedAt = Date.now();
  const browserRunId = uid("browser_run");
  const setup = await createRecordedContext(browser, browserRunId, lease.job.mode === "debug" ? "debug" : "light");
  leaseGuard.bindContext(setup.context);
  let { page } = setup;
  try {
  const job: CapabilityRun = { ...lease.job, status: "running", runnerId, startedAt: lease.job.startedAt || new Date().toISOString(), steps: [...lease.job.steps], artifactIds: [...lease.job.artifactIds] };
  const evidenceRun: BrowserRun = {
    id: browserRunId,
    learningJobId: `capability_run:${job.id}`,
    siteAgentId: job.siteAgentId,
    candidateId: job.capabilityId,
    runnerId,
    mode: job.mode === "debug" ? "debug" : "execute",
    status: "running",
    browser: { name: "chromium", version: browser.version(), headless: true },
    startedAt: job.startedAt!,
    startUrl: trustedReleaseStartUrl(lease.release, lease.job.startUrl, Boolean(lease.job.revisionId)),
    steps: job.steps,
  };
  let terminalStatus: Extract<CapabilityRun["status"], "completed" | "failed"> = "completed";
  try {
    job.progress = { stage: "observing", message: "正在准备独立云端浏览器", updatedAt: new Date().toISOString() };
    await updateExecution(runnerId, token, job, leaseGuard);
    const executionOrigin = new URL(evidenceRun.startUrl).origin;
    await installPinnedPageNavigationGuard(page, executionOrigin);
    await page.goto(evidenceRun.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    assertReleasePageOrigin(page, executionOrigin);
    job.timings.environmentSetupMs = Date.now() - setupStartedAt;
    const executionStartedAt = Date.now();
    const moduleRef = lease.capability.module;
    let output: Record<string, JsonValue>;
    let executionSource: "module" | "release-operation";
    if (moduleRef) {
      const result = await runPlaywrightCapabilityStages({ page, moduleUrl: new URL(moduleRef.moduleUrl, browserPublicEndpoint).href, input: job.input, outputSchema: lease.capability.outputs });
      page = result.page;
      output = { ...result.output };
      executionSource = "module";
      job.steps.push(...result.receipts.map((receipt) => ({ stepId: receipt.stageId, op: "adaptive" as const, label: receipt.stageId, status: "passed" as const, startedAt: new Date(executionStartedAt).toISOString(), endedAt: new Date().toISOString(), evidence: { moduleUrl: moduleRef.moduleUrl, transition: receipt.transition, url: receipt.urlAfter } })));
    } else {
      const result = await runVerifiedReleaseOperationCapability({
        page,
        capability: lease.capability,
        release: lease.release,
        revision: lease.revision,
        requiredRevisionStatus: "published",
        input: job.input,
        signal: leaseGuard.signal,
      });
      page = result.page;
      output = result.output;
      executionSource = "release-operation";
      job.steps.push(...result.receipts);
    }
    job.timings.executionMs = Date.now() - executionStartedAt;
    job.output = output;
    job.resultUrl = page.url();
    job.outcome = { status: "success", code: "capability_run_completed", summary: `已完成：${lease.capability.name}`, evaluatedAt: new Date().toISOString(), evidence: { source: executionSource === "module" ? "cloud-capability-run" : "release-operation-run", stepCount: job.steps.length } };
    evidenceRun.status = "passed";
  } catch (error) {
    leaseGuard.assertActive();
    const code = errorCode(error);
    if (error instanceof PlaywrightStageRunError) {
      job.steps.push(...error.receipts.map((receipt) => ({ stepId: receipt.stageId, op: "adaptive" as const, label: receipt.stageId, status: "failed" as const, startedAt: job.startedAt!, endedAt: new Date().toISOString(), evidence: { transition: receipt.transition, url: receipt.urlAfter }, error: { code, message: error.message } })));
    }
    if (error instanceof ReleaseOperationRunError) job.steps.push(...error.receipts);
    terminalStatus = "failed";
    job.error = { code, summary: error instanceof Error ? error.message : String(error) };
    job.outcome = { status: "execution-fault", code, summary: job.error.summary, evaluatedAt: new Date().toISOString(), evidence: { source: "cloud-capability-run" } };
    evidenceRun.status = "failed";
    await reportRunnerFailure(runnerId, "executing", error, `capability_run:${job.id}`);
  }
  const executionEndedAt = new Date().toISOString();
  job.completedAt = executionEndedAt;
  job.timings.totalMs = Math.max(0, Date.parse(executionEndedAt) - Date.parse(job.createdAt));
  job.status = "running";
  job.progress = { stage: "recording", message: "结果已返回，正在后台保存调试证据", updatedAt: job.completedAt };
  job.completedAt = undefined;
  job.timings.totalMs = undefined;
  await updateExecution(runnerId, token, job, leaseGuard);
  const endingUrl = page.url();
  try {
    if (new URL(endingUrl).origin === new URL(evidenceRun.startUrl).origin) {
      evidenceRun.endUrl = endingUrl;
    }
  } catch {
    // A failed navigation may leave Chromium on about:blank. That is useful
    // in the error receipt, but it is not trusted Revision-scoped evidence.
  }
  evidenceRun.endedAt = executionEndedAt; evidenceRun.outcome = job.outcome;
  const saveEvidence = async () => {
    try {
      const artifacts = await finishArtifacts(setup.context, page, setup, evidenceRun, async (screenshot) => {
        job.artifactIds = [screenshot.id];
        job.progress = { stage: "recording", message: job.mode === "debug" ? "结果截图已保存，低清调试视频正在后台生成" : "结果截图已保存", updatedAt: new Date().toISOString() };
        await updateExecution(runnerId, token, job, leaseGuard);
      }, leaseGuard.signal);
      job.artifactIds = artifacts.map((artifact) => artifact.id);
      evidenceRun.artifactIds = [...job.artifactIds];
      job.progress = { stage: "complete", message: job.mode === "debug" ? "结果截图与低清调试视频已保存" : "结果截图已保存", updatedAt: new Date().toISOString() };
    } catch (error) {
      console.error(`capability_evidence_save_failed:${error instanceof Error ? error.message : String(error)}`);
      job.progress = { stage: "complete", message: job.artifactIds.length ? "结果已保存，部分调试证据生成失败" : "结果已返回，调试证据生成失败", updatedAt: new Date().toISOString() };
    }
    evidenceRun.artifactIds = [...job.artifactIds];
    job.status = terminalStatus;
    job.completedAt = new Date().toISOString();
    job.timings.totalMs = Math.max(0, Date.parse(job.completedAt) - Date.parse(job.createdAt));
    job.progress = { ...job.progress!, stage: "complete", updatedAt: job.completedAt };
    await updateExecution(runnerId, token, job, leaseGuard, evidenceRun);
  };
  await saveEvidence();
  } finally {
    await cleanupRecordedContext(setup.context, [setup.screenshotPath, setup.tracePath]);
  }
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(browserChannel ? { channel: browserChannel } : {}),
  });
  browserReadyPool = new BrowserReadyPool(browser, prewarmCapacity);
  await browserReadyPool.start();
  const register = async () => {
    let attempt = 0;
    while (!shuttingDown) {
      try {
        return await api<{
          runner?: { id: string; sessionId?: string; desiredState?: "active" | "draining" };
          instance?: { id: string; sessionId: string; desiredState: "active" | "draining" };
          sessionToken?: string;
        }>("/api/validation/runners/register", {
          method: "POST",
          body: JSON.stringify({
            id: runnerId,
            name: runnerName,
            role: runnerRole || "mixed",
            workKinds: runnerWorkKinds,
            version: runnerVersion,
            browsers: ["chromium"],
            maxConcurrency: runnerConsumerCount,
            recording: true,
            prewarmCapacity,
            readySlots: Math.min(browserReadyPool?.ready || 0, runnerConsumerCount),
          }),
          headers: runnerEnrollmentToken ? { authorization: `Bearer ${runnerEnrollmentToken}` } : {},
        });
      } catch (error) {
        if (once) throw error;
        if (shuttingDown) return undefined;
        attempt += 1;
        const retryMs = Math.min(15_000, 1_000 * 2 ** Math.min(4, attempt - 1));
        console.error(`runner_registration_retry:${retryMs}ms:${error instanceof Error ? error.message : String(error)}`);
        await waitForShutdownOrDelay(retryMs);
      }
    }
    return undefined;
  };
  const registration = await register();
  if (!registration) {
    await browserReadyPool.close();
    await browser.close();
    return;
  }
  const registeredRunner = registration.instance || registration.runner;
  if (!registeredRunner) throw new Error("runner_registration_invalid");
  runnerSessionId = registeredRunner.sessionId || "";
  runnerSessionToken = registration.sessionToken || "";
  draining = registeredRunner.desiredState === "draining";
  const registeredRunnerId = registeredRunner.id;
  registeredRunnerIdForHeaders = registeredRunnerId;
  let heartbeatStatus: "online" | "busy" = "online";
  let activeLeaseCount = 0;
  let heartbeatInFlight: Promise<unknown> | undefined;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = heartbeat(registeredRunnerId, heartbeatStatus)
      .then((result) => {
        if (result.desiredState) draining = result.desiredState === "draining";
      })
      .catch((error) => console.warn(`runner_heartbeat_failed:${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { heartbeatInFlight = undefined; });
  }, 5_000);
  let lastControlPlaneDispatchAt = 0;
  let controlPlaneDispatch: Promise<void> | undefined;
  async function dispatchControlPlaneWork() {
    if (Date.now() - lastControlPlaneDispatchAt < 2_000 || controlPlaneDispatch) return;
    lastControlPlaneDispatchAt = Date.now();
    const dispatchToken = process.env.CAPABILITY_V2_DISPATCH_TOKEN?.trim();
    controlPlaneDispatch = api("/api/internal/learning-dispatch", {
      method: "POST",
      headers: dispatchToken ? { authorization: `Bearer ${dispatchToken}` } : undefined,
    })
      .then(() => undefined)
      .catch((error) => console.warn(`runner_control_plane_dispatch_failed:${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { controlPlaneDispatch = undefined; });
    await controlPlaneDispatch;
  }
  async function consume(queue: RunnerQueue, idleMs: number) {
    do {
      try {
        if (shuttingDown) break;
        if (draining) {
          if (once) break;
          await waitForShutdownOrDelay(Math.min(idleMs || 800, 800));
          continue;
        }
        // In the container-native runtime there is no Cloudflare scheduled
        // handler.  The worker therefore advances model-only knowledge/design
        // jobs alongside browser work. This is deliberately throttled and
        // shared by all local consumers: waiting for a model response must not
        // occupy the compact profile's only browser execution slot.
        if (queue === "any" || queue === "background" || queue === "author") void dispatchControlPlaneWork();
        const { lease } = await api<{ lease?: RunnerLease }>(`/api/validation/runners/${encodeURIComponent(registeredRunnerId)}/lease`, {
          method: "POST",
          body: JSON.stringify({ queue, sessionId: runnerSessionId, sessionToken: runnerSessionToken }),
        });
        if (lease) {
          activeLeaseCount += 1;
          heartbeatStatus = "busy";
        }
        const controlLease = lease ? controlLeaseIdentity(lease) : undefined;
        if (controlLease) controlLeaseByToken.set(controlLease.token, controlLease);
        const leaseGuard = lease?.kind === "crawl"
          ? startCrawlLeaseRenewal(registeredRunnerId, lease.job)
          : lease?.kind === "site-preview"
            ? startCrawlLeaseRenewal(registeredRunnerId, lease.job, "site-preview")
          : startLeaseRenewal(registeredRunnerId, controlLease);
        try {
          if (lease?.kind === "execute") await runCapabilityExecution(browser, registeredRunnerId, lease, leaseGuard);
          else if (lease?.kind === "author") await runAuthoring(browser, registeredRunnerId, lease, leaseGuard);
          else if (lease?.kind === "validate") await runValidation(browser, registeredRunnerId, lease, leaseGuard);
          else if (lease?.kind === "crawl") await runCrawl(browser, registeredRunnerId, lease, leaseGuard);
          else if (lease?.kind === "site-preview") await runSitePreview(browser, registeredRunnerId, lease, leaseGuard);
        } finally {
          await leaseGuard.stop();
          if (controlLease) controlLeaseByToken.delete(controlLease.token);
          if (lease) {
            activeLeaseCount = Math.max(0, activeLeaseCount - 1);
            heartbeatStatus = activeLeaseCount ? "busy" : "online";
            const heartbeatResult = await heartbeat(registeredRunnerId, heartbeatStatus, activeLeaseCount ? undefined : null).catch(() => undefined);
            if (heartbeatResult?.desiredState) draining = heartbeatResult.desiredState === "draining";
          }
        }
        if (!lease && !once) await waitForShutdownOrDelay(idleMs);
      } catch (error) {
        console.error(`runner_${queue}_loop_failed:${error instanceof Error ? error.message : String(error)}`);
        if (!isRunnerLeaseLostError(error)) await reportRunnerFailure(registeredRunnerId, `consume:${queue}`, error);
        if (once) throw error;
        await waitForShutdownOrDelay(1_000);
      }
    } while (!once && !shuttingDown);
  }
  try {
    if (once) await consume(runnerRole || "any", 0);
    else if (runnerRole) {
      const idleMs = runnerRole === "interactive" ? 350 : 800;
      await Promise.all(Array.from({ length: runnerConsumerCount }, () => consume(runnerRole, idleMs)));
    }
    else await Promise.all([
      consume("interactive", 350),
      ...Array.from({ length: runnerConsumerCount - 1 }, () => consume("background", 800)),
    ]);
  } finally {
    clearInterval(heartbeatTimer);
    await heartbeatInFlight?.catch(() => undefined);
    await heartbeat(registeredRunnerId, "offline", null).catch(() => undefined);
    await browserReadyPool.close();
    await browser.close();
  }
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shuttingDown = true;
    draining = true;
    resolveShutdownRequest?.();
    console.log(`runner_shutting_down:${signal}`);
  });
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
