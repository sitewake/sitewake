import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { stubModule } from "./support/module-stub.mjs";

let routeSequence = 0;

async function bundledManagementRoute(entry) {
  const stateKey = `__SITEWAKE_MANAGEMENT_ROUTE_${routeSequence += 1}`;
  const state = { storeCalls: [], overviewId: "atlas", updateError: undefined, overviewError: undefined, siteAgentExists: true, siteAgentAccess: "allowed", dismissArgs: undefined, listArgs: undefined, artifactInput: undefined, artifactContentType: undefined, artifactKind: undefined };
  globalThis[stateKey] = state;
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "management-route-fixtures",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]site-agent-store\.ts$/ }, () => ({
          // Reconciled against the real module. `db/agent-run-store.ts` imports
          // `createTaskSession` and `getTaskEpisodeById` from here, which a hand-written
          // list predating them turned into `No matching export` — an esbuild error that
          // reads like the product failing to build. Anything this suite does not stub
          // throws when called, naming itself.
          contents: stubModule(fileURLToPath(new URL("../db/site-agent-store.ts", import.meta.url)), {
            listSiteAgents: `export async function listSiteAgents() {
              called("listSiteAgents");
              return { agents: [], persistence: "memory" };
            }`,
            createSiteAgent: `export async function createSiteAgent() {
              called("createSiteAgent");
              return { persistence: "memory" };
            }`,
            siteAgentExists: `export async function siteAgentExists() {
              called("siteAgentExists");
              return state.siteAgentExists;
            }`,
            siteAgentAccess: `export async function siteAgentAccess() {
              called("siteAgentAccess");
              return state.siteAgentAccess;
            }`,
            getSiteAgentOverview: `export async function getSiteAgentOverview() {
              called("getSiteAgentOverview");
              if (state.overviewError) throw Object.assign(new Error(state.overviewError), { code: state.overviewError });
              return { overview: { id: state.overviewId }, persistence: "memory" };
            }`,
            updateSiteAgent: `export async function updateSiteAgent() {
              called("updateSiteAgent");
              return { release: {}, persistence: "memory" };
            }`,
            getActiveSiteAgentRelease: `export async function getActiveSiteAgentRelease() {
              called("getActiveSiteAgentRelease");
              return { release: { id: "release-0", version: 0, capabilities: [] }, persistence: "memory" };
            }`,
            recordModelInvocation: `export async function recordModelInvocation() {}`,
            activatePreparedSiteAgentReleaseInMemory: `export function activatePreparedSiteAgentReleaseInMemory() {}`,
            listCapabilityProjects: `export async function listCapabilityProjects(siteAgentId, options) {
              called("listCapabilityProjects");
              state.listArgs = { siteAgentId, options };
              if (state.updateError) throw new Error(state.updateError);
              return { projects: [], total: 0, buildTasks: [], buildTaskPage: { hasMoreDuplicates: true, nextDuplicateCursor: "next" }, persistence: "memory" };
            }`,
            getCapabilityProjectDetail: `export async function getCapabilityProjectDetail() {
              called("getCapabilityProjectDetail");
              return { detail: { project: { id: "project-1" } }, persistence: "memory" };
            }`,
            listCapabilityRuns: `export async function listCapabilityRuns() {
              called("listCapabilityRuns");
              return { runs: [], persistence: "memory" };
            }`,
            getCapabilityRun: `export async function getCapabilityRun() {
              called("getCapabilityRun");
              return { run: { id: "run-1" }, persistence: "memory" };
            }`,
            getTaskLaunch: `export async function getTaskLaunch() {
              called("getTaskLaunch");
              return { launch: { id: "launch-1" }, persistence: "memory" };
            }`,
            updateTaskLaunch: `export async function updateTaskLaunch() {
              called("updateTaskLaunch");
              if (state.updateError) throw new Error(state.updateError);
              return { launch: { id: "launch-1" }, persistence: "memory" };
            }`,
            dismissDuplicateCapabilityBuildRequest: `export async function dismissDuplicateCapabilityBuildRequest(siteAgentId, buildRequestId) {
              called("dismissDuplicateCapabilityBuildRequest");
              state.dismissArgs = { siteAgentId, buildRequestId };
              if (state.updateError) throw new Error(state.updateError);
              return { dismissed: true, buildRequestId, persistence: "memory" };
            }`,
            getBrowserArtifact: `export async function getBrowserArtifact() {
              called("getBrowserArtifact");
              return {
                artifact: { id: "artifact-1", kind: state.artifactKind || "console", contentType: state.artifactContentType || "text/plain" },
                object: { body: "evidence", size: 8 },
              };
            }`,
            putBrowserArtifact: `export async function putBrowserArtifact(input) {
              called("putBrowserArtifact");
              state.artifactInput = input;
              return { id: "artifact-uploaded", ...input, size: input.bytes.byteLength, url: "/api/artifacts/artifact-uploaded", createdAt: "2026-08-02T00:00:00.000Z" };
            }`,
          }, {
            // The bodies close over this. Dropping it compiles fine and then
            // fails at call time on an undefined helper, which a route reports
            // as 500 with nothing pointing at the cause.
            preamble: `
            const state = globalThis[${JSON.stringify(stateKey)}];
            function called(name) { state.storeCalls.push(name); }
          `,
          }),
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]app[\\/]api[\\/]site-agents[\\/]http\.ts$/ }, () => ({
          // Reconciled the same way: `persistenceHeaders` was the export this stub
          // lacked, exported on line 156 of the real file the whole time.
          contents: stubModule(fileURLToPath(new URL("../app/api/site-agents/http.ts", import.meta.url)), {
            managementAuthorized: `export async function managementAuthorized(request) {
              return request.headers.get("x-test-management") === "authorized";
            }`,
            managementMutationAuthorized: `export async function managementMutationAuthorized(request) {
              return managementAuthorized(request);
            }`,
            runnerAuthorized: `export function runnerAuthorized(request) {
              return request.headers.get("x-test-runner") === "authorized";
            }`,
            siteAgentJson: `export function siteAgentJson(payload, status = 200, headers = {}) {
              return new Response(JSON.stringify(payload), {
                status,
                headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
              });
            }`,
            siteAgentOptions: `export function siteAgentOptions() { return new Response(null, { status: 204 }); }`,
            persistenceHeaders: `export function persistenceHeaders(persistence) {
              return { "x-sitewake-persistence": persistence };
            }`,
            siteAgentNotFoundError: `export function siteAgentNotFoundError(error) {
              return Boolean(error) && (error.code === "site_agent_not_found" || error.message === "site_agent_not_found");
            }`,
            siteAgentFailure: `export function siteAgentFailure(error, fallbackCode, status = 500, headers = {}) {
              if (siteAgentNotFoundError(error)) return siteAgentJson({ error: "site_agent_not_found" }, 404, headers);
              return siteAgentJson({ error: fallbackCode, message: error instanceof Error ? error.message : "unknown" }, status, headers);
            }`,
            brandedEnv: `export function brandedEnv(suffix) {
              return (process.env["SITEWAKE_" + suffix] ?? process.env["SITEWAKE_" + suffix] ?? "").trim();
            }`,
          }),
          loader: "ts",
        }));
        // `app/api/site-agents/http.ts` imports NextResponse, which drags in Next's
        // compiled image-response helper and its CJS `__dirname`. These suites test
        // route authorization, not image rendering; the same stub is used by
        // tests/site-addresses.test.mjs.
        // The legacy runner header is off by default now
        // (SITEWAKE_LEGACY_RUNNER_PROTOCOL=false), so a runner authorizes with an
        // instance session. This suite is about what the route checks before
        // storing bytes, not about how a session is minted.
        builder.onLoad({ filter: /[\\/]db[\\/]runner-control-store\.ts$/ }, () => ({
          contents: stubModule(fileURLToPath(new URL("../db/runner-control-store.ts", import.meta.url)), {
            authorizeRunnerInstanceSession: `export async function authorizeRunnerInstanceSession() {
              return { runnerId: "runner-1", sessionId: "session-1" };
            }`,
          }),
          loader: "ts",
        }));
        builder.onLoad({ filter: /next[\\/]server/ }, () => ({
          contents: "export class NextRequest {}\nexport const NextResponse = {};",
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]lib[\\/]model-config\.ts$/ }, () => ({
          // Reconciled: `lib/capability-center-v2/model-json.ts` imports
          // `modelCompatibility` from here, which a hand-written list predating it
          // turned into `No matching export`.
          contents: stubModule(fileURLToPath(new URL("../lib/model-config.ts", import.meta.url)), {
            publicModelStatus: `export function publicModelStatus() { return { configured: true }; }`,
            getModelConfig: `export function getModelConfig() { return { configured: false, apiKey: "", baseUrl: "", model: "", source: "test" }; }`,
            modelChatCompletionsUrl: `export function modelChatCompletionsUrl() { return "http://model.invalid"; }`,
          }),
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
          contents: `
            export function getArtifactBinding() { return null; }
            export function getD1Binding() { return null; }
            export class D1UnavailableError extends Error {}
          `,
          loader: "ts",
        }));
      },
    }],
  });
  const route = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  return {
    route,
    state,
    cleanup() { delete globalThis[stateKey]; },
  };
}

