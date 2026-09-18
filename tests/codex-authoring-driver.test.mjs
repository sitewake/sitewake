import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { writeFile, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function load(entry) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const harnessMod = await load("../lib/site-knowledge/authoring-harness.ts");
const codexMod = await load("../runner/codex-authoring-driver.ts");

const verifier = { success: [], noResult: [], businessRejection: [] };
const CAP = `export const capability={version:1,stages:[{id:"extract",run(){return {output:{title:"x"}}}}]};`;
const MODEL_ENV = { MODEL_BASE_URL: "https://model.test/v1", MODEL_API_KEY: "secret", MODEL: "deepseek-test" };

async function authoringTool(env, tool, input = {}) {
  const config = await readFile(join(env.CODEX_HOME, "config.toml"), "utf8");
  const url = config.match(/SITEWAKE_AUTHORING_BRIDGE_URL = "([^"]+)"/)?.[1];
  const token = config.match(/SITEWAKE_AUTHORING_BRIDGE_TOKEN = "([^"]+)"/)?.[1];
  assert.ok(url && token, config);
  const response = await fetch(`${url}/tool`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ tool, input }) });
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text);
}

function bridge() {
  return {
    async getDom() { return { snapshotId: "s1", url: "https://shop.test/", kind: "semantic", content: "results grid" }; },
    async executeJs() { return { url: "https://shop.test/", transition: "none" }; },
    async runDraft({ runId }) { return { fixtureId: "", runId, outcome: "success", producedFieldIds: ["title"], producedValues: { title: "x" } }; },
  };
}

function deps(extra = {}) {
  return {
    build,
    bridge: bridge(),
    persistModule: async () => ({ contentHash: "d".repeat(64), moduleUrl: "/programs/d.js", exportName: "capability" }),
    verifier,
    coreFieldIds: ["title"],
    now: () => "2026-07-19T00:00:00.000Z",
    ...extra,
  };
}

test("buildCodexPrompt states the contract, core fields and appends prior feedback", () => {
  const prompt = codexMod.buildCodexPrompt({ goal: "search products", coreFieldIds: ["title", "price"] }, "- c1: missing field price");
  assert.match(prompt, /search products/);
  assert.match(prompt, /title, price/);
  assert.match(prompt, /Do not import Playwright/);
  assert.match(prompt, /missing field price/);
  assert.match(prompt, /automatically run the smoke case and submit/);
  assert.match(prompt, /capability.*version: 1/);
  assert.match(prompt, /navigation must be its final action/);
  assert.match(prompt, /run_draft/);
  assert.match(prompt, /Repeated observation without action ends the round/);
  assert.doesNotMatch(prompt, /OpenCLI|executor\.act|page\.goto/);
  assert.doesNotMatch(prompt, /extractList|textOf|ctx\.result/);
  assert.match(prompt, /get_dom progressively/);
  assert.match(prompt, /sitewake_authoring\.write_file/);
  assert.doesNotMatch(prompt, /MUST call/);
});

