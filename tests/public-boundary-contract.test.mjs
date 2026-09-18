import assert from "node:assert/strict";
import test from "node:test";
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

test("public runtime redacts credentials without erasing routes, business codes, or schema structure", async () => {
  const { sanitizePublicRuntime } = await bundledModule(
    "../lib/site-knowledge/public-runtime.ts",
  );
  const source = {
    callback: "https://user:pass@example.test/callback?accessToken=secret&productCode=SKU-1#ticket=grant",
    hashRoutes: [
      "https://example.test/#/cart",
      "https://example.test/#!/orders",
      "https://example.test/#details",
    ],
    opaqueFragment: "https://example.test/#AbCdEfGhIjKlMnOpQrStUvWx123456",
    malformedFragment: "https://example.test/#%E0%A4%A",
    business: {
      zipcode: "100000",
      promoCode: "SAVE20",
      productCode: "SKU-1",
    },
    credentials: {
      username: "alice",
      password: "hunter2",
      nested: { token: "nested-secret" },
    },
    inputSchema: {
      type: "object",
      description: "Login contract",
      required: ["accessToken"],
      properties: {
        accessToken: {
          type: "string",
          description: "Opaque access token",
          minLength: 16,
          pattern: "^[A-Za-z0-9]+$",
          format: "password",
          examples: ["secret-example"],
          default: "secret-default",
          const: "secret-const",
        },
      },
    },
  };

  const sanitized = sanitizePublicRuntime(source);
  const callback = new URL(sanitized.callback);
  assert.equal(callback.username, "");
  assert.equal(callback.password, "");
  assert.equal(callback.searchParams.get("accessToken"), "[redacted]");
  assert.equal(callback.searchParams.get("productCode"), "SKU-1");
  assert.equal(new URLSearchParams(callback.hash.slice(1)).get("ticket"), "[redacted]");
  assert.deepEqual(sanitized.hashRoutes, source.hashRoutes);
  assert.match(decodeURIComponent(new URL(sanitized.opaqueFragment).hash), /redacted/);
  assert.match(decodeURIComponent(new URL(sanitized.malformedFragment).hash), /redacted/);
  assert.deepEqual(sanitized.business, source.business);
  assert.equal(sanitized.credentials.username, "[redacted]");
  assert.equal(sanitized.credentials.password, "[redacted]");
  assert.equal(sanitized.credentials.nested.token, "[redacted]");
  const tokenSchema = sanitized.inputSchema.properties.accessToken;
  assert.equal(tokenSchema.type, "string");
  assert.equal(tokenSchema.description, "Opaque access token");
  assert.equal(tokenSchema.minLength, 16);
  assert.equal(tokenSchema.pattern, "^[A-Za-z0-9]+$");
  assert.equal(tokenSchema.format, "password");
  assert.deepEqual(tokenSchema.examples, ["[redacted]"]);
  assert.equal(tokenSchema.default, "[redacted]");
  assert.equal(tokenSchema.const, "[redacted]");
});

test("crawl knowledge accepts a genuine assembled document and rejects forged provenance or shape", async () => {
  const {
    assembleSiteKnowledgeDocument,
    assertValidSiteKnowledgeDocument,
  } = await bundledModule("../lib/site-knowledge/crawl-knowledge.ts");
  const capturedAt = "2026-07-30T08:00:00.000Z";
  const snapshot = {
    id: "snapshot-home",
    sessionId: "crawl-session",
    documentId: "crawl-document",
    sequence: 1,
    url: "https://atlas.test/",
    title: "Atlas Market",
    heading: "Atlas Market",
    visibleText: "Atlas Market 商品与购物车",
    links: [{ text: "购物车", url: "https://atlas.test/cart" }],
    elements: [{
      tag: "a",
      role: "link",
      accessibleName: "购物车",
      href: "https://atlas.test/cart",
      attributes: { href: "https://atlas.test/cart" },
      cssPath: "a[href='/cart']",
    }],
    metadata: {
      applicationName: "Atlas Market",
      description: "测试商城",
    },
    capturedAt,
  };
  const document = assembleSiteKnowledgeDocument({
    siteAgentId: "atlas",
    origin: "https://atlas.test",
    crawledAt: capturedAt,
    seeds: ["https://atlas.test/"],
    snapshots: [snapshot],
    urlsSeen: 2,
  });
  assert.doesNotThrow(() => assertValidSiteKnowledgeDocument(document, {
    siteAgentId: "atlas",
    origin: "https://atlas.test",
    limits: { maxRenders: 10 },
  }));

  const clone = () => structuredClone(document);
  const wrongSite = clone();
  wrongSite.meta.siteAgentId = "other";
  assert.throws(() => assertValidSiteKnowledgeDocument(wrongSite, {
    siteAgentId: "atlas",
    origin: "https://atlas.test",
  }), /crawl_document_invalid:site_agent/);

  const crossOrigin = clone();
  crossOrigin.links[0].href = "https://attacker.test/cart";
  assert.throws(() => assertValidSiteKnowledgeDocument(crossOrigin, {
    siteAgentId: "atlas",
    origin: "https://atlas.test",
  }), /crawl_document_invalid/);

  const badStats = clone();
  badStats.meta.stats.scenes += 1;
  assert.throws(() => assertValidSiteKnowledgeDocument(badStats, {
    siteAgentId: "atlas",
    origin: "https://atlas.test",
  }), /crawl_document_invalid:stats/);

  const duplicateScene = clone();
  duplicateScene.scenes.push(structuredClone(duplicateScene.scenes[0]));
  duplicateScene.meta.stats.scenes = duplicateScene.scenes.length;
  assert.throws(() => assertValidSiteKnowledgeDocument(duplicateScene, {
    siteAgentId: "atlas",
    origin: "https://atlas.test",
  }), /crawl_document_invalid:scene_/);

  // A legacy in-flight worker may still send a derived `tree` field. The validator no
  // longer requires or checks it (topology is derived by consumers), so an extra tree —
  // even a nonsensical one — is tolerated and ignored rather than rejected.
  const legacyTree = clone();
  legacyTree.tree = { root: { name: "Forged" }, areas: [], nodes: [], primaryEdges: [], secondaryEdges: [] };
  assert.doesNotThrow(() => assertValidSiteKnowledgeDocument(legacyTree, {
    siteAgentId: "atlas",
    origin: "https://atlas.test",
    limits: { maxRenders: 10 },
  }));

  const oversized = clone();
  oversized.profile.description = "x".repeat(5 * 1024 * 1024);
  assert.throws(() => assertValidSiteKnowledgeDocument(oversized, {
    siteAgentId: "atlas",
    origin: "https://atlas.test",
  }), /crawl_document_too_large/);
});
