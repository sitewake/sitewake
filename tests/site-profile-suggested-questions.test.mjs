import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// The analyzer is bundled with its model configuration stubbed, so these tests
// exercise the parsing and bookkeeping without reading any real provider
// settings and without a network call.
async function analyzer({ configured = true } = {}) {
  const result = await build({
    stdin: {
      contents: `export { analyzeSiteProfile } from "../lib/site-knowledge/model-analyzer";`,
      resolveDir: fileURLToPath(new URL(".", import.meta.url)),
      loader: "ts",
    },
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{
      name: "stub-model-config",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]lib[\\/]model-config\.ts$/ }, () => ({
          loader: "ts",
          contents: `export function getModelConfig(){ return ${configured
            ? `{ configured: true, apiKey: "stub", baseUrl: "https://model.stub.test/v1", model: "stub-model", source: "openai" }`
            : `{ configured: false }`} }
            export function modelChatCompletionsUrl(base){ return base + "/chat/completions" }
            export function modelCompatibility(){ return { supportsResponseFormat: true } }`,
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

function snapshot() {
  return {
    schemaVersion: "site-agent.v2",
    url: "https://shop.example.org/",
    title: "Example Shop",
    heading: "Example Shop",
    metadata: {},
    visibleText: "白色马克杯 黑色 T 恤 销量排行",
    headings: [], elements: [], links: [],
    capturedAt: "2026-09-28T00:00:00.000Z",
  };
}

function modelReply(profile) {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(profile) } }],
  }), { headers: { "content-type": "application/json" } });
}

test("suggested questions are capped at three, over-long ones dropped, and recorded as evidence", async () => {
  const { analyzeSiteProfile } = await analyzer();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => modelReply({
      name: "Example Shop",
      description: "一个卖杯子和 T 恤的店",
      category: "电商",
      audiences: ["消费者"],
      jobsToBeDone: ["按销量查看商品"],
      // Five questions, and the first one is far longer than any real question.
      suggestedQuestions: [
        "找".repeat(200),
        "找一个白色马克杯",
        "看看黑色 T 恤有哪些",
        "按销量排序看看最热门的商品",
        "第五条应当被丢弃",
      ],
      entityTypes: [],
      businessDomains: [],
      vocabulary: {},
    });
    const profile = await analyzeSiteProfile(snapshot());
    assert.ok(profile, "a configured model produces a profile");
    assert.equal(profile.suggestedQuestions.length, 3, "at most three questions survive");
    // The runaway one is dropped rather than cut, and dropping it does not cost a
    // slot: three usable questions still come through.
    assert.deepEqual(profile.suggestedQuestions,
      ["找一个白色马克杯", "看看黑色 T 恤有哪些", "按销量排序看看最热门的商品"]);
    assert.ok(profile.fieldEvidence?.suggestedQuestions, "the field carries its own evidence record");
    assert.equal(profile.fieldEvidence.suggestedQuestions.source, "ai");
  } finally { globalThis.fetch = original; }
});

test("a profile without questions keeps the rest of the analysis", async () => {
  const { analyzeSiteProfile } = await analyzer();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => modelReply({
      name: "Example Shop",
      description: "一个卖杯子和 T 恤的店",
      jobsToBeDone: ["按销量查看商品"],
      vocabulary: {},
    });
    const profile = await analyzeSiteProfile(snapshot());
    assert.ok(profile);
    assert.deepEqual(profile.suggestedQuestions, [], "a missing field reads as none, not as a failure");
    assert.deepEqual(profile.jobsToBeDone, ["按销量查看商品"]);
  } finally { globalThis.fetch = original; }
});

test("an unusable model leaves the existing degradation unchanged", async () => {
  const unconfigured = await analyzer({ configured: false });
  assert.equal(await unconfigured.analyzeSiteProfile(snapshot()), undefined,
    "no model configured still yields no profile");

  const { analyzeSiteProfile } = await analyzer();
  const original = globalThis.fetch;
  try {
    // A reply the analyzer cannot use at all: the existing contract is to mark
    // the previous profile as a failed review rather than to throw.
    globalThis.fetch = async () => modelReply({ notADescription: true });
    const previous = {
      name: "Example Shop", description: "旧描述", vocabulary: {}, suggestedGoals: [],
      suggestedQuestions: ["找一个白色马克杯"],
    };
    const profile = await analyzeSiteProfile(snapshot(), previous);
    assert.equal(profile.semanticReview?.status, "failed");
    assert.deepEqual(profile.suggestedQuestions, ["找一个白色马克杯"],
      "a failed review does not discard questions already known");
  } finally { globalThis.fetch = original; }
});

