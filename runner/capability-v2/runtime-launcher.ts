import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendTaskEvent, claimTask, failTaskDispatch, getTask, heartbeatRunner, listPendingTaskSites, listRunners, listTasks, markExpiredRunnersLost, markRunnerLost, registerRunner, releaseTaskClaim, terminateRunner } from "../../db/capability-center-v2-store";
import type { CapabilityTask, RunnerInstance } from "../../lib/capability-center-v2/model";
import { issueRunnerToken } from "../../lib/capability-center-v2/runner-auth";
import { getPublicAddress } from "../../lib/public-address";
import { capabilityV2RuntimeEndpoints } from "./module-delivery";

export type RuntimeType = "Process" | "Container" | "Function";
export type RuntimeHandle = {
  runnerId: string;
  siteId: string;
  taskId: string;
  child?: ChildProcess;
  runtimeType: RuntimeType;
  runtimeProvider: string;
  runtimeLauncherUrl?: string;
};
export type RuntimeAdapter = { launch(task: CapabilityTask, runner: RunnerInstance, runnerToken: string): Promise<RuntimeHandle>; terminate(handle: RuntimeHandle): Promise<void> };

const activeHandles = new Map<string, RuntimeHandle>();

/**
 * The public address the console holds, when an administrator set one there.
 *
 * `getPublicAddress()` answers with the environment's value too, and returning
 * that here would quietly promote `SITEWAKE_PUBLIC_ORIGIN` above an explicit
 * `CAPABILITY_V2_BROWSER_PUBLIC_URL`, which is a capability-specific override
 * an operator may have set on purpose. Only a saved address is forwarded; with
 * none, the environment decides in the order it always has.
 */
function consolePublicOrigin() {
  const address = getPublicAddress();
  return address.source === "console" ? address.origin : undefined;
}

export function runnerEnvironment(task: CapabilityTask, runner: RunnerInstance, runnerToken: string) {
  const { controlPlaneUrl, browserPublicUrl } = capabilityV2RuntimeEndpoints(process.env, consolePublicOrigin());
  const allowed = [
    "SystemRoot", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "NODE_OPTIONS", "NODE_ENV",
    "PLAYWRIGHT_BROWSERS_PATH",
    "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
    // The control plane's internal model proxy and the token it accepts: how a
    // runner reaches the model without ever holding the provider key.
    "SITEWAKE_MODEL_PROXY_URL", "CAPABILITY_V2_DISPATCH_TOKEN",
    "CAPABILITY_V2_ARTIFACT_DIR", "CAPABILITY_V2_INTERACTION_TIMEOUT_MS",
  ];
  const validation = task.type === "Validation";
  const modelKeys = new Set([
    "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC",
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL",
  ]);
  const env = Object.fromEntries(allowed.filter((key) => !validation || !modelKeys.has(key)).flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key] as string]]));
  return {
    ...env,
    NODE_ENV: process.env.NODE_ENV,
    CAPABILITY_V2_SITE_ID: task.siteId,
    CAPABILITY_V2_TASK_ID: task.id,
    CAPABILITY_V2_RUNNER_ID: runner.id,
    CAPABILITY_V2_SKIP_REGISTER: "1",
    CAPABILITY_V2_RUNNER_TOKEN: runnerToken,
    CAPABILITY_V2_TASK_TYPE: task.type,
    CAPABILITY_V2_CONTROL_PLANE_URL: controlPlaneUrl,
    ...(browserPublicUrl ? { CAPABILITY_V2_BROWSER_PUBLIC_URL: browserPublicUrl } : {}),
    ...(process.env.SITEWAKE_LOCAL_DEV === "1" && process.env.NODE_ENV !== "production" ? { CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN: "1" } : {}),
  };
}

class ProcessRuntimeAdapter implements RuntimeAdapter {
  async launch(task: CapabilityTask, runner: RunnerInstance, runnerToken: string) {
    const script = fileURLToPath(new URL("./process-runner.ts", import.meta.url));
    const tsxCli = fileURLToPath(new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const child = spawn(process.execPath, [tsxCli, script], { detached: false, stdio: "inherit", env: runnerEnvironment(task, runner, runnerToken) });
    return { runnerId: runner.id, siteId: task.siteId, taskId: task.id, child, runtimeType: "Process" as const, runtimeProvider: "Local" };
  }
  async terminate(handle: RuntimeHandle) {
    if (!handle.child || handle.child.killed) return;
    handle.child.kill("SIGTERM");
    const timer = setTimeout(() => { if (!handle.child?.killed) handle.child?.kill("SIGKILL"); }, 5_000);
    handle.child.once("exit", () => clearTimeout(timer));
  }
}

/**
 * Worker runtimes (including the local Vinext/Miniflare runtime) cannot spawn
 * OS processes from a request handler.  In that environment the control plane
 * delegates the same launch contract to a separately managed RuntimeLauncher
 * broker.  The broker is intentionally transport-only: it starts the exact
 * same process-runner with the task-scoped environment and returns immediately.
 */
export class RemoteProcessRuntimeAdapter implements RuntimeAdapter {
  constructor(private readonly launcherUrl: string, private readonly launcherToken?: string) {}

