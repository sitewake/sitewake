import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdtemp, mkdir, readdir, readFile as readFilePath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  assertReleaseContainsNoSensitivePaths,
  assertReleaseContainsNoCredentialMaterial,
  filterReleaseFiles,
  parseRuntimeEnv,
  parseRuntimePatch,
  redactedRuntimeDiff,
  serializeRuntimePatch,
} from "../scripts/deployment-security.mjs";

test("release allowlist permanently excludes environment files, keys, and credential paths", () => {
  const sentinel = "SENTINEL_LOCAL_CREDENTIAL_MUST_NEVER_REACH_SERVER";
  const candidates = [
    "package.json", "scripts/deploy-container-server.mjs", ".env", ".env.local",
    ".env.container.example", "private.pem", ".ssh/id_ed25519", "credentials/sentinel.txt",
  ];
  const release = filterReleaseFiles(candidates);
  assert.deepEqual(release, ["package.json", "scripts/deploy-container-server.mjs"]);
  assert.doesNotThrow(() => assertReleaseContainsNoSensitivePaths(release));
  assert.throws(() => assertReleaseContainsNoSensitivePaths([`.env.local/${sentinel}`]), /release_contains_forbidden_paths/);
  assert.ok(!release.join("\n").includes(sentinel));
  for (const path of [".npmrc", ".pypirc", ".netrc", ".dockercfg", ".docker/config.json", ".aws/credentials", ".git-credentials", "auth.json", "token.txt", "application_default_credentials.json", "service-account-prod.json", "vault.kdbx"]) {
    assert.deepEqual(filterReleaseFiles(["safe.js", path]), ["safe.js"]);
  }
});

