import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

/**
 * Capability-center-only boundary E2E.
 *
 * A is represented by the single logical CapabilityGenerationInput below.
 * Everything after that boundary is the production B -> C -> Review -> D
 * implementation: real model, database, Launcher, Runner, Chromium, Module
 * Store, deterministic C3 and AI Review. The test never dispatches a task or
 * writes a capability row directly.
 */

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
const siteId = `prestashop-boundary-${runId}`;
const prestashopUrl = "http://localhost:18081";
const reportDir = fileURLToPath(new URL(`.artifacts/capability-center-v2-boundary-e2e/${runId}/`, root));
const stateDir = join(reportDir, "local-state");
const runnerArtifactDir = join(reportDir, "runner-artifacts");
const launcherToken = `capability-boundary-${runId}`;

let controlPort;
let launcherPort;
let controlUrl;
let launcherUrl;
let controlPlane;
let runtimeLauncher;
const processLogs = [];
const dataflowEvents = [];
const seenEventIds = new Set();

function logProcess(label, command, args, env) {
  const child = spawn(command, args, { cwd: rootPath, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  for (const [stream, level] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
    stream?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      processLogs.push({ at: new Date().toISOString(), label, level, text: text.slice(0, 20_000) });
      if (process.env.SITEWAKE_BOUNDARY_E2E_VERBOSE === "1") process[level === "stderr" ? "stderr" : "stdout"].write(`[${label}] ${text}`);
    });
  }
  return child;
}

async function freePort(excluded = new Set()) {
  while (true) {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (port && !excluded.has(port)) return port;
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), delay(10_000)]);
  if (child.exitCode === null && process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    await Promise.race([once(killer, "exit"), delay(10_000)]);
  }
}

async function waitForUrl(url, headers = {}, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(3_000) });
      if (response.ok) return response.json().catch(() => ({}));
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await delay(300);
  }
  throw new Error(`service_not_ready:${url}:${lastError}`);
}

function headers(extra = {}) {
  return {
    "content-type": "application/json",
    origin: controlUrl,
    "x-sitewake-site-id": siteId,
    "x-sitewake-site-agent-id": siteId,
    ...extra,
  };
}

