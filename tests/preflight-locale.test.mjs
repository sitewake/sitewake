/**
 * Preflight issues are data (`code` + parameters); the words come from the
 * catalog at report time, in the reader's language. Commands stay commands.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { describeIssue, missingSharedLibraries, reportPreflight } from "../scripts/preflight.mjs";

const ISSUES = [
  { code: "node-too-old", current: "20.19.0", required: ">=22.13.0" },
  { code: "chromium-missing" },
  { code: "codex-missing" },
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
  assert.equal(describeIssue(ISSUES[3], "en").title, "Port 3000 is already in use — Console / Control Plane cannot start");
  assert.equal(describeIssue(ISSUES[4], "zh").title, "端口 4001 已被占用 — demo 站点 shop（Nimbus） 无法启动");
  assert.match(describeIssue(ISSUES[3], "zh").fix, /^lsof -nP -iTCP:3000 -sTCP:LISTEN/);
});

test("the report is fully in one language, numbered, and returns false when there are issues", () => {
  for (const [locale, header, fixLabel, footer] of [
    ["en", /^Preflight failed: 5 item\(s\)/, "Fix:", /run npm run dev again/],
    ["zh", /^启动前检查未通过，共 5 项/, "修复：", /重新执行 npm run dev/],
  ]) {
    const lines = [];
    const ok = reportPreflight(ISSUES, (line) => lines.push(line), locale);
    assert.equal(ok, false);
    const text = lines.join("\n");
    assert.match(text.trim(), header);
    assert.equal((text.match(new RegExp(`     ${fixLabel} `, "g")) || []).length, 5);
    assert.match(text, /  5\. /);
    assert.match(text, footer);
    if (locale === "en") assert.doesNotMatch(text, /[一-鿿]/);
  }
  assert.equal(reportPreflight([], () => { throw new Error("must not log"); }, "en"), true);
});

test("an unknown issue code is a programming error, not silent output", () => {
  assert.throws(() => describeIssue({ code: "made-up" }, "en"), /unknown preflight issue: made-up/);
});

test("the model is not a preflight item: npm run dev starts without one and never mentions it", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../scripts/preflight.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /model-missing|MODEL_API_KEY|OPENAI_API_KEY|checkModel/);
  assert.throws(() => describeIssue({ code: "model-missing" }, "en"), /unknown preflight issue/);
});

test("a browser whose system libraries are missing is one preflight item with the libraries and the install-deps fix", () => {
  const ldd = () => ({ status: 1, stdout: [
    "\tlinux-vdso.so.1 (0x00007fff)",
    "\tlibglib-2.0.so.0 => not found",
    "\tlibnss3.so => not found",
    "\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)",
    "\tlibglib-2.0.so.0 => not found",
  ].join("\n") });
  assert.deepEqual(missingSharedLibraries("/x/chrome", ldd), ["libglib-2.0.so.0", "libnss3.so"]);
  assert.deepEqual(missingSharedLibraries("/x/chrome", () => ({ error: new Error("ENOENT") })), [], "no ldd: nothing to report");
  const en = describeIssue({ code: "chromium-deps-missing", libraries: ["libglib-2.0.so.0", "libnss3.so"] }, "en");
  assert.match(en.title, /system libraries are missing \(libglib-2\.0\.so\.0, libnss3\.so\)/);
  assert.match(en.fix, /^npx playwright install-deps chromium/);
  const zh = describeIssue({ code: "chromium-deps-missing", libraries: ["libglib-2.0.so.0"] }, "zh");
  assert.match(zh.title, /系统缺少共享库（libglib-2\.0\.so\.0）/);
  assert.match(zh.fix, /^npx playwright install-deps chromium/, "the command is the same in both languages; the comment is translated");
});