const managementGets = [
  {
    name: "SiteAgent list",
    entry: "../app/api/site-agents/route.ts",
    url: "http://localhost/api/site-agents",
  },
  {
    name: "SiteAgent overview",
    entry: "../app/api/site-agents/[siteAgentId]/route.ts",
    url: "http://localhost/api/site-agents/atlas",
    params: { siteAgentId: "atlas" },
  },
  {
    name: "capability list",
    entry: "../app/api/site-agents/[siteAgentId]/capability-projects/route.ts",
    url: "http://localhost/api/site-agents/atlas/capability-projects",
    params: { siteAgentId: "atlas" },
  },
  {
    name: "capability detail",
    entry: "../app/api/site-agents/[siteAgentId]/capability-projects/[projectId]/route.ts",
    url: "http://localhost/api/site-agents/atlas/capability-projects/project-1",
    params: { siteAgentId: "atlas", projectId: "project-1" },
  },
  {
    name: "CapabilityRun list",
    entry: "../app/api/site-agents/[siteAgentId]/capability-runs/route.ts",
    url: "http://localhost/api/site-agents/atlas/capability-runs",
    params: { siteAgentId: "atlas" },
  },
  {
    name: "CapabilityRun detail",
    entry: "../app/api/site-agents/[siteAgentId]/capability-runs/[runId]/route.ts",
    url: "http://localhost/api/site-agents/atlas/capability-runs/run-1",
    params: { siteAgentId: "atlas", runId: "run-1" },
  },
  {
    name: "TaskLaunch detail",
    entry: "../app/api/site-agents/[siteAgentId]/task-launches/[launchId]/route.ts",
    url: "http://localhost/api/site-agents/atlas/task-launches/launch-1",
    params: { siteAgentId: "atlas", launchId: "launch-1" },
  },
];

