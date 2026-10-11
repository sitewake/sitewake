import type { CapabilityExperience, CapabilityGenerationInput, JsonObject, JsonValue } from "./model";
import { EXPERIENCE_PAGE_ACTIONS } from "../site-knowledge/protocol";
import type { PageAgentObservation, TaskEpisode } from "../site-knowledge/protocol";
import type { AgentRun } from "../site-knowledge/protocol";
import { normalizeGoal } from "../site-knowledge/protocol";
import { redactSensitiveJson, redactSensitiveText } from "../site-knowledge/sensitive-data";

const SENSITIVE_KEY = /(?:password|passwd|passcode|secret|token|authorization|cookie|credential|one.?time|otp|session(?:id)?|signature|credit.?card|debit.?card|card.?(?:number|no|security|expiry|expiration)|cc.?(?:number|num|csc|exp)|cvc|cvv|cvn)/iu;
const PAYMENT_TARGET = /(?:credit.?card|debit.?card|payment.?card|card.?(?:number|no|security|expiry|expiration)|cc.?(?:number|num|csc|exp)|cvc|cvv|cvn)/iu;
const MAX_ACTIONS = 24;
const MAX_STRING = 600;
const MAX_OUTPUT_KEYS = 30;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, limit = MAX_STRING) {
  return typeof value === "string" ? redactSensitiveText(value).trim().slice(0, limit) : "";
}

function safeUrl(value: unknown) {
  const raw = text(value, 2_000);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) if (SENSITIVE_KEY.test(key)) url.searchParams.delete(key);
    if (SENSITIVE_KEY.test(url.hash)) url.hash = "";
    return url.href.slice(0, 2_000);
  } catch {
    return raw.split("#")[0]!.slice(0, 2_000);
  }
}

function safeValue(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 3 || value === undefined) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactSensitiveText(value).slice(0, MAX_STRING);
  if (Array.isArray(value)) return value.slice(0, 20).flatMap((item) => {
    const safe = safeValue(item, depth + 1);
    return safe === undefined ? [] : [safe];
  });
  if (typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SENSITIVE_KEY.test(key))
    .slice(0, MAX_OUTPUT_KEYS)
    .flatMap(([key, item]) => {
      const safe = safeValue(item, depth + 1);
      return safe === undefined ? [] : [[key.slice(0, 80), safe]];
    })) as JsonObject;
}

function page(value: unknown) {
  const raw = record(value);
  return {
    url: safeUrl(raw.url),
    title: text(raw.title, 240) || undefined,
    heading: text(raw.heading, 240) || undefined,
  };
}

function route(value: unknown): NonNullable<CapabilityExperience["routes"]>[number] | undefined {
  const raw = record(value);
  const url = safeUrl(raw.url);
  if (!url) return undefined;
  return {
    url,
    sceneId: text(raw.sceneId, 160) || undefined,
    bindings: (safeValue(raw.bindings) || {}) as Record<string, JsonValue>,
    observedAt: text(raw.observedAt, 80),
  };
}

function action(value: unknown): CapabilityExperience["actions"][number] | undefined {
  const raw = record(value);
  const actionValue = ["click", "fill", "select", "scroll", "wait", "unknown"].includes(String(raw.action))
    ? String(raw.action) as CapabilityExperience["actions"][number]["action"]
    : "unknown";
  const rawElement = record(raw.element);
  const attributes = record(rawElement.attributes);
  const passwordField = String(attributes.type || "").toLowerCase() === "password"
    || SENSITIVE_KEY.test([rawElement.name, rawElement.label, rawElement.placeholder, rawElement.accessibleName].map(String).join(" "));
  const safeInput = passwordField ? {} : record(safeValue(raw.input));
  const element = Object.fromEntries([
    ["tag", text(rawElement.tag, 80)],
    ["role", text(rawElement.role, 80)],
    ["accessibleName", text(rawElement.accessibleName, 240)],
    ["label", text(rawElement.label, 240)],
    ["placeholder", text(rawElement.placeholder, 240)],
    ["name", SENSITIVE_KEY.test(String(rawElement.name || "")) ? "" : text(rawElement.name, 160)],
    ["href", safeUrl(rawElement.href)],
    ["contextText", text(rawElement.contextText, 500)],
    ["landmark", text(rawElement.landmark, 40)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1])));
  return {
    action: actionValue,
    rawAction: text(raw.rawAction, 120),
    input: safeInput as Record<string, JsonValue>,
    element: Object.keys(element).length ? element : undefined,
    page: page(raw.page),
    observedAt: text(raw.observedAt, 80) || new Date().toISOString(),
  };
}

