import { PageAgentCore, tool, type AgentActivity, type AgentStepEvent, type PageAgentTool } from "@page-agent/core";
import type { BrowserState } from "@page-agent/page-controller";
import * as z from "zod/v4";
import {
  SITE_AGENT_SCHEMA_VERSION,
  normalizeGoal,
  stableHash,
  type ActionReceiptV2,
  EXPERIENCE_PAGE_ACTIONS,
  type ExperienceActionEvidence,
  type ExperienceRouteEvidence,
  type JsonPrimitive,
  type JsonValue,
  type PageAgentObservation,
  type PageExecutionBrief,
  type PageExecutionBudget,
  type PageObservationRef,
  type PageProgramStep,
  type PageRuntimeMetric,
  type SiteAgentReleaseV2,
  type TargetSpec,
  type TaskEpisode,
  type TaskSession,
} from "../lib/site-knowledge/protocol";
import { buildSceneUrl, recognizeScene } from "../lib/site-knowledge/url-scene";
import { buildSiteKnowledgeContext, userInvocableCapabilities } from "../lib/site-knowledge/site-knowledge";
import { searchKnowledgeIndex } from "../lib/site-knowledge/planner";
import { assessPageExecutionEvidence } from "../lib/site-knowledge/execution-evidence";
import { deriveGoalSemanticFrame, semanticActionSummary } from "../lib/site-knowledge/goal-semantics";
import { isReadOnlyNavigationClick } from "../lib/site-knowledge/runtime-policy";
import { awaitPageHandoff, browserSessionId, capturePageSnapshot, documentId, evidenceFromElement, humanInteractionBlacklist, isSensitiveElement, targetFromEvidence, uid } from "./user-agent-shared";
import { SiteAgentPageController, type SiteAgentPageControllerSeed } from "./user-agent-page-controller";
import { resolveWidgetLocale, widgetCopy } from "./user-agent-copy";
import { startDomReplayRecorder } from "./user-agent-recorder";

type AdaptiveOptions = {
  siteAgentId: string;
  endpoint: string;
  agentRunToken: string;
  domReplay?: boolean;
  runtimeMode?: "full" | "read-only";
  /**
   * Why this run is read-only. Only a runtime-derived judgement may be lifted
   * by asking the user; a site-configured policy may not.
   */
  readOnlySource?: "site-config" | "runtime-derived";
  pageEpoch?: number;
  runtimeV2?: boolean;
  evidenceV2?: boolean;
  maxSteps: number;
  goal: string;
  input: Record<string, JsonValue>;
  release: SiteAgentReleaseV2;
  session: TaskSession;
  mode: "adaptive" | "repair";
  /** Minimum proof required before an explicit operation may report Success. */
  requiredActionEvidence?: "material" | "input";
  pageExecutionBrief?: PageExecutionBrief;
  pageExecutionBudget?: PageExecutionBudget;
  /**
   * Legacy repair retry counter. NOT dead: it is a closed loop that bounds the
   * pre-runtime-V2 retry path, which is the path production still runs.
   *
   *   compiler emits { attempt: attempt + 1 }
   *     -> port passes it back in as repairAttempt
   *     -> written to outcome.evidence.repairAttempt below
   *     -> compiler reads it and stops once it reaches 2
   *
   * Removing it makes the counter permanently 0, which turns that retry into an
   * unbounded loop. Delete only after runtime V2 is fully rolled out.
   */
  repairAttempt?: number;
  onStatus?: (status: { phase: "adaptive"; message: string; detail?: Record<string, unknown> }) => void;
  resumeTrace?: {
    episodeId?: string;
    startedAt: string;
    startSnapshot: ReturnType<typeof capturePageSnapshot>;
    steps: PageProgramStep[];
    targets: TargetSpec[];
    actions: ExperienceActionEvidence[];
    toolReceipts?: ToolReceipt[];
    actionReceiptsV2?: ActionReceiptV2[];
    observationRefs?: PageObservationRef[];
    budgetEvidence?: PageExecutionBudget;
    runtimeMetrics?: PageRuntimeMetric[];
  };
  onTrace?: (trace: NonNullable<AdaptiveOptions["resumeTrace"]>) => void;
  onAskUser?: (question: string, options?: {
    signal: AbortSignal;
    choices?: Array<{ label: string; value: string }>;
  }) => Promise<string>;
  onObservation?: (observation: PageAgentObservation) => void | Promise<void>;
  onDrainObservations?: () => void | Promise<void>;
  /**
   * Persist the detachable Agent state before a browser action that may cause
   * an opaque framework/location navigation. The destination URL does not
   * need to be known in advance.
   */
  onBeforeNavigationAction?: () => Promise<void>;
  /**
   * Hand a concrete same-site link to the persistent Run runtime. Agent-driven
   * clicks must not rely on a synthetic DOM event reaching the global click
   * observer: component libraries are allowed to stop or replace that event.
   */
  /**
   * A concrete link is a transaction boundary.  This is deliberately async:
   * the runtime must durably hand the Run to the destination *before* the
   * browser leaves the current document.  Returning a bare boolean here used
   * to leave the actor suspended forever if that asynchronous handoff failed.
   */
  onNavigateAction?: (url: string, target: string, route?: ExperienceRouteEvidence) => boolean | Promise<boolean>;
  callCapability?: (capabilityId: string, input: Record<string, JsonValue>, trace: NonNullable<AdaptiveOptions["resumeTrace"]>) => Promise<{
    success: boolean;
    text: string;
    output: Record<string, JsonValue>;
    outcome: TaskEpisode["outcome"];
  }>;
};

type ToolReceipt = NonNullable<NonNullable<TaskEpisode["experience"]>["toolReceipts"]>[number];

type RuntimeEvidence = {
  actionReceipts: ActionReceiptV2[];
  observationRefs: PageObservationRef[];
  observations: PageAgentObservation[];
  runtimeMetrics: PageRuntimeMetric[];
  budget: PageExecutionBudget;
  startedAt: number;
  pausedAt?: number;
  pauseDepth: number;
  /** Never shifted by pauses; the anchor for the wall clock. */
  wallStartedAt: number;
  /** Completed user-answer waits, excluded from the wall clock. */
  wallExcludedMs: number;
  /** Start of the current user-answer wait, if one is open. */
  askUserStartedAt?: number;
  /** Start of the current uninterrupted background stretch, if the page is hidden. */
  hiddenSince?: number;
  /**
   * Outcome of the one-off request to operate the page while in read-only mode.
   * Scoped to this run only: it is never persisted and never applies elsewhere.
   */
  readOnlyAuthorization?: { answer: "granted" | "refused"; question: string; decidedAt: string };
  lastObservation?: PageAgentObservation;
  controllerSeed?: SiteAgentPageControllerSeed;
  humanConfirmation?: {
    question: string;
    answer: "success" | "failed" | "unknown";
    confirmedAt: string;
  };
};

const ACTIVE_LIMIT_MS = 180_000;
const MODEL_REQUEST_LIMIT = 100;
// PageAgent uses a separate fetch hook from the main router. Keep the same
// real-provider spacing here so a multi-step exploration cannot burst into a
// 429 even when every request is otherwise within the task budget.
const MODEL_REQUEST_MIN_INTERVAL_MS = 1_500;
let nextModelRequestAt = 0;

async function waitForModelRequestSlot() {
  const spacingMs = Math.max(0, nextModelRequestAt - Date.now());
  if (spacingMs) await new Promise((resolve) => setTimeout(resolve, spacingMs));
  nextModelRequestAt = Date.now() + MODEL_REQUEST_MIN_INTERVAL_MS;
}

function providerRetryAfterMs(response: Response) {
  const value = response.headers.get("retry-after") || response.headers.get("x-ratelimit-reset-requests");
  if (!value) return 3_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    const delay = seconds > 10_000 ? Math.max(0, seconds * 1_000 - Date.now()) : seconds * 1_000;
    return Math.min(30_000, Math.max(1_000, delay));
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(30_000, Math.max(1_000, timestamp - Date.now())) : 3_000;
}
const NO_PROGRESS_LIMIT = 3;
export const MAX_EVIDENCE_CORRECTIONS = 1;
/**
 * Wall-clock ceiling for one task. `ACTIVE_LIMIT_MS` only bounds time the
 * runtime considers itself busy, and every wait suspends it — which is why a
 * task could previously hang for minutes with no limit in sight. Twice the
 * active limit leaves room for page loads, retries and brief tab switches.
 */
export const WALL_LIMIT_MS = 360_000;
/**
 * One continuous stretch of the page being in the background. Beyond this the
 * user has almost certainly moved on, so waiting out the full wall clock only
 * delays telling them.
 */
export const BACKGROUND_WAIT_LIMIT_MS = 90_000;
/** One wait for an answer the runtime explicitly asked the user for. */
export const ASK_USER_LIMIT_MS = 180_000;
/**
 * Floor for deadlines derived from the remaining budget. Without it a nearly
 * exhausted budget collapses the deadline towards zero and even an instant
 * operation is reported as a timeout.
 */
export const RUNTIME_DEADLINE_FLOOR_MS = 2_000;

export function elapsedBudget(runtime: RuntimeEvidence, now = Date.now()) {
  runtime.budget.activeElapsedMs = Math.max(runtime.budget.activeElapsedMs, (runtime.pausedAt || now) - runtime.startedAt);
  if (runtime.budget.activeElapsedMs >= runtime.budget.activeLimitMs) runtime.budget.exhaustedReason ||= "active-time";

  // The wall clock ignores every pause except an open user-answer wait: the
  // user is present and working on our question, so charging them for it would
  // cut off people who are cooperating.
  const openAskUserMs = runtime.askUserStartedAt ? Math.max(0, now - runtime.askUserStartedAt) : 0;
  const wallLimitMs = runtime.budget.wallLimitMs;
  runtime.budget.wallElapsedMs = Math.max(0, now - runtime.wallStartedAt - runtime.wallExcludedMs - openAskUserMs);
  if (wallLimitMs && runtime.budget.wallElapsedMs >= wallLimitMs) runtime.budget.exhaustedReason ||= "wall-clock";

  const backgroundLimitMs = runtime.budget.backgroundWaitLimitMs;
  runtime.budget.backgroundWaitMs = runtime.hiddenSince ? Math.max(0, now - runtime.hiddenSince) : 0;
  if (backgroundLimitMs && runtime.budget.backgroundWaitMs >= backgroundLimitMs) runtime.budget.exhaustedReason ||= "background-wait";

  const askUserLimitMs = runtime.budget.askUserLimitMs;
  runtime.budget.askUserWaitMs = openAskUserMs;
  if (askUserLimitMs && openAskUserMs >= askUserLimitMs) runtime.budget.exhaustedReason ||= "user-unanswered";
  // Reaching the request limit means the just-returned response still owns an
  // executable action. Only an attempted request beyond the limit exhausts
  // the budget; otherwise actionResult would incorrectly discard request 10.
  if (runtime.budget.modelRequests > runtime.budget.modelRequestLimit) runtime.budget.exhaustedReason ||= "model-requests";
  if (runtime.budget.noProgressCount >= NO_PROGRESS_LIMIT) runtime.budget.exhaustedReason ||= "no-progress";
  return runtime.budget;
}

export function pauseBudget(runtime: RuntimeEvidence, now = Date.now()) {
  runtime.pauseDepth += 1;
  if (runtime.pauseDepth === 1) {
    elapsedBudget(runtime, now);
    runtime.pausedAt = now;
  }
}

export function resumeBudget(runtime: RuntimeEvidence, now = Date.now()) {
  if (!runtime.pauseDepth) return;
  runtime.pauseDepth -= 1;
  if (!runtime.pauseDepth && runtime.pausedAt) {
    runtime.startedAt += now - runtime.pausedAt;
    runtime.pausedAt = undefined;
  }
}

function assertBudget(runtime: RuntimeEvidence) {
  const budget = elapsedBudget(runtime);
  if (budget.exhaustedReason) throw new Error(`page_agent_budget_exhausted:${budget.exhaustedReason}`);
}

/**
 * Running out of budget is a normal ending, not a malfunction. Each reason gets
 * its own stable code and a sentence the user can act on, instead of all of
 * them collapsing into one opaque "technical problem".
 *
 * `unknown` rather than `execution-fault`: the runtime genuinely cannot confirm
 * whether the goal was reached, and nothing broke.
 */
export function terminationFromBudget(
  technicalError: string | undefined,
  exhaustedReason: PageExecutionBudget["exhaustedReason"],
): { status: TaskEpisode["outcome"]["status"]; code: string; summary: string } | undefined {
  const reason = String(technicalError || "").startsWith("page_agent_budget_exhausted:")
    ? String(technicalError).split(":")[1] as PageExecutionBudget["exhaustedReason"]
    : technicalError
      ? undefined
      : exhaustedReason;
  switch (reason) {
    case "background-wait":
      return {
        status: "unknown",
        code: "agent_background_wait_exhausted",
        summary: say().backgroundWaitExhausted,
      };
    case "wall-clock":
      return {
        status: "unknown",
        code: "agent_wall_clock_exhausted",
        summary: say().wallClockExhausted,
      };
    case "page-handoff":
      return {
        status: "unknown",
        code: "agent_page_handoff_timeout",
        summary: say().pageHandoffTimeout,
      };
    case "user-unanswered":
      return {
        status: "unknown",
        code: "agent_user_unanswered",
        summary: say().userUnanswered,
      };
    case "active-time":
      return {
        status: "unknown",
        code: "agent_active_time_exhausted",
        summary: say().activeTimeExhausted,
      };
    case "model-requests":
      return {
        status: "unknown",
        code: "agent_model_requests_exhausted",
        summary: say().modelRequestsExhausted,
      };
    case "no-progress":
      return {
        status: "unknown",
        code: "agent_no_progress",
        summary: say().noProgress,
      };
    default:
      return undefined;
  }
}

/**
 * A user-facing sentence for a genuine internal fault. The category still has
 * to come through — "something broke" with no further signal is what left
 * people unable to tell a stuck task from a failed one.
 */
export function technicalFaultSummary(technicalError: string | undefined) {
  const code = String(technicalError || "").split(":")[0];
  switch (code) {
    case "page_agent_evidence_drain_timeout":
      return say().faultEvidenceDrain;
    case "page_agent_observation_missing":
    case "page_agent_turn_not_started":
      return say().faultObservationMissing;
    case "page_agent_sensitive_target_blocked":
      return say().faultSensitiveTarget;
    case "page_agent_duplicate_unchanged_action":
    case "page_agent_repeated_menu_trigger_choose_visible_item":
      return say().faultDuplicateAction;
    case "page_agent_round_unsettled":
      return say().faultRoundUnsettled;
    case "runtime_read_only_not_authorized":
      return say().faultReadOnlyNotAuthorized;
    default:
      return code
        ? say().faultWithCode(code)
        : say().faultGeneric;
  }
}

/** The in-page agent's visitor-facing copy, in the reader's language. */
const say = () => widgetCopy(resolveWidgetLocale()).page;

function metric(runtime: RuntimeEvidence, turnIndex: number, stage: PageRuntimeMetric["stage"], startedAt: number, detail?: Record<string, JsonValue>) {
  runtime.runtimeMetrics.push({ turnIndex, stage, startedAt: new Date(startedAt).toISOString(), durationMs: Math.max(0, Date.now() - startedAt), detail });
}

function progressSignature(observation?: PageAgentObservation) {
  if (!observation) return "";
  return stableHash(JSON.stringify({
    state: observation.state,
    targets: observation.targets.map(withoutObservationId),
  }));
}

