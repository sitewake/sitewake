/**
 * `release.version` is the website knowledge version, and nothing else.
 *
 * Widget presentation config (`agentConfig`: palette, launcher position,
 * display toggles) used to live inside the versioned Release snapshot. Because
 * a Release is immutable and its id derives from `version`, recolouring the
 * widget minted a whole new knowledge version — which then failed the
 * execution pin a queued task had already taken, rejecting work that had
 * nothing to do with the change.
 *
 * These tests hold that line from both sides: a config change must not move
 * the version, and a knowledge change must.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

let isolatedDatabaseSequence = 0;

async function isolatedD1Database() {
  const miniflare = new Miniflare({
    script: `export default { fetch() { return new Response("ok"); } }`,
    modules: true,
    d1Databases: { DB: `release-version-test-${isolatedDatabaseSequence += 1}` },
  });
  return {
    database: await miniflare.getD1Database("DB"),
    dispose: () => miniflare.dispose(),
  };
}

async function bundledModule(entry, options = {}) {
  const databaseKey = options.database ? `__SITEWAKE_RELEASE_VERSION_D1_${isolatedDatabaseSequence += 1}` : undefined;
  if (databaseKey) globalThis[databaseKey] = options.database;
  try {
    const result = await build({
      entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      // Route handlers reach dependencies that still use CommonJS globals.
      // The shims resolve against this test file, which is a real path — a
      // data: URL (how the bundle is imported) would not resolve.
      banner: options.commonjsShims ? { js: [
        "import { createRequire as __createRequire } from 'node:module';",
        `const require = __createRequire(${JSON.stringify(import.meta.url)});`,
        `const __filename = ${JSON.stringify(fileURLToPath(import.meta.url))};`,
        `const __dirname = ${JSON.stringify(fileURLToPath(new URL(".", import.meta.url)))};`,
      ].join("\n") } : undefined,
      plugins: databaseKey ? [{
        name: "isolated-d1-binding",
        setup(builder) {
          builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
            contents: `
              const database = globalThis[${JSON.stringify(databaseKey)}] || null;
              export function getD1Binding() { return database; }
              export function getArtifactBinding() { return null; }
              export class D1UnavailableError extends Error {}
            `,
            loader: "ts",
          }));
        },
      }] : [],
    });
    return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  } finally {
    if (databaseKey) delete globalThis[databaseKey];
  }
}

/** A scene, shaped enough to be real knowledge rather than a stub. */
function scene(id, pathnamePattern) {
  return {
    id,
    name: id,
    urlTemplates: [{ id: `url_${id}`, originPattern: "https://example.test", pathnamePattern, query: {} }],
    parameters: [],
    verifier: {},
    directEntry: "verified",
    sourceObservationIds: [],
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

test("schema migration adds the agent config columns and is idempotent", async () => {
  const isolated = await isolatedD1Database();
  try {
    const schema = await bundledModule("../db/site-agent-schema.ts", { database: isolated.database });
    await schema.ensureSiteAgentV2Schema(isolated.database);
    // Second run must be a no-op rather than an "already exists" failure.
    await schema.ensureSiteAgentV2Schema(isolated.database);
    const info = await isolated.database.prepare(`PRAGMA table_info(site_agent_v2_agents)`).all();
    const columns = new Set((info.results || []).map((row) => row.name));
    assert.ok(columns.has("agent_config_json"), "agent_config_json column must exist");
    assert.ok(columns.has("agent_config_updated_at"), "agent_config_updated_at column must exist");
  } finally {
    await isolated.dispose();
  }
});

test("changing only the widget config leaves the knowledge version untouched", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    await store.createSiteAgent({ id: "palette-site", name: "Palette", url: "https://example.test/" });

    const before = await store.getActiveSiteAgentRelease("palette-site");
    const beforeRows = await isolated.database
      .prepare(`SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?`)
      .bind("palette-site").all();

    await store.updateSiteAgent("palette-site", { agentConfig: { appearance: { palette: "violet" } } });

    const after = await store.getActiveSiteAgentRelease("palette-site");
    const afterRows = await isolated.database
      .prepare(`SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?`)
      .bind("palette-site").all();

    assert.equal(after.release.version, before.release.version, "a recolour must not mint a knowledge version");
    assert.equal(after.release.id, before.release.id, "a recolour must not mint a new Release");
    assert.equal(
      afterRows.results[0].count,
      beforeRows.results[0].count,
      "a recolour must not insert a Release row",
    );
    assert.equal(after.release.contentHash, before.release.contentHash, "config must stay out of the content hash");
    assert.equal(after.release.agentConfig.appearance.palette, "violet", "the new config must still be readable");
  } finally {
    await isolated.dispose();
  }
});

