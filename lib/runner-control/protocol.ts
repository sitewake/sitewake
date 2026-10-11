export const DEFAULT_RUNNER_POOL_ID = "default";

export type RunnerWorkKind = "execute" | "author" | "validate";
export type RunnerRole = "any" | "interactive" | "background" | "author" | "validate";
export type RunnerDesiredState = "active" | "draining";
export type RunnerObservedState =
  | "starting"
  | "idle"
  | "partial"
  | "busy"
  | "stale"
  | "offline"
  | "error";
export type RunnerProjectionMode = "full" | "aggregate" | "hidden";

export type RunnerActivity = {
  stage?: string;
  phase?: string;
  message?: string;
  learningJobId?: string;
  artifactIds?: string[];
  tokenUsage?: { input: number; output: number; cached?: number };
};

export type RunnerLastError = {
  code?: string;
  message: string;
  at: string;
  phase?: string;
};

export type RunnerCapabilities = {
  browsers: string[];
  maxConcurrency: number;
  recording: boolean;
  prewarmCapacity: number;
  readySlots: number;
};

export type RunnerInstance = {
  id: string;
  ephemeral: boolean;
  poolId: typeof DEFAULT_RUNNER_POOL_ID;
  sessionId: string;
  generation: number;
  name: string;
  version?: string;
  role: RunnerRole;
  desiredState: RunnerDesiredState;
  observedState: RunnerObservedState;
  workKinds: RunnerWorkKind[];
  capabilities: RunnerCapabilities;
  activeLeaseCount: number;
  availableSlots: number;
  lastHeartbeatAt: string;
  heartbeatExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  activity?: RunnerActivity;
  lastError?: RunnerLastError;
};

export type RunnerPublicInstance = Pick<
  RunnerInstance,
  | "id"
  | "ephemeral"
  | "poolId"
  | "generation"
  | "name"
  | "version"
  | "role"
  | "desiredState"
  | "observedState"
  | "workKinds"
  | "capabilities"
  | "activeLeaseCount"
  | "availableSlots"
  | "lastHeartbeatAt"
  | "createdAt"
  | "updatedAt"
  | "activity"
  | "lastError"
>;

export type RunnerPlacementBinding = {
  id: string;
  poolId: typeof DEFAULT_RUNNER_POOL_ID;
  siteAgentId: string;
  workKind: RunnerWorkKind;
  target:
    | { kind: "runner"; runnerId: string }
    | { kind: "pool"; poolId: typeof DEFAULT_RUNNER_POOL_ID };
  exclusive: true;
  createdAt: string;
  updatedAt: string;
};

export type RunnerWorkloadKind = "capability-run" | "capability-task" | "learning-job" | "validation-job";

export type RunnerLeaseWorkload = {
  kind: RunnerWorkloadKind;
  id: string;
  siteAgentId: string;
};

export type RunnerLeaseStatus =
  | "active"
  | "completing"
  | "completed"
  | "failed"
  | "released"
  | "expired";

export type RunnerLeaseCompletion = {
  status: Extract<RunnerLeaseStatus, "completed" | "failed" | "released">;
  result?: unknown;
  completedAt: string;
};

export type RunnerLeaseRecord = {
  id: string;
  poolId: typeof DEFAULT_RUNNER_POOL_ID;
  workload: RunnerLeaseWorkload;
  workKind: RunnerWorkKind;
  runnerId: string;
  runnerSessionId: string;
  status: RunnerLeaseStatus;
  fence: number;
  slot: number;
  activeWorkKey?: string;
  activeSlotKey?: string;
  completionLockExpiresAt?: string;
  routing: "default" | "explicit-binding";
  leasedAt: string;
  renewedAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  completion?: RunnerLeaseCompletion;
};

export type RunnerPublicActiveLease = Pick<
  RunnerLeaseRecord,
  | "poolId"
  | "workload"
  | "workKind"
  | "runnerId"
  | "status"
  | "routing"
  | "leasedAt"
  | "renewedAt"
  | "expiresAt"
  | "createdAt"
  | "updatedAt"
> & {
  /** Public display identity derived without exposing the control lease ID. */
  displayId: string;
};

export type RunnerLeaseGrant<TWork = unknown> = {
  lease: RunnerLeaseRecord;
  token: string;
  work: TWork;
};

export type RunnerPool = {
  id: typeof DEFAULT_RUNNER_POOL_ID;
  name: string;
  desiredState: "active";
  observedState: "healthy" | "busy" | "degraded" | "unavailable" | "empty";
  instanceCount: number;
  readyInstanceCount: number;
  drainingInstanceCount: number;
  staleInstanceCount: number;
  maxConcurrency: number;
  activeLeaseCount: number;
  availableSlots: number;
  queuedWorkCount: number;
  oldestQueuedAt?: string;
  workKinds: RunnerWorkKind[];
};

export type RunnerQueueHealth = {
  workKind: RunnerWorkKind;
  queuedWorkCount: number;
  oldestQueuedAt?: string;
};

