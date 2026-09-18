import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

let routeSequence = 0;

async function bundledRoute(t, state) {
  const stateKey = `__CAPABILITY_RUN_ROUTE_STATE_${routeSequence += 1}`;
  globalThis[stateKey] = state;
  t.after(() => {
    delete globalThis[stateKey];
  });
  const result = await build({
    entryPoints: [
      fileURLToPath(new URL(
        "../app/api/validation/runners/[runnerId]/capability-runs/[runId]/route.ts",
        import.meta.url,
      )),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "capability-run-completion-route-stubs",
      setup(builder) {
        builder.onResolve(
          { filter: /^@\/db\/site-agent-store$/ },
          () => ({ path: "site-agent-store", namespace: "route-stub" }),
        );
        builder.onResolve(
          { filter: /^@\/db\/runner-control-store$/ },
          () => ({ path: "runner-control-store", namespace: "route-stub" }),
        );
        builder.onResolve(
          { filter: /^\.\.\/\.\.\/\.\.\/http$/ },
          () => ({ path: "runner-http", namespace: "route-stub" }),
        );
        builder.onLoad(
          { filter: /.*/, namespace: "route-stub" },
          ({ path }) => {
            if (path === "site-agent-store") {
              return {
                loader: "ts",
                contents: `
                  const state = globalThis[${JSON.stringify(stateKey)}];
                  export async function resolveCapabilityRunLeaseControl() {
                    state.resolveCalls += 1;
                    return state.control;
                  }
                  export async function updateCapabilityRunFromRunner(
                    runnerId,
                    leaseToken,
                    runId,
                    body,
                    options,
                  ) {
                    state.updateCalls.push({
                      runnerId,
                      leaseToken,
                      runId,
                      body,
                      options,
                    });
                    if (state.updateFailures > 0) {
                      state.updateFailures -= 1;
                      throw new Error("capability_run_update_failed");
                    }
                    if (state.acceptedPayload
                      && JSON.stringify(state.acceptedPayload) !== JSON.stringify(body)) {
                      throw new Error("invalid_runner_lease");
                    }
                    state.acceptedPayload ||= structuredClone(body);
                    return {
                      run: {
                        id: runId,
                        status: state.canonicalStatus || body.status,
                      },
                      ...(options?.allowCompletedRetry ? { duplicate: true } : {}),
                    };
                  }
                `,
              };
            }
            if (path === "runner-control-store") {
              return {
                loader: "ts",
                contents: `
                  const state = globalThis[${JSON.stringify(stateKey)}];
                  export async function authorizeRunnerInstanceSession(runnerId, auth) {
                    state.authorizeCalls.push({ runnerId, auth });
                    if (state.authorizeFailure) throw new Error("runner_session_required");
                    return { id: auth.sessionId || "session-route" };
                  }
                  export async function acquireRunnerLeaseCompletion() {
                    state.acquireCalls += 1;
                    return state.beginResults.shift() || {
                      duplicate: false,
                      inProgress: false,
                    };
                  }
                  export async function completeRunnerLease(input) {
                    state.completeCalls.push(input);
                    if (state.completeFailures > 0) {
                      state.completeFailures -= 1;
                      throw new Error("runner_control_temporarily_unavailable");
                    }
                    return { lease: { status: input.status } };
                  }
                  export async function abortRunnerLeaseCompletion(input) {
                    state.abortCalls.push(input);
                    return { lease: { status: "active" } };
                  }
                  export async function renewRunnerLease() {
                    state.renewCalls += 1;
                  }
                `,
              };
            }
            return {
              loader: "ts",
              contents: `
                const state = globalThis[${JSON.stringify(stateKey)}];
                export function legacyRunnerProtocolEnabled() { return false; }
                export function runnerControlHeadersPlausible(request, options) {
                  return Boolean(
                    request.headers.get("x-sitewake-runner-session-id")
                    && request.headers.get("x-sitewake-runner-session-token")
                    && (!options?.requireLease || request.headers.get("x-sitewake-lease-token"))
                  );
                }
                export function runnerControlErrorStatus(error) {
                  return String(error?.message || error).includes("invalid_runner_lease")
                    ? 409
                    : 500;
                }
                export function runnerJson(body, status = 200) {
                  return Response.json(body, { status });
                }
                export function runnerLeaseControlInput() {
                  return state.control;
                }
                export function runnerOptions() {
                  return new Response(null, { status: 204 });
                }
                export function runnerSessionToken(request) {
                  return request.headers.get("x-sitewake-runner-session-token") || "";
                }
              `,
            };
          },
        );
      },
    }],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
}

function routeState(overrides = {}) {
  return {
    control: {
      runnerId: "runner-route",
      runnerSessionId: "session-route",
      leaseId: "lease-route",
      token: "lease-route.token",
      fence: 1,
    },
    authorizeCalls: [],
    authorizeFailure: false,
    resolveCalls: 0,
    acquireCalls: 0,
    updateCalls: [],
    updateFailures: 0,
    completeCalls: [],
    completeFailures: 0,
    abortCalls: [],
    renewCalls: 0,
    beginResults: [],
    ...overrides,
  };
}

function terminalRequest(output = { pageUrl: "https://route.test/done" }) {
  return {
    status: "completed",
    steps: [],
    timings: { totalMs: 10 },
    artifactIds: [],
    output,
    outcome: {
      status: "success",
      code: "completed",
      summary: "done",
      evaluatedAt: "2026-07-30T02:00:00.000Z",
      evidence: {},
    },
  };
}

function patchRequest(body) {
  return new Request(
    "https://control.test/api/validation/runners/runner-route/capability-runs/run-route",
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-sitewake-lease-token": "lease-route.token",
        "x-sitewake-runner-session-id": "session-route",
        "x-sitewake-runner-session-token": "session-route.token",
      },
      body: JSON.stringify(body),
    },
  );
}

