import type {
  CapabilityExecutionCursor,
  CapabilityLoopDefinition,
  CapabilityProgram,
  JsonObject,
} from "./model";

/** Default host-wide guards for a program that does not declare a loop. */
export const DEFAULT_CAPABILITY_MAX_TRANSITIONS = 1_000;
export const DEFAULT_CAPABILITY_TOTAL_TIMEOUT_MS = 180_000;

export class CapabilityControlFlowError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}:${message}`);
    this.name = "CapabilityControlFlowError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneCursor(cursor: CapabilityExecutionCursor): CapabilityExecutionCursor {
  return {
    ...cursor,
    loopIterations: { ...cursor.loopIterations },
    loopNoProgress: { ...cursor.loopNoProgress },
    loopStartedAt: { ...cursor.loopStartedAt },
    ...(cursor.loopProgressFingerprints ? { loopProgressFingerprints: { ...cursor.loopProgressFingerprints } } : {}),
  };
}

function loopsOf(program: CapabilityProgram): CapabilityLoopDefinition[] {
  return program.controlFlow?.loops || [];
}

function stageIds(program: CapabilityProgram) {
  return new Set(program.stages.map((stage) => stage.id));
}

function stageOf(program: CapabilityProgram, stageId: string) {
  const stage = program.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new CapabilityControlFlowError("capability_control_flow_stage_missing", stageId);
  return stage;
}

function finitePositive(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function capabilityControlFlowLimits(program: CapabilityProgram) {
  return {
    maxTransitions: finitePositive(program.controlFlow?.maxTransitions, DEFAULT_CAPABILITY_MAX_TRANSITIONS),
    totalTimeoutMs: finitePositive(program.controlFlow?.totalTimeoutMs, DEFAULT_CAPABILITY_TOTAL_TIMEOUT_MS),
  };
}

/**
 * Return the hard deadline for entering/running a stage.  The program-wide
 * deadline and every loop containing the stage apply; the narrowest one wins.
 */
/**
 * A stage gives up before the program does.
 *
 * The two deadlines used to be the same instant, so a stage that waited for
 * something the page never showed hit both at once and the program budget —
 * checked at the stage boundary — won the race. That error says only
 * `capability_control_flow_timeout:180000`: not which wait was pending, and
 * not to the read stage that would have recorded NoResult for it. A search
 * whose third case had no results on the page spent 198 seconds and ended the
 * whole validation instead of answering 「没有结果」.
 *
 * The reserve is what buys the run its own diagnosis.
 */
export const CAPABILITY_STAGE_DEADLINE_RESERVE_MS = 5_000;

export function capabilityStageDeadline(
  program: CapabilityProgram,
  cursor: CapabilityExecutionCursor,
  stageId: string,
) {
  const limits = capabilityControlFlowLimits(program);
  // A tenth of a short budget, five seconds of a long one: enough for the
  // stage's own timer to fire first, never enough to change what a stage that
  // is making progress can do.
  const reserve = Math.min(CAPABILITY_STAGE_DEADLINE_RESERVE_MS, Math.floor(limits.totalTimeoutMs / 10));
  let deadline = cursor.startedAt + Math.max(1, limits.totalTimeoutMs - reserve);
  for (const loop of loopsOf(program)) {
    if (!loop.stageIds.includes(stageId)) continue;
    const startedAt = cursor.loopStartedAt[loop.id];
    if (startedAt !== undefined) deadline = Math.min(deadline, startedAt + loop.timeoutMs);
  }
  return deadline;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

export function capabilityJsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function pathValue(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Produce a deterministic boundary fingerprint for no-progress detection.
 * Loop-specific progress paths keep unrelated state changes from making a
 * polling loop look productive when its business cursor did not move.
 */
export function capabilityProgressFingerprint(state: JsonObject, paths?: readonly string[]) {
  const selected = paths?.length
    ? Object.fromEntries(paths.map((path) => [path, pathValue(state, path)]))
    : state;
  return JSON.stringify(stableValue(selected));
}

function assertCursorStage(program: CapabilityProgram, cursor: CapabilityExecutionCursor) {
  if (!cursor.currentStageId) return;
  if (!stageIds(program).has(cursor.currentStageId)) {
    throw new CapabilityControlFlowError("capability_control_flow_stage_missing", cursor.currentStageId);
  }
}

function assertExecutionBudget(program: CapabilityProgram, cursor: CapabilityExecutionCursor, now: number) {
  const limits = capabilityControlFlowLimits(program);
  if (cursor.transitionCount > limits.maxTransitions) {
    throw new CapabilityControlFlowError("capability_control_flow_transition_limit_exceeded", String(limits.maxTransitions));
  }
  if (now - cursor.startedAt > limits.totalTimeoutMs) {
    throw new CapabilityControlFlowError("capability_control_flow_timeout", String(limits.totalTimeoutMs));
  }
}

function assertLoopBudget(loop: CapabilityLoopDefinition, cursor: CapabilityExecutionCursor, now: number) {
  const iterations = cursor.loopIterations[loop.id] || 0;
  if (iterations > loop.maxIterations) {
    throw new CapabilityControlFlowError("capability_control_flow_loop_limit_exceeded", loop.id);
  }
  const startedAt = cursor.loopStartedAt[loop.id];
  if (startedAt !== undefined && now - startedAt > loop.timeoutMs) {
    throw new CapabilityControlFlowError("capability_control_flow_loop_timeout", loop.id);
  }
  if ((cursor.loopNoProgress[loop.id] || 0) >= loop.maxNoProgress) {
    throw new CapabilityControlFlowError("capability_control_flow_no_progress", loop.id);
  }
}

/** Validate both global and applicable loop budgets at an arbitrary boundary. */
export function assertCapabilityControlFlowBudget(
  program: CapabilityProgram,
  cursor: CapabilityExecutionCursor,
  now = Date.now(),
) {
  assertExecutionBudget(program, cursor, now);
  if (cursor.currentStageId) {
    for (const loop of loopsOf(program)) {
      if (loop.stageIds.includes(cursor.currentStageId)) assertLoopBudget(loop, cursor, now);
    }
  }
}

export function createCapabilityExecutionCursor(
  program: CapabilityProgram,
  startStageId?: string,
  restored?: CapabilityExecutionCursor,
  now = Date.now(),
): CapabilityExecutionCursor {
  const firstStageId = startStageId || restored?.currentStageId || program.stages[0]?.id || "";
  if (firstStageId) stageOf(program, firstStageId);
  const cursor: CapabilityExecutionCursor = restored
    ? {
        ...restored,
        currentStageId: firstStageId,
        iteration: Number.isFinite(restored.iteration) ? restored.iteration : 0,
        transitionCount: Number.isFinite(restored.transitionCount)
          ? restored.transitionCount
          : Math.max(0, (Number.isFinite(restored.iteration) ? restored.iteration : 0) - 1),
        loopIterations: { ...restored.loopIterations },
        loopNoProgress: { ...restored.loopNoProgress },
        loopStartedAt: { ...restored.loopStartedAt },
        ...(restored.loopProgressFingerprints ? { loopProgressFingerprints: { ...restored.loopProgressFingerprints } } : {}),
      }
    : {
        currentStageId: firstStageId,
        iteration: 0,
        transitionCount: 0,
        loopIterations: {},
        loopNoProgress: {},
        loopStartedAt: {},
        loopProgressFingerprints: {},
        noProgress: 0,
        startedAt: now,
      };
  for (const loop of loopsOf(program)) {
    cursor.loopIterations[loop.id] ??= 0;
    cursor.loopNoProgress[loop.id] ??= 0;
    cursor.loopProgressFingerprints ??= {};
  }
  cursor.startedAt ||= now;
  cursor.transitionCount = Number.isFinite(cursor.transitionCount) ? Math.max(0, cursor.transitionCount) : 0;
  assertCursorStage(program, cursor);
  return cursor;
}

/** Mark a stage entry and apply the global/per-loop time and count guards. */
export function beginCapabilityStage(
  program: CapabilityProgram,
  cursor: CapabilityExecutionCursor,
  stageId: string,
  state: JsonObject,
  now = Date.now(),
) {
  const next = cloneCursor(cursor);
  stageOf(program, stageId);
  if (next.currentStageId && next.currentStageId !== stageId) {
    throw new CapabilityControlFlowError("capability_control_flow_cursor_mismatch", `${next.currentStageId}->${stageId}`);
  }
  assertCapabilityControlFlowBudget(program, next, now);
  next.currentStageId = stageId;
  next.iteration += 1;
  next.stageStartedAt = now;
  next.stageProgressFingerprint = capabilityProgressFingerprint(state);
  const loop = loopsOf(program).find((candidate) => candidate.entry === stageId);
  if (loop && (next.loopIterations[loop.id] || 0) === 0) {
    next.loopIterations[loop.id] = 1;
    next.loopStartedAt[loop.id] = now;
    next.loopNoProgress[loop.id] = 0;
    next.loopProgressFingerprints ??= {};
    next.loopProgressFingerprints[loop.id] = capabilityProgressFingerprint(state, loop.progressPaths);
  }
  for (const candidate of loopsOf(program)) {
    if (candidate.stageIds.includes(stageId)) assertLoopBudget(candidate, next, now);
  }
  return next;
}

/** Return the loop iteration associated with a stage for human/audit receipts. */
export function capabilityStageIteration(program: CapabilityProgram, cursor: CapabilityExecutionCursor, stageId: string) {
  const values = loopsOf(program)
    .filter((loop) => loop.stageIds.includes(stageId))
    .map((loop) => cursor.loopIterations[loop.id] || 0)
    .filter((value) => value > 0);
  return values.length ? Math.max(...values) : cursor.iteration;
}

function defaultNextStageId(program: CapabilityProgram, currentStageId: string) {
  const index = program.stages.findIndex((stage) => stage.id === currentStageId);
  if (index < 0) throw new CapabilityControlFlowError("capability_control_flow_stage_missing", currentStageId);
  return program.stages[index + 1]?.id;
}

/**
 * Resolve a stage result signal into the next graph node. A manifest without
 * transitions retains the original linear next-stage behavior.
 */
export function resolveCapabilityStageTransition(
  program: CapabilityProgram,
  cursor: CapabilityExecutionCursor,
  currentStageId: string,
  signal: string | undefined,
  state: JsonObject,
  now = Date.now(),
) {
  const current = stageOf(program, currentStageId);
  const next = cloneCursor(cursor);
  const branch = signal?.trim() || "next";
  let target: string | undefined;
  if (current.transitions) {
    target = current.transitions[branch];
    if (!target) throw new CapabilityControlFlowError("capability_control_flow_signal_unmapped", `${currentStageId}:${branch}`);
  } else {
    if (signal?.trim() && signal.trim() !== "next") {
      throw new CapabilityControlFlowError("capability_control_flow_signal_unexpected", `${currentStageId}:${signal}`);
    }
    target = defaultNextStageId(program, currentStageId);
  }
  if (target) stageOf(program, target);
  next.nextStageId = target;
  if (!target) {
    next.currentStageId = "";
    next.stageStartedAt = undefined;
    next.stageProgressFingerprint = undefined;
    return next;
  }

  next.transitionCount += 1;
  assertExecutionBudget(program, next, now);

  const reenteredLoops = loopsOf(program).filter((loop) =>
    loop.entry === target && loop.stageIds.includes(currentStageId));
  const currentStateFingerprint = capabilityProgressFingerprint(state);
  for (const loop of reenteredLoops) {
    const progressFingerprint = capabilityProgressFingerprint(state, loop.progressPaths);
    const previous = next.loopProgressFingerprints?.[loop.id];
    const noProgress = previous !== undefined && previous === progressFingerprint;
    next.loopIterations[loop.id] = (next.loopIterations[loop.id] || 0) + 1;
    next.loopNoProgress[loop.id] = noProgress ? (next.loopNoProgress[loop.id] || 0) + 1 : 0;
    next.noProgress = Math.max(next.noProgress, next.loopNoProgress[loop.id]);
    next.loopStartedAt[loop.id] ??= now;
    next.loopProgressFingerprints ??= {};
    next.loopProgressFingerprints[loop.id] = progressFingerprint;
    assertLoopBudget(loop, next, now);
  }
  next.progressFingerprint = currentStateFingerprint;
  next.currentStageId = target;
  next.stageStartedAt = undefined;
  next.stageProgressFingerprint = undefined;
  assertCapabilityControlFlowBudget(program, next, now);
  return next;
}
