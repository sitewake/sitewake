import { AgentStartupError } from './runtime-release-client';
import { hasVisibleOperations, renderOperationTrace } from "./user-agent-trace";
import { mergeResumedConversation, activitiesForTurn } from "./user-agent-conversation";
import { AgentPort, callFromClaimedTaskLaunch, type CapabilityV2RuntimeDefinition, type PortStatus, type TaskLaunchExecutionPin, type TaskResult } from "./user-agent-port";
import { defaultAgentConfig, normalizeAgentConfig, normalizeGoal, uid, type AgentConfig, type AgentRunActivity, type CapabilityDefinition, type JsonValue, type SiteAgentReleaseV2 } from "../lib/site-knowledge/protocol";
import { matchCapability } from "../lib/site-knowledge/planner";
import { userInvocableCapabilities } from "../lib/site-knowledge/site-knowledge";
import { assertRuntimeTeachingAllowed } from "../lib/site-knowledge/runtime-policy";
import { dispatchSiteWakeState } from "./user-agent-state";
import { WIDGET_STYLESHEET_PATH } from "./user-agent-styles";
import { followRequestLocale, forgetConversationLocale, localizedCapabilityName, resolveChromeCopy, resolveWidgetLocale, saveWidgetLocale, widgetCopy, WIDGET_LOCALE_LABELS, type WidgetCopy, type WidgetLocale } from "./user-agent-copy";

type ChatMessage = {
  id: string;
  kind: "user" | "assistant" | "error" | "system";
  text: string;
  taskId?: string;
  goal?: string;
  input?: Record<string, JsonValue>;
  startupFailure?: boolean;
  outcome?: "success" | "no-result" | "business-rejection" | "unknown" | "execution-fault";
  actions?: Array<"retry" | "teach" | "reconcile" | "continue-confirmed">;
};
type ExperienceMode = "idle" | "running" | "teach-intent" | "teaching";
type StoredExperience = { messages?: ChatMessage[]; goal?: string; mode?: ExperienceMode; panelOpen?: boolean; activityTimeline?: AgentRunActivity[]; savedAt?: number };
type StoredTaskLaunch = {
  launchId: string;
  claimKey: string;
  goal: string;
  capabilityId?: string;
  input: Record<string, JsonValue>;
  mode: "run" | "demonstrate";
  executionMode: "run" | "debug";
  releaseId?: string;
  releaseVersion?: number;
  revisionId?: string;
  executionOwnerId?: string;
  executionFence?: number;
  started: boolean;
  savedAt: number;
  leaseExpiresAt?: number;
  pendingTerminalPatch?: Record<string, unknown>;
  terminalRetryStartedAt?: number;
};
type StoredTaskLaunchClaim = {
  launchId: string;
  token: string;
  claimKey: string;
  savedAt: number;
};
type SiteWakeApi = {
  /** Reattach the same runtime after a host framework removes its DOM. */
  mount?(siteAgentId: string, endpoint: string): void;
  open(): void;
  close(): void;
  run(goal: string, input?: Record<string, JsonValue>): Promise<TaskResult | undefined>;
  call(capabilityId: string, input?: Record<string, JsonValue>): Promise<TaskResult | undefined>;
  teach(goal: string): Promise<void>;
  finishTeaching(): Promise<TaskResult>;
  cancel(): void;
  getRelease(): SiteAgentReleaseV2;
  /** Present only on a page the validation runner marked before this script loaded. */
  validateCandidate?(runtime: CapabilityV2RuntimeDefinition, input?: Record<string, JsonValue>): Promise<TaskResult | undefined>;
};

declare global {
  interface Window {
    SITEWAKE_CONFIG?: { siteAgentId?: string; endpoint?: string; open?: boolean; maxSteps?: number; runtimeMode?: "full" | "read-only"; allowedCapabilityIds?: string[] };
    SiteWake?: SiteWakeApi;
    /** Set by the validation runner before the widget loads; never by a site. */
    __sitewakeValidation?: boolean;
  }
}

const bootstrapScript = document.currentScript as HTMLScriptElement | null;
const frameDenied = bootstrapScript?.dataset.allowFrame === "false";
// Older host integrations remove legacy globals and widget nodes on remount,
// but do not know about window.SiteWake. Reuse the live runtime, never create
// duplicate timers or restart an in-flight task. Only explicit script loading
// remounts the widget; we do not observe/reinsert nodes on private routes.
const existingRuntime = window.SiteWake;
if ((window.parent === window || !frameDenied) && bootstrapScript?.dataset.siteAgent && existingRuntime) {
  existingRuntime.mount?.(bootstrapScript.dataset.siteAgent, bootstrapScript.dataset.endpoint || new URL(bootstrapScript.src).origin);
}


