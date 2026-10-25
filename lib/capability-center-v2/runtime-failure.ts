export type CapabilityRuntimeFailureContext = {
  technicalError: string;
  capabilityName: string;
  targetLabel?: string;
  inputLabel?: string;
  sideEffectStarted: boolean;
};

export type CapabilityRuntimeFailureExplanation = {
  code: string;
  summary: string;
  repairSuggested: boolean;
  /** False when no rule matched and the generic "unrecognized" wording was used. */
  recognized: boolean;
};

export type CapabilityStageReceiptSummary = { stageId: string; status: string };

/**
 * True when every action Stage completed and only the terminal verification
 * Stage failed. The page work is done; what failed is the capability's own
 * reading of the result, which is a capability defect, not a page fault — the
 * caller reports it as such and a repair can re-author that Stage.
 */
export function capabilityVerificationOnlyFailure(context: {
  stages: Array<{ id: string }>;
  receipts: CapabilityStageReceiptSummary[];
  activeStageId?: string;
}): boolean {
  const terminal = context.stages.at(-1);
  if (!terminal || context.stages.length < 2) return false;
  if (context.activeStageId && context.activeStageId !== terminal.id) return false;
  const completed = new Set(context.receipts.filter((receipt) => receipt.status === "Completed").map((receipt) => receipt.stageId));
  if (completed.has(terminal.id)) return false;
  if (!context.receipts.some((receipt) => receipt.stageId === terminal.id)) return false;
  return context.stages.slice(0, -1).every((stage) => completed.has(stage.id));
}

/**
 * The words a visitor reads when a capability fails, in the visitor's
 * language. The explanation rules live here; the sentences live in the widget
 * copy catalogs, so an English visitor never reads a Chinese failure.
 */
export type CapabilityRuntimeFailureWording = {
  quote: (value: string) => string;
  currentCapability: string;
  pageEntry: string;
  requiredInput: string;
  partialWarning: string;
  nothingDone: string;
  locatorNotFound: (capability: string, target: string, warning: string) => string;
  targetAmbiguous: (capability: string, target: string, warning: string) => string;
  waitTimeout: (capability: string, target: string, warning: string) => string;
  preconditionUrlMismatch: (capability: string) => string;
  preconditionTextMissing: (capability: string) => string;
  inputRequired: (capability: string, input: string) => string;
  resultUnverified: (capability: string) => string;
  navigationOriginInvalid: (capability: string) => string;
  fillVerificationFailed: (capability: string, target: string, warning: string) => string;
  targetNotCheckbox: (capability: string, target: string, warning: string) => string;
  uploadRequiresUser: (capability: string) => string;
  cancelled: (capability: string, sideEffectStarted: boolean) => string;
  unrecognized: (capability: string, warning: string) => string;
};

/**
 * Converts V2 runtime codes into stable, user-facing explanations. Technical
 * details stay in evidence; callers never have to display raw executor codes.
 */
export function explainCapabilityRuntimeFailure(context: CapabilityRuntimeFailureContext, say: CapabilityRuntimeFailureWording): CapabilityRuntimeFailureExplanation {
  const separator = context.technicalError.indexOf(":");
  const code = separator < 0 ? context.technicalError : context.technicalError.slice(0, separator);
  const capability = say.quote(context.capabilityName?.trim() || say.currentCapability);
  const target = say.quote(context.targetLabel?.trim() || say.pageEntry);
  const input = say.quote(context.inputLabel?.trim() || say.requiredInput);
  const warning = context.sideEffectStarted ? say.partialWarning : say.nothingDone;
  const recognized = (summary: string, repairSuggested = true) => ({ code, summary, repairSuggested, recognized: true });

  if (code === "locator_not_found") return recognized(say.locatorNotFound(capability, target, warning));
  if (code === "target_ambiguous") return recognized(say.targetAmbiguous(capability, target, context.sideEffectStarted ? say.partialWarning : ""));
  if (code === "wait_timeout") return recognized(say.waitTimeout(capability, target, warning));
  if (code === "precondition_url_mismatch") return recognized(say.preconditionUrlMismatch(capability));
  if (code === "precondition_text_missing") return recognized(say.preconditionTextMissing(capability));
  if (code === "capability_input_required" || code === "precondition_input_missing" || code.startsWith("capability_run_input_")) return recognized(say.inputRequired(capability, input), false);
  if (code.startsWith("success_") || code === "capability_result_unverified" || code.startsWith("capability_output_")) return recognized(say.resultUnverified(capability));
  if (code === "capability_navigation_origin_invalid") return recognized(say.navigationOriginInvalid(capability));
  if (code === "fill_verification_failed") return recognized(say.fillVerificationFailed(capability, target, warning));
  if (code === "target_not_checkbox") return recognized(say.targetNotCheckbox(capability, target, warning));
  if (code === "upload_requires_user_interaction") return recognized(say.uploadRequiresUser(capability), false);
  if (code === "task_cancelled") return recognized(say.cancelled(capability, context.sideEffectStarted), false);
  return {
    code: code || "runtime_error",
    summary: say.unrecognized(capability, warning),
    repairSuggested: false,
    recognized: false,
  };
}

/**
 * The value a stage was asked to choose, and what the page offered instead,
 * when the page does not offer it (`capability_stage_select_option_missing`).
 * That is an answer for the visitor, not a fault of the capability.
 */
export function capabilityOptionNotOffered(technicalError: string): { wanted: string; offered: string[] } | undefined {
  const match = /capability_stage_select_option_missing:[^:]*:([^;\n]*);\s*options:\s*([^\n]*)/u.exec(technicalError);
  if (!match) return undefined;
  const offered = match[2].split("|").map((item) => item.trim()).filter(Boolean);
  return { wanted: match[1].trim(), offered };
}
