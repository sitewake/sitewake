import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { withoutUnchangedOverrides } from "../lib/console/agent-presentation.ts";
import { deriveAgentConfigFromKnowledge, emptyRelease, normalizeAgentConfig, normalizeAgentConfigForRelease } from "../lib/site-knowledge/protocol.ts";
import { resolveChromeCopy } from "../client/user-agent-copy.ts";

const shown = {
  displayName: "明镜榜助手",
  welcomeTitle: "想在明镜榜完成什么？",
  welcomeDescription: "按指定日期回看当天的完整榜单。你也可以直接说出其他目标。",
  suggestions: ["看看周深最近上了哪些榜", "昨天的榜单第一是什么", "某个地区相关的榜单有哪些"],
};

function edited(overrides) {
  return normalizeAgentConfig({ overrides });
}

test("opening the editor and saving it unchanged customises nothing", () => {
  // The editor puts the automatic value in the box, so an untouched form still
  // submits all three strings. Every one of them has to read as untouched.
  const submitted = withoutUnchangedOverrides(edited({ ...shown }), shown);
  assert.equal(submitted.overrides.displayName, undefined);
  assert.equal(submitted.overrides.welcomeTitle, undefined);
  assert.equal(submitted.overrides.welcomeDescription, undefined);
});

test("changing one field customises only that field", () => {
  const submitted = withoutUnchangedOverrides(
    edited({ ...shown, welcomeDescription: "我们只回答关于榜单的问题。" }),
    shown,
  );
  assert.equal(submitted.overrides.welcomeDescription, "我们只回答关于榜单的问题。");
  assert.equal(submitted.overrides.displayName, undefined, "the name keeps following the site's knowledge");
  assert.equal(submitted.overrides.welcomeTitle, undefined);
});

test("typing the automatic value back returns the field to automatic", () => {
  const customised = edited({ ...shown, displayName: "旧名字" });
  assert.equal(withoutUnchangedOverrides(customised, shown).overrides.displayName, "旧名字");
  const restored = edited({ ...shown, displayName: `  ${shown.displayName}  ` });
  assert.equal(withoutUnchangedOverrides(restored, shown).overrides.displayName, undefined,
    "surrounding whitespace does not make it a customisation");
});

test("a field whose automatic value is empty is unaffected", () => {
  const submitted = withoutUnchangedOverrides(edited({ displayName: "只写了名字" }),
    { displayName: "", welcomeTitle: "", welcomeDescription: "", suggestions: [] });
  assert.equal(submitted.overrides.displayName, "只写了名字");
});

test("the saved configuration keeps customisations and lets the rest follow knowledge", () => {
  const base = emptyRelease("overrides-test");
  const release = {
    ...base,
    profile: {
      ...base.profile,
      name: "明镜榜",
      description: "历史榜单查询",
      jobsToBeDone: ["按指定日期回看当天的完整榜单"],
      vocabulary: {},
      suggestedGoals: [],
    },
  };
  const automatic = deriveAgentConfigFromKnowledge(release);
  const submitted = withoutUnchangedOverrides(
    edited({
      displayName: automatic.brand.displayName,
      welcomeTitle: "换一个欢迎语",
    }),
    {
      displayName: automatic.brand.displayName,
      welcomeTitle: automatic.copy.welcomeTitle,
      welcomeDescription: automatic.copy.welcomeDescription,
      suggestions: automatic.suggestions,
    },
  );
  const saved = normalizeAgentConfig(submitted, automatic);
  assert.equal(saved.brand.displayName, "明镜榜助手", "the untouched name resolves from knowledge");
  assert.equal(saved.copy.welcomeTitle, "换一个欢迎语", "the written greeting is kept");
  assert.equal(saved.overrides.displayName, undefined, "and is not recorded as a customisation");
});

