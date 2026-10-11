import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../lib/site-knowledge/execution-evidence.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const evidence = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

function observation(id, content) {
  return {
    id,
    state: { url: "http://shop.test/search", title: "Search results", header: "", content, footer: "" },
    targets: [],
  };
}

function receipt(targetText, beforeObservationId, afterObservationId) {
  return {
    id: "add-cart",
    dispatched: true,
    effect: "changed",
    input: { index: 1 },
    target: { role: "button", accessibleName: "Add to cart", nearbyText: targetText },
    effectSignals: {},
    beforeObservationId,
    afterObservationId,
  };
}

const brief = {
  objective: "给我找一个黑色的垫子加入购物车",
  normalizedGoal: "给我找一个黑色的垫子加入购物车",
  entities: { goalTarget: { anyOf: ["cushion", "垫子", "靠垫"] } },
  effect: "reversible-write",
  completionCriteria: [],
};

test("effectful product goals derive a target alias group", () => {
  assert.deepEqual(evidence.inferExecutionTargetEntity("给我找一个黑色的垫子加入购物车"), { anyOf: ["cushion", "垫子", "靠垫"] });
  assert.equal(evidence.inferExecutionTargetEntity("给我找一个商品加入购物车"), undefined);
});

test("search-result text cannot prove that an unrelated product was added", () => {
  const before = observation("before", "Search form");
  const after = observation("after", "Search results for 黑色的垫子. Mug Today is a good day was added to your cart.");
  const wrong = evidence.assessPageExecutionEvidence({
    brief,
    receipts: [receipt("Mug Today is a good day", before.id, after.id)],
    observations: [before, after],
    completionEvidence: [],
  });
  assert.equal(wrong.satisfied, false);
  assert.deepEqual(wrong.missingEntities, ["goalTarget"]);

  const correctAfter = observation("correct-after", "Search results for 黑色的垫子. Brown bear cushion was added to your cart.");
  const correct = evidence.assessPageExecutionEvidence({
    brief,
    receipts: [receipt("Brown bear cushion", before.id, correctAfter.id)],
    observations: [before, correctAfter],
    completionEvidence: [],
  });
  assert.equal(correct.satisfied, true);
});
