/**
 * The side that checks and the side that executes give the same answer.
 *
 * They did not. `lib/console/site-addresses.ts` admitted any subdomain of a
 * registered domain, and `db/agent-run-store.ts` required the exact origin. A
 * developer who installed the SDK on `app.example.test` with only
 * `example.test` registered was told the site was connected, and then every
 * task was refused with `agent_run_origin_rejected` — two views of the same
 * decision, disagreeing, with nothing in either file that could notice.
 *
 * Both sides are exact now. This holds them to it by asking the same question of
 * both, over the pairs that used to disagree, rather than trusting that two
 * functions written apart stay in step.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { originIsRegistered } from "../lib/console/site-addresses.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * A stub that cannot fall behind the module it replaces.
 *
 * Reading the real module's export names means a new export shows up here as a
 * no-op instead of as `No matching export`, which is an esbuild error that looks
 * like the product failing to build. `returns` gives a body to the ones whose
 * answer the test depends on; everything else answers undefined.
 */
function stubFor(relativePath, returns = {}) {
  const source = readFileSync(`${ROOT}${relativePath}`, "utf8");
  const names = [...source.matchAll(/^export (?:async function|function|const|class)\s+([A-Za-z0-9_$]+)/gm)]
    .map((match) => match[1]);
  const missing = Object.keys(returns).filter((name) => !names.includes(name));
  if (missing.length) throw new Error(`${relativePath} no longer exports ${missing.join(", ")}`);
  return names.map((name) => `export function ${name}() { return ${returns[name] ?? "undefined"}; }`).join("\n");
}

// agent-run-store reaches its neighbours without file extensions.
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../db/agent-run-store.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false,
  absWorkingDir: ROOT,
  plugins: [{
    name: "store-fixtures",
    setup(builder) {
      // Generated from the real module's exports rather than hand-written. A
      // hand-written stub falls behind the moment the real module gains an
      // export, and the failure then reads as a product build error — which is
      // how this very test failed on its first run.
      builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
        contents: stubFor("db/index.ts", { getD1Binding: "null", getArtifactBinding: "null" }),
        loader: "ts",
      }));
      builder.onLoad({ filter: /[\\/]db[\\/]site-agent-store\.ts$/ }, () => ({
        contents: "export async function siteAgentExists() { return true; }\nexport async function createTaskSession() { return {}; }\nexport async function getSiteAgentOverview() { return {}; }\nexport async function getTaskEpisodeById() { return undefined; }",
        loader: "ts",
      }));
    },
  }],
});
const { siteExecutionOrigins } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

/** Would a task from this page be authorized for a site registered at these origins? */
function executionAllows(registered, pageOrigin) {
  try {
    siteExecutionOrigins({ allowedOrigins: registered, reportedOrigin: pageOrigin, requestOrigin: pageOrigin });
    return true;
  } catch (error) {
    if (String(error?.message) === "agent_run_origin_rejected") return false;
    throw error;
  }
}

const CASES = [
  // [registered, page, expected]
  [["https://example.test"], "https://example.test", true, "the registered address itself"],
  [["https://example.test"], "https://app.example.test", false, "an unregistered subdomain — the pair that used to disagree"],
  [["https://example.test"], "https://www.example.test", false, "a www alias is its own address"],
  [["https://example.test", "https://app.example.test"], "https://app.example.test", true, "registering it is what admits it"],
  [["https://example.test"], "http://example.test", false, "another scheme"],
  [["https://example.test"], "https://example.test:8443", false, "another port"],
  [["https://example.test"], "https://example.test.evil.test", false, "a lookalike suffix"],
  [["https://example.test"], "https://other.test", false, "another domain"],
];

test("the check and the execution agree on every origin", () => {
  for (const [registered, page, expected, why] of CASES) {
    const checked = originIsRegistered(registered, page);
    const executed = executionAllows(registered, page);
    assert.equal(checked, expected, `check: ${why}`);
    assert.equal(executed, expected, `execution: ${why}`);
    assert.equal(checked, executed,
      `两侧对 ${page}（已登记 ${registered.join(", ")}）给出不同答案：检查 ${checked}，执行 ${executed}`);
  }
});

test("the authority callers cannot reach the lenient comparison", () => {
  // The bug was one function answering two questions. These are the call sites
  // that ask about authority; the same-site comparison belongs only to the
  // navigation-landing question and must not drift back into them.
  for (const file of [
    "app/api/site-agents/[siteAgentId]/connection/route.ts",
    "lib/console/install-readiness.ts",
    "db/agent-run-store.ts",
  ]) {
    const source = readFileSync(`${ROOT}${file}`, "utf8");
    assert.doesNotMatch(source, /sameSiteLanding/,
      `${file} 问的是授权，不能用落点比较`);
  }
});

test("the landing comparison is still same-site, and still used for landing", () => {
  const source = readFileSync(`${ROOT}lib/site-knowledge/site-address.ts`, "utf8");
  assert.match(source, /sameSiteLanding\(/,
    "落点改写仍应使用同站比较：任务走到自家子域并没有离开这个网站");
});
