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
if [ "$1" = "compose" ] && [ "$2" = "config" ]; then echo "ghcr.io/sitewake/sitewake-control-plane:1.0.0"; fi
exit 0
`);
    await chmod(join(dir, "docker"), 0o755);
  }
  // Only the tools the script itself calls, linked from wherever this machine
  // keeps them. Putting /usr/bin on the PATH would defeat the scenario on a
  // Linux box (or a CI runner) where node and docker live there too.
  const tools = join(dir, "tools");
  await mkdir(tools);
  for (const name of ["sh", "sed", "head", "awk", "cat", "id", "dirname", "hostname", "ipconfig", "uname", "tr", "grep", "rm", "mktemp", "od", "sleep"]) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    if (found) await symlink(found, join(tools, name));
  }
  const path = `${dir}:${tools}`;
  return {
    dir, log, path,
    // `docker info` (is Docker usable at all), `docker volume ls` (volumes an
    // earlier install left behind) and `docker compose config` (which images this
    // release names) are the wrapper's read-only probes; the calls of interest
    // are what runs the wizard.
    calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
      .filter((line) => !line.startsWith("docker volume ls") && !line.startsWith("docker compose config") && line !== "docker info"),
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
  // Volumes left by an earlier install reach the wizard on both paths, so it
  // can warn before a freshly generated database password locks the user out.
  const source = await readFile(SETUP, "utf8");
  assert.match(source, /export SITEWAKE_SETUP_EXISTING_VOLUMES/);
  assert.match(source, /-e SITEWAKE_SETUP_EXISTING_VOLUMES \\/);
  const { stdout } = await run("git", ["ls-files", "-s", "setup"], { cwd: ROOT });
  assert.match(stdout, /^100755 /, "setup must be committed with the executable bit");
});

test("Node at or above the floor runs the wizard directly with type stripping", async () => {
  const bin = await fakeBin({ nodeVersion: "22.13.0", docker: true });
  try {
    const { code } = await runSetup(bin, ["--no-start", "--lang", "en"]);
    assert.equal(code, 0);
    const calls = await bin.calls();
    assert.equal(calls.length, 1, calls.join("\n"));
    assert.match(calls[0], /^node --experimental-strip-types --disable-warning=ExperimentalWarning scripts\/setup\.mjs --no-start --lang en$/);
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
    const { code } = await runSetup(bin, ["--lang", "zh"], { env: { LANG: "zh_CN.UTF-8" } });
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
    // The report reads these two from its environment; the container must get them too.
    assert.match(command, / -e SITEWAKE_SETUP_HEALTH_JSON -e SITEWAKE_SETUP_EVENTS /);
    assert.match(command, / node:22-alpine node --experimental-strip-types --disable-warning=ExperimentalWarning scripts\/setup\.mjs --lang zh$/);
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

test("Docker present but not usable by this user names the cause and the fix, in the terminal's language", async () => {
  const bin = await fakeBin({ nodeVersion: "22.13.0", docker: true });
  try {
    // A fresh Ubuntu: docker is installed, the account is not in the docker group.
    await writeFile(join(bin.dir, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "${bin.log}"
if [ "$1" = "info" ]; then echo "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock" >&2; exit 1; fi
exit 0
`);
    await chmod(join(bin.dir, "docker"), 0o755);
    const en = await runSetup(bin, ["--lang", "en"], { env: { LANG: "en_US.UTF-8" } });
    assert.equal(en.code, 2);
    assert.match(en.stderr, /not allowed to use it/);
    assert.match(en.stderr, /sudo usermod -aG docker \S+ , then log out and back in/);
    const zh = await runSetup(bin, ["--lang", "zh"], { env: { LANG: "zh_CN.UTF-8" } });
    assert.equal(zh.code, 2);
    assert.match(zh.stderr, /没有权限使用它/);
    assert.match(zh.stderr, /sudo usermod -aG docker/);
    assert.ok(!(await bin.calls()).some((c) => /scripts\/setup\.mjs/.test(c)), "the wizard is not started");
    await assert.rejects(readFile(join(ROOT, ".sitewake-setup-start")));

    // The daemon is simply not running: a different message, same exit.
    await writeFile(join(bin.dir, "docker"), `#!/bin/sh
if [ "$1" = "info" ]; then echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1; fi
exit 0
`);
    const down = await runSetup(bin, ["--lang", "en"], { env: { LANG: "en_US.UTF-8" } });
    assert.equal(down.code, 2);
    assert.match(down.stderr, /not usable right now: Cannot connect to the Docker daemon/);
    assert.match(down.stderr, /Start Docker, then run \.\/setup again/);
  } finally { await bin.cleanup(); }
});

