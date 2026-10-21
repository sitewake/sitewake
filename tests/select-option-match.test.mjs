/**
 * The model sometimes names a dropdown option by the value the form sends
 * instead of the label a reader sees. Which option it meant is resolved by a
 * rule that knows nothing about any one site: exact label, then label
 * ignoring case and spacing, then value ignoring case and spacing, and only
 * when exactly one option qualifies.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { resolveSelectOptionLabel } = await (async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../client/select-option-match.ts", import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
})();

const country = [
  { text: "Choose…", value: "" },
  { text: "United States", value: "US" },
  { text: "United Kingdom", value: "GB" },
  { text: "Canada", value: "CA" },
];

test("an exact label is used as it is", () => {
  assert.equal(resolveSelectOptionLabel(country, "Canada"), "Canada");
});

test("a label in different case or spacing still names its option", () => {
  assert.equal(resolveSelectOptionLabel(country, "united  kingdom"), "United Kingdom");
});

test("a value names its option when no label does, in any case", () => {
  assert.equal(resolveSelectOptionLabel(country, "us"), "United States");
  assert.equal(resolveSelectOptionLabel([{ text: "Any", value: "" }, { text: "Waterproof", value: "yes" }, { text: "Not waterproof", value: "no" }], "Yes"), "Waterproof");
});

test("a label wins over another option's value", () => {
  const sizes = [{ text: "L", value: "large" }, { text: "Large print", value: "l" }];
  assert.equal(resolveSelectOptionLabel(sizes, "L"), "L");
});

test("two options that both qualify are not guessed between", () => {
  assert.equal(resolveSelectOptionLabel([{ text: "Blue", value: "1" }, { text: "blue", value: "2" }], "BLUE"), undefined);
  assert.equal(resolveSelectOptionLabel([{ text: "Small", value: "s" }, { text: "Short", value: "s" }], "s"), undefined);
});

test("nothing that matches, an empty request or an empty value resolves to nothing", () => {
  assert.equal(resolveSelectOptionLabel(country, "France"), undefined);
  assert.equal(resolveSelectOptionLabel(country, "  "), undefined);
  assert.equal(resolveSelectOptionLabel([{ text: "Any", value: "" }], ""), undefined);
});
