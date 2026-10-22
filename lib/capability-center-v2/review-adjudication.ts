import type { ModelConfig } from "../model-config";
import type { CapabilityProgram, JsonValue } from "./model";
import { requestStructuredModelJson } from "./model-json";
import { REVIEW_CLAIM_EXTRACTION_PROMPT } from "./prompts/review-claim-extraction";
import { containsLiteral, stripJavaScriptComments } from "./quality";
import { sourceConsumesInputPath } from "./javascript-runtime";

/**
 * A publish-review rejection stands only if the facts it cites are true. The
 * reviewer is a model reading a large payload; it can misread a stage's io
 * declaration the way a lamp capability was rejected on the claim that stages
 * "declare empty io.reads" — stage_8 in that program declared plugType and
 * consumed it. This module extracts the rejection's checkable claims and
 * verifies each one against the program and its source before the rejection
 * is allowed to block publication. A rejection whose claims do not check out
 * is overturned; the deterministic quality gate and Validation stay the
 * authority either way.
 */

/** Canonical receipt when every extracted claim fails verification. Stored on the review record. */
export const REVIEW_REJECTION_UNSUBSTANTIATED =
  "ai review approved; the rejection's claims do not match the program";

export type ReviewClaimKind =
  | "empty_reads_consumes_input"
  | "required_input_not_consumed"
  | "undeclared_input_read"
  | "demonstration_value_hardcoded"
  | "other";

export type ReviewClaim = {
  kind: ReviewClaimKind;
  stage?: string;
  input?: string;
  detail?: string;
};

export type ReviewAdjudication = {
  /** Claims the extraction step produced. */
  claims: number;
  /** Claims that survived deterministic verification. */
  verified: number;
  /** Every claim failed verification, so the rejection was overturned. */
  unsubstantiated: boolean;
  /** The adjudicator itself failed; the original rejection stands. */
  error?: string;
};

const CLAIM_KINDS = new Set<string>([
  "empty_reads_consumes_input",
  "required_input_not_consumed",
  "undeclared_input_read",
  "demonstration_value_hardcoded",
  "other",
]);

/** Providers occasionally mistype an enum value; a close miss still names its claim. */
function normalizeClaimKind(value: string): ReviewClaimKind {
  if (CLAIM_KINDS.has(value)) return value as ReviewClaimKind;
  if (/^empty.?reads.?consumes.?input$/iu.test(value)) return "empty_reads_consumes_input";
  if (/^required.?input.?not.?consumed$/iu.test(value)) return "required_input_not_consumed";
  if (/^un(?:de)?declared[ _-]?input[ _-]?read$/iu.test(value)) return "undeclared_input_read";
  if (/^demonstration.?value.?hardcoded$/iu.test(value)) return "demonstration_value_hardcoded";
  return "other";
}

export function parseReviewClaims(value: Record<string, unknown>): ReviewClaim[] {
  const raw = Array.isArray(value.claims) ? value.claims : [];
  return raw.flatMap((item): ReviewClaim[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const claim = item as Record<string, unknown>;
    const kind = normalizeClaimKind(String(claim.kind || "other"));
    const stage = typeof claim.stage === "string" && claim.stage.trim() ? claim.stage.trim() : undefined;
    const input = typeof claim.input === "string" && claim.input.trim() ? claim.input.trim() : undefined;
    const detail = typeof claim.detail === "string" && claim.detail.trim() ? claim.detail.trim() : undefined;
    return [{ kind, ...(stage ? { stage } : {}), ...(input ? { input } : {}), ...(detail ? { detail } : {}) }];
  }).slice(0, 8);
}

/**
 * Which inputs each stage's source actually reads. The authoring template
 * fixes the module shape (`export const capability = { stages: [ { id, ...,
 * async run() {} } ] }`), so a small scanner splits the stage objects by
 * brace matching instead of pulling a whole parser into the control-plane
 * bundle. Strings, templates and regex literals are skipped while matching;
 * a body that defeats the scanner yields no entry for that stage, and a
 * missing entry only ever fails a claim toward keeping the rejection.
 */
export function stageInputReads(source: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const text = stripJavaScriptComments(source);
  const stagesMatch = /\bstages\s*:\s*\[/u.exec(text);
  if (!stagesMatch || stagesMatch.index === undefined) return found;
  const elements = topLevelObjects(text, stagesMatch.index + stagesMatch[0].length - 1);
  for (const span of elements) {
    const idMatch = /\bid\s*:\s*"([^"]+)"/u.exec(text.slice(span.start, span.end));
    if (!idMatch) continue;
    const reads = new Set<string>();
    const body = text.slice(span.start, span.end);
    const refPattern = /\binput\s*\[\s*["']([^"']+)["']\s*\]|\binput\s*\.([A-Za-z_$][\w$]*)/gu;
    let ref: RegExpExecArray | null;
    while ((ref = refPattern.exec(body))) reads.add(ref[1] || ref[2]);
    found.set(idMatch[1], reads);
  }
  return found;
}

/**
 * The `{ ... }` objects directly inside the `[` at `openIndex`, matched with
 * string/template/regex awareness. Returns each object's span.
 */
