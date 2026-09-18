/**
 * Preflight issues are data (`code` + parameters); the words come from the
 * catalog at report time, in the reader's language. Commands stay commands.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { describeIssue, reportPreflight } from "../scripts/preflight.mjs";

const ISSUES = [
  { code: "node-too-old", current: "20.19.0", required: ">=22.13.0" },
  { code: "chromium-missing" },
  { code: "codex-missing" },
  { code: "model-missing" },
  { code: "port-busy", port: 3000, component: { key: "componentControlPlane" } },
  { code: "port-busy", port: 4001, component: { key: "componentDemoSite", args: ["shop", "Nimbus"] } },
];

test("a missing Playwright browser is described in English with the exact fix command", () => {
  const { title, fix } = describeIssue({ code: "chromium-missing" }, "en");
  assert.match(title, /^Playwright browser is not installed/);
  assert.equal(fix, "npx playwright install chromium");
});

test("the same issue in Chinese keeps the command verbatim", () => {
  const { title, fix } = describeIssue({ code: "chromium-missing" }, "zh");
  assert.match(title, /Playwright 浏览器内核未安装/);
  assert.equal(fix, "npx playwright install chromium");
});

test("parameters flow into the rendered title in both languages", () => {
  assert.equal(describeIssue(ISSUES[0], "en").title, "Node is too old: 20.19.0 installed, >=22.13.0 required");
  assert.equal(describeIssue(ISSUES[0], "zh").title, "Node 版本过低：当前 20.19.0，需要 >=22.13.0");
  assert.equal(describeIssue(ISSUES[4], "en").title, "Port 3000 is already in use — Console / Control Plane cannot start");
  assert.equal(describeIssue(ISSUES[5], "zh").title, "端口 4001 已被占用 — demo 站点 shop（Nimbus） 无法启动");
  assert.match(describeIssue(ISSUES[4], "zh").fix, /^lsof -nP -iTCP:3000 -sTCP:LISTEN/);
});

test("the report is fully in one language, numbered, and returns false when there are issues", () => {
  for (const [locale, header, fixLabel, footer] of [
    ["en", /^Preflight failed: 6 item\(s\)/, "Fix:", /run npm run dev again/],
    ["zh", /^启动前检查未通过，共 6 项/, "修复：", /重新执行 npm run dev/],
  ]) {
    const lines = [];
    const ok = reportPreflight(ISSUES, (line) => lines.push(line), locale);
    assert.equal(ok, false);
    const text = lines.join("\n");
    assert.match(text.trim(), header);
    assert.equal((text.match(new RegExp(`     ${fixLabel} `, "g")) || []).length, 6);
    assert.match(text, /  6\. /);
    assert.match(text, footer);
    if (locale === "en") assert.doesNotMatch(text, /[一-鿿]/);
  }
  assert.equal(reportPreflight([], () => { throw new Error("must not log"); }, "en"), true);
});

test("an unknown issue code is a programming error, not silent output", () => {
  assert.throws(() => describeIssue({ code: "made-up" }, "en"), /unknown preflight issue: made-up/);
});