test("with sudo at hand, ./setup adds the user to the docker group itself and carries on under sg", async () => {
  const bin = await fakeBin({ nodeVersion: "22.13.0", docker: true });
  try {
    // docker refuses until the group is in place (the fake sg sets the flag as a real one would grant the group).
    await writeFile(join(bin.dir, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "${bin.log}"
if [ "$1" = "info" ] && [ -z "$SITEWAKE_TEST_DOCKER_OK" ]; then echo "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock" >&2; exit 1; fi
exit 0
`);
    await writeFile(join(bin.dir, "sudo"), `#!/bin/sh
printf 'sudo %s\\n' "$*" >> "${bin.log}"
exit 0
`);
    await writeFile(join(bin.dir, "sg"), `#!/bin/sh
printf 'sg %s\\n' "$*" >> "${bin.log}"
export SITEWAKE_TEST_DOCKER_OK=1
exec sh -c "$3"
`);
    for (const name of ["docker", "sudo", "sg"]) await chmod(join(bin.dir, name), 0o755);
    const { code, stderr } = await runSetup(bin, ["--no-start", "--lang", "en"], { env: { LANG: "en_US.UTF-8" } });
    assert.equal(code, 0, stderr);
    assert.match(stderr, /Added \S+ to the docker group; continuing\./);
    const calls = await bin.calls();
    assert.ok(calls.some((c) => /^sudo -n usermod -aG docker \S+$/.test(c)), calls.join("\n"));
    assert.ok(calls.some((c) => /^sg docker -c sh '.*setup' '--no-start' '--lang' 'en'$/.test(c)), calls.join("\n"));
    assert.match(calls[calls.length - 1], /^node .* scripts\/setup\.mjs --no-start --lang en$/, "the wizard then runs with the original arguments");
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

test("after the wizard asks for a start, the entrypoint runs docker compose up, waits, and prints the report", async () => {
  const bin = await fakeBin({ nodeVersion: "22.13.0", docker: true });
  try {
    // A fake wizard: writes .env (project name + port), leaves the start marker
    // in the repo root, and logs its own invocations like the other fakes.
    await writeFile(join(bin.dir, "node"), `#!/bin/sh
if [ "$1" = "-p" ]; then echo "22.13.0"; exit 0; fi
printf 'node %s\\n' "$*" >> "${bin.log}"
case "$*" in
  *--report*) exit 0;;
  *) printf 'en\\n' > .sitewake-setup-start; exit 0;;
esac
`);
    await chmod(join(bin.dir, "node"), 0o755);
    const envBackup = await readFile(join(ROOT, ".env"), "utf8").catch(() => null);
    try {
      await writeFile(join(ROOT, ".env"), "COMPOSE_PROJECT_NAME=sitewake-test\nSITEWAKE_PORT=3456\n");
      const { code, stdout } = await runSetup(bin, [], { env: { LANG: "en_US.UTF-8" } });
      assert.equal(code, 0, stdout);
      const calls = await bin.calls();
      assert.match(calls[0], /^node .* scripts\/setup\.mjs$/);
      assert.ok(calls.some((c) => /^docker ps --filter publish=3456 /.test(c)), "the port is checked for another install first");
      // The registry answered for this release's image: pulled, no build, and
      // nobody was asked for an account — a published image needs none.
      assert.ok(calls.includes("docker manifest inspect ghcr.io/sitewake/sitewake-control-plane:1.0.0"), calls.join("\n"));
      assert.ok(!calls.some((c) => c.startsWith("docker login")), "a reachable image is pulled without signing in");
      assert.ok(calls.includes("docker compose pull"), calls.join("\n"));
      assert.ok(calls.includes("docker compose up -d --no-build"), calls.join("\n"));
      assert.ok(!calls.some((c) => c.includes("--build")), "nothing is built when the pull succeeds");
      assert.match(calls[calls.length - 1], /^node .* scripts\/setup\.mjs --report --lang en$/, "the report comes last, in the wizard's language");
      await assert.rejects(readFile(join(ROOT, ".sitewake-setup-start")), "the marker is consumed");

      // The registry says no (packages private, offline, version not published):
      // build from source without spraying pull errors first, and say so in the report.
      await writeFile(join(bin.dir, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "${bin.log}"
if [ "$1" = "compose" ] && [ "$2" = "config" ]; then echo "ghcr.io/sitewake/sitewake-control-plane:1.0.0"; fi
if [ "$1" = "manifest" ]; then echo "unauthorized" >&2; exit 1; fi
if [ "$1" = "compose" ] && [ "$2" = "pull" ]; then echo "must not pull when the probe failed" >&2; exit 1; fi
if [ "$1" = "compose" ] && [ "$2" = "up" ]; then
  case "$*" in *--no-build*) echo "must not run without images" >&2; exit 1;; esac
  printf 'npm_registry=%s\\n' "$SITEWAKE_NPM_REGISTRY" >> "${bin.log}"
fi
exit 0
`);
      await chmod(join(bin.dir, "docker"), 0o755);
      // A machine whose route to npm's own registry crawls: the build is
      // pointed at the mirror the measurement found clearly faster. The
      // fake curl answers only the two registry probes and the health poll
      // (degraded on the first ask, ready on the second), like a host with
      // no cloud metadata service. sleep is faked so the poll's wait is free.
      await writeFile(join(bin.dir, "curl"), `#!/bin/sh
for arg do
  case "$arg" in
    https://registry.npmjs.org/*) printf '48000.000'; exit 28;;
    https://registry.npmmirror.com/*) printf '9500000.000'; exit 0;;
    */api/health)
      if [ -f "${bin.dir}/health-asked" ]; then printf '{"status":"ready","services":{"database":"ready"}}'; else : > "${bin.dir}/health-asked"; printf '{"status":"degraded","services":{"database":"ready"}}'; fi
      exit 0;;
  esac
done
exit 22
`);
      await chmod(join(bin.dir, "curl"), 0o755);
      await writeFile(join(bin.dir, "sleep"), "#!/bin/sh\nexit 0\n");
      await chmod(join(bin.dir, "sleep"), 0o755);
      await writeFile(join(bin.dir, "node"), `#!/bin/sh
if [ "$1" = "-p" ]; then echo "22.13.0"; exit 0; fi
printf 'node %s\\n' "$*" >> "${bin.log}"
case "$*" in
  *--report*) printf 'events=%s\\n' "$SITEWAKE_SETUP_EVENTS" >> "${bin.log}"; printf 'health=%s\\n' "$SITEWAKE_SETUP_HEALTH_JSON" >> "${bin.log}"; exit 0;;
  *) printf 'en\\n' > .sitewake-setup-start; exit 0;;
esac
`);
      await chmod(join(bin.dir, "node"), 0o755);
      const fallback = await runSetup(bin, [], { env: { LANG: "en_US.UTF-8" } });
      assert.equal(fallback.code, 0, fallback.stdout + fallback.stderr);
      const later = (await bin.calls()).slice(calls.length);
      assert.ok(later.includes("docker manifest inspect ghcr.io/sitewake/sitewake-control-plane:1.0.0"), later.join("\n"));
      assert.ok(!later.includes("docker compose pull"), "no pull is attempted once the probe failed");
      assert.ok(later.includes("docker compose up -d --build"), later.join("\n"));
      assert.ok(!later.includes("docker compose up -d --no-build"));
      assert.match(fallback.stderr, /Building SiteWake for this machine/, "a build is announced as progress, never as a failed pull");
      assert.doesNotMatch(fallback.stderr, /not reachable|could not|failed/i);
      assert.ok(later.includes("npm_registry=https://registry.npmmirror.com"), later.join("\n"));
      // The report gets the health JSON alone — the waiting line and its dots
      // belong to the terminal, or JSON.parse would fail and every install
      // would be reported as "not ready".
      assert.ok(later.includes('health={"status":"ready","services":{"database":"ready"}}'), later.join("\n"));
      assert.match(fallback.stderr, /Waiting for the control plane on port 3456 \.\n/, "one dot for the one degraded answer");
      assert.match(fallback.stderr, /npm registry: https:\/\/registry\.npmmirror\.com/, "the chosen registry is named");
    } finally {
      if (envBackup === null) await rm(join(ROOT, ".env"), { force: true });
      else await writeFile(join(ROOT, ".env"), envBackup);
    }
  } finally { await bin.cleanup(); }
});

