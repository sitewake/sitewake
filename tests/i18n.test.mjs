import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function bundledModule(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
}

const { zh, en, copy, resolveServerLocale, DEFAULT_LOCALE } = await bundledModule("../lib/i18n/index.ts");

/** Walks a catalog, yielding [dotted.path, value] for every leaf. */
function* leaves(node, path = []) {
  for (const [key, value] of Object.entries(node)) {
    const next = [...path, key];
    if (value && typeof value === "object") yield* leaves(value, next);
    else yield [next.join("."), value];
  }
}

test("locales expose exactly the same keys", () => {
  const zhKeys = [...leaves(zh)].map(([path]) => path).sort();
  const enKeys = [...leaves(en)].map(([path]) => path).sort();
  // tsc already enforces this structurally; this catches a locale drifting at
  // runtime (e.g. a key added via spread) and names the difference.
  assert.deepEqual(enKeys, zhKeys);
});

test("every value is a non-empty string or a formatter function", () => {
  for (const [locale, catalog] of [["zh", zh], ["en", en]]) {
    for (const [path, value] of leaves(catalog)) {
      if (typeof value === "function") continue;
      assert.equal(typeof value, "string", `${locale}.${path} is not a string`);
      assert.ok(value.trim().length > 0, `${locale}.${path} is empty`);
    }
  }
});

test("formatters accept the same arguments in both locales", () => {
  const zhFns = [...leaves(zh)].filter(([, value]) => typeof value === "function");
  for (const [path, fn] of zhFns) {
    const other = path.split(".").reduce((node, key) => node[key], en);
    assert.equal(typeof other, "function", `en.${path} is not a formatter`);
    assert.equal(other.length, fn.length, `en.${path} takes a different number of arguments`);
  }
  // Spot-check that interpolation actually happens rather than being dropped.
  assert.match(zh.common.pagination(2, 5, 87), /2/);
  assert.match(zh.common.pagination(2, 5, 87), /87/);
  assert.match(en.common.pagination(2, 5, 87), /2/);
  assert.match(en.time.minutesAgo(7), /7/);
});

test("English is the default and unknown locales fall back to it", () => {
  assert.equal(DEFAULT_LOCALE, "en");
  assert.equal(copy("nope"), en);
  assert.equal(copy(), en);
  assert.equal(copy("en"), en);
  // Server-side, with no window, resolution must be deterministic.
  assert.equal(resolveServerLocale({}), "en");
  assert.equal(resolveServerLocale({ cookie: "zh" }), "zh");
});

test("the five-outcome taxonomy is complete and distinct in both locales", () => {
  const statuses = ["success", "no-result", "business-rejection", "execution-fault", "unknown"];
  for (const [locale, catalog] of [["zh", zh], ["en", en]]) {
    for (const status of statuses) {
      assert.ok(catalog.outcome.label[status], `${locale} is missing the ${status} label`);
      assert.ok(catalog.outcome.hint[status], `${locale} is missing the ${status} hint`);
    }
    // Distinct labels matter: docs/site-agent-system-design.md requires an owner
    // to tell "no data" apart from "something broke".
    const labels = statuses.map((status) => catalog.outcome.label[status]);
    assert.equal(new Set(labels).size, statuses.length, `${locale} reuses an outcome label`);
  }
});

test("user-facing copy carries no internal vocabulary", async () => {
  // docs/product-experience.md: Scene / Selector / Trace / Episode / Locator are
  // internal machinery and must never surface to a business user.
  const forbidden = [/\bSelector\b/i, /\bScene\b/, /\bEpisode\b/, /\bLocator\b/i, /\bTrace\b/];
  for (const [locale, catalog] of [["zh", zh], ["en", en]]) {
    for (const [path, value] of leaves(catalog)) {
      const text = typeof value === "function" ? value("x") : value;
      for (const pattern of forbidden) {
        assert.doesNotMatch(
          String(text),
          pattern,
          `${locale}.${path} leaks internal vocabulary: ${text}`,
        );
      }
    }
  }
});

test("console copy is read from the catalog rather than inlined", async () => {
  // Guards the seam: these modules should reference the catalog, so wording
  // stays reviewable in one place instead of drifting back into JSX.
  for (const path of [
    "../lib/console/copy.ts",
    "../components/ui/badge.tsx",
    "../components/ui/modal.tsx",
    "../components/ui/feedback.tsx",
    "../components/ui/data-table.tsx",
    "../components/access-manage-panel.tsx",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /from "(@\/lib\/i18n|\.\.\/i18n|\.\.\/\.\.\/lib\/i18n|\.\.\/lib\/i18n)"/, `${path} does not read the copy catalog`);
  }
});
