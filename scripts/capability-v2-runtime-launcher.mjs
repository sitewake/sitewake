import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildCapabilityV2RunnerEnvironment } from "./capability-v2-runtime-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.CAPABILITY_V2_RUNTIME_LAUNCHER_PORT || 3320);
const host = process.env.CAPABILITY_V2_RUNTIME_LAUNCHER_HOST?.trim() || "127.0.0.1";
const sharedToken = process.env.CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN?.trim() || "";
const dispatchToken = process.env.CAPABILITY_V2_DISPATCH_TOKEN?.trim() || "";
const controlPlaneUrl = process.env.CAPABILITY_V2_CONTROL_PLANE_URL?.trim()?.replace(/\/$/, "") || "";
if (!sharedToken) throw new Error("CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN is required");
if (!dispatchToken) throw new Error("CAPABILITY_V2_DISPATCH_TOKEN is required");
if (!controlPlaneUrl) throw new Error("CAPABILITY_V2_CONTROL_PLANE_URL is required");
const MAX_REQUEST_BYTES = 64 * 1024;
const dispatchIntervalMs = Math.max(1_000, Number(process.env.CAPABILITY_V2_DISPATCH_INTERVAL_MS || 5_000));
const concurrency = Math.max(1, Number(process.env.CAPABILITY_V2_RUNTIME_CONCURRENCY || 1));
const children = new Map();
let dispatchTimer;
let dispatching = false;
let learningDispatchAt = 0;
const MAX_RUNNER_DIAGNOSTIC_BYTES = 4_000;

async function dispatchControlPlaneQueues() {
  if (Date.now() - learningDispatchAt < 2_000) return;
  learningDispatchAt = Date.now();
  try {
    const response = await fetch(`${controlPlaneUrl}/api/internal/learning-dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${dispatchToken}` },
      // The caller has to be at least as patient as the work it asks for. This
      // dispatch turns a finished run into a capability goal, which waits on
      // two model calls in series; sixty seconds cut that off mid-way and the
      // console reported the caller's impatience as the reason the capability
      // could not be made.
      signal: AbortSignal.timeout(240_000),
    });
    if (!response.ok) {
      console.warn(`[capability-v2-runtime-launcher] learning dispatch failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
    } else {
      await response.arrayBuffer();
    }
  } catch (error) {
    console.warn(`[capability-v2-runtime-launcher] learning dispatch unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function authorized(request) {
  return request.headers.authorization === `Bearer ${sharedToken}`;
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function bodyOf(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw Object.assign(new Error("runtime_launcher_request_too_large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function appendRunnerOutput(handle, chunk, stream) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  if (handle.diagnosticOutput.length < MAX_RUNNER_DIAGNOSTIC_BYTES) {
    handle.diagnosticOutput += text.slice(0, MAX_RUNNER_DIAGNOSTIC_BYTES - handle.diagnosticOutput.length);
  }
  stream.write(chunk);
}

async function reportRunnerExit(handle, code, signal) {
  if (handle.terminating || handle.reportedExit || (code === 0 && !signal)) return;
  handle.reportedExit = true;
  const suffix = signal ? `signal=${signal}` : `code=${code ?? "unknown"}`;
  const detail = handle.diagnosticOutput.trim().replace(/\s+/g, " ").slice(0, 2_000);
  const reason = `runner_process_exited:${suffix}${detail ? `:${detail}` : ""}`;
  try {
    const response = await fetch(`${controlPlaneUrl}/api/internal/capability-v2/tasks/${encodeURIComponent(handle.taskId)}/runner/failed`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sitewake-site-id": handle.siteId,
        "x-capability-runner-id": handle.runnerId,
        authorization: `Bearer ${handle.runnerToken}`,
      },
      body: JSON.stringify({ siteId: handle.siteId, runnerId: handle.runnerId, reason }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) console.warn(`[capability-v2-runtime-launcher] runner failure report failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  } catch (error) {
    console.warn(`[capability-v2-runtime-launcher] runner failure report unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function launch(input) {
  const existing = children.get(input.runnerId);
  if (existing) return { runnerId: input.runnerId, pid: existing.child.pid, reused: true };
  if (children.size >= concurrency) throw Object.assign(new Error("runtime_launcher_capacity_exhausted"), { status: 503 });
  const script = resolve(root, "runner/capability-v2/process-runner.ts");
  const tsxCli = resolve(root, "node_modules/tsx/dist/cli.mjs");
  const child = spawn(process.execPath, [tsxCli, script], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: buildCapabilityV2RunnerEnvironment(input),
    windowsHide: true,
  });
  const handle = { child, siteId: input.siteId, taskId: input.taskId, runnerId: input.runnerId, runnerToken: input.runnerToken, diagnosticOutput: "", terminating: false, reportedExit: false };
  children.set(input.runnerId, handle);
  child.stdout?.on("data", (chunk) => appendRunnerOutput(handle, chunk, process.stdout));
  child.stderr?.on("data", (chunk) => appendRunnerOutput(handle, chunk, process.stderr));
  child.once("close", (code, signal) => {
    children.delete(input.runnerId);
    void reportRunnerExit(handle, code, signal);
    scheduleDispatch(0);
  });
  return { runnerId: input.runnerId, pid: child.pid, reused: false };
}

async function terminate(input) {
  const handle = children.get(input.runnerId);
  if (!handle || handle.child.killed) return { runnerId: input.runnerId, terminated: false };
  handle.terminating = true;
  handle.child.kill("SIGTERM");
  await new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      if (!handle.child.killed) handle.child.kill("SIGKILL");
      resolvePromise();
    }, 5_000);
    handle.child.once("exit", () => { clearTimeout(timer); resolvePromise(); });
  });
  return { runnerId: input.runnerId, terminated: true };
}

const server = http.createServer(async (request, response) => {
  if (!authorized(request)) return send(response, 401, { error: "runtime_launcher_unauthorized" });
  if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true, activeRunners: children.size });
  if (request.method !== "POST" || !["/launch", "/terminate"].includes(request.url || "")) return send(response, 404, { error: "runtime_launcher_route_not_found" });
  try {
    const input = await bodyOf(request);
    for (const key of ["siteId", "taskId", "runnerId"]) if (typeof input[key] !== "string" || !input[key]) return send(response, 400, { error: `${key}_required` });
    if (input.taskType !== undefined && !["Discovery", "Repair", "Validation"].includes(input.taskType)) return send(response, 400, { error: "runtime_task_type_invalid" });
    if (request.url === "/launch" && typeof input.runnerToken !== "string") return send(response, 400, { error: "runner_token_required" });
    return send(response, 202, request.url === "/launch" ? launch(input) : await terminate(input));
  } catch (error) {
    const status = Number(error?.status) || 500;
    return send(response, status, { error: "runtime_launcher_failed", message: error instanceof Error ? error.message : String(error) });
  }
});

