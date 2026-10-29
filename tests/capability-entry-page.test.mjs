import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

async function bundled(contents, plugins = []) {
  const result = await build({
    stdin: { contents, resolveDir: ROOT, loader: "ts", sourcefile: "entry-page-test.ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { capabilityEntryPage, capabilityRunPage, scopeMatchesRequest } = await bundled(`
  export * from "./lib/capability-center-v2/entry-page";
  export { scopeMatchesRequest } from "./lib/capability-center-v2/semantic-analyzer";
`);

const HOME = "https://shop.example/";

// The two Contracts the live demo published or tried to: one bound to /shop by
// its scope alone, one bound to a filtered listing by a precondition written
// without its scheme and a scope written as a whole URL.
const boundByScope = {
  preconditions: [],
  scope: { kind: "page-scoped", onMismatch: "no-match", match: { urlPatterns: ["/shop"] } },
};
const boundByPrecondition = {
  preconditions: [{ type: "urlIncludes", value: "shop.example/shop?type=wall" }],
  scope: { kind: "category-scoped", onMismatch: "no-match", match: { requiredInputPaths: ["finish"], urlPatterns: ["https://shop.example/shop?type=wall"] } },
};

test("a capability bound to a page starts on that page, however its Contract writes the address", () => {
  assert.equal(capabilityEntryPage(boundByScope, HOME), "https://shop.example/shop");
  assert.equal(capabilityEntryPage(boundByPrecondition, HOME), "https://shop.example/shop?type=wall");
  assert.equal(capabilityEntryPage(boundByPrecondition, "https://shop.example/product/lune"), "https://shop.example/shop?type=wall");
});

test("a scope written as a pattern is not an address to start on", () => {
  // A category scope written with the category's slug as a star was opened as
  // that very address; the site answered with its index, and every draft of
  // "cheapest book in a category" started on a page with no category on it.
  const detail = "https://books.example/catalogue/the-road_277/index.html";
  const byPattern = { preconditions: [], scope: { kind: "category-scoped", onMismatch: "no-match", match: { urlPatterns: ["/catalogue/category/books/*/index.html"] } } };
  assert.equal(capabilityEntryPage(byPattern, detail), undefined);
  assert.deepEqual(capabilityRunPage(byPattern, detail), { url: detail, entry: undefined });
});

test("a Contract that names no fixed page leaves the program's own entry alone", () => {
  const siteWide = { preconditions: [], scope: { kind: "site-global", onMismatch: "no-match", match: { urlPatterns: ["/shop"] } } };
  const templated = { preconditions: [], scope: { kind: "page-scoped", onMismatch: "no-match", match: { urlPatterns: ["https://shop.example/shop?type=floor&room={room}"] } } };
  const fragmentOnly = { preconditions: [{ type: "urlIncludes", value: "&dimmable=" }], scope: { kind: "page-scoped", onMismatch: "no-match" } };
  const elsewhere = { preconditions: [], scope: { kind: "page-scoped", onMismatch: "no-match", match: { urlPatterns: ["https://other.example/shop"] } } };
  for (const contract of [siteWide, templated, fragmentOnly, elsewhere]) {
    assert.equal(capabilityEntryPage(contract, HOME), undefined, JSON.stringify(contract));
    assert.equal(capabilityRunPage(contract, HOME).entry, undefined, JSON.stringify(contract));
  }
});

test("an entry page has to meet every address condition, not just the first one written", () => {
  const conflicting = {
    preconditions: [{ type: "urlIncludes", value: "/shop" }, { type: "urlIncludes", value: "type=wall" }],
    scope: { kind: "page-scoped", onMismatch: "no-match", match: { urlPatterns: ["/shop"] } },
  };
  assert.equal(capabilityEntryPage(conflicting, HOME), undefined, "/shop alone does not carry type=wall");
});

test("a path in a page scope is found in the address's path, not in its host", () => {
  assert.equal(scopeMatchesRequest(boundByScope.scope, { currentUrl: HOME }).reason, "page_scope_mismatch");
  assert.equal(scopeMatchesRequest(boundByScope.scope, { currentUrl: "https://shop.example/shop?room=dining" }).matched, true);
});

test("a visitor already on the bound page stays there; anyone else is taken to it", () => {
  assert.deepEqual(capabilityRunPage(boundByScope, HOME), { url: "https://shop.example/shop", entry: { mode: "Navigate", url: "https://shop.example/shop" } });
  assert.deepEqual(capabilityRunPage(boundByScope, "https://shop.example/shop?room=bedroom"), { url: "https://shop.example/shop?room=bedroom", entry: { mode: "CurrentPage" } });
});

test("the runtime hands a page-bound capability to a visitor on another page, starting where it belongs", async () => {
  const capability = {
    id: "cap_dimmable", siteId: "site", name: "Find dimmable lamps", description: "", status: "Active", currentVersionId: "v1",
    contract: { intent: "Show me dimmable table lamps under ${{maxPrice}}", inputSchema: { type: "object" }, outputSchema: { type: "object" }, preconditions: [], successConditions: [], ...boundByScope },
  };
  const version = { id: "v1", status: "Published", program: { schemaVersion: "2.0", entry: { mode: "Navigate", url: HOME }, stages: [] } };
  const stub = (contents) => ({ contents, loader: "ts", resolveDir: ROOT });
  const { GET } = await bundled(`export { GET } from "./app/api/capability-v2/capabilities/[capabilityId]/runtime/route";`, [{
    name: "stub-stores",
    setup(builder) {
      builder.onResolve({ filter: /(capability-center-v2-store|agent-run-store|agent-runs\/http|request-timing)$|^\.\.\/\.\.\/\.\.\/http$/ }, (args) => ({ path: args.path, namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
        if (args.path.endsWith("capability-center-v2-store")) return stub(`export const getCapability = async () => (${JSON.stringify(capability)}); export const getVersion = async () => (${JSON.stringify(version)});`);
        if (args.path.endsWith("agent-run-store")) return stub(`export const getSiteAgentRunByToken = async () => ({ run: { id: "run_1" } }); export const grantCompiledCapabilityExecution = async () => ({ executionGrantId: "grant_1" });`);
        if (args.path.endsWith("agent-runs/http")) return stub(`export const runToken = (request) => (request.headers.get("authorization") || "").replace(/^Bearer /, "");`);
        if (args.path.endsWith("request-timing")) return stub(`export const withRequestTiming = (_name, handler) => handler;`);
        return stub(`
          export const capabilityOptions = () => new Response(null);
          export const capabilityAgentAuthorized = async () => true;
          export const siteIdFromRequest = () => "site";
          export const capabilityJson = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
          export const errorResponse = (error) => new Response(JSON.stringify({ error: String(error) }), { status: 500 });
        `);
      });
    },
  }]);
  const ask = (currentUrl) => GET(new Request("https://console.example/api/capability-v2/capabilities/cap_dimmable/runtime?siteId=site", {
    headers: { authorization: "Bearer token", "x-capability-current-url": encodeURIComponent(currentUrl), "x-capability-input": encodeURIComponent("{}") },
  }), { params: Promise.resolve({ capabilityId: "cap_dimmable" }) });

  const fromHome = await ask(HOME);
  assert.equal(fromHome.status, 200, "refused a visitor on the home page");
  assert.deepEqual((await fromHome.json()).program.entry, { mode: "Navigate", url: "https://shop.example/shop" });
  const fromShop = await ask("https://shop.example/shop?room=bedroom");
  assert.deepEqual((await fromShop.json()).program.entry, { mode: "CurrentPage" }, "a visitor on the shop page was sent away from it");
});