test("the last config write wins and no history is kept", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    await store.createSiteAgent({ id: "history-site", name: "History", url: "https://example.test/" });
    const before = await store.getActiveSiteAgentRelease("history-site");

    await store.updateSiteAgent("history-site", { agentConfig: { appearance: { palette: "violet" } } });
    await store.updateSiteAgent("history-site", { agentConfig: { appearance: { palette: "coral" } } });

    const after = await store.getActiveSiteAgentRelease("history-site");
    assert.equal(after.release.agentConfig.appearance.palette, "coral");
    assert.equal(after.release.version, before.release.version, "two recolours still mint no version");

    const rows = await isolated.database
      .prepare(`SELECT COUNT(*) AS count FROM site_agent_v2_releases WHERE site_agent_id=?`)
      .bind("history-site").all();
    assert.equal(rows.results[0].count, 1, "config history must not accumulate Release rows");
  } finally {
    await isolated.dispose();
  }
});

test("a real knowledge change does move the version", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    await store.createSiteAgent({ id: "knowledge-site", name: "Knowledge", url: "https://example.test/" });
    const before = await store.getActiveSiteAgentRelease("knowledge-site");

    await store.recordSiteAgentConnection("knowledge-site", {
      origin: "https://example.test",
      url: "https://example.test/",
      title: "Example",
      heading: "Example",
      snapshot: {
        id: "snapshot_1",
        sessionId: "session_1",
        documentId: "document_1",
        sequence: 0,
        url: "https://example.test/",
        title: "Example",
        heading: "Example",
        visibleText: "Example home page",
        links: [],
        capturedAt: "2026-07-15T00:00:00.000Z",
      },
      reviewedScenes: [scene("scene_home", "/"), scene("scene_pricing", "/pricing")],
    });

    const after = await store.getActiveSiteAgentRelease("knowledge-site");
    assert.ok(after.release.version > before.release.version, "new scenes must mint a knowledge version");
    assert.notEqual(after.release.contentHash, before.release.contentHash, "knowledge change must change the hash");
  } finally {
    await isolated.dispose();
  }
});

test("config survives a round trip through the store as the current value", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    await store.createSiteAgent({ id: "roundtrip-site", name: "Roundtrip", url: "https://example.test/" });
    await store.updateSiteAgent("roundtrip-site", { agentConfig: { appearance: { palette: "violet" } } });

    // Read through the two paths the runtime and the console each use.
    const active = await store.getActiveSiteAgentRelease("roundtrip-site");
    const byId = await store.getSiteAgentReleaseById("roundtrip-site", active.release.id);
    assert.equal(active.release.agentConfig.appearance.palette, "violet");
    assert.equal(byId.release.agentConfig.appearance.palette, "violet", "pinned reads must see current config too");
  } finally {
    await isolated.dispose();
  }
});

test("a site that never touched its config reads the system default", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    await store.createSiteAgent({ id: "default-site", name: "Default", url: "https://example.test/" });
    const active = await store.getActiveSiteAgentRelease("default-site");
    assert.ok(active.release.agentConfig, "an untouched site still gets a config object");
    assert.ok(active.release.agentConfig.appearance, "defaults include appearance");
  } finally {
    await isolated.dispose();
  }
});

/**
 * The ETag has to move when the config moves. Config left the content hash, so
 * without its own contribution the endpoint keeps answering 304 and a
 * recoloured widget never reaches the browser.
 */
async function releaseEndpoint(database) {
  const route = await bundledModule("../app/api/site-agents/[siteAgentId]/release/route.ts", { database, commonjsShims: true });
  return async (siteAgentId, headers = {}) => {
    const url = `https://control.test/api/site-agents/${siteAgentId}/release?runtime=1`;
    // A plain Request is enough: the handler reads the URL and headers, and
    // Next's own request type is a thin wrapper over this one.
    const request = new Request(url, { headers });
    request.nextUrl = new URL(url);
    const response = await route.GET(request, { params: { siteAgentId } });
    return { status: response.status, etag: response.headers.get("etag"), body: response.status === 304 ? null : await response.json() };
  };
}

test("the release ETag tracks the widget config", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    await store.createSiteAgent({ id: "etag-site", name: "Etag", url: "https://example.test/" });
    const request = await releaseEndpoint(isolated.database);

    const first = await request("etag-site");
    assert.equal(first.status, 200);

    // Unchanged config must still validate as fresh.
    const revalidated = await request("etag-site", { "if-none-match": first.etag });
    assert.equal(revalidated.status, 304, "an unchanged site must still revalidate to 304");

    await store.updateSiteAgent("etag-site", { agentConfig: { appearance: { palette: "violet" } } });
    const afterChange = await request("etag-site", { "if-none-match": first.etag });
    assert.equal(afterChange.status, 200, "a recolour must not keep serving 304");
    assert.notEqual(afterChange.etag, first.etag, "the ETag must move with the config");
    assert.equal(afterChange.body.release.agentConfig.appearance.palette, "violet", "the response carries the new config");

    // Hashed, not timestamped: setting it back restores the original ETag.
    await store.updateSiteAgent("etag-site", { agentConfig: { appearance: { palette: "blue" } } });
    const reverted = await request("etag-site");
    assert.equal(reverted.etag, first.etag, "reverting the config must restore the original ETag");
  } finally {
    await isolated.dispose();
  }
});