for (const scenario of managementGets) {
  test(`${scenario.name} authenticates before reading its store`, async (t) => {
    const fixture = await bundledManagementRoute(scenario.entry);
    t.after(fixture.cleanup);
    const context = scenario.params ? { params: Promise.resolve(scenario.params) } : undefined;

    const unauthorized = await fixture.route.GET(new Request(scenario.url), context);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), { error: "unauthorized" });
    assert.deepEqual(fixture.state.storeCalls, [], "an unauthorized request must not touch the store");

    const authorized = await fixture.route.GET(new Request(scenario.url, {
      headers: { "x-test-management": "authorized" },
    }), context);
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("cache-control"), "no-store");
    assert.ok(fixture.state.storeCalls.length > 0, "an authorized request should reach its store");
  });
}

test("browser artifact GET authenticates before reading evidence bytes", async (t) => {
  const fixture = await bundledManagementRoute("../app/api/artifacts/[artifactId]/route.ts");
  t.after(fixture.cleanup);
  const url = "http://localhost/api/artifacts/artifact-1";
  const context = { params: Promise.resolve({ artifactId: "artifact-1" }) };

  const unauthorized = await fixture.route.GET(new Request(url), context);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(fixture.state.storeCalls, []);

  const authorized = await fixture.route.GET(new Request(url, {
    headers: { "x-test-management": "authorized" },
  }), context);
  assert.equal(authorized.status, 200);
  assert.equal(await authorized.text(), "evidence");
  assert.match(authorized.headers.get("content-disposition"), /^attachment;/);
  assert.equal(authorized.headers.get("cache-control"), "private, no-store");
  assert.equal(authorized.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(fixture.state.storeCalls, ["getBrowserArtifact"]);

  fixture.state.storeCalls = [];
  fixture.state.artifactContentType = "text/html";
  const legacyMalicious = await fixture.route.GET(new Request(url, {
    headers: { "x-test-management": "authorized" },
  }), context);
  assert.equal(legacyMalicious.headers.get("content-type"), "application/octet-stream");
  assert.match(legacyMalicious.headers.get("content-disposition"), /^attachment;/);
});

test("artifact upload rejects a kind/content-type mismatch before storage", async (t) => {
  const fixture = await bundledManagementRoute("../app/api/artifacts/route.ts");
  t.after(fixture.cleanup);
  const request = (contentType) => new Request("http://localhost/api/artifacts?siteAgentId=atlas", {
    method: "POST",
    headers: {
      "x-sitewake-runner-id": "runner-1",
      "x-sitewake-runner-session-token": "session-token",
      "x-sitewake-learning-job-id": "task-1",
      "x-sitewake-run-id": "run-1",
      "x-sitewake-artifact-kind": "console",
      "content-type": contentType,
    },
    body: "evidence",
  });

  const rejected = await fixture.route.POST(request("text/html"));
  assert.equal(rejected.status, 415);
  assert.deepEqual(fixture.state.storeCalls, []);

  const accepted = await fixture.route.POST(request("text/plain; charset=utf-8"));
  assert.equal(accepted.status, 201);
  assert.equal(fixture.state.artifactInput.contentType, "text/plain");
  assert.deepEqual(fixture.state.storeCalls, ["putBrowserArtifact"]);
});

test("TaskLaunch PATCH reports permanent and transient failures with distinct statuses", async (t) => {
  const fixture = await bundledManagementRoute(
    "../app/api/site-agents/[siteAgentId]/task-launches/[launchId]/route.ts",
  );
  t.after(fixture.cleanup);
  const url = "http://localhost/api/site-agents/atlas/task-launches/launch-1";
  const context = {
    params: Promise.resolve({ siteAgentId: "atlas", launchId: "launch-1" }),
  };
  const request = (body = "{}") => new Request(url, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body,
  });

  const missingOrigin = await fixture.route.PATCH(new Request(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: "{}",
  }), context);
  assert.equal(missingOrigin.status, 403);
  assert.deepEqual(await missingOrigin.json(), { error: "task_launch_origin_required" });

  const invalidJson = await fixture.route.PATCH(request("{"), context);
  assert.equal(invalidJson.status, 400);
  assert.deepEqual(await invalidJson.json(), { error: "invalid_json" });

  for (const [error, status] of [
    ["task_launch_status_invalid", 400],
    ["task_launch_update_rejected", 403],
    ["task_launch_already_terminal", 409],
    ["database_unavailable", 500],
  ]) {
    fixture.state.updateError = error;
    const response = await fixture.route.PATCH(request(), context);
    assert.equal(response.status, status, error);
  }
});

