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

function quoted(value: string | undefined, fallback: string) {
  return `“${value?.trim() || fallback}”`;
}

/**
 * Converts V2 runtime codes into stable, user-facing explanations. Technical
 * details stay in evidence; callers never have to display raw executor codes.
 */
export function explainCapabilityRuntimeFailure(context: CapabilityRuntimeFailureContext): CapabilityRuntimeFailureExplanation {
  const separator = context.technicalError.indexOf(":");
  const code = separator < 0 ? context.technicalError : context.technicalError.slice(0, separator);
  const capability = quoted(context.capabilityName, "当前能力");
  const target = quoted(context.targetLabel, "页面操作入口");
  const input = quoted(context.inputLabel, "必要参数");
  const partialWarning = context.sideEffectStarted
    ? "此前的页面操作可能已经部分生效，请先检查当前状态，不要直接重复执行。"
    : "本次尚未执行任何页面操作。";

  if (code === "locator_not_found") return {
    code,
    summary: `执行${capability}时，当前页面没有找到所需的${target}。${partialWarning}`,
    repairSuggested: true,
    recognized: true,
  };
  if (code === "target_ambiguous") return {
    code,
    summary: `执行${capability}时，页面上有多个符合条件的${target}，无法安全确定操作对象。为避免误操作，任务已停止。${context.sideEffectStarted ? partialWarning : ""}`,
    repairSuggested: true,
    recognized: true,
  };
  if (code === "wait_timeout") return {
    code,
    summary: `执行${capability}时，等待${target}就绪超时。页面可能仍在加载，也可能已经发生变化。${partialWarning}`,
    repairSuggested: true,
    recognized: true,
  };
  if (code === "precondition_url_mismatch") return {
    code,
    summary: `当前页面不符合${capability}要求的入口条件，因此没有开始执行。请从正确页面重试。`,
    repairSuggested: true,
    recognized: true,
  };
  if (code === "precondition_text_missing") return {
    code,
    summary: `当前页面缺少执行${capability}所需的业务前置状态，因此没有开始执行。`,
    repairSuggested: true,
    recognized: true,
  };
  if (code === "capability_input_required" || code === "precondition_input_missing" || code.startsWith("capability_run_input_")) return {
    code,
    summary: `执行${capability}缺少必要输入${input}，因此没有开始操作页面。`,
    repairSuggested: false,
    recognized: true,
  };
  if (code.startsWith("success_") || code === "capability_result_unverified" || code.startsWith("capability_output_")) return {
    code,
    summary: `${capability}已经执行页面操作，但没有观察到约定的成功结果。任务未被判定成功；操作可能已经部分生效，请检查页面状态后再决定是否重试。`,
    repairSuggested: true,
    recognized: true,
  };
  if (code === "capability_navigation_origin_invalid") return {
    code,
    summary: `${capability}试图跳转到当前网站允许范围之外的地址，系统已阻止该操作。`,
    repairSuggested: true,
    recognized: true,
  };
  if (code === "fill_verification_failed") return {
    code,
    summary: `执行${capability}时，页面没有接受写入${target}的内容。页面控件可能已变化，任务已停止。${partialWarning}`,
    repairSuggested: true,
    recognized: true,
  };
  if (code === "target_not_checkbox") return {
    code,
    summary: `执行${capability}时，${target}已不再是预期的勾选控件。为避免误操作，任务已停止。${partialWarning}`,
    repairSuggested: true,
    recognized: true,
  };
  if (code === "upload_requires_user_interaction") return {
    code,
    summary: `${capability}需要用户手动选择并上传文件，当前无法自动继续。`,
    repairSuggested: false,
    recognized: true,
  };
  if (code === "task_cancelled") return {
    code,
    summary: `${capability}已停止。${context.sideEffectStarted ? "停止前的操作可能已经部分生效，请检查页面当前状态。" : "尚未执行页面操作。"}`,
    repairSuggested: false,
    recognized: true,
  };
  return {
    code: code || "runtime_error",
    summary: `执行${capability}时遇到未能识别的运行问题，任务没有可靠完成。${partialWarning}`,
    repairSuggested: false,
    recognized: false,
  };
}
