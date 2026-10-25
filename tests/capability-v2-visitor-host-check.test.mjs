import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { VALIDATION_RESULT_KEY } from "../lib/capability-center-v2/validation-run.ts";

// Bundled like the other runner suites: the runner's own imports are extensionless.
const bundled = await build({ entryPoints: [fileURLToPath(new URL("../runner/capability-v2/visitor-host-check.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false, external: ["playwright"] });
const { runCandidateInVisitorHost } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

const candidate = {
  name: "Open rank",
  contract: { inputSchema: { type: "object", properties: { rank: { type: "number" } }, required: ["rank"] }, outputSchema: { type: "object", properties: {} } },
  program: { schemaVersion: "2.0", runtime: "BrowserJavaScriptStage", entry: { mode: "CurrentPage" }, stages: [], module: { contentHash: "a".repeat(64), moduleUrl: "/module.js", exportName: "capability" } },
};

/**
 * A stand-in for the site's widget. It offers validateCandidate only when the
 * runner marked the page before the site's scripts ran, as the real one does,
 * and ends the run the way the scenario says — on this document or the next.
 */
function widget(scenario) {
  if (scenario === "absent") return "";
  if (scenario === "outdated") return `<script>window.SiteWake = { run() {} };</script>`;
  return `<script>
    window.SiteWake = { run() {} };
    if (window.__sitewakeValidation === true) window.SiteWake.validateCandidate = async (runtime, input) => {
      sessionStorage.setItem("seen", JSON.stringify({ name: runtime.name, input }));
      ${scenario === "navigates" ? `location.assign("/next");` : scenario === "no-result" ? `sessionStorage.setItem(${JSON.stringify(VALIDATION_RESULT_KEY)}, JSON.stringify({ status: "no-result", code: "capability_no_result", summary: "nothing found", output: {}, url: location.href }));` : ""}
    };
    if (location.pathname === "/next" && sessionStorage.getItem("seen")) sessionStorage.setItem(${JSON.stringify(VALIDATION_RESULT_KEY)}, JSON.stringify({ status: "success", code: "capability_v2_program_verified", summary: "done", output: { rank: JSON.parse(sessionStorage.getItem("seen")).input.rank }, url: location.href }));
  </script>`;
}

test("validation runs the candidate through the page's own widget and reads how it ended", { timeout: 60_000 }, async (t) => {
  let scenario = "";
  const server = createServer((req, res) => { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(`<!doctype html><title>Site</title>${widget(scenario)}`); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const run = async (name, timeoutMs = 10_000) => {
    scenario = name;
    const context = await browser.newContext();
    try { return await runCandidateInVisitorHost({ page: await context.newPage(), startUrl: `${origin}/`, candidate, input: { rank: 3 }, timeoutMs }); }
    finally { await context.close(); }
  };
  try {
    await t.test("a run that crosses a document and succeeds agrees", async () => {
      const check = await run("navigates");
      assert.equal(check.outcome, "Agreed");
      assert.equal(check.result.url, `${origin}/next`);
      assert.deepEqual(check.result.output, { rank: 3 }, "the widget received the case's input");
    });
    await t.test("a run that ends without success diverges and says how", async () => {
      const check = await run("no-result");
      assert.equal(check.outcome, "Diverged");
      assert.match(check.reason, /capability_no_result: nothing found/);
    });
    await t.test("a run that never ends diverges at its deadline", async () => {
      const check = await run("silent", 2_500);
      assert.equal(check.outcome, "Diverged");
      assert.match(check.reason, /did not finish within 3s/);
    });
    await t.test("a page without the widget, or with one that cannot take a candidate, is skipped", async () => {
      assert.equal((await run("absent")).outcome, "Skipped");
      assert.equal((await run("outdated")).outcome, "Skipped");
    });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