test("a published image is pulled even when this machine still holds a stale registry login", async () => {
  const bin = await fakeBin({ nodeVersion: "22.13.0", docker: true });
  try {
    await writeFile(join(bin.dir, "node"), `#!/bin/sh
if [ "$1" = "-p" ]; then echo "22.13.0"; exit 0; fi
printf 'node %s\\n' "$*" >> "${bin.log}"
case "$*" in
  *--report*) exit 0;;
  *) printf 'en\\n' > .sitewake-setup-start; exit 0;;
esac
`);
    await chmod(join(bin.dir, "node"), 0o755);
    // The image is public; the expired credential this machine stored earlier
    // is what the registry refuses. Docker presents it unless the store is empty.
    await writeFile(join(bin.dir, "docker"), `#!/bin/sh
printf 'docker%s %s\\n' "\${DOCKER_CONFIG:+ [no-credentials]}" "$*" >> "${bin.log}"
if [ "$1" = "compose" ] && [ "$2" = "config" ]; then echo "ghcr.io/sitewake/sitewake-control-plane:1.0.0"; fi
if [ -z "\${DOCKER_CONFIG:-}" ]; then
  case "$1" in manifest) echo "unauthorized" >&2; exit 1;; compose) case "$2" in pull) echo "unauthorized" >&2; exit 1;; esac;; esac
fi
exit 0
`);
    await chmod(join(bin.dir, "docker"), 0o755);
    const envBackup = await readFile(join(ROOT, ".env"), "utf8").catch(() => null);
    try {
      await writeFile(join(ROOT, ".env"), "COMPOSE_PROJECT_NAME=sitewake-test\nSITEWAKE_PORT=3456\n");
      const { code, stdout, stderr } = await runSetup(bin, [], { env: { LANG: "en_US.UTF-8" } });
      assert.equal(code, 0, stdout + stderr);
      const calls = await bin.calls();
      assert.ok(calls.includes("docker [no-credentials] compose pull"), calls.join("\n"));
      assert.ok(calls.includes("docker [no-credentials] compose up -d --no-build"), calls.join("\n"));
      assert.ok(!calls.some((c) => c.includes("--build")), "nothing is built");
      assert.ok(!calls.some((c) => c.startsWith("docker login")), "a public image is never a reason to sign in");
      assert.ok(!calls.some((c) => c.includes("--build")), "nothing is built");
      assert.doesNotMatch(stderr, /unauthorized|credential|login/i, "the reader is not told about any of this");
    } finally {
      if (envBackup === null) await rm(join(ROOT, ".env"), { force: true });
      else await writeFile(join(ROOT, ".env"), envBackup);
    }
  } finally { await bin.cleanup(); }
});

