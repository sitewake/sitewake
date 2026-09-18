/**
 * The terminal copy catalog: both languages must have the same shape, the
 * locale must be chosen the way the spec says, and the scripts that talk to a
 * person must not carry Chinese literals of their own any more.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { en, zh, cli, resolveCliLocale, withoutLangFlag } from "../scripts/cli-copy.mjs";

function shape(value, path = "") {
  if (typeof value === "function") return [[path, `function/${value.length}`]];
  if (Array.isArray(value)) return [[path, `array/${value.length}`]];
  if (value && typeof value === "object") {
    return Object.keys(value).sort().flatMap((key) => shape(value[key], path ? `${path}.${key}` : key));
  }
  return [[path, typeof value]];
}

test("English and Chinese catalogs have identical keys, types and arities", () => {
  const left = shape(en);
  const right = shape(zh);
  const leftKeys = new Set(left.map(([key]) => key));
  const rightKeys = new Set(right.map(([key]) => key));
  const onlyEn = [...leftKeys].filter((key) => !rightKeys.has(key));
  const onlyZh = [...rightKeys].filter((key) => !leftKeys.has(key));
  assert.deepEqual(onlyEn, [], `keys only in en: ${onlyEn.join(", ")}`);
  assert.deepEqual(onlyZh, [], `keys only in zh: ${onlyZh.join(", ")}`);
  assert.deepEqual(left, right, "same keys must carry the same type and function arity");
});

test("every string differs between the two languages unless it is a command or code", () => {
  const same = shape(en)
    .filter(([, kind]) => kind === "string")
    .map(([key]) => key)
    .filter((key) => {
      const enValue = key.split(".").reduce((node, part) => node[part], en);
      const zhValue = key.split(".").reduce((node, part) => node[part], zh);
      return enValue === zhValue;
    });
  // Identical values are allowed only where translating would be wrong:
  // commands, code, answer letters and labels that are proper nouns.
  const allowed = new Set([
    "common.yes", "common.no", "setup.prefix", "setup.nextDocker", "setup.manualKey",
    "preflight.chromiumMissingFix", "preflight.codexMissingFix", "preflight.modelMissingFix",
    "preflight.componentLauncher",
    // The language question is asked before a language is chosen, so it is
    // the same bilingual line in both catalogs; the localhost value is a URL.
    "setup.languageQuestion", "setup.languageHint", "setup.originReachLocalhostValue",
  ]);
  const unexpected = same.filter((key) => !allowed.has(key));
  assert.deepEqual(unexpected, [], `untranslated: ${unexpected.join(", ")}`);
});

test("cli() falls back to English for unknown locales", () => {
  assert.equal(cli("en"), en);
  assert.equal(cli("zh"), zh);
  assert.equal(cli("fr"), en);
  assert.equal(cli(), en);
});

test("locale resolution: environment variables", () => {
  const cases = [
    [{ LANG: "zh_CN.UTF-8" }, "zh"],
    [{}, "en"],
    [{ LANG: "" , LC_ALL: "", LC_MESSAGES: "", LANGUAGE: "" }, "en"],
    [{ LANG: "ja_JP.UTF-8" }, "en"],
    [{ LANG: "C" }, "en"],
    [{ LANG: "POSIX" }, "en"],
    [{ LANG: "zh-Hans" }, "zh"],
    [{ LANG: "ZH_TW.UTF-8" }, "zh"],
    [{ LANG: "en_US.UTF-8" }, "en"],
    // POSIX precedence: LC_ALL beats LANG even when LANG is Chinese.
    [{ LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }, "en"],
    [{ LC_MESSAGES: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }, "zh"],
    // LANGUAGE is consulted last, only when nothing else is set.
    [{ LANGUAGE: "zh:en" }, "zh"],
  ];
  for (const [env, expected] of cases) {
    assert.equal(resolveCliLocale({ argv: [], env }), expected, JSON.stringify(env));
  }
});

test("locale resolution: --lang overrides the environment in both spellings", () => {
  const env = { LANG: "zh_CN.UTF-8" };
  assert.equal(resolveCliLocale({ argv: ["--lang", "en"], env }), "en");
  assert.equal(resolveCliLocale({ argv: ["--lang=en"], env }), "en");
  assert.equal(resolveCliLocale({ argv: ["--target", "docker", "--lang", "EN"], env }), "en");
  assert.equal(resolveCliLocale({ argv: ["--lang", "zh"], env: {} }), "zh");
});

test("locale resolution: an invalid --lang names the valid values", () => {
  assert.throws(() => resolveCliLocale({ argv: ["--lang", "fr"], env: {} }), /en, zh/);
  assert.throws(() => resolveCliLocale({ argv: ["--lang=de"], env: {} }), /en, zh/);
  assert.throws(() => resolveCliLocale({ argv: ["--lang"], env: {} }), /en, zh/);
});

test("withoutLangFlag strips both spellings and keeps everything else", () => {
  assert.deepEqual(withoutLangFlag(["--lang", "zh", "--target", "docker"]), ["--target", "docker"]);
  assert.deepEqual(withoutLangFlag(["--target", "local", "--lang=en"]), ["--target", "local"]);
  assert.deepEqual(withoutLangFlag([]), []);
});

/**
 * Comments may be written in whatever language the author likes; only code
 * counts. A character scan rather than a regex, for the same reason as
 * tests/i18n-coverage.test.mjs: a regex cannot tell `//` in a URL from a
 * comment, or a quote inside a string from one inside a comment.
 */
function stripComments(source) {
  let out = "";
  let index = 0;
  let inLine = false, inBlock = false, quote = "";
  while (index < source.length) {
    const char = source[index];
    const pair = source.slice(index, index + 2);
    if (char === "\n") { out += "\n"; index += 1; inLine = false; continue; }
    if (inLine) { index += 1; continue; }
    if (inBlock) { if (pair === "*/") { inBlock = false; index += 2; } else index += 1; continue; }
    if (quote) {
      if (char === "\\") { out += source.slice(index, index + 2); index += 2; continue; }
      if (char === quote) quote = "";
      out += char; index += 1; continue;
    }
    if (pair === "//") { inLine = true; index += 2; continue; }
    if (pair === "/*") { inBlock = true; index += 2; continue; }
    if (char === '"' || char === "'" || char === "`") quote = char;
    out += char; index += 1;
  }
  return out;
}

const HAN = /[一-鿿]/;

/**
 * Scripts whose person-facing output has moved into the catalog. Once a file
 * is listed here, a Chinese literal in its code is a regression.
 */
const EXTRACTED = [
  "scripts/setup.mjs",
  "scripts/model-check-core.mjs",
  "scripts/check-model-compatibility.mjs",
  "scripts/preflight.mjs",
];

test("extracted scripts carry no Chinese literals outside comments", async () => {
  const root = new URL("../", import.meta.url);
  const offenders = [];
  for (const file of EXTRACTED) {
    const source = await readFile(fileURLToPath(new URL(file, root)), "utf8");
    stripComments(source).split("\n").forEach((line, number) => {
      if (HAN.test(line)) offenders.push(`${file}:${number + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `Chinese outside the catalog:\n${offenders.join("\n")}`);
});

test("the catalog itself depends on nothing outside node:", async () => {
  const source = await readFile(fileURLToPath(new URL("../scripts/cli-copy.mjs", import.meta.url)), "utf8");
  const specifiers = [...source.matchAll(/^\s*import\b[^"']*["']([^"']+)["']/gm)].map((match) => match[1]);
  for (const specifier of specifiers) assert.match(specifier, /^node:/, specifier);
});