/** Re-sanitize at every trust boundary, even when the SDK already compacted it. */
export function normalizeCapabilityExperience(value: unknown): CapabilityExperience {
  const raw = record(value);
  const outcome = raw.outcome === "NoResult" ? "NoResult" : raw.outcome === "Success" ? "Success" : undefined;
  if (!outcome) throw new Error("capability_experience_outcome_invalid");
  const actions = (Array.isArray(raw.actions) ? raw.actions : []).slice(0, MAX_ACTIONS)
    .map(action).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const routes = (Array.isArray(raw.routes) ? raw.routes : []).slice(0, MAX_ACTIONS)
    .map(route).filter((item): item is NonNullable<typeof item> => Boolean(item));
  const experience: CapabilityExperience = {
    schemaVersion: "1.0",
    episodeId: text(raw.episodeId, 160),
    agentRunId: text(raw.agentRunId, 160),
    browserSessionId: text(raw.browserSessionId, 160),
    originalGoal: text(raw.originalGoal, 1_000),
    outcome,
    outcomeSummary: text(raw.outcomeSummary, 1_000),
    startedAt: text(raw.startedAt, 80),
    endedAt: text(raw.endedAt, 80),
    startPage: page(raw.startPage),
    endPage: page(raw.endPage),
    actions,
    ...(routes.length ? { routes } : {}),
    output: (safeValue(raw.output) || {}) as JsonObject,
  };
  if (!experience.episodeId || !experience.agentRunId || !experience.browserSessionId || !experience.originalGoal
    || !experience.startedAt || !experience.endedAt || !experience.startPage.url || !experience.endPage.url) {
    throw new Error("capability_experience_required_field_missing");
  }
  return experience;
}

export function capabilityExperienceHasPageEvidence(experience: CapabilityExperience) {
  // An address the run entered is evidence too. Requiring an action admitted
  // only capabilities that click, and excluded the kind this site is made of:
  // an answer that lives at a parameterized route.
  return experience.actions.some((item) => (EXPERIENCE_PAGE_ACTIONS as readonly string[]).includes(item.action))
    || Boolean(experience.routes?.length);
}

/**
 * Where a Runner should begin.
 *
 * The page the run started on is where the user happened to be standing, not
 * where the work is. When the run entered an address, that address is the
 * ground the capability stands on — starting anywhere else asks the Runner to
 * rediscover a route the run already handed it.
 */
export function capabilityExperienceStartUrl(experience: CapabilityExperience) {
  const routes = experience.routes || [];
  if (!routes.length) return experience.startPage.url;
  const sameAddress = (left: string, right: string) => {
    try {
      const one = new URL(left);
      const other = new URL(right);
      return one.origin === other.origin && one.pathname === other.pathname && one.search === other.search;
    } catch { return false; }
  };
  // A run may correct itself — a first address built from a badly formatted
  // value, then the right one. The address it stayed on is the one that
  // answered the goal, so prefer the entered address the run ended on, and
  // fall back to the terminal page when no recorded address matches it.
  const landed = [...routes].reverse().find((item) => sameAddress(item.url, experience.endPage.url));
  if (landed) return landed.url;
  return experience.actions.length ? routes[routes.length - 1].url : experience.endPage.url;
}

/** The values the run bound into the addresses it entered. */
export function capabilityExperienceRouteBindings(experience: CapabilityExperience) {
  return (experience.routes || []).flatMap((item) => Object.values(item.bindings));
}

export function capabilityExperienceJsonSize(experience: CapabilityExperience) {
  return new TextEncoder().encode(JSON.stringify(experience)).byteLength;
}

export const CAPABILITY_EXPERIENCE_MAX_BYTES = 56_000;

/**
 * The input generation actually consumes, built from a handover.
 *
 * This is the last thing in the chain before a capability is authored, so it is
 * what an owner needs to see to judge the contract between the two modules —
 * including what the restructuring drops. It lives here, and the discovery path
 * calls it, so the drawer cannot show a shape that generation never receives.
 *
 * The repair path builds a different input (`mode: "repair"` plus a capability
 * context) and is deliberately not covered here.
 */