test("content scanner rejects committed credential material hidden in ordinary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sitewake-credential-content-"));
  try {
    await writeFile(join(root, "safe.txt"), "ordinary deployment notes\n");
    await writeFile(join(root, "notes.txt"), ["-----BEGIN ", "OPENSSH PRIVATE KEY-----", "not-a-real-key"].join(""));
    assert.doesNotThrow(() => assertReleaseContainsNoCredentialMaterial(root, ["safe.txt"]));
    assert.throws(() => assertReleaseContainsNoCredentialMaterial(root, ["notes.txt"]), /release_contains_credential_material:notes\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local sentinel credentials never reach a fake server release", async () => {
  const root = await mkdtemp(join(tmpdir(), "sitewake-deploy-security-"));
  try {
    const local = join(root, "local");
    const remote = join(root, "fake-server");
    await mkdir(local);
    await mkdir(remote);
    const sentinel = `local-only-${Date.now()}-${Math.random()}`;
    await writeFile(join(local, ".env.local"), `OPENAI_API_KEY=${sentinel}\n`);
    await writeFile(join(local, "app.js"), "export const safe = true;\n");
    const files = filterReleaseFiles([".env.local", "app.js"]);
    const archive = join(root, "release.tar");
    assert.equal(spawnSync("tar", ["-cf", archive, ...files], { cwd: local }).status, 0);
    assert.equal(spawnSync("tar", ["-xf", archive, "-C", remote]).status, 0);
    const remoteFiles = await readdir(remote, { recursive: true });
    const remoteText = (await Promise.all(remoteFiles.map(async (path) => {
      try { return await readFilePath(join(remote, path), "utf8"); } catch { return ""; }
    }))).join("");
    assert.equal(remoteFiles.includes(".env.local"), false);
    assert.equal(remoteText.includes(sentinel), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment rejects dirty tracked content while ignoring untracked files", async () => {
  const root = await mkdtemp(join(tmpdir(), "sitewake-deploy-git-"));
  const deployScript = fileURLToPath(new URL("../scripts/deploy-container-server.mjs", import.meta.url));
  const fixtureEnv = { ...process.env };
  delete fixtureEnv.SITEWAKE_BUILD_SHA;
  try {
    assert.equal(spawnSync("git", ["init"], { cwd: root, stdio: "ignore" }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root }).status, 0);
    assert.equal(spawnSync("git", ["config", "user.name", "Deployment Test"], { cwd: root }).status, 0);
    await writeFile(join(root, "tracked.txt"), "committed\n");
    assert.equal(spawnSync("git", ["add", "tracked.txt"], { cwd: root }).status, 0);
    assert.equal(spawnSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" }).status, 0);
    await writeFile(join(root, "tracked.txt"), "dirty\n");
    await writeFile(join(root, "untracked-token.txt"), "must-not-archive\n");
    const dirty = spawnSync(process.execPath, [deployScript], {
      cwd: root,
      encoding: "utf8",
      env: { ...fixtureEnv, SITEWAKE_SERVER_HOST: "sentinel.invalid", SITEWAKE_SERVER_USER: "sitewake-deploy" },
    });
    assert.notEqual(dirty.status, 0);
    assert.match(`${dirty.stdout}${dirty.stderr}`, /tracked worktree must be clean before deployment/);
    await writeFile(join(root, "tracked.txt"), "committed\n");
    const untrackedOnly = spawnSync(process.execPath, [deployScript], {
      cwd: root,
      encoding: "utf8",
      env: { ...fixtureEnv, SITEWAKE_SERVER_HOST: "sentinel.invalid", SITEWAKE_SERVER_USER: "sitewake-deploy", SITEWAKE_SERVER_SSH_KEY: join(root, "missing-key") },
    });
    assert.notEqual(untrackedOnly.status, 0);
    assert.match(`${untrackedOnly.stdout}${untrackedOnly.stderr}`, /deployment SSH key not found/);
    assert.doesNotMatch(`${untrackedOnly.stdout}${untrackedOnly.stderr}`, /tracked worktree must be clean/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime configuration and patch parsing enforce the production variable allowlist", () => {
  const current = parseRuntimeEnv("OPENAI_MODEL=glm-5.2\nOPENAI_API_KEY=server-only\n");
  const patch = parseRuntimePatch("OPENAI_MODEL=qwen\n!OPENAI_API_KEY\n");
  assert.equal(serializeRuntimePatch(patch), "!OPENAI_API_KEY\nOPENAI_MODEL=qwen\n");
  assert.deepEqual(redactedRuntimeDiff(current, new Map([["OPENAI_MODEL", "qwen"]])), [
    "- OPENAI_API_KEY=<redacted>", "~ OPENAI_MODEL=<redacted>",
  ]);
  assert.throws(() => parseRuntimePatch("PATH=/tmp\n"), /runtime_env_key_not_allowed:PATH/);
  assert.throws(() => parseRuntimePatch("OPENAI_MODEL=a\nOPENAI_MODEL=b\n"), /runtime_env_duplicate_key/);
});

test("server deploy loads only SSH routing and cannot use legacy ubuntu credentials", async () => {
  // The CI pipeline file stays in the maintainers' repository; a public
  // checkout has none, and the pipeline assertions are skipped there.
  const [pkg, deploy, configure, pipeline] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/deploy-container-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/configure-container-server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../.cnb.yml", import.meta.url), "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    }),
  ]);
  assert.match(pkg, /"server:deploy": "node --env-file=\.env\.server\.local scripts\/deploy-container-server\.mjs"/);
  assert.doesNotMatch(pkg.match(/"server:deploy"[^\n]+/)?.[0] || "", /\.env\.local|\.env\.deploy|\.env\.tunnel/);
  assert.doesNotMatch(deploy, /OPENAI_|POSTGRES_PASSWORD|CLOUDFLARE_API_TOKEN|writeFileSync|\.env\.server\.runtime/);
  assert.match(deploy, /"ls-files", "--cached", "--stage", "-z"/);
  assert.match(deploy, /"archive", "--format=tar", headSha/);
  assert.doesNotMatch(deploy, /--others/);
  assert.match(deploy, /tracked worktree must be clean before deployment/);
  assert.match(deploy, /release build SHA does not match HEAD/);
  assert.match(deploy, /configShaBefore[\s\S]+configShaAfter/);
  assert.match(deploy, /\/opt\/sitewake-incoming\/\$\{releaseId\}/);
  assert.doesNotMatch(deploy, /find .*rm -rf|ssh-keygen|sshpass|bootstrap-container-host/);
  assert.match(configure, /sitewake-config/);
  if (pipeline !== null) {
    assert.match(pipeline, /scripts\/deploy-container-server\.mjs/);
    const cleanCheckoutIndex = pipeline.indexOf("Restore immutable release checkout");
    const deployIndex = pipeline.indexOf("Build containers, deploy and verify health");
    assert.ok(cleanCheckoutIndex >= 0 && deployIndex > cleanCheckoutIndex);
    assert.match(pipeline.slice(cleanCheckoutIndex, deployIndex), /git reset --hard "\$CNB_COMMIT"[\s\S]*git clean -ffdx/);
    assert.match(pipeline, /SITEWAKE_BUILD_SHA: \$CNB_COMMIT/);
    assert.doesNotMatch(pipeline, /\.env|OPENAI_API_KEY|CLOUDFLARE_API_TOKEN|POSTGRES_PASSWORD|rsync/);
  }

  const rejected = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/deploy-container-server.mjs", import.meta.url))], {
    encoding: "utf8",
    env: { ...process.env, SITEWAKE_SERVER_HOST: "sentinel.invalid", SITEWAKE_SERVER_USER: "ubuntu" },
  });
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout}${rejected.stderr}`, /dedicated sitewake-deploy identity/);
});

test("root helpers enforce separated identities, immutable configuration and compose policy", async () => {
  const [release, configure, bootstrap, compose, dockerfile, workerDockerfile] = await Promise.all([
    readFile(new URL("../scripts/sitewake-release-root.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/sitewake-configure-root.sh", import.meta.url), "utf8"),
    readFile(new URL("../scripts/bootstrap-deployment-security-root.sh", import.meta.url), "utf8"),
    readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile.worker", import.meta.url), "utf8"),
  ]);
  assert.match(release, /runtime_env=\/etc\/sitewake\/runtime\.env/);
  assert.match(release, /root:root:600/);
  assert.match(release, /flock -x/);
  assert.match(release, /build context escapes release/);
  assert.match(release, /host bind mounts are forbidden/);
  assert.match(release, /privileged/);
  assert.match(release, /production runtime configuration changed during release/);
  assert.match(release, /cp -a --reflink=never --no-preserve=ownership/);
  assert.match(release, /release snapshot changed while copying/);
  assert.doesNotMatch(release, /pg_dump|pg_restore|pre-release-.*dump/);
  assert.match(release, /database backup disabled/);
  assert.doesNotMatch(release, /run-catalog-migration\.mjs/);
  assert.match(release, /run-capability-center-migration\.mjs --schema-only/);
  assert.ok(release.indexOf("public release health check failed") < release.lastIndexOf("trap - EXIT"));
  assert.match(release, /FATAL: release rollback failed health verification/);
  assert.match(release, /minimum_release_bytes=\$\(\(4 \* 1024 \* 1024 \* 1024\)\)/);
  assert.ok(release.indexOf("insufficient disk space for immutable release") < release.indexOf("declare -A previous_image_ids"));
  assert.ok(release.lastIndexOf("trap - EXIT") < release.lastIndexOf('for rollback_tag in "${rollback_tags[@]}"'));
  assert.ok(release.indexOf("docker image prune -f") > release.lastIndexOf("trap - EXIT"));
  assert.match(configure, /explicit production confirmation missing/);
  assert.match(configure, /Production configuration diff \(values redacted\)/);
  assert.match(configure, /sync -f/);
  assert.match(configure, /rollback/);
  assert.match(configure, /FATAL: configuration rollback failed health verification/);
  assert.ok(configure.indexOf("active release build SHA unavailable") < configure.indexOf('mv -f "$temporary" "$runtime_env"'));
  assert.ok(configure.indexOf("trap rollback EXIT") < configure.indexOf('mv -f "$temporary" "$runtime_env"'));
  assert.match(configure, /configuration_replaced=0[\s\S]+configuration_replaced=1/);
  // The identities, helpers, directories and sudoers file are the sitewake-named
  // topology and nothing else; the bootstrap refuses any other identity name.
  assert.match(bootstrap, /\[ "\$deploy_user" = sitewake-deploy \] \|\|/);
  assert.match(bootstrap, /\[ "\$config_user" = sitewake-config \] \|\|/);
  assert.match(bootstrap, /groupadd -f sitewake-config-operators/);
  assert.match(bootstrap, /\/usr\/local\/sbin\/sitewake-release\b/);
  assert.match(bootstrap, /\/usr\/local\/sbin\/sitewake-configure\b/);
  assert.match(bootstrap, /install -d -o root -g root -m 755 \/etc\/sitewake \/opt\/sitewake-releases \/opt\/sitewake-incoming/);
  assert.match(bootstrap, /\/etc\/sudoers\.d\/sitewake-release/);
  assert.deepEqual([...new Set(bootstrap.match(/\b[a-z]+-(?:deploy|config|config-operators)\b/g))].filter((name) => !name.startsWith("sitewake-")), []);
  assert.deepEqual([...new Set(bootstrap.match(/\/usr\/local\/sbin\/([a-z-]+)/g))].filter((path) => !path.startsWith("/usr/local/sbin/sitewake-")), []);
  assert.match(bootstrap, /gpasswd -d/);
  assert.doesNotMatch(compose, /env_file:/);
  assert.match(dockerfile, /npm prune --omit=dev/);
  assert.ok(dockerfile.indexOf("npm run build") < dockerfile.indexOf("npm prune --omit=dev"));
  assert.match(workerDockerfile, /sh scripts\/npm-ci-retry\.sh \\\s+&& npm prune --omit=dev \\\s+&& npm cache clean --force/);
});

test("the root compose allowlist accepts the reviewed topology and rejects injected services", async () => {
  const release = await readFile(new URL("../scripts/sitewake-release-root.sh", import.meta.url), "utf8");
  const policy = release.match(/\| python3 -c '\n([\s\S]+?)\n' "\$project_dir"/)?.[1];
  assert.ok(policy, "embedded root compose policy must be extractable");
  const rendered = spawnSync("docker", ["compose", "--env-file", ".env.container.example", "-f", "compose.yaml", "-f", "compose.compact.yaml", "--profile", "validation", "--profile", "execution", "--profile", "edge", "config", "--format", "json"], { encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr);
  const accepted = spawnSync("python3", ["-c", policy, process.cwd()], { input: rendered.stdout, encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
  const explicitSafeDefaults = JSON.parse(rendered.stdout);
  explicitSafeDefaults.networks.default = {
    ...explicitSafeDefaults.networks.default,
    driver: "bridge",
    driver_opts: {},
    external: false,
    internal: false,
    attachable: false,
    enable_ipv4: true,
    enable_ipv6: false,
    labels: {},
  };
  const explicitDefaultsAccepted = spawnSync("python3", ["-c", policy, process.cwd()], { input: JSON.stringify(explicitSafeDefaults), encoding: "utf8" });
  assert.equal(explicitDefaultsAccepted.status, 0, explicitDefaultsAccepted.stderr);
  const injected = JSON.parse(rendered.stdout);
  injected.services.exfiltration = { image: "alpine", environment: {} };
  const rejected = spawnSync("python3", ["-c", policy, process.cwd()], { input: JSON.stringify(injected), encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /service set differs/);
  const networkMutated = JSON.parse(rendered.stdout);
  networkMutated.networks.default.driver = "host";
  const networkRejected = spawnSync("python3", ["-c", policy, process.cwd()], { input: JSON.stringify(networkMutated), encoding: "utf8" });
  assert.notEqual(networkRejected.status, 0);
  assert.match(networkRejected.stderr, /default network contract changed/);
  for (const [field, value] of [
    ["external", true],
    ["internal", true],
    ["attachable", true],
    ["enable_ipv4", false],
    ["enable_ipv6", true],
    ["driver_opts", { host_binding_ipv4: "127.0.0.1" }],
    ["ipam", { config: [{ subnet: "10.0.0.0/8" }] }],
  ]) {
    const mutated = JSON.parse(rendered.stdout);
    mutated.networks.default[field] = value;
    const result = spawnSync("python3", ["-c", policy, process.cwd()], { input: JSON.stringify(mutated), encoding: "utf8" });
    assert.notEqual(result.status, 0, `compose policy accepted networks.default.${field}`);
  }
  for (const [field, value] of [
    ["entrypoint", ["/bin/sh", "-c", "env"]],
    ["extra_hosts", ["metadata=169.254.169.254"]],
    ["security_opt", ["apparmor=unconfined"]],
    ["user", "0:0"],
    ["network_mode", "service:postgres"],
  ]) {
    const mutated = JSON.parse(rendered.stdout);
    mutated.services["control-plane"][field] = value;
    const result = spawnSync("python3", ["-c", policy, process.cwd()], { input: JSON.stringify(mutated), encoding: "utf8" });
    assert.notEqual(result.status, 0, `compose policy accepted control-plane.${field}`);
  }
  const sourcePolicy = release.match(/config --no-interpolate --format json \\\n\s+\| python3 -c '\n([\s\S]+?)\n'/)?.[1];
  assert.ok(sourcePolicy, "environment source policy must be extractable");
  const rawComposeDir = await mkdtemp(join(tmpdir(), "sitewake-raw-compose-"));
  const sanitizePorts = (source) => source
    .replaceAll("${SITEWAKE_BIND_ADDRESS:-0.0.0.0}", "0.0.0.0")
    .replaceAll("${SITEWAKE_PORT:-3000}", "3000");
  await Promise.all([
    writeFile(join(rawComposeDir, "compose.yaml"), sanitizePorts(await readFile("compose.yaml", "utf8"))),
    writeFile(join(rawComposeDir, "compose.compact.yaml"), sanitizePorts(await readFile("compose.compact.yaml", "utf8"))),
  ]);
  const rawRendered = spawnSync("docker", ["compose", "--project-directory", process.cwd(), "--env-file", ".env.container.example", "-f", join(rawComposeDir, "compose.yaml"), "-f", join(rawComposeDir, "compose.compact.yaml"), "--profile", "validation", "--profile", "execution", "--profile", "edge", "config", "--no-interpolate", "--format", "json"], { encoding: "utf8" });
  await rm(rawComposeDir, { recursive: true, force: true });
  assert.equal(rawRendered.status, 0, rawRendered.stderr);
  const rawAccepted = spawnSync("python3", ["-c", sourcePolicy], { input: rawRendered.stdout, encoding: "utf8" });
  assert.equal(rawAccepted.status, 0, rawAccepted.stderr);
  const sourceInjected = JSON.parse(rawRendered.stdout);
  const sourceEnvironment = sourceInjected.services["control-plane"].environment;
  sourceInjected.services["control-plane"].environment = Array.isArray(sourceEnvironment)
    ? sourceEnvironment.map((entry) => entry.startsWith("OPENAI_API_KEY=") ? "OPENAI_API_KEY=${POSTGRES_PASSWORD}" : entry)
    : { ...sourceEnvironment, OPENAI_API_KEY: "${POSTGRES_PASSWORD}" };
  const sourceRejected = spawnSync("python3", ["-c", sourcePolicy], { input: JSON.stringify(sourceInjected), encoding: "utf8" });
  assert.notEqual(sourceRejected.status, 0);
  assert.match(sourceRejected.stderr, /environment source is not approved/);
});


test("the root release helper accepts only sitewake_-prefixed volumes and the sitewake_default network", async () => {
  const release = await readFile(new URL("../scripts/sitewake-release-root.sh", import.meta.url), "utf8");
  const policy = release.match(/\| python3 -c '\n([\s\S]+?)\n' "\$project_dir"/)?.[1];
  assert.ok(policy);
  const rendered = spawnSync("docker", ["compose", "--env-file", ".env.container.example", "-f", "compose.yaml", "-f", "compose.compact.yaml", "--profile", "validation", "--profile", "execution", "--profile", "edge", "config", "--format", "json"], { encoding: "utf8" });
  assert.equal(rendered.status, 0, rendered.stderr);
  const config = JSON.parse(rendered.stdout);
  assert.equal(config.name, "sitewake");
  assert.deepEqual(Object.values(config.volumes).map((volume) => volume.name).sort(), ["sitewake_authoring-workspaces", "sitewake_minio-data", "sitewake_postgres-data"]);
  assert.equal(spawnSync("python3", ["-c", policy, process.cwd()], { input: JSON.stringify(config), encoding: "utf8" }).status, 0);
  // The same topology under any other project prefix is refused.
  for (const prefix of ["otherbrand", "oldname"]) {
    const renamed = structuredClone(config);
    for (const [key, volume] of Object.entries(renamed.volumes)) volume.name = `${prefix}_${key}`;
    const rejected = spawnSync("python3", ["-c", policy, process.cwd()], { input: JSON.stringify(renamed), encoding: "utf8" });
    assert.notEqual(rejected.status, 0, prefix);
    assert.match(rejected.stderr, /volume driver options are forbidden/);
    const network = structuredClone(config);
    network.networks.default = { ...network.networks.default, name: `${prefix}_default` };
    assert.notEqual(spawnSync("python3", ["-c", policy, process.cwd()], { input: JSON.stringify(network), encoding: "utf8" }).status, 0, prefix);
  }
});

test("container npm install retries network interruptions but preserves permanent failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sitewake-npm-retry-"));
  try {
    await writeFile(join(dir, "npm"), `#!/bin/sh
