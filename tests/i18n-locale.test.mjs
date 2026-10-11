/**
 * How the locale is decided.
 *
 * The console is server-rendered, so the locale must be fixed before the first byte —
 * which rules out localStorage (unreadable on the server). The decision is written to
 * `<html lang>` and the browser reads it back from the same attribute, so both sides
 * see one truth and there is no flash of Chinese SSR jumping to English after hydration.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile, rm } from "node:fs/promises";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../lib/i18n/index.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
});
const i18n = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("没有任何线索时用英文", () => {
  assert.equal(i18n.resolveServerLocale({}), "en");
  assert.equal(i18n.resolveServerLocale({ cookie: null, acceptLanguage: null }), "en");
});

test("跟随浏览器：认得的第一个语言胜出", () => {
  assert.equal(i18n.resolveServerLocale({ acceptLanguage: "en-US,en;q=0.9" }), "en");
  assert.equal(i18n.resolveServerLocale({ acceptLanguage: "zh-CN,zh;q=0.9" }), "zh");
  // Unsupported languages are skipped, not a reason to give up and fall back to the default
  assert.equal(i18n.resolveServerLocale({ acceptLanguage: "ja,ko;q=0.9,zh;q=0.8" }), "zh",
    "日语韩语都不支持，但列表里还有中文");
  assert.equal(i18n.resolveServerLocale({ acceptLanguage: "ja,ko" }), "en", "一个都不认识才退回英文");
});

test("q 权重决定顺序，不是书写顺序", () => {
  // Reading in written order gives Chinese, which is wrong: this person explicitly prefers English
  assert.equal(i18n.resolveServerLocale({ acceptLanguage: "zh;q=0.8, en;q=0.9" }), "en");
  assert.equal(i18n.resolveServerLocale({ acceptLanguage: "en;q=0.5, zh;q=0.9" }), "zh");
});

test("用户存下来的选择压过浏览器", () => {
  // Deliberately switched to English on a Chinese system: stays English
  assert.equal(i18n.resolveServerLocale({ cookie: "en", acceptLanguage: "zh-CN,zh;q=0.9" }), "en");
  assert.equal(i18n.resolveServerLocale({ cookie: "zh", acceptLanguage: "en-US" }), "zh");
});

test("cookie 里的垃圾值不作数，回落到浏览器", () => {
  for (const junk of ["", "  ", "fr", "zh-CN", "<script>", "null", "undefined"]) {
    assert.equal(i18n.resolveServerLocale({ cookie: junk, acceptLanguage: "en-US" }), "en",
      `cookie=${JSON.stringify(junk)} 不是合法语言，该跟浏览器走`);
  }
});

test("t() 不传参数时读 <html lang>，那是服务端写下的那一份", () => {
  const original = globalThis.document;
  try {
    globalThis.document = { documentElement: { lang: "en" } };
    assert.equal(i18n.t().common.save, i18n.en.common.save, "文档声明英文就给英文");
    globalThis.document = { documentElement: { lang: "zh-CN" } };
    assert.equal(i18n.t().common.save, i18n.zh.common.save, "带地区后缀也认");
    globalThis.document = { documentElement: { lang: "fr" } };
    assert.equal(i18n.t().common.save, i18n.zh.common.save, "认不出的语言回落中文");
  } finally {
    if (original === undefined) delete globalThis.document; else globalThis.document = original;
  }
});

test("服务端没有 document，t() 也不能炸", () => {
  const original = globalThis.document;
  try {
    delete globalThis.document;
    assert.equal(i18n.activeLocale(), "en");
    assert.ok(i18n.t().common, "服务端渲染时要拿到可用的词表");
  } finally {
    if (original !== undefined) globalThis.document = original;
  }
});

test("两份词表结构一致——缺键会让界面在某个语言下露出空白", () => {
  const walk = (value, path = "") => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value).flatMap(([key, child]) => walk(child, path ? `${path}.${key}` : key));
    }
    return [path];
  };
  const zhKeys = new Set(walk(i18n.zh));
  const enKeys = new Set(walk(i18n.en));
  assert.deepEqual([...zhKeys].filter((key) => !enKeys.has(key)), [], "英文词表缺了这些键");
  assert.deepEqual([...enKeys].filter((key) => !zhKeys.has(key)), [], "中文词表缺了这些键");
});

test("切换控件在两处 chrome 上各自渲染，且登录门那处不依赖登录", async (t) => {
  // The login gate is the first screen an unauthenticated visitor sees. It renders
  // instead of the console shell and cannot share the sidebar, so it needs its own
  // switcher — otherwise someone who cannot read the current language has no way in.
  const out = await build({
    stdin: {
      contents: `
        import { renderToStaticMarkup } from "react-dom/server";
        import { createElement } from "react";
        import { AccessGate } from "./components/access-gate";
        import { AccessManagePanel } from "./components/access-manage-panel";
        import { LocaleSwitcher } from "./components/locale-switcher";
        export const gate = (locale) => renderToStaticMarkup(createElement(AccessGate, { locale }));
        export const manage = (locale) => renderToStaticMarkup(createElement(AccessManagePanel, { locale }));
        export const rail = (locale) => renderToStaticMarkup(createElement(LocaleSwitcher, { locale, variant: "rail" }));`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      sourcefile: "i18n-surfaces.tsx", loader: "tsx",
    },
    // Leave react / react-dom to Node's resolver: they are CJS, and bundled into ESM
    // their internal require("util") breaks. Write the bundle to disk before importing
    // so relative resolution works.
    bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic",
    external: ["react", "react-dom", "react-dom/server"],
  });
  const artifact = fileURLToPath(new URL("../.i18n-surfaces.test.mjs", import.meta.url));
  await writeFile(artifact, out.outputFiles[0].text);
  t.after(() => rm(artifact, { force: true }));
  const surfaces = await import(pathToFileURL(artifact).href);

  // The trigger shows the **current** language, not the target. A two-state toggle is
  // ambiguous whichever side it labels: a button reading "English" on a Chinese page
  // could mean "you are in English" or "click to switch to English". A dropdown has no
  // such problem — the button says where you are, the list is the choice.
  for (const [locale, expected] of [["zh", "中文"], ["en", "English"]]) {
    const html = surfaces.gate(locale);
    assert.match(html, /class="sw-locale sw-locale-card"/, `登录门（${locale}）必须有切换控件`);
    assert.ok(html.includes(`<span>${expected}</span>`),
      `登录门（${locale}）的触发按钮该写当前语言，实际：${/<span>([^<]*)<\/span>/.exec(html)?.[1]}`);
    assert.match(html, /aria-haspopup="listbox"/, `登录门（${locale}）的切换控件应当是下拉，不是开关`);
    assert.match(html, /sw-auth-top/, "切换控件要与品牌同排，不是塞在表单里");
  }

  // The sidebar one is the same component in another variant, visually part of the nav rather than stuck on it
  assert.match(surfaces.rail("zh"), /class="sw-locale sw-locale-rail"/);

  // Was the extraction moved correctly: the guard only ensures "no Chinese literals in
  // the file", not "the right keys were used". Render for real; each language's key copy
  // must appear.
  const zh = surfaces.gate("zh");
  assert.ok(zh.includes("请输入访问密码") && zh.includes("访问密码"), "中文登录门该是中文");
  const en = surfaces.gate("en");
  assert.ok(en.includes("Enter the access password"), `英文登录门标题没换：${/<h1>([^<]*)<\/h1>/.exec(en)?.[1]}`);
  // The switcher's own language names and the "文" icon are kept on purpose (see the
  // i18n-exempt in locale-switcher); remove the whole button first, then what remains
  // is real leftover Chinese.
  const withoutSwitcher = en.replace(/<button[^>]*class="sw-locale[^"]*"[\s\S]*?<\/button>/g, "");
  assert.ok(!/[一-鿿]/.test(withoutSwitcher),
    `英文登录门里还有中文残留：${(withoutSwitcher.match(/[一-鿿]+/g) || []).slice(0, 5).join(" ")}`);
});

test("服务端渲染的组件必须收 locale，不能自己去读 <html lang>", async (t) => {
  // This tests rendering, not source. The guard only sees "no Chinese literals in the
  // file"; a component can have none and still server-render Chinese — `activeLocale()`
  // cannot read document on the server and falls back to the default. Such a page paints
  // Chinese first and hydrates to English: a hydration mismatch and a full-screen flash.
  //
  // So every server-rendered component must receive its locale from the caller. Verified
  // by a real render: asking for English without a document must yield English.
  const out = await build({
    stdin: {
      contents: `
        import { renderToStaticMarkup } from "react-dom/server";
        import { createElement } from "react";
        import { AccessManagePanel } from "./components/access-manage-panel";
        export const manage = (locale) => renderToStaticMarkup(createElement(AccessManagePanel, { locale }));`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      sourcefile: "i18n-ssr.tsx", loader: "tsx",
    },
    bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic",
    external: ["react", "react-dom", "react-dom/server"],
  });
  const artifact = fileURLToPath(new URL("../.i18n-ssr.test.mjs", import.meta.url));
  await writeFile(artifact, out.outputFiles[0].text);
  t.after(() => rm(artifact, { force: true }));
  const surfaces = await import(pathToFileURL(artifact).href);

  assert.equal(globalThis.document, undefined, "这条测试的前提就是服务端没有 document");
  const en = surfaces.manage("en");
  assert.ok(!/[一-鿿]/.test(en),
    `英文渲染里还有中文——组件八成是自己去推断语言，而不是用传进来的那一份：`
    + `${(en.match(/[一-鿿]+/g) || []).slice(0, 6).join(" ")}`);
  assert.match(surfaces.manage("zh"), /[一-鿿]/, "中文渲染反过来必须是中文");
});

test("both language menus list English first", async () => {
  // The console switcher and the widget menu share one order; both are read from
  // the source because the lists only render while the menu is open.
  const { readFile } = await import("node:fs/promises");
  const switcher = await readFile(new URL("../components/locale-switcher.tsx", import.meta.url), "utf8");
  assert.match(switcher, /const ORDER: Locale\[\] = \["en", "zh"\];/);
  const widget = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
  assert.match(widget, /for \(const item of \["en", "zh"\] as WidgetLocale\[\]\)/);
});
