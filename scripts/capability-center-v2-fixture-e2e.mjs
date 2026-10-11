import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Capability-center-only fixture E2E.
 *
 * The JSON files in tests/fixtures/capability-generation-inputs are the only
 * mocked boundary.  Every operation after POST /api/capability-v2/generation
 * uses the production B -> C -> C3 -> Review -> D implementation.
 */

const rootPath = fileURLToPath(new URL("../", import.meta.url));
const fixtureDir = join(rootPath, "tests", "fixtures", "capability-generation-inputs");
const artifactRoot = join(rootPath, ".artifacts", "capability-center-v2-fixture-e2e");
const manifestPath = join(fixtureDir, "manifest.json");
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
const runRoot = join(artifactRoot, "runs", runId);
const runMarker = join(artifactRoot, ".running");

const cli = new Map(process.argv.slice(2).map((arg, index, values) => {
  if (!arg.startsWith("--")) return [String(index), arg];
  const [key, inline] = arg.slice(2).split("=", 2);
  const next = inline ?? (values[index + 1] && !values[index + 1].startsWith("--") ? values[index + 1] : undefined);
  return [key, next ?? true];
}));
const mode = cli.has("validate") ? "validate" : "run";
const selectedCase = typeof cli.get("case") === "string" ? String(cli.get("case")) : undefined;
const keepServices = cli.has("keep-services");

let controlPort;
let launcherPort;
let controlUrl;
let launcherUrl;
let controlPlane;
let runtimeLauncher;
const processLogs = [];

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || "case";
}

function replaceTokens(value, tokens) {
  if (typeof value === "string") {
    return value.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key) => tokens[key] ?? `{{${key}}}`);
  }
  if (Array.isArray(value)) return value.map((item) => replaceTokens(item, tokens));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTokens(item, tokens)]));
  return value;
}

function collectKeys(value, path = "$", result = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectKeys(item, `${path}[${index}]`, result));
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) {
    result.push({ key, path: `${path}.${key}` });
    collectKeys(item, `${path}.${key}`, result);
  }
  return result;
}

const forbiddenInputKeys = new Set([
  "capabilitySeed",
  "contract",
  "program",
  "validationCases",
  "candidateArtifact",
  "candidateSource",
  "capabilityId",
  "versionId",
  "generationTaskId",
]);

async function loadManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.ok(manifest.schema === "CapabilityGenerationInput" || manifest.schemaVersion === "capability-center-v2-fixture-manifest.v1");
  assert.ok(Array.isArray(manifest.cases) && manifest.cases.length >= 10, "fixture manifest must contain at least ten cases");
  const cases = manifest.cases.map((raw) => {
    const id = raw.id || String(raw.file || "").replace(/\.json$/i, "");
    const terminal = String(raw.terminal || "");
    const rejected = raw.errorCode || String(raw.assertAtB || "").includes("Rejected");
    const expectation = typeof raw.expectation === "string"
      ? raw.expectation
      : rejected
      ? "HttpError"
      : id === "07-episode-duplicate-synonym"
        ? "Duplicate"
        : id === "08-episode-duplicate-broader"
          ? "DuplicateOrPublished"
          : terminal.includes("or") || terminal.includes("acceptable")
            ? "PublishedOrFailed"
            : terminal.startsWith("Published")
              ? "Published"
              : "TaskFailed";
    const dependency = Array.isArray(raw.requires) && raw.requires.length ? String(raw.requires[0]).replace(/\.json$/i, "") : undefined;
    return {
      ...raw,
      id,
      title: raw.title || raw.focus || id,
      expectation,
      siteGroup: raw.siteGroup || dependency || id,
    };
  });
  return { ...manifest, cases };
}

async function loadFixture(spec) {
  const file = String(spec.file || "");
  assert.match(file, /^[a-z0-9][a-z0-9._-]+\.json$/i, `${spec.id}: fixture filename is unsafe`);
  const fixturePath = resolve(fixtureDir, file);
  assert.ok(fixturePath.startsWith(`${resolve(fixtureDir)}${sep}`), `${spec.id}: fixture escaped fixture directory`);
  const input = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.ok(input.source === "Episode" || input.source === "Admin", `${spec.id}: fixture source must be Episode or Admin`);
  assert.ok(input.request && typeof input.request === "object", `${spec.id}: request is required`);
  const forbidden = collectKeys(input).filter(({ key }) => forbiddenInputKeys.has(key));
  assert.deepEqual(forbidden, [], `${spec.id}: input contains post-B data: ${JSON.stringify(forbidden)}`);
  if (spec.inputValid !== false && input.source === "Episode") {
    assert.ok(input.experience && typeof input.experience === "object", `${spec.id}: experience is required`);
    assert.ok(input.experience.execution && typeof input.experience.execution === "object", `${spec.id}: execution is required`);
    assert.ok(input.experience.outcome && typeof input.experience.outcome === "object", `${spec.id}: outcome is required`);
    assert.ok(input.experience.evidence && typeof input.experience.evidence === "object", `${spec.id}: evidence is required`);
  }
  if (spec.inputValid !== false && input.source === "Admin") {
    assert.ok(input.instruction && ["create", "repair", "rebuild"].includes(input.instruction.operation), `${spec.id}: Admin instruction is required`);
  }
  return input;
}

