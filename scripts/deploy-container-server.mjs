import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertReleaseContainsNoCredentialMaterial, assertReleaseContainsNoSensitivePaths, filterReleaseFiles } from "./deployment-security.mjs";

const host = process.env.SITEWAKE_SERVER_HOST?.trim();
const user = process.env.SITEWAKE_SERVER_USER?.trim() || "sitewake-deploy";
const keyPath = process.env.SITEWAKE_SERVER_SSH_KEY?.trim() || join(homedir(), ".ssh", "sitewake_deploy_ed25519");
const publicHealthUrl = process.env.SITEWAKE_PUBLIC_HEALTH_URL?.trim();
if (!host) throw new Error("SITEWAKE_SERVER_HOST is required");
if (user !== "sitewake-deploy") throw new Error("code deployment requires the dedicated sitewake-deploy identity");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status) process.exit(result.status || 1);
  return result;
}

const sshBase = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-i", keyPath];
const remoteTarget = `${user}@${host}`;
const sshCapture = (command) => {
  const result = spawnSync("ssh", [...sshBase, remoteTarget, command], { encoding: "utf8" });
  if (result.status) {
    process.stderr.write(result.stderr || "");
    process.exit(result.status || 1);
  }
  return String(result.stdout).trim();
};

const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
if (head.status) process.exit(head.status || 1);
const headSha = head.stdout.trim();
const buildSha = (process.env.SITEWAKE_BUILD_SHA || headSha).trim();
if (!/^[0-9a-f]{40}$/.test(buildSha)) throw new Error("invalid release build SHA");
if (buildSha !== headSha) throw new Error("release build SHA does not match HEAD");
for (const args of [["diff", "--quiet", "--exit-code"], ["diff", "--cached", "--quiet", "--exit-code"]]) {
  const clean = spawnSync("git", args, { stdio: "ignore" });
  if (clean.status) throw new Error("tracked worktree must be clean before deployment");
}
const releaseId = `${buildSha}-${Date.now()}`;

// The production runtime environment is server-owned. The only information
// read locally is SSH routing; runtime/model/database/Cloudflare variables are
// deliberately neither inspected nor serialized by this process.
const listed = spawnSync("git", ["ls-files", "--cached", "--stage", "-z"], {
  encoding: "buffer",
  maxBuffer: 20 * 1024 * 1024,
});
if (listed.status) process.exit(listed.status || 1);
const stagedEntries = listed.stdout.toString("utf8").split("\0").filter(Boolean).map((entry) => {
  const match = entry.match(/^(\d{6}) [0-9a-f]+ \d\t(.+)$/s);
  if (!match || !["100644", "100755"].includes(match[1])) throw new Error("release contains unsupported tracked file type");
  return match[2];
});
const candidates = stagedEntries;
const files = filterReleaseFiles(candidates);
if (!files.length) throw new Error("release contains no source files");
const exactArchive = spawnSync("git", ["archive", "--format=tar", headSha], { encoding: "buffer", maxBuffer: 200 * 1024 * 1024 });
if (exactArchive.status) process.exit(exactArchive.status || 1);
const snapshotDir = mkdtempSync(join(tmpdir(), "sitewake-release-"));
let archive;
try {
  const extract = spawnSync("tar", ["-xf", "-", "-C", snapshotDir], { input: exactArchive.stdout, encoding: "buffer" });
  if (extract.status) process.exit(extract.status || 1);
  assertReleaseContainsNoCredentialMaterial(snapshotDir, files);
  archive = spawnSync("tar", ["-cf", "-", "--null", "-T", "-"], {
    cwd: snapshotDir,
    input: Buffer.from(`${files.join("\0")}\0`),
    encoding: "buffer",
    maxBuffer: 200 * 1024 * 1024,
  });
  if (archive.status) process.exit(archive.status || 1);
} finally {
  rmSync(snapshotDir, { recursive: true, force: true });
}
const archivedEntries = spawnSync("tar", ["-tf", "-"], { input: archive.stdout, encoding: "utf8" });
if (archivedEntries.status) process.exit(archivedEntries.status || 1);
assertReleaseContainsNoSensitivePaths(archivedEntries.stdout.split(/\r?\n/).filter(Boolean));
if (!existsSync(keyPath)) throw new Error(`deployment SSH key not found: ${keyPath}`);
// Checked before the first SSH command so a misconfigured deploy stops here, not after the release.
if (!publicHealthUrl) throw new Error("SITEWAKE_PUBLIC_HEALTH_URL is required: the public /api/health URL of this deployment");

const expectedHelperSha = createHash("sha256").update(readFileSync(new URL("./sitewake-release-root.sh", import.meta.url))).digest("hex");
const installedHelperSha = sshCapture("sha256sum /usr/local/sbin/sitewake-release").split(/\s+/)[0];
if (installedHelperSha !== expectedHelperSha) {
  throw new Error("server release helper differs from this commit; an administrator must install the reviewed helper before deployment");
}
const configShaBefore = sshCapture("sudo /usr/local/sbin/sitewake-release config-sha");
if (!/^[0-9a-f]{64}$/.test(configShaBefore)) throw new Error("invalid server runtime configuration hash");
run("ssh", [...sshBase, remoteTarget, `sudo /usr/local/sbin/sitewake-release prepare-release ${releaseId} ${user}`]);
run("ssh", [...sshBase, remoteTarget, `tar -xf - -C /opt/sitewake-incoming/${releaseId}`], {
  input: archive.stdout,
  stdio: ["pipe", "inherit", "inherit"],
});
run("ssh", [
  ...sshBase,
  remoteTarget,
  `sudo /usr/local/sbin/sitewake-release activate-release ${releaseId} ${configShaBefore} ${buildSha}`,
]);
const configShaAfter = sshCapture("sudo /usr/local/sbin/sitewake-release config-sha");
if (configShaAfter !== configShaBefore) throw new Error("production runtime configuration changed during code deployment");

const response = await fetch(publicHealthUrl, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) throw new Error(`public health check failed: HTTP ${response.status}`);
const health = await response.json();
if (health.status !== "ready" || health.runtime !== "container" || health.buildSha !== buildSha) {
  throw new Error("public health check did not report the released container build");
}
console.log(`Released code ${buildSha}; production runtime configuration SHA-256 remained ${configShaAfter}.`);