const context = {
  params: { runnerId: "runner-route", runId: "run-route" },
};

test("a transient pre-commit store failure preserves the central completion lock", async (t) => {
  const state = routeState({
    updateFailures: 1,
    beginResults: [{ duplicate: false, inProgress: false, resumed: false }],
  });
  const route = await bundledRoute(t, state);
  const response = await route.PATCH(patchRequest(terminalRequest()), context);

  assert.equal(response.status, 500);
  assert.equal(state.updateCalls.length, 1);
  assert.equal(state.completeCalls.length, 0);
  assert.equal(state.abortCalls.length, 0);
});

test("a post-commit control failure preserves completing and exact replay finalizes it", async (t) => {
  const state = routeState({
    completeFailures: 1,
    beginResults: [
      { duplicate: false, inProgress: false, resumed: false },
      { duplicate: false, inProgress: false, resumed: true },
    ],
  });
  const route = await bundledRoute(t, state);
  const body = terminalRequest();

  const first = await route.PATCH(patchRequest(body), context);
  assert.equal(first.status, 500);
  assert.equal(state.abortCalls.length, 0);
  assert.equal(state.completeCalls.length, 1);

  const replay = await route.PATCH(patchRequest(body), context);
  assert.equal(replay.status, 200);
  assert.equal(state.abortCalls.length, 0);
  assert.equal(state.completeCalls.length, 2);
  assert.equal(state.updateCalls.length, 2);
  assert.equal(state.updateCalls[0].options.allowCompletedRetry, false);
  assert.equal(state.updateCalls[1].options.allowCompletedRetry, true);
});

test("a centrally completed lease still delegates exact terminal replay checks to the Run receipt", async (t) => {
  const accepted = terminalRequest();
  const state = routeState({
    acceptedPayload: accepted,
    beginResults: [{
      duplicate: true,
      inProgress: false,
      lease: { completion: { result: { stale: true } } },
    }],
  });
  const route = await bundledRoute(t, state);
  const response = await route.PATCH(
    patchRequest(terminalRequest({ pageUrl: "https://route.test/conflict" })),
    context,
  );

  assert.equal(response.status, 409);
  assert.equal(state.updateCalls.length, 1);
  assert.equal(state.updateCalls[0].options.allowCompletedRetry, true);
  assert.equal(state.completeCalls.length, 0);
  assert.equal(state.abortCalls.length, 0);
});

test("malformed completion JSON is rejected before acquiring a completion lock", async (t) => {
  const state = routeState();
  const route = await bundledRoute(t, state);
  const response = await route.PATCH(
    new Request(
      "https://control.test/api/validation/runners/runner-route/capability-runs/run-route",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-sitewake-lease-token": "lease-route.token",
          "x-sitewake-runner-session-id": "session-route",
          "x-sitewake-runner-session-token": "session-route.token",
        },
        body: "{",
      },
    ),
    context,
  );

  assert.equal(response.status, 400);
  assert.equal(state.acquireCalls, 0);
  assert.equal(state.updateCalls.length, 0);
});
