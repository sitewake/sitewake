import { capabilityCompletionText } from "../lib/capability-center-v2/result-presentation";
export { capabilityCompletionText } from "../lib/capability-center-v2/result-presentation";
import { RuntimeReleaseClient, AgentStartupError } from './runtime-release-client';
import { capabilityNavigationKind } from "../lib/capability-center-v2/navigation";
import { executeBrowserCapabilityStage, settleCapabilityPage } from "../lib/capability-center-v2/browser-stage-sdk";
import {
  SITE_AGENT_SCHEMA_VERSION,
  defaultAgentConfig,
  isRelease,
  normalizeGoal,
  type ActionReceiptV2,
  type CapabilityDefinition,
  type CapabilityModule,
  type ClientDirective,
  type ExecutionRequirement,
  type ExperienceActionEvidence,
  type ExperienceRouteEvidence,
  type JsonPrimitive,
  type JsonValue,
  type KnowledgeCandidate,
  type OperationDefinition,
  type OutcomeReceipt,
  type PageAgentObservation,
  type PageObservationRef,
  type PageExecutionBrief,
  type PageExecutionBudget,
  type PageProgram,
  type PageProgramStep,
  type PageRuntimeMetric,
  type SceneDefinition,
  type SiteAgentReleaseV2,
  type AgentRun,
  type AgentRunActivity,
  type AgentRunCheckpoint,
  type AgentRunToolCall,
  type TaskLaunch,
  type TaskEpisode,
  type TaskSession,
  type TransitionObservation,
} from "../lib/site-knowledge/protocol";
import { preserveRuntimeReleaseFeatures } from "./user-agent-runtime-release";
import type {
  CapabilityContract as CapabilityContractV2,
  CapabilityExperience,
  CapabilityProgram as CapabilityProgramV2,
  CapabilityControlFlow as CapabilityControlFlowV2,
  CapabilityExecutionCursor as CapabilityExecutionCursorV2,
  CapabilityStageEvidence as CapabilityStageEvidenceV2,
  CapabilityStageManifest as CapabilityStageManifestV2,
  CapabilityStageResult as CapabilityStageResultV2,
  JsonObject as JsonObjectV2,
} from "../lib/capability-center-v2/model";
import {
  assertCapabilityNavigationUrl,
  assertCapabilityStageResultIO,
  capabilityScopedJson,
  normalizeCapabilityStageIO,
  normalizeCapabilityStageNavigation,
} from "../lib/capability-center-v2/stage-io";
import {
  beginCapabilityStage,
  capabilityJsonEqual,
  capabilityControlFlowLimits,
  capabilityStageDeadline,
  assertCapabilityControlFlowBudget,
  capabilityStageIteration,
  createCapabilityExecutionCursor,
  resolveCapabilityStageTransition,
} from "../lib/capability-center-v2/control-flow";
import {
  capabilityHandoffForEpisode,
} from "../lib/capability-center-v2/experience";
import { capabilityOptionNotOffered, capabilityVerificationOnlyFailure, explainCapabilityRuntimeFailure } from "../lib/capability-center-v2/runtime-failure";
import { capabilityTextIncludes } from "../lib/capability-center-v2/text-match";
import { VALIDATION_RESULT_KEY } from "../lib/capability-center-v2/validation-run";
import { resolveCapabilityInputDefaults } from "../lib/capability-center-v2/input-template";
import { startDomReplayRecorder } from "./user-agent-recorder";
import { capabilityInputPathValue, capabilityTemplateInputPaths, capabilityUrlTemplateMatches, matchCapabilityIntentTemplate, renderCapabilityInputTemplate } from "../lib/capability-center-v2/input-template";
import { assertCapabilityInput, assertCapabilityOutput } from "../lib/site-knowledge/capability-output";
import { classifyGoal, isNavigationIntentGoal, transientNavigationToolCapability } from "../lib/site-knowledge/navigation-tools";
import { executionCompletionCriteria, executionRequirementForGoal, knowledgeCanAnswerGoal } from "../lib/site-knowledge/execution-requirement";
import { inferExecutionTargetEntity } from "../lib/site-knowledge/execution-evidence";
import { sha256HexText } from "../lib/site-knowledge/sha256";
import { capabilityGoalConflicts, choosePlan, exactCapabilityForGoal, rankPublishedCapabilities, searchKnowledgeIndex } from "../lib/site-knowledge/planner";
import { KEYWORD_EXPANSION_GUIDANCE } from "../lib/site-knowledge/knowledge-search-guidance";
import { buildTaskJudgeEvidence } from "../lib/site-knowledge/task-outcome";
import { profileTaskTemplates, userInvocableCapabilities } from "../lib/site-knowledge/site-knowledge";
import { assertRuntimeActionAllowed, assertRuntimeNavigationAllowed, assertRuntimeTeachingAllowed, enforceRuntimeReleaseReadiness } from "../lib/site-knowledge/runtime-policy";
import { buildSceneUrl, matchUrlTemplate, recognizeScene } from "../lib/site-knowledge/url-scene";
import { judgeTaskOutcome } from "./user-agent-judge";
import { replyLanguageInstruction, resolveReplyLocale, resolveWidgetLocale, widgetCopy } from "./user-agent-copy";
import { profileLanguage } from "../lib/site-knowledge/protocol";
import { reportUnregisteredOrigin } from "./user-agent-diagnostics";
import {
  actionableFromEvent,
  browserSessionId,
  capturePageSnapshot,
  awaitPageHandoff,
  clickTarget,
  documentId,
  evidenceFromElement,
  eventBelongsToSiteAgent,
  fillTarget,
  resolveTarget,
  resolveValue,
  targetFromEvidence,
  uid,
  waitFor,
} from "./user-agent-shared";

export type PortStatus = {
  phase: "connecting" | "ready" | "executing" | "adaptive" | "learning" | "awaiting-human" | "resuming" | "validating" | "completed" | "error";
  message: string;
  detail?: Record<string, unknown>;
};

export type PortOptions = {
  siteAgentId: string;
  visibility?: "production" | "sandbox" | "system";
  /** This document is the console's rehearsal, not a real installation. */
  rehearsal?: boolean;
  runtimeMode?: "full" | "read-only";
  allowedCapabilityIds?: string[];
  endpoint?: string;
  adaptiveUrl?: string;
  maxSteps?: number;
  domReplay?: boolean;
  onStatus?: (status: PortStatus) => void;
  onAskUser?: (question: string, options?: {
    signal: AbortSignal;
    choices?: Array<{ label: string; value: string }>;
  }) => Promise<string>;
  handoffToken?: string;
  executionReleaseId?: string;
  executionReleaseVersion?: number;
  executionRevisionId?: string;
};

/**
 * The three things one question hands to the WebAgent. `run()` takes them positionally;
 * the struct exists so this module boundary has a referable name. Call shape unchanged.
 */
export type WebAgentTaskInput = {
  /** The user's sentence, passed down verbatim. */
  goal: string;
  /** Business values the user filled into the form field by field. `{}` for plain chat. */
  input: Record<string, JsonValue>;
  /** Recent chat turns as model context. May be empty. */
  conversation: TaskSession["conversation"];
};

export type TaskResult = {
  success: boolean;
  mode: "compiled" | "adaptive" | "repair" | "demonstration" | "validation";
  /** Presentation is intentionally independent from execution mode. A normal
   * conversation may use the same durable AgentRun without pretending to be a
   * browser task or a learning episode. */
  interaction?: "conversation" | "capability" | "exploration";
  text: string;
  output: Record<string, JsonValue>;
  outcome: TaskEpisode["outcome"];
  session: TaskSession;
  release: SiteAgentReleaseV2;
};

export type CapabilityV2Candidate = {
  capabilityId: string;
  name: string;
  description: string;
  aliases?: string[];
  contract: { inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>; inputAliases?: Record<string, Record<string, string>>; intent?: string; successConditions?: JsonValue[]; scope?: Record<string, unknown> };
  status?: "Active";
  score?: number;
  scopeMatchReason?: string;
};

export type CapabilityV2RuntimeDefinition = {
  capabilityId: string;
  versionId: string;
  executionGrantId: string;
  name: string;
  description: string;
  contract: CapabilityContractV2;
  program: CapabilityProgramV2;
};

/**
 * Contract values are public/user-facing, while authored browser stages need
 * the site-language value learned during Discovery (for example `垫子` →
 * `cushion`).  The Runner already applies this projection for C3; the hot
 * path in the Site Agent must apply the same projection before preconditions,
 * stage code, and success templates are evaluated.  Keep the raw input in
 * status/episode presentation, but never expose the unprojected value to the
 * executable module.
 */
function applyCapabilityV2InputAliases(runtime: { program?: { inputAliases?: Record<string, Record<string, string>> }; contract: { inputAliases?: Record<string, Record<string, string>> } }, input: Record<string, JsonValue>): Record<string, JsonValue> {
  const aliases = runtime.program?.inputAliases || runtime.contract.inputAliases;
  if (!aliases) return input;
  const resolved: Record<string, JsonValue> = { ...input };
  for (const [name, values] of Object.entries(aliases)) {
    const value = resolved[name];
    if (typeof value !== "string") continue;
    const mapped = values[value];
    if (typeof mapped === "string" && mapped.trim()) resolved[name] = mapped;
  }
  return resolved;
}

/**
 * A natural-language value can omit punctuation used by a site's visible
 * option label (for example `Name A to Z` vs `Name, A to Z`).  Once a Stage
 * opens a menu, reconcile string inputs against the currently visible option
 * text.  This is deliberately limited to option/menuitem nodes so product
 * names and free-form text are never silently rewritten.
 */
function reconcileVisibleCapabilityOptions(input: Record<string, JsonValue>): Record<string, JsonValue> {
  const comparable = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[到至]/gu, "to").replace(/[\s\p{P}\p{S}]+/gu, "");  // i18n-exempt:匹配用户输入里的范围词，不是展示文案
  const options = Array.from(document.querySelectorAll<HTMLElement>("option,[role='option'],[role='menuitem']"))
    .filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    })
    .map((element) => (element.textContent || element.getAttribute("aria-label") || "").trim())
    .filter(Boolean);
  if (!options.length) return input;
  const resolved: Record<string, JsonValue> = { ...input };
  for (const [name, value] of Object.entries(input)) {
    if (!/(?:sort|order|filter|option|choice|select|color|colour|material|size|variant|currency|排序|筛选|颜色|材质|尺码|货币)/iu.test(name)) continue;  // i18n-exempt:匹配用户输入里的筛选词，不是展示文案
    if (typeof value !== "string" || !value.trim()) continue;
    const needle = comparable(value);
    if (!needle) continue;
    const match = options.find((option) => {
      const candidate = comparable(option);
      return candidate === needle || (needle.length >= 2 && (candidate.includes(needle) || needle.includes(candidate)));
    });
    if (match && match !== value) resolved[name] = match;
  }
  return resolved;
}

type CapabilityV2StageModule = {
  capability?: {
    version?: number;
    controlFlow?: CapabilityControlFlowV2;
    stages?: Array<{
      id?: string;
      transitions?: Record<string, string>;
      io?: unknown;
      navigation?: unknown;
      run?: (context: { input: JsonObjectV2; state: JsonObjectV2; signal?: AbortSignal; deadlineAt?: string }) => unknown | Promise<unknown>;
    }>;
  };
};

type CapabilityV2StageReceipt = {
  stageId: string;
  stageIndex: number;
  status: "Started" | "Completed";
  urlBefore: string;
  urlAfter?: string;
  outcome?: CapabilityStageResultV2["outcome"];
  signal?: string;
  iteration?: number;
  evidence?: CapabilityStageEvidenceV2[];
  completedAt?: string;
};

function assertCapabilityV2Json(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCapabilityV2Json(item, `${path}.${index}`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) assertCapabilityV2Json(item, `${path}.${key}`);
    return;
  }
  throw new Error(`capability_stage_non_json:${path}`);
}

/** A Stage came back with nothing to show: no outcome yet, so look again. */
function capabilityStageFoundNothing(value: unknown) {
  return Boolean(value) && typeof value === "object" && (value as { outcome?: unknown }).outcome === "NoResult";
}

function normalizeCapabilityV2StageResult(value: unknown, manifest: CapabilityStageManifestV2): CapabilityStageResultV2 {
  const stageId = manifest.id;
  const result = capabilityV2Object(value);
  if (!["Continue", "Success", "NoResult", "Ambiguous", "BusinessRejection"].includes(String(result.outcome || ""))) {
    throw new Error(`capability_stage_outcome_invalid:${stageId}`);
  }
  if (result.state !== undefined && (!result.state || typeof result.state !== "object" || Array.isArray(result.state))) {
    throw new Error(`capability_stage_state_invalid:${stageId}`);
  }
  if (result.output !== undefined && (!result.output || typeof result.output !== "object" || Array.isArray(result.output))) {
    throw new Error(`capability_stage_output_invalid:${stageId}`);
  }
  if (result.signal !== undefined && (typeof result.signal !== "string" || !result.signal.trim())) {
    throw new Error(`capability_stage_signal_invalid:${stageId}`);
  }
  if (result.evidence !== undefined && !Array.isArray(result.evidence)) throw new Error(`capability_stage_evidence_invalid:${stageId}`);
  assertCapabilityV2Json(result, `stage.${stageId}`);
  const normalized = result as unknown as CapabilityStageResultV2;
  if (normalized.outcome === "Success" && !normalized.output) throw new Error(`capability_stage_success_output_required:${stageId}`);
  if (["NoResult", "Ambiguous", "BusinessRejection"].includes(normalized.outcome) && !normalized.reason?.trim()) {
    throw new Error(`capability_stage_reason_required:${stageId}`);
  }
  assertCapabilityStageResultIO(manifest, normalized, stageId);
  return normalized;
}

class CapabilityV2HandledOutcomeError extends Error {
  constructor(
    readonly status: "no-result" | "business-rejection",
    readonly code: string,
    readonly summary: string,
    readonly detail: Record<string, JsonValue> = {},
  ) {
    super(summary);
    this.name = "CapabilityV2HandledOutcomeError";
  }
}

const runCopy = () => widgetCopy(resolveWidgetLocale()).run;
/** The visitor's frame for a finished capability result, resolved per render. */
const completionPresentation = () => {
  const locale = resolveWidgetLocale();
  return { copy: widgetCopy(locale).completion, locale };
};

function capabilityV2Object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function capabilityV2PathValue(root: unknown, path: string): unknown {
  return capabilityInputPathValue(root, path);
}

function capabilityV2RenderTemplate(template: unknown, input: Record<string, JsonValue>) {
  return renderCapabilityInputTemplate(template, input);
}

/**
 * What a capability run as one step of a larger request is judged against:
 * its own intent with this run's values, never the visitor's whole request,
 * which a step by definition does not finish.
 */
function capabilityStepGoal(runtime: CapabilityV2RuntimeDefinition, input: Record<string, JsonValue>) {
  const intent = typeof runtime.contract.intent === "string" ? capabilityV2RenderTemplate(runtime.contract.intent, input) : "";
  return (typeof intent === "string" && intent.trim()) || runtime.name;
}

function capabilityV2TemplateInputPaths(template: unknown) {
  return capabilityTemplateInputPaths(template);
}

function capabilityV2NoResultForInputs(runtime: CapabilityV2RuntimeDefinition, input: Record<string, JsonValue>, inputPaths: string[], detail: Record<string, JsonValue> = {}) {
  const say = runCopy();
  const properties = capabilityV2Object(capabilityV2Object(runtime.contract.inputSchema).properties);
  const fields = [...new Set(inputPaths)].map((path) => {
    const root = path.split(".")[0];
    const schema = capabilityV2Object(properties[root]);
    const label = String(schema.title || schema.description || path);
    const sensitive = schema.writeOnly === true || schema.format === "password" || /password|secret|token|credential/i.test(path);
    const rawValue = capabilityV2PathValue(input, path);
    const value = rawValue === undefined ? say.notProvided : sensitive ? say.valueProvided : typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue);
    return { label, value, sensitive };
  });
  const target = fields.length === 1 && !fields[0].sensitive
    ? say.quotedField(fields[0].value, fields[0].label)
    : fields.map((field) => say.labelledValue(field.label, field.value)).join(say.listSeparator) || say.currentInputs;
  return new CapabilityV2HandledOutcomeError(
    "no-result",
    "capability_target_absent",
    say.targetNotFound(target, runtime.name),
    { inputPaths: [...new Set(inputPaths)], ...detail },
  );
}

function capabilityV2FailureInputLabel(runtime: CapabilityV2RuntimeDefinition, message: string) {
  const rawPath = message.split(":")[1]?.split(",")[0]?.replace(/^input\./, "").trim();
  if (!rawPath) return undefined;
  const root = rawPath.split(".")[0];
  const properties = capabilityV2Object(capabilityV2Object(runtime.contract.inputSchema).properties);
  const schema = capabilityV2Object(properties[root]);
  return String(schema.title || schema.description || rawPath);
}

type AdaptiveTrace = {
  /** Stable across document handoffs so all observations belong to one Episode. */
  episodeId?: string;
  startedAt: string;
  startSnapshot: ReturnType<typeof capturePageSnapshot>;
  steps: PageProgramStep[];
  targets: ReturnType<typeof targetFromEvidence>[];
  actions: ExperienceActionEvidence[];
  actionReceiptsV2?: ActionReceiptV2[];
  observationRefs?: PageObservationRef[];
  budgetEvidence?: PageExecutionBudget;
  runtimeMetrics?: PageRuntimeMetric[];
  toolReceipts?: NonNullable<TaskEpisode["experience"]>["toolReceipts"];
  /** The page agent's own per-document conclusions; see AgentPageNote in user-agent-adaptive.ts. */
  notes?: Array<{ documentId: string; url: string; memory: string; nextGoal?: string }>;
};

type CapabilityToolContext = {
  parentMode: "adaptive" | "repair";
  adaptiveTrace: AdaptiveTrace;
  backgroundCapabilityExperience?: boolean;
  pageExecutionBrief?: PageExecutionBrief;
  pageExecutionBudget?: PageExecutionBudget;
  sourceCapabilityId?: string;
  runtimeModeOverride?: "read-only" | "full";
  executionIntent?: "reconciliation" | "confirmed-continuation";
};

export type TaskLaunchExecutionPin = Required<Pick<
  TaskLaunch,
  "releaseId" | "releaseVersion" | "revisionId"
>>;

type AdaptiveGlobal = {
  run(options: {
    siteAgentId: string; endpoint: string; maxSteps: number; goal: string; input: Record<string, JsonValue>;
    release: SiteAgentReleaseV2; session: TaskSession; mode: "adaptive" | "repair";
    requiredActionEvidence?: "material" | "input";
    agentRunToken: string; domReplay?: boolean; runtimeMode?: "full" | "read-only";
    readOnlySource?: "site-config" | "runtime-derived";
    pageEpoch?: number;
    runtimeV2?: boolean; evidenceV2?: boolean;
    pageExecutionBrief?: PageExecutionBrief; pageExecutionBudget?: PageExecutionBudget;
    repairAttempt?: number; onStatus?: PortOptions["onStatus"];
    resumeTrace?: AdaptiveTrace; onTrace?: (trace: AdaptiveTrace) => void;
    onAskUser?: (question: string, options?: {
      signal: AbortSignal;
      choices?: Array<{ label: string; value: string }>;
    }) => Promise<string>;
    onObservation?: (observation: PageAgentObservation) => void | Promise<void>;
    onDrainObservations?: () => void | Promise<void>;
    onBeforeNavigationAction?: () => Promise<void>;
    onNavigateAction?: (url: string, target: string, route?: ExperienceRouteEvidence) => boolean | Promise<boolean>;
    callCapability?: (capabilityId: string, input: Record<string, JsonValue>, trace: AdaptiveTrace) => Promise<{
      success: boolean; text: string; output: Record<string, JsonValue>; outcome: TaskEpisode["outcome"];
    }>;
  }): Promise<{ success: boolean; text: string; output: Record<string, JsonValue>; episode: TaskEpisode }>;
  cancel?(): void;
};

declare global {
  interface Window {
    SiteWakeAdaptive?: AdaptiveGlobal;
    SiteWakePort?: { version: string; create(options: PortOptions): AgentPort };
  }
}

function endpointUrl(endpoint: string, path: string) {
  return endpoint ? `${endpoint.replace(/\/$/, "")}${path}` : path;
}

async function json<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) throw new Error(payload.message || payload.error || `http_${response.status}`);
  return payload;
}

export class FetchTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`fetch_timeout_after_${timeoutMs}ms`);
    this.name = "FetchTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function signalAbortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Fetch with a deadline that covers both response headers and consumption of
 * the response body.  Returning a wrapped Response keeps response.json(),
 * response.text(), and direct stream readers on the same deadline.
 */
/**
 * `timeoutMs` bounds the whole exchange including the streamed body.
 *
 * `firstByteTimeoutMs` additionally bounds the wait for the first byte. A model
 * that accepts the request and then never emits a token is the failure mode a
 * single overall timeout handles worst: it makes the user wait out the entire
 * budget for a response that was never coming.
 */
/**
 * Checkpoint persistence is on the navigation critical path: the handoff waits
 * for this chain before it can even ask the server to move the run. Generous
 * against a large evidence body, but never open-ended.
 */
export const CHECKPOINT_SYNC_TIMEOUT_MS = 20_000;

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 8_000,
  firstByteTimeoutMs?: number,
): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init.signal || undefined;
  const effectiveTimeoutMs = Math.max(0, timeoutMs);
  const effectiveFirstByteMs = firstByteTimeoutMs === undefined
    ? undefined
    : Math.max(0, Math.min(firstByteTimeoutMs, effectiveTimeoutMs));
  let firstByteTimeout: ReturnType<typeof setTimeout> | undefined;
  const clearFirstByteTimeout = () => {
    if (firstByteTimeout !== undefined) clearTimeout(firstByteTimeout);
    firstByteTimeout = undefined;
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let downstreamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let failure: unknown;
  let finished = false;

  const cleanup = () => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
    clearFirstByteTimeout();
    externalSignal?.removeEventListener("abort", onExternalAbort);
  };
  const releaseReader = () => {
    try { upstreamReader?.releaseLock(); } catch { /* The reader may still have an in-flight read. */ }
  };
  const fail = (reason: unknown) => {
    if (finished) return;
    failure = reason;
    finished = true;
    cleanup();
    if (!controller.signal.aborted) controller.abort(reason);
    try { downstreamController?.error(reason); } catch { /* The response body may already be closed. */ }
    if (upstreamReader) void upstreamReader.cancel(reason).catch(() => undefined).finally(releaseReader);
  };
  function onExternalAbort() {
    if (externalSignal) fail(signalAbortReason(externalSignal));
  }

  if (externalSignal?.aborted) {
    const reason = signalAbortReason(externalSignal);
    controller.abort(reason);
    throw reason;
  }
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  timeout = setTimeout(() => fail(new FetchTimeoutError(effectiveTimeoutMs)), effectiveTimeoutMs);
  if (effectiveFirstByteMs !== undefined) {
    firstByteTimeout = setTimeout(() => fail(new FetchTimeoutError(effectiveFirstByteMs)), effectiveFirstByteMs);
  }

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (failure) {
      await response.body?.cancel(failure).catch(() => undefined);
      throw failure;
    }
    if (!response.body || [204, 205, 304].includes(response.status)) {
      finished = true;
      cleanup();
      // Browser/host fetch wrappers can expose an empty stream for bodyless
      // statuses. Re-wrapping that stream as a Response throws before startup.
      if (response.body) {
        await response.body.cancel().catch(() => undefined);
        return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      return response;
    }
    // The body exists but nothing has been read yet; the first-byte deadline
    // stays armed until the first chunk actually arrives.

    upstreamReader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        downstreamController = streamController;
        if (failure) {
          try { streamController.error(failure); } catch { /* The stream was already errored. */ }
        }
      },
      async pull(streamController) {
        if (failure || finished) return;
        try {
          const next = await upstreamReader!.read();
          if (failure) return;
          if (next.done) {
            finished = true;
            cleanup();
            streamController.close();
            releaseReader();
            return;
          }
          clearFirstByteTimeout();
          streamController.enqueue(next.value);
        } catch (error) {
          if (failure) return;
          finished = true;
          cleanup();
          try { streamController.error(error); } catch { /* The consumer may have canceled concurrently. */ }
          releaseReader();
        }
      },
      async cancel(reason) {
        if (!finished) {
          finished = true;
          cleanup();
        }
        try { await upstreamReader?.cancel(reason); }
        finally { releaseReader(); }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    const reason = failure || error;
    if (!finished) {
      finished = true;
      cleanup();
    }
    throw reason;
  }
}

export type MainAgentTurnResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
};

// Runtime routing is a real provider call, but it is also a user sitting in
// front of a chat box. Measured production latency is 5-7 seconds with an
// observed worst case near 12, so a single 180-second deadline never fired on
// a healthy request and only ever made a stuck one cost three minutes.
//
// Two deadlines instead of one: a short wait for the first token catches the
// "accepted the request, never emitted anything" case, and a longer overall
// deadline still covers genuinely long generations. The retry stays bounded so
// a persistent provider limit surfaces instead of looping.
const RUNTIME_MODEL_TIMEOUT_MS = 60_000;
const RUNTIME_MODEL_FIRST_BYTE_TIMEOUT_MS = 20_000;
// One bounded retry is enough to honor a provider Retry-After without turning
// a single user turn into a burst of three real requests.
const RUNTIME_MODEL_MAX_ATTEMPTS = 2;
// The provider is shared by all site-agent tabs/tasks.  A short global spacing
// prevents a multi-step PageAgent turn (or two tabs started together) from
// becoming a burst that is rejected with 429 before the provider's own
// Retry-After policy can help.  This is a transport throttle only; it does not
// replace the bounded retry or the 180-second per-call deadline.
const RUNTIME_MODEL_MIN_INTERVAL_MS = 1_500;
/** How many of a run's page actions the handover carries; the payload is capped at 56 KB. */
const RUN_PAGE_ACTION_LIMIT = 40;

/**
 * How long this attempt waits for the provider's first token.
 *
 * The short deadline exists to catch a request the provider accepted and then
 * never spoke on. Once it has fired, "stuck" has been ruled out cheaply, and
 * the retry's only remaining question is whether the provider is simply slow —
 * which it is whenever something heavy (a capability being authored) shares
 * the gateway. A production task died here: two router turns came back in 37s
 * and 20s, and the third was cut at the 20s first-byte deadline twice in a
 * row. The retry therefore waits out the overall deadline instead.
 */
export function runtimeModelFirstByteTimeoutMs(attempt: number) {
  return attempt === 0 ? RUNTIME_MODEL_FIRST_BYTE_TIMEOUT_MS : undefined;
}

/**
 * What to tell the user when the task fell over before it touched the page.
 *
 * The provider being slow or busy is not a defect in the site, the capability
 * or the request, and "interrupted during startup" sends the reader looking
 * for one. It is named, and it says what makes it better.
 */
export function agentStartupFailure(raw: string): { code: string; summary: string } {
  if (/^fetch_timeout_after/u.test(raw) || /main_agent_http_(?:408|429|5\d\d)/u.test(raw)) {
    return {
      code: "runtime_model_unavailable",
      summary: runCopy().modelNoResponse,
    };
  }
  if (raw.includes("normalize") || raw.includes("undefined")) {
    return { code: "runtime_capability_metadata_invalid", summary: runCopy().capabilityMetadataInvalid };
  }
  if (raw.startsWith("main_agent_scene_route_failed:")) {
    return { code: "main_agent_scene_route_failed", summary: runCopy().sceneRouteFailed };
  }
  if (raw === "main_agent_turn_limit") {
    return { code: "main_agent_routing_exhausted", summary: runCopy().routingExhausted };
  }
  return { code: "agent_runtime_start_failed", summary: runCopy().runtimeStartFailed };
}
let nextRuntimeModelRequestAt = 0;

class RuntimeModelRequestError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | undefined, message: string) {
    super(message);
    this.name = "RuntimeModelRequestError";
  }
}

function retryAfterMilliseconds(response: Response, attempt: number) {
  const retryAfter = response.headers.get("retry-after") || response.headers.get("x-ratelimit-reset-requests");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      // Providers commonly return seconds; tolerate an epoch-second reset as
      // well, without allowing a malformed value to stall the browser.
      const delay = seconds > 10_000 ? Math.max(0, seconds * 1_000 - Date.now()) : seconds * 1_000;
      return Math.min(60_000, Math.max(500, delay));
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(60_000, Math.max(500, date - Date.now()));
  }
  return Math.min(15_000, 1_000 * (2 ** attempt));
}

function runtimeModelRetryable(error: unknown) {
  return error instanceof RuntimeModelRequestError
    ? error.status === 408 || error.status === 429 || error.status >= 500
    : error instanceof TypeError || error instanceof FetchTimeoutError;
}

/** Consume an OpenAI-compatible response and stop promptly at the SSE sentinel. */
export async function readMainAgentTurnResponse(response: Response, onContent?: (content: string) => void): Promise<MainAgentTurnResponse> {
  if (!/text\/event-stream/i.test(response.headers.get("content-type") || "") || !response.body) {
    return await response.json() as MainAgentTurnResponse;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reachedEof = false;
  let reachedDone = false;
  const calls = new Map<number, { id?: string; type?: string; function?: { name?: string; arguments?: string } }>();
  const consume = (payload: string) => {
    if (!payload) return;
    if (payload === "[DONE]") {
      reachedDone = true;
      return;
    }
    let parsed: { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }> };
    try { parsed = JSON.parse(payload); } catch { return; }
    for (const choice of parsed.choices || []) {
      const delta = choice.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        onContent?.(content);
      }
      for (const chunk of delta.tool_calls || []) {
        const index = Number(chunk.index || 0);
        const current = calls.get(index) || {};
        calls.set(index, {
          id: chunk.id || current.id,
          type: chunk.type || current.type || "function",
          function: {
            name: chunk.function?.name || current.function?.name || "",
            arguments: `${current.function?.arguments || ""}${chunk.function?.arguments || ""}`,
          },
        });
      }
    }
  };
  const consumeBufferedEvents = () => {
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0 && !reachedDone) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      consume(data);
      boundary = buffer.indexOf("\n\n");
    }
  };

  try {
    while (!reachedDone) {
      const next = await reader.read();
      if (next.done) {
        reachedEof = true;
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(next.value, { stream: true }).replaceAll("\r\n", "\n");
      consumeBufferedEvents();
    }
    if (!reachedDone && buffer.trim()) {
      consume(buffer.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n"));
    }
    return { choices: [{ message: { content, tool_calls: [...calls.values()] } }] };
  } finally {
    if (!reachedEof) {
      try { await reader.cancel(reachedDone ? "sse_done" : "sse_abandoned"); }
      catch { /* Preserve the original stream error. */ }
    }
    try { reader.releaseLock(); } catch { /* The stream may be settling a concurrent cancellation. */ }
  }
}

type MainAgentContinuation = {
  messages: Array<Record<string, unknown>>;
  nextTurn: number;
  destination: string;
  /** Set when a capability the Agent called as a tool has ended; closes the task with that capability's own result. */
  capabilityResult?: () => Promise<TaskResult>;
};

/** A capability the main Agent called as one tool: its result goes back to the Agent, not to the visitor. */
type CapabilityAgentStep = {
  messages: Array<Record<string, unknown>>;
  nextTurn: number;
  toolCallId: string;
  toolName: string;
};


type RuntimeTiming = { name: string; startedAt: string; durationMs: number; status: "ok" | "error"; serverMs?: number; requestId?: string };

type Checkpoint = {
  runtimeTimings?: RuntimeTiming[];
  sessionId: string;
  mode: "compiled" | "validation" | "adaptive" | "repair";
  releaseId?: string;
  releaseVersion?: number;
  revisionId?: string;
  phase?: "running" | "navigating" | "waiting-page-restore" | "awaiting-human";
  capability?: CapabilityDefinition;
  v2Runtime?: CapabilityV2RuntimeDefinition;
  v2ModuleHash?: string;
  v2ControlState?: CapabilityExecutionCursorV2;
  v2StageReceipts?: CapabilityV2StageReceipt[];
  v2StageEvidence?: CapabilityStageEvidenceV2[];
  candidate?: KnowledgeCandidate;
  input: Record<string, JsonValue>;
  operationIndex: number;
  programStepIndex: number;
  output?: Record<string, JsonValue>;
  adaptiveTrace?: AdaptiveTrace;
  /** Addresses this run entered, accumulated across document handoffs. */
  routes?: ExperienceRouteEvidence[];
  /** This run started because no published capability matched. */
  backgroundCapabilityExperience?: boolean;
  pageExecutionBrief?: PageExecutionBrief;
  pageExecutionBudget?: PageExecutionBudget;
  /** Absolute, single-run wall-clock budget. It is never reset on navigation. */
  compiledRuntimeWindow?: CompiledRuntimeWindow;
  sourceCapabilityId?: string;
  runtimeModeOverride?: "read-only" | "full";
  executionIntent?: "reconciliation" | "confirmed-continuation";
  toolContext?: CapabilityToolContext;
  directCall?: boolean;
  /** A candidate run by validation before it is published: report the result, never repair or learn from it. */
  validationRun?: boolean;
  // Set only by a direct verified-scene navigation from the main Agent. When the
  // destination document restores this checkpoint it finishes the task with this
  // text via completeConversation — no page-reading Agent, no extra model turn.
  // The navigation IS the answer, so the knowledge-base entry closes the loop itself.
  directAnswer?: string;
  mainAgent?: MainAgentContinuation;
  v2AgentStep?: CapabilityAgentStep;
  activityTimeline?: AgentRunActivity[];
  savedAt: number;
};

type RunPointer = { runId: string; resumeToken: string; revision: number; pageEpoch: number; savedAt: number };

/**
 * A Run cannot outlive its resume token, so a record older than the token
 * lifetime can no longer be closed from here and is left to the server sweep.
 */
export function retainablePendingTerminals<T extends { runId?: string; resumeToken?: string; savedAt: number }>(
  entries: T[] | unknown,
  now = Date.now(),
): T[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry) => Boolean(entry?.runId) && Boolean(entry?.resumeToken)
    && now - Number(entry?.savedAt || 0) < 24 * 60 * 60_000);
}

/**
 * Whether a failed replay should be abandoned rather than retried. Auth,
 * missing and conflict responses all mean the Run is no longer ours to close;
 * anything else may still be transient.
 */
export function pendingTerminalIsUnrecoverable(message: string) {
  return /http_(?:401|403|404|409|410)/.test(message);
}


/**
 * A terminal state that still has to reach the server. Recorded before the
 * report is attempted so a page that closes mid-flight does not strand the Run
 * in "running" forever.
 */
type PendingTerminal = {
  runId: string;
  resumeToken: string;
  revision: number;
  pageEpoch: number;
  status: "completed" | "failed" | "cancelled";
  outcome?: OutcomeReceipt;
  output?: Record<string, JsonValue>;
  assistantText?: string;
  activityTimeline: AgentRunActivity[];
  savedAt: number;
};

type NavigationIntent = {
  runId: string;
  /** Single-use server grant. The durable resume token never crosses documents. */
  handoffToken: string;
  sourceDocumentId: string;
  sourceUrl: string;
  checkpoint: Checkpoint;
  createdAt: number;
};

export { executionRequirementForGoal };

function explicitlyRequiresPageOperation(goal: string) {
  return executionRequirementForGoal(goal).kind === "required";
}

function pageExecutionBrief(options: {
  goal: string;
  input: Record<string, JsonValue>;
  requirement: ExecutionRequirement;
  objective?: unknown;
  effect?: unknown;
  entities?: unknown;
  completionCriteria?: unknown;
  relevantSceneIds?: string[];
  relevantCapabilityIds?: string[];
  rejectedCapabilityReasons?: string[];
  knowledgeReceiptRefs?: string[];
}): PageExecutionBrief {
  const requestedObjective = typeof options.objective === "string" ? options.objective.normalize("NFKC").trim() : "";
  const requestedEffect = ["read", "reversible-write", "irreversible-write"].includes(String(options.effect || ""))
    ? String(options.effect) as ExecutionRequirement["effect"]
    : undefined;
  // Only a code-owned "required" decision can grant write authority. For an
  // uncertain/not-required request, operate_page remains a read-only escape hatch.
  const effect = options.requirement.kind === "required" ? options.requirement.effect : "read";
  const suppliedEntities = options.entities && typeof options.entities === "object" && !Array.isArray(options.entities)
    ? options.entities as Record<string, JsonValue>
    : {};
  const suppliedCriteria = Array.isArray(options.completionCriteria)
    ? options.completionCriteria.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const authorityReason = requestedEffect && requestedEffect !== effect
    ? [`Model-proposed effect ${requestedEffect} was narrowed to code-owned effect ${effect}.`]
    : [];
  const inferredTarget = options.requirement.evidence === "business-receipt"
    ? inferExecutionTargetEntity(options.goal)
    : undefined;
  // A model may describe only the first leg of a multi-step request (for
  // example, "search notebook") as its objective. That is useful for
  // read-only navigation, but unsafe for an effectful request because it can
  // make the actor stop before the requested write. Code-owned authority must
  // keep the complete original goal whenever the request can change state.
  const objective = effect === "read"
    ? requestedObjective || options.goal
    : options.goal;
  return {
    objective,
    normalizedGoal: normalizeGoal(options.goal),
    // User/task input is authoritative. The model can contribute extracted
    // facts, but cannot silently replace a value the user supplied.
    // The original goal contributes a code-owned target requirement for
    // effectful product operations. It cannot be replaced by a model's
    // broadened objective or by a search query that happens to contain the
    // requested noun.
    entities: { ...suppliedEntities, ...options.input, ...(inferredTarget ? { goalTarget: inferredTarget } : {}) },
    effect,
    completionCriteria: [...new Set([...suppliedCriteria, ...executionCompletionCriteria(options.goal, options.requirement)])],
    relevantSceneIds: [...new Set(options.relevantSceneIds || [])],
    relevantCapabilityIds: [...new Set(options.relevantCapabilityIds || [])],
    rejectedCapabilityReasons: [...new Set([...(options.rejectedCapabilityReasons || []), ...authorityReason])],
    knowledgeReceiptRefs: [...new Set(options.knowledgeReceiptRefs || [])],
  };
}

const RECONCILIATION_BUDGET: PageExecutionBudget = {
  activeLimitMs: 30_000, modelRequestLimit: 2, activeElapsedMs: 0, modelRequests: 0, noProgressCount: 0,
};
const CONFIRMED_CONTINUATION_BUDGET: PageExecutionBudget = {
  activeLimitMs: 90_000, modelRequestLimit: 5, activeElapsedMs: 0, modelRequests: 0, noProgressCount: 0,
};
type ReconciliationStatus = "completed" | "not-completed" | "unknown";
const PAGE_EXECUTION_UNCERTAIN_CODES = new Set([
  "adaptive_timeout",
  "page_agent_budget_exhausted",
  "agent_incomplete",
  "side_effect_unknown",
  "action_effect_unknown",
  "cancelled",
]);
const COMPILED_CAPABILITY_DRIFT_CODES = new Set([
  "target_not_found",
  "operation_not_found",
  "operation_implementation_not_found",
  "capability_plan_not_found",
  "postcondition_failed",
  "operation_verification_failed",
  "program_verification_failed",
  "scene_not_found",
  "scene_binding_missing",
]);

function isCompiledCapabilityDrift(code: string) {
  return COMPILED_CAPABILITY_DRIFT_CODES.has(code);
}

function pageExecutionUncertain(outcome: TaskEpisode["outcome"]) {
  return outcome.status === "unknown"
    || PAGE_EXECUTION_UNCERTAIN_CODES.has(outcome.code)
    || outcome.code.includes("budget_exhausted")
    || outcome.code.includes("no_progress")
    || outcome.code.includes("side_effect_unknown");
}

function reconciliationStatusFor(result: { output: Record<string, JsonValue>; episode: TaskEpisode }): ReconciliationStatus {
  if (pageExecutionUncertain(result.episode.outcome) || result.episode.outcome.status === "execution-fault") return "unknown";
  const evidenceOutput = result.episode.outcome.evidence.structuredOutput;
  const evidenceStatus = evidenceOutput && typeof evidenceOutput === "object" && !Array.isArray(evidenceOutput)
    ? evidenceOutput.reconciliationStatus
    : undefined;
  const status = result.output.reconciliationStatus || evidenceStatus;
  if (status === "completed") return result.episode.outcome.status === "success" ? status : "unknown";
  return status === "not-completed" ? status : "unknown";
}

const COMPILED_RUNTIME_LIMIT_MS = 180_000;
/** A dropped task older than this was left long ago; a fresh visit owes no explanation. */
const DROPPED_RUN_NOTICE_MS = 60_000;
const COMPILED_RUNTIME_MODEL_REQUEST_LIMIT = 100;

export type CompiledRuntimeWindow = {
  startedAt: string;
  deadlineAt: string;
  activeLimitMs: number;
  modelRequestLimit: number;
  inheritedModelRequests: number;
  noProgressCount: number;
  exhaustedReason?: PageExecutionBudget["exhaustedReason"];
};

type RuntimeModelLedgerSnapshot = {
  requestCount: number;
  pageExecutionRequests: number;
};

function finiteIntegerInRange(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value)) return fallback;
  const numeric = Number(value);
  if (numeric < minimum) return minimum;
  if (numeric > maximum) return maximum;
  return numeric;
}

/**
 * Establish the compiled window exactly once. A restored window is validated
 * and clamped down, never replaced with a fresh 180-second allowance.
 */
export function establishCompiledRuntimeWindow(
  inherited?: PageExecutionBudget,
  restored?: CompiledRuntimeWindow,
  now = Date.now(),
): CompiledRuntimeWindow {
  if (restored) {
    const started = Date.parse(restored.startedAt);
    const requestedDeadline = Date.parse(restored.deadlineAt);
    if (!Number.isFinite(started) || !Number.isFinite(requestedDeadline) || started > now + 5_000 || requestedDeadline <= started) {
      throw new Error("compiled_runtime_checkpoint_invalid");
    }
    if (!Number.isSafeInteger(restored.activeLimitMs) || restored.activeLimitMs < 1 || restored.activeLimitMs > COMPILED_RUNTIME_LIMIT_MS) {
      throw new Error("compiled_runtime_checkpoint_invalid");
    }
    const activeLimitMs = Number(restored.activeLimitMs);
    const deadline = Math.min(requestedDeadline, started + activeLimitMs);
    return {
      startedAt: new Date(started).toISOString(),
      deadlineAt: new Date(deadline).toISOString(),
      activeLimitMs,
      modelRequestLimit: finiteIntegerInRange(restored.modelRequestLimit, COMPILED_RUNTIME_MODEL_REQUEST_LIMIT, 1, COMPILED_RUNTIME_MODEL_REQUEST_LIMIT),
      inheritedModelRequests: finiteIntegerInRange(restored.inheritedModelRequests, 0, 0, COMPILED_RUNTIME_MODEL_REQUEST_LIMIT),
      noProgressCount: finiteIntegerInRange(restored.noProgressCount, 0, 0, Number.MAX_SAFE_INTEGER),
      exhaustedReason: restored.exhaustedReason,
    };
  }

  const activeLimitMs = finiteIntegerInRange(inherited?.activeLimitMs, COMPILED_RUNTIME_LIMIT_MS, 1, COMPILED_RUNTIME_LIMIT_MS);
  const inheritedElapsedMs = finiteIntegerInRange(inherited?.activeElapsedMs, 0, 0, activeLimitMs);
  const modelRequestLimit = finiteIntegerInRange(inherited?.modelRequestLimit, COMPILED_RUNTIME_MODEL_REQUEST_LIMIT, 1, COMPILED_RUNTIME_MODEL_REQUEST_LIMIT);
  const inheritedModelRequests = finiteIntegerInRange(inherited?.modelRequests, 0, 0, COMPILED_RUNTIME_MODEL_REQUEST_LIMIT);
  const started = now - inheritedElapsedMs;
  return {
    startedAt: new Date(started).toISOString(),
    deadlineAt: new Date(started + activeLimitMs).toISOString(),
    activeLimitMs,
    modelRequestLimit,
    inheritedModelRequests,
    noProgressCount: finiteIntegerInRange(inherited?.noProgressCount, 0, 0, Number.MAX_SAFE_INTEGER),
    exhaustedReason: inherited?.exhaustedReason,
  };
}

export function compiledRuntimeRemainingMs(window: CompiledRuntimeWindow, now = Date.now()) {
  const deadline = Date.parse(window.deadlineAt);
  if (!Number.isFinite(deadline)) return 0;
  const remaining = deadline - now;
  return remaining > 0 ? remaining : 0;
}

function compiledRuntimeWindowUntil(window: CompiledRuntimeWindow, deadlineAt: number): CompiledRuntimeWindow {
  const runtimeDeadline = Date.parse(window.deadlineAt);
  const effectiveDeadline = Math.min(
    Number.isFinite(runtimeDeadline) ? runtimeDeadline : deadlineAt,
    deadlineAt,
  );
  const startedAt = Date.parse(window.startedAt);
  return {
    ...window,
    deadlineAt: new Date(effectiveDeadline).toISOString(),
    activeLimitMs: Number.isFinite(startedAt) ? Math.max(1, effectiveDeadline - startedAt) : window.activeLimitMs,
  };
}

function compiledRuntimeDeadlineError() {
  return new Error("page_agent_budget_exhausted:active-time");
}

/** Bounds an arbitrary await, including non-abortable dynamic import. */
export async function withinCompiledRuntimeDeadline<T>(
  window: CompiledRuntimeWindow,
  task: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (window.exhaustedReason) throw new Error(`page_agent_budget_exhausted:${window.exhaustedReason}`);
  const remainingMs = compiledRuntimeRemainingMs(window);
  if (remainingMs <= 0) throw compiledRuntimeDeadlineError();
  if (externalSignal?.aborted) throw signalAbortReason(externalSignal);

  const controller = new AbortController();
  const deadlineError = compiledRuntimeDeadlineError();
  let rejectExternalAbort: ((reason: unknown) => void) | undefined;
  const externalAbort = new Promise<never>((_resolve, reject) => { rejectExternalAbort = reject; });
  const forwardAbort = () => {
    const reason = externalSignal ? signalAbortReason(externalSignal) : new Error("task_cancelled");
    controller.abort(reason);
    rejectExternalAbort?.(reason);
  };
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(deadlineError);
      reject(deadlineError);
    }, remainingMs);
  });
  try {
    const result = await Promise.race([task(controller.signal), timeout, externalAbort]);
    if (compiledRuntimeRemainingMs(window) <= 0) throw deadlineError;
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

export function compiledRuntimeBudgetEvidence(
  window: CompiledRuntimeWindow,
  ledger: RuntimeModelLedgerSnapshot,
  now = Date.now(),
): PageExecutionBudget {
  if (!Number.isSafeInteger(ledger.requestCount) || ledger.requestCount < 0 || ledger.requestCount > COMPILED_RUNTIME_MODEL_REQUEST_LIMIT) {
    throw new Error("compiled_runtime_budget_ledger_invalid");
  }
  if (!Number.isSafeInteger(ledger.pageExecutionRequests) || ledger.pageExecutionRequests < window.inheritedModelRequests) {
    // Never manufacture monotonicity with Math.max: a regressed server ledger
    // means the repair authority cannot be proven and must fail closed.
    throw new Error("compiled_runtime_budget_ledger_regressed");
  }
  const started = Date.parse(window.startedAt);
  const deadline = Date.parse(window.deadlineAt);
  if (!Number.isFinite(started) || !Number.isFinite(deadline) || deadline < started) throw new Error("compiled_runtime_checkpoint_invalid");
  if (!Number.isSafeInteger(window.activeLimitMs) || window.activeLimitMs < 1 || window.activeLimitMs > COMPILED_RUNTIME_LIMIT_MS) {
    throw new Error("compiled_runtime_checkpoint_invalid");
  }
  const activeLimitMs = Math.min(window.activeLimitMs, deadline - started);
  const rawElapsed = now - started;
  const activeElapsedMs = rawElapsed <= 0 ? 0 : Math.min(activeLimitMs, rawElapsed);
  const exhaustedReason = window.exhaustedReason
    || (activeElapsedMs >= activeLimitMs ? "active-time" : undefined)
    || (ledger.pageExecutionRequests > window.modelRequestLimit ? "model-requests" : undefined);
  return {
    activeLimitMs,
    modelRequestLimit: window.modelRequestLimit,
    activeElapsedMs,
    modelRequests: ledger.pageExecutionRequests,
    noProgressCount: window.noProgressCount,
    exhaustedReason,
  };
}

type PendingObservation = {
  snapshot: ReturnType<typeof capturePageSnapshot>;
  startedAt: string;
  evidence: ReturnType<typeof evidenceFromElement>;
  input?: JsonValue;
};

type StoredDemonstration = {
  goal: string;
  session: TaskSession;
  startedAt: string;
  start: ReturnType<typeof capturePageSnapshot>;
  steps: PageProgramStep[];
  targets: ReturnType<typeof targetFromEvidence>[];
};

const trustedTaskLaunchCalls = new WeakMap<object, (
  capabilityId: string,
  input: Record<string, JsonValue>,
  executionPin: TaskLaunchExecutionPin,
) => Promise<TaskResult | undefined>>();

export function callFromClaimedTaskLaunch(
  port: AgentPort,
  capabilityId: string,
  input: Record<string, JsonValue> = {},
  executionPin: TaskLaunchExecutionPin,
) {
  const call = trustedTaskLaunchCalls.get(port);
  if (!call) throw new Error("task_launch_port_invalid");
  return call(capabilityId, input, executionPin);
}

export class AgentPort {
  readonly options: Required<Pick<PortOptions, "siteAgentId" | "endpoint" | "adaptiveUrl" | "maxSteps" | "visibility" | "runtimeMode" | "domReplay" | "allowedCapabilityIds">> & Pick<PortOptions, "rehearsal" | "onStatus" | "onAskUser" | "handoffToken" | "executionReleaseId" | "executionReleaseVersion" | "executionRevisionId">;
  release: SiteAgentReleaseV2;
  private readyPromise: Promise<SiteAgentReleaseV2>;
  private adaptivePromise?: Promise<AdaptiveGlobal>;
  private activeSession?: TaskSession;
  private activeRun?: AgentRun;
  private runPointer?: RunPointer;
  private runSync: Promise<void> = Promise.resolve();
  private activeAbort?: AbortController;
  /**
   * Which task generation each session belongs to. A stopped task keeps running
   * until its current network call returns; `this.activeAbort` may by then be
   * the next task's controller, so the stale task must recognise itself by its
   * own session instead of by the shared controller.
   */
  private taskGenerations = new Map<string, number>();
  private cancelledSessionIds = new Set<string>();
  private demonstration?: { goal: string; session: TaskSession; startedAt: string; start: ReturnType<typeof capturePageSnapshot>; steps: PageProgramStep[]; targets: Map<string, ReturnType<typeof targetFromEvidence>> };
  private observationStart?: PendingObservation;
  private sequence = 0;
  private checkpointSyncTimer?: ReturnType<typeof setTimeout>;
  private pendingServerCheckpoint?: Checkpoint;
  private navigationIntentTimer?: ReturnType<typeof setTimeout>;
  private handoffInFlight = false;
  // Once the handoff endpoint commits the one-shot continuation token, this
  // document is no longer the Run owner. PageAgent can still finish the
  // current click callback while the browser begins unloading, so any late
  // trace/checkpoint from this document must stay local. Otherwise it can
  // overwrite the server's `awaiting-page` state with `running` before the
  // destination document consumes the token.
  private handoffCommitted = false;
  private leaseHeartbeat?: ReturnType<typeof setInterval>;
  private taskInFlight = false;
  private taskGeneration = 0;
  private activityTimeline: AgentRunActivity[] = [];
  /**
   * What this run did to the page, across its attempts.
   *
   * A run that fell short once and carried on is one run: the click that
   * happened before the interruption is part of how the goal was reached. The
   * Episodes stay truthful about themselves — each one records its own
   * actions — and the handover to the capability centre is about the run, so
   * it is assembled here. Judged per Episode, a 173-second success whose
   * second attempt only scrolled was filed as "no action evidence".
   */
  private runPageActions?: { runId: string; actions: ExperienceActionEvidence[] };
  private runtimeTimings: RuntimeTiming[] = [];
  private runtimeReleaseClient = new RuntimeReleaseClient();
  private commandPollTimer?: ReturnType<typeof setTimeout>;
  private remoteCommand?: AgentRunToolCall;
  private remoteNavigationStarted = false;
  private capabilityNavigationStarted = false;
  private capabilityNavigationDeferred = false;
  // The running Stage declares it may navigate: its own clicks and submits go
  // where the site sends them, and the armed continuation resumes the run.
  private capabilityStageNavigates = false;
  // Validation is running an unpublished candidate through this executor.
  private validationRun = false;
  private pendingCapabilityNavigation?: { rawUrl: string; target: string; openedWindow?: Window | null };
  private executionPin?: TaskLaunchExecutionPin;
  private readonly nativeWindowOpen = window.open.bind(window);

  constructor(options: PortOptions) {
    if (!options.siteAgentId.trim()) throw new Error("siteAgentId_required");
    this.options = {
      siteAgentId: options.siteAgentId.trim(), endpoint: options.endpoint || "",
      adaptiveUrl: options.adaptiveUrl || endpointUrl(options.endpoint || "", "/sitewake-adaptive.js"),
      visibility: options.visibility || "production",
      runtimeMode: options.runtimeMode === "read-only" ? "read-only" : "full",
      allowedCapabilityIds: [...new Set((options.allowedCapabilityIds || []).map((value) => value.trim()).filter(Boolean))],
      maxSteps: options.maxSteps || 12, domReplay: options.domReplay === true, rehearsal: options.rehearsal === true,
      onStatus: options.onStatus, onAskUser: options.onAskUser, handoffToken: options.handoffToken,
      executionReleaseId: options.executionReleaseId, executionReleaseVersion: options.executionReleaseVersion, executionRevisionId: options.executionRevisionId,
    };
    this.executionPin = this.executionPinFrom(options);
    this.release = this.cachedRelease();
    trustedTaskLaunchCalls.set(this, (capabilityId, input, executionPin) =>
      this.callCapability(capabilityId, input, true, executionPin));
    this.installObserver();
    this.readyPromise = this.initialize();
  }

  private async measureRuntime<T>(name: string, action: (timing: RuntimeTiming) => Promise<T>): Promise<T> {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const timing: RuntimeTiming = { name: name.slice(0, 80), startedAt, durationMs: 0, status: "ok" };
    try { return await action(timing); }
    catch (error) { timing.status = "error"; throw error; }
    finally {
      // Only stage names and durations: never prompts, tokens, URLs or arguments.
      this.runtimeTimings ||= [];
      timing.durationMs = Math.round(performance.now() - start);
      this.runtimeTimings.push(timing);
      this.runtimeTimings = this.runtimeTimings.slice(-120);
    }
  }

  /**
   * What this visitor is told, in the language they are reading. Resolved per
   * call rather than held: a visitor can change language mid-run, and the next
   * thing the agent says should follow them.
   */
  private get say() { return widgetCopy(resolveWidgetLocale()).run; }

  /**
   * The language answers are written in: this site's own, so a reply reads in the
   * language of the page it is about. The chrome around it still follows the browser,
   * and a visitor who picks a language in the widget overrides both.
   */
  private replyLocale() { return resolveReplyLocale(profileLanguage(this.release.profile || {})); }

  private status(phase: PortStatus["phase"], message: string, detail?: Record<string, unknown>) {
    const activity = detail?.activity as Record<string, unknown> | undefined;
    if (activity && this.activeSession) {
      const entry = this.activityFromStatus(activity, message);
      detail = { ...detail, activity: { ...activity, ...entry } };
      this.activityTimeline = this.activityTimeline.map((item) => {
        const parentCapabilityStillRunning = (item.kind === "capability" || item.kind === "navigation") && entry.kind === "page" && item.capabilityId === entry.capabilityId;
        return item.state === "running" && item.id !== entry.id && !parentCapabilityStillRunning ? { ...item, state: "completed" as const } : item;
      });
      const index = this.activityTimeline.findIndex((item) => item.id === entry.id);
      if (index >= 0) this.activityTimeline[index] = entry;
      else this.activityTimeline = [...this.activityTimeline, entry].slice(-80);
      const checkpoint = this.readCheckpoint();
      if (checkpoint?.sessionId === this.activeSession.id) {
        // Activity animation is presentation state, not a durable program
        // boundary. Persisting the full checkpoint for every PageAgent
        // thinking/executing event produced dozens of serialized D1 writes and
        // made the next navigation wait behind stale UI updates. The next tool
        // receipt, trace checkpoint or atomic handoff carries this latest local
        // timeline to the server.
        this.storeCheckpointLocally({ ...checkpoint, activityTimeline: this.activityTimeline, savedAt: Date.now() });
      }
    }
    if ((phase === "completed" || phase === "error") && this.activityTimeline.some((item) => item.state === "running")) {
      this.activityTimeline = this.activityTimeline.map((item) => item.state === "running" ? { ...item, state: phase === "error" ? "failed" as const : "completed" as const } : item);
    }
    if (this.validationRun && (phase === "completed" || phase === "error")) {
      const taskResult = detail?.taskResult as TaskResult | undefined;
      const record = { status: taskResult?.outcome?.status || (phase === "error" ? "error" : "completed"), code: taskResult?.outcome?.code || "", summary: message, output: taskResult?.output || {}, url: location.href, at: Date.now() };
      try { sessionStorage.setItem(VALIDATION_RESULT_KEY, JSON.stringify(record)); } catch { /* the runner then times out and says so */ }
    }
    this.options.onStatus?.({ phase, message, detail: { ...detail, sessionId: detail?.sessionId || this.activeSession?.id, activityTimeline: this.activityTimeline } });
  }

  private activityFromStatus(activity: Record<string, unknown>, message: string): AgentRunActivity {
    const rawKind = String(activity.kind);
    const kind = rawKind === "agent" ? "result" : rawKind === "capability-search" ? "capability-search" : ["reasoning", "knowledge", "capability", "navigation", "page", "transition", "result", "human"].includes(rawKind)
      ? rawKind as AgentRunActivity["kind"] : "reasoning";
    const state = ["completed", "failed"].includes(String(activity.state)) ? String(activity.state) as "completed" | "failed" : "running";
    const label = String(activity.label || activity.capabilityName || activity.operationName || (kind === "page" ? this.say.operateThisPage : this.say.understandAndChoose));
    const detail = String(activity.summary || activity.message || activity.tool || message || "");
    return {
      id: String(activity.id || `${kind}:${this.activityTimeline.length + 1}`), kind, state, label,
      sessionId: typeof activity.sessionId === "string" ? activity.sessionId : this.activeSession?.id,
      detail: detail === label ? undefined : detail, url: location.href, pageEpoch: this.activeRun?.pageEpoch,
      capabilityId: typeof activity.capabilityId === "string" ? activity.capabilityId : undefined,
      capabilityName: typeof activity.capabilityName === "string" ? activity.capabilityName : undefined,
      operationName: typeof activity.operationName === "string" ? activity.operationName : undefined,
      input: activity.input && typeof activity.input === "object" && !Array.isArray(activity.input) ? activity.input as Record<string, JsonValue> : undefined,
      output: activity.output && typeof activity.output === "object" && !Array.isArray(activity.output) ? activity.output as Record<string, JsonValue> : undefined,
      stepIndex: Number.isFinite(Number(activity.stepIndex)) ? Number(activity.stepIndex) : undefined,
      stepTotal: Number.isFinite(Number(activity.stepTotal)) ? Number(activity.stepTotal) : undefined,
      createdAt: new Date().toISOString(),
    };
  }

  private executionPinFrom(value: {
    releaseId?: string;
    releaseVersion?: number;
    revisionId?: string;
    executionReleaseId?: string;
    executionReleaseVersion?: number;
    executionRevisionId?: string;
  }): TaskLaunchExecutionPin | undefined {
    const releaseId = value.releaseId || value.executionReleaseId;
    const releaseVersion = value.releaseVersion ?? value.executionReleaseVersion;
    const revisionId = value.revisionId || value.executionRevisionId;
    const supplied = Boolean(releaseId || revisionId || releaseVersion !== undefined);
    if (!supplied) return undefined;
    if (!releaseId || !revisionId || !Number.isInteger(releaseVersion) || Number(releaseVersion) < 0) {
      throw new Error("task_launch_execution_pin_incomplete");
    }
    return { releaseId, releaseVersion: Number(releaseVersion), revisionId };
  }

  private runtimeReleaseUrl(releaseId?: string) {
    const query = new URLSearchParams({ runtime: "1", capabilityAdapters: "0" });
    if (releaseId) query.set("releaseId", releaseId);
    return endpointUrl(
      this.options.endpoint,
      `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/release?${query.toString()}`,
    );
  }

  private assertExecutionRelease(release: SiteAgentReleaseV2, pin: TaskLaunchExecutionPin) {
    if (release.id !== pin.releaseId || release.version !== pin.releaseVersion) {
      throw new Error("task_launch_release_mismatch");
    }
  }

  // Storage keys keep their original spelling; see the note in
  // user-agent-client.ts. Renaming them drops in-flight cross-page run state.
  private cacheKey() { return `sitewake:v5:${this.options.siteAgentId}:release`; }
  private checkpointKey() { return `sitewake:v5:${this.options.siteAgentId}:checkpoint`; }
  private runPointerKey() { return `sitewake:v5:${this.options.siteAgentId}:run`; }
  private leaseKey(sessionId: string) { return `sitewake:v5:${this.options.siteAgentId}:lease:${sessionId}`; }
  private observationKey() { return `sitewake:v5:${this.options.siteAgentId}:pending-observation`; }
  private demonstrationKey() { return `sitewake:v5:${this.options.siteAgentId}:demonstration`; }
  private followupClaimKey(sourceTaskId: string, intent: "reconciliation" | "confirmed-continuation") {
    return `sitewake:v5:${this.options.siteAgentId}:followup:${sourceTaskId}:${intent}`;
  }

  private continuationGrantKey(reconciliationTaskId: string) {
    return `sitewake:v5:${this.options.siteAgentId}:continuation-grant:${reconciliationTaskId}`;
  }

  private grantConfirmedContinuation(reconciliationTaskId: string) {
    if (!reconciliationTaskId.trim()) return;
    sessionStorage.setItem(this.continuationGrantKey(reconciliationTaskId), JSON.stringify({
      status: "not-completed",
      createdAt: Date.now(),
    }));
  }

  private consumeConfirmedContinuationGrant(reconciliationTaskId: string) {
    const key = this.continuationGrantKey(reconciliationTaskId);
    let grant: { status?: string; createdAt?: number } | undefined;
    try { grant = JSON.parse(sessionStorage.getItem(key) || "null") || undefined; }
    catch { grant = undefined; }
    sessionStorage.removeItem(key);
    return grant?.status === "not-completed"
      && Number.isFinite(grant.createdAt)
      && Date.now() - Number(grant.createdAt) <= 10 * 60_000;
  }

  private claimExecutionFollowup(sourceTaskId: string, intent: "reconciliation" | "confirmed-continuation") {
    if (!sourceTaskId.trim()) throw new Error("page_execution_followup_source_required");
    if (intent === "confirmed-continuation") this.consumeConfirmedContinuationGrant(sourceTaskId);
    const key = this.followupClaimKey(sourceTaskId, intent);
    if (sessionStorage.getItem(key)) throw new Error("page_execution_followup_already_used");
    // This browser-local marker is only UX debouncing. The source Run bearer
    // and the server-side CAS lineage claim are the actual authority boundary.
    sessionStorage.setItem(key, new Date().toISOString());
  }

  private cachedRelease() {
    try {
      const value = JSON.parse(localStorage.getItem(this.cacheKey()) || "null");
      if (isRelease(value)) return value;
    } catch { /* ignored */ }
    const now = new Date().toISOString();
    return {
      schemaVersion: SITE_AGENT_SCHEMA_VERSION, id: `${this.options.siteAgentId}:release:0`, siteAgentId: this.options.siteAgentId,
      version: 0, createdAt: now, contentHash: "0", profile: { name: this.options.siteAgentId, description: this.say.connectingToSite, vocabulary: {}, suggestedGoals: [] },
      agentConfig: defaultAgentConfig(),
      scenes: [], targets: [], operations: [], capabilities: [], outcomes: [],
      evalSummary: { passed: true, evaluatedEpisodes: 0, successfulEpisodes: 0, failedEpisodes: 0, generatedAt: now }, sourceEpisodeIds: [],
    } satisfies SiteAgentReleaseV2;
  }

  private saveRelease(release: SiteAgentReleaseV2) {
    const checkpointPin = this.executionPinFrom(this.readCheckpoint() || {});
    const pin = this.executionPin || checkpointPin;
    if (pin && (release.id !== pin.releaseId || release.version !== pin.releaseVersion)) return;
    const runtimeRelease = preserveRuntimeReleaseFeatures(this.release, release);
    this.release = runtimeRelease;
    try { localStorage.setItem(this.cacheKey(), JSON.stringify(runtimeRelease)); } catch { /* ignored */ }
  }

  private readRunPointer() {
    if (this.runPointer) return this.runPointer;
    try {
      const pointer = JSON.parse(sessionStorage.getItem(this.runPointerKey()) || "null") as RunPointer | null;
      if (pointer?.runId && pointer.resumeToken && Date.now() - pointer.savedAt < 24 * 60 * 60_000) this.runPointer = pointer;
    } catch { /* ignored */ }
    return this.runPointer;
  }

  private requireAgentRunToken(expectedRunId?: string) {
    const pointer = this.readRunPointer();
    if (!pointer || (expectedRunId && pointer.runId !== expectedRunId)) {
      throw new Error("agent_run_pointer_missing");
    }
    return pointer.resumeToken;
  }

  private capabilityAllowed(capabilityId: string) {
    return this.options.runtimeMode === "full" || this.options.allowedCapabilityIds.includes(capabilityId);
  }

  private assertCapabilityAllowed(capabilityId: string) {
    if (!this.capabilityAllowed(capabilityId)) throw new Error("runtime_read_only_capability_forbidden");
  }

  /** Throws task_cancelled once this session's task has been stopped or superseded. */
  private assertTaskAlive(sessionId: string) {
    const generation = this.taskGenerations.get(sessionId);
    if ((generation !== undefined && generation !== this.taskGeneration) || this.activeAbort?.signal.aborted) throw new Error("task_cancelled");
  }

  private saveRunPointer(pointer?: RunPointer) {
    this.runPointer = pointer;
    try { if (pointer) sessionStorage.setItem(this.runPointerKey(), JSON.stringify(pointer)); else sessionStorage.removeItem(this.runPointerKey()); }
    catch { /* ignored */ }
  }

  private navigationIntentKey() { return `sitewake:v5:${this.options.siteAgentId}:navigation-intent`; }

  /**
   * Remove the local continuation grant. During a compiled Stage the handoff
   * may already have been committed while the authored JavaScript is still
   * returning (a direct `location.assign()` is the common case). In that
   * window the old document must not delete the grant before the destination
   * BrowserPort can consume it. Callers which explicitly cancel/reset a run
   * pass `force=true`.
   */
  private clearNavigationIntent(force = false) {
    if (!force && this.handoffCommitted) return;
    if (this.navigationIntentTimer) clearTimeout(this.navigationIntentTimer);
    this.navigationIntentTimer = undefined;
    this.handoffCommitted = false;
    try { sessionStorage.removeItem(this.navigationIntentKey()); } catch { /* ignored */ }
  }

  private consumeNavigationIntent() {
    try {
      const intent = JSON.parse(sessionStorage.getItem(this.navigationIntentKey()) || "null") as NavigationIntent | null;
      sessionStorage.removeItem(this.navigationIntentKey());
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      // A few embedded/local browsers report a same-origin location assignment
      // as `reload` even though it is the continuation of the armed Stage.
      // The intent itself is the stronger signal: only reject a reload when
      // the document is still on the exact source URL. A user refresh of the
      // destination may therefore finish a handoff that was already committed,
      // but it can never consume an intent for the original page.
      if (!intent || Date.now() - intent.createdAt > 60_000 || intent.sourceDocumentId === documentId()) return undefined;
      if (navigation?.type === "reload" && intent.sourceUrl === location.href) return undefined;
      return intent;
    } catch {
      this.clearNavigationIntent(true);
      return undefined;
    }
  }

  /**
   * A JS button can navigate through a framework router or location assignment
   * without exposing its destination before the click. Persist the Run first
   * and leave a one-shot same-origin continuation grant in sessionStorage.
   * A normal user refresh has no grant and therefore still cancels the task.
   */
  private async armNavigationIntent() {
    const checkpoint = this.readCheckpoint();
    const pointer = this.readRunPointer();
    if (!checkpoint || !pointer || pointer.runId !== checkpoint.sessionId) return;
    const detachable = {
      ...checkpoint,
      phase: "waiting-page-restore" as const,
      savedAt: Date.now(),
    };
    // The checkpoint travels with the same-origin continuation intent and is
    // committed atomically when the new BrowserPort claims the Run. This keeps
    // every ordinary click local and fast while still making a document
    // navigation lossless.
    try { sessionStorage.setItem(this.checkpointKey(), JSON.stringify(detachable)); } catch { /* ignored */ }
    const handoffToken = await this.requestRunHandoff(new URL(location.href), detachable);
    this.handoffCommitted = true;
    const intent: NavigationIntent = {
      runId: pointer.runId,
      handoffToken,
      sourceDocumentId: documentId(),
      sourceUrl: location.href,
      checkpoint: detachable,
      createdAt: Date.now(),
    };
    try { sessionStorage.setItem(this.navigationIntentKey(), JSON.stringify(intent)); } catch { return; }
    if (this.navigationIntentTimer) clearTimeout(this.navigationIntentTimer);
    // If the click only updated the current DOM/SPA, this document remains
    // alive, revokes the pending grant with a normal checkpoint, and continues.
    // A real document navigation destroys the timer and lets the new SDK
    // consume the one-shot token.
    this.navigationIntentTimer = setTimeout(() => {
      this.navigationIntentTimer = undefined;
      // A direct location assignment can return before the old document is
      // unloaded. Keep the grant alive for the destination, but revoke it if
      // this exact document is still alive when the grace period expires.
      const current = this.readCheckpoint();
      if (documentId() === intent.sourceDocumentId) {
        this.clearNavigationIntent(true);
        if (current?.sessionId === pointer.runId
          && (current.phase === "waiting-page-restore" || current.phase === "navigating")) {
          // No document navigation occurred; the one-shot grant is being
          // revoked and this document resumes ownership of the Run.
          this.saveCheckpoint({ ...current, phase: "running", savedAt: Date.now() });
        }
      }
    }, 4_000);
  }

  private taskSessionFromRun(run: AgentRun): TaskSession {
    const status: TaskSession["status"] = run.status === "awaiting-user" ? "awaiting-human"
      : run.status === "completed" ? "completed"
        : run.status === "failed" ? "failed"
          : run.status === "cancelled" ? "cancelled" : "running";
    return {
      id: run.id, siteAgentId: run.scope.siteAgentId, browserSessionId: run.activePort?.browserSessionId || browserSessionId(),
      goal: run.goal, input: run.input,
      conversation: run.conversation.filter((turn) => turn.role !== "tool").map((turn) => ({ role: turn.role as "user" | "assistant" | "system", content: turn.content, at: turn.at })),
      nextStepIndex: run.programCursor?.operationIndex || 0, bindings: run.bindings, status,
      createdAt: run.createdAt, updatedAt: run.updatedAt, expiresAt: run.expiresAt,
    };
  }

  private checkpointForRun(checkpoint: Checkpoint): AgentRunCheckpoint {
    return {
      mode: checkpoint.mode === "validation" ? "compiled" : checkpoint.mode,
      phase: checkpoint.phase || "running",
      capabilityId: checkpoint.capability?.id,
      candidateId: checkpoint.candidate?.id,
      input: checkpoint.input,
      cursor: { operationIndex: checkpoint.operationIndex, programStepIndex: checkpoint.programStepIndex },
      output: checkpoint.output || {},
      // The v3 protocol keeps the complete detachable client execution state.
      // Typed projections above are for server coordination and observability.
      adaptiveState: JSON.parse(JSON.stringify(checkpoint)) as JsonValue,
      toolContext: checkpoint.toolContext ? JSON.parse(JSON.stringify(checkpoint.toolContext)) as JsonValue : undefined,
      activityTimeline: checkpoint.activityTimeline || this.activityTimeline,
      savedAt: new Date(checkpoint.savedAt).toISOString(),
    };
  }

  private checkpointFromRun(run: AgentRun) {
    const value = run.checkpoint?.adaptiveState;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as unknown as Checkpoint;
  }

  private updateRun(run: AgentRun) {
    this.activeRun = run;
    this.activityTimeline = run.activityTimeline || run.checkpoint?.activityTimeline || this.activityTimeline;
    this.activeSession = this.taskSessionFromRun(run);
    const pointer = this.readRunPointer();
    if (pointer?.runId === run.id) this.saveRunPointer({ ...pointer, revision: run.revision, pageEpoch: run.pageEpoch, savedAt: Date.now() });
  }

  private async claimRun(token: string, transferredCheckpoint?: Checkpoint) {
    const separator = token.indexOf(".");
    const runId = separator > 0 ? token.slice(0, separator) : "";
    if (!runId) throw new Error("agent_run_token_invalid");
    const existingPointer = this.readRunPointer();
    const result = await json<{ run: AgentRun; resumeToken: string }>(await fetch(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(runId)}/ports/claim`), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token, origin: location.origin, url: location.href, documentId: documentId(), browserSessionId: browserSessionId(),
        checkpoint: transferredCheckpoint ? this.checkpointForRun(transferredCheckpoint) : undefined,
      }),
    }));
    const resumeToken = result.run.controller === "script" && existingPointer?.runId === runId
      ? existingPointer.resumeToken
      : result.resumeToken || token;
    this.saveRunPointer({ runId, resumeToken, revision: result.run.revision, pageEpoch: result.run.pageEpoch, savedAt: Date.now() });
    this.updateRun(result.run);
    const serverCheckpoint = this.checkpointFromRun(result.run);
    const localCheckpoint = this.readCheckpoint();
    // The browser copy is only a warm cache. Once the service has a checkpoint,
    // it is authoritative even when a stale document wrote a newer local time.
    const checkpoint = serverCheckpoint || (localCheckpoint?.sessionId === runId ? localCheckpoint : null);
    if (checkpoint) sessionStorage.setItem(this.checkpointKey(), JSON.stringify(checkpoint));
    this.adoptEnteredRoutes(checkpoint);
    if (result.run.controller === "script") {
      if (result.run.activeToolCall?.status === "running") await this.completeRemoteCommand(result.run.activeToolCall, this.remotePageOutput());
      this.scheduleRemoteCommandPoll(0);
    }
    return result.run;
  }

  private remotePageOutput(): Record<string, JsonValue> {
    const snapshot = capturePageSnapshot(this.sequence++);
    return {
      url: snapshot.url,
      title: snapshot.title,
      heading: snapshot.heading,
      summary: `${snapshot.title}\n${snapshot.heading}\n${snapshot.visibleText}`.slice(0, 6_000),
      elements: (snapshot.elements || []).slice(0, 80).map((element, index) => ({ index, role: element.role || element.tag, text: element.accessibleName || element.label || element.placeholder || "" })),
    };
  }

  private scheduleRemoteCommandPoll(delay = 250) {
    if (this.commandPollTimer) clearTimeout(this.commandPollTimer);
    this.commandPollTimer = setTimeout(() => void this.pollRemoteCommand(), delay);
  }

  private async pollRemoteCommand() {
    const pointer = this.readRunPointer();
    const port = this.activeRun?.activePort;
    if (!pointer || !port || this.activeRun?.controller !== "script") return;
    try {
      const result = await json<{ run?: AgentRun; command?: AgentRunToolCall }>(await fetch(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(pointer.runId)}/commands?portId=${encodeURIComponent(port.id)}&pageEpoch=${port.pageEpoch}`), {
        cache: "no-store", headers: { authorization: `Bearer ${pointer.resumeToken}` },
      }));
      if (result.run) this.updateRun(result.run);
      if (result.command) await this.executeRemoteCommand(result.command);
    } catch (error) {
      this.status("error", error instanceof Error ? error.message : String(error), { remoteExecutor: true });
      return;
    }
    this.scheduleRemoteCommandPoll();
  }

  private remoteTarget(raw: unknown) {
    const target = String(raw || "").trim();
    if (!target) throw new Error("agent_run_target_required");
    try {
      const css = Array.from(document.querySelectorAll<HTMLElement>(target));
      if (css.length === 1) return css[0];
      if (css.length > 1) throw new Error(`agent_run_target_ambiguous:${target}`);
    } catch (error) {
      if (String(error).includes("target_ambiguous")) throw error;
    }
    const candidates = Array.from(document.querySelectorAll<HTMLElement>("button,a[href],input,textarea,select,[role],[contenteditable=true],[tabindex]"))
      .map((element) => ({ element, names: (() => { const evidence = evidenceFromElement(element); return [evidence.accessibleName, evidence.label, evidence.placeholder, evidence.name].filter(Boolean).map(String); })() }));
    const exact = candidates.filter((candidate) => candidate.names.includes(target));
    const matches = (exact.length ? exact : candidates.filter((candidate) => candidate.names.some((name) => name.includes(target)))).map((candidate) => candidate.element);
    if (matches.length !== 1) throw new Error(matches.length ? `agent_run_target_ambiguous:${target}` : `agent_run_target_not_found:${target}`);
    return matches[0];
  }

  private async completeRemoteCommand(command: AgentRunToolCall, output?: Record<string, JsonValue>, error?: unknown) {
    const pointer = this.readRunPointer();
    const port = this.activeRun?.activePort;
    if (!pointer || !port) throw new Error("agent_run_page_not_connected");
    const result = await json<{ run: AgentRun }>(await fetch(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(pointer.runId)}/commands/${encodeURIComponent(command.id)}`), {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${pointer.resumeToken}` },
      body: JSON.stringify({ portId: port.id, pageEpoch: port.pageEpoch, output, error: error instanceof Error ? error.message : error ? String(error) : undefined }),
    }));
    this.updateRun(result.run);
  }

  private async remoteHandoff(rawUrl: string, target = "_self", openedWindow?: Window | null) {
    const pointer = this.readRunPointer();
    if (!pointer) throw new Error("agent_run_pointer_missing");
    const destination = new URL(rawUrl, location.href);
    assertRuntimeNavigationAllowed(this.options.runtimeMode, destination.href, location.href);
    if (!this.activeRun?.scope.allowedOrigins.includes(destination.origin)) throw new Error("agent_run_origin_rejected");
    const response = await json<{ run: AgentRun; handoffToken: string }>(await fetch(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(pointer.runId)}/handoff`), {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${pointer.resumeToken}` },
      body: JSON.stringify({ expectedRevision: pointer.revision, pageEpoch: pointer.pageEpoch, destinationUrl: destination.toString() }),
    }));
    this.updateRun(response.run);
    this.handoffCommitted = true;
    const nextUrl = this.handoffUrl(destination, response.handoffToken);
    if (openedWindow) openedWindow.location.href = nextUrl;
    else location.assign(nextUrl);
    return target;
  }

  private async executeRemoteCommand(command: AgentRunToolCall) {
    this.remoteCommand = command;
    this.remoteNavigationStarted = false;
    try {
      const input = command.input;
      if (command.name === "observe") await this.completeRemoteCommand(command, this.remotePageOutput());
      else if (command.name === "query") {
        const query = String(input.query || input.target || "");
        const snapshot = capturePageSnapshot(this.sequence++);
        const matches = (snapshot.elements || []).filter((element) => `${element.accessibleName || ""}\n${element.label || ""}\n${element.placeholder || ""}`.includes(query));
        await this.completeRemoteCommand(command, { url: location.href, count: matches.length, matches: matches.slice(0, 40).map((item) => ({ text: item.accessibleName || item.label || item.placeholder || "", role: item.role || item.tag })) });
      } else if (command.name === "wait") {
        const timeoutMs = Math.max(0, Math.min(Number(input.timeoutMs || 1_000), 30_000));
        const selector = String(input.selector || "");
        const text = String(input.text || "");
        if (selector || text) await waitFor(() => Boolean((selector && document.querySelector(selector)) || (text && document.body?.innerText.includes(text))), timeoutMs, selector || text);
        else await new Promise((resolve) => setTimeout(resolve, timeoutMs));
        await this.completeRemoteCommand(command, { url: location.href, ready: true });
      } else if (command.name === "navigate") {
        assertRuntimeNavigationAllowed(this.options.runtimeMode, String(input.url || ""), location.href);
        const openedWindow = input.target === "_blank" ? this.nativeWindowOpen("about:blank", "_blank") : undefined;
        await this.remoteHandoff(String(input.url || ""), String(input.target || "_self"), openedWindow);
        return;
      } else if (command.name === "act") {
        const op = String(input.op || "");
        assertRuntimeActionAllowed(this.options.runtimeMode, op);
        if (op === "scroll") window.scrollBy({ top: Number(input.value || 600), behavior: "instant" });
        else {
          const element = this.remoteTarget(input.target);
          if (op === "click") {
            if (clickTarget(element) || this.remoteNavigationStarted) return;
          } else if (op === "fill" || op === "select") fillTarget(element, String(input.value ?? ""));
          else if (op === "press") element.dispatchEvent(new KeyboardEvent("keydown", { key: String(input.value || "Enter"), bubbles: true }));
          else throw new Error(`agent_run_action_invalid:${op}`);
        }
        await this.completeRemoteCommand(command, { url: location.href, ok: true });
      }
    } catch (error) {
      await this.completeRemoteCommand(command, undefined, error);
    } finally {
      this.remoteCommand = undefined;
    }
  }

  private async restoreRun(token: string, isHandoff: boolean, transferredCheckpoint?: Checkpoint) {
    if (isHandoff) return this.claimRun(token, transferredCheckpoint);
    const pointer = this.readRunPointer();
    if (!pointer) throw new Error("agent_run_pointer_missing");
    const current = await json<{ run: AgentRun }>(await fetch(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(pointer.runId)}`), {
      cache: "no-store", headers: { authorization: `Bearer ${pointer.resumeToken}` },
    }));
    if (["completed", "failed", "cancelled"].includes(current.run.status)) {
      this.updateRun(current.run);
      return current.run;
    }
    return this.claimRun(token, transferredCheckpoint);
  }

  private async cancelInterruptedRun(pointer: RunPointer) {
    try {
      await fetch(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(pointer.runId)}/cancel`), {
        method: "POST", keepalive: true,
        headers: { "content-type": "application/json", authorization: `Bearer ${pointer.resumeToken}` },
        // Cancellation deliberately has no optimistic revision precondition.
        // A pending handoff may change revision between a user's stop/refresh
        // and this request; user intent must still win that race.
        body: JSON.stringify({}),
      });
    } catch { /* The service may be temporarily unreachable; local state was already revoked. */ }
  }

  private pendingTerminalKey() { return `sitewake:v5:${this.options.siteAgentId}:pending-terminal`; }

  private readPendingTerminals(): PendingTerminal[] {
    try {
      return retainablePendingTerminals(JSON.parse(sessionStorage.getItem(this.pendingTerminalKey()) || "[]") as PendingTerminal[]);
    } catch { return []; }
  }

  private writePendingTerminals(entries: PendingTerminal[]) {
    try {
      if (entries.length) sessionStorage.setItem(this.pendingTerminalKey(), JSON.stringify(entries.slice(-8)));
      else sessionStorage.removeItem(this.pendingTerminalKey());
    } catch { /* Storage is unavailable; the server-side sweep remains the backstop. */ }
  }

  private rememberPendingTerminal(entry: PendingTerminal) {
    const others = this.readPendingTerminals().filter((item) => item.runId !== entry.runId);
    this.writePendingTerminals([...others, entry]);
  }

  private forgetPendingTerminal(runId: string) {
    const remaining = this.readPendingTerminals().filter((item) => item.runId !== runId);
    this.writePendingTerminals(remaining);
  }

  private async sendTerminalState(entry: PendingTerminal) {
    const response = await json<{ run: AgentRun }>(await fetch(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(entry.runId)}`), {
      method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${entry.resumeToken}` },
      body: JSON.stringify({
        expectedRevision: entry.revision,
        pageEpoch: entry.pageEpoch,
        status: entry.status,
        outcome: entry.outcome,
        output: entry.output,
        assistantText: entry.assistantText,
        activityTimeline: entry.activityTimeline,
      }),
    }));
    this.forgetPendingTerminal(entry.runId);
    return response.run;
  }

  /**
   * Close out Runs whose terminal PATCH never landed. Without this a failed
   * report left the Run "running" forever: the comment used to promise the next
   * bootstrap would reconcile it, but nothing actually did.
   */
  async flushPendingTerminals() {
    const pending = this.readPendingTerminals();
    if (!pending.length) return;
    for (const entry of pending) {
      // A conflict or an expired token means the Run is no longer ours to
      // close; drop it rather than retrying forever.
      try { await this.sendTerminalState(entry); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (pendingTerminalIsUnrecoverable(message)) this.forgetPendingTerminal(entry.runId);
      }
    }
  }

  private async finishRun(status: "completed" | "failed" | "cancelled", outcome?: OutcomeReceipt, output?: Record<string, JsonValue>, assistantText?: string, expectedRunId?: string) {
    const pointer = this.readRunPointer();
    if (!pointer || (expectedRunId && pointer.runId !== expectedRunId)) return;
    // A debounced checkpoint may still be waiting to start even though every
    // previously-started write in runSync has finished. If it fires after the
    // terminal PATCH it can otherwise publish a stale "running" status and
    // revive the completed Run. Drain in-flight work and discard only the
    // not-yet-started checkpoint before committing the terminal state.
    if (this.checkpointSyncTimer) {
      clearTimeout(this.checkpointSyncTimer);
      this.checkpointSyncTimer = undefined;
    }
    this.pendingServerCheckpoint = undefined;
    await this.settleRunSync();
    const latest = this.readRunPointer();
    if (!latest || (expectedRunId && latest.runId !== expectedRunId)) return;
    if (outcome) outcome = { ...outcome, evidence: { ...outcome.evidence, runtimeTimings: JSON.parse(JSON.stringify(this.runtimeTimings || [])) as JsonValue } };
    const entry: PendingTerminal = {
      runId: latest.runId,
      resumeToken: latest.resumeToken,
      revision: latest.revision,
      pageEpoch: latest.pageEpoch,
      status,
      outcome,
      output,
      assistantText,
      activityTimeline: this.activityTimeline,
      savedAt: Date.now(),
    };
    // Persist before attempting the report. If this page is closed mid-flight
    // the next bootstrap in the same browser session can still close the Run,
    // and the server-side sweep covers the case where it never comes back.
    this.rememberPendingTerminal(entry);
    try {
      const run = await this.sendTerminalState(entry);
      this.updateRun(run);
      this.saveCheckpoint();
    } catch (error) {
      // One in-session retry: a transient network blip should not require a
      // page reload to settle the Run.
      await new Promise((resolve) => setTimeout(resolve, 750));
      try {
        const run = await this.sendTerminalState(entry);
        this.updateRun(run);
        this.saveCheckpoint();
      } catch {
        // The answer is already on screen; leave the record for the next
        // bootstrap and surface nothing to the user.
        throw error;
      }
    }
  }

  private passiveObservationAllowed() {
    if (this.options.runtimeMode !== "read-only") return true;
    if (this.demonstration) return true;
    return Boolean(this.activeSession && ["running", "awaiting-human", "resuming", "validating"].includes(this.activeSession.status));
  }

  // Passive navigation capture. SPA route changes (hash / pushState) are not
  // full page loads, so /connection only fires once on init. Re-capture and
  // report a snapshot on every route change so every page the user visits
  // becomes a Scene — not just the ones reached by a tracked click.
  private setupPassiveNavigationCapture() {
    if (typeof window === "undefined") return;
    let lastReported = location.href;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capture = () => {
      if (location.href === lastReported) return;
      lastReported = location.href;
      if (!this.passiveObservationAllowed()) return;
      const snapshot = capturePageSnapshot(this.sequence++);
      void fetchWithTimeout(endpointUrl(this.options.endpoint, `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/connection`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshot, visibility: this.options.visibility, rehearsal: this.options.rehearsal }) }, 10_000)
        .then((response) => json<{ release: SiteAgentReleaseV2 }>(response))
        .then((result) => { if (isRelease(result.release) && result.release.version >= this.release.version) this.saveRelease(result.release); })
        .catch(() => undefined);
    };
    // Debounce so the SPA renders the new route before we snapshot it.
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(capture, 600); };
    window.addEventListener("hashchange", schedule, { passive: true });
    window.addEventListener("popstate", schedule, { passive: true });
    window.setInterval(schedule, 1500);
  }

  private async initialize() {
    this.status("connecting", this.say.connectingSiteAgent);
    this.setupPassiveNavigationCapture();
    // Settle Runs whose terminal report never landed before this document was
    // unloaded. Fire-and-forget: bootstrap must not wait on reconciliation.
    void this.flushPendingTerminals().catch(() => undefined);
    const bootCheckpoint = this.readCheckpoint();
    const bootExecutionPin = this.executionPin || this.executionPinFrom(bootCheckpoint || {});
    if (bootExecutionPin) this.executionPin = bootExecutionPin;
    const snapshot = capturePageSnapshot(this.sequence++);
    // Release availability is the readiness boundary. Connection discovery and
    // AI semantic review are background knowledge work and must never block the
    // page Agent from becoming usable.
    const connectionPromise = this.options.runtimeMode === "read-only"
      ? Promise.resolve()
      : fetchWithTimeout(endpointUrl(this.options.endpoint, `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/connection`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ snapshot, visibility: this.options.visibility, rehearsal: this.options.rehearsal }) }, 20_000)
        .then(async (response) => {
          // The one refusal a developer can act on from inside the page they
          // are looking at: this address was never registered for the site.
          // Everything else stays silent — a visitor's console is not ours.
          if (response.status === 403) await reportUnregisteredOrigin(response);
          return response;
        })
        .then((response) => json<{ release: SiteAgentReleaseV2 }>(response))
        .then((result) => { if (isRelease(result.release) && result.release.version >= this.release.version) this.saveRelease(result.release); })
        .catch(() => undefined);
    const releasePromise = this.runtimeReleaseClient.read(this.runtimeReleaseUrl(bootExecutionPin?.releaseId), (url, init) => fetchWithTimeout(url, init, 5_000))
      .then((remote) => {
        if (!isRelease(remote.release)) throw new Error("runtime_release_invalid");
        if (bootExecutionPin) this.assertExecutionRelease(remote.release, bootExecutionPin);
        // The server's runtime Release is authoritative even when its version
        // is lower than a browser cache left behind by a database restore or a
        // clean local reset. Keeping that higher-numbered cache paints stale
        // Capability ids; the first invocation then refreshes to the server
        // Release and cannot resolve the card that the user just clicked.
        this.saveRelease(remote.release);
      });
    // The cache makes the widget paint immediately, but executable capability
    // code must never start from that cache. A published Release can replace a
    // concrete example with a parameterized program; executing the older copy
    // first caused one stale navigation followed by a second, correct one once
    // the destination fetched the current Release. Refresh the runtime Release
    // before either accepting a new goal or resuming a Stage. The bounded
    // request still leaves the last-known Release as an offline fallback.
    // A claimed execution pin is different: falling back to any cached/active
    // Release would run a graph that its published Revision never validated.
    await enforceRuntimeReleaseReadiness(
      this.options.runtimeMode,
      Boolean(bootExecutionPin),
      releasePromise,
    );
    // Claim the durable AgentRun before any normal ready state is emitted. A
    // new document is merely a replacement BrowserPort for the same Agent.
    const pointer = this.readRunPointer();
    // Automatic continuation is explicit: only a navigation handoff token may
    // transfer a running task into this document. A normal reload/direct visit
    // is a user interruption, so it clears the local task and cancels its Run.
    // This prevents an old Agent from resuming clicks after the user refreshes.
    const navigationIntent = this.options.handoffToken ? undefined : this.consumeNavigationIntent();
    const handoffRunId = this.options.handoffToken?.split(".", 1)[0] || "";
    // A URL token is transport for a navigation already initiated in this
    // browser, never an invitation to start a task in an unrelated visitor's
    // authenticated page. Same-tab document navigation preserves this pointer
    // in sessionStorage before the handoff URL is assigned.
    const trustedHandoffToken = pointer?.runId === handoffRunId ? this.options.handoffToken || "" : "";
    const intentHandoffToken = navigationIntent && pointer && navigationIntent.runId === pointer.runId
      ? navigationIntent.handoffToken
      : "";
    const continuationToken = trustedHandoffToken || intentHandoffToken;
    let checkpoint = this.readCheckpoint();
    // A task that was mid-step when this document loaded, with nothing to hand
    // it over, is dropped below. Say so: the widget used to come back as
    // "ready" with the request unanswered and no hint that it had stopped.
    const droppedByPageChange = Boolean(!continuationToken && pointer && checkpoint
      && ["running", "navigating", "waiting-page-restore"].includes(checkpoint.phase || "running")
      && Date.now() - checkpoint.savedAt < DROPPED_RUN_NOTICE_MS);
    if (!continuationToken && pointer) {
      this.saveRunPointer();
      this.saveCheckpoint();
      checkpoint = null;
      // A copied tab receives the same sessionStorage snapshot. It may discard
      // that local copy, but it must never cancel the server Run still owned by
      // the source document. Explicit user cancel/reset retains that authority.
    }
    if (continuationToken) {
      try {
        this.status("resuming", this.say.resumedFromPage, { resumed: true, sessionId: pointer?.runId });
        const run = await this.restoreRun(continuationToken, true, navigationIntent?.checkpoint);
        checkpoint = this.readCheckpoint();
        const transitionActivity: AgentRunActivity = {
          id: `transition:${run.pageEpoch}`, kind: "transition", state: "completed", label: this.say.continuedToNewPage,
          detail: document.title, url: location.href, pageEpoch: run.pageEpoch, createdAt: new Date().toISOString(),
        };
        this.activityTimeline = this.activityTimeline.map((item) => item.state === "running" ? { ...item, state: "completed" as const } : item);
        if (!this.activityTimeline.some((item) => item.id === transitionActivity.id)) this.activityTimeline = [...this.activityTimeline, transitionActivity].slice(-80);
        if (checkpoint) this.saveCheckpoint({ ...checkpoint, activityTimeline: this.activityTimeline, savedAt: Date.now() });
        this.status("resuming", this.say.resumedOnNewPage, { resumed: true, sessionId: run.id, run: { ...run, activityTimeline: this.activityTimeline }, conversation: run.conversation, activityTimeline: this.activityTimeline });
        if (checkpoint && ["running", "awaiting-page", "awaiting-user"].includes(run.status)) {
          void this.resumeCheckpoint().catch((error) => this.status("error", error instanceof Error ? error.message : String(error)));
        } else if (run.status === "completed") {
          this.status("completed", run.outcome?.summary || run.conversation.at(-1)?.content || this.say.taskAlreadyDone, { resumed: true, run, conversation: run.conversation });
        }
      } catch (error) {
        this.saveRunPointer();
        this.saveCheckpoint();
        this.status("error", error instanceof Error ? error.message : String(error), { resumeFailed: true });
      }
    }
    const pending = this.readPendingObservation();
    if (pending && pending.snapshot.documentId !== snapshot.documentId) {
      this.persistPendingObservation();
      if (this.passiveObservationAllowed()) void this.submitObservation(pending, snapshot).catch(() => undefined);
    }
    if (!checkpoint && !continuationToken) this.status("ready", this.say.connectedVersion(this.release.version), { profile: this.release.profile, capabilities: this.release.capabilities.length });
    if (droppedByPageChange) this.status("ready", this.say.stoppedByPageChange, { taskInterrupted: true });
    void connectionPromise;
    this.restoreDemonstration();
    if (this.demonstration) this.reportDemonstration(this.say.resumedRecording);
    return this.release;
  }

  ready() { return this.readyPromise; }

  async refresh(releaseId?: string) {
    return this.measureRuntime("release.refresh", async () => {
      const result = await this.runtimeReleaseClient.read(this.runtimeReleaseUrl(releaseId), (url, init) => fetchWithTimeout(url, init, 5_000));
      if (!isRelease(result.release)) throw new Error("runtime_release_invalid");
      const executionPin = releaseId
        ? this.executionPin || this.executionPinFrom(this.readCheckpoint() || {})
        : undefined;
      if (releaseId && (!executionPin || executionPin.releaseId !== releaseId)) {
        throw new Error("task_launch_execution_pin_incomplete");
      }
      if (executionPin) this.assertExecutionRelease(result.release, executionPin);
      this.saveRelease(result.release);
      if (releaseId && this.release.id !== releaseId) throw new Error("task_launch_release_mismatch");
      return result.release;
    });
  }

  getRelease() { return this.release; }
  getCapabilities() { return userInvocableCapabilities(this.release); }
  async getAvailableCapabilitiesV2(limit = 8) {
    await this.ready();
    const boundedLimit = Math.min(20, Math.max(1, Math.floor(limit) || 8));
    const response = await this.capabilityV2Request<{ items?: CapabilityV2Candidate[] }>(`/api/capability-v2/capabilities?siteId=${encodeURIComponent(this.options.siteAgentId)}&limit=${boundedLimit}`);
    return (response.items || []).filter((item) => !item.status || item.status === "Active");
  }
  private missingCapabilityInputs(capability: CapabilityDefinition, input: Record<string, JsonValue>) {
    const required = capability.inputs.required || Object.keys(capability.inputs.properties || {});
    return required.filter((name) => input[name] === undefined || input[name] === "");
  }
  private assertCapabilityInput(capability: CapabilityDefinition, input: Record<string, JsonValue>) {
    const missing = this.missingCapabilityInputs(capability, input);
    if (missing.length) throw new Error(`capability_input_required:${missing.join(",")}`);
  }
  suggestions() {
    const current = recognizeScene(this.release.scenes, capturePageSnapshot(this.sequence++));
    const capabilities = userInvocableCapabilities(this.release)
      .filter((capability) => !current
        || capability.plans.some((plan) =>
          plan.entrySceneIds.includes("*") || plan.entrySceneIds.includes(current.sceneId)));
    return [...new Set([...capabilities.map((item) => item.name), ...profileTaskTemplates(this.release).map((task) => task.name)])];
  }

  private async createSession(
    goal: string,
    input: Record<string, JsonValue>,
    conversation: TaskSession["conversation"] = [],
    followup?: {
      sourceTaskId: string;
      intent: "reconciliation" | "confirmed-continuation";
      sourceToken: string;
    },
  ) {
    return this.measureRuntime("run.create", async () => {
      const response = await json<{ run: AgentRun; resumeToken: string }>(await fetch(endpointUrl(this.options.endpoint, "/api/agent-runs"), {
        method: "POST", headers: {
          "content-type": "application/json",
          ...(followup ? { authorization: `Bearer ${followup.sourceToken}` } : {}),
        }, body: JSON.stringify({
          siteAgentId: this.options.siteAgentId, origin: location.origin, url: location.href, goal, input,
          conversation, documentId: documentId(), browserSessionId: browserSessionId(),
          ...(followup ? { sourceTaskId: followup.sourceTaskId, intent: followup.intent } : {}),
        }),
      }));
      this.saveRunPointer({ runId: response.run.id, resumeToken: response.resumeToken, revision: response.run.revision, pageEpoch: response.run.pageEpoch, savedAt: Date.now() });
      this.updateRun(response.run);
      return this.activeSession!;
    });
  }

  private async session(sessionId: string) {
    const pointer = this.readRunPointer();
    if (pointer?.runId === sessionId) {
      const result = await json<{ run: AgentRun }>(await fetch(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(sessionId)}`), { cache: "no-store", headers: { authorization: `Bearer ${pointer.resumeToken}` } }));
      this.updateRun(result.run);
      return this.activeSession!;
    }
    const legacy = await json<{ session: TaskSession }>(await fetch(endpointUrl(this.options.endpoint, `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/sessions/${encodeURIComponent(sessionId)}`), { cache: "no-store" }));
    this.activeSession = legacy.session;
    return legacy.session;
  }

  private async patchSession(sessionId: string, patch: Partial<TaskSession>) {
    if (this.activeRun?.id === sessionId) {
      this.activeSession = { ...this.taskSessionFromRun(this.activeRun), ...patch, id: sessionId, siteAgentId: this.options.siteAgentId, updatedAt: new Date().toISOString() };
    }
    // Keep only the evidence projection compatible with the existing learning
    // compiler. Runtime ownership and recovery never read this record.
    const result = await json<{ session: TaskSession }>(await fetch(endpointUrl(this.options.endpoint, `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/sessions/${encodeURIComponent(sessionId)}`), {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch), keepalive: true,
    }));
    if (!this.activeRun && this.activeSession?.id === sessionId) this.activeSession = result.session;
    return this.activeSession || result.session;
  }

  /**
   * Remember an address the run entered. Both Agents record one immediately
   * before handing the Run to the destination document, and saveCheckpoint
   * writes the list into every checkpoint it persists, so the next document
   * restores it and keeps building on the same list.
   */
  private recordEnteredRoute(sessionId: string, route: ExperienceRouteEvidence) {
    const previous = this.enteredRoutesFor(sessionId);
    if (previous.some((item) => item.url === route.url)) return;
    this.enteredRoutes = { sessionId, routes: [...previous, route] };
  }

  /**
   * Take over the addresses a previous document entered.
   *
   * The destination document clears the checkpoint as soon as it resumes the
   * main Agent, so reading the list lazily at the end of the run finds nothing
   * — the addresses have to be adopted the moment the checkpoint is restored.
   */
  private adoptEnteredRoutes(checkpoint?: Checkpoint | null) {
    if (!checkpoint?.sessionId || !checkpoint.routes?.length) return;
    if (this.enteredRoutes?.sessionId === checkpoint.sessionId
      && this.enteredRoutes.routes.length >= checkpoint.routes.length) return;
    this.enteredRoutes = { sessionId: checkpoint.sessionId, routes: checkpoint.routes };
  }

  private enteredRoutesFor(sessionId: string) {
    if (this.enteredRoutes?.sessionId === sessionId) return this.enteredRoutes.routes;
    const stored = this.readCheckpoint();
    return stored?.sessionId === sessionId ? stored.routes || [] : [];
  }

  private enteredRoutes?: { sessionId: string; routes: ExperienceRouteEvidence[] };

  private saveCheckpoint(checkpoint?: Checkpoint) {
    if (checkpoint) {
      const executionPin = this.executionPin || this.executionPinFrom(checkpoint);
      // Addresses are run-scoped evidence, not per-save state: every other
      // caller of saveCheckpoint would otherwise erase what the run entered.
      const routes = this.enteredRoutesFor(checkpoint.sessionId);
      checkpoint = {
        ...checkpoint,
        ...(executionPin || {}),
        activityTimeline: checkpoint.activityTimeline || this.activityTimeline,
        ...(routes.length ? { routes } : {}),
      };
    }
    this.storeCheckpointLocally(checkpoint);
    if (!checkpoint) return;
    // The handoff transaction already persisted the waiting-page checkpoint.
    // Ignore a final action/trace callback from the old document; it cannot
    // safely mutate the server-owned Run anymore.
    if (this.handoffCommitted) return;
    // During an atomic handoff the server revision is owned by the handoff
    // transaction. Keep late PageAgent activity local until that transaction
    // finishes, otherwise a status write can invalidate its revision.
    if (this.handoffInFlight) return;
    this.pendingServerCheckpoint = checkpoint;
    const sync = () => {
      const pending = this.pendingServerCheckpoint;
      this.pendingServerCheckpoint = undefined;
      this.checkpointSyncTimer = undefined;
      if (!pending) return;
      this.runSync = this.runSync.then(() => this.syncCheckpoint(pending)).catch((error) => {
        if (String(error).includes("page_superseded")) this.status("ready", this.say.continuedElsewhere, { superseded: true });
      });
    };
    if (checkpoint.phase === "waiting-page-restore" || checkpoint.phase === "navigating") {
      if (this.checkpointSyncTimer) clearTimeout(this.checkpointSyncTimer);
      sync();
    } else {
      if (this.checkpointSyncTimer) clearTimeout(this.checkpointSyncTimer);
      this.checkpointSyncTimer = setTimeout(sync, 180);
    }
  }

  private storeCheckpointLocally(checkpoint?: Checkpoint) {
    try { if (checkpoint) sessionStorage.setItem(this.checkpointKey(), JSON.stringify(checkpoint)); else sessionStorage.removeItem(this.checkpointKey()); } catch { /* ignored */ }
  }

  /**
   * Wait for the queued checkpoint writes, but never indefinitely.
   *
   * Each write is bounded on its own; the chain is bounded again here because
   * several queued writes can still add up, and the navigation handoff blocks
   * on this. A run that stops inside this await never reaches a handoff, so no
   * execution budget can observe it — that is how one production run sat in
   * `running` for thirteen minutes.
   */
  private async settleRunSync(limitMs = CHECKPOINT_SYNC_TIMEOUT_MS * 2) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.runSync.catch(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, limitMs); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async syncCheckpoint(checkpoint: Checkpoint) {
    const pointer = this.readRunPointer();
    if (!pointer || pointer.runId !== checkpoint.sessionId) return;
    const response = await fetchWithTimeout(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(pointer.runId)}/observations`), {
      // This request is awaited before navigation. `keepalive` imposes a
      // browser-wide ~64 KiB body limit and rejects evidence-rich checkpoints
      // before they ever reach the Run API. The explicit handoff that follows
      // is the unload-safe boundary; checkpoint persistence must use a normal
      // fetch so large pages can cross documents reliably.
      //
      // It must still be bounded. This write is chained onto `runSync`, and the
      // navigation handoff awaits that chain — so a stalled request here does
      // not merely lose a checkpoint, it stops the run before any handoff is
      // requested, in a place no execution budget ever looks.
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pointer.resumeToken}` },
      body: JSON.stringify({
        expectedRevision: pointer.revision, pageEpoch: pointer.pageEpoch, checkpoint: this.checkpointForRun(checkpoint),
        bindings: checkpoint.output || {}, conversation: this.activeSession?.conversation,
        status: checkpoint.phase === "awaiting-human" ? "awaiting-user" : checkpoint.phase === "waiting-page-restore" || checkpoint.phase === "navigating" ? "awaiting-page" : "running",
      }),
    }, CHECKPOINT_SYNC_TIMEOUT_MS);
    const payload = await response.json() as { run?: AgentRun; error?: string; message?: string };
    if (!response.ok || !payload.run) throw new Error(payload.message || payload.error || `agent_run_checkpoint_${response.status}`);
    this.updateRun(payload.run);
  }

  private async flushCheckpoint(checkpoint: Checkpoint) {
    if (this.checkpointSyncTimer) { clearTimeout(this.checkpointSyncTimer); this.checkpointSyncTimer = undefined; }
    this.pendingServerCheckpoint = undefined;
    await this.settleRunSync();
    await this.syncCheckpoint(checkpoint);
  }

  private readCheckpoint() {
    try { return JSON.parse(sessionStorage.getItem(this.checkpointKey()) || "null") as Checkpoint | null; } catch { return null; }
  }

  hasRestorableTask() {
    const checkpoint = this.readCheckpoint();
    return Boolean(checkpoint && Date.now() - checkpoint.savedAt < 10 * 60 * 1000);
  }

  ownsRestorableTask() {
    const checkpoint = this.readCheckpoint();
    if (!checkpoint) return false;
    try {
      const lease = JSON.parse(
        localStorage.getItem(this.leaseKey(checkpoint.sessionId)) || "null",
      ) as { owner?: string; expiresAt?: number } | null;
      return lease?.owner === documentId()
        && Number(lease.expiresAt || 0) > Date.now();
    } catch {
      return false;
    }
  }

  private acquireLease(sessionId: string) {
    const key = this.leaseKey(sessionId);
    const owner = documentId();
    try {
      const current = JSON.parse(localStorage.getItem(key) || "null") as { owner?: string; expiresAt?: number } | null;
      const serverClaimOwnsDocument = this.activeRun?.id === sessionId
        && this.activeRun.activePort?.documentId === owner
        && this.activeRun.activePort.pageEpoch === this.activeRun.pageEpoch;
      // Only a successful server-side one-shot claim can move ownership to a
      // new document. A copied waiting-page checkpoint is not authority.
      if (current?.owner && current.owner !== owner
        && Number(current.expiresAt || 0) > Date.now()
        && !serverClaimOwnsDocument) return false;
      localStorage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + 45_000 }));
      if (this.leaseHeartbeat) clearInterval(this.leaseHeartbeat);
      this.leaseHeartbeat = setInterval(() => {
        try {
          const lease = JSON.parse(localStorage.getItem(key) || "null") as { owner?: string } | null;
          if (lease?.owner !== owner) { if (this.leaseHeartbeat) clearInterval(this.leaseHeartbeat); this.leaseHeartbeat = undefined; return; }
          localStorage.setItem(key, JSON.stringify({ owner, expiresAt: Date.now() + 45_000 }));
        } catch { /* The in-memory task can continue if storage is temporarily unavailable. */ }
      }, 15_000);
      return true;
    } catch {
      // Without a cross-document lease, executing a write capability is less
      // safe than stopping. Fail closed so a duplicated tab cannot run twice.
      return false;
    }
  }

  private releaseLease(sessionId?: string) {
    if (this.leaseHeartbeat) { clearInterval(this.leaseHeartbeat); this.leaseHeartbeat = undefined; }
    if (!sessionId) return;
    try {
      const key = this.leaseKey(sessionId);
      const current = JSON.parse(localStorage.getItem(key) || "null") as { owner?: string } | null;
      if (!current?.owner || current.owner === documentId()) localStorage.removeItem(key);
    } catch { /* ignored */ }
  }

  private persistPendingObservation(pending?: PendingObservation) {
    try { if (pending) sessionStorage.setItem(this.observationKey(), JSON.stringify(pending)); else sessionStorage.removeItem(this.observationKey()); } catch { /* ignored */ }
  }

  private readPendingObservation() {
    try { return JSON.parse(sessionStorage.getItem(this.observationKey()) || "null") as PendingObservation | null; } catch { return null; }
  }

  private saveDemonstration() {
    try {
      if (!this.demonstration) { sessionStorage.removeItem(this.demonstrationKey()); return; }
      const stored: StoredDemonstration = { ...this.demonstration, targets: [...this.demonstration.targets.values()] };
      sessionStorage.setItem(this.demonstrationKey(), JSON.stringify(stored));
    } catch { /* ignored */ }
  }

  private restoreDemonstration() {
    if (this.options.runtimeMode === "read-only") {
      this.demonstration = undefined;
      try { sessionStorage.removeItem(this.demonstrationKey()); } catch { /* ignored */ }
      return;
    }
    try {
      const stored = JSON.parse(sessionStorage.getItem(this.demonstrationKey()) || "null") as StoredDemonstration | null;
      if (!stored || Date.now() - Date.parse(stored.startedAt) > 24 * 60 * 60 * 1000) { sessionStorage.removeItem(this.demonstrationKey()); return; }
      this.demonstration = { ...stored, targets: new Map(stored.targets.map((target) => [target.id, target])) };
    } catch { sessionStorage.removeItem(this.demonstrationKey()); }
  }

  private reportDemonstration(lastAction?: string) {
    if (!this.demonstration) return;
    this.status("learning", this.say.demonstrating(this.demonstration.goal), {
      goal: this.demonstration.goal,
      teaching: true,
      stepCount: this.demonstration.steps.length,
      lastAction: lastAction || (this.demonstration.steps.length ? this.say.resumedRecordingProgress : this.say.waitingForYou),
      currentPage: { url: location.href, title: document.title, heading: document.querySelector("h1")?.textContent?.trim() || "" },
      startedAt: this.demonstration.startedAt,
    });
  }

  private async submitObservation(pending: PendingObservation, end: ReturnType<typeof capturePageSnapshot>) {
    const startScene = recognizeScene(this.release.scenes, pending.snapshot);
    const endScene = recognizeScene(this.release.scenes, end);
    const target = targetFromEvidence(pending.evidence, startScene?.sceneId);
    const step: PageProgramStep = pending.input !== undefined
      ? { id: uid("step"), op: "fill", targetId: target.id, value: { source: "literal", value: pending.input }, timeoutMs: 8_000 }
      : { id: uid("step"), op: "click", targetId: target.id, timeoutMs: 8_000 };
    const observation: TransitionObservation = {
      id: uid("transition"), siteAgentId: this.options.siteAgentId, sessionId: browserSessionId(),
      fromScene: startScene, toScene: endScene, fromSnapshot: pending.snapshot, toSnapshot: end,
      steps: [step], elementEvidence: [pending.evidence], inputBindings: pending.input === undefined ? {} : { value: pending.input }, outputBindings: {},
      startedAt: pending.startedAt, endedAt: end.capturedAt,
    };
    const response = await json<{ release?: SiteAgentReleaseV2 }>(await fetch(endpointUrl(this.options.endpoint, `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/observations`), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ observations: [observation] }), keepalive: true,
    }));
    if (response.release && isRelease(response.release)) this.saveRelease(response.release);
  }

  private async resumeCheckpoint() {
    const checkpoint = this.readCheckpoint();
    this.adoptEnteredRoutes(checkpoint);
    if (checkpoint?.runtimeTimings) this.runtimeTimings = checkpoint.runtimeTimings;
    if (!checkpoint || Date.now() - checkpoint.savedAt > 10 * 60 * 1000) { this.saveCheckpoint(); return; }
    const executionPin = this.executionPinFrom(checkpoint);
    if (executionPin) {
      this.executionPin = executionPin;
      await this.refresh(executionPin.releaseId);
    }
    // Retire validation checkpoints written by pre-v2.1 clients. Validation is
    // now runner-only; resuming one here would hijack the user's result page.
    if (checkpoint.mode === "validation" || checkpoint.candidate) {
      this.saveCheckpoint();
      if (executionPin) this.executionPin = undefined;
      this.releaseLease(checkpoint.sessionId);
      void fetch(endpointUrl(this.options.endpoint, `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/sessions/${encodeURIComponent(checkpoint.sessionId)}`), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
        keepalive: true,
      }).catch(() => undefined);
      this.status("ready", this.say.resumedValidationElsewhere, { resumed: true, retiredValidation: true });
      return;
    }
    if (!this.acquireLease(checkpoint.sessionId)) {
      this.status("ready", this.say.continuedElsewhere);
      return;
    }
    // The claimed AgentRun is the runtime authority.  The v2 Session is only
    // retained as asynchronous learning evidence, so fetching it on every
    // navigation made a completed Program feel like a brand-new chat.
    const session = this.activeRun?.id === checkpoint.sessionId
      ? (this.activeSession = this.taskSessionFromRun(this.activeRun))
      : await this.session(checkpoint.sessionId);
    if (!["running", "validating", "resuming"].includes(session.status)) {
      this.saveCheckpoint();
      if (executionPin) this.executionPin = undefined;
      this.releaseLease(session.id);
      // A completed server session means the previous page already finished.
      // Keep the restored conversation open, but never invent a new task.
      if (session.status === "completed") this.status("completed", this.say.earlierTaskDone, { resumed: true, sessionId: session.id });
      return;
    }
    // A direct verified-scene navigation carries its own completion text: arriving
    // on the page IS the fulfilled request. Close the task here without waking the
    // page-reading Agent, so a knowledge-base entry navigates end-to-end on its own.
    if (checkpoint.directAnswer) {
      this.saveCheckpoint();
      const exactScene = this.verifiedSceneForNavigation(session.goal);
      if (exactScene && new URL(buildSceneUrl(exactScene, {}, location.origin)).href === location.href) {
        await this.completeConversation(session, checkpoint.directAnswer);
      } else {
        // Old clients persisted an unconditional success message for any scene.
        // A destination page must not replay that claim for an unrelated goal.
        await this.runMainAgent(session);
      }
      return;
    }
    this.status(checkpoint.mode === "adaptive" || checkpoint.mode === "repair" ? "adaptive" : "executing", checkpoint.phase === "waiting-page-restore" || checkpoint.phase === "navigating" ? this.say.enteredNewPageCarryOn : this.say.pageRestoredCarryOn, { resumed: true, sessionId: session.id });
    if (checkpoint.mainAgent) {
      this.activeAbort = new AbortController();
      this.saveCheckpoint();
      await this.runMainAgent(session, checkpoint.mainAgent);
    }
    else if (checkpoint.v2Runtime) {
      this.activeAbort = new AbortController();
      this.validationRun = checkpoint.validationRun === true;
      await this.executeCapabilityV2JavaScriptRuntime(checkpoint.v2Runtime, session, checkpoint.input, checkpoint.programStepIndex, checkpoint.output || {}, checkpoint.v2StageReceipts || [], checkpoint.v2StageEvidence || [], checkpoint.v2ModuleHash, checkpoint.v2ControlState, checkpoint.compiledRuntimeWindow, checkpoint.v2AgentStep);
    }
    else if (checkpoint.capability) {
      const result = await this.executeCapability(checkpoint.capability, session, checkpoint.input, checkpoint.mode === "adaptive" ? "repair" : checkpoint.mode, checkpoint.operationIndex, checkpoint.programStepIndex, checkpoint.candidate, checkpoint.output, checkpoint.toolContext, checkpoint.directCall, checkpoint.compiledRuntimeWindow);
      if (result && !this.readCheckpoint() && executionPin) this.executionPin = undefined;
      // A learned capability can navigate across full documents while it is
      // being used as one tool of the main Agent. Resume the same Agent task
      // with the tool receipt instead of turning the destination page into a
      // new conversation or completing the task prematurely.
      if (result && checkpoint.toolContext) {
        const resumedPageExecutionBudget = checkpoint.compiledRuntimeWindow
          ? compiledRuntimeBudgetEvidence(
              checkpoint.compiledRuntimeWindow,
              await this.runtimeModelLedger(session.id, checkpoint.compiledRuntimeWindow),
            )
          : checkpoint.toolContext.pageExecutionBudget;
        const receipt = {
          kind: "capability" as const,
          name: checkpoint.capability.name,
          capabilityId: checkpoint.capability.id,
          status: result.success ? "completed" as const : "failed" as const,
          summary: result.text,
          output: result.output,
          observedAt: new Date().toISOString(),
        };
        const adaptiveTrace = {
          ...checkpoint.toolContext.adaptiveTrace,
          budgetEvidence: resumedPageExecutionBudget || checkpoint.toolContext.adaptiveTrace.budgetEvidence,
          toolReceipts: [...(checkpoint.toolContext.adaptiveTrace.toolReceipts || []), receipt],
        };
        this.saveCheckpoint({ sessionId: session.id, mode: checkpoint.toolContext.parentMode, phase: "running", input: session.input, operationIndex: 0, programStepIndex: 0, adaptiveTrace, backgroundCapabilityExperience: checkpoint.toolContext.backgroundCapabilityExperience, pageExecutionBrief: checkpoint.toolContext.pageExecutionBrief, pageExecutionBudget: resumedPageExecutionBudget, sourceCapabilityId: checkpoint.toolContext.sourceCapabilityId, runtimeModeOverride: checkpoint.toolContext.runtimeModeOverride, executionIntent: checkpoint.toolContext.executionIntent, savedAt: Date.now() });
        await this.runAdaptive(session, checkpoint.toolContext.parentMode, 0, adaptiveTrace, checkpoint.toolContext.backgroundCapabilityExperience, checkpoint.toolContext.pageExecutionBrief, resumedPageExecutionBudget, checkpoint.toolContext.sourceCapabilityId, checkpoint.toolContext.runtimeModeOverride, checkpoint.toolContext.executionIntent);
      }
    }
    else if (checkpoint.mode === "repair" || checkpoint.mode === "adaptive") await this.runAdaptive(session, checkpoint.mode, 0, checkpoint.adaptiveTrace, checkpoint.backgroundCapabilityExperience, checkpoint.pageExecutionBrief, checkpoint.pageExecutionBudget, checkpoint.sourceCapabilityId, checkpoint.runtimeModeOverride, checkpoint.executionIntent);
  }

  private operation(id: string, candidate?: KnowledgeCandidate) {
    return candidate?.operations.find((item) => item.id === id) || this.release.operations.find((item) => item.id === id);
  }

  private target(id: string, candidate?: KnowledgeCandidate) {
    const target = candidate?.targets.find((item) => item.id === id) || this.release.targets.find((item) => item.id === id);
    if (!target) throw new Error(`target_not_found:${id}`);
    return target;
  }

  private transformData(op: "map" | "filter" | "sort" | "pick" | "limit", value: JsonValue | undefined, expression?: string): JsonValue {
    const values = Array.isArray(value) ? value : [];
    const field = expression?.replace(/:(asc|desc)$/i, "");
    const at = (item: JsonValue, path?: string): JsonValue | undefined => {
      if (!path) return item;
      let current: JsonValue | undefined = item;
      for (const part of path.split(".")) {
        if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
        current = current[part];
      }
      return current;
    };
    if (op === "map") return values.map((item) => at(item, field) ?? null);
    if (op === "pick") return values.length ? at(values[0], field) ?? null : null;
    if (op === "limit") return values.slice(0, Math.max(0, Number(expression || 1)));
    if (op === "filter") {
      const [path, expected] = (expression || "").split("=");
      return values.filter((item) => expected === undefined ? Boolean(at(item, path)) : String(at(item, path)) === expected);
    }
    const direction = expression?.endsWith(":desc") ? -1 : 1;
    return [...values].sort((left, right) => String(at(left, field) ?? "").localeCompare(String(at(right, field) ?? ""), undefined, { numeric: true }) * direction);
  }

  private outcomeMatches(outcomeId: string) {
    const outcome = this.release.outcomes.find((item) => item.id === outcomeId);
    if (!outcome || !outcome.classifiers.length) return undefined;
    const matched = outcome.classifiers.every((classifier) => {
      if (classifier.kind === "url") return location.href.includes(classifier.value);
      if (classifier.kind === "text") return document.body?.innerText.includes(classifier.value) || false;
      if (classifier.kind === "target") {
        try { resolveTarget(this.target(classifier.value)); return true; } catch { return false; }
      }
      return false;
    });
    return matched ? outcome : undefined;
  }

  private async verifyOperation(operation: OperationDefinition, candidate?: KnowledgeCandidate) {
    if (operation.verification.sceneId) {
      const scenes = candidate ? [...this.release.scenes, ...candidate.scenes] : this.release.scenes;
      await waitFor(() => recognizeScene(scenes, capturePageSnapshot(this.sequence++))?.sceneId === operation.verification.sceneId, 5_000, `scene:${operation.verification.sceneId}`);
    }
    for (const targetId of operation.verification.targetIds || []) resolveTarget(this.target(targetId, candidate));
    const proofRules = operation.implementations[0]?.authored?.proof.verifier.success || [];
    const hasDynamicStructuralProof = proofRules.some((rule) => rule.kind === "input-visible")
      && proofRules.some((rule) => rule.kind === "scene" || rule.kind === "url" || rule.kind === "target");
    for (const text of hasDynamicStructuralProof ? [] : operation.verification.textIncludes || []) {
      if (!document.body?.innerText.includes(text)) throw new Error(`operation_verification_failed:text:${text}`);
    }
  }

  private async verifyAuthoredImplementation(operation: OperationDefinition, input: Record<string, JsonValue>, candidate?: KnowledgeCandidate) {
    const proof = operation.implementations[0]?.authored?.proof;
    if (!proof?.verifier.success.length) return;
    const snapshot = capturePageSnapshot(this.sequence++);
    const scenes = candidate ? [...this.release.scenes, ...candidate.scenes] : this.release.scenes;
    const hasDynamicStructuralProof = proof.verifier.success.some((rule) => rule.kind === "input-visible")
      && proof.verifier.success.some((rule) => rule.kind === "scene" || rule.kind === "url" || rule.kind === "target");
    for (const rule of proof.verifier.success) {
      if (rule.kind === "url" && !location.href.includes(rule.value)) throw new Error(`program_verification_failed:url:${rule.value}`);
      if (rule.kind === "text" && !hasDynamicStructuralProof && !document.body.innerText.includes(rule.value)) throw new Error(`program_verification_failed:text:${rule.value}`);
      if (rule.kind === "target") resolveTarget(this.target(rule.value, candidate));
      if (rule.kind === "scene") {
        const actualSceneId = recognizeScene(scenes, snapshot)?.sceneId;
        const expectedScene = scenes.find((scene) => scene.id === rule.value);
        const expectedMatchesUrl = expectedScene?.urlTemplates.some((template) => Boolean(matchUrlTemplate(template, snapshot.url)));
        const canonicalOperationScene = operation.verification.sceneId || operation.toSceneId;
        const retiredVerifierRecovered = !expectedScene && Boolean(actualSceneId && canonicalOperationScene === actualSceneId);
        if (actualSceneId !== rule.value && !expectedMatchesUrl && !retiredVerifierRecovered) throw new Error(`program_verification_failed:scene:${rule.value}`);
      }
      if (rule.kind === "input-visible") {
        const expected = String(input[rule.inputId || rule.value] ?? "");
        if (!expected || !`${location.href}\n${document.body.innerText}`.includes(expected)) throw new Error(`program_verification_failed:input:${rule.inputId || rule.value}`);
      }
    }
  }

  private handoffUrl(destination: URL, token: string) {
    const originalHash = destination.hash.replace(/^#/, "");
    const handoff = new URLSearchParams({ "sitewake-run": token });
    if (originalHash) handoff.set("sitewake-return-hash", originalHash);
    destination.hash = handoff.toString();
    return destination.toString();
  }

  private sameDocumentDestination(rawUrl: string) {
    return capabilityNavigationKind(location.href, rawUrl) === "same-document";
  }

  private applySameDocumentDestination(rawUrl: string) {
    const destination = new URL(rawUrl, location.href);
    const current = new URL(location.href);
    if (destination.href === current.href) return;
    // Preserve native hashchange/anchor behavior for SPA tabs and in-page
    // anchors; history.pushState alone does not notify those listeners.
    if (destination.hash !== current.hash) location.hash = destination.hash;
    else history.pushState({}, "", destination.href);
  }

  private shouldArmOpaqueNavigation(element: HTMLElement) {
    const control = element.closest("button,input,textarea,select,[role=button],[role=link]") || element;
    if (control instanceof HTMLInputElement) return ["submit", "image"].includes(control.type.toLowerCase());
    if (control instanceof HTMLButtonElement) {
      const declaredType = control.getAttribute("type")?.toLowerCase();
      // A missing type defaults to submit only when the button belongs to a
      // form. Standalone framework buttons are commonly AJAX controls (e.g.
      // quick-view) and must not move the Run into awaiting-page.
      return declaredType === "submit" || (!declaredType && Boolean(control.form));
    }
    return false;
  }

  private async requestRunHandoff(destination: URL, navigating: Checkpoint) {
    if (this.handoffInFlight) throw new Error("agent_run_handoff_in_progress");
    this.handoffInFlight = true;
    try {
      if (this.checkpointSyncTimer) {
        clearTimeout(this.checkpointSyncTimer);
        this.checkpointSyncTimer = undefined;
      }
      this.pendingServerCheckpoint = undefined;
      // A click activity may already have queued a checkpoint. Wait for it
      // before reading the revision used by the atomic handoff.
      await this.settleRunSync();
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = this.readRunPointer();
        if (!current) throw new Error("agent_run_pointer_missing");
        const activePort = this.activeRun?.id === current.runId
          ? this.activeRun.activePort
          : undefined;
        try {
          const response = await json<{ run: AgentRun; handoffToken: string }>(await fetch(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(current.runId)}/handoff`), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${current.resumeToken}`,
            },
            body: JSON.stringify({
              expectedRevision: current.revision,
              pageEpoch: current.pageEpoch,
              portId: activePort?.id,
              documentId: documentId(),
              browserSessionId: browserSessionId(),
              destinationUrl: destination.toString(),
              checkpoint: this.checkpointForRun(navigating),
            }),
          }));
          this.updateRun(response.run);
          return response.handoffToken;
        } catch (error) {
          lastError = error;
          if (!String(error).includes("agent_run_revision_conflict") || attempt) throw error;
          // Reconcile exactly once. Do not turn a cancelled/superseded Run
          // into a retry; only a late activity update is safe to absorb.
          const latestPointer = this.readRunPointer();
          if (!latestPointer) throw error;
          const latest = await json<{ run: AgentRun }>(await fetch(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(latestPointer.runId)}`), {
            cache: "no-store",
            headers: { authorization: `Bearer ${latestPointer.resumeToken}` },
          }));
          if (!["running", "awaiting-page"].includes(latest.run.status)) throw error;
          this.updateRun(latest.run);
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new Error(String(lastError || "agent_run_handoff_failed"));
    } finally {
      this.handoffInFlight = false;
    }
  }

  private async prepareRunHandoff(rawUrl: string) {
    const destination = new URL(rawUrl, location.href);
    const checkpoint = this.readCheckpoint();
    const pointer = this.readRunPointer();
    if (!checkpoint || !pointer || pointer.runId !== checkpoint.sessionId) return destination.toString();
    if (destination.origin !== location.origin) throw new Error("agent_run_origin_rejected");
    const navigating = { ...checkpoint, phase: "waiting-page-restore" as const, savedAt: Date.now() };
    try { sessionStorage.setItem(this.checkpointKey(), JSON.stringify(navigating)); } catch { /* ignored */ }
    // A scripted click is armed before page code runs because a framework may
    // hide the eventual destination behind an event handler. If the same click
    // then exposes a concrete anchor/form URL through our navigation observer,
    // reuse that already-issued one-shot grant. Issuing a second handoff here
    // would revoke the first token and create an avoidable race with document
    // teardown.
    try {
      const intent = JSON.parse(
        sessionStorage.getItem(this.navigationIntentKey()) || "null",
      ) as NavigationIntent | null;
      if (intent
        && intent.runId === pointer.runId
        && intent.sourceDocumentId === documentId()
        && intent.sourceUrl === location.href
        && Date.now() - intent.createdAt <= 10_000) {
        this.clearNavigationIntent();
        return this.handoffUrl(destination, intent.handoffToken);
      }
    } catch {
      this.clearNavigationIntent(true);
    }
    // `/handoff` is an atomic checkpoint + continuation-token write. Do not
    // checkpoint once here and again in `/handoff`: that doubled round trips
    // and allowed the old document to race the destination BrowserPort.
    const handoffToken = await this.requestRunHandoff(destination, navigating);
    this.clearNavigationIntent(true);
    return this.handoffUrl(destination, handoffToken);
  }

  private async navigateWithRun(rawUrl: string, target = "_self", openedWindow?: Window | null) {
    // Hash-only and same-document route changes do not create a new BrowserPort.
    // Never issue a one-shot handoff for them: the current document remains the
    // owner and can continue observing the page normally.
    if (this.sameDocumentDestination(rawUrl)) {
      this.applySameDocumentDestination(rawUrl);
      this.status("executing", this.say.movedWithinPage, { navigating: false });
      return false;
    }
    const nextUrl = await this.measureRuntime("navigation.handoff", () => this.prepareRunHandoff(rawUrl));
    this.handoffCommitted = true;
    this.status("executing", target === "_blank" ? this.say.continuingInNewTab : this.say.enteringNextPage, { navigating: true, run: this.activeRun });
    if (openedWindow) openedWindow.location.href = nextUrl;
    else location.assign(nextUrl);
    return true;
  }

  private compiledAwait<T>(window: CompiledRuntimeWindow, task: (signal: AbortSignal) => Promise<T>) {
    return withinCompiledRuntimeDeadline(window, task, this.activeAbort?.signal);
  }

  private async runtimeModelLedger(sessionId: string, window: CompiledRuntimeWindow): Promise<RuntimeModelLedgerSnapshot> {
    const token = this.requireAgentRunToken(sessionId);
    const timeoutMs = Math.min(5_000, compiledRuntimeRemainingMs(window));
    if (timeoutMs <= 0) throw compiledRuntimeDeadlineError();
    const payload = await this.compiledAwait(window, async (signal) => {
      const response = await fetchWithTimeout(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(sessionId)}`), {
        cache: "no-store",
        headers: { authorization: `Bearer ${token}` },
        signal,
      }, timeoutMs);
      return json<{ run: AgentRun }>(response);
    });
    this.updateRun(payload.run);
    const rawLedger = payload.run.agentState.runtimeModelBudget;
    const ledger = rawLedger && typeof rawLedger === "object" && !Array.isArray(rawLedger)
      ? rawLedger as Record<string, JsonValue>
      : {};
    const requestCount = ledger.requestCount === undefined ? 0 : Number(ledger.requestCount);
    const rawStageCounts = ledger.stageCounts && typeof ledger.stageCounts === "object" && !Array.isArray(ledger.stageCounts)
      ? ledger.stageCounts as Record<string, JsonValue>
      : {};
    const pageAgentRequests = rawStageCounts["runtime-page-agent"] === undefined ? 0 : Number(rawStageCounts["runtime-page-agent"]);
    const boundaryRequests = rawStageCounts["runtime-boundary"] === undefined ? 0 : Number(rawStageCounts["runtime-boundary"]);
    const pageExecutionRequests = pageAgentRequests + boundaryRequests;
    if (!Number.isSafeInteger(requestCount) || requestCount < 0 || requestCount > COMPILED_RUNTIME_MODEL_REQUEST_LIMIT
      || !Number.isSafeInteger(pageAgentRequests) || pageAgentRequests < 0
      || !Number.isSafeInteger(boundaryRequests) || boundaryRequests < 0
      || pageExecutionRequests > requestCount) {
      throw new Error("compiled_runtime_budget_ledger_invalid");
    }
    return { requestCount, pageExecutionRequests };
  }

  private async assertCompiledModelRequestAvailable(sessionId: string, window: CompiledRuntimeWindow) {
    const ledger = await this.runtimeModelLedger(sessionId, window);
    if (ledger.requestCount >= COMPILED_RUNTIME_MODEL_REQUEST_LIMIT
      || ledger.pageExecutionRequests >= window.modelRequestLimit) {
      throw new Error("page_agent_budget_exhausted:model-requests");
    }
    return ledger;
  }

  private async executeModule(operation: OperationDefinition, session: TaskSession, input: Record<string, JsonValue>, checkpointBase: Omit<Checkpoint, "programStepIndex" | "savedAt">, operationIndex: number, startStage = 0) {
    const runtimeWindow = checkpointBase.compiledRuntimeWindow;
    if (!runtimeWindow) throw new Error("compiled_runtime_window_missing");
    if (this.options.runtimeMode === "read-only") throw new Error("runtime_read_only_module_forbidden");
    const implementation = operation.implementations[0];
    if (implementation?.authored?.kind !== "module") throw new Error("program_module_missing");
    const moduleUrl = endpointUrl(this.options.endpoint, implementation.authored.module.moduleUrl);
    const loaded = await this.compiledAwait(runtimeWindow, async () => import(/* webpackIgnore: true */ moduleUrl) as Promise<{ capability?: CapabilityModule }>);
    const capability = loaded.capability;
    if (capability?.version !== 1 || !Array.isArray(capability.stages) || !capability.stages.length) throw new Error("capability_module_invalid");
    const state: Record<string, JsonValue> = { ...(checkpointBase.output || {}) };
    for (let stageIndex = startStage; stageIndex < capability.stages.length; stageIndex += 1) {
      const stage = capability.stages[stageIndex];
      if (!stage?.id || typeof stage.run !== "function") throw new Error(`capability_stage_invalid:${stageIndex}`);
      this.status("executing", `${operation.name} · ${stage.id}`, {
        activity: { id: stage.id, kind: "page", state: "running", sessionId: session.id, capabilityId: checkpointBase.capability?.id, capabilityName: checkpointBase.capability?.name, operationId: operation.id, operationName: operation.name, stepId: stage.id, stepOp: "stage", stepIndex: stageIndex + 1, stepTotal: capability.stages.length },
      });
      // The destination document must always know which stage comes next. The
      // cursor is prepared before arbitrary page JavaScript gets control.
      const pending = { ...checkpointBase, output: state, phase: "waiting-page-restore" as const, operationIndex, programStepIndex: stageIndex + 1, savedAt: Date.now() };
      this.saveCheckpoint(pending);
      await this.compiledAwait(runtimeWindow, () => this.armNavigationIntent());
      this.capabilityNavigationStarted = false;
      const value = await this.compiledAwait(runtimeWindow, (signal) => stage.run({ input, state: { ...state }, signal, deadlineAt: runtimeWindow.deadlineAt } as Parameters<typeof stage.run>[0]) as Promise<Awaited<ReturnType<typeof stage.run>>>);
      if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error(`capability_stage_result_invalid:${stage.id}`);
      if (value?.state) Object.assign(state, value.state);
      // A native location assignment can return before the browser emits its
      // navigation event. Keep the one-shot continuation armed and commit the
      // returned state before giving the next Stage control. If this document
      // is destroyed during the barrier, the destination consumes exactly the
      // pending next-stage cursor. If it survives, this was an in-page Stage.
      this.saveCheckpoint({ ...pending, output: state, savedAt: Date.now() });
      if (this.capabilityNavigationStarted) return "navigating" as const;
      if (!value?.output && stageIndex < capability.stages.length - 1) {
        await this.compiledAwait(runtimeWindow, () => new Promise((resolve) => setTimeout(resolve, 2_500)));
      }
      this.clearNavigationIntent();
      this.saveCheckpoint({ ...checkpointBase, output: state, phase: "running", operationIndex, programStepIndex: stageIndex + 1, savedAt: Date.now() });
      this.status("executing", this.say.stageDone(operation.name, stage.id), {
        activity: { id: stage.id, kind: "page", state: "completed", sessionId: session.id, capabilityId: checkpointBase.capability?.id, capabilityName: checkpointBase.capability?.name, operationId: operation.id, operationName: operation.name, stepId: stage.id, stepOp: "stage", stepIndex: stageIndex + 1, stepTotal: capability.stages.length },
      });
      if (value?.output) return value.output;
    }
    throw new Error("capability_output_missing");
  }

  private async executeProgram(program: PageProgram, operation: OperationDefinition, session: TaskSession, input: Record<string, JsonValue>, mode: Exclude<Checkpoint["mode"], "adaptive">, checkpointBase: Omit<Checkpoint, "programStepIndex" | "savedAt">, startIndex = 0) {
    const runtimeWindow = checkpointBase.compiledRuntimeWindow;
    if (!runtimeWindow) throw new Error("compiled_runtime_window_missing");
    // One state object is deliberately shared by expressions, extractions and
    // checkpoints. This makes an extracted value a real Capability output even
    // when a later step performs a full-document navigation.
    const state: Record<string, JsonValue> = { ...(checkpointBase.output || {}) };
    for (let index = startIndex; index < program.steps.length; index += 1) {
      this.assertTaskAlive(session.id);
      const step = program.steps[index];
      assertRuntimeActionAllowed(this.options.runtimeMode, step.op);
      this.status(mode === "validation" ? "validating" : "executing", `${operation.name} · ${step.op}`, {
        activity: {
          id: step.id, kind: "page", state: "running", sessionId: session.id,
          capabilityId: checkpointBase.capability?.id, capabilityName: checkpointBase.capability?.name,
          operationId: operation.id, operationName: operation.name,
          stepId: step.id, stepOp: step.op, stepIndex: index + 1, stepTotal: program.steps.length,
        },
      });
      if (step.op === "navigate") {
        const scene = this.release.scenes.find((item) => item.id === step.sceneId) || checkpointBase.candidate?.scenes.find((item) => item.id === step.sceneId);
        if (!scene) throw new Error(`scene_not_found:${step.sceneId}`);
        const explicitBindings = Object.fromEntries(Object.entries(step.bindings).map(([key, expression]) => [key, resolveValue(expression, { input, state, step: state })]));
        const requiredParameters = scene.parameters.filter((parameter) => parameter.required);
        const primitiveInputs = Object.entries(input).filter((entry): entry is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof entry[1]));
        // v2 discovery sometimes named a single dynamic path `path1` while the
        // capability contract named the only semantic input `date`/`keyword`.
        // The mapping is unambiguous by arity, so old releases can keep working;
        // newly authored programs still need explicit bindings at Release Gate.
        const bindings = Object.fromEntries(scene.parameters.flatMap((parameter) => {
          const value = explicitBindings[parameter.id]
            ?? input[parameter.id]
            ?? (requiredParameters.length === 1 && primitiveInputs.length === 1 ? primitiveInputs[0][1] : undefined);
          return value === undefined || (typeof value === "object" && value !== null) ? [] : [[parameter.id, value]];
        })) as Record<string, string | number | boolean>;
        const url = buildSceneUrl(scene, bindings, location.origin);
        if (new URL(url).href !== location.href) {
          const navigationCheckpoint = { ...checkpointBase, output: state, phase: "waiting-page-restore" as const, programStepIndex: index + 1, savedAt: Date.now() };
          this.saveCheckpoint(navigationCheckpoint);
          await this.compiledAwait(runtimeWindow, () => this.navigateWithRun(url));
          return "navigating" as const;
        }
      } else if (step.op === "click" || step.op === "fill" || step.op === "type" || step.op === "select" || step.op === "waitForTarget" || step.op === "assertTarget" || step.op === "extract") {
        const targetId = step.targetId;
        const target = this.target(targetId, checkpointBase.candidate);
        if (step.op === "waitForTarget" || step.op === "assertTarget") await this.compiledAwait(runtimeWindow, () => waitFor(() => { try { resolveTarget(target); return true; } catch { return false; } }, step.timeoutMs, target.name));
        else {
          const resolved = resolveTarget(target);
          if (step.op === "click") {
            const opaqueNavigation = this.shouldArmOpaqueNavigation(resolved.element);
            const anchor = resolved.element.closest<HTMLAnchorElement>("a[href]");
            const concreteNavigation = Boolean(anchor && !this.sameDocumentDestination(anchor.href));
            // A concrete link or a native submit can destroy this document
            // immediately. Persist the next instruction as detachable state
            // only for those targets. Ordinary AJAX/button clicks stay in the
            // running phase, so they cannot falsely publish awaiting-page.
            this.saveCheckpoint({
              ...checkpointBase,
              output: state,
              phase: opaqueNavigation || concreteNavigation ? "waiting-page-restore" : "running",
              programStepIndex: index + 1,
              savedAt: Date.now(),
            });
            // Do not arm a handoff for ordinary AJAX/button interactions. A
            // submit control may still trigger a full-document navigation, so
            // retain the opaque fallback only for those native submit controls;
            // anchors use the concrete handoff in clickTarget instead.
            if (opaqueNavigation) {
              await this.compiledAwait(runtimeWindow, () => this.armNavigationIntent());
            }
            if (clickTarget(resolved.element)) return "navigating" as const;
            const transition = step.transition || (index === program.steps.length - 1 && operation.toSceneId
              ? { kind: "spa" as const, expectedSceneIds: [operation.toSceneId], expectedOrigin: location.origin }
              : undefined);
            if (transition) {
              if (transition.expectedOrigin !== location.origin) throw new Error("agent_run_origin_rejected");
              await this.compiledAwait(runtimeWindow, () => waitFor(() => {
                const scene = recognizeScene(this.release.scenes, capturePageSnapshot(this.sequence++));
                return !transition.expectedSceneIds.length || Boolean(scene && transition.expectedSceneIds.includes(scene.sceneId));
              }, step.timeoutMs, `transition:${transition.expectedSceneIds.join(",")}`));
              const boundaryCheckpoint = { ...checkpointBase, output: state, phase: "running" as const, programStepIndex: index + 1, savedAt: Date.now() };
              this.saveCheckpoint(boundaryCheckpoint);
              await this.compiledAwait(runtimeWindow, () => this.flushCheckpoint(boundaryCheckpoint));
            }
          }
          else if (step.op === "fill" || step.op === "type" || step.op === "select") {
            const value = resolveValue(step.value, { input, state, step: state });
            fillTarget(resolved.element, String(value ?? ""));
          } else if (step.op === "extract") {
            const value = step.attribute ? resolved.element.getAttribute(step.attribute) : resolved.element.textContent;
            if (step.schema.type === "number") {
              const parsed = Number(String(value || "").replace(/[^\d.+-]/g, ""));
              if (!Number.isFinite(parsed)) throw new Error(`extract_type_mismatch:${step.saveAs}:number`);
              state[step.saveAs] = parsed;
            } else if (step.schema.type === "boolean") state[step.saveAs] = /^(true|1|yes|是)$/i.test(String(value || "").trim());  // i18n-exempt:解析页面返回的布尔值写法，不是展示文案
            else state[step.saveAs] = value || "";
          }
        }
      } else if (step.op === "press") {
        const element = step.targetId ? resolveTarget(this.target(step.targetId, checkpointBase.candidate)).element : document.activeElement as HTMLElement;
        element?.dispatchEvent(new KeyboardEvent("keydown", { key: step.key, bubbles: true }));
        element?.dispatchEvent(new KeyboardEvent("keyup", { key: step.key, bubbles: true }));
      } else if (step.op === "scroll") {
        const element = step.targetId ? resolveTarget(this.target(step.targetId, checkpointBase.candidate)).element : document.scrollingElement;
        element?.scrollBy?.({ top: (step.direction === "down" ? 1 : -1) * (step.amount || innerHeight * 0.8), behavior: "smooth" });
      } else if (step.op === "waitForScene" || step.op === "assertScene") {
        const scenes = checkpointBase.candidate ? [...this.release.scenes, ...checkpointBase.candidate.scenes] : this.release.scenes;
        await this.compiledAwait(runtimeWindow, () => waitFor(() => recognizeScene(scenes, capturePageSnapshot(this.sequence++))?.sceneId === step.sceneId, step.timeoutMs, step.sceneId));
      } else if (step.op === "waitForCondition") {
        await this.compiledAwait(runtimeWindow, () => waitFor(() => (!step.text || document.body.innerText.includes(step.text)) && (!step.urlPattern || location.href.includes(step.urlPattern)), step.timeoutMs, "condition"));
      } else if (step.op === "assertOutcome") {
        const outcome = this.outcomeMatches(step.outcomeId);
        if (!outcome) throw new Error(`outcome_assertion_failed:${step.outcomeId}`);
        state.__outcomeId = outcome.id;
      } else if (step.op === "map" || step.op === "filter" || step.op === "sort" || step.op === "pick" || step.op === "limit") {
        const value = resolveValue(step.input, { input, state, step: state });
        state[step.saveAs] = this.transformData(step.op, value, step.expression);
      }
      await this.compiledAwait(runtimeWindow, () => new Promise((resolve) => setTimeout(resolve, 100)));
      this.status(mode === "validation" ? "validating" : "executing", this.say.stepDone(operation.name, step.op), {
        activity: {
          id: step.id, kind: "page", state: "completed", sessionId: session.id,
          capabilityId: checkpointBase.capability?.id, capabilityName: checkpointBase.capability?.name,
          operationId: operation.id, operationName: operation.name,
          stepId: step.id, stepOp: step.op, stepIndex: index + 1, stepTotal: program.steps.length,
        },
      });
    }
    return state;
  }

  private async executeCapability(capability: CapabilityDefinition, session: TaskSession, input: Record<string, JsonValue>, mode: "compiled" | "validation" | "repair" = "compiled", operationStart?: number, programStart = 0, candidate?: KnowledgeCandidate, restoredOutput: Record<string, JsonValue> = {}, toolContext?: CapabilityToolContext, directCall = false, restoredRuntimeWindow?: CompiledRuntimeWindow): Promise<TaskResult | undefined> {
    this.assertCapabilityAllowed(capability.id);
    const inheritedBudget = toolContext?.adaptiveTrace.budgetEvidence || toolContext?.pageExecutionBudget;
    const runtimeWindow = establishCompiledRuntimeWindow(inheritedBudget, restoredRuntimeWindow);
    const capabilityActivityId = `capability:${session.id}:${capability.id}`;
    const activityKind = capability.kind === "navigation" ? "navigation" as const : "capability" as const;
    if (!toolContext) {
      this.status(mode === "validation" ? "validating" : "executing", capability.kind === "navigation" ? this.say.usingNavigationTool(capability.name) : this.say.callingCapability(capability.name), {
        activity: { id: capabilityActivityId, kind: activityKind, state: "running", sessionId: session.id, capabilityId: capability.id, capabilityName: capability.name, input },
      });
    }
    const snapshot = capturePageSnapshot(this.sequence++);
    const scenes = candidate ? [...this.release.scenes, ...candidate.scenes] : this.release.scenes;
    const operations = candidate ? [...this.release.operations, ...candidate.operations] : this.release.operations;
    const current = recognizeScene(scenes, snapshot);
    let selection = choosePlan(capability, operations, current?.sceneId);
    if (!selection) throw new Error("capability_plan_not_found");
    const finalStep = selection.plan.steps.at(-1);
    const finalOperation = finalStep ? operations.find((operation) => operation.id === finalStep.operationId) : undefined;
    const requiredValues = Object.values(input).filter((value) => ["string", "number", "boolean"].includes(typeof value)).map(String).filter(Boolean);
    let decodedUrl = snapshot.url;
    try { decodedUrl = decodeURIComponent(snapshot.url); } catch { /* keep the original URL if a site uses malformed escapes */ }
    const pageEvidence = `${decodedUrl}\n${snapshot.heading}\n${snapshot.visibleText}`.normalize("NFKC").toLowerCase();
    const inputsMatch = requiredValues.every((value) => pageEvidence.includes(value.normalize("NFKC").toLowerCase()));
    const finalOutputFields = Object.keys(capability.outputs.properties || {});
    const finalOutputNeedsProgram = finalOutputFields.some((field) => {
      const binding = finalStep ? (selection.plan.outputBindings[field] || { source: "state" as const, path: field }) : undefined;
      // Page identity is already available from the current SceneRef. Every
      // other declared output (a result count, list, price, status, etc.) must
      // still run its extractor even when navigation itself is unnecessary.
      return binding?.source !== "state" || !["__pageUrl", "__pageTitle", "__pageHeading"].includes(binding.path || "");
    });
    if (current && finalOperation?.toSceneId === current.sceneId && inputsMatch && !finalOutputNeedsProgram) {
      // The requested result is already visible. Finishing from the plan suffix
      // is preferable to navigating back to its entry Scene and replaying it.
      selection = { ...selection, startIndex: selection.plan.steps.length, score: 4 };
    }
    const plan = selection.plan;
    const startOperation = operationStart ?? selection.startIndex;
    const firstPlanStep = plan.steps[startOperation];
    const firstOperation = firstPlanStep ? operations.find((operation) => operation.id === firstPlanStep.operationId) : undefined;
    const firstImplementation = firstOperation?.implementations.toSorted((a, b) => (b.successes - b.failures) - (a.successes - a.failures))[0];
    const moduleOwnsNavigation = firstImplementation?.authored?.kind === "module";
    // A staged JS module is the complete executable product and owns its own
    // document boundaries. Pre-navigating to its nominal entry Scene adds an
    // unrequested extra page load (`/search` before `/search?q=许嵩`) and can
    // invalidate the module's verified stage cursor. The legacy DSL still
    // receives direct-entry help when it has an unambiguous binding.
    if (operationStart === undefined && selection.score === 0 && !moduleOwnsNavigation) {
      const entry = scenes.find((scene) => plan.entrySceneIds.includes(scene.id) && scene.directEntry !== "failed");
      if (entry) {
        const bindings = Object.fromEntries(entry.parameters.flatMap((parameter) => {
          // Examples describe authoring evidence; they are never executable
          // defaults.  If a Scene parameter cannot be bound from this task's
          // real input, skip the direct-entry optimization and let the
          // verified Operation/Module perform its own parameterized
          // navigation.  Falling back to a historical example caused a real
          // first hop to `q=周杰伦` before the module correctly used `许嵩`.
          const value = input[parameter.id];
          return value === undefined || (typeof value === "object" && value !== null) ? [] : [[parameter.id, value]];
        }));
        let entryUrl: string | undefined;
        try { entryUrl = buildSceneUrl(entry, bindings, location.origin); }
        catch { /* Missing dynamic data: fall through to the bounded known path. */ }
        if (entryUrl && new URL(entryUrl).href !== location.href) {
          const navigationCheckpoint: Checkpoint = { sessionId: session.id, mode, phase: "waiting-page-restore", capability, candidate, input, output: restoredOutput, operationIndex: startOperation, programStepIndex: 0, toolContext, directCall, compiledRuntimeWindow: runtimeWindow, savedAt: Date.now() };
          this.saveCheckpoint(navigationCheckpoint);
          await this.compiledAwait(runtimeWindow, () => this.navigateWithRun(entryUrl!));
          return undefined;
        }
      }
    }
    const checkpointBase = { sessionId: session.id, mode, capability, candidate, input, output: restoredOutput, operationIndex: startOperation, toolContext, directCall, compiledRuntimeWindow: runtimeWindow } satisfies Omit<Checkpoint, "programStepIndex" | "savedAt">;
    const startedAt = runtimeWindow.startedAt;
    let output: Record<string, JsonValue> = { ...restoredOutput };
    const executedSteps: PageProgramStep[] = [];
    try {
      if (compiledRuntimeRemainingMs(runtimeWindow) <= 0) throw compiledRuntimeDeadlineError();
      for (let operationIndex = startOperation; operationIndex < plan.steps.length; operationIndex += 1) {
        const planStep = plan.steps[operationIndex];
        const operation = this.operation(planStep.operationId, candidate);
        if (!operation) throw new Error(`operation_not_found:${planStep.operationId}`);
        const implementation = operation.implementations.sort((a, b) => (b.successes - b.failures) - (a.successes - a.failures))[0];
        if (!implementation) throw new Error(`operation_implementation_not_found:${operation.id}`);
        const operationInput = { ...input };
        for (const [key, expression] of Object.entries(planStep.bindings)) {
          const value = resolveValue(expression, { input, state: output, step: output });
          if (value !== undefined) operationInput[key] = value;
        }
        const moduleImplementation = implementation.authored?.kind === "module";
        const result = moduleImplementation
          ? await this.compiledAwait(runtimeWindow, () => this.executeModule(operation, session, operationInput, { ...checkpointBase, output, operationIndex }, operationIndex, operationIndex === startOperation ? programStart : 0))
          : await this.compiledAwait(runtimeWindow, () => this.executeProgram(implementation.program, operation, session, operationInput, mode, { ...checkpointBase, output, operationIndex }, operationIndex === startOperation ? programStart : 0));
        if (result === "navigating") return undefined;
        if (!moduleImplementation) {
          executedSteps.push(...implementation.program.steps.slice(operationIndex === startOperation ? programStart : 0));
          await this.compiledAwait(runtimeWindow, () => this.verifyAuthoredImplementation(operation, operationInput, candidate));
          await this.compiledAwait(runtimeWindow, () => this.verifyOperation(operation, candidate));
        }
        output = { ...output, ...result };
      }
      this.saveCheckpoint();
      const end = capturePageSnapshot(this.sequence++);
      const assertedOutcomeId = typeof output.__outcomeId === "string" ? output.__outcomeId : undefined;
      const resultState: Record<string, JsonValue> = {
        ...output,
        __pageUrl: end.url,
        __pageTitle: end.title,
        __pageHeading: end.heading,
      };
      // A Capability returns its declared contract, not every internal scratch
      // variable produced by the program. Built-in page facts make navigation
      // capabilities useful to callers without requiring DOM extraction code.
      const contractedOutput: Record<string, JsonValue> = {};
      for (const field of Object.keys(capability.outputs.properties || {})) {
        const expression = plan.outputBindings[field] || { source: "state" as const, path: field };
        const value = resolveValue(expression, { input, state: resultState, step: resultState });
        if (value !== undefined) contractedOutput[field] = value;
      }
      output = Object.keys(capability.outputs.properties || {}).length ? contractedOutput : output;
      assertCapabilityOutput(capability.outputs, output);
      const assertedOutcome = assertedOutcomeId ? [...capability.outcomes, ...this.release.outcomes].find((item) => item.id === assertedOutcomeId) : undefined;
      delete output.__outcomeId;
      const missingOutputFields = (capability.outputs.required || []).filter(
        (field) => output[field] === undefined,
      );
      const capabilityUse = {
        capabilityId: capability.id,
        fullySatisfied: missingOutputFields.length === 0,
        extraObservation: false,
        missingOutputFields,
        executionMs: Math.max(0, Date.now() - Date.parse(startedAt)),
        output,
        observedAt: new Date().toISOString(),
      };
      let outcome: TaskEpisode["outcome"] = assertedOutcome
        ? { status: assertedOutcome.status, code: assertedOutcome.code, summary: assertedOutcome.description, evaluatedAt: new Date().toISOString(), evidence: { output, source: "verified-outcome-contract", capabilityUse } }
        : { status: "success", code: "verified_program", summary: this.say.completedGoal(session.goal), evaluatedAt: new Date().toISOString(), evidence: { output, source: "program-postconditions", capabilityUse } };
      if (mode === "validation") {
        this.status("validating", this.say.verifyingReplay);
        await this.assertCompiledModelRequestAvailable(session.id, runtimeWindow);
        const decision = await this.compiledAwait(runtimeWindow, (signal) => judgeTaskOutcome({
          endpoint: this.options.endpoint,
          siteAgentId: this.options.siteAgentId,
          agentRunToken: this.requireAgentRunToken(session.id),
          evidence: buildTaskJudgeEvidence({ goal: session.goal, values: input, actorSuccess: true, actorText: outcome.summary, start: snapshot, end, steps: executedSteps }),
          signal,
        }));
        outcome = decision && decision.status !== "needs-more-work" && decision.status !== "unknown" && decision.confidence >= 0.65
          ? { status: decision.status, code: decision.code, summary: decision.summary, evaluatedAt: new Date().toISOString(), evidence: { output, source: "independent-judge", confidence: decision.confidence, judgeEvidence: decision.evidence } }
          : { status: "unknown", code: "validation_insufficient_evidence", summary: decision?.summary || this.say.validationInsufficient, evaluatedAt: new Date().toISOString(), evidence: { output, source: decision ? "independent-judge" : "judge-unavailable", confidence: decision?.confidence || 0 } };
      }
      const episode: TaskEpisode = {
        schemaVersion: SITE_AGENT_SCHEMA_VERSION, id: uid("episode"), siteAgentId: this.options.siteAgentId, taskSessionId: session.id,
        browserSessionId: browserSessionId(), documentId: snapshot.documentId, mode: mode === "validation" ? "validation" : "compiled", goal: session.goal,
        normalizedGoal: normalizeGoal(session.goal), input, startedAt, endedAt: new Date().toISOString(), releaseId: this.release.id,
        capabilityId: capability.id, candidateId: candidate?.id, startSnapshot: snapshot, endSnapshot: end, transitions: [], outcome,
      };
      if (toolContext) {
        this.saveCheckpoint();
        return { success: ["success", "no-result", "business-rejection"].includes(outcome.status), mode: "compiled", text: outcome.summary, output, outcome, session, release: this.release };
      }
      this.status("executing", this.say.capabilityDone(capability.name), {
        activity: { id: capabilityActivityId, kind: activityKind, state: "completed", sessionId: session.id, capabilityId: capability.id, capabilityName: capability.name, input, output },
      });
      return await this.ingestEpisode(episode, output, mode === "validation" ? "validation" : "compiled", directCall);
    } catch (error) {
      const end = capturePageSnapshot(this.sequence++);
      const outcome: TaskEpisode["outcome"] = { status: "execution-fault", code: error instanceof Error ? error.message.split(":")[0] : "runtime_error", summary: error instanceof Error ? error.message : String(error), evaluatedAt: new Date().toISOString(), evidence: { source: "runtime", capabilityUse: { capabilityId: capability.id, fullySatisfied: false, extraObservation: false, missingOutputFields: [], output: {}, observedAt: new Date().toISOString() } } };
      let publishedDrift = this.release.runtimeFeatures?.pageAgentRuntimeV2 === true
        && mode !== "validation"
        && this.release.capabilities.some((item) => item.id === capability.id)
        && isCompiledCapabilityDrift(outcome.code);
      let driftBudget: PageExecutionBudget | undefined;
      if (publishedDrift) {
        try {
          const ledger = await this.runtimeModelLedger(session.id, runtimeWindow);
          driftBudget = compiledRuntimeBudgetEvidence(runtimeWindow, ledger);
        } catch {
          // Repair is authority-bearing. If the server ledger or remaining
          // deadline cannot be proven, do not mint it from client-only state.
          publishedDrift = false;
        }
      }
      const requirement = executionRequirementForGoal(session.goal);
      const driftBrief = publishedDrift
        ? (toolContext?.pageExecutionBrief || pageExecutionBrief({
            goal: session.goal,
            input,
            requirement,
            relevantCapabilityIds: [capability.id],
            rejectedCapabilityReasons: [`Published capability ${capability.id} drifted: ${outcome.code}`],
          }))
        : undefined;
      const episode: TaskEpisode = {
        schemaVersion: SITE_AGENT_SCHEMA_VERSION, id: uid("episode"), siteAgentId: this.options.siteAgentId, taskSessionId: session.id,
        browserSessionId: browserSessionId(), documentId: snapshot.documentId, mode: mode === "validation" ? "validation" : "compiled",
        goal: session.goal, normalizedGoal: normalizeGoal(session.goal), input, startedAt, endedAt: new Date().toISOString(), releaseId: this.release.id,
        capabilityId: capability.id, sourceCapabilityId: publishedDrift ? capability.id : undefined,
        repairKind: publishedDrift ? "compiled-capability-drift" : undefined, pageExecutionBrief: driftBrief,
        candidateId: candidate?.id, startSnapshot: snapshot, endSnapshot: end, transitions: [], outcome,
        ...(publishedDrift ? {
          experience: {
            version: 1,
            actions: [],
            actorSummary: outcome.summary,
            judgeEvidence: [snapshot.url, end.url].filter(Boolean),
            budgetEvidence: driftBudget!,
          },
        } : {}),
      };
      if (toolContext) {
        this.saveCheckpoint();
        return { success: false, mode: "compiled", text: outcome.summary, output: {}, outcome, session, release: this.release };
      }
      this.status("executing", this.say.capabilityFailed(capability.name), {
        activity: { id: capabilityActivityId, kind: activityKind, state: "failed", sessionId: session.id, capabilityId: capability.id, capabilityName: capability.name, input, summary: outcome.summary },
      });
      return await this.ingestEpisode(episode, {}, mode === "validation" ? "validation" : "compiled", directCall);
    }
  }

  private async executeCandidate(candidate: KnowledgeCandidate, session: TaskSession, input: Record<string, JsonValue>, operationStart?: number, programStart = 0) {
    this.status("validating", this.say.verifyingOnRealPage);
    return this.executeCapability(candidate.capability, session, input, "validation", operationStart, programStart, candidate);
  }

  private async ingestEpisode(episode: TaskEpisode, output: Record<string, JsonValue>, mode: TaskResult["mode"], directCall = false, backgroundCapabilityExperience = false): Promise<TaskResult> {
    if (this.cancelledSessionIds.delete(episode.taskSessionId)) {
      const session = this.activeSession || { status: "cancelled" } as TaskSession;
      return { success: false, mode, text: this.say.taskStopped, output, outcome: { status: "execution-fault", code: "cancelled", summary: this.say.taskStopped, evaluatedAt: new Date().toISOString(), evidence: {} }, session, release: this.release };
    }

    // A known capability has already produced a typed browser receipt.  Make
    // the answer visible now; episode ingestion, health aggregation, video
    // processing and any possible enhancement decision are intentionally
    // background work.  Previously all of that ran before the user saw the
    // final answer, which made a one-step navigate feel inexplicably slow.
    const publishedFastPath = mode === "compiled"
      && !(this.release.runtimeFeatures?.pageAgentRuntimeV2 === true && episode.outcome.status === "execution-fault")
      && Boolean(
      episode.capabilityId
      && (directCall || this.release.capabilities.some((item) => item.id === episode.capabilityId)),
    );
    if (publishedFastPath) {
      const session = this.activeSession || this.taskSessionFromRun(this.activeRun || {
        id: episode.taskSessionId, controller: "page-agent", scope: { kind: "site", siteAgentId: this.options.siteAgentId, allowedOrigins: [location.origin], knowledgeNamespaceIds: [this.options.siteAgentId] }, goal: episode.goal, input: episode.input, conversation: [], agentState: {}, activityTimeline: [], bindings: {}, pageEpoch: 0, eventSequence: 0, revision: 0, status: "running", createdAt: episode.startedAt, updatedAt: episode.endedAt, expiresAt: episode.endedAt,
      });
      const success = ["success", "no-result", "business-rejection"].includes(episode.outcome.status);
      const capability = this.release.capabilities.find((item) => item.id === episode.capabilityId);
      const responseText = directCall
        ? (episode.outcome.status === "success" ? this.formatDirectCapabilityResponse(session.goal, capability, output) : episode.outcome.summary)
        : await this.composeTaskResponse(session, episode.outcome, output, mode);
      const finalActivity = {
        id: `result:${session.id}:${this.activeRun?.pageEpoch || 0}`, kind: "result" as const, state: success ? "completed" as const : "failed" as const,
        sessionId: session.id, capabilityId: episode.capabilityId,
        capabilityName: capability?.name,
        label: success ? this.say.taskDone : this.say.taskNotDone, summary: success ? this.say.capabilityReturned : this.say.capabilityUnreliable, outcome: episode.outcome.status,
      };
      this.status(success ? "completed" : "error", responseText, { taskResult: { success, mode, text: responseText, output, outcome: episode.outcome, session, release: this.release }, activity: finalActivity });
      // Keep the run pointer alive until both the terminal Run update and the
      // Episode append have used it. Releasing the lease first removed the
      // pointer, so the background POST always sent an empty/invalid bearer
      // token and a published capability never left a durable Episode.
      let episodeRunToken: string | undefined;
      try { episodeRunToken = this.requireAgentRunToken(episode.taskSessionId); } catch { /* finishRun below will surface the durable failure */ }
      void this.finishRun(success ? "completed" : "failed", episode.outcome, output, responseText, episode.taskSessionId)
        .catch(() => undefined)
        .then(async () => {
          if (!episodeRunToken) return;
          const response = await fetch(endpointUrl(this.options.endpoint, `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/episodes`), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${episodeRunToken}`,
              "idempotency-key": episode.id,
            },
            body: JSON.stringify(episode),
            keepalive: true,
          });
          if (!response.ok) return;
          const recorded = await response.json() as { release?: SiteAgentReleaseV2 };
          if (recorded.release && isRelease(recorded.release)) this.saveRelease(recorded.release);
        })
        .catch(() => undefined)
        .finally(() => this.releaseLease(episode.taskSessionId));
      return { success, mode, text: responseText, output, outcome: episode.outcome, session, release: this.release };
    }
    type EpisodeResponse = { release: SiteAgentReleaseV2; directive: ClientDirective; agentRun?: AgentRun };
    const maxPersistenceAttempts = backgroundCapabilityExperience ? 3 : 1;
    let response: EpisodeResponse | undefined;
    let persistenceError: unknown;
    for (let attempt = 1; attempt <= maxPersistenceAttempts; attempt += 1) {
      let request: Response;
      try {
        request = await fetchWithTimeout(endpointUrl(this.options.endpoint, `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/episodes`), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.requireAgentRunToken(episode.taskSessionId)}`,
            // TaskEpisode ids are stable across retries and the server treats a
            // repeated id as the same append, never as a second experience.
            "idempotency-key": episode.id,
          },
          body: JSON.stringify(episode),
        }, 10_000);
      } catch (error) {
        // Network errors and the hard timeout are retryable only for the V2
        // background PageAgent path. Other ingestion paths retain their
        // existing single-attempt behavior.
        persistenceError = error;
        if (attempt < maxPersistenceAttempts) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 250));
          continue;
        }
        break;
      }
      if (request.ok) {
        try {
          response = await json<EpisodeResponse>(request);
          break;
        } catch (error) {
          // A 2xx response that cannot prove which Episode was accepted is also
          // unsafe to close locally; an idempotent retry can resolve it.
          persistenceError = error;
          if (attempt < maxPersistenceAttempts) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 250));
            continue;
          }
          break;
        }
      }
      const payload = await request.json().catch(() => ({})) as { error?: string; message?: string };
      persistenceError = new Error(payload.message || payload.error || `http_${request.status}`);
      const retryableStatus = request.status === 429 || request.status >= 500;
      if (!retryableStatus || attempt >= maxPersistenceAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
    if (!response) {
      if (!backgroundCapabilityExperience) throw persistenceError instanceof Error ? persistenceError : new Error(String(persistenceError || "episode_persistence_failed"));
      const technicalError = persistenceError instanceof Error ? persistenceError.message : String(persistenceError || "episode_persistence_failed");
      const summary = this.say.resultNotSaved;
      const persistenceOutcome: TaskEpisode["outcome"] = {
        status: "execution-fault",
        code: "episode_persistence_failed",
        summary,
        evaluatedAt: new Date().toISOString(),
        evidence: {
          source: "episode-persistence",
          episodeId: episode.id,
          retryAttempts: maxPersistenceAttempts,
          technicalError,
          originalOutcomeStatus: episode.outcome.status,
          ...(episode.outcome.code ? { originalOutcomeCode: episode.outcome.code } : {}),
        },
      };
      const session = this.activeSession || { id: episode.taskSessionId, status: "running" } as TaskSession;
      const taskResult: TaskResult = { success: false, mode, interaction: "exploration", text: summary, output: {}, outcome: persistenceOutcome, session, release: this.release };
      this.status("error", summary, {
        taskResult,
        persistenceFailure: { episodeId: episode.id, attempts: maxPersistenceAttempts, technicalError },
        activity: { id: `result:${episode.taskSessionId}`, kind: "result", state: "failed", sessionId: episode.taskSessionId, summary, outcome: persistenceOutcome.status },
      });
      // Intentionally do not finish the AgentRun or release its local lease.
      // The latest adaptive checkpoint remains available for explicit recovery.
      return taskResult;
    }
    if (response.agentRun) this.updateRun(response.agentRun);
    if (isRelease(response.release)) this.saveRelease(response.release);
    const reconciliationAuthority = response.agentRun?.agentState.reconciliationEpisodeAuthority;
    if (reconciliationAuthority
      && typeof reconciliationAuthority === "object"
      && !Array.isArray(reconciliationAuthority)
      && reconciliationAuthority.status === "not-completed"
      && reconciliationAuthority.episodeId === episode.id) {
      // This local grant only exposes the button. The server marker above,
      // written after strict Episode/evidence validation, is authoritative.
      this.grantConfirmedContinuation(episode.taskSessionId);
    }
    const directive = response.directive;
    this.activeSession = directive && "session" in directive ? directive.session : this.activeSession;
    if (directive?.type === "validate-candidate") {
      // Compatibility for runner-only validation directives. A normal user
      // page must never receive this after a successful adaptive task.
      throw new Error("validation_requires_isolated_runner");
    }
    if (!backgroundCapabilityExperience && directive?.type === "learning-queued") {
      this.status("learning", this.say.doneHandedToLearning, {
        learningQueued: true,
        jobId: directive.job.id,
      });
    }
    if (!backgroundCapabilityExperience && directive?.type === "learning-unavailable") {
      this.status("completed", this.say.doneWithReason(directive.reason), {
        learningQueued: false,
        jobId: directive.job.id,
      });
    }
    if (directive?.type === "continue-adaptive") {
      const targetedRepair = this.release.runtimeFeatures?.pageAgentRuntimeV2 === true
        && directive.repairKind === "compiled-capability-drift"
        && Boolean(directive.sourceCapabilityId);
      if (this.release.runtimeFeatures?.pageAgentRuntimeV2 !== true || targetedRepair) {
        return this.runAdaptive(
          directive.session,
          // `repair` means one thing: a published capability is being repaired,
          // and it says which one. Carrying on exploring — the second pass of a
          // run that did not get there the first time — is still exploration.
          // Labelling it `repair` is why a 490-second success with two page
          // actions never reached the capability centre: the handover refuses
          // a repair, and there was no capability to repair.
          directive.sourceCapabilityId ? "repair" : "adaptive",
          directive.attempt,
          undefined,
          backgroundCapabilityExperience,
          directive.pageExecutionBrief,
          directive.budgetEvidence,
          directive.sourceCapabilityId,
        );
      }
    }
    let session = this.activeSession || { status: "completed" } as TaskSession;
    const intent = String(episode.outcome.evidence.executionIntent || "");
    const uncertainExecution = this.release.runtimeFeatures?.pageAgentRuntimeV2 === true && pageExecutionUncertain(episode.outcome);
    const terminalOutcome: TaskEpisode["outcome"] = uncertainExecution
      ? {
          ...episode.outcome,
          summary: intent === "reconciliation"
            ? this.say.readOnlyCheckUnknown
            : intent === "confirmed-continuation"
              ? this.say.confirmedStepUnreliable
              : episode.outcome.code === "cancelled"
                ? this.say.stoppedNoRetry
                : this.say.pageExecutionCapped,
          evidence: {
            ...episode.outcome.evidence,
            ...(intent === "reconciliation" ? { reconciliationStatus: "unknown" } : {}),
            ...(!intent && episode.outcome.code !== "cancelled" ? { reconciliationAvailable: true } : {}),
          },
        }
      : episode.outcome;
    const success = terminalOutcome.status === "success" || terminalOutcome.status === "no-result" || terminalOutcome.status === "business-rejection";
    const responseText = await this.composeTaskResponse(session, terminalOutcome, output, mode);
    if (session.id) {
      const conversation = [...(session.conversation || [])];
      const previous = conversation.at(-1);
      if (previous?.role !== "assistant" || previous.content !== responseText) conversation.push({ role: "assistant", content: responseText, at: new Date().toISOString() });
      // Keep the legacy Session projection terminal with the final answer.
      // AgentRun remains the execution authority, but a running projection
      // makes completed browser actions appear active in the management view.
      const sessionStatus: TaskSession["status"] = success ? "completed" : "failed";
      try { session = await this.patchSession(session.id, { conversation, status: sessionStatus }); } catch { /* The local result remains authoritative when persistence is temporarily unavailable. */ }
    }
    const taskResult = { success, mode, text: responseText, output, outcome: terminalOutcome, session, release: this.release };
    const finalActivity = {
      id: `result:${session.id}`, kind: "result", state: success ? "completed" : "failed",
      sessionId: session.id, capabilityId: episode.capabilityId,
      capabilityName: episode.capabilityId ? this.release.capabilities.find((item) => item.id === episode.capabilityId)?.name : undefined,
      label: success ? this.say.taskDone : this.say.taskNotDone,
      summary: success ? this.say.goalDoneFinalReply : this.say.notReliablyDone,
      outcome: terminalOutcome.status,
    };
    // Record the terminal Agent decision before closing the Run so a page
    // restored from the server sees the same final timeline and answer.
    this.status("executing", responseText, { activity: finalActivity });
    try { await this.finishRun(success ? "completed" : "failed", terminalOutcome, output, responseText, episode.taskSessionId); }
    catch { /* The episode remains durable and the next page can reconcile the terminal Run state. */ }
    this.status(success ? "completed" : "error", responseText, {
      taskResult,
      ...(!backgroundCapabilityExperience ? { learningQueued: directive?.type === "learning-queued" } : {}),
      activity: finalActivity,
    });
    this.rememberRunPageActions(episode);
    const executionIntent = String(episode.outcome.evidence.executionIntent || "");
    const serverOwnsExperienceOutbox = this.release.runtimeFeatures?.pageAgentRuntimeV2 === true
      && this.release.runtimeFeatures?.pageAgentEvidenceV2 === true
      && this.release.runtimeFeatures?.capabilityExperienceOutbox === true
      && (episode.outcome.status === "success" || episode.outcome.status === "no-result");
    if (backgroundCapabilityExperience && !serverOwnsExperienceOutbox && !executionIntent) this.submitCapabilityV2Experience(episode, output);
    this.releaseLease(episode.taskSessionId);
    return taskResult;
  }

  private formatDirectCapabilityResponse(goal: string, capability: CapabilityDefinition | undefined, output: Record<string, JsonValue>) {
    const metadataFields = new Set(["pageUrl", "pageTitle", "pageHeading", "sceneId"]);
    const businessResults = Object.entries(output).filter(([key, value]) => !metadataFields.has(key) && value !== undefined);
    if (capability?.resultKind !== "data" && businessResults.length === 0) return this.say.completedGoal(goal);
    if (businessResults.length === 0) return this.say.completedGoalNoData(goal);
    const properties = capability?.outputs.properties || {};
    const lines = businessResults.map(([key, value]) => {
      const label = properties[key]?.description?.trim() || key;
      const serialized = typeof value === "string"
        ? value
        : typeof value === "number" || typeof value === "boolean" || value === null
          ? String(value)
          : JSON.stringify(value);
      const compact = serialized.replace(/\s+/g, " ").trim();
      return `- ${this.say.labelledValue(label, compact.length > 500 ? `${compact.slice(0, 497)}…` : compact)}`;
    });
    return this.say.completedGoalWithData(goal, lines.join("\n"));
  }

  private async composeTaskResponse(session: TaskSession, outcome: OutcomeReceipt, output: Record<string, JsonValue>, mode: TaskResult["mode"]) {
    const fallback = outcome.status === "success"
      ? (Object.keys(output).length ? this.say.completedGoalResultReturned(session.goal) : this.say.completedGoalQuoted(session.goal))
      : outcome.summary;
    // Adaptive tasks already passed through an Actor and an independent Judge;
    // their summary is model-authored. Synthesize only deterministic program
    // results, which previously fell back to the rigid "Done: …" template.
    if (mode === "adaptive" || mode === "repair" || mode === "validation" || mode === "demonstration") return outcome.summary || fallback;
    if (outcome.status === "execution-fault") {
      const messages: Record<string, string> = {
        scene_binding_missing: this.say.outcomeSceneBindingMissing,
        capability_plan_not_found: this.say.outcomeCapabilityPlanNotFound,
        operation_not_found: this.say.outcomeOperationNotFound,
        operation_implementation_not_found: this.say.outcomeOperationImplementationNotFound,
        target_not_found: this.say.outcomeTargetNotFound,
      };
      return messages[outcome.code] || this.say.outcomeTechnicalFault;
    }
    try {
      this.status("executing", this.say.composingFromResults, { activity: { kind: "reasoning", state: "running", sessionId: session.id, label: this.say.organizeFromTools } });
      const response = await fetchWithTimeout(endpointUrl(this.options.endpoint, `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/model/v2/chat/completions`), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.requireAgentRunToken(session.id)}`, "x-sitewake-ai-stage": "runtime-router" },
        body: JSON.stringify({
          messages: [
            { role: "system", content: `你是嵌入网站的任务 Agent。根据已经发生的真实执行结果直接回答用户。先明确完成情况，再用自然语言给出关键结果；可以基于结果建议一个合理下一步，但不得编造页面没有返回的事实。不要提 Selector、训练、候选知识或内部协议。回答简洁，像成熟的通用 Agent，而不是固定模板。${replyLanguageInstruction(this.replyLocale())}` },  // i18n-exempt:给模型看的提示词正文，访客语言由 replyLanguageInstruction 单独告知
            { role: "user", content: JSON.stringify({ goal: session.goal, input: session.input, outcome, output, executionMode: mode, recentConversation: session.conversation.slice(-6) }).slice(0, 10_000) },
          ],
          temperature: 0.2,
        }),
      }, 8_000);
      if (!response.ok) return fallback;
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return payload.choices?.[0]?.message?.content?.trim() || fallback;
    } catch { return fallback; }
  }

  private capabilityToolbox(goal: string) {
    // The model toolbox contains formal public Capability contracts only.
    // NavigationTools are knowledge/dependency assets and must never become
    // recommendations just because a transient legacy adapter can execute.
    const invocable = userInvocableCapabilities(this.release).filter((capability) => this.capabilityAllowed(capability.id));
    const invocableIds = new Set(invocable.map((capability) => capability.id));
    const invocableRelease = { ...this.release, capabilities: invocable };
    const publicTools = rankPublishedCapabilities(invocableRelease, goal, 20)
      .map(({ capability }) => capability)
      .filter((capability) => invocableIds.has(capability.id))
      // NavigationTools/Scenes are knowledge assets. They may be consumed by
      // the code-owned fast path, but a persisted navigation Capability must
      // never be advertised as a business tool to the model.
      .filter((capability) => capability.kind !== "navigation")
      .filter((capability) => !capabilityGoalConflicts(goal, [capability.name, capability.description, capability.goalTemplate || "", ...capability.aliases]));
    const tools = publicTools.slice(0, 20);
    const runtimeSchema = (schema: CapabilityDefinition["inputs"]) => JSON.parse(JSON.stringify(schema, (key, value) => key === "examples" ? undefined : value));
    return tools.map((capability, index) => ({
      capability,
      tool: {
        type: "function",
        function: {
          name: `capability_${index + 1}`,
          description: `${capability.kind === "navigation" ? "导航工具，只承诺到达目标页面，不代表已经获取业务数据。" : "业务能力。"}${capability.name}：${capability.description || capability.goalTemplate}`.slice(0, 500), // i18n-exempt: tool description read by the model, not the reader
          // Examples help the human-facing form, but sending them as tool
          // arguments encourages models to copy an unrelated sample value.
          parameters: runtimeSchema(capability.inputs),
        },
      },
    }));
  }

  private directNavigationCapability(goal: string) {
    if (!isNavigationIntentGoal(goal)) return undefined;
    const invocable = userInvocableCapabilities(this.release);
    const command = normalizeGoal(goal).replace(/^(请|帮我|我要|我想|带我|麻烦)?(打开|查看|看看|看一下|进入|前往|去|跳转到)/, "");  // i18n-exempt:匹配用户目标里的祈使语，不是展示文案
    // “页面 / 功能 / 入口” (page / feature / entry) are presentation words, not a business parameter.
    // Removing them makes “打开词云页面” and “打开词云” the same invocation
    // without adding any website-specific synonym table.
    const key = command.replace(/(页面|页|功能|入口|界面|栏目|模块|列表|展示)$/g, "");  // i18n-exempt:匹配用户目标里的页面后缀，不是展示文案
    if (!key) return undefined;
    const matchingTools = (this.release.navigationTools || []).filter((tool) => {
      if (tool.status !== "verified" || Object.keys(tool.inputs.properties || {}).length || (tool.inputs.required || []).length) return false;
      const targetScene = this.release.scenes.find((scene) => scene.id === tool.targetSceneId);
      // A zero-input observed product URL is not a reusable navigation fact:
      // it points at one concrete entity and must be reached by clicking the
      // matching live card/link. Never let a stale technical adapter turn that
      // URL into a static navigation shortcut.
      if (targetScene && this.sceneRequiresLiveEntityClick(targetScene)) return false;
      return [tool.name, ...tool.aliases].some((phrase) => normalizeGoal(phrase)
        .replace(/^(请|帮我|我要|我想|带我|麻烦)?(打开|查看|看看|看一下|进入|前往|去|跳转到)/, "")  // i18n-exempt:匹配用户目标里的祈使语，不是展示文案
        .replace(/(页面|页|功能|入口|界面|栏目|模块|列表|展示)$/g, "") === key);  // i18n-exempt:匹配用户目标里的页面后缀，不是展示文案
    });
    if (matchingTools.length === 1) {
      const tool = matchingTools[0];
      const strategyOperationIds = new Set(tool.strategies.map((strategy) => strategy.operationId));
      const managed = invocable.filter((capability) =>
        capability.kind === "navigation"
        && !Object.keys(capability.inputs.properties || {}).length
        && !(capability.inputs.required || []).length
        && capability.plans.some((plan) =>
          plan.steps.some((step) => strategyOperationIds.has(step.operationId))));
      if (managed.length === 1) return managed[0];
      // A NavigationTool without a formal public Capability is knowledge, not
      // terminal invocation authority. The main Agent may still use that
      // knowledge to operate the page, but the fast path cannot call it.
      return undefined;
    }
    if (matchingTools.length > 1) return undefined;
    const candidates = invocable.filter((capability) => {
      if (capability.kind !== "navigation" || !["available", "improving"].includes(capability.status)) return false;
      if (Object.keys(capability.inputs.properties || {}).length || (capability.inputs.required || []).length) return false;
      const targetSceneIds = capability.plans.flatMap((plan) => plan.steps.flatMap((step) => {
        const operation = this.release.operations.find((item) => item.id === step.operationId);
        return operation?.toSceneId && operation.toSceneId !== "*" ? [operation.toSceneId] : [];
      }));
      if (targetSceneIds.some((sceneId) => {
        const scene = this.release.scenes.find((item) => item.id === sceneId);
        return Boolean(scene && this.sceneRequiresLiveEntityClick(scene));
      })) return false;
      // Releases are versioned server data.  Older/hand-authored navigation
      // assets can legitimately omit aliases or a goal template, so never let
      // optional presentation fields abort the entire Agent before it has
      // dispatched its first tool.  A malformed candidate is simply ignored.
      const phrases = [capability.name, capability.goalTemplate, ...(Array.isArray(capability.aliases) ? capability.aliases : [])]
        .filter((phrase): phrase is string => typeof phrase === "string" && phrase.trim().length > 0);
      return phrases.some((phrase) => {
        const phraseKey = normalizeGoal(phrase).replace(/^(请|帮我|我要|我想|带我|麻烦)?(打开|查看|看看|看一下|进入|前往|去|跳转到)/, "").replace(/(页面|页|功能|入口|界面|栏目|模块|列表|展示)$/g, "");  // i18n-exempt:匹配用户目标里的祈使语，不是展示文案
        return phraseKey === key;
      });
    });
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  private sceneRequiresLiveEntityClick(scene: SceneDefinition) {
    const material = [
      scene.name,
      scene.description || "",
      scene.businessArea || "",
      ...(scene.evidence?.linkLabels || []),
      ...(scene.evidence?.titles || []),
      ...scene.urlTemplates.map((template) => template.pathnamePattern),
    ].join(" ");
    return /(商品详情|产品详情|特定商品|单个商品|product\s*detail|sku|variant)/i.test(material)  // i18n-exempt:匹配页面材料里的商品词，不是展示文案
      || scene.urlTemplates.some((template) => /(?:^|[/{-])\d*[-/]*[a-z0-9][a-z0-9-]*\.html(?:$|[?#/{])/i.test(template.pathnamePattern));
  }

  /** The compiled tool name carries a fixed Chinese verb; the reader sees the destination in their own language. */
  private navigationToolLabel(tool: { name: string; targetSceneId?: string }) {
    const scene = tool.targetSceneId ? this.release.scenes.find((item) => item.id === tool.targetSceneId) : undefined;
    return scene?.name ? this.say.enterScene(scene.name) : tool.name;
  }

  private searchKnowledge(keywords: string[]) {
    // Delegate to the single authoritative knowledge index — readiness-ranked, with
    // PATH templates + required params + directEntry — so the main agent, adaptive
    // agent, and routing context all consume the same knowledge. Scores each object as
    // the max over the keyword list. Navigation tools (execution routes) are appended.
    const index = searchKnowledgeIndex(this.release, keywords);
    return [
      ...index.scenes.map((scene) => ({ kind: "scene", id: scene.id, name: scene.name, description: scene.description, urlTemplate: scene.urlTemplate, requiredParams: scene.requiredParams, directEntry: scene.directEntry, status: scene.evidenceStatus })),
      ...index.operations.map((operation) => ({ kind: "operation", id: operation.id, name: operation.name, description: operation.description, status: operation.status })),
      ...(this.release.navigationTools || []).map((tool) => ({ kind: "navigation-tool", id: tool.id, name: this.navigationToolLabel(tool), description: `${tool.description}；只负责到达页面`, status: tool.status })), // i18n-exempt: tool description read by the model, not the reader
    ];
  }

  /** Content backend of the unified search: grep the content index by the keyword LIST,
   * surfaced alongside structure results so a topic buried in a page body (a scene-name
   * miss, e.g. 未成年 in 隐私条款) is still found. Each page carries `matchedKeywords` and
   * `text` = the hit-centered context windows so the agent answers directly from the
   * knowledge base (citing the URL). `totalPagesWithHits` reports breadth so the model can
   * tell a distinctive term from a site-wide one. Best-effort; empty on any failure. */
  private async searchContentPassages(keywords: string[]): Promise<{ items: Array<{ kind: "content"; url: string; sceneId?: string; heading?: string; matchedKeywords: string[]; text: string; score: number }>; totalPagesWithHits: number }> {
    try {
      const params = keywords.map((keyword) => `keyword=${encodeURIComponent(keyword)}`).join("&");
      const data = await fetchWithTimeout(endpointUrl(this.options.endpoint, `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/content?${params}`), { cache: "no-store" }, 5_000)
        .then((response) => json<{ pages?: Array<{ url: string; sceneId?: string; headingPath?: string; matchedKeywords?: string[]; context?: Array<{ text: string }>; score: number }>; totalPagesWithHits?: number }>(response));
      const items = (data.pages || []).map((page) => ({
        kind: "content" as const, url: page.url, sceneId: page.sceneId, heading: page.headingPath,
        matchedKeywords: page.matchedKeywords || [],
        text: (page.context || []).map((window) => window.text).join("\n"), score: page.score,
      }));
      return { items, totalPagesWithHits: data.totalPagesWithHits || 0 };
    } catch {
      return { items: [], totalPagesWithHits: 0 };
    }
  }

  /** The `read_page` backend: the full indexed text of one page by exact URL — the agent's
   * Read step after a grep hit when the context windows are not enough. Index-only, never
   * the live page. Null on failure / unindexed URL. */
  private async readPage(url: string): Promise<{ url: string; text: string } | null> {
    try {
      const data = await fetchWithTimeout(endpointUrl(this.options.endpoint, `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/content?url=${encodeURIComponent(url)}`), { cache: "no-store" }, 5_000)
        .then((response) => json<{ url?: string; chunks?: Array<{ text: string }> }>(response));
      const text = (data.chunks || []).map((chunk) => chunk.text).join("\n");
      return text ? { url, text } : null;
    } catch {
      return null;
    }
  }

  private async completeConversation(session: TaskSession, text: string, outcomeOverride?: TaskEpisode["outcome"]): Promise<TaskResult> {
    const now = new Date().toISOString();
    const outcome: TaskEpisode["outcome"] = outcomeOverride || { status: "success", code: "conversation_completed", summary: text, evaluatedAt: now, evidence: { source: "main-agent" } };
    const succeeded = outcome.status === "success";
    // A direct answer is not a successful browser episode. In particular it
    // must not be fed into capability discovery as an "adaptive" experience:
    // greetings and product questions are part of the conversation, not
    // demonstrations of a reusable website task.
    const conversation = [...(session.conversation || [])];
    if (conversation.at(-1)?.role !== "assistant" || conversation.at(-1)?.content !== text) conversation.push({ role: "assistant", content: text, at: now });
    const terminalStatus = succeeded ? "completed" : "failed";
    let completedSession: TaskSession = { ...session, conversation, status: terminalStatus, updatedAt: now };
    try { completedSession = await this.patchSession(session.id, { conversation, status: terminalStatus }); }
    catch { this.activeSession = completedSession; }
    const result: TaskResult = { success: succeeded, mode: "adaptive", interaction: "conversation", text, output: {}, outcome, session: completedSession, release: this.release };
    try { await this.finishRun(terminalStatus, outcome, {}, text, session.id); }
    catch { /* The response is already visible; the next SDK bootstrap reconciles the durable run. */ }
    this.releaseLease(session.id);
    this.status(succeeded ? "completed" : "error", text, { taskResult: result, presentation: "conversation" });
    return result;
  }

  /**
   * Consume the OpenAI-compatible streaming envelope without making the
   * runtime depend on a particular model vendor.  Text is forwarded to the UI
   * immediately; tool-call fragments are losslessly reassembled before the
   * Agent decides what to execute.
   */
  private async completeMainAgentTurn(messages: Array<Record<string, unknown>>, tools: Array<Record<string, unknown>>, streamAnswer = true, toolChoice: "auto" | "none" = "auto") {
    let lastError: unknown;
    // The task's own controller, captured now: "stop" must cut this request and
    // its stream at once, not let the reply keep arriving (and the widget keep
    // switching back to "running") until the next checkpoint notices.
    const signal = this.activeAbort?.signal;
    for (let attempt = 0; attempt < RUNTIME_MODEL_MAX_ATTEMPTS; attempt += 1) {
      try {
        if (signal?.aborted) throw new Error("task_cancelled");
        const spacingMs = Math.max(0, nextRuntimeModelRequestAt - Date.now());
        if (spacingMs) await new Promise((resolve) => setTimeout(resolve, spacingMs));
        nextRuntimeModelRequestAt = Date.now() + RUNTIME_MODEL_MIN_INTERVAL_MS;
        const response = await fetchWithTimeout(endpointUrl(this.options.endpoint, `/api/site-agents/${encodeURIComponent(this.options.siteAgentId)}/model/v2/chat/completions`), {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.requireAgentRunToken()}`, "x-sitewake-ai-stage": "runtime-router" },
          body: JSON.stringify({ messages, tools, tool_choice: toolChoice, parallel_tool_calls: false, temperature: 0.2, stream: true, stream_options: { include_usage: true } }),
          signal,
        }, RUNTIME_MODEL_TIMEOUT_MS, runtimeModelFirstByteTimeoutMs(attempt));
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const detail = text.slice(0, 240).replace(/\s+/g, " ").trim();
          throw new RuntimeModelRequestError(response.status, retryAfterMilliseconds(response, attempt), detail || `main_agent_http_${response.status}`);
        }
        return await readMainAgentTurnResponse(response, (content) => {
          if (streamAnswer) this.status("adaptive", this.say.generatingAnswer, { presentation: "assistant-stream", assistantDelta: content });
        });
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw new Error("task_cancelled");
        if (!runtimeModelRetryable(error) || attempt >= RUNTIME_MODEL_MAX_ATTEMPTS - 1) throw error;
        const waitMs = error instanceof RuntimeModelRequestError
          ? error.retryAfterMs || Math.min(15_000, 1_000 * (2 ** attempt))
          : Math.min(15_000, 1_000 * (2 ** attempt));
        this.status("adaptive", this.say.modelBusyRetry(Math.ceil(waitMs / 1000)), { presentation: "model-retry", retryAfterMs: waitMs, retryAttempt: attempt + 1 });
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw lastError instanceof Error ? lastError : new Error("main_agent_model_failed");
  }

  private capabilityV2Headers() {
    const pointer = this.readRunPointer();
    return {
      "content-type": "application/json",
      "x-sitewake-site-id": this.options.siteAgentId,
      "x-sitewake-site-agent-id": this.options.siteAgentId,
      ...(pointer ? { authorization: `Bearer ${pointer.resumeToken}` } : {}),
    };
  }

  private async capabilityV2Request<T>(path: string, init: RequestInit = {}) {
    return this.measureRuntime(path.includes("/search") ? "capability.catalog" : path.includes("/runtime") ? "capability.runtime" : "capability.request", async (timing) => {
      const response = await fetchWithTimeout(endpointUrl(this.options.endpoint, path), { ...init, cache: "no-store", headers: { ...this.capabilityV2Headers(), ...(init.headers || {}) } }, 45_000);
      const appTiming = response.headers.get("server-timing")?.match(/app;dur=([\d.]+)/)?.[1];
      if (appTiming) timing.serverMs = Number(appTiming);
      const requestId = response.headers.get("x-request-id");
      if (requestId && /^[a-f0-9-]{36}$/i.test(requestId)) timing.requestId = requestId;
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
        throw new Error(payload.message || payload.error || `capability_v2_http_${response.status}`);
      }
      return response.json() as Promise<T>;
    });
  }

  private async searchCapabilitiesV2(queries: string[], request: { goal?: string; input?: Record<string, JsonValue> } = {}) {
    const response = await this.capabilityV2Request<{ items?: CapabilityV2Candidate[] }>("/api/capability-v2/capabilities/search", { method: "POST", body: JSON.stringify({ siteId: this.options.siteAgentId, queries: queries.filter(Boolean).slice(0, 12), limit: 30, goal: request.goal, input: request.input, currentUrl: typeof location !== "undefined" ? location.href : undefined }) });
    return response.items || [];
  }

  /**
   * The arguments an intent match produces, or nothing if they are not the
   * arguments this contract declares.
   *
   * What the sentence yields is text. A contract that asks for a number gets
   * one only when the text is a number and nothing else; anything the schema
   * refuses, or any required input the sentence left unsaid, withdraws the
   * whole route rather than calling the capability with a value it cannot use.
   */
  private capabilityV2InputFromTemplate(candidate: CapabilityV2Candidate, bound: Record<string, string>, supplied: Record<string, JsonValue>) {
    const schema = candidate.contract.inputSchema || {};
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, Record<string, unknown>>
      : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : Object.keys(properties);
    const input: Record<string, JsonValue> = { ...supplied };
    for (const [path, text] of Object.entries(bound)) {
      if (!Object.hasOwn(properties, path)) return undefined;
      const declared = String(properties[path].type || "string");
      if (declared === "string") input[path] = text;
      else if (declared === "number" || declared === "integer") {
        const value = Number(text);
        if (!Number.isFinite(value) || (declared === "integer" && !Number.isInteger(value))) return undefined;
        input[path] = value;
      } else return undefined;
    }
    if (required.some((path) => input[path] === undefined || input[path] === "")) return undefined;
    try {
      assertCapabilityInput(schema as Parameters<typeof assertCapabilityInput>[0], input);
    } catch {
      return undefined;
    }
    return input;
  }

  /**
   * A published contract is already a deterministic routing authority.  When
   * the user goal contains the contract's public alias vocabulary, do not ask
   * the runtime model to rediscover the same required arguments (which often
   * fell through to PageAgent and produced a burst of model calls).  Unknown
   * values still go through the model; this helper only maps explicit aliases
   * or declared defaults and never invents a value.
   */
  private inferCapabilityV2Input(candidate: CapabilityV2Candidate, goal: string, supplied: Record<string, JsonValue>) {
    const schema = candidate.contract.inputSchema || {};
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, Record<string, unknown>>
      : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : Object.keys(properties);
    const input: Record<string, JsonValue> = { ...supplied };
    const normalizedGoal = normalizeGoal(goal);
    for (const name of required) {
      if (input[name] !== undefined && input[name] !== "") continue;
      const aliases = candidate.contract.inputAliases?.[name] || {};
      const aliasHit = Object.entries(aliases).find(([publicValue, canonicalValue]) => {
        const left = normalizeGoal(publicValue);
        const right = normalizeGoal(canonicalValue);
        return (left && normalizedGoal.includes(left)) || (right && normalizedGoal.includes(right));
      });
      if (aliasHit) {
        input[name] = aliasHit[1];
        continue;
      }
      const defaultValue = properties[name]?.default;
      if (["string", "number", "boolean"].includes(typeof defaultValue)) input[name] = defaultValue as JsonPrimitive;
    }
    return required.every((name) => input[name] !== undefined && input[name] !== "") ? input : undefined;
  }

  private async getCapabilityV2Runtime(capabilityId: string, input: Record<string, JsonValue> = {}, runtimeWindow?: CompiledRuntimeWindow) {
    const path = `/api/capability-v2/capabilities/${encodeURIComponent(capabilityId)}/runtime?siteId=${encodeURIComponent(this.options.siteAgentId)}`;
    const init: RequestInit = { headers: {
      // Fetch forbids non ISO-8859-1 header bytes. User goals and capability
      // inputs are routinely Unicode (for example, “搜索马克杯”), so carry
      // them as percent-encoded ASCII and decode them at the control plane.
      // This keeps scope matching semantically identical without letting a
      // valid capability call fail before the request leaves Chromium.
      "x-capability-input": encodeURIComponent(JSON.stringify(input).slice(0, 8_000)),
      "x-capability-goal": encodeURIComponent(this.activeSession?.goal || ""),
      "x-capability-current-url": encodeURIComponent(location.href),
    } };
    if (!runtimeWindow) return this.capabilityV2Request<CapabilityV2RuntimeDefinition>(path, init);
    return this.compiledAwait(runtimeWindow, (signal) => this.capabilityV2Request<CapabilityV2RuntimeDefinition>(path, { ...init, signal }));
  }

  private async executeCapabilityV2JavaScriptRuntime(
    runtime: CapabilityV2RuntimeDefinition,
    session: TaskSession,
    input: Record<string, JsonValue>,
    startIndex = 0,
    restoredOutput: Record<string, JsonValue> = {},
    restoredReceipts: CapabilityV2StageReceipt[] = [],
    restoredEvidence: CapabilityStageEvidenceV2[] = [],
    restoredModuleHash?: string,
    restoredControlState?: CapabilityExecutionCursorV2,
    restoredRuntimeWindow?: CompiledRuntimeWindow,
    agentStep?: CapabilityAgentStep,
  ): Promise<TaskResult | undefined> {
    const runtimeWindow = establishCompiledRuntimeWindow(undefined, restoredRuntimeWindow);
    // Every default the Contract declares, the way validation resolves them.
    // Only required inputs were defaulted here, so an optional one reached the
    // program as undefined: 「maxPrice=undefined」 in a filter that had passed
    // validation with its default of 300.
    const executionInput = applyCapabilityV2InputAliases(runtime, resolveCapabilityInputDefaults(runtime.contract, input));
    const activityId = `capability-v2:${session.id}:${runtime.capabilityId}`;
    const start = capturePageSnapshot(this.sequence++);
    const domRecorder = this.options.domReplay
      ? startDomReplayRecorder({ siteAgentId: this.options.siteAgentId, endpoint: this.options.endpoint, runId: session.id, runToken: this.requireAgentRunToken(session.id), sessionId: browserSessionId(), documentId: start.documentId, origin: "capability-v2" })
      : undefined;
    const state: JsonObjectV2 = { ...restoredOutput };
    const stageEvidence: CapabilityStageEvidenceV2[] = [...restoredEvidence];
    const stageReceipts: CapabilityV2StageReceipt[] = [...restoredReceipts];
    const resumeStageId = restoredControlState?.currentStageId || runtime.program.stages[startIndex]?.id || runtime.program.stages[0]?.id;
    let controlCursor = createCapabilityExecutionCursor(runtime.program, resumeStageId, restoredControlState);
    let activeStage: CapabilityStageManifestV2 | undefined;
    const checkpoint = (programStepIndex: number, phase: Checkpoint["phase"] = "running"): Checkpoint => ({
      sessionId: session.id,
      mode: "compiled",
      phase,
      v2Runtime: runtime,
      runtimeTimings: this.runtimeTimings,
      activityTimeline: this.activityTimeline,
      v2ModuleHash: runtime.program.module.contentHash,
      v2ControlState: controlCursor,
      v2StageReceipts: stageReceipts,
      v2StageEvidence: stageEvidence,
      compiledRuntimeWindow: runtimeWindow,
      input: executionInput,
      operationIndex: 0,
      programStepIndex,
      output: state,
      directCall: true,
      ...(this.validationRun ? { validationRun: true } : {}),
      ...(agentStep ? { v2AgentStep: agentStep } : {}),
      savedAt: Date.now(),
    });
    this.status("executing", this.say.callingCapability(runtime.name), { activity: { id: activityId, kind: "capability", state: "running", sessionId: session.id, capabilityId: runtime.capabilityId, capabilityName: runtime.name, input } });
    // Every way this run can end goes through here. When the main Agent called
    // the capability as one tool, a handled ending is that tool's receipt and
    // the Agent decides what comes next; only otherwise does it close the task.
    // Three endings each closed the task on their own, and the one for "no
    // result" kept doing so after the other two had learned to hand back.
    const conclude = async (outcome: TaskEpisode["outcome"], output: Record<string, JsonValue>) => {
      const handled = ["success", "no-result", "business-rejection"].includes(outcome.status);
      const settle = async () => {
        const sessionStatus = handled ? "completed" : "failed";
        const completedSession: TaskSession = { ...session, status: sessionStatus, updatedAt: new Date().toISOString() };
        this.activeSession = completedSession;
        void this.patchSession(session.id, { status: sessionStatus }).catch(() => undefined);
        const result: TaskResult = { success: handled, mode: "compiled", interaction: "capability", text: outcome.summary, output, outcome, session: completedSession, release: this.release };
        this.status(handled ? "completed" : "error", outcome.summary, { taskResult: result, activity: { id: activityId, kind: "capability", state: handled ? "completed" : "failed", sessionId: session.id, capabilityId: runtime.capabilityId, capabilityName: runtime.name, input, output, summary: outcome.summary } });
        await this.finishRun(handled ? "completed" : "failed", outcome, output, outcome.summary, session.id).catch(() => undefined);
        this.releaseLease(session.id);
        return result;
      };
      if (agentStep && handled) return this.continueAgentAfterCapability(session, agentStep, runtime, { status: outcome.status, summary: outcome.summary, output }, activityId, input, settle);
      return settle();
    };
    try {
      if (compiledRuntimeRemainingMs(runtimeWindow) <= 0) throw compiledRuntimeDeadlineError();
      assertCapabilityInput(runtime.contract.inputSchema as never, executionInput);
      if (restoredModuleHash && restoredModuleHash !== runtime.program.module.contentHash) throw new Error("capability_checkpoint_module_mismatch");
      const pageText = () => (document.body?.innerText || "").replace(/\s+/g, " ");
      // A run is fresh until a Stage has started. A Stage that leaves the
      // entry page resumes on the destination with the cursor still at that
      // Stage, so the cursor alone cannot say so: the first Stage of "Find
      // kids room lamps" went to /shop, the destination took itself for a new
      // run, went back to the entry page and started over, forever.
      const fresh = startIndex === 0 && !restoredReceipts.length;
      if (fresh && runtime.program.entry.mode === "Navigate" && runtime.program.entry.url) {
        const entryUrl = new URL(runtime.program.entry.url, location.href);
        if (entryUrl.origin !== location.origin) throw new Error("capability_navigation_origin_invalid");
        if (entryUrl.href !== location.href) {
          this.storeCheckpointLocally(checkpoint(0, "waiting-page-restore"));
          if (await this.compiledAwait(runtimeWindow, () => this.navigateWithRun(entryUrl.href))) return undefined;
        }
      }

      if (fresh) {
        for (const raw of runtime.contract.preconditions || []) {
          if (typeof raw === "string" && !capabilityTextIncludes(pageText(), raw)) throw new Error(`precondition_text_missing:${raw}`);
          const condition = capabilityV2Object(raw);
          const type = String(condition.type || "");
          if (type === "urlIncludes" && !location.href.includes(String(condition.value || ""))) throw new Error("precondition_url_mismatch");
          if (type === "urlTemplate" && !capabilityUrlTemplateMatches(location.href, condition.template, executionInput)) throw new Error("precondition_url_mismatch");
          if (type === "textIncludes" && !capabilityTextIncludes(pageText(), condition.value)) throw new Error("precondition_text_missing");
          if (type === "textTemplate" && !capabilityTextIncludes(pageText(), capabilityV2RenderTemplate(condition.template, executionInput))) {
            const inputPaths = capabilityV2TemplateInputPaths(condition.template);
            if (inputPaths.length) throw capabilityV2NoResultForInputs(runtime, executionInput, inputPaths, { conditionType: "textTemplate" });
            throw new Error("precondition_text_missing");
          }
          if (type === "inputExists" && capabilityV2PathValue(input, String(condition.path || "")) === undefined) throw new Error(`precondition_input_missing:${String(condition.path || "")}`);
        }
      }

      // BrowserJavaScriptStage is intentionally unavailable in a read-only
      // embedding. Its reviewed source can contain arbitrary DOM code, so a
      // per-action allowlist cannot enforce the production read-only boundary.
      if (this.options.runtimeMode === "read-only") throw new Error("runtime_read_only_module_forbidden");
      const moduleUrl = new URL(endpointUrl(this.options.endpoint, runtime.program.module.moduleUrl), location.href);
      // Capability modules are delivered by the configured control-plane
      // endpoint.  The page itself is often a different origin in local
      // development (for example PrestaShop on :18081 and the control plane
      // on :3310), so requiring same-origin here made every published V2
      // capability fail before its first stage.  Keep the origin boundary:
      // only the current page or the explicitly configured endpoint may serve
      // executable capability code.
      let endpointOrigin = location.origin;
      try { endpointOrigin = new URL(this.options.endpoint || location.origin, location.href).origin; } catch { /* malformed endpoints fail at fetch */ }
      if (moduleUrl.origin !== location.origin && moduleUrl.origin !== endpointOrigin) throw new Error("capability_module_origin_invalid");
      const moduleSource = await this.measureRuntime("module.fetch", () => this.compiledAwait(runtimeWindow, async (signal) => {
        const moduleResponse = await fetch(moduleUrl.href, { cache: "force-cache", signal });
        if (!moduleResponse.ok) throw new Error(`capability_module_unavailable:${moduleResponse.status}`);
        return moduleResponse.text();
      }));
      const actualHash = await this.measureRuntime("module.integrity", () => this.compiledAwait(runtimeWindow, async () => sha256HexText(moduleSource)));
      if (actualHash !== runtime.program.module.contentHash) throw new Error("capability_module_integrity_mismatch");
      let loaded: CapabilityV2StageModule;
      try {
        loaded = await this.measureRuntime("module.import", () => this.compiledAwait(runtimeWindow, async () => import(/* webpackIgnore: true */ moduleUrl.href) as Promise<CapabilityV2StageModule>));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("page_agent_budget_exhausted:") || message === "task_cancelled") throw error;
        throw new Error(`capability_module_import_blocked:${message}`);
      }
      const moduleCapability = loaded.capability;
      if (moduleCapability?.version !== 2 || !Array.isArray(moduleCapability.stages) || !moduleCapability.stages.length) throw new Error("capability_module_invalid");
      const moduleStageIds = moduleCapability.stages.map((stage, index) => {
        if (!stage?.id || typeof stage.run !== "function") throw new Error(`capability_stage_invalid:${index}`);
        return stage.id;
      });
      if (JSON.stringify(moduleStageIds) !== JSON.stringify(runtime.program.stages.map((stage) => stage.id))) throw new Error("capability_stage_manifest_mismatch");
      if (!capabilityJsonEqual(moduleCapability.stages.map((stage) => stage.transitions || null), runtime.program.stages.map((stage) => stage.transitions || null))) throw new Error("capability_stage_transition_manifest_mismatch");
      if (!capabilityJsonEqual(moduleCapability.stages.map((stage) => normalizeCapabilityStageIO(stage.io) || null), runtime.program.stages.map((stage) => normalizeCapabilityStageIO(stage.io) || null))) throw new Error("capability_stage_io_manifest_mismatch");
      if (!capabilityJsonEqual(moduleCapability.stages.map((stage) => normalizeCapabilityStageNavigation(stage.navigation) || null), runtime.program.stages.map((stage) => normalizeCapabilityStageNavigation(stage.navigation) || null))) throw new Error("capability_stage_navigation_manifest_mismatch");
      if (!capabilityJsonEqual(moduleCapability.controlFlow || null, runtime.program.controlFlow || null)) throw new Error("capability_control_flow_manifest_mismatch");

      const lastReceipt = stageReceipts.at(-1);
      const pendingReceipt = lastReceipt?.status === "Started" ? lastReceipt : undefined;
      if (pendingReceipt) {
        const pendingStage = runtime.program.stages[pendingReceipt.stageIndex];
        if (pendingStage) controlCursor = createCapabilityExecutionCursor(runtime.program, pendingStage.id, restoredControlState);
        if (location.href !== pendingReceipt.urlBefore && pendingStage && (pendingStage.navigation === "none" || pendingStage.effect === "read")) {
          // The document left while a Stage that cannot navigate (or only
          // reads) was running: the navigation belongs to the Stage before it,
          // whose click handler returned before the unload. Nothing of this
          // Stage happened on the destination yet — run it here, do not skip it.
          controlCursor = createCapabilityExecutionCursor(runtime.program, pendingStage.id, controlCursor);
        } else if (location.href !== pendingReceipt.urlBefore) {
          const resumeStageId = pendingStage?.id || controlCursor.currentStageId;
          if (runtime.program.controlFlow || pendingStage?.transitions) throw new Error(`capability_control_flow_resume_signal_missing:${resumeStageId}`);
          controlCursor = resolveCapabilityStageTransition(runtime.program, controlCursor, resumeStageId, "next", state);
          stageReceipts.push({ ...pendingReceipt, status: "Completed", urlAfter: location.href, outcome: "Continue", signal: "next", completedAt: new Date().toISOString() });
        } else {
          // A write may have happened immediately before the old document was
          // interrupted. Re-enter that Stage so its mandatory reconciliation
          // guard can prove completion or retry safely.
          controlCursor = createCapabilityExecutionCursor(runtime.program, pendingStage?.id || controlCursor.currentStageId, controlCursor);
        }
      }

      let terminalResult: CapabilityStageResultV2 | undefined;
      // Dynamic storefronts often encode a variant in the URL hash and apply
      // it asynchronously after the new document is ready.  A generated
      // Stage must never treat that hash alone as proof that the requested
      // color/size/material is selected: before a later write Stage runs,
      // select the matching visible control and wait for its checked state.
      const ensureFacetSelection = async () => {
        const facet = Object.entries(executionInput).find(([name, value]) =>
          typeof value === "string" && value.trim() && /(?:color|colour|material|size|variant|颜色|材质|尺码)/iu.test(name));  // i18n-exempt:匹配页面字段里的规格词，不是展示文案
        if (!facet) return;
        const needle = String(facet[1]).trim().toLocaleLowerCase();
        const selected = () => Array.from(document.querySelectorAll("input:checked, option:checked, [aria-checked='true'], [data-selected='true']")).some((node) => {
          const element = node as HTMLElement;
          const id = element.getAttribute("id") || "";
          const label = id ? document.getElementById(id)?.parentElement : undefined;
          const text = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("value") || ""} ${label?.textContent || ""} ${element.parentElement?.textContent || ""}`.toLocaleLowerCase();
          return text.includes(needle);
        });
        const controls = () => Array.from(document.querySelectorAll("input[type='radio'], input[type='checkbox'], [role='radio']")).find((node) => {
          const element = node as HTMLElement;
          const id = element.getAttribute("id") || "";
          const label = id ? document.querySelector(`label[for='${id.replace(/'/g, "\\'")}']`) : undefined;
          const text = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("value") || ""} ${label?.textContent || ""}`.toLocaleLowerCase();
          return text.includes(needle);
        }) as HTMLInputElement | HTMLElement | undefined;
        const deadline = Date.now() + 2_000;
        while (!selected() && Date.now() < deadline) {
          const control = controls();
          if (control) {
            try { (control as HTMLElement).click(); } catch { /* the authored Stage may still select it */ }
          }
          if (selected()) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };
      while (controlCursor.currentStageId) {
        if (Date.now() - controlCursor.startedAt > capabilityControlFlowLimits(runtime.program).totalTimeoutMs) throw new Error("capability_program_timeout");
        this.assertTaskAlive(session.id);
        const index = runtime.program.stages.findIndex((candidate) => candidate.id === controlCursor.currentStageId);
        if (index < 0) throw new Error(`capability_stage_missing:${controlCursor.currentStageId}`);
        const stage = runtime.program.stages[index];
        controlCursor = beginCapabilityStage(runtime.program, controlCursor, stage.id, state);
        activeStage = stage;
        // Reconcile option labels before checkpointing.  If this Stage
        // navigates, the next document resumes from the checkpoint and must
        // receive the canonical visible value as well (not the punctuation-
        // free phrase the user supplied).
        const stageInput = reconcileVisibleCapabilityOptions(executionInput);
        Object.assign(executionInput, stageInput);
        this.status("executing", `${runtime.name} · ${stage.title}`, { activity: { id: stage.id, kind: "page", state: "running", sessionId: session.id, capabilityId: runtime.capabilityId, capabilityName: runtime.name, stepId: stage.id, stepOp: "javascript-stage", stepIndex: index + 1, stepTotal: runtime.program.stages.length } });
        // A Stage can navigate synchronously. Persist the next cursor and arm
        // the same one-shot handoff used by the legacy module host before any
        // authored JavaScript receives control.
        const startedReceipt: CapabilityV2StageReceipt = { stageId: stage.id, stageIndex: index, status: "Started", urlBefore: location.href, iteration: capabilityStageIteration(runtime.program, controlCursor, stage.id) };
        stageReceipts.push(startedReceipt);
        this.capabilityNavigationDeferred = true;
        this.capabilityStageNavigates = stage.navigation !== "none";
        this.pendingCapabilityNavigation = undefined;
        this.capabilityNavigationStarted = false;
        // The continuation armed for the previous Stage is not revoked here:
        // that Stage may have returned while the document navigation it
        // started is still in flight (a click handler's location assignment
        // returns at once; the unload comes later). A navigating Stage re-arms
        // below, replacing it; a non-navigating one leaves it to the grace
        // timer, which revokes it only if this document is still alive.
        let rawResult: unknown;
        try {
          // Keep only a local detachable checkpoint while the authored Stage
          // runs. The stage may return state and a branch signal after asking
          // the host to navigate; the irreversible handoff is committed below
          // only after that result is recorded.
          this.storeCheckpointLocally(checkpoint(index, "waiting-page-restore"));
          // V2 navigation is returned as data. Native navigation is rejected by
          // the observer; reserve a server handoff only when the host navigates.
          if (stage.effect === "write") state.__capabilityV2SideEffectStarted = true;
          const capabilityDeadlineAt = capabilityStageDeadline(runtime.program, controlCursor, stage.id);
          const compiledDeadlineAt = Date.parse(runtimeWindow.deadlineAt);
          const stageDeadlineAt = Number.isFinite(compiledDeadlineAt)
            ? Math.min(capabilityDeadlineAt, compiledDeadlineAt)
            : capabilityDeadlineAt;
          const stageWindow = compiledRuntimeWindowUntil(runtimeWindow, stageDeadlineAt);
          // A Stage that may navigate (its manifest says so) can still leave
          // through a path the observer cannot intercept — a framework router
          // or a location assignment behind the site's own submit handler.
          // Without a one-shot continuation the destination document would
          // treat the arrival as a user interruption and the Run would sit in
          // "running" forever. Arm the same handoff the legacy module host
          // arms before every scripted click: the destination consumes it and
          // resumes from the Started receipt above; a document that survives
          // revokes it on the next Stage (or the grace timer does).
          if (stage.navigation !== "none") {
            await this.compiledAwait(stageWindow, () => this.armNavigationIntent());
          }
          if (controlCursor.iteration > 1 && stage.effect === "write") {
            try {
              await this.compiledAwait(stageWindow, ensureFacetSelection);
            } catch (error) {
              if (stageDeadlineAt < Date.parse(runtimeWindow.deadlineAt) && error instanceof Error && error.message === "page_agent_budget_exhausted:active-time") {
                throw new Error("capability_control_flow_timeout");
              }
              throw error;
            }
          }
          const run = moduleCapability.stages[index]?.run;
          if (typeof run !== "function") throw new Error(`capability_stage_missing:${stage.id}`);
          // A read Stage that finds nothing on a page still putting itself
          // together has not found an absence. Production: the dialog was open
          // and on screen, and the Stage read its title 555ms after the click,
          // before the title was in the document, so a capability that had
          // done its work reported no result. A read Stage changes nothing, so
          // it is worth one more look once the page has gone quiet. A write
          // Stage is never repeated this way.
          const looks = stage.effect === "read" ? 2 : 1;
          for (let look = 0; look < looks; look += 1) {
            if (look) await this.compiledAwait(stageWindow, (signal) => settleCapabilityPage(signal, 400, 2_000));
            try {
              rawResult = await this.measureRuntime(`stage.${stage.id}`, () => this.compiledAwait(stageWindow, async (signal) => executeBrowserCapabilityStage({
                run, input: { ...stageInput }, state: { ...state },
                inputPaths: stage.io.reads.input, statePaths:stage.io.reads.state, stageId:stage.id,
                signal,
                deadlineAt: stageWindow.deadlineAt,
              })));
            } catch (error) {
              if (stageDeadlineAt < Date.parse(runtimeWindow.deadlineAt) && error instanceof Error && error.message === "page_agent_budget_exhausted:active-time") {
                throw new Error("capability_control_flow_timeout");
              }
              throw error;
            }
            if (!capabilityStageFoundNothing(rawResult)) break;
          }
          assertCapabilityControlFlowBudget(runtime.program, controlCursor, Date.now());
        } finally {
          this.capabilityNavigationDeferred = false;
          this.capabilityStageNavigates = false;
        }
        const result = normalizeCapabilityV2StageResult(rawResult, stage);
        // V2 authored Stages communicate navigation as data. A direct DOM
        // navigation or the legacy observer hook is a protocol violation:
        // it can tear down this document before state, cursor, receipt and
        // handoff have been committed.
        const directNavigation = this.pendingCapabilityNavigation as { openedWindow?: Window | null } | undefined;
        if (directNavigation) {
          this.pendingCapabilityNavigation = undefined;
          directNavigation.openedWindow?.close();
          throw new Error(`capability_stage_direct_navigation_forbidden:${stage.id}`);
        }
        if (result.navigation) {
          assertCapabilityNavigationUrl(location.href, result.navigation, stage.id);
        }
        if (result.state) Object.assign(state, result.state);
        if (result.evidence) stageEvidence.push(...result.evidence);
        const completedIteration = capabilityStageIteration(runtime.program, controlCursor, stage.id);
        const stageBoundaryCursor = controlCursor;
        if (result.outcome !== "Continue" && result.navigation) {
          throw new Error(`capability_navigation_terminal_outcome:${stage.id}`);
        }
        controlCursor = result.outcome === "Continue"
          ? resolveCapabilityStageTransition(runtime.program, controlCursor, stage.id, result.signal, state)
          : { ...controlCursor, currentStageId: "", nextStageId: undefined };
        stageReceipts.push({ ...startedReceipt, status: "Completed", urlAfter: location.href, outcome: result.outcome, signal: result.signal, iteration: completedIteration, evidence: result.evidence, completedAt: new Date().toISOString() });
        const pendingNavigation = result.navigation;
        // Commit the completed step and next cursor before a document can leave.
        // A returned destination may already have been reached by an SPA click.
        // Only an actual document handoff suspends this executor.
        this.status("executing", this.say.stageDone(runtime.name, stage.title), { activity: { id: stage.id, kind: "page", state: "completed", sessionId: session.id, capabilityId: runtime.capabilityId, capabilityName: runtime.name, stepId: stage.id, stepOp: "javascript-stage", stepIndex: index + 1, stepTotal: runtime.program.stages.length } });
        const nextIndex = controlCursor.currentStageId
          ? runtime.program.stages.findIndex((candidate) => candidate.id === controlCursor.currentStageId)
          : index;
        const continuationCheckpoint = checkpoint(nextIndex, pendingNavigation ? "waiting-page-restore" : "running");
        this.storeCheckpointLocally(continuationCheckpoint);
        if (pendingNavigation) {
          const handedOff = await this.compiledAwait(runtimeWindow, () => this.navigateWithRun(pendingNavigation.url, pendingNavigation.target));
          if (handedOff) return undefined;
          this.storeCheckpointLocally(checkpoint(nextIndex, "running"));
        }
        if (result.outcome !== "Continue") {
          assertCapabilityControlFlowBudget(runtime.program, { ...stageBoundaryCursor, currentStageId: stage.id }, Date.now());
        }
        this.clearNavigationIntent();
        if (result.outcome !== "Continue") {
          terminalResult = result;
          break;
        }
      }

      if (!terminalResult) throw new Error("capability_output_missing");
      // The program ended in this document: no continuation may outlive it.
      this.clearNavigationIntent(true);
      if (terminalResult.outcome !== "Success") {
        const status = terminalResult.outcome === "BusinessRejection" ? "business-rejection" : "no-result";
        const code = terminalResult.outcome === "Ambiguous"
          ? "capability_target_ambiguous"
          : terminalResult.outcome === "BusinessRejection"
            ? "capability_business_rejection"
            : "capability_no_result";
        const summary = terminalResult.reason?.trim() || this.say.capabilityNoUsableResult(runtime.name);
        const outcome: TaskEpisode["outcome"] = { status, code, summary, evaluatedAt: new Date().toISOString(), evidence: { source: "capability-center-v2-sdk", capabilityId: runtime.capabilityId, versionId: runtime.versionId, ...(activeStage?.id ? { stageId: activeStage.id } : {}), stageOutcome: terminalResult.outcome, stageEvidence, stageReceipts } };
        this.saveCheckpoint();
        return conclude(outcome, terminalResult.output || {});
      }

      state.__pageUrl = location.href;
      state.__pageTitle = document.title;
      state.__pageText = pageText().slice(0, 8_000);
      const output: Record<string, JsonValue> = { ...(terminalResult.output || {}) };
      assertCapabilityOutput(runtime.contract.outputSchema as never, output);
      const conditions = runtime.contract.successConditions || [];
      // What a capability produced and where it ended up are facts about the
      // run. What the page says at this instant is a fact about the world, and
      // the world moves: 打开指定排名的微博热搜 opened the topic it was asked
      // for and was failed because the live board had already renumbered it, so
      // 「第 7 名」 was no longer written anywhere. A text condition is recorded
      // as unmet and travels with the result; it does not decide the run.
      const unmetText: string[] = [];
      for (const raw of conditions) {
        if (typeof raw === "string") {
          if (!capabilityTextIncludes(pageText(), raw)) unmetText.push(raw);
          continue;
        }
        const condition = capabilityV2Object(raw);
        const type = String(condition.type || "");
        if (type === "urlIncludes" && !location.href.includes(String(condition.value || ""))) throw new Error("success_url_mismatch");
        if (type === "urlTemplate" && !capabilityUrlTemplateMatches(location.href, condition.template, executionInput)) throw new Error("success_url_mismatch");
        if (type === "textIncludes" && !capabilityTextIncludes(pageText(), condition.value)) unmetText.push(String(condition.value || ""));
        if (type === "textTemplate") {
          const rendered = capabilityV2RenderTemplate(condition.template, executionInput);
          if (!capabilityTextIncludes(pageText(), rendered)) unmetText.push(rendered);
        }
        if (type === "outputEquals" && capabilityV2PathValue(output, String(condition.path || "")) !== condition.value) throw new Error("success_output_mismatch");
        if (type === "outputExists" && capabilityV2PathValue(output, String(condition.path || "")) === undefined) throw new Error("success_output_missing");
      }
      const needsModelJudge = !conditions.length || conditions.some((raw) => typeof raw === "object" && String(capabilityV2Object(raw).type || "") === "modelGoal");
      let outcome: TaskEpisode["outcome"] = { status: "success", code: "capability_v2_program_verified", summary: capabilityCompletionText(runtime.name, executionInput, output, runtime.contract.outputSchema, completionPresentation()), evaluatedAt: new Date().toISOString(), evidence: { source: "capability-center-v2-sdk", capabilityId: runtime.capabilityId, versionId: runtime.versionId, output, stageEvidence, stageReceipts, ...(unmetText.length ? { unmetTextConditions: unmetText } : {}) } };
      if (needsModelJudge) {
        const end = capturePageSnapshot(this.sequence++);
        await this.assertCompiledModelRequestAvailable(session.id, runtimeWindow);
        const decision = await this.compiledAwait(runtimeWindow, (signal) => judgeTaskOutcome({ endpoint: this.options.endpoint, siteAgentId: this.options.siteAgentId, agentRunToken: this.requireAgentRunToken(session.id), evidence: buildTaskJudgeEvidence({ goal: agentStep ? capabilityStepGoal(runtime, executionInput) : session.goal, values: input, actorSuccess: true, actorText: outcome.summary, start, end, steps: [] }), replyLocale: this.replyLocale(), signal }));
        if (!decision || decision.status === "needs-more-work" || decision.status === "unknown" || decision.confidence < .65) throw new Error("capability_result_unverified");
        outcome = { status: decision.status, code: decision.code, summary: decision.summary, evaluatedAt: new Date().toISOString(), evidence: { source: "capability-center-v2-sdk-judge", capabilityId: runtime.capabilityId, versionId: runtime.versionId, output, confidence: decision.confidence, stageEvidence, stageReceipts } };
      }
      this.saveCheckpoint();
      return conclude(outcome, output);
    } catch (error) {
      this.capabilityNavigationDeferred = false;
      this.capabilityStageNavigates = false;
      this.pendingCapabilityNavigation?.openedWindow?.close();
      this.pendingCapabilityNavigation = undefined;
      this.saveCheckpoint();
      const message = error instanceof Error ? error.message : String(error);
      // A value the site does not offer is an answer for the visitor: say which
      // options it does offer. Reported as an unrecognized fault, it read as a
      // broken capability, in whatever language the explainer was written in.
      const notOffered = capabilityOptionNotOffered(message);
      const handledError = error instanceof CapabilityV2HandledOutcomeError
        ? error
        : notOffered
          ? new CapabilityV2HandledOutcomeError("no-result", "capability_input_not_offered", this.say.inputNotOffered(runtime.name, notOffered.wanted, notOffered.offered.join(this.say.listSeparator)), { wanted: notOffered.wanted, offered: notOffered.offered })
          : undefined;
      if (handledError) {
        const error = handledError;
        const outcome: TaskEpisode["outcome"] = { status: error.status, code: error.code, summary: error.summary, evaluatedAt: new Date().toISOString(), evidence: { source: "capability-center-v2-sdk", capabilityId: runtime.capabilityId, versionId: runtime.versionId, repairSuggested: false, ...error.detail } };
        return conclude(outcome, {});
      }
      const failureContext = {
        technicalError: message,
        capabilityName: runtime.name,
        targetLabel: activeStage?.title || this.say.pageEntry,
        inputLabel: capabilityV2FailureInputLabel(runtime, message),
        sideEffectStarted: state.__capabilityV2SideEffectStarted === true,
      };
      let explanation = explainCapabilityRuntimeFailure(failureContext, this.say.runtimeFailure);
      // An authored Stage may throw its own free-form message, which matches no
      // runtime rule and would be reported as an unrecognized fault the user can
      // only be warned about. When every action Stage completed and only the
      // terminal verification Stage threw, the page work is done and the
      // capability simply could not read the result: say that, and let it be
      // repaired.
      if (!explanation.recognized && capabilityVerificationOnlyFailure({
        stages: runtime.program.stages,
        receipts: stageReceipts,
        activeStageId: activeStage?.id,
      })) {
        explanation = explainCapabilityRuntimeFailure({ ...failureContext, technicalError: `capability_result_unverified:${message}` }, this.say.runtimeFailure);
      }
      const summary = explanation.summary;
      const outcome: TaskEpisode["outcome"] = { status: "execution-fault", code: explanation.code, summary, evaluatedAt: new Date().toISOString(), evidence: { source: "capability-center-v2-sdk", capabilityId: runtime.capabilityId, versionId: runtime.versionId, technicalError: message, repairSuggested: explanation.repairSuggested, stageEvidence, stageReceipts, ...(activeStage?.id ? { stepId: activeStage.id } : {}) } };
      let publishedDrift = this.release.runtimeFeatures?.pageAgentRuntimeV2 === true
        && !this.validationRun
        && isCompiledCapabilityDrift(outcome.code);
      let driftBudget: PageExecutionBudget | undefined;
      if (publishedDrift) {
        try {
          const ledger = await this.runtimeModelLedger(session.id, runtimeWindow);
          driftBudget = compiledRuntimeBudgetEvidence(runtimeWindow, ledger);
        } catch {
          publishedDrift = false;
        }
      }
      if (publishedDrift) {
        const end = capturePageSnapshot(this.sequence++);
        const requirement = executionRequirementForGoal(session.goal);
        const episode: TaskEpisode = {
          schemaVersion: SITE_AGENT_SCHEMA_VERSION,
          id: uid("episode"),
          siteAgentId: this.options.siteAgentId,
          taskSessionId: session.id,
          browserSessionId: browserSessionId(),
          documentId: start.documentId,
          mode: "compiled",
          goal: session.goal,
          normalizedGoal: normalizeGoal(session.goal),
          input: this.activeRun?.input || session.input,
          startedAt: runtimeWindow.startedAt,
          endedAt: end.capturedAt,
          capabilityId: runtime.capabilityId,
          sourceCapabilityId: runtime.capabilityId,
          repairKind: "compiled-capability-drift",
          compiledExecutionGrantId: runtime.executionGrantId,
          pageExecutionBrief: pageExecutionBrief({
            goal: session.goal,
            input: this.activeRun?.input || session.input,
            requirement,
            relevantCapabilityIds: [runtime.capabilityId],
            rejectedCapabilityReasons: [`Published capability ${runtime.capabilityId} drifted: ${outcome.code}`],
          }),
          startSnapshot: start,
          endSnapshot: end,
          transitions: [],
          outcome,
          experience: {
            version: 1,
            actions: [],
            actorSummary: outcome.summary,
            judgeEvidence: [start.url, end.url],
            budgetEvidence: driftBudget!,
          },
        };
        return this.ingestEpisode(episode, {}, "compiled", true);
      }
      let failedSession: TaskSession = { ...session, status: "failed", updatedAt: new Date().toISOString() };
      this.activeSession = failedSession;
      void this.patchSession(session.id, { status: "failed" }).catch(() => undefined);
      const result: TaskResult = { success: false, mode: "compiled", interaction: "capability", text: summary, output: {}, outcome, session: failedSession, release: this.release };
      this.status("error", this.say.capabilityFailed(runtime.name), { taskResult: result, activity: { id: activityId, kind: "capability", state: "failed", sessionId: session.id, capabilityId: runtime.capabilityId, capabilityName: runtime.name, input, summary } });
      await this.finishRun("failed", outcome, {}, summary, session.id).catch(() => undefined);
      this.releaseLease(session.id);
      return result;
    } finally {
      await domRecorder?.stop();
    }
  }

  private async executeCapabilityV2ById(session: TaskSession, capabilityId: string, input: Record<string, JsonValue>, agentStep?: CapabilityAgentStep) {
    this.assertCapabilityAllowed(capabilityId);
    const runtimeWindow = establishCompiledRuntimeWindow();
    const runtime = await this.getCapabilityV2Runtime(capabilityId, input, runtimeWindow);
    // Invalid tool arguments are recoverable before any browser action starts.
    assertCapabilityInput(runtime.contract.inputSchema as never, applyCapabilityV2InputAliases(runtime, input));
    return this.executeCapabilityV2JavaScriptRuntime(runtime, session, input, 0, {}, [], [], undefined, undefined, runtimeWindow, agentStep);
  }

  /**
   * A capability the main Agent chose is one step of the visitor's request,
   * not the whole of it. It used to end the task: "Add the cheapest table lamp
   * to my cart" ran a filter, and the visitor was told the task was complete
   * with nothing in the cart. Its result now goes back to the Agent as the
   * tool's receipt. When the Agent needs nothing more, the capability's own
   * result closes the task exactly as before; otherwise the Agent goes on.
   */
  private async continueAgentAfterCapability(
    session: TaskSession,
    step: CapabilityAgentStep,
    runtime: CapabilityV2RuntimeDefinition,
    receipt: { status: string; summary: string; output: Record<string, JsonValue> },
    activityId: string,
    input: Record<string, JsonValue>,
    settle: () => Promise<TaskResult>,
  ) {
    this.saveCheckpoint();
    this.status("adaptive", receipt.summary, { presentation: "tool", activity: { id: activityId, kind: "capability", state: "completed", sessionId: session.id, capabilityId: runtime.capabilityId, capabilityName: runtime.name, input, output: receipt.output } });
    const messages = [...step.messages, { role: "tool", tool_call_id: step.toolCallId, name: step.toolName, content: JSON.stringify({
      success: true, capability: runtime.name, status: receipt.status, summary: receipt.summary, output: receipt.output, url: location.href,
    }) }];
    try {
      return await this.runMainAgent(session, { messages, nextTurn: step.nextTurn, destination: location.href, capabilityResult: settle });
    } catch (error) {
      // The capability has acted. Rethrown, a failure to go on would reach the
      // loop that called it as a tool error, and that loop could run the same
      // capability again — a second item in the cart. What it did stands.
      if (this.activeAbort?.signal.aborted || this.handoffCommitted) throw error;
      return settle();
    }
  }

  /** Everything this run did to the page, oldest first, bounded for the payload. */
  private rememberRunPageActions(episode: TaskEpisode) {
    const actions = episode.experience?.actions || [];
    if (this.runPageActions?.runId !== episode.taskSessionId) {
      this.runPageActions = { runId: episode.taskSessionId, actions: [] };
    }
    const known = new Set(this.runPageActions.actions.map((item) => item.id));
    for (const action of actions) if (!known.has(action.id)) this.runPageActions.actions.push(action);
    // The payload has a size limit; the oldest actions are the ones a later
    // attempt is least likely to need.
    if (this.runPageActions.actions.length > RUN_PAGE_ACTION_LIMIT) {
      this.runPageActions.actions = this.runPageActions.actions.slice(-RUN_PAGE_ACTION_LIMIT);
    }
    return this.runPageActions.actions;
  }

  /** The Episode as the capability centre should read it: the run's own doing, not one attempt's. */
  private episodeWithRunEvidence(episode: TaskEpisode): TaskEpisode {
    const actions = this.runPageActions?.runId === episode.taskSessionId ? this.runPageActions.actions : [];
    if (!actions.length) return episode;
    const own = episode.experience;
    if (own && own.actions.length === actions.length) return episode;
    return {
      ...episode,
      experience: {
        ...(own || { version: 1 as const, actorSummary: episode.outcome.summary, judgeEvidence: [] }),
        actions,
      },
    };
  }

  private capabilityV2Experience(episode: TaskEpisode, output: Record<string, JsonValue>): CapabilityExperience | undefined {
    // The admission gates and the payload shape live in one shared function so
    // that the effect drawer can show exactly what this path would send. The
    // reason for a refusal only matters to the drawer; here, no payload means
    // nothing to submit.
    const handoff = capabilityHandoffForEpisode(this.episodeWithRunEvidence(episode), output);
    return handoff.delivered ? handoff.experience : undefined;
  }

  private submitCapabilityV2Experience(episode: TaskEpisode, output: Record<string, JsonValue>) {
    const experience = this.capabilityV2Experience(episode, output);
    const pointer = this.readRunPointer();
    if (!experience || !pointer || pointer.runId !== experience.agentRunId) return;
    const request = () => fetch(endpointUrl(this.options.endpoint, "/api/capability-v2/experiences"), {
      method: "POST",
      headers: {
        ...this.capabilityV2Headers(),
        authorization: `Bearer ${pointer.resumeToken}`,
        "idempotency-key": experience.episodeId,
      },
      body: JSON.stringify({ siteId: this.options.siteAgentId, sourceAgentRunId: experience.agentRunId, experience }),
      keepalive: true,
    });
    const drain = async (response: Response) => {
      // A fire-and-forget fetch still has to consume its response body. Leaving
      // the keepalive response unread can keep the HTTP exchange open in some
      // browsers and makes observability clients wait forever for completion.
      await response.arrayBuffer().catch(() => undefined);
      return response.status;
    };
    // The terminal answer is already visible. A model outage, duplicate, or
    // Runner problem must never turn background capability work into a user
    // error. One bounded retry covers a transient control-plane response.
    void request().then(async (response) => {
      const status = await drain(response);
      if (status < 500) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const retried = await request().catch(() => undefined);
      if (retried) await drain(retried);
    }).catch(() => undefined);
  }

  /**
   * One conversational Agent owns intent understanding and tool choice.  It
   * starts with typed capability tools plus explicit discovery/page tools; no
   * DOM is captured until the model deliberately selects operate_page.
   */
  // A pure "打开/进入 X" goal that maps unambiguously to one verified, zero-parameter
  // Scene is a knowledge-base fact, not a task: navigate to it deterministically with
  // no model turn, exactly like a zero-argument navigation capability. Parameterized or
  // ambiguous navigations still go through the model (the navigate_scene tool).
  private verifiedSceneForNavigation(goal: string): SceneDefinition | undefined {
    if (!isNavigationIntentGoal(goal)) return undefined;
    const command = normalizeGoal(goal).replace(/^(请|帮我|我要|我想|带我|麻烦)?(打开|查看|看看|看一下|进入|前往|去|跳转到)/, "");  // i18n-exempt:匹配用户目标里的祈使语，不是展示文案
    const key = command.replace(/(页面|页|功能|入口|界面|栏目|模块|列表|展示)$/g, "");  // i18n-exempt:匹配用户目标里的页面后缀，不是展示文案
    if (!key) return undefined;
    const matches = this.release.scenes.filter((scene) =>
      scene.directEntry === "verified"
      && !this.sceneRequiresLiveEntityClick(scene)
      && !scene.parameters.some((parameter) => parameter.required)
      && normalizeGoal(scene.name).replace(/(页面|页|功能|入口|界面|栏目|模块|列表|展示)$/g, "") === key);  // i18n-exempt:匹配场景名里的页面后缀，不是展示文案
    return matches.length === 1 ? matches[0] : undefined;
  }

  // Enter one verified Scene directly from the main Agent: build the URL from the
  // knowledge base, then either finish in place (already there) or hand off to the
  // destination document, which restores directAnswer and completes without ever
  // waking the page-reading Agent. Returns undefined when it cannot navigate (bad
  // URL / cross-origin), so callers fall back to the normal tool path.
  private enterVerifiedScene(session: TaskSession, scene: SceneDefinition, values: Record<string, JsonPrimitive>): Promise<TaskResult> | undefined {
    let destination: string;
    try { destination = buildSceneUrl(scene, values, location.origin); }
    catch { return undefined; }
    if (new URL(destination).origin !== location.origin) return undefined;
    const answer = this.say.enteredSceneViaKnowledge(scene.name);
    if (new URL(destination).href === location.href) return this.completeConversation(session, answer);
    this.saveCheckpoint({ sessionId: session.id, mode: "adaptive", phase: "navigating", input: session.input, operationIndex: 0, programStepIndex: 0, directAnswer: answer, savedAt: Date.now() });
    this.status("executing", this.say.enteringSceneViaKnowledge(scene.name), {
      navigating: true,
      activity: { id: `scene-nav:${session.id}`, kind: "knowledge", state: "running", sessionId: session.id, label: this.say.usingVerifiedEntry(scene.name), createdAt: new Date().toISOString() },
    });
    return this.navigateWithRun(destination).then((navigated) => {
      if (!navigated) return this.completeConversation(session, answer);
      return awaitPageHandoff();
    });
  }

  private async runMainAgent(session: TaskSession, continuation?: MainAgentContinuation): Promise<TaskResult | undefined> {
    const pageAgentRuntimeV2 = this.release.runtimeFeatures?.pageAgentRuntimeV2 === true;
    // Authority and completion requirements cannot depend on a rollout flag.
    const executionRequirement = executionRequirementForGoal(session.goal);
    const pageOperationRequired = executionRequirement.kind === "required";
    if (this.options.runtimeMode === "read-only" && pageOperationRequired && executionRequirement.effect !== "read") {
      return this.completeConversation(session, this.say.readOnlyModeNotice);
    }
    const relevantSceneIds = new Set<string>();
    const relevantCapabilityIds = new Set<string>();
    const rejectedCapabilityReasons = new Set<string>();
    const knowledgeReceiptRefs = new Set<string>();
    const invocable = userInvocableCapabilities(this.release).filter((capability) => this.capabilityAllowed(capability.id));
    const invocableIds = new Set(invocable.map((capability) => capability.id));
    const v2Candidates = new Map<string, CapabilityV2Candidate>();
    // A verified, exact static destination can still take the fast path. Goal
    // categories never remove tools: navigation can also be a published skill.
    const directNavigation = !continuation ? this.directNavigationCapability(session.goal) : undefined;
    const navigableScene = !continuation ? this.verifiedSceneForNavigation(session.goal) : undefined;
    if (directNavigation && this.capabilityAllowed(directNavigation.id)) {
      return this.executeCapability(directNavigation, session, {}, "compiled", undefined, 0, undefined, {}, undefined, true);
    }
    if (navigableScene) {
      const entered = this.enterVerifiedScene(session, navigableScene, {});
      if (entered) return entered;
    }
    // Prefetch only saves a tool round trip; search remains available to every goal.
    let catalogUnavailable = false;
    const initialV2 = classifyGoal(session.goal) !== "conversation"
      ? (await this.searchCapabilitiesV2([session.goal], { goal: session.goal, input: session.input }).catch(() => {
          catalogUnavailable = true;
          return [];
        })).filter((candidate) => this.capabilityAllowed(candidate.capabilityId))
      : [];
    if (classifyGoal(session.goal) !== "conversation") {
      this.status("adaptive", catalogUnavailable ? this.say.capabilityCatalogFailed : this.say.foundCandidates(initialV2.length), {
        presentation: "tool",
        activity: {
          id: `capability-prefetch:${session.id}:${continuation?.nextTurn || 0}`,
          kind: "capability-search", state: catalogUnavailable ? "failed" : "completed", sessionId: session.id,
          label: this.say.capabilityList, input: { goal: session.goal },
          output: catalogUnavailable ? { error: "capability_catalog_unavailable" } : { candidateCount: initialV2.length, candidateNames: initialV2.map(candidate => candidate.name) },
        },
      });
    }
    initialV2.forEach((candidate) => {
      v2Candidates.set(candidate.capabilityId, candidate);
      relevantCapabilityIds.add(candidate.capabilityId);
    });
    const normalizedGoal = normalizeGoal(session.goal);
    const exactV2Candidates = initialV2.filter((candidate) => [candidate.name, ...(candidate.aliases || [])]
      .some((phrase) => typeof phrase === "string" && normalizeGoal(phrase) === normalizedGoal));
    const exactV2 = exactV2Candidates.length === 1 ? exactV2Candidates[0] : undefined;
    const exactV2RequiredInputs = exactV2 && exactV2.contract.inputSchema && Array.isArray((exactV2.contract.inputSchema as { required?: unknown }).required)
      ? ((exactV2.contract.inputSchema as { required: unknown[] }).required).filter((key): key is string => typeof key === "string")
      : [];
    const missingExactV2Inputs = exactV2RequiredInputs.filter((key) => session.input[key] === undefined);
    if (!continuation && exactV2 && !missingExactV2Inputs.length) {
      return this.executeCapabilityV2ById(session, exactV2.capabilityId, session.input);
    }
    // A published intent is a sentence with holes; a request that is that
    // sentence with the holes filled names the capability as plainly as its
    // own title does, and says what to pass. Only one candidate may claim a
    // request this way — two sentences that both fit describe an ambiguity the
    // Agent should resolve, not a route.
    const templateV2Matches = continuation ? [] : initialV2.flatMap((candidate) => {
      const bound = matchCapabilityIntentTemplate(candidate.contract.intent, session.goal);
      const input = bound && this.capabilityV2InputFromTemplate(candidate, bound, session.input);
      return input ? [{ candidate, input }] : [];
    });
    // Fitting the sentence is not the same as being the best answer to it.
    // 「给我查看第五条热搜」 fits 「给我查看{{celebrityName}}热搜」 with 第五条 as the
    // name, and the capability that reads a rank off the list is plainly the
    // one meant — so the match may not be taken while the catalogue ranks
    // another candidate above it. A tie is not above.
    const bestV2Score = Math.max(0, ...initialV2.map((candidate) => candidate.score ?? 0));
    if (templateV2Matches.length === 1 && (templateV2Matches[0].candidate.score ?? 0) >= bestV2Score) {
      const [matched] = templateV2Matches;
      relevantCapabilityIds.add(matched.candidate.capabilityId);
      this.activeSession = { ...session, input: matched.input };
      return this.executeCapabilityV2ById(this.activeSession, matched.candidate.capabilityId, matched.input);
    }
    // Fuzzy recall is evidence for the Agent, not permission to execute.
    // Only an exact public name/alias may bind inputs without a model decision.
    const deterministicV2Candidate = exactV2;
    const deterministicV2Input = deterministicV2Candidate
      ? this.inferCapabilityV2Input(deterministicV2Candidate, session.goal, session.input)
      : undefined;
    if (!continuation && deterministicV2Candidate && deterministicV2Input) {
      this.activeSession = { ...session, input: deterministicV2Input };
      return this.executeCapabilityV2ById(this.activeSession, deterministicV2Candidate.capabilityId, deterministicV2Input);
    }
    const exactCandidate = exactCapabilityForGoal(this.release, session.goal);
    const exactCapability = exactCandidate && invocableIds.has(exactCandidate.id) ? exactCandidate : undefined;
    const missingExactInputs = exactCapability
      ? (exactCapability.inputs.required || []).filter((key) => session.input[key] === undefined)
      : [];
    if (exactCapability) relevantCapabilityIds.add(exactCapability.id);
    if (missingExactInputs.length) rejectedCapabilityReasons.add(`Exact capability ${exactCapability?.id || "unknown"} is missing inputs: ${missingExactInputs.join(", ")}`);
    // An exact published contract is already the routing decision. Calling a
    // model again can only add latency or incorrectly fall through to page
    // exploration, which used to create duplicate "AI generated" projects.
    if (!continuation && exactCapability && !missingExactInputs.length) {
      return this.executeCapability(exactCapability, session, session.input, "compiled", undefined, 0, undefined, {}, undefined, true);
    }
    const toolbox = this.capabilityToolbox(session.goal);
    const toolByName = new Map(toolbox.map((item) => [item.tool.function.name, item.capability]));
    const v2Toolbox = initialV2.slice(0, 8).map((candidate, index) => ({ candidate, tool: { type: "function", function: { name: `capability_v2_${index + 1}`, description: `Execute on the live website: ${candidate.name}. ${candidate.description}. This is an executable browser program, not stored knowledge or a cached result; it reads the current page and performs the contracted operation with the supplied inputs. Its result comes back to you; when the request needs more than this operation, continue with the next step. Contract: ${JSON.stringify({ intent: candidate.contract.intent, successConditions: candidate.contract.successConditions, scope: candidate.contract.scope, outputSchema: candidate.contract.outputSchema })}`.slice(0, 1800), parameters: candidate.contract.inputSchema || { type: "object", additionalProperties: true } } } }));
    const v2ToolByName = new Map(v2Toolbox.map((item) => [item.tool.function.name, item.candidate]));
    const tools = [
      { type: "function", function: { name: "ask_user", description: "Ask a concise question when necessary user input is missing or ambiguous. Do not guess required values.", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false } } },
      ...toolbox.map((item) => item.tool),
      ...v2Toolbox.map((item) => item.tool),
      { type: "function", function: { name: "search_capabilities", description: "Generate several short retrieval phrases, then search V2 and legacy published capability catalogs. The backend only performs character fuzzy recall; judge the returned contracts yourself.", parameters: { type: "object", properties: { query: { type: "string", description: "The original user goal" }, queries: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 12, description: "Short verbs, objects, phrases and synonyms generated for fuzzy recall" } }, required: ["query", "queries"], additionalProperties: false } } },
      { type: "function", function: { name: "call_capability", description: "Call a published capability returned by search_capabilities.", parameters: { type: "object", properties: { capabilityId: { type: "string", description: "Exact capability id returned by search_capabilities" }, input: { type: "object", description: "Input that conforms to the capability schema", additionalProperties: true } }, required: ["capabilityId", "input"], additionalProperties: false } } },
      { type: "function", function: { name: "search_site_knowledge", description: `Grep the site's scenes, internal operations, AND indexed page content (policy/help/about text) by a KEYWORD LIST — no live DOM read. ${KEYWORD_EXPANSION_GUIDANCE} Returns \`pages\` (each with \`matchedKeywords\`, and \`context\` = the page's ACTUAL indexed body text to answer from) and \`routes\` (scenes to navigate to), plus \`totalPagesWithHits\`. For an informational question, ANSWER DIRECTLY from the page text and cite the URL — do not open the page. If results are empty, retry ONCE OR TWICE with different/broader keywords; if too many pages hit (large totalPagesWithHits), add keywords to narrow. For page actions or live/dynamic data outside this index, choose a published capability whose contract covers the request, or operate_page for work not covered by a capability. Published capabilities execute against the live page, including current rankings.`, parameters: { type: "object", properties: { keywords: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 6, description: "The user's terms plus synonyms / site-specific wordings (2–6 items)" } }, required: ["keywords"], additionalProperties: false } } },
      { type: "function", function: { name: "read_page", description: "Read the FULL indexed text of ONE page by its exact URL (from a search_site_knowledge result). Use when the search `context` window is not enough to answer a detailed question. Reads only the stored index — never the live page.", parameters: { type: "object", properties: { url: { type: "string", description: "Exact page URL returned by search_site_knowledge" } }, required: ["url"], additionalProperties: false } } },
      { type: "function", function: { name: "navigate_scene", description: "Navigate to a verified entry returned by search_site_knowledge. This tool only changes location; it does not complete the user task. Continue with the original objective after arrival. Do not invent a scene id or parameter.", parameters: { type: "object", properties: { sceneId: { type: "string", description: "A verified scene id from search_site_knowledge" }, bindings: { type: "object", description: "Values for the scene's required parameters", additionalProperties: true } }, required: ["sceneId"], additionalProperties: false } } },
      pageAgentRuntimeV2
        ? { type: "function", function: { name: "operate_page", description: "General-purpose live browser observation and operation for work not covered by published capabilities or stored knowledge. Published capabilities also read and operate the live page; dynamic data does not by itself require this tool. Supply a structured execution brief. This tool cannot grant broader write authority than the user's original request. Do NOT use it merely to navigate to a verified scene.", parameters: { type: "object", properties: {
          objective: { type: "string", description: "The next page atom only; preserve the user's original objective and never present this hint as the completed task" },
          effect: { type: "string", enum: ["read", "reversible-write", "irreversible-write"], description: "Expected effect; runtime policy will narrow this when necessary" },
          entities: { type: "object", description: "Known entities and user-supplied values needed for execution", additionalProperties: true },
          completionCriteria: { type: "array", items: { type: "string" }, minItems: 1, description: "Observable criteria that prove completion" },
        }, required: ["objective", "effect", "entities", "completionCriteria"], additionalProperties: false } } }
        : { type: "function", function: { name: "operate_page", description: "General-purpose live browser observation and operation for work not covered by published capabilities or stored knowledge. Published capabilities also read and operate the live page; dynamic data does not by itself require this tool. Do NOT use it merely to navigate to a page a verified scene already covers — use navigate_scene for that.", parameters: { type: "object", properties: { objective: { type: "string", description: "The concrete objective to complete on the live page" } }, required: ["objective"], additionalProperties: false } } },
    ];
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: [
        "你是当前网站唯一的用户级主 Agent。像成熟的通用 Agent 一样直接回答或调用工具，不要把工作转交给虚构角色。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        "直接回答或按需选择工具，没有固定检索顺序。普通问候无需工具；网站事实应来自知识正文或实时观察。知识检索只返回线索，不能据此声称已操作网页。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        "已发布能力是操作当前真实网页的可执行程序，已注册为类型化工具，不是知识条目或缓存结果。它们可以读取实时榜单、绑定参数并完成点击和跨页操作，无需先用 operate_page 重做观察。若其契约完整覆盖当前目标，优先绑定用户参数调用，避免重复探索；参数值不同不代表需要新能力。候选数量和检索分数不证明适用性，缺少参数时用 ask_user 澄清。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        "导航、查询、跨页操作都可以使用能力。search_capabilities 可补充候选，search_site_knowledge/read_page 提供索引正文，operate_page 可获取实时事实并完成未覆盖的目标。知识没有结果不代表实时页面没有答案。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        "navigate_scene 只负责到达入口。进入首页、榜单页或详情页不自动代表原始目标完成；例如打开指定条目还需要定位该条目。导航后根据工具回执继续，不能用‘已进入首页’替代用户要求的结果。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        "需要操作时，最终答复必须有覆盖完整目标的执行回执。不要把中间步骤、计划、检索命中或工具自身成功当成任务成功。工具错误应按反馈修正参数、换工具或向用户说明，不能编造完成。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        "operate_page 的 objective 应保留原始目标及用户限制，不要只传中间入口步骤；completionCriteria 描述可观察的最终结果。实际页面路径由页面工具观察后决定。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        `调用 search_site_knowledge 时，${KEYWORD_EXPANSION_GUIDANCE} 正文足够时直接回答并引用 URL，正文不足可 read_page；需要动态信息时使用页面工具。`, // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        ...(catalogUnavailable ? ["能力目录预取失败，不代表没有已发布能力。可调用 search_capabilities 重试，或选择其他适用工具。"] : []), // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        ...(pageAgentRuntimeV2 ? [`执行权限上限：${JSON.stringify(executionRequirement)}。工具不能扩大用户授权。`] : []), // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        ...(knowledgeCanAnswerGoal(session.goal) ? ["这是查找、比较类目标：search_site_knowledge/read_page 返回的索引正文就是可用的结果来源。正文足以覆盖用户要求时，直接据此回答并引用 URL，不必再操作页面；个别商品缺少某项细节不妨碍作答，在回答中说明缺少什么即可。"] : []), // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        `当前页面：${typeof location !== "undefined" ? location.href : "unknown"}。这只是位置，不是任务完成证据。`, // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        `网站摘要：${this.release.profile?.name || this.options.siteAgentId}；${this.release.profile?.description || ""}`, // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        // Last, deliberately: as a standalone closing sentence this lands, where the
        // same requirement mid-list was read as an aside and the model answered in the
        // language of the page content instead.
        replyLanguageInstruction(this.replyLocale()),
      ].join("\n") },
      ...session.conversation.slice(-8).map((turn) => ({ role: turn.role, content: turn.content })),
    ];
    if (!messages.some((message) => message.role === "user" && message.content === session.goal)) messages.push({ role: "user", content: session.goal });
    if (continuation) {
      const arrived = location.href === continuation.destination;
      const lastTool = continuation.messages.at(-1);
      if (lastTool?.role === "tool" && lastTool.name === "navigate_scene") {
        lastTool.content = JSON.stringify({ success: arrived, destination: continuation.destination, actualUrl: location.href, taskComplete: false,
          instruction: arrived ? "Entry reached. Continue the original task." : "The destination differs from the requested entry. Reassess the current page before acting." });
      }
      this.activityTimeline = this.activityTimeline.map(item => item.sessionId === session.id && item.kind === "navigation" && item.state === "running"
        ? { ...item, state: arrived ? "completed" : "failed", detail: arrived ? this.say.enteredSceneCarryOn : this.say.arrivedElsewhere } : item);
      messages.splice(1, messages.length - 1, ...continuation.messages.filter((message) => message.role !== "system"));
      messages.push(continuation.capabilityResult
        ? { role: "system", content: `能力已执行完毕，结果见上一条工具回执；当前位置：${location.href}。原始任务：${session.goal}。回执已覆盖原始任务的全部要求时，不要再调用工具，也不要复述结果；还差步骤时（例如筛选后还要加入购物车），继续调用相应工具完成。` }  // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        : { role: "system", content: `导航已结束，实际当前位置：${location.href}；预期入口：${continuation.destination}。继续原始任务：${session.goal}。导航仅完成中间步骤，不得直接报告整体成功。` });  // i18n-exempt:给模型看的提示词正文，访客语言由 replyLanguageInstruction 单独告知
    }

    let lastSceneRoutingFailure: string | undefined;
    // A capability's receipt is not an entry: the Agent may close on it.
    const capabilityResult = continuation?.capabilityResult;
    let entryOnly = Boolean(continuation) && !capabilityResult;
    // A pure search is settled by an answer drawn from indexed page text once
    // that text has actually come back; see knowledgeCanAnswerGoal.
    const knowledgeMaySettle = knowledgeCanAnswerGoal(session.goal);
    let indexedTextReturned = false;
    let unreceiptedReplies = 0;
    let pageDetourDeclined = false;
    const MAIN_AGENT_TURNS = 8;
    const continueWithPageAgent = async (rawBrief: Record<string, JsonValue> = {}) => {
      const brief = pageAgentRuntimeV2 ? pageExecutionBrief({
        goal: session.goal,
        input: session.input,
        requirement: executionRequirement,
        objective: rawBrief.objective,
        effect: rawBrief.effect,
        entities: rawBrief.entities,
        completionCriteria: rawBrief.completionCriteria,
        relevantSceneIds: [...relevantSceneIds],
        relevantCapabilityIds: [...relevantCapabilityIds],
        rejectedCapabilityReasons: [...rejectedCapabilityReasons],
        knowledgeReceiptRefs: [...knowledgeReceiptRefs],
      }) : undefined;
      this.status("adaptive", this.say.startingPageTool, { activity: { id: `page-tool:${session.id}`, kind: "page", state: "running", label: this.say.viewAndOperate, input: { objective: typeof rawBrief.objective === "string" ? rawBrief.objective : session.goal, availableCapabilityIds: [...v2Candidates.keys()] } }, presentation: "tool" });
      // A capability miss is still a user task. PageAgent must finish it in
      // the user's current browser; capability construction is a silent,
      // post-completion control-plane concern.
      // Only a code-owned `required` classification can grant the interactive
      // runtime. An uncertain/not-required goal may use PageAgent as a live
      // read escape hatch, but a model-issued operate_page call cannot promote
      // that request into clicks, text entry, navigation, or submission.
      const runtimeModeOverride = pageAgentRuntimeV2 && executionRequirement.kind !== "required"
        ? "read-only" as const
        : undefined;
      return this.runAdaptive(session, "adaptive", 0, undefined, true, brief, undefined, undefined, runtimeModeOverride);
    };

    for (let turn = continuation?.nextTurn || 0; turn < MAIN_AGENT_TURNS; turn += 1) {
      this.assertTaskAlive(session.id);
      // Thinking is not a tool call. Keep it as lightweight state only; the
      // user-visible trace starts when a capability, knowledge lookup or page
      // tool is actually invoked.
      this.status("adaptive", turn ? this.say.continuingWithToolResults : this.say.understandingRequest, { presentation: "conversation-thinking" });
      const textSettles = !entryOnly && (!pageOperationRequired || (knowledgeMaySettle && indexedTextReturned));
      // A search that has its page text back is answered on the last turn, not
      // failed for having kept on looking; the model was gathering, not lost.
      const answerNow = knowledgeMaySettle && indexedTextReturned && !entryOnly && turn === MAIN_AGENT_TURNS - 1;
      if (answerNow) messages.push({ role: "system", content: "检索轮次已用完。现在只根据上面已取得的索引正文回答用户，不再调用工具；缺少的信息直接说明。" });  // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
      // After a capability step the visitor sees that capability's own result,
      // so the Agent's words are not streamed: they only decide whether to go on.
      const payload = await this.measureRuntime("model.choose-tool", () => this.completeMainAgentTurn(messages, tools, textSettles && !capabilityResult, answerNow ? "none" : "auto"));
      const message = payload.choices?.[0]?.message;
      const calls = message?.tool_calls?.slice(0, 1) || [];
      if (!calls.length && capabilityResult) return capabilityResult();
      if (!calls.length) {
        // An action goal needs a capability or page-execution receipt.
        // A model's text alone cannot prove the operation happened.
        if (!textSettles) {
          // Asked once already and still answering without a receipt: the
          // page tool is the path that produces one, so take it rather than
          // spend the remaining turns on the same refusal.
          unreceiptedReplies += 1;
          if (unreceiptedReplies >= 2) return continueWithPageAgent();
          messages.push({ role: "assistant", content: message?.content || "" });
          messages.push({ role: "system", content: "尚无完成原始目标的执行回执。请调用适用的能力或页面工具完成目标，缺少信息用 ask_user；不能把入口导航或计划作为成功答复。" });  // i18n-exempt:给模型看的提示词正文，访客语言由 replyLanguageInstruction 单独告知
          continue;
        }
        if (lastSceneRoutingFailure) {
          return this.completeConversation(session, this.say.unverifiedSceneOnly, {
            status: "execution-fault",
            code: "main_agent_scene_route_failed",
            summary: this.say.unverifiedSceneSummary,
            evaluatedAt: new Date().toISOString(),
            evidence: { source: "runtime", runtimeError: lastSceneRoutingFailure },
          });
        }
        return this.completeConversation(session, message?.content?.trim() || this.say.greeting);
      }
      messages.push({ role: "assistant", content: message?.content || "", tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name || "";
        let args: Record<string, JsonValue> = {};
        try { args = JSON.parse(call.function?.arguments || "{}") as Record<string, JsonValue>; } catch { /* invalid arguments become an empty input and are validated below */ }
        try {
          if (!tools.some(tool => tool.function.name === name)) throw new Error("tool_not_available");
          if (name === "ask_user") {
            const question = typeof args.question === "string" ? args.question.trim() : "";
            if (!question || !this.options.onAskUser) {
              messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ success: false, error: "question_unavailable" }) });
              continue;
            }
            const controller = this.activeAbort ||= new AbortController();
            const answer = await this.options.onAskUser(question, { signal: controller.signal });
            session.conversation.push({ role: "assistant", content: question, at: new Date().toISOString() }, { role: "user", content: answer, at: new Date().toISOString() });
            messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ answer }) });
            continue;
          }
          const v2Capability = v2ToolByName.get(name);
          if (v2Capability) {
            const input = applyCapabilityV2InputAliases(v2Capability, args);
            assertCapabilityInput(v2Capability.contract.inputSchema as never, input);
            this.activeSession = { ...session, input };
            return await this.executeCapabilityV2ById(this.activeSession, v2Capability.capabilityId, input, { messages, nextTurn: turn + 1, toolCallId: call.id || name, toolName: name });
          }
          const capability = toolByName.get(name);
          if (capability) {
            this.assertCapabilityInput(capability, args);
            this.activeSession = { ...session, input: args };
            return await this.executeCapability(capability, this.activeSession, args);
          }
          if (name === "call_capability") {
            const capabilityId = typeof args.capabilityId === "string" ? args.capabilityId : "";
            const capabilityInput = args.input && typeof args.input === "object" && !Array.isArray(args.input) ? args.input as Record<string, JsonValue> : {};
            const discoveredV2 = v2Candidates.get(capabilityId);
            if (discoveredV2) {
              const input = applyCapabilityV2InputAliases(discoveredV2, capabilityInput);
              assertCapabilityInput(discoveredV2.contract.inputSchema as never, input);
              this.activeSession = { ...session, input };
              return await this.executeCapabilityV2ById(this.activeSession, capabilityId, input, { messages, nextTurn: turn + 1, toolCallId: call.id || name, toolName: name });
            }
            const discovered = invocable.find((item) => item.id === capabilityId);
            if (!discovered) throw new Error("capability_not_available");
            this.assertCapabilityInput(discovered, capabilityInput);
            this.activeSession = { ...session, input: capabilityInput };
            return await this.executeCapability(discovered, this.activeSession, capabilityInput);
          }
          // A search whose page text is already back leaves for the live page
          // only if the model insists: a detour to fill one missing detail
          // turned a ten-second answer into minutes of browsing that never
          // returned. The first request is answered with the way back.
          if ((name === "navigate_scene" || name === "operate_page") && knowledgeMaySettle && indexedTextReturned && !pageDetourDeclined) {
            pageDetourDeclined = true;
            messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({
              success: false, error: "answer_from_indexed_text",
              instruction: "The indexed page text already returned is the result source for this search. Answer the user from it now, citing URLs, and say plainly which details the index does not contain. Call this tool again only if the indexed text cannot answer the request at all.",
            }) });
            continue;
          }
          if (name === "navigate_scene") {
            // A Scene only proves arrival. Preserve the main Agent loop so
            // the next tool can complete the original objective.
            const sceneId = typeof args.sceneId === "string" ? args.sceneId : "";
            const scene = this.release.scenes.find((item) => item.id === sceneId);
            if (scene) relevantSceneIds.add(scene.id);
            if (!scene || scene.directEntry !== "verified") {
              lastSceneRoutingFailure = "scene_direct_entry_unverified";
              messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({
                success: false,
                error: lastSceneRoutingFailure,
                instruction: "该入口只有观察证据，不能直接导航或报告成功；请选择其他已验证入口、搜索已发布能力，或调用 operate_page。",  // i18n-exempt:给模型看的提示词正文，访客语言由 replyLanguageInstruction 单独告知
              }) });
              continue;
            }
            const rawBindings = args.bindings && typeof args.bindings === "object" && !Array.isArray(args.bindings) ? args.bindings as Record<string, JsonValue> : {};
            const values = Object.fromEntries(Object.entries(rawBindings).flatMap(([key, value]) => ["string", "number", "boolean"].includes(typeof value) ? [[key, value as JsonPrimitive]] : []));
            const missing = scene.parameters.filter((parameter) => parameter.required && (values[parameter.id] === undefined || values[parameter.id] === ""));
            if (missing.length) {
              lastSceneRoutingFailure = "scene_binding_missing";
              messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ success: false, error: lastSceneRoutingFailure, required: missing.map((item) => ({ id: item.id, name: item.name })) }) });
              continue;
            }
            let destination: string;
            try {
              destination = buildSceneUrl(scene, values, location.origin);
              if (new URL(destination).origin !== location.origin) throw new Error("scene_origin_not_allowed");
            } catch {
              messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ success: false, error: "scene_navigation_unavailable" }) });
              continue;
            }
            lastSceneRoutingFailure = undefined;
            entryOnly = true;
            messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({
              success: true, sceneId, destination, taskComplete: false,
              instruction: "This is an entry point only. Continue the original objective; use a capability or the live page to verify the requested result.",
            }) });
            if (new URL(destination).href !== location.href) {
              // The address this run is about to stand on. A task answered by
              // entering the right parameterized route operates nothing, so
              // without this the run reaches the capability centre with no
              // evidence at all — and the route was the whole capability.
              this.recordEnteredRoute(session.id, { url: destination, sceneId, bindings: values, observedAt: new Date().toISOString() });
              this.saveCheckpoint({ sessionId: session.id, mode: "adaptive", phase: "navigating", input: session.input, operationIndex: 0, programStepIndex: 0,
                mainAgent: { messages, nextTurn: turn + 1, destination }, savedAt: Date.now() });
              this.status("executing", this.say.enteringScene(scene.name), { activity: {
                id: `scene:${session.id}:${turn}`, kind: "navigation", state: "running", sessionId: session.id, label: this.say.enterScene(scene.name),
              } });
              if (await this.navigateWithRun(destination)) return awaitPageHandoff();
              this.saveCheckpoint();
            }
            continue;
          }
          if (name === "operate_page") {
            return continueWithPageAgent(args);
          }
          if (name === "read_page") {
            // The Read step after a grep hit: full indexed text of one page (index-only).
            const url = typeof args.url === "string" ? args.url : "";
            const page = url ? await this.readPage(url) : null;
            if (page?.text) { entryOnly = false; lastSceneRoutingFailure = undefined; indexedTextReturned = true; }
            messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(page ? { success: true, url: page.url, text: page.text } : { success: false, error: "page_not_indexed" }) });
            continue;
          }
          // search_site_knowledge takes a KEYWORD LIST (synonym expansion is the model's
          // job); search_capabilities keeps its single query string.
          const keywords = name === "search_site_knowledge" && Array.isArray(args.keywords)
            ? (args.keywords as JsonValue[]).filter((keyword): keyword is string => typeof keyword === "string" && keyword.trim().length > 0)
            : [];
          const knowledgeKeywords = keywords.length ? keywords : [session.goal];
          const query = typeof args.query === "string" ? args.query : session.goal;
          const retrievalQueries = Array.isArray(args.queries) ? args.queries.filter((item): item is string => typeof item === "string" && Boolean(item.trim())) : [];
          const lookupTerm = name === "search_site_knowledge" ? knowledgeKeywords.join(" ") : query;
          const lookupKey = `${name}:${normalizeGoal(lookupTerm)}`;
          const repeatedLookup = messages.some((entry) => entry.role === "tool" && entry.name === name && String(entry.content || "").includes(`\"lookupKey\":\"${lookupKey}\"`));
          if (repeatedLookup) {
            // Return feedback to the Agent instead of choosing its next tool.
            // The previous successful result remains available in the transcript.
            messages.push({
              role: "tool", tool_call_id: call.id, name,
              content: JSON.stringify({ success: false, lookupKey, error: "lookup_already_completed", instruction: "Use the previous lookup result; do not query again." }),
            });
            continue;
          }
          const knowledgeActivity: AgentRunActivity = {
            id: `${name}:${session.id}:${turn}`,
            kind: name === "search_capabilities" ? "capability-search" : "knowledge",
            state: "running",
            sessionId: session.id,
            label: name === "search_capabilities" ? this.say.searchPublishedCapabilities : this.say.queryKnowledge,
            input: name === "search_capabilities" ? { query } : { keywords: knowledgeKeywords },
            createdAt: new Date().toISOString(),
          };
          this.status("adaptive", name === "search_capabilities" ? this.say.searchingCapabilities : this.say.searchingKnowledge, { activity: knowledgeActivity, presentation: "tool" });
          let totalPagesWithHits = 0;
          let lookupUnavailable = false;
          let exactV2FromLookup: CapabilityV2Candidate | undefined;
          const result = name === "search_capabilities"
            ? await (async () => {
              const v2 = (await this.searchCapabilitiesV2(retrievalQueries.length ? [query, ...retrievalQueries] : [query], { goal: session.goal, input: session.input }).catch(() => {
                lookupUnavailable = true;
                return [];
              })).filter((candidate) => this.capabilityAllowed(candidate.capabilityId));
              v2.forEach((candidate) => v2Candidates.set(candidate.capabilityId, candidate));
              // The model may search with a shortened phrase (for example
              // “关于我们”) even though the user's original goal exactly names
              // one published capability.  Preserve the typed candidate so the
              // code-owned router can invoke it without another model turn.
              const exactMatches = v2.filter((candidate) => [candidate.name, ...(candidate.aliases || [])]
                .some((phrase) => typeof phrase === "string" && normalizeGoal(phrase) === normalizedGoal));
              exactV2FromLookup = exactMatches.length === 1 ? exactMatches[0] : undefined;
              const legacy = rankPublishedCapabilities({ ...this.release, capabilities: invocable }, query, 20)
                .filter(({ capability }) => invocableIds.has(capability.id))
                .map(({ capability, score }) => ({ id: capability.id, name: capability.name, description: capability.description, inputs: capability.inputs, outputs: capability.outputs, score, source: "legacy" }));
              return [...v2.map((candidate) => ({ id: candidate.capabilityId, name: candidate.name, description: candidate.description, intent: candidate.contract.intent, successConditions: candidate.contract.successConditions, scope: candidate.contract.scope, inputs: candidate.contract.inputSchema || { type: "object" }, outputs: candidate.contract.outputSchema || { type: "object" }, score: candidate.score, source: "v2" })), ...legacy].slice(0, 30);
            })()
            : await (async () => {
              const structure = this.searchKnowledge(knowledgeKeywords);
              const content = await this.searchContentPassages(knowledgeKeywords);
              totalPagesWithHits = content.totalPagesWithHits;
              if (content.items.length) indexedTextReturned = true;
              // Lead with content when a page body answers the question so the model
              // answers from that text directly, instead of latching onto a scene route
              // (which reads as "go navigate there"). No content hit → structure as before.
              return content.items.length ? [...content.items, ...structure] : structure;
            })();
          if (lookupUnavailable) {
            rejectedCapabilityReasons.add("Published capability catalog unavailable; coverage unknown");
            this.status("adaptive", this.say.capabilityCatalogUnavailable, {
              activity: { ...knowledgeActivity, state: "failed", output: { error: "capability_catalog_unavailable" } },
            });
            // No lookupKey: an unsuccessful request must remain retryable.
            messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({
              success: false, error: "capability_catalog_unavailable", retryable: true,
              result, instruction: "Catalog lookup failed; these results may be incomplete. This is not evidence that no capability exists. Retry or choose another suitable tool.",
            }) });
            continue;
          }
          if (name === "search_capabilities") {
            for (const item of result) {
              const id = typeof (item as { id?: unknown }).id === "string" ? String((item as { id?: string }).id) : "";
              if (id) relevantCapabilityIds.add(id);
            }
            if (!result.length) rejectedCapabilityReasons.add(`No published capability matched: ${lookupTerm}`);
          } else {
            for (const item of result) {
              const value = item as { id?: unknown; url?: unknown; sceneId?: unknown; type?: unknown; kind?: unknown };
              const sceneId = typeof value.sceneId === "string"
                ? value.sceneId
                : ["scene", "route"].includes(String(value.type || value.kind || "")) && typeof value.id === "string" ? value.id : "";
              if (sceneId) relevantSceneIds.add(sceneId);
              const receiptRef = typeof value.id === "string" ? value.id : typeof value.url === "string" ? value.url : "";
              if (receiptRef) knowledgeReceiptRefs.add(receiptRef);
            }
            if (!result.length) rejectedCapabilityReasons.add(`No site knowledge matched: ${lookupTerm}`);
          }
          this.status("adaptive", name === "search_capabilities" ? this.say.foundCapabilities : this.say.gotKnowledge, {
            activity: {
              ...knowledgeActivity,
              state: "completed",
              output: {
                matches: result.length,
                ...(name === "search_capabilities"
                  ? {
                      candidates: result.slice(0, 20).map((item) => {
                        const value = item as {
                          id?: string;
                          name?: string;
                          description?: string;
                          score?: number;
                        };
                        return {
                          id: value.id || "",
                          name: value.name || value.id || this.say.fallbackCapabilityName,
                          description: value.description || "",
                          score: Number(value.score || 0),
                        };
                      }),
                    }
                  : {}),
                searchResultRefs: result.slice(0, 8).map((item) => {
                  const value = item as {
                    id?: string;
                    name?: string;
                    title?: string;
                    type?: string;
                    kind?: string;
                  };
                  return {
                    id: value.id || value.name || value.title || "knowledge-match",
                    label: value.name || value.title || value.id || this.say.knowledgeMatch,
                    type: value.type || value.kind || (name === "search_capabilities" ? "capability" : "knowledge"),
                  };
                }),
              },
            },
            presentation: "tool",
          });
          if (name === "search_capabilities" && exactV2FromLookup) {
            const required = exactV2FromLookup.contract.inputSchema && Array.isArray((exactV2FromLookup.contract.inputSchema as { required?: unknown }).required)
              ? ((exactV2FromLookup.contract.inputSchema as { required: unknown[] }).required).filter((key): key is string => typeof key === "string")
              : [];
            const missing = required.filter((key) => session.input[key] === undefined || session.input[key] === "");
            if (!missing.length) {
              this.activeSession = { ...session, input: session.input };
              return await this.executeCapabilityV2ById(this.activeSession, exactV2FromLookup.capabilityId, session.input);
            }
          }
          messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(name === "search_site_knowledge" ? { lookupKey, result, totalPagesWithHits } : { lookupKey, result }) });
        } catch (error) {
          if (this.activeAbort?.signal.aborted || this.handoffCommitted) throw error;
          const lastMessage = messages.at(-1);
          if (lastMessage?.role === "tool" && lastMessage.tool_call_id === call.id) messages.pop();
          if (this.readCheckpoint()?.mainAgent) this.saveCheckpoint();
          messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({
            success: false, error: error instanceof Error ? error.message.slice(0, 500) : "tool_failed",
            instruction: "Correct input or tool availability problems. If an operation may have started, verify the current state before retrying; do not blindly repeat writes or report success.",
          }) });
        }
      }
    }
    if (capabilityResult) return capabilityResult();
    if (lastSceneRoutingFailure) throw new Error(`main_agent_scene_route_failed:${lastSceneRoutingFailure}`);
    throw new Error("main_agent_turn_limit");
  }

  private async loadAdaptive() {
    const loaded = () => window.SiteWakeAdaptive;
    const already = loaded();
    if (already) return already;
    this.adaptivePromise ||= new Promise<AdaptiveGlobal>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = this.options.adaptiveUrl; script.async = true; script.dataset.sitewakeAgent = "adaptive";
      script.onload = () => { const global = loaded(); return global ? resolve(global) : reject(new Error("adaptive_bundle_invalid")); };
      script.onerror = () => reject(new Error("adaptive_bundle_load_failed"));
      document.head.appendChild(script);
    });
    return this.adaptivePromise;
  }

  private async runAdaptive(
    session: TaskSession,
    mode: "adaptive" | "repair",
    repairAttempt = 0,
    resumeTrace?: AdaptiveTrace,
    backgroundCapabilityExperience = false,
    brief?: PageExecutionBrief,
    budget?: PageExecutionBudget,
    sourceCapabilityId?: string,
    runtimeModeOverride?: "read-only" | "full",
    executionIntent?: "reconciliation" | "confirmed-continuation",
  ): Promise<TaskResult> {
    // The exploratory bundle is intentionally lazy-loaded.  A full document
    // navigation therefore has a short, real bootstrap window before the
    // PageAgent can issue its first model turn.  Make that window explicit:
    // without an activity the widget looked idle on the destination document
    // even though the same AgentRun was already being restored.
    const resumedWithWork = Boolean(resumeTrace && (resumeTrace.actions.length || resumeTrace.toolReceipts?.length));
    const recoveryActivity = {
      id: `restore:${session.id}:${documentId()}`,
      kind: "reasoning" as const,
      state: "running" as const,
      label: resumedWithWork ? this.say.resumeAndRead : this.say.readingPage,
    };
    this.status(
      "adaptive",
      mode === "repair"
        ? this.say.knownPathBrokenRepairing
        : resumedWithWork
          ? this.say.resumedReadingPage
          : this.say.newGoalInPage,
      { activity: recoveryActivity },
    );
    const checkpointBase = { sessionId: session.id, mode, input: session.input, operationIndex: 0, programStepIndex: 0, backgroundCapabilityExperience, pageExecutionBrief: brief, pageExecutionBudget: budget, sourceCapabilityId, runtimeModeOverride, executionIntent } as const;
    this.saveCheckpoint({ ...checkpointBase, phase: "running", adaptiveTrace: resumeTrace, savedAt: Date.now() });
    const adaptive = await this.loadAdaptive();
    const requiredActionEvidence = executionIntent === "reconciliation"
      ? undefined
      : explicitlyRequiresPageOperation(session.goal)
      ? /(?:搜索|search\b)/iu.test(session.goal.normalize("NFKC")) ? "input" as const : "material" as const  // i18n-exempt:匹配用户目标里的搜索词，不是展示文案
      : undefined;
    const agentRunToken = this.requireAgentRunToken(session.id);
    const runtimeV2 = this.release.runtimeFeatures?.pageAgentRuntimeV2 === true;
    const evidenceV2 = this.release.runtimeFeatures?.pageAgentEvidenceV2 === true;
    const observationOutbox: PageAgentObservation[] = [];
    let latestAdaptiveTrace = resumeTrace;
    const drainObservations = async () => {
      if (!evidenceV2 || !observationOutbox.length) return;
      while (observationOutbox.length) {
        // Server contracts cap a batch at four observations and the complete
        // JSON request at 512 KiB. Build a bounded prefix without reordering.
        const batch: PageAgentObservation[] = [];
        for (const observation of observationOutbox.slice(0, 4)) {
          const candidate = [...batch, observation];
          const bytes = new TextEncoder().encode(JSON.stringify({ siteAgentId: this.options.siteAgentId, observations: candidate })).byteLength;
          if (bytes > 512 * 1024) break;
          batch.push(observation);
        }
        if (!batch.length) throw new Error("page_observation_request_too_large");
        // The queue is the only copy that survives a transient request failure.
        // Remove a prefix only after the server has acknowledged that exact
        // prefix; network errors, aborts and non-2xx responses leave it intact.
        const response = await fetchWithTimeout(endpointUrl(this.options.endpoint, `/api/agent-runs/${encodeURIComponent(session.id)}/page-observations`), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${agentRunToken}` },
          body: JSON.stringify({ siteAgentId: this.options.siteAgentId, observations: batch }),
        }, 10_000);
        if (!response.ok) throw new Error(`page_observation_persist_failed:${response.status}`);
        await response.arrayBuffer().catch(() => undefined);
        observationOutbox.splice(0, batch.length);
      }
    };
    const result = await adaptive.run({
      // Keep the immutable user goal as the Episode/AgentRun identity. The
      // brief objective is an internal execution instruction and is already
      // supplied to executeActorRound below; using it here changes the
      // TaskEpisode.goal after a page handoff and makes the authenticated
      // Episode fail the AgentRun identity check.
      siteAgentId: this.options.siteAgentId, endpoint: this.options.endpoint, maxSteps: this.options.maxSteps, goal: session.goal, input: session.input,
      agentRunToken, domReplay: this.options.domReplay, runtimeMode: runtimeModeOverride || this.options.runtimeMode,
      // A site-configured read-only policy outranks anything the runtime infers:
      // the end user may lift a wrong guess, never the site owner's setting.
      readOnlySource: this.options.runtimeMode === "read-only" ? "site-config" : runtimeModeOverride === "read-only" ? "runtime-derived" : undefined,
      pageEpoch: this.activeRun?.pageEpoch || this.runPointer?.pageEpoch || 1,
      runtimeV2, evidenceV2,
      pageExecutionBrief: brief, pageExecutionBudget: budget,
      release: { ...this.release, capabilities: userInvocableCapabilities(this.release) },
      session, mode, repairAttempt, requiredActionEvidence, onStatus: (next) => this.status(next.phase, next.message, next.detail), resumeTrace,
      onTrace: (adaptiveTrace) => {
        latestAdaptiveTrace = adaptiveTrace;
        this.saveCheckpoint({ ...checkpointBase, phase: "running", adaptiveTrace, pageExecutionBudget: adaptiveTrace.budgetEvidence || budget, savedAt: Date.now() });
      },
      onBeforeNavigationAction: async () => {
        // A full-document navigation destroys this in-memory queue. Evidence
        // referenced by the cross-page checkpoint must therefore be durable
        // before the navigation grant is armed.
        await drainObservations();
        await this.armNavigationIntent();
      },
      onNavigateAction: async (url, target, route) => {
        // An address entered by the page Agent is the same evidence as one
        // entered by the main Agent; record it before the handoff commits.
        if (route) this.recordEnteredRoute(session.id, route);
        // Do not report a click as handed off until its server checkpoint and
        // one-shot continuation token exist. This closes the old race where a
        // PageAgent returned a never-settling promise while an asynchronous
        // navigation silently failed in the background.
        // Some navigation paths (for example an adapter-handled anchor) enter
        // here directly, so keep the persistence barrier in both hooks.
        await drainObservations();
        return this.navigateWithRun(url, target);
      },
      onAskUser: this.options.onAskUser,
      onObservation: evidenceV2 ? (observation) => { observationOutbox.push(observation); } : undefined,
      onDrainObservations: evidenceV2 ? drainObservations : undefined,
      callCapability: async (capabilityId, capabilityInput, adaptiveTrace) => {
        const capability = userInvocableCapabilities(this.release)
          .find((item) => item.id === capabilityId);
        if (!capability) throw new Error("capability_not_available");
        // The same user-facing Agent already understands the request and owns
        // clarification. Do not invoke a second "parameter binder" model here.
        // Missing fields are returned to that Agent, which can ask the user.
        const resolvedInput = { ...session.input, ...capabilityInput };
        this.assertCapabilityInput(capability, resolvedInput);
        const toolContext: CapabilityToolContext = { parentMode: mode, adaptiveTrace, backgroundCapabilityExperience, pageExecutionBrief: brief, pageExecutionBudget: adaptiveTrace.budgetEvidence || budget, sourceCapabilityId, runtimeModeOverride, executionIntent };
        const toolResult = await this.executeCapability(capability, session, resolvedInput, "repair", undefined, 0, undefined, {}, toolContext);
        if (!toolResult) return awaitPageHandoff();
        return { success: toolResult.success, text: toolResult.text, output: toolResult.output, outcome: toolResult.outcome };
      },
    });
    const reconciliationStatus = executionIntent === "reconciliation" ? reconciliationStatusFor(result) : undefined;
    const reconciledOutcome: TaskEpisode["outcome"] = reconciliationStatus === "completed"
      ? { ...result.episode.outcome, status: "success", code: "reconciliation_completed", summary: result.episode.outcome.summary || this.say.reconciliationCompleted }
      : reconciliationStatus === "not-completed"
        ? { ...result.episode.outcome, status: "no-result", code: "reconciliation_not_completed", summary: result.episode.outcome.summary || this.say.reconciliationNotCompleted }
        : reconciliationStatus === "unknown"
          ? { ...result.episode.outcome, status: "unknown", code: "reconciliation_unknown", summary: this.say.reconciliationUnknown }
          : result.episode.outcome;
    // Read once the run is over: both Agents write addresses into the stored
    // checkpoint, and the checkpoint is what survived the handoffs.
    const enteredRoutes = this.enteredRoutesFor(session.id);
    const episode: TaskEpisode = {
      ...result.episode,
      outcome: executionIntent
        ? { ...reconciledOutcome, evidence: { ...reconciledOutcome.evidence, executionIntent, ...(reconciliationStatus ? { reconciliationStatus } : {}) } }
        : reconciledOutcome,
      pageExecutionBrief: result.episode.pageExecutionBrief || brief,
      // What the run actually did is evidence whatever the run was for. This
      // read the intent instead of the trace, so only a reconciliation kept
      // its record: an ordinary task — 我想看周杰伦的热搜 — threw away every
      // click, every receipt and every observation it had just made, the
      // episode reached the capability centre saying it had touched nothing,
      // and no capability was ever generated from real use.
      // An address the run entered is evidence on its own. A task finished by
      // going to the right parameterized route operates nothing, so requiring
      // an action here threw away the site's most reusable capability: the
      // route itself.
      experience: (enteredRoutes.length
        || latestAdaptiveTrace?.observationRefs?.length
        || latestAdaptiveTrace?.actionReceiptsV2?.length
        || latestAdaptiveTrace?.actions?.length)
        ? {
            version: 1,
            actions: latestAdaptiveTrace?.actions || [],
            ...(enteredRoutes.length ? { routes: enteredRoutes } : {}),
            actorSummary: result.text,
            judgeEvidence: [result.episode.endSnapshot.url, result.episode.endSnapshot.heading || result.episode.endSnapshot.title].filter(Boolean),
            toolReceipts: latestAdaptiveTrace?.toolReceipts,
            actionReceiptsV2: latestAdaptiveTrace?.actionReceiptsV2 || [],
            observationRefs: latestAdaptiveTrace?.observationRefs,
            budgetEvidence: latestAdaptiveTrace?.budgetEvidence || budget,
            runtimeMetrics: latestAdaptiveTrace?.runtimeMetrics || [],
          }
        : result.episode.experience,
      sourceCapabilityId: result.episode.sourceCapabilityId || sourceCapabilityId,
      repairKind: result.episode.repairKind || (sourceCapabilityId && mode === "repair" ? "compiled-capability-drift" : undefined),
    };
    return this.ingestEpisode(episode, result.output, mode, false, backgroundCapabilityExperience);
  }

  private async runExecutionFollowup(
    goal: string,
    input: Record<string, JsonValue>,
    intent: "reconciliation" | "confirmed-continuation",
    sourceTaskId: string,
  ) {
    if (this.taskInFlight) throw new Error("task_already_running");
    await this.ready();
    await this.refresh();
    if (this.release.runtimeFeatures?.pageAgentRuntimeV2 !== true) throw new Error("page_agent_runtime_v2_disabled");
    if (this.taskInFlight) throw new Error("task_already_running");
    const sourceToken = this.requireAgentRunToken(sourceTaskId);
    this.claimExecutionFollowup(sourceTaskId, intent);
    this.taskInFlight = true;
    const generation = ++this.taskGeneration;
    this.activeAbort = new AbortController();
    let session: TaskSession | undefined;
    try {
      // Reconciliation and confirmed continuation are deliberately new Runs,
      // never a continuation directive on the exhausted Run.
      session = await this.createSession(goal, input, [], { sourceTaskId, intent, sourceToken });
      this.taskGenerations.set(session.id, generation);
      if (!this.acquireLease(session.id)) throw new Error("task_active_in_another_page");
      const originalRequirement = executionRequirementForGoal(goal);
      const requirement: ExecutionRequirement = intent === "reconciliation"
        ? { kind: "required", effect: "read", evidence: "page-action", reasons: ["user-requested-read-only-reconciliation"] }
        : originalRequirement;
      const brief = pageExecutionBrief({
        goal,
        input,
        requirement,
        objective: intent === "reconciliation"
          ? `Read-only reconciliation: verify whether the current page already shows that this objective completed: ${goal}. Do not click, type, submit, navigate, or mutate page state. In done.output return reconciliationStatus as exactly "completed", "not-completed", or "unknown". Use "not-completed" only when the page explicitly proves the requested outcome did not occur; absence of proof is "unknown".`
          : goal,
        completionCriteria: intent === "reconciliation"
          ? [`Report only what the current page can prove about the original objective: ${goal}`, "Perform no page mutation during this reconciliation."]
          : undefined,
      });
      return await this.runAdaptive(
        session,
        "adaptive",
        0,
        undefined,
        false,
        brief,
        intent === "reconciliation" ? { ...RECONCILIATION_BUDGET } : { ...CONFIRMED_CONTINUATION_BUDGET },
        undefined,
        intent === "reconciliation" ? "read-only" : undefined,
        intent,
      );
    } catch (error) {
      if (generation !== this.taskGeneration) return this.stoppedTaskResult();
      if (!session) throw error;
      const raw = error instanceof Error ? error.message : String(error);
      const summary = intent === "reconciliation"
        ? this.say.reconciliationIncomplete
        : this.say.confirmedStepTechnicalIssue;
      const outcome: TaskEpisode["outcome"] = {
        status: "execution-fault",
        code: "page_execution_followup_failed",
        summary,
        evaluatedAt: new Date().toISOString(),
        evidence: { source: "runtime", runtimeError: raw, executionIntent: intent, ...(intent === "reconciliation" ? { reconciliationStatus: "unknown" } : {}) },
      };
      let failedSession = session;
      try { failedSession = await this.patchSession(session.id, { status: "failed", checkpoint: null }); }
      catch { /* AgentRun remains the terminal authority. */ }
      const result: TaskResult = { success: false, mode: "adaptive", interaction: "exploration", text: summary, output: {}, outcome, session: failedSession, release: this.release };
      this.status("error", summary, { taskResult: result });
      await this.finishRun("failed", outcome, {}, summary, session.id).catch(() => undefined);
      this.releaseLease(session.id);
      return result;
    } finally {
      if (generation === this.taskGeneration) this.taskInFlight = false;
    }
  }

  /** Start one bounded, read-only Run to reconcile an exhausted task. */
  async reconcile(goal: string, input: Record<string, JsonValue> = {}, sourceTaskId = "") {
    return this.runExecutionFollowup(goal, input, "reconciliation", sourceTaskId);
  }

  /** Start one bounded new Run after the user explicitly confirms continuation. */
  async continueAfterConfirmation(goal: string, input: Record<string, JsonValue> = {}, sourceTaskId = "") {
    return this.runExecutionFollowup(goal, input, "confirmed-continuation", sourceTaskId);
  }

  async run(goal: WebAgentTaskInput["goal"], input: WebAgentTaskInput["input"] = {}, conversation: WebAgentTaskInput["conversation"] = []) {
    if (this.taskInFlight) throw new Error("task_already_running");
    this.runtimeTimings = [];
    try { await this.ready(); } catch (error) { throw new AgentStartupError("readiness", error); }
    // A page can remain open across multiple control-plane deployments.  The
    // executable Release cached by that already-running SDK must not choose a
    // tool or navigate before it has checked the current runtime Release.
    // Refresh at the task boundary as well as at SDK startup so a stale tab can
    // never perform one old action and only become correct after navigation.
    try { await this.refresh(); } catch (error) { throw new AgentStartupError("release", error); }
    if (this.taskInFlight) throw new Error("task_already_running");
    this.taskInFlight = true;
    const generation = ++this.taskGeneration;
    this.activeAbort = new AbortController();
    try {
      // One main Agent owns direct replies and tool selection. Published
      // capabilities are normal typed tools; DOM access is an explicit tool,
      // never a mandatory preflight scan.
      let session: TaskSession;
      try { session = await this.createSession(goal, input, conversation); }
      catch (error) { throw new AgentStartupError("create", error); }
      this.taskGenerations.set(session.id, generation);
      if (!this.acquireLease(session.id)) throw new Error("task_active_in_another_page");
      return await this.runMainAgent(session);
    } catch (error) {
      if (error instanceof AgentStartupError) throw error;
      // This task was stopped (or superseded) while a request was in flight.
      // Its late failure belongs to nobody: `this.activeSession` may already be
      // the *next* task's, and marking that one failed is exactly what turned a
      // user's "stop, then ask again" into "aborted during startup" in production.
      if (generation !== this.taskGeneration) return this.stoppedTaskResult();
      // Creating an AgentRun is itself a state transition.  Never leave that
      // Run silently "running" when a client-side router/metadata fault occurs
      // before the first tool activity: persist a terminal receipt and emit a
      // user-visible, actionable reason instead of relying on the widget's
      // generic catch-all message.
      const session = this.activeSession;
      if (!session) throw error;
      const raw = error instanceof Error ? error.message : String(error);
      const { code, summary } = agentStartupFailure(raw);
      let failedSession = session;
      try { failedSession = await this.patchSession(session.id, { status: "failed", checkpoint: null }); }
      catch { /* AgentRun remains authoritative if the legacy learning projection is unavailable. */ }
      const outcome: TaskEpisode["outcome"] = {
        status: "execution-fault", code,
        summary, evaluatedAt: new Date().toISOString(), evidence: { source: "runtime", runtimeError: raw },
      };
      const result: TaskResult = { success: false, mode: "adaptive", interaction: "conversation", text: summary, output: {}, outcome, session: failedSession, release: this.release };
      const activity: AgentRunActivity = {
        id: `result:${session.id}:${this.activeRun?.pageEpoch || 0}`, kind: "result", state: "failed", sessionId: session.id,
        label: this.say.taskNotDone, detail: summary, createdAt: new Date().toISOString(),
      };
      this.status("error", summary, { taskResult: result, activity });
      await this.finishRun("failed", outcome, {}, summary, session.id).catch(() => undefined);
      this.releaseLease(session.id);
      return result;
    } finally { if (generation === this.taskGeneration) this.taskInFlight = false; }
  }

  private async callCapability(
    capabilityId: string,
    input: Record<string, JsonValue>,
    trustedTaskLaunch: boolean,
    executionPin?: TaskLaunchExecutionPin,
  ) {
    if (this.taskInFlight) throw new Error("task_already_running");
    this.runtimeTimings = [];
    await this.ready();
    const trustedExecutionPin = trustedTaskLaunch
      ? this.executionPinFrom(executionPin || {})
      : undefined;
    if (trustedTaskLaunch && !trustedExecutionPin) {
      throw new Error("task_launch_execution_pin_incomplete");
    }
    const previousExecutionPin = this.executionPin;
    if (trustedExecutionPin) this.executionPin = trustedExecutionPin;
    try {
      await this.refresh(trustedExecutionPin?.releaseId);
    } catch (error) {
      this.executionPin = previousExecutionPin;
      throw error;
    }
    if (this.taskInFlight) {
      this.executionPin = previousExecutionPin;
      throw new Error("task_already_running");
    }
    this.taskInFlight = true;
    const generation = ++this.taskGeneration;
    try {
      const catalog = trustedTaskLaunch ? this.release.capabilities : userInvocableCapabilities(this.release);
      let capability = catalog.find((item) => item.id === capabilityId && ["available", "improving"].includes(item.status));
      if (!capability && trustedTaskLaunch && capabilityId.startsWith("navigation-tool:")) {
        const toolId = capabilityId.slice("navigation-tool:".length);
        const tool = (this.release.navigationTools || []).find((item) => item.id === toolId);
        const adapter = tool ? transientNavigationToolCapability(tool) : undefined;
        if (adapter && ["available", "improving"].includes(adapter.status)) capability = adapter;
      }
      if (!capability && trustedTaskLaunch && capabilityId.startsWith("operation:")) {
        const operation = this.release.operations.find((item) => item.id === capabilityId.slice("operation:".length) && ["verified", "published"].includes(item.status));
        if (operation) capability = {
          id: capabilityId, kind: "navigation", resultKind: "page", exposure: "internal", name: operation.name,
          description: operation.description || operation.name, normalizedGoal: normalizeGoal(operation.name), goalTemplate: operation.name,
          aliases: [], inputs: operation.inputs, outputs: operation.outputs, outcomes: [],
          plans: [{ id: `runtime_${operation.id}`, entrySceneIds: operation.fromSceneId === "*" ? ["*"] : [operation.fromSceneId], steps: [{ operationId: operation.id, bindings: {} }], outputBindings: {} }],
          sourceEpisodeIds: [], confidence: 1, status: "available", updatedAt: operation.updatedAt,
        };
      }
      if (!capability) throw new Error("capability_not_available");
      this.assertCapabilityInput(capability, input);
      const session = await this.createSession(capability.name, input);
      this.taskGenerations.set(session.id, generation);
      if (!this.acquireLease(session.id)) throw new Error("task_active_in_another_page");
      return await this.executeCapability(capability, session, input, "compiled", undefined, 0, undefined, {}, undefined, true);
    } finally {
      if (generation === this.taskGeneration) this.taskInFlight = false;
      if (!this.readCheckpoint()) this.executionPin = previousExecutionPin;
    }
  }

  async call(capabilityId: string, input: Record<string, JsonValue> = {}) {
    return this.callCapability(capabilityId, input, false);
  }

  /**
   * Run an unpublished candidate exactly as a visitor's run would go: this
   * executor, a real AgentRun, real handoffs across documents. Validation used
   * to prove a program only in its own Playwright host, which followed links
   * the widget held back, filled defaults the widget left out and never
   * resumed across a document; three published capabilities hung or looped
   * for visitors. The terminal result is left under VALIDATION_RESULT_KEY for
   * the runner, on whichever document the run ends. Nothing is learned from
   * it: no drift repair, no episode.
   */
  async validateCandidate(runtime: CapabilityV2RuntimeDefinition, input: Record<string, JsonValue> = {}) {
    if (this.taskInFlight) throw new Error("task_already_running");
    await this.ready();
    if (this.taskInFlight) throw new Error("task_already_running");
    this.taskInFlight = true;
    this.validationRun = true;
    try { sessionStorage.removeItem(VALIDATION_RESULT_KEY); } catch { /* ignored */ }
    const generation = ++this.taskGeneration;
    this.activeAbort = new AbortController();
    try {
      const session = await this.createSession(runtime.name, input);
      this.taskGenerations.set(session.id, generation);
      if (!this.acquireLease(session.id)) throw new Error("task_active_in_another_page");
      const runtimeWindow = establishCompiledRuntimeWindow();
      assertCapabilityInput(runtime.contract.inputSchema as never, applyCapabilityV2InputAliases(runtime, input));
      return await this.executeCapabilityV2JavaScriptRuntime(runtime, session, input, 0, {}, [], [], undefined, undefined, runtimeWindow);
    } catch (error) {
      this.status("error", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (generation === this.taskGeneration) this.taskInFlight = false;
    }
  }

  /** Execute a V2 shortcut directly, without asking the model to rediscover it. */
  async callV2(capabilityId: string, capabilityName: string, input: Record<string, JsonValue> = {}) {
    if (this.taskInFlight) throw new Error("task_already_running");
    await this.ready();
    if (this.taskInFlight) throw new Error("task_already_running");
    this.taskInFlight = true;
    const generation = ++this.taskGeneration;
    this.activeAbort = new AbortController();
    try {
      const session = await this.createSession(capabilityName, input);
      this.taskGenerations.set(session.id, generation);
      if (!this.acquireLease(session.id)) throw new Error("task_active_in_another_page");
      return await this.executeCapabilityV2ById(session, capabilityId, input);
    } finally {
      if (generation === this.taskGeneration) this.taskInFlight = false;
    }
  }

  async teach(goal: string) {
    assertRuntimeTeachingAllowed(this.options.runtimeMode);
    await this.ready();
    if (this.demonstration) throw new Error("demonstration_already_running");
    const session = await this.createSession(goal, {});
    this.demonstration = { goal, session, startedAt: new Date().toISOString(), start: capturePageSnapshot(this.sequence++), steps: [], targets: new Map() };
    this.saveDemonstration();
    this.reportDemonstration(this.say.recordingStarted);
  }

  async finishTeaching() {
    assertRuntimeTeachingAllowed(this.options.runtimeMode);
    const teaching = this.demonstration;
    if (!teaching || !teaching.steps.length) throw new Error("demonstration_empty");
    this.demonstration = undefined;
    this.saveDemonstration();
    const end = capturePageSnapshot(this.sequence++);
    const targets = teaching.targets;
    const actions = teaching.steps.map((step) => {
      const targetId = "targetId" in step ? step.targetId : undefined;
      const target = targetId ? targets.get(targetId) : undefined;
      const value = "value" in step ? resolveValue(step.value, { input: {}, state: {}, step: {} }) : undefined;
      return {
        id: step.id,
        action: step.op === "click" || step.op === "fill" || step.op === "select" || step.op === "scroll" ? step.op : "unknown" as const,
        rawAction: step.op,
        input: (value === undefined ? {} : { value }) as Record<string, JsonValue>,
        element: target ? {
          tag: target.attributes.tag || "unknown",
          role: target.role,
          accessibleName: target.accessibleNames[0],
          label: target.locatorVariants.find((item) => item.strategy === "label")?.value,
          placeholder: target.locatorVariants.find((item) => item.strategy === "placeholder")?.value,
          name: target.locatorVariants.find((item) => item.strategy === "name")?.value,
          href: target.attributes.href,
          attributes: target.attributes,
          cssPath: target.locatorVariants.find((item) => item.strategy === "css")?.value,
        } : undefined,
        page: { url: teaching.start.url, title: teaching.start.title, heading: teaching.start.heading },
        observedAt: end.capturedAt,
      };
    });
    const episode: TaskEpisode = { schemaVersion: SITE_AGENT_SCHEMA_VERSION, id: uid("episode"), siteAgentId: this.options.siteAgentId, taskSessionId: teaching.session.id, browserSessionId: browserSessionId(), documentId: teaching.start.documentId, mode: "demonstration", goal: teaching.goal, normalizedGoal: normalizeGoal(teaching.goal), input: {}, startedAt: teaching.startedAt, endedAt: end.capturedAt, releaseId: this.release.id, startSnapshot: teaching.start, endSnapshot: end, transitions: [], outcome: { status: "success", code: "demonstrated", summary: this.say.demonstrated(teaching.goal), evaluatedAt: end.capturedAt, evidence: {} }, experience: { version: 1, actions, actorSummary: this.say.demonstratedActions(teaching.steps.length), judgeEvidence: [teaching.start.url, end.url] } };
    return this.ingestEpisode(episode, {}, "demonstration");
  }

  /** The quiet result of a task that was stopped while it was still running: no
   * receipt, no status event, nothing written to whichever task is current now. */
  private stoppedTaskResult(): TaskResult {
    const outcome: TaskEpisode["outcome"] = { status: "execution-fault", code: "cancelled", summary: this.say.taskStopped, evaluatedAt: new Date().toISOString(), evidence: {} };
    return { success: false, mode: "adaptive", interaction: "conversation", text: this.say.taskStopped, output: {}, outcome, session: { status: "cancelled" } as TaskSession, release: this.release };
  }

  cancel() {
    const pointer = this.readRunPointer();
    const sessionId = this.activeSession?.id || pointer?.runId;
    if (sessionId) this.cancelledSessionIds.add(sessionId);
    this.activeAbort?.abort();
    window.SiteWakeAdaptive?.cancel?.();
    // Revoke every local continuation synchronously before asking the service
    // to cancel. A late navigation/new document can therefore never resurrect
    // the Run from sessionStorage while the network request is in flight.
    this.clearNavigationIntent(true);
    this.saveCheckpoint();
    this.saveRunPointer();
    this.releaseLease(sessionId);
    this.activeRun = undefined;
    this.activeSession = undefined;
    // The stopped task may still be unwinding its aborted network calls. Its
    // `finally` must not clear the flag of the *next* task, and the next task
    // must not be refused with task_already_running — or reuse an already
    // aborted controller — while it does. Same bookkeeping as resetConversation.
    this.activeAbort = undefined;
    this.taskGeneration += 1;
    this.taskInFlight = false;
    if (pointer) void this.cancelInterruptedRun(pointer);
    this.demonstration = undefined;
    this.saveDemonstration();
  }

  /** End one conversation without letting its asynchronous cancellation touch
   * the next Run. Used by the UI's explicit "new conversation" action. */
  async resetConversation() {
    const pointer = this.readRunPointer();
    const sessionId = this.activeSession?.id || pointer?.runId;
    if (sessionId) this.cancelledSessionIds.add(sessionId);
    this.activeAbort?.abort();
    window.SiteWakeAdaptive?.cancel?.();
    this.releaseLease(sessionId);
    this.clearNavigationIntent(true);
    this.saveCheckpoint();
    this.saveRunPointer();
    this.activeRun = undefined;
    this.activeSession = undefined;
    this.activeAbort = undefined;
    this.activityTimeline = [];
    this.taskGeneration += 1;
    this.taskInFlight = false;
    this.demonstration = undefined;
    this.saveDemonstration();
    if (pointer) await this.cancelInterruptedRun(pointer);
  }

  private installObserver() {
    const nativeOpen = this.nativeWindowOpen;
    const navigate = (rawUrl: string, target = "_self") => {
      const checkpoint = this.readCheckpoint();
      const pointer = this.readRunPointer();
      if (this.activeRun?.controller === "script" && this.remoteCommand && pointer) {
        const openedWindow = target === "_blank" ? nativeOpen("about:blank", "_blank") : undefined;
        void this.remoteHandoff(rawUrl, target, openedWindow).catch((error) => {
          openedWindow?.close();
          void this.completeRemoteCommand(this.remoteCommand!, undefined, error);
        });
        return openedWindow || true;
      }
      if (!checkpoint || !pointer || pointer.runId !== checkpoint.sessionId) return false;
      if (this.sameDocumentDestination(rawUrl)) {
        this.applySameDocumentDestination(rawUrl);
        this.status("executing", this.say.movedWithinPage, { navigating: false });
        return false;
      }
      // A Stage that may navigate clicks links the way the explorer did, and
      // validation runs it in a browser where those links simply go. Held
      // back here, the click never navigated, the Stage waited for the page
      // to change, and every published capability that opens a link sat at
      // "running" for the visitor until its deadline. The continuation armed
      // before the Stage resumes the run on the destination; an SPA route
      // change stays in this document and the Stage sees it.
      if (checkpoint.v2Runtime && this.capabilityNavigationDeferred && this.capabilityStageNavigates) {
        this.capabilityNavigationStarted = true;
        return false;
      }
      const openedWindow = target === "_blank" ? nativeOpen("about:blank", "_blank") : undefined;
      if (checkpoint.v2Runtime && this.capabilityNavigationDeferred) {
        if (this.pendingCapabilityNavigation) {
          openedWindow?.close();
          return false;
        }
        this.capabilityNavigationStarted = true;
        this.pendingCapabilityNavigation = { rawUrl, target, openedWindow };
        return openedWindow || true;
      }
      this.capabilityNavigationStarted = true;
      void this.navigateWithRun(rawUrl, target, openedWindow).catch((error) => {
        openedWindow?.close();
        this.status("error", error instanceof Error ? error.message : String(error), { navigationFailed: true });
      });
      return openedWindow || true;
    };
    window.__SiteWakeNavigate = navigate;
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      const handled = url && window.__SiteWakeNavigate?.(new URL(String(url), location.href).toString(), target || "_blank");
      if (handled) return handled === true ? window : handled;
      return nativeOpen(url, target, features);
    }) as typeof window.open;
    const appendAdaptiveTrace = (snapshot: ReturnType<typeof capturePageSnapshot>, evidence: ReturnType<typeof evidenceFromElement>, input?: JsonValue) => {
      const checkpoint = this.readCheckpoint();
      if (!checkpoint || (checkpoint.mode !== "adaptive" && checkpoint.mode !== "repair") || checkpoint.capability || checkpoint.candidate) return;
      const target = targetFromEvidence(evidence, recognizeScene(this.release.scenes, snapshot)?.sceneId);
      const step: PageProgramStep = input === undefined
        ? { id: uid("step"), op: "click", targetId: target.id, timeoutMs: 8_000 }
        : { id: uid("step"), op: evidence.tag === "select" ? "select" : "fill", targetId: target.id, value: { source: "literal", value: input }, timeoutMs: 8_000 };
      const trace = checkpoint.adaptiveTrace || { startedAt: new Date().toISOString(), startSnapshot: snapshot, steps: [], targets: [], actions: [] };
      const previous = trace.steps.at(-1);
      const duplicate = previous?.op === step.op && "targetId" in previous && previous.targetId === target.id;
      this.saveCheckpoint({
        ...checkpoint,
        adaptiveTrace: {
          ...trace,
          steps: duplicate ? trace.steps : [...trace.steps, step],
          targets: trace.targets.some((item) => item.id === target.id) ? trace.targets : [...trace.targets, target],
          actions: duplicate ? trace.actions : [...trace.actions, { id: step.id, action: input === undefined ? "click" : evidence.tag === "select" ? "select" : "fill", rawAction: step.op, input: input === undefined ? {} : { value: input }, element: evidence, page: { url: snapshot.url, title: snapshot.title, heading: snapshot.heading }, observedAt: new Date().toISOString() }],
        },
        savedAt: Date.now(),
      });
    };
    const complete = () => {
      const pending = this.observationStart;
      if (!pending) return;
      this.observationStart = undefined;
      this.persistPendingObservation();
      const end = capturePageSnapshot(this.sequence++);
      void this.submitObservation(pending, end).catch(() => undefined);
    };
    document.addEventListener("click", (event) => {
      if (eventBelongsToSiteAgent(event)) return;
      if (!this.passiveObservationAllowed()) return;
      const element = actionableFromEvent(event);
      if (!element) return;
      const evidence = evidenceFromElement(element);
      const snapshot = capturePageSnapshot(this.sequence++);
      appendAdaptiveTrace(snapshot, evidence);
      if (this.demonstration) {
        const target = targetFromEvidence(evidence, recognizeScene(this.release.scenes, snapshot)?.sceneId);
        this.demonstration.targets.set(target.id, target);
        this.demonstration.steps.push({ id: uid("step"), op: "click", targetId: target.id, timeoutMs: 8_000 });
        this.saveDemonstration();
        this.reportDemonstration(`${this.say.demoClick} · ${evidence.accessibleName || evidence.label || evidence.href || evidence.tag}`);
      }
      this.observationStart = { snapshot, startedAt: new Date().toISOString(), evidence };
      this.persistPendingObservation(this.observationStart);
      setTimeout(complete, 700);
      const anchor = element.closest<HTMLAnchorElement>("a[href]");
      if (anchor && this.readCheckpoint()) {
        // Same-document links still need their native event suppressed (a
        // reload would destroy this AgentPort), but they must not be marked as
        // a cross-document handoff.  Other links are intercepted only when the
        // run hook actually accepted the navigation.
        if (this.sameDocumentDestination(anchor.href)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          this.applySameDocumentDestination(anchor.href);
          this.status("executing", this.say.movedWithinPage, { navigating: false });
        } else {
          const handled = window.__SiteWakeNavigate?.(anchor.href, anchor.target || "_self");
          if (handled) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        }
      }
    }, true);
    document.addEventListener("submit", (event) => {
      if (eventBelongsToSiteAgent(event) || event.defaultPrevented) return;
      if (!this.passiveObservationAllowed()) return;
      const form = event.target instanceof HTMLFormElement ? event.target : undefined;
      if (!form) return;
      const submitter = event.submitter instanceof HTMLElement ? event.submitter : undefined;
      // Framework-owned search forms routinely omit `action` and call
      // preventDefault() in their own handler. Intercepting them in capture
      // phase replaced that client-side search with a native submission to the
      // current URL, which looked like a mysterious jump back to the home
      // page. Only own explicit, native GET navigations after application
      // handlers have had a chance to cancel the event.
      const explicitAction = submitter?.getAttribute("formaction") || form.getAttribute("action");
      const method = (submitter?.getAttribute("formmethod") || form.getAttribute("method") || "get").toLowerCase();
      if (this.activeRun?.controller === "script" && this.remoteCommand) {
        if (method !== "get") return;
        const destination = new URL(explicitAction || location.href, location.href);
        const data = new FormData(form);
        if (submitter instanceof HTMLButtonElement && submitter.name) data.set(submitter.name, submitter.value);
        destination.search = new URLSearchParams([...data.entries()].map(([key, value]) => [key, String(value)])).toString();
        const target = submitter?.getAttribute("formtarget") || form.target || "_self";
        const openedWindow = target === "_blank" ? this.nativeWindowOpen("about:blank", "_blank") : undefined;
        this.remoteNavigationStarted = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        void this.remoteHandoff(destination.toString(), target, openedWindow).catch((error) => {
          openedWindow?.close();
          void this.completeRemoteCommand(this.remoteCommand!, undefined, error);
        });
        return;
      }
      const checkpoint = this.readCheckpoint();
      if (!checkpoint || !explicitAction || method !== "get") return;
      if (checkpoint.v2Runtime && this.capabilityNavigationDeferred && this.capabilityStageNavigates) return;
      const action = new URL(explicitAction, location.href).toString();
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = submitter?.getAttribute("formtarget") || form.target || "_self";
      const openedWindow = target === "_blank" ? this.nativeWindowOpen("about:blank", "_blank") : undefined;
      if (checkpoint.v2Runtime && this.capabilityNavigationDeferred) {
        if (this.pendingCapabilityNavigation) {
          openedWindow?.close();
          return;
        }
        const destination = new URL(action, location.href);
        const data = new FormData(form);
        if (submitter instanceof HTMLButtonElement && submitter.name) data.set(submitter.name, submitter.value);
        destination.search = new URLSearchParams([...data.entries()].map(([key, value]) => [key, String(value)])).toString();
        this.capabilityNavigationStarted = true;
        this.pendingCapabilityNavigation = { rawUrl: destination.toString(), target, openedWindow };
        return;
      }
      void this.prepareRunHandoff(action).then((handoffUrl) => {
        form.action = handoffUrl;
        HTMLFormElement.prototype.submit.call(form);
      }).catch((error) => this.status("error", error instanceof Error ? error.message : String(error), { navigationFailed: true }));
    });
    // A search box is the most ordinary thing on a website and the least
    // likely to fire `change`: a framework-controlled input reports `input`,
    // its own handler keeps the value, and pressing Enter navigates before any
    // blur. A demonstration of 「给我搜索周杰伦」 recorded nothing at all and
    // the console asked the person to go and do the task they had just done.
    // Enter in a field is a step, and what was in the field is the step before
    // it when nothing else recorded it.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      if (eventBelongsToSiteAgent(event)) return;
      if (!this.passiveObservationAllowed()) return;
      const element = actionableFromEvent(event);
      if (!element || element instanceof HTMLSelectElement) return;
      const value = "value" in element ? String((element as HTMLInputElement).value) : "";
      const evidence = evidenceFromElement(element);
      const snapshot = capturePageSnapshot(this.sequence++);
      appendAdaptiveTrace(snapshot, evidence, value);
      if (this.demonstration) {
        const target = targetFromEvidence(evidence, recognizeScene(this.release.scenes, snapshot)?.sceneId);
        this.demonstration.targets.set(target.id, target);
        const steps = this.demonstration.steps;
        const filled = steps.some((step) => "targetId" in step && step.targetId === target.id && step.op === "fill");
        if (value && !filled) steps.push({ id: uid("step"), op: "fill", targetId: target.id, value: { source: "literal", value }, timeoutMs: 8_000 });
        steps.push({ id: uid("step"), op: "press", targetId: target.id, key: "Enter", timeoutMs: 8_000 });
        this.saveDemonstration();
        this.reportDemonstration(`${this.say.demoEnter} · ${evidence.accessibleName || evidence.label || evidence.placeholder || evidence.tag}`);
      }
      this.observationStart = { snapshot, startedAt: new Date().toISOString(), evidence, input: value };
      this.persistPendingObservation(this.observationStart);
      setTimeout(complete, 700);
    }, true);
    document.addEventListener("change", (event) => {
      if (eventBelongsToSiteAgent(event)) return;
      if (!this.passiveObservationAllowed()) return;
      const element = actionableFromEvent(event);
      if (!element) return;
      const value = "value" in element ? String((element as HTMLInputElement).value) : "";
      const evidence = evidenceFromElement(element);
      const snapshot = capturePageSnapshot(this.sequence++);
      appendAdaptiveTrace(snapshot, evidence, value);
      if (this.demonstration) {
        const target = targetFromEvidence(evidence, recognizeScene(this.release.scenes, snapshot)?.sceneId);
        this.demonstration.targets.set(target.id, target);
        this.demonstration.steps.push({ id: uid("step"), op: element instanceof HTMLSelectElement ? "select" : "fill", targetId: target.id, value: { source: "literal", value }, timeoutMs: 8_000 });
        this.saveDemonstration();
        this.reportDemonstration(`${element instanceof HTMLSelectElement ? this.say.demoSelect : this.say.demoFill} · ${evidence.accessibleName || evidence.label || evidence.placeholder || evidence.tag}`);
      }
      this.observationStart = { snapshot, startedAt: new Date().toISOString(), evidence, input: value };
      this.persistPendingObservation(this.observationStart);
      setTimeout(complete, 400);
    }, true);
  }
}

const portGlobal = { version: "2.0.0", create(options: PortOptions) { return new AgentPort(options); } };
window.SiteWakePort = portGlobal;
