import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { emptyRelease } from "../lib/site-knowledge/protocol.ts";

let sequence = 0;

async function bundledPostgresStore(database) {
  const databaseKey = `__SITEWAKE_TEST_POSTGRES_OVERVIEW_${sequence += 1}`;
  globalThis[databaseKey] = database;
  try {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("../db/site-agent-store.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: [{
        name: "postgres-overview-fixtures",
        setup(builder) {
          builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
            contents: `
              const database = globalThis[${JSON.stringify(databaseKey)}];
              export function getD1Binding() { return database; }
              export function getArtifactBinding() { return null; }
              export class D1UnavailableError extends Error {}
            `,
            loader: "ts",
          }));
          builder.onLoad({ filter: /[\\/]db[\\/]site-agent-schema\.ts$/ }, () => ({
            contents: `
              export async function ensureSiteAgentV2Schema() {}
              export async function ensureSiteAgentV3Schema() {}
            `,
            loader: "ts",
          }));
          builder.onLoad({ filter: /[\\/]db[\\/]runner-control-store\.ts$/ }, () => ({
            contents: `
              export async function getRunnerControlProjection() { throw new Error("runner projection unavailable"); }
              export function configuredRunnerProjectionMode() { return "aggregate"; }
              export function configuredRunnerLeaseAuthority() { return "central"; }
              export async function claimRunnerLease() { throw new Error("unused"); }
              export async function completeRunnerLease() { throw new Error("unused"); }
              export async function getRunnerLeaseMirror() { return undefined; }
              export async function heartbeatRunnerInstance() { throw new Error("unused"); }
              export async function registerRunnerInstance() { throw new Error("unused"); }
            `,
            loader: "ts",
          }));
          builder.onResolve({ filter: /(?:^|[\\/])capability-center-store$/ }, () => ({
            path: "postgres-overview-capability-center-store",
            namespace: "postgres-overview-fixtures",
          }));
          builder.onResolve({ filter: /(?:^|[\\/])proposal-service$/ }, () => ({
            path: "postgres-overview-proposal-service",
            namespace: "postgres-overview-fixtures",
          }));
          builder.onLoad({ filter: /.*/, namespace: "postgres-overview-fixtures" }, ({ path }) => ({
            contents: path === "postgres-overview-capability-center-store"
              ? `export async function coalesceCapabilityProposalsForEpisodes() { return { sourceEpisodeId: undefined }; }`
              : `export function capabilitySignalLastError(error) { return error instanceof Error ? error.message : String(error); }
                 export async function submitEpisodeCapabilitySignal() { throw new Error("unused"); }`,
            loader: "ts",
          }));
        },
      }],
    });
    return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  } finally {
    delete globalThis[databaseKey];
  }
}

function fakePostgresDatabase() {
  const release = emptyRelease("acme-production");
  const validEpisode = {
    schemaVersion: "site-agent.v2",
    id: "episode-valid",
    siteAgentId: "acme-production",
    taskSessionId: "session-valid",
    browserSessionId: "browser-valid",
    documentId: "document-valid",
    mode: "adaptive",
    goal: "Find the latest article",
    normalizedGoal: "find the latest article",
    input: { query: "latest" },
    startedAt: "2026-08-15T00:00:00.000Z",
    endedAt: "2026-08-15T00:00:01.000Z",
    startSnapshot: { url: "https://example.com", title: "Example", heading: "Home" },
    endSnapshot: { url: "https://example.com/latest", title: "Latest", heading: "Latest" },
    transitions: [],
    outcome: { status: "success" },
  };
  const malformedEpisode = {
    id: "episode-malformed",
    taskSessionId: "session-malformed",
    mode: "adaptive",
    episodeJson: "{\"input\":}",
    startedAt: "2026-08-14T00:00:00.000Z",
    endedAt: "2026-08-14T00:00:01.000Z",
  };
  const rows = [
    { id: "episode-valid", taskSessionId: "session-valid", mode: "adaptive", episodeJson: JSON.stringify(validEpisode), startedAt: validEpisode.startedAt, endedAt: validEpisode.endedAt },
    malformedEpisode,
  ];
  return {
    dialect: "postgres",
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async all() {
              if (sql.includes("JOIN site_agent_v2_releases")) return { success: true, results: [{ releaseJson: JSON.stringify(release) }] };
              if (sql.includes("episode_json AS episodeJson")) return { success: true, results: rows };
              if (sql.includes("COUNT(*) AS episodeCount")) return { success: true, results: [{ episodeCount: 2, taskCount: 2 }] };
              return { success: true, results: [] };
            },
            async run() { return { success: true, results: [], meta: { changes: 0 } }; },
          };
        },
      };
    },
    async batch() { return []; },
  };
}

test("Postgres overview skips malformed episode JSON without failing the site", async () => {
  const store = await bundledPostgresStore(fakePostgresDatabase());
  const result = await store.getSiteAgentOverview("acme-production");
  assert.deepEqual(result.overview.recentEpisodes.map((episode) => episode.id), ["episode-valid"]);
  assert.ok(result.overview.diagnostics?.some((diagnostic) => diagnostic.code === "site_agent_episode_data_invalid"));
});
