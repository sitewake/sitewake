import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import {
  deriveAgentConfigFromKnowledge,
  emptyRelease,
} from "../lib/site-knowledge/protocol.ts";

// Bundled rather than imported: canonicalize.ts reaches its neighbours without
// file extensions, which the public release gate's loader cannot resolve.
async function canonicalizer() {
  const result = await build({
    stdin: {
      contents: `export { canonicalizeReleaseKnowledge } from "../lib/site-knowledge/canonicalize";`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "ts",
    },
    bundle: true, platform: "node", format: "esm", write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

function releaseWith(profile) {
  const release = emptyRelease("presentation-test");
  return {
    ...release,
    profile: {
      ...release.profile,
      name: "明镜榜",
      description: "历史榜单查询",
      allowedOrigins: ["https://shop.example.org"],
      entryUrl: "https://shop.example.org/",
      vocabulary: {},
      suggestedGoals: [],
      ...profile,
    },
  };
}

test("an address the knowledge wrote survives canonicalization", async () => {
  // The questions are written once, during knowledge analysis, and every later
  // stage only reshapes the release around them. A stage that rebuilt the
  // profile field by field would drop them silently, and the symptom — the
  // widget sometimes having suggestions and sometimes not — is close to
  // impossible to attribute from the console.
  const questions = ["看看周深最近上了哪些榜", "昨天的榜单第一是什么"];
  const { canonicalizeReleaseKnowledge } = await canonicalizer();
  const canonical = canonicalizeReleaseKnowledge(releaseWith({ suggestedQuestions: questions }));
  assert.deepEqual(canonical.profile.suggestedQuestions, questions);
});

test("suggested questions come from knowledge, not from the capability catalog", () => {
  const config = deriveAgentConfigFromKnowledge(releaseWith({
    suggestedQuestions: ["看看周深最近上了哪些榜", "昨天的榜单第一是什么", "某个地区相关的榜单有哪些", "第四条应当被丢弃"],
    jobsToBeDone: ["按指定日期回看当天的完整榜单"],
  }));
  assert.deepEqual(config.suggestions, [
    "看看周深最近上了哪些榜",
    "昨天的榜单第一是什么",
    "某个地区相关的榜单有哪些",
  ], "at most three, and the written questions win over the jobs");
});

test("a site with no written questions falls back to the jobs it knows", () => {
  // A newly onboarded site has no published capability at all, so a suggestion
  // list that depended on one would be empty exactly when it matters most.
  const config = deriveAgentConfigFromKnowledge(releaseWith({
    jobsToBeDone: ["按指定日期回看当天的完整榜单", "查看某个话题的热度曲线"],
  }));
  assert.deepEqual(config.suggestions, [
    "按指定日期回看当天的完整榜单",
    "查看某个话题的热度曲线",
  ]);
});

test("a site that knows neither offers nothing rather than a placeholder", () => {
  const config = deriveAgentConfigFromKnowledge(releaseWith({}));
  assert.deepEqual(config.suggestions, []);
});

test("the site's own name is what greets a visitor", () => {
  const config = deriveAgentConfigFromKnowledge(releaseWith({}));
  assert.equal(config.brand.displayName, "明镜榜助手");
  assert.equal(config.copy.welcomeTitle, "想在明镜榜完成什么？");
});

test("a separator-laden SEO title is still cut down to the product name", () => {
  const config = deriveAgentConfigFromKnowledge(releaseWith({
    name: "明镜榜 - 数据查询与每日榜单回看",
  }));
  assert.equal(config.brand.displayName, "明镜榜助手");
});

test("an ordinary product name passes through untouched", () => {
  const config = deriveAgentConfigFromKnowledge(releaseWith({ name: "CypressEra" }));
  assert.equal(config.brand.displayName, "CypressEra助手");
});

test("the second language survives canonicalization", async () => {
  // A stage that rebuilt the profile field by field would drop it silently,
  // and the symptom — one language quietly falling back to the built-in
  // sentences — is close to impossible to attribute from the console.
  const { canonicalizeReleaseKnowledge } = await canonicalizer();
  const localized = { en: { description: "A shop", jobsToBeDone: ["Browse products"], suggestedQuestions: ["Find me a mug"] } };
  const canonical = canonicalizeReleaseKnowledge(releaseWith({ localized }));
  assert.deepEqual(canonical.profile.localized, localized);
});

test("the console preview resolves its questions for the reader, like everything else in it", async () => {
  // Production: an English console showed an English title and description above
  // three Chinese questions. Every other line of that preview went through
  // resolveChromeCopy; the questions were read straight off the config, which is
  // always the default language whatever the console is set to.
  const source = await readFile(new URL("../components/console/settings.tsx", import.meta.url), "utf8");
  const previewBlock = /sw-chat-welcome[\s\S]{0,400}?<\/div>/.exec(source)?.[0] || "";

  assert.ok(previewBlock, "the preview welcome block has to be findable");
  assert.match(previewBlock, /chrome\.suggestions/, "the questions follow the reader's language");
  assert.doesNotMatch(previewBlock, /preview\.suggestions/,
    "reading the raw field puts the default language inside the other language's console");
});
