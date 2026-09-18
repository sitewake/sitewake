import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function load(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const {
  normalizeDetectedSiteAgentIds,
  classifySiteAgentInstallation,
  MAX_DETECTED_SITE_AGENT_IDS,
  MAX_SITE_AGENT_ID_LENGTH,
} = await load("../lib/site-knowledge/site-preview-detection.ts");

const site = "shop.example.com";

test("a page with no install tag reads as absent", () => {
  assert.deepEqual(classifySiteAgentInstallation([], site), { kind: "absent" });
  assert.deepEqual(classifySiteAgentInstallation(undefined, site), { kind: "absent" });
  // A whitespace-only attribute value counts as not installed.
  assert.deepEqual(classifySiteAgentInstallation(["", "   "], site), { kind: "absent" });
});

test("a page carrying this site's identifier reads as self", () => {
  assert.deepEqual(classifySiteAgentInstallation([site], site), { kind: "self" });
  assert.deepEqual(classifySiteAgentInstallation([`  ${site}  `], site), { kind: "self" });
  // This site present means installed; another site's install on the page must not block the user.
  assert.deepEqual(classifySiteAgentInstallation(["other.test", site], site), { kind: "self" });
});

test("a page carrying only another site's identifier reads as foreign", () => {
  assert.deepEqual(classifySiteAgentInstallation(["docs.other.test"], site), {
    kind: "foreign",
    siteAgentIds: ["docs.other.test"],
  });
  assert.deepEqual(classifySiteAgentInstallation(["a.test", "b.test", "a.test"], site), {
    kind: "foreign",
    siteAgentIds: ["a.test", "b.test"],
  });
});

test("identifiers copied from a third-party page are clamped before they travel", () => {
  const long = "x".repeat(MAX_SITE_AGENT_ID_LENGTH + 50);
  assert.equal(normalizeDetectedSiteAgentIds([long])[0].length, MAX_SITE_AGENT_ID_LENGTH);

  const many = Array.from({ length: MAX_DETECTED_SITE_AGENT_IDS + 5 }, (_, index) => `site-${index}`);
  assert.equal(normalizeDetectedSiteAgentIds(many).length, MAX_DETECTED_SITE_AGENT_IDS);

  // Non-array input and non-string members are dropped, never thrown.
  assert.deepEqual(normalizeDetectedSiteAgentIds("site"), []);
  assert.deepEqual(normalizeDetectedSiteAgentIds(null), []);
  assert.deepEqual(normalizeDetectedSiteAgentIds([1, {}, null, "ok"]), ["ok"]);
});
