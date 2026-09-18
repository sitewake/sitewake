/**
 * The setup wizard loads `lib/site-knowledge/provider-payload-policy.ts`
 * straight from source with Node's type stripping — no bundler, no
 * node_modules. That works only while the file has no imports and uses only
 * erasable TypeScript syntax. The day someone adds an `import` or an `enum`,
 * the wizard breaks on a fresh clone; this test breaks first.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const POLICY = fileURLToPath(new URL("../lib/site-knowledge/provider-payload-policy.ts", import.meta.url));

test("provider-payload-policy.ts loads under --experimental-strip-types and exports the policy", async () => {
  const { stdout } = await run(process.execPath, [
    "--experimental-strip-types", "--disable-warning=ExperimentalWarning",
    "--input-type=module", "-e",
    `import(${JSON.stringify(POLICY)}).then((m) => console.log(JSON.stringify({ policy: typeof m.applyProviderPayloadPolicy, forced: typeof m.hasForcedToolChoice })))`,
  ]);
  assert.deepEqual(JSON.parse(stdout.trim()), { policy: "function", forced: "function" });
});

test("provider-payload-policy.ts stays import-free and uses only erasable syntax", async () => {
  const source = await readFile(POLICY, "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m, "an import would need node_modules or a bundler");
  assert.doesNotMatch(source, /^\s*export\s+.*\bfrom\s/m, "re-exports need a resolver too");
  assert.doesNotMatch(source, /\benum\s+\w/, "enums are not erasable");
  assert.doesNotMatch(source, /\bnamespace\s+\w/, "namespaces are not erasable");
  assert.doesNotMatch(source, /constructor\s*\([^)]*\b(public|private|protected|readonly)\s+\w/, "parameter properties are not erasable");
});
