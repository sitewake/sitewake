import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/** The console's Chinese copy, which is where its labels live. */
const consoleCopyZh = readFileSync(new URL("../lib/i18n/zh.ts", import.meta.url), "utf8");
import { readFileSync } from "node:fs";

async function runnerConsoleSources() {
  // Route parsing lives in lib/console/route.ts; the rest of the console
  // behaviour is still JSX in the component, so both sources are returned.
  return Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../components/site-agent-console.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/console/route.ts", import.meta.url), "utf8"),
  ]);
}

test("runner visibility is injected by the server without a client capability request", async () => {
  const [pageSource, consoleSource] = await runnerConsoleSources();

  assert.match(pageSource, /configuredRunnerProjectionMode\(\)/);
  assert.match(
    pageSource,
    /<SiteAgentConsole initialRunnerMode=\{runnerMode\}/,
  );
  assert.match(
    consoleSource,
    /initialRunnerMode:\s*RunnerManagementMode/,
  );
  assert.match(
    consoleSource,
    /useState<RunnerManagementMode>\(initialRunnerMode\)/,
  );
  assert.doesNotMatch(
    consoleSource,
    /\/api\/runner-management\/capabilities/,
  );
  assert.doesNotMatch(
    consoleSource,
    /fetch\([^)]*\/api\/runner-management\//s,
  );
});

test("hidden system runner deep links fall back before the management surface mounts", async () => {
  const [, consoleSource] = await runnerConsoleSources();

  assert.match(
    consoleSource,
    /runnerMode === "hidden" && route\.scope === "system"/,
  );
  assert.match(
    consoleSource,
    /setScope\(hiddenRunnerRoute \? "site" : route\.scope\)/,
  );
  assert.doesNotMatch(consoleSource, /id: "runners", label:/);
  // `openRunnerManagement` is gone: runner management became a module inside the
  // capability tab rather than its own opener, so the route carries it. What the
  // assertion protected — a hidden mode offering no way in — is held by the two
  // assertions above (hidden forces the site scope, and there is no `runners` nav
  // entry). This one pins the route that replaced it.
  assert.match(consoleSource, /url\.searchParams\.set\("view", "capabilities"\)/,
    "runner \u7ba1\u7406\u73b0\u5728\u662f\u80fd\u529b\u9875\u91cc\u7684\u4e00\u4e2a module");
  assert.match(consoleSource, /url\.searchParams\.set\("module", "runners"\)/);
  assert.doesNotMatch(consoleSource, /<nav className="sw-system-nav"/);
  assert.match(
    consoleSource,
    /scope === "system" \? \(\s*<RunnerManagement/s,
  );
});

test("runner management is reached from the capability workspace while legacy links remain compatible", async () => {
  const [, consoleSource, routeSource] = await runnerConsoleSources();

  assert.doesNotMatch(consoleSource, /className="sw-system-menu-trigger"/);
  assert.match(consoleCopyZh, /Runner 管理/);
  assert.match(consoleSource, /url\.searchParams\.set\("view", "capabilities"\);[\s\S]*url\.searchParams\.set\("module", "runners"\)/);
  assert.match(consoleSource, /const legacySiteId =[\s\S]*url\.searchParams\.set\("view", "capabilities"\);[\s\S]*url\.searchParams\.set\("module", "runners"\)/);
  assert.doesNotMatch(consoleSource, /tab === "runners"/);
  assert.match(
    routeSource,
    /if \(rawView === "runners"\)/,
  );
  assert.match(
    routeSource,
    /scope: "system" as ConsoleScope[\s\S]*runnerSiteAgentId:[\s\S]*query\.get\("siteAgentId"\) \|\| query\.get\("site"\)/,
  );
  assert.match(
    routeSource,
    /url\.searchParams\.set\("site", siteId\)[\s\S]*url\.searchParams\.set\("view", tab\)/,
  );
});

test("site-filtered runner routes resolve visibility with the site context", async () => {
  const [overview, tasks, bindings] = await Promise.all([
    readFile(new URL("../app/api/runner-management/overview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/runner-management/tasks/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/runner-management/runners/[runnerId]/bindings/[siteAgentId]/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(overview, /configuredRunnerProjectionMode\(\{ siteAgentId \}\)/);
  assert.match(tasks, /configuredRunnerProjectionMode\(\{ siteAgentId \}\) !== "full"/);
  assert.ok(
    tasks.indexOf("const siteAgentId") < tasks.indexOf("configuredRunnerProjectionMode({ siteAgentId })"),
  );
  assert.match(bindings, /configuredRunnerProjectionMode\(\{ siteAgentId: params\.siteAgentId \}\)/);
});
