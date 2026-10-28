import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export * from "./lib/capability-center-v2/failure-class";
      export { failureClassLabel } from "./lib/console/failure-copy";
    `,
    resolveDir: ROOT, loader: "ts", sourcefile: "failure-class-test.ts",
  },
  bundle: true, platform: "node", format: "esm", write: false,
});
const { FAILURE_CLASSES, MESSAGE_CLASSIFIED_CODES, classifyFailure, attributeTaskFailure, attributeRunFailure, isNonFailureCode, failureClassLabel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("every class has at least one code that lands in it, and an unknown code is unclassified", () => {
  const examples = {
    "model-protocol": ["model_protocol_error", "case_generation_browser_required", "tool_argument_enum_invalid"],
    "model-budget": ["authoring_budget_exhausted", "main_agent_turn_limit", "javascript_author_repeated_failure"],
    "wrong-answer": ["agent_incomplete", "capability_no_result"],
    "site-changed": ["page_changed", "capability_stage_select_option_missing", "precondition_text_missing"],
    "site-unreachable": ["validation_browser_unavailable", "runner_start_retry_exhausted", "module_load_failed"],
    "site-auth": ["authentication_failed", "auth_bootstrap_url_invalid"],
    "pipeline-contradiction": ["capability_scope_mismatch", "precondition_url_mismatch", "capability_stage_manifest_mismatch", "agent_run_episode_rejected", "capability_contract_inconsistent"],
    "gate-false-reject": ["capability_quality_rejected", "capability_module_empty_branch", "validation_no_case_produced_a_result", "noresult"],
    "bad-test-data": ["capability_input_not_offered", "case_generation_independent_cases_required"],
    "navigation-lost": ["capability_stage_context_lost", "capability_navigation_terminal_outcome"],
    "timeout": ["capability_control_flow_timeout", "model_timeout"],
  };
  for (const [failureClass, codes] of Object.entries(examples)) {
    for (const code of codes) assert.equal(classifyFailure({ code }), failureClass, code);
  }
  assert.equal(classifyFailure({ code: "something_nobody_wrote" }), "unclassified");
  assert.equal(classifyFailure({}), "unclassified");
  for (const failureClass of ["host-difference", "harness"]) assert.ok(FAILURE_CLASSES.includes(failureClass), `${failureClass} is a class the benchmark assigns from two records`);
});

test("a run that could not start is read by its message: a refused capability is a contradiction", () => {
  assert.equal(classifyFailure({ code: "agent_runtime_start_failed", message: "capability_v2_http_409 capability_scope_mismatch" }), "pipeline-contradiction");
  assert.equal(classifyFailure({ code: "agent_runtime_start_failed", message: "The reasoning_content in the thinking mode must be passed back" }), "model-protocol");
  assert.equal(classifyFailure({ code: "agent_runtime_start_failed" }), "unclassified");
});

test("a task is attributed from its error and the stage its result names; a run from its outcome and host", () => {
  assert.deepEqual(attributeTaskFailure({ type: "Discovery", error: { code: "authoring_budget_exhausted", message: "javascript_author_tool_budget_exhausted:capability_control_flow_timeout" }, result: { buildResult: { stage: "Authoring" } } }), { failureClass: "model-budget", failureStage: "Authoring" });
  assert.deepEqual(attributeTaskFailure({ type: "Validation", error: { code: "noresult", message: "validation_no_case_produced_a_result:precondition_url_mismatch" } }), { failureClass: "gate-false-reject", failureStage: "Validation" });
  assert.deepEqual(attributeRunFailure({ outcomeCode: "capability_stage_select_option_missing", capabilityUsed: true }), { failureClass: "site-changed", failureStage: "runtime.stage" });
  assert.deepEqual(attributeRunFailure({ outcomeCode: "agent_runtime_start_failed", summary: "interrupted while starting", evidence: { runtimeError: "capability_v2_http_409 capability_scope_mismatch" } }), { failureClass: "pipeline-contradiction", failureStage: "runtime.start" });
});

test("both dictionaries word every class, and the word is not the class id", () => {
  for (const failureClass of FAILURE_CLASSES) {
    for (const locale of ["zh", "en"]) {
      const label = failureClassLabel(locale, failureClass);
      assert.ok(label && label !== failureClass, `${locale} has no word for ${failureClass}`);
    }
  }
});

// Every code the pipeline or the widget can end a task or a run with must map
// to a class, or be declared not to be a failure. A code added without a
// mapping would otherwise swell `unclassified` unnoticed.
test("every failure code in the capability code maps to a class", () => {
  const roots = ["lib/capability-center-v2", "runner/capability-v2", "client/user-agent-port.ts", "db/capability-center-v2-store.ts"];
  const files = [];
  const walk = (path) => {
    const info = statSync(path);
    if (info.isDirectory()) { for (const entry of readdirSync(path)) walk(join(path, entry)); return; }
    if (/\.ts$/.test(path) && !/\.test\.|debug-trace|prompts\//.test(path)) files.push(path);
  };
  for (const root of roots) walk(join(ROOT, root));
  const pattern = /(?:new Error\(|code:\s*|error:\s*|Error\(")\s*[`"']([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?=[:;`"'])/g;
  const codes = new Set();
  for (const file of files) for (const match of readFileSync(file, "utf8").matchAll(pattern)) codes.add(match[1]);
  assert.ok(codes.size > 200, `the scan found only ${codes.size} codes`);
  const unmapped = [...codes].filter((code) => !isNonFailureCode(code) && !MESSAGE_CLASSIFIED_CODES.has(code) && classifyFailure({ code }) === "unclassified").sort();
  assert.deepEqual(unmapped, [], `codes without a class:\n  ${unmapped.join("\n  ")}`);
});
