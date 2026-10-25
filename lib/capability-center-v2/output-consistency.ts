import type { JsonObject } from "./model";

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
