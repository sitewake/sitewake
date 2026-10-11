import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runC1Real } from "./capability-center-v2-c1-mock.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const result = await runC1Real({ input: option(args, "--input"), outputDir: option(args, "--output-dir") });
  console.log("C1 Real: PASS");
  console.log(`模型: ${result.model.source}/${result.model.model}`);
  console.log(`输入: ${result.inputPath}`);
  console.log(`输出: ${result.outputPath}`);
  console.log(`源码: ${result.moduleSourcePath}`);
  console.log(`Bundle: ${result.moduleBundlePath}`);
  console.log(`contentHash: ${result.output.program.module.contentHash}`);
  console.log(`Contract: ${result.output.name}`);
  console.log(`Program stages: ${result.output.program.stages.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