async function validateFixtures() {
  const manifest = await loadManifest();
  const ids = new Set();
  const files = new Set();
  for (const spec of manifest.cases) {
    assert.ok(spec.id && !ids.has(spec.id), `duplicate fixture id: ${spec.id}`);
    assert.ok(spec.file && !files.has(spec.file), `duplicate fixture file: ${spec.file}`);
    ids.add(spec.id);
    files.add(spec.file);
    await loadFixture(spec);
    assert.ok(["Published", "Duplicate", "DuplicateOrPublished", "PublishedOrFailed", "HttpError", "TaskFailed"].includes(spec.expectation), `${spec.id}: unsupported expectation`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, fixtureCount: manifest.cases.length, directory: fixtureDir }, null, 2)}\n`);
  return manifest;
}

async function freePort(excluded = new Set()) {
  while (true) {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    if (port && !excluded.has(port)) return port;
  }
}

function logProcess(label, command, args, env) {
  const child = spawn(command, args, { cwd: rootPath, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  for (const [stream, level] of [[child.stdout, "stdout"], [child.stderr, "stderr"]]) {
    stream?.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      processLogs.push({ at: new Date().toISOString(), label, level, text: text.slice(0, 20_000) });
      if (process.env.SITEWAKE_FIXTURE_E2E_VERBOSE === "1") process[level === "stderr" ? "stderr" : "stdout"].write(`[${label}] ${text}`);
    });
  }
  return child;
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
  throw new Error(`fixture_service_not_ready:${url}:${lastError}`);
}

function headers(siteId, extra = {}) {
  return {
    "content-type": "application/json",
    origin: controlUrl,
    "x-sitewake-site-id": siteId,
    "x-sitewake-site-agent-id": siteId,
    ...extra,
  };
}

async function request(siteId, path, init = {}) {
  const response = await fetch(`${controlUrl}${path}`, { ...init, headers: { ...headers(siteId), ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function getTask(siteId, taskId) {
  const result = await request(siteId, `/api/capability-v2/tasks/${encodeURIComponent(taskId)}?siteId=${encodeURIComponent(siteId)}`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.task;
}

async function listTasks(siteId) {
  const result = await request(siteId, `/api/capability-v2/tasks?siteId=${encodeURIComponent(siteId)}&includeArchived=1`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.tasks || [];
}

async function listCapabilities(siteId) {
  const result = await request(siteId, `/api/admin/capability-v2/capabilities?siteId=${encodeURIComponent(siteId)}`);
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body.capabilities || [];
}

/**
 * Inventory both the capability row and its published-version rows.  A
 * failed/duplicate boundary must be fail-closed: comparing only the list
 * summary can miss a version row attached to an existing capability.
 */
async function capabilityInventory(siteId) {
  const capabilities = await listCapabilities(siteId);
  const inventory = [];
  for (const item of capabilities) {
    const detail = await request(siteId, `/api/admin/capability-v2/capabilities/${encodeURIComponent(item.id)}?siteId=${encodeURIComponent(siteId)}`);
    assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
    inventory.push({
      id: item.id,
      status: item.status,
      currentVersionId: item.currentVersionId || null,
      versionIds: (detail.body.versions || []).map((version) => version.id).filter(Boolean).sort(),
    });
  }
  return JSON.stringify(inventory.sort((left, right) => left.id.localeCompare(right.id)));
}

function capabilitySnapshot(capabilities) {
  return JSON.stringify(capabilities
    .map((item) => ({ id: item.id, status: item.status, currentVersionId: item.currentVersionId || null }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

async function waitForTerminalTask(siteId, taskId, timeoutMs = 35 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  while (Date.now() < deadline) {
    current = await getTask(siteId, taskId);
    if (["Succeeded", "Failed", "Cancelled", "Deleted"].includes(current.status)) return current;
    await delay(1_000);
  }
  throw new Error(`fixture_task_timeout:${taskId}:${current?.status || "unknown"}`);
}

async function waitForPublished(siteId, timeoutMs = 35 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    const result = await request(siteId, `/api/admin/capability-v2/capabilities?siteId=${encodeURIComponent(siteId)}`);
    if (result.response.ok) {
      latest = result.body.capabilities || [];
      const active = latest.find((item) => item.status === "Active" && item.currentVersionId);
      if (active) {
        const detail = await request(siteId, `/api/admin/capability-v2/capabilities/${encodeURIComponent(active.id)}?siteId=${encodeURIComponent(siteId)}`);
        if (detail.response.ok && (detail.body.versions || []).some((version) => version.id === active.currentVersionId && version.status === "Published")) return { list: latest, detail: detail.body };
      }
    }
    await delay(1_000);
  }
  throw new Error(`fixture_publish_timeout:${JSON.stringify(latest)}`);
}

async function getGenerationTrace(siteId, taskId) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const list = await request(siteId, `/api/admin/capability-v2/debug/traces?siteId=${encodeURIComponent(siteId)}&kind=generation&limit=100`);
    const summary = (list.body.traces || []).find((item) => item.rootTaskId === taskId);
    if (summary) {
      const detail = await request(siteId, `/api/admin/capability-v2/debug/traces/generation/${encodeURIComponent(summary.id)}?siteId=${encodeURIComponent(siteId)}`);
      if (detail.response.ok) return detail.body;
    }
    await delay(500);
  }
  throw new Error(`fixture_trace_timeout:${taskId}`);
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(JSON.stringify(value))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function boundaryEvent(input, siteId, caseId) {
  const output = { source: input.source, request: input.request, ...(input.source === "Episode" ? { experience: input.experience } : { instruction: input.instruction }) };
  const envelope = (schemaRef, value) => ({ schemaRef, hash: fnv1a(value), bytes: Buffer.byteLength(JSON.stringify(value)), value });
  return {
    schemaVersion: "capability-debug.v1",
    eventId: `fixture-boundary-${runId}-${caseId}`,
    occurredAt: new Date().toISOString(),
    trace: { id: `generation:fixture:${runId}:${caseId}`, kind: "generation" },
    lifecycle: "completed",
    severity: "info",
    module: { id: "mock.boundary", phase: "input", component: "fixture-runner", attempt: 1 },
    correlation: { siteId, episodeId: input.experience?.episodeId },
    message: input.source === "Episode" ? "A→B MockBoundary（Fixture）" : "Admin→B Fixture Boundary",
    io: { input: envelope("mock.boundary.input", { source: input.source }), output: envelope("mock.boundary.output", output) },
  };
}

function auditTrace(trace, caseId, requirePublishedPath = false) {
  const observed = (trace.nodes || []).filter((node) => node.observed);
  for (const node of observed) {
    assert.match(String(node.input?.schemaRef || ""), new RegExp(`^${node.moduleId}\\.input$`), `${caseId}: ${node.moduleId} input schema missing`);
    assert.match(String(node.output?.schemaRef || ""), new RegExp(`^${node.moduleId}\\.output$`), `${caseId}: ${node.moduleId} output schema missing`);
    assert.match(String(node.input?.hash || ""), /^fnv1a:[0-9a-f]{8}$/i, `${caseId}: ${node.moduleId} input hash missing`);
    assert.match(String(node.output?.hash || ""), /^fnv1a:[0-9a-f]{8}$/i, `${caseId}: ${node.moduleId} output hash missing`);
  }
  if (requirePublishedPath) {
    const required = [
      "experience.abstract", "semantic.analyze", "dependency.ledger", "scope.resolve", "seed.build",
      "capability.classify", "capability.dedupe", "task.create", "runspec.build", "runner.dispatch",
      "runner.preflight", "browser.explore", "contract.design", "program.author", "module.persist",
      "draft.replay", "quality.gate", "case.generate-compile", "validation.create", "validation.replay",
      "validation.judge", "review.ai", "version.publish",
    ];
    const observedIds = new Set(observed.map((node) => node.id));
    const missing = required.filter((id) => !observedIds.has(id));
    assert.deepEqual(missing, [], `${caseId}: published trace is missing observed nodes: ${missing.join(", ")}`);
  }
  return { status: trace.summary?.status, nodeCount: trace.nodes?.length || 0, observedNodeCount: observed.length };
}

function assertC3TraceHasNoCredentials(trace, caseId) {
  const forbidden = /^(apiKey|api_key|modelApiKey|model_api_key|authorization|cookie|password|accessToken|access_token|baseUrl|base_url)$/i;
  const validationNodes = (trace.nodes || []).filter((node) => ["validation.replay", "validation.judge"].includes(node.id));
  assert.ok(validationNodes.length >= 2, `${caseId}: C3 trace nodes are missing`);
  for (const node of validationNodes) {
    assert.equal(node.component, "runner", `${caseId}: C3 node ${node.id} must run in the Runner`);
    const visit = (value, path = node.id) => {
      if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${path}[${index}]`));
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        assert.ok(!forbidden.test(key), `${caseId}: C3 trace leaked credential field ${path}.${key}`);
        visit(child, `${path}.${key}`);
      }
    };
    visit(node.input?.value);
    visit(node.output?.value);
  }
}

