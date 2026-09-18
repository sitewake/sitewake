import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

function releaseFixture(id, version, dependencyHash) {
  const now = "2026-07-30T05:00:00.000Z";
  return {
    schemaVersion: 4,
    id,
    siteAgentId: "pin-site",
    version,
    contentHash: `${id}-content`,
    profile: {
      name: "Pinned site",
      description: "Pinned site",
      vocabulary: {},
      suggestedGoals: [],
      entryUrl: "https://pin.test/",
      allowedOrigins: ["https://pin.test"],
    },
    scenes: [],
    linkReferences: [],
    targets: [],
    operations: [],
    navigationTools: [{
      id: "navigation-tool-cart",
      siteAgentId: "pin-site",
      intentKey: "open-cart",
      name: "Open cart",
      description: "Open cart",
      aliases: [],
      targetSceneId: "scene-cart",
      inputs: { type: "object", properties: {} },
      outputs: { type: "object", properties: {} },
      applicability: { scope: "any-scene", evidenceSceneIds: [] },
      strategies: [],
      verifier: { sceneId: "scene-cart" },
      source: {
        kind: "knowledge-compiled",
        knowledgeRevision: version,
        dependencyHash,
        evidenceRefs: [],
      },
      status: "verified",
      usedByCapabilityIds: ["capability-cart"],
      updatedAt: now,
    }],
    capabilities: [],
    outcomes: [],
    sourceEpisodeIds: [],
    evalSummary: {
      passed: true,
      evaluatedEpisodes: 0,
      successfulEpisodes: 0,
      failedEpisodes: 0,
      generatedAt: now,
    },
    createdAt: now,
  };
}

async function bundledReleaseRoute(state) {
  const stateKey = `__CONNECTED_BROWSER_PIN_ROUTE_${Date.now()}_${Math.random()}`;
  globalThis[stateKey] = state;
  const result = await build({
    entryPoints: [
      fileURLToPath(new URL("../app/api/site-agents/[siteAgentId]/release/route.ts", import.meta.url)),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "connected-browser-pin-route",
      setup(builder) {
        builder.onResolve({ filter: /^next\/server$/ }, () => ({
          path: "next-server",
          namespace: "pin-test",
        }));
        builder.onLoad({ filter: /.*/, namespace: "pin-test" }, () => ({
          loader: "js",
          contents: `
            export class NextRequest {}
            export class NextResponse extends Response {
              static json(body, init = {}) {
                const headers = new Headers(init.headers || {});
                if (!headers.has("content-type")) headers.set("content-type", "application/json");
                return new NextResponse(JSON.stringify(body), { ...init, headers });
              }
            }
          `,
        }));
        builder.onLoad({ filter: /[\\/]db[\\/]site-agent-store\.ts$/ }, () => ({
          loader: "ts",
          contents: `
            const state = globalThis[${JSON.stringify(stateKey)}];
            export async function siteAgentExists(siteAgentId) {
              return siteAgentId === state.siteAgentId;
            }
            export async function getActiveSiteAgentRelease(siteAgentId) {
              state.calls.push(["active", siteAgentId]);
              return { release: state.active, persistence: "d1" };
            }
            export async function getSiteAgentReleaseById(siteAgentId, releaseId) {
              state.calls.push(["exact", siteAgentId, releaseId]);
              if (siteAgentId !== state.siteAgentId || releaseId !== state.historical.id) {
                throw new Error("site_agent_release_not_found");
              }
              return { release: state.historical, persistence: "d1" };
            }
          `,
        }));
      },
    }],
  });
  try {
    return await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`,
    );
  } finally {
    delete globalThis[stateKey];
  }
}

async function bundledTaskLaunchPatchRuntime() {
  const source = await readFile(
    new URL("../client/user-agent-client.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("  class TaskLaunchPatchError extends Error");
  const end = source.indexOf("\n  function patchTaskLaunch(", start);
  assert.notEqual(start, -1, "TaskLaunchPatchError must remain executable client code");
  assert.notEqual(end, -1, "performTaskLaunchPatch must have a stable function boundary");
  const result = await transform(`
    type StoredTaskLaunch = {
      launchId: string;
      claimKey: string;
      executionOwnerId?: string;
      executionFence?: number;
    };
    let activeTaskLaunch: StoredTaskLaunch | undefined;
    let taskLaunchMutationAuthority = true;
    const documentTaskLaunchOwnerId = "owner-test";
    const config = { endpoint: "https://control.test", siteAgentId: "pin-site" };
    const portRef = { current: undefined };
    let capturedTaskLaunchClaim: unknown;
    let capturedLaunchToken = "";
    const taskLaunchClaimStorageKey = "claim-test";
    function saveTaskLaunch(value?: StoredTaskLaunch) { activeTaskLaunch = value; }
${source.slice(start, end)}
    export { performTaskLaunchPatch, TaskLaunchPatchError };
  `, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.code).toString("base64")}`
  );
}