function jsonEqual(left: Record<string, JsonValue>, right: Record<string, JsonValue>) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function pageAgentActionSignature(
  action: ActionReceiptV2["action"],
  target: ActionReceiptV2["target"],
  input: Record<string, JsonValue>,
) {
  return JSON.stringify({ action, semanticId: target?.semanticId || "", index: target?.index, input });
}

export function closeActionReceiptWithObservation(
  receipt: ActionReceiptV2,
  before: PageAgentObservation | undefined,
  after: PageAgentObservation,
) {
  if (receipt.afterObservationId || receipt.beforeObservationId === after.id) return false;
  receipt.afterObservationId = after.id;
  const beforeSignature = progressSignature(before);
  const afterSignature = progressSignature(after);
  if (receipt.action === "press" && receipt.effectSignals.isTrusted === false) {
    receipt.effectSignals = {
      ...receipt.effectSignals,
      observedStateChanged: Boolean(beforeSignature && beforeSignature !== afterSignature),
    };
    // Synthetic keyboard events can wake application listeners, but the
    // browser will never mark them trusted. DOM movement after dispatch is
    // correlation only and must not become reusable action authority.
    receipt.effect = "unknown";
    return true;
  }
  const signals: Record<string, JsonValue> = {
    ...receipt.effectSignals,
    urlChanged: Boolean(before && before.state.url !== after.state.url),
    titleChanged: Boolean(before && before.state.title !== after.state.title),
    contentChanged: Boolean(before && before.state.content !== after.state.content),
    targetSetChanged: Boolean(before && !jsonEqual(
      { targets: before.targets.map(withoutObservationId) } as Record<string, JsonValue>,
      { targets: after.targets.map(withoutObservationId) } as Record<string, JsonValue>,
    )),
  };
  receipt.effectSignals = signals;
  receipt.effect = beforeSignature && beforeSignature === afterSignature ? "unchanged" : "changed";
  return true;
}

function withoutObservationId(target: PageAgentObservation["targets"][number]) {
  const { observationId, ...stableTarget } = target;
  void observationId;
  return stableTarget;
}

export function isDuplicateUnchangedAction(
  receipts: ActionReceiptV2[],
  action: ActionReceiptV2["action"],
  target: ActionReceiptV2["target"],
  input: Record<string, JsonValue>,
) {
  const previous = [...receipts].reverse().find((receipt) => receipt.dispatched);
  return Boolean(previous
    && (previous.effect === "unchanged"
      || (previous.action === "press" && previous.effect === "unknown" && previous.effectSignals.observedStateChanged === false))
    && pageAgentActionSignature(previous.action, previous.target, previous.input) === pageAgentActionSignature(action, target, input));
}

/**
 * A repeated click on a menu/dropdown trigger is almost always a routing
 * mistake: the first click opened the menu and the second one merely closed
 * it again.  Do not classify the DOM toggle as useful progress.  Quantity
 * buttons and ordinary business buttons remain repeatable; only controls
 * whose accessible name explicitly describes a menu/sort/filter are guarded.
 */
export function isRepeatedMenuTriggerAction(
  receipts: ActionReceiptV2[],
  action: ActionReceiptV2["action"],
  target: ActionReceiptV2["target"],
  input: Record<string, JsonValue>,
) {
  if (action !== "click") return false;
  const label = `${target?.accessibleName || ""} ${target?.nearbyText || ""}`;
  if (!/(?:sort|filter|dropdown|menu|order|排序|筛选|下拉|菜单)/iu.test(label)) return false; // i18n-exempt: matching logic: these patterns read what a visitor typed, they are not shown
  const previous = [...receipts].reverse().find((receipt) => receipt.dispatched);
  return Boolean(previous && pageAgentActionSignature(previous.action, previous.target, previous.input)
    === pageAgentActionSignature(action, target, input));
}