test("the backfill is idempotent and invisible to callers", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });

    // One site with a custom config, one that never touched it.
    await store.createSiteAgent({ id: "custom-site", name: "Custom", url: "https://example.test/" });
    await store.createSiteAgent({ id: "untouched-site", name: "Untouched", url: "https://example.test/" });
    await store.updateSiteAgent("custom-site", { agentConfig: { appearance: { palette: "coral" } } });

    // Simulate a pre-migration row: config embedded in the Release, column empty.
    const active = await store.getActiveSiteAgentRelease("custom-site");
    const embedded = { ...active.release, agentConfig: active.release.agentConfig };
    await isolated.database
      .prepare(`UPDATE site_agent_v2_releases SET release_json=? WHERE id=?`)
      .bind(JSON.stringify(embedded), active.release.id).run();
    await isolated.database.prepare(`UPDATE site_agent_v2_agents SET agent_config_json=NULL WHERE id=?`).bind("custom-site").run();

    const beforeCustom = await store.getActiveSiteAgentRelease("custom-site");
    const beforeUntouched = await store.getActiveSiteAgentRelease("untouched-site");
    assert.equal(beforeCustom.release.agentConfig.appearance.palette, "coral", "fallback must serve the embedded config");

    const first = await store.backfillAgentConfigColumns();
    assert.ok(first.migrated >= 1, "the un-backfilled site must be migrated");

    const second = await store.backfillAgentConfigColumns();
    assert.equal(second.migrated, 0, "a second run must migrate nothing");

    const afterCustom = await store.getActiveSiteAgentRelease("custom-site");
    const afterUntouched = await store.getActiveSiteAgentRelease("untouched-site");
    assert.deepEqual(afterCustom.release.agentConfig, beforeCustom.release.agentConfig, "custom config must survive unchanged");
    assert.deepEqual(afterUntouched.release.agentConfig, beforeUntouched.release.agentConfig, "an untouched site keeps the default");
  } finally {
    await isolated.dispose();
  }
});

/**
 * Mirrors the comparison `assertExecutionRelease` makes in the browser port:
 *
 *   if (release.id !== pin.releaseId || release.version !== pin.releaseVersion)
 *     throw new Error("task_launch_release_mismatch");
 *
 * That method is deliberately not changed by this work. Pinning was never the
 * bug — it was correct to reject a Release that had moved. The bug was that a
 * recolour moved it. These two tests are the acceptance for that.
 */
function pinMatches(release, pin) {
  return release.id === pin.releaseId && release.version === pin.releaseVersion;
}

test("a task pinned before a recolour still passes its release check", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    await store.createSiteAgent({ id: "pin-config-site", name: "Pin", url: "https://example.test/" });

    const atLaunch = await store.getActiveSiteAgentRelease("pin-config-site");
    const pin = { releaseId: atLaunch.release.id, releaseVersion: atLaunch.release.version, revisionId: "revision_1" };

    await store.updateSiteAgent("pin-config-site", { agentConfig: { appearance: { palette: "violet" } } });

    const atExecution = await store.getActiveSiteAgentRelease("pin-config-site");
    assert.ok(pinMatches(atExecution.release, pin), "a recolour must not invalidate a queued task's pin");
  } finally {
    await isolated.dispose();
  }
});

test("a task pinned before a knowledge change still fails its release check", async () => {
  const isolated = await isolatedD1Database();
  try {
    const store = await bundledModule("../db/site-agent-store.ts", { database: isolated.database });
    await store.createSiteAgent({ id: "pin-knowledge-site", name: "Pin", url: "https://example.test/" });

    const atLaunch = await store.getActiveSiteAgentRelease("pin-knowledge-site");
    const pin = { releaseId: atLaunch.release.id, releaseVersion: atLaunch.release.version, revisionId: "revision_1" };

    await store.recordSiteAgentConnection("pin-knowledge-site", {
      origin: "https://example.test",
      url: "https://example.test/",
      title: "Example",
      heading: "Example",
      snapshot: {
        id: "snapshot_1", sessionId: "session_1", documentId: "document_1", sequence: 0,
        url: "https://example.test/", title: "Example", heading: "Example",
        visibleText: "Example home page", links: [], capturedAt: "2026-07-15T00:00:00.000Z",
      },
      reviewedScenes: [scene("scene_home", "/"), scene("scene_pricing", "/pricing")],
    });

    const atExecution = await store.getActiveSiteAgentRelease("pin-knowledge-site");
    assert.equal(pinMatches(atExecution.release, pin), false, "a knowledge change must still invalidate the pin");
  } finally {
    await isolated.dispose();
  }
});