function dataflowLines(result) {
  const lines = [];
  if (result.boundary?.io) {
    lines.push({
      occurredAt: result.boundary.occurredAt,
      traceId: result.boundary.trace?.id,
      module: result.boundary.module?.id || "mock.boundary",
      node: result.boundary.module?.id || "mock.boundary",
      lifecycle: result.boundary.lifecycle,
      durationMs: 0,
      correlation: result.boundary.correlation,
      input: result.boundary.io.input,
      output: result.boundary.io.output,
      mockBoundary: true,
    });
  }
  for (const node of result.trace?.nodes || []) {
    lines.push({
      occurredAt: node.completedAt || node.startedAt || result.trace?.summary?.updatedAt,
      traceId: result.trace?.summary?.id,
      module: node.moduleId || node.id,
      node: node.id || node.moduleId,
      lifecycle: node.state,
      durationMs: Number(node.durationMs || 0),
      correlation: node.correlation,
      observed: node.observed === true,
      dataQuality: node.dataQuality,
      input: node.input || null,
      output: node.output || null,
      evidence: node.evidence || null,
      ...(node.error || node.failure ? { failure: node.error || node.failure } : {}),
    });
  }
  return lines;
}

function dataflowLineKey(line) {
  return JSON.stringify([
    line.traceId || "",
    line.node || "",
    line.lifecycle || "",
    line.input?.hash || "",
    line.output?.hash || "",
    line.failure?.code || "",
  ]);
}

