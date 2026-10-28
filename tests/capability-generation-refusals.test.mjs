import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Three refusals the benchmark found ending runs the visitor had just seen
// succeed (benchmark/BASELINE.md): a guard meant for write stages applied to
// every stage, an explorer that ended a generation when the model read a
// value off the page, and a grounding check that took a colour word inside a
// product's own name for a facet.
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export { isSuspiciousDetailTransition } from "./runner/capability-v2/javascript-stage-runner";
      export { extractWithoutElementAsDone, assertGoalTargetGrounded } from "./runner/capability-v2/browser-runtime";
      export { validateCapabilityJavaScriptSource, DEMOTED_CHECKS } from "./lib/capability-center-v2/javascript-runtime";
    `,
    resolveDir: ROOT, loader: "ts", sourcefile: "generation-refusals-test.ts",
  },
  bundle: true, platform: "node", format: "esm", write: false, external: ["playwright", "esbuild"],
});
const { isSuspiciousDetailTransition, extractWithoutElementAsDone, assertGoalTargetGrounded, validateCapabilityJavaScriptSource, DEMOTED_CHECKS } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("paging a tag on a static site is not a product detour: only a write stage is judged", () => {
  const page1 = "http://quotes.bench:8102/tag/humor/index.html";
  const page2 = "http://quotes.bench:8102/tag/humor/page/2/index.html";
  assert.equal(isSuspiciousDetailTransition(page1, page2, "stage_3", "read"), false);
  assert.equal(isSuspiciousDetailTransition(page1, page2, "stage_3", "write"), true, "a write stage leaving one detail page for another still is");
  assert.equal(isSuspiciousDetailTransition(page1, page2, "stage_3"), true, "callers that name no effect keep the strict reading");
  assert.equal(isSuspiciousDetailTransition("http://shop.bench/men/1-1-t-shirt.html", "http://shop.bench/men/1-1-t-shirt.html#/1-size-s", "stage_2", "write"), false, "a variant change on the same page is fine");
});

test("an extract that names no element is the demonstration's end, not its failure", () => {
  assert.deepEqual(extractWithoutElementAsDone({ action: "extract", saveAs: "resultCount", extractType: "text", reason: "The count is on the page" }), { action: "done", reason: "The count is on the page" });
  assert.deepEqual(extractWithoutElementAsDone({ action: "extract", saveAs: "resultCount", extractType: "text" }), { action: "done", reason: "extract_without_element:resultCount" });
  const withElement = { action: "extract", index: 4, saveAs: "price", extractType: "text" };
  assert.equal(extractWithoutElementAsDone(withElement), withElement, "an extract on an element is acted on");
  const click = { action: "click", index: 2 };
  assert.equal(extractWithoutElementAsDone(click), click);
});

test("a colour word inside the demonstrated product's name is not a facet to ground", () => {
  const plan = { parameters: [{ name: "productName", role: "target", userSupplied: true }], groundingExamples: [], inputAliases: {} };
  const evidence = "Brown bear cushion $18.90 Add to cart Product successfully added to your shopping cart";
  assert.doesNotThrow(() => assertGoalTargetGrounded(plan, "Add the Brown bear cushion to my cart", evidence));
  // A colour that is a real facet, and not in the evidence as part of a name, is still refused.
  assert.throws(() => assertGoalTargetGrounded(plan, "Add a brown cushion to my cart", "Mountain fox cushion $18.90 Add to cart"), /capability_goal_target_not_grounded/);
});

test("the cheapest of the listed items is published with a provenance note, not refused", () => {
  // The verify stage of "the cheapest book in a category": its output is
  // computed from the elements it listed. The resolver cannot trace a value
  // through sort/reduce; the check is demoted, so the finding is a note.
  const body = `const items=[...document.querySelectorAll("article.product_pod")].map(pod=>({title:pod.querySelector("h3 a").getAttribute("title"),price:Number(pod.querySelector(".price_color").textContent.replace(/[^\\d.]/g,""))}));const cheapest=items.sort((a,b)=>a.price-b.price)[0];return{outcome:"Success",output:{cheapestTitle:cheapest.title,cheapestPrice:cheapest.price}}`;
  const verdict = validateCapabilityJavaScriptSource(`export const capability={version:2,stages:[{id:"stage_verify",async run({input,state,waitFor}){${body}}}]};`, []);
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  assert.ok((verdict.notes || []).some((note) => note.code.startsWith("capability_module_output_provenance_unknown:")), JSON.stringify(verdict.notes));
  assert.ok(Object.hasOwn(DEMOTED_CHECKS, "capability_module_output_provenance_unknown"), "the demotion is declared, so the gate table can show it");
});
