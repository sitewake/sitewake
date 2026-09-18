import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function bundledModule(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { installGuide, installationSnippet, INSTALL_STACKS } = await bundledModule("../lib/console/install-guide.ts");

const ORIGIN = "https://console.sitewake.test";
const SITE_ID = "shop.example.test";

test("every stack carries the same site identifier and the same SDK address", () => {
  assert.deepEqual(INSTALL_STACKS, ["html", "react", "next", "vue"]);
  for (const stack of INSTALL_STACKS) {
    const guide = installGuide(ORIGIN, SITE_ID, stack);
    assert.equal(guide.stack, stack);
    assert.ok(guide.plain.includes(`data-site-agent="${SITE_ID}"`), `${stack} 带本站接入标识`);
    assert.ok(guide.plain.includes(`${ORIGIN}/sitewake.js`), `${stack} 指向同一个 SDK 地址`);
    assert.ok(guide.plain.includes(`data-endpoint="${ORIGIN}"`), `${stack} 回传地址一致`);
    assert.equal(guide.plain, guide.lines.join("\n"), `${stack} 展示与复制内容一致`);
  }
});

test("Next.js gets the framework's script component, never a raw script tag", () => {
  const next = installGuide(ORIGIN, SITE_ID, "next");
  // A raw <script> in an App Router layout is dropped by React — the whole reason this
  // tab exists. Case-sensitive: the lowercase native tag is what to block; `<Script` is
  // exactly the framework component we want.
  assert.doesNotMatch(next.plain, /<script/);
  assert.match(next.plain, /import Script from "next\/script";/);
  assert.match(next.plain, /<Script/);

  // The other three tabs are the paste-ready line.
  for (const stack of ["html", "react", "vue"]) {
    const guide = installGuide(ORIGIN, SITE_ID, stack);
    assert.match(guide.plain, /^<script /);
    assert.match(guide.plain, /defer><\/script>$/);
  }
});

test("the connection settings page keeps the exact snippet it showed before", () => {
  // This string is what overview-metrics.installationSnippet produced before the move, byte for byte.
  assert.equal(
    installationSnippet(ORIGIN, SITE_ID),
    `<script src="${ORIGIN}/sitewake.js" data-site-agent="${SITE_ID}" data-endpoint="${ORIGIN}" defer></script>`,
  );
  // It is the HTML tab, not a separately assembled copy.
  assert.equal(installationSnippet(ORIGIN, SITE_ID), installGuide(ORIGIN, SITE_ID, "html").plain);
});

test("interpolated values are escaped so a hostile identifier cannot break out of the tag", () => {
  const hostile = `a" onload="alert(1)`;
  for (const stack of INSTALL_STACKS) {
    const guide = installGuide(ORIGIN, hostile, stack);
    assert.ok(!guide.plain.includes(`onload="alert(1)`), `${stack} 不放出未转义的引号`);
    assert.ok(guide.plain.includes("&quot;"), `${stack} 把引号转义掉`);
  }
  // Only the origin is taken from the URL; path and query never enter the code.
  assert.match(installationSnippet("https://console.test/some/path?x=1", SITE_ID), /https:\/\/console\.test\/sitewake\.js/);
  assert.doesNotMatch(installationSnippet("https://console.test/some/path?x=1", SITE_ID), /some\/path/);
});

test("the SDK file the flow hands out is covered by the no-cache header rule", async () => {
  // The install URL is stable: developers paste it once and leave it, so that SDK must
  // be revalidated every time or browsers keep the old agent protocol forever. When the
  // rename to SiteWake happened the next.config.ts rule did not follow, so the SDK served
  // under the new name stayed cacheable. This pins both sides together.
  const { readFile } = await import("node:fs/promises");
  const config = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
  const alternation = config.match(/source:\s*"\/:sdk\(([^)]+)\)\.js"/)?.[1];
  assert.ok(alternation, "next.config.ts 里找不到 SDK 缓存规则");
  const covered = new Set(alternation.split("|"));

  // All four tabs ship the same file; compare by its basename.
  for (const stack of INSTALL_STACKS) {
    const src = installGuide(ORIGIN, SITE_ID, stack).plain.match(/https?:\/\/[^"\s]+\/([\w-]+)\.js/)?.[1];
    assert.ok(src, `${stack} 栏里没找到 SDK 文件名`);
    assert.ok(covered.has(src), `${stack} 栏发的是 ${src}.js，但缓存规则没覆盖它：${alternation}`);
  }
});