test("task-local authoring bridge exposes only the bounded browser harness", () => {
  const source = codexMod.buildAuthoringCliSource();
  assert.match(source, /new Set\(\["get_dom", "execute_js", "write_file", "run_draft"\]\)/);
  assert.match(source, /SITEWAKE_AUTHORING_QUEUE_DIR/);
  assert.match(source, /\.request\.json/);
  assert.match(source, /\.response\.json/);
  assert.doesNotMatch(source, /fetch\(/);
  assert.doesNotMatch(source, /eval|Function\(/);
});

test("Codex provider uses the shared SiteWake model URL, key and model", () => {
  const provider = codexMod.resolveCodexProviderConfig(MODEL_ENV);
  assert.deepEqual(provider, { model: "deepseek-test", baseUrl: "https://model.test/v1", apiKeyEnv: "MODEL_API_KEY" });
  const config = codexMod.buildCodexConfig(provider, { command: "/usr/bin/node", args: ["mcp.js"], bridgeUrl: "http://127.0.0.1:1", bridgeToken: "token" });
  assert.match(config, /model_provider = "sitewake"/);
  assert.match(config, /base_url = "https:\/\/model\.test\/v1"/);
  assert.match(config, /env_key = "MODEL_API_KEY"/);
  assert.match(config, /wire_api = "responses"/);
  assert.match(config, /mcp_servers\.sitewake_authoring/);
  assert.match(config, /enabled_tools = \["get_dom", "execute_js", "write_file", "run_draft"\]/);
  assert.match(config, /required = true/);
  assert.equal(codexMod.resolveCodexProviderConfig({ ...MODEL_ENV, MODEL_BASE_URL: "https://model.test" })?.baseUrl, "https://model.test/v1");
  assert.equal(codexMod.resolveCodexProviderConfig({ ...MODEL_ENV, MODEL_BASE_URL: "https://ark.cn-beijing.volces.com/api/coding/v3" })?.baseUrl, "https://ark.cn-beijing.volces.com/api/coding/v3");
  assert.deepEqual(
    codexMod.resolveCodexProviderConfig({
      OPENAI_MODEL: "alias-model",
      OPENAI_BASE_URL: "https://alias.test/v1",
      OPENAI_API_KEY: "alias-key",
      MODEL: "canonical-model",
      MODEL_BASE_URL: "https://canonical.test/v1",
      MODEL_API_KEY: "canonical-key",
    }),
    { model: "canonical-model", baseUrl: "https://canonical.test/v1", apiKeyEnv: "MODEL_API_KEY" },
  );
  // The authoring runner works on the execution tier when one is configured.
  assert.equal(
    codexMod.resolveCodexProviderConfig({ ...MODEL_ENV, MODEL_EXECUTION: "execution-tier" })?.model,
    "execution-tier",
  );
});

test("collectWorkspaceFromDir keeps valid VFS files and drops foreign ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lc-collect-"));
  await writeFile(join(dir, "capability.ts"), CAP);
  await writeFile(join(dir, "fixtures.json"), `{ "cases": [] }`);
  await writeFile(join(dir, "evil.sh"), "rm -rf /");
  const files = await codexMod.collectWorkspaceFromDir(dir);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["capability.ts", "fixtures.json"]);
});

test("CodexAuthoringDriver uses the task-scoped Responses adapter for MCP namespace tools", async () => {
  const { CodexAuthoringDriver } = codexMod;
  const { runAuthoringSession } = harnessMod;
  const calls = [];
  const runCodex = async ({ dir, env, sandbox }) => {
    const config = await readFile(join(env.CODEX_HOME, "config.toml"), "utf8");
    assert.match(config, /base_url = "http:\/\/control\.test\/api\/site-agents\/site\/model\/v2"/);
    assert.match(config, /wire_api = "responses"/);
    assert.equal(sandbox, process.platform === "win32" ? "danger-full-access" : "workspace-write");
    await writeFile(join(dir, "capability.ts"), CAP);
    await writeFile(join(dir, "fixtures.json"), `{ "cases": [{ "id": "c1", "input": { "q": "x" }, "expect": { "fields": ["title"] } }] }`);
    for (const tool of ["get_dom", "execute_js", "run_draft"]) {
      calls.push(tool);
      await authoringTool(env, tool, tool === "execute_js" ? { source: "document.title" } : tool === "run_draft" ? { input: { q: "x" } } : {});
    }
    return { ok: true };
  };
  const driver = new CodexAuthoringDriver({ runCodex, rounds: 2, seedObservation: true, env: MODEL_ENV });
  const result = await runAuthoringSession(driver, { goal: "search", coreFieldIds: ["title"], modelProxyBaseUrl: "http://control.test/api/site-agents/site/model/v2" }, deps());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.kind, "codex");
  assert.equal(result.implementation.proof.codingAgent, "codex");
  assert.ok(result.implementation.proof.workspaceHash);
  assert.deepEqual(calls, ["get_dom", "execute_js", "run_draft"]);
});

