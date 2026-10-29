import type { JsonObject, JsonValue } from "./model";

/**
 * How a frozen case's `expected` is read against the output a replay produced.
 *
 * `expected` is a prediction the C2 turn made for an input it never ran the
 * program on. Nothing here decides whether a case passed: every difference is
 * drift, it travels with the validation result, and the review turn reads it.
 */
export type ExpectedOutputDrift = {
  key: string;
  expected: JsonValue;
  actual: JsonValue;
};

export type ExpectedOutputComparison = {
  /** Every predicted value the replay did not reproduce. */
  drift: ExpectedOutputDrift[];
};

import { expectedValuesEqual } from "./value-equality";
export { expectedValuesEqual };

function leafValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(leafValues);
  if (value && typeof value === "object")
    return Object.values(value as Record<string, unknown>).flatMap(leafValues);
  return [value];
}

/**
 * `expected` is a prediction, and a prediction is not a fact.
 *
 * It used to decide whether a case passed: a missing key failed it, and a key
 * whose value repeated one of the case's own inputs failed it too. Both refused
 * capabilities that work. A page writes a date one way and a person writes it
 * another; a field the prediction named may be absent because the page had
 * nothing to put there, which the contract's own outputSchema is what decides.
 *
 * So nothing here fails a case any more. Every difference is reported as drift
 * and travels with the validation result, where the review turn reads it and
 * decides what it means. What still fails a case is what has nothing to do with
 * predictions: a program that crashes, one whose output the outputSchema
 * refuses, one whose contract's success conditions do not hold on the page, and
 * outputs that came back identical from cases that were meant to differ.
 */
export function compareCapabilityExpectedOutput(options: {
  expected: JsonObject;
  actual: JsonObject;
  input: JsonObject;
}): ExpectedOutputComparison {
  const comparison: ExpectedOutputComparison = { drift: [] };
  for (const [key, expectedValue] of Object.entries(options.expected)) {
    if (!Object.hasOwn(options.actual, key)) {
      comparison.drift.push({ key, expected: expectedValue, actual: null });
      continue;
    }
    const actualValue = options.actual[key];
    if (expectedValuesEqual(actualValue, expectedValue)) continue;
    comparison.drift.push({ key, expected: expectedValue, actual: actualValue });
  }
  return comparison;
}

/**
 * Outputs that came back identical from cases that were meant to differ.
 *
 * Two distinct cases exist so that a different input produces a different
 * answer. Where the frozen expectations disagree about a field and the replay
 * returned the same value for every case, the program is not reading that
 * field from the item it acted on — it is reading something fixed on the page.
 * A capability shipped this way: asked for rank 1 and rank 5 it returned the
 * site's own document title as `targetTitle` both times, and because a title
 * is not one of the input's own values, each case recorded it as drift and
 * passed.
 *
 * Only fields the expectations disagree about are examined, so a field that is
 * genuinely the same for every case is left alone.
 */
export function outputsConstantAcrossCases(
  cases: ReadonlyArray<{ expected: JsonObject }>,
  outputs: ReadonlyArray<JsonObject>,
) {
  if (cases.length < 2 || outputs.length !== cases.length) return [];
  const constant: string[] = [];
  const keys = new Set(cases.flatMap((item) => Object.keys(item.expected || {})));
  for (const key of keys) {
    const predicted = cases.map((item) => item.expected?.[key]);
    if (predicted.some((value) => value === undefined)) continue;
    if (predicted.every((value) => expectedValuesEqual(value, predicted[0]))) continue;
    const actual = outputs.map((output) => output?.[key]);
    if (actual.some((value) => value === undefined)) continue;
    if (actual.every((value) => expectedValuesEqual(value, actual[0]))) constant.push(key);
  }
  return constant;
}

/** One line for an event or error message; values are shortened so a page dump never becomes the message. */
export function describeExpectedOutputDrift(drift: ExpectedOutputDrift[]) {
  const short = (value: JsonValue) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}…` : text;
  };
  return drift.map((item) => `${item.key}: 预期 ${JSON.stringify(short(item.expected))}，实际 ${JSON.stringify(short(item.actual))}`).join("；");
}