test("the analysis writes the same three fields for a reader of either language", async () => {
  const { analyzeSiteProfile } = await analyzer();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => modelReply({
      name: "Example Shop",
      description: "一个卖杯子和 T 恤的店",
      jobsToBeDone: ["按销量查看商品"],
      suggestedQuestions: ["找一个白色马克杯"],
      localized: {
        en: {
          description: "A shop selling mugs and t-shirts",
          jobsToBeDone: ["Browse products by sales"],
          suggestedQuestions: ["Find me a white mug"],
        },
      },
      vocabulary: {},
    });
    // Asked for Chinese: the profile's own fields are Chinese and English goes beside them.
    const profile = await analyzeSiteProfile(snapshot(), undefined, [], undefined, "zh");
    assert.equal(profile.localized.en.description, "A shop selling mugs and t-shirts");
    assert.deepEqual(profile.localized.en.suggestedQuestions, ["Find me a white mug"]);
    assert.equal(profile.description, "一个卖杯子和 T 恤的店", "the language asked for keeps its own fields");
    assert.ok(profile.fieldEvidence?.localized, "the second language carries its own evidence record");
  } finally { globalThis.fetch = original; }
});

test("a reply with nothing in the second language is not a failure", async () => {
  const { analyzeSiteProfile } = await analyzer();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => modelReply({
      name: "Example Shop", description: "一个卖杯子和 T 恤的店",
      jobsToBeDone: ["按销量查看商品"], vocabulary: {},
    });
    const profile = await analyzeSiteProfile(snapshot());
    assert.equal(profile.localized, undefined, "a site simply has nothing in that language yet");
    assert.equal(profile.description, "一个卖杯子和 T 恤的店");
  } finally { globalThis.fetch = original; }
});

test("an English question is kept whole, not cut to a Chinese-sized budget", async () => {
  // Production evidence: sitewake.ai stored
  // "How can I integrate SiteWake into my website to enable automatic ordering for re"
  // — 80 characters, cut mid-word. A suggested question is sent verbatim as the goal
  // when a visitor clicks it, so a cut question asks half a thing.
  const { analyzeSiteProfile } = await analyzer();
  const english = "How can I integrate SiteWake into my website to enable automatic ordering for a desk lamp?";
  assert.ok(english.length > 80, "the fixture has to be longer than the budget that caused this");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => modelReply({
      name: "SiteWake", description: "一句话价值", jobsToBeDone: ["接入助手"],
      suggestedQuestions: ["如何在我的网站上接入 SiteWake 以实现自动下单功能？"],
      localized: { en: { description: "the value", jobsToBeDone: ["integrate the agent"], suggestedQuestions: [english] } },
      vocabulary: {},
    });
    const profile = await analyzeSiteProfile(snapshot(), undefined, [], undefined, "zh");
    assert.deepEqual(profile.localized.en.suggestedQuestions, [english], "the question survives whole");
  } finally { globalThis.fetch = original; }
});

test("a question too long to be a question is dropped, never truncated", async () => {
  const { analyzeSiteProfile } = await analyzer();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => modelReply({
      name: "SiteWake", description: "一句话价值", jobsToBeDone: ["接入助手"],
      suggestedQuestions: ["好".repeat(400), "一条正常长度的问题？"],
      vocabulary: {},
    });
    const profile = await analyzeSiteProfile(snapshot());
    assert.deepEqual(profile.suggestedQuestions, ["一条正常长度的问题？"],
      "a runaway string is not offered at all, rather than offered half-finished");
  } finally { globalThis.fetch = original; }
});

test("the language the analysis is asked for is the one the profile itself is written in", async () => {
  // The prompt used to fix Chinese as the profile's language and English as the copy
  // beside it, so an English-only site was described in Chinese whatever was configured.
  const { analyzeSiteProfile } = await analyzer();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => modelReply({
      name: "Orvelle",
      description: "Design-led lighting for homes",
      jobsToBeDone: ["Compare table lamps"],
      suggestedQuestions: ["What is the warranty on the Lune table lamp?"],
      localized: { zh: { description: "面向家居的设计照明", jobsToBeDone: ["比较台灯"], suggestedQuestions: ["Lune 台灯的保修是多久？"] } },
      vocabulary: {},
    });
    const profile = await analyzeSiteProfile(snapshot(), undefined, [], undefined, "en");
    assert.equal(profile.description, "Design-led lighting for homes", "the profile is written in the language asked for");
    assert.doesNotMatch(profile.description, /[\u4e00-\u9fff]/);
    assert.equal(profile.localized.zh.description, "面向家居的设计照明", "the other language goes beside it");
    assert.ok(!profile.localized.en, "the language asked for is not duplicated into localized");
  } finally { globalThis.fetch = original; }
});
