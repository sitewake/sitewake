import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

async function bundledOutputGate() {
  const result = await build({
    entryPoints: [
      fileURLToPath(new URL("../lib/site-knowledge/capability-output.ts", import.meta.url)),
    ],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
}

test("connected and cloud execution share a strict required/type output gate", async () => {
  const { assertCapabilityInput, assertCapabilityOutput } = await bundledOutputGate();
  const schema = {
    type: "object",
    properties: {
      itemCount: { type: "number", minimum: 0 },
      pageUrl: { type: "string" },
      optionalNote: { type: "string" },
    },
    required: ["itemCount", "pageUrl"],
  };
  assert.doesNotThrow(() => assertCapabilityOutput(schema, {
    itemCount: 2,
    pageUrl: "https://atlas.test/cart",
  }));
  assert.throws(
    () => assertCapabilityOutput(schema, { pageUrl: "https://atlas.test/cart" }),
    /capability_output_required:output\.itemCount/,
  );
  assert.throws(
    () => assertCapabilityOutput(schema, {
      itemCount: "2",
      pageUrl: "https://atlas.test/cart",
    }),
    /capability_output_type:output\.itemCount:number/,
  );
  const formatted = {
    type: "object",
    properties: {
      date: { type: "string", format: "date" },
      createdAt: { type: "string", format: "date-time" },
      website: { type: "string", format: "uri" },
      email: { type: "string", format: "email" },
    },
    required: ["date", "createdAt", "website", "email"],
  };
  assert.doesNotThrow(() => assertCapabilityOutput(formatted, {
    date: "2026-07-30",
    createdAt: "2026-07-30T12:30:15+08:00",
    website: "https://atlas.test/cart",
    email: "owner@atlas.test",
  }));
  for (const [field, value, format] of [
    ["date", "2026-02-30", "date"],
    ["createdAt", "2026-07-30 12:30:15", "date-time"],
    ["website", "/relative-only", "uri"],
    ["email", "not-an-email", "email"],
  ]) {
    assert.throws(
      () => assertCapabilityOutput(formatted, {
        date: "2026-07-30",
        createdAt: "2026-07-30T12:30:15Z",
        website: "https://atlas.test/cart",
        email: "owner@atlas.test",
        [field]: value,
      }),
      new RegExp(`capability_output_format:output\\.${field}:${format}`),
    );
  }
  const nestedInput = {
    type: "object",
    properties: {
      customer: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
      tags: {
        type: "array",
        items: { type: "string", minLength: 2 },
        minItems: 1,
      },
    },
    required: ["customer", "tags"],
  };
  assert.doesNotThrow(() => assertCapabilityInput(nestedInput, {
    customer: { email: "buyer@atlas.test" },
    tags: ["new"],
  }));
  assert.throws(
    () => assertCapabilityInput(nestedInput, {
      customer: {},
      tags: [],
    }),
    /capability_run_input_required:customer\.email/,
  );
  assert.throws(
    () => assertCapabilityInput(nestedInput, {
      customer: { email: "invalid" },
      tags: ["x"],
    }),
    /capability_run_input_format:customer\.email:email/,
  );
  assert.throws(
    () => assertCapabilityInput(nestedInput, {
      customer: { email: "buyer@atlas.test" },
      tags: [],
    }),
    /capability_run_input_min_items:tags/,
  );
});

test("unsafe capability patterns are rejected before matching attacker-controlled input", async () => {
  const {
    assertCapabilityInput,
    assertSafeCapabilitySchema,
  } = await bundledOutputGate();
  const schema = {
    type: "object",
    properties: {
      value: {
        type: "string",
        pattern: "(a+)+$",
      },
    },
    required: ["value"],
  };
  assert.throws(
    () => assertSafeCapabilitySchema(schema),
    /capability_contract_pattern_unsafe:schema\.value/,
  );
  const startedAt = performance.now();
  assert.throws(
    () => assertCapabilityInput(schema, {
      value: `${"a".repeat(16_000)}!`,
    }),
    /capability_run_input_pattern_unsafe:value/,
  );
  assert.ok(
    performance.now() - startedAt < 1_000,
    "unsafe patterns must fail without evaluating a catastrophic match",
  );
});

test("required string inputs accept an empty string unless minLength forbids it", async () => {
  const { assertCapabilityInput } = await bundledOutputGate();
  const requiredOnly = {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  };
  assert.doesNotThrow(() => assertCapabilityInput(requiredOnly, {
    query: "",
  }));
  assert.throws(
    () => assertCapabilityInput({
      ...requiredOnly,
      properties: {
        query: { type: "string", minLength: 1 },
      },
    }, {
      query: "",
    }),
    /capability_run_input_min_length:query/,
  );
});

test("connected-browser execution validates output before constructing success", async () => {
  const source = await readFile(
    new URL("../client/user-agent-port.ts", import.meta.url),
    "utf8",
  );
  const outputGate = source.indexOf(
    "assertCapabilityOutput(capability.outputs, output)",
  );
  const successOutcome = source.indexOf(
    'status: "success", code: "verified_program"',
    outputGate,
  );
  assert.ok(outputGate >= 0);
  assert.ok(
    successOutcome > outputGate,
    "missing or mistyped required output must enter the execution-fault catch path",
  );
});

test("the real connected executeCapability path converts an invalid output into an execution fault", async (t) => {
  const built = await build({
    entryPoints: [
      fileURLToPath(new URL("../client/user-agent-port.ts", import.meta.url)),
    ],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
  });
  const now = "2026-07-30T12:00:00.000Z";
  const operation = {
    id: "operation-output-gate",
    name: "Return profile",
    kind: "task",
    evidenceSource: "ai-authored",
    applicability: { scope: "any-scene", evidenceSceneIds: [] },
    fromSceneId: "*",
    toSceneId: "*",
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: {} },
    preconditions: [],
    effects: [],
    implementations: [{
      id: "implementation-output-gate",
      program: { version: 2, steps: [] },
      conditions: [],
      successes: 1,
      failures: 0,
      sourceEpisodeIds: [],
    }],
    verification: {},
    status: "verified",
    updatedAt: now,
  };
  const capability = {
    id: "capability-output-gate",
    kind: "task",
    resultKind: "data",
    exposure: "internal",
    name: "Return profile",
    description: "Return a typed profile",
    normalizedGoal: "return profile",
    goalTemplate: "Return profile",
    aliases: [],
    inputs: { type: "object", properties: {} },
    outputs: {
      type: "object",
      properties: { email: { type: "string", format: "email" } },
      required: ["email"],
    },
    outcomes: [],
    plans: [{
      id: "plan-output-gate",
      entrySceneIds: ["*"],
      steps: [{ operationId: operation.id, bindings: {} }],
      outputBindings: {},
    }],
    sourceEpisodeIds: [],
    confidence: 1,
    status: "available",
    updatedAt: now,
  };
  const release = {
    schemaVersion: "site-agent.v2",
    id: "release-output-gate",
    siteAgentId: "connected-output-gate",
    version: 1,
    contentHash: "output-gate",
    profile: {
      name: "Output gate",
      description: "Output gate",
      vocabulary: {},
      suggestedGoals: [],
      entryUrl: "https://connected-output.test/",
      allowedOrigins: ["https://connected-output.test"],
    },
    scenes: [],
    linkReferences: [],
    targets: [],
    operations: [operation],
    navigationTools: [],
    capabilities: [capability],
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

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://connected-output.test/**", async (route) => {
    if (route.request().resourceType() === "document") {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Output gate</title><main>Profile</main>",
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ release }),
    });
  });
  await page.goto("https://connected-output.test/");
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const result = await page.evaluate(async ({ capability, release, now }) => {
    const port = window.SiteWakePort.create({
      siteAgentId: "connected-output-gate",
    });
    port.release = release;
    port.executeProgram = async () => ({});
    port.verifyAuthoredImplementation = async () => undefined;
    port.verifyOperation = async () => undefined;
    port.saveCheckpoint = () => undefined;
    port.ingestEpisode = async (episode, output, mode) => ({
      success: ["success", "no-result", "business-rejection"].includes(
        episode.outcome.status,
      ),
      mode,
      text: episode.outcome.summary,
      output,
      outcome: episode.outcome,
      session: {
        id: episode.taskSessionId,
        siteAgentId: episode.siteAgentId,
        mode: "run",
        goal: episode.goal,
        input: episode.input,
        status: "running",
        startedAt: now,
        updatedAt: now,
        expiresAt: now,
      },
      release,
    });
    return port.executeCapability(capability, {
      id: "session-output-gate",
      siteAgentId: "connected-output-gate",
      mode: "run",
      goal: "Return profile",
      input: {},
      status: "running",
      startedAt: now,
      updatedAt: now,
      expiresAt: now,
    }, {}, "compiled", undefined, 0, undefined, {}, undefined, true);
  }, { capability, release, now });
  assert.equal(result.success, false);
  assert.equal(result.outcome.status, "execution-fault");
  assert.equal(result.outcome.code, "capability_output_required");
  assert.match(result.text, /capability_output_required:output\.email/);
});