async function appendLiveDataflow(caseId, line) {
  const caseDir = join(runRoot, "cases", caseId);
  await mkdir(caseDir, { recursive: true });
  const payload = { ...line, live: true };
  const serialized = `${JSON.stringify(payload)}\n`;
  await appendFile(join(runRoot, "dataflow.jsonl"), serialized);
  await appendFile(join(caseDir, "dataflow.jsonl"), serialized);
  process.stdout.write(`[dataflow] ${serialized}`);
}

async function appendMissingDataflow(filePath, lines) {
  let existing = "";
  try { existing = await readFile(filePath, "utf8"); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const keys = new Set(existing.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [dataflowLineKey(JSON.parse(line))]; } catch { return []; }
  }));
  const missing = lines.filter((line) => {
    const key = dataflowLineKey(line);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  if (missing.length) await appendFile(filePath, `${missing.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

/**
 * Poll the real Debug Trace while a task is running. This is intentionally a
 * read-only observer: it never dispatches or advances a task. Each node state
 * transition is printed and appended immediately, while the final report is
 * later completed with any missing terminal snapshots.
 */
async function streamGenerationTrace(siteId, taskId, caseId, timeoutMs = 40 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  const seen = new Set();
  let latest;
  while (Date.now() < deadline) {
    try {
      const list = await request(siteId, `/api/admin/capability-v2/debug/traces?siteId=${encodeURIComponent(siteId)}&kind=generation&limit=100`);
      const summary = (list.body.traces || []).find((item) => item.rootTaskId === taskId);
      if (summary) {
        const detail = await request(siteId, `/api/admin/capability-v2/debug/traces/generation/${encodeURIComponent(summary.id)}?siteId=${encodeURIComponent(siteId)}`);
        if (detail.response.ok) {
          latest = detail.body;
          for (const line of dataflowLines({ trace: latest })) {
            const key = dataflowLineKey(line);
            if (seen.has(key)) continue;
            seen.add(key);
            await appendLiveDataflow(caseId, line);
          }
          if (["succeeded", "failed", "cancelled"].includes(String(latest.summary?.status || "").toLowerCase())) return latest;
        }
      }
    } catch (error) {
      // The observer must never change the task outcome. Keep polling unless
      // the task itself reaches a terminal state through the normal API.
      if (process.env.SITEWAKE_FIXTURE_E2E_VERBOSE === "1") process.stderr.write(`[dataflow] observer: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    await delay(1_000);
  }
  return latest;
}

function compactTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    type: task.type,
    status: task.status,
    siteId: task.siteId,
    versionId: task.versionId,
    runnerId: task.runnerId,
    rerunOfTaskId: task.rerunOfTaskId,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    ...(task.error ? { error: task.error } : {}),
    ...(task.result ? { result: task.result } : {}),
  };
}

function taskChain(result) {
  return {
    caseId: result.caseId,
    siteId: result.siteId,
    expectation: result.expectation,
    outcome: result.outcome,
    submitted: compactTask(result.submitted?.task),
    discovery: compactTask(result.discovery),
    validation: compactTask(result.validation),
    capability: result.capability ? { id: result.capability.id, status: result.capability.status, currentVersionId: result.capability.currentVersionId } : null,
    version: result.version ? { id: result.version.id, capabilityId: result.version.capabilityId, status: result.version.status, review: result.version.review } : null,
  };
}

function moduleBoundaryReport(result) {
  return {
    caseId: result.caseId,
    traceId: result.trace?.summary?.id || result.boundary?.trace?.id,
    status: result.trace?.summary?.status || result.outcome,
    boundaries: (result.trace?.nodes || []).map((node) => ({
      id: node.id,
      moduleId: node.moduleId,
      phase: node.phase,
      component: node.component,
      state: node.state,
      observed: node.observed === true,
      input: node.input ? { schemaRef: node.input.schemaRef, hash: node.input.hash, bytes: node.input.bytes } : null,
      output: node.output ? { schemaRef: node.output.schemaRef, hash: node.output.hash, bytes: node.output.bytes } : null,
      correlation: node.correlation,
    })),
  };
}

