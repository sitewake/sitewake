import assert from "node:assert/strict";
import test from "node:test";
import { emptyRelease, normalizeAgentConfigForRelease } from "../lib/site-knowledge/protocol.ts";
import { resolveChromeCopy } from "../client/user-agent-copy.ts";

function release(profile) {
  const base = emptyRelease("both-languages");
  return { ...base, profile: { ...base.profile, name: "SiteWake", vocabulary: {}, suggestedGoals: [], ...profile } };
}

// Through the entry a release is actually served with. Calling the derive
// directly skips the normalisation in between, which is where a field that is
// produced but never carried through goes missing — exactly what happened.
const served = (rel) => normalizeAgentConfigForRelease(rel, { overrides: { pinnedSuggestions: [] } });

const written = {
  localized: {
    zh: {
      description: "为现有网站提供原生智能体 SDK",
      jobsToBeDone: ["把智能体脚本装进现有网站"],
      suggestedQuestions: ["怎么把脚本装到我的网站上"],
    },
    en: {
      description: "A native agent SDK for an existing website",
      jobsToBeDone: ["Install the agent script into an existing website"],
      suggestedQuestions: ["How do I install the script on my site"],
    },
  },
};

test("a reader of either language gets this site's own words", () => {
  const config = served(release(written));

  const zh = resolveChromeCopy(config, "zh");
  assert.equal(zh.displayName, "SiteWake助手");
  assert.equal(zh.welcomeTitle, "想在SiteWake完成什么？");
  assert.match(zh.welcomeDescription, /^把智能体脚本装进现有网站。/);
  assert.deepEqual(zh.suggestions, ["怎么把脚本装到我的网站上"]);

  const en = resolveChromeCopy(config, "en");
  assert.equal(en.displayName, "SiteWake assistant");
  assert.equal(en.welcomeTitle, "What would you like to do on SiteWake?");
  assert.match(en.welcomeDescription, /^Install the agent script into an existing website\./);
  assert.deepEqual(en.suggestions, ["How do I install the script on my site"]);
});

test("neither language is served the other's sentences", () => {
  // The defect this replaces: everything was labelled Chinese, so an English
  // reader was shown the built-in assistant and a Chinese reader was shown an
  // English sentence with a Chinese tail glued on.
  const config = served(release(written));
  const en = resolveChromeCopy(config, "en");
  assert.doesNotMatch(en.welcomeDescription, /[一-鿿]/, "no Chinese reaches an English reader");
  assert.doesNotMatch(en.displayName, /[一-鿿]/);
  const zh = resolveChromeCopy(config, "zh");
  assert.doesNotMatch(zh.welcomeDescription, /Install the agent/, "and no English sentence reaches a Chinese one");
});

test("a profile from before there were two languages still reads", () => {
  // Older records carry one set of fields and say which language it is in.
  const config = served(release({
    description: "为现有网站提供原生智能体 SDK",
    jobsToBeDone: ["把智能体脚本装进现有网站"],
  }));
  const zh = resolveChromeCopy(config, "zh");
  assert.equal(zh.displayName, "SiteWake助手");
  assert.match(zh.welcomeDescription, /^把智能体脚本装进现有网站。/);
  // The other language has no sentences written for it, so it gets the built-in
  // ones rather than a sentence it cannot read — but the site's name is the
  // site's name in either.
  const en = resolveChromeCopy(config, "en");
  assert.equal(en.displayName, "SiteWake assistant");
  assert.doesNotMatch(en.welcomeDescription, /[\u4e00-\u9fff]/, "no Chinese sentence reaches an English reader");
});

test("a site known only by name is still called by it", () => {
  // Knowing what a site is called is worth using even when nothing else has
  // been written about it; only the sentences fall back.
  const config = served(release({ description: "" }));
  assert.equal(resolveChromeCopy(config, "zh").displayName, "SiteWake助手");
  assert.equal(resolveChromeCopy(config, "en").displayName, "SiteWake assistant");
  assert.equal(resolveChromeCopy(config, "en").welcomeDescription,
    "Just say what you want. I will work on the page you are on, and tell you the result when it is done.");
});

test("a site with nothing written still gets the built-in sentences", () => {
  // The name falls back to the site's identifier, which is pre-existing; what
  // matters here is that the sentences come from the reader's own catalog
  // rather than from the other language.
  const config = served(emptyRelease("unknown-site"));
  const en = resolveChromeCopy(config, "en");
  assert.doesNotMatch(en.welcomeDescription, /[\u4e00-\u9fff]/,
    "the placeholder a site carries before its first crawl is Chinese; an English reader must not be shown it");
  assert.doesNotMatch(en.welcomeTitle, /[\u4e00-\u9fff]/);
});

test("questions somebody wrote are theirs in both languages", () => {
  const config = served(release(written));
  const pinned = { ...config, overrides: { pinnedSuggestions: ["我们自己想问的"] } };
  // Pinned first, then the site's own fill the rest — the same order every
  // reader sees, whichever language they are in.
  assert.equal(resolveChromeCopy(pinned, "zh").suggestions[0], "我们自己想问的");
  assert.equal(resolveChromeCopy(pinned, "en").suggestions[0], "我们自己想问的");
  assert.equal(resolveChromeCopy(pinned, "en").suggestions[1], "How do I install the script on my site",
    "and the rest are in the language being read");
});
