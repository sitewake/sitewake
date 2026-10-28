/**
 * One class and one stage for every failure, from a fixed table.
 *
 * The pipeline and the widget raise some four hundred distinct codes. They
 * stay as the detail; this is the grouping the console, the benchmark and a
 * person reading a report share, so "what kind of failure is this" has one
 * answer wherever it is asked. A code the table does not know is
 * `unclassified`, which the benchmark counts as a defect of this table.
 */

export const FAILURE_CLASSES = [
  "model-protocol",
  "model-budget",
  "wrong-answer",
  "site-changed",
  "site-unreachable",
  "site-auth",
  "pipeline-contradiction",
  "gate-false-reject",
  "bad-test-data",
  "host-difference",
  "navigation-lost",
  "timeout",
  "harness",
  "unclassified",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export type FailureAttribution = {
  failureClass: FailureClass;
  failureStage: string;
};

/**
 * Codes that are not failures of a task or a run: successful outcomes,
 * transient states, and the request errors an API answers a caller with.
 * The source scan in tests asserts every other code maps to a class.
 */
export const NON_FAILURE_CODES: RegExp[] = [
  /^(?:agent_completed|conversation_completed|capability_v2_program_verified|answer_from_indexed_text|user_cancelled|cancelled|completed|running|pending)$/,
  /^(?:case_enrichment_demonstrated_case_kept|capability_maintenance_in_progress|capability_experience_source_version_required|capability_experience_source_required|task_cancelled|verified_program|reconciliation_completed)$/,
  /^(?:site_id_|invalid_json|unknown_action|unauthorized|forbidden|not_found|task_not_|artifact_not_found|debug_trace_|admin_capability_v2_route|capability_not_found|generation_task_|task_launch_|runtime_read_only_|page_execution_followup_|page_observation_request_too_large|crawl_|site_agent_)/,
  /^(?:tool_call_(?:id_required|name_required|required|type_invalid|unknown|invalid)|tool_arguments_)$/,
];

// First match wins. The order puts the more specific families before the
// families whose names they share a word with.
const RULES: Array<[FailureClass, RegExp]> = [
  ["pipeline-contradiction", /scope_mismatch|precondition_url_mismatch|contract_inconsistent|manifest_mismatch|episode_rejected|authority_rejected|source_version_changed|checkpoint_(?:invalid|module_mismatch)|compiled_runtime_|stage_io_|required_input_|condition_output_|success_output_mismatch|agent_run_(?:handoff|pointer|page_not_connected|action_invalid|origin_rejected|capability_experience_rejected)|capability_navigation_origin_invalid|runner_url_|origin_mismatch|origin_invalid|hash_mismatch|integrity_mismatch|capability_version_(?:missing|not_published)|_read_undeclared|_write_undeclared|io_manifest|transition_manifest|navigation_manifest|plan_not_found|experience_source|result_unverified|stage_mismatch|verification_text_slicing|output_fabricated|input_not_reused|capability_not_available|task_not_found|version_not_found|scene_not_found|scene_origin_not_allowed|scene_navigation_unavailable|operation_not_found|operation_implementation_not_found|tool_not_available|question_unavailable|already_running|active_in_another_page|already_completed|sequence_conflict|persistence_failed|ordering_bug|reconciliation_not_completed|requires_isolated_runner|credentials_present|not_authored|publication_failed/i],
  ["gate-false-reject", /quality_rejected|review_rejected|capability_module_|control_flow_invalid|validation_no_case|noresult|candidate_artifact_gate|rejection_evidence_required|identity_check_overruled|validation_insufficient_evidence|validation_failed|validation_required|draft_replay_failed|draft_business_outcome|draft_output_identity|business_?rejection|not_grounded|_leaked|not_parameterized|not_generalized|not_consumed|must_be_optional|not_navigated|reference_undeclared|required_undeclared/i],
  ["bad-test-data", /input_not_offered|case_enrichment_|independent_cases_required|grounding_example|not_independent|example_not_in_evidence/i],
  ["site-auth", /authentication_failed|auth_(?:bootstrap|form|secret|submit|success)|login_required|site_access_challenge|captcha|credentials_forbidden/i],
  ["site-unreachable", /unreachable|net::|ENOTFOUND|ECONNREFUSED|browser_unavailable|runner_(?:execution_failed|start_retry|environment_missing|token_missing)|execution_?failure|isolation_failed|load_failed|module_url_invalid|public_url_required|requires_https|catalog_unavailable|check_unavailable|persist_failed|dns_|runner_private_url|model_unavailable|debug_page_unavailable/i],
  ["model-budget", /budget|exhausted|turn_limit|step_limit|repeated_failure|routing_exhausted|model_stalled|max_tool_calls|draft_never_run/i],
  ["timeout", /timeout|deadline|timed_out|interaction_window|window_missing/i],
  ["navigation-lost", /navigation_lost|run_lost|page_restore|document_unloaded|context_lost|navigation_terminal_outcome|direct_navigation_forbidden|new_window|related_target_navigation|related_variant_navigation|navigation_forbidden/i],
  ["site-changed", /page_changed|precondition_(?:text|input)|target_absent|target_ambiguous|select_option_missing|element_not_found|locator_not_found|target_not_found|exploration_element_|fill_target|success_text_missing|output_missing|scene_route|unaddressable|not_editable|no_match|exploration_failed|assertion_failed|verification_failed/i],
  ["model-protocol", /model_protocol|provider_|json_schema|reasoning_content|tool_choice|forced_tool|model_not_configured|structured_model_|tool_argument|tool_calling_|case_discovery_|case_generation_|case_context_|c1_authoring_|capability_spec_|ai_review_|experience_parameter_|output_schema_|schema_invalid|shape_invalid|fields_invalid|json_invalid|json_missing|non_json|decision_invalid|result_judge|capability_contract_shape|capability_experience_(?:invalid|outcome_invalid|required_field)|candidate_validation_|model_failed|review_failed|capability_input_(?:required|invalid)|input_undeclared|output_undeclared|_invalid$|_required$|_forbidden$|_missing$|_empty$|_unknown$|_mismatch$|_unwritable$|_duplicate$|_unsupported$|empty_response|object_required|reason_incomplete|protocol_invalid|dynamic_code|external_import|source_map|helpers_required|spec_missing|stage_manifest_empty|private_field|replacement_ids|runtime_v2_disabled|unbounded_loop|empty_branch|invented_customization|fixed_cart_success_text|first_candidate|computed_aria|network_forbidden|direct_value_assignment|search_form_submit_unsafe|add_to_cart_fallback|requires_artifact_input/i],
  ["wrong-answer", /agent_incomplete|capability_no_result|no_result|unverified_scene|business_result_wrong|answer_wrong|page_not_indexed/i],
];

/** The class for a code, with the failure's message as a second witness. */
export function classifyFailure(input: { code?: string; message?: string }): FailureClass {
  const code = String(input.code || "").trim();
  if (!code && !input.message) return "unclassified";
  for (const [failureClass, pattern] of RULES) if (pattern.test(code)) return failureClass;
  const message = String(input.message || "");
  for (const [failureClass, pattern] of RULES) if (pattern.test(message)) return failureClass;
  // A run that could not start names its cause only in the message; a 409
  // there is the runtime refusing what the search offered.
  if (/start_failed/i.test(code) && /\b409\b|scope|refused|rejected/i.test(message)) return "pipeline-contradiction";
  return "unclassified";
}

export function isNonFailureCode(code: string) {
  return NON_FAILURE_CODES.some((pattern) => pattern.test(code));
}

/** Codes whose class comes only from the message that travels with them. */
export const MESSAGE_CLASSIFIED_CODES = new Set(["agent_runtime_start_failed"]);

/** A failed task's attribution: the stage its result or error names, the class from its code. */
export function attributeTaskFailure(task: {
  type?: string;
  error?: { code?: string; message?: string; cause?: { code?: string; message?: string } };
  result?: { buildResult?: unknown };
}): FailureAttribution {
  const build = task.result?.buildResult && typeof task.result.buildResult === "object" ? task.result.buildResult as { stage?: string; code?: string; reason?: string } : undefined;
  // The task's error may only name the outcome kind ("businessrejection") or
  // the wrapper that ended the work ("authoring_repeated_failure"); the cause
  // and the build result name what happened. The first code that classifies
  // wins, the most specific first.
  const message = [task.error?.message, task.error?.cause?.code, task.error?.cause?.message, build?.reason].filter(Boolean).join(" ");
  const codes = [task.error?.cause?.code, build?.code, task.error?.code].filter((value): value is string => Boolean(value));
  let failureClass: FailureClass = "unclassified";
  for (const code of codes) {
    failureClass = classifyFailure({ code });
    if (failureClass !== "unclassified") break;
  }
  if (failureClass === "unclassified") failureClass = classifyFailure({ code: codes[0] || "", message });
  const stage = build?.stage
    || (task.type === "Validation" ? "Validation" : task.type === "Discovery" ? "Production" : task.type || "task");
  return { failureClass, failureStage: stage };
}

/** A failed run's attribution: whether a capability or the page agent was running, the class from its outcome. */
export function attributeRunFailure(run: {
  outcomeCode?: string;
  summary?: string;
  evidence?: Record<string, unknown> | null;
  capabilityUsed?: boolean;
}): FailureAttribution {
  const code = run.outcomeCode || "";
  const evidence = run.evidence && typeof run.evidence === "object" ? run.evidence : {};
  const message = [run.summary, evidence.runtimeError, evidence.error, evidence.reason].filter((value) => typeof value === "string").join(" ");
  const stage = /start_failed/i.test(code) ? "runtime.start" : run.capabilityUsed ? "runtime.stage" : "page-agent";
  return { failureClass: classifyFailure({ code, message }), failureStage: stage };
}
