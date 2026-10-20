import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/** The console's Chinese copy, which is where its labels live. */
const consoleCopyZh = readFileSync(new URL("../lib/i18n/zh.ts", import.meta.url), "utf8");
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
  assert.match(consoleCopyZh, /输入契约/);
  assert.match(consoleCopyZh, /输出契约/);
  assert.match(screen, /detail\.capability\.inputSchema/);
  assert.match(screen, /detail\.capability\.outputSchema/);
  assert.match(consoleCopyZh, /用户执行/);
  assert.match(consoleCopyZh, /系统验证/);
});

test("system validation is represented by a validate Capability Task", async () => {
  const [screen] = await sources();
  assert.match(screen, /createTask\([\s\S]*type:\s*"validate"/);
  assert.match(consoleCopyZh, /Runner 将在独立浏览器中校验当前脚本/);
  assert.match(screen, /setActiveModule\("tasks"\)/);
});

test("the task module exposes pending capability analysis and its real retry diagnostics", async () => {
  const [screen, api] = await sources();
  for (const label of ["AI 能力分析", "等待重试", "重试次数", "下次重试"]) assert.match(consoleCopyZh, new RegExp(label));
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

test("the progress feed shows a superseded publication and drops the review it made moot", async () => {
  const { build } = await import("esbuild");
  const { fileURLToPath } = await import("node:url");
  const result = await build({
    stdin: {
      contents: `export { progressActivity } from ${JSON.stringify(fileURLToPath(new URL("../components/capability-center-v2-screen.tsx", import.meta.url)))};`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts",
    },
    bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
  });
  const { progressActivity } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const at = (sequence, eventType, payload) => ({ id: String(sequence), sequence, eventType, payload, createdAt: "2026-09-21T13:00:00.000Z" });
  const events = [
    at(1, "PhaseChanged", { phase: "Validating", message: "C3 纯代码验证样例 case_1 已通过" }),
    at(2, "ReviewStarted", { phase: "Reviewing" }),
    at(3, "PhaseChanged", { phase: "Reviewing", message: "ai review started" }),
    at(4, "ReviewCompleted", { phase: "Reviewing", decision: "Rejected", reason: "违反程序不能完整满足成功条件的规则……" }),
    at(5, "PublicationSuperseded", { phase: "Published", capabilityId: "cap", capabilityName: "查询记录", message: "publication superseded" }),
  ];
  const feed = progressActivity(events);
  assert.deepEqual(feed.map((event) => event.sequence), [5, 1], "the superseded outcome leads; the moot review is gone; validation stays");
  assert.equal(String(feed[0].payload.message), "publication superseded", "the feed carries a marker the console words");
  // Without a superseding publication the review history is shown as before.
  assert.deepEqual(progressActivity(events.slice(0, 4)).map((event) => event.sequence), [4, 3, 2, 1]);
});

test("the console says what each validation case came to, and names the one refusal plainly", async () => {
  // A replay no longer ends at the first case that did not work, so a published
  // capability can carry a case recorded as failed. The console used to show
  // only the run-level outcome and a receipt dump, and reported the sole
  // refusal as the internal predicate it came from — `success_text_missing:第 5
  // 名` read as "the capability could not be made" when two of three cases had
  // passed.
  const screen = await readFile(new URL("../components/capability-center-v2-screen.tsx", import.meta.url), "utf8");
  assert.match(screen, /validationResults/, "the per-case results reach the view");
  assert.match(screen, /noResultReason/);
  assert.match(screen, /failureReason/);
  assert.match(screen, /data-outcome=/, "each case renders its own outcome");

  const [zh, en] = await Promise.all([
    readFile(new URL("../lib/i18n/zh.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/i18n/en.ts", import.meta.url), "utf8"),
  ]);
  for (const bundle of [zh, en]) {
    for (const key of ["caseOutcomes", "casePassed", "caseNoResult", "caseFailed"]) {
      assert.match(bundle, new RegExp(`\\b${key}:`), `${key} is translated`);
    }
  }

  const diagnostics = await readFile(new URL("../runner/capability-v2/failure-diagnostics.ts", import.meta.url), "utf8");
  assert.match(diagnostics, /validation_no_case_produced_a_result/);
  // The runner names the refusal; each catalog states it, so the reader is
  // told plainly in their own language rather than handed the predicate.
  assert.match(diagnostics, /diagnosis\("no_case_produced_a_result"/, "the refusal is coded, not stated in the record");
  assert.match(zh, /没有任何一条样例把能力跑出结果/, "the refusal is stated in Chinese");
  assert.match(en, /No case in the independent replay produced a result/i, "the refusal is stated in English");
});

/**
 * The progress panel and the activity feed read copy, not the server's prose.
 *
 * Both used to render whatever the server had written: a projection's sentence
 * and an event's message. Those were Chinese, so an English console showed the
 * state of a capability run in Chinese while every label around it was
 * translated. The producers now emit keys and markers, and these two tests are
 * what stops prose coming back.
 */
test("the progress and activity producers emit keys, never sentences a reader would have to be fluent in", async () => {
  const files = [
    "../lib/capability-center-v2/production-status.ts",
    "../lib/capability-center-v2/coordinator.ts",
    "../runner/capability-v2/javascript-author.ts",
    "../runner/capability-v2/process-runner.ts",
  ];
  const chinese = /[一-鿿]/;
  for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      // A prompt body, a model instruction and a detection pattern are all
      // allowed to be Chinese; what a task record carries is not. A record's
      // value can be a ternary, so a branch counts when the field it belongs
      // to is just above it.
      const field = /\b(?:message|reason):/;
      const branch = /^\s*[?:]\s*["'`]/.test(line)
        && lines.slice(Math.max(0, index - 3), index).some((above) => field.test(above));
      if ((field.test(line) || branch) && chinese.test(line)) {
        assert.fail(`${file.replace("../", "")}:${index + 1} puts prose in a record a console has to word: ${line.trim().slice(0, 90)}`);
      }
    });
  }
});

test("every marker the activity feed words is worded in both languages", async () => {
  const [zh, en] = await Promise.all([
    readFile(new URL("../lib/i18n/zh.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/i18n/en.ts", import.meta.url), "utf8"),
  ]);
  const markers = (source) => {
    const block = source.match(/activityMessage: \{([\s\S]*?)\} as Record<string, string>,/);
    assert.ok(block, "the activity markers are a catalog block");
    return [...block[1].matchAll(/^\s*"([^"]+)": "([^"]+)",$/gm)].map(([, key, value]) => [key, value]);
  };
  const zhMarkers = markers(zh);
  const enMarkers = markers(en);
  assert.deepEqual(zhMarkers.map(([key]) => key).sort(), enMarkers.map(([key]) => key).sort(), "the two catalogs word the same markers");
  assert.ok(zhMarkers.length >= 8, `expected the known markers to be worded, found ${zhMarkers.length}`);
  for (const [key, value] of [...zhMarkers, ...enMarkers]) {
    assert.ok(value.trim().length > 4, `${key} has no usable copy`);
  }
  // The markers are what the producers actually emit, so a rename on one side
  // shows up here rather than as an untranslated line in the feed.
  const producers = await Promise.all([
    readFile(new URL("../lib/capability-center-v2/coordinator.ts", import.meta.url), "utf8"),
    readFile(new URL("../runner/capability-v2/javascript-author.ts", import.meta.url), "utf8"),
    readFile(new URL("../runner/capability-v2/process-runner.ts", import.meta.url), "utf8"),
  ]);
  for (const marker of ["review started", "ai review started", "publication superseded", "ai review approved on gate evidence", "building the module", "run spec and module address checked"]) {
    assert.ok(producers.some((source) => source.includes(`"${marker}"`)), `no producer emits the marker "${marker}"`);
    assert.ok(zhMarkers.some(([key]) => key === marker), `"${marker}" is emitted but not worded`);
  }
});