async function request(path, init = {}) {
  const response = await fetch(`${controlUrl}${path}`, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(JSON.stringify(value))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function io(schemaRef, value) {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  return { schemaRef, hash: fnv1a(value), bytes, value };
}

function mockBoundaryEvent(input) {
  const traceId = `generation:episode_${runId}`;
  return {
    schemaVersion: "capability-debug.v1",
    eventId: `mock-boundary-${runId}`,
    occurredAt: new Date().toISOString(),
    trace: { id: traceId, kind: "generation" },
    lifecycle: "completed",
    severity: "info",
    module: { id: "mock.boundary", phase: "input", component: "experience-api", attempt: 1 },
    correlation: { siteId, episodeId: `episode_${runId}` },
    message: "A→B MockBoundary（仅测试输入，不代表真实 AgentRun）",
    io: {
      input: io("mock.boundary.input", { source: "ModuleA", fixture: "prestashop-natural-request" }),
      output: io("mock.boundary.output", input),
    },
  };
}

async function appendDataflow(event) {
  if (!event || typeof event !== "object") return;
  const id = event.eventId || `${event.module?.id || "event"}:${event.occurredAt || Date.now()}`;
  if (seenEventIds.has(id)) return;
  seenEventIds.add(id);
  dataflowEvents.push(event);
  process.stdout.write(`[capability-dataflow] ${JSON.stringify(event)}\n`);
  await writeFile(join(reportDir, "dataflow.jsonl"), `${dataflowEvents.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

async function captureTaskEvents(taskId, stopSignal) {
  let afterSequence = 0;
  while (!stopSignal.done) {
    const result = await request(`/api/admin/capability-v2/tasks/${encodeURIComponent(taskId)}/events?siteId=${encodeURIComponent(siteId)}&afterSequence=${afterSequence}&limit=500`);
    if (result.response.ok) {
      for (const event of result.body.events || []) {
        afterSequence = Math.max(afterSequence, Number(event.sequence || 0));
        const debugEvent = event.payload?.debugEvent;
        if (debugEvent) await appendDataflow(debugEvent);
      }
    }
    await delay(500);
  }
}

async function task(taskId) {
  const result = await request(`/api/admin/capability-v2/tasks/${encodeURIComponent(taskId)}?siteId=${encodeURIComponent(siteId)}`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.task;
}

async function tasks() {
  const result = await request(`/api/admin/capability-v2/tasks?siteId=${encodeURIComponent(siteId)}&includeArchived=1`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.tasks || [];
}

async function waitTask(taskId, timeoutMs = 30 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await task(taskId);
    if (["Succeeded", "Failed", "Cancelled", "Deleted"].includes(current.status)) return current;
    await delay(1_000);
  }
  throw new Error(`boundary_task_timeout:${taskId}:${current?.status || "unknown"}`);
}

async function waitForPublishedCapability(validationTaskId, timeoutMs = 30 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    const result = await request(`/api/admin/capability-v2/capabilities?siteId=${encodeURIComponent(siteId)}`);
    if (result.response.ok) {
      latest = result.body.capabilities || [];
      if (latest.length === 1 && latest[0]?.status === "Active" && latest[0]?.currentVersionId) {
        const detail = await request(`/api/admin/capability-v2/capabilities/${encodeURIComponent(latest[0].id)}?siteId=${encodeURIComponent(siteId)}`);
        if (detail.response.ok && (detail.body.versions || []).some((version) => version.id === latest[0].currentVersionId && version.status === "Published")) {
          return { capabilities: latest, detail: detail.body };
        }
      }
    }
    const events = await request(`/api/admin/capability-v2/tasks/${encodeURIComponent(validationTaskId)}/events?siteId=${encodeURIComponent(siteId)}&limit=500`);
    for (const event of events.body.events || []) {
      if (event.eventType === "ReviewFailed") throw new Error(`boundary_review_failed:${event.payload?.reason || "unknown"}`);
      if (event.eventType === "ReviewCompleted" && event.payload?.decision === "Rejected") throw new Error(`boundary_review_rejected:${event.payload?.reason || "unknown"}`);
    }
    await delay(1_000);
  }
  throw new Error(`boundary_publish_timeout:${JSON.stringify(latest)}`);
}

async function saveTaskArtifacts(item) {
  const result = await request(`/api/admin/capability-v2/tasks/${encodeURIComponent(item.id)}/artifacts?siteId=${encodeURIComponent(siteId)}`);
  if (!result.response.ok) return;
  await writeFile(join(reportDir, `${item.id}-artifacts.json`), JSON.stringify(result.body, null, 2));
  for (const [index, ref] of (result.body.artifacts || []).entries()) {
    if (!ref.artifactId) continue;
    const response = await fetch(`${controlUrl}/api/admin/capability-v2/artifacts/${encodeURIComponent(ref.artifactId)}?siteId=${encodeURIComponent(siteId)}`, { headers: headers() });
    if (!response.ok) continue;
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const extension = contentType.includes("json") ? "json" : contentType.includes("png") ? "png" : contentType.includes("webm") ? "webm" : "bin";
    await writeFile(join(reportDir, `${item.id}-${String(index + 1).padStart(2, "0")}-${String(ref.kind || "artifact").toLowerCase()}.${extension}`), Buffer.from(await response.arrayBuffer()));
  }
}

async function debugTrace(taskId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const list = await request(`/api/admin/capability-v2/debug/traces?siteId=${encodeURIComponent(siteId)}&kind=generation&limit=100`);
    const summary = (list.body.traces || []).find((item) => item.rootTaskId === taskId);
    if (summary) {
      const detail = await request(`/api/admin/capability-v2/debug/traces/generation/${encodeURIComponent(summary.id)}?siteId=${encodeURIComponent(siteId)}`);
      if (detail.response.ok) return detail.body;
    }
    await delay(500);
  }
  throw new Error(`boundary_debug_trace_timeout:${taskId}`);
}

function validateTrace(detail) {
  assert.ok(Array.isArray(detail.nodes) && detail.nodes.length > 0, "generation trace is empty");
  assert.equal(detail.summary?.status, "succeeded", `generation trace did not settle: ${JSON.stringify(detail.summary)}`);
  const observed = detail.nodes.filter((node) => node.observed);
  assert.ok(observed.length >= 8, `expected core dataflow nodes, got ${observed.length}`);
  for (const node of observed) {
    assert.match(String(node.input?.schemaRef || ""), new RegExp(`^${node.moduleId}\\.input$`));
    assert.match(String(node.output?.schemaRef || ""), new RegExp(`^${node.moduleId}\\.output$`));
    assert.match(String(node.input?.hash || ""), /^fnv1a:[0-9a-f]{8}$/i);
    assert.match(String(node.output?.hash || ""), /^fnv1a:[0-9a-f]{8}$/i);
    assert.notEqual(node.input?.value, undefined, `${node.moduleId} input is missing`);
    assert.notEqual(node.output?.value, undefined, `${node.moduleId} output is missing`);
  }
  const review = observed.find((node) => node.moduleId === "review.ai");
  const publish = observed.find((node) => node.moduleId === "version.publish");
  assert.equal(review?.output?.value?.decision, "Approved", "AI Review receipt is missing");
  assert.equal(publish?.output?.value?.publishResult?.outcome, "Published", "D publish receipt is missing");
  return {
    traceId: detail.summary?.id,
    status: detail.summary?.status,
    observedNodeCount: observed.length,
    nodes: detail.nodes.map((node) => ({ id: node.id, moduleId: node.moduleId, state: node.state, observed: node.observed, input: node.input, output: node.output })),
  };
}

function writeReport(input, chain, trace, capabilities) {
  const boundaries = {};
  for (const event of dataflowEvents) {
    const id = event.module?.id || "unknown";
    boundaries[id] ||= { moduleId: id, first: event, last: event, count: 0 };
    boundaries[id].last = event;
    boundaries[id].count += 1;
  }
  return Promise.all([
    writeFile(join(reportDir, "input.json"), JSON.stringify(input, null, 2)),
    writeFile(join(reportDir, "module-boundaries.json"), JSON.stringify(Object.values(boundaries), null, 2)),
    writeFile(join(reportDir, "task-chain.json"), JSON.stringify(chain, null, 2)),
    writeFile(join(reportDir, "debug-trace.json"), JSON.stringify(trace, null, 2)),
    writeFile(join(reportDir, "candidate-artifact.json"), JSON.stringify(chain.discovery?.result?.candidateArtifact || chain.discovery?.result || {}, null, 2)),
    writeFile(join(reportDir, "generated-source.ts"), chain.discovery?.result?.candidateSource || ""),
    writeFile(join(reportDir, "validation-results.json"), JSON.stringify(chain.validation?.result || {}, null, 2)),
    writeFile(join(reportDir, "process-logs.json"), JSON.stringify(processLogs, null, 2)),
    writeFile(join(reportDir, "report.html"), `<!doctype html><meta charset="utf-8"><title>Capability Center Boundary E2E</title><style>body{font-family:system-ui;background:#f3f7f5;color:#18382d;max-width:1100px;margin:32px auto;padding:0 18px}section{background:#fff;padding:20px;margin:16px 0;border-radius:14px;border:1px solid #d8e8df}code,pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#067c65}</style><h1>能力中心 B→C→Review→D 真实 E2E</h1><section><p>Run: ${runId}</p><p>Site: ${siteId}</p><p>结果：${chain.discovery?.status === "Succeeded" && chain.validation?.status === "Succeeded" ? "Published" : "Failed"}</p><p>能力数：${capabilities.length}</p></section><section><h2>模块边界</h2><pre>${JSON.stringify(Object.values(boundaries).map((item) => ({ moduleId: item.moduleId, count: item.count, input: item.first.io?.input, output: item.last.io?.output })), null, 2)}</pre></section><section><h2>产物</h2><p><a href="dataflow.jsonl">dataflow.jsonl</a> · <a href="module-boundaries.json">module-boundaries.json</a> · <a href="task-chain.json">task-chain.json</a> · <a href="debug-trace.json">debug-trace.json</a> · <a href="generated-source.ts">generated-source.ts</a> · <a href="validation-results.json">validation-results.json</a></p></section>`),
  ]);
}

test("capability center boundary: real PrestaShop B→C→Review→D with only A mocked", { timeout: 45 * 60_000 }, async () => {
  await rm(reportDir, { recursive: true, force: true });
  await mkdir(runnerArtifactDir, { recursive: true });
  controlPort = await freePort();
  launcherPort = await freePort(new Set([controlPort]));
  controlUrl = `http://127.0.0.1:${controlPort}`;
  launcherUrl = `http://127.0.0.1:${launcherPort}`;
  const common = {
    ...process.env,
    SITEWAKE_LOCAL_DEV: "1",
    SITEWAKE_TEST_SUITE: "capability-center-v2-boundary-real-e2e",
    SITEWAKE_LOCAL_PERSIST_PATH: stateDir,
    WRANGLER_LOG_PATH: join(stateDir, "wrangler.log"),
    MINIFLARE_REGISTRY_PATH: join(stateDir, "registry"),
    CAPABILITY_V2_AUTO_DISPATCH: "1",
    CAPABILITY_V2_RUNTIME_CONCURRENCY: "1",
    CAPABILITY_V2_MODEL_TIMEOUT_MS: "180000",
    CAPABILITY_V2_AUTHOR_MAX_TOOL_CALLS: "48",
    CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN: "1",
    CAPABILITY_V2_CONTROL_PLANE_URL: controlUrl,
    CAPABILITY_V2_RUNTIME_LAUNCHER_PORT: String(launcherPort),
    CAPABILITY_V2_RUNTIME_LAUNCHER_URL: launcherUrl,
    CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN: launcherToken,
    CAPABILITY_V2_DISPATCH_TOKEN: process.env.CAPABILITY_V2_DISPATCH_TOKEN?.trim() || launcherToken,
    CAPABILITY_V2_ARTIFACT_DIR: runnerArtifactDir,
  };
  const input = {
    request: {
      goal: "给我找一个白色的马克杯放到购物车",
      normalizedGoal: "找白色马克杯并加入购物车",
      parameters: { query: "马克杯", color: "白色" },
      entryUrl: `${prestashopUrl}/`,
      locale: "zh-CN",
    },
    guidance: {
      derived: [{ text: "动态商品详情 URL 只能来自当前页面商品证据；不能把演示商品 URL 固化为能力入口。", basedOn: [{ kind: "episode", id: `episode_${runId}` }] }],
    },
    source: "Episode",
    experience: {
      episodeId: `episode_${runId}`,
      mode: "demonstration",
      execution: {
        startPage: { url: `${prestashopUrl}/`, title: "PrestaShop", heading: "Shop" },
        actions: [
          { action: "fill", rawAction: "在站点搜索框输入马克杯", input: { text: "马克杯", value: "马克杯" }, element: { role: "searchbox", placeholder: "Search" }, page: { url: `${prestashopUrl}/` } },
          { action: "click", rawAction: "提交搜索", input: {}, element: { role: "button", accessibleName: "Search" }, page: { url: `${prestashopUrl}/` } },
          { action: "click", rawAction: "点击当前结果中的白色马克杯商品卡片", input: {}, element: { tag: "a", contextText: "White Ceramic Mug" }, page: { url: `${prestashopUrl}/search?controller=search&s=mug` } },
          { action: "click", rawAction: "点击加入购物车", input: {}, element: { role: "button", accessibleName: "Add to cart" }, page: { url: `${prestashopUrl}/19-customizable-mug.html` } },
        ],
        endPage: { url: `${prestashopUrl}/19-customizable-mug.html`, title: "Customizable mug", heading: "Customizable mug" },
      },
      outcome: { status: "Success", summary: "白色马克杯已加入购物车", checks: [{ type: "business-output", value: "cart updated" }] },
      evidence: { observationRefs: [`observation_${runId}_1`, `observation_${runId}_2`], actionReceiptRefs: [`receipt_${runId}_1`], source: "MockBoundary" },
    },
  };
  const stopCapture = { done: false };
  await appendDataflow(mockBoundaryEvent(input));
  try {
    runtimeLauncher = logProcess("runtime-launcher", process.execPath, ["scripts/capability-v2-runtime-launcher.mjs"], common);
    await waitForUrl(`${launcherUrl}/health`, { authorization: `Bearer ${launcherToken}` });
    controlPlane = logProcess("control-plane", process.execPath, ["scripts/run-vinext.mjs", "dev", "--hostname", "127.0.0.1", "--port", String(controlPort), "--strictPort"], common);
    await waitForUrl(`${controlUrl}/api/health`);
    const preflight = await fetch(prestashopUrl, { signal: AbortSignal.timeout(10_000) });
    assert.equal(preflight.ok, true, `PrestaShop unavailable: ${preflight.status}`);
    const model = await request(`/api/site-agents/${encodeURIComponent(siteId)}/model`);
    assert.equal(model.response.status, 200, JSON.stringify(model.body));
    assert.equal(model.body.execution?.configured, true, "execution model must be configured");
    assert.equal(model.body.semantic?.configured, true, "semantic model must be configured");
    assert.doesNotMatch(`${model.body.execution?.model || ""} ${model.body.semantic?.model || ""}`, /mock|fixture/i, "real E2E forbids mock/fixture model");
    const submitted = await request("/api/capability-v2/generation", { method: "POST", body: JSON.stringify(input) });
    assert.equal(submitted.response.status, 202, JSON.stringify(submitted.body));
    assert.equal(submitted.body.disposition, "Created", JSON.stringify(submitted.body));
    assert.ok(submitted.body.task?.id, JSON.stringify(submitted.body));
    const discoveryTaskId = submitted.body.task.id;
    const capture = captureTaskEvents(discoveryTaskId, stopCapture);
    const discovery = await waitTask(discoveryTaskId);
    let all = await tasks();
    const validation = all.find((item) => item.type === "Validation" && item.rerunOfTaskId === discovery.id) || all.find((item) => item.type === "Validation" && item.versionId === discovery.versionId);
    assert.ok(validation, `Validation task not created automatically: ${JSON.stringify(all)}`);
    const validationTask = await waitTask(validation.id);
    // Validation is persisted before the synchronous Review→D continuation
    // finishes.  Do not tear down the isolated services at that intermediate
    // state: wait for the real AI Review and transactional publish to settle.
    const published = await waitForPublishedCapability(validation.id);
    stopCapture.done = true;
    await capture;
    all = await tasks();
    await saveTaskArtifacts(discovery);
    await saveTaskArtifacts(validationTask);
    assert.equal(discovery.status, "Succeeded", JSON.stringify(discovery.error || discovery.result));
    assert.equal(validationTask.status, "Succeeded", JSON.stringify(validationTask.error || validationTask.result));
    assert.equal(discovery.result?.outcome, "Success", JSON.stringify(discovery.result));
    assert.equal(validationTask.result?.outcome, "Success", JSON.stringify(validationTask.result));
    assert.notEqual(discovery.runnerId, validationTask.runnerId, "C3 must use an independent Runner");
    assert.ok((validationTask.result?.validationCaseCount || 0) >= 1);
    const trace = await debugTrace(discovery.id);
    const traceAudit = validateTrace(trace);
    const capabilities = published.capabilities;
    assert.equal(capabilities.length, 1, JSON.stringify(capabilities));
    assert.equal(capabilities[0].status, "Active");
    const detail = published.detail;
    const publishedVersion = (detail.versions || []).find((version) => version.status === "Published");
    assert.ok(publishedVersion, JSON.stringify(detail));
    assert.equal(detail.capability.currentVersionId, publishedVersion.id);
    const summary = JSON.stringify(discovery.result?.candidateSummary || {});
    assert.doesNotMatch(summary, /白色马克杯|19-customizable-mug/i, "capability summary must not freeze demonstration instance");
    const source = discovery.result?.candidateSource || "";
    assert.doesNotMatch(source, /19-customizable-mug\.html/i, "generated program must resolve dynamic product pages from evidence");
    const chain = { discovery, validation: validationTask, tasks: all, capability: detail.capability, version: publishedVersion };
    await writeReport(input, chain, { ...trace, audit: traceAudit }, capabilities);
  } catch (error) {
    stopCapture.done = true;
    throw error;
  } finally {
    await stopProcess(controlPlane);
    await stopProcess(runtimeLauncher);
    await writeFile(join(reportDir, "process-logs.json"), JSON.stringify(processLogs, null, 2)).catch(() => undefined);
  }
});
