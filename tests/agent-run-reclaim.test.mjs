import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

globalThis.window = globalThis;
globalThis.window.addEventListener ||= () => {};
globalThis.window.removeEventListener ||= () => {};
globalThis.document ||= {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
  getElementsByTagName() { return []; },
};

async function bundled(entry, stubs = true) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: stubs ? [{
      name: "browser-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^@page-agent\// }, () => ({ path: "stub", namespace: "pa" }));
        builder.onLoad({ filter: /.*/, namespace: "pa" }, () => ({
          loader: "js",
          contents: "export class PageController {} export class PageAgentCore {} export const tool = value => value;",
        }));
      },
    }] : [],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const port = await bundled("../client/user-agent-port.ts");
const store = await bundled("../db/agent-run-store.ts", false);
const { retainablePendingTerminals, pendingTerminalIsUnrecoverable } = port;
const { reclaimExpiredRun } = store;

function run(overrides = {}) {
  return {
    id: "run_1",
    revision: 3,
    controller: "page-agent",
    scope: { kind: "site", siteAgentId: "site", allowedOrigins: [], knowledgeNamespaceIds: [] },
    status: "running",
    goal: "点开第三个热搜",
    input: {},
    conversation: [],
    agentState: {},
    activityTimeline: [],
    bindings: {},
    pageEpoch: 1,
    eventSequence: 4,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:10.000Z",
    expiresAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

const AFTER_EXPIRY = Date.parse("2026-08-19T00:00:00.000Z");
const BEFORE_EXPIRY = Date.parse("2026-08-15T12:00:00.000Z");

test("an expired run left in progress is reclaimed", () => {
  const reclaimed = reclaimExpiredRun(run(), AFTER_EXPIRY);

  assert.ok(reclaimed, "a run past its expiry with no terminal report must be reclaimed");
  assert.equal(reclaimed.status, "failed");
  assert.equal(reclaimed.outcome.code, "agent_run_expired_reclaimed");
  assert.equal(reclaimed.outcome.evidence.reclaimedFrom, "running",
    "the reclaim must record what it interrupted, so it can be told apart from a real failure");
});

test("the other in-progress statuses are reclaimed too", () => {
  for (const status of ["awaiting-page", "awaiting-user"]) {
    const reclaimed = reclaimExpiredRun(run({ status }), AFTER_EXPIRY);
    assert.ok(reclaimed, `${status} is an in-progress state and must be reclaimable`);
    assert.equal(reclaimed.outcome.evidence.reclaimedFrom, status);
  }
});

test("a run that has not expired is left alone", () => {
  assert.equal(reclaimExpiredRun(run(), BEFORE_EXPIRY), undefined);
});

test("a run that already reached a terminal state is left alone", () => {
  for (const status of ["completed", "failed", "cancelled"]) {
    assert.equal(reclaimExpiredRun(run({ status }), AFTER_EXPIRY), undefined,
      `${status} is terminal and must not be rewritten`);
  }
});

test("an existing outcome is never overwritten by the reclaim", () => {
  const outcome = { status: "success", code: "agent_completed", summary: "done", evaluatedAt: "x", evidence: {} };
  const reclaimed = reclaimExpiredRun(run({ outcome }), AFTER_EXPIRY);

  assert.deepEqual(reclaimed.outcome, outcome, "a reported business result must survive the status sweep");
});

test("a malformed expiry does not trigger a reclaim", () => {
  assert.equal(reclaimExpiredRun(run({ expiresAt: "not-a-date" }), AFTER_EXPIRY), undefined);
});

test("pending terminal reports survive until their token could no longer work", () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");
  const fresh = { runId: "run_1", resumeToken: "t", savedAt: now - 60_000 };
  const stale = { runId: "run_2", resumeToken: "t", savedAt: now - 25 * 60 * 60_000 };
  const malformed = { runId: "", resumeToken: "t", savedAt: now };

  const retained = retainablePendingTerminals([fresh, stale, malformed], now);

  assert.deepEqual(retained.map((entry) => entry.runId), ["run_1"]);
});

test("a non-array store does not throw", () => {
  assert.deepEqual(retainablePendingTerminals(null), []);
  assert.deepEqual(retainablePendingTerminals("corrupt"), []);
});

test("replays stop for responses that mean the run is no longer ours", () => {
  for (const message of ["http_401", "http_403", "http_404", "http_409", "http_410"]) {
    assert.equal(pendingTerminalIsUnrecoverable(message), true, `${message} must not be retried forever`);
  }
});

test("replays continue for transient failures", () => {
  for (const message of ["http_500", "http_502", "http_429", "Failed to fetch", "timeout"]) {
    assert.equal(pendingTerminalIsUnrecoverable(message), false, `${message} may still succeed later`);
  }
});

test("a terminal report is persisted before it is attempted", async () => {
  const source = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const body = /private async finishRun\([\s\S]*?\n  \}\n/.exec(source)?.[0] || "";

  const remembered = body.indexOf("rememberPendingTerminal");
  const sent = body.indexOf("sendTerminalState");
  assert.ok(remembered > 0 && sent > 0, "finishRun must both record and send");
  assert.ok(remembered < sent,
    "the record has to exist before the request, otherwise a page closed mid-flight strands the run");
});

test("bootstrap replays leftover terminal reports", async () => {
  const source = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const initialize = /private async initialize\(\)[\s\S]*?\n  \}\n/.exec(source)?.[0] || "";

  assert.match(initialize, /flushPendingTerminals/,
    "the promise that 'the next bootstrap reconciles the run' has to be kept by actual code");
});

