import { countsIgnoringTheirList, demonstrationAnswerDisagreement, describeAnswerDisagreement, describeCountIgnoringList } from "../../lib/capability-center-v2/output-consistency";
import { createAuthoringConnectors, type AuthoringConnectors } from "./connectors";
import { contractWithOutputs } from "./contract-from-demonstration";
import { executeBrowserCapabilityStage } from "../../lib/capability-center-v2/browser-stage-sdk";
import { DEFAULT_CAPABILITY_TOTAL_TIMEOUT_MS } from "../../lib/capability-center-v2/control-flow";
import { CapabilityWorkspace } from "./workspace";
import { transform } from "esbuild";
import type { BrowserContext, Page } from "playwright";
import { getModelConfig } from "../../lib/model-config";
import {
  CAPABILITY_V2_MAX_MODULE_BYTES,
  inspectCapabilityJavaScriptProgram,
  validateCapabilityJavaScriptSource,
} from "../../lib/capability-center-v2/javascript-runtime";
import { resolveCapabilityInput } from "../../lib/capability-center-v2/run-resolution";
import { pageSelectingInputs } from "../../lib/capability-center-v2/quality";
import { promptProvenance } from "../../lib/capability-center-v2/prompt";
import type {
  CapabilityContract,
  CapabilityDslProgram,
  CapabilityModuleRef,
  CapabilityParameterRole,
  CapabilityProgram,
  CapabilityPromptProvenance,
  CapabilityStageIO,
  CapabilityStageManifest,
  CapabilityTargetBinding,
  CapabilityTaskInput,
  JsonObject,
  JsonValue,
  LocatorStrategy,
  LocatorValue,
  ProgramStep,
  ProgramValue,
} from "../../lib/capability-center-v2/model";
import { evaluateResult, inspectPage } from "./browser-runtime";
import { runCapabilityJavaScriptStages, type JavaScriptStageRunResult } from "./javascript-stage-runner";
import { JAVASCRIPT_AUTHOR_PROMPT, JAVASCRIPT_AUTHOR_TOOLS } from "./prompts/javascript-author";
import { parseAndValidateToolArguments, requestToolCallingTurn, type ToolCallingMessage, type ToolDefinition } from "./tool-calling";
import { isTerminalAuthoringError } from "./module-delivery";
import { inspectCapabilityQuality, type CapabilityQualityReport } from "../../lib/capability-center-v2/quality";
import { assertContractConsistent } from "../../lib/capability-center-v2/contract-consistency";
import { capabilityEntryPage } from "../../lib/capability-center-v2/entry-page";

export type JavaScriptAuthorResult = {
  source: string;
  bundle: string;
  program: CapabilityProgram;
  /** The Contract as frozen on this draft: its outputs are what the draft answered with. */
  contract: CapabilityContract;
  draft: JavaScriptStageRunResult;
  provenance: CapabilityPromptProvenance;
};

/** When this many tool calls remain and no source exists yet, the tool result names the next step. */
const NUDGE_AT_TOOL_CALLS_LEFT = 6;
/**
 * Wall-clock cap for one authoring self-test.
 *
 * It used to be a third of the production budget, which meant a capability
 * whose page legitimately takes longer than a minute could never be authored:
 * the self-test ran out of time before the verifying stage began, the model
 * was handed that as a code failure and rewrote the logic, and the run ended
 * telling the operator to look for a contract problem that was not there. A
 * test stricter than production rejects capabilities that would have worked.
 */
const DRAFT_DEADLINE_CAP_MS = Math.max(20_000, Math.min(180_000, Number(process.env.CAPABILITY_V2_DRAFT_DEADLINE_MS || DEFAULT_CAPABILITY_TOTAL_TIMEOUT_MS)));

export class JavaScriptAuthorToolBudgetError extends Error {
  readonly code = "javascript_author_tool_budget_exhausted";
  readonly authorRepairable = false;
  readonly taskRetryable = true;

  constructor(readonly lastFailure?: Error) {
    super(`javascript_author_tool_budget_exhausted:${lastFailure?.message || "no_successful_draft"}`, { cause: lastFailure });
    this.name = "JavaScriptAuthorToolBudgetError";
  }
}

/**
 * The same run_draft failure twice in a row means the repair did not touch the
 * failing point: the cause is outside the source (a Contract predicate, a
 * rule), and every further turn would repeat it. One production run spent six
 * identical rounds — four minutes — on a predicate no Stage could satisfy.
 */
export class JavaScriptAuthorRepeatedFailureError extends Error {
  readonly code = "javascript_author_repeated_failure";
  readonly authorRepairable = false;
  readonly taskRetryable = true;

  constructor(readonly lastFailure: Error, readonly draftRuns: number) {
    super(`javascript_author_repeated_failure:${lastFailure.message}`, { cause: lastFailure });
    this.name = "JavaScriptAuthorRepeatedFailureError";
  }
}

/** What makes two draft failures "the same": the code and detail, not the hints or receipts attached for the model. */
export function draftFailureSignature(message: string) {
  return message.split(";hint=")[0].split(";receipts=")[0].replace(/\s+/g, " ").trim();
}

/**
 * A runtime guard that only reports a code makes the model try a different
 * wrong thing next turn: one production run spent 12 of its 24 turns on the
 * same rule. Spelling out the "why" and the "how to fix" for each rule makes a
 * violation cost one turn. Build-time static checks already carry hints (see
 * the validation branch of run_draft); these cover what only surfaces once a
 * stage actually runs.
 */
