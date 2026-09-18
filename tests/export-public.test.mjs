import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExportError, exportPlan, main, nextCommands, precheck, versionOfTag, writeExport } from "../scripts/export-public.mjs";
import { INTERNAL_MARKERS } from "../scripts/public-boundary.mjs";

// The export is exercised end to end on throwaway repositories: a "source"
// with export-ignored paths and a "public clone" whose remote points at the
// public repository. `main` runs with skipChecks so no npm install happens.

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function makeRepo(dir) {
  await mkdir(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "tag.gpgsign", "false");
  return dir;
}

async function commitAll(dir, message) {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

async function makeSource(dir, { version = "1.0.0", changelog = `# Changelog\n\n## ${version} - 2026-01-01\n\n- first\n` } = {}) {
  await makeRepo(dir);
  await writeFile(join(dir, ".gitattributes"), "docs export-ignore\nAGENTS.md export-ignore\nscripts/internal export-ignore\n");
  await writeFile(join(dir, ".gitignore"), ".env.local\ndist/\n");
  await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: "x", version, private: true }, null, 2)}\n`);
  await writeFile(join(dir, "CHANGELOG.md"), changelog);
  await writeFile(join(dir, "README.md"), "# public\n");
  await mkdir(join(dir, "lib"));
  await writeFile(join(dir, "lib", "a.mjs"), "export const a = 1;\n");
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "docs", "secret.md"), "internal notes\n");
  await writeFile(join(dir, "AGENTS.md"), "internal rules\n");
  await mkdir(join(dir, "scripts", "internal"), { recursive: true });
  await writeFile(join(dir, "scripts", "internal", "x.mjs"), "// internal\n");
  await commitAll(dir, "initial");
  // Local files that git never tracks must never travel either.
  await writeFile(join(dir, ".env.local"), "MODEL_API_KEY=sk-secret\n");
  await mkdir(join(dir, "dist"));
  await writeFile(join(dir, "dist", "bundle.js"), "built\n");
  return dir;
}

async function makeTarget(dir) {
  await makeRepo(dir);
  git(dir, "remote", "add", "origin", "https://github.com/sitewake/sitewake.git");
  await writeFile(join(dir, "LICENSE"), "wizard license\n");
  await writeFile(join(dir, "README.md"), "# sitewake\n");
  await commitAll(dir, "Initial commit");
  return dir;
}

function listTracked(dir) {
  return git(dir, "ls-files").split("\n").filter(Boolean).sort();
}

test("only public/vX.Y.Z tags are accepted", () => {
  assert.equal(versionOfTag("public/v1.2.3"), "1.2.3");
  assert.equal(versionOfTag("public/v1.2.3-rc.1"), "1.2.3-rc.1");
  for (const bad of ["v1.2.3", "public/1.2.3", "public/v1.2", "release/v1.2.3", "", undefined]) {
    assert.throws(() => versionOfTag(bad), ExportError, `accepted ${JSON.stringify(bad)}`);
  }
});

test("the printed commands name the release commit and tag exactly", () => {
  assert.deepEqual(nextCommands("1.0.1"), [
    "git add -A",
    'git commit -m "Release v1.0.1"',
    'git tag -a v1.0.1 -m "SiteWake v1.0.1"',
    "git push origin main v1.0.1",
  ]);
});

test("prechecks refuse every unsafe starting point without touching the clone", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sitewake-export-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = await makeSource(join(base, "source"));
  const target = await makeTarget(join(base, "target"));
  const targetBefore = listTracked(target);

  // Tag missing.
  assert.throws(() => precheck({ source, tag: "public/v1.0.0", target }), /does not exist/);

  // Tag present but not at HEAD.
  git(source, "tag", "-a", "public/v1.0.0", "-m", "v1.0.0");
  await writeFile(join(source, "lib", "b.mjs"), "export const b = 2;\n");
  await commitAll(source, "more");
  assert.throws(() => precheck({ source, tag: "public/v1.0.0", target }), /check the tag out first/);
  git(source, "reset", "-q", "--hard", "HEAD~1");

  // Dirty source worktree.
  await writeFile(join(source, "lib", "a.mjs"), "export const a = 2;\n");
  assert.throws(() => precheck({ source, tag: "public/v1.0.0", target }), /uncommitted changes/);
  git(source, "checkout", "--", "lib/a.mjs");

  // package.json version disagrees with the tag.
  git(source, "tag", "-a", "public/v1.0.1", "-m", "v1.0.1");
  assert.throws(() => precheck({ source, tag: "public/v1.0.1", target }), /package.json version is 1.0.0 but the tag names 1.0.1/);

  // CHANGELOG has no entry for the version.
  await writeFile(join(source, "package.json"), `${JSON.stringify({ name: "x", version: "1.0.1", private: true }, null, 2)}\n`);
  await commitAll(source, "bump");
  git(source, "tag", "-f", "-a", "public/v1.0.1", "-m", "v1.0.1");
  assert.throws(() => precheck({ source, tag: "public/v1.0.1", target }), /CHANGELOG.md has no entry for 1.0.1/);
  git(source, "reset", "-q", "--hard", "HEAD~1");
  git(source, "tag", "-d", "public/v1.0.1");

  // No clone given / not a repository / wrong remote / dirty clone.
  assert.throws(() => precheck({ source, tag: "public/v1.0.0", target: undefined }), /no public clone given/);
  const notRepo = join(base, "not-a-repo");
  await mkdir(notRepo);
  assert.throws(() => precheck({ source, tag: "public/v1.0.0", target: notRepo }), /not a git repository/);
  const wrongRemote = await makeRepo(join(base, "wrong-remote"));
  git(wrongRemote, "remote", "add", "origin", "https://example.com/other.git");
  assert.throws(() => precheck({ source, tag: "public/v1.0.0", target: wrongRemote }), /no remote pointing at github.com\/sitewake\/sitewake/);
  await writeFile(join(target, "scratch.txt"), "oops\n");
  assert.throws(() => precheck({ source, tag: "public/v1.0.0", target }), /public clone has uncommitted changes/);
  await rm(join(target, "scratch.txt"));

  // Everything in order.
  assert.deepEqual(precheck({ source, tag: "public/v1.0.0", target }), { version: "1.0.0", commit: git(source, "rev-parse", "HEAD") });
  assert.deepEqual(listTracked(target), targetBefore, "prechecks must not modify the public clone");
});

test("the export carries exactly the archive, replaces the clone's tracked files and removes what the new version dropped", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sitewake-export-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = await makeSource(join(base, "source"));
  const target = await makeTarget(join(base, "target"));
  git(source, "tag", "-a", "public/v1.0.0", "-m", "v1.0.0");

  const plan = exportPlan(source, "public/v1.0.0");
  assert.deepEqual(plan.exported.sort(), [".gitattributes", ".gitignore", "CHANGELOG.md", "README.md", "lib/a.mjs", "package.json"]);
  assert.deepEqual(plan.ignoredTopLevel, ["AGENTS.md", "docs", "scripts"]);

  const result = await main(["public/v1.0.0", "--target", target], { source, skipChecks: true });
  assert.equal(result.dryRun, false);
  git(target, "add", "-A");
  const archived = execFileSync("git", ["archive", "--format=tar", "public/v1.0.0"], { cwd: source })
    .toString("latin1").match(/[\w./-]+\.(mjs|md|json|gitattributes|gitignore)/g);
  // The clone holds the archive's files and nothing else that git tracks:
  // the wizard's LICENSE is gone, docs/, AGENTS.md and scripts/internal never arrived.
  assert.deepEqual(listTracked(target), plan.exported.sort());
  assert.ok(archived.includes("lib/a.mjs"));
  for (const never of [".env.local", "dist/bundle.js", "docs/secret.md", "AGENTS.md", "scripts/internal/x.mjs", "LICENSE"]) {
    assert.ok(!existsSync(join(target, never)), `${never} must not be in the public clone`);
  }
  assert.equal(await readFile(join(target, "README.md"), "utf8"), "# public\n");
  git(target, "commit", "-q", "-m", "Release v1.0.0");

  // Next version drops lib/a.mjs and adds lib/c.mjs: the deletion must reach the clone.
  await rm(join(source, "lib", "a.mjs"));
  await writeFile(join(source, "lib", "c.mjs"), "export const c = 3;\n");
  await writeFile(join(source, "package.json"), `${JSON.stringify({ name: "x", version: "1.1.0", private: true }, null, 2)}\n`);
  await writeFile(join(source, "CHANGELOG.md"), "# Changelog\n\n## 1.1.0 - 2026-02-01\n\n- c\n\n## 1.0.0 - 2026-01-01\n\n- first\n");
  await commitAll(source, "1.1.0");
  git(source, "tag", "-a", "public/v1.1.0", "-m", "v1.1.0");
  await main(["public/v1.1.0", "--target", target], { source, skipChecks: true });
  git(target, "add", "-A");
  const status = git(target, "status", "--porcelain");
  assert.match(status, /^D {2}lib\/a\.mjs$/m);
  assert.match(status, /^A {2}lib\/c\.mjs$/m);
  assert.ok(!existsSync(join(target, "lib", "a.mjs")));
});

test("a dry run reports the plan and leaves the clone untouched", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sitewake-export-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = await makeSource(join(base, "source"));
  const target = await makeTarget(join(base, "target"));
  git(source, "tag", "-a", "public/v1.0.0", "-m", "v1.0.0");
  const before = listTracked(target);
  const result = await main(["public/v1.0.0", "--target", target, "--dry-run"], { source, skipChecks: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.exported.length, 6);
  assert.deepEqual(listTracked(target), before);
  assert.equal(git(target, "status", "--porcelain"), "");
});

test("an internal marker in the exported tree fails verification before any commit is suggested", async (t) => {
  if (!INTERNAL_MARKERS.length) {
    t.skip("no marker list in this checkout");
    return;
  }
  const base = await mkdtemp(join(tmpdir(), "sitewake-export-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = await makeSource(join(base, "source"));
  const target = await makeTarget(join(base, "target"));
  // The marker comes from the shared list so this test file itself stays clean.
  const marker = INTERNAL_MARKERS[0];
  await writeFile(join(source, "lib", "a.mjs"), `// see ${marker}\nexport const a = 1;\n`);
  await commitAll(source, "leak");
  git(source, "tag", "-a", "public/v1.0.0", "-m", "v1.0.0");
  await assert.rejects(main(["public/v1.0.0", "--target", target], { source, skipChecks: true }), new RegExp(`lib/a\\.mjs:1: ${marker}`));
});

test("writeExport keeps the clone's own untracked and ignored files", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "sitewake-export-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = await makeSource(join(base, "source"));
  const target = await makeTarget(join(base, "target"));
  git(source, "tag", "-a", "public/v1.0.0", "-m", "v1.0.0");
  await mkdir(join(target, "node_modules"));
  await writeFile(join(target, "node_modules", "keep.txt"), "installed\n");
  writeExport({ source, tag: "public/v1.0.0", target });
  assert.ok(existsSync(join(target, "node_modules", "keep.txt")));
  assert.ok(existsSync(join(target, ".git")));
});
