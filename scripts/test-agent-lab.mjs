import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";

const args = process.argv.slice(2);
const caseIndex = args.indexOf("--case");
const selectedCase = caseIndex >= 0 ? args[caseIndex + 1] : undefined;
if (caseIndex >= 0 && !selectedCase) {
  console.error("Missing test case after --case");
  process.exit(2);
}

const passthrough = caseIndex >= 0 ? args.filter((_, index) => index !== caseIndex && index !== caseIndex + 1) : args;
const testFiles = (await readdir("tests/agent-lab"))
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => `tests/agent-lab/${name}`);
const child = spawn(process.execPath, ["--test", ...testFiles, ...passthrough], {
  stdio: "inherit",
  env: { ...process.env, ...(selectedCase ? { SITEWAKE_AGENT_LAB_CASE: selectedCase } : {}) },
});
child.on("exit", (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));
