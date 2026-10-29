/**
 * Equality the way the capability pipeline compares values: text normalised
 * the same way C2 grounds values in evidence, structures compared canonically.
 * Kept apart from the drift report so the widget can bundle it without that
 * report's display copy.
 */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function normalizedText(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

/** Equality with the same text normalization C2 uses to ground values in evidence. */
export function expectedValuesEqual(left: unknown, right: unknown) {
  if (typeof left === "string" && typeof right === "string")
    return normalizedText(left) === normalizedText(right);
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
