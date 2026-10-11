/**
 * The stub helper, and why it reads the real module instead of being written out.
 *
 * `management-api-auth` failed for weeks with
 * `No matching export in "app/api/site-agents/http.ts" for import
 * "persistenceHeaders"` — an esbuild error that reads like the product failing to
 * build, while `persistenceHeaders` was exported on line 156 of the real file the
 * whole time. The stub replacing that module had been written by hand and never
 * updated.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportedNames, stubModule } from "./support/module-stub.mjs";

async function moduleFile(source) {
  const dir = await mkdtemp(join(tmpdir(), "sitewake-stub-"));
  const path = join(dir, "module.ts");
  await writeFile(path, source, "utf8");
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("the names come from the module, in every form it can export them", async (t) => {
  const { path, cleanup } = await moduleFile(`
export function first() {}
export async function second() {}
export const third = 1;
export class Fourth {}
function helper() {}
export { helper };
export { helper as fifth };
const hidden = 2;
`);
  t.after(cleanup);
  assert.deepEqual(exportedNames(path).sort(), ["Fourth", "fifth", "first", "helper", "second", "third"]);
});

test("an export the test says nothing about exists, and says so if it is called", async (t) => {
  // The whole point: a new export in the real module arrives here harmlessly, so
  // the bundle still builds. If something does call it, the message names it —
  // rather than answering undefined, which is how a route came to return 500
  // with nothing pointing at the cause.
  const { path, cleanup } = await moduleFile("export function known() {}\nexport function addedLater() {}\n");
  t.after(cleanup);
  const stub = stubModule(path, { known: "export function known() { return 7; }" });
  assert.match(stub, /export function known\(\) \{ return 7; \}/);
  assert.match(stub, /export function addedLater\(\)/,
    "真实模块后来新增的导出必须有一个替身，否则 esbuild 会报 No matching export");

  const loaded = await import(`data:text/javascript;base64,${Buffer.from(stub).toString("base64")}`);
  assert.equal(loaded.known(), 7);
  assert.throws(() => loaded.addedLater(), /addedLater is stubbed with no body/);
});

test("stubbing a name the module no longer exports is itself reported", async (t) => {
  // Drift in the other direction: the stub holding an opinion about something gone.
  const { path, cleanup } = await moduleFile("export function stillHere() {}\n");
  t.after(cleanup);
  assert.throws(
    () => stubModule(path, { goneAway: "export function goneAway() {}" }),
    /no longer exports goneAway/,
  );
});

test("the module that started this is covered by its own real exports", () => {
  // Not a fixture: the actual file, so that adding an export to it cannot
  // reintroduce the failure this helper exists to prevent.
  const names = exportedNames(new URL("../app/api/site-agents/http.ts", import.meta.url));
  assert.ok(names.includes("persistenceHeaders"),
    "persistenceHeaders 必须在真实导出里 —— 它就是那条看起来像产品构建失败的报错的来源");
  assert.ok(names.includes("siteAgentJson"));
});

test("a repository path with a space in it is still a path", async () => {
  // The helper took a percent-encoded `URL.pathname` and handed it to
  // readFileSync. Everything passed until the public clone sat in a directory
  // called "SiteWake Github", where the space arrived as %20 and the file could
  // not be opened — a suite that fails for anyone who clones into a path with a
  // space, which no amount of running it here would have revealed.
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = await mkdtemp(join(tmpdir(), "sitewake-space-"));
  const directory = join(base, "with space");
  await mkdir(directory, { recursive: true });
  const file = join(directory, "module.ts");
  await writeFile(file, "export function alpha() {}\nexport const beta = 1;\n");
  try {
    assert.deepEqual(exportedNames(file).sort(), ["alpha", "beta"]);
    assert.deepEqual(exportedNames(new URL(`file://${encodeURI(file)}`)).sort(), ["alpha", "beta"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
