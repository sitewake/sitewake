/**
 * `./setup` decides how to run the wizard. Exercised with fake `node` and
 * `docker` executables on a private PATH: each fake records the argv it was
 * called with, so the test can assert on the exact command without needing a
 * real Docker daemon or a second Node version.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SETUP = join(ROOT, "setup");

/** A PATH with only what the scenario allows: coreutils, plus optional fakes. */
async function fakeBin({ nodeVersion, docker } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sitewake-entrypoint-"));
  const log = join(dir, "calls.log");
  if (nodeVersion) {
    await writeFile(join(dir, "node"), `#!/bin/sh
if [ "$1" = "-p" ]; then echo "${nodeVersion}"; exit 0; fi
printf 'node %s\\n' "$*" >> "${log}"
exit 0
`);
    await chmod(join(dir, "node"), 0o755);
  }
  if (docker) {
    await writeFile(join(dir, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "${log}"
exit 0
`);
    await chmod(join(dir, "docker"), 0o755);
  }
  // Only the tools the script itself calls, linked from wherever this machine
  // keeps them. Putting /usr/bin on the PATH would defeat the scenario on a
  // Linux box (or a CI runner) where node and docker live there too.
  const tools = join(dir, "tools");
  await mkdir(tools);
  for (const name of ["sh", "sed", "head", "awk", "id", "dirname", "hostname", "ipconfig", "uname"]) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    if (found) await symlink(found, join(tools, name));
  }
  const path = `${dir}:${tools}`;
  return {
    dir, log, path,
    calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function runSetup(bin, args, { stdin = "ignore", env = {} } = {}) {
  const cleanEnv = { PATH: bin.path, HOME: process.env.HOME || "/", ...env };
  try {
    const result = await run("/bin/sh", [SETUP, ...args], { env: cleanEnv, stdio: [stdin, "pipe", "pipe"] });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout || "", stderr: error.stderr || "", code: error.code };
  }
}

test("the script is valid POSIX sh and executable", async () => {
  await run("/bin/sh", ["-n", SETUP]);
  const { stdout } = await run("git", ["ls-files", "-s", "setup"], { cwd: ROOT });
  assert.match(stdout, /^100755 /, "setup must be committed with the executable bit");
});

test("Node at or above the floor runs the wizard directly with type stripping", async () => {
  const bin = await fakeBin({ nodeVersion: "22.13.0", docker: true });
  try {
    const { code } = await runSetup(bin, ["--target", "local", "--lang", "en"]);
    assert.equal(code, 0);
    const calls = await bin.calls();
    assert.equal(calls.length, 1, calls.join("\n"));
    assert.match(calls[0], /^node --experimental-strip-types --disable-warning=ExperimentalWarning scripts\/setup\.mjs --target local --lang en$/);
  } finally { await bin.cleanup(); }
});

test("a newer Node also runs directly", async () => {
  const bin = await fakeBin({ nodeVersion: "24.1.0" });
  try {
    const { code } = await runSetup(bin, []);
    assert.equal(code, 0);
    assert.match((await bin.calls())[0], /^node .* scripts\/setup\.mjs$/);
  } finally { await bin.cleanup(); }
});

test("Node below the floor with Docker present runs the wizard in a container", async () => {
  const bin = await fakeBin({ nodeVersion: "20.19.0", docker: true });
  try {
    const { code } = await runSetup(bin, ["--target", "docker"], { env: { LANG: "zh_CN.UTF-8" } });
    assert.equal(code, 0);
    const calls = await bin.calls();
    assert.equal(calls.length, 1, calls.join("\n"));
    const [command] = calls;
    assert.match(command, /^docker run --rm -i /, "no -t when stdin is not a terminal");
    assert.doesNotMatch(command, /run --rm -i -t /);
    assert.match(command, / --user \d+:\d+ /);
    assert.match(command, new RegExp(` -v ${ROOT.replace(/\/$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:/app -w /app `));
    assert.match(command, / -e LANG -e LC_ALL -e LANGUAGE /);
    assert.match(command, / -e SITEWAKE_SETUP_RUNNER=docker /);
    assert.match(command, / -e SITEWAKE_SETUP_HOST_IP=\S* /, "host IP is passed even when detection found nothing");
    assert.match(command, / node:22-alpine node --experimental-strip-types --disable-warning=ExperimentalWarning scripts\/setup\.mjs --target docker$/);
  } finally { await bin.cleanup(); }
});

test("without Node at all, Docker is used", async () => {
  const bin = await fakeBin({ docker: true });
  try {
    const { code } = await runSetup(bin, []);
    assert.equal(code, 0);
    assert.match((await bin.calls())[0], /^docker run /);
  } finally { await bin.cleanup(); }
});

test("with neither, both prerequisites are printed in the terminal's language and nothing is created", async () => {
  const bin = await fakeBin({});
  try {
    const before = await readdir(ROOT);
    const en = await runSetup(bin, [], { env: { LANG: "en_US.UTF-8" } });
    assert.equal(en.code, 2);
    assert.match(en.stderr, /Node\.js >= 22\.13\.0/);
    assert.match(en.stderr, /Docker/);
    const zh = await runSetup(bin, [], { env: { LANG: "zh_CN.UTF-8" } });
    assert.equal(zh.code, 2);
    assert.match(zh.stderr, /Node\.js >= 22\.13\.0/);
    assert.match(zh.stderr, /Docker（/);
    assert.deepEqual(await readdir(ROOT), before, "the entrypoint creates nothing");
  } finally { await bin.cleanup(); }
});

test("the wizard's exit status is the entrypoint's exit status", async () => {
  const bin = await fakeBin({ nodeVersion: "22.13.0" });
  try {
    await writeFile(join(bin.dir, "node"), `#!/bin/sh
if [ "$1" = "-p" ]; then echo "22.13.0"; exit 0; fi
exit 7
`);
    const { code } = await runSetup(bin, ["--target", "bogus"]);
    assert.equal(code, 7);
  } finally { await bin.cleanup(); }
});