/** Same guard using the live element when a computed target has no label. */
export function isRepeatedMenuTriggerElement(
  receipts: ActionReceiptV2[],
  action: ActionReceiptV2["action"],
  index: number | undefined,
  element: Element | undefined,
  target?: ActionReceiptV2["target"],
) {
  if (action !== "click" || index === undefined || !element) return false;
  if (element.matches("option,[role='option'],[role='menuitem'],a[href]")) return false;
  const label = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.textContent || ""}`;
  if (!/(?:sort|filter|dropdown|menu|order|排序|筛选|下拉|菜单)/iu.test(label)) return false; // i18n-exempt: matching logic: these patterns read what a visitor typed, they are not shown
  const previous = [...receipts].reverse().find((receipt) => receipt.dispatched);
  if (!previous || previous.action !== "click") return false;
  if (Number(previous.input.index) === index) return true;
  const previousLabel = `${previous.target?.accessibleName || ""} ${previous.target?.nearbyText || ""}`.trim().toLocaleLowerCase();
  const currentLabel = label.toLocaleLowerCase();
  const semanticIdMatches = Boolean(target?.semanticId && previous.target?.semanticId && target.semanticId === previous.target.semanticId);
  const labelMatches = Boolean(previousLabel && currentLabel && (currentLabel.includes(previousLabel) || previousLabel.includes(currentLabel)));
  const previousWasMenuTrigger = /(?:sort|filter|dropdown|menu|order|排序|筛选|下拉|菜单)/iu.test(previousLabel); // i18n-exempt: matching logic: these patterns read what a visitor typed, they are not shown
  // A second trigger click before selecting a visible item is never useful.
  // This also covers sites whose DOM re-indexing changes the numeric target
  // between observations, which would otherwise evade an index-only guard.
  return semanticIdMatches || labelMatches || previousWasMenuTrigger;
}

export function pageAgentReceiptProgressEffect(receipt: ActionReceiptV2): ActionReceiptV2["effect"] {
  if (receipt.action === "press" && receipt.effect === "unknown" && receipt.effectSignals.observedStateChanged === false) return "unchanged";
  return receipt.effect;
}

export function recordNoProgressEffect(budget: PageExecutionBudget, effect: ActionReceiptV2["effect"]) {
  budget.noProgressCount = effect === "unchanged" ? budget.noProgressCount + 1 : effect === "changed" ? 0 : budget.noProgressCount;
  if (budget.noProgressCount >= NO_PROGRESS_LIMIT) budget.exhaustedReason ||= "no-progress";
  return budget.exhaustedReason;
}

export function isAllowedPageAgentKey(key: string) {
  return SAFE_KEYS.has(key);
}

/**
 * `escalatable` distinguishes the two very different reasons a run can be
 * read-only:
 *
 * - the site owner configured `data-runtime-mode="read-only"` — a policy the
 *   end user must not be able to click past, so the write tools stay hidden;
 * - the runtime's own regular expression judged this goal read-only — a guess
 *   that can be wrong, so the tools stay listed and are gated behind one
 *   explicit authorization instead.
 */
export function runtimeV2ToolAvailability(readOnly: boolean, escalatable = false) {
  const tools = new Set<string>(PAGE_AGENT_RUNTIME_V2_TOOL_NAMES);
  tools.add("click_element_by_index");
  tools.add("select_dropdown_option");
  tools.add("scroll");
  tools.add("scroll_horizontally");
  tools.add("wait");
  tools.add("navigate_scene");
  tools.add("call_capability");
  tools.add("search_site_knowledge");
  tools.add("ask_user");
  if (readOnly && !escalatable) {
    for (const name of [
      "click_element_by_index", "set_text_by_index", "insert_text_by_index", "select_dropdown_option",
      "submit_form_by_index", "press_key_by_index", "wait", "navigate_scene", "call_capability",
      "search_site_knowledge", "ask_user",
    ]) tools.delete(name);
  } else if (readOnly) {
    // Listed, but every write goes through the authorization gate. Hiding them
    // left the model unable to signal "this needs an action" at all, so a goal
    // the regex misjudged just failed with no explanation.
    // A published capability runs a whole compiled program, which is not a
    // single gated write, so it stays unavailable either way.
    tools.delete("call_capability");
  }
  return [...tools].sort();
}

export function consumePageAgentModelRequest(runtime: RuntimeEvidence) {
  assertBudget(runtime);
  if (runtime.budget.modelRequests >= runtime.budget.modelRequestLimit) {
    runtime.budget.exhaustedReason = "model-requests";
    throw new Error("page_agent_budget_exhausted:model-requests");
  }
  runtime.budget.modelRequests += 1;
  return runtime.budget.modelRequests;
}

type VisibilitySource = Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

/** Wait without charging active runtime; onBeforeStep calls this before any DOM/model work. */
export async function waitForPageAgentForeground(
  runtime: RuntimeEvidence,
  source: VisibilitySource,
  signal: AbortSignal,
  now: () => number = Date.now,
) {
  if (source.visibilityState !== "hidden") {
    runtime.hiddenSince = undefined;
    return { waitedMs: 0, startedAt: now() };
  }
  const startedAt = now();
  // Active time stops, but the wall clock and this continuous-background timer
  // keep running. Without a timer the loop below only wakes on a
  // `visibilitychange` that may never arrive, which is how a task could hang
  // for ten minutes with no limit able to stop it.
  runtime.hiddenSince = startedAt;
  pauseBudget(runtime, startedAt);
  try {
    while (source.visibilityState === "hidden") {
      const limitMs = runtime.budget.backgroundWaitLimitMs || BACKGROUND_WAIT_LIMIT_MS;
      const remainingMs = Math.max(0, limitMs - Math.max(0, now() - startedAt));
      if (!remainingMs) break;
      const returned = await new Promise<boolean>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer !== undefined) clearTimeout(timer);
          source.removeEventListener("visibilitychange", changed);
          signal.removeEventListener("abort", aborted);
        };
        const changed = () => {
          if (source.visibilityState === "hidden") return;
          cleanup();
          resolve(true);
        };
        const aborted = () => {
          cleanup();
          reject(abortError(signal));
        };
        source.addEventListener("visibilitychange", changed);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
        else if (source.visibilityState !== "hidden") changed();
        else timer = setTimeout(() => { cleanup(); resolve(false); }, remainingMs);
      });
      if (!returned) break;
    }
    const waitedMs = Math.max(0, now() - startedAt);
    if (source.visibilityState === "hidden") {
      // Left the loop on the limit rather than on the page coming back. Record
      // the exhaustion so the caller reports "you switched away" instead of an
      // opaque technical fault.
      elapsedBudget(runtime, now());
      runtime.budget.backgroundWaitMs = waitedMs;
      runtime.budget.exhaustedReason ||= "background-wait";
      throw new Error("page_agent_budget_exhausted:background-wait");
    }
    runtime.hiddenSince = undefined;
    return { waitedMs, startedAt };
  } finally {
    resumeBudget(runtime, now());
    if (source.visibilityState !== "hidden") runtime.hiddenSince = undefined;
  }
}

/**
 * Wait for an answer the runtime explicitly asked the user for. Active time and
 * the wall clock both stop, because the user is present and working on our
 * question; the wait is instead bounded by its own limit.
 */
export async function withUserAnswerBudget<T>(
  runtime: RuntimeEvidence,
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<T> {
  const startedAt = now();
  runtime.askUserStartedAt = startedAt;
  pauseBudget(runtime, startedAt);
  const limitMs = runtime.budget.askUserLimitMs || ASK_USER_LIMIT_MS;
  const controller = new AbortController();
  const forward = () => controller.abort(abortError(signal));
  signal.addEventListener("abort", forward, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("page_agent_budget_exhausted:user-unanswered");
        reject(error);
        controller.abort(error);
      }, limitMs);
    });
    return await Promise.race([operation(controller.signal), timeout]);
  } catch (error) {
    if (String((error as Error)?.message).endsWith(":user-unanswered")) {
      runtime.budget.exhaustedReason ||= "user-unanswered";
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", forward);
    const endedAt = now();
    runtime.budget.askUserWaitMs = Math.max(0, endedAt - startedAt);
    runtime.wallExcludedMs += Math.max(0, endedAt - startedAt);
    runtime.askUserStartedAt = undefined;
    resumeBudget(runtime, endedAt);
  }
}

export async function withPageAgentRuntimeDeadline<T>(
  runtime: RuntimeEvidence,
  operation: (signal: AbortSignal) => Promise<T>,
  maxMs = 10_000,
  source?: VisibilitySource,
) {
  // Background tabs have their timers throttled hard, so a short deadline
  // started while hidden fires long before the operation had a fair chance.
  // Wait for the foreground first — that wait is itself bounded by the
  // continuous-background limit, so this cannot reintroduce an unbounded hang.
  if (source && source.visibilityState === "hidden") {
    await waitForPageAgentForeground(runtime, source, new AbortController().signal);
  }
  const budget = elapsedBudget(runtime);
  const remainingMs = Math.max(0, budget.activeLimitMs - budget.activeElapsedMs);
  // Floor the deadline: an almost-exhausted budget used to collapse it towards
  // zero, so even an instant operation was reported as a timeout.
  const timeoutMs = Math.max(RUNTIME_DEADLINE_FLOOR_MS, Math.min(maxMs, remainingMs));
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error("page_agent_evidence_drain_timeout");
      reject(error);
      // Queue the timeout rejection before notifying cooperative listeners;
      // an abort listener is allowed to resolve its operation synchronously.
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/** Prefer a forced terminal reason even when stop() makes execute() settle first. */
export async function resolvePageAgentExecution<T>(
  execution: Promise<T>,
  timeout: Promise<never>,
  forcedError: () => Error | undefined,
  forcedSettlement: () => Promise<void> | undefined = () => undefined,
) {
  try {
    const result = await Promise.race([execution, timeout]);
    const forced = forcedError();
    if (forced) {
      await forcedSettlement();
      throw forced;
    }
    return result;
  } catch (error) {
    const forced = forcedError();
    if (forced) {
      await forcedSettlement();
      throw forced;
    }
    throw error;
  }
}

/** Evidence failure must never skip disposal, listener removal, or UI restore. */
export async function finalizePageAgentRuntime(
  evidence: () => Promise<void>,
  cleanup: () => void | Promise<void>,
) {
  try {
    await evidence();
  } finally {
    await cleanup();
  }
}

export function pageAgentLongTaskMetric(
  turnIndex: number,
  entry: Pick<PerformanceEntry, "name" | "entryType" | "startTime" | "duration">,
  timeOrigin: number,
): PageRuntimeMetric {
  return {
    turnIndex: Math.max(0, turnIndex),
    stage: "turn_before_hook",
    startedAt: new Date(timeOrigin + entry.startTime).toISOString(),
    durationMs: Math.max(0, entry.duration),
    detail: { telemetry: "long-task", name: entry.name, entryType: entry.entryType },
  };
}

export function literalTextReplacement(previous: string, text: string) {
  void previous;
  return literalPageAgentText(text);
}

export function literalTextInsertion(previous: string, start: number, end: number, text: string) {
  return `${previous.slice(0, start)}${literalPageAgentText(text)}${previous.slice(end)}`;
}

export function pageAgentKeyboardEventOptions(key: string): KeyboardEventInit {
  return {
    key: key === "Space" ? " " : key,
    code: key === "Space" ? "Space" : key,
    bubbles: true,
    cancelable: true,
    composed: true,
    repeat: false,
  };
}

const SAFE_KEYS = new Set([
  "Enter", "Escape", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End",
]);

export const PAGE_AGENT_RUNTIME_V2_TOOL_NAMES = [
  "set_text_by_index",
  "insert_text_by_index",
  "submit_form_by_index",
  "move_focus",
  "press_key_by_index",
] as const;

/** Preserve whitespace and control-looking words as literal field content. */
export function literalPageAgentText(text: string) {
  return text;
}

function compactStructuredOutput(value: JsonValue, depth = 0): JsonValue {
  if (typeof value === "string") return value.slice(0, 1_000);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => compactStructuredOutput(item, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, compactStructuredOutput(item, depth + 1)]));
}

type ActorRound = {
  reportedSuccess: boolean;
  text: string;
  outcome?: "success" | "no-result" | "business-rejection" | "incomplete";
  output?: Record<string, JsonValue>;
  completionEvidence?: Array<{ criterion: string; evidence: string }>;
  technicalError?: string;
  actionFailure?: string;
};

export function pageExecutionBriefInstructions(brief?: PageExecutionBrief) {
  if (!brief) return "";
  const effectful = brief.effect !== "read";
  const hasGoalTarget = Object.prototype.hasOwnProperty.call(brief.entities, "goalTarget");
  const semantic = deriveGoalSemanticFrame(brief.normalizedGoal || brief.objective);
  const semanticSummary = semanticActionSummary(semantic);
  return [
    `Original normalized goal (immutable): ${brief.normalizedGoal}`,
    `Known entities and user values (must be preserved exactly): ${JSON.stringify(brief.entities)}`,
    `Maximum authorized effect: ${brief.effect}`,
    `Completion criteria (all must be addressed by observable evidence): ${JSON.stringify(brief.completionCriteria)}`,
    semanticSummary ? `Business atoms (code-owned semantic hints; complete them in order): ${semanticSummary}` : "",
    brief.objective !== brief.normalizedGoal
      ? `Current page-step hint (non-authoritative): ${brief.objective}. It is only the next UI step; it cannot replace or complete the original goal.`
      : "",
    "每次只生成并执行一个原子页面动作；动作完成后先记录回执、观察新页面，再决定下一个动作。业务原子不是固定 DOM 路径，下一页面动作必须从当前观察动态决定。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
    effectful
      ? "这是执行型目标：原始目标中的每个动作都必须完成；搜索、筛选、打开详情页等只是后续写操作的中间步骤，不能在中间步骤调用 done。" // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
      : "",
    hasGoalTarget
      ? "goalTarget 必须绑定到最终副作用动作实际操作的目标控件（例如 Add to cart <商品>）；搜索框输入、页面标题或结果列表已有文本不能单独证明目标动作完成。" // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
      : "",
  ].filter(Boolean).join("\n");
}

/**
 * Keep the task given to the page actor aligned with code-owned authority.
 * Focused model objectives are allowed for read-only work, but an effectful
 * request must retain the user's complete goal so intermediate discovery does
 * not become an accidental terminal state.
 */
export function pageExecutionTask(brief: PageExecutionBrief | undefined, goal: string) {
  // The original goal is the only task identity for every mode.  A focused
  // objective remains available in the execution brief as a non-authoritative
  // page-step hint; it must never turn a compound task into a search-only task.
  return goal;
}

export function parseHumanConfirmationAnswer(answer: string): "success" | "failed" | "unknown" {
  const value = answer.normalize("NFKC").trim().toLocaleLowerCase();
  if (!value) return "unknown";
  if (/(?:失败|没成功|没有成功|未完成|没完成|不成功|否|不是|no\b|not\b|failed|failure|unsuccessful)/iu.test(value)) return "failed"; // i18n-exempt: matching logic: these patterns read what a visitor typed, they are not shown
  if (/(?:成功|完成|已完成|有了|是的|对|可以|确认|yes\b|done\b|success|succeeded|completed|ok\b)/iu.test(value)) return "success"; // i18n-exempt: matching logic: these patterns read what a visitor typed, they are not shown
  return "unknown";
}

/**
 * The PageAgent model is the first decision maker. Ask the user only when the
 * model did not return a terminal business decision (or failed technically),
 * rather than turning a successful model judgement with incomplete citations
 * into an unnecessary confirmation dialog.
 */
export function aiHasTerminalDecision(round: {
  reportedSuccess: boolean;
  outcome?: ActorRound["outcome"];
  technicalError?: string;
  actionFailure?: string;
}) {
  return !round.technicalError
    && !round.actionFailure
    && (round.outcome === "business-rejection"
      || (round.reportedSuccess && (!round.outcome || ["success", "no-result"].includes(round.outcome))));
}

export function aiReportedSuccess(round: {
  reportedSuccess: boolean;
  outcome?: ActorRound["outcome"];
  technicalError?: string;
  actionFailure?: string;
}) {
  return !round.technicalError
    && !round.actionFailure
    && round.reportedSuccess
    && (!round.outcome || ["success", "no-result"].includes(round.outcome));
}

/**
 * Decide whether a completed browser run may be handed to the capability
 * center as raw experience. This is intentionally weaker than capability
 * authority: AI success records the trace, while the server-side authority,
 * abstraction, generation and validation stages decide whether it is usable.
 */
export function shouldRecordAdaptiveExperience(
  status: TaskEpisode["outcome"]["status"],
  hasPageAction: boolean,
  humanConfirmationAnswer?: "success" | "failed" | "unknown",
) {
  return (status === "success" || status === "no-result")
    && hasPageAction
    && (humanConfirmationAnswer === undefined || humanConfirmationAnswer === "success");
}

function receiptSuggestsIrreversibleAction(receipt: ActionReceiptV2) {
  const target = receipt.target ? JSON.stringify(receipt.target) : "";
  const input = JSON.stringify(receipt.input || {});
  return receipt.action === "submit"
    || (receipt.action === "press" && /enter|return|提交|确认/iu.test(`${target} ${input}`)) // i18n-exempt: matching logic: these patterns read what a visitor typed, they are not shown
    || /(?:add\s+to\s+cart|buy|purchase|checkout|pay|delete|remove|submit|place\s+order|加入购物车|加入购物袋|购买|下单|结算|支付|删除|移除|提交|确认)/iu.test(`${target} ${input}`); // i18n-exempt: matching logic: these patterns read what a visitor typed, they are not shown
}

/**
 * Search is a parameter-binding task, not a category-navigation task.  A
 * model that sees a useful category link before it binds the user's query can
 * produce a perfectly valid page transition while silently changing the
 * meaning of the request (for example, "找一个衣服" becoming "浏览餐具").
 * Keep this as a protocol-level instruction so every site gets the same
 * semantic guard; the actual input is still selected from the live DOM.
 */
export function searchExecutionInstructions(goal: string) {
  if (!/(?:搜索|查找|找一下|找个|找一个|search\b|find\b)/iu.test(goal.normalize("NFKC"))) return ""; // i18n-exempt: matching logic: these patterns read what a visitor typed, they are not shown
  return [
    "这是搜索/查找目标，先绑定用户的原始查询词，再观察新的结果。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
    "优先使用当前页面可见的搜索输入框（role=textbox、aria-label/placeholder/name 含搜索或 search）输入用户原话中的查询词，并点击可见搜索按钮或提交表单。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
    "不要用分类、标签、推荐商品或固定 URL 代替查询词；只有用户明确说了某个分类时，才能把分类作为额外筛选条件。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
    "搜索结果里的同名商品不代表本次搜索已经完成；必须留下真实输入和提交后的结果页证据。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
  ].join("\n");
}

export function pageExecutionEntityEvidence(
  brief: PageExecutionBrief | undefined,
  receipts: ActionReceiptV2[],
  observations: PageAgentObservation[],
) {
  const result = assessPageExecutionEvidence({ brief, receipts, observations });
  return { satisfied: result.missingEntities.length === 0, missing: result.missingEntities };
}

export function pageExecutionCompletionEvidence(
  brief: PageExecutionBrief | undefined,
  supplied: Array<{ criterion: string; evidence: string }> | undefined,
  receipts: ActionReceiptV2[],
  observations: PageAgentObservation[],
) {
  const result = assessPageExecutionEvidence({ brief, receipts, observations, completionEvidence: supplied });
  return { satisfied: result.missingCriteria.length === 0, missing: result.missingCriteria };
}

let activeAgent: PageAgentCore | undefined;
let activeRuntimeAbort: AbortController | undefined;
let cancelled = false;

function observePageAgentLongTasks(runtime: RuntimeEvidence, currentTurn: () => number) {
  if (typeof PerformanceObserver === "undefined"
    || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return undefined;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        runtime.runtimeMetrics.push(pageAgentLongTaskMetric(currentTurn(), entry, performance.timeOrigin));
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
    return observer;
  } catch {
    return undefined;
  }
}

function endpointUrl(endpoint: string, path: string) {
  return endpoint ? `${endpoint.replace(/\/$/, "")}${path}` : path;
}

function activityText(activity: AgentActivity) {
  if (activity.type === "thinking") return say().thinking;
  if (activity.type === "executing") return say().executing;
  if (activity.type === "executed") return say().executed;
  if (activity.type === "retrying") return say().retrying;
  return activity.message;
}

function compact(content: string, goal: string) {
  if (content.length <= 18_000) return content;
  const terms = normalizeGoal(goal).split(/\s+/).filter((item) => item.length >= 2);
  const lines = content.split("\n");
  const relevant = lines.filter((line) => terms.some((term) => normalizeGoal(line).includes(term)));
  const interactive = lines.filter((line) => /^\s*\*?\[\d+\]</.test(line));
  return [...new Set([...relevant.slice(0, 100), ...interactive.slice(0, 220), ...lines.slice(0, 80)])].join("\n").slice(0, 18_000);
}

/**
 * Adaptive-shaped view over the single authoritative `searchKnowledgeIndex` — so
 * the adaptive agent, main agent, and routing context all consume one knowledge
 * search. Scenes now also carry the ready-to-route `urlTemplate`, `requiredParams`
 * and `readiness` (verified-ranked, not verified-filtered).
 */
function searchSiteKnowledge(release: SiteAgentReleaseV2, query: string, currentSceneId?: string) {
  const index = searchKnowledgeIndex(release, query, currentSceneId);
  return {
    site: { name: release.profile.name, description: release.profile.description, suggestedGoals: release.profile.suggestedGoals.slice(0, 8) },
    currentSceneId: index.currentSceneId,
    scenes: index.scenes.map((scene) => ({ id: scene.id, name: scene.name, description: scene.description, urlTemplate: scene.urlTemplate, paths: scene.paths, parameters: scene.parameters, requiredParams: scene.requiredParams, directEntry: scene.directEntry, readiness: scene.readiness, current: scene.current })),
    operations: index.operations.map((operation) => ({ id: operation.id, name: operation.name, from: operation.from, to: operation.to, scope: operation.scope, status: operation.status })),
    capabilities: index.capabilities.map((capability) => ({ id: capability.id, name: capability.name, description: capability.description, goalTemplate: capability.goalTemplate, inputs: capability.inputs, outputs: capability.outputs })),
  };
}

function capabilityManifest(release: SiteAgentReleaseV2) {
  const unique = new Map<string, SiteAgentReleaseV2["capabilities"][number]>();
  for (const capability of userInvocableCapabilities(release)) {
    const key = normalizeGoal(capability.normalizedGoal || capability.goalTemplate || capability.name);
    const previous = unique.get(key);
    if (!previous || (previous.status === "improving" && capability.status === "available")) unique.set(key, capability);
  }
  return [...unique.values()]
    .slice(0, 40)
    .map((capability) => ({
      id: capability.id,
      name: capability.name,
      description: capability.description,
      goalTemplate: capability.goalTemplate,
      inputSchema: capability.inputs,
      outputSchema: capability.outputs,
    }));
}

function elementFromBrowserLine(content: string, index: number) {
  const line = content.split("\n").find((item) => item.includes(`[${index}]`));
  if (!line) return undefined;
  const attribute = (name: string) => {
    const match = line.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return match?.[1] || match?.[2] || match?.[3] || undefined;
  };
  const rawRole = line.match(/<([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase() || "button";
  const role = rawRole === "a" ? "link" : ["input", "textarea"].includes(rawRole) ? "textbox" : rawRole === "select" ? "combobox" : rawRole;
  // PageAgent's accessibility serialization may end a line with `/>`. That is
  // syntax, never part of an accessible name (the old compiler produced
  // targets such as “明星 />”, which could not be replayed).
  const text = line
    .replace(/^.*?\[\d+\]\s*/, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/(?:^|\s)\/?>(?:\s|$)/g, " ")
    .replace(/\s+\/?\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return { role, text: text || attribute("aria-label") || "", placeholder: attribute("placeholder"), name: attribute("name") };
}

function targetForStep(step: AgentStepEvent, state: BrowserState | undefined, release: SiteAgentReleaseV2) {
  const index = Number(step.action.input?.index);
  if (!Number.isInteger(index) || index < 0 || !state) return undefined;
  const line = elementFromBrowserLine(state.content, index);
  if (!line) return undefined;
  const existing = release.targets.find((target) => target.role === line.role && target.accessibleNames.includes(line.text));
  if (existing) return existing;
  return targetFromEvidence({ tag: line.role === "link" ? "a" : line.role === "textbox" ? "input" : line.role === "combobox" ? "select" : "button", role: line.role, accessibleName: line.text || undefined, placeholder: line.placeholder, name: line.name, attributes: {} });
}

function compileStep(step: AgentStepEvent, state: BrowserState | undefined, release: SiteAgentReleaseV2, targets: Map<string, TargetSpec>, input: Record<string, JsonValue>): PageProgramStep | undefined {
  const action = step.action.name;
  if (["click_element_by_index", "input_text", "set_text_by_index", "select_dropdown_option"].includes(action)) {
    const target = targetForStep(step, state, release);
    if (!target) return undefined;
    targets.set(target.id, target);
    if (action === "click_element_by_index") return { id: uid("step"), op: "click", targetId: target.id, timeoutMs: 8_000 };
    const raw = String(step.action.input?.text || step.action.input?.option || "");
    const inputEntry = Object.entries(input).find(([, value]) => String(value) === raw);
    const value = inputEntry ? { source: "input" as const, path: inputEntry[0] } : { source: "literal" as const, value: raw };
    return { id: uid("step"), op: action === "select_dropdown_option" ? "select" : "fill", targetId: target.id, value, timeoutMs: 8_000 };
  }
  if (action === "scroll") return { id: uid("step"), op: "scroll", direction: step.action.input?.down === false ? "up" : "down", amount: Number(step.action.input?.pixels || innerHeight * 0.8), timeoutMs: 5_000 };
  if (action === "wait") return { id: uid("step"), op: "waitForCondition", timeoutMs: Math.max(500, Math.min(10_000, Number(step.action.input?.seconds || 1) * 1000)) };
  return undefined;
}

async function executeActorRound(options: AdaptiveOptions, task: string, maxSteps: number, steps: PageProgramStep[], targets: Map<string, TargetSpec>, actions: ExperienceActionEvidence[], toolReceipts: ToolReceipt[], traceStart: ReturnType<typeof capturePageSnapshot>, traceStartedAt: string, episodeId: string, runtime: RuntimeEvidence): Promise<ActorRound> {
  const runtimeAbort = new AbortController();
  const completionReceipt = [...toolReceipts].reverse().find((receipt) => receipt.kind === "capability" && receipt.status === "completed");
  const businessOutputKeys = Object.keys(completionReceipt?.output || {}).filter((key) => !["pageUrl", "pageTitle"].includes(key));
  const receiptCompletionOnly = Boolean(completionReceipt && businessOutputKeys.length);
  const receiptNeedsPageEvidence = Boolean(completionReceipt && !businessOutputKeys.length);
  // `data-sitewake-agent` is a cross-module contract; see user-agent-client.ts.
  const agentHosts = [...document.querySelectorAll<HTMLElement>("[data-sitewake-agent]")];
  const previousPointerEvents = agentHosts.map((host) => host.style.pointerEvents);
  const projectState = (state: BrowserState) => {
    if (receiptCompletionOnly) return { ...state, content: `能力调用已经完成。请只根据结构化能力回执形成最终回答，不要再次观察或操作页面。\n${JSON.stringify(completionReceipt)}` }; // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
    if (receiptNeedsPageEvidence) return { ...state, content: `${compact(state.content, options.goal).slice(0, 7_000)}\n\n能力回执：${JSON.stringify(completionReceipt)}` }; // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
    return { ...state, content: compact(state.content, options.goal) };
  };
  const controller = new SiteAgentPageController({
    enableMask: receiptNeedsPageEvidence || !completionReceipt,
    viewportExpansion: 250,
    interactiveBlacklist: [...agentHosts, ...humanInteractionBlacklist()],
    context: {
      siteAgentId: options.siteAgentId,
      runId: options.session.id,
      episodeId,
      browserSessionId: browserSessionId(),
      documentId: documentId(),
      pageEpoch: options.pageEpoch || 1,
    },
    projectState,
    initialSeed: runtime.controllerSeed,
    onMetric: (stage, startedAt, detail) => metric(runtime, currentTurn, stage, startedAt, detail),
    onObservation: async (observation) => {
      const started = Date.now();
      if (options.evidenceV2 !== false) {
        const ref = {
          id: observation.id,
          turnIndex: observation.turnIndex,
          kind: observation.kind,
          sha256: observation.sha256,
          pageEpoch: observation.pageEpoch,
          documentId: observation.documentId,
        } satisfies PageObservationRef;
        if (!runtime.observationRefs.some((item) => item.id === ref.id)) runtime.observationRefs.push(ref);
        if (!runtime.observations.some((item) => item.id === observation.id)) runtime.observations.push(observation);
      }
      const pending = [...runtime.actionReceipts].reverse().find((receipt) => receipt.dispatched && !receipt.afterObservationId);
      if (pending && closeActionReceiptWithObservation(pending, runtime.lastObservation, observation)) {
        recordNoProgressEffect(runtime.budget, pageAgentReceiptProgressEffect(pending));
        metric(runtime, observation.turnIndex, "effect_settle", started, { actionReceiptId: pending.id, effect: pending.effect });
        // Persist the closed before→after lifecycle immediately. A terminal
        // failure must still leave the receipt available to Debug/repair.
        emitCheckpoint("action-receipt-settled", { actionReceiptId: pending.id, effect: pending.effect });
      }
      runtime.lastObservation = observation;
      if (options.evidenceV2 !== false) {
        await options.onObservation?.(observation);
        metric(runtime, observation.turnIndex, "evidence_enqueue", started, { observationId: observation.id });
      }
    },
  });
  const trace = (): NonNullable<AdaptiveOptions["resumeTrace"]> => ({
    startedAt: traceStartedAt,
    episodeId,
    startSnapshot: traceStart,
    steps,
    targets: [...targets.values()],
    actions,
    toolReceipts,
    ...(options.evidenceV2 === false ? {} : {
      actionReceiptsV2: runtime.actionReceipts,
      observationRefs: runtime.observationRefs,
      budgetEvidence: elapsedBudget(runtime),
      runtimeMetrics: runtime.runtimeMetrics,
    }),
  });
  const emitCheckpoint = (reason: string, detail: Record<string, JsonValue> = {}) => {
    const startedAt = Date.now();
    metric(runtime, Math.max(0, currentTurn), "checkpoint", startedAt, { reason, ...detail });
    options.onTrace?.(trace());
  };
  const drainEvidenceRaw = async (signal?: AbortSignal) => {
    if (signal?.aborted) throw abortError(signal);
    await controller.drainObservations();
    if (signal?.aborted) throw abortError(signal);
    if (options.evidenceV2 !== false) await options.onDrainObservations?.();
  };
  const drainEvidence = () => withPageAgentRuntimeDeadline(runtime, drainEvidenceRaw, 10_000, document);

  /**
   * Gate one page-write in read-only mode behind an explicit user authorization.
   *
   * Read-only is decided by a regular expression over the user's wording, which
   * can never be complete. Rather than widening that expression forever, ask the
   * person once at the moment it actually matters — and keep the answer as
   * evidence, since a user-confirmed value is exactly what downstream
   * abstraction needs to tell an intended parameter from an incidental one.
   */
  const ensureWriteAuthorized = async (what: string, policyCode: string) => {
    if (options.runtimeMode !== "read-only") return;
    // A site-configured read-only policy belongs to the site owner. The end
    // user must not be able to click past it, so it refuses exactly as before.
    if (options.readOnlySource !== "runtime-derived") throw new Error(policyCode);
    if (runtime.readOnlyAuthorization?.answer === "granted") return;
    if (runtime.readOnlyAuthorization?.answer === "refused") throw new Error("runtime_read_only_not_authorized");
    if (!options.onAskUser) throw new Error("runtime_read_only_not_authorized");
    const question = say().authorizeQuestion(what);
    const raw = await withUserAnswerBudget(
      runtime,
      (answerSignal) => options.onAskUser!(question, {
        signal: answerSignal,
        choices: [{ label: say().authorizeYes, value: "granted" }, { label: say().authorizeNo, value: "refused" }],
      }),
      runtimeAbort.signal,
    );
    const answer = /granted|继续|好|是|yes|ok/i.test(String(raw || "")) ? "granted" as const : "refused" as const; // i18n-exempt: matching logic: these patterns read what a visitor typed, they are not shown
    runtime.readOnlyAuthorization = { answer, question, decidedAt: new Date().toISOString() };
    toolReceipts.push({
      kind: "human",
      name: question,
      status: "completed",
      summary: answer === "granted" ? say().authorizedByUser : say().refusedByUser,
      output: { readOnlyAuthorization: answer },
      observedAt: new Date().toISOString(),
    });
    if (answer !== "granted") throw new Error("runtime_read_only_not_authorized");
  };
  const elementAt = (index: number, turnIndex = currentTurn) => {
    try { return controller.elementForTurn(turnIndex, index); }
    catch { return undefined; }
  };
  const record = (action: ExperienceActionEvidence["action"], rawAction: string, index: number | undefined, input: Record<string, JsonValue>) => {
    const element = index === undefined ? undefined : elementAt(index);
    const page = capturePageSnapshot(actions.length + 1);
    actions.push({ id: uid("experience_action"), action, rawAction, input, element: element ? evidenceFromElement(element) : undefined, page: { url: page.url, title: page.title, heading: page.heading }, observedAt: new Date().toISOString() });
    emitCheckpoint("legacy-action-record", { action, rawAction });
  };
  const click = controller.clickElement.bind(controller);
  let actionFailure = "";
  const isSameDocumentDestination = (destination: URL) => {
    const current = new URL(location.href);
    return destination.origin === current.origin
      && destination.pathname === current.pathname
      && destination.search === current.search;
  };
  const applySameDocumentDestination = (destination: URL) => {
    const current = new URL(location.href);
    if (destination.href === current.href) return;
    // Preserve native hashchange/anchor behavior for SPA tabs and in-page
    // anchors; history.pushState alone does not notify those listeners.
    if (destination.hash !== current.hash) location.hash = destination.hash;
    else history.pushState({}, "", destination.href);
  };
  const shouldArmOpaqueNavigation = (element: Element | undefined) => {
    // A normal input/textarea/select click is a local interaction. Arming a
    // cross-document handoff before it runs leaves the server in
    // `awaiting-page` even when the page never navigates (the common case for
    // search fields and filters). Only explicit native form-submit controls
    // retain the opaque-navigation fallback; anchors are handled above with a
    // concrete destination URL.
    const control = element instanceof Element
      ? element.closest("button,input,textarea,select,[role=button],[role=link]") || element
      : undefined;
    if (control instanceof HTMLInputElement) return ["submit", "image"].includes(control.type.toLowerCase());
    if (control instanceof HTMLButtonElement) {
      const declaredType = control.getAttribute("type")?.toLowerCase();
      // HTML defaults a button's type to submit, but standalone framework
      // buttons (for example PrestaShop quick-view controls) are not form
      // submissions and must never arm a cross-document handoff.
      return declaredType === "submit" || (!declaredType && Boolean(control.form));
    }
    return false;
  };
  /**
   * Move the page-controller's simulator cursor (the large pointer visitors watch
   * during exploration) to an element, optionally with its click ripple. The
   * controller only moves it inside its own clickElement; every path SiteWake
   * handles itself — link handoffs, typing, selects, key presses, form submits —
   * left the pointer parked in the middle of the screen while the page changed.
   */
  const simulatorPointerTo = async (element: Element | undefined, click = false) => {
    if (!(element instanceof Element)) return;
    const rect = element.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    window.dispatchEvent(new CustomEvent("PageAgent::MovePointerTo", { detail: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (click) window.dispatchEvent(new CustomEvent("PageAgent::ClickPointer"));
  };
  const animatePointerTo = async (element?: Element) => {
    if (!element || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pointer = document.createElement("span");
    pointer.dataset.sitewakePointer = "true";
    pointer.innerHTML = '<svg viewBox="0 0 30 38" width="24" height="30" aria-hidden="true"><path d="M3 2l20 20-10 1 5 10-5 3-5-11-7 7z" fill="#fff" stroke="#18181b" stroke-width="2.2" stroke-linejoin="round"/></svg>';
    pointer.style.cssText = "position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;filter:drop-shadow(0 3px 5px #0005);transform:translate(-28px,-36px);transition:transform 160ms cubic-bezier(.2,.8,.2,1)";
    document.documentElement.appendChild(pointer);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => { pointer.style.transform = `translate(${Math.round(rect.left + rect.width / 2)}px,${Math.round(rect.top + rect.height / 2)}px)`; setTimeout(resolve, 175); })));
    pointer.animate([{ transform: pointer.style.transform }, { transform: `${pointer.style.transform} scale(.82)` }, { transform: pointer.style.transform }], { duration: 130 });
    await new Promise((resolve) => setTimeout(resolve, 135));
    pointer.remove();
  };
  controller.clickElement = async (index) => {
    const element = elementAt(index);
    const anchor = element instanceof HTMLAnchorElement
      ? element
      : element instanceof Element
        ? element.closest<HTMLAnchorElement>("a[href]")
        : undefined;
    // Resolving the link before the policy check, rather than after, is what
    // lets read-only tell "follow this link" apart from "operate this control".
    // Only the second one is a write; the first arrives at a destination the
    // mode already allows the runtime to navigate to on its own.
    const followsLink = Boolean(anchor)
      && !(element instanceof Element && isSensitiveElement(element))
      && isReadOnlyNavigationClick(anchor?.getAttribute("href"), location.href);
    if (!followsLink) {
      try { await ensureWriteAuthorized(say().actionClick, "runtime_read_only_click_forbidden"); }
      catch (error) {
        if (String((error as Error)?.message) === "runtime_read_only_click_forbidden") actionFailure = "runtime_read_only_click_forbidden";
        throw error;
      }
    }
    await animatePointerTo(element);
    if (element instanceof HTMLElement
      && element.matches("[role=menu],.dropdown-menu,[role=listbox]")
      && element.querySelector("a[href][role=menuitem],[role=option]")) {
      throw new Error("page_agent_menu_container_not_actionable_choose_visible_item");
    }
    if (anchor?.href) {
      const destination = new URL(anchor.href, location.href);
      // A link that leaves this site has nowhere for the run to go. The agent
      // serves one site and the SDK lives only on it, so following one opens a
      // page nothing can resume from — and where the link also carries
      // target=_blank the browser opens it beside this page, which is left in
      // the background with the run still waiting in it. 热搜时光机 links every
      // topic to s.weibo.com that way: 33 of the 60 links on its home page,
      // and a run that clicked one waited out its background budget and told
      // the person they had switched away from the page. Say what is wrong
      // with the choice instead, so the next turn picks something on the site.
      const registrable = (host: string) => host.split(".").slice(-2).join(".");
      const offSite = ["http:", "https:"].includes(destination.protocol)
        && registrable(destination.hostname) !== registrable(location.hostname);
      if (offSite) {
        return {
          success: false,
          message: say().leavesSiteBlocked(destination.origin),
        };
      }
      if (isSameDocumentDestination(destination)) {
        // A same-document link cannot transfer BrowserPort ownership.  Let the
        // current document handle the URL locally and keep the Run running;
        // otherwise a harmless link such as the site's logo can leave the Run
        // waiting forever for a page that will never be created.
        await simulatorPointerTo(element, true);
        applySameDocumentDestination(destination);
        record("click", "click_element_by_index", index, { index });
        return { success: true, message: say().positionUpdated };
      }
      if (["http:", "https:"].includes(destination.protocol)
        && destination.origin === location.origin
        && options.onNavigateAction) {
        if (options.runtimeV2 === false) controller.markActionBoundary();
        await simulatorPointerTo(element, true);
        await drainEvidence();
        // Record before the handoff: onNavigateAction commits the checkpoint the
        // next document resumes from, so a click recorded after it never reaches
        // that document. A visitor session that only followed links ("show me the
        // news for region X") then arrived with no actions at all and never entered
        // capability intake. Withdrawn again if the handoff is not accepted.
        record("click", "click_element_by_index", index, { index });
        const recordedClick = actions.at(-1);
        const handoffStarted = Date.now();
        let accepted = false;
        try {
          accepted = await options.onNavigateAction(destination.toString(), anchor.target || "_self");
        } finally {
          metric(runtime, Math.max(0, currentTurn), "page_handoff", handoffStarted, {
            source: "anchor",
            accepted,
            path: destination.pathname.slice(0, 500),
          });
        }
        if (!accepted) {
          const at = actions.lastIndexOf(recordedClick!);
          if (at >= 0) actions.splice(at, 1);
          if (options.runtimeV2 === false) controller.cancelActionBoundary();
        }
        else {
          // The destination document claims the same AgentRun. Never allow the
          // old document's Actor loop to report this click as a completed local
          // action or to make another decision while navigation is in flight.
          // Bounded: if the destination never claims the run, this rejects
          // rather than parking the runtime outside every budget check.
          return awaitPageHandoff();
        }
      }
    }
    // Buttons implemented by a framework can still navigate without exposing
    // a destination. Preserve a short-lived fallback only for that opaque
    // case; known anchors always use the durable handoff above. An invalid
    // model index has no element that could navigate, so do not move the Run
    // into awaiting-page before the controller reports target_not_found.
    // Record before clicking. If the click really replaces the document, nothing
    // after it ever runs — one production capability generation received an
    // experience with only the typed keyword, because the search button click that
    // led to the results page was lost, and the capability center had to guess.
    // A failed click removes the record again.
    record("click", "click_element_by_index", index, { index });
    const recorded = actions.at(-1);
    const unrecord = () => { const at = actions.lastIndexOf(recorded!); if (at >= 0) actions.splice(at, 1); };
    if (element && shouldArmOpaqueNavigation(element)) {
      await drainEvidence();
      emitCheckpoint("opaque-navigation-armed", { source: "click" });
      await options.onBeforeNavigationAction?.();
    }
    let result: Awaited<ReturnType<typeof click>>;
    try { result = await click(index); }
    catch (error) {
      unrecord();
      actionFailure = error instanceof Error ? error.message : String(error);
      throw error;
    }
    if (!result.success) {
      unrecord();
      actionFailure = result.message || `click_target_not_found:${index}`;
      throw new Error(actionFailure);
    }
    // A click that leaves the page unchanged is not treated as a failure. The
    // next model turn re-observes the page and decides for itself whether to
    // wait, try another path, or ask for a missing parameter.
    return result;
  };
  const inputText = controller.inputText.bind(controller);
  controller.inputText = async (index, text) => {
    await ensureWriteAuthorized(say().actionFill, "runtime_read_only_fill_forbidden");
    await simulatorPointerTo(elementAt(index));
    try {
      const result = await inputText(index, text);
      if (!result.success) throw new Error(result.message || `input_target_not_found:${index}`);
      record("fill", "input_text", index, { index, text });
      return result;
    }
    catch (error) { actionFailure = error instanceof Error ? error.message : String(error); throw error; }
  };
  const selectOption = controller.selectOption.bind(controller);
  controller.selectOption = async (index, option) => {
    await ensureWriteAuthorized(say().actionSelect, "runtime_read_only_select_forbidden");
    await simulatorPointerTo(elementAt(index));
    try {
      const liveTarget = controller.elementForTurn(currentTurn, index);
      // PrestaShop and many modern sites expose sort/filter choices as an
      // expanded menu of links, not a native <select>. If the model chose the
      // typed select tool for that control, use the visible semantic option
      // instead of sending an invalid DOM operation and burning retry turns.
      if (liveTarget.tagName.toLowerCase() !== "select") {
        const normalizeOption = (value: string) => value.toLocaleLowerCase("zh-CN").normalize("NFKC")
          .replace(/价格/gu, "price").replace(/名称/gu, "name").replace(/从高到低|高到低/gu, "high to low") // i18n-exempt: matching logic: these patterns read what a visitor typed, they are not shown
          .replace(/从低到高|低到高/gu, "low to high").replace(/从大到小|大到小/gu, "large to small") // i18n-exempt: matching logic: these patterns read what a visitor typed, they are not shown
          .replace(/从小到大|小到大/gu, "small to large").replace(/[\s\p{P}\p{S}]+/gu, ""); // i18n-exempt: matching logic: these patterns read what a visitor typed, they are not shown
        const wanted = normalizeOption(String(option));
        const visible = [...document.querySelectorAll("option,[role='option'],[role='menuitem']")]
          .filter((candidate) => {
            const style = getComputedStyle(candidate);
            const rect = candidate.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          });
        const match = visible.find((candidate) => {
          const label = normalizeOption(`${candidate.textContent || ""} ${candidate.getAttribute("aria-label") || ""}`);
          return wanted && label && (label === wanted || label.includes(wanted) || wanted.includes(label));
        });
        if (match) {
          (match as HTMLElement).click();
          record("select", "select_dropdown_option", index, { index, option });
          return { success: true, message: `Clicked visible option ${String(option)}` };
        }
      }
      const result = await selectOption(index, option);
      if (!result.success) throw new Error(result.message || `select_target_not_found:${index}`);
      record("select", "select_dropdown_option", index, { index, option });
      return result;
    }
    catch (error) { actionFailure = error instanceof Error ? error.message : String(error); throw error; }
  };
  let currentTurn = -1;
  let handled = 0;
  const currentScene = recognizeScene(options.release.scenes, capturePageSnapshot());
  const todayParts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const datePart = (type: string) => todayParts.find((part) => part.type === type)?.value || "";
  const today = `${datePart("year")}-${datePart("month")}-${datePart("day")}`;
  const knowledge = buildSiteKnowledgeContext(options.release, currentScene?.sceneId);
  const goalKnowledge = searchSiteKnowledge(options.release, options.goal, currentScene?.sceneId);
  const capabilities = capabilityManifest(options.release);
  let activitySequence = 0;
  let activeBrowserCallId = "";
  let activeActionStartedAt = 0;
  const activityPrefix = `${options.session.id}:${document.location.href}`;
  const observationActivityId = `observe:${activityPrefix}`;
  const resumedWithWork = Boolean(options.resumeTrace && (actions.length || toolReceipts.length));
  options.onStatus?.({
    phase: "adaptive",
    message: resumedWithWork ? say().readingResultEvidence : say().readingPageContent,
    detail: { activity: { id: observationActivityId, kind: "reasoning", state: "running", label: resumedWithWork ? say().labelReadResultEvidence : say().labelReadPageContent } },
  });
  const browserTools = new Set(["click_element_by_index", "set_text_by_index", "insert_text_by_index", "select_dropdown_option", "move_focus", "press_key_by_index", "submit_form_by_index", "scroll", "scroll_horizontally", "wait"]);
  const emitTool = (activity: Record<string, unknown>, message: string) => options.onStatus?.({ phase: "adaptive", message, detail: { activity } });
  const actionResult = async (
    action: ActionReceiptV2["action"],
    index: number | undefined,
    input: Record<string, JsonValue>,
    operation: () => Promise<string>,
  ) => {
    assertBudget(runtime);
    if (!["focus", "scroll"].includes(action)) await ensureWriteAuthorized(say().actionGeneric(action), `runtime_read_only_${action}_forbidden`);
    const before = controller.observationForTurn(currentTurn);
    if (!before) throw new Error("page_agent_observation_missing");
    const targetBefore = index === undefined ? undefined : controller.targetForTurn(currentTurn, index);
    if (index !== undefined) {
      const liveTarget = controller.elementForTurn(currentTurn, index);
      if (isSensitiveElement(liveTarget)) throw new Error("page_agent_sensitive_target_blocked");
    }
    if (isDuplicateUnchangedAction(runtime.actionReceipts, action, targetBefore, input)) {
      throw new Error("page_agent_duplicate_unchanged_action");
    }
    if (isRepeatedMenuTriggerAction(runtime.actionReceipts, action, targetBefore, input)
      || isRepeatedMenuTriggerElement(runtime.actionReceipts, action, index, index === undefined ? undefined : controller.elementForTurn(currentTurn, index), targetBefore)) {
      throw new Error("page_agent_repeated_menu_trigger_choose_visible_item");
    }
    const started = Date.now();
    const receipt: ActionReceiptV2 = {
      // A read-only/non-DOM tool may consume one or more model turns while the
      // page observation is deliberately reused. Authority keys the action to
      // the observation it actually acted on, not the SDK's later step number.
      id: uid("action_receipt"), turnIndex: before.turnIndex, action, target: targetBefore, input,
      beforeObservationId: before.id,
      dispatched: true,
      effect: "unknown",
      effectSignals: action === "press" ? { synthetic: true, isTrusted: false, handling: "unknown" } : {},
      startedAt: new Date(started).toISOString(), endedAt: new Date(started).toISOString(),
    };
    runtime.actionReceipts.push(receipt);
    emitCheckpoint("action-receipt-record", { action });
    controller.markActionBoundary();
    try {
      const output = await operation();
      receipt.endedAt = new Date().toISOString();
      metric(runtime, currentTurn, "action_execute", started, { action });
      emitCheckpoint("action-dispatched", { action });
      return output;
    } catch (error) {
      controller.cancelActionBoundary();
      receipt.dispatched = false;
      receipt.effectSignals = { error: error instanceof Error ? error.message : String(error) };
      receipt.endedAt = new Date().toISOString();
      emitCheckpoint("action-failed", { action });
      throw error;
    }
  };
  const runtimeAction = async (
    action: ActionReceiptV2["action"],
    index: number | undefined,
    input: Record<string, JsonValue>,
    operation: () => Promise<string>,
  ) => {
    if (options.runtimeV2 !== false) return actionResult(action, index, input, operation);
    const output = await operation();
    controller.markActionBoundary();
    return output;
  };
  const customTools: Record<string, PageAgentTool | null> = {
    done: tool({
      description: "Finish the user request. For every code-owned completion criterion, cite an exact short string visible in the current observation or a receipt. Success is rejected when a criterion or required entity is ungrounded; pre-existing matching content is not proof that the requested action ran.",
      inputSchema: z.object({
        text: z.string(),
        success: z.boolean(),
        outcome: z.enum(["success", "no-result", "business-rejection", "incomplete"]),
        output: z.record(z.string(), z.any()).default({}),
        completionEvidence: z.array(z.object({ criterion: z.string(), evidence: z.string().min(1) })).default([]),
      }),
      execute: async () => "Task completed",
    }),
    click_element_by_index: tool({
      description: "Click element by index.",
      inputSchema: z.object({ index: z.int().min(0) }),
      execute: ({ index }) => runtimeAction("click", index, { index }, async () => {
        const result = await controller.clickElement(index);
        if (!result.success) throw new Error(result.message);
        return result.message;
      }),
    }),
    select_dropdown_option: tool({
      description: "Select a dropdown option by its literal visible text.",
      inputSchema: z.object({ index: z.int().min(0), text: z.string() }),
      execute: ({ index, text }) => runtimeAction("select", index, { index, text }, async () => {
        const result = await controller.selectOption(index, literalPageAgentText(text));
        if (!result.success) throw new Error(result.message);
        return result.message;
      }),
    }),
    scroll: tool({
      description: "Scroll vertically, optionally within one indexed container.",
      inputSchema: z.object({
        down: z.boolean().default(true),
        num_pages: z.number().min(0).max(10).default(0.1),
        pixels: z.number().int().min(0).optional(),
        index: z.number().int().min(0).optional(),
      }),
      execute: ({ down, num_pages, pixels, index }) => runtimeAction("scroll", index, { down, num_pages, ...(pixels === undefined ? {} : { pixels }), ...(index === undefined ? {} : { index }) }, async () => {
        const result = await controller.scroll({ down, numPages: num_pages, pixels, index });
        if (!result.success) throw new Error(result.message);
        record("scroll", "scroll", index, { down, num_pages, ...(pixels === undefined ? {} : { pixels }) });
        return result.message;
      }),
    }),
    scroll_horizontally: tool({
      description: "Scroll horizontally, optionally within one indexed container.",
      inputSchema: z.object({ right: z.boolean().default(true), pixels: z.number().int().min(0), index: z.number().int().min(0).optional() }),
      execute: ({ right, pixels, index }) => runtimeAction("scroll", index, { right, pixels, ...(index === undefined ? {} : { index }) }, async () => {
        const result = await controller.scrollHorizontally({ right, pixels, index });
        if (!result.success) throw new Error(result.message);
        record("scroll", "scroll_horizontally", index, { right, pixels });
        return result.message;
      }),
    }),
    wait: tool({
      description: "Wait briefly for asynchronous page state to settle.",
      inputSchema: z.object({ seconds: z.number().min(1).max(10).default(1) }),
      execute: ({ seconds }, { signal }) => runtimeAction("wait", undefined, { seconds }, async () => {
        const lastUpdate = await controller.getLastUpdateTime();
        const remainingMs = Math.max(0, seconds * 1_000 - (Date.now() - lastUpdate));
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, remainingMs);
          signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        return `Waited ${seconds} seconds for page state.`;
      }),
    }),
    input_text: options.runtimeV2 === false ? tool({
      description: "Click and type literal text into an indexed input (legacy protocol compatibility).",
      inputSchema: z.object({ index: z.int().min(0), text: z.string() }),
      execute: ({ index, text }) => runtimeAction("set-text", index, { index, text }, async () => {
        const result = await controller.inputText(index, literalPageAgentText(text));
        if (!result.success) throw new Error(result.message);
        return result.message;
      }),
    }) : null,
    set_text_by_index: tool({
      description: "Replace the current value of one input with the exact literal text. Text such as Enter or Tab is inserted as text and is never treated as a key or submission.",
      inputSchema: z.object({ index: z.int().min(0), text: z.string() }),
      execute: async ({ index, text }) => actionResult("set-text", index, { index, text }, async () => {
        const result = await controller.inputText(index, literalPageAgentText(text));
        if (!result.success) throw new Error(result.message);
        return result.message;
      }),
    }),
    insert_text_by_index: tool({
      description: "Insert literal text at the current caret without clearing the field. Never use this tool for Enter, Tab, Escape, or form submission.",
      inputSchema: z.object({ index: z.int().min(0), text: z.string() }),
      execute: async ({ index, text }) => actionResult("insert-text", index, { index, text }, async () => {
        const element = controller.elementForTurn(currentTurn, index);
        element.focus({ preventScroll: true });
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
          const start = element.selectionStart ?? element.value.length;
          const end = element.selectionEnd ?? start;
          element.setRangeText(literalPageAgentText(text), start, end, "end");
          element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
        } else if (element.isContentEditable) {
          const accepted = element.ownerDocument.execCommand("insertText", false, literalPageAgentText(text));
          if (!accepted) throw new Error("insert_text_not_supported");
          element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
        } else throw new Error("insert_text_target_invalid");
        return `Inserted literal text into element ${index}.`;
      }),
    }),
    move_focus: tool({
      description: "Move focus forward or backward among the indexed targets in the current observation. This does not dispatch Tab or activate anything.",
      inputSchema: z.object({ direction: z.enum(["forward", "backward"]) }),
      execute: async ({ direction }) => {
        const ordered = controller.orderedTargetsForTurn(currentTurn);
        const currentIndex = ordered.findIndex((target) => {
          try { return controller.elementForTurn(currentTurn, target.index) === document.activeElement; }
          catch { return false; }
        });
        const offset = direction === "forward" ? 1 : -1;
        const nextPosition = currentIndex < 0
          ? (direction === "forward" ? 0 : ordered.length - 1)
          : (currentIndex + offset + ordered.length) % ordered.length;
        const next = ordered[nextPosition];
        if (!next) throw new Error("focus_target_not_found");
        return actionResult("focus", next.index, { direction }, async () => {
          const element = controller.elementForTurn(currentTurn, next.index);
          element.focus({ preventScroll: true });
          if (element.ownerDocument.activeElement !== element) throw new Error("focus_target_failed");
          return `Moved focus ${direction} to element ${next.index}.`;
        });
      },
    }),
    press_key_by_index: tool({
      description: "Dispatch one allow-listed semantic key (Enter, Escape, Space, Arrow*, Home, or End) on an indexed element. This synthetic event is never proof that the page handled the key.",
      inputSchema: z.object({
        index: z.int().min(0),
        key: z.string().refine(isAllowedPageAgentKey, "unsupported_key"),
      }),
      execute: async ({ index, key }) => actionResult("press", index, { index, key }, async () => {
        const element = controller.elementForTurn(currentTurn, index);
        await simulatorPointerTo(element);
        element.focus({ preventScroll: true });
        const form = element.closest("form");
        if (key === "Enter" && form instanceof HTMLFormElement) {
          // Enter on a form control is the same gesture as clicking its submit
          // button and the capability center needs to know about it; record it
          // before dispatching, because a document change leaves no chance later.
          record("click", "press_key_by_index", index, { index, key });
          // A trusted Enter may submit a native form before the page's own
          // handler exposes a concrete URL. Arm the same detachable boundary
          // used by submit_form_by_index so such a navigation can be claimed;
          // the short-lived intent is revoked automatically when the form is
          // handled in place.
          await drainEvidence();
          emitCheckpoint("opaque-navigation-armed", { source: "press-key" });
          await options.onBeforeNavigationAction?.();
        }
        const down = new KeyboardEvent("keydown", pageAgentKeyboardEventOptions(key));
        const proceed = element.dispatchEvent(down);
        element.dispatchEvent(new KeyboardEvent("keyup", pageAgentKeyboardEventOptions(key)));
        return `Dispatched synthetic ${key} on element ${index}${proceed ? "" : " (default prevented)"}; effect remains unknown until the next observation.`;
      }),
    }),
    submit_form_by_index: tool({
      description: "Submit the form associated with an indexed form control. Prefer clicking a visible submit button; use this only for implicit submission. Runs validation and submit handlers through requestSubmit().",
      inputSchema: z.object({ index: z.int().min(0) }),
      execute: async ({ index }) => actionResult("submit", index, { index }, async () => {
        const element = controller.elementForTurn(currentTurn, index);
        const form = element instanceof HTMLFormElement ? element : element.closest("form");
        if (!(form instanceof HTMLFormElement)) throw new Error("submit_form_not_found");
        await simulatorPointerTo(element, true);
        if (!form.checkValidity()) {
          form.reportValidity();
          throw new Error("submit_form_invalid");
        }
        record("click", "submit_form_by_index", index, { index });
        await drainEvidence();
        emitCheckpoint("opaque-navigation-armed", { source: "submit" });
        await options.onBeforeNavigationAction?.();
        form.requestSubmit();
        return `Submitted form for element ${index}.`;
      }),
    }),
    search_site_knowledge: tool({
      description: "Search the website knowledge base for product facts, page types, known routes, shared actions, and available capabilities. Use it when website structure or the shortest path is unclear. This tool reads knowledge only; it does not complete the user's task by itself.",
      inputSchema: z.object({ query: z.string().min(1), scope: z.enum(["all", "pages", "routes", "capabilities"]).default("all") }),
      execute: async ({ query, scope }) => {
        const callId = uid("tool");
        emitTool({ id: callId, kind: "knowledge", state: "running", label: say().labelQueryKnowledge, query }, say().queryingKnowledge(query));
        const found = searchSiteKnowledge(options.release, query, currentScene?.sceneId);
        const scoped = scope === "pages" ? { site: found.site, currentSceneId: found.currentSceneId, scenes: found.scenes }
          : scope === "routes" ? { currentSceneId: found.currentSceneId, scenes: found.scenes, operations: found.operations }
            : scope === "capabilities" ? { capabilities: found.capabilities }
              : found;
        const summary = say().knowledgeFound(found.scenes.length, found.operations.length, found.capabilities.length);
        const searchResultRefs = [
          ...found.scenes.map((item) => ({ id: item.id, label: item.name || item.id, type: "scene" })),
          ...found.operations.map((item) => ({ id: item.id, label: item.name || item.id, type: "operation" })),
          ...found.capabilities.map((item) => ({ id: item.id, label: item.name || item.id, type: "capability" })),
        ].slice(0, 8);
        toolReceipts.push({
          kind: "knowledge",
          name: query,
          status: "completed",
          summary,
          output: { matches: searchResultRefs.length, searchResultRefs },
          observedAt: new Date().toISOString(),
        });
        emitCheckpoint("knowledge-result");
        emitTool({
          id: callId,
          kind: "knowledge",
          state: "completed",
          label: say().labelSiteKnowledge,
          summary,
          output: { matches: searchResultRefs.length, searchResultRefs },
        }, summary);
        return JSON.stringify(scoped);
      },
    }),
    navigate_scene: tool({
      description: "Enter one verified parameterized website Scene directly. Use a Scene id returned by goalRelevantKnowledge or search_site_knowledge and bind every required parameter from the user's request. This is the fastest reliable UI-native route; never invent a Scene id or sample value.",
      inputSchema: z.object({ sceneId: z.string().min(1), bindings: z.record(z.string(), z.any()).default({}) }),
      execute: async ({ sceneId, bindings }) => {
        await ensureWriteAuthorized(say().actionNavigate, "runtime_read_only_navigation_forbidden");
        const scene = options.release.scenes.find((item) => item.id === sceneId);
        if (!scene || scene.directEntry !== "verified") return JSON.stringify({ success: false, error: "scene_direct_entry_unverified" });
        const values = Object.fromEntries(Object.entries(bindings).flatMap(([key, value]) => ["string", "number", "boolean"].includes(typeof value) ? [[key, value as JsonPrimitive]] : []));
        const missing = scene.parameters.filter((parameter) => parameter.required && (values[parameter.id] === undefined || values[parameter.id] === ""));
        if (missing.length) return JSON.stringify({ success: false, error: "scene_binding_missing", required: missing.map((item) => ({ id: item.id, name: item.name })) });
        let destination: string;
        try { destination = buildSceneUrl(scene, values, location.origin); }
        catch (error) { return JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }); }
        if (new URL(destination).origin !== location.origin) return JSON.stringify({ success: false, error: "scene_origin_rejected" });
        const callId = uid("tool");
        const summary = say().usingVerifiedEntry(scene.name);
        emitTool({ id: callId, kind: "knowledge", state: "running", label: say().labelUsingKnowledge, sceneId, bindings }, summary);
        toolReceipts.push({ kind: "knowledge", name: scene.name, status: "completed", summary, output: { sceneId, destination }, observedAt: new Date().toISOString() });
        emitCheckpoint("scene-selected", { sceneId });
        if (new URL(destination).href === location.href) {
          emitTool({ id: callId, kind: "knowledge", state: "completed", label: say().labelAlreadyThere, sceneId, bindings }, summary);
          return JSON.stringify({ success: true, sceneId, destination, alreadyThere: true });
        }
        if (!options.onNavigateAction) return JSON.stringify({ success: false, error: "scene_navigation_unavailable" });
        emitTool({ id: callId, kind: "knowledge", state: "completed", label: say().labelShortestEntry, sceneId, bindings }, summary);
        await drainEvidence();
        const handoffStarted = Date.now();
        let accepted = false;
        try {
          accepted = await options.onNavigateAction(destination, "_self", { url: destination, sceneId, bindings: values, observedAt: new Date().toISOString() });
        } finally {
          metric(runtime, Math.max(0, currentTurn), "page_handoff", handoffStarted, {
            source: "scene",
            accepted,
            sceneId,
          });
        }
        if (accepted) return awaitPageHandoff();
        return JSON.stringify({ success: false, error: "scene_navigation_rejected" });
      },
    }),
    call_capability: tool({
      description: "Call one published website capability by id. Prefer this over manually repeating page clicks when the capability matches the user's goal. The result is real execution output; after it returns, continue reasoning and answer the user. Never invent an id or missing required input.",
      inputSchema: z.object({ capabilityId: z.string().min(1), input: z.record(z.string(), z.any()).default({}) }),
      execute: async ({ capabilityId, input }) => {
        if (options.runtimeMode === "read-only") throw new Error("runtime_read_only_capability_forbidden");
        const capability = options.release.capabilities.find((item) => item.id === capabilityId);
        if (!options.callCapability || !capability) return `Capability unavailable: ${capabilityId}`;
        const callId = uid("tool");
        emitTool({ id: callId, kind: "capability", state: "running", capabilityId, capabilityName: capability.name, input }, widgetCopy(resolveWidgetLocale()).run.callingCapability(capability.name));
        try {
          await drainEvidence();
          const result = await options.callCapability(capabilityId, input as Record<string, JsonValue>, trace());
          const receipt: ToolReceipt = { kind: "capability", name: capability.name, capabilityId, status: result.success ? "completed" : "failed", summary: result.text, output: result.output, observedAt: new Date().toISOString() };
          toolReceipts.push(receipt);
          emitCheckpoint("capability-result", { capabilityId, status: receipt.status });
          emitTool({ id: callId, kind: "capability", state: result.success ? "completed" : "failed", capabilityId, capabilityName: capability.name, input, summary: result.text, output: result.output }, result.success ? widgetCopy(resolveWidgetLocale()).run.capabilityDone(capability.name) : say().capabilityCallFailed(capability.name));
          return JSON.stringify({ success: result.success, outcome: result.outcome.status, summary: result.text, output: result.output });
        } catch (error) {
          const summary = error instanceof Error ? error.message : String(error);
          toolReceipts.push({ kind: "capability", name: capability.name, capabilityId, status: "failed", summary, observedAt: new Date().toISOString() });
          emitCheckpoint("capability-result", { capabilityId, status: "failed" });
          emitTool({ id: callId, kind: "capability", state: "failed", capabilityId, capabilityName: capability.name, summary }, say().capabilityCallFailed(capability.name));
          return JSON.stringify({ success: false, error: summary });
        }
      },
    }),
    ask_user: options.onAskUser ? tool({
      description: "Ask the current user for one piece of missing business information or a decision, then continue the same task with their answer. Use this instead of guessing.",
      inputSchema: z.object({ question: z.string().min(1) }),
      execute: async ({ question }, { signal }) => {
        const callId = uid("tool");
        emitTool({ id: callId, kind: "human", state: "running", label: say().labelWaitingForUser, question }, say().needOneMoreThing);
        const answer = await withUserAnswerBudget(runtime, (answerSignal) => options.onAskUser!(question, { signal: answerSignal }), signal);
        const summary = say().userAnswered(answer);
        toolReceipts.push({ kind: "human", name: question, status: "completed", summary, output: { answer }, observedAt: new Date().toISOString() });
        emitCheckpoint("human-answer");
        emitTool({ id: callId, kind: "human", state: "completed", label: say().labelUserAnswered, summary }, say().gotItContinuing);
        return summary;
      },
    }) : null,
    execute_javascript: null,
  };
  const controlledTools = [
    "input_text", "click_element_by_index", "set_text_by_index", "insert_text_by_index",
    "select_dropdown_option", "submit_form_by_index", "move_focus", "press_key_by_index",
    "scroll", "scroll_horizontally", "wait", "navigate_scene", "call_capability", "search_site_knowledge", "ask_user",
  ];
  const availableTools = options.runtimeV2 === false
    ? new Set(options.runtimeMode === "read-only"
      ? ["scroll", "scroll_horizontally"]
      : ["input_text", "click_element_by_index", "select_dropdown_option", "scroll", "scroll_horizontally", "wait", "navigate_scene", "call_capability", "search_site_knowledge", "ask_user"])
    : new Set(runtimeV2ToolAvailability(options.runtimeMode === "read-only", options.readOnlySource === "runtime-derived"));
  for (const name of controlledTools) {
    if (!availableTools.has(name)) customTools[name] = null;
  }
  const agent = new PageAgentCore({
    pageController: controller,
    baseURL: endpointUrl(options.endpoint, `/api/site-agents/${encodeURIComponent(options.siteAgentId)}/model/v2`),
    apiKey: options.agentRunToken,
    // One bounded retry, not two. Every attempt is real user waiting time and
    // counts against the wall clock; a provider that fails twice in a row is
    // not going to succeed on a third try within this task.
    model: "sitewake-site-agent", language: "zh-CN", maxSteps, maxRetries: 1, stepDelay: 0.25,
    customFetch: async (input, init) => {
      if (options.runtimeV2 !== false) {
        consumePageAgentModelRequest(runtime);
        await waitForModelRequestSlot();
      }
      const started = Date.now();
      try {
        const headers = new Headers(init?.headers);
        headers.set("x-sitewake-ai-stage", "runtime-page-agent");
        const response = await fetch(input, { ...init, headers });
        if (response.status === 429) await new Promise((resolve) => setTimeout(resolve, providerRetryAfterMs(response)));
        return response;
      } finally {
        metric(runtime, currentTurn, "model_wait", started, { modelRequests: runtime.budget.modelRequests });
      }
    },
    instructions: completionReceipt ? {
      system: [
        "你是网站 Agent。一个已发布能力已经完成，下面是可信的结构化工具回执。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        receiptCompletionOnly
          ? "现在只调用 done：根据回执自然、准确地回答用户；保留有用的 Markdown 结构。不得再次观察或操作页面，不得调用其他工具，不得臆造回执外的信息。" // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
          : "该存量能力只返回了页面身份。请结合当前结果页中已经提供的紧凑证据回答用户，然后只调用 done。不得再次导航、点击或重复调用能力。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        `用户目标：${options.goal}`, // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        `能力回执：${JSON.stringify(completionReceipt)}`, // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        pageExecutionBriefInstructions(options.pageExecutionBrief),
        searchExecutionInstructions(options.goal),
      ].join("\n"),
      getPageInstructions: () => receiptCompletionOnly ? "能力已经完成；当前页面无需再次分析。" : "只读取当前结果页证据并形成回答，不执行页面动作。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
    } : {
      system: [
        "你是直接服务当前用户的网站 Agent，也是唯一负责理解目标、选择工具、操作页面和形成最终回答的角色。不要把任务转交给另一个虚构角色。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        pageExecutionBriefInstructions(options.pageExecutionBrief),
        searchExecutionInstructions(options.goal),
        options.runtimeMode !== "read-only"
          ? ""
          : options.readOnlySource === "runtime-derived"
            ? "当前默认只读：读取、滚动和 move_focus 可以直接做。如果这个目标确实必须在页面上操作，你可以照常调用点击/输入/选择/导航工具——运行时会先向用户申请一次授权，用户同意后本次任务才会真正执行；用户不同意就如实说明只完成了查看。不要为了绕开限制而反复重试。" // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
            : "当前站点被配置为只读：只允许读取、滚动和 move_focus；禁止点击、输入、选择、按键、提交、等待工具、调用能力或任何导航。这是站点的设置，不能通过询问用户来放开。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        options.runtimeMode === "read-only" ? "" : "本产品执行框架支持同站完整页面跳转和自动恢复。基础浏览器提示中关于‘只能处理单页应用、不要跳出当前页面’的限制在这里不适用；可以点击同站链接到达完成目标所需的页面。新标签会由运行时统一接管，不要自行拒绝合理导航。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        "遇到登录、验证码或身份确认时不要结束任务；运行时会暂停并让用户接管，完成后你会在同一任务中继续。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        options.runtimeMode === "read-only" ? "" : "你拥有三类能力：search_site_knowledge 查询网站知识；call_capability 调用已学会的可靠能力；页面观察与 click/input/select/scroll 等工具处理未知缺口。优先用最短、最可靠的工具组合。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        options.runtimeMode === "read-only" ? "" : "如果 goalRelevantKnowledge 中存在能直接满足目标的 verified Scene，优先调用 navigate_scene 并绑定用户给出的参数；不要为了寻找入口逐页点击，也不要使用示例值替代用户参数。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        options.runtimeMode === "read-only" ? "" : "调用能力后必须读取返回结果并继续决策；工具完成不等于对话结束。只有你调用 done 时才产生用户最终回答。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        options.runtimeMode === "read-only" ? "" : "如果用户缺少完成任务所必需的关键词、日期、对象或确认，必须使用 ask_user 追问，不能猜测，也不能拿示例值代替。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        `当前本地日期是 ${today}。用户说“今天/昨天/前天”时，应先换算为具体 YYYY-MM-DD，再在网站中执行；不要把相对日期原样填入只接受日期的控件。`, // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        options.runtimeMode === "read-only"
          ? "只读核对只允许读取当前 BrowserState、使用 scroll/scroll_horizontally 查看同页内容，或用 move_focus 移动焦点；随后必须用 done 报告 completed、not-completed 或 unknown。不得使用或建议任何其他工具。" // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
          : options.runtimeV2 === false
          ? "每一步必须严格使用旧版动作协议。点击用 click_element_by_index；输入用 input_text；选择用 select_dropdown_option；滚动用 scroll；等待用 wait；结束用 done。" // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
          : "每一步必须严格使用 Runtime V2 动作协议。点击用 click_element_by_index；替换为字面文本用 set_text_by_index；在光标处插入字面文本用 insert_text_by_index；焦点前后移动用 move_focus；允许的键盘语义用 press_key_by_index；隐式提交表单用 submit_form_by_index；选择用 select_dropdown_option；滚动用 scroll；等待用 wait；结束用 done。set_text_by_index 的 text=\"Enter\" 只会输入五个字母，按回车必须用 press_key_by_index。搜索框填写后不能再次点击输入框来提交，必须使用 press_key_by_index(key=\"Enter\")，或在没有可见提交按钮时使用 submit_form_by_index。Tab 不允许作为按键，焦点移动必须用 move_focus。可见提交按钮应优先点击。处理自定义排序/筛选菜单时，点击触发按钮展开后，下一步必须点击当前观察中可见的目标 menuitem/option；禁止再次点击同一个展开按钮，也不要用循环点击等待菜单变化。action 必须形如 {\"click_element_by_index\":{\"index\":12}}，不能把 index、type、fill 当成动作名。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        "不要因为页面正文出现‘无法’‘失败’‘没有’等字样就判断任务失败。聚焦用户目标和当前交互结果。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        "当用户要求排序、筛选或在当前列表上执行操作，但没有指定分类，而当前页面已经展示对应列表和可见控件时，默认目标范围就是当前页面；直接操作当前列表，不要仅因为知识里存在多个分类而追问。只有当前页面没有可用控件，或用户明确要求切换到另一个分类/页面时，才请求澄清或使用导航知识。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        "对‘按销量/评分/价格/名称等排序’以及‘筛选/排序当前列表’的执行目标，知识中的 Best sellers、New products、Prices drop 等入口只是静态导航，不等价于排序结果；不要为了这些词调用 navigate_scene 或点击静态栏目。若当前页面已有商品列表和排序控件，直接操作当前列表；只有用户明确要求打开该栏目页面时才导航。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        options.runtimeMode === "read-only"
          ? "只根据当前页可见证据核对原目标是否已经完成；证据不足时返回 unknown，绝不通过执行原动作来试探。" // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
          : "每次操作前先判断当前页面是否已经出现足以满足目标的结果。纯查看目标看到对应页面或状态即可 done；但搜索、筛选、提交、添加、删除等执行型目标，页面原本就存在同名内容或相同状态不代表动作已经完成，必须执行原始动词要求的动作并观察其结果，不能把最终动作退化成查找或浏览。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        options.requiredActionEvidence === "input"
          ? "当前目标要求把用户指定的业务值实际应用到页面：成功前必须留下 set_text_by_index、insert_text_by_index 或 select_dropdown_option 证据；仅滚动、等待、看到同名内容或打开通用列表都不算完成。" // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
          : options.requiredActionEvidence === "material"
            ? "当前目标是执行型操作：成功前必须留下点击、输入或选择证据；仅滚动、等待或阅读已有状态都不算完成。" // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
            : "",
        "完成后调用 done，并用面向用户的自然语言说明实际完成了什么；如果仍可继续，不要过早结束。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        `当前页面的紧凑知识上下文：${JSON.stringify(knowledge)}`, // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        options.runtimeMode === "read-only"
          ? `与当前用户目标语义相关的只读背景知识（不得据此导航或调用能力）：${JSON.stringify(goalKnowledge)}` // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
          : `与当前用户目标语义召回的知识（优先使用其中 verified 入口）：${JSON.stringify(goalKnowledge)}`, // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        options.runtimeMode === "read-only" ? "" : `可调用能力目录（id 必须原样使用）：${JSON.stringify(capabilities)}`, // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        toolReceipts.length ? `跨页面恢复的工具回执（这些动作已经发生，不要重复调用）：${JSON.stringify(toolReceipts)}` : "", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        actions.length ? `跨页面恢复的已执行页面动作（已经发生，不得重做）：${JSON.stringify(actions.slice(-8).map((action) => ({ action: action.action, input: action.input, page: action.page, element: action.element ? { role: action.element.role, name: action.element.accessibleName } : undefined })))}` : "", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        options.session.conversation.length > 1 ? `最近对话（只用于理解指代和连续目标）：\n${options.session.conversation.slice(-8).map((item) => `${item.role}: ${item.content}`).join("\n")}` : "", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        "页面知识只用于缩短路径，不代表目标已完成。结合当前页面选择最短、最直接的可见 UI 路径。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
      ].filter(Boolean).join("\n"),
      getPageInstructions: () => `当前 URL：${location.href}。任务会话：${options.session.id}。`, // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
    },
    customTools,
    onBeforeStep: async (_, stepIndex) => {
      const hookStarted = Date.now();
      const visibilityWait = await waitForPageAgentForeground(runtime, document, runtimeAbort.signal);
      if (visibilityWait.waitedMs) {
        metric(runtime, stepIndex, "turn_before_hook", visibilityWait.startedAt, {
          telemetry: "visibility-wait",
          waitedMs: visibilityWait.waitedMs,
          visibilityState: document.visibilityState,
        });
      }
      if (runtimeAbort.signal.aborted) throw abortError(runtimeAbort.signal);
      currentTurn = stepIndex;
      controller.beginTurn(stepIndex);
      if (options.runtimeV2 !== false) assertBudget(runtime);
      // Login walls, captchas and identity confirmations are no longer detected
      // here: the site's logged-in state is ours to guarantee in this phase, and
      // the detection cost a page-model request per step while its failure path
      // reported an unactionable technical fault. A page that does block the
      // task now ends through the ordinary budget limits with an honest message.
      metric(runtime, stepIndex, "turn_before_hook", hookStarted);
    },
    onAfterStep: async (_, history) => {
      for (const item of history.slice(handled)) {
        if (item.type !== "step") continue;
        const compiled = compileStep(item, controller.stateForTurn(item.stepIndex), options.release, targets, options.input);
        if (compiled) {
          const previous = steps.at(-1);
          const duplicate = previous?.op === compiled.op && "targetId" in previous && "targetId" in compiled && previous.targetId === compiled.targetId;
          if (!duplicate) steps.push(compiled);
          emitCheckpoint("compiled-step", { op: compiled.op });
        }
      }
      handled = history.length;
      elapsedBudget(runtime);
    },
  });
  agent.onAskUser = options.onAskUser;
  activeAgent = agent;
  activeRuntimeAbort = runtimeAbort;
  agent.addEventListener("activity", (event) => {
    const activity = (event as CustomEvent<AgentActivity>).detail;
    if (activity.type === "thinking") {
      // Recovery has a real local phase before the first model token: restore
      // the Run, capture the destination page and build BrowserState. Surface
      // it explicitly so a just-navigated page never looks frozen.
      emitTool({ id: observationActivityId, kind: "reasoning", state: "completed", label: resumedWithWork ? say().labelResultEvidenceRead : say().labelPageEvidenceRead }, resumedWithWork ? say().resultEvidenceReadNext : say().pageEvidenceReadNext);
    }
    if (activity.type === "executing") {
      // Tool invocations such as call_capability and done are not DOM actions.
      // They already emit a structured capability/result card above; rendering
      // them again as "page actions" created a deceptive duplicate timeline.
      if (!browserTools.has(String(activity.tool || ""))) return;
      activeActionStartedAt = Date.now();
      activeBrowserCallId = uid("tool");
      emitTool({ id: activeBrowserCallId, kind: "page", state: "running", type: activity.type, tool: activity.tool, input: activity.input, label: say().labelOperatePage }, activityText(activity));
      return;
    }
    if (activity.type === "executed") {
      if (!browserTools.has(String(activity.tool || ""))) return;
      if (activeActionStartedAt) metric(runtime, currentTurn, "action_execute", activeActionStartedAt, { tool: String(activity.tool || "") });
      activeActionStartedAt = 0;
      const id = activeBrowserCallId || `browser_${activitySequence++}`;
      emitTool({ id, kind: "page", state: "completed", type: activity.type, tool: activity.tool, input: activity.input, output: activity.output, duration: activity.duration, label: say().labelPageAction }, activityText(activity));
      activeBrowserCallId = "";
      return;
    }
    const reasoningLabel = completionReceipt
      ? (receiptCompletionOnly ? say().labelComposeFromCapability : say().labelReadResultPage)
      : activity.type === "thinking" ? say().labelUnderstandAndChoose : say().labelAdjustPlan;
    options.onStatus?.({ phase: "adaptive", message: activityText(activity), detail: { activity: { ...activity, id: `agent:${activityPrefix}:${activitySequence++}`, kind: "reasoning", state: "running", label: reasoningLabel } } });
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const longTaskObserver = observePageAgentLongTasks(runtime, () => currentTurn);
  let visibilityBudgetPaused = false;
  const visibilityChanged = () => {
    const startedAt = Date.now();
    if (document.visibilityState === "hidden" && !visibilityBudgetPaused) {
      pauseBudget(runtime, startedAt);
      visibilityBudgetPaused = true;
    } else if (document.visibilityState !== "hidden" && visibilityBudgetPaused) {
      resumeBudget(runtime, startedAt);
      visibilityBudgetPaused = false;
    }
    metric(runtime, Math.max(0, currentTurn), "turn_before_hook", startedAt, {
      telemetry: "visibility-change",
      visibilityState: document.visibilityState,
      activeBudgetPaused: visibilityBudgetPaused,
    });
  };
  visibilityChanged();
  document.addEventListener("visibilitychange", visibilityChanged);
  // The SDK panel is intentionally excluded from Agent observation, but a
  // visible fixed overlay can still make the site's controls underneath fail
  // hit-testing. Keep progress visible while removing only the SDK itself from
  // pointer targeting, so PageAgent observes and operates the real page rather
  // than being blinded by its own UI.
  for (const host of agentHosts) {
    host.dataset.sitewakePageOperating = "true";
    host.style.setProperty("pointer-events", "none", "important");
  }
  let round: ActorRound | undefined;
  let forcedTermination: Error | undefined;
  let forcedStop: Promise<void> | undefined;
  try {
    // A task may pause for user clarification, login, or a full-page handoff.
    // Step and model calls already have their own bounds; this outer guard only
    // prevents genuinely abandoned runs from living forever.
    const timeout = new Promise<never>((_, reject) => {
      const stopFor = (error: Error) => {
        if (forcedTermination) return;
        // Set the terminal reason before awaiting stop(): stop may resolve the
        // execute promise, but resolvePageAgentExecution still returns budget.
        forcedTermination = error;
        runtimeAbort.abort(error);
        forcedStop = (async () => {
          try { await agent.stop(); }
          catch { /* the forced terminal reason remains authoritative */ }
        })();
        void forcedStop.finally(() => reject(error));
      };
      const check = () => {
        if (options.runtimeV2 === false) {
          stopFor(new Error("adaptive_timeout"));
          return;
        }
        elapsedBudget(runtime);
        if (runtime.budget.exhaustedReason === "active-time") {
          stopFor(new Error("page_agent_budget_exhausted:active-time"));
          return;
        }
        timeoutId = setTimeout(check, Math.max(50, Math.min(1_000, runtime.budget.activeLimitMs - runtime.budget.activeElapsedMs)));
      };
      timeoutId = setTimeout(check, options.runtimeV2 === false ? 5 * 60_000 : 250);
    });
    const result = await resolvePageAgentExecution(agent.execute(task), timeout, () => forcedTermination, () => forcedStop);
    const completed = result.history.findLast((item) => item.type === "step" && item.action.name === "done");
    const doneInput = completed?.type === "step" ? completed.action.input as {
      outcome?: ActorRound["outcome"];
      output?: Record<string, JsonValue>;
      completionEvidence?: Array<{ criterion: string; evidence: string }>;
    } : undefined;
    round = {
      reportedSuccess: Boolean(result.success),
      text: typeof result.data === "string" ? result.data : JSON.stringify(result.data ?? ""),
      outcome: doneInput?.outcome,
      output: doneInput?.output,
      completionEvidence: doneInput?.completionEvidence,
      actionFailure: actionFailure || undefined,
    };
  } catch (error) {
    const terminal = forcedTermination || (error instanceof Error ? error : new Error(String(error)));
    round = { reportedSuccess: false, text: "", technicalError: terminal.message };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    const finalStartedAt = Date.now();
    let finalizationError: unknown;
    try {
      await finalizePageAgentRuntime(
        () => withPageAgentRuntimeDeadline(runtime, async (signal) => {
          const visibilityWait = await waitForPageAgentForeground(runtime, document, signal);
          if (visibilityWait.waitedMs) {
            metric(runtime, Math.max(0, currentTurn + 1), "turn_before_hook", visibilityWait.startedAt, {
              telemetry: "visibility-wait",
              waitedMs: visibilityWait.waitedMs,
              visibilityState: document.visibilityState,
              phase: "final-evidence",
            });
          }
          const openReceipt = [...runtime.actionReceipts].reverse().find((receipt) => receipt.dispatched && !receipt.afterObservationId);
          if (openReceipt) await controller.captureTerminalObservation(Math.max(currentTurn + 1, 0));
          if (signal.aborted) throw abortError(signal);
          runtime.controllerSeed = controller.exportSeed();
          await drainEvidenceRaw(signal);
        }),
        async () => {
          document.removeEventListener("visibilitychange", visibilityChanged);
          if (visibilityBudgetPaused) {
            resumeBudget(runtime);
            visibilityBudgetPaused = false;
          }
          while (runtime.pauseDepth) resumeBudget(runtime);
          elapsedBudget(runtime);
          runtimeAbort.abort(new DOMException("PageAgent round finalized", "AbortError"));
          longTaskObserver?.disconnect();
          try {
            agent.dispose();
          } finally {
            if (activeAgent === agent) activeAgent = undefined;
            if (activeRuntimeAbort === runtimeAbort) activeRuntimeAbort = undefined;
            agentHosts.forEach((host, index) => {
              delete host.dataset.sitewakePageOperating;
              const previous = previousPointerEvents[index];
              if (previous) host.style.pointerEvents = previous;
              else host.style.removeProperty("pointer-events");
            });
          }
        },
      );
    } catch (error) {
      finalizationError = error;
    } finally {
      metric(runtime, Math.max(0, currentTurn + 1), "checkpoint", finalStartedAt, {
        reason: "final-evidence",
        success: !finalizationError,
      });
      try { options.onTrace?.(trace()); }
      catch { /* final trace persistence cannot bypass lifecycle cleanup */ }
    }
    if (finalizationError && !round?.technicalError) {
      const budget = elapsedBudget(runtime);
      round = {
        reportedSuccess: false,
        text: "",
        technicalError: budget.exhaustedReason
          ? `page_agent_budget_exhausted:${budget.exhaustedReason}`
          : finalizationError instanceof Error ? finalizationError.message : String(finalizationError),
        actionFailure: actionFailure || undefined,
      };
    }
  }
  return round || { reportedSuccess: false, text: "", technicalError: "page_agent_round_unsettled" };
}

async function runAdaptive(options: AdaptiveOptions) {
  cancelled = false;
  const episodeId = options.resumeTrace?.episodeId || uid("episode");
  const startedAt = options.resumeTrace?.startedAt || new Date().toISOString();
  const inheritedBudget = options.pageExecutionBudget || options.resumeTrace?.budgetEvidence;
  const runtime: RuntimeEvidence = {
    actionReceipts: [...(options.resumeTrace?.actionReceiptsV2 || [])],
    observationRefs: [...(options.resumeTrace?.observationRefs || [])],
    observations: [],
    runtimeMetrics: [...(options.resumeTrace?.runtimeMetrics || [])],
    startedAt: Date.now() - Math.max(0, inheritedBudget?.activeElapsedMs || 0),
    pauseDepth: 0,
    // A cross-page resume continues the same user task, so the wall clock has
    // to continue too — otherwise every navigation would silently hand the task
    // a fresh unlimited budget, which is exactly the hang this limit prevents.
    wallStartedAt: Date.now() - Math.max(0, inheritedBudget?.wallElapsedMs || 0),
    wallExcludedMs: 0,
    budget: {
      activeLimitMs: Math.min(ACTIVE_LIMIT_MS, Math.max(1_000, inheritedBudget?.activeLimitMs || ACTIVE_LIMIT_MS)),
      modelRequestLimit: Math.min(MODEL_REQUEST_LIMIT, Math.max(1, inheritedBudget?.modelRequestLimit || MODEL_REQUEST_LIMIT)),
      activeElapsedMs: Math.max(0, inheritedBudget?.activeElapsedMs || 0),
      modelRequests: Math.max(0, inheritedBudget?.modelRequests || 0),
      noProgressCount: Math.max(0, inheritedBudget?.noProgressCount || 0),
      wallLimitMs: Math.min(WALL_LIMIT_MS, Math.max(1_000, inheritedBudget?.wallLimitMs || WALL_LIMIT_MS)),
      wallElapsedMs: Math.max(0, inheritedBudget?.wallElapsedMs || 0),
      backgroundWaitLimitMs: Math.min(BACKGROUND_WAIT_LIMIT_MS, Math.max(1_000, inheritedBudget?.backgroundWaitLimitMs || BACKGROUND_WAIT_LIMIT_MS)),
      backgroundWaitMs: 0,
      askUserLimitMs: Math.min(ASK_USER_LIMIT_MS, Math.max(1_000, inheritedBudget?.askUserLimitMs || ASK_USER_LIMIT_MS)),
      askUserWaitMs: 0,
      exhaustedReason: inheritedBudget?.exhaustedReason,
    },
  };
  const start = options.resumeTrace?.startSnapshot || capturePageSnapshot(0);
  // Original-DOM replay can contain page and form content. Production embeds
  // opt in explicitly; the default execution path never starts a recorder.
  const domRecorder = options.domReplay
    ? startDomReplayRecorder({ siteAgentId: options.siteAgentId, endpoint: options.endpoint, episodeId, runId: options.session.id, runToken: options.agentRunToken, sessionId: browserSessionId(), documentId: start.documentId })
    : undefined;
  const targets = new Map((options.resumeTrace?.targets || []).map((target) => [target.id, target]));
  const steps: PageProgramStep[] = [...(options.resumeTrace?.steps || [])];
  const actions: ExperienceActionEvidence[] = [...(options.resumeTrace?.actions || [])];
  const toolReceipts: ToolReceipt[] = [...(options.resumeTrace?.toolReceipts || [])];
  const emitTrace = () => options.onTrace?.({
    startedAt,
    episodeId,
    startSnapshot: start,
    steps,
    targets: [...targets.values()],
    actions,
    toolReceipts,
    ...(options.evidenceV2 === false ? {} : {
      actionReceiptsV2: runtime.actionReceipts,
      observationRefs: runtime.observationRefs,
      budgetEvidence: elapsedBudget(runtime),
      runtimeMetrics: runtime.runtimeMetrics,
    }),
  });
  emitTrace();
  const continuation = options.resumeTrace && (actions.length || toolReceipts.length)
    ? "这是同一个任务跨页面恢复后的继续执行。已完成的动作和工具回执已在上下文中，请从当前页面继续，禁止返回旧页面重新开始。" // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
    : "";
  const remainingBudget = Math.max(3, options.maxSteps - Math.min(options.maxSteps - 3, steps.length));
  const executionTask = pageExecutionTask(options.pageExecutionBrief, options.goal);
  let actor = await executeActorRound(options, `${executionTask}${continuation ? `\n\n${continuation}` : ""}`, remainingBudget, steps, targets, actions, toolReceipts, start, startedAt, episodeId, runtime);
  const completedCapabilityReceipt = () => toolReceipts.some((receipt) => receipt.kind === "capability" && receipt.status === "completed");
  const executionEvidence = () => assessPageExecutionEvidence({
    brief: options.pageExecutionBrief,
    receipts: runtime.actionReceipts,
    observations: runtime.observations,
    completionEvidence: actor.completionEvidence,
  });
  const missingExecutionEvidence = () => {
    if (!actor.reportedSuccess || !["success", "no-result"].includes(actor.outcome || "")
      || completedCapabilityReceipt()) return false;
    const dispatchedV2 = runtime.actionReceipts.filter((receipt) => receipt.dispatched);
    const missingRequiredAction = options.requiredActionEvidence === "input"
      ? !actions.some((item) => item.action === "fill" || item.action === "select")
        && !dispatchedV2.some((receipt) => ["set-text", "insert-text", "select"].includes(receipt.action))
      : options.requiredActionEvidence === "material"
        ? !actions.some((item) => ["click", "fill", "select"].includes(item.action))
          && !dispatchedV2.some((receipt) => ["click", "set-text", "insert-text", "select", "submit"].includes(receipt.action))
        : false;
    return missingRequiredAction || !executionEvidence().satisfied;
  };
  for (let correctionAttempt = 1; correctionAttempt <= MAX_EVIDENCE_CORRECTIONS
    && missingExecutionEvidence()
    // Once a receipt looks like the irreversible business action, never
    // replay it automatically. The fallback is explicit user confirmation.
    && !runtime.actionReceipts.some((receipt) => receipt.dispatched && receiptSuggestsIrreversibleAction(receipt)); correctionAttempt += 1) {
    const missing = executionEvidence();
    const correction = [
      options.requiredActionEvidence === "input"
        ? "上一次判断把页面已有的同名内容或详情页误当成了原始操作结果。请把用户指定的值真正应用到控件并观察新结果。" // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
        : "上一次判断缺少原始动作产生的可验证结果。请继续完成原始动词要求的页面动作并观察新结果。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
      missing.missingEntities.length ? `尚未绑定到发生变化动作的实体字段：${missing.missingEntities.join("、")}。` : "", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
      missing.missingCriteria.length ? `尚未提供逐字可核验引用的完成条件：${missing.missingCriteria.join("；")}。` : "", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
      "再次调用 done 时，每条 completionEvidence.evidence 必须是当前 BrowserState 或动作回执中真实出现的短文本；不得用推断或页面原有同名内容代替动作结果。", // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
    ].filter(Boolean).join("\n");
    options.onStatus?.({
      phase: "adaptive",
      message: say().checkingOriginalAction,
      detail: { activity: { id: `goal-evidence:${options.session.id}:${correctionAttempt}`, kind: "reasoning", state: "running", label: say().labelCheckFinalEvidence } },
    });
    actor = await executeActorRound(
      options,
      `${executionTask}\n\n纠偏要求：${correction}`, // i18n-exempt: model prompt body; the reader's language is set by replyLanguageInstruction
      Math.max(3, options.maxSteps - Math.min(options.maxSteps - 3, steps.length)),
      steps,
      targets,
      actions,
      toolReceipts,
      start,
      startedAt,
      episodeId,
      runtime,
    );
  }
  let finalExecutionEvidence = executionEvidence();
  const needsHumanConfirmation = !aiHasTerminalDecision(actor)
    && !runtime.humanConfirmation
    && Boolean(options.onAskUser)
    && runtime.actionReceipts.some((receipt) => receipt.dispatched);
  if (needsHumanConfirmation) {
    const question = say().confirmQuestion(options.goal);
    options.onStatus?.({ phase: "adaptive", message: say().waitingForConfirmation, detail: { activity: { id: `human-confirm:${options.session.id}`, kind: "human", state: "running", label: say().labelConfirmResult }, question } });
    try {
      const rawAnswer = await withUserAnswerBudget(runtime, (answerSignal) => options.onAskUser!(question, {
        signal: answerSignal,
        choices: [
          { label: say().confirmYes, value: "success" },
          { label: say().confirmNo, value: "failed" },
        ],
      }), activeRuntimeAbort?.signal || new AbortController().signal);
      const answer = parseHumanConfirmationAnswer(rawAnswer);
      // Keep only the bounded decision. The free-form answer may contain
      // unrelated user data and is not needed for execution evidence.
      runtime.humanConfirmation = { question, answer, confirmedAt: new Date().toISOString() };
      emitTrace();
      if (answer === "success") {
        actor = { ...actor, reportedSuccess: true, outcome: "success", text: actor.text || say().userConfirmedSuccess };
      } else {
        actor = { ...actor, reportedSuccess: false, outcome: "incomplete", text: answer === "failed" ? say().userConfirmedFailure : say().userCouldNotConfirm };
      }
      finalExecutionEvidence = executionEvidence();
    } catch (error) {
      runtime.humanConfirmation = { question, answer: "unknown", confirmedAt: new Date().toISOString() };
      emitTrace();
    }
  }
  if (missingExecutionEvidence() && !aiReportedSuccess(actor) && runtime.humanConfirmation?.answer !== "success") {
    actor = {
      ...actor,
      reportedSuccess: false,
      outcome: "incomplete",
      text: finalExecutionEvidence.missingEntities.length
        ? say().missingBoundFields(finalExecutionEvidence.missingEntities.join(widgetCopy(resolveWidgetLocale()).run.listSeparator))
        : finalExecutionEvidence.missingCriteria.length
          ? say().missingVisibleEvidence
          : options.requiredActionEvidence === "input"
            ? say().missingInputApplied
            : say().missingAction,
    };
  }
  const end = capturePageSnapshot(steps.length + 3);
  void domRecorder?.stop();
  let status: TaskEpisode["outcome"]["status"];
  let code: string;
  let summary: string;
  const budgetTermination = terminationFromBudget(actor.technicalError, runtime.budget.exhaustedReason);
  const unauthorizedWrite = String(actor.technicalError || "").startsWith("runtime_read_only_not_authorized");
  if (cancelled) {
    status = "execution-fault"; code = "cancelled"; summary = widgetCopy(resolveWidgetLocale()).run.taskStopped;
  } else if (unauthorizedWrite) {
    // Declining to authorize a page write is a user decision, not a fault.
    status = "unknown";
    code = "agent_read_only_not_authorized";
    summary = technicalFaultSummary("runtime_read_only_not_authorized");
  } else if (budgetTermination) {
    // Running out of budget is not a malfunction: the task simply could not be
    // confirmed within the time the user was actually present for. Reporting it
    // as a technical fault hid the one thing the user could act on.
    status = budgetTermination.status;
    code = budgetTermination.code;
    summary = budgetTermination.summary;
  } else if (actor.technicalError || (actor.actionFailure && !actions.length && !toolReceipts.length)) {
    status = "execution-fault";
    code = (actor.technicalError || actor.actionFailure || "agent_runtime_error").split(":")[0] || "agent_runtime_error";
    summary = actor.actionFailure && !actions.length && !toolReceipts.length
      ? say().noExpectedEffect
      : actor.text || technicalFaultSummary(actor.technicalError);
  } else if (actor.outcome === "no-result") {
    status = "no-result";
    code = "agent_no_result";
    summary = actor.text;
  } else if (actor.outcome === "business-rejection") {
    status = "business-rejection";
    code = "agent_business_rejection";
    summary = actor.text;
  } else if (!actor.reportedSuccess || actor.outcome === "incomplete") {
    status = "unknown";
    code = "agent_incomplete";
    summary = actor.text || say().notFinishedYet;
  } else {
    status = "success";
    code = "agent_completed";
    summary = actor.text || widgetCopy(resolveWidgetLocale()).run.completedGoalQuoted(options.goal);
  }

  const output = toolReceipts.reduce<Record<string, JsonValue>>((result, receipt) => receipt.output ? { ...result, ...receipt.output } : result, { ...(actor.output || {}) });
  const structuredOutput = compactStructuredOutput(output) as Record<string, JsonValue>;
  const hasStructuredOutput = Object.keys(structuredOutput).length > 0;
  // Capability construction is allowed only from an observed browser
  // operation. A fluent text answer or a structured answer with no page
  // action is not reusable execution evidence. `no-result` is valuable when
  // the Agent really performed the operation and observed an empty result.
  // Every kind named here must be one the runtime actually records; a kind
  // that nothing writes is a rule that can never fire. Scrolling was in this
  // list and in no recorder, so a run that reached its goal by scrolling
  // looked like a run that never touched the page, and the capability centre
  // was told there was no action evidence.
  const hasPageAction = actions.some((item) => EXPERIENCE_PAGE_ACTIONS.includes(item.action))
    || runtime.actionReceipts.some((receipt) => receipt.dispatched);
  // `completionEvidence` is a diagnostic judgement, not the admission gate
  // for collecting raw experience. If PageAgent itself has reached a terminal
  // success, keep the complete action/observation trace and let the trusted
  // server-side authority decide whether it can enter capability generation.
  // A failed/unknown human choice remains terminal and is never reusable.
  const evidencedExperience = shouldRecordAdaptiveExperience(
    status,
    hasPageAction,
    runtime.humanConfirmation?.answer,
  );
  const episode: TaskEpisode = {
    schemaVersion: SITE_AGENT_SCHEMA_VERSION, id: episodeId, siteAgentId: options.siteAgentId, taskSessionId: options.session.id,
    browserSessionId: browserSessionId(), documentId: start.documentId, mode: options.mode, goal: options.goal, normalizedGoal: normalizeGoal(options.goal), input: options.input,
    startedAt, endedAt: new Date().toISOString(), releaseId: options.release.id, pageExecutionBrief: options.pageExecutionBrief, startSnapshot: start, endSnapshot: end, transitions: [],
    outcome: {
      status, code, summary, evaluatedAt: new Date().toISOString(),
      evidence: {
        actions: steps.length, urlChanged: start.url !== end.url, headingChanged: start.heading !== end.heading, contentChanged: start.visibleText !== end.visibleText,
        repairAttempt: options.repairAttempt || 0, actorReportedSuccess: actor.reportedSuccess, actorText: actor.text, technicalError: actor.technicalError || actor.actionFailure || "",
        decisionSource: "user-agent",
        ...(runtime.readOnlyAuthorization
          ? { readOnlyAuthorization: runtime.readOnlyAuthorization.answer, readOnlyAuthorizationSource: "user-answer" }
          : {}),
        toolReceiptCount: toolReceipts.length,
        entityBindings: finalExecutionEvidence.entityBindings,
        completionEvidence: finalExecutionEvidence.completionEvidence,
        actionReceiptCount: runtime.actionReceipts.length,
        actionReceiptsV2: runtime.actionReceipts,
        observationRefs: runtime.observationRefs,
        unsettledActionReceiptIds: runtime.actionReceipts.filter((receipt) => receipt.dispatched && !receipt.afterObservationId).map((receipt) => receipt.id),
        ...(runtime.humanConfirmation ? { humanConfirmation: runtime.humanConfirmation } : {}),
        ...(hasStructuredOutput ? { structuredOutput } : {}),
      },
    },
    experience: evidencedExperience ? {
      version: 1,
      actions,
      actorSummary: actor.text,
      judgeEvidence: [end.url, end.heading || end.title].filter(Boolean),
      toolReceipts,
      ...(options.evidenceV2 === false ? {} : {
        actionReceiptsV2: runtime.actionReceipts,
        observationRefs: runtime.observationRefs,
        budgetEvidence: elapsedBudget(runtime),
        runtimeMetrics: runtime.runtimeMetrics,
      }),
    } : undefined,
  };
  return { success: ["success", "no-result", "business-rejection"].includes(status), text: summary, output, episode };
}

const adaptiveGlobal = {
  run: runAdaptive,
  cancel() {
    cancelled = true;
    activeRuntimeAbort?.abort(new DOMException("PageAgent cancelled", "AbortError"));
    void activeAgent?.stop();
  },
};
window.SiteWakeAdaptive = adaptiveGlobal;
