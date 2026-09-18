import {
  DEFAULT_RUNNER_POOL_ID,
  type RunnerControlProjection,
  type RunnerControlSummary,
  type RunnerInstance,
  type RunnerLeaseRecord,
  type RunnerPlacementBinding,
  type RunnerPool,
  type RunnerProjectionMode,
  type RunnerProjectionScope,
  type RunnerPublicActiveLease,
  type RunnerPublicInstance,
  type RunnerQueueHealth,
  type RunnerWorkKind,
} from "./protocol";

const ALL_WORK_KINDS: RunnerWorkKind[] = ["execute", "author", "validate"];

export function runnerLeaseDisplayId(
  lease: Pick<RunnerLeaseRecord, "workload" | "runnerId" | "leasedAt">,
) {
  return `runner_attempt:${lease.workload.kind}:${lease.workload.id}:${lease.runnerId}:${lease.leasedAt}`;
}

export function projectPublicRunnerInstance(instance: RunnerInstance): RunnerPublicInstance {
  return {
    id: instance.id,
    ephemeral: instance.ephemeral,
    poolId: instance.poolId,
    generation: instance.generation,
    name: instance.name,
    version: instance.version,
    role: instance.role,
    desiredState: instance.desiredState,
    observedState: instance.observedState,
    workKinds: instance.workKinds,
    capabilities: instance.capabilities,
    activeLeaseCount: instance.activeLeaseCount,
    availableSlots: instance.availableSlots,
    lastHeartbeatAt: instance.lastHeartbeatAt,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    activity: instance.activity,
    lastError: instance.lastError,
  };
}

function publicActiveLease(lease: RunnerLeaseRecord): RunnerPublicActiveLease {
  return {
    displayId: runnerLeaseDisplayId(lease),
    poolId: lease.poolId,
    workload: lease.workload,
    workKind: lease.workKind,
    runnerId: lease.runnerId,
    status: lease.status,
    routing: lease.routing,
    leasedAt: lease.leasedAt,
    renewedAt: lease.renewedAt,
    expiresAt: lease.expiresAt,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt,
  };
}

export function runnerPoolFromState(
  instances: RunnerInstance[],
  activeLeases: RunnerLeaseRecord[],
  queueHealth: RunnerQueueHealth[] = [],
): RunnerPool {
  const maxConcurrency = instances.reduce((total, instance) => total + instance.capabilities.maxConcurrency, 0);
  const activeLeaseCount = activeLeases.length;
  const availableSlots = instances.reduce((total, instance) => total + instance.availableSlots, 0);
  const readyInstanceCount = instances.filter((instance) => ["idle", "partial"].includes(instance.observedState)).length;
  const drainingInstanceCount = instances.filter((instance) => instance.desiredState === "draining").length;
  const staleInstanceCount = instances.filter((instance) => ["stale", "offline"].includes(instance.observedState)).length;
  const queuedWorkCount = queueHealth.reduce((total, queue) => total + queue.queuedWorkCount, 0);
  const oldestQueuedAt = queueHealth.map((queue) => queue.oldestQueuedAt).filter((value): value is string => Boolean(value)).sort()[0];
  const serviceableInstances = instances.filter((instance) =>
    instance.desiredState === "active" && !["stale", "offline", "error"].includes(instance.observedState));
  const observedState: RunnerPool["observedState"] = instances.length === 0
    ? "empty"
    : serviceableInstances.length === 0
      ? "unavailable"
      : availableSlots > 0
      ? "healthy"
      : activeLeaseCount > 0
        ? "busy"
        : staleInstanceCount === instances.length
          ? "unavailable"
          : "degraded";
  return {
    id: DEFAULT_RUNNER_POOL_ID,
    name: "Default shared runners",
    desiredState: "active",
    observedState,
    instanceCount: instances.length,
    readyInstanceCount,
    drainingInstanceCount,
    staleInstanceCount,
    maxConcurrency,
    activeLeaseCount,
    availableSlots,
    queuedWorkCount,
    oldestQueuedAt,
    workKinds: ALL_WORK_KINDS,
  };
}

