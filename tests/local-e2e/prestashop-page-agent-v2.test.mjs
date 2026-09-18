import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const SHOP_ORIGIN = "http://localhost:18081";
const CONTROL_ORIGIN = "http://localhost:3310";
const SITE_AGENT_ID = "prestashop";
const GOAL = "给我找一个棕熊图案的垫子放购物车里";
const NOW = "2026-08-13T00:00:00.000Z";
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const sdk = await readFile("public/sitewake.js", "utf8");
const adaptiveSdk = await readFile("public/sitewake-adaptive.js", "utf8");

function json(body, status = 200) {
  return {
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization,content-type,idempotency-key,x-sitewake-ai-stage,x-sitewake-site-id,x-sitewake-site-agent-id",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

function releaseFixture() {
  return {
    schemaVersion: "site-agent.v2",
    id: "prestashop:runtime-v2-local-e2e",
    siteAgentId: SITE_AGENT_ID,
    version: 1,
    createdAt: NOW,
    contentHash: "prestashop-runtime-v2-local-e2e",
    profile: {
      name: "PrestaShop Runtime V2 E2E",
      description: "Local deterministic PageAgent Runtime V2 validation",
      semanticSource: "ai",
      visibility: "sandbox",
      vocabulary: {},
      suggestedGoals: [GOAL],
    },
    agentConfig: {
      appearance: { preset: "orb", palette: "mint", launcherPosition: "bottom-right" },
      overrides: {},
      features: {
        showSuggestions: true,
        showTeachAfterFailure: true,
        showNewChat: true,
        showKnowledgeVersion: true,
      },
      suggestions: [],
    },
    scenes: [],
    linkReferences: [],
    targets: [],
    operations: [],
    navigationTools: [],
    capabilities: [],
    outcomes: [],
    evalSummary: {
      passed: true,
      evaluatedEpisodes: 0,
      successfulEpisodes: 0,
      failedEpisodes: 0,
      generatedAt: NOW,
    },
    sourceEpisodeIds: [],
    runtimeFeatures: {
      pageAgentRuntimeV2: true,
      pageAgentEvidenceV2: true,
      capabilityExperienceOutbox: true,
    },
  };
}

function promptText(payload) {
  return (payload.messages || [])
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content || ""))
    .join("\n");
}

function indexedElement(prompt, ...needles) {
  const normalizedNeedles = needles.map((needle) => needle.toLowerCase());
  for (const line of prompt.split("\n")) {
    const lower = line.toLowerCase();
    if (!normalizedNeedles.every((needle) => lower.includes(needle))) continue;
    const match = line.match(/(?:\*\s*)?\[(\d+)]/);
    if (match) return Number(match[1]);
  }
  throw new Error(`page_agent_target_not_found:${needles.join("+")}\n${prompt.slice(-12_000)}`);
}

function agentOutput(action, evaluation = "The previous step is grounded by the current page state.") {
  return {
    choices: [{
      finish_reason: "tool_calls",
      message: {
        tool_calls: [{
          id: `page_${Date.now()}`,
          type: "function",
          function: {
            name: "AgentOutput",
            arguments: JSON.stringify({
              evaluation_previous_goal: evaluation,
              memory: "用户要找带棕熊图案的垫子并放进购物车，只能在页面证据确认后执行一次加购。",
              next_goal: "Perform the next explicit semantic action.",
              action,
            }),
          },
        }],
      },
    }],
  };
}

class LocalControlPlane {
  constructor() {
    this.release = releaseFixture();
    this.runs = new Map();
    this.sequence = 0;
    this.pageAgentStep = 0;
    this.modelCalls = [];
    this.observations = new Map();
    this.observationBatches = [];
    this.episodes = [];
    this.events = [];
    this.legacyExperiencePosts = 0;
  }

  event(name, detail = {}) {
    this.events.push({ name, detail, at: Date.now() });
  }

  runView(run) {
    return JSON.parse(JSON.stringify(run));
  }

