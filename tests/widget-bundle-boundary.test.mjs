import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/**
 * The widget ships as one file injected into every visitor's page, so what it imports
 * is a size budget, not a style preference. `client/user-agent-copy.ts` says as much:
 * the widget keeps its own catalog precisely so the console's dictionary never reaches
 * a customer's site.
 *
 * Nothing enforced that. Reaching for a helper in `lib/i18n` — whose module loads both
 * catalogs, zh alone being over two thousand lines — would have pulled them in, and the
 * only symptom is a bigger file for every visitor. Hence a check on the import graph.
 */
const ENTRIES = ["client/user-agent-client.ts", "client/user-agent-adaptive.ts"];
const CONSOLE_CATALOG = /lib\/i18n\/(zh|en)\.ts$/;

async function bundleInputs(entry) {
  const result = await build({
    // fileURLToPath, not URL.pathname: a checkout whose path contains a space
    // arrives percent-encoded and esbuild cannot resolve it.
    entryPoints: [fileURLToPath(new URL(`../${entry}`, import.meta.url))],
    bundle: true, write: false, metafile: true, format: "esm", logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs);
}

test("the injected widget bundles never pull in the console copy catalogs", async () => {
  for (const entry of ENTRIES) {
    const pulled = (await bundleInputs(entry)).filter((file) => CONSOLE_CATALOG.test(file));
    assert.deepEqual(pulled, [], `${entry} bundles the console dictionary: ${pulled.join(", ")}`
      + " — import from lib/i18n/locale.ts, which carries no catalog.");
  }
});

test("the widget still resolves authored text, so field labels follow the visitor", async () => {
  // The guard above is satisfied by importing nothing at all; this keeps it honest.
  const inputs = await bundleInputs("client/user-agent-client.ts");
  assert.ok(inputs.some((file) => file.endsWith("lib/i18n/locale.ts")),
    "the catalog-free locale module should be in the widget bundle");
});