  private async call(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${this.launcherUrl.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.launcherToken ? { authorization: `Bearer ${this.launcherToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as { message?: string; error?: string };
    if (!response.ok) throw new Error(payload.message || payload.error || `runtime_launcher_http_${response.status}`);
    return payload;
  }

  async launch(task: CapabilityTask, runner: RunnerInstance, runnerToken: string) {
    const { controlPlaneUrl, browserPublicUrl } = capabilityV2RuntimeEndpoints(process.env, consolePublicOrigin());
    await this.call("/launch", {
      siteId: task.siteId,
      taskId: task.id,
      runnerId: runner.id,
      runnerToken,
      controlPlaneUrl,
      browserPublicUrl,
      allowPrivateOrigin: process.env.CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN === "1",
      interactionTimeoutMs: process.env.CAPABILITY_V2_INTERACTION_TIMEOUT_MS,
      taskType: task.type,
    });
    return {
      runnerId: runner.id,
      siteId: task.siteId,
      taskId: task.id,
      runtimeType: "Process" as const,
      runtimeProvider: "Local",
      runtimeLauncherUrl: this.launcherUrl,
    };
  }

  async terminate(handle: RuntimeHandle) {
    await this.call("/terminate", {
      siteId: handle.siteId,
      taskId: handle.taskId,
      runnerId: handle.runnerId,
    });
  }
}

function defaultRuntimeAdapter(): RuntimeAdapter {
  const launcherUrl = process.env.CAPABILITY_V2_RUNTIME_LAUNCHER_URL?.trim();
  return launcherUrl
    ? new RemoteProcessRuntimeAdapter(launcherUrl, process.env.CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN?.trim())
    : new ProcessRuntimeAdapter();
}

export class RuntimeLauncher {
  constructor(private readonly adapter: RuntimeAdapter = defaultRuntimeAdapter()) {}

  async dispatchOne(siteId: string, taskId?: string) {
    await markExpiredRunnersLost(siteId);
    const { tasks } = await listTasks(siteId, { status: "Pending" });
    const retryDelayMs = Math.max(1_000, Number(process.env.CAPABILITY_V2_DISPATCH_RETRY_MS || 15_000));
    const dispatchable = tasks.filter((item) => !item.error?.retryable || Date.now() - Date.parse(item.updatedAt) >= retryDelayMs);
    const task = taskId ? dispatchable.find((item) => item.id === taskId) : dispatchable[0];
    if (!task) return undefined;
    const maxAttempts = Math.max(1, Number(process.env.CAPABILITY_V2_DISPATCH_MAX_ATTEMPTS || 3));
    const attempts = (await listRunners(siteId, { taskId: task.id })).runners.filter((runner) => runner.status === "Lost").length;
    if (attempts >= maxAttempts) {
      await failTaskDispatch(siteId, task.id, `runner_start_retry_exhausted:attempts=${attempts}`);
      return undefined;
    }
    const runnerId = crypto.randomUUID();
    await claimTask(siteId, task.id, runnerId);
    let registered: Awaited<ReturnType<typeof registerRunner>>;
    try { registered = await registerRunner(siteId, { id: runnerId, taskId: task.id, runtimeType: "Process", runtimeProvider: "Local", runtimeVersion: "2.0.0" }); }
    catch (error) { await releaseTaskClaim(siteId, task.id, runnerId).catch(() => undefined); throw error; }
    try {
      const claimed = await getTask(siteId, task.id, true);
      if (!claimed) throw new Error("claimed_task_not_found");
      const handle = await this.adapter.launch(claimed, registered.runner, await issueRunnerToken(siteId, task.id, runnerId));
      activeHandles.set(runnerId, handle);
      await heartbeatRunner(siteId, runnerId, { status: "Running" });
      await appendTaskEvent(siteId, task.id, {
        eventType: "RunnerDispatched",
        payload: { phase: "RunnerDispatch", runnerId, runtimeType: handle.runtimeType, runtimeProvider: handle.runtimeProvider },
      }).catch((eventError) => console.warn("[capability-debug] RunnerDispatched event failed", { taskId: task.id, eventError }));
      handle.child?.once("exit", () => {
        activeHandles.delete(runnerId);
        void (async () => {
          const current = await getTask(siteId, task.id, true);
          if (current && !["Succeeded", "Failed", "Cancelled", "Deleted"].includes(current.status)) await markRunnerLost(siteId, runnerId, "runner_process_exited");
          else await terminateRunner(siteId, runnerId);
        })().catch(() => undefined);
      });
      return handle;
    } catch (error) {
      const detail = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 300);
      await markRunnerLost(siteId, runnerId, `runner_launch_failed:${detail}`).catch(() => releaseTaskClaim(siteId, task.id, runnerId, `runner_launch_failed:${detail}`));
      throw error;
    }
  }

  async dispatchNext() {
    await markExpiredRunnersLost();
    for (const siteId of await listPendingTaskSites()) {
      const handle = await this.dispatchOne(siteId);
      if (handle) return handle;
    }
    return undefined;
  }

  async terminate(siteId: string, handle: RuntimeHandle) {
    await this.adapter.terminate(handle);
    activeHandles.delete(handle.runnerId);
    await terminateRunner(siteId, handle.runnerId).catch(() => undefined);
  }
}

export async function terminateActiveTaskRunner(siteId: string, taskId: string) {
  const task = await getTask(siteId, taskId, true);
  if (!task?.runnerId) return false;
  const handle = activeHandles.get(task.runnerId);
  if (handle) await new RuntimeLauncher().terminate(siteId, handle);
  else await markRunnerLost(siteId, task.runnerId, "runner_cancelled").catch(() => undefined);
  return true;
}

export async function terminateRunnerProcess(siteId: string, runnerId: string) {
  const handle = activeHandles.get(runnerId);
  if (handle) await new RuntimeLauncher().terminate(siteId, handle);
  else await terminateRunner(siteId, runnerId).catch(() => undefined);
}

export { ProcessRuntimeAdapter };