test("a probe that answers but a pull that cannot fetch is retried once with a credential", async () => {
  const bin = await fakeBin({ nodeVersion: "22.13.0", docker: true });
  try {
    await writeFile(join(bin.dir, "node"), `#!/bin/sh
if [ "$1" = "-p" ]; then echo "22.13.0"; exit 0; fi
printf 'node %s\\n' "$*" >> "${bin.log}"
case "$*" in
  *--report*) exit 0;;
  *) printf 'en\\n' > .sitewake-setup-start; exit 0;;
esac
`);
    await chmod(join(bin.dir, "node"), 0o755);
    // Docker Desktop answers a manifest probe from its own credential helper
    // even with an empty store; the pull that follows is still refused.
    await writeFile(join(bin.dir, "docker"), `#!/bin/sh
printf 'docker%s %s\\n' "\${DOCKER_CONFIG:+ [no-credentials]}" "$*" >> "${bin.log}"
if [ "$1" = "compose" ] && [ "$2" = "config" ]; then echo "ghcr.io/sitewake/sitewake-control-plane:1.0.0"; fi
if [ "$1" = "manifest" ]; then [ -n "\${DOCKER_CONFIG:-}" ] || exit 1; fi
if [ "$1" = "compose" ] && [ "$2" = "pull" ]; then [ -f "${bin.dir}/signed-in" ] || exit 1; fi
if [ "$1" = "login" ]; then cat > /dev/null; : > "${bin.dir}/signed-in"; fi
exit 0
`);
    await chmod(join(bin.dir, "docker"), 0o755);
    const envBackup = await readFile(join(ROOT, ".env"), "utf8").catch(() => null);
    try {
      await writeFile(join(ROOT, ".env"), "COMPOSE_PROJECT_NAME=sitewake-test\nSITEWAKE_PORT=3456\n");
      const { code, stdout, stderr } = await runSetup(bin, [], { env: { LANG: "en_US.UTF-8", GITHUB_TOKEN: "tester-token" } });
      assert.equal(code, 0, stdout + stderr);
      const calls = await bin.calls();
      assert.ok(calls.includes("docker [no-credentials] compose pull"), "the anonymous pull is attempted first");
      assert.ok(calls.some((c) => c.startsWith("docker login")), "then the credential is used");
      assert.ok(calls.includes("docker compose pull") && calls.includes("docker compose up -d --no-build"), calls.join("\n"));
      assert.ok(!calls.some((c) => c.includes("--build")), "the published images are used after the retry");
    } finally {
      if (envBackup === null) await rm(join(ROOT, ".env"), { force: true });
      else await writeFile(join(ROOT, ".env"), envBackup);
    }
  } finally { await bin.cleanup(); }
});

