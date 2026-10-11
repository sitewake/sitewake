import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const ROOT = new URL("../", import.meta.url);

async function bundledAnalyzer() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("lib/capability-center/proposal-analysis.ts", ROOT))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

async function bundledModelAnalyzer() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("lib/site-knowledge/model-analyzer.ts", ROOT))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#model-${Date.now()}`);
}

/** A site is born only in `createSiteAgent`; the memory store hangs on globalThis and is shared across bundles. */
let siteStorePromise;
async function ensureSites(...ids) {
  siteStorePromise ||= build({
    entryPoints: [fileURLToPath(new URL("db/site-agent-store.ts", ROOT))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  }).then((result) => import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`));
  const store = await siteStorePromise;
  for (const id of ids) await store.createSiteAgent({ id });
}

async function bundledProposalService() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("lib/capability-center/proposal-service.ts", ROOT))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#service-${Date.now()}`);
}

function capability(overrides = {}) {
  return {
    id: "capability-home",
    siteAgentId: "proposal-site",
    stableKey: "navigate-home",
    intentKey: "navigate_home",
    name: "返回首页",
    description: "返回网站首页",
    goalTemplate: "返回首页",
    kind: "navigation",
    structure: "atomic",
    operation: "read",
    exposure: "public",
    resultKind: "page",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { pageUrl: { type: "string" } } },
    executionRequirements: { authentication: "none", supportedEnvironments: { connectedBrowser: "supported", cloudBrowser: "supported", managedProfile: "blocked" }, checkpoints: [], evidenceRefs: [] },
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    id: "proposal-1",
    siteAgentId: "proposal-site",
    kind: "new",
    status: "analyzing",
    title: "返回首页",
    description: "返回网站首页",
    requestedGoal: "返回首页",
    input: {},
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function stableHashForTest(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

test("an exact repeated proposal is resolved server-side as duplicate without a Task", async () => {
  const analyzer = await bundledAnalyzer();
  const result = await analyzer.analyzeCapabilityProposal({ proposal: proposal(), capabilities: [capability()] });
  assert.equal(result.disposition, "duplicate");
  assert.equal(result.duplicateCapabilityId, "capability-home");
  assert.equal(result.modelUsed, false);
});

test("either localized display name participates in deterministic duplicate detection", async () => {
  const analyzer = await bundledAnalyzer();
  const result = await analyzer.analyzeCapabilityProposal({
    proposal: proposal({ requestedGoal: "返回首页" }),
    capabilities: [capability({
      name: "Navigate Home",
      localizedNames: { zhCN: "返回首页", en: "Navigate Home" },
      goalTemplate: "Navigate to the home page",
    })],
  });
  assert.equal(result.disposition, "duplicate");
  assert.equal(result.duplicateCapabilityId, "capability-home");
  assert.equal(result.modelUsed, false);
});

test("an explicit improvement of an existing capability is not collapsed into duplicate", async () => {
  const analyzer = await bundledAnalyzer();
  const result = await analyzer.analyzeCapabilityProposal({
    proposal: proposal({ kind: "improvement", capabilityId: "capability-home", requestedGoal: "优化返回首页能力，它现在不稳定" }),
    capabilities: [capability()],
  });
  assert.notEqual(result.disposition, "duplicate");
  assert.equal(result.targetCapabilityId, "capability-home");
});

test("a generated capability always carries Chinese and English display names", async () => {
  const analyzer = await bundledAnalyzer();
  const result = await analyzer.analyzeCapabilityProposal({
    proposal: proposal({
      id: "proposal-bilingual",
      title: "打开订单历史",
      description: "进入当前用户的订单历史页面",
      requestedGoal: "打开订单历史",
    }),
    capabilities: [],
  });

  assert.equal(result.disposition, "new");
  assert.ok(result.capability.localizedNames.zhCN.trim());
  assert.ok(result.capability.localizedNames.en.trim());
  assert.match(result.capability.localizedNames.zhCN, /\p{Script=Han}/u);
  assert.doesNotMatch(result.capability.localizedNames.en, /\p{Script=Han}/u);
  assert.equal(result.capability.name, result.capability.localizedNames.en);
});

test("runtime evidence informs analysis without leaking into the capability description", async () => {
  const analyzer = await bundledAnalyzer();
  const cleanDescription = "Export the current user's invoices.";
  const evidenceUrl = "https://private.example.test/invoices?account=secret";
  const result = await analyzer.analyzeCapabilityProposal({
    proposal: proposal({
      id: "proposal-runtime-evidence",
      title: "Export invoices",
      description: cleanDescription,
      requestedGoal: "Export invoices",
    }),
    capabilities: [],
    runtimeEvidence: {
      start: { url: "https://private.example.test/" },
      end: { url: evidenceUrl },
      outcome: { status: "success", summary: "Downloaded invoice archive." },
    },
  });

  assert.equal(result.capability.description, cleanDescription);
  assert.doesNotMatch(result.capability.description, /private\.example\.test|account=secret/);
});

test("an authentication-dependent proposal is blocked with a plan before Runner allocation", async () => {
  const analyzer = await bundledAnalyzer();
  const result = await analyzer.analyzeCapabilityProposal({
    proposal: proposal({
      id: "proposal-logout-without-session",
      title: "Log out",
      description: "Log out the current user.",
      requestedGoal: "Log out",
    }),
    capabilities: [],
    runtimeEvidence: {
      start: { url: "https://example.test/" },
      end: { url: "https://example.test/" },
      outcome: { status: "failed", summary: "No authenticated session is available." },
    },
  });

  assert.equal(result.disposition, "new");
  assert.equal(result.feasibility.status, "blocked");
  assert.ok(result.feasibility.requiredResources.includes("authenticated-browser-or-test-account"));
  assert.ok(result.feasibility.plan.length >= 1);
});

test("a blocked Proposal creates no Task until an administrator explicitly forces it", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
      disposition: "new",
      summary: "Logout requires an authenticated browser session.",
      confidence: 0.97,
      capability: {
        intentKey: "logout",
        name: "Log Out",
        localizedNames: { zhCN: "退出登录", en: "Log Out" },
        description: "Log out the current user.",
        goalTemplate: "Log out",
        kind: "task",
        operation: "write",
        resultKind: "data",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { loggedOut: { type: "boolean" } }, required: ["loggedOut"] },
        executionRequirements: {
          authentication: "required",
          supportedEnvironments: { connectedBrowser: "supported", cloudBrowser: "supported", managedProfile: "blocked" },
          checkpoints: [],
          evidenceRefs: [],
        },
      },
      evidence: ["authentication-required"],
      feasibility: {
        status: "blocked",
        summary: "No authenticated session is available.",
        blockers: ["No authenticated browser session."],
        requiredResources: ["authenticated-browser-or-test-account"],
        plan: [
          { step: "prepare", objective: "Provide an authenticated browser session.", resource: "authenticated-browser-or-test-account" },
          { step: "author", objective: "Implement logout and verify the session is cleared.", resource: "authoring-runner" },
        ],
      },
    }) } }],
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    globalThis.__SITEWAKE_SITE_AGENT_V2__ = new Map();
    globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__ = new Map();
    const service = await bundledProposalService();
    const siteAgentId = "blocked-before-allocation";
    await ensureSites(siteAgentId);
    const blocked = await service.submitCapabilityProposal(siteAgentId, {
      title: "退出登录",
      requestedGoal: "退出登录",
    });
    assert.equal(blocked.proposal.status, "blocked");
    assert.equal(blocked.queued, false);
    const beforeOverride = globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.get(siteAgentId);
    assert.equal(beforeOverride.tasks.length, 0);
    assert.equal(beforeOverride.capabilities.length, 0);

    const forced = await service.forceCapabilityProposalTask(siteAgentId, blocked.proposal.id, {
      reason: "Use the administrator-provided test account.",
    });
    assert.equal(forced.queued, true);
    assert.equal(forced.proposal.status, "accepted");
    assert.equal(forced.analysis.manualOverride.reason, "Use the administrator-provided test account.");
    const afterOverride = globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.get(siteAgentId);
    assert.equal(afterOverride.tasks.length, 1);
    assert.equal(afterOverride.capabilities.length, 1);
    assert.equal(afterOverride.tasks[0].status, "queued");
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  }
});

