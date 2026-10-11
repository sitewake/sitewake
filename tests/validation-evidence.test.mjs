import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function load(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const evidence = await load("../lib/site-knowledge/validation-evidence.ts");

function artifact(id, kind, label, role) {
  return { id, siteAgentId: "site", learningJobId: "job", runId: "run", kind, role, label, contentType: kind === "video" ? "video/webm" : "image/jpeg", size: 1, url: `/artifacts/${id}`, createdAt: new Date(0).toISOString() };
}

test("validation artifacts retain stable human-readable roles", () => {
  const artifacts = [
    artifact("before", "screenshot", "验证执行前截图", "before-screenshot"),
    artifact("after", "screenshot", evidence.validationArtifactLabels["after-screenshot"]),
    artifact("keyframe", "screenshot", evidence.validationArtifactLabels.keyframe),
    artifact("video", "video", evidence.validationArtifactLabels["validation-video"]),
    artifact("trace", "trace", evidence.validationArtifactLabels.trace),
    artifact("other", "screenshot", "结果截图"),
  ];

  assert.deepEqual(
    evidence.validationArtifactEvidence(artifacts).map(({ artifactId, role }) => [artifactId, role]),
    [
      ["before", "before-screenshot"],
      ["after", "after-screenshot"],
      ["keyframe", "keyframe"],
      ["video", "validation-video"],
      ["trace", "trace"],
    ],
  );
});

test("validation Runner owns its overlay and keeps it outside semantic evidence", async () => {
  const runner = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");

  assert.match(runner, /data-sitewake-validation-overlay=\"runner-owned\"/);
  assert.match(runner, /pointer-events:none/);
  assert.match(runner, /querySelectorAll<HTMLElement>\(\"\[data-sitewake-agent\]\"\)/);
  assert.match(runner, /overlay\.style\.display = \"none\"/);
  assert.match(runner, /presentation\.setPhase\(\"before\"/);
  assert.match(runner, /presentation\.setPhase\(\"running\"/);
  assert.match(runner, /run\.status === \"passed\" \? \"completed\" : \"failed\"/);
  assert.match(runner, /captureValidationFrame\(page, setup\.beforeScreenshotPath\)/);
  assert.match(runner, /captureValidationFrame\(page, setup\.afterScreenshotPath\)/);
  assert.match(runner, /role: "keyframe"/);
  assert.match(runner, /onStage: captureKeyframe/);
  assert.match(runner, /run\.outcome\.evidence\.artifacts = validationArtifactEvidence\(artifacts\)/);
  assert.match(runner, /"x-sitewake-artifact-role": metadata\.role/);
});
