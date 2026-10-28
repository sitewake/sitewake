import type { JsonValue } from "./model";
import { sourceHardcodesValue } from "./quality";

/**
 * The verdict on a validated candidate, decided from its validation record
 * alone. The demonstration already proved the capability once; validation
 * replayed it in a fresh context on the demonstrated input and on the values
 * the site offers beside it. What those replays came to is the whole
 * judgment: the demonstrated case passed, no offered value was left without
 * a result, no demonstrated value is written into the source, and at least
 * one case passed. Nothing here reads a model's opinion of the program; a
 * model review used to sit between validation and publication, and its two
 * correct rejections are rules below while its wrong ones needed a layer of
 * claim-checking to undo.
 */

/** The verdict when the floor holds. Stored on the version's review record. */
export const REVIEW_APPROVED_ON_VALIDATION =
  "approved on validation: the demonstrated case and the offered values passed";

/** Deterministic rejections; details travel beside them on the event. */
export const REVIEW_DEMONSTRATION_CASE_FAILED = "review rejected: the demonstrated input's case did not pass";
export const REVIEW_DEMONSTRATION_CASE_NO_RESULT = "review rejected: the demonstrated input's case found nothing where the visitor's run found a result";
export const REVIEW_OFFERED_INPUT_NO_RESULT = "review rejected: a case found nothing for a value the site lists beside the demonstrated one";
/** The failure a validation case records when it found nothing for a value the site offers. */
export const OFFERED_INPUT_NO_RESULT = /^no_result_for_offered_input:/u;
export const REVIEW_NO_CASE_PASSED = "review rejected: no validation case passed";
export const REVIEW_DEMONSTRATION_VALUE_LEAKED = "review rejected: a demonstrated value is written into the source";

/**
 * What one validation case came to. InputNotOffered: the program asked the
 * page for the case's own input value and the page does not offer it (a
 * dropdown without that option). The case's data was wrong for this site, not
 * the program; a demonstrated value is never classified so, since the
 * demonstration showed the site offering it.
 */
export type ValidationCaseOutcome = "Passed" | "NoResult" | "InputNotOffered" | "Failed";

export type ValidationCaseResult = {
  caseId: string;
  resolvedInput?: Record<string, JsonValue>;
  noResultReason?: string;
  failureReason?: string;
};

const OPTION_MISSING = /capability_stage_select_option_missing:[^:]*:([^;\n]*);\s*options:\s*([^\n]*)/u;

function sameText(left: JsonValue | undefined, right: string) {
  return typeof left === "string" && left.normalize("NFKC").trim().toLocaleLowerCase() === right.normalize("NFKC").trim().toLocaleLowerCase();
}

export function classifyValidationCase(
  result: ValidationCaseResult,
  demonstrationParameters?: Record<string, JsonValue>,
): { outcome: ValidationCaseOutcome; offered?: string[] } {
  if (result.noResultReason) return { outcome: "NoResult" };
  if (!result.failureReason) return { outcome: "Passed" };
  const missing = OPTION_MISSING.exec(result.failureReason);
  if (missing) {
    const wanted = missing[1].trim();
    const paths = Object.entries(result.resolvedInput || {}).filter(([, value]) => sameText(value, wanted)).map(([path]) => path);
    const demonstrated = paths.some((path) => sameText(demonstrationParameters?.[path], wanted));
    if (paths.length && !demonstrated) {
      return { outcome: "InputNotOffered", offered: missing[2].split("|").map((item) => item.trim()).filter(Boolean) };
    }
  }
  return { outcome: "Failed" };
}

/**
 * The floor under publication: the demonstration's own case passed, or,
 * without one among the cases, some case did. Undefined when it holds;
 * otherwise the reason and the case it is about.
 *
 * A case that finds nothing is the capability answering, except for the
 * demonstrated input of a run the visitor saw succeed: the site had the
 * result in front of them, and a program that finds nothing there has not
 * reproduced the demonstration. "Add product to cart" was proven with one
 * cushion, reported "cart has no row matching" for it on replay, and was
 * published on that.
 */
