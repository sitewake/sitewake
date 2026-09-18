import { createAuthoringConnectors, type AuthoringConnectors } from "./connectors";
import { executeBrowserCapabilityStage } from "../../lib/capability-center-v2/browser-stage-sdk";
import { CapabilityWorkspace } from "./workspace";
import { transform } from "esbuild";
import type { BrowserContext, Page } from "playwright";
import { getModelConfig } from "../../lib/model-config";
import {
  CAPABILITY_V2_MAX_MODULE_BYTES,
  inspectCapabilityJavaScriptProgram,
  validateCapabilityJavaScriptSource,
} from "../../lib/capability-center-v2/javascript-runtime";
import { resolveCapabilityInputDefaults } from "../../lib/capability-center-v2/input-template";
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

export type JavaScriptAuthorResult = {
  source: string;
  bundle: string;
  program: CapabilityProgram;
  draft: JavaScriptStageRunResult;
  provenance: CapabilityPromptProvenance;
};

/** When this many tool calls remain and no source exists yet, the tool result names the next step. */
const NUDGE_AT_TOOL_CALLS_LEFT = 6;
/** Wall-clock cap for one authoring self-test; the production budget stays 3 minutes. */
const DRAFT_DEADLINE_CAP_MS = Math.max(20_000, Math.min(180_000, Number(process.env.CAPABILITY_V2_DRAFT_DEADLINE_MS || 60_000)));

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
 * A runtime guard that only reports a code makes the model try a different
 * wrong thing next turn: one production run spent 12 of its 24 turns on the
 * same rule. Spelling out the "why" and the "how to fix" for each rule makes a
 * violation cost one turn. Build-time static checks already carry hints (see
 * the validation branch of run_draft); these cover what only surfaces once a
 * stage actually runs.
 */