async function saveCaseReport(spec, siteId, input, result) {
  const caseDir = join(runRoot, "cases", spec.id);
  await mkdir(caseDir, { recursive: true });
  await writeFile(join(caseDir, "input.json"), JSON.stringify(input, null, 2));
  await writeFile(join(caseDir, "result.json"), JSON.stringify(result, null, 2));
  if (result.boundary) await writeFile(join(caseDir, "mock-boundary.json"), JSON.stringify(result.boundary, null, 2));
  if (result.trace) await writeFile(join(caseDir, "debug-trace.json"), JSON.stringify(result.trace, null, 2));
  await appendMissingDataflow(join(caseDir, "dataflow.jsonl"), dataflowLines(result));
  await writeFile(join(caseDir, "task-chain.json"), JSON.stringify(taskChain(result), null, 2));
  await writeFile(join(caseDir, "module-boundaries.json"), JSON.stringify(moduleBoundaryReport(result), null, 2));
  const candidateArtifact = result.discovery?.result?.candidateArtifact || result.validation?.result?.candidateArtifact;
  if (candidateArtifact) await writeFile(join(caseDir, "candidate-artifact.json"), JSON.stringify(candidateArtifact, null, 2));
  const validationResult = result.validation?.result;
  if (validationResult) await writeFile(join(caseDir, "validation-results.json"), JSON.stringify(validationResult, null, 2));
  const generatedSource = result.discovery?.result?.candidateSource;
  if (typeof generatedSource === "string" && generatedSource.trim()) await writeFile(join(caseDir, "generated-source.ts"), generatedSource);
  const title = `${spec.id} · ${spec.title || spec.file}`;
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font-family:system-ui;max-width:1100px;margin:32px auto;padding:0 18px;background:#f4f7f6;color:#173a30}section{background:#fff;padding:18px;margin:14px 0;border:1px solid #d8e7e0;border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere}code{color:#075f4b}</style><h1>${title}</h1><section><p>siteId: <code>${siteId}</code></p><p>期望：${spec.expectation}</p><p>实际：${result.outcome || result.error || "unknown"}</p></section><section><h2>结果</h2><pre>${JSON.stringify(result, null, 2)}</pre></section>`;
  await writeFile(join(caseDir, "report.html"), html);
}

