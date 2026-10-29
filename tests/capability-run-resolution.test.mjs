import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: { contents: `export * from "./lib/capability-center-v2/run-resolution";`, resolveDir: ROOT, loader: "ts", sourcefile: "run-resolution-test.ts" },
  bundle: true, platform: "node", format: "esm", write: false,
});
const { resolveCapabilityRun, resolveCapabilityInput, checkPreconditions, evaluateSuccessConditions } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const shop = {
  inputSchema: { type: "object", properties: { maxPrice: { type: "number", default: 300 }, finish: { type: "string" } } },
  inputAliases: { finish: { "黄铜": "Brass", brass: "Brass" } },
  preconditions: [],
  successConditions: [{ type: "outputExists", path: "lampList" }, { type: "urlIncludes", value: "dimmable=yes" }, { type: "textTemplate", template: "{{finish}}" }],
  scope: { kind: "page-scoped", onMismatch: "no-match", match: { urlPatterns: ["/shop"] } },
};

test("a capability bound to the shop page starts there from the home page, and stays where a visitor already is", () => {
  const fromHome = resolveCapabilityRun(shop, { currentUrl: "https://shop.example/", input: {} });
  assert.deepEqual(fromHome.entry, { mode: "Navigate", url: "https://shop.example/shop" });
  assert.equal(fromHome.startUrl, "https://shop.example/shop");
  const onShop = resolveCapabilityRun(shop, { currentUrl: "https://shop.example/shop?room=bedroom", input: {} });
  assert.deepEqual(onShop.entry, { mode: "CurrentPage" });
  assert.equal(onShop.startUrl, "https://shop.example/shop?room=bedroom", "the visitor's filter is kept");
});

test("a site-wide capability leaves the program's entry alone and starts where the caller is", () => {
  const siteWide = { ...shop, scope: { kind: "site-global", onMismatch: "no-match" } };
  const run = resolveCapabilityRun(siteWide, { currentUrl: "https://shop.example/product/lune", input: {} });
  assert.equal(run.entry, undefined);
  assert.equal(run.startUrl, "https://shop.example/product/lune");
});

test("an optional input gets its default and an alias is mapped once, for every host", () => {
  const input = resolveCapabilityInput(shop, { finish: "黄铜" });
  assert.deepEqual(input.declared, { finish: "黄铜", maxPrice: 300 }, "the schema is checked against the caller's words plus defaults");
  assert.deepEqual(input.site, { finish: "Brass", maxPrice: 300 }, "the program runs with the site's words");
  const withProgramAliases = resolveCapabilityInput(shop, { finish: "brass" }, { finish: { brass: "Antique brass" } });
  assert.equal(withProgramAliases.site.finish, "Antique brass", "a program published with its own aliases keeps them");
});

test("success conditions are judged the same way whichever host asks: decoded addresses, normalised values, text only recorded", () => {
  const input = resolveCapabilityInput(shop, { finish: "黄铜" });
  const encoded = { url: "https://shop.example/shop?finish=Brass&dimmable=yes&category=%E5%87%BA%E8%A1%8C", text: "Brass lamps — 3 results", output: { lampList: [{ name: "Lune" }] } };
  const verdict = evaluateSuccessConditions(shop, encoded, input);
  assert.deepEqual(verdict.failures, [], "an encoded address still contains its condition");
  assert.deepEqual(verdict.unmetText, []);
  const chinese = evaluateSuccessConditions({ successConditions: [{ type: "urlIncludes", value: "category=出行" }] }, encoded, input);
  assert.deepEqual(chinese.failures, [], "a condition written in the visible text matches the percent-encoded address");
  const moved = evaluateSuccessConditions(shop, { ...encoded, text: "Loading…" }, input);
  assert.deepEqual(moved.failures, []);
  assert.deepEqual(moved.unmetText, ["Brass"], "missing page text is reported, not charged");
  const spaced = evaluateSuccessConditions({ successConditions: [{ type: "outputEquals", path: "title", value: "Lune Table Lamp" }] }, { ...encoded, output: { title: " lune  table lamp " } }, input);
  assert.deepEqual(spaced.failures, [], "a value is compared with the same text normalisation validation uses, not by identity");
  const missingOutput = evaluateSuccessConditions(shop, { ...encoded, output: {} }, input);
  assert.deepEqual(missingOutput.failures.map((item) => item.code), ["success_output_missing"]);
  assert.equal(evaluateSuccessConditions({ successConditions: [] }, encoded, input).needsModelJudge, true);
});

test("preconditions name what is unmet, with the rendered text and inputs a host needs to answer", () => {
  const contract = { preconditions: [{ type: "urlIncludes", value: "/shop" }, { type: "textTemplate", template: "{{finish}}" }, { type: "inputExists", path: "room" }] };
  const input = resolveCapabilityInput(shop, { finish: "黄铜" });
  const failures = checkPreconditions(contract, { url: "https://shop.example/", text: "Welcome" }, input);
  assert.deepEqual(failures.map((item) => item.code), ["precondition_url_mismatch", "precondition_text_missing", "precondition_input_missing:room"]);
  assert.equal(failures[1].rendered, "Brass");
  assert.deepEqual(failures[1].inputPaths, ["finish"]);
  assert.deepEqual(checkPreconditions(contract, { url: "https://shop.example/shop", text: "Brass" }, resolveCapabilityInput(shop, { finish: "黄铜", room: "bedroom" })), []);
});
