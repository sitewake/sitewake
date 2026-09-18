import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const RUNNER_URL = new URL("../runner/browser-runner.ts", import.meta.url);

async function bundledSharedOperationRunner() {
  const source = await readFile(RUNNER_URL, "utf8");
  const start = source.indexOf("function trustedReleaseOrigins(");
  const end = source.indexOf("\nasync function runCrawl(", start);
  assert.notEqual(start, -1, "shared Release Operation helper must remain executable runner code");
  assert.notEqual(end, -1, "shared Release Operation helper must have a stable function boundary");
  const result = await build({
    stdin: {
      contents: `
        import type {
          BrowserStepReceipt, CapabilityDefinition, CapabilityRevision, JsonPrimitive, JsonValue,
          OperationDefinition, PageProgramStep, SiteAgentReleaseV2, ValueExpression,
        } from "./lib/site-knowledge/protocol";
        import type { Page } from "playwright";
        import { buildSceneUrl, recognizeScene } from "./lib/site-knowledge/url-scene";
        import { assertCapabilityOutput } from "./runner/playwright-stage-runner";
        ${source.slice(start, end)}
        export { ReleaseOperationRunError, runVerifiedReleaseOperationCapability };
      `,
      resolveDir: ROOT,
      sourcefile: "shared-operation-runner.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

function scene(originPattern = "https://knowledge-origin.invalid") {
  return {
    id: "scene-cart",
    name: "购物车",
    evidenceStatus: "observed",
    lifecycle: "observed",
    urlTemplates: [{
      id: "url-cart",
      originPattern,
      pathnamePattern: "/demo/cart",
      query: {},
    }],
    parameters: [],
    verifier: {
      titleIncludes: ["购物车"],
      headingIncludes: ["购物车"],
      textIncludes: ["购物车商品"],
    },
    directEntry: "candidate",
    sourceObservationIds: [],
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function operation(status = "verified") {
  return {
    id: "operation_shared_nav_cart",
    name: "前往购物车",
    kind: "navigation",
    evidenceSource: "shared-navigation",
    applicability: { scope: "any-scene", evidenceSceneIds: ["scene-home"] },
    fromSceneId: "*",
    toSceneId: "scene-cart",
    inputs: { type: "object", properties: {} },
    outputs: {
      type: "object",
      properties: {
        pageUrl: { type: "string" },
        pageTitle: { type: "string" },
      },
      required: ["pageUrl", "pageTitle"],
    },
    preconditions: [],
    effects: ["scene:scene-cart"],
    implementations: [{
      id: "implementation_shared_nav_cart",
      program: {
        version: 2,
        steps: [
          { id: "navigate-cart", op: "navigate", sceneId: "scene-cart", bindings: {}, timeoutMs: 5_000 },
          { id: "wait-cart", op: "waitForScene", sceneId: "scene-cart", timeoutMs: 5_000 },
          { id: "assert-cart", op: "assertScene", sceneId: "scene-cart", timeoutMs: 5_000 },
          { id: "wait-cart-copy", op: "waitForCondition", text: "购物车商品", timeoutMs: 5_000 },
        ],
      },
      conditions: [],
      successes: 1,
      failures: 0,
      sourceEpisodeIds: [],
    }],
    verification: { sceneId: "scene-cart", textIncludes: ["购物车商品"] },
    status,
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function capability(operationIds = ["operation_shared_nav_cart"]) {
  return {
    id: "capability-open-cart",
    kind: "navigation",
    resultKind: "page",
    exposure: "public",
    name: "打开购物车",
    description: "打开购物车",
    normalizedGoal: "打开购物车",
    aliases: [],
    inputs: { type: "object", properties: {} },
    outputs: {
      type: "object",
      properties: {
        pageUrl: { type: "string" },
        pageTitle: { type: "string" },
      },
      required: ["pageUrl", "pageTitle"],
    },
    outcomes: [],
    plans: [{
      id: "plan-open-cart",
      entrySceneIds: ["*"],
      steps: operationIds.map((operationId) => ({ operationId, bindings: {} })),
      outputBindings: {
        pageUrl: { source: "state", path: "__pageUrl" },
        pageTitle: { source: "state", path: "__pageTitle" },
      },
    }],
    sourceEpisodeIds: [],
    confidence: 1,
    status: "available",
    updatedAt: "2026-07-30T00:00:00.000Z",
  };
}

function release(origin, operations = [operation()]) {
  return {
    profile: { entryUrl: `${origin}/demo`, allowedOrigins: [origin] },
    scenes: [scene()],
    operations,
  };
}

async function localDemoServer() {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (request.url === "/demo/cart") {
      response.end("<!doctype html><title>Atlas 购物车</title><h1>购物车</h1><main>购物车商品</main>");
      return;
    }
    response.end("<!doctype html><title>Atlas 首页</title><h1>首页</h1>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test("module-less Navigation capability executes verified and published Release Operations on the live origin", async () => {
  const [{ runVerifiedReleaseOperationCapability }, demo, browser] = await Promise.all([
    bundledSharedOperationRunner(),
    localDemoServer(),
    chromium.launch({ headless: true }),
  ]);
  const page = await browser.newPage();
  try {
    for (const status of ["verified", "published"]) {
      await page.goto(`${demo.origin}/demo`);
      const result = await runVerifiedReleaseOperationCapability({
        page,
        capability: capability(),
        release: release(demo.origin, [operation(status)]),
        input: {},
      });
      assert.equal(result.page.url(), `${demo.origin}/demo/cart`);
      assert.deepEqual(result.output, {
        pageUrl: `${demo.origin}/demo/cart`,
        pageTitle: "Atlas 购物车",
      });
      assert.deepEqual(
        result.receipts.map((receipt) => [receipt.op, receipt.status]),
        [
          ["navigate", "passed"],
          ["waitForScene", "passed"],
          ["assertScene", "passed"],
          ["waitForCondition", "passed"],
          ["assertScene", "passed"],
        ],
      );
      assert.equal(result.receipts[0].evidence.operationId, "operation_shared_nav_cart");
      assert.equal(result.receipts[0].evidence.implementationId, "implementation_shared_nav_cart");
    }
  } finally {
    await page.close();
    await browser.close();
    await demo.close();
  }
});

test("Release Operation plan preflight rejects an unavailable later step before any browser side effect", async () => {
  const [{ runVerifiedReleaseOperationCapability, ReleaseOperationRunError }, demo, browser] = await Promise.all([
    bundledSharedOperationRunner(),
    localDemoServer(),
    chromium.launch({ headless: true }),
  ]);
  const page = await browser.newPage();
  try {
    await page.goto(`${demo.origin}/demo`);
    const unavailable = {
      ...operation("candidate"),
      id: "operation-unavailable",
      implementations: [{
        ...operation("candidate").implementations[0],
        id: "implementation-unavailable",
      }],
    };
    await assert.rejects(
      runVerifiedReleaseOperationCapability({
        page,
        capability: capability(["operation_shared_nav_cart", "operation-unavailable"]),
        release: release(demo.origin, [operation(), unavailable]),
        input: {},
      }),
      (error) => {
        assert.equal(error instanceof ReleaseOperationRunError, false, "preflight failure occurs before a run receipt exists");
        assert.match(error.message, /^capability_release_operation_unavailable:operation-unavailable$/);
        return true;
      },
    );
    assert.equal(page.url(), `${demo.origin}/demo`);
  } finally {
    await page.close();
    await browser.close();
    await demo.close();
  }
});

test("a trusted-page redirect is blocked before the attacker origin receives a request", async () => {
  let attackerRequests = 0;
  const attacker = createServer((_request, response) => {
    attackerRequests += 1;
    response.end("<!doctype html><title>Attacker</title>");
  });
  await new Promise((resolve) => attacker.listen(0, "127.0.0.1", resolve));
  const attackerAddress = attacker.address();
  assert.ok(attackerAddress && typeof attackerAddress === "object");
  const attackerOrigin = `http://127.0.0.1:${attackerAddress.port}`;
  const trusted = createServer((request, response) => {
    if (request.url === "/demo/cart") {
      response.writeHead(302, { location: `${attackerOrigin}/stolen` });
      response.end();
      return;
    }
    response.end("<!doctype html><title>Atlas 首页</title><h1>首页</h1>");
  });
  await new Promise((resolve) => trusted.listen(0, "127.0.0.1", resolve));
  const trustedAddress = trusted.address();
  assert.ok(trustedAddress && typeof trustedAddress === "object");
  const trustedOrigin = `http://127.0.0.1:${trustedAddress.port}`;
  const [{ runVerifiedReleaseOperationCapability }, browser] = await Promise.all([
    bundledSharedOperationRunner(),
    chromium.launch({ headless: true }),
  ]);
  const page = await browser.newPage();
  try {
    await page.goto(`${trustedOrigin}/demo`);
    await assert.rejects(
      runVerifiedReleaseOperationCapability({
        page,
        capability: capability(),
        release: release(trustedOrigin),
        input: {},
      }),
      /capability_release_(?:origin_mismatch|navigation_origin_rejected|operation_cross_origin)/,
    );
    assert.equal(
      attackerRequests,
      0,
      "the navigation guard aborts the cross-origin main-frame request itself",
    );
  } finally {
    await page.close();
    await browser.close();
    await Promise.all([
      new Promise((resolve, reject) => trusted.close((error) => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => attacker.close((error) => error ? reject(error) : resolve())),
    ]);
  }
});

test("validation and execution keep the module path and share the Release Operation fallback", async () => {
  const source = await readFile(RUNNER_URL, "utf8");
  const validation = source.slice(
    source.indexOf("async function runValidation("),
    source.indexOf("\nasync function updateExecution("),
  );
  const execution = source.slice(
    source.indexOf("async function runCapabilityExecution("),
    source.indexOf("\nasync function main("),
  );
  for (const runtime of [validation, execution]) {
    assert.match(runtime, /if \(moduleRef\) \{[\s\S]*runPlaywrightCapabilityStages/);
    assert.match(runtime, /else \{[\s\S]*runVerifiedReleaseOperationCapability/);
  }
  assert.match(validation, /executionSource === "module"[\s\S]*navigationCompletionVerified/);
  assert.doesNotMatch(validation, /if \(!moduleRef\) throw new Error\("capability_module_required"\)/);
  assert.doesNotMatch(execution, /if \(!moduleRef\) throw new Error\("capability_module_required"\)/);
});
