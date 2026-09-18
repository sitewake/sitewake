import { getArtifactBinding, getD1Binding } from "../../../db";
import { getRunnerControlProjection } from "../../../db/runner-control-store";
import { expireStaleTaskLaunches } from "../../../db/site-agent-store";
import { siteAgentJson } from "../site-agents/http";

export const runtime = "nodejs";

const REQUIRED_RUNNER_WORK_KINDS = ["author", "execute", "validate"] as const;

async function probeObjectStorage() {
  const artifacts = getArtifactBinding();
  if (!artifacts) return "unavailable" as const;
  const key = `_health/${crypto.randomUUID()}`;
  try {
    await artifacts.put(key, new TextEncoder().encode("ready").buffer, {
      httpMetadata: { contentType: "text/plain" },
      customMetadata: { kind: "healthcheck" },
    });
    const object = await artifacts.get(key);
    if (!object) return "error" as const;
    await new Response(object.body).arrayBuffer();
    return "ready" as const;
  } catch {
    return "error" as const;
  } finally {
    await artifacts.delete(key).catch(() => undefined);
  }
}

async function probeCapabilityV2Launcher() {
  const endpoint = process.env.CAPABILITY_V2_RUNTIME_LAUNCHER_URL?.trim()?.replace(/\/$/, "");
  const token = process.env.CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN?.trim();
  if (!endpoint || !token) return "unavailable" as const;
  try {
    const response = await fetch(`${endpoint}/health`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok ? "ready" as const : "error" as const;
  } catch {
    return "error" as const;
  }
}

export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get("deep") === "1";
  const database = getD1Binding();
  const artifacts = getArtifactBinding();
  let taskLaunchWatchdog: "ready" | "error" = "ready";
  let expiredTaskLaunches = 0;
  try {
    const sweep = await expireStaleTaskLaunches({ database: database || undefined });
    expiredTaskLaunches = sweep.expired;
  } catch {
    taskLaunchWatchdog = "error";
  }
  let databaseStatus: "ready" | "unavailable" | "error" = database ? "ready" : "unavailable";
  if (database) {
    try {
      const result = await database.prepare("SELECT 1 AS ready").all();
      if (!result.success) databaseStatus = "error";
    } catch {
      databaseStatus = "error";
    }
  }
  const objectStorageStatus = deep ? await probeObjectStorage() : artifacts ? "ready" : "unavailable";
  const capabilityV2LauncherStatus = database?.dialect === "postgres"
    ? await probeCapabilityV2Launcher()
    : "not-required" as const;
  const runnerProjection = deep
    ? await getRunnerControlProjection({ mode: "full" }).catch(() => undefined)
    : undefined;
  const readyRunnerInstances = runnerProjection?.mode === "full"
    ? runnerProjection.instances.filter((instance) =>
      instance.desiredState === "active"
      && !["stale", "offline", "error"].includes(instance.observedState))
    : [];
  const runnerWorkKinds = runnerProjection?.mode === "full"
    ? [...new Set(readyRunnerInstances.flatMap((instance) => instance.workKinds))].sort()
    : [];
  const runnersReady = Boolean(
    runnerProjection?.mode === "full"
    && readyRunnerInstances.length > 0
    && REQUIRED_RUNNER_WORK_KINDS.every((kind) => runnerWorkKinds.includes(kind)),
  );
  const ready = databaseStatus === "ready"
    && taskLaunchWatchdog === "ready"
    && capabilityV2LauncherStatus !== "error"
    && capabilityV2LauncherStatus !== "unavailable"
    && (!deep || (objectStorageStatus === "ready" && runnersReady));
  return siteAgentJson({
    status: ready ? "ready" : "degraded",
    runtime: database?.dialect === "postgres" ? "container" : "cloudflare",
    buildSha: process.env.SITEWAKE_BUILD_SHA || process.env.SITEWAKE_BUILD_SHA || "development",
    services: {
      controlPlane: "ready",
      database: databaseStatus,
      objectStorage: objectStorageStatus,
      authoring: process.env.SITEWAKE_AUTHORING_BACKEND || process.env.SITEWAKE_AUTHORING_BACKEND || "model",
      validation: "runner",
      capabilityV2RunnerLauncher: capabilityV2LauncherStatus,
      taskLaunchWatchdog,
    },
    watchdog: {
      expiredTaskLaunches,
    },
    ...(deep ? {
      runners: {
        status: runnersReady ? "ready" : "unavailable",
        registered: readyRunnerInstances.length,
        workKinds: runnerWorkKinds,
      },
    } : {}),
    timestamp: new Date().toISOString(),
  }, ready ? 200 : 503);
}