test("a private image is reached with the credential the clone already used, without asking again", async () => {
  const bin = await fakeBin({ nodeVersion: "22.13.0", docker: true });
  try {
    await writeFile(join(bin.dir, "node"), `#!/bin/sh
if [ "$1" = "-p" ]; then echo "22.13.0"; exit 0; fi
printf 'node %s\\n' "$*" >> "${bin.log}"
case "$*" in
  *--report*) exit 0;;
  *) printf 'en\\n' > .sitewake-setup-start; exit 0;;
esac
`);
    await chmod(join(bin.dir, "node"), 0o755);
    // git holds what `git clone` used for github.com; the environment and the
    // gh CLI hold nothing.
    await writeFile(join(bin.dir, "git"), `#!/bin/sh
printf 'git %s\\n' "$*" >> "${bin.log}"
if [ "$1" = "credential" ] && [ "$2" = "fill" ]; then
  printf 'protocol=https\\nhost=github.com\\nusername=tester\\npassword=clone-credential\\n'
fi
exit 0
`);
    await chmod(join(bin.dir, "git"), 0o755);
    await writeFile(join(bin.dir, "docker"), `#!/bin/sh
printf 'docker%s %s\\n' "\${DOCKER_CONFIG:+ [no-credentials]}" "$*" >> "${bin.log}"
if [ "$1" = "compose" ] && [ "$2" = "config" ]; then echo "ghcr.io/sitewake/sitewake-control-plane:1.0.0"; fi
if [ "$1" = "manifest" ]; then [ -f "${bin.dir}/signed-in" ] || exit 1; fi
if [ "$1" = "login" ]; then cat > "${bin.dir}/token-seen"; : > "${bin.dir}/signed-in"; fi
exit 0
`);
    await chmod(join(bin.dir, "docker"), 0o755);
    const envBackup = await readFile(join(ROOT, ".env"), "utf8").catch(() => null);
    try {
      await writeFile(join(ROOT, ".env"), "COMPOSE_PROJECT_NAME=sitewake-test\nSITEWAKE_PORT=3456\n");
      const { code, stdout, stderr } = await runSetup(bin, [], { env: { LANG: "en_US.UTF-8" } });
      assert.equal(code, 0, stdout + stderr);
      const calls = await bin.calls();
      assert.ok(calls.some((c) => /^git credential fill$/.test(c)), calls.join("\n"));
      assert.equal((await readFile(join(bin.dir, "token-seen"), "utf8")).trim(), "clone-credential");
      assert.ok(calls.includes("docker compose pull") && calls.includes("docker compose up -d --no-build"), calls.join("\n"));
      assert.doesNotMatch(stderr, /credential|login|token/i, "borrowing a credential is not something the reader is told about");
    } finally {
      if (envBackup === null) await rm(join(ROOT, ".env"), { force: true });
      else await writeFile(join(ROOT, ".env"), envBackup);
    }
  } finally { await bin.cleanup(); }
});