async function runCase(spec, rawInput, counters) {
  const group = slug(spec.siteGroup || spec.id);
  const siteId = `ccfixture-${slug(runId)}-${group}`.slice(0, 120);
  const tokens = { RUN_ID: runId, SITE_ID: siteId, EPISODE_ID: `episode_${runId}_${slug(spec.id)}` };
  const input = replaceTokens(rawInput, tokens);
  const beforeTasks = await listTasks(siteId);
  const beforeCapabilities = await listCapabilities(siteId);
  const beforeCapabilityInventory = await capabilityInventory(siteId);
  const boundary = boundaryEvent(input, siteId, spec.id);
  await appendLiveDataflow(spec.id, dataflowLines({ boundary })[0]);
  const submitted = await request(siteId, "/api/capability-v2/generation", { method: "POST", body: JSON.stringify(input) });
  const result = { caseId: spec.id, title: spec.title, siteId, expectation: spec.expectation, boundary, submittedStatus: submitted.response.status, submitted: submitted.body };
  const parseInventory = (value) => {
    try { return JSON.parse(value); } catch { return value; }
  };
  const captureSideEffects = async () => {
    const after = await capabilityInventory(siteId);
    result.sideEffects = {
      capabilityVersionInventoryBefore: parseInventory(beforeCapabilityInventory),
      capabilityVersionInventoryAfter: parseInventory(after),
      capabilityVersionInventoryChanged: after !== beforeCapabilityInventory,
    };
    return after;
  };
  const assertNoCapabilitySideEffect = async (message) => {
    const after = await captureSideEffects();
    assert.equal(after, beforeCapabilityInventory, `${spec.id}: ${message}`);
  };

  if (spec.expectation === "HttpError") {
    assert.ok(submitted.response.status >= 400, `${spec.id}: expected HTTP error, got ${submitted.response.status}`);
    if (spec.errorCode) assert.equal(submitted.body.error, spec.errorCode, `${spec.id}: error code mismatch`);
    const afterTasks = await listTasks(siteId);
    assert.equal(afterTasks.length, beforeTasks.length, `${spec.id}: rejected input must not create a task`);
    assert.equal(capabilitySnapshot(await listCapabilities(siteId)), capabilitySnapshot(beforeCapabilities), `${spec.id}: rejected input changed capabilities`);
    await assertNoCapabilitySideEffect("rejected input changed capability/version inventory");
    result.outcome = "HttpError";
    await saveCaseReport(spec, siteId, input, result);
    counters.httpErrors += 1;
    return result;
  }

  if (spec.expectation === "Duplicate") {
    assert.equal(submitted.response.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.disposition, "Duplicate", JSON.stringify(submitted.body));
    const afterTasks = await listTasks(siteId);
    assert.equal(afterTasks.length, beforeTasks.length, `${spec.id}: duplicate must not create a task`);
    assert.equal(capabilitySnapshot(await listCapabilities(siteId)), capabilitySnapshot(beforeCapabilities), `${spec.id}: duplicate changed capabilities`);
    await assertNoCapabilitySideEffect("duplicate changed capability/version inventory");
    result.outcome = "Duplicate";
    await saveCaseReport(spec, siteId, input, result);
    counters.duplicates += 1;
    return result;
  }

  if (spec.expectation === "DuplicateOrPublished" && submitted.response.status === 200 && submitted.body.disposition === "Duplicate") {
    const afterTasks = await listTasks(siteId);
    assert.equal(afterTasks.length, beforeTasks.length, `${spec.id}: duplicate must not create a task`);
    assert.equal(capabilitySnapshot(await listCapabilities(siteId)), capabilitySnapshot(beforeCapabilities), `${spec.id}: duplicate changed capabilities`);
    await assertNoCapabilitySideEffect("duplicate changed capability/version inventory");
    result.outcome = "Duplicate";
    await saveCaseReport(spec, siteId, input, result);
    counters.duplicates += 1;
    return result;
  }

  assert.equal(submitted.response.status, 202, JSON.stringify(submitted.body));
  assert.equal(submitted.body.disposition, "Created", JSON.stringify(submitted.body));
  const traceStream = streamGenerationTrace(siteId, submitted.body.task.id, spec.id);
  const discovery = await waitForTerminalTask(siteId, submitted.body.task.id);
  result.discovery = discovery;
  result.outcome = discovery.status === "Succeeded" ? "Succeeded" : "TaskFailed";
  const mayPublish = ["Published", "DuplicateOrPublished", "PublishedOrFailed"].includes(spec.expectation);
  if (mayPublish && discovery.status === "Succeeded") {
    assert.equal(discovery.status, "Succeeded", JSON.stringify(discovery.error || discovery.result));
    const all = await listTasks(siteId);
    const validationEntry = all.find((item) => item.type === "Validation" && item.rerunOfTaskId === discovery.id)
      || all.find((item) => item.type === "Validation" && item.versionId === discovery.versionId);
    assert.ok(validationEntry, `${spec.id}: automatic Validation task missing`);
    const validation = await waitForTerminalTask(siteId, validationEntry.id);
    assert.notEqual(validation.runnerId, discovery.runnerId, `${spec.id}: C3 must use an independent Runner`);
    result.validation = validation;
    if (validation.status === "Succeeded") {
      const published = await waitForPublished(siteId);
      result.capability = published.detail.capability;
      result.version = (published.detail.versions || []).find((item) => item.id === published.detail.capability.currentVersionId);
      assert.equal(result.version?.status, "Published");
      assert.equal(result.version?.review?.ai?.status, "Approved");
      result.outcome = "Published";
      counters.published += 1;
    } else if (spec.expectation === "PublishedOrFailed") {
      result.outcome = "TaskFailed";
      result.failure = validation.error || validation.result || null;
      await assertNoCapabilitySideEffect("failed validation created a capability/version");
      counters.taskFailures += 1;
    } else {
      assert.equal(validation.status, "Succeeded", JSON.stringify(validation.error || validation.result));
    }
  } else if (spec.expectation === "PublishedOrFailed" && discovery.status === "Failed") {
    assert.equal(discovery.status, "Failed", `${spec.id}: failure branch must be terminal`);
    result.outcome = "TaskFailed";
    result.failure = discovery.error || discovery.result || null;
    await assertNoCapabilitySideEffect("failed discovery created a capability/version");
    counters.taskFailures += 1;
  } else if (spec.expectation === "Published" || spec.expectation === "DuplicateOrPublished") {
    result.trace = await traceStream.catch(() => undefined) || await getGenerationTrace(siteId, discovery.id).catch(() => undefined);
    if (result.trace) result.traceAudit = auditTrace(result.trace, spec.id);
    await assertNoCapabilitySideEffect("unexpected failed discovery changed capability/version inventory");
    await saveCaseReport(spec, siteId, input, result);
    assert.equal(discovery.status, "Succeeded", `${spec.id}: expected a successful discovery/publish path`);
    throw new Error(`${spec.id}: unreachable publish assertion`);
  } else {
    assert.equal(discovery.status, "Failed", `${spec.id}: expected task failure`);
    await assertNoCapabilitySideEffect("failed task created a capability/version");
    counters.taskFailures += 1;
  }
  result.trace = await traceStream.catch(() => undefined) || await getGenerationTrace(siteId, discovery.id);
  result.traceAudit = auditTrace(result.trace, spec.id, result.outcome === "Published");
  if (result.outcome === "Published") assertC3TraceHasNoCredentials(result.trace, spec.id);
  if (!result.sideEffects) await captureSideEffects();
  await saveCaseReport(spec, siteId, input, result);
  return result;
}