  create(body) {
    const id = `run_prestashop_${++this.sequence}`;
    const token = `${id}.resume`;
    const run = {
      id,
      revision: 1,
      scope: {
        kind: "site",
        siteAgentId: SITE_AGENT_ID,
        allowedOrigins: [SHOP_ORIGIN],
        knowledgeNamespaceIds: [SITE_AGENT_ID],
      },
      status: "running",
      goal: body.goal,
      input: body.input || {},
      conversation: [...(body.conversation || []), { role: "user", content: body.goal, at: new Date().toISOString() }],
      agentState: {},
      activityTimeline: [],
      bindings: {},
      pageEpoch: 1,
      eventSequence: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: "2030-01-01T00:00:00.000Z",
      activePort: {
        id: `${id}.port.1`,
        documentId: body.documentId,
        browserSessionId: body.browserSessionId,
        origin: body.origin,
        url: body.url,
        pageEpoch: 1,
        state: "active",
        claimedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        leaseExpiresAt: "2030-01-01T00:00:00.000Z",
      },
    };
    this.runs.set(id, { run, token, handoffToken: undefined });
    this.event("run-created", { runId: id });
    return { run: this.runView(run), resumeToken: token, persistence: "memory" };
  }

  authorize(id, token, allowHandoff = false) {
    const entry = this.runs.get(id);
    if (!entry || (entry.token !== token && (!allowHandoff || entry.handoffToken !== token))) {
      throw new Error("agent_run_token_rejected");
    }
    return entry;
  }

  mutate(id, token, body, eventName) {
    const entry = this.authorize(id, token);
    const { run } = entry;
    if (body.expectedRevision !== undefined && Number(body.expectedRevision) !== run.revision) {
      throw new Error("agent_run_revision_conflict");
    }
    if (body.pageEpoch !== undefined && Number(body.pageEpoch) !== run.pageEpoch) {
      throw new Error("agent_run_page_superseded");
    }
    Object.assign(run, body.patch || {});
    run.revision += 1;
    run.eventSequence += 1;
    run.updatedAt = new Date().toISOString();
    this.event(eventName, { runId: id, revision: run.revision });
    return entry;
  }

  checkpoint(id, token, body) {
    const current = this.runs.get(id)?.run;
    const entry = this.mutate(id, token, {
      expectedRevision: body.expectedRevision,
      pageEpoch: body.pageEpoch,
      patch: {
        checkpoint: body.checkpoint,
        bindings: { ...(current?.bindings || {}), ...(body.bindings || {}) },
        activityTimeline: body.checkpoint?.activityTimeline || current?.activityTimeline || [],
      },
    }, "checkpoint");
    return { run: this.runView(entry.run), persistence: "memory" };
  }

  handoff(id, token, body) {
    const entry = this.mutate(id, token, {
      expectedRevision: body.expectedRevision,
      pageEpoch: body.pageEpoch,
      patch: { status: "awaiting-page", checkpoint: body.checkpoint, programCursor: body.checkpoint?.cursor },
    }, "handoff");
    entry.handoffToken = `${id}.handoff.${entry.run.pageEpoch}`;
    this.event("handoff-issued", { runId: id, pageEpoch: entry.run.pageEpoch });
    return {
      run: this.runView(entry.run),
      handoffToken: entry.handoffToken,
      expiresAt: "2030-01-01T00:00:00.000Z",
    };
  }

  claim(id, body) {
    const entry = this.authorize(id, body.token, true);
    const { run } = entry;
    if (!["awaiting-page", "running"].includes(run.status)) throw new Error("agent_run_not_claimable");
    run.pageEpoch += 1;
    run.revision += 1;
    run.eventSequence += 1;
    run.status = "running";
    run.checkpoint = body.checkpoint || run.checkpoint;
    run.activePort = {
      id: `${id}.port.${run.pageEpoch}`,
      documentId: body.documentId,
      browserSessionId: body.browserSessionId,
      origin: body.origin,
      url: body.url,
      pageEpoch: run.pageEpoch,
      state: "active",
      claimedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      leaseExpiresAt: "2030-01-01T00:00:00.000Z",
    };
    entry.token = body.token;
    entry.handoffToken = undefined;
    this.event("port-claimed", { runId: id, pageEpoch: run.pageEpoch });
    return { run: this.runView(run), resumeToken: entry.token, persistence: "memory" };
  }

