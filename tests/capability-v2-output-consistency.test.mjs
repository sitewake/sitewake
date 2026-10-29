import assert from "node:assert/strict";
import test from "node:test";
import { countsIgnoringTheirList, demonstrationAnswerDisagreement, describeAnswerDisagreement } from "../lib/capability-center-v2/output-consistency.ts";

const items = (count) => Array.from({ length: count }, (_, index) => ({ name: `Lamp ${index + 1}` }));

test("a count that stays put while its list changes is not counting the result", () => {
  // "Showing 4 of 16 lamps" read as 16 for every room.
  assert.deepEqual(
    countsIgnoringTheirList([{ items: items(4), totalCount: 16 }, { items: items(2), totalCount: 16 }, { items: items(5), totalCount: 16 }]),
    [{ count: "totalCount", list: "items", value: 16, lengths: [4, 2, 5] }],
  );
});

test("counts that follow their list, or cannot be compared with one, are left alone", () => {
  // A count of the matches beyond the first page changes with the input.
  assert.deepEqual(countsIgnoringTheirList([{ items: items(20), total: 135 }, { items: items(7), total: 7 }]), []);
  // A list of fixed length says nothing about a count beside it.
  assert.deepEqual(countsIgnoringTheirList([{ items: items(3), total: 16 }, { items: items(3), total: 16 }]), []);
  // A single run cannot show that anything stayed put.
  assert.deepEqual(countsIgnoringTheirList([{ items: items(4), total: 16 }]), []);
  // A page size that every full page fills is not a count of anything else.
  assert.deepEqual(countsIgnoringTheirList([{ items: items(20), pageSize: 20 }, { items: items(20), pageSize: 20 }]), []);
});

test("an output that states none of the numbers the answer leads with disagrees with the demonstration", () => {
  // "Count quotes by tag" was proven with twelve quotes and counted the two on its last page.
  const answer = "There are 12 quotes tagged 'humor' in total on Quotes to Scrape. Page 1 lists 10 quotes, and page 2 lists the remaining 2.";
  const finding = demonstrationAnswerDisagreement({ tag: "humor", quoteCount: 2, pageCount: 2, quotes: [{ text: "a" }, { text: "b" }] }, answer);
  assert.deepEqual(finding, {
    sentence: "There are 12 quotes tagged 'humor' in total on Quotes to Scrape",
    stated: ["12"],
    output: [
      { path: "quoteCount", value: "2" }, { path: "pageCount", value: "2" },
      { path: "quotes.length", value: "2" },
    ],
  });
  assert.match(describeAnswerDisagreement(finding, { tag: "humor" }), /which states 12; the draft's output for the same input states 2 \(quoteCount\), 2 \(pageCount\), 2 \(quotes\.length\), and none of them agree/);
});

test("one number the output states anywhere is agreement, and an answer that leads with no number says nothing", () => {
  // The quantity agrees; the cart total and the shipping fee the answer goes on to are not demanded.
  assert.equal(demonstrationAnswerDisagreement({ cartItemName: "Brown bear cushion", cartItemQuantity: 1 }, "Your cart now shows 1 item at $18.90, with a total of $25.90 including $7.00 shipping."), undefined);
  // A price written "£11.90" agrees with an answer that says 11.9, and a list of twelve agrees with "12".
  assert.equal(demonstrationAnswerDisagreement({ price: "£11.90" }, "The cheapest book in Travel costs £11.90 (In stock)."), undefined);
  assert.equal(demonstrationAnswerDisagreement({ quotes: Array.from({ length: 12 }, () => ({ text: "q" })) }, "There are 12 quotes tagged 'humor'."), undefined);
  // A thousands separator is not a disagreement.
  assert.equal(demonstrationAnswerDisagreement({ total: 1234 }, "Found 1,234 results in total."), undefined);
  // An answer that leads with no number, or no answer at all, is no verdict.
  assert.equal(demonstrationAnswerDisagreement({ quoteCount: 2 }, "The cushion has been added to your cart. It shows 1 item."), undefined);
  assert.equal(demonstrationAnswerDisagreement({ quoteCount: 2 }, undefined), undefined);
  // An output with no number at all, against an answer that leads with one, disagrees.
  assert.deepEqual(demonstrationAnswerDisagreement({ tag: "humor" }, "There are 12 quotes tagged 'humor'."), { sentence: "There are 12 quotes tagged 'humor'", stated: ["12"], output: [] });
});

test("a number the answer adds in parentheses is not what it found", () => {
  // "There are 12 quotes tagged 'humor' (10 on page 1, 2 on page 2)": a draft
  // that counted the last page answered 2, agreed with the breakdown, and was
  // published to answer every tag with one page's count.
  const answer = "There are 12 quotes tagged 'humor' on Quotes to Scrape (10 on page 1, 2 on page 2).";
  assert.ok(demonstrationAnswerDisagreement({ tag: "humor", quoteCount: 2, lastPageNumber: 2 }, answer), "the last page's count disagrees");
  assert.equal(demonstrationAnswerDisagreement({ tag: "humor", quoteCount: 12 }, answer), undefined);
});