test("the editor decides this with the same value it put in the box", async () => {
  // Recomputing the automatic value at save time is the defect this change
  // exists to remove; a second source would reintroduce it in the same shape.
  const source = await readFile(new URL("../components/console/settings.tsx", import.meta.url), "utf8");
  assert.match(source, /const shownAutomatic = \{/);
  assert.match(source, /fallback: shownAutomatic\.displayName/);
  assert.match(source, /fallback: shownAutomatic\.welcomeTitle/);
  assert.match(source, /fallback: shownAutomatic\.welcomeDescription/);
  assert.match(source, /withoutUnchangedOverrides\(agentConfig, shownAutomatic\)/);
  assert.match(source, /const automaticChrome = resolveChromeCopy\(automaticConfig, locale\)/,
    "the baseline comes from the knowledge-derived layer");
});

// These go through the entry the release is actually served with. Calling the
// inner normaliser directly skips the step that manufactures the problem, and
// the test would pass while production stayed broken.
function servedRelease(stored, profile = {}) {
  const base = emptyRelease("served");
  const release = {
    ...base,
    profile: { ...base.profile, name: "CypressEra", description: "x", vocabulary: {}, suggestedGoals: [], ...profile },
  };
  return normalizeAgentConfigForRelease(release, stored);
}

test("a resolved value frozen in a stored record is not a customisation", () => {
  // Production: a site is named after its host until the crawl reads its real
  // product name. The resolved name from that early moment stays in the stored
  // record, and when the real name arrived the stale one was read as something
  // a person had chosen — so the site stopped following its own knowledge with
  // nobody having touched anything.
  const served = servedRelease({
    overrides: { pinnedSuggestions: [] },
    brand: { displayName: "cypressera.ai助手", launcherLabel: "打开 cypressera.ai助手", avatarText: "SiteWake" },
    copy: { welcomeTitle: "想在cypressera.ai完成什么？", welcomeDescription: "等待网站首次连接后由 AI 完成产品理解。", composerPlaceholder: "", poweredByText: "" },
  });
  assert.equal(served.overrides.displayName, undefined, "a resolved name is not a chosen one");
  assert.equal(served.overrides.welcomeTitle, undefined);
  assert.equal(served.overrides.welcomeDescription, undefined);
  assert.equal(served.brand.displayName, "CypressEra助手", "the site follows its own knowledge again");
});

test("a record old enough to predate the overrides layer keeps its wording", () => {
  // No `overrides` key at all: the only place this person's wording can live.
  const served = servedRelease({ brand: { displayName: "我们自己起的名字" } });
  assert.equal(served.overrides.displayName, "我们自己起的名字");
  assert.equal(served.brand.displayName, "我们自己起的名字");
});

test("punctuation width alone does not make a value a customisation", () => {
  // The generated title ends in a full-width question mark; anything stored has
  // been folded to a half-width one.
  const served = servedRelease({ overrides: { welcomeTitle: "想在CypressEra完成什么?" } });
  assert.equal(served.overrides.welcomeTitle, undefined);
  assert.equal(served.copy.welcomeTitle, "想在CypressEra完成什么？");
});

test("a real customisation still wins over knowledge", () => {
  const served = servedRelease({ overrides: { displayName: "我们自己起的名字" } });
  assert.equal(served.overrides.displayName, "我们自己起的名字");
  assert.equal(served.brand.displayName, "我们自己起的名字");
});

test("a served configuration survives being normalised again", async () => {
  // The widget re-normalises what the service sent it. `normalizeAgentConfig`
  // takes the resolved name and copy from its second argument, so handing it
  // the widget's built-in defaults discards the site's own name and greets
  // visitors as the generic assistant. The served config is the baseline.
  const base = emptyRelease("served-again");
  const release = {
    ...base,
    profile: {
      ...base.profile, name: "明镜榜", description: "x",
      jobsToBeDone: ["按指定日期回看当天的完整榜单"], vocabulary: {}, suggestedGoals: [],
    },
  };
  const served = normalizeAgentConfigForRelease(release, { overrides: { pinnedSuggestions: [] } });
  assert.equal(served.brand.displayName, "明镜榜助手", "the service resolved it");

  const renormalised = normalizeAgentConfig(served, served);
  assert.equal(renormalised.brand.displayName, "明镜榜助手", "and re-normalising keeps it");
  assert.equal(renormalised.copy.welcomeTitle, "想在明镜榜完成什么？");
  assert.deepEqual(renormalised.suggestions, served.suggestions);
  assert.equal(renormalised.generatedLocale, "zh");

  const source = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
  assert.match(source, /return normalizeAgentConfig\(released, baseline\)/,
    "the widget uses the served config as its baseline, not its own defaults");
});

test("questions offered back unchanged are not a choice", () => {
  // The boxes are filled with the questions a visitor is currently offered, so
  // an untouched form submits all three. None of them is a customisation.
  const submitted = withoutUnchangedOverrides(edited({ ...shown, pinnedSuggestions: [...shown.suggestions] }), shown);
  assert.deepEqual(submitted.overrides.pinnedSuggestions, []);
});

test("editing one question keeps the set the editor showed", () => {
  // A list, not three independent fields: dropping the two that were left
  // alone would reorder what a visitor sees and lose the third entirely.
  const written = [shown.suggestions[0], "我们自己想问的", shown.suggestions[2]];
  const submitted = withoutUnchangedOverrides(edited({ ...shown, pinnedSuggestions: written }), shown);
  assert.deepEqual(submitted.overrides.pinnedSuggestions, written);
});

test("clearing the questions returns them to the site's own", () => {
  const submitted = withoutUnchangedOverrides(edited({ ...shown, pinnedSuggestions: ["", "", ""] }), shown);
  assert.deepEqual(submitted.overrides.pinnedSuggestions, [], "nothing pinned");
  const base = emptyRelease("cleared");
  const release = {
    ...base,
    profile: { ...base.profile, name: "明镜榜", description: "x", suggestedQuestions: shown.suggestions, vocabulary: {}, suggestedGoals: [] },
  };
  const served = normalizeAgentConfigForRelease(release, submitted);
  assert.deepEqual(served.suggestions, shown.suggestions, "the site's own questions come back");
});

test("the question boxes carry their current value, not a hint", async () => {
  const source = await readFile(new URL("../components/console/settings.tsx", import.meta.url), "utf8");
  assert.match(source, /value=\{suggestions\[index\]\}/, "the current question is editable text");
  assert.doesNotMatch(source, /placeholder=\{automaticConfig\.suggestions\[index\]/,
    "the offered question is no longer only a hint");
});

test("what someone typed is measured against the automatic value, not itself", () => {
  // The editor resolves the copy it displays, and a resolved value IS the
  // override once one is set. Measuring "unchanged" against that compares the
  // new sentence with itself, so a real edit was thrown away on save and the
  // field silently snapped back.
  const base = emptyRelease("typed");
  const release = {
    ...base,
    profile: {
      ...base.profile, name: "明镜榜", description: "x",
      jobsToBeDone: ["按指定日期回看当天的完整榜单"], vocabulary: {}, suggestedGoals: [],
    },
  };
  const automatic = deriveAgentConfigFromKnowledge(release);
  const typed = normalizeAgentConfig({ overrides: { welcomeTitle: "我们自己写的欢迎语" } }, automatic);

  // How the editor derives its baseline: from the knowledge-derived layer.
  const baseline = resolveChromeCopy(automatic, "zh");
  const submitted = withoutUnchangedOverrides(typed, { ...baseline, suggestions: automatic.suggestions });
  assert.equal(submitted.overrides.welcomeTitle, "我们自己写的欢迎语", "the edit survives the save");

  // Resolving from the edited config is the mistake this guards against: its
  // resolved copy is the sentence that was just typed.
  assert.equal(resolveChromeCopy(typed, "zh").welcomeTitle, "我们自己写的欢迎语");

  // Since the release started carrying `generated`, dropping the overrides does
  // fall back to the written-for-this-language copy. That is not a licence to
  // derive the baseline that way: a record saved before `generated` existed has
  // only the promoted `copy`, and there the typed sentence comes straight back,
  // which is the comparison-with-itself that threw the edit away.
  assert.equal(resolveChromeCopy({ ...typed, overrides: undefined }, "zh").welcomeTitle,
    resolveChromeCopy(automatic, "zh").welcomeTitle, "with `generated`, the automatic value is recoverable");
  assert.equal(resolveChromeCopy({ ...typed, generated: undefined, overrides: undefined }, "zh").welcomeTitle,
    "我们自己写的欢迎语", "without `generated`, the resolved copy still carries the edit");
});

test("a question you cleared stays cleared", async () => {
  // Saving drops empty entries and closes the list up, so a box refilled from
  // the site's own questions came back as a copy of the one above it and the
  // third could never be deleted.
  const source = await readFile(new URL("../components/console/settings.tsx", import.meta.url), "utf8");
  assert.match(source, /pinnedSuggestions\.length\s*\n?\s*\? \[0, 1, 2\]\.map\(\(index\) => pinnedSuggestions\[index\] \?\? ""\)/,
    "a written list is shown as written, empties included");

  // What the save does with a list that has had one cleared out of the middle.
  const written = [shown.suggestions[0], "", shown.suggestions[2]];
  const submitted = withoutUnchangedOverrides(edited({ ...shown, pinnedSuggestions: written }), shown);
  assert.deepEqual(submitted.overrides.pinnedSuggestions, [shown.suggestions[0], shown.suggestions[2]],
    "the emptied one is gone rather than refilled");
  assert.notEqual(submitted.overrides.pinnedSuggestions[0], submitted.overrides.pinnedSuggestions[1],
    "and nothing is duplicated");
});

test("a Release carrying only part of a config still keeps what it has", async () => {
  // Older records, and records written before a field existed, carry a config
  // with branches missing. Treating that as the baseline left the resolver
  // reading through gaps, so one absent branch dropped the whole config —
  // including the chosen launcher side — back to the built-in defaults.
  const partial = { appearance: { preset: "orb", palette: "mint", launcherPosition: "bottom-left" }, overrides: {}, features: {} };
  const base = normalizeAgentConfig(undefined);
  const baseline = {
    ...base,
    ...partial,
    brand: { ...base.brand, ...partial.brand },
    copy: { ...base.copy, ...partial.copy },
    theme: { ...base.theme, ...partial.theme },
    features: { ...base.features, ...partial.features },
  };
  const resolved = normalizeAgentConfig(partial, baseline);
  assert.equal(resolved.appearance.launcherPosition, "bottom-left", "the side it chose survives");
  assert.equal(resolved.theme.launcherPosition, "bottom-left");
  assert.equal(resolved.appearance.palette, "mint");

  const source = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
  assert.match(source, /const fallback = defaultAgentConfig\(\);\s*\n\s*const baseline = \{/,
    "the widget fills the gaps before using the served config as its baseline");
});