export type DiscoveryGenerationInput = Extract<CapabilityGenerationInput, { source: "Episode" }>;

export function discoveryGenerationInputFromExperience(
  experience: CapabilityExperience,
): DiscoveryGenerationInput {
  return {
    request: {
      goal: experience.originalGoal,
      parameters: {},
      // Where the run stood, not where the visitor happened to be standing
      // when they asked. This is the address generation starts from.
      entryUrl: capabilityExperienceStartUrl(experience),
      locale: "zh-CN",
    },
    source: "Episode",
    experience: {
      episodeId: experience.episodeId,
      mode: "adaptive",
      execution: { startPage: experience.startPage, actions: experience.actions, endPage: experience.endPage },
      outcome: { status: experience.outcome, summary: experience.outcomeSummary },
      evidence: { episodeId: experience.episodeId, actionCount: experience.actions.length },
    },
  };
}

/**
 * Why one Episode was, or was not, handed over to the capability centre.
 *
 * The first three are the caller's conclusions rather than this function's: a
 * run that produced no Episode has nothing here to judge, and why it produced
 * none is a property of the run. They share this type so that a caller can
 * describe every outcome with one vocabulary.
 *
 * Keeping them apart matters: a task the user cancelled and a task that
 * answered without touching the page both end with no Episode, but only the
 * second is the design working. Reporting them as one reason would file real
 * faults under "working as intended".
 */
export type CapabilityHandoffBlockedReason =
  | "noEpisode"
  | "run-cancelled"
  | "run-unfinished"
  | "not-adaptive"
  | "capability-call"
  | "capability-repair"
  | "no-experience-evidence"
  | "outcome-not-eligible"
  | "no-page-action"
  | "payload-too-large"
  | "malformed";

export type CapabilityHandoff =
  | { delivered: true; experience: CapabilityExperience; bytes: number }
  | { delivered: false; reason: CapabilityHandoffBlockedReason; bytes?: number };

/**
 * Decide whether one Episode becomes a capability-centre handover, and build
 * the payload when it does.
 *
 * Both the browser (which actually posts it) and the effect drawer (which shows
 * what was posted) go through here. Keeping one implementation is the whole
 * basis for the drawer's claim that you are looking at the real payload: a
 * second copy would drift the first time someone added a gate on one side, and
 * the drawer would then display a payload that is never sent.
 *
 * Returning a reason rather than `undefined` is what lets the drawer say why
 * nothing was handed over. Callers that only need the payload can ignore it.
 */
export function capabilityHandoffForEpisode(
  episode: TaskEpisode,
  output: Record<string, JsonValue>,
): CapabilityHandoff {
  // Exploration that reached the goal belongs to the capability centre, and
  // the centre decides what to do with it. Only two things are not
  // exploration: running a published capability, and repairing one — a repair
  // names the capability it repairs and goes down that capability's own path.
  //
  // A second pass of an exploration used to be labelled `repair` with no
  // capability attached, and every one of those was dropped here: a
  // 490-second success with two page actions reached nothing and said nothing.
  // The label is fixed at the source; an older widget can still send it, and
  // it is read for what it is.
  if (episode.capabilityId) return { delivered: false, reason: "capability-call" };
  if (episode.mode === "repair" && episode.sourceCapabilityId) return { delivered: false, reason: "capability-repair" };
  const exploration = episode.mode === "adaptive" || episode.mode === "demonstration" || episode.mode === "repair";
  if (!exploration) return { delivered: false, reason: "not-adaptive" };
  if (!episode.experience) return { delivered: false, reason: "no-experience-evidence" };
  if (episode.outcome.status !== "success" && episode.outcome.status !== "no-result") {
    return { delivered: false, reason: "outcome-not-eligible" };
  }
  let experience: CapabilityExperience;
  try {
    experience = normalizeCapabilityExperience({
      schemaVersion: "1.0",
      episodeId: episode.id,
      agentRunId: episode.taskSessionId,
      browserSessionId: episode.browserSessionId,
      originalGoal: episode.goal,
      outcome: episode.outcome.status === "no-result" ? "NoResult" : "Success",
      outcomeSummary: episode.outcome.summary,
      startedAt: episode.startedAt,
      endedAt: episode.endedAt,
      startPage: episode.startSnapshot,
      endPage: episode.endSnapshot,
      actions: episode.experience.actions,
      routes: episode.experience.routes,
      output,
    });
  } catch {
    return { delivered: false, reason: "malformed" };
  }
  const bytes = capabilityExperienceJsonSize(experience);
  if (!capabilityExperienceHasPageEvidence(experience)) return { delivered: false, reason: "no-page-action", bytes };
  if (bytes > CAPABILITY_EXPERIENCE_MAX_BYTES) return { delivered: false, reason: "payload-too-large", bytes };
  return { delivered: true, experience, bytes };
}

