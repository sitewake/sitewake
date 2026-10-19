/**
 * The widget's language is the **visitor's**, not the operator's.
 *
 * None of the console's scheme (cookie + Accept-Language + SSR into `<html lang>`)
 * applies here: the widget is injected into the customer's site, cannot read cookies
 * on our domain, and the `<html lang>` it sees is the customer's. So it follows the
 * visitor — their stored choice first, then what the browser asks for.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../client/user-agent-copy.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
});
const widget = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

/** Throwaway localStorage / navigator stand-ins. */
function withEnvironment({ saved, languages }, run) {
  const store = new Map(saved === undefined ? [] : [[widget.WIDGET_LOCALE_KEY, saved]]);
  const originalStorage = globalThis.localStorage;
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: languages === undefined ? undefined : { languages, language: languages[0] },
    configurable: true, writable: true,
  });
  try {
    return run(store);
  } finally {
    Object.defineProperty(globalThis, "localStorage", { value: originalStorage, configurable: true, writable: true });
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true, writable: true });
  }
}

test("没有任何线索时用英文", () => {
  withEnvironment({ languages: [] }, () => {
    assert.equal(widget.resolveWidgetLocale(), "en");
  });
});

test("跟随访客的浏览器，认得的第一个语言胜出", () => {
  withEnvironment({ languages: ["en-US", "en"] }, () => assert.equal(widget.resolveWidgetLocale(), "en"));
  withEnvironment({ languages: ["zh-CN", "zh"] }, () => assert.equal(widget.resolveWidgetLocale(), "zh"));
  // Read navigator.languages, not navigator.language: when the first language is
  // unsupported, the visitor's second one should still be used.
  withEnvironment({ languages: ["ja", "ko", "en"] }, () =>
    assert.equal(widget.resolveWidgetLocale(), "en", "日韩都不支持，但列表里还有英语"));
  withEnvironment({ languages: ["ja", "ko"] }, () =>
    assert.equal(widget.resolveWidgetLocale(), "en", "一个都不认识才退回英文"));
});

test("访客存下来的选择压过浏览器", () => {
  withEnvironment({ saved: "en", languages: ["zh-CN"] }, () =>
    assert.equal(widget.resolveWidgetLocale(), "en", "在中文浏览器上主动选了英文，就该一直是英文"));
  withEnvironment({ saved: "zh", languages: ["en-US"] }, () =>
    assert.equal(widget.resolveWidgetLocale(), "zh"));
});

test("存下来的垃圾值不作数，回落到浏览器", () => {
  for (const junk of ["", "fr", "zh-CN", "null", "<script>"]) {
    withEnvironment({ saved: junk, languages: ["en-US"] }, () =>
      assert.equal(widget.resolveWidgetLocale(), "en", `${JSON.stringify(junk)} 不是合法语言`));
  }
});

test("localStorage 用不了也不能炸——无痕模式、被禁用、沙箱 iframe 都会这样", () => {
  const originalStorage = globalThis.localStorage;
  const originalNavigator = globalThis.navigator;
  Object.defineProperty(globalThis, "localStorage", {
    get() { throw new Error("SecurityError"); },
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", { value: { languages: ["en"] }, configurable: true, writable: true });
  try {
    assert.equal(widget.resolveWidgetLocale(), "en", "读不了存储就该跟着浏览器走，而不是抛异常");
    assert.doesNotThrow(() => widget.saveWidgetLocale("zh"), "存不进去也只是存不进去，不该让挂件挂掉");
  } finally {
    Object.defineProperty(globalThis, "localStorage", { value: originalStorage, configurable: true, writable: true });
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true, writable: true });
  }
});

test("两份词表结构一致——缺键会让挂件在某个语言下露出空白", () => {
  const walk = (value, path = "") => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value).flatMap(([key, child]) => walk(child, path ? `${path}.${key}` : key));
    }
    return [path];
  };
  const zhKeys = new Set(walk(widget.widgetZh));
  const enKeys = new Set(walk(widget.widgetEn));
  assert.deepEqual([...zhKeys].filter((key) => !enKeys.has(key)), [], "英文词表缺了这些键");
  assert.deepEqual([...enKeys].filter((key) => !zhKeys.has(key)), [], "中文词表缺了这些键");
});

