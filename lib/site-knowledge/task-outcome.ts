import type { JsonValue, PageProgramStep, PageSnapshot } from "./protocol";

/**
 * A business result is a semantic judgement, not a DOM keyword match.  This
 * type is intentionally richer than OutcomeReceipt because the Judge may ask
 * the Actor to continue before a final receipt is emitted.
 */
export type TaskOutcomeDecision = {
  status: "success" | "no-result" | "business-rejection" | "needs-more-work" | "unknown";
  code: string;
  summary: string;
  confidence: number;
  evidence: string[];
  missingEvidence: string[];
  nextInstruction?: string;
  source: "judge" | "judge-unavailable";
};

export type TaskJudgeEvidence = {
  goal: string;
  input: Record<string, JsonValue>;
  actor: {
    reportedSuccess: boolean;
    response: string;
    technicalError?: string;
  };
  trace: Array<{ operation: PageProgramStep["op"]; targetId?: string }>;
  before: { url: string; title: string; heading: string; text: string };
  after: { url: string; title: string; heading: string; text: string };
  highlights: {
    goalTerms: string[];
    afterUrlPath: string;
    afterUrlSearch: string;
    afterMatchedSnippets: string[];
    changedSnippets: string[];
  };
  facts: {
    actionCount: number;
    urlChanged: boolean;
    titleChanged: boolean;
    headingChanged: boolean;
    contentChanged: boolean;
  };
};

function evidencePage(snapshot: PageSnapshot) {
  return {
    url: snapshot.url,
    title: snapshot.title,
    heading: snapshot.heading,
    text: snapshot.visibleText.slice(0, 8_000),
  };
}

function compactTerm(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{Letter}\p{Number}\u4e00-\u9fff]+/gu, " ").trim();
}

function goalTerms(goal: string, input: Record<string, JsonValue>) {
  const fromGoal = compactTerm(goal).split(/\s+/).filter((item) => item.length >= 2);
  const fromInput = Object.values(input).flatMap((value) => compactTerm(String(value)).split(/\s+/)).filter((item) => item.length >= 2);
  const cjkPhrases = [goal, ...Object.values(input).map(String)].join(" ").match(/[\u4e00-\u9fff]{2,}/g) || [];
  const cjkTerms = cjkPhrases.flatMap((phrase) => {
    const terms: string[] = [];
    for (let size = 2; size <= Math.min(6, phrase.length); size += 1) {
      for (let index = 0; index <= phrase.length - size; index += 1) terms.push(phrase.slice(index, index + size));
    }
    return terms;
  });
  return [...new Set([...fromGoal, ...fromInput, ...cjkTerms])].slice(0, 40);
}

function lines(value: string) {
  return value.split(/\n+/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line.length >= 2);
}

function relevantSnippets(text: string, terms: string[]) {
  const normalizedTerms = terms.map(compactTerm).filter(Boolean);
  return lines(text)
    .filter((line) => {
      const normalized = compactTerm(line);
      return normalizedTerms.some((term) => normalized.includes(term) || term.includes(normalized));
    })
    .slice(0, 12)
    .map((line) => line.slice(0, 220));
}

function changedSnippets(beforeText: string, afterText: string) {
  const before = new Set(lines(beforeText).map(compactTerm));
  return lines(afterText)
    .filter((line) => !before.has(compactTerm(line)))
    .slice(0, 12)
    .map((line) => line.slice(0, 220));
}

function urlParts(value: string) {
  try {
    const url = new URL(value);
    return { path: url.pathname, search: url.search };
  } catch {
    return { path: value, search: "" };
  }
}

export function buildTaskJudgeEvidence(input: {
  goal: string;
  values: Record<string, JsonValue>;
  actorSuccess: boolean;
  actorText: string;
  technicalError?: string;
  start: PageSnapshot;
  end: PageSnapshot;
  steps: PageProgramStep[];
}): TaskJudgeEvidence {
  const terms = goalTerms(input.goal, input.values);
  const afterUrl = urlParts(input.end.url);
  return {
    goal: input.goal,
    input: input.values,
    actor: {
      reportedSuccess: input.actorSuccess,
      response: input.actorText.slice(0, 3_000),
      technicalError: input.technicalError?.slice(0, 1_000),
    },
    trace: input.steps.map((step) => ({ operation: step.op, targetId: "targetId" in step ? step.targetId : undefined })),
    before: evidencePage(input.start),
    after: evidencePage(input.end),
    highlights: {
      goalTerms: terms,
      afterUrlPath: afterUrl.path,
      afterUrlSearch: afterUrl.search.slice(0, 500),
      afterMatchedSnippets: relevantSnippets([input.end.title, input.end.heading, input.end.visibleText].join("\n"), terms),
      changedSnippets: changedSnippets(input.start.visibleText, input.end.visibleText),
    },
    facts: {
      actionCount: input.steps.length,
      urlChanged: input.start.url !== input.end.url,
      titleChanged: input.start.title !== input.end.title,
      headingChanged: input.start.heading !== input.end.heading,
      contentChanged: input.start.visibleText !== input.end.visibleText,
    },
  };
}

export function parseTaskOutcomeDecision(value: unknown): TaskOutcomeDecision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const statuses = ["success", "no-result", "business-rejection", "needs-more-work", "unknown"] as const;
  if (!statuses.includes(record.status as typeof statuses[number])) return undefined;
  const status = record.status as typeof statuses[number];
  const confidence = Math.max(0, Math.min(1, Number(record.confidence || 0)));
  const list = (candidate: unknown) => Array.isArray(candidate) ? candidate.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 8) : [];
  const defaultCode = status === "success" ? "judge_verified" : status === "no-result" ? "not_found" : status === "business-rejection" ? "business_rejected" : "insufficient_evidence";
  return {
    status,
    code: String(record.code || defaultCode).slice(0, 100),
    summary: String(record.summary || "还不能可靠确认任务结果。").slice(0, 800),
    confidence,
    evidence: list(record.evidence),
    missingEvidence: list(record.missingEvidence),
    nextInstruction: typeof record.nextInstruction === "string" ? record.nextInstruction.slice(0, 500) : undefined,
    source: "judge",
  };
}
