import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

// The server accepts an Episode only with the input its run was started with.
// A capability the assistant called replaced the session input with the
// capability's, so "Which floor lamps suit a bedroom?" was answered and then
// its record was refused: {room: "bedroom"} against a run of {}.
test("an Episode is sent with its run's input, not the input of a capability the run called", async (t) => {
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
  await page.route("https://run-input.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Shop</title><main>Lamps</main>" }));
  await page.goto("https://run-input.test/");
  await page.addScriptTag({ content: built.outputFiles[0].text });
  const sent = await page.evaluate(async () => {
    const port = window.SiteWakePort.create({ siteAgentId: "run-input" });
    port.activeRun = { id: "run_1", input: {} };
    port.runPointer = { runId: "run_1", resumeToken: "token", savedAt: Date.now() };
    const bodies = [];
    window.fetch = async (url, init) => {
      if (String(url).includes("/episodes")) bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ error: "stop_here" }), { status: 400 });
    };
    const episode = {
      id: "episode_1", taskSessionId: "run_1", siteAgentId: "run-input", goal: "Which floor lamps suit a bedroom?",
      input: { room: "bedroom" },
      outcome: { status: "success", code: "done", summary: "Rune Tripod", evaluatedAt: new Date().toISOString(), evidence: {} },
    };
    await port.ingestEpisode(episode, {}, "adaptive").catch(() => undefined);
    return bodies;
  });
  assert.equal(sent.length, 1, "the record was sent");
  assert.deepEqual(sent[0].input, {}, "the record carries the run's input");
  assert.equal(sent[0].goal, "Which floor lamps suit a bedroom?");
});
