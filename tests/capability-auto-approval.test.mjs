import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** The console's Chinese copy, which is where its labels live. */
const consoleCopyZh = readFileSync(new URL("../lib/i18n/zh.ts", import.meta.url), "utf8");
import { build } from "esbuild";

async function bundledSettings() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../db/capability-center-store.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "memory-settings",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]index\.ts$/ }, () => ({
          contents: `export function getD1Binding(){return null;} export class D1UnavailableError extends Error {}`,
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]db[\\/]site-agent-store\.ts$/ }, () => ({
          contents: `export function activatePreparedSiteAgentReleaseInMemory(){} export async function getActiveSiteAgentRelease(){throw new Error("unused");}`,
          loader: "ts",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

test("AI auto approval is disabled by default and preserves administrator constraints", async () => {
  const store = await bundledSettings();
  const siteAgentId = "auto-approval-settings";
  assert.deepEqual((await store.getCapabilityCenterSettings(siteAgentId)).settings.autoApproval, { enabled: false, prompt: "" });
  const updated = await store.updateCapabilityCenterSettings(siteAgentId, {
    autoApproval: { enabled: true, prompt: "只批准只读能力" },
  });
  assert.deepEqual(updated.settings.autoApproval, { enabled: true, prompt: "只批准只读能力" });
  const bounded = await store.updateCapabilityCenterSettings(siteAgentId, {
    autoApproval: { enabled: true, prompt: "约".repeat(4_100) },
  });
  assert.equal(bounded.settings.autoApproval.prompt.length, 4_000);
});

test("Runner completion invokes server-side AI review and AI approval reuses the atomic approval gate", async () => {
  const [route, service, screen, schema] = await Promise.all([
    readFile(new URL("../app/api/validation/runners/[runnerId]/runs/complete/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/capability-center/auto-approval.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/capability-center/capability-center-screen.tsx", import.meta.url), "utf8"),
    readFile(new URL("../db/site-agent-schema.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /maybeAutoApproveCapabilityTask/);
  assert.match(service, /reviewer:\s*"ai"/);
  assert.match(service, /recordCapabilityTaskAutoReview/);
  assert.match(service, /confidence\s*>=\s*0\.8/);
  assert.match(service, /Number\.isFinite\(rawConfidence\)/, "invalid model confidence must fail closed");
  assert.match(service, /baselineResult = await review/);
  assert.match(service, /constrainedResult = await review\(config\.prompt\)/, "administrator constraints must be a second, tightening-only gate");
  assert.match(service, /Math\.min\(baseline\.confidence, constrained\.confidence\)/);
  assert.match(service, /getBrowserArtifact/);
  assert.match(service, /artifact\.role === "before-screenshot"/);
  assert.match(service, /artifact\.role === "after-screenshot"/);
  assert.match(service, /images\.length < 2/);
  assert.match(service, /verification: detail\.verification/);
  const analyzer = await readFile(new URL("../lib/site-knowledge/model-analyzer.ts", import.meta.url), "utf8");
  assert.match(analyzer, /type: "image_url"/);
  assert.match(analyzer, /image\.dataUrl/);
  assert.match(consoleCopyZh, /AI 自动审批/);
  assert.match(consoleCopyZh, /审批约束提示词/);
  assert.match(screen, /draftAutoApprovalEnabled/);
  assert.match(screen, /draftAutoApprovalPrompt/);
  assert.match(screen, /Promise\.allSettled/, "settings failure must not hide capability-center data");
  assert.doesNotMatch(schema, /capability_auto_approvals/i, "configuration must not create a fifth Capability Center table");
});