test("duplicate BuildRequest DELETE authenticates, decodes ids, and maps dismissal failures", async (t) => {
  const fixture = await bundledManagementRoute(
    "../app/api/site-agents/[siteAgentId]/capability-build-requests/[buildRequestId]/route.ts",
  );
  t.after(fixture.cleanup);
  const url = "http://localhost/api/site-agents/atlas%20site/capability-build-requests/build-request%3Ajob%2F1";
  const context = {
    params: Promise.resolve({
      siteAgentId: "atlas%20site",
      buildRequestId: "build-request%3Ajob%2F1",
    }),
  };
  const unauthorized = await fixture.route.DELETE(new Request(url, { method: "DELETE" }), context);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(fixture.state.storeCalls, []);

  const authorizedRequest = () => new Request(url, {
    method: "DELETE",
    headers: { "x-test-management": "authorized" },
  });
  const authorized = await fixture.route.DELETE(authorizedRequest(), context);
  assert.equal(authorized.status, 200);
  assert.deepEqual(fixture.state.dismissArgs, {
    siteAgentId: "atlas site",
    buildRequestId: "build-request:job/1",
  });

  for (const [error, status] of [
    ["capability_build_request_id_invalid", 400],
    ["capability_build_request_not_found", 404],
    ["capability_build_request_dismiss_not_allowed", 409],
    ["capability_build_request_dismiss_conflict", 409],
    ["database_unavailable", 500],
  ]) {
    fixture.state.updateError = error;
    const response = await fixture.route.DELETE(authorizedRequest(), context);
    assert.equal(response.status, status, error);
    assert.deepEqual(await response.json(), {
      error: "capability_build_request_dismiss_failed",
      message: error,
    });
  }
});

