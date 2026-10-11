import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseRuntimePatch, PRODUCTION_CONFIRMATION, serializeRuntimePatch } from "./deployment-security.mjs";

const host = process.env.SITEWAKE_CONFIG_SERVER_HOST?.trim();
const user = process.env.SITEWAKE_CONFIG_SERVER_USER?.trim() || "sitewake-config";
const keyPath = process.env.SITEWAKE_CONFIG_SERVER_SSH_KEY?.trim() || join(homedir(), ".ssh", "sitewake_config_ed25519");
const sourcePath = process.env.SITEWAKE_CONFIG_FILE?.trim();
if (process.env.SITEWAKE_PRODUCTION_CONFIRM !== PRODUCTION_CONFIRMATION) throw new Error(`set SITEWAKE_PRODUCTION_CONFIRM=${PRODUCTION_CONFIRMATION}`);
if (!host || !sourcePath) throw new Error("SITEWAKE_CONFIG_SERVER_HOST and SITEWAKE_CONFIG_FILE are required");
if (user !== "sitewake-config") throw new Error("production configuration requires the dedicated sitewake-config identity");
const proposed = parseRuntimePatch(readFileSync(sourcePath, "utf8"));
const sshBase = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-i", keyPath];
const target = `${user}@${host}`;
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status) process.exit(result.status || 1);
  return result;
}
const currentResult = spawnSync("ssh", [...sshBase, target, "sudo /usr/local/sbin/sitewake-configure status"], { encoding: "utf8" });
if (currentResult.status) process.exit(currentResult.status || 1);
const expectedSha = currentResult.stdout.trim().match(/^__SITEWAKE_RUNTIME_SHA256__=([0-9a-f]{64})$/)?.[1];
if (!expectedSha) throw new Error("unable to read production configuration hash");
console.log(`Submitting ${proposed.size} allowlisted production configuration changes; values are redacted by the server.`);
const changeId = randomBytes(16).toString("hex");
run("ssh", [...sshBase, target, `sudo /usr/local/sbin/sitewake-configure prepare ${changeId} ${user}`]);
run("ssh", [...sshBase, target, `cat > /opt/sitewake-config-incoming/${changeId}/runtime.env && chmod 600 /opt/sitewake-config-incoming/${changeId}/runtime.env`], {
  input: serializeRuntimePatch(proposed), stdio: ["pipe", "inherit", "inherit"],
});
run("ssh", [...sshBase, target, `sudo /usr/local/sbin/sitewake-configure apply ${changeId} ${expectedSha} ${PRODUCTION_CONFIRMATION}`]);