function topLevelObjects(text: string, openIndex: number): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  let quote = "";
  let inRegex = false;
  let previousSignificant = "";
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1] || "";
    if (quote) {
      if (char === "\\") { index += 1; continue; }
      if (char === quote) quote = "";
      continue;
    }
    if (inRegex) {
      if (char === "\\") { index += 1; continue; }
      if (char === "[") { let cls = index + 1; while (cls < text.length && text[cls] !== "]") { if (text[cls] === "\\") cls += 1; cls += 1; } index = cls; continue; }
      if (char === "/") inRegex = false;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "/" && next === "/") { while (index < text.length && text[index] !== "\n") index += 1; continue; }
    if (char === "/" && next === "*") { index = text.indexOf("*/", index + 2) + 1 || text.length; continue; }
    if (char === "/" && !/[\w$)\]]/u.test(previousSignificant)) { inRegex = true; continue; }
    if (char === "{") { if (depth === 0) start = index; depth += 1; previousSignificant = char; continue; }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) spans.push({ start, end: index + 1 });
      previousSignificant = char;
      continue;
    }
    if (char === "]" && depth === 0) break;
    if (!/\s/u.test(char)) previousSignificant = char;
  }
  return spans;
}

type AdjudicationProgram = Pick<CapabilityProgram, "stages" | "parameterRoles">;

export type ReviewClaimContext = {
  program: AdjudicationProgram;
  source: string;
  requiredInputs: string[];
  demonstrationParameters?: Record<string, JsonValue>;
};

/**
 * The subset of claims whose named facts hold against the program. A claim
 * that cannot be checked (unknown stage, missing input, "other") does not
 * verify; letting the rejection stand is the safe direction for anything the
 * checker cannot disprove.
 */
export function verifyReviewClaims(claims: ReviewClaim[], context: ReviewClaimContext): ReviewClaim[] {
  const stagesById = new Map(context.program.stages.map((stage) => [stage.id, stage]));
  const readsByStage = stageInputReads(context.source);
  const programInputs = new Set(context.program.parameterRoles.map((role) => role.inputPath.split(".")[0] || ""));
  return claims.filter((claim) => {
    switch (claim.kind) {
      case "empty_reads_consumes_input": {
        const stage = claim.stage ? stagesById.get(claim.stage) : undefined;
        if (!stage) return false;
        const declared = stage.io?.reads?.input || [];
        if (declared.length > 0) return false;
        const reads = readsByStage.get(stage.id);
        if (!reads || !reads.size) return false;
        return claim.input ? reads.has(claim.input) : true;
      }
      case "required_input_not_consumed": {
        const name = claim.input;
        if (!name || !context.requiredInputs.includes(name)) return false;
        return !(programInputs.has(name) && sourceConsumesInputPath(context.source, name));
      }
      case "undeclared_input_read": {
        const stage = claim.stage ? stagesById.get(claim.stage) : undefined;
        const name = claim.input;
        if (!stage || !name) return false;
        const reads = readsByStage.get(stage.id);
        if (!reads?.has(name)) return false;
        const declaredRoots = new Set((stage.io?.reads?.input || []).map((path) => path.split(".")[0] || ""));
        return !declaredRoots.has(name);
      }
      case "demonstration_value_hardcoded": {
        const name = claim.input;
        if (!name) return false;
        const demonstrated = context.demonstrationParameters?.[name];
        if (typeof demonstrated !== "string" || demonstrated.trim().length < 2) return false;
        return containsLiteral(stripJavaScriptComments(context.source), demonstrated.trim());
      }
      default:
        return false;
    }
  });
}

export type AdjudicatedReviewDecision = {
  decision: "Approved" | "Rejected";
  reason: string;
  adjudication: ReviewAdjudication;
};

/**
 * Rejection adjudication: extract the claims, verify them, and overturn a
 * rejection whose claims do not check out. Any failure in the adjudicator
 * itself (model error, malformed output) leaves the original rejection
 * standing — a conservative failure direction, matching the gate's.
 */
export async function adjudicateReviewRejection(
  config: ModelConfig,
  input: {
    reason: string;
    program: AdjudicationProgram;
    source: string;
    requiredInputs: string[];
    demonstrationParameters?: Record<string, JsonValue>;
    timeoutMs?: number;
  },
): Promise<AdjudicatedReviewDecision> {
  const keepRejection: AdjudicatedReviewDecision = {
    decision: "Rejected",
    reason: input.reason,
    adjudication: { claims: 0, verified: 0, unsubstantiated: false },
  };
  try {
    const prompt = REVIEW_CLAIM_EXTRACTION_PROMPT;
    const response = await requestStructuredModelJson(config, {
      system: prompt.text,
      payload: {
        reason: input.reason,
        requiredInputs: input.requiredInputs,
        stages: input.program.stages.map((stage) => ({
          id: stage.id,
          readsInput: stage.io?.reads?.input || [],
        })),
      },
      timeoutMs: input.timeoutMs ?? 120_000,
      maxTokens: 1500,
      attempts: 2,
      disableThinking: true,
      jsonSchema: prompt.outputSchema,
      validate: (value) => { parseReviewClaims(value); },
    });
    const claims = parseReviewClaims(response);
    const verified = verifyReviewClaims(claims, {
      program: input.program,
      source: input.source,
      requiredInputs: input.requiredInputs,
      demonstrationParameters: input.demonstrationParameters,
    });
    if (verified.length > 0) {
      return { ...keepRejection, adjudication: { claims: claims.length, verified: verified.length, unsubstantiated: false } };
    }
    return {
      decision: "Approved",
      reason: REVIEW_REJECTION_UNSUBSTANTIATED,
      adjudication: { claims: claims.length, verified: 0, unsubstantiated: true },
    };
  } catch (error) {
    return {
      ...keepRejection,
      adjudication: { ...keepRejection.adjudication, error: error instanceof Error ? error.message : String(error) },
    };
  }
}
