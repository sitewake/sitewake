import type { JsonObject, JsonValue } from "./model";

export type CountIgnoringList = { count: string; list: string; value: number; lengths: number[] };

/**
 * Whole-number outputs that stay the same across runs while a list in the same
 * output changes length, and that disagree with that list at least once.
 *
 * Such a number is not counting what the run found. "Find floor lamps" read
 * the 16 in "Showing 4 of 16 lamps" for every room while its own list held
 * 4, 2 and 5 lamps; every visitor was told 16. The rule reads only the
 * outputs, never field names: a page size or a total that does follow the
 * list is never caught, and neither is a count beside a list of fixed length.
 */
export function countsIgnoringTheirList(outputs: JsonObject[]): CountIgnoringList[] {
  if (outputs.length < 2) return [];
  const keys = Object.keys(outputs[0]);
  const counts = keys.filter((key) => outputs.every((output) => Number.isInteger(output[key])));
  const lists = keys.filter((key) => outputs.every((output) => Array.isArray(output[key])));
  const found: CountIgnoringList[] = [];
  for (const count of counts) {
    const value = outputs[0][count] as number;
    if (!outputs.every((output) => output[count] === value)) continue;
    for (const list of lists) {
      const lengths = outputs.map((output) => (output[list] as unknown[]).length);
      if (new Set(lengths).size < 2) continue;
      if (lengths.every((length) => length === value)) continue;
      found.push({ count, list, value, lengths });
    }
  }
  return found;
}

/** The finding as the authoring model reads it: what each run returned. */
export function describeCountIgnoringList(finding: CountIgnoringList, inputs: JsonObject[]) {
  const runs = finding.lengths.map((length, index) => `${JSON.stringify(inputs[index] || {})} → ${finding.list} has ${length}`).join("; ");
  return `${finding.count} was ${finding.value} in every run while ${finding.list} changed (${runs}). It is not counting what the run found; read the count of the matches for this input, or the number of items returned.`;
}

export type AnswerDisagreement = {
  /** The sentence the demonstration's answer led with, as the visitor read it. */
  sentence: string;
  /** The numbers that sentence states. */
  stated: string[];
  /** Every number the output states, each with where it was read. */
  output: Array<{ path: string; value: string }>;
};

const NUMBER = /\d[\d,]*(?:\.\d+)?/gu;

/** A number as it compares: thousands separators dropped, "11.90" and "11.9" the same. */
function canonicalNumber(text: string) {
  const value = Number(text.replace(/,/gu, ""));
  return Number.isFinite(value) ? String(value) : undefined;
}

function numbersIn(text: string) {
  return [...new Set((text.match(NUMBER) || []).map(canonicalNumber).filter((value): value is string => value !== undefined))];
}

/** The sentence an answer leads with: what it states before its first full stop or line break. */
function leadSentence(answer: string) {
  const match = /^[\s\S]*?(?:[.!?。！？](?=\s|$)|\n|$)/u.exec(answer.trim());
  return (match?.[0] || "").replace(/[.!?。！？]\s*$/u, "").trim();
}

/** Every number an output states: a number, the digit runs inside a string, the length of a list. */
function outputNumbers(value: JsonValue | undefined, path: string, into: Array<{ path: string; value: string }>) {
  if (typeof value === "number") {
    const number = canonicalNumber(String(value));
    if (number !== undefined) into.push({ path, value: number });
    return;
  }
  if (typeof value === "string") {
    for (const number of numbersIn(value)) into.push({ path, value: number });
    return;
  }
  if (Array.isArray(value)) {
    into.push({ path: `${path || "output"}.length`, value: String(value.length) });
    value.forEach((item, index) => outputNumbers(item, `${path}[${index}]`, into));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) outputNumbers(item, path ? `${path}.${key}` : key, into);
  }
}

/**
 * The demonstration's answer against the draft's output for the same input.
 * The answer leads with what it found — "There are 12 quotes tagged
 * 'humor'", "the cheapest is X at £11.90" — and an output that states none of
 * the numbers that lead sentence states did not find it. Only a number the
 * output states somewhere (a value, inside a string, the length of a list)
 * counts as agreement, and one agreeing number is enough: an answer that
 * goes on to a cart total and a shipping fee is not contradicted by an output
 * that carries the quantity alone. An answer whose lead sentence states no
 * number says nothing here.
 */
export function demonstrationAnswerDisagreement(output: JsonObject, answer: string | undefined): AnswerDisagreement | undefined {
  if (typeof answer !== "string" || !answer.trim()) return undefined;
  const sentence = leadSentence(answer);
  const stated = numbersIn(sentence);
  if (!stated.length) return undefined;
  const found: Array<{ path: string; value: string }> = [];
  outputNumbers(output, "", found);
  if (found.some((item) => stated.includes(item.value))) return undefined;
  return { sentence, stated, output: found };
}

/** The finding as the authoring model reads it: what the visitor was told, what the draft returned. */
export function describeAnswerDisagreement(finding: AnswerDisagreement, input: JsonObject) {
  const states = finding.output.length
    ? finding.output.slice(0, 8).map((item) => `${item.value} (${item.path})`).join(", ")
    : "no number at all";
  return `the demonstration answered ${JSON.stringify(finding.sentence)} for ${JSON.stringify(input)}, which states ${finding.stated.join(", ")}; the draft's output for the same input states ${states}, and none of them agree. The draft must find what the demonstration found: read observation.text on the page the demonstration ended on and take the whole result — every page of a paginated list, the total where the page states one — not the part that happens to be in view.`;
}
