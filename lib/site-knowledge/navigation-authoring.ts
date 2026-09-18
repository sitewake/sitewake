import {
  normalizeGoal,
  type CompletionVerifier,
  type KnowledgeCandidate,
  type PageSnapshot,
} from "./protocol";

export function navigationTargetTerm(goal: string) {
  return normalizeGoal(goal)
    .replace(/^(请|帮我|我要|我想|带我|麻烦)?(打开|查看|进入|前往|去|跳转到)/, "")
    .replace(/(页面|页|功能|入口|界面|栏目|模块|列表|展示)$/g, "");
}

export function navigationTargetEvidence(
  goal: string,
  before: PageSnapshot,
  after: PageSnapshot,
  options: { semanticJudged?: boolean } = {},
): CompletionVerifier["success"] | undefined {
  const targetTerm = navigationTargetTerm(goal);
  const beforeLandmark = normalizeGoal(`${before.title} ${before.heading}`);
  const afterLandmark = normalizeGoal(`${after.title} ${after.heading}`);
  const targetTermVisible = Boolean(targetTerm && afterLandmark.includes(targetTerm));
  const targetTermWasAlreadyVisible = Boolean(targetTerm && beforeLandmark.includes(targetTerm));
  const targetPathVisible = Boolean(targetTerm && normalizeGoal(new URL(after.url).pathname).includes(targetTerm));
  const goalCorrelated = (targetTermVisible && !targetTermWasAlreadyVisible) || targetPathVisible || options.semanticJudged === true;
  const urlChanged = before.url !== after.url;
  const headingChanged = Boolean(after.heading && after.heading !== before.heading);
  const titleChanged = Boolean(after.title && after.title !== before.title);
  if (!goalCorrelated || (!urlChanged && !headingChanged && !titleChanged)) return undefined;
  const rules: CompletionVerifier["success"] = [
    ...(urlChanged ? [{ kind: "url" as const, value: after.url.replace(/#.*$/, "") }] : []),
    ...(targetTermVisible ? [{ kind: "text" as const, value: targetTerm }] : []),
    ...(!targetTermVisible && headingChanged ? [{ kind: "text" as const, value: after.heading }] : []),
    ...(!targetTermVisible && !headingChanged && titleChanged ? [{ kind: "text" as const, value: after.title }] : []),
  ];
  return rules.length ? rules : undefined;
}

export function navigationCompletionVerified(
  candidate: KnowledgeCandidate,
  before: PageSnapshot,
  after: PageSnapshot,
) {
  const rules = candidate.operations
    .flatMap((operation) => operation.implementations)
    .flatMap((implementation) => implementation.authored?.proof.verifier.success || []);
  const beforeText = `${before.title}\n${before.heading}\n${before.visibleText}`.normalize("NFKC").toLowerCase();
  const afterText = `${after.title}\n${after.heading}\n${after.visibleText}`.normalize("NFKC").toLowerCase();
  const matched = rules.some((rule) => {
    if (rule.kind === "url") {
      try {
        const actual = new URL(after.url);
        const expected = new URL(rule.value, actual.origin);
        return actual.origin === expected.origin
          && actual.pathname === expected.pathname
          && actual.search === expected.search;
      } catch {
        return false;
      }
    }
    if (rule.kind === "text") return afterText.includes(rule.value.normalize("NFKC").toLowerCase());
    return false;
  });
  const newlyVisible = rules.some((rule) => rule.kind === "text"
    && afterText.includes(rule.value.normalize("NFKC").toLowerCase())
    && !beforeText.includes(rule.value.normalize("NFKC").toLowerCase()));
  return matched && (before.url !== after.url || before.title !== after.title || before.heading !== after.heading || newlyVisible);
}
