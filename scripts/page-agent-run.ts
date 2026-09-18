// Cleared before anything can import a store: db/index.ts wires the production
// Postgres adapter at module load from these two variables. On a machine that
// has them — a server, a worker container — an ordinary import would silently
// point this run at the production database.
delete process.env.DATABASE_URL;
delete process.env.S3_BUCKET;

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPageAgentInput, runPageAgentModuleForReal } from "../lib/page-agent/real-runner";


/** The output lands next to the input it came from: one folder is one case. */
export function defaultOutputFor(inputPath: string) {
  return resolve(dirname(inputPath), "01-module-output.json");
}

function option(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runRealPageAgent(options: {
  input?: string;
  output?: string;
  headed?: boolean;
  timeoutMs?: number;
  port?: number;
  onProgress?: (message: string) => void;
} = {}) {
  if (!options.input) throw new Error("page-agent-run: --input <00-module-input.json> is required (a case folder under tests/unit/page-agent/)");
  const inputPath = resolve(options.input);
  const outputPath = resolve(options.output || defaultOutputFor(inputPath));
  const input = await readPageAgentInput(inputPath);
  // Only `output` is written. `diagnostics` says how the run was performed,
  // which is not something the module hands to anyone — it stays on screen.
  const { output, diagnostics } = await runPageAgentModuleForReal(input, {
    headed: options.headed,
    timeoutMs: options.timeoutMs,
    port: options.port,
    onProgress: options.onProgress,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return { inputPath, outputPath, output, diagnostics };
}

async function main() {
  const args = process.argv.slice(2);
  const run = await runRealPageAgent({
    input: option(args, "--input"),
    output: option(args, "--output"),
    headed: args.includes("--headed"),
    timeoutMs: Number(option(args, "--timeout") || 0) || undefined,
    port: Number(option(args, "--port") || 0) || undefined,
    onProgress: (message) => console.log(`… ${message}`),
  });
  const { output, diagnostics } = run;
  const receipts = output.episode.experience?.actionReceiptsV2 || [];
  const changed = receipts.filter((receipt) => receipt.effect === "changed").length;
  console.log("");
  console.log(`输入: ${run.inputPath}`);
  console.log(`输出: ${run.outputPath}`);
  console.log("");
  console.log("── 输出文件里的三样（PageAgent 交给外部的全部东西）──");
  console.log(`① 给调用方: ${output.result.success ? "成功" : "未完成"} · ${output.result.text || "（无文案）"}`);
  console.log(`   业务产出: ${Object.keys(output.result.output).length ? JSON.stringify(output.result.output).slice(0, 300) : "{}"}`);
  console.log(`② 给能力中心: ${output.episode.id} · ${output.episode.outcome?.status} · ${receipts.length} 条动作回执（${changed} 条真的改变了页面）`);
  console.log(`③ 给证据库: ${output.evidence.observations.length} 个观察`);
  console.log("");
  console.log("── 这次是怎么跑的（不进输出文件）──");
  console.log(`实现: 真实运行 · 浏览器 ${diagnostics.browser} · 模型 ${diagnostics.model.source}/${diagnostics.model.model}`);
  console.log(`控制面: 生产路由 in-process（存储走内存，不碰任何数据库）`);
  console.log(`宿主 AgentRun: ${diagnostics.agentRunId}（模型请求都记在它账上）`);
  console.log(`可用服务: ask_user ${diagnostics.services.askUser ? "开" : "关"}（跨文档续跑是宿主的活，这个单元不接手）`);
  console.log(`模型请求: ${diagnostics.modelCalls.length} 次`);
  // The brief is the run's authority, so a case that produced no trusted
  // entities is worth naming: the capability centre cannot learn from it.
  const entities = Object.keys(output.episode.pageExecutionBrief?.entities || {});
  console.log(`brief 里的可信实体: ${entities.length ? entities.join(", ") : "无——这样的经验能力中心学不走"}`);
  if (diagnostics.failures.length) {
    console.log(`被拒绝的控制面请求: ${diagnostics.failures.map((item) => `${item.status} ${item.path}`).join(" · ")}`);
  }
  console.log(`耗时: ${Math.round(diagnostics.durationMs / 1000)} 秒`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