count=0
[ ! -f "$TEST_COUNT" ] || count=$(cat "$TEST_COUNT")
count=$((count + 1))
echo "$count" > "$TEST_COUNT"
echo "$*" > "$TEST_ARGS"
if [ "$TEST_MODE" = recover ] && [ "$count" -ge 2 ]; then exit 0; fi
echo "npm error code $TEST_ERROR" >&2
exit 17
`, { mode: 0o755 });
    await writeFile(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    for (const dockerfile of ["Dockerfile", "Dockerfile.worker", "Dockerfile.capability-v2-runner"]) {
      const source = await readFile(dockerfile, "utf8");
      assert.match(source, /COPY scripts\/npm-ci-retry\.sh scripts\/npm-ci-retry\.sh/);
      assert.match(source, /RUN sh scripts\/npm-ci-retry\.sh/);
    }
    for (const [mode, error, attempts, status] of [
      ["recover", "ECONNRESET", 2, 0],
      ["recover", "EAI_AGAIN", 2, 0],
      ["fail", "ETIMEDOUT", 3, 17],
      ["fail", "EUSAGE", 1, 17],
      ["fail", "EINTEGRITY", 1, 17],
    ]) {
      const counter = join(dir, "count");
      await rm(counter, { force: true });
      const result = spawnSync("sh", ["scripts/npm-ci-retry.sh", "--omit=dev"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TEST_COUNT: counter,
          TEST_ARGS: join(dir, "args"), TEST_MODE: mode, TEST_ERROR: error },
      });
      assert.equal(result.status, status, result.stderr);
      assert.equal(Number(await readFile(counter, "utf8")), attempts);
      assert.match(await readFile(join(dir, "args"), "utf8"), /^ci --no-audit --no-fund --omit=dev/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