test("capability list forwards the opaque duplicate cursor and maps invalid cursors", async (t) => {
  const fixture = await bundledManagementRoute(
    "../app/api/site-agents/[siteAgentId]/capability-projects/route.ts",
  );
  t.after(fixture.cleanup);
  const cursor = JSON.stringify(["2026-07-31T12:00:00.000Z", "job/same-time"]);
  const url = new URL("http://localhost/api/site-agents/atlas%20site/capability-projects");
  url.searchParams.set("duplicateCursor", cursor);
  const context = { params: Promise.resolve({ siteAgentId: "atlas%20site" }) };
  const response = await fixture.route.GET(new Request(url, {
    headers: { "x-test-management": "authorized" },
  }), context);
  assert.equal(response.status, 200);
  assert.deepEqual(fixture.state.listArgs, {
    siteAgentId: "atlas site",
    options: {
      status: undefined,
      excludeArchived: false,
      duplicateCursor: cursor,
    },
  });
  assert.deepEqual((await response.json()).buildTaskPage, {
    hasMoreDuplicates: true,
    nextDuplicateCursor: "next",
  });

  fixture.state.updateError = "capability_build_request_cursor_invalid";
  const invalid = await fixture.route.GET(new Request(url, {
    headers: { "x-test-management": "authorized" },
  }), context);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: "capability_projects_failed",
    message: "capability_build_request_cursor_invalid",
  });
});

test("SiteAgent overview keeps the real acme-production path and authenticated success", async (t) => {
  const fixture = await bundledManagementRoute("../app/api/site-agents/[siteAgentId]/route.ts");
  t.after(fixture.cleanup);
  fixture.state.overviewId = "acme-production";
  const url = "http://localhost/api/site-agents/acme-production";
  const context = { params: Promise.resolve({ siteAgentId: "acme-production" }) };
  const response = await fixture.route.GET(new Request(url, {
    headers: { "x-test-management": "authorized" },
  }), context);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).id, "acme-production");
  assert.deepEqual(fixture.state.storeCalls, ["siteAgentExists", "siteAgentAccess", "getSiteAgentOverview"]);
});

test("SiteAgent overview separates auth, permission, missing-resource, and database failures", async (t) => {
  const fixture = await bundledManagementRoute("../app/api/site-agents/[siteAgentId]/route.ts");
  t.after(fixture.cleanup);
  const url = "http://localhost/api/site-agents/acme-production";
  const context = { params: Promise.resolve({ siteAgentId: "acme-production" }) };
  const request = () => new Request(url, { headers: { "x-test-management": "authorized" } });

  const unauthorized = await fixture.route.GET(new Request(url), context);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(fixture.state.storeCalls, []);

  fixture.state.siteAgentAccess = "forbidden";
  const forbidden = await fixture.route.GET(request(), context);
  assert.equal(forbidden.status, 403);
  // The code is the whole response: the console renders the sentence from it, in the
  // reader's language, so an API-side message would only ever be one language.
  assert.deepEqual(await forbidden.json(), { error: "site_agent_forbidden" });
  assert.equal(fixture.state.storeCalls.at(-1), "siteAgentAccess");

  fixture.state.storeCalls = [];
  fixture.state.siteAgentAccess = "allowed";
  fixture.state.siteAgentExists = false;
  const missing = await fixture.route.GET(request(), context);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "site_agent_not_found" });
  assert.deepEqual(fixture.state.storeCalls, ["siteAgentExists"]);

  fixture.state.storeCalls = [];
  fixture.state.siteAgentExists = true;
  fixture.state.overviewError = "site_agent_database_failed";
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const databaseFailure = await fixture.route.GET(request(), context);
    assert.equal(databaseFailure.status, 503);
    // The code and the retry flag are the contract. The message is a fallback for a
    // console that does not know the code, and the server has no reader locale, so its
    // wording is not pinned here.
    const databaseBody = await databaseFailure.json();
    assert.ok(typeof databaseBody.message === "string" && databaseBody.message.trim(), databaseBody.message);
    assert.deepEqual({ ...databaseBody, message: undefined }, {
      error: "site_agent_database_failed",
      message: undefined,
      retryable: true,
      phase: "site_agent_overview_database",
    });
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], "site_agent_request_failed");
  assert.equal(errors[0][1].code, "site_agent_database_failed");
});
