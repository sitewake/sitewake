import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../runner/capability-v2/failure-diagnostics.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const diagnostics = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("exploration failures retain their cause instead of becoming generic page changes", () => {
  for (const [reason, code] of [
    ["repeated_click_without_page_progress", "exploration_no_progress"],
    ["external_link_outside_exploration_scope", "exploration_target_outside_site"],
    ["popup_transition_requires_page_handoff", "exploration_popup_transition"],
  ]) {
    const result = diagnostics.diagnoseRunnerFailure(`capability_exploration_failed:${reason}`);
    assert.equal(result.code, code);
    assert.equal(result.retryable, false);
  }
});

test("reports a website security challenge instead of page_changed", () => {
  const result = diagnostics.diagnoseRunnerFailure("exploration_element_invalid", {
    url: "https://www.example.test/security/challenge?next=%2F",
    title: "安全验证 | 示例网站",
    heading: "安全验证",
    text: "请完成安全验证，拖动滑块还原图片",
  });
  assert.equal(result.code, "site_access_challenge");
  assert.equal(result.retryable, false);
  assert.match(result.message, /尚未进入业务页面/);
  assert.match(result.message, /访问白名单/);
});

test("reports a 403 access restriction from document labels", () => {
  const result = diagnostics.diagnoseBlockedPage({
    url: "https://www.example.test/",
    title: "访问受限 - 示例网站",
    heading: "403 访问受限",
    text: "你的访问被系统拦截",
  });
  assert.equal(result?.code, "site_access_challenge");
});

test("does not mistake an ordinary help article for a live challenge", () => {
  const result = diagnostics.diagnoseBlockedPage({
    url: "https://www.example.test/help/http-errors",
    title: "HTTP 错误帮助",
    heading: "如何解决网站错误",
    text: "本文介绍 403、验证码与访问受限问题。",
  });
  assert.equal(result, undefined);
});

test("does not classify a normal business verification route by URL alone", () => {
  const result = diagnostics.diagnoseBlockedPage({
    url: "https://www.example.test/account/verify",
    title: "验证邮箱",
    heading: "请输入邮件中的确认代码",
    text: "完成邮箱验证后保存账户设置。",
  });
  assert.equal(result, undefined);
});

test("translates low-level element errors into an actionable page diagnostic", () => {
  const result = diagnostics.diagnoseRunnerFailure("exploration_element_invalid", {
    url: "https://www.example.test/search",
    title: "搜索",
    heading: "商品搜索",
    text: "搜索商品",
  });
  assert.equal(result.code, "page_changed");
  assert.match(result.message, /找不到预期的页面元素/);
  assert.equal(result.retryable, true);
});

test("preserves target ambiguity as a distinct non-retryable root cause", () => {
  const result = diagnostics.diagnoseRunnerFailure("target_ambiguous:step_1", {
    url: "https://www.example.test/products",
    title: "Products",
    heading: "Products",
    text: "View details View details",
  });
  assert.equal(result.code, "target_ambiguous");
  assert.equal(result.retryable, false);
  assert.match(result.message, /多个符合条件/);
});

test("classifies a browser dynamic-import failure as module_load_failed with actionable configuration guidance", () => {
  const cause = new Error("page.evaluate: TypeError: Failed to fetch dynamically imported module: http://control-plane:3000/api/capability-v2/modules/abc");
  const error = Object.assign(new Error(`module_load_failed:${cause.message}`, { cause }), { code: "module_load_failed" });
  const result = diagnostics.diagnoseRunnerFailure(error, {
    url: "https://www.example.org/",
    title: "微博热搜",
    heading: "实时热点",
    text: "热点列表",
  });
  assert.equal(result.code, "module_load_failed");
  assert.equal(result.retryable, true);
  assert.match(result.message, /CAPABILITY_V2_BROWSER_PUBLIC_URL/);
  assert.match(result.message, /HTTPS/);
  assert.equal(result.cause.code, "runner_root_cause");
  assert.match(result.cause.message, /Failed to fetch dynamically imported module/);
  assert.doesNotMatch(result.message, /control-plane:3000/);
});

test("maps an invalid browser-public base to module_load_failed instead of model_protocol_error", () => {
  const error = Object.assign(new Error("browser_module_url_invalid:https_page_requires_https_module"), {
    code: "browser_module_url_invalid",
  });
  const result = diagnostics.diagnoseRunnerFailure(error);
  assert.equal(result.code, "module_load_failed");
  assert.notEqual(result.code, "model_protocol_error");
  assert.match(result.message, /CAPABILITY_V2_BROWSER_PUBLIC_URL/);
});

test("authoring budget exhaustion retains its last repairable root cause", () => {
  const cause = new Error("capability_stage_result_invalid:stage_verify");
  const error = Object.assign(new Error(`javascript_author_tool_budget_exhausted:${cause.message}`, { cause }), {
    code: "javascript_author_tool_budget_exhausted",
  });
  const result = diagnostics.diagnoseRunnerFailure(error);
  assert.equal(result.code, "authoring_budget_exhausted");
  assert.notEqual(result.code, "model_protocol_error");
  assert.equal(result.cause.code, "capability_stage_result_invalid");
  assert.equal(result.cause.message, "capability_stage_result_invalid:stage_verify");
  assert.doesNotMatch(result.message, /capability_stage_result_invalid:stage_verify/);
});

test("a structured authoring budget error wins over dynamic-import-like text in a repairable root cause", () => {
  const cause = new Error("target application said: Failed to fetch dynamically imported module");
  const error = Object.assign(new Error(`javascript_author_tool_budget_exhausted:${cause.message}`, { cause }), {
    code: "javascript_author_tool_budget_exhausted",
  });
  const result = diagnostics.diagnoseRunnerFailure(error);
  assert.equal(result.code, "authoring_budget_exhausted");
  assert.notEqual(result.code, "module_load_failed");
  assert.equal(result.cause.message, cause.message);
});

test("true Function Calling protocol failures remain model_protocol_error", () => {
  const result = diagnostics.diagnoseRunnerFailure("tool_call_required");
  assert.equal(result.code, "model_protocol_error");
});

test("an expired or invalid site certificate is named as such, not as a generic runner failure", () => {
  // Production: the visitor's demonstration entered the capability center, and the
  // run failed only because the site's own TLS certificate had expired that night.
  const result = diagnostics.diagnoseRunnerFailure(new Error('page.goto: net::ERR_CERT_DATE_INVALID at https://www.example.org/\nCall log:\n  - navigating to "https://www.example.org/", waiting until "domcontentloaded"'));
  assert.equal(result.code, "site_certificate_invalid");
  assert.equal(result.retryable, true);
  assert.match(result.message, /www\.example\.org/);
  assert.match(result.message, /证书/);
});