if ((window.parent === window || !frameDenied) && !window.SiteWake) {
  const script = bootstrapScript;
  const config = {
    siteAgentId: script?.dataset.siteAgent || window.SITEWAKE_CONFIG?.siteAgentId || "",
    endpoint: script?.dataset.endpoint || window.SITEWAKE_CONFIG?.endpoint || (script?.src ? new URL(script.src).origin : ""),
    maxSteps: Number(script?.dataset.maxSteps || window.SITEWAKE_CONFIG?.maxSteps || 12),
    visibility: (script?.dataset.visibility === "sandbox" || script?.dataset.visibility === "system" ? script.dataset.visibility : "production") as "production" | "sandbox" | "system",
    runtimeMode: (script?.dataset.runtimeMode === "read-only" || window.SITEWAKE_CONFIG?.runtimeMode === "read-only" ? "read-only" : "full") as "full" | "read-only",
    allowedCapabilityIds: (script?.dataset.allowedCapabilityIds?.split(",") || window.SITEWAKE_CONFIG?.allowedCapabilityIds || []).map((value) => value.trim()).filter(Boolean),
    open: script?.dataset.open === "true" || window.SITEWAKE_CONFIG?.open === true,
    // Original-DOM replay may contain page and form content. It is therefore
    // off unless the embedding script explicitly opts this document in.
    domReplay: script?.dataset.domReplay === "true",
    embedded: window.parent !== window,
    // Set only by the console's own rehearsal, which serves the page with the
    // snippet in it to find out what a browser would do. Everything runs as
    // usual; the handshake simply is not recorded as an installation.
    rehearsal: script?.dataset.sitewakeRehearsal === "1",
  };
  if (!config.siteAgentId) throw new Error("SiteWake requires data-site-agent");
  const dispatchState = (state: "booting" | "ready" | "error", message?: string, releaseVersion?: number) => {
    dispatchSiteWakeState(window, {
      state,
      siteAgentId: config.siteAgentId,
      ...(releaseVersion === undefined ? {} : { releaseVersion }),
      ...(message ? { message } : {}),
    });
  };
  dispatchState("booting");
  const documentTaskLaunchOwnerId = uid("owner");
  // Browser storage keys keep their original spelling on purpose: renaming them
  // would orphan an in-flight cross-page run and the stored experience of every
  // visitor who was mid-task when this build shipped. They are invisible to
  // users and carry no brand meaning at runtime.
  const storageKey = `sitewake:v5:${config.siteAgentId}:experience`;
  const taskLaunchStorageKey = `sitewake:v5:${config.siteAgentId}:task-launch`;
  const taskLaunchClaimStorageKey = `sitewake:v5:${config.siteAgentId}:task-launch-claim`;

  // Capture launch and legacy goal directives synchronously. Many applications
  // rewrite their hash during hydration; waiting for Release.ready() made a
  // control-plane launch disappear before SiteWake could claim it.
  const startupHash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const capturedRunToken = startupHash.get("sitewake-run") || "";
  const capturedReturnHash = startupHash.get("sitewake-return-hash") || "";
  let capturedLaunchToken = startupHash.get("sitewake-launch") || "";
  let capturedTaskLaunchClaim: StoredTaskLaunchClaim | undefined;
  try {
    const storedClaim = JSON.parse(
      sessionStorage.getItem(taskLaunchClaimStorageKey) || "null",
    ) as StoredTaskLaunchClaim | null;
    if (capturedLaunchToken) {
      const separator = capturedLaunchToken.indexOf(".");
      const launchId = separator > 0 ? capturedLaunchToken.slice(0, separator) : "";
      if (launchId) {
        capturedTaskLaunchClaim = storedClaim
          && storedClaim.launchId === launchId
          && storedClaim.token === capturedLaunchToken
          && Date.now() - storedClaim.savedAt < 15 * 60_000
          ? storedClaim
          : {
              launchId,
              token: capturedLaunchToken,
              claimKey: uid("claim"),
              savedAt: Date.now(),
            };
        // Persist before stripping the URL token. A reload can therefore
        // retry the identical idempotent claim after either a pre-commit
        // network failure or a committed response that was lost in transit.
        sessionStorage.setItem(
          taskLaunchClaimStorageKey,
          JSON.stringify(capturedTaskLaunchClaim),
        );
      }
    } else if (storedClaim && Date.now() - storedClaim.savedAt < 15 * 60_000) {
      capturedTaskLaunchClaim = storedClaim;
      capturedLaunchToken = storedClaim.token;
    } else {
      sessionStorage.removeItem(taskLaunchClaimStorageKey);
    }
  } catch {
    sessionStorage.removeItem(taskLaunchClaimStorageKey);
  }
  const capturedStartupGoal = startupHash.get("sitewake-goal") || "";
  const capturedStartupMode = startupHash.get("sitewake-mode") || "";
  for (const key of ["sitewake-run", "sitewake-return-hash", "sitewake-launch", "sitewake-goal", "sitewake-mode"]) startupHash.delete(key);
  if (capturedRunToken || capturedLaunchToken || capturedStartupGoal) {
    const restoredHash = capturedReturnHash || (startupHash.size ? startupHash.toString() : "");
    const launchTransportUrl = location.href;
    history.replaceState(history.state, "", `${location.pathname}${location.search}${restoredHash ? `#${restoredHash}` : ""}`);
    if (location.href !== launchTransportUrl) {
      // replaceState intentionally avoids a native navigation, but a HashRouter
      // may already be mounted before this deferred SDK script executes. Notify
      // both native hash listeners and routers that use the history popstate
      // contract so their rendered page catches up with the restored URL.
      window.dispatchEvent(new HashChangeEvent("hashchange", {
        oldURL: launchTransportUrl,
        newURL: location.href,
      }));
      window.dispatchEvent(new PopStateEvent("popstate", {
        state: history.state,
      }));
    }
  }

  const taskLaunchExecutionPin = (value: Pick<StoredTaskLaunch, "releaseId" | "releaseVersion" | "revisionId">): TaskLaunchExecutionPin | undefined => {
    const supplied = Boolean(value.releaseId || value.revisionId || value.releaseVersion !== undefined);
    if (!supplied) return undefined;
    if (!value.releaseId || !value.revisionId || !Number.isInteger(value.releaseVersion) || Number(value.releaseVersion) < 0) {
      throw new Error("task_launch_execution_pin_incomplete");
    }
    return {
      releaseId: value.releaseId,
      releaseVersion: Number(value.releaseVersion),
      revisionId: value.revisionId,
    };
  };
  // This flag is deliberately document-local. sessionStorage (including the
  // claim key and server fence) is cloned by "Duplicate tab"; execution
  // authority is not. A new document only regains authority after AgentPort
  // has won the cross-tab continuation lease.
  let taskLaunchMutationAuthority = Boolean(capturedLaunchToken);
  let activeTaskLaunch: StoredTaskLaunch | undefined;
  try {
    const stored = JSON.parse(sessionStorage.getItem(taskLaunchStorageKey) || "null") as StoredTaskLaunch | null;
    const executionPin = stored ? taskLaunchExecutionPin(stored) : undefined;
    if (stored?.capabilityId && !executionPin) {
      // A legacy claimed capability has no immutable execution authority.
      // Remove its continuation rather than resume it against today's Release.
      sessionStorage.removeItem(`sitewake:v5:${config.siteAgentId}:checkpoint`);
      sessionStorage.removeItem(`sitewake:v5:${config.siteAgentId}:run`);
      sessionStorage.removeItem(taskLaunchStorageKey);
    } else if (stored
      && (stored.pendingTerminalPatch
        ? Date.now() - (stored.terminalRetryStartedAt || stored.savedAt) < 15 * 60_000
        : stored.leaseExpiresAt
          ? Date.now() < stored.leaseExpiresAt
          : Date.now() - stored.savedAt < 15 * 60_000)) activeTaskLaunch = stored;
    else sessionStorage.removeItem(taskLaunchStorageKey);
  } catch {
    sessionStorage.removeItem(taskLaunchStorageKey);
    sessionStorage.removeItem(`sitewake:v5:${config.siteAgentId}:checkpoint`);
    sessionStorage.removeItem(`sitewake:v5:${config.siteAgentId}:run`);
  }

  function saveTaskLaunch(value?: StoredTaskLaunch) {
    activeTaskLaunch = value;
    try { if (value) sessionStorage.setItem(taskLaunchStorageKey, JSON.stringify(value)); else sessionStorage.removeItem(taskLaunchStorageKey); } catch { /* ignored */ }
  }

  class TaskLaunchPatchError extends Error {
    constructor(message: string, readonly retryable: boolean, readonly status?: number) {
      super(message);
      this.name = "TaskLaunchPatchError";
    }
  }

  function clearStoredTaskLaunchClaim() {
    capturedTaskLaunchClaim = undefined;
    capturedLaunchToken = "";
    try { sessionStorage.removeItem(taskLaunchClaimStorageKey); } catch { /* ignored */ }
  }

  let taskLaunchPatchTail: Promise<void> = Promise.resolve();
  function currentDocumentCanMutateTaskLaunch() {
    if (taskLaunchMutationAuthority) return true;
    const port = portRef.current;
    if (port?.ownsRestorableTask()) {
      taskLaunchMutationAuthority = true;
      return true;
    }
    return false;
  }

  async function performTaskLaunchPatch(value: StoredTaskLaunch, patch: Record<string, unknown>) {
    if (!currentDocumentCanMutateTaskLaunch()) {
      throw new TaskLaunchPatchError("task_launch_document_not_owner", false);
    }
    const current = activeTaskLaunch?.launchId === value.launchId
      && activeTaskLaunch.claimKey === value.claimKey
      ? activeTaskLaunch
      : value;
    const explicitOwner = typeof patch.executionOwnerId === "string";
    const executionOwnerId = explicitOwner
      ? patch.executionOwnerId
      : documentTaskLaunchOwnerId;
    const executionFence = explicitOwner
      ? patch.executionFence
      : current.executionFence || 0;
    const previousExecutionOwnerId = explicitOwner
      ? patch.previousExecutionOwnerId
      : current.executionOwnerId
        && current.executionOwnerId !== executionOwnerId
        ? current.executionOwnerId
        : undefined;
    let response: Response;
    try {
      response = await fetch(`${config.endpoint.replace(/\/$/, "")}/api/site-agents/${encodeURIComponent(config.siteAgentId)}/task-launches/${encodeURIComponent(value.launchId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          claimKey: value.claimKey,
          ...patch,
          executionOwnerId,
          executionFence,
          ...(previousExecutionOwnerId ? { previousExecutionOwnerId } : {}),
        }),
        keepalive: true,
      });
    } catch (error) {
      throw new TaskLaunchPatchError(
        error instanceof Error ? error.message : "task_launch_patch_network_failed",
        true,
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string; message?: string };
      throw new TaskLaunchPatchError(
        payload.message || payload.error || `task_launch_patch_failed:${response.status}`,
        response.status >= 500
          || response.status === 408
          || response.status === 429
          || (response.status === 409 && payload.error === "task_launch_update_conflict"),
        response.status,
      );
    }
    const payload = await response.json().catch(() => ({})) as {
      launch?: {
        status?: string;
        expiresAt?: string;
        executionOwnerId?: string;
        executionFence?: number;
      };
    };
    const leaseExpiresAt = payload.launch?.expiresAt
      ? Date.parse(payload.launch.expiresAt)
      : Number.NaN;
    if (activeTaskLaunch?.launchId === value.launchId
      && activeTaskLaunch.claimKey === value.claimKey
      && !["completed", "failed", "cancelled", "expired"].includes(
        String(payload.launch?.status || ""),
      )) {
      saveTaskLaunch({
        ...activeTaskLaunch,
        savedAt: Date.now(),
        executionOwnerId: payload.launch?.executionOwnerId
          || activeTaskLaunch.executionOwnerId,
        executionFence: payload.launch?.executionFence
          ?? activeTaskLaunch.executionFence,
        ...(Number.isFinite(leaseExpiresAt) ? { leaseExpiresAt } : {}),
      });
    }
    return payload;
  }

  function patchTaskLaunch(value: StoredTaskLaunch, patch: Record<string, unknown>) {
    const pending = taskLaunchPatchTail
      .catch(() => undefined)
      .then(() => performTaskLaunchPatch(value, patch));
    taskLaunchPatchTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  let terminalPatchRetry: number | undefined;
  let taskLaunchHeartbeat: number | undefined;
  function stopTaskLaunchHeartbeat() {
    window.clearTimeout(taskLaunchHeartbeat);
    taskLaunchHeartbeat = undefined;
  }
  function startTaskLaunchHeartbeat() {
    if (taskLaunchHeartbeat !== undefined
      || !currentDocumentCanMutateTaskLaunch()) return;
    const heartbeat = async () => {
      taskLaunchHeartbeat = undefined;
      const launch = activeTaskLaunch;
      if (!launch) return;
      try {
        await patchTaskLaunch(launch, {
          status: "running",
          resultUrl: location.href,
        });
      } catch (error) {
        console.warn("[SiteWake] task launch heartbeat failed", error);
      }
      if (activeTaskLaunch?.launchId === launch.launchId
        && activeTaskLaunch.claimKey === launch.claimKey
        && !activeTaskLaunch.pendingTerminalPatch) {
        taskLaunchHeartbeat = window.setTimeout(heartbeat, 60_000);
      }
    };
    taskLaunchHeartbeat = window.setTimeout(heartbeat, 60_000);
  }
  async function persistTerminalTaskLaunch(
    value: StoredTaskLaunch,
    patch: Record<string, unknown>,
    attempt = 0,
  ) {
    if (attempt > 0
      && (activeTaskLaunch?.launchId !== value.launchId
        || activeTaskLaunch.claimKey !== value.claimKey)) return;
    // The first accepted terminal intent wins locally. Abort/error callbacks
    // can race with an explicit cancel or a completed result, but they must
    // never replace a durable terminal payload that is already awaiting ACK.
    const terminalPatch = value.pendingTerminalPatch || {
      ...patch,
      executionOwnerId: value.executionOwnerId || documentTaskLaunchOwnerId,
      executionFence: value.executionFence || 0,
    };
    const retryStartedAt = value.terminalRetryStartedAt || Date.now();
    const pending = {
      ...value,
      pendingTerminalPatch: terminalPatch,
      terminalRetryStartedAt: retryStartedAt,
    };
    if (activeTaskLaunch?.launchId === value.launchId
      && activeTaskLaunch.claimKey === value.claimKey) {
      saveTaskLaunch(pending);
    }
    // The terminal receipt owns the serialized PATCH lane. Stop scheduling
    // renewals, then wait behind any heartbeat that was already in flight.
    stopTaskLaunchHeartbeat();
    try {
      await patchTaskLaunch(value, terminalPatch);
      window.clearTimeout(terminalPatchRetry);
      terminalPatchRetry = undefined;
      stopTaskLaunchHeartbeat();
      if (activeTaskLaunch?.launchId === value.launchId
        && activeTaskLaunch.claimKey === value.claimKey) {
        saveTaskLaunch();
      }
    } catch (error) {
      console.error("[SiteWake] task launch terminal update failed", error);
      if (activeTaskLaunch?.launchId !== value.launchId
        || activeTaskLaunch.claimKey !== value.claimKey) return;
      const retryable = error instanceof TaskLaunchPatchError && error.retryable;
      if (!retryable || Date.now() - retryStartedAt >= 15 * 60_000) {
        window.clearTimeout(terminalPatchRetry);
        terminalPatchRetry = undefined;
        stopTaskLaunchHeartbeat();
        saveTaskLaunch();
        sessionStorage.removeItem(`sitewake:v5:${config.siteAgentId}:checkpoint`);
        sessionStorage.removeItem(`sitewake:v5:${config.siteAgentId}:run`);
        return;
      }
      saveTaskLaunch(pending);
      window.clearTimeout(terminalPatchRetry);
      terminalPatchRetry = window.setTimeout(
        () => void persistTerminalTaskLaunch(pending, terminalPatch, attempt + 1),
        Math.min(30_000, 1_000 * (2 ** Math.min(attempt, 5))),
      );
    }
  }

  function cancelActiveTaskLaunch() {
    const launch = activeTaskLaunch;
    if (!launch || !currentDocumentCanMutateTaskLaunch()) return;
    void persistTerminalTaskLaunch(
      launch,
      launch.pendingTerminalPatch
        || { status: "cancelled", resultUrl: location.href },
    );
  }
  const host = document.createElement("div");
  // `data-sitewake-agent` is a cross-module contract: the Runner hides and
  // strips widget hosts by this attribute when capturing page evidence.
  host.dataset.sitewakeAgent = "widget";
  host.style.cssText = "position:fixed;right:20px;bottom:20px;z-index:2147483647;pointer-events:none;font-synthesis:none";
  const root = host.attachShadow({ mode: "open" });
  /**
   * Shared drawing for the three icon buttons in the top bar.
   *
   * Only the language one used to be SVG; the other two were the text glyphs "↻" and
   * "×" — a glyph's visual size depends on the font's em-box ratio, `×` is clearly
   * smaller than `↻` at the same font-size, and neither lines up with an SVG. As long
   * as text glyphs are mixed in, the three can never be aligned. Same viewBox, same
   * stroke width, same rendered size is what makes them consistent.
   */
  const headIcon = (path: string) =>
    `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" `
    + `stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  /**
   * The language icon: a globe.
   *
   * It was switched to the "文 A" glyph and back. "文 A" is semantically sharper, but it
   * marks the act of **translating**; this control is a **language picker** that
   * changes the UI's own language. The two horizontal lines are latitudes, not an
   * equator plus meridian — the meridian version has three curves crossing at the
   * center and blurs at 15px.
   */
  const ICON_GLOBE = headIcon('<circle cx="8" cy="8" r="6"/><path d="M2.8 5.9h10.4M2.8 10.1h10.4"/><ellipse cx="8" cy="8" rx="2.7" ry="6"/>');
  const ICON_NEW_CHAT = headIcon('<path d="M13.6 8a5.6 5.6 0 1 1-1.9-4.2"/><path d="M13.9 2.4v3.4h-3.4"/>');
  const ICON_CLOSE = headIcon('<path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/>');

  root.innerHTML = `
    <button class="launcher"><span class="launcher-symbol"><span class="sw-logo-shape"></span></span><span class="launcher-label"></span><i class="launcher-dot"></i></button>
    <section class="panel" hidden>
      <header class="head"><span class="mark">✦</span><div class="identity"><b class="agent-name"></b><small><i class="online"></i><span class="status"></span></small></div><div class="locale-wrap"><button class="head-action locale" aria-haspopup="listbox" aria-expanded="false">${ICON_GLOBE}</button><ul class="locale-menu" role="listbox" hidden></ul></div><button class="head-action new-chat">${ICON_NEW_CHAT}</button><button class="head-action close">${ICON_CLOSE}</button></header>
      <main class="body">
        <div class="empty-state"><h2></h2><p></p><div class="suggestions"></div></div>
        <div class="teach-banner"><div><b></b><small></small></div><button class="finish-teach"></button></div>
        <div class="messages" role="log" aria-live="polite" aria-relevant="additions"></div><div class="progress" role="status" aria-live="polite"><span class="avatar">✦</span><div class="progress-card"><b class="progress-title"></b><small class="progress-text"></small><div class="tool-activity" hidden><i>◇</i><span><b></b><small></small></span></div><div class="thinking-dots"><i></i><i></i><i></i></div></div></div>
      </main>
      <footer class="composer"><form class="composer-shell"><textarea name="goal" rows="1" autocomplete="off"></textarea><button class="send">↑</button><button class="stop" type="button">■</button></form><div class="composer-meta"><span class="mode-hint"></span></div></footer>
    </section>`;
  linkWidgetStylesheet(root, config.endpoint);
  const teachingHost = document.createElement("div");
  teachingHost.dataset.sitewakeAgent = "teaching-studio";
  teachingHost.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;font-synthesis:none";
  const teachingRoot = teachingHost.attachShadow({ mode: "open" });
  teachingRoot.innerHTML = `<section class="studio" hidden><i class="record"></i><div class="copy"><small><i></i>SITEWAKE TEACHING STUDIO</small><b class="goal"></b><div class="meta"><em class="steps"></em><span class="last"></span><time class="timer">00:00</time></div></div><div class="actions"><button class="cancel" type="button"></button><button class="primary finish" type="button"></button></div></section>`;
  linkWidgetStylesheet(teachingRoot, config.endpoint);
  document.documentElement.appendChild(teachingHost);
  const teachingStudio = teachingRoot.querySelector<HTMLElement>(".studio")!;
  // The stylesheet arrives over the network; until it does, the section would
  // inherit the host's `pointer-events:none` and its buttons would be dead.
  // Its own interactivity is not the stylesheet's to grant. Written through
  // the CSSOM, which a strict style-src policy does not refuse.
  teachingStudio.style.pointerEvents = "auto";
  const teachingGoal = teachingRoot.querySelector<HTMLElement>(".goal")!;
  const teachingSteps = teachingRoot.querySelector<HTMLElement>(".steps")!;
  const teachingLast = teachingRoot.querySelector<HTMLElement>(".last")!;
  const teachingTimer = teachingRoot.querySelector<HTMLElement>(".timer")!;
  const teachingCancel = teachingRoot.querySelector<HTMLButtonElement>(".cancel")!;
  const teachingFinish = teachingRoot.querySelector<HTMLButtonElement>(".primary.finish")!;
  let teachingStartedAt = 0;
  setInterval(() => { if (!teachingStudio.hidden && teachingStartedAt) { const seconds = Math.max(0, Math.floor((Date.now() - teachingStartedAt) / 1000)); teachingTimer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; } }, 1_000);
  const query = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
  const panel = query<HTMLElement>(".panel");
  const launcher = query<HTMLButtonElement>(".launcher");
  const launcherSymbol = query<HTMLElement>(".launcher-symbol");
  const launcherLabel = query<HTMLElement>(".launcher-label");
  const close = query<HTMLButtonElement>(".close");
  const form = query<HTMLFormElement>("form");
  const input = query<HTMLTextAreaElement>("textarea");
  const send = query<HTMLButtonElement>(".send");
  const stop = query<HTMLButtonElement>(".stop");
  const status = query<HTMLElement>(".status");
  const messagesElement = query<HTMLElement>(".messages");
  const suggestionsElement = query<HTMLElement>(".suggestions");
  const agentName = query<HTMLElement>(".agent-name");
  const modeHint = query<HTMLElement>(".mode-hint");
  const teachBanner = query<HTMLElement>(".teach-banner");
  const teachBannerTitle = query<HTMLElement>(".teach-banner b");
  const teachBannerBody = query<HTMLElement>(".teach-banner small");
  const finishTeach = query<HTMLButtonElement>(".finish-teach");
  const emptyState = query<HTMLElement>(".empty-state");
  const welcomeTitle = query<HTMLElement>(".empty-state h2");
  const welcomeDescription = query<HTMLElement>(".empty-state>p");
  const headerMark = query<HTMLElement>(".mark");
  const localeWrap = query<HTMLElement>(".locale-wrap");
  const localeButton = query<HTMLButtonElement>(".locale");
  const localeMenu = query<HTMLElement>(".locale-menu");
  const newChat = query<HTMLButtonElement>(".new-chat");
  const progress = query<HTMLElement>(".progress");
  const progressAvatar = query<HTMLElement>(".progress>.avatar");
  const progressTitle = query<HTMLElement>(".progress-title");
  const progressText = query<HTMLElement>(".progress-text");
  const toolActivity = query<HTMLElement>(".tool-activity");
  const toolActivityTitle = query<HTMLElement>(".tool-activity b");
  const toolActivityDetail = query<HTMLElement>(".tool-activity small");
  const composer = query<HTMLElement>(".composer");
  const portRef: { current?: AgentPort } = {};
  let mode: ExperienceMode = "idle";
  let resettingConversation = false;
  // Once the user has explicitly opened or closed the panel, asynchronous
  // startup/task restoration must not overwrite that choice.
  let panelVisibilityTouchedByUser = false;
  let lastGoal = "";
  // The last state to replay on language change. Status / progress / demonstration
  // workbench are each **written once when the event arrives**; changing language does
  // not re-fire the event, so without a replay they stay in the old language.
  let lastStatus: PortStatus | undefined;
  let messages: ChatMessage[] = [];
  let activeAgentConfig: AgentConfig = defaultAgentConfig();
  // The visitor's language, not the operator's. See the top of user-agent-copy.ts.
  let locale: WidgetLocale = resolveWidgetLocale();
  let copy: WidgetCopy = widgetCopy(locale);
  const expandedTraces = new Set<string>();
  const trackedResults = new Set<string>();
  let activityTimeline: AgentRunActivity[] = [];
  const stoppedTaskIds = new Set<string>();
  let streamingMessageId = "";
  let activeQuestionRow: HTMLElement | undefined;
  const engagementStorageKey = `sitewake:v5:${config.siteAgentId}:anonymous-browser`;
  let engagementBrowserSessionId = "";
  try {
    engagementBrowserSessionId =
      localStorage.getItem(engagementStorageKey) || uid("browser");
    localStorage.setItem(engagementStorageKey, engagementBrowserSessionId);
  } catch {
    engagementBrowserSessionId = uid("browser");
  }

  function trackEngagement(
    type:
      | "agent-seen"
      | "agent-opened"
      | "suggestion-selected"
      | "goal-submitted"
      | "result-seen"
      | "feedback-submitted"
      | "runtime-startup-failed",
    metadata: Record<string, JsonValue> = {},
    runId?: string,
  ) {
    void fetch(
      `${config.endpoint.replace(/\/$/, "")}/api/site-agents/${encodeURIComponent(config.siteAgentId)}/effects/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          browserSessionId: engagementBrowserSessionId,
          type,
          runId,
          metadata,
        }),
        keepalive: true,
      },
    ).catch(() => undefined);
  }

  function showAssistantStream(text: string) {
    if (!text) return;
    if (!streamingMessageId) streamingMessageId = uid("stream");
    const index = messages.findIndex((message) => message.id === streamingMessageId);
    const message: ChatMessage = { id: streamingMessageId, kind: "assistant", text, goal: lastGoal };
    if (index >= 0) messages[index] = message;
    else messages.push(message);
    if (!panelVisibilityTouchedByUser) panel.hidden = false;
    const content = messagesElement.querySelector<HTMLElement>(`[data-message-id="${streamingMessageId}"] .markdown`);
    if (!content) { renderMessages(); return; }
    const body = query<HTMLElement>(".body");
    const followLatest = body.scrollHeight - body.scrollTop - body.clientHeight < 96;
    content.replaceChildren(); renderMarkdown(content, text);
    if (followLatest) body.scrollTop = body.scrollHeight;
  }

  function discardAssistantStream() {
    if (!streamingMessageId) return;
    messages = messages.filter((message) => message.id !== streamingMessageId);
    streamingMessageId = "";
    renderMessages();
  }

  function renderLogo(element: HTMLElement) {
    element.replaceChildren();
    const shape = document.createElement("span");
    shape.className = "sw-logo-shape";
    element.appendChild(shape);
  }

  function agentConfig() {
    // `normalizeAgentConfig(source, previous)` reads only overrides, appearance
    // and feature flags from `source`; the resolved name and welcome copy come
    // from `previous`, which is meant to be the automatic layer. The service
    // already resolved that layer against this site's knowledge before sending
    // it, so the served config is the baseline. Passing this widget's built-in
    // defaults instead threw the site's own name away and greeted every visitor
    // as the generic assistant — invisible for as long as a stale resolved
    // value was also being mistaken for a customisation, because an override
    // takes precedence and papered over it.
    const released = portRef.current?.getRelease().agentConfig;
    if (!released) return normalizeAgentConfig(undefined, activeAgentConfig);
    // A Release can carry a partial config — an older record, or one written
    // before a field existed. Fill the gaps from the built-in defaults so the
    // baseline is whole, and let anything the service did resolve win, rather
    // than dropping the whole config back to the defaults because one branch
    // of it was missing.
    const fallback = defaultAgentConfig();
    const baseline = {
      ...fallback,
      ...released,
      brand: { ...fallback.brand, ...released.brand },
      copy: { ...fallback.copy, ...released.copy },
      theme: { ...fallback.theme, ...released.theme },
      features: { ...fallback.features, ...released.features },
    };
    return normalizeAgentConfig(released, baseline);
  }

  function chromeCopy(config: AgentConfig) {
    return resolveChromeCopy(config, locale);
  }

  function applyAgentConfig() {
    activeAgentConfig = agentConfig();
    const preset = activeAgentConfig.appearance?.preset || "orb";
    host.dataset.preset = preset;
    // The panel is anchored to the host's right edge (.panel{right:0}) and the host
    // is only as wide as the launcher: with the launcher bottom-left, a 430px panel
    // spreads leftward from the launcher's right edge and mostly leaves the viewport.
    // Left/right must switch as a unit, so the side lives on the host and both the
    // panel and the phone launcher follow it in the stylesheet.
    const side = activeAgentConfig.theme.launcherPosition === "bottom-left" ? "bottom-left" : "bottom-right";
    host.dataset.position = side;
    host.style.cssText = side === "bottom-left"
      ? "position:fixed;left:20px;bottom:20px;z-index:2147483647;pointer-events:none;font-synthesis:none"
      : "position:fixed;right:20px;bottom:20px;z-index:2147483647;pointer-events:none;font-synthesis:none";
    host.dataset.surface = activeAgentConfig.appearance?.surface || "clean";
    host.style.setProperty("--accent", activeAgentConfig.theme.accentColor);
    host.style.setProperty("--accent-text", activeAgentConfig.theme.accentTextColor);
    host.style.setProperty("--panel-bg", activeAgentConfig.theme.panelBackground);
    const brandAsset = `${config.endpoint.replace(/\/$/, "")}/brand/sitewake-mark.svg?v=wstar-1`;
    host.style.setProperty("--sitewake-mark", `url("${brandAsset.replace(/"/g, "%22")}")`);
    const chrome = chromeCopy(activeAgentConfig);
    launcher.setAttribute("aria-label", chrome.launcherLabel);
    launcherLabel.textContent = preset === "dock" ? chrome.composerPlaceholder : chrome.displayName;
    renderLogo(launcherSymbol);
    renderLogo(headerMark);
    renderLogo(progressAvatar);
    agentName.textContent = chrome.displayName;
    welcomeTitle.textContent = chrome.welcomeTitle;
    welcomeDescription.textContent = chrome.welcomeDescription;
    input.placeholder = chrome.composerPlaceholder;
    modeHint.textContent = chrome.poweredByText;
    applyStaticCopy();
    newChat.hidden = !activeAgentConfig.features.showNewChat;
    suggestionsElement.hidden = !activeAgentConfig.features.showSuggestions;
  }

  /**
   * All state-independent copy is written into the DOM from this one place.
   *
   * The skeleton HTML deliberately inlines no text: a single inlined string would be
   * missed on language switch, and that kind of miss is the hardest to spot — it only
   * shows after switching. Writing everything from here makes a language switch just
   * another call of the same function.
   */
  function applyStaticCopy() {
    panel.setAttribute("aria-label", copy.panel.label);
    localeButton.setAttribute("aria-label", copy.panel.language);
    localeButton.title = `${copy.panel.language} · ${WIDGET_LOCALE_LABELS[locale]}`;
    if (!localeMenu.hidden) renderLocaleMenu();
    newChat.setAttribute("aria-label", copy.panel.newChat);
    newChat.title = copy.panel.newChat;
    close.setAttribute("aria-label", copy.panel.close);
    send.setAttribute("aria-label", copy.composer.send);
    stop.setAttribute("aria-label", copy.composer.stop);
    teachBannerTitle.textContent = copy.teach.bannerTitle;
    teachBannerBody.textContent = copy.teach.bannerBody;
    finishTeach.textContent = copy.teach.finish;
    teachingCancel.textContent = copy.form.cancel;
    teachingFinish.textContent = copy.teach.finishDemo;
  }

  /**
   * Strips the prefix activityLabel() adds to capability calls.
   *
   * It used to be `replace(/^调用能力 · /, "")` — the prefix now follows the visitor's
   * language, so a hard-coded one only worked in Chinese and the English line became
   * "Capability · Capability · …". Asking the dictionary for a label with an empty
   * name yields exactly the current language's prefix.
   */
  function stripActivityPrefix(label: string) {
    const prefix = copy.activity.capabilityCall("");
    return label.startsWith(prefix) ? label.slice(prefix.length) : label;
  }

  /**
   * Language dropdown.
   *
   * Same shape as the console, for the same reason: a two-state toggle is ambiguous
   * whichever side it labels, and an icon-only toggle is worse — you cannot tell what
   * will happen before pressing it. The dropdown checks the current item, so opening it
   * shows where you are.
   *
   * No page reload: the widget is fully client-rendered, there is no server-rendered
   * half to refresh, and a reload would wipe the visitor's ongoing conversation.
   */
  function renderLocaleMenu() {
    localeMenu.replaceChildren();
    // Same order as the console switcher: English first.
    for (const item of ["en", "zh"] as WidgetLocale[]) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(item === locale));
      if (item === locale) button.className = "current";
      const label = document.createElement("span");
      label.textContent = WIDGET_LOCALE_LABELS[item];
      button.append(label);
      if (item === locale) {
        const check = document.createElement("i");
        check.textContent = "✓";
        button.append(check);
      }
      button.onclick = () => { closeLocaleMenu(); applyLocale(item); };
      row.append(button);
      localeMenu.append(row);
    }
  }

  function openLocaleMenu() {
    renderLocaleMenu();
    localeMenu.hidden = false;
    localeButton.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onLocaleOutside, true);
    document.addEventListener("keydown", onLocaleEscape, true);
  }

  function closeLocaleMenu() {
    localeMenu.hidden = true;
    localeButton.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onLocaleOutside, true);
    document.removeEventListener("keydown", onLocaleEscape, true);
  }

  // Clicks outside the widget do not bubble into the shadow root, so use composedPath.
  const onLocaleOutside = (event: Event) => {
    if (!event.composedPath().includes(localeWrap)) closeLocaleMenu();
  };
  const onLocaleEscape = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeLocaleMenu();
  };

  /** The visitor wrote in another language: answer them in it, with no fade and nothing saved. */
  function followRequestLanguage(text: string) {
    followRequestLocale(text);
    const next = resolveWidgetLocale();
    if (next === locale) return;
    locale = next;
    copy = widgetCopy(locale);
    applyAgentConfig();
    renderSuggestions();
    renderMessages();
    setMode(mode);
    if (lastStatus) onStatus(lastStatus);
  }

  function applyLocale(next: WidgetLocale) {
    if (next === locale) return;
    // Fade first, then switch: everything changing at once looks like an error; the fade reads as the result of that click.
    panel.classList.add("locale-swapping");
    window.setTimeout(() => {
      locale = next;
      copy = widgetCopy(locale);
      saveWidgetLocale(locale);
      applyAgentConfig();
      renderSuggestions();
      renderMessages();
      // These two are event-driven: without a replay they stay in the old language.
      // setMode owns modeHint and the input placeholder; onStatus owns connection
      // status, progress copy and the demonstration workbench.
      setMode(mode);
      if (lastStatus) onStatus(lastStatus);
      panel.classList.remove("locale-swapping");
    }, 120);
  }

  function failureActions(): Array<"retry" | "teach"> {
    return config.runtimeMode === "full" && activeAgentConfig.features.showTeachAfterFailure ? ["retry", "teach"] : ["retry"];
  }

  function failureActionsForError(value: unknown): ChatMessage["actions"] {
    if (value instanceof AgentStartupError) return ["retry"];
    const text = value instanceof Error ? value.message : String(value);
    if (portRef.current?.getRelease().runtimeFeatures?.pageAgentRuntimeV2 === true && recoverablePageExecutionUncertainty(text)) return ["reconcile"];
    return failureActions();
  }

  function recoverablePageExecutionUncertainty(code: string) {
    const value = code.toLowerCase();
    if (value.includes("cancelled") || value.includes("reconciliation_")) return false;
    return ["adaptive_timeout", "budget_exhausted", "model-requests", "no-progress", "no_progress", "side_effect_unknown", "action_effect_unknown"]
      .some((marker) => value.includes(marker));
  }

  function taskResultActions(result: TaskResult): ChatMessage["actions"] {
    if (result.release.runtimeFeatures?.pageAgentRuntimeV2 !== true) return failureActions();
    const evidence = result.outcome.evidence;
    const intent = String(evidence.executionIntent || "");
    if (intent === "confirmed-continuation") return undefined;
    if (intent === "reconciliation") return evidence.reconciliationStatus === "not-completed" ? ["continue-confirmed"] : undefined;
    if (recoverablePageExecutionUncertainty(result.outcome.code) || evidence.reconciliationAvailable === true) return ["reconcile"];
    return failureActions();
  }

  function restoreExperience() {
    try {
      const raw = sessionStorage.getItem(storageKey) || "null";
      const stored = JSON.parse(raw) as StoredExperience | null;
      messages = stored?.messages?.slice(-80) || [];
      lastGoal = stored?.goal || "";
      // A capability card is part of the conversation's observable history,
      // not a one-document animation. Keep a compact local projection so a
      // full navigation or the user's next question cannot erase it.
      activityTimeline = Array.isArray(stored?.activityTimeline) ? stored!.activityTimeline.slice(-80) : [];
      if (stored?.mode === "running" || (config.runtimeMode === "full" && stored?.mode === "teaching") || stored?.panelOpen) {
        panel.hidden = false;
        if (stored.mode === "running" || (config.runtimeMode === "full" && stored.mode === "teaching")) mode = stored.mode;
      }
    } catch { messages = []; }
  }

  function persistExperience() {
    try { sessionStorage.setItem(storageKey, JSON.stringify({ messages: messages.slice(-80), goal: lastGoal, mode, panelOpen: !panel.hidden, activityTimeline: activityTimeline.slice(-80), savedAt: Date.now() } satisfies StoredExperience)); } catch { /* ignored */ }
  }

  function appendMarkdownInline(parent: HTMLElement, source: string) {
    const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\*[^*\n]+\*)/g;
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      const index = match.index || 0;
      if (index > cursor) parent.append(document.createTextNode(source.slice(cursor, index)));
      const token = match[0];
      if (token.startsWith("**")) {
        const strong = document.createElement("strong"); strong.textContent = token.slice(2, -2); parent.append(strong);
      } else if (token.startsWith("`")) {
        const code = document.createElement("code"); code.textContent = token.slice(1, -1); parent.append(code);
      } else if (token.startsWith("[")) {
        const parts = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
        if (parts) { const link = document.createElement("a"); link.textContent = parts[1]; link.href = parts[2]; link.target = "_blank"; link.rel = "noopener noreferrer"; parent.append(link); }
        else parent.append(document.createTextNode(token));
      } else {
        const emphasis = document.createElement("em"); emphasis.textContent = token.slice(1, -1); parent.append(emphasis);
      }
      cursor = index + token.length;
    }
    if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
  }

  /** Split a GFM table row without interpreting its cell contents as HTML. */
  function splitMarkdownTableRow(source: string) {
    const row = source.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells: string[] = [];
    let cell = "";
    let escaped = false;
    for (const char of row) {
      if (escaped) { cell += char; escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === "|") { cells.push(cell.trim()); cell = ""; continue; }
      cell += char;
    }
    cells.push(cell.trim());
    return cells;
  }

  function markdownTableAlignment(source: string) {
    const cell = source.trim();
    if (!/^:?-{3,}:?$/.test(cell)) return undefined;
    return cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : undefined;
  }

  function tableDividerFor(source: string, columns: number) {
    const cells = splitMarkdownTableRow(source);
    return cells.length === columns && cells.every((cell) => markdownTableAlignment(cell) !== undefined || /^-{3,}$/.test(cell.trim()));
  }

  function appendMarkdownTable(parent: HTMLElement, header: string[], divider: string[], rows: string[][]) {
    const wrap = document.createElement("div"); wrap.className = "markdown-table-wrap";
    const table = document.createElement("table");
    const thead = document.createElement("thead"); const headerRow = document.createElement("tr");
    header.forEach((value, index) => {
      const cell = document.createElement("th");
      const align = markdownTableAlignment(divider[index]);
      if (align) cell.style.textAlign = align;
      appendMarkdownInline(cell, value); headerRow.append(cell);
    });
    thead.append(headerRow); table.append(thead);
    const tbody = document.createElement("tbody");
    for (const row of rows) {
      const tr = document.createElement("tr");
      header.forEach((_, index) => {
        const cell = document.createElement("td");
        const align = markdownTableAlignment(divider[index]);
        if (align) cell.style.textAlign = align;
        appendMarkdownInline(cell, row[index] || ""); tr.append(cell);
      });
      tbody.append(tr);
    }
    table.append(tbody); wrap.append(table); parent.append(wrap);
  }

  function renderMarkdown(parent: HTMLElement, source: string) {
    const lines = source.replaceAll("\r\n", "\n").split("\n");
    let list: HTMLOListElement | HTMLUListElement | undefined;
    let code: string[] | undefined;
    const closeList = () => { list = undefined; };
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (line.trim().startsWith("```")) {
        closeList();
        if (code) { const pre = document.createElement("pre"); const node = document.createElement("code"); node.textContent = code.join("\n"); pre.append(node); parent.append(pre); code = undefined; }
        else code = [];
        continue;
      }
      if (code) { code.push(line); continue; }
      // Models commonly insert blank lines around pipe-table rows. Look ahead
      // through those blanks, so otherwise valid GFM tables still render well.
      const header = splitMarkdownTableRow(line);
      let dividerIndex = lineIndex + 1;
      // Keep the look-ahead bounded. A normal final paragraph has no following
      // divider; walking beyond the array must not spin the page forever.
      while (dividerIndex < lines.length && !lines[dividerIndex].trim()) dividerIndex += 1;
      if (line.includes("|") && lines[dividerIndex] && tableDividerFor(lines[dividerIndex], header.length)) {
        const divider = splitMarkdownTableRow(lines[dividerIndex]);
        const rows: string[][] = [];
        let rowIndex = dividerIndex + 1;
        while (rowIndex < lines.length) {
          if (!lines[rowIndex].trim()) { rowIndex += 1; continue; }
          if (!lines[rowIndex].includes("|")) break;
          const row = splitMarkdownTableRow(lines[rowIndex]);
          if (row.length !== header.length) break;
          rows.push(row); rowIndex += 1;
        }
        closeList(); appendMarkdownTable(parent, header, divider, rows); lineIndex = rowIndex - 1; continue;
      }
      const item = line.match(/^\s*(\d+\.|[-*])\s+(.+)$/);
      if (item) {
        const ordered = item[1].endsWith(".");
        if (!list || (ordered && list.tagName !== "OL") || (!ordered && list.tagName !== "UL")) { list = document.createElement(ordered ? "ol" : "ul"); parent.append(list); }
        const li = document.createElement("li"); appendMarkdownInline(li, item[2]); list.append(li); continue;
      }
      closeList();
      if (!line.trim()) continue;
      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      const block = document.createElement(heading ? `h${Math.min(3, heading[1].length + 2)}` : "p");
      appendMarkdownInline(block, heading ? heading[2] : line);
      parent.append(block);
    }
    if (code) { const pre = document.createElement("pre"); const node = document.createElement("code"); node.textContent = code.join("\n"); pre.append(node); parent.append(pre); }
  }

  function renderMessages() {
    const scroller = query<HTMLElement>(".body");
    const followLatest = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
    messagesElement.replaceChildren();
    const lastUserIndex = messages.findLastIndex((message) => message.kind === "user");
    for (const [index, message] of messages.entries()) {
      const row = document.createElement("div");
      row.className = `message-row ${message.kind}${message.id === streamingMessageId ? " streaming" : ""}`;
      row.dataset.messageId = message.id;
      if (message.kind !== "user") {
        const avatar = document.createElement("span"); avatar.className = "avatar"; renderLogo(avatar); row.appendChild(avatar);
      }
      const bubble = document.createElement("div"); bubble.className = "message";
      if (message.outcome && message.outcome !== "success") {
        const badge = document.createElement("span"); badge.className = `outcome ${message.outcome}`;
        badge.textContent = message.startupFailure ? widgetCopy(locale).page.notStarted : copy.outcome[message.outcome || "unknown"] || copy.outcome.unknown;
        bubble.appendChild(badge); bubble.appendChild(document.createElement("br"));
      }
      const content = document.createElement("div"); content.className = "markdown";
      if (message.kind === "user") content.textContent = message.text;
      else renderMarkdown(content, message.text);
      bubble.appendChild(content);
      if (message.actions?.length) {
        const actions = document.createElement("div"); actions.className = "actions";
        for (const action of message.actions) {
          const button = document.createElement("button");
          button.textContent = action === "retry"
            ? copy.action.retry
            : action === "reconcile"
              ? copy.action.verify
              : action === "continue-confirmed"
                ? copy.action.confirm
                : copy.action.demonstrate;
          button.onclick = () => {
            if (action === "reconcile" || action === "continue-confirmed") {
              // Recovery grants are single-use UI decisions. Consume the
              // button before starting the new Run so double-click/reload does
              // not silently launch duplicate reconciliation or write tasks.
              message.actions = message.actions?.filter((item) => item !== action);
              persistExperience(); renderMessages();
            }
            if (action === "retry") void submitGoal(message.goal || lastGoal);
            else if (action === "reconcile") void reconcileTimedOutTask(message.goal || lastGoal, message.input || {}, message.taskId || "");
            else if (action === "continue-confirmed") void continueTimedOutTask(message.goal || lastGoal, message.input || {}, message.taskId || "");
            else void beginTeaching(message.goal || lastGoal);
          };
          actions.appendChild(button);
        }
        bubble.appendChild(actions);
      }
      row.appendChild(bubble); messagesElement.appendChild(row);
      if (message.kind === "user") {
        const entries = activitiesForTurn(activityTimeline, message.taskId);
        if (entries.length) {
          const trace = createActivityDisclosure(message.id);
          renderActivityTimeline(trace, entries, message.taskId);
          messagesElement.appendChild(trace);
        }
      }
      if (index === lastUserIndex) messagesElement.appendChild(progress);
    }
    if (lastUserIndex < 0) messagesElement.appendChild(progress);
    if (activeQuestionRow) messagesElement.appendChild(activeQuestionRow);
    emptyState.hidden = messages.length > 0;
    if (followLatest) scroller.scrollTop = scroller.scrollHeight;

  }

  function addMessage(text: string, kind: ChatMessage["kind"] = "assistant", options: Partial<Omit<ChatMessage, "id" | "kind" | "text">> = {}) {
    const taskId = options.taskId;
    if (taskId && messages.some((message) => message.taskId === taskId && message.kind === kind && message.text === text)) return;
    messages.push({ id: uid("message"), kind, text, ...options });
    persistExperience(); renderMessages();
    if (kind === "user") { const body = query<HTMLElement>(".body"); body.scrollTop = body.scrollHeight; }
  }

  function setMode(next: ExperienceMode) {
    if (config.runtimeMode === "read-only" && (next === "teach-intent" || next === "teaching")) next = "idle";
    const wasBusy = mode === "running";
    mode = next;
    if (next === "running" || next === "teaching") panel.hidden = false;
    const busy = next === "running";
    // The trace header reads "still working" off this flag; a stop or an
    // error path that skips the terminal status must not leave it hanging.
    if (wasBusy !== busy) renderActivityTimeline();
    input.disabled = busy || next === "teaching"; send.disabled = busy || next === "teaching" || !input.value.trim();
    composer.classList.toggle("running", busy);
    // Keep one compact, live “now” indicator above the durable trace.  The
    // trace answers what has happened; this answers what the Agent is doing
    // while a new document restores or a model/browser turn is in flight.
    // Clearing it here made cross-document PageAgent work look frozen.
    if (next === "running") {
      progressTitle.textContent = copy.progress.understanding;
      progressText.textContent = copy.progress.syncing;
      toolActivity.hidden = true;
      progress.classList.add("show");
    } else progress.classList.remove("show");
    teachBanner.classList.toggle("show", next === "teaching");
    teachingStudio.hidden = next !== "teaching";
    modeHint.textContent = next === "teach-intent" ? copy.composer.teachIntentHint : next === "teaching" ? copy.composer.teachingHint : busy ? copy.composer.busyHint : chromeCopy(activeAgentConfig).poweredByText;
    input.placeholder = next === "teach-intent" ? copy.composer.teachIntentPlaceholder : chromeCopy(activeAgentConfig).composerPlaceholder;
    persistExperience();
    if (!busy && next !== "teaching") setTimeout(() => input.focus(), 0);
  }

  const reportedStartupFailures = new Set<string>();
  function friendlyFailure(value: unknown) {
    if (value instanceof AgentStartupError) {
      if (!reportedStartupFailures.has(value.diagnosticId)) {
        reportedStartupFailures.add(value.diagnosticId);
        if (reportedStartupFailures.size > 50) reportedStartupFailures.delete(reportedStartupFailures.values().next().value!);
        const metadata = { diagnosticId: value.diagnosticId, phase: value.phase, code: value.code, errorName: value.errorName, sdkFrame: value.sdkFrame, releaseVersion: activePort.getRelease().version };
        trackEngagement("runtime-startup-failed", metadata);
        console.warn("[SiteWake] Task did not start", metadata);
      }
      const reason = value.code === "connection_timeout" ? widgetCopy(locale).page.connectionTimedOut
        : value.code === "connection_failed" ? widgetCopy(locale).page.connectionFailed
        : widgetCopy(locale).page.couldNotPrepare;
      return `${reason}${widgetCopy(locale).page.nothingWasDone} (${value.diagnosticId})`;
    }
    const text = value instanceof Error ? value.message : String(value);
    if (text.includes("capability_input_required")) return copy.error.inputRequired;
    if (text.includes("model_not_configured")) return copy.error.modelNotConfigured;
    if (text.includes("adaptive_timeout")) return portRef.current?.getRelease().runtimeFeatures?.pageAgentRuntimeV2 === true
      ? copy.error.budgetExhausted
      : copy.error.tooLong;
    if (text.includes("Unknown action") || text.includes("agent_protocol_invalid")) return copy.error.protocol;
    if (text.includes("demonstration_empty")) return copy.error.demonstrationEmpty;
    if (text.includes("task_cancelled") || text.includes("cancelled")) return copy.error.cancelled;
    // task_already_running is this page's own port still finishing; only the lease code means another page.
    if (text.includes("task_already_running")) return copy.error.stillFinishing;
    if (text.includes("task_active_in_another_page")) return copy.error.alreadyRunning;
    return copy.error.generic;
  }

  // The strip under the welcome text holds only the site owner's suggested
  // questions, as plain prompts: a click asks exactly what typing it would.
  // Capabilities are not surfaced as shortcuts — the visitor says what they
  // want in the composer and the Agent picks the tool.
  function renderSuggestions() {
    const port = portRef.current; if (!port) return;
    suggestionsElement.replaceChildren();
    if (!activeAgentConfig.features.showSuggestions || messages.length) return;
    const seen = new Set<string>();
    // Through the same resolver as the rest of the copy, so a reader gets this
    // site's questions in the language they are reading rather than whichever
    // one the generator happened to write first.
    const prompts = chromeCopy(activeAgentConfig).suggestions.filter((text) => {
      const key = normalizeGoal(text);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    for (const text of prompts.slice(0, 4)) {
      const button = document.createElement("button"); button.innerHTML = `<i>↗</i><span><b></b></span><em>›</em>`;
      button.querySelector("b")!.textContent = text;
      button.onclick = () => {
        trackEngagement("suggestion-selected", { suggestion: text, kind: "prompt" });
        input.value = text; void submitGoal(text);
      };
      suggestionsElement.appendChild(button);
    }
  }

  function activityLabel(activity: { kind?: string; type?: string; capabilityName?: string; operationName?: string; label?: string; tool?: string }) {
    if (activity.kind === "navigation" && activity.capabilityName) return copy.activity.navigationTool(activity.capabilityName);
    if (activity.capabilityName) return copy.activity.capabilityCall(activity.capabilityName);
    if (activity.kind === "knowledge") return activity.label || copy.activity.knowledge;
    if (activity.operationName) return copy.activity.sitePath(activity.operationName);
    if (activity.kind === "page") {
      return copy.activity.tool[activity.tool || ""] || activity.label || copy.activity.operatePage;
    }
    return activity.label || copy.activity.deciding;
  }

  function askUser(question: string, options?: {
    signal: AbortSignal;
    choices?: Array<{ label: string; value: string }>;
  }) {
    panel.hidden = false; emptyState.hidden = true;
    addMessage(question, "assistant", { taskId: uid("question") });
    return new Promise<string>((resolve, reject) => {
      const row = document.createElement("div"); row.className = "message-row system";
      const choices = (options?.choices || []).filter((choice) => choice.label.trim() && choice.value.trim());
      const card = document.createElement(choices.length ? "div" : "form");
      card.className = `agent-question${choices.length ? " agent-choice-question" : ""}`;
      activeQuestionRow = row;
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        activeQuestionRow = undefined;
        row.remove();
        reject(new DOMException("Task cancelled", "AbortError"));
      };
      const settle = (answer: string, displayAnswer = answer) => {
        if (settled) return;
        settled = true;
        activeQuestionRow = undefined;
        options?.signal.removeEventListener("abort", abort);
        row.remove();
        addMessage(displayAnswer, "user");
        resolve(answer);
      };
      if (choices.length) {
        const optionList = document.createElement("div"); optionList.className = "agent-question-options";
        for (const choice of choices) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = choice.label;
          button.onclick = () => settle(choice.value, choice.label);
          optionList.appendChild(button);
        }
        card.appendChild(optionList);
      } else {
        const field = document.createElement("input"); field.required = true; field.autocomplete = "off"; field.placeholder = copy.form.fillIn;
        const submit = document.createElement("button"); submit.type = "submit"; submit.textContent = copy.form.continue;
        card.append(field, submit);
        (card as HTMLFormElement).onsubmit = (event) => {
          event.preventDefault();
          const answer = field.value.trim();
          if (answer) settle(answer);
        };
        queueMicrotask(() => field.focus());
      }
      row.appendChild(card); messagesElement.appendChild(row); row.scrollIntoView({ block: "end" });
      options?.signal.addEventListener("abort", abort, { once: true });
    });
  }

  function resetToolActivity(options: { clearHistory?: boolean } = {}) {
    if (options.clearHistory) expandedTraces.clear();
    // A normal user turn keeps prior tool receipts, but an explicit new-chat
    // action is a hard conversation boundary. Durable runs still retain their
    // audit trail; the new conversation must not inherit an old invocation.
    if (options.clearHistory) activityTimeline = [];
    renderActivityTimeline();
    toolActivity.hidden = true;
  }

  function createActivityDisclosure(messageId: string) {
    const trace = document.createElement("details"); trace.className = "run-trace";
    trace.dataset.messageId = messageId;
    trace.open = expandedTraces.has(messageId);
    trace.setAttribute("aria-label", copy.panel.runTrace);
    trace.addEventListener("toggle", () => {
      if (trace.open) expandedTraces.add(messageId); else expandedTraces.delete(messageId);
    });
    return trace;
  }

  /** The run owning a turn is still working while the widget is busy on that
   * turn and no terminal result has landed for it. Rows alone cannot tell
   * "finished" from "deciding the next tool call". */
  function turnInFlight(taskId?: string) {
    if (!taskId || mode !== "running") return false;
    const current = messages.findLast((message) => message.kind === "user");
    return current?.taskId === taskId && !activityTimeline.some((item) => item.kind === "result" && item.sessionId === taskId);
  }

  function renderActivityTimeline(target?: HTMLDetailsElement, entries?: AgentRunActivity[], taskId?: string) {
    if (!target) {
      // Update only tool receipts. Streaming or progress must not remount the
      // whole chat, steal text selection, or repeatedly announce older turns.
      const rows = new Map([...messagesElement.querySelectorAll<HTMLElement>(".message-row.user")].map(row => [row.dataset.messageId, row]));
      for (const message of messages.filter(item => item.kind === "user")) {
        const row = rows.get(message.id); if (!row) continue;
        const sibling = row.nextElementSibling;
        let trace = sibling instanceof HTMLDetailsElement && sibling.dataset.messageId === message.id ? sibling : undefined;
        const items = activitiesForTurn(activityTimeline, message.taskId);
        // A plain chat turn gets no "completed · view steps" disclosure: only a turn that touched the page or ran a capability has steps to show.
        if (!hasVisibleOperations(items)) { trace?.remove(); continue; }
        if (!trace) { trace = createActivityDisclosure(message.id); row.after(trace); }
        renderActivityTimeline(trace, items, message.taskId);
      }
      return;
    }
    renderOperationTrace(target, entries || [], locale === "en", turnInFlight(taskId), Boolean(taskId && stoppedTaskIds.has(taskId)));
  }

  /** The run id of the turn currently in flight, as the timeline attributes it. */
  function currentTurnTaskId() {
    const owner = [...messages].reverse().find((message) => message.kind === "user");
    return owner?.taskId || activityTimeline.findLast((item) => item.sessionId)?.sessionId;
  }

  function upsertActivity(activity: AgentRunActivity) {
    if (activity.sessionId) {
      const owner = [...messages].reverse().find((message) => message.kind === "user" && !message.taskId && (message.goal === lastGoal || message.text === lastGoal));
      if (owner) owner.taskId = activity.sessionId;
    }
    const index = activityTimeline.findIndex((item) => item.id === activity.id);
    if (index >= 0) activityTimeline[index] = activity;
    else activityTimeline = [...activityTimeline, activity].slice(-80);
    renderActivityTimeline(); persistExperience();
  }

  function onStatus(next: PortStatus) {
    lastStatus = next;
    // An explicit new conversation is a UI/session boundary. Late events from
    // the cancelled Run must not repopulate the freshly cleared transcript.
    if (resettingConversation && !["connecting", "ready"].includes(next.phase)) return;
    const restoredConversation = next.detail?.conversation as Array<{ role?: string; content?: string; at?: string }> | undefined;
    if (next.detail?.resumed && restoredConversation?.length) {
      const restoredRun = next.detail?.run as { goal?: string } | undefined;
      const restoredSessionId = String(next.detail?.sessionId || "active");
      const restoredMessages: ChatMessage[] = restoredConversation.filter((turn) => turn.content && (turn.role === "user" || turn.role === "assistant" || turn.role === "system")).map((turn, index) => ({
        id: `run:${String(next.detail?.sessionId || "active")}:${index}`,
        kind: turn.role === "user" ? "user" : turn.role === "system" ? "system" : "assistant",
        text: String(turn.content),
        taskId: turn.role === "user" && index === restoredConversation.findLastIndex(entry => entry.role === "user" && entry.content === restoredRun?.goal) ? restoredSessionId : undefined,
      }));
      messages = mergeResumedConversation(messages.filter(message => message.id !== streamingMessageId), restoredMessages).slice(-80);
      lastGoal = restoredRun?.goal || [...messages].reverse().find((message) => message.kind === "user")?.text || lastGoal;
      if (!panelVisibilityTouchedByUser) panel.hidden = false;
      renderMessages();
      persistExperience();
    }
    const restoredTimeline = (next.detail?.activityTimeline || (next.detail?.run as { activityTimeline?: AgentRunActivity[] } | undefined)?.activityTimeline) as AgentRunActivity[] | undefined;
    if (next.detail?.resumed && restoredTimeline?.length) {
      // The server owns the active Run; sessionStorage owns already-finished
      // visual history from earlier Runs. Merge them by stable activity id so
      // a destination BrowserPort restores its current card without deleting
      // cards from previous turns.
      const merged = new Map(activityTimeline.map((item) => [item.id, item]));
      for (const item of restoredTimeline) merged.set(item.id, item);
      activityTimeline = [...merged.values()].slice(-80); renderActivityTimeline(); persistExperience();
    }
    if ((next.phase === "completed" || next.phase === "error") && next.detail?.sessionId) {
      const id = String(next.detail.sessionId);
      activityTimeline = activityTimeline.map(item => item.sessionId === id && item.state === "running"
        ? { ...item, state: next.phase === "error" ? "failed" : "completed" } : item);
      renderActivityTimeline();
    }
    if (next.phase === "executing" || next.phase === "adaptive" || next.phase === "resuming") setMode("running");
    const presentation = String(next.detail?.presentation || "");
    if (presentation === "assistant-stream") {
      status.textContent = copy.status.generating;
      progressTitle.textContent = copy.progress.generating;
      progressText.textContent = copy.progress.organizing;
      toolActivity.hidden = true;
      progress.classList.add("show");
      showAssistantStream(String(next.detail?.assistantDelta || ""));
      return;
    }
    const statusText = presentation === "conversation" ? copy.status.connected : presentation === "conversation-thinking" ? copy.status.answering : next.phase === "connecting" ? copy.status.connectingSite : next.phase === "ready" ? copy.status.connected : next.phase === "resuming" ? copy.status.resuming : next.phase === "adaptive" ? copy.status.handlingTask : next.phase === "executing" ? copy.status.executing : next.phase === "validating" ? copy.status.validating : next.phase === "learning" && next.detail?.teaching ? copy.status.recording : next.phase === "learning" ? copy.status.learning : next.phase === "error" ? copy.status.taskFailed : copy.status.taskDone;
    status.textContent = statusText;
    progressText.textContent = next.message;
    const activity = next.detail?.activity as { id?: string; kind?: string; type?: string; state?: string; sessionId?: string; capabilityId?: string; capabilityName?: string; operationName?: string; stepOp?: string; stepIndex?: number; stepTotal?: number; label?: string; message?: string; outcome?: string; tool?: string; duration?: number; summary?: string; input?: Record<string, JsonValue>; output?: Record<string, JsonValue> } | undefined;
    if (activity?.id) upsertActivity({
      id: activity.id, sessionId: activity.sessionId || (typeof next.detail?.sessionId === "string" ? next.detail.sessionId : undefined), kind: activity.kind === "agent" ? "result" : (["reasoning", "capability-search", "knowledge", "capability", "navigation", "page", "transition", "result", "human"].includes(activity.kind || "") ? activity.kind as AgentRunActivity["kind"] : "reasoning"),
      state: ["completed", "failed"].includes(activity.state || "") ? activity.state as "completed" | "failed" : "running",
      label: activityLabel(activity), detail: activity.summary || activity.message || activity.tool || next.message,
      capabilityId: typeof activity.capabilityId === "string" ? activity.capabilityId : undefined,
      capabilityName: typeof activity.capabilityName === "string" ? activity.capabilityName : undefined,
      operationName: typeof activity.operationName === "string" ? activity.operationName : undefined,
      input: activity.input && typeof activity.input === "object" && !Array.isArray(activity.input) ? activity.input as Record<string, JsonValue> : undefined,
      output: activity.output && typeof activity.output === "object" && !Array.isArray(activity.output) ? activity.output as Record<string, JsonValue> : undefined,
      stepIndex: activity.stepIndex, stepTotal: activity.stepTotal,
      url: location.href, createdAt: new Date().toISOString(),
    });
    const isVisibleTool = Boolean(activity && ["capability-search", "capability", "navigation", "knowledge", "page", "human"].includes(activity.kind || ""));
    const isResponseGeneration = presentation === "conversation-thinking";
    // Some providers emit a short natural-language preamble before deciding
    // to call a tool. It is not an answer yet, so remove that provisional
    // stream as soon as a real tool invocation begins.
    if (isVisibleTool && (activity?.state === "running" || (activity?.type && !activity.state))) discardAssistantStream();
    if (isVisibleTool && (activity?.state === "running" || (activity?.type && !activity.state))) {
      progress.classList.add("show");
      progressTitle.textContent = copy.progress.usingTools;
      toolActivity.hidden = false;
      toolActivityTitle.textContent = activityLabel(activity);
      toolActivityDetail.textContent = activity.operationName
        ? `${activity.operationName}${activity.stepOp ? ` · ${activity.stepOp}` : ""}${activity.stepTotal ? ` · ${activity.stepIndex || 1}/${activity.stepTotal}` : ""}`
        : activity.kind === "reasoning" ? copy.progress.reasoning : activity.message ? activity.message.replaceAll("_", " ") : copy.progress.afterTools;
    } else if (activity?.state) {
      toolActivity.hidden = true;
    }
    // The loading card represents observable tool work, not generic Agent
    // thinking or document restoration. The header status still reports those
    // phases; the animated surface only appears while a real tool is running.
    if (isResponseGeneration) {
      progressTitle.textContent = copy.progress.generating;
      progressText.textContent = next.message || copy.progress.composing;
      toolActivity.hidden = true;
      progress.classList.add("show");
    } else if (!isVisibleTool || activity?.state !== "running") progress.classList.remove("show");
    if (isVisibleTool && activitiesForTurn(activityTimeline, String(next.detail?.sessionId || "")).length) progress.classList.remove("show");
    if (["ready", "completed", "error"].includes(next.phase)) progress.classList.remove("show");
    const release = portRef.current?.getRelease();
    if (release) applyAgentConfig();
    if (next.phase === "ready") renderSuggestions();
    if (next.detail?.resumed || next.detail?.navigating) { if (activeTaskLaunch?.executionMode === "debug") panel.hidden = false; persistExperience(); }
    if (next.phase === "learning" && next.detail?.teaching) setMode("teaching");
    if (next.phase === "learning" && next.detail?.teaching) {
      const currentPage = next.detail.currentPage as { title?: string; heading?: string } | undefined;
      teachingGoal.textContent = String(next.detail.goal || lastGoal || copy.teach.goalFallback);
      teachingSteps.textContent = copy.teach.steps(Number(next.detail.stepCount || 0));
      teachingLast.textContent = String(next.detail.lastAction || currentPage?.heading || currentPage?.title || copy.teach.recording);
      const parsed = Date.parse(String(next.detail.startedAt || ""));
      if (Number.isFinite(parsed)) teachingStartedAt = parsed;
    }
    if (next.phase === "completed" || next.phase === "error") {
      const result = next.detail?.taskResult as TaskResult | undefined;
      if (result) {
        discardAssistantStream();
        const outcome = result.outcome.status;
        const failed = outcome === "execution-fault" || outcome === "unknown";
        // Runtime already translates known failures into a safe, actionable
        // outcome summary.  Do not erase that explanation with the widget's
        // generic fallback merely because text and summary are identical.
        const unsafeRuntimeText = /^(?:TypeError|ReferenceError|InvokeError|Error):/i.test(result.text || "");
        const reply = outcome === "unknown" ? result.text : outcome === "execution-fault"
          ? (result.text && !unsafeRuntimeText ? result.text : friendlyFailure(result.text))
          : result.text;
        const resultActions = result.release.runtimeFeatures?.pageAgentRuntimeV2 === true
          && String(result.outcome.evidence.executionIntent || "") === "reconciliation"
          ? taskResultActions(result)
          : failed ? taskResultActions(result) : undefined;
        addMessage(reply, failed ? "error" : "assistant", {
          taskId: result.session.id, goal: result.session.goal || lastGoal, outcome,
          input: result.session.input,
          actions: resultActions,
        });
        if (!trackedResults.has(result.session.id)) {
          trackedResults.add(result.session.id);
          trackEngagement(
            "result-seen",
            { outcome: result.outcome.status },
            result.session.id,
          );
        }
      }
      if (activeTaskLaunch && result) {
        const launch = activeTaskLaunch;
        void persistTerminalTaskLaunch(launch, {
          status: result.outcome.status === "execution-fault" || result.outcome.status === "unknown" ? "failed" : "completed",
          taskSessionId: result.session.id,
          outcome: result.outcome,
          output: result.output,
          resultUrl: location.href,
          ...(result.outcome.status === "execution-fault" || result.outcome.status === "unknown" ? { error: { code: result.outcome.code, summary: result.outcome.summary } } : {}),
        });
      } else if (activeTaskLaunch && next.phase === "error") {
        const launch = activeTaskLaunch;
        void persistTerminalTaskLaunch(launch, { status: "failed", resultUrl: location.href, error: { code: "client_execution_failed", summary: next.message } });
      }
      setMode("idle"); toolActivity.hidden = true; renderSuggestions();
    }
  }

  const activePort = (() => {
    try {
      return new AgentPort({
        siteAgentId: config.siteAgentId,
        endpoint: config.endpoint,
        adaptiveUrl: `${config.endpoint.replace(/\/$/, "")}/sitewake-adaptive.js`,
        visibility: config.visibility,
        rehearsal: config.rehearsal,
        runtimeMode: config.runtimeMode,
        allowedCapabilityIds: config.allowedCapabilityIds,
        maxSteps: config.maxSteps,
        domReplay: config.domReplay,
        onStatus,
        onAskUser: askUser,
        handoffToken: capturedRunToken,
        executionReleaseId: capturedLaunchToken ? undefined : activeTaskLaunch?.releaseId,
        executionReleaseVersion: capturedLaunchToken ? undefined : activeTaskLaunch?.releaseVersion,
        executionRevisionId: capturedLaunchToken ? undefined : activeTaskLaunch?.revisionId,
      });
    } catch (error) {
      dispatchState("error", error instanceof Error ? error.message : String(error));
      throw error;
    }
  })();
  portRef.current = activePort;
  applyAgentConfig();

  function normalizeDateValue(raw: string) {
    const value = raw.trim().normalize("NFKC");
    const now = new Date();
    // i18n-exempt: these match **what the user typed**, not copy shown to them. Both
    // languages must be recognized — input method and UI language are separate things,
    // and someone on the English UI may still type "昨天". Hence a union, not a
    // per-language choice.
    const relative: Record<string, number> = {
      "今天": 0, "昨日": -1, "昨天": -1, "前天": -2, "明天": 1, // i18n-exempt: matching logic: these read what the visitor typed, in either language
      today: 0, yesterday: -1, tomorrow: 1, "day before yesterday": -2,
    };
    const offset = relative[value] ?? relative[value.toLowerCase()];
    if (offset !== undefined) now.setDate(now.getDate() + offset);
    else {
      const matched = value.match(/^(\d{4})[\-/\.年](\d{1,2})[\-/\.月](\d{1,2})(?:日|号)?$/); // i18n-exempt: matching logic: these read what the visitor typed, in either language
      if (!matched) return undefined;
      now.setFullYear(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
      if (now.getFullYear() !== Number(matched[1]) || now.getMonth() !== Number(matched[2]) - 1 || now.getDate() !== Number(matched[3])) return undefined;
    }
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  function renderCapabilityForm(capability: CapabilityDefinition, originalGoal?: string) {
    panel.hidden = false;
    emptyState.hidden = true;
    const row = document.createElement("div"); row.className = "message-row system";
    const avatar = document.createElement("span"); avatar.className = "avatar"; renderLogo(avatar); row.appendChild(avatar);
    const card = document.createElement("div"); card.className = "message";
    const title = document.createElement("b"); title.textContent = localizedCapabilityName(capability, locale); card.appendChild(title);
    const description = document.createElement("div"); description.textContent = capability.description; card.appendChild(description);
    const parameterForm = document.createElement("form"); parameterForm.className = "parameter-form";
    for (const [name, schema] of Object.entries(capability.inputs.properties || {})) {
      const label = document.createElement("label"); label.textContent = name;
      const field = document.createElement("input"); field.name = name; field.required = capability.inputs.required?.includes(name) ?? true; field.type = schema.type === "number" ? "number" : "text";
      const dateField = schema.format === "date";
      field.placeholder = dateField ? copy.form.dateExample : schema.description || copy.form.inputFor(name);
      label.appendChild(field);
      if (dateField) {
        const hint = document.createElement("small"); hint.textContent = `${copy.form.dateHint}${schema.examples?.[0] ? copy.form.dateExampleSuffix(String(schema.examples[0])) : ""}`;
        field.oninput = () => { const normalized = normalizeDateValue(field.value); hint.textContent = normalized ? copy.form.dateResolved(normalized) : `${copy.form.dateHint}${schema.examples?.[0] ? copy.form.dateExampleSuffix(String(schema.examples[0])) : ""}`; };
        label.appendChild(hint);
      } else if (schema.description || schema.examples?.length) {
        const hint = document.createElement("small"); hint.textContent = [schema.description, schema.examples?.length ? copy.form.exampleList(schema.examples.map(String).join("、")) : ""].filter(Boolean).join(" · "); label.appendChild(hint);
      }
      parameterForm.appendChild(label);
    }
    const submit = document.createElement("button"); submit.type = "submit"; submit.textContent = copy.form.start; parameterForm.appendChild(submit);
    parameterForm.onsubmit = (event) => {
      event.preventDefault(); const values: Record<string, JsonValue> = {};
      const data = new FormData(parameterForm);
      for (const [name, schema] of Object.entries(capability.inputs.properties || {})) {
        const raw = String(data.get(name) || "");
        const normalizedDate = schema.format === "date" ? normalizeDateValue(raw) : undefined;
        if (schema.format === "date" && !normalizedDate) { const field = parameterForm.elements.namedItem(name) as HTMLInputElement | null; field?.setCustomValidity(copy.form.dateInvalid); field?.reportValidity(); return; }
        values[name] = schema.type === "number" ? Number(raw) : normalizedDate || raw;
      }
      trackEngagement("goal-submitted", {
        source: "capability-form",
        capabilityId: capability.id,
      });
      row.remove(); void runCapability(capability, values, originalGoal);
    };
    card.appendChild(parameterForm); row.appendChild(card); messagesElement.appendChild(row); row.scrollIntoView({ block: "end" });
  }

  async function runCapability(capability: CapabilityDefinition, taskInput: Record<string, JsonValue>, originalGoal?: string) {
    const goal = originalGoal || localizedCapabilityName(capability, locale);
    lastGoal = goal; persistExperience(); resetToolActivity(); setMode("running");
    if (!originalGoal) addMessage(goal, "user", { goal });
    try { if (originalGoal) await activePort.run(goal, taskInput); else await activePort.call(capability.id, taskInput); }
    catch (error) {
      console.error("[SiteWake] capability invocation failed", error);
      addMessage(friendlyFailure(error), "error", { goal, input: taskInput, outcome: "execution-fault", actions: failureActionsForError(error) });
      setMode("idle");
    }
  }

  function recoverMissingCapabilityInput(error: unknown, goal: string) {
    const text = error instanceof Error ? error.message : String(error);
    if (!text.includes("capability_input_required")) return false;
    const matched = matchCapability(activePort.getRelease(), goal);
    const invocableIds = new Set(userInvocableCapabilities(activePort.getRelease()).map((capability) => capability.id));
    if (!matched || !invocableIds.has(matched.capability.id)) return false;
    setMode("idle");
    addMessage(copy.message.needMoreInfo, "system", { goal });
    renderCapabilityForm(matched.capability, goal);
    return true;
  }

  async function reconcileTimedOutTask(goal: string, taskInput: Record<string, JsonValue>, sourceTaskId: string) {
    const value = goal.trim(); if (!value) return;
    lastGoal = value; persistExperience(); panel.hidden = false; resetToolActivity(); setMode("running");
    addMessage(copy.message.readOnlyCheck, "system", { goal: value, input: taskInput });
    try { await activePort.reconcile(value, taskInput, sourceTaskId); }
    catch (error) {
      addMessage(friendlyFailure(error), "error", { goal: value, input: taskInput, outcome: "execution-fault" });
      setMode("idle");
    }
  }

  async function continueTimedOutTask(goal: string, taskInput: Record<string, JsonValue>, sourceTaskId: string) {
    const value = goal.trim(); if (!value) return;
    lastGoal = value; persistExperience(); panel.hidden = false; resetToolActivity(); setMode("running");
    addMessage(copy.message.confirmedContinue, "system", { goal: value, input: taskInput });
    try { await activePort.continueAfterConfirmation(value, taskInput, sourceTaskId); }
    catch (error) {
      addMessage(friendlyFailure(error), "error", { goal: value, input: taskInput, outcome: "execution-fault" });
      setMode("idle");
    }
  }

  async function submitGoal(goal: string) {
    const value = goal.trim(); if (!value) return;
    trackEngagement("goal-submitted", { source: "composer" });
    // No name matching here: the Agent reads the request and chooses the
    // capability itself, asking for whatever it still needs.
    followRequestLanguage(value);
    lastGoal = value; persistExperience(); panel.hidden = false; input.value = ""; resetToolActivity(); setMode("running"); addMessage(value, "user", { goal: value });
    const conversation = messages.filter((message) => message.kind === "user" || message.kind === "assistant").slice(-10).map((message) => ({ role: message.kind as "user" | "assistant", content: message.text, at: new Date().toISOString() }));
    try { await activePort.run(value, {}, conversation); }
    catch (error) {
      if (!recoverMissingCapabilityInput(error, value)) {
        addMessage(friendlyFailure(error), "error", { goal: value, input: {}, outcome: "execution-fault", startupFailure: error instanceof AgentStartupError, actions: failureActionsForError(error) }); setMode("idle");
      }
    }
  }

  async function beginTeaching(goal: string) {
    assertRuntimeTeachingAllowed(config.runtimeMode);
    const value = goal.trim();
    if (!value) { setMode("teach-intent"); input.focus(); return; }
    lastGoal = value; persistExperience(); panel.hidden = false;
    try { await activePort.teach(value); setMode("teaching"); addMessage(copy.teach.prompt(value), "system", { goal: value }); }
    catch (error) { addMessage(friendlyFailure(error), "error"); setMode("idle"); }
  }

  async function finishTeaching() {
    assertRuntimeTeachingAllowed(config.runtimeMode);
    setMode("running");
    try { await activePort.finishTeaching(); }
    catch (error) { addMessage(friendlyFailure(error), "error", { outcome: "execution-fault" }); setMode("teaching"); }
  }

  restoreExperience(); renderActivityTimeline(); renderMessages(); setMode(mode);
  async function publicApiCall<T>(operation: () => Promise<T>) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof AgentStartupError) friendlyFailure(error);
      dispatchState("error", error instanceof Error ? error.message : String(error), activePort.getRelease().version);
      throw error;
    }
  }
  const publicApi: SiteWakeApi = {
    open() { panelVisibilityTouchedByUser = true; host.dataset.panelStateSource = "api-open"; panel.hidden = false; trackEngagement("agent-opened", { source: "api" }); setTimeout(() => input.focus(), 0); },
    close() { panelVisibilityTouchedByUser = true; host.dataset.panelStateSource = "api-close"; panel.hidden = true; },
    run: (goal, taskInput = {}) => {
      trackEngagement("goal-submitted", { source: "api" });
      return publicApiCall(() => activePort.run(goal, taskInput));
    },
    call: (capabilityId, taskInput = {}) => {
      trackEngagement("goal-submitted", { source: "direct-call", capabilityId });
      return publicApiCall(() => activePort.call(capabilityId, taskInput));
    },
    teach: (goal) => publicApiCall(() => beginTeaching(goal)),
    finishTeaching: () => publicApiCall(() => activePort.finishTeaching()),
    cancel: () => stopActiveRun(),
    getRelease: () => activePort.getRelease(),
    ...(window.__sitewakeValidation === true
      ? { validateCandidate: (runtime: CapabilityV2RuntimeDefinition, taskInput: Record<string, JsonValue> = {}) => publicApiCall(() => activePort.validateCandidate(runtime, taskInput)) }
      : {}),
    mount: (siteAgentId, endpoint) => {
      if (siteAgentId !== config.siteAgentId || endpoint.replace(/\/$/, "") !== config.endpoint.replace(/\/$/, "")) return;
      if (!host.isConnected) document.documentElement.appendChild(host);
      if (!teachingHost.isConnected) document.documentElement.appendChild(teachingHost);
      window.SiteWake = publicApi;
      void activePort.ready().then(() => dispatchState("ready", undefined, activePort.getRelease().version)).catch(() => dispatchState("error", "runtime_unavailable"));
    },
  };
  window.SiteWake = publicApi;
  function notifyEmbedding(state: "booting" | "ready" | "error", message?: string) {
    if (!config.embedded) return;
    let targetOrigin = "*";
    try { targetOrigin = new URL(config.endpoint).origin; } catch { /* Relative local endpoint. */ }
    const detail = {
      state, message, siteAgentId: config.siteAgentId,
      page: { origin: location.origin, url: location.href, title: document.title },
      releaseVersion: activePort.getRelease().version,
    };
    window.parent.postMessage({ type: "sitewake:embedded-state", ...detail }, targetOrigin);
  }
  if (config.embedded) {
    window.addEventListener("message", (event) => {
      let endpointOrigin = location.origin;
      try { endpointOrigin = new URL(config.endpoint).origin; } catch { /* Relative endpoint. */ }
      if (event.origin !== endpointOrigin || event.source !== window.parent) return;
      const message = event.data as { type?: string; command?: string } | null;
      if (message?.type !== "sitewake:embedded-command") return;
      if (message.command === "open") publicApi.open();
      if (message.command === "close") publicApi.close();
    });
    notifyEmbedding("booting");
  }
  launcher.onclick = () => {
    panelVisibilityTouchedByUser = true;
    host.dataset.panelStateSource = "launcher";
    panel.hidden = !panel.hidden;
    persistExperience();
    if (!panel.hidden) {
      trackEngagement("agent-opened", { source: "launcher" });
      input.focus();
    }
  };
  localeButton.onclick = () => (localeMenu.hidden ? openLocaleMenu() : closeLocaleMenu());
  close.onclick = () => { panelVisibilityTouchedByUser = true; host.dataset.panelStateSource = "close"; panel.hidden = true; persistExperience(); };
  query<HTMLButtonElement>(".new-chat").onclick = async () => {
    if (resettingConversation) return;
    resettingConversation = true;
    newChat.disabled = true;
    cancelActiveTaskLaunch();
    // The questions belong to the empty conversation, so they come back with it.
    // They used to return only if a `ready` status happened to arrive after the
    // reset, which is why they were sometimes there and sometimes not.
    forgetConversationLocale();
    messages = []; lastGoal = ""; resetToolActivity({ clearHistory: true }); renderMessages(); renderSuggestions(); setMode("idle"); persistExperience();
    try { await activePort.resetConversation(); }
    finally { resettingConversation = false; newChat.disabled = false; input.focus(); }
  };
  /** The port emits no terminal status for a cancel, so the trace would keep
   * a spinner and a "…" title forever unless the widget settles them here. */
  function stopActiveRun() {
    const stoppedTaskId = currentTurnTaskId();
    cancelActiveTaskLaunch(); activePort.cancel();
    if (stoppedTaskId) stoppedTaskIds.add(stoppedTaskId);
    activityTimeline = activityTimeline.map(item => item.state === "running" ? { ...item, state: "failed" } : item);
    renderActivityTimeline(); persistExperience();
  }
  // Stopping is a terminal outcome like a failure: the user gets the same way
  // forward — try again, or demonstrate it once — instead of a dead end.
  stop.onclick = () => { stopActiveRun(); setMode("idle"); addMessage(copy.message.stopped, "system", { goal: lastGoal, input: {}, actions: failureActions() }); };
  query<HTMLButtonElement>(".finish-teach").onclick = () => void finishTeaching();
  teachingRoot.querySelector<HTMLButtonElement>(".finish")!.onclick = () => void finishTeaching();
  teachingRoot.querySelector<HTMLButtonElement>(".cancel")!.onclick = () => {
    stopActiveRun(); setMode("idle"); addMessage(copy.teach.cancelled, "system");
  };
  form.onsubmit = (event) => { event.preventDefault(); if (resettingConversation) return; if (mode === "teach-intent") void beginTeaching(input.value); else void submitGoal(input.value); };
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 110)}px`; send.disabled = mode === "running" || !input.value.trim(); });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
  // Do not expose a launcher that cannot handle clicks yet. The previous early
  // mount left a small but observable startup window where the button was
  // visible before its handlers existed, so the user's first click vanished.
  // Mounting only after all synchronous interaction wiring is complete makes
  // the first visible frame interactive by construction.
  host.dataset.sitewakeReady = "true";
  document.documentElement.appendChild(host);
  if (config.open) panel.hidden = false;
  void activePort.ready().then(() => {
    applyAgentConfig(); renderSuggestions();
    dispatchState("ready", undefined, activePort.getRelease().version);
    trackEngagement("agent-seen", {
      page: location.pathname,
      releaseVersion: activePort.getRelease().version,
    });
    if (config.open) trackEngagement("agent-opened", { source: "configured-open" });
    notifyEmbedding("ready");
    const beginLaunch = async () => {
      if (capturedLaunchToken) {
        const claimIntent = capturedTaskLaunchClaim;
        const separator = capturedLaunchToken.indexOf(".");
        const launchId = separator > 0 ? capturedLaunchToken.slice(0, separator) : "";
        if (!launchId
          || !claimIntent
          || claimIntent.launchId !== launchId
          || claimIntent.token !== capturedLaunchToken) {
          throw new Error("task_launch_token_invalid");
        }
        let payload: {
          launch?: {
            goal: string;
            capabilityId?: string;
            input: Record<string, JsonValue>;
            mode: "run" | "demonstrate";
            executionMode?: "run" | "debug";
            releaseId?: string;
            releaseVersion?: number;
            revisionId?: string;
            expiresAt?: string;
          };
          claimKey?: string;
          message?: string;
          error?: string;
        } = {};
        for (let attempt = 0; attempt < 3; attempt += 1) {
          let response: Response;
          try {
            response = await fetch(`${config.endpoint.replace(/\/$/, "")}/api/site-agents/${encodeURIComponent(config.siteAgentId)}/task-launches/${encodeURIComponent(launchId)}/claim`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                token: claimIntent.token,
                claimKey: claimIntent.claimKey,
                origin: location.origin,
              }),
            });
          } catch (error) {
            if (attempt < 2) {
              await new Promise((resolve) => window.setTimeout(resolve, 250 * (2 ** attempt)));
              continue;
            }
            throw error;
          }
          payload = await response.json().catch(() => ({})) as typeof payload;
          if (response.ok && payload.launch
            && (!payload.claimKey || payload.claimKey === claimIntent.claimKey)) {
            break;
          }
          const retryable = response.status >= 500
            || response.status === 408
            || response.status === 429;
          if (retryable && attempt < 2) {
            await new Promise((resolve) => window.setTimeout(resolve, 250 * (2 ** attempt)));
            continue;
          }
          clearStoredTaskLaunchClaim();
          throw new Error(payload.message || payload.error || "task_launch_claim_failed");
        }
        if (!payload.launch) throw new Error("task_launch_claim_failed");
        const claimedBase: StoredTaskLaunch = {
          launchId,
          claimKey: claimIntent.claimKey,
          goal: payload.launch.goal,
          capabilityId: payload.launch.capabilityId,
          input: payload.launch.input || {},
          mode: payload.launch.mode,
          executionMode: payload.launch.executionMode || "run",
          releaseId: payload.launch.releaseId,
          releaseVersion: payload.launch.releaseVersion,
          revisionId: payload.launch.revisionId,
          started: true,
          savedAt: Date.now(),
          leaseExpiresAt: payload.launch.expiresAt
            ? Date.parse(payload.launch.expiresAt)
            : undefined,
        };
        let executionPin: TaskLaunchExecutionPin | undefined;
        try {
          executionPin = taskLaunchExecutionPin(payload.launch);
          if (payload.launch.capabilityId && !executionPin) {
            throw new Error("task_launch_execution_pin_incomplete");
          }
        } catch (error) {
          saveTaskLaunch(claimedBase);
          clearStoredTaskLaunchClaim();
          startTaskLaunchHeartbeat();
          await persistTerminalTaskLaunch(claimedBase, {
            status: "failed",
            resultUrl: location.href,
            error: {
              code: "task_launch_execution_pin_incomplete",
              summary: error instanceof Error ? error.message : String(error),
            },
          });
          throw error;
        }
        const claimed: StoredTaskLaunch = {
          ...claimedBase,
          ...(executionPin || {}),
        };
        saveTaskLaunch(claimed);
        clearStoredTaskLaunchClaim();
        startTaskLaunchHeartbeat();
        if (!panelVisibilityTouchedByUser) {
          host.dataset.panelStateSource = "claimed-task-launch";
          panel.hidden = claimed.executionMode !== "debug" && claimed.mode !== "demonstrate";
        }
        await patchTaskLaunch(claimed, { status: "running", resultUrl: location.href });
        if (claimed.mode === "demonstrate") await beginTeaching(claimed.goal);
        else if (claimed.capabilityId) await callFromClaimedTaskLaunch(activePort, claimed.capabilityId, claimed.input, executionPin!);
        else await activePort.run(claimed.goal, claimed.input);
        return;
      }
      // A claimed launch survives full-document navigation in sessionStorage.
      // AgentPort resumes its checkpoint; this document only needs to report
      // the eventual completion through onStatus, never start the task twice.
      if (activeTaskLaunch?.pendingTerminalPatch) {
        const pending = activeTaskLaunch;
        const terminalPatch = pending.pendingTerminalPatch!;
        startTaskLaunchHeartbeat();
        void persistTerminalTaskLaunch(
          pending,
          terminalPatch,
        );
        return;
      }
      if (activeTaskLaunch?.started) {
        if (activePort.hasRestorableTask()
          && !activePort.ownsRestorableTask()) {
          addMessage(
            copy.error.alreadyRunningHere,
            "system",
          );
          return;
        }
        const resumed = activeTaskLaunch;
        await patchTaskLaunch(resumed, {
          status: "running",
          resultUrl: location.href,
        });
        startTaskLaunchHeartbeat();
        if (!panelVisibilityTouchedByUser) {
          host.dataset.panelStateSource = "restored-task-launch";
          panel.hidden = activeTaskLaunch.executionMode !== "debug" && activeTaskLaunch.mode !== "demonstrate";
        }
        if (activePort.hasRestorableTask()) return;
        const lost = activeTaskLaunch;
        await persistTerminalTaskLaunch(lost, { status: "failed", resultUrl: location.href, error: { code: "task_state_lost", summary: copy.error.checkpointLostSummary } });
        addMessage(copy.error.checkpointLost, "error", { outcome: "execution-fault", actions: ["retry"] });
        return;
      }
      if (capturedStartupGoal) { panel.hidden = false; if (capturedStartupMode === "teach") await beginTeaching(capturedStartupGoal); else await submitGoal(capturedStartupGoal); }
    };
    void beginLaunch().catch((error) => { dispatchState("error", error instanceof Error ? error.message : String(error), activePort.getRelease().version); addMessage(friendlyFailure(error), "error", { outcome: "execution-fault", actions: ["retry"] }); if (activeTaskLaunch) { const launch = activeTaskLaunch; void persistTerminalTaskLaunch(launch, { status: "failed", error: { code: "task_launch_failed", summary: error instanceof Error ? error.message : String(error) }, resultUrl: location.href }); } });
  }).catch((error) => {
    // Keep the user-facing copy concise, but preserve the actual initialization
    // failure for developer diagnostics instead of collapsing every cause into
    // an indistinguishable "connection failed" state.
    console.error("[SiteWake] SDK initialization failed", error);
    status.textContent = copy.status.failed; status.title = error instanceof Error ? error.message : String(error);
    dispatchState("error", error instanceof Error ? error.message : String(error), activePort.getRelease().version);
    notifyEmbedding("error", error instanceof Error ? error.message : String(error));
    addMessage(friendlyFailure(error), "error", { outcome: "execution-fault", actions: ["retry"] });
    if (activeTaskLaunch) {
      const launch = activeTaskLaunch;
      if (launch.pendingTerminalPatch) {
        void persistTerminalTaskLaunch(launch, launch.pendingTerminalPatch);
        return;
      }
      void persistTerminalTaskLaunch(launch, {
        status: "failed",
        error: {
          code: "task_launch_release_load_failed",
          summary: error instanceof Error ? error.message : String(error),
        },
        resultUrl: location.href,
      });
    }
  });
}

/**
 * The widget's stylesheet, loaded from the control plane rather than injected.
 *
 * A site with `style-src 'self'` refuses a `<style>` element — including one
 * inside this shadow root (measured in tests/csp-request-inventory.test.mjs) —
 * and would only take it back with `'unsafe-inline'`. Linking it from the same
 * address the script and the API already come from keeps SiteWake's whole ask
 * down to one origin.
 */
/**
 * Link the widget stylesheet into a shadow root, after its markup.
 *
 * Assigning `innerHTML` replaces every child of the root, the link included.
 * The teaching studio linked its stylesheet and then wrote its markup, so the
 * studio never had any styles at all: it drew as an unstyled block over the
 * site's own header, and because its host is `pointer-events:none` so that the
 * page underneath stays usable, the section inherited that and neither 取消 nor
 * 完成演示 could be clicked. Call this after the markup, never before.
 */
function linkWidgetStylesheet(root: ShadowRoot, endpoint: string) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `${String(endpoint || "").replace(/\/$/, "")}${WIDGET_STYLESHEET_PATH}`;
  root.appendChild(link);
}
