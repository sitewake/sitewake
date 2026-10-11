import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const candidate = { id: "existing-rank", name: "按排名打开详情", searchText: "打开第个热搜详情按排名", status: "Active", contract: {} };
async function matcher({ configured = true, result, fail = false, items = [candidate] } = {}) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../lib/capability-center-v2/duplicate-matcher.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "dependencies", setup(b) {
      b.onLoad({ filter: /capability-center-v2-store\.ts$/ }, () => ({ contents: `export async function listCapabilities(){return {capabilities:${JSON.stringify(items)}}}`, loader: "ts" }));
      b.onLoad({ filter: /model-config\.ts$/ }, () => ({ contents: `export function getModelConfig(){return {configured:${configured}}}`, loader: "ts" }));
      b.onLoad({ filter: /model-json\.ts$/ }, () => ({ contents: `export async function requestStructuredModelJson(config, request){${fail ? 'throw new Error("provider_unavailable")' : `const result=${JSON.stringify(result ?? { capabilityId: null, reason: "different" })};request.validate(result);return result;`}}`, loader: "ts" }));
    } }],
  });
  return (await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`)).findDuplicateCapability;
}

test("provider failure and missing configuration are unknown, never permission to create", async () => {
  for (const options of [{ fail: true }, { configured: false }, { result: { capabilityId: "invented", reason: "match" } }]) {
    const find = await matcher(options);
    await assert.rejects(find("site", "打开第 10 个热搜"), /capability_duplicate_check_unavailable/);
  }
});
test("a valid parameterized match reuses the existing identity", async () => {
  const find = await matcher({ result: { capabilityId: candidate.id, reason: "rank is an input" } });
  assert.equal((await find("site", "打开第 10 个热搜")).id, candidate.id);
});
test("a valid negative decision or empty catalog still permits new capability creation", async () => {
  for (const options of [{}, { items: [], configured: false }]) {
    assert.equal(await (await matcher(options))("site", "打开第 10 个热搜"), undefined);
  }
});