test("英文词表里不该有中文", () => {
  const chinese = JSON.stringify(widget.widgetEn, (_key, value) =>
    typeof value === "function" ? value(1, 2) : value).match(/[一-鿿]+/g);
  assert.equal(chinese, null, `英文词表里混进了中文：${(chinese || []).slice(0, 5).join(" ")}`);
});

// --- Three-layer precedence -----------------------------------------------
// The easiest thing to get backwards and the hardest to notice: with the wrong
// precedence the UI still renders, and only switching language or site reveals it.
// Hence its own tests.

const config = {
  generatedLocale: "zh",
  brand: { displayName: "微博榜单助手", launcherLabel: "打开 微博榜单助手" },
  copy: {
    welcomeTitle: "想在微博榜单完成什么？",
    welcomeDescription: "我已经理解这个网站的核心业务：看实时热搜榜。",
    composerPlaceholder: "告诉 SiteWake 你想完成什么",
    poweredByText: "由 SiteWake 提供",
  },
};

test("语言对得上时，用服务端生成的那份——它带站点信息，比通用句子有用", () => {
  const chrome = widget.resolveChromeCopy(config, "zh");
  assert.equal(chrome.welcomeTitle, "想在微博榜单完成什么？",
    "中文访客不该因为多语言改造，从个性化欢迎语退回通用句——那是倒退");
  assert.equal(chrome.displayName, "微博榜单助手");
  assert.equal(chrome.launcherLabel, "打开 微博榜单助手");
});

test("语言对不上时回落到词表——通用，但至少是访客读得懂的语言", () => {
  const chrome = widget.resolveChromeCopy(config, "en");
  assert.equal(chrome.welcomeTitle, widget.widgetEn.empty.title);
  assert.equal(chrome.displayName, widget.widgetEn.panel.agentName);
  assert.equal(chrome.composerPlaceholder, widget.widgetEn.composer.placeholder);
  assert.ok(!/[一-鿿]/.test(Object.values(chrome).join(" ")),
    `英文访客不该看到中文外壳：${Object.values(chrome).join(" ")}`);
});

test("运营手打的覆盖一切——包括语言对不上的时候", () => {
  const branded = { ...config, overrides: { displayName: "小微", welcomeTitle: "小微能帮你做什么？" } };
  for (const locale of ["zh", "en"]) {
    const chrome = widget.resolveChromeCopy(branded, locale);
    assert.equal(chrome.displayName, "小微",
      `运营给助手起的名字是他们对自己网站的选择，不该被我们按访客语言改写（locale=${locale}）`);
    assert.equal(chrome.welcomeTitle, "小微能帮你做什么？");
  }
  // Fields not overridden still follow the first two layers
  assert.equal(widget.resolveChromeCopy(branded, "en").composerPlaceholder, widget.widgetEn.composer.placeholder);
});

test("空白的覆盖不算覆盖", () => {
  const blank = { ...config, overrides: { displayName: "   " } };
  assert.equal(widget.resolveChromeCopy(blank, "zh").displayName, "微博榜单助手",
    "只敲了几个空格不是一次有意的命名");
});

test("没写 generatedLocale 的旧配置按中文算——不能让老站点突然变英文", () => {
  const legacy = { ...config, generatedLocale: undefined };
  assert.equal(widget.resolveChromeCopy(legacy, "zh").welcomeTitle, "想在微博榜单完成什么？");
  assert.equal(widget.resolveChromeCopy(legacy, "en").welcomeTitle, widget.widgetEn.empty.title);
});

test("给模型的语言指令跟着访客走", () => {
  assert.match(widget.replyLanguageInstruction("en"), /English/);
  assert.match(widget.replyLanguageInstruction("zh"), /中文/);
});

test("换语言必须重放事件驱动的渲染", async () => {
  // The widget has two kinds of text. One is rewritten on every applyAgentConfig and
  // follows a language change naturally; the other is **written once when an event
  // arrives** — connection status, knowledge version, progress copy, input placeholder.
  // A language change does not re-fire the event; without an explicit replay it stays
  // in the old language and the UI ends up half and half.
  //
  // This tests structure, not render output: adding an event-driven render and
  // forgetting to replay it in applyLocale is this file's most likely repeat mistake,
  // and neither types nor the build can see it.
  const source = await readFile(
    fileURLToPath(new URL("../client/user-agent-client.ts", import.meta.url)), "utf8");
  const body = /function applyLocale\([\s\S]*?\n  \}\n/.exec(source);
  assert.ok(body, "找不到 applyLocale——它要么被改名了，要么换语言的入口变了");

  for (const [call, why] of [
    ["applyAgentConfig", "外壳文案与知识版本"],
    ["renderSuggestions", "建议任务"],
    ["renderMessages", "已有的对话消息"],
    ["setMode", "底栏提示与输入框占位符"],
    ["onStatus", "连接状态、进度文案、演示工作台"],
  ]) {
    assert.match(body[0], new RegExp(`\\b${call}\\b`),
      `applyLocale 没有重放 ${call}()，${why} 会停在换语言之前的那一种`);
  }
});

