import assert from "node:assert/strict";
import test from "node:test";

import {
  recordedExplorerAction,
  recordedPageMove,
  scopeWithRouteMatch,
} from "../runner/capability-v2/browser-runtime.ts";

// A capability is generated because an agent completed the task once, and that
// run is recorded. The exploration used to ignore it and ask a model to find
// the same path again, one turn per step, on a site whose route was already
// known. These are the three facts the recording supplies.

const DAY_PAGE = {
  url: "https://hotsearch.example/daily/2026-09-20",
  title: "2026年09月20日微博热搜榜_全天热点与热度峰值 | 热搜时光机",
  heading: "2026年09月20日微博热搜榜",
};

function snapshot(url, elements = []) {
  return { url, elements };
}

test("the address a step happened at is what a scroll-only recording teaches", () => {
  // 给我查看2026年9月20日热搜, as the agent actually ran it: it never touched a
  // date control, because the site addresses a day directly. Its one recorded
  // action is a scroll, and everything useful about the run is the page it
  // happened on. The exploration started at the site root and spent its whole
  // budget hunting for a path the agent had never walked.
  const scrolled = { action: "scroll", rawAction: "scroll", input: { down: true }, page: DAY_PAGE, observedAt: "" };
  assert.deepEqual(
    recordedPageMove(scrolled, "https://hotsearch.example/", "https://hotsearch.example"),
    { action: "navigate", url: DAY_PAGE.url },
  );

  // Standing there already, there is nothing to do.
  assert.equal(recordedPageMove(scrolled, DAY_PAGE.url, "https://hotsearch.example"), undefined);
  assert.equal(
    recordedPageMove(scrolled, "https://hotsearch.example/daily/2026-09-20#top", "https://hotsearch.example"),
    undefined,
    "a fragment is the same page",
  );

  // Another origin is never navigated to from an exploration.
  assert.equal(recordedPageMove(scrolled, "https://hotsearch.example/", "https://example.test"), undefined);
});

test("a recorded click is placed on the page by what the recording saw", () => {
  const page = snapshot("https://hotsearch.example/", [
    { index: 1, tag: "a", role: "link", name: "首页" },
    { index: 2, tag: "a", role: "link", name: "热搜时光机", href: "/daily/2026-09-20" },
    { index: 3, tag: "button", role: "button", name: "查看当日榜单" },
  ]);
  const clicked = {
    action: "click",
    rawAction: "click",
    input: {},
    element: { role: "button", accessibleName: "查看当日榜单" },
    page: { url: "https://hotsearch.example/" },
    observedAt: "",
  };
  assert.deepEqual(recordedExplorerAction(clicked, page, { parameters: {} }), { action: "click", index: 3 });

  // The address the recording captured identifies the element even when the
  // page renames it.
  const byHref = {
    action: "click",
    rawAction: "click",
    input: {},
    element: { role: "link", accessibleName: "另一个名字", href: "https://hotsearch.example/daily/2026-09-20" },
    page: { url: "https://hotsearch.example/" },
    observedAt: "",
  };
  assert.deepEqual(recordedExplorerAction(byHref, page, { parameters: {} }), { action: "click", index: 2 });

  // A step this page cannot place is not insisted upon; the caller asks the
  // model for that one step instead.
  const absent = { ...clicked, element: { role: "button", accessibleName: "结算" } };
  assert.equal(recordedExplorerAction(absent, page, { parameters: {} }), undefined);
});

test("what was typed becomes the input it demonstrates, or the literal it was", () => {
  const page = snapshot("https://hotsearch.example/", [
    { index: 1, tag: "input", role: "textbox", name: "搜索热搜", placeholder: "输入关键词" },
  ]);
  const typed = {
    action: "fill",
    rawAction: "set-text",
    input: { text: "周深" },
    element: { role: "textbox", accessibleName: "搜索热搜" },
    page: { url: "https://hotsearch.example/" },
    observedAt: "",
  };
  assert.deepEqual(
    recordedExplorerAction(typed, page, { parameters: { keyword: "周深" } }),
    { action: "fill", index: 1, inputPath: "keyword" },
  );
  assert.deepEqual(
    recordedExplorerAction(typed, page, { parameters: { rank: 3 } }),
    { action: "fill", index: 1, value: "周深" },
  );
});

test("where a capability may be called is not where it ends up", () => {
  // Its input is part of the address, so it opens that address itself and can
  // be called from anywhere on the site. Pinned to the route it ended on, it
  // was unreachable: asked from the home page, 查看某一天的微博热搜榜单 was
  // answered by the page agent in 172 seconds instead of by the capability in
  // four, because the home page is not /daily/*.
  assert.deepEqual(
    scopeWithRouteMatch(
      { kind: "page-scoped", onMismatch: "no-match" },
      "https://hotsearch.example/daily/2026-09-20",
      { date: "2026-09-20" },
    ),
    { kind: "site-global", onMismatch: "no-match" },
  );

  // Where no address carries the input, the capability does have to be on that
  // page, and it says which page rather than being refused for not saying it.
  assert.deepEqual(
    scopeWithRouteMatch({ kind: "page-scoped", onMismatch: "no-match" }, "https://hotsearch.example/daily/2026-09-20", {}),
    { kind: "page-scoped", onMismatch: "no-match", match: { urlPatterns: ["/daily/2026-09-20"] } },
  );

  // The model can also pin the scope to the one address its demonstration
  // ended on. 查看人物微博热搜记录 came back scoped to 周杰伦's own page and
  // answered nobody asking about anyone — including about 周杰伦 — from
  // anywhere else. What the run's own values reached says otherwise whether
  // or not the model declared an address writing.
  assert.deepEqual(
    scopeWithRouteMatch(
      { kind: "page-scoped", onMismatch: "no-match", match: { urlPatterns: ["https://hotsearch.example/celebrity/%E5%91%A8%E6%9D%B0%E4%BC%A6"] } },
      "https://hotsearch.example/celebrity/%E5%91%A8%E6%9D%B0%E4%BC%A6",
      {},
      { celebrityName: "周杰伦" },
    ),
    { kind: "site-global", onMismatch: "no-match" },
  );

  // A scope that already says which pages it serves is left alone, and so is
  // one that is not page-scoped.
  const declared = { kind: "page-scoped", onMismatch: "no-match", match: { urlPatterns: ["/archive/*"] } };
  assert.equal(scopeWithRouteMatch(declared, "https://hotsearch.example/daily/2026-09-20", {}), declared);
  const global = { kind: "site-global", onMismatch: "no-match" };
  assert.equal(scopeWithRouteMatch(global, "https://hotsearch.example/daily/2026-09-20", {}), global);
});
