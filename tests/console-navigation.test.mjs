import assert from "node:assert/strict";
import test from "node:test";
import { writeConsoleRoute, consoleRoute } from "../lib/console/route.ts";

test("user navigation adds history once, preserving router state and unrelated query fields", () => {
  const original = globalThis.window;
  const entries = [];
  const state = { router: "preserve" };
  globalThis.window = {
    location: { href: "http://localhost/?site=a&view=capabilities&module=runners&capability=c&utm_source=docs", get search() { return new URL(this.href).search; } },
    history: { state, pushState(value, _unused, url) { entries.push(["push", value]); window.location.href = String(url); }, replaceState(value, _unused, url) { entries.push(["replace", value]); window.location.href = String(url); } },
  };
  try {
    writeConsoleRoute("site", "a", "sessions", "", "push");
    assert.deepEqual(entries, [["push", state]]);
    const url = new URL(window.location.href);
    assert.equal(url.searchParams.get("module"), null);
    assert.equal(url.searchParams.get("capability"), null);
    assert.equal(url.searchParams.get("utm_source"), "docs");
    assert.equal(consoleRoute().tab, "sessions");
    writeConsoleRoute("site", "a", "sessions", "");
    assert.equal(entries.length, 1, "render synchronization must not duplicate history");
    writeConsoleRoute("site", "b", "sessions", "", "push");
    assert.equal(consoleRoute().siteId, "b");
    assert.equal(consoleRoute().tab, "sessions");
  } finally { globalThis.window = original; }
});

test("settings drops website scope, preserves its category and keeps old website-settings links working", () => {
  const original = globalThis.window;
  globalThis.window = {
    location: { href: "http://localhost/?site=shop&view=settings&section=runtime", get search() { return new URL(this.href).search; } },
    history: { replaceState(_state, _unused, url) { window.location.href = String(url); } },
  };
  try {
    writeConsoleRoute("site", "shop", "settings", "");
    assert.equal(consoleRoute().siteId, "");
    assert.equal(new URL(window.location.href).searchParams.get("section"), "runtime");
    writeConsoleRoute("site", "shop", "connection", "");
    assert.equal(consoleRoute().tab, "connection");
    assert.equal(consoleRoute().siteId, "shop");
    assert.equal(new URL(window.location.href).searchParams.has("section"), false);
    window.location.href = "http://localhost/?site=shop&view=settings&section=connection";
    assert.equal(consoleRoute().tab, "connection");
    writeConsoleRoute("system", "shop", "overview", "");
    assert.equal(consoleRoute().runnerSiteAgentId, "");
    assert.equal(consoleRoute().scope, "system");
  } finally { globalThis.window = original; }
});
