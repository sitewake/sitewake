"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RunnerControlProjection,
  RunnerDesiredState,
  RunnerFullProjection,
  RunnerPublicActiveLease,
  RunnerPublicInstance,
  RunnerProjectionMode,
  RunnerTaskProjection,
  RunnerTaskStatus,
  RunnerWorkKind,
} from "../lib/runner-control/protocol";
import {
  browserModeLabel,
  durationSince,
  relativeTime,
  roleLabel,
  stateLabel,
  stateTone,
  workKindLabel,
} from "./console/runner-vocabulary";
import { t } from "../lib/i18n";

export type RunnerManagementMode = RunnerProjectionMode;
export type RunnerServiceSummary = RunnerControlProjection;

type RunnerCapacity = {
  instances?: number;
  onlineInstances?: number;
  readyInstances?: number;
  busyInstances?: number;
  maxConcurrency?: number;
  active?: number;
  available?: number;
  readySlots?: number;
  prewarmCapacity?: number;
};

type RunnerPoolView = {
  id: string;
  name: string;
  desiredState?: RunnerDesiredState;
  observedState?:
    | "healthy"
    | "busy"
    | "degraded"
    | "unavailable"
    | "empty";
  status?: string;
  workKinds?: RunnerWorkKind[];
  capacity?: RunnerCapacity;
  queued?: number;
  oldestQueuedAt?: string;
  message?: string;
};

type RunnerSummaryView = {
  state?: string;
  status?: string;
  message?: string;
  onlineInstances?: number;
  readyInstances?: number;
  busyInstances?: number;
  totalInstances?: number;
  activeLeases?: number;
  queued?: number;
  queuedWork?: number;
  maxConcurrency?: number;
  available?: number;
  readySlots?: number;
  prewarmCapacity?: number;
  oldestQueuedAt?: string;
  updatedAt?: string;
};

type RunnerInstanceView = {
  id: string;
  name: string;
  version?: string;
  poolId?: string;
  desiredState?: RunnerDesiredState;
  observedState?: RunnerPublicInstance["observedState"];
  status?: string;
  workKinds?: RunnerWorkKind[];
  role?: string;
  lastHeartbeatAt?: string;
  createdAt?: string;
  capabilities?: {
    browsers?: string[];
    maxConcurrency?: number;
    recording?: boolean;
    prewarmCapacity?: number;
    readySlots?: number;
  };
  activeLeaseCount?: number;
  lastError?: RunnerPublicInstance["lastError"];
  activity?: {
    phase?: string;
    message?: string;
    learningJobId?: string;
    updatedAt?: string;
  };
};

type RunnerBindingView = {
  id?: string;
  runnerId: string;
  siteAgentId: string;
  workKind: RunnerWorkKind;
  createdAt?: string;
};

type RunnerTaskView = {
  id?: string;
  leaseId?: string;
  runnerId?: string;
  siteAgentId?: string;
  workKind?: RunnerWorkKind;
  status?: string;
  lifecycleStatus?: RunnerTaskStatus;
  taskId?: string;
  capabilityId?: string;
  title?: string;
  goal?: string;
  createdAt?: string;
  updatedAt?: string;
  leasedAt?: string;
  startedAt?: string;
  expiresAt?: string;
  completedAt?: string;
  attempts?: RunnerTaskProjection["attempts"];
  progress?: {
    stage?: string;
    message?: string;
    current?: number;
    total?: number;
    updatedAt?: string;
  };
  failure?: RunnerTaskProjection["failure"];
};

type RunnerControlPayload = RunnerControlProjection;

type SiteOption = { id: string; name: string };
type FullSection = "pool" | "instances" | "tasks";
type TaskFilters = {
  status: "" | RunnerTaskStatus;
  siteAgentId: string;
  runnerId: string;
  workKind: "" | RunnerWorkKind;
};

const TASK_PAGE_SIZE = 20;

export function normalizeRunnerMode(value: unknown): RunnerManagementMode {
  if (value === "hidden") return "hidden";
  if (value === "aggregate" || value === "service-health" || value === "pool-summary")
    return "aggregate";
  return "full";
}

function numberValue(...values: unknown[]) {
  const value = values.find(
    (item) => typeof item === "number" && Number.isFinite(item),
  );
  return typeof value === "number" ? value : 0;
}

function leaseDuration(lease: RunnerTaskView) {
  const started = Date.parse(
    lease.startedAt || lease.leasedAt || lease.createdAt || "",
  );
  const ended = Date.parse(lease.completedAt || "");
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(ended) ||
    ended < started
  )
    return durationSince(lease.startedAt || lease.leasedAt || lease.createdAt);
  // Same shape as durationSince's tail, over a closed interval rather than "until now".
  const copy = t().runner.time;
  const seconds = Math.floor((ended - started) / 1000);
  if (seconds < 60) return copy.seconds(seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return copy.minutes(minutes);
  return copy.hoursMinutes(Math.floor(minutes / 60), minutes % 60);
}

function serviceState(
  summary?: RunnerSummaryView,
  pool?: RunnerPoolView,
) {
  return summary?.state || summary?.status || pool?.observedState || pool?.status;
}

function modeOfPayload(
  payload: RunnerControlPayload | undefined,
  fallback: RunnerManagementMode,
) {
  return payload ? normalizeRunnerMode(payload.mode) : fallback;
}

function poolCapacity(
  pool: RunnerPoolView | undefined,
  summary: RunnerSummaryView | undefined,
  instances: RunnerInstanceView[],
) {
  const capacity = pool?.capacity;
  const totalInstances = numberValue(
    summary?.totalInstances,
    capacity?.instances,
    instances.length,
  );
  const onlineInstances = numberValue(
    summary?.onlineInstances,
    capacity?.onlineInstances,
    instances.filter(
      (item) => !["offline", "stale"].includes(item.observedState || ""),
    ).length,
  );
  const active = numberValue(
    summary?.activeLeases,
    capacity?.active,
    instances.reduce(
      (sum, item) => sum + numberValue(item.activeLeaseCount),
      0,
    ),
  );
  const maximum = numberValue(
    summary?.maxConcurrency,
    capacity?.maxConcurrency,
    instances.reduce(
      (sum, item) =>
        sum + numberValue(item.capabilities?.maxConcurrency),
      0,
    ),
  );
  const available = numberValue(
    summary?.available,
    capacity?.available,
    Math.max(0, maximum - active),
  );
  const readySlots = numberValue(
    summary?.readySlots,
    capacity?.readySlots,
    instances.reduce(
      (sum, item) => sum + numberValue(item.capabilities?.readySlots),
      0,
    ),
  );
  const prewarmCapacity = numberValue(
    summary?.prewarmCapacity,
    capacity?.prewarmCapacity,
    instances.reduce(
      (sum, item) =>
        sum + numberValue(item.capabilities?.prewarmCapacity),
      0,
    ),
  );
  const queued = numberValue(
    summary?.queued,
    summary?.queuedWork,
    pool?.queued,
  );
  return {
    totalInstances,
    onlineInstances,
    active,
    maximum,
    available,
    readySlots,
    prewarmCapacity,
    queued,
  };
}

function parseResponse(value: unknown): RunnerControlPayload {
  if (!value || typeof value !== "object")
    throw new Error("runner_control_invalid_response");
  const payload = value as Partial<RunnerControlProjection>;
  const mode = normalizeRunnerMode(payload.mode);
  const generatedAt =
    typeof payload.generatedAt === "string"
      ? payload.generatedAt
      : new Date().toISOString();
  if (mode === "hidden") return { mode, generatedAt };
  if (mode === "aggregate") {
    const aggregate = value as Partial<
      Extract<RunnerControlProjection, { mode: "aggregate" }>
    >;
    return {
      mode,
      generatedAt,
      serviceStatus: aggregate.serviceStatus || "unavailable",
      queueBand: aggregate.queueBand || "empty",
    };
  }
  const full = value as Partial<RunnerFullProjection>;
  if (!full.pool || !full.summary)
    throw new Error("runner_control_full_projection_invalid");
  return {
    mode: "full",
    generatedAt,
    scope: full.scope,
    platformPool: full.platformPool,
    pool: full.pool,
    summary: full.summary,
    instances: Array.isArray(full.instances) ? full.instances : [],
    bindings: Array.isArray(full.bindings) ? full.bindings : [],
    activeLeases: Array.isArray(full.activeLeases)
      ? full.activeLeases
      : [],
    queueHealth: Array.isArray(full.queueHealth) ? full.queueHealth : [],
  };
}