export function validationCaseFloor(
  results: ValidationCaseResult[],
  demonstrationParameters?: Record<string, JsonValue>,
  demonstrationOutcome?: "Success" | "NoResult",
): { reason: string; caseId?: string; failure?: string } | undefined {
  const demonstration = demonstrationParameters && Object.keys(demonstrationParameters).length
    ? results.find((item) => Object.entries(demonstrationParameters).every(([path, value]) => {
      const resolved = item.resolvedInput?.[path];
      return typeof value === "string" ? sameText(resolved, value) : JSON.stringify(resolved) === JSON.stringify(value);
    }))
    : undefined;
  if (demonstration) {
    const outcome = classifyValidationCase(demonstration, demonstrationParameters).outcome;
    if (outcome === "NoResult" && demonstrationOutcome === "Success") {
      return { reason: REVIEW_DEMONSTRATION_CASE_NO_RESULT, caseId: demonstration.caseId, failure: firstLine(demonstration.noResultReason) };
    }
    if (outcome !== "Passed" && outcome !== "NoResult") {
      return { reason: REVIEW_DEMONSTRATION_CASE_FAILED, caseId: demonstration.caseId, failure: firstLine(demonstration.failureReason) };
    }
  }
  // A value the site lists beside the demonstrated one is a value the
  // capability is for; nothing found for it is the program failing, whatever
  // the other cases came to. "Count books in category" was published on
  // Poetry alone and answered every other category with the Poetry page.
  const offered = results.find((item) => OFFERED_INPUT_NO_RESULT.test(item.failureReason || ""));
  if (offered) return { reason: REVIEW_OFFERED_INPUT_NO_RESULT, caseId: offered.caseId, failure: firstLine(offered.failureReason) };
  if (demonstration) return undefined;
  return results.some((item) => classifyValidationCase(item, demonstrationParameters).outcome === "Passed")
    ? undefined
    : { reason: REVIEW_NO_CASE_PASSED };
}

/**
 * Required inputs whose demonstrated value is written into the executable
 * source: the quality gate's demonstration_value_leaked rule, applied where
 * the pipeline has the source. C2 runs that gate without it.
 */
export function hardcodedDemonstrationInputs(
  source: string,
  demonstrationParameters: Record<string, JsonValue> | undefined,
  requiredInputs: string[],
) {
  if (!source.trim()) return [];
  return Object.entries(demonstrationParameters || {})
    .filter(([key, raw]) => requiredInputs.includes(key) && typeof raw === "string" && sourceHardcodesValue(source, raw))
    .map(([key]) => key);
}

function firstLine(text?: string) {
  return String(text || "").split("\n")[0].slice(0, 300);
}

export type ValidationVerdict =
  | { decision: "Approved"; reason: string }
  | { decision: "Rejected"; reason: string; caseId?: string; failure?: string; inputs?: string[] };

/**
 * The verdict: the floor over the validation cases, then the source checked
 * for a demonstrated value written into it. Approved when neither finds
 * anything; the rejection names the case or the inputs it is about.
 */
export function validationVerdict(input: {
  results: ValidationCaseResult[];
  demonstrationParameters?: Record<string, JsonValue>;
  demonstrationOutcome?: "Success" | "NoResult";
  source?: string;
  requiredInputs: string[];
}): ValidationVerdict {
  const floor = validationCaseFloor(input.results, input.demonstrationParameters, input.demonstrationOutcome);
  if (floor) return { decision: "Rejected", ...floor };
  const hardcoded = hardcodedDemonstrationInputs(input.source || "", input.demonstrationParameters, input.requiredInputs);
  if (hardcoded.length) return { decision: "Rejected", reason: REVIEW_DEMONSTRATION_VALUE_LEAKED, inputs: hardcoded };
  return { decision: "Approved", reason: REVIEW_APPROVED_ON_VALIDATION };
}
