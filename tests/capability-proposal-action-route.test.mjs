import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const stateKey = "__SITEWAKE_CAPABILITY_PROPOSAL_ACTION_ROUTE_TEST__";
const state = { authorized: false, calls: [], error: undefined };
globalThis[stateKey] = state;

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../app/api/site-agents/[siteAgentId]/capability-center/proposals/[proposalId]/actions/route.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [{
    name: "capability-proposal-action-route-test-seams",
    setup(builder) {
      builder.onResolve({ filter: /^@\/(.*)$/ }, (args) => ({
        path: `${fileURLToPath(new URL(`../${args.path.slice(2)}`, import.meta.url))}.ts`,
      }));
      builder.onLoad({ filter: /[\\/]lib[\\/]capability-center[\\/]proposal-service\.ts$/ }, () => ({
        contents: `
          const state = globalThis[${JSON.stringify(stateKey)}];
          export async function forceCapabilityProposalTask(siteAgentId, proposalId, options) {
            state.calls.push({ siteAgentId, proposalId, options });
            if (state.error) throw Object.assign(new Error(state.error), { code: state.error });
            return { queued: true, proposal: { id: proposalId, siteAgentId, status: "accepted" }, task: { id: "task-1" } };
          }
        `,
        loader: "ts",
      }));
      builder.onLoad({ filter: /[\\/]app[\\/]api[\\/]site-agents[\\/]http\.ts$/ }, () => ({
        contents: `
          const state = globalThis[${JSON.stringify(stateKey)}];
          export async function managementMutationAuthorized() { return state.authorized; }
          export function siteAgentJson(payload, status = 200, headers = {}) {
            return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
          }
          export function siteAgentOptions() { return new Response(null, { status: 204 }); }
        `,
        loader: "ts",
      }));
    },
  }],
});

const route = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test.after(() => { delete globalThis[stateKey]; });

const context = { params: Promise.resolve({ siteAgentId: "site-1", proposalId: "proposal-1" }) };

test("proposal force action authenticates before mutating", async () => {
  state.authorized = false;
  state.calls.length = 0;
  const response = await route.POST(new Request("http://localhost/api/action", { method: "POST" }), context);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
  assert.deepEqual(state.calls, []);
});

test("proposal force action validates input and returns the queued task", async () => {
  state.authorized = true;
  state.calls.length = 0;
  const invalid = await route.POST(new Request("http://localhost/api/action", {
    method: "POST",
    body: JSON.stringify({ action: "unknown" }),
    headers: { "content-type": "application/json" },
  }), context);
  assert.equal(invalid.status, 400);
  assert.deepEqual(state.calls, []);

  const accepted = await route.POST(new Request("http://localhost/api/action", {
    method: "POST",
    body: JSON.stringify({ action: "force-create-task", reason: "administrator supplied a test account" }),
    headers: { "content-type": "application/json" },
  }), context);
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), {
    queued: true,
    proposal: { id: "proposal-1", siteAgentId: "site-1", status: "accepted" },
    task: { id: "task-1" },
  });
  assert.deepEqual(state.calls, [{
    siteAgentId: "site-1",
    proposalId: "proposal-1",
    options: { reason: "administrator supplied a test account" },
  }]);
});

test("proposal force action preserves not-found and conflict distinctions", async () => {
  state.authorized = true;
  state.calls.length = 0;
  state.error = "capability_proposal_not_found";
  const missing = await route.POST(new Request("http://localhost/api/action", {
    method: "POST",
    body: JSON.stringify({ action: "force-create-task" }),
  }), context);
  assert.equal(missing.status, 404);
  state.error = "capability_proposal_not_blocked";
  const conflict = await route.POST(new Request("http://localhost/api/action", {
    method: "POST",
    body: JSON.stringify({ action: "force-create-task" }),
  }), context);
  assert.equal(conflict.status, 409);
  state.error = undefined;
});