test("the legacy repair retry stays bounded", async () => {
  // This counter looks dead from any single file — it is a loop across three.
  // Removing it would make the pre-runtime-V2 retry path unbounded, which is
  // the path production runs today.
  const compiler = await readFile(new URL("../lib/site-knowledge/compiler.ts", import.meta.url), "utf8");
  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const adaptive = await readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8");

  assert.match(compiler, /repairAttempt \|\| 0/, "the compiler reads the counter");
  assert.match(compiler, /attempt < 2/, "and uses it to stop retrying");
  assert.match(compiler, /attempt: attempt \+ 1/, "and increments it for the next round");
  assert.match(port, /directive\.attempt/, "the port feeds the incremented value back into the run");
  assert.match(adaptive, /repairAttempt: options\.repairAttempt \|\| 0/, "the run records it for the next read");
});

test("the sweep is bounded and targets only this site's abandoned runs", async () => {
  const source = await readFile(new URL("../db/agent-run-store.ts", import.meta.url), "utf8");
  const sweep = /export async function sweepExpiredRunsForSite[\s\S]*?\n\}/.exec(source)?.[0] || "";

  assert.ok(sweep, "the sweep has to exist");
  assert.match(sweep, /site_agent_id=\?/, "one site's records only");
  assert.match(sweep, /expires_at<=\?/, "only records past their expiry");
  assert.match(sweep, /'running','awaiting-page','awaiting-user'/, "only records that never reached a terminal state");
  assert.match(sweep, /LIMIT \?/, "bounded, so one task start cannot become an unbounded write");
});

test("starting a run sweeps that site's leftovers", async () => {
  const source = await readFile(new URL("../db/agent-run-store.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function createAgentRun");
  const create = source.slice(start, source.indexOf("export async function claimAgentRun"));

  // Hanging the sweep off the admin listing alone was not enough: production
  // had 11 leaked runs that nothing ever read. Run creation is the frequent
  // per-site write, so it is where the sweep actually fires.
  assert.match(create, /sweepExpiredRunsForSite/);
  assert.match(create, /void sweepExpiredRunsForSite/, "a failed sweep must not block the user's task");
});