function fullProjectionView(payload?: RunnerFullProjection) {
  if (!payload)
    return {
      pool: undefined,
      platformPool: undefined,
      summary: undefined,
      instances: [] as RunnerInstanceView[],
      bindings: [] as RunnerBindingView[],
      activeLeases: [] as RunnerTaskView[],
      queueHealth: [] as RunnerFullProjection["queueHealth"],
    };
  const instances: RunnerInstanceView[] = payload.instances.map((instance) => ({
    id: instance.id,
    name: instance.name,
    version: instance.version,
    poolId: instance.poolId,
    role: instance.role,
    desiredState: instance.desiredState,
    observedState: instance.observedState,
    workKinds: instance.workKinds,
    lastHeartbeatAt: instance.lastHeartbeatAt,
    createdAt: instance.createdAt,
    capabilities: instance.capabilities,
    activeLeaseCount: instance.activeLeaseCount,
    lastError: instance.lastError,
    activity: instance.activity,
  }));
  const pool: RunnerPoolView = {
    id: payload.pool.id,
    name: payload.pool.name,
    desiredState: payload.pool.desiredState,
    observedState: payload.pool.observedState,
    workKinds: payload.pool.workKinds,
    queued: payload.pool.queuedWorkCount,
    oldestQueuedAt: payload.pool.oldestQueuedAt,
    capacity: {
      instances: payload.pool.instanceCount,
      onlineInstances:
        payload.summary.instanceCount - payload.summary.offlineInstanceCount,
      readyInstances: payload.pool.readyInstanceCount,
      maxConcurrency: payload.pool.maxConcurrency,
      active: payload.pool.activeLeaseCount,
      available: payload.pool.availableSlots,
    },
  };
  const platformPool: RunnerPoolView | undefined = payload.platformPool
    ? {
        id: payload.platformPool.id,
        name: payload.platformPool.name,
        desiredState: payload.platformPool.desiredState,
        observedState: payload.platformPool.observedState,
        workKinds: payload.platformPool.workKinds,
        queued: payload.platformPool.queuedWorkCount,
        oldestQueuedAt: payload.platformPool.oldestQueuedAt,
        capacity: {
          instances: payload.platformPool.instanceCount,
          onlineInstances:
            payload.platformPool.instanceCount -
            payload.platformPool.staleInstanceCount,
          readyInstances: payload.platformPool.readyInstanceCount,
          maxConcurrency: payload.platformPool.maxConcurrency,
          active: payload.platformPool.activeLeaseCount,
          available: payload.platformPool.availableSlots,
        },
      }
    : undefined;
  const summary: RunnerSummaryView = {
    state: payload.pool.observedState,
    onlineInstances:
      payload.summary.instanceCount - payload.summary.offlineInstanceCount,
    readyInstances: payload.summary.readyInstanceCount,
    busyInstances: payload.summary.busyInstanceCount,
    totalInstances: payload.summary.instanceCount,
    activeLeases: payload.summary.activeLeaseCount,
    queued: payload.summary.queuedWorkCount,
    oldestQueuedAt: payload.summary.oldestQueuedAt,
    maxConcurrency: payload.summary.maxConcurrency,
    available: payload.summary.availableSlots,
    message: payload.summary.serviceAvailable
      ? t().runner.health.defaultPool
      : t().runner.health.noPool,
  };
  const bindings: RunnerBindingView[] = payload.bindings.flatMap((binding) =>
    binding.target.kind === "runner"
      ? [
          {
            id: binding.id,
            runnerId: binding.target.runnerId,
            siteAgentId: binding.siteAgentId,
            workKind: binding.workKind,
            createdAt: binding.createdAt,
          },
        ]
      : [],
  );
  const activeLeases = payload.activeLeases.map(leaseView);
  return {
    pool,
    platformPool,
    summary,
    instances,
    bindings,
    activeLeases,
    queueHealth: payload.queueHealth,
  };
}

function leaseView(lease: RunnerPublicActiveLease): RunnerTaskView {
  const lifecycleStatus =
    lease.status === "active" || lease.status === "completing"
      ? lease.status
      : "terminal";
  return {
    id: lease.displayId,
    leaseId: lease.displayId,
    runnerId: lease.runnerId,
    siteAgentId: lease.workload.siteAgentId,
    workKind: lease.workKind,
    status: lease.status,
    lifecycleStatus,
    taskId: lease.workload.id,
    title: `${workKindLabel(lease.workKind)} · ${shortId(lease.workload.id)}`,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt,
    leasedAt: lease.leasedAt,
    startedAt: lease.leasedAt,
    expiresAt: lease.expiresAt,
    attempts: [
      {
        displayId: lease.displayId,
        runnerId: lease.runnerId,
        status: lifecycleStatus,
        terminalStatus:
          lifecycleStatus === "terminal"
            ? (lease.status as "completed" | "failed" | "released" | "expired")
            : undefined,
        leasedAt: lease.leasedAt,
        renewedAt: lease.renewedAt,
        expiresAt: lease.expiresAt,
        browserRuns: [],
      },
    ],
  };
}

function taskView(task: RunnerTaskProjection): RunnerTaskView {
  const displayStatus =
    task.status === "terminal"
      ? task.terminalStatus || "terminal"
      : task.status;
  return {
    id: task.id,
    leaseId: task.attempts.at(-1)?.displayId,
    runnerId: task.runnerId,
    siteAgentId: task.siteAgentId,
    workKind: task.workKind,
    status: displayStatus,
    lifecycleStatus: task.status,
    taskId: task.workload.id,
    title: `${workKindLabel(task.workKind)} · ${shortId(task.workload.id)}`,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    leasedAt: task.leasedAt,
    startedAt: task.leasedAt,
    expiresAt: task.expiresAt,
    completedAt: task.completedAt,
    failure: task.failure,
    attempts: task.attempts,
  };
}

function taskFailureMessage(task: RunnerTaskView) {
  if (!task.failure) return undefined;
  const copy = t().runner.task;
  if (task.failure.code === "capability_module_required") {
    return copy.failureModuleRequired;
  }
  return task.failure.message || copy.failureGeneric;
}

function siteName(sites: SiteOption[], siteAgentId?: string) {
  if (!siteAgentId) return t().runner.task.globalTask;
  return (
    sites.find((item) => item.id === siteAgentId)?.name || siteAgentId
  );
}

function shortId(value?: string) {
  if (!value) return "—";
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value;
}

function taskViewId(task: RunnerTaskView) {
  return (
    task.id ||
    `${task.runnerId || "queue"}:${task.taskId || "unknown"}`
  );
}

function attemptDisplayStatus(
  attempt: RunnerTaskProjection["attempts"][number],
) {
  return attempt.status === "terminal"
    ? attempt.terminalStatus || "terminal"
    : attempt.status;
}

function taskForRunner(task: RunnerTaskView, runnerId: string) {
  const attempt = task.attempts
    ?.filter((item) => item.runnerId === runnerId)
    .at(-1);
  if (!attempt) return task;
  return {
    ...task,
    leaseId: attempt.displayId,
    runnerId,
    status: attemptDisplayStatus(attempt),
    lifecycleStatus: attempt.status,
    leasedAt: attempt.leasedAt,
    startedAt: attempt.leasedAt,
    expiresAt: attempt.expiresAt,
    completedAt: attempt.completedAt,
  } satisfies RunnerTaskView;
}

export function RunnerServiceHealth({
  service,
  onOpen,
}: {
  service?: RunnerControlPayload;
  onOpen(): void;
}) {
  if (service?.mode === "hidden") return null;
  const view = fullProjectionView(
    service?.mode === "full" ? service : undefined,
  );
  const summary = view.summary;
  const pool = view.pool;
  const instances = view.instances;
  const capacity = poolCapacity(pool, summary, instances);
  const state =
    service?.mode === "aggregate"
      ? service.serviceStatus
      : serviceState(summary, pool);
  const waiting = !service;
  const aggregate = service?.mode === "aggregate";
  const copy = t().runner.health;
  const bands = t().runner.queueBand;
  return (
    <section
      className={`rm-service-health ${stateTone(state)} ${waiting ? "loading" : ""}`}
      aria-live="polite"
    >
      <span className="rm-status-orb" aria-hidden="true">
        <i />
      </span>
      <div className="rm-service-copy">
        <small>{copy.eyebrow}</small>
        <h3>
          {waiting
            ? copy.loading
            : stateLabel(state || (capacity.onlineInstances ? "healthy" : "unavailable"))}
        </h3>
        <p>
          {aggregate
            ? copy.aggregateMessage(stateLabel(service.serviceStatus), bands[service.queueBand])
            : summary?.message ||
              pool?.message ||
              (capacity.onlineInstances
                ? copy.instancesMessage(capacity.onlineInstances, capacity.active)
                : copy.noInstances)}
        </p>
      </div>
      <dl>
        <div>
          <dt>{aggregate ? copy.service : copy.onlineInstances}</dt>
          <dd>
            {waiting
              ? "—"
              : aggregate
                ? stateLabel(service.serviceStatus)
                : capacity.onlineInstances}
          </dd>
        </div>
        <div>
          <dt>{aggregate ? copy.queueBandLabel : copy.runningOverCapacity}</dt>
          <dd>
            {waiting
              ? "—"
              : aggregate
                ? bands[service.queueBand]
                : `${capacity.active} / ${capacity.maximum}`}
          </dd>
        </div>
        {!aggregate && (
          <div>
            <dt>{copy.waiting}</dt>
            <dd>{waiting ? "—" : capacity.queued}</dd>
          </div>
        )}
      </dl>
      <button type="button" onClick={onOpen}>
        {copy.open} <span>↗</span>
      </button>
    </section>
  );
}