export type RunnerControlSummary = {
  serviceAvailable: boolean;
  instanceCount: number;
  readyInstanceCount: number;
  busyInstanceCount: number;
  drainingInstanceCount: number;
  staleInstanceCount: number;
  offlineInstanceCount: number;
  maxConcurrency: number;
  activeLeaseCount: number;
  availableSlots: number;
  bindingCount: number;
  queuedWorkCount: number;
  oldestQueuedAt?: string;
};

export type RunnerProjectionScope =
  | { kind: "global" }
  | { kind: "site"; siteAgentId: string };

export type RunnerFullProjection = {
  mode: "full";
  generatedAt: string;
  /** Site scope applies to pool, summary, instances, bindings, leases, and queue health. */
  scope?: RunnerProjectionScope;
  /** Actual organization-wide pool capacity; instance availability in site scope is site-accounted. */
  platformPool?: RunnerPool;
  pool: RunnerPool;
  summary: RunnerControlSummary;
  instances: RunnerPublicInstance[];
  bindings: RunnerPlacementBinding[];
  activeLeases: RunnerPublicActiveLease[];
  queueHealth: RunnerQueueHealth[];
};

export type RunnerAggregateProjection = {
  mode: "aggregate";
  generatedAt: string;
  serviceStatus: "available" | "busy" | "congested" | "unavailable";
  queueBand: "empty" | "low" | "medium" | "high";
};

export type RunnerHiddenProjection = {
  mode: "hidden";
  generatedAt: string;
};

export type RunnerControlProjection =
  | RunnerFullProjection
  | RunnerAggregateProjection
  | RunnerHiddenProjection;

export type RunnerTaskStatus = "queued" | "active" | "completing" | "terminal";

export type RunnerTaskBrowserRunProjection = {
  id: string;
  mode: "author" | "validate" | "execute" | "debug";
  status: "running" | "passed" | "failed";
  startedAt: string;
  endedAt?: string;
};

export type RunnerTaskFailureProjection = {
  code?: string;
  message: string;
};

export type RunnerTaskAttemptProjection = {
  displayId: string;
  runnerId: string;
  status: Exclude<RunnerTaskStatus, "queued">;
  terminalStatus?: Extract<RunnerLeaseStatus, "completed" | "failed" | "released" | "expired">;
  leasedAt: string;
  renewedAt: string;
  expiresAt: string;
  completedAt?: string;
  browserRuns: RunnerTaskBrowserRunProjection[];
  failure?: RunnerTaskFailureProjection;
};

export type RunnerTaskProjection = {
  id: string;
  workload: RunnerLeaseWorkload;
  siteAgentId: string;
  workKind: RunnerWorkKind;
  status: RunnerTaskStatus;
  terminalStatus?: Extract<RunnerLeaseStatus, "completed" | "failed" | "released" | "expired">;
  runnerId?: string;
  createdAt: string;
  updatedAt: string;
  leasedAt?: string;
  renewedAt?: string;
  expiresAt?: string;
  completedAt?: string;
  attempts: RunnerTaskAttemptProjection[];
  failure?: RunnerTaskFailureProjection;
};

export interface RunnerVisibilityProvider {
  projectionMode(context: { siteAgentId?: string }): RunnerProjectionMode | undefined;
}

export type RegisterRunnerInstanceInput = {
  id?: string;
  name?: string;
  version?: string;
  role?: RunnerRole | "mixed";
  workKinds?: RunnerWorkKind[];
  browsers?: string[];
  maxConcurrency?: number;
  recording?: boolean;
  prewarmCapacity?: number;
  readySlots?: number;
};

export type RegisterRunnerInstanceResult = {
  instance: RunnerInstance;
  sessionToken: string;
  persistence: "memory" | "d1";
};

export type HeartbeatRunnerInstanceInput = {
  sessionId?: string;
  sessionToken?: string;
  legacy?: boolean;
  activity?: RunnerActivity | null;
  lastError?: Omit<RunnerLastError, "at">;
  readySlots?: number;
};

export type HeartbeatRunnerInstanceResult = {
  instance: RunnerInstance;
  desiredState: RunnerDesiredState;
  heartbeatIntervalMs: number;
  persistence: "memory" | "d1";
};

export type ClaimRunnerLeaseInput<TWork = unknown> = {
  runnerId: string;
  runnerSessionId?: string;
  sessionToken?: string;
  legacy?: boolean;
  workload: RunnerLeaseWorkload;
  workKind: RunnerWorkKind;
  work: TWork;
  ttlMs?: number;
};

export type RenewRunnerLeaseInput = {
  runnerId: string;
  runnerSessionId?: string;
  sessionToken?: string;
  legacy?: boolean;
  leaseId: string;
  token: string;
  fence: number;
  ttlMs?: number;
};

export type CompleteRunnerLeaseInput = {
  runnerId: string;
  runnerSessionId?: string;
  sessionToken?: string;
  legacy?: boolean;
  leaseId: string;
  token: string;
  fence: number;
  status: Extract<RunnerLeaseStatus, "completed" | "failed" | "released">;
  result?: unknown;
};

export type BeginRunnerLeaseCompletionResult = {
  lease: RunnerLeaseRecord;
  duplicate: boolean;
  inProgress: boolean;
  resumed?: boolean;
  retryAfterMs?: number;
  persistence: "memory" | "d1";
};