export function runnerSummaryFromState(
  instances: RunnerInstance[],
  bindings: RunnerPlacementBinding[],
  activeLeases: RunnerLeaseRecord[],
  queueHealth: RunnerQueueHealth[] = [],
): RunnerControlSummary {
  const queuedWorkCount = queueHealth.reduce((total, queue) => total + queue.queuedWorkCount, 0);
  return {
    serviceAvailable: instances.some((instance) => instance.desiredState === "active" && instance.availableSlots > 0),
    instanceCount: instances.length,
    readyInstanceCount: instances.filter((instance) => ["idle", "partial"].includes(instance.observedState)).length,
    busyInstanceCount: instances.filter((instance) => instance.observedState === "busy").length,
    drainingInstanceCount: instances.filter((instance) => instance.desiredState === "draining").length,
    staleInstanceCount: instances.filter((instance) => instance.observedState === "stale").length,
    offlineInstanceCount: instances.filter((instance) => instance.observedState === "offline").length,
    maxConcurrency: instances.reduce((total, instance) => total + instance.capabilities.maxConcurrency, 0),
    activeLeaseCount: activeLeases.length,
    availableSlots: instances.reduce((total, instance) => total + instance.availableSlots, 0),
    bindingCount: bindings.length,
    queuedWorkCount,
    oldestQueuedAt: queueHealth.map((queue) => queue.oldestQueuedAt).filter((value): value is string => Boolean(value)).sort()[0],
  };
}

export function projectRunnerControl(input: {
  mode: RunnerProjectionMode;
  generatedAt?: string;
  instances: RunnerInstance[];
  bindings: RunnerPlacementBinding[];
  leases: RunnerLeaseRecord[];
  queueHealth?: RunnerQueueHealth[];
  scope?: RunnerProjectionScope;
  platformPoolState?: {
    instances: RunnerInstance[];
    leases: RunnerLeaseRecord[];
    queueHealth?: RunnerQueueHealth[];
  };
}): RunnerControlProjection {
  const generatedAt = input.generatedAt || new Date().toISOString();
  if (input.mode === "hidden") return { mode: "hidden", generatedAt };
  const activeLeases = input.leases.filter((lease) => lease.status === "active" || lease.status === "completing");
  const queueHealth = input.queueHealth || ALL_WORK_KINDS.map((workKind) => ({ workKind, queuedWorkCount: 0 }));
  const pool = runnerPoolFromState(input.instances, activeLeases, queueHealth);
  const summary = runnerSummaryFromState(input.instances, input.bindings, activeLeases, queueHealth);
  if (input.mode === "aggregate") {
    const queuedWorkCount = summary.queuedWorkCount;
    const queueBand = queuedWorkCount === 0 ? "empty" : queuedWorkCount <= 2 ? "low" : queuedWorkCount <= 10 ? "medium" : "high";
    const serviceableInstances = input.instances.filter((instance) =>
      instance.desiredState === "active" && !["stale", "offline", "error"].includes(instance.observedState));
    const serviceableAvailableSlots = serviceableInstances.reduce((total, instance) => total + instance.availableSlots, 0);
    const serviceStatus = serviceableInstances.length === 0
      ? "unavailable"
      : serviceableAvailableSlots > 0
      ? "available"
      : summary.activeLeaseCount > 0 && queuedWorkCount === 0
        ? "busy"
        : summary.activeLeaseCount > 0 || queuedWorkCount > 0
          ? "congested"
          : "unavailable";
    return { mode: "aggregate", generatedAt, serviceStatus, queueBand };
  }
  const platformPool = input.platformPoolState
    ? runnerPoolFromState(
      input.platformPoolState.instances,
      input.platformPoolState.leases.filter((lease) => lease.status === "active" || lease.status === "completing"),
      input.platformPoolState.queueHealth,
    )
    : undefined;
  return {
    mode: "full",
    generatedAt,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(platformPool ? { platformPool } : {}),
    pool,
    summary,
    instances: input.instances.map(projectPublicRunnerInstance),
    bindings: input.bindings,
    activeLeases: activeLeases.map(publicActiveLease),
    queueHealth,
  };
}