test("CodexAuthoringDriver continues the same workspace when the first turn only observes", async () => {
  const { CodexAuthoringDriver } = codexMod;
  const { runAuthoringSession } = harnessMod;
  let round = 0;
  const runCodex = async ({ dir, prompt, env, sandbox }) => {
    assert.equal(sandbox, "workspace-write");
    round += 1;
    if (round === 1) {
      await authoringTool(env, "get_dom");
      return { ok: true, output: "Observed the page." };
    }
    assert.match(prompt, /Continue the same workspace now/);
    await writeFile(join(dir, "capability.ts"), CAP);
    await writeFile(join(dir, "fixtures.json"), `{ "cases": [{ "id": "c1", "input": {}, "expect": { "fields": ["title"] } }] }`);
    return { ok: true };
  };
  const driver = new CodexAuthoringDriver({ runCodex, rounds: 3, seedObservation: false, env: MODEL_ENV });
  const result = await runAuthoringSession(driver, { goal: "search", coreFieldIds: ["title"] }, deps());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(round, 2);
});

test("CodexAuthoringDriver ignores model edits to generated fixtures", async () => {
  const { CodexAuthoringDriver } = codexMod;
  const { runAuthoringSession } = harnessMod;
  let round = 0;
  const runCodex = async ({ dir }) => {
    round += 1;
    await writeFile(join(dir, "capability.ts"), CAP);
    await writeFile(join(dir, "fixtures.json"), `{ "cases": [{ "id": "c1", "input": {}, "expect": { "fields": ["title", "price"] } }] }`);
    return { ok: true };
  };
  const driver = new CodexAuthoringDriver({ runCodex, rounds: 3, seedObservation: false, env: MODEL_ENV });
  const result = await runAuthoringSession(driver, { goal: "search", coreFieldIds: ["title"] }, deps());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(round, 1);
  const fixture = result.workspace.files.find((file) => file.path === "fixtures.json");
  assert.doesNotMatch(fixture.content, /price/);
});

test("CodexAuthoringDriver stops a runaway tool loop at the per-job budget", async () => {
  const { CodexAuthoringDriver } = codexMod;
  const { runAuthoringSession } = harnessMod;
  let accepted = 0;
  let aborted = false;
  const runCodex = async ({ env, signal }) => {
    for (let index = 0; index < 20; index += 1) {
      try {
        const tool = index % 2 ? "execute_js" : "get_dom";
        await authoringTool(env, tool, tool === "execute_js" ? { source: "document.title" } : {});
        accepted += 1;
      } catch (error) {
        assert.match(String(error), /authoring_tool_budget_exceeded:total:8/);
        aborted = signal.aborted;
        return { ok: false, error: String(error) };
      }
    }
    return { ok: true };
  };
  const driver = new CodexAuthoringDriver({ runCodex, rounds: 1, seedObservation: false, maxToolCalls: 8, env: MODEL_ENV });
  const result = await runAuthoringSession(driver, { goal: "search", coreFieldIds: ["title"] }, deps());
  assert.equal(result.ok, false);
  assert.equal(accepted, 8);
  assert.equal(aborted, true);
});

test("CodexAuthoringDriver interrupts consecutive observation without action and uses the correction round", async () => {
  const { CodexAuthoringDriver } = codexMod;
  const { runAuthoringSession } = harnessMod;
  let round = 0;
  let firstRoundAborted = false;
  const runCodex = async ({ dir, prompt, env, signal }) => {
    round += 1;
    if (round === 1) {
      try {
        for (let index = 0; index < 4; index += 1) await authoringTool(env, "get_dom", { snapshotId: `snapshot-${index}` });
      } catch (error) {
        assert.match(String(error), /authoring_observation_stalled:get_dom_without_action:4/);
        firstRoundAborted = signal.aborted;
        return { ok: false, error: String(error) };
      }
    }
    assert.match(prompt, /final correction round/);
    assert.match(prompt, /Collected page evidence/);
    await assert.rejects(
      authoringTool(env, "get_dom", { selector: "main" }),
      /authoring_observation_locked:use_collected_evidence_and_edit_capability\.ts_now/,
    );
    assert.equal(signal.aborted, false, "one locked observation should return a correction without killing the final round");
    await writeFile(join(dir, "capability.ts"), CAP);
    return { ok: true };
  };
  const driver = new CodexAuthoringDriver({ runCodex, rounds: 2, seedObservation: false, env: MODEL_ENV });
  const result = await runAuthoringSession(driver, { goal: "search", coreFieldIds: ["title"] }, deps());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(round, 2);
  assert.equal(firstRoundAborted, true);
});

