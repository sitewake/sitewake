// Decides whether a task passed: by the reply's text, or by the site's state
// after the run. The decisions are pure functions over what was observed, so
// they can be tested without a browser; `probeSite` gathers the observation.

/** Case, width and spacing folded away; punctuation kept only inside numbers. */
export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[​-‍﻿]/g, "")
    .replace(/(\d),(\d{3})(?!\d)/g, "$1$2")
    .replace(/[^\p{L}\p{N}.]+/gu, " ")
    .replace(/(^|\s)\.|\.(\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every fact appears in the reply. */
export function answerContains(answer, facts) {
  const haystack = ` ${normalizeText(answer)} `;
  const missing = facts.filter((fact) => {
    const needle = normalizeText(fact);
    if (!needle) return false;
    // A bare number must stand on its own: "19" is not found inside "2019".
    if (/^\d+(?:\.\d+)?$/.test(needle)) return !new RegExp(`(?<![\\d.])${needle.replace(".", "\\.")}(?![\\d])`).test(haystack);
    return !haystack.includes(needle);
  });
  return { pass: missing.length === 0, missing };
}

/** At least one pattern matches the reply. */
export function answerMatches(answer, patterns) {
  const matched = patterns.find((pattern) => new RegExp(pattern, "iu").test(String(answer ?? "")));
  return { pass: Boolean(matched), matched };
}

/**
 * The probe's conditions hold for what was observed on the site:
 * `observed` is `{ text, counts: { selector: n }, values: { selector: text } }`.
 */
export function siteStateHolds(observed, probe) {
  const reasons = [];
  const text = normalizeText(observed?.text || "");
  for (const needle of probe.contains || []) if (!text.includes(normalizeText(needle))) reasons.push(`"${needle}" is not on ${probe.url}`);
  for (const needle of probe.absent || []) if (text.includes(normalizeText(needle))) reasons.push(`"${needle}" is still on ${probe.url}`);
  if (probe.count) {
    const found = observed?.counts?.[probe.count.selector];
    if (found !== probe.count.equals) reasons.push(`${probe.count.selector} matched ${found ?? "nothing"} element(s), expected ${probe.count.equals}`);
  }
  if (probe.value) {
    const found = observed?.values?.[probe.value.selector];
    if (String(found ?? "") !== String(probe.value.equals)) reasons.push(`${probe.value.selector} is ${JSON.stringify(found ?? null)}, expected ${JSON.stringify(probe.value.equals)}`);
  }
  return { pass: reasons.length === 0, reasons };
}

/** Opens the probe page in the visitor's own context and collects what the conditions need. */
export async function probeSite(context, siteBase, probe) {
  const page = await context.newPage();
  try {
    await page.goto(`${siteBase}${probe.url}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(2_000);
    const observed = await page.evaluate(({ countSelector, valueSelector, valueAttribute }) => {
      const counts = {};
      const values = {};
      if (countSelector) counts[countSelector] = document.querySelectorAll(countSelector).length;
      if (valueSelector) {
        const element = document.querySelector(valueSelector);
        values[valueSelector] = element ? (valueAttribute ? (element.getAttribute(valueAttribute) ?? element[valueAttribute] ?? "") : (element.textContent || "").trim()) : undefined;
      }
      return { text: document.body?.innerText || "", counts, values, url: location.href };
    }, { countSelector: probe.count?.selector, valueSelector: probe.value?.selector, valueAttribute: probe.value?.attribute });
    return observed;
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** The verdict for one ask: `{ pass, detail }`, with the observation kept for the report. */
export async function judge(expect, { answer, context, siteBase }) {
  if (expect.type === "answer-contains") {
    const verdict = answerContains(answer, expect.facts);
    return { pass: verdict.pass, detail: verdict.pass ? "every fact present" : `missing: ${verdict.missing.join(" | ")}` };
  }
  if (expect.type === "answer-matches") {
    const verdict = answerMatches(answer, expect.patterns);
    return { pass: verdict.pass, detail: verdict.pass ? `matched /${verdict.matched}/` : "no pattern matched" };
  }
  if (expect.type === "site-state") {
    const observed = await probeSite(context, siteBase, expect.probe);
    const verdict = siteStateHolds(observed, expect.probe);
    return { pass: verdict.pass, detail: verdict.pass ? `state holds on ${expect.probe.url}` : verdict.reasons.join("; "), observed: { url: observed.url, counts: observed.counts, values: observed.values, text: observed.text.slice(0, 600) } };
  }
  return { pass: false, detail: `unknown expectation type ${expect.type}` };
}