export function runtimeRepairHint(message: string, manifestStageIds: string[] = []): string | undefined {
  if (message.startsWith("capability_stage_manifest_mismatch")) {
    const listed = manifestStageIds.length ? ` The manifest fixes exactly these stages, in this order: ${manifestStageIds.join(", ")}.` : "";
    return `REPAIR REQUIRED: the module's stages differ from the manifest.${listed} Stages cannot be added, removed, renamed or reordered here; implement what is needed inside the declared stages.`;
  }
  const undeclared = message.match(/capability_stage_(input|state)_read_undeclared:([^:\s]+):([^\s;"']+)/);
  if (undeclared) {
    const [, kind, stageId, path] = undeclared;
    return kind === "state"
      ? `REPAIR REQUIRED: ${stageId} reads state.${path} but its io.reads.state does not declare it. Either add "${path}" to ${stageId}.io.reads.state (and make sure an earlier Stage lists it in io.writes.state and actually sets it), or read input.${path} instead when it is a public input.`
      : `REPAIR REQUIRED: ${stageId} reads input.${path} but its io.reads.input does not declare it. Add "${path}" to ${stageId}.io.reads.input; only declared Contract inputs can be read.`;
  }
  const contextLost = message.match(/capability_stage_context_lost(?:_before_result)?:([^:\s;]+)/);
  if (contextLost) {
    return `REPAIR REQUIRED: the document was unloaded while ${contextLost[1]} was still running and no navigation was observed. Do not reload or replace the page inside a Stage; if an action (click/submit) navigates, make it the LAST statement and return { outcome: "Continue" } right away — the next Stage runs on the new page.`;
  }
  if (/capability_stage_direct_navigation_forbidden:[^:]+:new_window/.test(message)) {
    return "REPAIR REQUIRED: the Stage opened a new window/tab. Click the in-page business target that navigates the current document (not a share/source link with target=_blank), or return a same-origin navigation intent { outcome: \"Continue\", navigation: { url, target: \"_self\" } }.";
  }
  if (/capability_stage_related_target_navigation:/.test(message)) {
    return "REPAIR REQUIRED: the Stage navigated to a related/adjacent target instead of the requested one. Resolve the target by the input value inside the primary results region and click exactly that card/link.";
  }
  const pendingWaitFor = message.match(/capability_control_flow_timeout:[^:\s]+:pending=waitFor\(("(?:[^"\\]|\\.)*")\)/u);
  if (pendingWaitFor) {
    return `REPAIR REQUIRED: waitFor(${pendingWaitFor[1]}) never matched a visible element and consumed the whole stage budget. The selector is wrong for this page: get_dom's role/name are computed accessibility metadata, not attributes. Use the element's css from get_dom, a placeholder/type/id attribute, or find it by visible text, and verify with execute_js(document.querySelector(...)) before run_draft.`;
  }
  // "Find floor lamps" looked for the shop's type filter on the home page,
  // where there is none, and was told four times that a wait never settled
  // and to check a controlled input. The page was the problem, not the wait.
  const pendingFind = message.match(/capability_control_flow_timeout:[^:\s]+:pending=find\((.*)\)/u);
  if (pendingFind) {
    return `REPAIR REQUIRED: find(${pendingFind[1].slice(0, 200)}) never matched on the page the stage ran on. Read observation.url and observation.text first. If that page does not have the element — the demonstration found it on another page — the program never got there: the stage before it, or this stage if it comes first, must end by returning a same-origin navigation intent { outcome: "Continue", navigation: { url, target: "_self" } } to that page, and the following stage then runs there. Unless its Contract binds it to a page, a capability starts on whatever page the visitor is on, so never assume it starts where the demonstration did. If the page does have it, the selector is wrong: take its css from get_dom and verify with execute_js(document.querySelector(...)) before run_draft.`;
  }
  // The host's navigation, not the module's wait. Told to fix a wait, the
  // author rewrote waits it had no way to be wrong about, twice, and the run
  // stopped for a change that had not touched the failure — because the
  // failure was not in its code.
  const navigation = message.match(/capability_navigation_timeout:([^:\s]+):(\S+?):(.*?)(?:;hint=|$)/u);
  if (navigation) {
    const [, stageId, url, detail] = navigation;
    return `NOT YOUR WAIT: ${stageId} returned a navigation to ${url} and the host's own load of that page ran out of time (${detail.trim() || "no detail"}). Rewriting waits in the module cannot change this. Either the address is wrong for this input — check it against the demonstrated one and fix how the stage builds it — or the page is simply slow, in which case leave the source as it is and call run_draft again.`;
  }
  if (/capability_control_flow_timeout|capability_program_timeout/.test(message)) {
    return "REPAIR REQUIRED: a wait never settled. First read the observation: if the url did not change and a text input you wrote to still has value \"\", the page never received your value (controlled input) — write it with fill(element, value) instead of element.value. Then wait with waitUntil on a condition the page really reaches after the action (result region rendered, URL carries the query) and return as soon as it holds.";
  }
  return undefined;
}

function failureCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  const message = error instanceof Error ? error.message : String(error);
  // A code may be followed by ";hint=" (capability_source_missing;hint=…), not only by a colon.
  return message.match(/^([a-z][a-z0-9_]+)(?=[:;]|$)/i)?.[1] || "draft_replay_failed";
}

function draftOutputIdentityIssue(output: JsonObject | undefined) {
  const genericUiLabels = new Set(["close", "continue shopping", "view cart", "cart", "add to cart", "search", "home", "menu"]);
  for (const [key, value] of Object.entries(output || {})) {
    if (!/(?:product|item|target).*?(?:name|title)$/iu.test(key) || typeof value !== "string") continue;
    const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
    if (!normalized || genericUiLabels.has(normalized)) return `${key}:${value || "empty"}`;
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function inputPath(value: LocatorValue | ProgramValue | undefined) {
  return value && typeof value === "object" && value.source === "input" ? value.path.split(".")[0] : undefined;
}

function strategyPaths(strategy: LocatorStrategy) {
  return [inputPath(strategy.name), inputPath(strategy.value), inputPath(strategy.containsText), ...(strategy.containsTextAll || []).map((value) => inputPath(value))].filter((value): value is string => Boolean(value));
}

function isTargetIdentityPath(path: string) {
  if (/(?:attribute|property|facet|filter|color|colour|material|size|brand|option|属性|颜色|材质|尺码|品牌|筛选)/iu.test(path)) return false;
  return /(?:query|keyword|search|term|product|item|target|sku|variant|object|商品|产品)/iu.test(path)
    && !/(?:quantity|count|amount|qty|number)/iu.test(path);
}

function uniquePaths(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

/**
 * The visible identity of the element an action Stage acted on, read before
 * the click. The authoring prompt requires the verification Stage to confirm
 * the final page belongs to the same business object; without this the model
 * has to re-derive that identity from the result page, and a production
 * capability did it by slicing the text between two editorial labels that only
 * that day's record happened to carry.
 */
export const ACTED_ON_STATE_PATH = "targets.__actedOn";
const ACTED_ON_ACTIONS = ["click", "check", "press"];
// Elements that change the chosen object rather than name it.
const CONTROL_SELECTOR = "button, input, select, textarea, label, option, [role=button], [role=radio], [role=checkbox], [role=option], [role=switch], [role=tab], [role=menuitemradio], [role=spinbutton], [rel=next], [rel=prev], [rel=previous], .pagination a, .pager a, nav[aria-label*=pagination i] a, [aria-label*=next page i], [aria-label*=previous page i]";
// A link that turns the page is a control too, whatever the site calls it:
// "Count quotes by tag" turned to page 2 of the tag, the seed took "Next →"
// for the object it had acted on, and the verify stage refused page 2 of
// the tag for not being "humor". Source text, as the seed is written out.
const PAGING_NAME_PATTERN = "/^(?:next|previous|prev|more|load more|show more|»|›|«|‹|→|←|\\d+)\\s*(?:[»›→←]|page)?$/iu";

function stageIO(readsInput: string[], readsState: string[] = [], writesState: string[] = [], writesOutput: string[] = []): CapabilityStageIO {
  return {
    reads: { input: uniquePaths(readsInput), state: uniquePaths(readsState) },
    writes: { state: uniquePaths(writesState), output: uniquePaths(writesOutput) },
  };
}

/**
 * What to tell the model when the manifest quality gate refuses a draft.
 *
 * The gate ran after the authoring loop and its refusal ended the task. A
 * capability that reads the hot list for a date was authored, replayed and
 * frozen, and then refused for `stage_io_state_read_unavailable`: its verify
 * stage declared it reads state.targets and nothing produced it. The model
 * never heard about it. The gate now runs inside run_draft, and each refusal
 * says what to change.
 */
export function qualityRepairHint(issue: CapabilityQualityReport["issues"][number]) {
  const stage = /Stage '([^']+)'/u.exec(issue.message)?.[1] || /program\.stages\.([^.]+)/u.exec(issue.path || "")?.[1] || "the stage";
  const quoted = [...issue.message.matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  if (issue.code === "stage_io_state_read_unavailable") {
    const path = quoted[1] || "that path";
    return `REPAIR REQUIRED: ${stage} declares io.reads.state "${path}" but no earlier Stage declares it in io.writes.state. Either the Stage that produces it must list it in writes.state and set it in the state it returns, or remove it from ${stage}.io.reads.state and stop reading state.${path}. state.targets.__actedOn exists only when an earlier Stage clicked, checked or pressed an element; when the only actions fill a field or navigate there is no acted-on identity, and ${stage} must locate the result itself.`;
  }
  if (issue.code === "stage_io_terminal_output_missing") {
    return `REPAIR REQUIRED: stage_verify.io.writes.output must list every required output of the Contract, and the stage must return each of them in output.`;
  }
  if (issue.code === "stage_io_input_undeclared" || issue.code === "stage_io_output_undeclared") {
    return `REPAIR REQUIRED: ${stage} declares a field the Contract does not: io.reads.input may name only inputSchema properties and io.writes.output only outputSchema properties. Remove the undeclared field; the public Contract cannot be changed here.`;
  }
  if (issue.code === "page_selecting_input_not_navigated") {
    const input = quoted[0] || "the input";
    return `REPAIR REQUIRED: input '${input}' selects which page to read — its value is part of the address the capability was demonstrated on — but no Stage navigates, so the program can only ever read that one page. Add a Stage before stage_verify with navigation "required" that opens the page for the input (for example location.assign(\`/daily/\${input.${input}}\`) with the address pattern of the demonstrated page), list the input in that Stage's io.reads.input, and let stage_verify read the page it lands on.`;
  }
  if (issue.code === "required_input_does_not_parameterize") {
    return "REPAIR REQUIRED: a required input is declared by no Stage that acts on the page, so the program acts the same way whatever its value is. The acting Stage must list it in io.reads.input and use it to choose what it acts on — the nth item, the matching row, the query it sends.";
  }
  if (issue.code === "demonstration_value_leaked") {
    return "REPAIR REQUIRED: the demonstration value is written into executable code. Read the value from input.* instead; a literal copied from the example works for one input only.";
  }
  if (issue.code === "write_stage_reconciliation_required") {
    return `REPAIR REQUIRED: ${stage} has effect "write" and must declare resumePolicy "reconcile-before-retry".`;
  }
  return `REPAIR REQUIRED: ${issue.message}`;
}

export type AuthoringAddressOptions = {
  /** The address the capability was demonstrated on. */
  startUrl?: string;
  /** The input values that demonstration succeeded with. */
  demonstrationParameters?: Record<string, JsonValue>;
};

/**
 * The inputs that choose the page — their demonstration value is part of the
 * demonstrated address — when nothing in the trace navigates. A by-date
 * archive was explored on `/daily/2026-03-11` with no navigation step: its
 * manifest had no stage that could open another date's page, and the model,
 * told to add one, could not, because the stage list is fixed here.
 */
function openingInputs(trace: CapabilityDslProgram, contract: CapabilityContract, options: AuthoringAddressOptions) {
  if (trace.steps.some((step) => step.action === "navigate")) return [] as string[];
  // Every declared input, not only the required ones: a room filter given a
  // default ("dining") still chooses the page, and as an optional input it got
  // no opening stage — the program read whatever page it started on.
  const declared = Object.keys(record(record(contract.inputSchema).properties));
  return pageSelectingInputs([options.startUrl], options.demonstrationParameters, declared, record(contract.inputSchema));
}

/** The inputs the program opens a page for by writing them into its address. */
export function addressOpenedInputs(trace: CapabilityDslProgram, contract: CapabilityContract, options: AuthoringAddressOptions) {
  return uniquePaths([
    ...openingInputs(trace, contract, options),
    ...trace.steps.flatMap((step) => navigateAddressInputs(step, contract, options)),
  ]);
}

/**
 * The declared writing of each input, as the contract publishes it, over the
 * value the demonstration ran with. An address states its own form and the
 * contract carries that form as `examples`; the demonstrated value is what an
 * older capability has instead.
 */
function addressWritings(contract: CapabilityContract, options: AuthoringAddressOptions) {
  const properties = record(record(contract.inputSchema).properties);
  const declared = Object.fromEntries(Object.keys(properties).flatMap((path) => {
    const examples = record(properties[path]).examples;
    const written = Array.isArray(examples) ? examples.find((item) => typeof item === "string" || typeof item === "number") : undefined;
    return written === undefined ? [] : [[path, written as JsonValue]];
  }));
  return { ...(options.demonstrationParameters || {}), ...declared };
}

/**
 * The inputs a navigate step's own address carries.
 *
 * A trace that navigates used to be taken as proof that the capability opens
 * the page for its input, and the step was emitted with the demonstrated
 * address written out and `void input`. Every date then opened 2026-09-20.
 * The address is the same statement `stage_open` makes when nothing in the
 * trace navigates, so it is read the same way.
 */
function navigateAddressInputs(step: ProgramStep, contract: CapabilityContract, options: AuthoringAddressOptions) {
  if (step.action !== "navigate") return [] as string[];
  const url = step.value?.source === "literal" && typeof step.value.value === "string" ? step.value.value : "";
  if (!url) return [] as string[];
  const schema = record(contract.inputSchema);
  return pageSelectingInputs([url], addressWritings(contract, options), Object.keys(record(schema.properties)), schema);
}

export function authoringManifest(trace: CapabilityDslProgram, contract: CapabilityContract, options: AuthoringAddressOptions = {}) {
  const opening = openingInputs(trace, contract, options);
  const openingStages: CapabilityStageManifest[] = opening.length
    ? [{
        id: "stage_open",
        title: "Open the page for the input",
        purpose: "Open the page for the input: the demonstration value in the address is replaced by the actual input",
        effect: "read",
        resumePolicy: "skip-completed",
        io: stageIO(opening, [], [], []),
        navigation: "required",
      }]
    : [];
  const actionStages: CapabilityStageManifest[] = trace.steps.map((step, index) => {
    const effect = ["click", "fill", "select", "check", "press", "upload"].includes(step.action) ? "write" as const : "read" as const;
    const readsInput = uniquePaths([
      ...((step.target?.strategies || []).flatMap(strategyPaths)),
      ...((step.target?.scope?.strategies || []).flatMap(strategyPaths)),
      ...navigateAddressInputs(step, contract, options),
      inputPath(step.value),
    ].filter((path): path is string => Boolean(path)));
    return {
      id: `stage_${index + 1}`,
      title: `${step.action} · ${step.id}`,
      purpose: `Perform the ${step.action} step of the explored path`,
      effect,
      resumePolicy: effect === "write" ? "reconcile-before-retry" as const : "skip-completed" as const,
      io: stageIO(readsInput, [], [...readsInput, ...(ACTED_ON_ACTIONS.includes(step.action) ? [ACTED_ON_STATE_PATH] : [])]),
      navigation: step.action === "navigate" ? "required" as const : "optional" as const,
    };
  });
  const declared = Object.keys(record(record(contract.inputSchema).properties));
  // Semantic analysis is intentionally conservative about facet roles.  The
  // executable target boundary still needs the public identity input (query,
  // product, item, …), while colour/size/brand remain selection filters.
  // Quantity/count never belongs to this set even when an older semantic
  // record classified every user field as a target.
  const targetInputs = new Set(declared.filter(isTargetIdentityPath));
  const traceTargets = new Set(
    trace.steps.flatMap((step) => [
      ...(step.target?.scope?.strategies || []).flatMap(strategyPaths),
      ...(step.target?.strategies || []).flatMap(strategyPaths),
    ]),
  );
  const resolvedTargetInputs = new Set(
    declared.filter((path) => targetInputs.has(path) || (traceTargets.has(path) && isTargetIdentityPath(path))),
  );
  // A single demonstrated click is often performed on an already-open product
  // detail page.  Generic capabilities must also resolve a different runtime
  // target from public inputs, so reserve two explicit stages for the
  // search/result boundary before replaying the demonstrated business action.
  // These internal stage-manifest entries participate in the same explicit
  // Stage I/O protocol as authored action and verification stages.
  const requiresDynamicTargetResolution = resolvedTargetInputs.size > 0
    && actionStages.some((stage) => stage.effect === "write")
    && declared.length > 0;
  const targetStages: CapabilityStageManifest[] = requiresDynamicTargetResolution
    ? [
        {
          id: "stage_resolve_target",
          title: "Resolve input-driven target",
          purpose: "Search by the public input or return to the matching business object, without fixing the demonstration item or a static category path",
          effect: "write",
          resumePolicy: "reconcile-before-retry",
          io: stageIO([], [], [], []),
          navigation: "optional",
        },
        {
          id: "stage_select_target",
          title: "Select matching dynamic target",
          purpose: "Pick the result that matches the input and open its detail page",
          effect: "write",
          resumePolicy: "reconcile-before-retry",
          io: stageIO([], [], [], []),
          navigation: "optional",
        },
      ]
    : [];
  const stages: CapabilityStageManifest[] = [
    ...openingStages,
    ...targetStages,
    ...actionStages,
    {
      id: "stage_verify",
      title: "Verify final business result",
      purpose: "Observe the page after all actions and return the final typed outcome, output, and evidence",
      effect: "read",
      resumePolicy: "skip-completed",
      io: stageIO([], [], [], []),
      navigation: "none",
    },
  ];
  const values = new Set(trace.steps.map((step) => inputPath(step.value)).filter((value): value is string => Boolean(value)));
  // An input is a target only where the program actually picks that target out
  // of the page. A route that reaches its result by opening an address has no
  // stage that selects anything, so there is no acted-on identity to keep and
  // nothing writes `targets.<input>` — and a binding that names a state path no
  // stage writes is a contradiction C2 refuses outright
  // (case_generation_target_binding_unwritten). The input is still carried into
  // the page; it is carried by the address, which is a value, not a target.
  const boundTargets = targetStages.length ? resolvedTargetInputs : new Set<string>();
  const parameterRoles: CapabilityParameterRole[] = declared.map((path) => ({
    inputPath: path,
    role: boundTargets.has(path) ? "target" : values.has(path) ? "value" : "context",
  }));
  const targetBindings: CapabilityTargetBinding[] = parameterRoles.filter((item) => item.role === "target").map((item) => ({
    inputPath: item.inputPath,
    targetKind: "page-business-object",
    identityStatePath: `targets.${item.inputPath}`,
    required: true,
  }));
  const targetInputPaths = [...resolvedTargetInputs];
  const targetStatePaths = targetBindings.map((binding) => binding.identityStatePath);
  const outputPaths = Object.keys(record(record(contract.outputSchema).properties));
  const targetStageIds = new Set(targetStages.map((stage) => stage.id));
  const withIO = stages.map((stage) => {
    if (targetStageIds.has(stage.id)) {
      return {
        ...stage,
        io: stageIO(
          targetInputPaths,
          stage.id === "stage_select_target" ? targetStatePaths : [],
          targetStatePaths,
        ),
        navigation: "optional" as const,
      };
    }
    if (stage.id === "stage_verify") {
      const actedOn = trace.steps.some((step) => ACTED_ON_ACTIONS.includes(step.action)) ? [ACTED_ON_STATE_PATH] : [];
      return { ...stage, io: stageIO(declared, [...targetStatePaths, ...actedOn], [], outputPaths), navigation: "none" as const };
    }
    return stage;
  });
  // The seed must satisfy its own gate. stage_verify may declare a state read
  // only for a path some earlier Stage declares it writes; a target input
  // whose trace produced no resolve/select Stage has no producer, and
  // declaring the read anyway made the seed manifest refuse itself for
  // stage_io_state_read_unavailable once that gate ran inside the loop.
  const produced = new Set(withIO.filter((stage) => stage.id !== "stage_verify").flatMap((stage) => stage.io.writes.state));
  const consistent = withIO.map((stage) => stage.id === "stage_verify"
    ? { ...stage, io: { ...stage.io, reads: { ...stage.io.reads, state: stage.io.reads.state.filter((path) => produced.has(path)) } } }
    : stage);
  return { stages: consistent, parameterRoles, targetBindings };
}

/** Render a locator value as a JavaScript expression: literals stay literal, input bindings read `input`. */
function locatorExpression(value: LocatorValue | ProgramValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return JSON.stringify(value);
  if (value.source === "literal") return JSON.stringify(value.value);
  if (value.source === "input") return `input[${JSON.stringify(value.path.split(".")[0])}]`;
  return undefined;
}

/**
 * Render one exploration target as a `find()`-compatible object literal. A
 * target named by an input also carries that input as its `choice`: the
 * positional strategies beside it were recorded for the demonstrated option
 * and may only locate the group, never stand in for another value.
 */
function targetExpression(target: ProgramStep["target"]): string {
  const choice = (target?.strategies || [])
    .flatMap((strategy) => [strategy.name, strategy.value])
    .find((value) => value !== undefined && typeof value !== "string" && value.source === "input");
  const strategies = (target?.strategies || []).map((strategy) => {
    const fields: string[] = [`type:${JSON.stringify(strategy.type)}`];
    if (strategy.role) fields.push(`role:${JSON.stringify(strategy.role)}`);
    const name = locatorExpression(strategy.name); if (name) fields.push(`name:${name}`);
    const value = locatorExpression(strategy.value); if (value) fields.push(`value:${value}`);
    if (strategy.match) fields.push(`match:${JSON.stringify(strategy.match)}`);
    return `{${fields.join(",")}}`;
  });
  const chosen = locatorExpression(choice);
  return `{strategies:[${strategies.join(",")}]${chosen ? `,choice:${chosen}` : ""}}`;
}

/**
 * The first draft is generated from the exploration that already succeeded,
 * not written from a blank page.
 *
 * Every production failure of the authoring loop was the model re-deriving
 * something the explorer had already proven: a controlled input that reverts a
 * direct `.value` write, a selector built from a computed accessible name, a
 * submit that must wait for the page to change. The seed reuses the explorer's
 * targets through `waitForTarget`, writes values through `fill`, waits for the
 * page to react after a click, and leaves only the verification stage — the
 * part that genuinely needs the model — as a stub that throws.
 */
/**
 * The demonstrated address as a template: every path segment and query value
 * equal to an input's demonstration value becomes that input, encoded. The
 * result is JavaScript source for a template literal.
 */
export function pageAddressTemplate(startUrl: string, inputs: string[], demonstrationParameters: Record<string, JsonValue>) {
  const url = new URL(startUrl);
  const key = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase();
  const inputFor = (raw: string) => {
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* not encoded */ }
    return inputs.find((path) => {
      const demonstration = demonstrationParameters[path];
      return (typeof demonstration === "string" || typeof demonstration === "number") && key(String(demonstration)) === key(decoded);
    });
  };
  const literal = (text: string) => text.replace(/[\\`$]/gu, (character) => `\\${character}`);
  const substitute = (path: string) => `\${encodeURIComponent(String(input[${JSON.stringify(path)}]))}`;
  const pathname = url.pathname.split("/").map((segment) => {
    const path = segment ? inputFor(segment) : undefined;
    return path ? substitute(path) : literal(segment);
  }).join("/");
  const query = [...url.searchParams.entries()].map(([name, value]) => {
    const path = inputFor(value);
    return `${literal(encodeURIComponent(name))}=${path ? substitute(path) : literal(encodeURIComponent(value))}`;
  }).join("&");
  return `\`${literal(url.origin)}${pathname}${query ? `?${query}` : ""}\``;
}

export function seedCapabilitySource(manifest: ReturnType<typeof authoringManifest>, trace: CapabilityDslProgram, contract: CapabilityContract, options: AuthoringAddressOptions = {}) {
  const targetStatePaths = manifest.targetBindings.map((binding) => binding.identityStatePath);
  const targetInputs = manifest.targetBindings.map((binding) => binding.inputPath);
  const declared = Object.keys(record(record(contract.inputSchema).properties));
  const outputs = Object.keys(record(record(contract.outputSchema).properties));
  const io = (stage: CapabilityStageManifest) => JSON.stringify(stage.io);
  const firstActedOnStep = trace.steps.find((step) => ACTED_ON_ACTIONS.includes(step.action));
  const stages = manifest.stages.map((stage, index) => {
    const header = `{ id: ${JSON.stringify(stage.id)}, io: ${io(stage)}, navigation: ${JSON.stringify(stage.navigation)},`;
    if (stage.id === "stage_resolve_target" || stage.id === "stage_select_target") {
      // State is written by returning it, never by mutating the (declaration-checked) proxy.
      const nested: Record<string, unknown> = {};
      targetStatePaths.forEach((path, at) => {
        const segments = path.split(".");
        let cursor = nested;
        segments.slice(0, -1).forEach((segment) => { cursor = (cursor[segment] ||= {}) as Record<string, unknown>; });
        cursor[segments.at(-1)!] = `__INPUT__${targetInputs[at]}__`;
      });
      const stateLiteral = JSON.stringify(nested).replace(/"__INPUT__([^"]+)__"/gu, (_, path: string) => `input[${JSON.stringify(path)}]`);
      return `${header}
      async run({ input }) {
        // The target identity is the public input itself; keep it in state for the verification stage.
        return { outcome: "Continue", state: ${stateLiteral} };
      } }`;
    }
    if (stage.id === "stage_open") {
      const inputs = stage.io.reads.input;
      // The value to replace in the address is the one the address itself
      // carries, which the contract states; only where it does not is the
      // demonstrated value tried instead.
      const declaredWritings = Object.fromEntries(inputs.flatMap((path) => {
        const examples = record(record(record(contract.inputSchema).properties)[path]).examples;
        const written = Array.isArray(examples) ? examples.find((item) => typeof item === "string" || typeof item === "number") : undefined;
        return written === undefined ? [] : [[path, written as JsonValue]];
      }));
      const address = options.startUrl
        ? pageAddressTemplate(options.startUrl, inputs, { ...(options.demonstrationParameters || {}), ...declaredWritings })
        : JSON.stringify(trace.entry.url || "");
      return `${header}
      async run({ input }) {
        // The page for this input is the demonstrated address with the input
        // in place of its demonstration value. Change the address only if the
        // site addresses the page differently; the host navigates and resumes
        // the next stage on the new document.
        return { outcome: "Continue", navigation: { url: ${address}, target: "_self" } };
      } }`;
    }
    if (stage.id === "stage_verify") {
      const reads = declared.map((path) => `input[${JSON.stringify(path)}]`).join(", ");
      const identity = declared.map((path) => `${JSON.stringify(path)}: input[${JSON.stringify(path)}]`).join(", ");
      return `${header}
      async run({ input, state, waitUntil, settle, identityMatches }) {
        const expected = [${reads}];
        const identity = { ${identity} }; void identity;
        // state.targets.__actedOn is the whole visible text of the element the
        // action stages acted on — a card carries its title together with rank,
        // counters, badges and timestamps, so it is never equal to the result's
        // title. Compare with identityMatches(state.targets.__actedOn, title),
        // never with === or your own containment check. An output that is that
        // identity comes from there; do not re-read from the result region what
        // was already known before the action. Anything genuinely new comes
        // from structure (a heading/title node, a link's URL parameter, a data
        // attribute), never by slicing a text blob between literal page
        // phrases, which vary per record and per day.
        // waitUntil must wait for the value about to be read, not for its
        // container: a mounted drawer can still be empty. settle() is available
        // for an in-place update whose shape is not known in advance.
        // TODO(author): wait for the real result region, then return
        // { outcome: "Success", output: { ${outputs.length ? outputs.join(", ") : "...the fields you read off the result, named for what they are (they become the capability's outputs)"} }, evidence: [{ kind: "status", value: {...} }] }
        // built from the page; NoResult when the page proves there is nothing; BusinessRejection when the site refuses.
        void expected; void state; void waitUntil; void settle; void identityMatches;
        throw new Error("stage_verify_not_authored");
      } }`;
    }
    const step = trace.steps[index - (manifest.stages.length - trace.steps.length - 1)];
    if (!step) return `${header} async run() { return { outcome: "Continue" }; } }`;
    const target = targetExpression(step.target);
    if (step.action === "fill" || step.action === "select") {
      const value = locatorExpression(step.value) || '""';
      return `${header}
      async run({ input, waitForTarget, fill }) {
        const element = await waitForTarget(${target});
        fill(element, ${value});
        return { outcome: "Continue" };
      } }`;
    }
    if (step.action === "click" || step.action === "check" || step.action === "press") {
      // Only the first acted-on stage names the object unconditionally. A later
      // control (a variant, a quantity, the cart button) acts on the object that
      // is already chosen; letting it overwrite the identity made stage_verify
      // compare the product heading with the cart button's own label and reject its
      // own correct result.
      const namesObject = step === firstActedOnStep
        ? "true"
        : `!element.closest(${JSON.stringify(CONTROL_SELECTOR)}) && !${PAGING_NAME_PATTERN}.test((nameOf(element) || element.innerText || "").trim())`;
      return `${header}
      async run({ input, waitForTarget, waitUntil, settle, keep, nameOf }) {
        void input;
        const element = await waitForTarget(${target});
        // Read the identity of the object being acted on before the page changes;
        // stage_verify checks the result against this instead of re-deriving it
        // from whatever wording the result page happens to carry. nameOf is the
        // name the element was found by: its text, else its image's alt, else
        // its title — an image link has no text of its own.
        const actedOn = (nameOf(element) || element.innerText || element.textContent || "").replace(/\\s+/gu, " ").trim().slice(0, 240);
        // A link or card names the object; a control keeps the identity an earlier stage recorded.
        const namesObject = ${namesObject};
        // The click may unload this document before this stage can return; the
        // identity is kept now and reaches the next stage either way.
        if (namesObject) keep({ targets: { __actedOn: actedOn } });
        const hrefBefore = location.href; const textBefore = document.body.innerText;
        element.click();
        // A click either navigates (the host resumes on the new document) or changes the page in place.
        await waitUntil(() => location.href !== hrefBefore || document.body.innerText !== textBefore);
        // The document changes the moment a drawer or panel mounts; the next
        // stage must not read it while it is still painting.
        await settle();
        return namesObject ? { outcome: "Continue", state: { targets: { __actedOn: actedOn } } } : { outcome: "Continue" };
      } }`;
    }
    if (step.action === "navigate") {
      // An address that carries an input's value opens that input's page, not
      // the demonstration's. Written out literally, the capability went to the
      // same day whatever day it was asked for.
      const carried = navigateAddressInputs(step, contract, options);
      const literalUrl = step.value?.source === "literal" && typeof step.value.value === "string" ? step.value.value : "";
      const url = carried.length && literalUrl
        ? pageAddressTemplate(literalUrl, carried, addressWritings(contract, options))
        : locatorExpression(step.value) || JSON.stringify(trace.entry.url || "");
      return `${header}
      async run({ input }) {${carried.length ? "" : " void input;"} return { outcome: "Continue", navigation: { url: ${url}, target: "_self" } }; } }`;
    }
    return `${header} async run() { return { outcome: "Continue" }; } }`;
  });
  return `export const capability = {
  version: 2,
  stages: [
    ${stages.join(",\n    ")}
  ]
};
`;
}

function trimSnapshot(value: Awaited<ReturnType<typeof inspectPage>>) {
  return {
    url: value.url,
    title: value.title,
    heading: value.heading,
    text: value.text.slice(0, 12_000),
    signals: value.signals,
    elements: value.elements.slice(0, 180),
  };
}

async function transpile(source: string) {
  const result = await transform(source, { loader: "ts", format: "esm", target: "es2022", sourcemap: false, minifyWhitespace: true, minifyIdentifiers: false, legalComments: "none" });
  return result.code.trim();
}

export async function authorJavaScriptCapability(options: {
  explorationPage: Page;
  startUrl: string;
  goal: string;
  input: CapabilityTaskInput;
  contract: CapabilityContract;
  explorationProgram: CapabilityDslProgram;
  groundingExamples: Array<Record<string, JsonValue>>;
  /** Source a prior run authored; it replaces the seed as the first draft and meets every check the seed does. */
  startingSource?: string;
  /** The candidate's name, description and aliases, for the rules that read them. */
  summary?: { name?: string; description?: string; aliases?: string[] };
  explorationPromptProvenance?: CapabilityPromptProvenance[];
  createDraftContext: () => Promise<{ context: BrowserContext; page: Page }>;
  persistModule: (source: string) => Promise<CapabilityModuleRef>;
  absoluteModuleUrl: (moduleUrl: string, contentHash?: string) => string;
  onEvent?: (event: { phase: string; message: string; payload?: JsonObject }) => void | Promise<void>;
  maxToolCalls?: number;
  /** Upper bound on run_draft calls — the actual repair budget; inspection calls do not count. */
  maxDraftRuns?: number;
  workspace?: CapabilityWorkspace;
  connectors?: AuthoringConnectors;
}): Promise<JavaScriptAuthorResult> {
  const connectors = options.connectors || createAuthoringConnectors({page:options.explorationPage,startUrl:options.startUrl,createContext:options.createDraftContext});
  const config = getModelConfig("execution");
  if (!config.configured) throw new Error("javascript_author_model_not_configured");
  // Every draft, example and debug page opens where the published program
  // will start: the page the Contract binds it to, when it names one.
  // The Contract the authoring starts from names the inputs, the scope and
  // the address; what the capability answers with is known only once a draft
  // has answered, and is frozen from the first draft that passes the
  // demonstration (contractWithOutputs). Everything after that reads this.
  let contract = options.contract;
  const entryPage = capabilityEntryPage(contract, options.startUrl);
  const startPage = entryPage || options.startUrl;
  const addressOptions: AuthoringAddressOptions = {
    startUrl: options.startUrl,
    demonstrationParameters: resolveCapabilityInput(contract, options.input.parameters).declared,
  };
  const manifest = authoringManifest(options.explorationProgram, contract, addressOptions);
  if (!manifest.stages.length) throw new Error("javascript_author_stage_manifest_empty");
  // The Contract and the Stage I/O it implies must agree before any budget is
  // spent: a predicate on a field no Stage may write is unrepairable by code.
  assertContractConsistent(contract, manifest.stages);
  // The invariant every gate in this file serves: a draft the post-loop
  // quality gate would refuse is refused before or inside the loop, never
  // after it. Rules about the program run inside run_draft, where the model
  // can repair. Rules about the Contract or the candidate summary are not the
  // model's to fix and run here, on the seed manifest, before a single model
  // call is spent — the same rules, the same function, so nothing can first
  // appear after the loop.
  const seedQuality = inspectCapabilityQuality(contract, {
    schemaVersion: "2.0",
    runtime: "BrowserJavaScriptStage",
    module: { contentHash: "0".repeat(64), moduleUrl: "/pending", exportName: "capability" },
    entry: { mode: "CurrentPage" },
    stages: manifest.stages,
    parameterRoles: manifest.parameterRoles,
    targetBindings: manifest.targetBindings,
    promptProvenance: [],
  }, {
    demonstrationParameters: resolveCapabilityInput(contract, options.input.parameters).declared,
    entryUrl: options.startUrl,
    validationCases: options.groundingExamples,
    summary: options.summary,
  });
  const unrepairable = seedQuality.issues.filter((issue) => issue.path && /^(?:contract|summary)\b/u.test(issue.path));
  if (unrepairable.length) {
    const details = unrepairable.map((issue) => `${issue.code}@${issue.path}`).join(",");
    throw Object.assign(new Error(`capability_quality_rejected:${details}`), { code: "capability_quality_rejected", authorRepairable: false });
  }
  // The authoring demonstration must use the same effective input as C3.
  // A defaulted public parameter may be intentionally omitted at the A→B
  // boundary; passing the raw envelope here would make DraftReplay exercise a
  // different input from the immutable Contract and fail only after the
  // source has already been authored.
  const demonstrationParameters = resolveCapabilityInput(contract, options.input.parameters).declared;
  const groundingExamples = (options.groundingExamples || []).filter(example => JSON.stringify(resolveCapabilityInput(contract, {...options.input.parameters,...example}).declared) !== JSON.stringify(demonstrationParameters));
  const provenance = await promptProvenance(JAVASCRIPT_AUTHOR_PROMPT, config.model);
  let lastDraftObservation: unknown;
  let debugContext: {context: BrowserContext; page: Page} | undefined;
  let lastCase: {caseId:string; input:Record<string, JsonValue>; moduleHash:string} | undefined;
  const closeDebug = async () => { await debugContext?.context.close().catch(() => undefined); debugContext = undefined; };

  let source = ""; let successful: JavaScriptAuthorResult | undefined;
  // The latest draft whose demonstration replay passed while a grounding
  // example did not. Grounding examples are the pipeline's own guesses — one
  // asked a cart capability for a lamp that cannot be added without a plug
  // type the capability has no input for — so when repairs end, this draft is
  // what authoring hands on, and independent validation decides the rest.
  let demonstrated: JavaScriptAuthorResult | undefined;
  const messages: ToolCallingMessage[] = [
    { role: "system", content: JAVASCRIPT_AUTHOR_PROMPT.text },
    {
      role: "user",
      content: JSON.stringify({
        connectors: connectors.catalog,
        goal: options.goal,
        startUrl: startPage,
        contract: contract,
        demonstrationInput: demonstrationParameters,
        groundingExamples,
        stageManifest: manifest.stages,
        parameterRoles: manifest.parameterRoles,
        targetBindings: manifest.targetBindings,
        successfulExplorationTrace: options.explorationProgram,
        instruction: "编写通用 JavaScript Stage 模块，不得硬编码 demonstrationInput。",
      }),
    },
  ];
  const workspace = options.workspace || await CapabilityWorkspace.create();
  // The first draft is generated from the successful exploration; the model
  // starts from proven action stages and only authors the verification stage.
  const seed = options.startingSource || seedCapabilitySource(manifest, options.explorationProgram, contract, addressOptions);
  await workspace.revision(seed);
  source = seed;
  await workspace.write('task/authoring-input.json', {goal:options.goal,startUrl:options.startUrl,input:options.input,contract:contract,explorationProgram:options.explorationProgram,groundingExamples});
  await workspace.write('context/authoring-prompt.json', {provenance,messages});
  await workspace.write('context/tools.json', JAVASCRIPT_AUTHOR_TOOLS);
  await workspace.write('context/connectors.json', connectors.catalog);
  await workspace.write('context/runtime.json', {target:'browser-sdk',kernelVersion:'2',buildSha:process.env.SITEWAKE_BUILD_SHA || 'development'});
  await workspace.write('context/browser-stage-sdk.js', 'export ' + executeBrowserCapabilityStage.toString(), true);
  const allowed = new Set(["get_dom", "execute_js", "write_file", "edit_file", "read_file", "run_draft", "reset_browser"]);
  const toolDefinitions = JAVASCRIPT_AUTHOR_TOOLS as unknown as readonly ToolDefinition[];
  /**
   * Two budgets with separate jobs.
   *
   * One production run spent 23 of 24 tool calls on get_dom/execute_js, wrote
   * capability.ts on the 24th, and the loop ended with "budget exhausted" — the
   * code never ran once, and the reported cause was an ENOENT from the 10th
   * read_file. The repair budget must count run_draft calls; the total call
   * count is only a safety limit against loops, and when it runs out with an
   * unreplayed source, that source gets one replay before any verdict.
   */
  const maxToolCalls = Math.max(4, Math.min(96, options.maxToolCalls || Number(process.env.CAPABILITY_V2_AUTHOR_MAX_TOOL_CALLS || 48)));
  let maxDraftRuns = Math.max(1, Math.min(12, options.maxDraftRuns || Number(process.env.CAPABILITY_V2_AUTHOR_MAX_DRAFT_RUNS || 6)));
  /**
   * Whether the one extra replay for a cross-run finding was granted. The
   * answers-together check is the only one that can fire after every run
   * passed on its own, so it tends to arrive on the last replay: the floor
   * lamp rebuild spent five replays on unrelated errors and learned on the
   * sixth that its count read the catalog total. With no replay left, the
   * draft whose count was proven wrong went on to be published.
   */
  let crossRunReplayGranted = false;
  let recordedMessageCount = 0;
  let toolCallsUsed = 0;
  let draftRuns = 0;
  /** A write_file has not been followed by run_draft yet. */
  let draftPending = false;
  let lastRepairableFailure: Error | undefined;
  let lastDraftFailure: Error | undefined;
  let previousDraftFailureSignature: string | undefined;
  let repeatedDraftFailures = 0;
  let modelStalled = false;
  const budgetLeft = () => ({ toolCalls: Math.max(0, maxToolCalls - toolCallsUsed), draftRuns: Math.max(0, maxDraftRuns - draftRuns) });

  /** Build the current source and replay every authoring example; shared by the tool loop and the budget wrap-up. */
  const acceptDraft = async (candidate: JavaScriptAuthorResult) => {
    await workspace.write('dist/program.json', candidate.program);
    await workspace.write('dist/contract.json', candidate.contract);
    await workspace.write('dist/capability.js', candidate.bundle, true);
    const {page: _page, ...receipt} = candidate.draft;
    await workspace.write('reports/author-draft.json', receipt);
    successful = candidate;
  };
  // Repairs are over without a draft that passed everything. One whose
  // demonstration passed is the capability the visitor already showed working.
  const acceptDemonstrated = async (reason: string) => {
    if (!demonstrated) return undefined;
    // The workspace's source is whatever the model wrote last; the accepted one is this.
    source = demonstrated.source;
    await workspace.revision(demonstrated.source);
    await workspace.event('draft.accepted_on_demonstration', { reason });
    await options.onEvent?.({ phase: "DraftReplay", message: "a grounding example failed; the draft that passed the demonstration goes on to validation", payload: { reason: reason.slice(0, 600) } });
    await acceptDraft(demonstrated);
    return successful;
  };
  const runDraft = async (): Promise<Record<string, unknown>> => {
    draftRuns += 1;
    draftPending = false;
    let draftResult: Record<string, unknown> | undefined;
      if (!source) throw new Error("capability_source_missing;hint=src/capability.ts has not been written yet. Call write_file({ path: 'capability.ts', content }) with the full module first, then run_draft.");
      await options.onEvent?.({ phase: "Building", message: "building the module" });
      const bundle = await transpile(source);
      const requiredInputPaths = Object.keys(record(record(contract.inputSchema).properties));
      const validation = validateCapabilityJavaScriptSource(
        bundle,
        requiredInputPaths,
        // An input the program binds as a target must be read where the
        // target is resolved and again where it is selected. Which inputs
        // those are is the manifest's own target bindings, not a guess from
        // the name: "variantOption" matched /option/, and a variant picked
        // with one click on the product page was refused until authoring gave
        // up, though the program declared it context.
        manifest.targetBindings.map((binding) => binding.inputPath),
      );
      if (!validation.ok) {
        const repairHint = validation.code === "capability_module_target_first_candidate_forbidden"
          ? "REPAIR REQUIRED: remove every candidate/match/result/product/link/selection collection [0], at(0), first, or incomplete .find predicate. This includes allLinks.find(link => link.href/name), which can silently choose the first product link. Build one record per visible product/card with matchesAllInputs (every public target/facet input matches the card or its detail evidence) and enabledAction (the intended action is visible and enabled), then use .find(candidate => candidate.matchesAllInputs && candidate.enabledAction); return NoResult when none and Ambiguous when multiple remain. Do not replace the collection name or keep a global link fallback to evade this rule."
          : validation.code === "capability_module_verification_text_slicing"
            ? "REPAIR REQUIRED: stop slicing the result out of a text blob between literal page phrases — those labels are editorial copy that other records and other days do not carry, so the capability breaks as soon as the page shows a different one. state.targets.__actedOn already holds the identity the action stage acted on: confirm the result belongs to it, and read each output from structure — a heading/title node, a link's URL parameter, a data attribute. Use execute_js on the failing page to find that node before writing the code."
            : validation.code.startsWith("capability_module_input_unused:")
            ? "REPAIR REQUIRED: read the exact Contract input property in the real search/filter/action/verification logic; do not delete or rename the property. Unicode keys must use input['原字段名']; if you normalize an envelope, use const params = input?.parameters ?? input and then read params['原字段名']."
            : validation.code === "capability_module_fixed_cart_success_text"
              ? "REPAIR REQUIRED: delete every literal cart/bag success sentence containing a fixed number, including fallback branches and comments. Do not compare document.body text to a frozen demonstration sentence, and do not copy any example wording from this error back into capability.ts. In stage_verify read an actual visible dialog/status, item identity, cart badge/count transition, or cart-row structure; derive count from current DOM and/or the before-click state, and return the observed values only as evidence."
              : validation.code.startsWith("capability_module_input_not_verified:")
                ? "REPAIR REQUIRED: stage_verify must directly read every named input (use input['原字段名'] or a safe params alias) and compare it with final business-region evidence; a generic toast alone is insufficient."
                : validation.code === "capability_module_target_input_not_reused"
                  ? "REPAIR REQUIRED: read the named target/facet input in both target resolution and candidate selection. Filter candidates by the full target identity and facet, then choose only an enabled executable match."
                  : validation.code === "capability_module_related_variant_navigation"
                    ? "REPAIR REQUIRED: remove document-wide color/variant link navigation. Scope the variant control to the selected primary business object; related cards must never change the target."
                    : validation.code === "capability_module_related_add_to_cart_fallback"
                      ? "REPAIR REQUIRED: remove document-wide Add-to-cart fallback. Scope the action to the primary business region, reject disabled/customization-required candidates, and select another matching executable object or return NoResult."
                      : validation.code === "capability_module_search_form_submit_unsafe"
                        ? "REPAIR REQUIRED: replace searchForm.submit() with an input-driven same-origin navigation URL; navigation must be the last action of that Stage and the next Stage must inspect the settled result page."
                        : validation.code === "capability_module_invented_customization"
                          ? "REPAIR REQUIRED: never invent textarea/customization text. Consume a user-provided customization input or skip the non-executable object and select another matching object."
                          : "REPAIR REQUIRED: modify the source according to the validation code before calling run_draft again.";
        throw new Error(`${validation.code}:${validation.message};hint=${repairHint}`);
      }
      const moduleRef = await options.persistModule(bundle);
      let program: CapabilityProgram = {
        schemaVersion: "2.0",
        runtime: "BrowserJavaScriptStage",
        module: moduleRef,
        // A site-global, parameterized capability must run from the
        // caller's current page.  The discovery URL is evidence used to
        // bootstrap DraftReplay/C3, not a fixed navigation step in the
        // published capability.  Page/category-scoped capabilities keep
        // the explicit Navigate entry because their contract declares the
        // page context as part of the business boundary — the page the
        // Contract names, not the one exploration happened to start on.
        entry: entryPage
          ? { mode: "Navigate", url: entryPage }
          : contract.scope?.kind === "site-global"
            ? { mode: "CurrentPage" }
            : { mode: "Navigate", url: options.startUrl },
        stages: manifest.stages,
        parameterRoles: manifest.parameterRoles,
        targetBindings: manifest.targetBindings,
        promptProvenance: [...(options.explorationPromptProvenance || []), provenance],
        ...(contract.inputAliases ? { inputAliases: contract.inputAliases } : {}),
        ...(validation.notes?.length ? { qualityNotes: validation.notes } : {}),
      };
      for (const note of validation.notes || []) await options.onEvent?.({ phase: "Quality", message: "quality note", payload: { code: note.code, message: note.message.slice(0, 400) } });
      await workspace.write('dist/program.json', program);
      await workspace.write('dist/contract.json', contract);
      await workspace.write('dist/capability.js', bundle, true);
      await closeDebug();
      lastDraftObservation = undefined;
      lastCase = {caseId:'demonstration',input:demonstrationParameters,moduleHash:moduleRef.contentHash};
      const draftPage = await connectors.execution.createContext();
      try {
        await draftPage.page.goto(startPage, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const draft = await connectors.execution.run({
          page: draftPage.page,
          moduleUrl: options.absoluteModuleUrl(moduleRef.moduleUrl, moduleRef.contentHash),
          program,
          input: demonstrationParameters,
          allowModuleGraphAdoption: true,
          draftInputPaths: requiredInputPaths,
          deadlineCapMs: DRAFT_DEADLINE_CAP_MS,
        });
        // A module may declare its finite control-flow graph alongside the
        // executable stages.  The graph is executable metadata, so copy
        // the exact module value into the immutable Program before the
        // independent validation replays and before returning the
        // candidate to the C2 internal commit. If the caller already supplied a graph,
        // the stage runner has already required an exact match.
        if (draft.stageManifest) program = { ...program, stages: draft.stageManifest };
        if (draft.controlFlow && !program.controlFlow) program = { ...program, controlFlow: draft.controlFlow };
        if (draft.stageTransitions?.some(Boolean) && !program.stages.some((stage) => stage.transitions)) {
          program = {
            ...program,
            stages: program.stages.map((stage, index) => {
              const transitions = draft.stageTransitions?.[index];
              return transitions ? { ...stage, transitions } : stage;
            }),
          };
        }
        const controlFlowInspection = inspectCapabilityJavaScriptProgram(program);
        if (!controlFlowInspection.valid) throw new Error(`capability_control_flow_invalid:${controlFlowInspection.issues.join(",")}`);
        // The manifest the module carries is what will be frozen. Every rule
        // the post-loop quality gate applies to it is applied here, while the
        // model can still repair: a draft that would be refused after the loop
        // is refused now, with the reason. Issues on the Contract itself are
        // not the model's to fix and are left to the gate that already
        // reports them.
        // A draft that answered declares the capability's outputs by what it
        // answered with; the rules below read the Contract as it will be frozen.
        const frozen = draft.outcome === "Success" && draft.output
          ? contractWithOutputs(contract, draft.output as JsonObject, program.stages.flatMap((stage) => stage.io?.writes?.output || []))
          : contract;
        const quality = inspectCapabilityQuality(frozen, program, {
          demonstrationParameters,
          validationCases: groundingExamples,
          source: bundle,
          entryUrl: options.startUrl,
        });
        const repairable = quality.issues.filter((issue) => !issue.path || /^(?:program|source)\b/u.test(issue.path));
        if (repairable.length) {
          const issue = repairable[0];
          throw new Error(`capability_quality_rejected:${issue.code}${issue.path ? `@${issue.path}` : ""}:${issue.message};hint=${qualityRepairHint(issue)}`);
        }
        if (draft.outcome !== "Success") {
          // Show the model every stage's result. With only the last four lifecycle
          // rows it concluded "only stage_2 and stage_verify ran", treated the
          // earlier stages as skipped, and repaired the wrong thing.
          const receipts = draft.receipts.filter((receipt) => receipt.status === "Completed").slice(-8).map((receipt) => ({
            stageId: receipt.stageId,
            outcome: receipt.outcome,
            urlBefore: receipt.urlBefore,
            urlAfter: receipt.urlAfter,
          }));
          // One hint for every business outcome, in no site's words. Five
          // hints used to hang here, each written after an incident on the
          // demo shop — its search address, its cart button's label, its
          // product-keyword input — and they steered authoring on every other
          // site toward that shop's shape.
          const hint = "Read observation.url and observation.text before changing code. If the page is not the one the demonstration reached, the stage before this one must get there (return a same-origin navigation intent, or click the link that leads there) and this stage runs on the next page. If it is the right page, locate the business element by its own structure — its card, row or heading — and select it by the input's value, never by position; verify the result from that element's state, not from a fixed sentence or number.";
          throw new Error(`draft_business_outcome:${draft.outcome}:${draft.reason || ""};receipts=${JSON.stringify(receipts)};hint=${hint}`);
        }
        const outputIdentityIssue = draftOutputIdentityIssue(draft.output);
        if (outputIdentityIssue) throw new Error(`draft_output_identity_invalid:${outputIdentityIssue}`);
        contract = frozen;
        await workspace.write('dist/contract.json', contract);
        // A Stage module can report Success while still leaving the page
        // in an intermediate state.  Draft Replay must satisfy the same
        // Contract success conditions as the later C3 replay before
        // the authoring loop accepts the source; otherwise a bad module
        // is materialized and only fails much later in the pipeline.
        await evaluateResult(draft.page, options.goal, contract, draft.output, options.input, undefined, draft.observedText);
        // The demonstration is the proof of the answer as well as of the path.
        // A draft that reaches the right page and returns a number the visitor
        // was never told has not passed it: "Count quotes by tag" was proven
        // with twelve quotes, counted the two on its last page, and was
        // published to tell every visitor the count of one page.
        const disagreement = demonstrationAnswerDisagreement(draft.output as JsonObject, options.input.experience?.answer);
        if (disagreement) {
          await workspace.event('replay.answer_disagrees', { ...lastCase, finding: disagreement });
          throw new Error(`draft_disagrees_with_demonstration:${describeAnswerDisagreement(disagreement, demonstrationParameters as JsonObject)}`);
        }
        const passedDemonstration: JavaScriptAuthorResult = { source, bundle, program, contract, draft, provenance };
        // What each run answered, to read together once all of them have.
        const answers: Array<{ input: JsonObject; output: JsonObject }> = [{ input: options.input.parameters as JsonObject, output: draft.output as JsonObject }];
        // Replay every evidence-backed grounding example before accepting
        // a draft. This is private C1 execution (no model
        // call) and catches ordering bugs such as setting quantity after
        // the Add-to-cart click, which a demonstration quantity of 1
        // cannot reveal.
        for (let exampleIndex = 0; exampleIndex < groundingExamples.length; exampleIndex += 1) {
          const groundingInput = {
            ...options.input,
            parameters: resolveCapabilityInput(contract, { ...options.input.parameters, ...groundingExamples[exampleIndex] }).declared,
          };
          const isolatedExample = await connectors.execution.createContext();
          try {
            await isolatedExample.page.goto(startPage, { waitUntil: "domcontentloaded", timeout: 30_000 });

            const exampleReplay = await connectors.execution.run({
              page: isolatedExample.page,
              moduleUrl: options.absoluteModuleUrl(moduleRef.moduleUrl, moduleRef.contentHash),
              program,
              input: groundingInput.parameters,
              deadlineCapMs: DRAFT_DEADLINE_CAP_MS,
            });
            // The site answering "there is nothing for this input" is an
            // answer, not a broken program: an example drawn from the page
            // (a sample order number in the help text, a sibling value) need
            // not exist. A program that ignored its input would return the
            // demonstration's result here, never "not found", so this cannot
            // hide hardcoding. Independent validation applies the same rule.
            if (exampleReplay.outcome === "NoResult") {
              await workspace.event('replay.no_result', {caseId:`example_${exampleIndex + 1}`,input:groundingInput.parameters,reason:exampleReplay.reason || ""});
              await options.onEvent?.({ phase: "DraftReplay", message: "draft grounding example returned no result", payload: { example: exampleIndex + 1, reason: exampleReplay.reason || "" } });
              continue;
            }
            if (exampleReplay.outcome !== "Success") throw new Error(`${exampleReplay.outcome}:${exampleReplay.reason || ""}`);
            await evaluateResult(isolatedExample.page, options.goal, contract, exampleReplay.output, groundingInput, undefined, exampleReplay.observedText);
            answers.push({ input: groundingInput.parameters as JsonObject, output: exampleReplay.output as JsonObject });
            await options.onEvent?.({ phase: "DraftReplay", message: "draft grounding example succeeded", payload: { example: exampleIndex + 1 } });
          } catch (error) {
            lastCase = {caseId:`example_${exampleIndex + 1}`,input:groundingInput.parameters,moduleHash:moduleRef.contentHash};
            lastDraftObservation = await inspectPage(isolatedExample.page).then(trimSnapshot).catch(() => ({unavailable:true}));
            debugContext = isolatedExample;
            await workspace.event('replay.failure', {...lastCase, observation:lastDraftObservation, error:String(error)});
            const message = error instanceof Error ? error.message : String(error);
            demonstrated = passedDemonstration;
            throw new Error(`draft_grounding_example_failed:example_${exampleIndex + 1}:${message}`);
          } finally {
            if (debugContext !== isolatedExample) await isolatedExample.context.close().catch(() => undefined);
          }
        }
        // Each run passed on its own; read together, a count that never moved
        // while its list did is not counting the result. The model can fix
        // that while it is still writing; when its repairs run out, the draft
        // that passed the demonstration goes on as for any grounding example.
        const stuck = countsIgnoringTheirList(answers.map((answer) => answer.output));
        if (stuck.length) {
          lastCase = {caseId:"answers_together",input:Object.fromEntries(answers.map((answer, index) => [`run_${index + 1}`, answer.input])),moduleHash:moduleRef.contentHash};
          await workspace.event('replay.count_ignores_list', {findings:stuck,inputs:answers.map((answer) => answer.input)});
          demonstrated = passedDemonstration;
          throw new Error(`draft_grounding_example_failed:answers_together:${describeCountIgnoringList(stuck[0], answers.map((answer) => answer.input))}`);
        }
        await acceptDraft(passedDemonstration);
        draftResult = { ok: true, outcome: draft.outcome, output: draft.output, evidence: draft.evidence, receipts: draft.receipts };
        await options.onEvent?.({ phase: "DraftReplay", message: "draft replay succeeded" });
      } catch (error) {
        if (!debugContext) {
          debugContext = draftPage;
          lastDraftObservation = await inspectPage(draftPage.page).then(trimSnapshot).catch(() => ({unavailable:true}));
          await workspace.event('replay.failure', {...lastCase, observation:lastDraftObservation, error:String(error)});
        }
        await workspace.write('reports/last-draft-observation.json',{...lastCase,observation:lastDraftObservation});
        throw error;
      } finally {
        if (debugContext !== draftPage) await draftPage.context.close().catch(() => undefined);
      }
    return draftResult!;
  };

  // Exercise the seeded action stages once before the model spends anything.
  // Reaching stage_verify proves the proven path replays under the kernel; a
  // failure earlier names the stage and the wait, which is the model's first fact.
  let seedCheck: Record<string, unknown>;
  try {
    seedCheck = await runDraft();
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (isTerminalAuthoringError(failure)) throw failure;
    const code = failureCode(failure);
    const hint = runtimeRepairHint(failure.message, manifest.stages.map((stage) => stage.id));
    seedCheck = { ok: false, code, error: hint && !failure.message.includes(";hint=") ? `${failure.message};hint=${hint}` : failure.message, case: lastCase, observation: lastDraftObservation };
    await options.onEvent?.({ phase: "DraftReplay", message: "seed draft checked", payload: { code, error: failure.message.slice(0, 600) } });
  }
  if (successful) return successful;
  draftRuns = 0;
  draftPending = false;
  messages.push({
    role: "user",
    content: JSON.stringify(options.startingSource ? {
      seededSource: "src/capability.ts",
      seedCheck,
      instruction: "src/capability.ts 是此前一次运行为同一目标写成的完整源码。seedCheck 是它在当前检查下的结果：按 seedCheck 指出的问题修改，其余部分保持原样。",
    } : {
      seededSource: "src/capability.ts",
      seedCheck,
      instruction: "src/capability.ts 已按探索成功路径生成：动作阶段用 waitForTarget(探索目标) 定位、fill 写值、点击后等页面变化，它们已经在 seedCheck 里跑过一遍。只需补齐 stage_verify（读取结果页，返回 output 与 evidence；output 的字段就是这个能力的公开输出，按业务含义命名，契约按第一份通过的草稿冻结它们），保留其余阶段原样；如果 seedCheck 在动作阶段就失败，按它给出的阶段和等待去修。",
    }),
  });
  try {
  while (toolCallsUsed < maxToolCalls && draftRuns < maxDraftRuns) {
    await options.onEvent?.({ phase: "Authoring", message: "model turn", payload: { turn: toolCallsUsed + 1 } });
    const authorTimeoutMs = Math.max(120_000, Number(process.env.CAPABILITY_V2_AUTHOR_TIMEOUT_MS || 180_000));
    await workspace.event('model.request', {baseMessageCount:recordedMessageCount,appendMessages:messages.slice(recordedMessageCount),model:config.model,prompt:provenance});
    recordedMessageCount = messages.length;
    let turn: Awaited<ReturnType<typeof requestToolCallingTurn>>;
    try {
      turn = await requestToolCallingTurn({ config, messages, tools: toolDefinitions, maxTokens: 10_000, timeoutMs: authorTimeoutMs, protocolRepairAttempts: 1, disableThinking: true });
    } catch (error) {
      // The model answered with text twice and stopped calling tools: it is saying
      // "I cannot fix this" (once in production the contract had frozen a sentence
      // that only held for the demonstration). That is not a protocol fault; treat
      // it as an exhausted budget and report the real last draft failure.
      if (error instanceof Error && error.message === "tool_call_required") {
        await workspace.event('model.stalled', { toolCallsUsed, draftRuns });
        await options.onEvent?.({ phase: "Authoring", message: "model stopped calling tools", payload: { toolCallsUsed, draftRuns } });
        modelStalled = true;
        break;
      }
      // A malformed call (an argument outside its schema, an unknown tool) is
      // the model's to correct, not the end of authoring: one wrong path
      // spelling ended a run whose draft already replayed every action stage.
      // It costs a tool call, so the budget still bounds it.
      if (error instanceof Error && /^tool_(?:argument|arguments|call_unknown|call_type|call_name|call_id)/.test(error.message)) {
        toolCallsUsed += 1;
        await workspace.event('model.invalid_tool_call', { error: error.message, toolCallsUsed });
        await options.onEvent?.({ phase: "Authoring", message: "tool call failed", payload: { tool: "protocol", code: "tool_call_invalid", error: error.message.slice(0, 600) } });
        messages.push({ role: "user", content: `Your last tool call was rejected: ${error.message}. Call one of the declared tools again with arguments that match its schema exactly.` });
        continue;
      }
      throw error;
    }
    await workspace.event('model.response', turn.message);
    const calls = turn.calls;
    messages.push(turn.message);
    for (const call of calls) {
      toolCallsUsed += 1;
      if (!allowed.has(call.function.name)) throw new Error(`javascript_author_tool_unknown:${call.function.name}`);
      const definition = toolDefinitions.find((tool) => tool.function.name === call.function.name);
      if (!definition) throw new Error(`javascript_author_tool_unknown:${call.function.name}`);
      const args = parseAndValidateToolArguments(call, definition);
      await workspace.event('tool.request', {id:call.id,name:call.function.name,args});
      let result: Record<string, unknown>;
      try {
        if (call.function.name === "get_dom") {
          if (args.target === 'last_draft' && !debugContext) throw new Error('debug_page_unavailable');
          result = debugContext && args.target !== 'exploration'
            ? {ok:true, case:lastCase, page:trimSnapshot(await inspectPage(debugContext.page))}
            : {ok:true,page:trimSnapshot(await connectors.browser.observe())};
        } else if (call.function.name === "reset_browser") {
          await closeDebug();
          debugContext = await connectors.execution.createContext();
          await debugContext.page.goto(startPage, {waitUntil:'domcontentloaded',timeout:30_000});
          lastCase = undefined;
          result = {ok:true,url:debugContext.page.url(),message:'Fresh page. Use condition-based waits before inspecting async business data.'};
        } else if (call.function.name === "read_file") {
          const allowedPaths = ['src/capability.ts','task/authoring-input.json','context/tools.json','context/runtime.json','context/browser-stage-sdk.js','dist/program.json','dist/contract.json','reports/author-draft.json'];
          if (typeof args.path !== 'string' || !allowedPaths.includes(args.path)) throw new Error(`workspace_read_path_forbidden:${String(args.path).slice(0, 120)};hint=only these paths are readable: ${allowedPaths.join(', ')}. capability.ts does not exist until you write it with write_file.`);
          if (args.path === 'src/capability.ts' && !source) throw new Error("capability_source_missing;hint=src/capability.ts has not been written yet. Call write_file({ path: 'capability.ts', content }) with the full module first.");
          result = {ok:true,path:args.path,content:await (await import('node:fs/promises')).readFile(`${workspace.directory}/${args.path}`,'utf8')};
        } else if (call.function.name === "execute_js") {
          const code = typeof args.source === "string" ? args.source : "";
          if (!code || code.length > 8_000) throw new Error("execute_js_source_invalid");
          if (args.target === 'last_draft' && !debugContext) throw new Error('debug_page_unavailable');
          const value = debugContext && args.target !== 'exploration' ? await debugContext.page.evaluate(code) : await connectors.browser.evaluate(code);
          result = { ok: true, value: value === undefined ? null : value };
        } else if (call.function.name === "write_file" || call.function.name === "edit_file") {
          // edit_file changes one exact passage of the current source. A
          // repair used to cost a whole-file rewrite — about a minute of
          // output per turn at production speed — and each rewrite risked
          // breaking action stages the exploration had already proven.
          let content: string;
          if (call.function.name === "edit_file") {
            if (!["capability.ts", "src/capability.ts"].includes(String(args.path)) || typeof args.old_str !== "string" || !args.old_str || typeof args.new_str !== "string") throw new Error("edit_file_arguments_invalid");
            const occurrences = source.split(args.old_str).length - 1;
            if (occurrences !== 1) throw new Error(occurrences ? `edit_file_old_str_not_unique:${occurrences}` : "edit_file_old_str_not_found: copy old_str exactly from the current src/capability.ts (read_file shows it)");
            content = source.replace(args.old_str, () => args.new_str as string);
          } else {
            if (!["capability.ts", "src/capability.ts"].includes(String(args.path)) || typeof args.content !== "string") throw new Error("write_file_arguments_invalid");
            content = args.content;
          }
          if (new TextEncoder().encode(content).byteLength > CAPABILITY_V2_MAX_MODULE_BYTES) throw new Error("capability_module_too_large");
          await workspace.revision(content);
          source = await (await import('node:fs/promises')).readFile(`${workspace.directory}/src/capability.ts`, 'utf8');
          successful = undefined;
          draftPending = true;
          result = { ok: true, path: "capability.ts", bytes: new TextEncoder().encode(source).byteLength };
          await options.onEvent?.({ phase: "Authoring", message: "capability.ts written" });
        } else {
          result = await runDraft();
        }
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        const code = failureCode(failure);
        await options.onEvent?.({
          phase: call.function.name === "run_draft" ? "DraftReplay" : "Authoring",
          message: call.function.name === "run_draft" ? "run_draft failed" : "tool call failed",
          payload: {
            tool: call.function.name,
            code,
            error: failure.message.slice(0, 1_000),
            ...(call.function.name === "run_draft" && code === "BusinessRejection"
              ? { contractSuccessConditions: contract.successConditions }
              : {}),
            repairable: !isTerminalAuthoringError(failure),
          },
        });
        if (isTerminalAuthoringError(failure)) throw failure;
        lastRepairableFailure = failure;
        if (call.function.name === "run_draft") {
          lastDraftFailure = failure;
          const signature = draftFailureSignature(failure.message);
          repeatedDraftFailures = signature && signature === previousDraftFailureSignature ? repeatedDraftFailures + 1 : 0;
          // A repeat proves the change missed the failure only when the
          // failure says where it was. `capability_control_flow_timeout` on
          // its own says a wait never settled, not which wait, and two of them
          // can be two different stalls; the run stopped after two of its six
          // drafts on a capability that passed on the next attempt. A located
          // signature still ends the repairs at once.
          // A navigation the host could not complete is not a change the
          // module declined to make: the right response to a slow page is the
          // same source again. The same holds for a spent control-flow budget,
          // which the comment above already describes but the test did not
          // cover once that error started naming the stage it gave up in — the
          // added detail made it read as located and cut the repairs short.
          const ranOutOfTime = /^capability_(?:control_flow|navigation)_timeout/.test(signature);
          const locatedFailure = signature.includes(":") && !ranOutOfTime;
          if (repeatedDraftFailures >= (locatedFailure ? 1 : 2)) {
            await workspace.event('draft.repeated_failure', { draftRuns, signature, repeats: repeatedDraftFailures });
            await options.onEvent?.({ phase: "DraftReplay", message: "same failure twice in a row; stopping repairs", payload: { code, error: failure.message.slice(0, 600), draftRuns } });
            const accepted = await acceptDemonstrated(failure.message);
            if (accepted) return accepted;
            throw new JavaScriptAuthorRepeatedFailureError(failure, draftRuns);
          }
          previousDraftFailureSignature = signature;
        }
        const hint = runtimeRepairHint(failure.message, manifest.stages.map((stage) => stage.id));
        result = { ok: false, code, error: hint && !failure.message.includes(";hint=") ? `${failure.message};hint=${hint}` : failure.message, repairable: true, ...(call.function.name === "run_draft" ? {case:lastCase,observation:lastDraftObservation} : {}) };
      }
      const budget = budgetLeft();
      result = { ...result, budget };
      // The model can only plan around a budget it can see. When the calls are
      // nearly gone and nothing has been written or replayed yet, name the next step.
      if (draftRuns === 0 && !draftPending && budget.toolCalls <= NUDGE_AT_TOOL_CALLS_LEFT) result.hint = `Only ${budget.toolCalls} tool call(s) remain. Write capability.ts with write_file now, then call run_draft; further inspection will not be possible.`;
      await workspace.event('tool.result', {id:call.id,name:call.function.name,result});
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) });
      if (call.function.name === "run_draft" && successful) return successful;
      if (draftRuns >= maxDraftRuns && !crossRunReplayGranted && call.function.name === "run_draft" && lastDraftFailure?.message.includes(":answers_together:")) {
        crossRunReplayGranted = true;
        maxDraftRuns += 1;
      }
      if (toolCallsUsed >= maxToolCalls || draftRuns >= maxDraftRuns) break;
    }
  }
  // Budget exhausted with an unreplayed source: replaying it is what the model would have done next, so do it before the verdict.
  if (draftPending && source) {
    await options.onEvent?.({ phase: "DraftReplay", message: "authoring budget exhausted; replaying the unreplayed draft once", payload: { toolCallsUsed, draftRuns } });
    try {
      await runDraft();
      if (successful) return successful;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (isTerminalAuthoringError(failure)) throw failure;
      lastDraftFailure = failure;
      await options.onEvent?.({ phase: "DraftReplay", message: "run_draft failed", payload: { tool: "run_draft", code: failureCode(failure), error: failure.message.slice(0, 1_000), repairable: false } });
    }
  }
  const accepted = await acceptDemonstrated(lastDraftFailure?.message || "authoring budget exhausted");
  if (accepted) return accepted;
  // Report the last draft failure, never a stale ENOENT from some read_file along the way.
  throw new JavaScriptAuthorToolBudgetError(
    lastDraftFailure
      ?? (modelStalled
        ? new Error(`authoring_model_stalled:the model stopped calling tools after ${toolCallsUsed} tool call(s) without a successful draft`)
        : draftRuns === 0 ? new Error(`authoring_draft_never_run:${toolCallsUsed} tool calls were spent without writing capability.ts`) : lastRepairableFailure),
  );
  } finally { await closeDebug(); }
}