test("a tester whose machine already holds a GitHub token gets the prebuilt images without doing anything", async () => {
  const bin = await fakeBin({ nodeVersion: "22.13.0", docker: true });
  try {
    await writeFile(join(bin.dir, "node"), `#!/bin/sh
if [ "$1" = "-p" ]; then echo "22.13.0"; exit 0; fi
printf 'node %s\\n' "$*" >> "${bin.log}"
case "$*" in
  *--report*) exit 0;;
  *) printf 'en\\n' > .sitewake-setup-start; exit 0;;
esac
`);
    await chmod(join(bin.dir, "node"), 0o755);
    // The release is published privately while it is still in testing: the
    // registry answers only once this machine's credentials are presented.
    await writeFile(join(bin.dir, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "${bin.log}"
if [ "$1" = "compose" ] && [ "$2" = "config" ]; then echo "ghcr.io/sitewake/sitewake-control-plane:1.0.0"; fi
if [ "$1" = "manifest" ]; then [ -f "${bin.dir}/signed-in" ] || exit 1; fi
if [ "$1" = "login" ]; then cat > "${bin.dir}/token-seen"; : > "${bin.dir}/signed-in"; fi
exit 0
`);
    await chmod(join(bin.dir, "docker"), 0o755);
    const envBackup = await readFile(join(ROOT, ".env"), "utf8").catch(() => null);
    try {
      await writeFile(join(ROOT, ".env"), "COMPOSE_PROJECT_NAME=sitewake-test\nSITEWAKE_PORT=3456\n");
      const { code, stdout, stderr } = await runSetup(bin, [], { env: { LANG: "en_US.UTF-8", GITHUB_TOKEN: "tester-token" } });
      assert.equal(code, 0, stdout + stderr);
      const calls = await bin.calls();
      assert.ok(calls.some((c) => /^docker login ghcr\.io -u \S+ --password-stdin$/.test(c)), calls.join("\n"));
      assert.equal((await readFile(join(bin.dir, "token-seen"), "utf8")).trim(), "tester-token", "the token is handed over on stdin, never in the command line");
      assert.ok(calls.some((c) => c.startsWith("docker login")) && calls.includes("docker compose pull"), calls.join("\n"));
      assert.ok(calls.includes("docker compose up -d --no-build"), calls.join("\n"));
      assert.ok(!calls.some((c) => c.includes("--build")), "nothing is built once the images are reachable");
      assert.doesNotMatch(stderr, /Building SiteWake for this machine/);
    } finally {
      if (envBackup === null) await rm(join(ROOT, ".env"), { force: true });
      else await writeFile(join(ROOT, ".env"), envBackup);
    }
  } finally { await bin.cleanup(); }
});

test("the wizard's exit status is the entrypoint's exit status", async () => {
  const bin = await fakeBin({ nodeVersion: "22.13.0" });
  try {
    await writeFile(join(bin.dir, "node"), `#!/bin/sh
if [ "$1" = "-p" ]; then echo "22.13.0"; exit 0; fi
exit 7
`);
    const { code } = await runSetup(bin, ["--lang", "bogus"]);
    assert.equal(code, 7);
  } finally { await bin.cleanup(); }
});