test("CodexAuthoringDriver aborts a coding process at the wall-clock budget", async () => {
  const { CodexAuthoringDriver } = codexMod;
  const { runAuthoringSession } = harnessMod;
  const runCodex = ({ signal }) => new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve({ ok: false, error: "aborted" }), { once: true });
  });
  const driver = new CodexAuthoringDriver({ runCodex, rounds: 1, seedObservation: false, timeoutMs: 100, env: MODEL_ENV });
  const started = Date.now();
  const result = await runAuthoringSession(driver, { goal: "search", coreFieldIds: ["title"] }, deps());
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" "), /authoring_time_budget_exceeded:100/);
  assert.ok(Date.now() - started < 2_000);
});

test("CodexAuthoringDriver propagates a Runner lease abort to the active coding process", async () => {
  const { CodexAuthoringDriver } = codexMod;
  const { runAuthoringSession } = harnessMod;
  const leaseController = new AbortController();
  let childAborted = false;
  let signalReady;
  const started = new Promise((resolve) => {
    signalReady = resolve;
  });
  const runCodex = ({ signal }) => new Promise((resolve) => {
    if (signal.aborted) {
      childAborted = true;
      resolve({ ok: false, error: "runner lease lost" });
      return;
    }
    signalReady();
    signal.addEventListener("abort", () => {
      childAborted = true;
      resolve({ ok: false, error: "runner lease lost" });
    }, { once: true });
  });
  const driver = new CodexAuthoringDriver({
    runCodex,
    rounds: 1,
    seedObservation: false,
    signal: leaseController.signal,
    env: MODEL_ENV,
  });
  const pending = runAuthoringSession(driver, { goal: "search", coreFieldIds: ["title"] }, deps());

  await started;
  leaseController.abort(new Error("runner_lease_lost"));
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(childAborted, true);
  assert.match(result.reasons.join(" "), /runner_lease_lost/);
});

test("defaultCodexRunner closes stdin so Codex does not wait for additional piped input", async () => {
  const source = await readFile(new URL("../runner/codex-authoring-driver.ts", import.meta.url), "utf8");
  assert.match(source, /stdio:\s*\[\s*"ignore",\s*"pipe",\s*"pipe"\s*\]/);
  assert.match(source, /Reading additional input from stdin/);
});

test("default Codex invocation uses the project-pinned CLI instead of an OS execution alias", () => {
  const invocation = codexMod.resolveCodexInvocation("codex", process.cwd());
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.prefixArgs.length, 1);
  assert.match(
    invocation.prefixArgs[0].replaceAll("\\", "/"),
    /node_modules\/@openai\/codex\/bin\/codex\.js$/,
  );
  assert.deepEqual(
    codexMod.resolveCodexInvocation("custom-codex", process.cwd()),
    { command: "custom-codex", prefixArgs: [] },
  );
});

test("Runner-spawned Codex does not inherit Desktop thread or permission authority", () => {
  const isolated = codexMod.standaloneCodexEnv({
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
    CODEX_PERMISSION_PROFILE: "managed-read-only",
    CODEX_THREAD_ID: "thread-parent",
    MODEL_API_KEY: "secret",
  });
  assert.equal(isolated.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
  assert.equal(isolated.CODEX_PERMISSION_PROFILE, undefined);
  assert.equal(isolated.CODEX_THREAD_ID, undefined);
  assert.equal(isolated.MODEL_API_KEY, "secret");
});

test("Codex diagnostics stay concise and redact signed URL queries", () => {
  const output = codexMod.conciseCodexOutput([
    "useful failure",
    "2026-01-01 WARN codex_core_plugins sync failed https://files.openai.com/content?id=x&sig=secret",
    `${"x".repeat(2_000)} last detail https://example.test/path?token=secret`,
  ].join("\n"));
  assert.match(output, /https:\/\/example\.test\/path\?\[redacted\]/);
  assert.doesNotMatch(output, /secret/);
  assert.ok(output.length <= 1_000);
});

test("codexAuthoringAvailable requires the shared model triplet", () => {
  assert.equal(codexMod.codexAuthoringAvailable({}), false);
  assert.equal(codexMod.codexAuthoringAvailable({ MODEL_API_KEY: "sk-x" }), false);
  assert.equal(codexMod.codexAuthoringAvailable(MODEL_ENV), true);
});
