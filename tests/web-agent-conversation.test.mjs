import assert from "node:assert/strict";
import test from "node:test";
import { activitiesForTurn, activitySummaryState, mergeResumedConversation } from "../client/user-agent-conversation.ts";
const message = (id, kind, text, taskId) => ({ id, kind, text, taskId });
const activity = (id, sessionId, state = "completed", kind = "knowledge") => ({ id, sessionId, state, kind, label: id, createdAt: "2026-09-06T00:00:00Z" });

test("a resumed suffix preserves earlier chat, message identities and run ownership", () => {
  const local = [message("a", "user", "你好", "old"), message("b", "assistant", "你好"), message("c", "user", "点开第 4 个热搜")];
  const server = [message("s1", "assistant", "你好"), message("s2", "user", "点开第 4 个热搜", "current")];
  const merged = mergeResumedConversation(local, server);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].taskId, "old");
  assert.equal(merged[2].id, "c");
  assert.equal(merged[2].taskId, "current");
  assert.deepEqual(mergeResumedConversation(merged, server), merged, "restoration is idempotent");
});

test("an older server snapshot cannot erase a later local answer", () => {
  const local = [message("a", "user", "第四个", "run"), message("b", "assistant", "已经打开")];
  assert.deepEqual(mergeResumedConversation(local, [message("s", "user", "第四个", "run")]), local);
});

test("each turn gets its own activities; failures are not labelled successful", () => {
  const items = [activity("a", "old"), activity("b", "new", "failed"), activity("c", "new", "completed", "reasoning")];
  assert.deepEqual(activitiesForTurn(items, "old").map(x => x.id), ["a"]);
  const current = activitiesForTurn(items, "new");
  assert.deepEqual(current.map(x => x.id), ["b"]);
  assert.equal(activitySummaryState(current), "failed");
  assert.deepEqual(activitiesForTurn(items), [], "unattributed receipts are not borrowed by the latest turn");
});

test("different document visits to the same URL retain separate receipts", () => {
  const visits = [1, 1, 2].map((pageEpoch, i) => ({ ...activity(String(i), "run", "completed", "transition"), pageEpoch, url: "https://example.com/" }));
  assert.equal(activitiesForTurn(visits, "run").length, 2);
});

test("repeating the same question in a new run does not reuse the old user turn", () => {
  const local = [message("old-u", "user", "点开第4个", "old"), message("old-a", "assistant", "已打开", "old")];
  const incoming = [message("new-u", "user", "点开第4个", "new")];
  const result = mergeResumedConversation(local, incoming);
  assert.equal(result.length, 3);
  assert.equal(result[0].taskId, "old");
  assert.equal(result[2].taskId, "new");
});
