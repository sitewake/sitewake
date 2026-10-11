import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadOptionalInternalModule } from "../scripts/optional-internal-module.mjs";

const demoSitesModule = new URL("../scripts/internal/demo-sites.mjs", import.meta.url);

test("local development exposes the control plane to the LAN and starts one enrolled runner", async () => {
  const [source, viteConfig, packageSource] = await Promise.all([
    readFile(new URL("../scripts/dev-local.mjs", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(source, /waitForHealth\(\)/);
  assert.match(source, /const localEndpoint = .*`http:\/\/localhost:\$\{port\}`/);
  assert.match(source, /const listenHost = "0\.0\.0\.0"/);
  assert.match(source, /"dev",\s*"--hostname",\s*listenHost,\s*"--port",\s*port/s);
  assert.match(source, /"--port",\s*port,\s*"--strictPort"/);
  assert.match(source, /SITEWAKE_CONTROL_PLANE_URL:\s*localEndpoint/);
  assert.match(source, /SITEWAKE_BROWSER_PUBLIC_URL:\s*localEndpoint/);
  assert.match(source, /const localRunnerId = `local-dev-\$\{port\}`/);
  assert.match(source, /SITEWAKE_RUNNER_ID:\s*localRunnerId/);
  assert.match(source, /SITEWAKE_RUNNER_ROLE:\s*"any"/);
  assert.match(source, /SITEWAKE_RUNNER_PREWARM:\s*"0"/);
  assert.match(source, /SITEWAKE_RUNNER_CONCURRENCY:\s*"1"/);
  assert.match(source, /局域网访问控制台/);
  assert.doesNotMatch(source, /\.env\.deploy\.local/);
  const pkg = JSON.parse(packageSource);
  assert.match(pkg.scripts["dev:server"], /scripts\/dev-local\.mjs/);
  assert.match(pkg.scripts["dev:control-plane"], /dev --hostname 0\.0\.0\.0 --port 3000 --strictPort/);
  assert.match(viteConfig, /"SITEWAKE_RUNNER_ENROLLMENT_TOKEN"/);
  // The local Worker runtime only sees listed variables: the model proxy's token must be one of them.
  assert.match(viteConfig, /"CAPABILITY_V2_DISPATCH_TOKEN"/);
  assert.match(viteConfig, /command === "serve" \? \{ vars: localRunnerVars\(\) \}/);
});

test("local orchestration refuses a split-brain port and waits for the runner bound to that control plane", async () => {
  const source = await readFile(new URL("../scripts/dev-local.mjs", import.meta.url), "utf8");
  assert.match(source, /assertPortAvailable\(port\)/);
  assert.match(source, /local_runner_not_ready/);
  assert.match(source, /waitForRunnerReady\(localEndpoint, localRunnerId\)/);
  assert.match(source, /SITEWAKE_CONTROL_PLANE_URL:\s*localEndpoint/);
  assert.match(source, /SITEWAKE_RUNNER_ID:\s*localRunnerId/);
  assert.match(source, /lastHeartbeatAt|heartbeatAt/);
});

test("local development runner receives the project-local Codex CLI explicitly", async () => {
  const [devSource, runnerSource] = await Promise.all([
    readFile(new URL("../scripts/dev-local.mjs", import.meta.url), "utf8"),
    readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8"),
  ]);
  assert.match(devSource, /node_modules", "@openai", "codex", "bin", "codex\.js"/);
  assert.doesNotMatch(devSource, /const codex = executable\("codex"\)/);
  assert.match(devSource, /SITEWAKE_CODEX_BIN:\s*codex/);
  assert.match(runnerSource, /codexBin:\s*process\.env\.SITEWAKE_CODEX_BIN/);
});

test("one dev command checks the environment and, when the maintainers' demo sites exist, serves and registers them", async () => {
  const source = await readFile(new URL("../scripts/dev-local.mjs", import.meta.url), "utf8");

  // Everything is checked before any child process starts, so a missing browser
  // or model credential is reported instead of failing deep inside a run.
  const preflightAt = source.indexOf("await preflight()");
  const firstSpawnAt = source.indexOf("start(node,");
  assert.ok(preflightAt > 0, "dev 必须先执行启动前检查");
  assert.ok(preflightAt < firstSpawnAt, "启动前检查必须早于任何子进程");
  // What this machine is missing and dev can install itself is installed before
  // anything is reported; the report is rendered in the terminal's language.
  assert.match(source, /repairPreflight\(await preflight\(\), \{ locale, log: console\.error \}\)/);
  assert.match(source, /if \(!reportPreflight\(issues, console\.error, locale\)\)/);

  // Demo sites live under scripts/internal/, which a public checkout does not
  // have. They are loaded optionally, never imported statically.
  assert.doesNotMatch(source, /^import .* from "\.\/(internal\/)?(demo-sites|seed-demo-sites)\.mjs";/m);
  assert.match(source, /loadOptionalInternalModule\("\.\/internal\/demo-sites\.mjs", import\.meta\.url\)/);
  assert.match(source, /demoSitesModule \? await demoSitesModule\.loadDemoSites\(\) : \[\]/);
  // Serving, seeding and the "demos" child all sit inside the same guard.
  const guardAt = source.indexOf("if (demoSitesModule) {");
  const serveAt = source.indexOf("start(node, [demoSiteServer]");
  const seedAt = source.indexOf("await seedDemoSites({ endpoint: localEndpoint");
  const readyAt = source.indexOf("readyTable(demoSites)");
  assert.ok(guardAt > 0 && guardAt < serveAt && serveAt < seedAt, "起站与登记必须只在演示站模块存在时发生");
  assert.ok(readyAt > seedAt, "登记必须发生在宣告就绪之前");
  assert.match(source, /scripts", "internal", "serve-demo-sites\.mjs"/);

  // Each child is labelled so five processes sharing one terminal stay legible.
  for (const label of ['label: "cp"', 'label: "runner"', 'label: "launcher"', 'label: "demos"']) {
    assert.ok(source.includes(label), `子进程缺少日志前缀：${label}`);
  }
  assert.match(source, /pipeWithPrefix/);

  // A crash names the component that died before stopping the rest.
  assert.match(source, /意外退出，正在停止其余组件/);
});

test("preflight loads the demo sites optionally and derives the control plane URL without them", async () => {
  const source = await readFile(new URL("../scripts/preflight.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "\.\/(internal\/)?demo-sites\.mjs"/);
  assert.match(source, /from "\.\/local-endpoint\.mjs"/);
  assert.match(source, /loadOptionalInternalModule\("\.\/internal\/demo-sites\.mjs", import\.meta\.url\)/);
  assert.match(source, /demoSitesModule \? await demoSitesModule\.loadDemoSites\(\) : \[\]/);
});

test("an absent internal module is null; a present one that fails to load still throws", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "sitewake-optional-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const importer = pathToFileURL(join(dir, "importer.mjs")).href;

  // Missing module: the public checkout case.
  assert.equal(await loadOptionalInternalModule("./internal/demo-sites.mjs", importer), null);

  // Present module whose own dependency is missing: a real defect, not absence.
  await writeFile(join(dir, "broken.mjs"), 'import "./does-not-exist.mjs";\nexport const ok = true;\n');
  await assert.rejects(loadOptionalInternalModule("./broken.mjs", importer), { code: "ERR_MODULE_NOT_FOUND" });

  // Present module with a syntax error: also a real defect.
  await writeFile(join(dir, "syntax.mjs"), "export const = ;\n");
  await assert.rejects(loadOptionalInternalModule("./syntax.mjs", importer), SyntaxError);

  // Present and healthy: returned as-is.
  await writeFile(join(dir, "fine.mjs"), "export const sites = 3;\n");
  assert.equal((await loadOptionalInternalModule("./fine.mjs", importer)).sites, 3);
});

test("a corrupt demo-site manifest is reported, not treated as no demo sites", async (t) => {
  if (!existsSync(demoSitesModule)) {
    t.skip("scripts/internal/demo-sites.mjs is not part of this checkout");
    return;
  }
  const { loadDemoSites } = await import(demoSitesModule.href);
  const dir = await mkdtemp(join(tmpdir(), "sitewake-manifest-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "demo-sites.json"), "{ not json");
  await assert.rejects(loadDemoSites({ manifest: join(dir, "demo-sites.json") }), /demo_site_manifest_unreadable/);
});

test("the local runner and launcher call the model through the control plane, never with a key of their own", async () => {
  const source = await readFile(new URL("../scripts/dev-local.mjs", import.meta.url), "utf8");
  assert.match(source, /SITEWAKE_MODEL_PROXY_URL: `\$\{localEndpoint\}\/api\/internal\/model`/);
  assert.match(source, /MODEL_API_KEY: "", MODEL_BASE_URL: "", MODEL: "", MODEL_EXECUTION: "", MODEL_SEMANTIC: "",\s*OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: ""/);
  const launcherBlock = source.slice(source.indexOf('label: "launcher"'), source.indexOf("const capabilityLauncherExit"));
  const runnerBlock = source.slice(source.indexOf('label: "runner"'), source.indexOf("const runnerExit"));
  assert.match(launcherBlock, /\.\.\.modelProxyEnv/);
  assert.match(runnerBlock, /\.\.\.modelProxyEnv/);
  const controlPlaneBlock = source.slice(source.indexOf('label: "cp"'), source.indexOf("const serverExit"));
  assert.doesNotMatch(controlPlaneBlock, /modelProxyEnv|SITEWAKE_MODEL_PROXY_URL/, "the control plane is the key holder, not a proxy client");
});
