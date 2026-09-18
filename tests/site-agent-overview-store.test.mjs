import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

let sequence = 0;

async function bundledMemoryStore() {
  const stateKey = `__SITEWAKE_OVERVIEW_STORE_${sequence += 1}`;
  globalThis[stateKey] = { runnerCalls: 0 };
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../db/site-agent-store.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "overview-memory-fixtures",
      setup(builder) {
        builder.onResolve({ filter: /(?:^|[\\/])capability-center-store$/ }, () => ({
          path: "overview-capability-center-store",
          namespace: "overview-fixtures",
        }));
        builder.onResolve({ filter: /(?:^|[\\/])proposal-service$/ }, () => ({
          path: "overview-proposal-service",
          namespace: "overview-fixtures",
        }));
        builder.onLoad({ filter: /.*/, namespace: "overview-fixtures" }, ({ path }) => ({
          contents: path === "overview-capability-center-store"
            ? `export async function coalesceCapabilityProposalsForEpisodes() { return { sourceEpisodeId: undefined }; }`
            : `export function capabilitySignalLastError(error) { return error instanceof Error ? error.message : String(error); }
               export async function submitEpisodeCapabilitySignal() { throw new Error("unused"); }`,
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
          contents: `
            export function getD1Binding() { return null; }
            export function getArtifactBinding() { return null; }
            export class D1UnavailableError extends Error {}
          `,
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]db[\\/]runner-control-store\.ts$/ }, () => ({
          contents: `
            const state = globalThis[${JSON.stringify(stateKey)}];
            export async function getRunnerControlProjection() { state.runnerCalls += 1; throw new Error("runner_queue_database_failed"); }
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
      },
    }],
  });
  const store = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  return { store, state: globalThis[stateKey], cleanup() { delete globalThis[stateKey]; } };
}

test("production-shaped acme overview remains readable when optional Runner projection fails", async (t) => {
  const fixture = await bundledMemoryStore();
  t.after(fixture.cleanup);
  fixture.store.resetMemorySiteAgentStore();
  await fixture.store.createSiteAgent({
    id: "acme-production",
    url: "https://www.example.org/",
    name: "微博头条",
  });
  await fixture.store.createSiteAgent({
    id: "sandbox-overview-fixture",
    url: "https://sandbox.example/",
    visibility: "sandbox",
  });
  assert.equal(await fixture.store.siteAgentAccess("sandbox-overview-fixture"), "forbidden");
  assert.equal(await fixture.store.siteAgentAccess("missing-overview-fixture"), "not_found");
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);
  try {
    const result = await fixture.store.getSiteAgentOverview("acme-production");
    assert.equal(result.overview.id, "acme-production");
    assert.equal(result.overview.profile.entryUrl, "https://www.example.org/");
    assert.equal(result.overview.diagnostics?.[0]?.code, "site_agent_runner_service_failed");
  } finally {
    console.error = originalError;
  }
  assert.equal(fixture.state.runnerCalls, 1);
  assert.equal(logs[0]?.[0], "site_agent_overview_dependency_failed");
  assert.equal(logs[0]?.[1]?.code, "site_agent_runner_service_failed");
});
