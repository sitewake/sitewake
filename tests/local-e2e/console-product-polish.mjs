import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const origin = "http://localhost:3000";
const output = new URL("../../.artifacts/product-polish/", import.meta.url).pathname;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let writes = 0;
  let rejectSave = true;
  await page.route("**/api/site-agents/shop", async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++;
    await route.fulfill({ status: rejectSave ? 503 : 200, json: {} });
  });
  await page.goto(`${origin}/?site=shop&view=agent`);
  const name = page.getByRole("textbox", { name: "名称", exact: true });
  await name.waitFor();
  await page.screenshot({ path: `${output}agent-desktop.png`, fullPage: true });
  const original = await name.inputValue();
  assert.equal(await page.locator(".sw-chat-preview img").count(), 1, "one identity mark in the open preview");
  await name.fill("Nimbus 专属助手");
  await page.locator(".sw-chat-preview header b").filter({ hasText: "Nimbus 专属助手" }).waitFor();
  await page.getByRole("button", { name: "收起窗口", exact: true }).click();
  assert.equal(await page.locator(".sw-chat-preview").count(), 0);
  await page.getByRole("button", { name: "展开窗口", exact: true }).click();
  await page.getByRole("button", { name: "手机", exact: true }).click();
  assert.equal(writes, 0, "preview interactions must never save configuration");
  await page.getByRole("tab", { name: "用户会话", exact: true }).click();
  await page.getByRole("tab", { name: "智能体", exact: true }).click();
  assert.equal(await name.inputValue(), "Nimbus 专属助手", "unsaved draft survives navigation");
  await page.getByRole("button", { name: "保存并应用", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "保存失败" }).waitFor();
  assert.equal(await name.inputValue(), "Nimbus 专属助手", "failure preserves edits");
  rejectSave = false;
  await page.getByRole("button", { name: "保存并应用", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "已应用到网站" }).waitFor();
  assert.equal(writes, 2);
  assert.equal(await page.getByRole("button", { name: "保存并应用", exact: true }).isDisabled(), true);
  await page.getByRole("button", { name: "恢复默认", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "恢复默认", exact: true }).click();
  assert.equal(writes, 2, "restoring defaults only edits the draft");
  await name.fill(original);
  await page.evaluate(() => sessionStorage.clear());
  await page.goto(`${origin}/?site=shop&view=connection`);
  await page.getByRole("heading", { name: "网站信息", exact: true }).waitFor();
  await page.screenshot({ path: `${output}settings-desktop.png`, fullPage: true });
  await page.locator("summary").filter({ hasText: "接入代码" }).click();
  assert.match(await page.locator(".sw-setting-disclosure pre").innerText(), /data-site-agent="shop"/);
  await page.reload();
  await page.getByRole("heading", { name: "网站信息", exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("view"), "connection");
  await page.goto(`${origin}/?site=shop`);
  await page.locator(".sw-preview-panel").waitFor();
  await page.screenshot({ path: `${output}overview-desktop.png`, fullPage: true });
  await page.goto(`${origin}/?site=shop&view=sessions`);
  await page.locator(".sw-session-reader").waitFor();
  await page.screenshot({ path: `${output}sessions-empty-desktop.png`, fullPage: true });

  // Synthetic conversations exercise layout and reading states; never stored in the app.
  const fact = id => ({ runId: id, goal: "帮我选一款适合阅读的台灯", status: "completed", outcomeStatus: "success", outcomeSummary: "已找到两款可选台灯，并比较了亮度调节和价格。", startedAt: "2026-09-05T06:20:00Z", endedAt: "2026-09-05T06:20:18Z", durationMs: 18000, startUrl: "https://example.com/products", endUrl: "https://example.com/products/reading-light" });
  await page.route("**/session-history?*", route => route.fulfill({ json: { records: [fact("sample-task")], total: 1 } }));
  await page.route("**/session-history/*", route => route.fulfill({ json: { detail: { fact: fact("sample-task"), conversation: [{ role: "user", at: "2026-09-05T06:20:00Z", content: "想给书桌买一盏台灯，晚上看书用，预算在 300 元以内。" }, { role: "assistant", at: "2026-09-05T06:20:10Z", content: "找到两款符合预算的台灯。\n\nHalo 护眼台灯支持无级调光，适合长时间阅读；另一款体积更小，适合桌面空间有限的情况。" }, { role: "user", at: "2026-09-05T06:20:12Z", content: "帮我打开 Halo 看看。" }, { role: "assistant", at: "2026-09-05T06:20:18Z", content: "已打开 Halo 护眼台灯的详情页，你可以继续查看参数和配送信息。" }], activityTimeline: [{ id: "step-1", label: "查找阅读台灯", detail: "按预算筛选并比较产品信息。", state: "completed", createdAt: "2026-09-05T06:20:06Z", url: "https://example.com/products" }], replayChunks: [] } } }));
  await page.reload();
  await page.locator(".sw-session-conversation .assistant").first().waitFor();
  await page.screenshot({ path: `${output}sessions-sample-desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "操作过程", exact: true }).click();
  await page.getByText("查找阅读台灯", { exact: true }).waitFor();
  await page.goto(`${origin}/?site=shop&view=sessions&run=outside-list`);
  await page.locator(".sw-session-conversation").waitFor();
  assert.equal(await page.locator(".sw-session-detail h2").innerText(), "帮我选一款适合阅读的台灯");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "返回记录", exact: false }).click();
  await page.locator(".sw-session-list > button").first().click();
  await page.locator(".sw-session-conversation").waitFor({ state: "visible" });
  await page.screenshot({ path: `${output}sessions-sample-mobile.png`, fullPage: true });
  for (const view of ["overview", "agent", "sessions", "settings"]) {
    await page.goto(`${origin}/?site=shop&view=${view}`);
    await page.locator(".sw-topbar h1").waitFor();
    const ready = { overview: ".sw-preview-panel", agent: ".sw-studio-editor", sessions: ".sw-session-reader", settings: ".sw-system-settings" }[view];
    await page.locator(ready).waitFor();
    await page.getByRole("button", { name: "打开导航", exact: true }).click();
    for (const label of view === "settings" ? [] : ["概览", "智能体", "用户会话", "能力", "知识"]) {
      assert.equal(await page.getByRole("tab", { name: label, exact: true }).locator("span").isVisible(), true, `${label} remains visible on a phone`);
    }
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".sw-console-sidebar").isVisible(), false, "drawer returns the full width to content");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${view} fits a phone`);
    await page.screenshot({ path: `${output}${view}-mobile.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log("PASS: preview isolation, navigation draft recovery, save failure/retry, deliberate reset, settings routing, session evidence, direct record links and four mobile layouts.");
} finally { await browser.close(); }
