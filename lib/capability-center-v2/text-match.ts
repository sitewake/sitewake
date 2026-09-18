/**
 * Normalizes human-visible text before evaluating capability contracts.
 *
 * Sites commonly normalize user input while rendering it (for example, by
 * lower-casing search terms), and DOM text can contain compatibility-width or
 * zero-width characters. Those presentation differences must not turn a
 * successfully completed browser operation into a runtime failure.
 */
export function normalizeCapabilityText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/gu, "'")
    .replace(/[\u00AB\u00BB\u201C\u201D\u201E\u201F\u2033\u2036]/gu, '"')
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * Contract text matching stays structurally strict (the expected phrase must
 * still be present) while ignoring harmless display normalization.
 */
export function capabilityTextIncludes(actual: unknown, expected: unknown) {
  const needle = normalizeCapabilityText(expected);
  return needle.length > 0 && normalizeCapabilityText(actual).includes(needle);
}
