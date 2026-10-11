import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/check-model-compatibility.mjs", import.meta.url));

/**
 * A provider stub that can accept or reject per stage. The page-execution
 * request is recognised by the tool set `@page-agent/core` builds, which is the
 * whole point: the two stages send materially different requests.
 */
async function providerStub(decide) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* leave empty */ }
      const toolNames = (payload.tools || []).map((entry) => entry?.function?.name).filter(Boolean);
      const stage = toolNames.includes("search_site_knowledge") ? "runtime-router" : "runtime-page-agent";
      requests.push({ stage, toolNames, payload });
      const verdict = decide(stage);
      if (verdict.ok) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
        return;
      }
      response.writeHead(verdict.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "invalid_request_error", message: verdict.message } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function checkAgainst(stub) {
  try {
    const { stdout } = await run("node", [SCRIPT, "--json"], {
      env: {
        ...process.env,
        OPENAI_BASE_URL: stub.baseUrl,
        OPENAI_API_KEY: "test-key",
        OPENAI_MODEL: "stub-model",
      },
      maxBuffer: 4 * 1024 * 1024,
    });
    return { exitCode: 0, report: JSON.parse(stdout) };
  } catch (error) {
    return { exitCode: error.code ?? 1, report: JSON.parse(error.stdout || "{}") };
  }
}

test("an unknown provider is refused before any request is sent", async (t) => {
  // The server applies a verified per-provider payload policy before forwarding
  // a forced-tool request, and refuses providers it has no rule for. The check
  // has to fail the same way, or it would bless a provider production rejects.
  const stub = await providerStub(() => ({ ok: true }));
  t.after(() => stub.close());

  const { exitCode, report } = await checkAgainst(stub);
  const pageExecution = report.results.find((result) => result.stage === "runtime-page-agent");

  assert.equal(exitCode, 1);
  assert.equal(pageExecution.ok, false);
  assert.match(pageExecution.detail, /provider payload policy/);
});

test("the routing stage is still probed over HTTP", async (t) => {
  // Routing does not force a tool choice, so it is not gated by the policy and
  // exercises the real request path end to end.
  const stub = await providerStub(() => ({ ok: true }));
  t.after(() => stub.close());

  await checkAgainst(stub);
  const routing = stub.requests.find((entry) => entry.stage === "runtime-router");

  assert.ok(routing, "the routing stage must reach the provider");
  assert.ok(routing.toolNames.includes("search_site_knowledge"));
});

test("a routing failure is reported with the provider's own reason", async (t) => {
  const stub = await providerStub(() => ({ ok: false, status: 400, message: "unsupported tool schema" }));
  t.after(() => stub.close());

  const { exitCode, report } = await checkAgainst(stub);
  const routing = report.results.find((result) => result.stage === "runtime-router");

  assert.equal(exitCode, 1);
  assert.equal(routing.status, 400);
  assert.match(routing.detail, /unsupported tool schema/);
});

test("the page-execution payload is the library's own, normalised by the production policy", async () => {
  // Capture the request the agent library actually builds, then run it through
  // the same policy the server applies. This is the pairing that matters: the
  // library forces a tool choice, and several providers only accept that with
  // thinking mode disabled.
  const { build } = await import("esbuild");
  const bundle = await build({
    stdin: {
      contents: 'export { applyProviderPayloadPolicy } from "./lib/site-knowledge/provider-payload-policy";',
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "ts",
    },
    bundle: true, format: "esm", platform: "node", write: false,
  });
  const { applyProviderPayloadPolicy } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

  const forced = { model: "qwen3.7-plus", tool_choice: "required", messages: [], tools: [] };
  const normalised = applyProviderPayloadPolicy({
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-plus",
    payload: forced,
  });

  assert.equal(normalised.enable_thinking, false,
    "a forced tool choice must arrive with thinking disabled, or the provider rejects it");

  assert.throws(() => applyProviderPayloadPolicy({
    baseUrl: "https://unknown.example/v1",
    model: "whatever",
    payload: forced,
  }), /thinking policy/, "an unverified provider must fail closed rather than be guessed at");
});

test("an unreachable provider fails the check rather than passing silently", async () => {
  const { exitCode, report } = await checkAgainst({ baseUrl: "http://127.0.0.1:1/v1" });

  assert.notEqual(exitCode, 0);
  assert.equal(report.passed, false);
});

test("the check is registered as a runnable script", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(manifest.scripts["check:model-compat"], "switching models must be one command away, not tribal knowledge");
  assert.match(manifest.scripts["check:model-compat"], /check-model-compatibility\.mjs/);
});

test("a provider error keeps enough detail to diagnose it", async () => {
  const route = await import(new URL("../app/api/site-agents/[siteAgentId]/model/v2/chat/completions/route.ts", import.meta.url).href)
    .catch(() => undefined);
  // The route module pulls in server-only bindings; when it cannot be imported
  // directly, assert on the source instead of skipping the guarantee.
  if (route?.modelProviderErrorDetail) {
    const detail = route.modelProviderErrorDetail(JSON.stringify({
      error: { code: "invalid_request_error", type: "invalid_request", message: "unsupported tool schema" },
    }));
    assert.match(detail, /invalid_request_error/);
    assert.match(detail, /unsupported tool schema/);
    return;
  }
  const source = await readFile(
    new URL("../app/api/site-agents/[siteAgentId]/model/v2/chat/completions/route.ts", import.meta.url), "utf8");
  assert.match(source, /errorDetail: modelProviderErrorDetail\(failure\?\.text\)/,
    "an upstream failure must persist the provider's own message, not just a status code");
  assert.match(source, /httpStatus: failure\?\.status/,
    "the status has to be queryable on its own, not only embedded in a string code");
});

test("the invocation record has a field for the provider detail", async () => {
  const protocol = await readFile(new URL("../lib/site-knowledge/protocol.ts", import.meta.url), "utf8");
  const invocation = /export type ModelInvocation = \{([\s\S]*?)\n\};/.exec(protocol)?.[1] || "";

  assert.match(invocation, /errorDetail\?: string;/,
    "without a place to store it, the provider's reason is lost the moment the request fails");
});
