import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function load(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    external: ["playwright"],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const [{ contractFromDemonstration, contractWithOutputs, addressTemplateFromEnd, intentFromGoal, humanize }, { traceFromExperience }] = await Promise.all([
  load("../runner/capability-v2/contract-from-demonstration.ts"),
  load("../runner/capability-v2/recording-trace.ts"),
]);

function recording(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/capability-center-v2/recordings/${name}.json`, import.meta.url)), "utf8"));
}

function contractFor(name) {
  const { goal, parameters, experience } = recording(name);
  const { program } = traceFromExperience(experience, parameters);
  return contractFromDemonstration({ goal, parameters, experience, trace: program });
}

const wording = (contract) => contract.successConditions.filter((condition) => typeof condition === "string" || ["textIncludes", "textTemplate", "modelGoal"].includes(condition?.type));

test("a category count: the goal is the intent, the category the input, and no page wording is a condition", () => {
  const contract = contractFor("books-count-poetry");
  assert.equal(contract.intent, "How many books are in the {{category}} category?");
  assert.deepEqual(Object.keys(contract.inputSchema.properties), ["category"]);
  assert.deepEqual(contract.inputSchema.properties.category.examples, ["Poetry"]);
  assert.deepEqual(contract.inputSchema.required, ["category"]);
  assert.deepEqual(contract.preconditions, [{ type: "inputExists", path: "category" }]);
  assert.equal(contract.scope.kind, "site-global", "the run started on the home page");
  // "poetry_23" is the site's slug, not the input; no address is demanded.
  assert.deepEqual(contract.successConditions, []);
  assert.deepEqual(wording(contract), []);
});

test("an address that carries the input is demanded only up to the input, not the page the visitor was reading", () => {
  const contract = contractFor("quotes-tag-count");
  assert.equal(contract.intent, "How many quotes are tagged '{{tag}}'?");
  assert.deepEqual(contract.successConditions, [{ type: "urlTemplate", template: "/tag/{{tag}}" }], "the tag is in the address; page 2 is where the visitor happened to end");
  assert.equal(addressTemplateFromEnd("http://shop.test/search?controller=search&s=Brown+bear+cushion", { query: "Brown bear cushion" }), "/search?controller=search&s={{query}}");
  assert.equal(addressTemplateFromEnd("http://shop.test/home-accessories/10-24-brown-bear-cushion.html", { productName: "Brown bear cushion" }), undefined, "a slug that merely contains the words is not the input");
});

test("an add-to-cart run demands no address, and its outputs are frozen from the first passing draft", () => {
  const before = contractFor("ps-add-cushion");
  assert.equal(before.intent, "Add the {{productName}} to my cart");
  assert.deepEqual(before.successConditions, []);
  assert.deepEqual(before.outputSchema.properties, {});
  const after = contractWithOutputs(before, { cartItemName: "Brown bear cushion", cartItemQuantity: 1, lineTotal: null, options: ["White"], detail: { color: "White" } });
  assert.deepEqual(Object.keys(after.outputSchema.properties), ["cartItemName", "cartItemQuantity", "lineTotal", "options", "detail"]);
  assert.deepEqual(after.outputSchema.properties.cartItemQuantity, { type: "number", title: "Cart item quantity" });
  assert.deepEqual(after.outputSchema.properties.options, { type: "array", items: { type: "string" }, title: "Options" });
  assert.deepEqual(after.outputSchema.required, ["cartItemName", "cartItemQuantity", "options", "detail"], "a field the draft returned as null is an output, not a required one");
  assert.deepEqual(after.successConditions, [
    { type: "outputExists", path: "cartItemName" }, { type: "outputExists", path: "cartItemQuantity" },
    { type: "outputExists", path: "options" }, { type: "outputExists", path: "detail" },
  ]);
  // Freezing again replaces the output conditions rather than stacking them.
  const again = contractWithOutputs(after, { cartItemName: "x" });
  assert.deepEqual(again.successConditions, [{ type: "outputExists", path: "cartItemName" }]);
  assert.deepEqual(wording(after), []);
});

test("intent and names are written from the words at hand", () => {
  assert.equal(intentFromGoal("Put 2 of the \"Mug The best is yet to come\" in my cart", { productName: "Mug The best is yet to come", quantity: 2 }), "Put {{quantity}} of the \"{{productName}}\" in my cart");
  assert.equal(intentFromGoal("Show me the cheapest lamp", { query: "pendant" }), "Show me the cheapest lamp", "a value the goal does not contain leaves the goal as it is");
  assert.equal(humanize("quoteCount"), "Quote count");
  assert.equal(humanize("product_name"), "Product name");
});

test("an output another listed value answers without is optional, and no condition demands it", async () => {
  const { contractWithOutputs, withOptionalOutputs } = await load("../runner/capability-v2/contract-from-demonstration.ts");
  const base = { intent: "Add {{productName}} to cart", inputSchema: { type: "object", properties: { productName: { type: "string" } }, required: ["productName"] }, outputSchema: { type: "object", properties: {}, required: [], additionalProperties: true }, preconditions: [], successConditions: [] };
  const frozen = contractWithOutputs(base, { productName: "Brown bear cushion", selectedColor: "White", quantity: 1 });
  assert.deepEqual(frozen.outputSchema.required, ["productName", "selectedColor", "quantity"]);
  const relaxed = withOptionalOutputs(frozen, ["selectedColor"]);
  assert.deepEqual(relaxed.outputSchema.required, ["productName", "quantity"]);
  assert.ok(relaxed.outputSchema.properties.selectedColor, "the field stays declared");
  assert.ok(!relaxed.successConditions.some((condition) => condition.path === "selectedColor"));
  assert.ok(relaxed.successConditions.some((condition) => condition.path === "quantity"));
});