test("知识版本不能写成「没值才填」", async () => {
  // Used to be `if (!version.textContent) version.textContent = …`, which only ran the
  // first time, so "knowledge v2" stayed in Chinese after a language change. This is
  // exactly what a user reported.
  const source = await readFile(
    fileURLToPath(new URL("../client/user-agent-client.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /if \(!version\.textContent\)/,
    "版本号必须每次按当前 release 重算，不能只在为空时填一次");
});

// --- Capability names -----------------------------------------------------
// Not "adding i18n": the capability center always stored bilingual names, the release
// projection dropped them, and the widget could only show name — which the proposal
// path sets to the English name, so Chinese visitors saw English capability names.
// These tests are about "do not throw away data that already exists".

test("能力名按访客语言挑", () => {
  const capability = { name: "Check Trending List", localizedNames: { zhCN: "查看热搜榜", en: "Check trending list" } };
  assert.equal(widget.localizedCapabilityName(capability, "zh"), "查看热搜榜",
    "中文访客不该看到英文能力名——中文名一直在库里");
  assert.equal(widget.localizedCapabilityName(capability, "en"), "Check trending list");
});

test("没有双语名的老 release 回落到 name", () => {
  const legacy = { name: "查看热搜榜" };
  assert.equal(widget.localizedCapabilityName(legacy, "zh"), "查看热搜榜");
  assert.equal(widget.localizedCapabilityName(legacy, "en"), "查看热搜榜",
    "老数据没有英文名时显示原名，总好过显示空白");
});

test("只填了一半的双语名，另一半回落", () => {
  const half = { name: "Check Trending List", localizedNames: { zhCN: "查看热搜榜" } };
  assert.equal(widget.localizedCapabilityName(half, "en"), "Check Trending List");
  const blank = { name: "Check Trending List", localizedNames: { zhCN: "   ", en: "" } };
  assert.equal(widget.localizedCapabilityName(blank, "zh"), "Check Trending List",
    "空白不算一个名字");
});

test("只改显示位，匹配和发给后端的值都不许动", async () => {
  // A capability name is used in two places that must not follow the language:
  // matching user input against capabilities (in the shared planner, not here)
  // and the goal sent to the backend. The widget itself sends what the visitor
  // typed, verbatim, and localizes a name only where it is displayed.
  const source = await readFile(
    fileURLToPath(new URL("../client/user-agent-client.ts", import.meta.url)), "utf8");
  assert.match(source, /await activePort\.run\(value, \{\}, conversation\)/,
    "输入框里的话必须原样发给 Agent");
  assert.match(source, /const goal = originalGoal \|\| localizedCapabilityName\(capability, locale\)/,
    "本地化的名字只用于显示");
  const matching = source.split("\n").filter((text) =>
    /\.find\(|\.some\(|\.filter\(/.test(text) && /capability\.name/.test(text));
  for (const text of matching) {
    assert.doesNotMatch(text, /localizedCapabilityName/,
      `匹配不能用本地化后的名字：${text.trim().slice(0, 80)}`);
  }
});

test("答复语言跟随网站自己的语言，访客自己选过的优先", () => {
  // A Chinese browser on an English store was answered in Chinese about English
  // products: the reply followed the browser, and nothing consulted the site.
  withEnvironment({ languages: ["zh-CN", "zh"] }, () => {
    assert.equal(widget.resolveReplyLocale("en"), "en", "英文站点的答复用英文，即使浏览器是中文");
    assert.equal(widget.resolveReplyLocale("zh"), "zh", "中文站点不变");
    assert.equal(widget.resolveReplyLocale(undefined), "zh", "站点语言未知时才退回浏览器");
  });
  withEnvironment({ languages: ["ja"] }, () => {
    assert.equal(widget.resolveReplyLocale(undefined), "en", "都不认识时退回英文");
  });
});
