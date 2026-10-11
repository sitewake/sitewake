import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const active = { id: "by-category", name: "分类热搜排序", description: "按分类对热搜排序", searchText: "分类 热搜 搜索 排序", aliases: [], status: "Active", contract: {
  intent: "分类热搜排序", scope: { kind: "category-scoped", match: { requiredInputPaths: ["category"] } },
  inputSchema: { type: "object", properties: { category: { type: "string" } }, required: ["category"] },
} };
const bundle = await build({ entryPoints: [resolve(root, "app/api/capability-v2/capabilities/search/route.ts")], bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{ name: "test-boundaries", setup(b) {
    b.onResolve({ filter: /^@\// }, args => ({ path: resolve(root, `${args.path.slice(2)}.ts`) }));
    b.onLoad({ filter: /capability-center-v2-store\.ts$/ }, () => ({ contents: `export async function listCapabilities(){return {capabilities:${JSON.stringify([active, { ...active, id: "disabled", status: "Disabled" }])}}}`, loader: "ts" }));
    b.onLoad({ filter: /capability-v2\/http\.ts$/ }, () => ({ contents: `
      export const capabilityJson = (body,status=200)=>Response.json(body,{status});
      export const capabilityAgentAuthorized = async r=>r.headers.get("authorization")==="Bearer test";
      export const siteIdFromRequest = (r,b)=>b.siteId;
      export const capabilityOptions = ()=>new Response(null);
      export const errorResponse = ()=>Response.json({error:"failed"},{status:500});`, loader: "ts" }));
  } }],
});
const { POST } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const request = authorized => new Request("http://local/api/capability-v2/capabilities/search", { method: "POST", headers: { "content-type": "application/json", ...(authorized ? { authorization: "Bearer test" } : {}) }, body: JSON.stringify({ siteId: "site", queries: ["热搜"], goal: "搜索热搜", input: {} }) });

test("retrieval exposes required inputs and scope instead of hiding the candidate before binding", async () => {
  const response = await POST(request(true));
  assert.equal(response.status, 200);
  const { items } = await response.json();
  assert.deepEqual(items.map(item => item.capabilityId), [active.id], "disabled abilities remain excluded");
  assert.equal(items[0].scopeMatchReason, "scope_input_missing");
  assert.deepEqual(items[0].contract.inputSchema.required, ["category"]);
});
test("retrieval still enforces caller authorization", async () => {
  assert.equal((await POST(request(false))).status, 401);
});