async function startServices() {
  controlPort = await freePort();
  launcherPort = await freePort(new Set([controlPort]));
  controlUrl = `http://127.0.0.1:${controlPort}`;
  launcherUrl = `http://127.0.0.1:${launcherPort}`;
  const stateDir = join(runRoot, "local-state");
  const runnerArtifactDir = join(runRoot, "runner-artifacts");
  await mkdir(runnerArtifactDir, { recursive: true });
  const launcherToken = `capability-fixture-${runId}`;
  const common = {
    ...process.env,
    SITEWAKE_LOCAL_DEV: "1",
    SITEWAKE_TEST_SUITE: "capability-center-v2-fixture-e2e",
    SITEWAKE_LOCAL_PERSIST_PATH: stateDir,
    WRANGLER_LOG_PATH: join(stateDir, "wrangler.log"),
    MINIFLARE_REGISTRY_PATH: join(stateDir, "registry"),
    CAPABILITY_V2_AUTO_DISPATCH: "1",
    CAPABILITY_V2_RUNTIME_CONCURRENCY: "1",
    CAPABILITY_V2_MODEL_TIMEOUT_MS: "180000",
    CAPABILITY_V2_AUTHOR_MAX_TOOL_CALLS: "72",
    CAPABILITY_V2_EXPLORATION_MAX_STEPS: "100",
    CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN: "1",
    CAPABILITY_V2_CONTROL_PLANE_URL: controlUrl,
    CAPABILITY_V2_RUNTIME_LAUNCHER_PORT: String(launcherPort),
    CAPABILITY_V2_RUNTIME_LAUNCHER_URL: launcherUrl,
    CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN: launcherToken,
    CAPABILITY_V2_DISPATCH_TOKEN: process.env.CAPABILITY_V2_DISPATCH_TOKEN?.trim() || launcherToken,
    CAPABILITY_V2_ARTIFACT_DIR: runnerArtifactDir,
  };
  runtimeLauncher = logProcess("runtime-launcher", process.execPath, ["scripts/capability-v2-runtime-launcher.mjs"], common);
  await waitForUrl(`${launcherUrl}/health`, { authorization: `Bearer ${launcherToken}` });
  controlPlane = logProcess("control-plane", process.execPath, ["scripts/run-vinext.mjs", "dev", "--hostname", "127.0.0.1", "--port", String(controlPort), "--strictPort"], common);
  await waitForUrl(`${controlUrl}/api/health`);
  const siteProbe = `ccfixture-${slug(runId)}-probe`;
  const model = await request(siteProbe, `/api/site-agents/${encodeURIComponent(siteProbe)}/model`);
  assert.equal(model.response.status, 200, JSON.stringify(model.body));
  assert.equal(model.body.execution?.configured, true, "execution model must be configured");
  assert.equal(model.body.semantic?.configured, true, "semantic model must be configured");
  assert.doesNotMatch(`${model.body.execution?.model || ""} ${model.body.semantic?.model || ""}`, /mock|fixture/i, "fixture E2E forbids mock/fixture models");
  return { controlUrl, launcherUrl, model: { execution: model.body.execution.model, semantic: model.body.semantic.model } };
}