  finish(id, token, body) {
    const current = this.runs.get(id)?.run;
    const entry = this.mutate(id, token, {
      expectedRevision: body.expectedRevision,
      pageEpoch: body.pageEpoch,
      patch: {
        status: body.status,
        output: body.output,
        outcome: body.outcome,
        activityTimeline: body.activityTimeline || current?.activityTimeline || [],
        conversation: [
          ...(current?.conversation || []),
          ...(body.assistantText ? [{ role: "assistant", content: body.assistantText, at: new Date().toISOString() }] : []),
        ],
      },
    }, "run-finished");
    return { run: this.runView(entry.run), persistence: "memory" };
  }

  appendObservations(runId, body) {
    const batch = body.observations || [];
    for (const observation of batch) {
      const existing = this.observations.get(observation.id);
      if (existing && existing.sha256 !== observation.sha256) throw new Error("page_observation_hash_conflict");
      this.observations.set(observation.id, observation);
    }
    this.observationBatches.push(batch.map((observation) => observation.id));
    this.event("observations-acked", { runId, ids: batch.map((observation) => observation.id) });
    return { accepted: batch.length, replayed: 0 };
  }

  async model(payload, headers) {
    const stage = headers["x-sitewake-ai-stage"] || "runtime-router";
    this.modelCalls.push({ stage, payload });
    this.event("model-request", { stage });

    if (stage === "runtime-boundary") {
      throw new Error("newsletter_email_must_not_trigger_boundary_model");
    }

    const isPageAgent = payload.tools?.some?.((entry) => entry.function?.name === "AgentOutput");
    if (!isPageAgent) {
      const criteria = [
        `Complete the user's original objective: ${GOAL}`,
        "Observe a page or business receipt that proves the requested change took effect.",
      ];
      return {
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: "",
            tool_calls: [{
              id: "operate_prestashop",
              type: "function",
              function: {
                name: "operate_page",
                arguments: JSON.stringify({
                  objective: GOAL,
                  effect: "reversible-write",
                  // The model receives only the natural-language customer
                  // brief. The exact product remains hidden in assertions.
                  // The customer phrase remains natural Chinese; the agent is
                  // allowed to normalize the object into the site's searchable
                  // vocabulary without hard-coding a product name.
                  entities: { query: "cushion" },
                  completionCriteria: criteria,
                }),
              },
            }],
          },
        }],
      };
    }

    const tools = payload.tools?.flatMap?.((entry) => entry.function?.name ? [entry.function.name] : []) || [];
    assert.ok(tools.includes("AgentOutput"), "PageAgent must use its structured macro tool");
    assert.deepEqual(tools, ["AgentOutput"], "the PageAgent wire contract exposes one macro tool; Runtime V2 actions are validated inside its structured action payload");
    const serializedTools = JSON.stringify(payload.tools);
    assert.doesNotMatch(serializedTools, /input_text/, "Runtime V2 must not expose legacy input_text");

    const prompt = promptText(payload);
    assert.match(prompt, /set_text_by_index/, "Runtime V2 must instruct the macro model to emit literal set-text");
    assert.match(prompt, /submit_form_by_index/, "Runtime V2 must instruct the macro model to emit semantic submit");
    const step = this.pageAgentStep++;
    if (step === 0) {
      const index = indexedElement(prompt, "input", "aria-label=search");
      return agentOutput({ set_text_by_index: { index, text: "cushion" } }, "The PrestaShop search box is visible.");
    }
    if (step === 1) {
      const index = indexedElement(prompt, "input", "aria-label=search");
      return agentOutput({ submit_form_by_index: { index } }, "The exact literal search value is present; submit explicitly.");
    }
    if (step === 2) {
      // PageController intentionally truncates long attributes in the model
      // projection; the stable target/receipt still carries the full label.
      const index = indexedElement(prompt, "button", "title=add to cart brown");
      return agentOutput({ click_element_by_index: { index } }, "The search results contain the requested Brown bear cushion.");
    }
    if (step === 3) {
      // PrestaShop confirms add-to-cart asynchronously after the button
      // dispatch. A single bounded wait is evidence-driven, not a blind retry.
      return agentOutput({ wait: { seconds: 4 } }, "The add request was dispatched; wait once for its business confirmation.");
    }
    if (step === 4) {
      this.terminalPrompt = prompt;
      this.event("terminal-model-evidence", {
        lines: prompt.split("\n").filter((line) => /brown bear|added to|item in your cart/i.test(line)).slice(-20),
      });
      return agentOutput({
        done: {
          text: "Brown bear cushion was found and added to the cart exactly once.",
          success: true,
          outcome: "success",
          output: { query: "垫子", cartItem: "Brown bear cushion", quantity: 1 },
          completionEvidence: [
            { criterion: `Complete the user's original objective: ${GOAL}`, evidence: "Brown bear cushion" },
            { criterion: "Observe a page or business receipt that proves the requested change took effect.", evidence: "Added to your cart" },
          ],
        },
      }, "The exact product and cart quantity are visible in the terminal state.");
    }
    throw new Error(`unexpected_page_agent_model_request:${step + 1}`);
  }
}