test("a historical runtime Release request is exact and never falls back to active", async () => {
  const state = {
    siteAgentId: "pin-site",
    active: releaseFixture("release-active", 12, "dependency-active"),
    historical: releaseFixture("release-approved", 8, "dependency-approved"),
    calls: [],
  };
  const route = await bundledReleaseRoute(state);
  const request = (url) => ({
    url,
    nextUrl: new URL(url),
    headers: new Headers(),
  });
  const context = { params: { siteAgentId: state.siteAgentId } };

  const exact = await route.GET(
    request("https://control.test/api/site-agents/pin-site/release?runtime=1&capabilityAdapters=0&releaseId=release-approved"),
    context,
  );
  assert.equal(exact.status, 200);
  const exactBody = await exact.json();
  assert.equal(exactBody.release.id, state.historical.id);
  assert.equal(exactBody.release.version, state.historical.version);
  assert.equal(exactBody.release.contentHash, state.historical.contentHash);
  assert.equal(
    exactBody.release.navigationTools[0].source.dependencyHash,
    "dependency-approved",
  );
  assert.deepEqual(state.calls, [["exact", state.siteAgentId, state.historical.id]]);

  const missing = await route.GET(
    request("https://control.test/api/site-agents/pin-site/release?runtime=1&releaseId=release-missing"),
    context,
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, "site_agent_release_not_found");
  assert.equal(state.calls.some(([kind]) => kind === "active"), false);

  const empty = await route.GET(
    request("https://control.test/api/site-agents/pin-site/release?releaseId="),
    context,
  );
  assert.equal(empty.status, 400);
});