export function RunnerManagement({
  mode = "full",
  siteAgentId = "",
  siteAgentIdFilter = "",
  sites,
  onModeChange,
  onOpenSite,
  onSiteAgentFilterChange,
}: {
  mode?: RunnerManagementMode;
  siteAgentId?: string;
  siteAgentIdFilter?: string;
  sites: SiteOption[];
  onModeChange?(mode: RunnerManagementMode): void;
  onOpenSite?(siteAgentId: string, capabilityId?: string): void;
  onSiteAgentFilterChange?(siteAgentId: string): void;
}) {
  const [payload, setPayload] = useState<RunnerControlPayload>();
  const [loading, setLoading] = useState(mode !== "hidden");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [lastSuccessfulAt, setLastSuccessfulAt] = useState("");
  const [section, setSection] = useState<FullSection>("pool");
  const [selectedInstanceId, setSelectedInstanceId] = useState("");
  const [selectedLeaseId, setSelectedLeaseId] = useState("");
  const [taskRecords, setTaskRecords] = useState<RunnerTaskProjection[]>([]);
  const [tasksResolved, setTasksResolved] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskPage, setTaskPage] = useState(1);
  const [taskTotal, setTaskTotal] = useState(0);
  const [taskFilters, setTaskFilters] = useState<TaskFilters>({
    status: "",
    siteAgentId: siteAgentId || siteAgentIdFilter,
    runnerId: "",
    workKind: "",
  });
  const [busyAction, setBusyAction] = useState("");
  const [notice, setNotice] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [bindingSiteId, setBindingSiteId] = useState(siteAgentId);
  const [bindingWorkKind, setBindingWorkKind] =
    useState<RunnerWorkKind>("execute");
  const guideButtonRef = useRef<HTMLButtonElement>(null);
  const guideCloseRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async (quiet = false) => {
    if (mode === "hidden") return;
    if (!quiet) setRefreshing(true);
    try {
      const overviewParams = new URLSearchParams();
      if (taskFilters.siteAgentId)
        overviewParams.set("siteAgentId", taskFilters.siteAgentId);
      const response = await fetch(
        `/api/runner-management/overview${
          overviewParams.size ? `?${overviewParams.toString()}` : ""
        }`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`runner_control_${response.status}`);
      const next = parseResponse(await response.json());
      setPayload(next);
      setError("");
      setLastSuccessfulAt(next.generatedAt || new Date().toISOString());
      onModeChange?.(next.mode);
      if (next.mode === "full") {
        setTasksLoading(true);
        try {
          const params = new URLSearchParams({
            page: String(taskPage),
            pageSize: String(TASK_PAGE_SIZE),
          });
          if (taskFilters.status) params.set("status", taskFilters.status);
          if (taskFilters.siteAgentId)
            params.set("siteAgentId", taskFilters.siteAgentId);
          if (taskFilters.runnerId)
            params.set("runnerId", taskFilters.runnerId);
          if (taskFilters.workKind)
            params.set("workKind", taskFilters.workKind);
          const taskResponse = await fetch(
            `/api/runner-management/tasks?${params.toString()}`,
            { cache: "no-store" },
          );
          if (!taskResponse.ok)
            throw new Error(`runner_tasks_${taskResponse.status}`);
          const taskPayload = (await taskResponse.json()) as {
            tasks?: RunnerTaskProjection[];
            page?: number;
            pageSize?: number;
            total?: number;
          };
          setTaskRecords(
            Array.isArray(taskPayload.tasks) ? taskPayload.tasks : [],
          );
          setTasksResolved(true);
          setTaskTotal(
            typeof taskPayload.total === "number"
              ? taskPayload.total
              : taskPayload.tasks?.length || 0,
          );
          setTaskError("");
        } catch (taskReason) {
          setTaskError(
            taskReason instanceof Error
              ? taskReason.message
              : "runner_tasks_failed",
          );
        } finally {
          setTasksLoading(false);
        }
      } else {
        setTaskRecords([]);
        setTasksResolved(false);
        setTaskTotal(0);
        setTaskError("");
        setTasksLoading(false);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "runner_control_failed");
    } finally {
      setLoading(false);
      if (!quiet) setRefreshing(false);
    }
  }, [mode, onModeChange, taskFilters, taskPage]);

  useEffect(() => {
    if (mode === "hidden") return;
    const initial = window.setTimeout(() => void load(true), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 5_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    window.addEventListener("focus", onVisibility);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener("focus", onVisibility);
    };
  }, [load, mode]);

  useEffect(() => {
    if (!guideOpen) return;
    guideCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setGuideOpen(false);
      guideButtonRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [guideOpen]);

  const effectiveMode = modeOfPayload(payload, mode);
  const fullPayload = payload?.mode === "full" ? payload : undefined;
  const view = fullProjectionView(fullPayload);
  if (effectiveMode === "hidden") return null;

  const {
    pool,
    platformPool,
    summary,
    instances,
    bindings,
    activeLeases,
    queueHealth,
  } = view;
  const projectedTasks = taskRecords.map(taskView);
  const tasks = tasksResolved
    ? projectedTasks
    : taskError &&
        taskPage === 1 &&
        !Object.values(taskFilters).some(Boolean)
      ? activeLeases
      : [];
  const capacity = poolCapacity(pool, summary, instances);
  const organizationCapacity = platformPool
    ? poolCapacity(platformPool, undefined, [])
    : undefined;
  const state =
    payload?.mode === "aggregate"
      ? payload.serviceStatus
      : serviceState(summary, pool);
  const selectedInstance =
    instances.find((item) => item.id === selectedInstanceId) || instances[0];
  const selectedInstanceRecentTasks = selectedInstance
    ? projectedTasks
        .filter(
          (item) =>
            item.runnerId === selectedInstance.id ||
            item.attempts?.some(
              (attempt) => attempt.runnerId === selectedInstance.id,
            ),
        )
        .map((item) => taskForRunner(item, selectedInstance.id))
        .filter(
          (item) =>
            !["active", "completing"].includes(item.lifecycleStatus || ""),
        )
        .slice(0, 5)
    : [];
  const selectedLease =
    tasks.find((item) => taskViewId(item) === selectedLeaseId) || tasks[0];

  function applyTaskFilters(next: TaskFilters) {
    const scopedNext = siteAgentId
      ? { ...next, siteAgentId }
      : next;
    if (!siteAgentId && scopedNext.siteAgentId !== taskFilters.siteAgentId)
      onSiteAgentFilterChange?.(scopedNext.siteAgentId);
    setTaskFilters(scopedNext);
    setTaskPage(1);
    setTaskRecords([]);
    setTasksResolved(false);
    setTaskTotal(0);
    setTaskError("");
    setSelectedLeaseId("");
  }

  const copy = t().runner;

  async function mutate(
    key: string,
    url: string,
    init: RequestInit,
    success: string,
  ) {
    setBusyAction(key);
    setNotice("");
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "content-type": "application/json", ...(init.headers || {}) },
      });
      if (!response.ok) throw new Error(`runner_action_${response.status}`);
      setNotice(success);
      await load(true);
    } catch {
      setNotice(copy.error.actionFailed);
    } finally {
      setBusyAction("");
    }
  }

  async function updateDesiredState(
    instance: RunnerInstanceView,
    desiredState: "active" | "draining",
  ) {
    if (
      siteAgentId &&
      !window.confirm(
        desiredState === "draining"
          ? copy.action.confirmDrain(instance.name)
          : copy.action.confirmResume(instance.name),
      )
    ) return;
    await mutate(
      `state:${instance.id}`,
      `/api/runner-management/runners/${encodeURIComponent(instance.id)}`,
      { method: "PATCH", body: JSON.stringify({ desiredState }) },
      desiredState === "draining"
        ? copy.action.drained(instance.name)
        : copy.action.resumed(instance.name),
    );
  }

  async function createBinding() {
    if (!selectedInstance || !bindingSiteId) return;
    await mutate(
      `bind:${selectedInstance.id}:${bindingSiteId}:${bindingWorkKind}`,
      `/api/runner-management/runners/${encodeURIComponent(selectedInstance.id)}/bindings/${encodeURIComponent(bindingSiteId)}`,
      {
        method: "PUT",
        body: JSON.stringify({ workKinds: [bindingWorkKind] }),
      },
      copy.action.bound(
        siteName(sites, bindingSiteId),
        workKindLabel(bindingWorkKind),
        selectedInstance.name,
      ),
    );
  }

  async function removeBinding(binding: RunnerBindingView) {
    await mutate(
      `unbind:${binding.runnerId}:${binding.siteAgentId}:${binding.workKind}`,
      `/api/runner-management/runners/${encodeURIComponent(binding.runnerId)}/bindings/${encodeURIComponent(binding.siteAgentId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ workKinds: [binding.workKind] }),
      },
      copy.action.unbound,
    );
  }

  const generatedAt = payload?.generatedAt || lastSuccessfulAt;
  const hasStaleData = Boolean(error && payload);

  return (
    <section className="rm-console">
      <header className="rm-hero">
        <div>
          <span className={`rm-live-state ${stateTone(state)}`}>
            <i />
            {loading ? copy.hero.syncing : stateLabel(state)}
          </span>
          <small>
            {siteAgentId ? "SITE · RUNNER MANAGEMENT" : "SYSTEM · RUNNER MANAGEMENT"}
            {taskFilters.siteAgentId
              ? ` · SITE ${siteName(sites, taskFilters.siteAgentId)}`
              : ""}
          </small>
          <h2>{copy.hero.title}</h2>
          <p>{siteAgentId ? copy.hero.siteLead : copy.hero.systemLead}</p>
        </div>
        <div className="rm-hero-actions">
          <span>
            {hasStaleData
              ? copy.hero.lastSuccess(relativeTime(lastSuccessfulAt))
              : generatedAt
                ? copy.hero.updatedAt(relativeTime(generatedAt))
                : copy.hero.awaitingFirstSync}
          </span>
          <div className="rm-hero-buttons">
            <button
              ref={guideButtonRef}
              type="button"
              aria-expanded={guideOpen}
              aria-controls="runner-page-guide"
              onClick={() => setGuideOpen((open) => !open)}
            >
              {guideOpen ? copy.hero.hideGuide : copy.hero.showGuide}
            </button>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => void load()}
            >
              {refreshing ? copy.hero.refreshing : copy.hero.refresh}
            </button>
          </div>
        </div>
      </header>

      {guideOpen && (
        <RunnerPageGuide
          closeRef={guideCloseRef}
          onClose={() => {
            setGuideOpen(false);
            guideButtonRef.current?.focus();
          }}
        />
      )}

      {error && (
        <div className={`rm-error-banner ${hasStaleData ? "stale" : ""}`}>
          <span>!</span>
          <div>
            <b>
              {hasStaleData ? copy.error.staleTitle : copy.error.failedTitle}
            </b>
            <p>{hasStaleData ? copy.error.staleBody : copy.error.failedBody}</p>
          </div>
          <button type="button" onClick={() => void load()}>
            {copy.error.retry}
          </button>
        </div>
      )}

      {notice && (
        <div className="rm-notice" role="status">
          {notice}
        </div>
      )}

      {payload?.mode === "aggregate" ? (
        <div className="rm-metrics aggregate" aria-label={copy.metrics.aggregateLabel}>
          <article>
            <small>{copy.metrics.service}</small>
            <b className={stateTone(payload.serviceStatus)}>
              {stateLabel(payload.serviceStatus)}
            </b>
            <span>{copy.metrics.serviceHidden}</span>
          </article>
          <article>
            <small>{copy.metrics.queueBandLabel}</small>
            <b>{copy.queueBand[payload.queueBand]}</b>
            <span>{copy.metrics.queueBandHidden}</span>
          </article>
        </div>
      ) : siteAgentId ? (
        <div className="rm-metrics" aria-label={copy.metrics.siteScopeLabel}>
          <article>
            <small>
              {organizationCapacity ? copy.metrics.orgInstances : copy.metrics.siteState}
            </small>
            {organizationCapacity ? (
              <b>
                {loading && !payload
                  ? "—"
                  : organizationCapacity.onlineInstances}
                <em> / {organizationCapacity.totalInstances}</em>
              </b>
            ) : (
              <b className={stateTone(state)}>{stateLabel(state)}</b>
            )}
            <span>
              {organizationCapacity
                ? copy.metrics.orgInstancesHint
                : copy.metrics.noOrgSnapshot}
            </span>
          </article>
          <article>
            <small>
              {organizationCapacity ? copy.metrics.orgCapacity : copy.metrics.siteInstances}
            </small>
            <b>
              {loading && !payload
                ? "—"
                : organizationCapacity
                  ? organizationCapacity.active
                  : capacity.onlineInstances}
              <em>
                {" "}
                /{" "}
                {organizationCapacity
                  ? organizationCapacity.maximum
                  : capacity.totalInstances}
              </em>
            </b>
            <span>
              {organizationCapacity
                ? copy.metrics.orgCapacityHint
                : copy.metrics.siteInstancesHint}
            </span>
          </article>
          <article>
            <small>{copy.metrics.siteRunning}</small>
            <b>{loading && !payload ? "—" : capacity.active}</b>
            <span>{copy.metrics.siteRunningHint}</span>
          </article>
          <article>
            <small>{copy.metrics.siteQueued}</small>
            <b>{loading && !payload ? "—" : capacity.queued}</b>
            <span>{copy.metrics.siteQueuedHint}</span>
          </article>
        </div>
      ) : (
        <div className="rm-metrics" aria-label={copy.metrics.aggregateLabel}>
          <article>
            <small>{copy.metrics.serviceState}</small>
            <b className={stateTone(state)}>{stateLabel(state)}</b>
            <span>
              {summary?.message || pool?.message || copy.metrics.defaultPool} ·{" "}
              {copy.metrics.serviceStateHint}
            </span>
          </article>
          <article>
            <small>{copy.metrics.onlineInstances}</small>
            <b>
              {loading && !payload ? "—" : capacity.onlineInstances}
              <em> / {capacity.totalInstances}</em>
            </b>
            <span>{copy.metrics.onlineInstancesHint}</span>
          </article>
          <article>
            <small>{copy.metrics.capacity}</small>
            <b>
              {loading && !payload ? "—" : capacity.active}
              <em> / {capacity.maximum}</em>
            </b>
            <span>{copy.metrics.capacityHint}</span>
          </article>
          <article>
            <small>{copy.metrics.queued}</small>
            <b>{loading && !payload ? "—" : capacity.queued}</b>
            <span>{copy.metrics.queuedHint}</span>
          </article>
        </div>
      )}

      {effectiveMode === "aggregate" ? (
        <AggregateHealth
          projection={
            payload?.mode === "aggregate" ? payload : undefined
          }
          loading={loading}
        />
      ) : (
        <>
          <nav
            className="rm-section-tabs"
            aria-label={copy.tabs.label}
            role="tablist"
          >
            {(
              [
                ["pool", siteAgentId ? copy.tabs.resources : copy.tabs.pool, ""],
                [
                  "instances",
                  siteAgentId ? copy.tabs.sharedInstances : copy.tabs.instances,
                  copy.tabs.instancesMeta(instances.length),
                ],
                [
                  "tasks",
                  copy.tabs.tasks,
                  tasksLoading ? copy.tabs.tasksLoading : copy.tabs.tasksMeta(tasks.length),
                ],
              ] as const
            ).map(([id, label, meta]) => (
              <button
                type="button"
                role="tab"
                key={id}
                className={section === id ? "active" : ""}
                aria-selected={section === id}
                onClick={() => setSection(id)}
              >
                <b>{label}</b>
                <small>{meta}</small>
              </button>
            ))}
          </nav>

          {section === "pool" ? (
            <PoolOverview
              pool={pool}
              platformPool={platformPool}
              capacity={organizationCapacity || capacity}
              bindings={bindings}
              activeLeases={activeLeases}
              queueHealth={queueHealth}
              sites={sites}
              siteAgentId={siteAgentId}
              onOpenInstances={() => setSection("instances")}
              onOpenTasks={() => setSection("tasks")}
            />
          ) : section === "instances" ? (
            <div className="rm-workbench">
              <InstanceList
                instances={instances}
                activeLeases={activeLeases}
                bindings={bindings}
                sites={sites}
                selectedId={selectedInstance?.id}
                onSelect={setSelectedInstanceId}
              />
              {selectedInstance ? (
                <InstanceInspector
                  instance={selectedInstance}
                  bindings={bindings.filter(
                    (item) => item.runnerId === selectedInstance.id,
                  )}
                  activeLeases={activeLeases.filter(
                    (item) => item.runnerId === selectedInstance.id,
                  )}
                  recentTasks={selectedInstanceRecentTasks}
                  sites={sites}
                  siteAgentId={siteAgentId}
                  bindingSiteId={bindingSiteId}
                  bindingWorkKind={bindingWorkKind}
                  busyAction={busyAction}
                  actionsDisabled={Boolean(error)}
                  onBindingSiteId={setBindingSiteId}
                  onBindingWorkKind={setBindingWorkKind}
                  onCreateBinding={() => void createBinding()}
                  onRemoveBinding={(binding) => void removeBinding(binding)}
                  onDesiredState={(desiredState) =>
                    void updateDesiredState(selectedInstance, desiredState)
                  }
                  onCopyId={() =>
                    void navigator.clipboard?.writeText(selectedInstance.id)
                  }
                  onOpenSite={onOpenSite}
                />
              ) : (
                <EmptyState
                  title={copy.instance.emptyTitle}
                  text={copy.instance.emptyText}
                  code={[
                    "npm run runner",
                    "docker compose up -d --build",
                  ]}
                />
              )}
            </div>
          ) : (
            <TaskView
              leases={tasks}
              sites={sites}
              instances={instances}
              selectedId={selectedLease ? taskViewId(selectedLease) : undefined}
              onSelect={setSelectedLeaseId}
              onOpenSite={onOpenSite}
              taskError={taskError}
              loading={tasksLoading}
              filters={taskFilters}
              fixedSiteAgentId={siteAgentId}
              page={taskPage}
              pageSize={TASK_PAGE_SIZE}
              total={taskTotal}
              onFilters={applyTaskFilters}
              onPage={(nextPage) => {
                setTaskPage(nextPage);
                setTaskRecords([]);
                setTasksResolved(false);
                setTaskError("");
                setSelectedLeaseId("");
              }}
            />
          )}
        </>
      )}
    </section>
  );
}

function AggregateHealth({
  projection,
  loading,
}: {
  projection?: Extract<RunnerControlProjection, { mode: "aggregate" }>;
  loading: boolean;
}) {
  const state = projection?.serviceStatus;
  const copy = t().runner.aggregate;
  const queueLabel = projection
    ? t().runner.queueBand[projection.queueBand]
    : copy.loading;
  return (
    <section className="rm-aggregate-card">
      <div className={`rm-aggregate-visual ${stateTone(state)}`}>
        <span>
          <i />
        </span>
        <div>
          <small>MANAGED EXECUTION SERVICE</small>
          <h3>{loading ? copy.confirming : stateLabel(state)}</h3>
          <p>{copy.lead}</p>
        </div>
      </div>
      <dl>
        <div>
          <dt>{copy.serviceState}</dt>
          <dd>{stateLabel(state)}</dd>
        </div>
        <div>
          <dt>{copy.queueBand}</dt>
          <dd>{queueLabel}</dd>
        </div>
      </dl>
      <footer>{copy.footer}</footer>
    </section>
  );
}

function RunnerPageGuide({
  closeRef,
  onClose,
}: {
  closeRef: React.RefObject<HTMLButtonElement | null>;
  onClose(): void;
}) {
  const copy = t().runner.guide;
  return (
    <aside
      id="runner-page-guide"
      className="rm-page-guide"
      role="region"
      aria-labelledby="runner-page-guide-title"
    >
      <header>
        <div>
          <small>PAGE GUIDE</small>
          <h3 id="runner-page-guide-title">{copy.title}</h3>
          <p>{copy.lead}</p>
        </div>
        <button
          ref={closeRef}
          type="button"
          aria-label={copy.close}
          onClick={onClose}
        >
          {copy.closeLabel}
        </button>
      </header>
      <div className="rm-guide-concepts">
        <article>
          <h4>{copy.conceptPool}</h4>
          <p>{copy.conceptPoolBody}</p>
        </article>
        <article>
          <h4>{copy.conceptCapacity}</h4>
          <p>{copy.conceptCapacityBody}</p>
        </article>
        <article>
          <h4>{copy.conceptWorkKinds}</h4>
          <p>{copy.conceptWorkKindsBody}</p>
        </article>
        <article>
          <h4>{copy.conceptBinding}</h4>
          <p>{copy.conceptBindingBody}</p>
        </article>
        <article>
          <h4>{copy.conceptTask}</h4>
          <p>{copy.conceptTaskBody}</p>
        </article>
        <article>
          <h4>{copy.conceptBrowser}</h4>
          <p>{copy.conceptBrowserBody}</p>
        </article>
      </div>
      <section className="rm-guide-statuses" aria-labelledby="runner-status-guide">
        <h4 id="runner-status-guide">{copy.statusTitle}</h4>
        <dl>
          <div>
            <dt>{copy.statusReady}</dt>
            <dd>healthy / ready / idle / online / available</dd>
          </div>
          <div>
            <dt>{copy.statusBusy}</dt>
            <dd>starting / partial / busy / draining</dd>
          </div>
          <div>
            <dt>{copy.statusTaskRunning}</dt>
            <dd>queued / active / running / completing</dd>
          </div>
          <div>
            <dt>{copy.statusInfra}</dt>
            <dd>congested / degraded / stale / offline / unavailable / error</dd>
          </div>
          <div>
            <dt>{copy.statusDone}</dt>
            <dd>completed / passed / released / terminal / failed / expired</dd>
          </div>
        </dl>
      </section>
      <section className="rm-guide-checklist" aria-labelledby="runner-admin-guide">
        <h4 id="runner-admin-guide">{copy.checklistTitle}</h4>
        <ol>
          <li>{copy.checklist1}</li>
          <li>{copy.checklist2}</li>
          <li>{copy.checklist3}</li>
          <li>{copy.checklist4}</li>
        </ol>
      </section>
    </aside>
  );
}

function PoolOverview({
  pool,
  platformPool,
  capacity,
  bindings,
  activeLeases,
  queueHealth,
  sites,
  siteAgentId,
  onOpenInstances,
  onOpenTasks,
}: {
  pool?: RunnerPoolView;
  platformPool?: RunnerPoolView;
  capacity: ReturnType<typeof poolCapacity>;
  bindings: RunnerBindingView[];
  activeLeases: RunnerTaskView[];
  queueHealth: RunnerFullProjection["queueHealth"];
  sites: SiteOption[];
  siteAgentId?: string;
  onOpenInstances(): void;
  onOpenTasks(): void;
}) {
  const busyPercent = capacity.maximum
    ? Math.min(100, (capacity.active / capacity.maximum) * 100)
    : 0;
  const readyPercent = capacity.maximum
    ? Math.min(100 - busyPercent, (capacity.available / capacity.maximum) * 100)
    : 0;
  const displayedPool = platformPool || pool;
  const copy = t().runner.pool;
  return (
    <div className="rm-pool-layout">
      <section className="rm-pool-card">
        <header>
          <div>
            <small>
              {platformPool
                ? "ORGANIZATION PUBLIC POOL · CONSISTENT ACROSS ALL SITES"
                : siteAgentId
                  ? "SITE-EFFECTIVE RESOURCES · ROUTING VIEW"
                  : "ORGANIZATION SHARED RESOURCES · PUBLIC POOL"}
            </small>
            <h3>
              {platformPool
                ? copy.orgTitle
                : siteAgentId
                  ? copy.siteTitle
                  : displayedPool?.name || copy.poolFallbackName}
            </h3>
            <p>
              {platformPool
                ? copy.orgLead
                : siteAgentId
                  ? copy.siteLead
                  : copy.systemLead}
            </p>
          </div>
          <span
            className={stateTone(
              displayedPool?.observedState || displayedPool?.status,
            )}
          >
            <i />
            {stateLabel(displayedPool?.observedState || displayedPool?.status)}
          </span>
        </header>
        <div className="rm-capacity-track" aria-label={copy.capacityLabel}>
          <span className="busy" style={{ width: `${busyPercent}%` }} />
          <span className="ready" style={{ width: `${readyPercent}%` }} />
        </div>
        <div className="rm-capacity-legend">
          <span>
            <i className="busy" /> {copy.legendBusy} {capacity.active}
          </span>
          <span>
            <i className="ready" /> {copy.legendReady} {capacity.available}
          </span>
          <span>
            <i className="offline" /> {copy.legendOffline}{" "}
            {Math.max(0, capacity.totalInstances - capacity.onlineInstances)}
          </span>
        </div>
        <dl className="rm-pool-facts">
          <div>
            <dt>{copy.instances}</dt>
            <dd>
              {capacity.onlineInstances} / {capacity.totalInstances}
            </dd>
            <small>{copy.instancesHint}</small>
          </div>
          <div>
            <dt>{copy.concurrency}</dt>
            <dd>{capacity.maximum}</dd>
            <small>{copy.concurrencyHint}</small>
          </div>
          <div>
            <dt>{copy.prewarm}</dt>
            <dd>
              {capacity.readySlots} / {capacity.prewarmCapacity}
            </dd>
            <small>{copy.prewarmHint}</small>
          </div>
          <div>
            <dt>{copy.bindings}</dt>
            <dd>{bindings.length}</dd>
            <small>{copy.bindingsHint}</small>
          </div>
        </dl>
        <footer>
          <button type="button" onClick={onOpenInstances}>
            {copy.viewInstances}
          </button>
          <button type="button" onClick={onOpenTasks}>
            {copy.viewTasks}
          </button>
        </footer>
      </section>
      <aside className="rm-pool-side">
        <section>
          <header>
            <small>WORK KINDS</small>
            <b>{copy.workKindsTitle}</b>
            <p>{copy.workKindsLead}</p>
          </header>
          <div className="rm-work-kinds">
            {(pool?.workKinds?.length
              ? pool.workKinds
              : (["execute", "author", "validate"] as RunnerWorkKind[])
            ).map((kind) => (
              <span key={kind}>
                <i>{kind.slice(0, 1).toUpperCase()}</i>
                <b>{workKindLabel(kind)}</b>
                <small>
                  {copy.workKindCounts(
                    activeLeases.filter((item) => item.workKind === kind).length,
                    queueHealth.find((item) => item.workKind === kind)?.queuedWorkCount || 0,
                  )}
                </small>
              </span>
            ))}
          </div>
        </section>
        <section>
          <header>
            <small>SITE-DIRECTED RESOURCES</small>
            <b>{siteAgentId ? copy.siteBindingsTitle : copy.systemBindingsTitle}</b>
            <p>{siteAgentId ? copy.siteBindingsLead : copy.systemBindingsLead}</p>
          </header>
          <div className="rm-binding-summary">
            {bindings.slice(0, 5).map((binding) => (
              <div
                key={`${binding.runnerId}:${binding.siteAgentId}:${binding.workKind}`}
              >
                <span>
                  <b>{siteName(sites, binding.siteAgentId)}</b>
                  <small>{workKindLabel(binding.workKind)}</small>
                </span>
                <code>{shortId(binding.runnerId)}</code>
              </div>
            ))}
            {!bindings.length && (
              <p>
                {siteAgentId ? copy.noSiteBindings : copy.noBindings}
              </p>
            )}
          </div>
        </section>
      </aside>
    </div>
  );
}

function InstanceList({
  instances,
  activeLeases,
  bindings,
  sites,
  selectedId,
  onSelect,
}: {
  instances: RunnerInstanceView[];
  activeLeases: RunnerTaskView[];
  bindings: RunnerBindingView[];
  sites: SiteOption[];
  selectedId?: string;
  onSelect(id: string): void;
}) {
  const copy = t().runner.instance;
  return (
    <div className="rm-instance-list">
      <header>
        <span className="rm-instance-list-hint">{copy.listHint}</span>
        <span>{copy.colInstance}</span>
        <span>{copy.colCapacity}</span>
        <span>{copy.colHeartbeat}</span>
      </header>
      {instances.map((instance) => {
        const instanceLeases = activeLeases.filter(
          (item) => item.runnerId === instance.id,
        );
        const active = instanceLeases.length;
        const boundSites = Array.from(
          new Set(
            bindings
              .filter((item) => item.runnerId === instance.id)
              .map((item) => siteName(sites, item.siteAgentId)),
          ),
        );
        const currentWork = instanceLeases.map(
          (item) =>
            `${workKindLabel(item.workKind || "execute")} ${shortId(item.taskId)}`,
        );
        const maximum = numberValue(instance.capabilities?.maxConcurrency);
        const observed = instance.observedState || instance.status;
        const displayState =
          instance.desiredState === "draining" ? "draining" : observed;
        return (
          <button
            type="button"
            key={instance.id}
            className={selectedId === instance.id ? "selected" : ""}
            onClick={() => onSelect(instance.id)}
          >
            <span className="rm-instance-identity">
              <i className={stateTone(displayState)} />
              <span>
                <b>{instance.name}</b>
                <small>
                  {stateLabel(displayState)}
                  {instance.version ? ` · v${instance.version}` : ""} ·{" "}
                  {shortId(instance.id)}
                </small>
                <em className="rm-instance-context">
                  <span title={boundSites.join("、")}>
                    {copy.boundTo(boundSites.length ? boundSites.join("、") : copy.boundDefault)}
                  </span>
                  <span title={currentWork.join("、")}>
                    {copy.currentWork(currentWork.length ? currentWork.join("、") : copy.idle)}
                  </span>
                </em>
                {instance.lastError && (
                  <em
                    className="rm-instance-error-line"
                    title={instance.lastError.message}
                  >
                    <i>!</i>
                    <span>
                      {instance.lastError.phase ||
                        instance.lastError.code ||
                        copy.lastErrorFallback}
                      ：{instance.lastError.message}
                    </span>
                    <time>{relativeTime(instance.lastError.at)}</time>
                  </em>
                )}
              </span>
            </span>
            <span className="rm-instance-capacity">
              <b>
                {active} / {maximum}
              </b>
              <small>
                {copy.prewarm(
                  numberValue(instance.capabilities?.readySlots),
                  numberValue(instance.capabilities?.prewarmCapacity),
                )}
              </small>
            </span>
            <span className="rm-instance-time">
              <b>{relativeTime(instance.lastHeartbeatAt)}</b>
              <small>{stateLabel(instance.desiredState)}</small>
            </span>
          </button>
        );
      })}
      {!instances.length && (
        <p className="rm-list-empty">{copy.listEmpty}</p>
      )}
    </div>
  );
}

function InstanceInspector({
  instance,
  bindings,
  activeLeases,
  recentTasks,
  sites,
  siteAgentId,
  bindingSiteId,
  bindingWorkKind,
  busyAction,
  actionsDisabled,
  onBindingSiteId,
  onBindingWorkKind,
  onCreateBinding,
  onRemoveBinding,
  onDesiredState,
  onCopyId,
  onOpenSite,
}: {
  instance: RunnerInstanceView;
  bindings: RunnerBindingView[];
  activeLeases: RunnerTaskView[];
  recentTasks: RunnerTaskView[];
  sites: SiteOption[];
  siteAgentId?: string;
  bindingSiteId: string;
  bindingWorkKind: RunnerWorkKind;
  busyAction: string;
  actionsDisabled: boolean;
  onBindingSiteId(value: string): void;
  onBindingWorkKind(value: RunnerWorkKind): void;
  onCreateBinding(): void;
  onRemoveBinding(binding: RunnerBindingView): void;
  onDesiredState(state: "active" | "draining"): void;
  onCopyId(): void;
  onOpenSite?(siteAgentId: string, capabilityId?: string): void;
}) {
  const observed = instance.observedState || instance.status;
  const draining = instance.desiredState === "draining";
  const displayState = draining ? "draining" : observed;
  const copy = t().runner.instance;
  return (
    <aside className="rm-inspector">
      <header>
        <div>
          <small>RUNNER INSTANCE</small>
          <h3>{instance.name}</h3>
          <button type="button" className="rm-copy-id" onClick={onCopyId}>
            {instance.id} <span>{copy.copyId}</span>
          </button>
        </div>
        <span className={stateTone(displayState)}>
          <i /> {stateLabel(displayState)}
        </span>
      </header>
      <div className="rm-instance-actions">
        <button
          type="button"
          disabled={actionsDisabled || Boolean(busyAction)}
          onClick={() => onDesiredState(draining ? "active" : "draining")}
        >
          {busyAction === `state:${instance.id}`
            ? copy.updating
            : draining
              ? copy.resume
              : copy.drain}
        </button>
        <p>
          {siteAgentId
            ? copy.siteScopeWarning
            : draining
              ? copy.drainingNote
              : copy.drainNote}
        </p>
      </div>
      <dl className="rm-instance-facts">
        <div>
          <dt>{copy.version}</dt>
          <dd>{instance.version || copy.versionMissing}</dd>
        </div>
        <div>
          <dt>{copy.role}</dt>
          <dd>{instance.role ? roleLabel(instance.role) : copy.roleFallback}</dd>
        </div>
        <div>
          <dt>{copy.workKinds}</dt>
          <dd>
            {instance.workKinds?.map((kind) => workKindLabel(kind)).join(" / ") ||
              copy.workKindsMissing}
          </dd>
        </div>
        <div>
          <dt>{copy.browsers}</dt>
          <dd>{instance.capabilities?.browsers?.join(", ") || "Chromium"}</dd>
        </div>
        <div>
          <dt>{copy.maxConcurrency}</dt>
          <dd>{numberValue(instance.capabilities?.maxConcurrency)}</dd>
        </div>
        <div>
          <dt>{copy.recording}</dt>
          <dd>{instance.capabilities?.recording ? copy.recordingOn : copy.recordingOff}</dd>
        </div>
        <div>
          <dt>{copy.prewarmSlots}</dt>
          <dd>
            {numberValue(instance.capabilities?.readySlots)} /{" "}
            {numberValue(instance.capabilities?.prewarmCapacity)}
          </dd>
        </div>
        <div>
          <dt>{copy.createdAt}</dt>
          <dd>{relativeTime(instance.createdAt)}</dd>
        </div>
        <div>
          <dt>{copy.lastHeartbeat}</dt>
          <dd>{relativeTime(instance.lastHeartbeatAt)}</dd>
        </div>
      </dl>
      {instance.lastError && (
        <section className="rm-instance-last-error" aria-label={copy.lastErrorLabel}>
          <header>
            <span>
              <small>LAST SAFE ERROR</small>
              <b>
                {instance.lastError.phase || "Runner"}
                {instance.lastError.code
                  ? ` · ${instance.lastError.code}`
                  : ""}
              </b>
            </span>
            <time dateTime={instance.lastError.at}>
              {relativeTime(instance.lastError.at)}
            </time>
          </header>
          <p>{instance.lastError.message}</p>
        </section>
      )}
      {instance.activity?.message && (
        <section className="rm-current-activity">
          <small>CURRENT ACTIVITY</small>
          <b>{instance.activity.phase || "Runner"}</b>
          <p>{instance.activity.message}</p>
        </section>
      )}
      <section className="rm-current-leases">
        <header>
          <small>ACTIVE LEASES</small>
          <b>{copy.activeLeases}</b>
        </header>
        {activeLeases.map((lease) => (
          <button
            type="button"
            key={lease.leaseId || lease.id}
            onClick={() =>
              lease.siteAgentId &&
              onOpenSite?.(lease.siteAgentId, lease.capabilityId)
            }
          >
            <i className="active" />
            <span>
              <b>{lease.title || lease.goal || workKindLabel(lease.workKind || "execute")}</b>
              <small>
                {siteName(sites, lease.siteAgentId)} ·{" "}
                {lease.progress?.message || stateLabel(lease.status)}
              </small>
            </span>
            <em>{durationSince(lease.startedAt || lease.leasedAt)}</em>
          </button>
        ))}
        {!activeLeases.length && <p>{copy.noActiveLeases}</p>}
      </section>
      <section className="rm-instance-history">
        <header>
          <small>RECENT TASKS</small>
          <b>{copy.recentTasks}</b>
        </header>
        <div>
          {recentTasks.map((task) => (
            <button
              type="button"
              key={taskViewId(task)}
              disabled={!task.siteAgentId}
              onClick={() =>
                task.siteAgentId &&
                onOpenSite?.(task.siteAgentId, task.capabilityId)
              }
            >
              <i className={stateTone(task.status)} />
              <span>
                <b>{task.title || workKindLabel(task.workKind || "execute")}</b>
                <small>
                  {siteName(sites, task.siteAgentId)} ·{" "}
                  {stateLabel(task.status)}
                </small>
              </span>
              <time dateTime={task.completedAt || task.updatedAt}>
                {relativeTime(
                  task.completedAt || task.updatedAt || task.createdAt,
                )}
              </time>
            </button>
          ))}
          {!recentTasks.length && <p>{copy.noRecentTasks}</p>}
        </div>
      </section>
      <section className="rm-binding-editor">
        <header>
          <small>SITE-DIRECTED RESOURCES</small>
          <b>{siteAgentId ? copy.bindingSiteTitle : copy.bindingSystemTitle}</b>
          <p>{copy.bindingLead}</p>
        </header>
        <div className="rm-binding-form">
          {siteAgentId ? (
            <div className="rm-binding-site-lock" aria-label={copy.currentSite}>
              <small>{copy.currentSite}</small>
              <b>{siteName(sites, siteAgentId)}</b>
            </div>
          ) : (
            <select
              aria-label={copy.pickSite}
              value={bindingSiteId}
              onChange={(event) => onBindingSiteId(event.target.value)}
            >
              <option value="">{copy.pickSite}</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label={copy.pickWorkKind}
            value={bindingWorkKind}
            onChange={(event) =>
              onBindingWorkKind(event.target.value as RunnerWorkKind)
            }
          >
            {Object.entries(t().runner.workKind).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={
              actionsDisabled || !bindingSiteId || Boolean(busyAction)
            }
            onClick={onCreateBinding}
          >
            {copy.bind}
          </button>
        </div>
        <div className="rm-binding-list">
          {bindings.map((binding) => (
            <div
              key={`${binding.siteAgentId}:${binding.workKind}`}
            >
              <span>
                <b>{siteName(sites, binding.siteAgentId)}</b>
                <small>{workKindLabel(binding.workKind)}</small>
              </span>
              <button
                type="button"
                disabled={actionsDisabled || Boolean(busyAction)}
                onClick={() => onRemoveBinding(binding)}
              >
                {copy.unbind}
              </button>
            </div>
          ))}
          {!bindings.length && <p>{copy.noBindings}</p>}
        </div>
      </section>
    </aside>
  );
}

function taskProgressState(task: RunnerTaskView, index: number) {
  if (task.lifecycleStatus === "queued") return index === 0 ? "active" : "";
  if (task.lifecycleStatus === "completing")
    return index < 3 ? "done" : index === 3 ? "active" : "";
  if (task.lifecycleStatus === "terminal") {
    if (task.status === "completed") return "done";
    if (["failed", "expired"].includes(task.status || ""))
      return index < 2 ? "done" : index === 2 ? "failed" : "";
    return index < 2 ? "done" : "";
  }
  return index < 2 ? "done" : index === 2 ? "active" : "";
}

function taskProgressSymbol(
  task: RunnerTaskView,
  index: number,
  className: string,
) {
  if (className === "done") return "✓";
  if (className === "failed") return "!";
  if (className === "active" && task.lifecycleStatus === "queued") return "•";
  return index + 1;
}

function taskFallbackMessage(task: RunnerTaskView) {
  const copy = t().runner.task;
  if (task.lifecycleStatus === "queued") return copy.fallbackQueued;
  if (task.lifecycleStatus === "completing") return copy.fallbackCompleting;
  if (task.lifecycleStatus === "terminal")
    return copy.fallbackTerminal(stateLabel(task.status));
  return copy.fallbackActive;
}

function TaskView({
  leases,
  sites,
  instances,
  selectedId,
  onSelect,
  onOpenSite,
  taskError,
  loading,
  filters,
  fixedSiteAgentId,
  page,
  pageSize,
  total,
  onFilters,
  onPage,
}: {
  leases: RunnerTaskView[];
  sites: SiteOption[];
  instances: RunnerInstanceView[];
  selectedId?: string;
  onSelect(id: string): void;
  onOpenSite?(siteAgentId: string, capabilityId?: string): void;
  taskError?: string;
  loading?: boolean;
  filters: TaskFilters;
  fixedSiteAgentId?: string;
  page: number;
  pageSize: number;
  total: number;
  onFilters(filters: TaskFilters): void;
  onPage(page: number): void;
}) {
  const selected =
    leases.find((item) => taskViewId(item) === selectedId) ||
    leases[0];
  const selectedAttempts = selected?.attempts || [];
  const hasFilters = Boolean(
    filters.status ||
    filters.runnerId ||
    filters.workKind ||
    (!fixedSiteAgentId && filters.siteAgentId),
  );
  const displayTotal = taskError && !total ? leases.length : total;
  const totalPages = Math.max(1, Math.ceil(displayTotal / pageSize));
  const firstVisible = displayTotal ? (page - 1) * pageSize + 1 : 0;
  const lastVisible = Math.min(page * pageSize, displayTotal);
  const copy = t().runner.task;

  function changeFilter<Key extends keyof TaskFilters>(
    key: Key,
    value: TaskFilters[Key],
  ) {
    onFilters({ ...filters, [key]: value });
  }

  return (
    <section className="rm-task-view">
      <header className="rm-task-filters">
        <div>
          <small>TASK QUERY</small>
          <b>{copy.queryTitle}</b>
          <span>{copy.queryLead}</span>
        </div>
        <select
          aria-label={copy.filterStatus}
          value={filters.status}
          onChange={(event) =>
            changeFilter("status", event.target.value as TaskFilters["status"])
          }
        >
          <option value="">{copy.allStatuses}</option>
          <option value="queued">{copy.statusQueued}</option>
          <option value="active">{copy.statusActive}</option>
          <option value="completing">{copy.statusCompleting}</option>
          <option value="terminal">{copy.statusTerminal}</option>
        </select>
        {fixedSiteAgentId ? (
          <div className="rm-task-site-lock" aria-label={copy.siteScope}>
            <small>{copy.currentSite}</small>
            <b>{siteName(sites, fixedSiteAgentId)}</b>
          </div>
        ) : (
          <select
            aria-label={copy.filterSite}
            value={filters.siteAgentId}
            onChange={(event) => changeFilter("siteAgentId", event.target.value)}
          >
            <option value="">{copy.allSites}</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label={copy.filterRunner}
          value={filters.runnerId}
          onChange={(event) => changeFilter("runnerId", event.target.value)}
        >
          <option value="">{copy.allRunners}</option>
          {instances.map((instance) => (
            <option key={instance.id} value={instance.id}>
              {instance.name}
            </option>
          ))}
        </select>
        <select
          aria-label={copy.filterWorkKind}
          value={filters.workKind}
          onChange={(event) =>
            changeFilter(
              "workKind",
              event.target.value as TaskFilters["workKind"],
            )
          }
        >
          <option value="">{copy.allWorkKinds}</option>
          {Object.entries(t().runner.workKind).map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={!hasFilters}
          onClick={() =>
            onFilters({
              status: "",
              siteAgentId: fixedSiteAgentId || "",
              runnerId: "",
              workKind: "",
            })
          }
        >
          {copy.clearFilters}
        </button>
      </header>
      <div className="rm-task-layout">
        <div className="rm-task-list">
          <header>
            <span>
              {loading ? copy.syncing : copy.count(displayTotal)}
            </span>
            <small>{hasFilters ? copy.filtered : copy.recentFirst}</small>
          </header>
          {taskError && (
            <p className="rm-task-warning">
              {leases.length ? copy.partialError : copy.queryError}
            </p>
          )}
          {leases.map((lease) => {
            const id = taskViewId(lease);
            return (
              <button
                type="button"
                key={id}
                className={selected === lease ? "selected" : ""}
                onClick={() => onSelect(id)}
              >
                <i className={stateTone(lease.status || "busy")} />
                <span>
                  <b>
                    {lease.title ||
                      lease.goal ||
                      workKindLabel(lease.workKind || "execute")}
                  </b>
                  <small>
                    {siteName(sites, lease.siteAgentId)} ·{" "}
                    {stateLabel(lease.status)}
                  </small>
                </span>
                <em>
                  {leaseDuration(lease)}
                  <small>
                    {lease.runnerId ? shortId(lease.runnerId) : copy.awaitingRunner}
                  </small>
                </em>
              </button>
            );
          })}
          {!leases.length && (
            <div className="rm-task-zero">
              <span>⌁</span>
              <b>
                {loading
                  ? copy.zeroLoading
                  : hasFilters
                    ? copy.zeroFiltered
                    : copy.zeroIdle}
              </b>
              <p>{hasFilters ? copy.zeroFilteredHint : copy.zeroIdleHint}</p>
            </div>
          )}
          <footer className="rm-task-pagination">
            <span>
              {firstVisible}–{lastVisible} / {displayTotal}
            </span>
            <div>
              <button
                type="button"
                disabled={loading || page <= 1}
                onClick={() => onPage(page - 1)}
                aria-label={copy.prevPage}
              >
                ←
              </button>
              <b>
                {page} / {totalPages}
              </b>
              <button
                type="button"
                disabled={loading || page >= totalPages}
                onClick={() => onPage(page + 1)}
                aria-label={copy.nextPage}
              >
                →
              </button>
            </div>
          </footer>
        </div>
        {selected ? (
          <aside className="rm-task-inspector">
            <header>
              <small>
                {selected.lifecycleStatus === "queued"
                  ? "QUEUED WORK"
                  : selected.lifecycleStatus === "terminal"
                    ? "RECENT TASK"
                    : "ACTIVE LEASE"}
              </small>
              <h3>
                {selected.title ||
                  selected.goal ||
                  workKindLabel(selected.workKind || "execute")}
              </h3>
              <span className={stateTone(selected.status)}>
                {stateLabel(selected.status || "busy")}
              </span>
            </header>
            <div className="rm-task-progress">
              {[copy.stepQueued, copy.stepAssigned, copy.stepBrowser, copy.stepEvidence].map(
                (label, index) => {
                  const className = taskProgressState(selected, index);
                  return (
                    <span key={label} className={className}>
                      <i>
                        {taskProgressSymbol(selected, index, className)}
                      </i>
                      {label}
                    </span>
                  );
                },
              )}
            </div>
            <section>
              <small>TASK STATE</small>
              <b>{selected.failure?.code || selected.progress?.stage || stateLabel(selected.status)}</b>
              <p>
                {taskFailureMessage(selected) || selected.progress?.message || taskFallbackMessage(selected)}
              </p>
            </section>
            {!!selectedAttempts.length && (
              <section className="rm-task-attempts">
                <header>
                  <span>
                    <small>ATTEMPT TIMELINE</small>
                    <b>{copy.attemptCount(selectedAttempts.length)}</b>
                  </span>
                  <em>{copy.attemptHint}</em>
                </header>
                <div>
                  {[...selectedAttempts].reverse().map((attempt, index) => {
                    const attemptStatus = attemptDisplayStatus(attempt);
                    return (
                      <article key={attempt.displayId}>
                        <i className={stateTone(attemptStatus)} />
                        <div>
                          <span>
                            <b>
                              Attempt {selectedAttempts.length - index}
                            </b>
                            <small>{shortId(attempt.runnerId)}</small>
                          </span>
                          <span className={stateTone(attemptStatus)}>
                            {stateLabel(attemptStatus)}
                          </span>
                          <time
                            dateTime={
                              attempt.completedAt || attempt.leasedAt
                            }
                          >
                            {relativeTime(
                              attempt.completedAt || attempt.leasedAt,
                            )}
                          </time>
                          {!!attempt.browserRuns.length && (
                            <div className="rm-attempt-browser-runs">
                              {attempt.browserRuns.map((run) => (
                                <span
                                  key={run.id}
                                  className={stateTone(run.status)}
                                  title={`${run.id} · ${stateLabel(run.status)}`}
                                >
                                  {browserModeLabel(run.mode)}
                                  <i />
                                  {stateLabel(run.status)}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
            <dl>
              <div>
                <dt>{copy.taskId}</dt>
                <dd>{selected.taskId || selected.id || "—"}</dd>
              </div>
              <div>
                <dt>Lease</dt>
                <dd>{selected.leaseId || copy.leaseUnassigned}</dd>
              </div>
              <div>
                <dt>Runner</dt>
                <dd>{selected.runnerId || copy.runnerUnassigned}</dd>
              </div>
              <div>
                <dt>{selected.leasedAt ? copy.startedAt : copy.enqueuedAt}</dt>
                <dd>
                  {relativeTime(
                    selected.startedAt ||
                      selected.leasedAt ||
                      selected.createdAt,
                  )}
                </dd>
              </div>
              <div>
                <dt>{selected.completedAt ? copy.completedAt : copy.leaseExpiry}</dt>
                <dd>
                  {selected.completedAt || selected.expiresAt
                    ? relativeTime(
                        selected.completedAt || selected.expiresAt,
                      )
                    : copy.leaseUnassigned}
                </dd>
              </div>
            </dl>
            {selected.siteAgentId && (
              <button
                type="button"
                className="rm-open-owner"
                onClick={() =>
                  onOpenSite?.(selected.siteAgentId!, selected.capabilityId)
                }
              >
                {copy.openOwner}
              </button>
            )}
          </aside>
        ) : (
          <aside className="rm-task-inspector empty">
            <span>{copy.pickTask}</span>
          </aside>
        )}
      </div>
    </section>
  );
}

function EmptyState({
  title,
  text,
  code,
}: {
  title: string;
  text: string;
  code?: string | string[];
}) {
  const commands = Array.isArray(code) ? code : code ? [code] : [];
  return (
    <section className="rm-empty">
      <span>⌁</span>
      <small>RUNNER CONTROL</small>
      <h3>{title}</h3>
      <p>{text}</p>
      {commands.map((command) => (
        <button
          type="button"
          key={command}
          onClick={() => void navigator.clipboard?.writeText(command)}
        >
          <code>{command}</code>
          <span>{t().runner.copyCommand}</span>
        </button>
      ))}
    </section>
  );
}