async function installControlPlane(context, plane) {
  await context.route(`${CONTROL_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() === "OPTIONS") return route.fulfill(json({}, 204));
    const raw = request.postData();
    const body = raw ? JSON.parse(raw) : {};
    try {
      if (path === "/sitewake.js") {
        return route.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: sdk });
      }
      if (path === "/sitewake-adaptive.js") {
        return route.fulfill({ status: 200, contentType: "application/javascript", headers: { "access-control-allow-origin": "*" }, body: adaptiveSdk });
      }
      if (path === `/api/site-agents/${SITE_AGENT_ID}/release`) return route.fulfill(json({ release: plane.release }));
      if (path === `/api/site-agents/${SITE_AGENT_ID}/connection`) return route.fulfill(json({ connection: {}, release: plane.release }));
      if (path === "/api/capability-v2/capabilities/search") return route.fulfill(json({ items: [] }));
      if (path === "/api/capability-v2/experiences") {
        plane.legacyExperiencePosts += 1;
        return route.fulfill(json({ error: "legacy_experience_forbidden" }, 409));
      }
      if (path === "/api/agent-runs" && request.method() === "POST") return route.fulfill(json(plane.create(body), 201));

      const runMatch = path.match(/^\/api\/agent-runs\/([^/]+)(?:\/(.+))?$/);
      if (runMatch) {
        const [, runId, action] = runMatch;
        const token = request.headers().authorization?.replace(/^Bearer\s+/i, "") || body.token;
        if (!action && request.method() === "GET") {
          return route.fulfill(json({ run: plane.runView(plane.authorize(runId, token).run), persistence: "memory" }));
        }
        if (!action && request.method() === "PATCH") return route.fulfill(json(plane.finish(runId, token, body)));
        if (action === "observations") return route.fulfill(json(plane.checkpoint(runId, token, body)));
        if (action === "page-observations") {
          plane.authorize(runId, token);
          return route.fulfill(json(plane.appendObservations(runId, body), 202));
        }
        if (action === "handoff") return route.fulfill(json(plane.handoff(runId, token, body)));
        if (action === "ports/claim") return route.fulfill(json(plane.claim(runId, body)));
        if (action === "cancel") {
          const entry = plane.authorize(runId, token);
          entry.run.status = "cancelled";
          return route.fulfill(json({ run: plane.runView(entry.run), persistence: "memory" }));
        }
        if (action === "events") return route.fulfill(json({ events: plane.events, persistence: "memory" }));
      }

      if (path === `/api/site-agents/${SITE_AGENT_ID}/model/v2/chat/completions`) {
        return route.fulfill(json(await plane.model(body, request.headers())));
      }
      if (path === `/api/site-agents/${SITE_AGENT_ID}/episodes` && request.method() === "POST") {
        const token = request.headers().authorization?.replace(/^Bearer\s+/i, "");
        const entry = plane.authorize(body.taskSessionId, token);
        plane.episodes.push(body);
        plane.event("episode-acked", { episodeId: body.id });
        return route.fulfill(json({ release: plane.release, directive: { type: "none" }, agentRun: plane.runView(entry.run) }, 202));
      }
      if (path.includes(`/api/site-agents/${SITE_AGENT_ID}/sessions/`)) {
        return route.fulfill(json({
          session: {
            id: path.split("/").at(-1),
            siteAgentId: SITE_AGENT_ID,
            status: body.status || "running",
            conversation: body.conversation || [],
            checkpoint: body.checkpoint,
          },
        }));
      }
      return route.fulfill(json({ error: `unhandled:${request.method()}:${path}` }, 404));
    } catch (error) {
      const detailError = error instanceof Error ? error.message : String(error);
      plane.event("route-error", {
        path,
        error: detailError,
        tools: Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name).filter(Boolean) : undefined,
      });
      return route.fulfill(json({ error: detailError }, 409));
    }
  });
}

async function waitForTerminal(plane, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = [...plane.runs.values()].at(-1)?.run;
    if (run && TERMINAL_STATUSES.has(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("prestashop_page_agent_terminal_timeout");
}

function assertObservationChain(observations) {
  assert.ok(observations.length >= 4, "initial, post-input, destination and terminal observations must be durable");
  const byDocument = new Map();
  for (const observation of observations) {
    assert.equal(observation.schemaVersion, "page-agent-observation.v1");
    assert.match(observation.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Buffer.byteLength(JSON.stringify(observation), "utf8") <= 96 * 1024, "observation must stay within 96 KiB");
    const previous = byDocument.get(observation.documentId);
    if (!previous) {
      assert.equal(observation.kind, "full", "the first observation for every document must be full");
      assert.equal(observation.baseObservationId, undefined);
    } else {
      assert.equal(observation.kind, "delta", "same-document observations must be chained deltas");
      assert.equal(observation.baseObservationId, previous.id);
    }
    byDocument.set(observation.documentId, observation);
  }
  assert.ok(byDocument.size >= 2, "search submission must cross to a new PrestaShop document");
}

test("local PrestaShop Runtime V2: searches cushion, adds only Brown bear cushion, and seals evidence", { timeout: 120_000 }, async () => {
  const shopHealth = await fetch(`${SHOP_ORIGIN}/`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(shopHealth.ok, true, `PrestaShop must be running at ${SHOP_ORIGIN}`);

  const plane = new LocalControlPlane();
  const browser = await chromium.launch({ headless: process.env.SITEWAKE_E2E_HEADED !== "1" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: {} });
    if (!globalThis.crypto.randomUUID) {
      globalThis.crypto.randomUUID = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
  });
  await installControlPlane(context, plane);
  const page = await context.newPage();
  const startedAt = Date.now();
  let assertionsPassed = false;
  try {
    await page.goto(`${SHOP_ORIGIN}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.SiteWake), undefined, { timeout: 15_000 });
    // A full-document search submission intentionally destroys the originating
    // JS execution context. The durable AgentRun, not the old page promise, is
    // the cross-document completion contract.
    const invocation = page.evaluate((goal) => window.SiteWake.run(goal), GOAL).catch(() => undefined);
    const run = await waitForTerminal(plane);
    await invocation;

    assert.equal(run.status, "completed", JSON.stringify({
      outcome: run.outcome,
      output: run.output,
      pageAgentStep: plane.pageAgentStep,
      modelStages: plane.modelCalls.map((call) => call.stage),
      routeErrors: plane.events.filter((event) => event.name === "route-error"),
    }, null, 2));
    assert.equal(run.outcome?.status, "success");
    assert.deepEqual(run.output, { query: "垫子", cartItem: "Brown bear cushion", quantity: 1 });
    assert.ok(Date.now() - startedAt <= 120_000, "wall-clock execution must remain within the local E2E SLO");

    const body = await page.locator("body").innerText();
    assert.match(body, /Brown bear cushion has been added to your cart/i);
    assert.match(body, /There is 1 item in your cart/i);
    assert.doesNotMatch(body, /Mountain fox cushion has been added to your cart/i);
    assert.doesNotMatch(body, /Hummingbird cushion has been added to your cart/i);

    const pageCalls = plane.modelCalls.filter((call) => call.stage === "runtime-page-agent");
    const boundaryCalls = plane.modelCalls.filter((call) => call.stage === "runtime-boundary");
    assert.equal(pageCalls.length, 5, "search, submit, exact add, one bounded settle and terminal proof should take five PageAgent model requests");
    assert.ok(plane.modelCalls.length <= 100, "the entire deterministic flow must remain under the shared model limit");
    assert.equal(boundaryCalls.length, 0, "PrestaShop newsletter email must not trigger a boundary model review");
    assert.match(plane.terminalPrompt || "", /Brown bear cushion/i, "the terminal model turn must see the bound product entity");
    assert.match(plane.terminalPrompt || "", /Added to your cart/i, "the terminal model turn must see the business confirmation");
    assert.equal(plane.events.filter((event) => event.name === "route-error").length, 0);

    const observations = [...plane.observations.values()].sort((left, right) => left.pageEpoch - right.pageEpoch || left.turnIndex - right.turnIndex);
    assertObservationChain(observations);
    assert.equal(plane.episodes.length, 1, "the successful execution must persist exactly one Episode");
    const episode = plane.episodes[0];
    assert.equal(episode.mode, "adaptive");
    assert.equal(episode.outcome.status, "success");
    assert.equal(episode.sourceCapabilityId, undefined);
    assert.equal(episode.repairKind, undefined, "normal PageAgent execution must not synthesize repair");
    assert.ok(episode.experience?.budgetEvidence?.modelRequests <= 100);
    assert.equal(episode.experience?.budgetEvidence?.exhaustedReason, undefined);

    const receipts = episode.experience?.actionReceiptsV2 || [];
    assert.deepEqual(receipts.map((receipt) => receipt.action), ["set-text", "submit", "click", "wait"]);
    assert.equal(receipts.filter((receipt) => receipt.action === "click" && /Brown bear cushion/i.test(receipt.target?.accessibleName || "")).length, 1);
    assert.equal(receipts.filter((receipt) => receipt.action === "click" && /Mountain fox|Hummingbird/i.test(receipt.target?.accessibleName || "")).length, 0);
    assert.ok(receipts.every((receipt) => receipt.beforeObservationId && receipt.afterObservationId), "every dispatched action must have closed before/after evidence");

    const refs = episode.experience?.observationRefs || [];
    assert.deepEqual(refs.map((ref) => ref.id), observations.map((observation) => observation.id));
    assert.deepEqual(refs.map((ref) => ref.sha256), observations.map((observation) => observation.sha256));
    assert.equal(plane.legacyExperiencePosts, 0, "strict Runtime V2 must never downgrade to the legacy client experience POST");
    assert.ok(plane.events.findIndex((event) => event.name === "episode-acked") > plane.events.findLastIndex((event) => event.name === "observations-acked"), "all evidence batches must be acknowledged before Episode ingestion");

    const firstReceiptAt = Date.parse(receipts[0].startedAt);
    assert.ok(Number.isFinite(firstReceiptAt) && firstReceiptAt - startedAt <= 30_000, "first effective page action must begin within 30 seconds");
    assertionsPassed = true;
  } finally {
    try {
      await page.goto(`${SHOP_ORIGIN}/cart?action=show`, { waitUntil: "domcontentloaded", timeout: 15_000 });
      const remove = page.getByRole("link", { name: "Remove Brown bear cushion from cart" });
      if (assertionsPassed) assert.equal(await remove.count(), 1, "the isolated cart must contain exactly one removable Brown bear cushion");
      if (await remove.count()) {
        await remove.click({ timeout: 5_000 });
        await remove.waitFor({ state: "detached", timeout: 10_000 });
      }
    } catch (error) {
      if (assertionsPassed) throw error;
      // The isolated anonymous cart expires independently; cleanup is best-effort
      // and never masks the Runtime V2 assertion that failed above.
    }
    await browser.close();
  }
});
