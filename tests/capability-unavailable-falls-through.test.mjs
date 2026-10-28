import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

// A request that names a published capability outright used to run it at
// once and, when the runtime refused it (409: the visitor was not on the page
// the capability is bound to), the task ended three seconds in with
// "interrupted while starting". The capability's unavailability is a note for
// the Agent, which goes on with the page and answers the visitor.
test("a capability the runtime refuses to start hands the task to the page agent instead of ending it", async (t) => {
  const built = await build({
    entryPoints: [fileURLToPath(new URL("../client/user-agent-port.ts", import.meta.url))],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
  });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://fallthrough.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Shop</title><main><h1>Lamps for every room</h1><p>Lune Table Lamp $138</p></main>" }));
  await page.goto("https://fallthrough.test/");
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const outcome = await page.evaluate(async () => {
    // A read goal: the Agent may answer it in words once the capability is out
    // of reach, where an action goal would go on to the page tool.
    const goal = "Which lamps are dimmable?";
    const candidate = {
      capabilityId: "cap_dimmable", name: "Which lamps are dimmable?", description: "Dimmable table lamps under a price", aliases: [], score: 1, status: "Active",
      contract: { intent: "Show me dimmable table lamps", inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object" }, preconditions: [], successConditions: [], scope: { kind: "page-scoped", onMismatch: "no-match", match: { urlPatterns: ["/shop"] } } },
    };
    const calls = [];
    const sse = (text) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    window.fetch = async (url, init = {}) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, "");
      calls.push({ method: init.method || "GET", path });
      if (path.includes("/capability-v2/capabilities/search")) return json({ items: [candidate] });
      if (/\/capability-v2\/capabilities\/[^/]+\/runtime/.test(path)) return json({ error: "capability_scope_mismatch", reason: "page_scope_mismatch" }, 409);
      if (path.includes("/model/v2/chat/completions")) return sse("The Lune Table Lamp is dimmable and costs $138.");
      if (/\/sessions\/run_1$/.test(path) && init.method === "PATCH") {
        const patch = JSON.parse(init.body || "{}");
        return json({ session: { ...window.__session, ...patch } });
      }
      // Every other call on the run answers with the run itself, as the console does.
      if (/\/api\/agent-runs\/run_1/.test(path)) {
        if (init.method === "PATCH") window.__run = { ...window.__run, ...JSON.parse(init.body || "{}"), revision: window.__run.revision + 1 };
        return json({ run: window.__run });
      }
      return json({});
    };
    const port = window.SiteWakePort.create({ siteAgentId: "fallthrough" });
    // The port's own start-up (connection, release) runs against the mocks and
    // settles its state; the run below is installed after it, as a resume would.
    await port.readyPromise.catch(() => undefined);
    const now = new Date().toISOString();
    const session = { id: "run_1", siteAgentId: "fallthrough", browserSessionId: "browser_1", goal, input: {}, conversation: [{ role: "user", content: goal, at: now }], nextStepIndex: 0, bindings: {}, status: "running", createdAt: now, updatedAt: now };
    window.__session = session;
    window.__run = { id: "run_1", revision: 1, scope: { siteAgentId: "fallthrough", allowedOrigins: [location.origin] }, status: "running", goal, input: {}, agentState: {}, activePort: { id: "port_1", pageEpoch: 0, browserSessionId: "browser_1" }, pageEpoch: 0, createdAt: now, updatedAt: now };
    port.activeSession = session;
    port.activeRun = window.__run;
    port.runPointer = { runId: "run_1", resumeToken: "token", savedAt: Date.now() };
    port.activeAbort = new AbortController();
    let result;
    let error;
    let stack;
    try { result = await port.runMainAgent(session); } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); stack = caught instanceof Error ? String(caught.stack).split("\n").slice(0, 8).join(" | ") : undefined; }
    const note = port.activityTimeline.find((item) => item.kind === "capability" && item.state === "failed" && item.capabilityId === "cap_dimmable");
    return {
      error, stack, calls: calls.map((call) => `${call.method} ${call.path}`).slice(0, 12),
      success: result?.success, code: result?.outcome?.code, text: result?.text,
      runtimeAsked: calls.some((call) => /\/runtime/.test(call.path)),
      modelAsked: calls.some((call) => call.path.includes("/model/v2/chat/completions")),
      note: note ? { label: note.label, detail: note.detail } : undefined,
    };
  });
  assert.equal(outcome.error, undefined, `the task ended with an error: ${outcome.error}\n${outcome.stack}\ncalls: ${outcome.calls.join(", ")}`);
  assert.equal(outcome.runtimeAsked, true, "the capability was tried first");
  assert.equal(outcome.modelAsked, true, "the page agent took over");
  assert.equal(outcome.success, true, "the visitor's task completed");
  assert.match(outcome.text || "", /Lune Table Lamp/);
  assert.ok(outcome.note, "the run records that the capability was not used");
  assert.match(outcome.note.detail || "", /scope_mismatch|409/);
});
