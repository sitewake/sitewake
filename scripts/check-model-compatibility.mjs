#!/usr/bin/env node
/**
 * Verify a model can serve BOTH runtime stages before it is put in front of
 * users.
 *
 * Why this exists: the page-execution stage does not build its own request —
 * `@page-agent/core` does, with its own tool definitions and message shape. In
 * production a model once accepted every routing request and rejected every
 * page-execution request with HTTP 400, and nothing caught it until tasks
 * started failing. Checking only the routing stage proves nothing about the
 * stage that actually operates the page.
 *
 * The page-execution request is captured from the real library rather than
 * hand-written here: a hand-written copy would drift and stop proving anything.
 * The same capture is what `--write-fixture` commits to
 * `scripts/fixtures/page-execution-request.json`, so the setup wizard can
 * replay it before `npm install`; `tests/model-check-fixture.test.mjs` fails
 * the moment the committed copy and a fresh capture disagree.
 *
 * Usage:
 *   node scripts/check-model-compatibility.mjs
 *   node scripts/check-model-compatibility.mjs --json
 *   node scripts/check-model-compatibility.mjs --write-fixture
 *
 * Reads the same provider configuration the runtime uses: the canonical
 * MODEL_BASE_URL / MODEL_API_KEY / MODEL names first, then OPENAI_* — the same
 * order as lib/model-config.ts.
 * The console writes the canonical names, so omitting them made this check
 * unusable on any installation it had configured. Exit 0 means both stages passed.
 */
import process from "node:process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
import { verifyStages } from "./model-check-core.mjs";
import { cli, resolveCliLocale } from "./cli-copy.mjs";

const asJson = process.argv.includes("--json");
const writeFixture = process.argv.includes("--write-fixture");

export const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/page-execution-request.json", import.meta.url));

function providerConfig() {
  const env = process.env;
  const apiKey = env.MODEL_API_KEY || env.OPENAI_API_KEY;
  const baseUrl = env.MODEL_BASE_URL || env.OPENAI_BASE_URL;
  const model = env.MODEL || env.OPENAI_MODEL;
  const executionModel = env.MODEL_EXECUTION || model;
  return { apiKey, baseUrl, model, executionModel };
}

/**
 * Drive the real page-execution agent with a stub page and a fetch hook that
 * captures the outgoing request instead of sending it. Whatever the library
 * would have sent to the provider is what we then replay.
 */
export async function capturePageExecutionRequest() {
  const bundle = await build({
    stdin: {
      contents: `
        import { PageAgentCore, tool } from "@page-agent/core";
        import * as z from "zod/v4";
        import { applyProviderPayloadPolicy } from "./lib/site-knowledge/provider-payload-policy";
        export { PageAgentCore, tool, z, applyProviderPayloadPolicy };
      `,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const { PageAgentCore, tool, z, applyProviderPayloadPolicy } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

  // The agent only has to get far enough to build one request, so every page
  // operation is a no-op. A permissive proxy keeps this working if the library
  // starts calling a method it did not call before.
  const pageController = new Proxy({
    async getBrowserState() {
      return {
        url: "https://compatibility.check/",
        title: "Compatibility check",
        header: "",
        content: "[1] button \"Search\"\n[2] input \"Query\"",
        footer: "",
      };
    },
    getLastUpdateTime() { return Date.now(); },
  }, {
    get(target, property) {
      if (property in target) return Reflect.get(target, property);
      return async () => undefined;
    },
  });

  let captured;
  const agent = new PageAgentCore({
    pageController,
    baseURL: "https://capture.invalid/v1",
    apiKey: "capture",
    model: "capture",
    language: "zh-CN",
    maxSteps: 1,
    maxRetries: 0,
    customFetch: async (_input, init) => {
      captured = JSON.parse(String(init?.body || "{}"));
      // Stop the agent immediately; only the request shape matters here.
      throw new Error("captured");
    },
    customTools: {
      done: tool({
        description: "Finish the task.",
        inputSchema: z.object({ text: z.string() }),
        execute: async () => "done",
      }),
    },
    instructions: {
      system: "compatibility probe",
      getPageInstructions: () => "compatibility probe",
    },
  });

  // The agent narrates its steps to the console. That is noise here, and it
  // would corrupt --json output, so it is silenced for the capture only.
  const console_ = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  console.log = console.info = console.warn = console.error = console.debug = () => {};
  try { await agent.execute("compatibility probe"); }
  catch { /* Expected: the capture hook aborts the run. */ }
  finally { Object.assign(console, console_); }
  if (!captured) throw new Error("page_execution_request_not_captured");
  return { captured, applyProviderPayloadPolicy };
}

/**
 * The library stamps the wall clock into the user message ("Current time:
 * 9/10/2026, 8:56:15 PM", in the machine's locale format). It is the only
 * part of the capture that changes between runs, and a probe does not need it
 * to be current. Pin it so the fixture is byte-stable and the drift test
 * compares shape, not clocks. Applied on both sides: when writing the fixture
 * and to the fresh capture the test compares against it.
 */
export function normalizeVolatile(captured) {
  const messages = (captured.messages || []).map((message) => (
    typeof message.content === "string"
      ? { ...message, content: message.content.replace(/Current time: [^\n]*/g, "Current time: <pinned>") }
      : message
  ));
  return { ...captured, messages };
}

/** The exact bytes the fixture holds: the normalized capture, stable key order, trailing newline. */
export function serializeFixture(captured) {
  const { stream: _stream, ...rest } = normalizeVolatile(captured);
  return `${JSON.stringify(rest, null, 2)}\n`;
}

export async function checkModelCompatibility({ apiKey, baseUrl, model, executionModel = model }, { timeoutMs = 30_000, locale = "en" } = {}) {
  const { captured, applyProviderPayloadPolicy } = await capturePageExecutionRequest();
  return verifyStages({ apiKey, baseUrl, model, executionModel, pageRequest: captured, applyPolicy: applyProviderPayloadPolicy, timeoutMs, locale });
}

async function main() {
  const locale = resolveCliLocale();
  const copy = cli(locale).check;

  if (writeFixture) {
    const { captured } = await capturePageExecutionRequest();
    await writeFile(FIXTURE_PATH, serializeFixture(captured), "utf8");
    console.log(copy.fixtureWritten(FIXTURE_PATH));
    return;
  }

  const { model, executionModel, baseUrl, passed, results } = await checkModelCompatibility(providerConfig(), { locale });
  const routing = results.find((result) => result.stage === "runtime-router");
  const pageExecution = results.find((result) => result.stage === "runtime-page-agent");

  if (asJson) {
    console.log(JSON.stringify({ model, executionModel, baseUrl, passed, results }, null, 2));
  } else {
    console.log(copy.modelLine(model));
    for (const result of results) {
      const mark = result.ok ? copy.pass : copy.fail;
      console.log(`  ${result.stage.padEnd(20)} ${mark}  ${result.status || "-"}  ${result.durationMs}ms${result.detail ? `  ${result.detail}` : ""}`);
    }
    if (routing?.ok && pageExecution && !pageExecution.ok) {
      console.log("");
      console.log(copy.routingOnly1);
      console.log(copy.routingOnly2);
    }
    console.log("");
    console.log(passed ? copy.verdictPass : copy.verdictFail);
  }
  process.exitCode = passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
