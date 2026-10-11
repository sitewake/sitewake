/**
 * The English catalog must actually be English.
 *
 * The complaint that started this was "英文模式下不是完全英文": the widget was in
 * English mode and still said 正在理解你的需求. TypeScript could not catch it — `en`
 * satisfies `WidgetCopy` whether its values are English or not, and a template
 * function hides its Chinese behind a call. So this test calls every entry, including
 * every function, and reads what comes out.
 *
 * It also checks the shapes match, which matters for the functions: a zh entry taking
 * two arguments and an en entry taking one is a dropped value, not a type error.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../client/user-agent-copy.ts", import.meta.url))],
  bundle: true, platform: "neutral", format: "esm", write: false,
});
const copy = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

const HAN = /[一-鿿]/;

/** Every leaf of a catalog, as `path -> rendered text`. Functions are called. */
function render(node, path = "") {
  if (typeof node === "string") return [[path, node]];
  if (typeof node === "function") {
    // Probe with both shapes: a label takes strings, a count takes numbers.
    const args = (filler) => Array.from({ length: node.length }, () => filler);
    const outputs = [];
    for (const filler of ["PROBE", 2]) {
      try { outputs.push(String(node(...args(filler)))); } catch { /* the other shape will do */ }
    }
    assert.ok(outputs.length, `${path} could not be called with either probe`);
    return outputs.map((text, index) => [`${path}()#${index}`, text]);
  }
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([key, value]) => render(value, path ? `${path}.${key}` : key));
  }
  return [];
}

test("英文词表里不出现中文", () => {
  const offenders = render(copy.widgetCopy("en"))
    // The probe is substituted into the sentence, so strip it before reading.
    .filter(([, text]) => HAN.test(text.replaceAll("PROBE", "")))
    .map(([path, text]) => `${path}: ${text.slice(0, 60)}`);
  assert.deepEqual(offenders, [], `英文读者会看到这些中文：\n  ${offenders.join("\n  ")}`);
});

test("中文词表是中文的，否则就是漏翻", () => {
  // Not every entry has Chinese in it — "SiteWake" and "Markdown" are names. The point
  // is the reverse direction: a zh entry identical to its en twin is usually an
  // untranslated paste, so the two catalogs must not be the same object.
  const zh = Object.fromEntries(render(copy.widgetCopy("zh")));
  const en = Object.fromEntries(render(copy.widgetCopy("en")));
  assert.deepEqual(Object.keys(zh), Object.keys(en), "两份词表的形状必须一致");
  const chinese = Object.values(zh).filter((text) => HAN.test(text));
  assert.ok(chinese.length > 100, `中文词表只有 ${chinese.length} 条中文，不像完整的词表`);
});

test("两边的模板函数接受同样多的参数", () => {
  const arity = (catalog) => {
    const walk = (node, path = "") => {
      if (typeof node === "function") return [[path, node.length]];
      if (node && typeof node === "object") {
        return Object.entries(node).flatMap(([key, value]) => walk(value, path ? `${path}.${key}` : key));
      }
      return [];
    };
    return Object.fromEntries(walk(catalog));
  };
  assert.deepEqual(arity(copy.widgetCopy("en")), arity(copy.widgetCopy("zh")));
});