async function runAll() {
  const manifest = await loadManifest();
  const byId = new Map(manifest.cases.map((item) => [item.id, item]));
  const required = new Set();
  const addWithDependencies = (item) => {
    if (!item || required.has(item.id)) return;
    required.add(item.id);
    for (const dependency of item.requires || []) {
      const dependencyId = String(dependency).replace(/\.json$/i, "");
      addWithDependencies(byId.get(dependencyId));
    }
  };
  if (selectedCase) addWithDependencies(byId.get(selectedCase));
  const selected = selectedCase ? manifest.cases.filter((item) => required.has(item.id)) : manifest.cases;
  assert.ok(selected.length, `fixture case not found: ${selectedCase}`);
  await rm(runRoot, { recursive: true, force: true });
  await mkdir(runRoot, { recursive: true });
  await writeFile(join(runRoot, "dataflow.jsonl"), "");
  await writeFile(runMarker, JSON.stringify({ pid: process.pid, runId, startedAt: new Date().toISOString() }));
  const counters = { published: 0, duplicates: 0, taskFailures: 0, httpErrors: 0 };
  const results = [];
  const fixtureInputs = [];
  try {
    const services = await startServices();
    for (const spec of selected) {
      const rawInput = await loadFixture(spec);
      const siteId = `ccfixture-${slug(runId)}-${slug(spec.siteGroup || spec.id)}`.slice(0, 120);
      const input = replaceTokens(rawInput, { RUN_ID: runId, SITE_ID: siteId, EPISODE_ID: `episode_${runId}_${slug(spec.id)}` });
      fixtureInputs.push({ caseId: spec.id, siteId, input });
      process.stdout.write(`\n[fixture] ${spec.id} (${spec.expectation})\n`);
      try {
        results.push(await runCase(spec, rawInput, counters));
      } catch (error) {
        // Preserve a case-level diagnostic even when an assertion stops the
        // suite. The report is intentionally written from the fixture input
        // only; no post-B object is synthesized by the test runner.
        const siteId = `ccfixture-${slug(runId)}-${slug(spec.siteGroup || spec.id)}`.slice(0, 120);
        const input = replaceTokens(rawInput, { RUN_ID: runId, SITE_ID: siteId, EPISODE_ID: `episode_${runId}_${slug(spec.id)}` });
        const failure = {
          caseId: spec.id,
          title: spec.title,
          siteId,
          expectation: spec.expectation,
          outcome: "RunnerAssertionFailed",
          error: error instanceof Error ? error.message : String(error),
          boundary: boundaryEvent(input, siteId, spec.id),
        };
        results.push(failure);
        await saveCaseReport(spec, siteId, input, failure);
        await writeFile(join(runRoot, "partial-summary.json"), JSON.stringify({ runId, failedCase: failure, counters, cases: results }, null, 2));
        throw error;
      }
      await delay(Number(process.env.CAPABILITY_V2_FIXTURE_DELAY_MS || 1_000));
    }
    const summary = { schemaVersion: "capability-center-v2-fixture-report.v1", runId, startedAt: new Date().toISOString(), services, counters, cases: results.map((item) => ({ caseId: item.caseId, siteId: item.siteId, expectation: item.expectation, outcome: item.outcome, discoveryTaskId: item.discovery?.id, validationTaskId: item.validation?.id, capabilityId: item.capability?.id, versionId: item.version?.id, traceId: item.trace?.summary?.id, traceAudit: item.traceAudit })) };
    const allDataflowLines = results.flatMap((item) => dataflowLines(item));
    const boundaryReports = results.map((item) => moduleBoundaryReport(item));
    const taskChains = results.map((item) => taskChain(item));
    const candidateArtifacts = Object.fromEntries(results
      .map((item) => [item.caseId, item.discovery?.result?.candidateArtifact || item.validation?.result?.candidateArtifact])
      .filter(([, artifact]) => artifact));
    const validationResults = Object.fromEntries(results
      .map((item) => [item.caseId, item.validation?.result])
      .filter(([, validation]) => validation));
    const sourceIndex = results
      .filter((item) => typeof item.discovery?.result?.candidateSource === "string" && item.discovery.result.candidateSource.trim())
      .map((item) => ({ caseId: item.caseId, path: `cases/${item.caseId}/generated-source.ts` }));
    await writeFile(join(runRoot, "input.json"), JSON.stringify(fixtureInputs, null, 2));
    await appendMissingDataflow(join(runRoot, "dataflow.jsonl"), allDataflowLines);
    await writeFile(join(runRoot, "module-boundaries.json"), JSON.stringify(boundaryReports, null, 2));
    await writeFile(join(runRoot, "task-chain.json"), JSON.stringify(taskChains, null, 2));
    await writeFile(join(runRoot, "candidate-artifact.json"), JSON.stringify(candidateArtifacts, null, 2));
    await writeFile(join(runRoot, "validation-results.json"), JSON.stringify(validationResults, null, 2));
    await writeFile(join(runRoot, "generated-source.ts"), `// Generated-source index. Actual source is stored per case.\nexport const generatedSourceFiles = ${JSON.stringify(sourceIndex, null, 2)} as const;\n`);
    await writeFile(join(runRoot, "summary.json"), JSON.stringify(summary, null, 2));
    await writeFile(join(runRoot, "process-logs.json"), JSON.stringify(processLogs, null, 2));
    await writeFile(join(runRoot, "report.html"), `<!doctype html><meta charset="utf-8"><title>CapabilityGenerationInput Fixture E2E</title><style>body{font-family:system-ui;max-width:1200px;margin:30px auto;padding:0 18px;background:#f4f7f6;color:#18382d}section{background:white;border:1px solid #d8e7e0;border-radius:12px;padding:18px;margin:14px 0}table{border-collapse:collapse;width:100%}td,th{padding:8px;border-bottom:1px solid #e2ece8;text-align:left}code{overflow-wrap:anywhere}</style><h1>能力中心 CapabilityGenerationInput Fixture E2E</h1><section><p>runId: <code>${runId}</code></p><p>真实链路：A Mock Boundary → B → C1/C2 → C3 → AI Review → D</p><p>发布：${counters.published}，重复：${counters.duplicates}，任务失败：${counters.taskFailures}，输入错误：${counters.httpErrors}</p></section><section><table><thead><tr><th>用例</th><th>期望</th><th>实际</th><th>Trace</th></tr></thead><tbody>${summary.cases.map((item) => `<tr><td>${item.caseId}</td><td>${item.expectation}</td><td>${item.outcome}</td><td><code>${item.traceId || "-"}</code></td></tr>`).join("")}</tbody></table></section>`);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await writeFile(join(runRoot, "process-logs.json"), JSON.stringify(processLogs, null, 2)).catch(() => undefined);
    if (!keepServices) {
      await stopProcess(controlPlane);
      await stopProcess(runtimeLauncher);
    } else {
      process.stdout.write(`[fixture] services kept alive: ${controlUrl} / ${launcherUrl}\n`);
    }
    await rm(runMarker, { force: true }).catch(() => undefined);
  }
}

if (mode === "validate") await validateFixtures();
else await runAll();
