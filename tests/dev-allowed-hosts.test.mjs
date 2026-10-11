import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

// `npm run dev` binds 0.0.0.0 so a cloud workspace can reach it; Vite refuses
// an unknown hostname unless the config names it, which is what makes the
// console answer "Blocked request" in a development container.
async function devAllowedHosts(environment) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../vite.config.ts", import.meta.url))],
    bundle: false, platform: "node", format: "esm", write: false,
  });
  // Only the helper is loaded: the rest of the config imports the Cloudflare
  // plugin and the hosting bindings, which a unit test must not pull in.
  const source = result.outputFiles[0].text;
  const start = source.indexOf("function devAllowedHosts");
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end + 3);
  assert.match(body, /SITEWAKE_DEV_ALLOWED_HOSTS/, "the helper source was not isolated");
  const module = await import(`data:text/javascript;base64,${Buffer.from(`${body}\nexport { devAllowedHosts };`).toString("base64")}`);
  const keys = ["SITEWAKE_DEV_ALLOWED_HOSTS", "SITEWAKE_PUBLIC_ORIGIN", "SITEWAKE_PUBLIC_HOSTNAME", "SITEWAKE_LOCAL_URL"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, environment);
    return module.devAllowedHosts();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("the dev server answers at every hostname this deployment names for itself", async () => {
  assert.deepEqual(await devAllowedHosts({}), [], "a plain local run needs nothing: Vite already allows localhost and IPs");
  assert.deepEqual(
    await devAllowedHosts({ SITEWAKE_PUBLIC_ORIGIN: "https://workspace-3000.example.run" }),
    ["workspace-3000.example.run"],
  );
  assert.deepEqual(
    await devAllowedHosts({ SITEWAKE_DEV_ALLOWED_HOSTS: "one.example.com, two.example.com", SITEWAKE_LOCAL_URL: "http://three.example.com:3000" }),
    ["one.example.com", "two.example.com", "three.example.com"],
  );
  assert.equal(await devAllowedHosts({ SITEWAKE_DEV_ALLOWED_HOSTS: "all" }), true);
  assert.equal(await devAllowedHosts({ SITEWAKE_DEV_ALLOWED_HOSTS: "*" }), true);
});

test("local development serves the SDK's own files cross-site", async () => {
  // The dev server refuses cross-site no-cors requests, which is right for the
  // console and wrong for these three: they exist to be loaded by another
  // origin's page. Without this a developer running their site on another port
  // gets 403 for the install snippet — the one pairing that works without a
  // public address.
  const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /function sdkAssets\(\)/);
  assert.match(config, /"\/sitewake\.js":/);
  assert.match(config, /"\/sitewake-adaptive\.js":/);
  assert.match(config, /"\/sitewake\.css":/);
  assert.match(config, /"access-control-allow-origin": "\*"/);
  // Before vinext, or its guard answers first.
  assert.ok(config.indexOf("sdkAssets(),") < config.indexOf("vinext(),"), "必须排在 vinext 之前");
  assert.match(config, /apply: "serve" as const/, "只在开发时生效");
});
