import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CapabilityGenerationInput } from "../lib/capability-center-v2/model";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultInput = resolve(root, "tests/fixtures/capability-center-v2/notebook-search/00-original-input.json");
const defaultOutput = resolve(root, ".artifacts/capability-center-v2/notebook-search/01-classify.json");

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runRealClassification(options: { input?: string; output?: string; siteId?: string } = {}) {
  // This command must never use the developer or production database. Model
  // credentials may come from .env.local, but all classification state stays
  // in this process's in-memory store.
  delete process.env.DATABASE_URL;
  delete process.env.S3_BUCKET;
  process.env.CAPABILITY_V2_AUTO_DISPATCH = "0";

  const inputPath = resolve(options.input || defaultInput);
  const outputPath = resolve(options.output || defaultOutput);
  const siteId = options.siteId || "prestashop_notebook_classify_real";
  const input = JSON.parse(await readFile(inputPath, "utf8")) as CapabilityGenerationInput;

  const [{ createDiscoveryFromGenerationInput }, { resetCapabilityCenterV2ForTests }, { getModelConfig }] = await Promise.all([
    import("../lib/capability-center-v2/experience-service"),
    import("../db/capability-center-v2-store"),
    import("../lib/model-config"),
  ]);
  const model = getModelConfig("semantic");
  if (input.source === "Episode" && !model.configured) {
    throw new Error("缺少模型 API Key：请在 .env.local 配置 OPENAI_API_KEY、OPENAI_BASE_URL、OPENAI_MODEL");
  }

  resetCapabilityCenterV2ForTests();
  const result = await createDiscoveryFromGenerationInput(siteId, input, { autoDispatch: async () => {} });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  return { inputPath, outputPath, result, model: { source: model.source, model: model.model } };
}

async function main() {
  const args = process.argv.slice(2);
  const input = option(args, "--input");
  if (!input) throw new Error("classification_input_required:--input");
  const run = await runRealClassification({
    input,
    output: option(args, "--output"),
    siteId: option(args, "--site-id"),
  });
  console.log(`模型: ${run.model.source}/${run.model.model}`);
  console.log(`输入: ${run.inputPath}`);
  console.log(`输出: ${run.outputPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
