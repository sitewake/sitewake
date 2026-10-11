import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootPath = resolve(fileURLToPath(new URL("../", import.meta.url)));
const artifactRoot = resolve(rootPath, ".artifacts", "capability-center-v2-fixture-e2e");
const markerPath = join(artifactRoot, ".running");
const force = process.argv.includes("--force");

function assertScoped(path, label) {
  const resolved = resolve(path);
  if (!resolved.startsWith(`${artifactRoot}${sep}`) && resolved !== artifactRoot) {
    throw new Error(`refusing_to_clear_outside_fixture_artifacts:${label}:${resolved}`);
  }
  return resolved;
}

async function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let marker;
try { marker = JSON.parse(await readFile(markerPath, "utf8")); } catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (marker && await isRunning(Number(marker.pid)) && !force) {
  throw new Error(`fixture_e2e_running:pid=${marker.pid}:use --force only after stopping the test process`);
}

const runsPath = assertScoped(join(artifactRoot, "runs"), "runs");
await rm(runsPath, { recursive: true, force: true });
await rm(markerPath, { force: true });
await mkdir(artifactRoot, { recursive: true });
process.stdout.write(`${JSON.stringify({ ok: true, cleared: [runsPath], preserved: "all application and non-fixture databases" }, null, 2)}\n`);
