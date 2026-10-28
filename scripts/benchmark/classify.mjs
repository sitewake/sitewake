// The benchmark's own reading of a failure's class and stage, from what the
// run record, the generation task and the driver observed. The class table is
// the one `capability-center/failure-attribution` fixes; once records carry
// their own class this file only fills in what needs more than one record
// (wrong answers, host differences, a search that offered what the runtime
// refused).

export const FAILURE_CLASSES = [
  "model-protocol", "model-budget", "wrong-answer", "site-changed", "site-unreachable", "site-auth",
  "pipeline-contradiction", "gate-false-reject", "bad-test-data", "host-difference", "navigation-lost",
  "timeout", "harness", "unclassified",
];

const RULES = [
  ["model-protocol", /model_protocol|provider_|json_schema|reasoning_content|tool_choice|forced_tool|model_not_configured/i],
  ["model-budget", /budget|exhausted|turn_limit|repeated_failure/i],
  ["site-auth", /authentication|login_required|auth_bootstrap/i],
  ["site-unreachable", /unreachable|net::ERR|ENOTFOUND|ECONNREFUSED|navigation_timeout|browser_unavailable/i],
  ["site-changed", /page_changed|precondition_(url|text)|target_absent|select_option_missing|element_not_found/i],
  ["pipeline-contradiction", /scope_mismatch|contract_inconsistent|manifest_mismatch|episode_rejected|authority_rejected|source_version_changed|checkpoint_module_mismatch/i],
  ["gate-false-reject", /quality_rejected|review_rejected|capability_module_|control_flow_invalid|validation_no_case|noresult/i],
  ["bad-test-data", /input_not_offered|select_option_missing_for_case/i],
  ["timeout", /timeout|deadline|timed_out/i],
  ["navigation-lost", /navigation_lost|run_lost|page_restore|document_unloaded/i],
];

export function classFromCode(code = "") {
  for (const [name, pattern] of RULES) if (pattern.test(String(code))) return name;
  return "unclassified";
}

/** The class and stage of a failed benchmark record. */
export function classify(record) {
  if (record.harness) return { failureClass: "harness", stage: record.phase };
  if (record.phase === "generation") {
    const generation = record.generation || {};
    if (generation.state === "not-generated") return { failureClass: "pipeline-contradiction", stage: "experience.intake", note: "a successful run with page actions produced no generation task" };
    if (generation.state === "timed-out") return { failureClass: "timeout", stage: `${generation.phase || "pipeline"}` };
    // The console attributed the task when it failed; that is the class.
    if (generation.failureClass && generation.failureClass !== "unclassified") return { failureClass: generation.failureClass, stage: generation.failureStage ? `generation.${String(generation.failureStage).toLowerCase()}` : "generation" };
    const codes = `${generation.code || ""} ${generation.message || ""}`;
    // Validation that never reached the page the program needs: the stages
    // disagree about where the capability starts, not the site or the data.
    if (/precondition_url_mismatch|scope_mismatch/i.test(codes)) return { failureClass: "pipeline-contradiction", stage: `generation.${(generation.phase || "validation").toLowerCase()}` };
    const failureClass = classFromCode(codes);
    // A candidate the demonstration already proved, refused by a check: the
    // demonstration is the proof, so a refusal here is a false rejection
    // unless the code says the site or the model was at fault.
    const refused = ["unclassified", "bad-test-data"].includes(failureClass) && /Validation|Review|Quality/i.test(generation.phase || "");
    return { failureClass: refused ? "gate-false-reject" : failureClass, stage: generation.phase ? `generation.${generation.phase.toLowerCase()}` : "generation" };
  }
  const fact = record.fact || {};
  const drive = record.drive || {};
  const code = String(fact.outcomeCode || "");
  if (drive.outcome === "widget_missing") return { failureClass: "site-unreachable", stage: "runtime.load", note: "the widget never appeared on the page" };
  if (drive.timedOut || drive.outcome === "still_busy") return { failureClass: "timeout", stage: "runtime" };
  if (record.phase === "reuse" && fact.status === "completed" && fact.capabilityUsed === false) return { failureClass: "pipeline-contradiction", stage: "capability.search", note: "the published capability was not chosen" };
  if (record.phase === "reuse" && fact.capabilityUsed && fact.status !== "completed") return { failureClass: "host-difference", stage: "runtime.stage", note: `validated capability failed in the widget: ${code}` };
  if (fact.status === "completed" && !record.pass) return { failureClass: "wrong-answer", stage: record.phase === "reuse" ? "runtime.output" : "page-agent" };
  if (fact.failureClass && fact.failureClass !== "unclassified") return { failureClass: fact.failureClass, stage: fact.failureStage || (fact.capabilityUsed ? "runtime.stage" : "page-agent") };
  if (/agent_runtime_start_failed/.test(code) && (drive.consoleErrors || []).some((line) => /\b409\b/.test(line))) return { failureClass: "pipeline-contradiction", stage: "runtime.fetch", note: "the runtime refused a capability the search offered" };
  const failureClass = classFromCode(code);
  return { failureClass, stage: fact.capabilityUsed ? "runtime.stage" : "page-agent" };
}
