/**
 * A visitor who writes in English reads English back, whatever language their
 * browser asks for: the status lines, the failure notice and the answer. A
 * recorded run on the demo store showed an English request answered inside a
 * Chinese shell, with a Chinese failure notice, because only the answer looked
 * at anything but the browser.
 *
 * And a request that only asks to find something is settled by an answer from
 * the site's indexed page text: the same run was sent back for a "page
 * receipt" until its turns ran out.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function moduleFrom(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const copy = await moduleFrom("../client/user-agent-copy.ts");
const requirement = await moduleFrom("../lib/site-knowledge/execution-requirement.ts");

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

function withBrowser(languages, body) {
  const saved = { localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator") };
  globalThis.localStorage = memoryStorage();
  globalThis.sessionStorage = memoryStorage();
  Object.defineProperty(globalThis, "navigator", { value: { languages, language: languages[0] }, configurable: true });
  try { return body(); }
  finally {
    globalThis.localStorage = saved.localStorage;
    globalThis.sessionStorage = saved.sessionStorage;
    if (saved.navigator) Object.defineProperty(globalThis, "navigator", saved.navigator);
  }
}

test("a request's language is read from its script", () => {
  assert.equal(copy.requestLocale("Find me an eye-friendly lamp for my desk."), "en");
  assert.equal(copy.requestLocale("帮我找一个护眼台灯"), "zh");
  // A Chinese request naming an English product is still Chinese.
  assert.equal(copy.requestLocale("比较 Kesta Reading Lamp 和 Lune Table Lamp"), "zh");
  assert.equal(copy.requestLocale("42?"), undefined);
});

test("an English request on a Chinese browser turns the widget and the reply English", () => {
  withBrowser(["zh-CN", "zh"], () => {
    assert.equal(copy.resolveWidgetLocale(), "zh");
    copy.followRequestLocale("Find me an eye-friendly lamp for my desk.");
    assert.equal(copy.resolveWidgetLocale(), "en");
    assert.equal(copy.resolveReplyLocale("zh"), "en");
  });
});

test("a Chinese request on an English site is answered in Chinese", () => {
  withBrowser(["en-US"], () => {
    copy.followRequestLocale("帮我找一个护眼台灯");
    assert.equal(copy.resolveWidgetLocale(), "zh");
    assert.equal(copy.resolveReplyLocale("en"), "zh");
  });
});

test("a language the visitor picked outranks the language they wrote in", () => {
  withBrowser(["en-US"], () => {
    copy.saveWidgetLocale("zh");
    copy.followRequestLocale("Find me a lamp");
    assert.equal(copy.resolveWidgetLocale(), "zh");
    assert.equal(copy.resolveReplyLocale("en"), "zh");
  });
});

test("a request with no clear language leaves the earlier one, and a new chat forgets it", () => {
  withBrowser(["zh-CN"], () => {
    copy.followRequestLocale("Find me a lamp");
    copy.followRequestLocale("42");
    assert.equal(copy.resolveWidgetLocale(), "en");
    copy.forgetConversationLocale();
    assert.equal(copy.resolveWidgetLocale(), "zh");
  });
});

test("only a pure search may be settled by an answer from indexed page text", () => {
  const lamp = "Find me an eye-friendly lamp for my desk. Compare suitable options using the product details on this site and explain your recommendation. Only search and show information. Do not add anything to the cart, place an order, or make a payment.";
  assert.equal(requirement.knowledgeCanAnswerGoal(lamp), true);
  assert.equal(requirement.knowledgeCanAnswerGoal("帮我找一个护眼台灯并比较一下"), true);
  // A rearranged page, an opened page or a write is a change the page has to show.
  assert.equal(requirement.knowledgeCanAnswerGoal("Search for lamps and sort by price"), false);
  assert.equal(requirement.knowledgeCanAnswerGoal("Find a lamp and add it to the cart"), false);
  assert.equal(requirement.knowledgeCanAnswerGoal("Open the help center"), false);
  assert.equal(requirement.knowledgeCanAnswerGoal("Order a dimmable desk lamp in brass"), false);
});
