import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Bundle instead of importing .ts directly: `lib/console/route.ts` has an extensionless
// relative import that `--experimental-strip-types` cannot resolve (a pre-existing
// issue; tests/console-navigation.test.mjs fails on HEAD for the same reason). Not
// touched here.
async function bundledModule(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { consoleRoute, writeConsoleRoute, CONSOLE_TABS } = await bundledModule("../lib/console/route.ts");

function withWindow(href, run) {
  const original = globalThis.window;
  globalThis.window = {
    location: { href, get search() { return new URL(this.href).search; } },
    history: {
      state: null,
      replaceState(_state, _unused, url) { globalThis.window.location.href = String(url); },
      pushState(_state, _unused, url) { globalThis.window.location.href = String(url); },
    },
  };
  try { return run(); } finally { globalThis.window = original; }
}

test("the onboarding flow is not a tab and does not disturb the unknown-view fallback", () => {
  // Tab identity and order do not change for onboarding.
  assert.deepEqual(
    CONSOLE_TABS.map((item) => item.id),
    ["overview", "agent", "sessions", "capabilities", "model", "settings"],
  );
  withWindow("http://localhost/?view=onboarding", () => {
    assert.equal(consoleRoute().tab, "overview", "未知 view 仍然兜底回首页");
    assert.equal(consoleRoute().onboarding, false, "view 名字不能开启流程");
  });
  withWindow("http://localhost/?view=connect", () => {
    assert.equal(consoleRoute().tab, "overview");
    assert.equal(consoleRoute().onboarding, false);
  });
});

test("the onboarding flag round-trips through the URL and stays orthogonal to the tab", () => {
  withWindow("http://localhost/", () => {
    writeConsoleRoute("site", "", "overview", "", "replace", { onboarding: true });
    assert.equal(new URL(window.location.href).searchParams.get("connect"), "1");
    assert.equal(consoleRoute().onboarding, true);
    assert.equal(consoleRoute().tab, "overview");
    assert.equal(consoleRoute().siteId, "");

    // Step two carries the site, the marker stays, a refresh comes back.
    writeConsoleRoute("site", "shop", "overview", "", "replace", { onboarding: true });
    assert.equal(consoleRoute().onboarding, true);
    assert.equal(consoleRoute().siteId, "shop");

    // Omitted means cleared: leaving the flow leaves nothing in the address bar.
    writeConsoleRoute("site", "shop", "overview", "");
    assert.equal(new URL(window.location.href).searchParams.has("connect"), false);
    assert.equal(consoleRoute().onboarding, false);
  });
});

test("system scope clears the onboarding flag", () => {
  withWindow("http://localhost/?connect=1", () => {
    assert.equal(consoleRoute().onboarding, true);
    writeConsoleRoute("system", "", "overview", "");
    assert.equal(new URL(window.location.href).searchParams.has("connect"), false);
    assert.equal(consoleRoute().onboarding, false);
  });
});

test("existing route behaviour is unchanged alongside the new flag", () => {
  withWindow("http://localhost/?site=a&view=capabilities&module=runners&capability=c&utm_source=docs", () => {
    writeConsoleRoute("site", "a", "sessions", "", "push");
    const url = new URL(window.location.href);
    assert.equal(url.searchParams.get("module"), null);
    assert.equal(url.searchParams.get("capability"), null);
    assert.equal(url.searchParams.get("utm_source"), "docs", "无关查询参数仍然保留");
    assert.equal(consoleRoute().tab, "sessions");
  });
  withWindow("http://localhost/?site=shop&view=settings&section=connection", () => {
    assert.equal(consoleRoute().tab, "connection", "旧的网站设置链接仍然可用");
  });
  withWindow("http://localhost/?view=runs", () => {
    assert.equal(consoleRoute().tab, "sessions", "旧 view 名仍然可用");
  });
});

test("server rendering reports no onboarding flow", () => {
  const original = globalThis.window;
  globalThis.window = undefined;
  try {
    assert.equal(consoleRoute().onboarding, false);
    assert.equal(consoleRoute().tab, "overview");
  } finally { globalThis.window = original; }
});
