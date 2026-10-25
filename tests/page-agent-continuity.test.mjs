import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Three ways a visitor's task used to fail on sites other than the demo shop,
// each the same everywhere it appeared:
// - after a full-page navigation the agent no longer knew what it had
//   established on the previous page, walked back to re-establish it and
//   looped until the step limit;
// - a button whose script assigns `location` (the search button of many shops)
//   left the page without handing the task over, so the task was dropped;
// - list answers were built from the visible screen only and called complete.
globalThis.window = globalThis;
globalThis.window.addEventListener ||= () => {};
globalThis.window.removeEventListener ||= () => {};
globalThis.document ||= {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
  getElementsByTagName() { return []; },
};

async function moduleFrom(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "browser-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^@page-agent\// }, () => ({ path: "stub", namespace: "pa" }));
        builder.onLoad({ filter: /.*/, namespace: "pa" }, () => ({
          loader: "js",
          contents: "export class PageController { constructor(){ this.selectorMap=new Map(); this.elementTextMap=new Map(); } } export class PageAgentCore {} export const tool = value => value;",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { recordAgentPageNote, priorPageNotes, guardScriptNavigation, NAVIGATION_ARM_GRACE_MS } = await moduleFrom("../client/user-agent-adaptive.ts");
const { observationViewportExpansion } = await moduleFrom("../client/user-agent-page-controller.ts");

test("what the agent concluded on a page survives the navigation away from it", () => {
  let notes = [];
  notes = recordAgentPageNote(notes, { documentId: "list", url: "https://shop.test/all", memory: "Cheapest available is Bronze sandals £39.99", nextGoal: "Open Bronze sandals" });
  notes = recordAgentPageNote(notes, { documentId: "detail", url: "https://shop.test/bronze", memory: "On Bronze sandals" });
  const fromDetail = priorPageNotes(notes, "detail");
  assert.equal(fromDetail.length, 1, "the detail page must see the list page's conclusion");
  assert.match(fromDetail[0].memory, /Bronze sandals/);
  assert.equal(fromDetail[0].nextGoal, "Open Bronze sandals");
});

test("each page keeps only its latest conclusion, and the carried notes stay bounded", () => {
  let notes = [];
  notes = recordAgentPageNote(notes, { documentId: "a", url: "u", memory: "first" });
  notes = recordAgentPageNote(notes, { documentId: "a", url: "u", memory: "second" });
  assert.deepEqual(notes.map((note) => note.memory), ["second"]);
  for (let index = 0; index < 20; index += 1) {
    notes = recordAgentPageNote(notes, { documentId: `d${index}`, url: "u", memory: "x".repeat(5_000) });
  }
  assert.ok(notes.length <= 6, "a long task must not grow the prompt without limit");
  assert.ok(notes.every((note) => note.memory.length <= 1_200));
  assert.deepEqual(recordAgentPageNote(notes, { documentId: "empty", url: "u", memory: "   " }), notes, "an empty memory is not a conclusion");
});

test("ordinary pages are observed whole; only very long ones are windowed", () => {
  assert.equal(observationViewportExpansion(2_100, 900, 15), -1, "a catalog page two screens tall is read in full");
  assert.equal(observationViewportExpansion(900 * 15, 900, 15), -1);
  const windowed = observationViewportExpansion(900 * 53, 900, 15);
  assert.ok(windowed > 250, "a long article still sees more than a sliver below the fold");
  assert.notEqual(windowed, -1);
});

function fakeNavigation() {
  const listeners = new Set();
  const navigated = [];
  return {
    navigated,
    listenerCount: () => listeners.size,
    addEventListener(type, listener) { if (type === "navigate") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "navigate") listeners.delete(listener); },
    navigate(url, options) {
      navigated.push({ url, options });
      for (const listener of [...listeners]) listener(navigateEvent(url));
      return { committed: Promise.resolve(), finished: Promise.resolve() };
    },
    fire(event) { for (const listener of [...listeners]) listener(event); return event; },
  };
}

function navigateEvent(url, overrides = {}) {
  return {
    cancelable: true,
    userInitiated: false,
    hashChange: false,
    downloadRequest: null,
    formData: null,
    navigationType: "push",
    destination: { url, sameDocument: false },
    prevented: false,
    preventDefault() { this.prevented = true; },
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a script navigation during the task is held until the task is handed over, then carried out", async () => {
  const navigation = fakeNavigation();
  let armed = 0;
  const stop = guardScriptNavigation(
    { armedRecently: () => false, arm: async () => { armed += 1; }, enabled: true },
    { navigation, location: { href: "https://shop.test/products" } },
  );
  const event = navigation.fire(navigateEvent("https://shop.test/products?search=jeans"));
  assert.equal(event.prevented, true, "leaving before the handover drops the task");
  await settle();
  assert.equal(armed, 1);
  assert.deepEqual(navigation.navigated, [{ url: "https://shop.test/products?search=jeans", options: { history: "push" } }]);
  assert.equal(armed, 1, "the reissued navigation is not held a second time");
  stop();
  assert.equal(navigation.listenerCount(), 0);
});

test("navigations that are not the agent's to hand over pass straight through", async () => {
  const cases = [
    ["the visitor clicked it", navigateEvent("https://shop.test/a", { userInitiated: true })],
    ["a form POST cannot be replayed", navigateEvent("https://shop.test/a", { formData: {} })],
    ["another site cannot resume the task", navigateEvent("https://other.test/a")],
    ["the run is already being handed over by URL", navigateEvent("https://shop.test/a#sitewake-run=r.t")],
    ["same-document changes keep the page alive", navigateEvent("https://shop.test/products#reviews", { hashChange: true, destination: { url: "https://shop.test/products#reviews", sameDocument: true } })],
    ["a reload is the visitor's interruption", navigateEvent("https://shop.test/products", { navigationType: "reload" })],
    ["the browser does not allow holding it", navigateEvent("https://shop.test/a", { cancelable: false })],
  ];
  for (const [reason, event] of cases) {
    const navigation = fakeNavigation();
    let armed = 0;
    const stop = guardScriptNavigation(
      { armedRecently: () => false, arm: async () => { armed += 1; }, enabled: true },
      { navigation, location: { href: "https://shop.test/products" } },
    );
    navigation.fire(event);
    await settle();
    assert.equal(event.prevented, false, reason);
    assert.equal(armed, 0, reason);
    stop();
  }
});

test("a navigation the agent already prepared for is not prepared twice", async () => {
  assert.ok(NAVIGATION_ARM_GRACE_MS >= 1_000);
  const navigation = fakeNavigation();
  let armed = 0;
  const stop = guardScriptNavigation(
    { armedRecently: () => true, arm: async () => { armed += 1; }, enabled: true },
    { navigation, location: { href: "https://shop.test/products" } },
  );
  const event = navigation.fire(navigateEvent("https://shop.test/cart"));
  await settle();
  assert.equal(event.prevented, false);
  assert.equal(armed, 0);
  stop();
});

test("the navigation still happens when the handover fails", async () => {
  const navigation = fakeNavigation();
  const stop = guardScriptNavigation(
    { armedRecently: () => false, arm: async () => { throw new Error("agent_run_revision_conflict"); }, enabled: true },
    { navigation, location: { href: "https://shop.test/products" } },
  );
  navigation.fire(navigateEvent("https://shop.test/cart"));
  await settle();
  await settle();
  assert.equal(navigation.navigated.length, 1, "the site's own behaviour must never be swallowed");
  stop();
});

test("only one round's guard is ever listening, and browsers without the API are untouched", () => {
  const navigation = fakeNavigation();
  const hooks = { armedRecently: () => false, arm: async () => {}, enabled: true };
  guardScriptNavigation(hooks, { navigation, location: { href: "https://shop.test/" } });
  const stop = guardScriptNavigation(hooks, { navigation, location: { href: "https://shop.test/" } });
  assert.equal(navigation.listenerCount(), 1, "a finished round's guard must not act for the next one");
  stop();
  const noop = guardScriptNavigation(hooks, { location: { href: "https://shop.test/" } });
  assert.equal(typeof noop, "function");
  noop();
});
