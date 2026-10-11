/**
 * The entry-verification state machine — the missing rung that turns "the AI
 * understood this page" (semantics) into "the agent can reliably enter it"
 * (execution). It is a pure reducer over a scene: an execution outcome (or a
 * dedicated re-verify probe) feeds back as `EntryFeedback`, and the scene's
 * `directEntry` / `evidenceStatus` promote or demote accordingly. All health
 * counters/timestamps are volatile (excluded from the material hash), so only the
 * discrete state transition re-versions the release.
 */
import type { JsonPrimitive, PageSnapshot, SceneDefinition } from "./protocol";
import { matchUrlTemplate } from "./url-scene";

export type EntryFeedback = {
  /**
   * `reached-verified` — a real run reached this scene via its URL template and the
   * verifier passed (the ONLY way to earn `verified`).
   * `structural-fault` — a run that targeted this scene failed structurally
   * (target/scene/operation not found), evidence the entry is broken/stale.
   * `machinery-ok` — a run touched the scene and its machinery worked, but not as a
   * direct-entry proof (counts a success, never promotes).
   */
  kind: "reached-verified" | "structural-fault" | "machinery-ok";
  at: string;
  reason?: string;
};

/** Consecutive structural faults before a *verified* entry is demoted to re-verify. */
export const ENTRY_DEMOTE_STREAK = 2;
/** Consecutive faults before an unverified candidate is marked failed. */
export const ENTRY_FAIL_STREAK = 4;

function health(scene: SceneDefinition) {
  return scene.entryHealth || { successes: 0, failures: 0, failStreak: 0 };
}

export function applyEntryFeedback(scene: SceneDefinition, feedback: EntryFeedback): SceneDefinition {
  const current = health(scene);

  if (feedback.kind === "reached-verified") {
    return {
      ...scene,
      directEntry: "verified",
      evidenceStatus: "entry-verified",
      lastVerifiedAt: feedback.at,
      demotedAt: undefined,
      verificationFailure: undefined,
      entryHealth: { ...current, successes: current.successes + 1, failStreak: 0, lastOkAt: feedback.at },
      updatedAt: feedback.at,
    };
  }

  if (feedback.kind === "structural-fault") {
    const failStreak = current.failStreak + 1;
    const entryHealth = { ...current, failures: current.failures + 1, failStreak, lastFailAt: feedback.at };
    // A verified entry that fails structurally is no longer trustworthy — demote to
    // needs-reverify (a probe or a later successful run re-promotes it).
    if (scene.directEntry === "verified" && failStreak >= ENTRY_DEMOTE_STREAK) {
      const demotedStatus = scene.evidenceStatus === "entry-verified" ? "observed" : scene.evidenceStatus;
      // Demote the (deprecated) lifecycle in lockstep with evidenceStatus. Canonicalization
      // recomputes evidenceStatus as strongerEvidenceStatus(evidenceStatus, lifecycle), so a
      // stale lifecycle="entry-verified" left here would resurrect the pre-demotion status.
      return { ...scene, directEntry: "needs-reverify", evidenceStatus: demotedStatus, lifecycle: scene.lifecycle === "entry-verified" ? "observed" : scene.lifecycle, demotedAt: feedback.at, verificationFailure: feedback.reason, entryHealth, updatedAt: feedback.at };
    }
    // An unverified candidate that keeps failing is marked failed (stop retrying).
    if (scene.directEntry !== "verified" && failStreak >= ENTRY_FAIL_STREAK) {
      return { ...scene, directEntry: "failed", demotedAt: feedback.at, verificationFailure: feedback.reason, entryHealth, updatedAt: feedback.at };
    }
    return { ...scene, verificationFailure: feedback.reason, entryHealth, updatedAt: feedback.at };
  }

  // machinery-ok: real success but not a direct-entry proof — reinforce, don't promote.
  return { ...scene, entryHealth: { ...current, successes: current.successes + 1, failStreak: 0, lastOkAt: feedback.at }, updatedAt: feedback.at };
}

/** A scene whose verified entry has gone stale past `ttlMs` (no re-proof) — a
 *  candidate for a cheap re-verify probe. Pure; the caller supplies `now`. */
export function entryNeedsReverify(scene: SceneDefinition, now: number, ttlMs: number): boolean {
  if (scene.directEntry === "needs-reverify") return true;
  if (scene.directEntry !== "verified" || !scene.lastVerifiedAt) return false;
  return now - Date.parse(scene.lastVerifiedAt) >= ttlMs;
}

/**
 * Sample parameter bindings for a probe — the concrete values used to build the
 * candidate's URL. Taken from each parameter's own examples; returns undefined if
 * a *required* parameter has no example (can't safely probe it).
 */
export function sampleEntryBindings(scene: SceneDefinition): Record<string, JsonPrimitive> | undefined {
  const bindings: Record<string, JsonPrimitive> = {};
  for (const parameter of scene.parameters) {
    const sample = parameter.examples?.[0];
    if (sample !== undefined) bindings[parameter.id] = sample;
    else if (parameter.required) return undefined;
  }
  return bindings;
}

/**
 * The verification assertion the browser runner calls after opening the built URL:
 * the opened page must actually BE this scene's parameterized URL, and its verifier
 * (title/heading/text) must hold. Pure — the runner only supplies the snapshot.
 * A pass earns `reached-verified`; any miss is a `structural-fault` with a reason.
 */
export function verifyEntry(scene: SceneDefinition, snapshot: Pick<PageSnapshot, "url" | "title" | "heading" | "visibleText">, at: string): EntryFeedback {
  const template = scene.urlTemplates[0];
  if (!template || !matchUrlTemplate(template, snapshot.url)) return { kind: "structural-fault", at, reason: "url_template_mismatch" };
  const includesAll = (haystack: string, needles?: string[]) => (needles || []).every((needle) => haystack.includes(needle));
  const verifier = scene.verifier || {};
  if (!includesAll(snapshot.title || "", verifier.titleIncludes)) return { kind: "structural-fault", at, reason: "title_assertion_failed" };
  if (!includesAll(snapshot.heading || "", verifier.headingIncludes)) return { kind: "structural-fault", at, reason: "heading_assertion_failed" };
  if (!includesAll(snapshot.visibleText || "", verifier.textIncludes)) return { kind: "structural-fault", at, reason: "text_assertion_failed" };
  return { kind: "reached-verified", at };
}