test("GLM JSON length truncation disables thinking and succeeds with a larger bounded fallback", async () => {
  const previous = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://model.test/v1", OPENAI_MODEL: "glm-test" });
  const originalFetch = globalThis.fetch;
  const requests = [];
  const responses = [
    { choices: [{ finish_reason: "length", message: { content: '{"disposition":"new","summary":"truncated' } }] },
    { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      disposition: "new", summary: "Recovered with a larger output budget.", confidence: 0.96,
      capability: { intentKey: "export_invoices", localizedNames: { zhCN: "导出发票", en: "Export Invoices" }, name: "Export Invoices", description: "Export invoices.", goalTemplate: "Export invoices", kind: "task", operation: "read", resultKind: "data", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: { url: { type: "string" } } } },
      evidence: ["bounded-retry"],
    }) } }] },
  ];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body || "{}")));
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const analyzer = await bundledAnalyzer();
    const telemetry = [];
    const result = await analyzer.analyzeCapabilityProposal({
      proposal: proposal({ id: "proposal-glm-length", requestedGoal: "Export invoices", title: "Export invoices" }),
      capabilities: [],
      telemetry: { record: (invocation) => telemetry.push(invocation) },
    });
    assert.equal(result.modelUsed, true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.thinking), [{ type: "disabled" }, { type: "disabled" }]);
    assert.ok(requests[0].response_format);
    assert.equal(requests[1].response_format, undefined, "fallback preserves JSON-mode compatibility");
    assert.ok(requests[1].max_tokens > requests[0].max_tokens, "the bounded retry receives a larger output budget");
    assert.equal(telemetry.at(-1).status, "succeeded");
    assert.equal(telemetry.at(-1).attempt, 2);
    assert.equal(telemetry.at(-1).finishReason, "stop");
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("finish_reason length retries even when the partial response is parseable JSON", async () => {
  const previous = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://model.test/v1", OPENAI_MODEL: "glm-test" });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ finish_reason: calls === 1 ? "length" : "stop", message: { content: calls === 1 ? "{}" : '{"ok":true}' } }] }), { status: 200 });
  };
  try {
    const analyzer = await bundledModelAnalyzer();
    const result = await analyzer.modelJson("Return JSON", {}, 5_000, undefined, "semantic", undefined, [], { failureMode: "throw" });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("two invalid model JSON responses succeed on the final bounded retry", async () => {
  const previous = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://model.test/v1", OPENAI_MODEL: "glm-test" });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body || "{}"));
    requests.push(request);
    const content = requests.length < 3 ? `{"invalid":"attempt-${requests.length}` : '{"ok":true}';
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }), { status: 200 });
  };
  try {
    const analyzer = await bundledModelAnalyzer();
    const result = await analyzer.modelJson("Return JSON", {}, 5_000, undefined, "semantic", undefined, [], { failureMode: "throw" });
    assert.deepEqual(result, { ok: true });
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((request) => request.thinking), [{ type: "disabled" }, { type: "disabled" }, { type: "disabled" }]);
    assert.deepEqual(requests.map((request) => Boolean(request.response_format)), [true, false, true]);
    assert.deepEqual(requests.map((request) => request.max_tokens), [2_400, 4_800, 4_800]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("an unconfigured model stays soft by default and throws a safe typed failure when required", async () => {
  const keys = ["OPENAI_API_KEY"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    const analyzer = await bundledModelAnalyzer();
    assert.equal(await analyzer.modelJson("Return JSON", {}), undefined);
    await assert.rejects(
      analyzer.modelJson("Return JSON", {}, 5_000, undefined, "semantic", undefined, [], { failureMode: "throw" }),
      (error) => error?.name === "ModelJsonError" && error.failure?.errorCode === "model_not_configured" && error.failure?.attempt === 0,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("three invalid model JSON attempts expose only safe structured diagnostics", async () => {
  const previous = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://model.test/v1", OPENAI_MODEL: "glm-test" });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ finish_reason: calls === 1 ? "length" : "stop", message: { content: `{"secret":"must-not-persist-${calls}` } }] }), { status: 200 });
  };
  try {
    const analyzer = await bundledAnalyzer();
    const telemetry = [];
    await assert.rejects(
      analyzer.analyzeCapabilityProposal({
        proposal: proposal({ id: "proposal-json-failure", requestedGoal: "Export invoices", title: "Export invoices" }),
        capabilities: [],
        telemetry: { record: (invocation) => telemetry.push(invocation) },
      }),
      (error) => error?.name === "ModelJsonError"
        && error.failure?.errorCode === "model_json_invalid"
        && error.failure?.attempt === 3
        && error.failure?.parseError === "unexpected_end_of_json",
    );
    assert.equal(calls, 3);
    const failed = telemetry.at(-1);
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempt, 3);
    assert.equal(failed.parseError, "unexpected_end_of_json");
    assert.doesNotMatch(JSON.stringify(failed), /must-not-persist|secret/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("an OpenAI-compatible provider that rejects thinking gets one bounded compatibility fallback", async () => {
  const previous = Object.fromEntries(["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://model.test/v1", OPENAI_MODEL: "compat-test" });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body || "{}"));
    requests.push(request);
    if (request.thinking) return new Response("unsupported field", { status: 400 });
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ disposition: "rejected", summary: "Not reusable.", confidence: 0.9, evidence: ["compat-fallback"] }) } }] }), { status: 200 });
  };
  try {
    const analyzer = await bundledAnalyzer();
    const result = await analyzer.analyzeCapabilityProposal({
      proposal: proposal({ id: "proposal-thinking-compat", requestedGoal: "Tell me a joke", title: "Tell me a joke" }),
      capabilities: [],
    });
    assert.equal(result.disposition, "rejected");
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((request) => request.thinking), [{ type: "disabled" }, { type: "disabled" }, undefined]);
    assert.ok(requests[0].response_format);
    assert.equal(requests[1].response_format, undefined);
    assert.equal(requests[2].response_format, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("model-backed runtime new creates one Proposal and Task while rejected creates neither", async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  const responses = [
    {
      disposition: "new",
      summary: "Reusable invoice export.",
      confidence: 0.95,
      capability: {
        intentKey: "export_invoices",
        name: "Export Invoices",
        localizedNames: { zhCN: "导出发票", en: "Export Invoices" },
        description: "Export invoices for the signed-in user.",
        goalTemplate: "Export invoices",
        kind: "task",
        operation: "read",
        resultKind: "data",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { archiveUrl: { type: "string" } }, required: ["archiveUrl"] },
      },
      evidence: ["runtime-episode-success"],
    },
    { disposition: "rejected", summary: "One-off conversational request.", confidence: 0.98, evidence: ["not-reusable"] },
    { disposition: "rejected", summary: "Retry determined this is not reusable.", confidence: 0.99, evidence: ["retry-rejected"] },
    { disposition: "rejected", summary: "Concurrent stale recovery has one owner.", confidence: 0.99, evidence: ["single-owner"] },
  ];
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    const response = responses.shift();
    if (response?.summary.includes("Concurrent")) await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(response) } }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    globalThis.__SITEWAKE_SITE_AGENT_V2__ = new Map();
    globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__ = new Map();
    const service = await bundledProposalService();
    const runtimeEpisode = (siteAgentId, id, goal) => ({
      schemaVersion: "site-agent.v2",
      id,
      siteAgentId,
      taskSessionId: `session-${id}`,
      browserSessionId: `browser-${id}`,
      documentId: `document-${id}`,
      mode: "adaptive",
      goal,
      normalizedGoal: goal.toLowerCase(),
      input: {},
      startedAt: "2026-08-01T00:00:00.000Z",
      endedAt: "2026-08-01T00:00:01.000Z",
      startSnapshot: { id: "start", sessionId: `session-${id}`, documentId: `document-${id}`, sequence: 1, url: "https://example.test/", title: "Home", heading: "Home", visibleText: "", links: [], capturedAt: "2026-08-01T00:00:00.000Z" },
      endSnapshot: { id: "end", sessionId: `session-${id}`, documentId: `document-${id}`, sequence: 2, url: "https://example.test/done", title: "Done", heading: "Done", visibleText: "", links: [], capturedAt: "2026-08-01T00:00:01.000Z" },
      transitions: [],
      outcome: { status: "success", code: "completed", summary: "Completed.", evaluatedAt: "2026-08-01T00:00:01.000Z", evidence: {} },
      experience: { version: 1, actions: [], actorSummary: "Completed.", judgeEvidence: ["Done"] },
    });

    await ensureSites("runtime-new", "runtime-duplicate", "runtime-rejected", "runtime-rejected-recovery", "runtime-stale-concurrent-recovery");
    const created = await service.submitEpisodeCapabilitySignal("runtime-new", runtimeEpisode("runtime-new", "episode-new", "Export invoices"));
    assert.equal(created.analysis.disposition, "new");
    const newMemory = globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.get("runtime-new");
    assert.equal(newMemory.proposals.length, 1);
    assert.equal(newMemory.tasks.length, 1);
    assert.match(newMemory.tasks[0].id, /^capability-task:/);

    const duplicateSite = "runtime-duplicate";
    globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.set(duplicateSite, {
      capabilities: [capability({ siteAgentId: duplicateSite })],
      versions: [],
      proposals: [],
      tasks: [],
      settings: { autoApproval: { enabled: false, prompt: "" } },
    });
    const duplicate = await service.submitEpisodeCapabilitySignal(
      duplicateSite,
      runtimeEpisode(duplicateSite, "episode-duplicate", "返回首页"),
    );
    assert.equal(duplicate.disposition, "duplicate");
    assert.equal(duplicate.duplicateCapabilityId, "capability-home");
    const duplicateMemory = globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.get(duplicateSite);
    assert.equal(duplicateMemory.proposals.length, 0);
    assert.equal(duplicateMemory.tasks.length, 0);

    const rejected = await service.submitEpisodeCapabilitySignal("runtime-rejected", runtimeEpisode("runtime-rejected", "episode-rejected", "Tell me a joke"));
    assert.equal(rejected.disposition, "rejected");
    const rejectedMemory = globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.get("runtime-rejected");
    assert.equal(rejectedMemory.proposals.length, 0);
    assert.equal(rejectedMemory.tasks.length, 0);

    const recoverySite = "runtime-rejected-recovery";
    const recoveryEpisode = runtimeEpisode(recoverySite, "episode-rejected-recovery", "Summarize this one-off page");
    const recoveryProposalId = `capability-proposal:${stableHashForTest(`${recoverySite}:${recoveryEpisode.id}:terminal-user-gap`)}`;
    globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.set(recoverySite, {
      capabilities: [],
      versions: [],
      tasks: [],
      settings: { autoApproval: { enabled: false, prompt: "" } },
      proposals: [{
        id: recoveryProposalId,
        siteAgentId: recoverySite,
        kind: "new",
        status: "analyzing",
        title: recoveryEpisode.goal,
        description: recoveryEpisode.outcome.summary,
        requestedGoal: recoveryEpisode.goal,
        input: {},
        sourceEpisodeId: recoveryEpisode.id,
        createdAt: "2026-08-01T00:00:01.000Z",
        updatedAt: "2026-08-01T00:00:02.000Z",
      }],
    });
    const recovered = await service.submitEpisodeCapabilitySignal(recoverySite, recoveryEpisode);
    assert.equal(recovered.proposal.status, "rejected");
    const recoveredMemory = globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.get(recoverySite);
    assert.equal(recoveredMemory.proposals[0].status, "rejected");
    assert.equal(recoveredMemory.tasks.length, 0);
    const concurrentSite = "runtime-stale-concurrent-recovery";
    const concurrentEpisode = runtimeEpisode(concurrentSite, "episode-stale-concurrent", "Summarize another one-off page");
    const concurrentProposalId = `capability-proposal:${stableHashForTest(`${concurrentSite}:${concurrentEpisode.id}:terminal-user-gap`)}`;
    globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.set(concurrentSite, {
      capabilities: [], versions: [], tasks: [], settings: { autoApproval: { enabled: false, prompt: "" } },
      proposals: [{
        id: concurrentProposalId, siteAgentId: concurrentSite, kind: "new", status: "analyzing",
        title: concurrentEpisode.goal, description: concurrentEpisode.outcome.summary, requestedGoal: concurrentEpisode.goal,
        input: {}, sourceEpisodeId: concurrentEpisode.id,
        createdAt: "2026-08-01T00:00:01.000Z", updatedAt: "2026-08-01T00:00:02.000Z",
      }],
    });
    const callsBeforeConcurrentRecovery = fetchCalls;
    const concurrentRecovery = await Promise.allSettled([
      service.submitEpisodeCapabilitySignal(concurrentSite, concurrentEpisode),
      service.submitEpisodeCapabilitySignal(concurrentSite, concurrentEpisode),
    ]);
    assert.equal(fetchCalls - callsBeforeConcurrentRecovery, 1, "only the CAS lease owner calls the model");
    assert.equal(concurrentRecovery.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(globalThis.__SITEWAKE_CAPABILITY_CENTER_V2__.get(concurrentSite).proposals[0].status, "rejected");
    assert.equal(responses.length, 0, "stale persisted analyzing Proposals are actually analyzed again");
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  }
});

test("the management route cannot submit a forged analysis outcome", async () => {
  const route = await readFile(new URL("app/api/site-agents/[siteAgentId]/capability-center/proposals/route.ts", ROOT), "utf8");
  assert.match(route, /submitCapabilityProposal/);
  assert.doesNotMatch(route, /duplicateCapabilityId\?:|analysis\?:|status\?:\s*CapabilityProposalStatus/);
});
