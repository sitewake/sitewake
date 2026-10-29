import assert from "node:assert/strict";
import test from "node:test";
import { answerContains, answerMatches, normalizeText, siteStateHolds } from "../scripts/benchmark/check.mjs";

test("a reply passes when every fact is in it, however it is punctuated or cased", () => {
  const reply = "The cheapest Travel book is “The Road to Little Dribbling: Adventures of an American in Britain (Notes From a Small Island #2)” at £23.21.";
  assert.deepEqual(answerContains(reply, ["The Road to Little Dribbling: Adventures of an American in Britain (Notes From a Small Island #2)", "23.21"]), { pass: true, missing: [] });
  assert.deepEqual(answerContains("There are 19 books in Poetry.", ["19"]).pass, true);
  assert.deepEqual(answerContains("Price: $1,299.00", ["1299"]).pass, true);
  assert.equal(answerContains("The cheapest accessory is the Mug at $11.90.", ["11.9"]).pass, true, "a price is a value, not a spelling");
  assert.equal(answerContains("The most expensive Travel book is A Year in Provence at £56.88.", ["A Year in Provence (Provence #1)", "56.88"]).pass, true, "a title may drop its series suffix");
});

test("a reply fails when a fact is missing, and a bare number is not found inside a longer one", () => {
  const verdict = answerContains("The Poetry category was added in 2019.", ["19"]);
  assert.equal(verdict.pass, false);
  assert.deepEqual(verdict.missing, ["19"]);
  const partial = answerContains("I found It's Only the Himalayas for you.", ["It's Only the Himalayas", "45.17"]);
  assert.equal(partial.pass, false);
  assert.deepEqual(partial.missing, ["45.17"]);
});

test("a no-result reply is judged by pattern, in any wording the patterns allow", () => {
  const patterns = ["no (products|results|items)", "(0|zero) (products|results)", "couldn't find|could not find"];
  assert.equal(answerMatches("Sorry — I couldn't find a unicorn lamp in this shop.", patterns).pass, true);
  assert.equal(answerMatches("There are 0 results for unicorn lamp.", patterns).pass, true);
  assert.equal(answerMatches("Here are 3 lamps you might like.", patterns).pass, false);
});

test("an action is judged by the site's state, not by the assistant's claim", () => {
  const probe = { url: "/en/cart?action=show", contains: ["Brown bear cushion"], count: { selector: ".cart-item", equals: 1 } };
  const emptyCart = { text: "Your cart is empty. There are no more items in your cart", counts: { ".cart-item": 0 }, values: {} };
  const verdict = siteStateHolds(emptyCart, probe);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.reasons.length, 2, verdict.reasons.join("; "));
  const filled = { text: "Shopping Cart\nBrown bear cushion\n$18.90\nTotal $18.90", counts: { ".cart-item": 1 }, values: {} };
  assert.deepEqual(siteStateHolds(filled, probe), { pass: true, reasons: [] });
  const quantity = { ...probe, value: { selector: "input.js-cart-line-product-quantity", attribute: "value", equals: "2" } };
  assert.equal(siteStateHolds({ ...filled, values: { "input.js-cart-line-product-quantity": "1" } }, quantity).pass, false);
  assert.equal(siteStateHolds({ ...filled, values: { "input.js-cart-line-product-quantity": "2" } }, quantity).pass, true);
});

test("normalisation folds width, case and punctuation but keeps decimals", () => {
  assert.equal(normalizeText("  Ｓauce Labs Onesie — $7.99! "), "sauce labs onesie 7.99");
  assert.equal(normalizeText("Done."), "done");
});
