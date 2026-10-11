import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runStep } from "./capability-center-v2-notebook-mock.mjs";

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const input = option(args, "--input");
  if (!input) throw new Error("module_input_required:--input");
  const result = await runStep("generate-cases", {
    input,
    outputDir: option(args, "--output-dir"),
    modelMode: "real",
  });
  console.log("C2 Real: PASS");
  console.log(`输入: ${result.inputPath}`);
  console.log(`输出: ${result.outputPath}`);
  console.log(`页面证据: ${result.caseDiscoveryEvidencePath}`);
  console.log(`CandidateArtifact: ${result.output.artifact.candidateId}`);
  console.log(`ValidationSuite: ${result.output.artifact.validationSuite.cases.length} cases`);
  console.log(`validationSuiteHash: ${result.output.artifact.validationSuiteHash}`);
  console.log(`C3 task: ${result.output.validationTask.id}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
