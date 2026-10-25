import assert from "node:assert/strict";
import test from "node:test";
import { countsIgnoringTheirList } from "../lib/capability-center-v2/output-consistency.ts";

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
