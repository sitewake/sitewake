import { spawn } from "node:child_process";

const root = process.cwd();

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} failed (${code ?? signal})`));
    });
  });
}

const node = process.execPath;

await run(node, ["scripts/build-sitewake-sdk.mjs"]);

console.log("\n[page-agent-e2e] Real PrestaShop browser flow");
await run(node, ["--test", "tests/local-e2e/prestashop-page-agent-v2.test.mjs"]);

console.log("\n[page-agent-e2e] Runtime V2 evidence, budget, continuation and outbox closure");
await run(node, [
  "--experimental-strip-types",
  "--test",
  "tests/page-agent-runtime-v2.test.mjs",
  "tests/page-observation-evidence.test.mjs",
  "tests/page-observation-store-d1.test.mjs",
  "tests/capability-experience-outbox.integration.test.mjs",
  "tests/runtime-model-budget.test.mjs",
  "tests/agent-run-followup-lineage.test.mjs",
  "tests/compiled-runtime-deadline.test.mjs",
  "tests/site-agent-runtime-features.test.mjs",
  "tests/site-agent-stream-timeout.test.mjs",
]);

console.log("\n[page-agent-e2e] PASS");
