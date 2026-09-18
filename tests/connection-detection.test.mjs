import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function bundledModule(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const snapshot = (url) => ({
  url,
  title: "Shop",
  heading: "Shop",
  capturedAt: "2026-09-08T00:00:00.000Z",
  elements: [],
  links: [],
  visibleText: "Shop",
});

test("the overview carries the facts a detection verdict needs, and old sites read without error", async () => {
  const store = await bundledModule("../db/site-agent-store.ts");
  const siteAgentId = "detection-facts-site";
  await store.createSiteAgent({ id: siteAgentId, url: "https://shop.example.test" });

  // A site neither connected nor previewed: all three absent, reading does not throw.
  const fresh = (await store.getSiteAgentOverview(siteAgentId)).overview;
  assert.equal(fresh.connection, undefined);
  assert.equal(fresh.sitePreview, undefined);
  assert.equal(fresh.sitePreviewJob, undefined);

  // Trigger an evidence job: it carries createdAt, the start of the verdict window.
  const { job } = await store.enqueueSitePreviewJob({
    siteAgentId,
    origin: "https://shop.example.test",
    url: "https://shop.example.test/",
    force: true,
  });
  const queued = (await store.getSiteAgentOverview(siteAgentId)).overview;
  assert.equal(queued.sitePreviewJob?.id, job.id);
  assert.equal(queued.sitePreviewJob?.status, "queued");
  assert.ok(Date.parse(queued.sitePreviewJob.createdAt) > 0, "the window start is a readable timestamp");
  // The lease token does not appear in the overview.
  assert.equal(queued.sitePreviewJob.lease?.token, undefined);

  // Once the handshake is stored the overview carries lastSeenAt — "connected" is decided by comparing it with the window start.
  await store.recordSiteAgentConnection(siteAgentId, {
    origin: "https://shop.example.test",
    url: "https://shop.example.test/",
    title: "Shop",
    heading: "Shop",
    snapshot: snapshot("https://shop.example.test/"),
  });
  const connected = (await store.getSiteAgentOverview(siteAgentId)).overview;
  assert.ok(connected.connection?.lastSeenAt, "the handshake timestamp is exposed");
  assert.equal(connected.connection.origin, "https://shop.example.test");
  assert.ok(Date.parse(connected.connection.lastSeenAt) >= Date.parse(queued.sitePreviewJob.createdAt));
});

const detection = await bundledModule("../lib/console/connection-detection.ts");
const {
  detectionState,
  handshakeIsFresh,
  shouldAwaitHandshake,
  unownedInstallIds,
  DETECTION_PICKUP_TIMEOUT_MS,
  DETECTION_TOTAL_TIMEOUT_MS,
} = detection;

const SITE = "shop.example.test";
const START = "2026-09-08T00:00:00.000Z";
const at = (ms) => new Date(Date.parse(START) + ms).toISOString();

test("only a handshake inside this detection window counts as connected", () => {
  // spec: a stale handshake does not count
  assert.equal(handshakeIsFresh(at(-1), START), false);
  assert.equal(handshakeIsFresh("2026-09-01T00:00:00.000Z", START), false);
  // Equal does not count either: nothing at or before the window start counts.
  assert.equal(handshakeIsFresh(START, START), false);
  // spec: a handshake inside the window counts
  assert.equal(handshakeIsFresh(at(1), START), true);
  // Absent and malformed both mean no handshake; no throw.
  assert.equal(handshakeIsFresh(undefined, START), false);
  assert.equal(handshakeIsFresh("not a date", START), false);
});

test("the decision table from design.md maps facts onto verdicts", () => {
  const base = { siteAgentId: SITE, windowStartedAt: START, now: at(1_000) };
  const rows = [
    {
      name: "握手到达，任务还在跑也算连上",
      input: { ...base, lastSeenAt: at(500), job: { status: "running", createdAt: START } },
      expected: { kind: "connected" },
    },
    {
      name: "握手到达，任务失败也算连上",
      input: { ...base, lastSeenAt: at(500), job: { status: "failed", createdAt: START, error: "site_preview_navigation_failed" } },
      expected: { kind: "connected" },
    },
    {
      name: "任务成功、页面上没有接入标签 → 脚本没装",
      input: { ...base, job: { status: "succeeded", createdAt: START }, preview: { detectedSiteAgentIds: [] } },
      expected: { kind: "not-detected", reason: "script-missing" },
    },
    {
      name: "任务成功、标签是本站但没握手 → 装了却连不上",
      input: { ...base, job: { status: "succeeded", createdAt: START }, preview: { detectedSiteAgentIds: [SITE] } },
      expected: { kind: "not-detected", reason: "script-not-connecting" },
    },
    {
      name: "任务成功、标签属于别的网站 → 停止并说明",
      input: { ...base, job: { status: "succeeded", createdAt: START }, preview: { detectedSiteAgentIds: ["docs.other.test"] } },
      expected: { kind: "not-detected", reason: "foreign-install", foreignSiteAgentIds: ["docs.other.test"] },
    },
    {
      name: "任务失败 → 检测未能进行",
      input: { ...base, job: { status: "failed", createdAt: START, error: "site_preview_navigation_failed" } },
      expected: { kind: "unavailable", reason: "job-failed", error: "site_preview_navigation_failed" },
    },
    {
      name: "任务在跑、还没到时限 → 未出结论",
      input: { ...base, job: { status: "running", createdAt: START } },
      expected: { kind: "in-progress", awaitingHandshakeOnly: false },
    },
  ];
  for (const row of rows) {
    assert.deepEqual(detectionState(row.input), row.expected, row.name);
  }
});

test("a job no runner ever leases becomes unavailable instead of spinning forever", () => {
  const queued = { status: "queued", createdAt: START };
  const base = { siteAgentId: SITE, windowStartedAt: START, job: queued };
  // Before the deadline: still waiting.
  assert.deepEqual(
    detectionState({ ...base, now: at(DETECTION_PICKUP_TIMEOUT_MS - 1) }),
    { kind: "in-progress", awaitingHandshakeOnly: false },
  );
  // At the deadline: evidence deemed impossible, fall back to handshake waiting.
  const timedOut = detectionState({ ...base, now: at(DETECTION_PICKUP_TIMEOUT_MS) });
  assert.deepEqual(timedOut, { kind: "unavailable", reason: "never-leased" });
  assert.equal(shouldAwaitHandshake(timedOut), true);

  // Leased but never finishing goes by the total deadline.
  const running = { siteAgentId: SITE, windowStartedAt: START, job: { status: "running", createdAt: START } };
  assert.equal(detectionState({ ...running, now: at(DETECTION_TOTAL_TIMEOUT_MS - 1) }).kind, "in-progress");
  assert.equal(detectionState({ ...running, now: at(DETECTION_TOTAL_TIMEOUT_MS) }).kind, "unavailable");
});

test("the handshake-waiting path shares the same verdict and never fails on its own", () => {
  const waiting = { siteAgentId: SITE, windowStartedAt: START, job: undefined };
  // Without an evidence job only the handshake is awaited; no failure verdict however long.
  assert.deepEqual(
    detectionState({ ...waiting, now: at(DETECTION_TOTAL_TIMEOUT_MS * 10) }),
    { kind: "in-progress", awaitingHandshakeOnly: true },
  );
  // A handshake during the wait uses exactly the main-path rule.
  assert.deepEqual(
    detectionState({ ...waiting, lastSeenAt: at(5_000), now: at(6_000) }),
    { kind: "connected" },
  );
  // Only "detection could not run" triggers the fallback to waiting.
  assert.equal(shouldAwaitHandshake({ kind: "connected" }), false);
  assert.equal(shouldAwaitHandshake({ kind: "not-detected", reason: "script-missing" }), false);
});

test("a stale preview from an earlier round cannot decide this round", () => {
  // The overview's sitePreview is the latest successful job's result and may predate
  // this round. No verdict from it while this round's job is still running.
  assert.deepEqual(
    detectionState({
      siteAgentId: SITE,
      windowStartedAt: START,
      job: { status: "running", createdAt: START },
      preview: { detectedSiteAgentIds: [SITE] },
      now: at(1_000),
    }),
    { kind: "in-progress", awaitingHandshakeOnly: false },
  );
});

test("页面上的外来标识里，哪些已经没有对应的网站", () => {
  const sites = [{ id: "shop.example.test" }, { id: "docs.other.test" }];
  const foreign = (ids) => ({ kind: "not-detected", reason: "foreign-install", foreignSiteAgentIds: ids });
  // All existing sites: none unowned — this is "bound to another site", stop.
  assert.deepEqual(unownedInstallIds(foreign(["docs.other.test"]), sites), []);
  // All unowned: the typical delete-and-re-add shape, adoptable.
  assert.deepEqual(unownedInstallIds(foreign(["acme-production"]), sites), ["acme-production"]);
  // Mixed: pick only the unowned ones.
  assert.deepEqual(unownedInstallIds(foreign(["docs.other.test", "gone-1", "gone-2"]), sites), ["gone-1", "gone-2"]);
  // Every other verdict yields empty.
  assert.deepEqual(unownedInstallIds({ kind: "connected" }, sites), []);
  assert.deepEqual(unownedInstallIds({ kind: "not-detected", reason: "script-missing" }, sites), []);
  assert.deepEqual(unownedInstallIds(undefined, sites), []);
});