/**
 * Build the compact, sanitized authoring receipt on the server. Raw model
 * observations remain in the evidence store and are referenced only by the
 * separately verified authority envelope.
 */
export function capabilityExperienceFromEpisode(
  episode: TaskEpisode,
  observations: PageAgentObservation[],
  run?: AgentRun,
) {
  const observationById = new Map(observations.map((item) => [item.id, item]));
  const receiptActions = (episode.experience?.actionReceiptsV2 || [])
    // Only server-authorized V2 effects are authoring input. Unchanged steps
    // are diagnostic evidence, not a workflow to teach; unknown effects are
    // rejected by CapabilityExperienceAuthority before this function runs.
    .filter((receipt) => receipt.dispatched && receipt.effect === "changed"
      && receipt.action !== "focus" && receipt.action !== "press")
    .map((receipt) => {
      const observation = observationById.get(receipt.beforeObservationId);
      const mappedAction: CapabilityExperience["actions"][number]["action"] = receipt.action === "set-text" || receipt.action === "insert-text"
        ? "fill"
        : receipt.action === "select"
          ? "select"
          : receipt.action === "scroll"
            ? "scroll"
            : receipt.action === "wait"
              ? "wait"
              : ["click", "submit"].includes(receipt.action)
                ? "click"
                : "unknown";
      return {
        action: mappedAction,
        rawAction: receipt.action,
        input: PAYMENT_TARGET.test([
          receipt.target?.accessibleName,
          receipt.target?.controlType,
          receipt.target?.nearbyText,
        ].map(String).join(" ")) ? {} : Object.fromEntries(Object.entries(receipt.input).filter(([, value]) => {
          const normalized = normalizeGoal(String(value));
          return !normalized || normalizeGoal(run?.goal || episode.goal).includes(normalized)
            || Object.values(run?.input || episode.input).some((trusted) => normalizeGoal(String(trusted)).includes(normalized));
        })),
        element: receipt.target ? {
          role: receipt.target.role,
          accessibleName: receipt.target.accessibleName,
          contextText: receipt.target.nearbyText,
        } : undefined,
        page: {
          url: observation?.state.url || episode.startSnapshot.url,
          title: observation?.state.title || episode.startSnapshot.title,
        },
        observedAt: receipt.startedAt,
      };
    });
  const hasV2Evidence = Boolean(episode.experience?.observationRefs?.length
    || episode.experience?.actionReceiptsV2?.length);
  // Once V2 evidence is present the client-authored legacy action list is
  // untrusted. Author only from receipts validated against durable snapshots.
  const actions = hasV2Evidence
    ? receiptActions
    : episode.experience?.actions?.length
      ? episode.experience.actions
      : receiptActions;
  const firstObservation = observations.at(0);
  const lastObservation = observations.at(-1);
  const originalGoal = run?.goal || episode.goal;
  return normalizeCapabilityExperience({
    schemaVersion: "1.0",
    episodeId: episode.id,
    agentRunId: episode.taskSessionId,
    browserSessionId: episode.browserSessionId,
    originalGoal,
    outcome: episode.outcome.status === "no-result" ? "NoResult" : "Success",
    outcomeSummary: `Observed ${receiptActions.length} changed page action${receiptActions.length === 1 ? "" : "s"}; terminal page: ${lastObservation?.state.title || "untitled"}.`,
    startedAt: firstObservation?.capturedAt || episode.startedAt,
    endedAt: lastObservation?.capturedAt || episode.endedAt,
    startPage: firstObservation?.state || episode.startSnapshot,
    endPage: lastObservation?.state || episode.endSnapshot,
    actions,
    // Receipts can replace a client-authored action list; they cannot replace
    // an address, which no receipt describes.
    routes: episode.experience?.routes,
    output: redactSensitiveJson({
      terminalUrl: lastObservation?.state.url || episode.endSnapshot.url,
      terminalTitle: lastObservation?.state.title || episode.endSnapshot.title,
      actionCount: receiptActions.length,
    }),
  });
}