function scheduleDispatch(delay = dispatchIntervalMs) {
  if (!controlPlaneUrl || !dispatchToken || dispatchTimer) return;
  dispatchTimer = setTimeout(() => {
    dispatchTimer = undefined;
    void dispatchPending();
  }, delay);
}

async function dispatchPending() {
  if (dispatching || children.size >= concurrency) return scheduleDispatch();
  dispatching = true;
  try {
    // This always-on container is the compact deployment's control-plane
    // scheduler. Advance evidence/effect/outbox queues even when the optional
    // Playwright authoring worker is stopped.
    const [response] = await Promise.all([
      fetch(`${controlPlaneUrl}/api/internal/capability-v2/dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${dispatchToken}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      }),
      dispatchControlPlaneQueues(),
    ]);
    if (response.status !== 202 && response.status !== 404) {
      const payload = await response.text();
      console.warn(`[capability-v2-runtime-launcher] dispatch failed: ${response.status} ${payload.slice(0, 300)}`);
    }
  } catch (error) {
    console.warn(`[capability-v2-runtime-launcher] dispatch unavailable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    dispatching = false;
    scheduleDispatch(children.size < concurrency ? dispatchIntervalMs : dispatchIntervalMs * 2);
  }
}

server.listen(port, host, () => {
  console.log(`[capability-v2-runtime-launcher] listening on http://${host}:${port}`);
  scheduleDispatch(0);
});

function shutdown() {
  if (dispatchTimer) clearTimeout(dispatchTimer);
  for (const handle of children.values()) handle.child.kill("SIGTERM");
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
