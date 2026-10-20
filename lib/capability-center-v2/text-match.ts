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

/** Case, spacing and punctuation free: a slug and its visible label are one value. */
export function capabilityTextToken(value: unknown) {
  return String(value).normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, "");
}

const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** Words, with a change into or out of an unspaced script as a boundary: "搜索Echo商品" holds "echo". */
function words(value: unknown) {
  return String(value).normalize("NFKC").toLocaleLowerCase("zh-CN")
    .replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu, " $& ")
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Whether `text` mentions `value` as a whole. In a script that separates words
 * the value's words must appear in order as whole words, so "red" is not found
 * in "ordered" nor "us" in "focus"; in one that does not (Chinese, Japanese),
 * the run of characters is all there is to match.
 */
export function capabilityTextMentions(text: unknown, value: unknown) {
  const needle = words(value);
  if (!needle.length || capabilityTextToken(value).length < 2) return false;
  if (UNSPACED_SCRIPT.test(needle.join(""))) return capabilityTextToken(text).includes(capabilityTextToken(value));
  const haystack = words(text);
  return haystack.some((_, start) => needle.every((word, offset) => haystack[start + offset] === word));
}
