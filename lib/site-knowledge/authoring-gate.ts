// Deterministic fixture evaluation + submit gate for the AI CODING harness.
//
// The browser run itself is non-deterministic (a real page + a model), so it is
// injected. Everything here — parsing acceptance cases, comparing a run result
// against expectations, aggregating a report, and deciding whether submit is
// allowed — is pure and unit-tested. This is the logic that must never be the
// reason a run fails: with these tests green, a live failure is the model's or
// the page's, not the flow's.

import type { JsonValue, OutcomeStatus } from "./protocol";

export type CapabilityFixture = {
  id: string;
  title?: string;
  input: Record<string, JsonValue>;
  expect?: {
    outcome?: OutcomeStatus; // defaults to "success"
    fields?: string[]; // result field ids that must be produced
    contains?: Record<string, JsonValue>; // optional exact value assertions
  };
};

export type FixtureRunResult = {
  fixtureId: string;
  outcome: OutcomeStatus;
  producedFieldIds: string[];
  producedValues?: Record<string, JsonValue>;
  runId?: string;
  error?: string;
};

export type FixtureCaseReport = {
  fixtureId: string;
  passed: boolean;
  gaps: string[];
};

export type TestReport = {
  total: number;
  passed: number;
  failed: number;
  cases: FixtureCaseReport[];
  coveredFieldIds: string[];
};

export type FixtureParse =
  | { ok: true; cases: CapabilityFixture[] }
  | { ok: false; code: string; message: string };

/** Parse and validate the fixtures.json document. */
export function parseFixtures(json: string): FixtureParse {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    return { ok: false, code: "fixtures_invalid_json", message: "fixtures.json is not valid JSON" };
  }
  const rawCases = (doc as { cases?: unknown } | null)?.cases;
  if (rawCases !== undefined && !Array.isArray(rawCases)) {
    return { ok: false, code: "fixtures_shape", message: "fixtures.json must be { cases: [...] }" };
  }
  const cases: CapabilityFixture[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (Array.isArray(rawCases) ? rawCases : []).entries()) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, code: "fixtures_case_shape", message: `case #${index} must be an object` };
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : `case-${index + 1}`;
    if (seen.has(id)) return { ok: false, code: "fixtures_duplicate_id", message: `duplicate fixture id "${id}"` };
    seen.add(id);
    const input = record.input;
    if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
      return { ok: false, code: "fixtures_input_shape", message: `case "${id}" input must be an object` };
    }
    const expectRaw = record.expect;
    let expect: CapabilityFixture["expect"];
    if (expectRaw !== undefined) {
      if (typeof expectRaw !== "object" || expectRaw === null || Array.isArray(expectRaw)) {
        return { ok: false, code: "fixtures_expect_shape", message: `case "${id}" expect must be an object` };
      }
      const expectRecord = expectRaw as Record<string, unknown>;
      const fields = expectRecord.fields;
      if (fields !== undefined && (!Array.isArray(fields) || fields.some((field) => typeof field !== "string"))) {
        return { ok: false, code: "fixtures_expect_fields", message: `case "${id}" expect.fields must be a string[]` };
      }
      expect = {
        outcome: typeof expectRecord.outcome === "string" ? (expectRecord.outcome as OutcomeStatus) : undefined,
        fields: fields as string[] | undefined,
        contains: (expectRecord.contains as Record<string, JsonValue> | undefined) ?? undefined,
      };
    }
    cases.push({ id, title: typeof record.title === "string" ? record.title : undefined, input: (input as Record<string, JsonValue>) ?? {}, expect });
  }
  return { ok: true, cases };
}

function stableEqual(a: JsonValue | undefined, b: JsonValue): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b);
}

/** Compare one run result against one fixture's expectations. */
export function evaluateFixtureCase(fixture: CapabilityFixture, result: FixtureRunResult): FixtureCaseReport {
  const gaps: string[] = [];
  const expectedOutcome = fixture.expect?.outcome ?? "success";
  if (result.error) gaps.push(`run error: ${result.error}`);
  if (result.outcome !== expectedOutcome) gaps.push(`outcome ${result.outcome} != expected ${expectedOutcome}`);
  for (const field of fixture.expect?.fields ?? []) {
    if (!result.producedFieldIds.includes(field)) gaps.push(`missing field "${field}"`);
  }
  for (const [field, value] of Object.entries(fixture.expect?.contains ?? {})) {
    if (!stableEqual(result.producedValues?.[field], value)) gaps.push(`field "${field}" != expected value`);
  }
  return { fixtureId: fixture.id, passed: gaps.length === 0, gaps };
}

/** Aggregate a full run of fixtures into a report. Missing results count as failures. */
export function summarizeTestReport(fixtures: CapabilityFixture[], results: FixtureRunResult[]): TestReport {
  const byId = new Map(results.map((result) => [result.fixtureId, result]));
  const covered = new Set<string>();
  const cases: FixtureCaseReport[] = fixtures.map((fixture) => {
    const result = byId.get(fixture.id);
    if (!result) return { fixtureId: fixture.id, passed: false, gaps: ["no run result"] };
    for (const field of result.producedFieldIds) covered.add(field);
    return evaluateFixtureCase(fixture, result);
  });
  const passed = cases.filter((item) => item.passed).length;
  return { total: cases.length, passed, failed: cases.length - passed, cases, coveredFieldIds: [...covered].sort() };
}

export type SubmitGateInput = {
  report: TestReport;
  provingRuns: Array<{ outcome: OutcomeStatus; producedFieldIds: string[] }>;
};

export type SubmitGateResult = { ok: true } | { ok: false; reasons: string[] };

/**
 * The self-verification gate. submit is only allowed when the flow has proof —
 * not a model claim — that the capability works: at least one fixture, all
 * green, and at least one successful proving run. Rich schema/type validation
 * intentionally belongs to a later qualification stage; the first usable
 * pipeline only proves that Codex produced and ran a real module.
 */
export function evaluateSubmitGate(input: SubmitGateInput): SubmitGateResult {
  const reasons: string[] = [];
  if (input.report.total === 0) reasons.push("no fixtures: add at least one acceptance case to fixtures.json");
  if (input.report.failed > 0) reasons.push(`${input.report.failed} of ${input.report.total} fixtures are failing`);
  const successRuns = input.provingRuns.filter((run) => run.outcome === "success");
  if (successRuns.length === 0) reasons.push("no successful proving run: run the capability to completion at least once before submit");
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