export function runtimeRepairHint(message: string): string | undefined {
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

function isSelectionFacetPath(path: string) {
  return isTargetIdentityPath(path)
    || /(?:color|colour|size|brand|material|attribute|property|option|filter|facet|category|department|分类|属性|选项|颜色|尺码|品牌|材质|筛选)/iu.test(path);
}

function uniquePaths(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort();
}

function stageIO(readsInput: string[], readsState: string[] = [], writesState: string[] = [], writesOutput: string[] = []): CapabilityStageIO {
  return {
    reads: { input: uniquePaths(readsInput), state: uniquePaths(readsState) },
    writes: { state: uniquePaths(writesState), output: uniquePaths(writesOutput) },
  };
}

export function authoringManifest(trace: CapabilityDslProgram, contract: CapabilityContract) {
  const actionStages: CapabilityStageManifest[] = trace.steps.map((step, index) => {
    const effect = ["click", "fill", "select", "check", "press", "upload"].includes(step.action) ? "write" as const : "read" as const;
    const readsInput = uniquePaths([
      ...((step.target?.strategies || []).flatMap(strategyPaths)),
      ...((step.target?.scope?.strategies || []).flatMap(strategyPaths)),
      inputPath(step.value),
    ].filter((path): path is string => Boolean(path)));
    return {
      id: `stage_${index + 1}`,
      title: `${step.action} · ${step.id}`,
      purpose: `执行已探索成功路径中的 ${step.action} 操作`,
      effect,
      resumePolicy: effect === "write" ? "reconcile-before-retry" as const : "skip-completed" as const,
      io: stageIO(readsInput, [], readsInput),
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
          purpose: "按公开输入搜索或回到匹配的动态业务对象，不固化演示商品或静态分类路径",
          effect: "write",
          resumePolicy: "reconcile-before-retry",
          io: stageIO([], [], [], []),
          navigation: "optional",
        },
        {
          id: "stage_select_target",
          title: "Select matching dynamic target",
          purpose: "在结果列表中按输入条件选择匹配的动态商品/业务对象并进入详情页",
          effect: "write",
          resumePolicy: "reconcile-before-retry",
          io: stageIO([], [], [], []),
          navigation: "optional",
        },
      ]
    : [];
  const stages: CapabilityStageManifest[] = [
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
  const parameterRoles: CapabilityParameterRole[] = declared.map((path) => ({
    inputPath: path,
    role: resolvedTargetInputs.has(path) ? "target" : values.has(path) ? "value" : "context",
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
      return { ...stage, io: stageIO(declared, targetStatePaths, [], outputPaths), navigation: "none" as const };
    }
    return stage;
  });
  return { stages: withIO, parameterRoles, targetBindings };
}

/** Render a locator value as a JavaScript expression: literals stay literal, input bindings read `input`. */
function locatorExpression(value: LocatorValue | ProgramValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return JSON.stringify(value);
  if (value.source === "literal") return JSON.stringify(value.value);
  if (value.source === "input") return `input[${JSON.stringify(value.path.split(".")[0])}]`;
  return undefined;
}

/** Render one exploration target as a `find()`-compatible object literal. */
function targetExpression(target: ProgramStep["target"]): string {
  const strategies = (target?.strategies || []).map((strategy) => {
    const fields: string[] = [`type:${JSON.stringify(strategy.type)}`];
    if (strategy.role) fields.push(`role:${JSON.stringify(strategy.role)}`);
    const name = locatorExpression(strategy.name); if (name) fields.push(`name:${name}`);
    const value = locatorExpression(strategy.value); if (value) fields.push(`value:${value}`);
    if (strategy.match) fields.push(`match:${JSON.stringify(strategy.match)}`);
    return `{${fields.join(",")}}`;
  });
  return `{strategies:[${strategies.join(",")}]}`;
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
export function seedCapabilitySource(manifest: ReturnType<typeof authoringManifest>, trace: CapabilityDslProgram, contract: CapabilityContract) {
  const targetStatePaths = manifest.targetBindings.map((binding) => binding.identityStatePath);
  const targetInputs = manifest.targetBindings.map((binding) => binding.inputPath);
  const declared = Object.keys(record(record(contract.inputSchema).properties));
  const outputs = Object.keys(record(record(contract.outputSchema).properties));
  const io = (stage: CapabilityStageManifest) => JSON.stringify(stage.io);
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
    if (stage.id === "stage_verify") {
      const reads = declared.map((path) => `input[${JSON.stringify(path)}]`).join(", ");
      const identity = declared.map((path) => `${JSON.stringify(path)}: input[${JSON.stringify(path)}]`).join(", ");
      return `${header}
      async run({ input, state, waitUntil }) {
        const expected = [${reads}];
        const identity = { ${identity} }; void identity;
        // TODO(author): wait for the real result region, then return
        // { outcome: "Success", output: { ${outputs.join(", ")} }, evidence: [{ kind: "status", value: {...} }] }
        // built from the page; NoResult when the page proves there is nothing; BusinessRejection when the site refuses.
        void expected; void state; void waitUntil;
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
      return `${header}
      async run({ input, waitForTarget, waitUntil }) {
        void input;
        const element = await waitForTarget(${target});
        const hrefBefore = location.href; const textBefore = document.body.innerText;
        element.click();
        // A click either navigates (the host resumes on the new document) or changes the page in place.
        await waitUntil(() => location.href !== hrefBefore || document.body.innerText !== textBefore);
        return { outcome: "Continue" };
      } }`;
    }
    if (step.action === "navigate") {
      const url = locatorExpression(step.value) || JSON.stringify(trace.entry.url || "");
      return `${header}
      async run({ input }) { void input; return { outcome: "Continue", navigation: { url: ${url}, target: "_self" } }; } }`;
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
  const manifest = authoringManifest(options.explorationProgram, options.contract);
  if (!manifest.stages.length) throw new Error("javascript_author_stage_manifest_empty");
  // The authoring demonstration must use the same effective input as C3.
  // A defaulted public parameter may be intentionally omitted at the A→B
  // boundary; passing the raw envelope here would make DraftReplay exercise a
  // different input from the immutable Contract and fail only after the
  // source has already been authored.
  const demonstrationParameters = resolveCapabilityInputDefaults(options.contract, options.input.parameters);
  const groundingExamples = (options.groundingExamples || []).filter(example => JSON.stringify(resolveCapabilityInputDefaults(options.contract, {...options.input.parameters,...example})) !== JSON.stringify(demonstrationParameters));
  const provenance = await promptProvenance(JAVASCRIPT_AUTHOR_PROMPT, config.model);
  let lastDraftObservation: unknown;
  let debugContext: {context: BrowserContext; page: Page} | undefined;
  let lastCase: {caseId:string; input:Record<string, JsonValue>; moduleHash:string} | undefined;
  const closeDebug = async () => { await debugContext?.context.close().catch(() => undefined); debugContext = undefined; };

  let source = ""; let successful: JavaScriptAuthorResult | undefined;
  const messages: ToolCallingMessage[] = [
    { role: "system", content: JAVASCRIPT_AUTHOR_PROMPT.text },
    {
      role: "user",
      content: JSON.stringify({
        connectors: connectors.catalog,
        goal: options.goal,
        startUrl: options.startUrl,
        contract: options.contract,
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
  const seed = seedCapabilitySource(manifest, options.explorationProgram, options.contract);
  await workspace.revision(seed);
  source = seed;
  await workspace.write('task/authoring-input.json', {goal:options.goal,startUrl:options.startUrl,input:options.input,contract:options.contract,explorationProgram:options.explorationProgram,groundingExamples});
  await workspace.write('context/authoring-prompt.json', {provenance,messages});
  await workspace.write('context/tools.json', JAVASCRIPT_AUTHOR_TOOLS);
  await workspace.write('context/connectors.json', connectors.catalog);
  await workspace.write('context/runtime.json', {target:'browser-sdk',kernelVersion:'2',buildSha:process.env.SITEWAKE_BUILD_SHA || 'development'});
  await workspace.write('context/browser-stage-sdk.js', 'export ' + executeBrowserCapabilityStage.toString(), true);
  const allowed = new Set(["get_dom", "execute_js", "write_file", "read_file", "run_draft", "reset_browser"]);
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
  const maxDraftRuns = Math.max(1, Math.min(12, options.maxDraftRuns || Number(process.env.CAPABILITY_V2_AUTHOR_MAX_DRAFT_RUNS || 6)));
  let recordedMessageCount = 0;
  let toolCallsUsed = 0;
  let draftRuns = 0;
  /** A write_file has not been followed by run_draft yet. */
  let draftPending = false;
  let lastRepairableFailure: Error | undefined;
  let lastDraftFailure: Error | undefined;
  let modelStalled = false;
  const budgetLeft = () => ({ toolCalls: Math.max(0, maxToolCalls - toolCallsUsed), draftRuns: Math.max(0, maxDraftRuns - draftRuns) });

  /** Build the current source and replay every authoring example; shared by the tool loop and the budget wrap-up. */
  const runDraft = async (): Promise<Record<string, unknown>> => {
    draftRuns += 1;
    draftPending = false;
    let draftResult: Record<string, unknown> | undefined;
      if (!source) throw new Error("capability_source_missing;hint=src/capability.ts has not been written yet. Call write_file({ path: 'capability.ts', content }) with the full module first, then run_draft.");
      await options.onEvent?.({ phase: "Building", message: "构建并检查 JavaScript 模块" });
      const bundle = await transpile(source);
      const requiredInputPaths = Object.keys(record(record(options.contract.inputSchema).properties));
      const validation = validateCapabilityJavaScriptSource(
        bundle,
        requiredInputPaths,
        // Require every identity/facet input to be read in both the
        // resolve and select stages.  This is an internal source gate;
        // the public four-module envelopes remain unchanged.
        requiredInputPaths.filter(isSelectionFacetPath),
      );
      if (!validation.ok) {
        const repairHint = validation.code === "capability_module_target_first_candidate_forbidden"
          ? "REPAIR REQUIRED: remove every candidate/match/result/product/link/selection collection [0], at(0), first, or incomplete .find predicate. This includes allLinks.find(link => link.href/name), which can silently choose the first product link. Build one record per visible product/card with matchesAllInputs (every public target/facet input matches the card or its detail evidence) and enabledAction (the intended action is visible and enabled), then use .find(candidate => candidate.matchesAllInputs && candidate.enabledAction); return NoResult when none and Ambiguous when multiple remain. Do not replace the collection name or keep a global link fallback to evade this rule."
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
        // page context as part of the business boundary.
        entry: options.contract.scope?.kind === "site-global"
          ? { mode: "CurrentPage" }
          : { mode: "Navigate", url: options.startUrl },
        stages: manifest.stages,
        parameterRoles: manifest.parameterRoles,
        targetBindings: manifest.targetBindings,
        promptProvenance: [...(options.explorationPromptProvenance || []), provenance],
        ...(options.contract.inputAliases ? { inputAliases: options.contract.inputAliases } : {}),
      };
      await workspace.write('dist/program.json', program);
      await workspace.write('dist/contract.json', options.contract);
      await workspace.write('dist/capability.js', bundle, true);
      await closeDebug();
      lastDraftObservation = undefined;
      lastCase = {caseId:'demonstration',input:demonstrationParameters,moduleHash:moduleRef.contentHash};
      const draftPage = await connectors.execution.createContext();
      try {
        await draftPage.page.goto(options.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
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
          const facetHint = Object.keys(options.input.parameters).some((key) => /color|material|size|variant|facet|filter/i.test(key))
            ? "Facet text may be absent from a result card; select by target identity, open its dynamic detail link, then verify the facet on the detail page instead of rejecting the card from its first href."
            : "";
          const disabledCartHint = /(?:no\s+enabled|add\s+to\s+cart\s+button\s+is\s+disabled|disabled.*add\s+to\s+cart)/iu.test(draft.reason || "")
            ? "Do not stop at a disabled primary product button: if the current product requires unprovided customization, inspect sibling product cards and either click an enabled Add to cart control scoped to an article whose name matches input.productKeyword, or open that card's dynamic detail link and verify the requested facet there. Never invent customization text and never click a disabled or unrelated card."
            : "";
          const searchHint = /no\s+products?\s+found|products?\s+found\s+matching|search\s+results?/iu.test(draft.reason || "")
            ? "If the search form produces a URL but the next stage sees no result cards, do not use form.submit() as the only path; return a same-origin input-driven navigation intent for /search?controller=search&s=encodeURIComponent(input.productKeyword), then let the following stage inspect the settled result page."
            : "";
          const cartConfirmationHint = /success_text_missing|cart\s+(?:does\s+not\s+show|confirmation)|no\s+cart\s+confirmation|Could not confirm|购物车.*(?:确认|成功)|颜色.*(?:未在|未被).*购物车/iu.test(draft.reason || "")
            ? "The success check must use real post-action DOM structure or a state transition, never a fabricated or copied natural-language sentence. After the enabled detail-page action, wait briefly for the asynchronous UI update and inspect a visible status/dialog node, the selected business object identity, a cart badge/count transition, or a cart-row structure. Return observed values as evidence; do not put any fixed locale text or fixed number in capability.ts. If receipts show the terminal stage still on a listing URL, fix the dynamic product href handoff before changing the success predicate."
            : "";
          const relatedTargetHint = /capability_stage_related_target_navigation|related.*target|different.*product.*detail/iu.test(draft.reason || "")
            ? "The runner detected a detail-to-detail transition that changed the selected business object. Never follow a related-product or variant href from the whole document; keep the primary detail pathname stable and scope facet controls to the selected product region."
            : "";
          const hints = [facetHint, disabledCartHint, searchHint, cartConfirmationHint, relatedTargetHint].filter(Boolean).join(" ");
          throw new Error(`draft_business_outcome:${draft.outcome}:${draft.reason || ""};receipts=${JSON.stringify(receipts)}${hints ? `;hint=${hints}` : ""}`);
        }
        const outputIdentityIssue = draftOutputIdentityIssue(draft.output);
        if (outputIdentityIssue) throw new Error(`draft_output_identity_invalid:${outputIdentityIssue}`);
        // A Stage module can report Success while still leaving the page
        // in an intermediate state.  Draft Replay must satisfy the same
        // Contract success conditions as the later C3 replay before
        // the authoring loop accepts the source; otherwise a bad module
        // is materialized and only fails much later in the pipeline.
        await evaluateResult(draft.page, options.goal, options.contract, draft.output, options.input, undefined, draft.observedText);
        // Replay every evidence-backed grounding example before accepting
        // a draft. This is private C1 execution (no model
        // call) and catches ordering bugs such as setting quantity after
        // the Add-to-cart click, which a demonstration quantity of 1
        // cannot reveal.
        for (let exampleIndex = 0; exampleIndex < groundingExamples.length; exampleIndex += 1) {
          const groundingInput = {
            ...options.input,
            parameters: resolveCapabilityInputDefaults(options.contract, {
              ...options.input.parameters,
              ...groundingExamples[exampleIndex],
            }),
          };
          const isolatedExample = await connectors.execution.createContext();
          try {
            await isolatedExample.page.goto(options.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

            const exampleReplay = await connectors.execution.run({
              page: isolatedExample.page,
              moduleUrl: options.absoluteModuleUrl(moduleRef.moduleUrl, moduleRef.contentHash),
              program,
              input: groundingInput.parameters,
              deadlineCapMs: DRAFT_DEADLINE_CAP_MS,
            });
            if (exampleReplay.outcome !== "Success") throw new Error(`${exampleReplay.outcome}:${exampleReplay.reason || ""}`);
            await evaluateResult(isolatedExample.page, options.goal, options.contract, exampleReplay.output, groundingInput, undefined, exampleReplay.observedText);
            await options.onEvent?.({ phase: "DraftReplay", message: `draft grounding example ${exampleIndex + 1} succeeded` });
          } catch (error) {
            lastCase = {caseId:`example_${exampleIndex + 1}`,input:groundingInput.parameters,moduleHash:moduleRef.contentHash};
            lastDraftObservation = await inspectPage(isolatedExample.page).then(trimSnapshot).catch(() => ({unavailable:true}));
            debugContext = isolatedExample;
            await workspace.event('replay.failure', {...lastCase, observation:lastDraftObservation, error:String(error)});
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`draft_grounding_example_failed:example_${exampleIndex + 1}:${message}`);
          } finally {
            if (debugContext !== isolatedExample) await isolatedExample.context.close().catch(() => undefined);
          }
        }
        await workspace.write('dist/program.json', program);
        await workspace.write('dist/contract.json', options.contract);
        await workspace.write('dist/capability.js', bundle, true);
        const {page: _page, ...receipt} = draft;
        await workspace.write('reports/author-draft.json', receipt);
        successful = { source, bundle, program, draft, provenance };
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
    const hint = runtimeRepairHint(failure.message);
    seedCheck = { ok: false, code, error: hint && !failure.message.includes(";hint=") ? `${failure.message};hint=${hint}` : failure.message, case: lastCase, observation: lastDraftObservation };
    await options.onEvent?.({ phase: "DraftReplay", message: "seed draft checked", payload: { code, error: failure.message.slice(0, 600) } });
  }
  if (successful) return successful;
  draftRuns = 0;
  draftPending = false;
  messages.push({
    role: "user",
    content: JSON.stringify({
      seededSource: "src/capability.ts",
      seedCheck,
      instruction: "src/capability.ts 已按探索成功路径生成：动作阶段用 waitForTarget(探索目标) 定位、fill 写值、点击后等页面变化，它们已经在 seedCheck 里跑过一遍。只需补齐 stage_verify（读取结果页、按 outputSchema 返回 output 与 evidence），保留其余阶段原样；如果 seedCheck 在动作阶段就失败，按它给出的阶段和等待去修。",
    }),
  });
  try {
  while (toolCallsUsed < maxToolCalls && draftRuns < maxDraftRuns) {
    await options.onEvent?.({ phase: "Authoring", message: `model turn ${toolCallsUsed + 1}` });
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
          await debugContext.page.goto(options.startUrl, {waitUntil:'domcontentloaded',timeout:30_000});
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
        } else if (call.function.name === "write_file") {
          if (args.path !== "capability.ts" || typeof args.content !== "string") throw new Error("write_file_arguments_invalid");
          if (new TextEncoder().encode(args.content).byteLength > CAPABILITY_V2_MAX_MODULE_BYTES) throw new Error("capability_module_too_large");
          await workspace.revision(args.content);
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
          message: `${call.function.name} failed`,
          payload: {
            tool: call.function.name,
            code,
            error: failure.message.slice(0, 1_000),
            ...(call.function.name === "run_draft" && code === "BusinessRejection"
              ? { contractSuccessConditions: options.contract.successConditions }
              : {}),
            repairable: !isTerminalAuthoringError(failure),
          },
        });
        if (isTerminalAuthoringError(failure)) throw failure;
        lastRepairableFailure = failure;
        if (call.function.name === "run_draft") lastDraftFailure = failure;
        const hint = runtimeRepairHint(failure.message);
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
  // Report the last draft failure, never a stale ENOENT from some read_file along the way.
  throw new JavaScriptAuthorToolBudgetError(
    lastDraftFailure
      ?? (modelStalled
        ? new Error(`authoring_model_stalled:the model stopped calling tools after ${toolCallsUsed} tool call(s) without a successful draft`)
        : draftRuns === 0 ? new Error(`authoring_draft_never_run:${toolCallsUsed} tool calls were spent without writing capability.ts`) : lastRepairableFailure),
  );
  } finally { await closeDebug(); }
}
