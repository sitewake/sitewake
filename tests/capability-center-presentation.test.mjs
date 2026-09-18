import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

async function sources() {
  return Promise.all([
    readFile(new URL("../components/capability-center/capability-center-screen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/capability-center/capability-center-api.ts", import.meta.url), "utf8"),
  ]);
}

test("the Capability workbench presents four-table versions without legacy Revision projections", async () => {
  const [screen, api] = await sources();
  assert.match(screen, /detail\.versions\.map/);
  assert.match(screen, /version\.validation\?\.status/);
  assert.match(api, /capability-center\/capabilities\/\$\{encodeURIComponent\(capabilityId\)\}/);
  assert.doesNotMatch(screen, /CapabilityProject|CapabilityRevision|workingRevision|activeRevision/);
});

test("the Capability workbench renders stable contracts and separates user execution from validation", async () => {
  const [screen] = await sources();
  assert.match(screen, /输入契约/);
  assert.match(screen, /输出契约/);
  assert.match(screen, /detail\.capability\.inputSchema/);
  assert.match(screen, /detail\.capability\.outputSchema/);
  assert.match(screen, /用户执行/);
  assert.match(screen, /系统验证/);
});

test("system validation is represented by a validate Capability Task", async () => {
  const [screen] = await sources();
  assert.match(screen, /createTask\([\s\S]*type:\s*"validate"/);
  assert.match(screen, /Runner 将在独立浏览器中校验当前脚本/);
  assert.match(screen, /setActiveModule\("tasks"\)/);
});

test("the task module exposes pending capability analysis and its real retry diagnostics", async () => {
  const [screen, api] = await sources();
  for (const label of ["AI 能力分析", "等待重试", "重试次数", "下次重试"]) assert.match(screen, new RegExp(label));
  assert.match(screen, /signals\.filter\(\(signal\) => signal\.status === "pending" \|\| signal\.status === "processing"\)/);
  assert.doesNotMatch(screen, /signal\.status === "processing" \|\| Boolean\(signal\.lastError\)/);
  assert.match(screen, /signal\.lastError\.summary/);
  assert.match(screen, /signal\.lastError\.finishReason/);
  assert.match(api, /capability-center[\s\S]*\/signals/);
});

test("task artifacts are labelled by kind, not all as 执行记录", async () => {
  // A failed task leaves a screenshot, a trace, a recording and a log; the four download buttons used to look identical.
  const { build } = await import("esbuild");
  const { fileURLToPath } = await import("node:url");
  const result = await build({
    stdin: {
      contents: `export { artifactLabel } from ${JSON.stringify(fileURLToPath(new URL("../components/capability-center-v2-screen.tsx", import.meta.url)))};`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts",
    },
    bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
  });
  const { artifactLabel } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const artifacts = [
    { kind: "Screenshot", contentType: "image/png" },
    { kind: "Trace", contentType: "application/json" },
    { kind: "Video", contentType: "video/webm" },
    { kind: "Log", contentType: "application/vnd.sitewake.workspace+json+gzip" },
  ];
  const labels = artifacts.map((artifact) => artifactLabel(artifact, "zh"));
  assert.deepEqual(labels, ["截图（PNG）", "执行轨迹（JSON）", "录像（WebM）", "阶段检查点"]);
  assert.equal(new Set(labels).size, labels.length, "四份产物四个不同的名字");
  assert.equal(artifactLabel({ kind: "Mystery", contentType: "application/octet-stream" }, "zh"), "执行记录");
  // The English UI names them by kind as well instead of falling back to Chinese.
  assert.deepEqual(artifacts.map((artifact) => artifactLabel(artifact, "en")), ["screenshot (PNG)", "execution trace (JSON)", "recording (WebM)", "stage checkpoint"]);
  const screen = await readFile(new URL("../components/capability-center-v2-screen.tsx", import.meta.url), "utf8");
  assert.match(screen, /className="ccv2-artifacts"[\s\S]*artifactLabel\(a\)/);
});