test("claimed connected-browser execution carries one immutable pin through refresh and checkpoints", async () => {
  const protocol = await readFile(new URL("../lib/site-knowledge/protocol.ts", import.meta.url), "utf8");
  const taskLaunch = protocol.slice(
    protocol.indexOf("export type TaskLaunch ="),
    protocol.indexOf("export type CapabilityRunStatus"),
  );
  for (const field of ["releaseId?: string", "releaseVersion?: number", "revisionId?: string"]) {
    assert.ok(taskLaunch.includes(field), `${field} must be part of TaskLaunch`);
  }

  const port = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const callEntry = port.slice(
    port.indexOf("private async callCapability("),
    port.indexOf("\n  async call(", port.indexOf("private async callCapability(")),
  );
  assert.match(callEntry, /trustedTaskLaunch[\s\S]*task_launch_execution_pin_incomplete/);
  assert.match(callEntry, /await this\.refresh\(trustedExecutionPin\?\.releaseId\)/);
  assert.ok(
    callEntry.indexOf("await this.refresh(trustedExecutionPin?.releaseId)")
      < callEntry.indexOf("const catalog = trustedTaskLaunch"),
    "the exact Release must load before capability lookup",
  );
  assert.match(
    port,
    /if \(pin && \(release\.id !== pin\.releaseId \|\| release\.version !== pin\.releaseVersion\)\) return/,
    "background refreshes cannot replace an executing pinned Release",
  );
  const saveCheckpoint = port.slice(
    port.indexOf("private saveCheckpoint("),
    port.indexOf("\n  private storeCheckpointLocally", port.indexOf("private saveCheckpoint(")),
  );
  assert.match(saveCheckpoint, /\.\.\.\(executionPin \|\| \{\}\)/);
  const resume = port.slice(
    port.indexOf("private async resumeCheckpoint()"),
    port.indexOf("\n  private operation(", port.indexOf("private async resumeCheckpoint()")),
  );
  assert.match(resume, /const executionPin = this\.executionPinFrom\(checkpoint\)/);
  assert.ok(
    resume.indexOf("await this.refresh(executionPin.releaseId)")
      < resume.indexOf("await this.executeCapability("),
    "cross-page execution reloads its exact Release before resolving operations",
  );
  assert.match(
    port,
    /async call\(capabilityId:[\s\S]*return this\.callCapability\(capabilityId, input, false\)/,
    "ordinary SiteWake.call remains unpinned",
  );

  const client = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
  assert.match(client, /releaseId\?: string;[\s\S]*releaseVersion\?: number;[\s\S]*revisionId\?: string;/);
  assert.match(client, /executionReleaseId: capturedLaunchToken \? undefined : activeTaskLaunch\?\.releaseId/);
  assert.match(
    client,
    /if \(payload\.launch\.capabilityId && !executionPin\) \{\s*throw new Error\("task_launch_execution_pin_incomplete"\)/,
  );
  assert.match(
    client,
    /saveTaskLaunch\(claimedBase\);[\s\S]*status: "failed"[\s\S]*code: "task_launch_execution_pin_incomplete"/,
    "a claimed capability without a complete pin is acknowledged as a terminal failure",
  );
  assert.match(
    client,
    /callFromClaimedTaskLaunch\(activePort, claimed\.capabilityId, claimed\.input, executionPin!\)/,
  );
  const patchRuntime = await bundledTaskLaunchPatchRuntime();
  const originalFetch = globalThis.fetch;
  const launch = {
    launchId: "launch-test",
    claimKey: "claim-test",
    executionFence: 1,
  };
  try {
    const classify = async (status, error) => {
      globalThis.fetch = async () => Response.json({ error }, { status });
      return patchRuntime.performTaskLaunchPatch(launch, { status: "running" })
        .then(
          () => ({ retryable: undefined }),
          (failure) => ({
            retryable: failure.retryable,
            status: failure.status,
          }),
        );
    };
    assert.deepEqual(await classify(503, "service_unavailable"), {
      retryable: true,
      status: 503,
    });
    assert.deepEqual(await classify(409, "task_launch_update_conflict"), {
      retryable: true,
      status: 409,
    });
    assert.deepEqual(await classify(409, "task_launch_terminal"), {
      retryable: false,
      status: 409,
    });
    assert.deepEqual(await classify(400, "task_launch_patch_invalid"), {
      retryable: false,
      status: 400,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const terminalPersistence = client.slice(
    client.indexOf("async function persistTerminalTaskLaunch("),
    client.indexOf("\n  const host =", client.indexOf("async function persistTerminalTaskLaunch(")),
  );
  assert.match(terminalPersistence, /terminalRetryStartedAt: retryStartedAt/);
  assert.doesNotMatch(
    terminalPersistence,
    /savedAt: Date\.now\(\)/,
    "terminal retries must not refresh the launch retention timestamp forever",
  );
  assert.match(
    terminalPersistence,
    /if \(!retryable \|\| Date\.now\(\) - retryStartedAt >= 15 \* 60_000\)/,
    "permanent failures and exhausted retry windows must discard the continuation",
  );
  assert.ok(
    terminalPersistence.includes(
      "const terminalPatch = value.pendingTerminalPatch ||",
    ),
    "a later abort/error callback cannot replace the first durable terminal intent",
  );
  const cancellation = client.slice(
    client.indexOf("function cancelActiveTaskLaunch()"),
    client.indexOf("\n  const host =", client.indexOf("function cancelActiveTaskLaunch()")),
  );
  assert.match(cancellation, /status: "cancelled"/);
  assert.match(client, /cancel: \(\) => \{ cancelActiveTaskLaunch\(\); activePort\.cancel\(\); \}/);
  assert.match(client, /\.new-chat"\)\.onclick[\s\S]*cancelActiveTaskLaunch\(\);[\s\S]*activePort\.resetConversation\(\)/);
  assert.match(client, /stop\.onclick = \(\) => \{ cancelActiveTaskLaunch\(\); activePort\.cancel\(\)/);
  assert.match(client, /\.cancel"\)!\.onclick = \(\) => \{\s*cancelActiveTaskLaunch\(\); activePort\.cancel\(\)/);
  const initializationFailure = client.slice(
    client.lastIndexOf("}).catch((error) => {"),
    client.lastIndexOf("\n}", client.length),
  );
  assert.ok(
    initializationFailure.indexOf("if (launch.pendingTerminalPatch)")
      < initializationFailure.indexOf('code: "task_launch_release_load_failed"'),
    "ready failures retry an already-saved terminal payload before synthesizing a release-load failure",
  );
});
