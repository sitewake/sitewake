// The AI CODING harness orchestrator.
//
// This is the deterministic spine of the authoring flow. It owns the workspace,
// the budget, the self-verification gate and the delivery pipeline, and it
// exposes a stable toolset to a *pluggable* coding-agent driver. The driver is
// the only non-deterministic part (a real Codex CLI, or a scripted FakeDriver
// in tests). Because the spine is deterministic and fully unit-tested, a green
// FakeDriver session proves the flow is correct: any live failure is then
// attributable to the model or the page, never to flow bugs.

import type {
  AuthoredImplementation,
  AuthoringProof,
  AuthoringWorkspaceSnapshot,
  CodingAgentKind,
  CompletionVerifier,
  JsonValue,
  ProgramModuleRef,
} from "./protocol";
import type { CapabilitySpecDoc } from "./protocol";
import { AuthoringWorkspace, scaffoldWorkspace, type WorkspaceListing } from "./authoring-workspace";
import { bundleWorkspace, type BundleResult, type EsbuildBuild } from "./authoring-bundler";
import {
  evaluateSubmitGate,
  parseFixtures,
  summarizeTestReport,
  type CapabilityFixture,
  type FixtureRunResult,
  type TestReport,
} from "./authoring-gate";
import { FIXTURES_PATH } from "./authoring-workspace";

export type ToolResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string; diagnostics?: string[] };

const ok = <T>(data: T): ToolResult<T> => ({ ok: true, data });
const fail = <T>(code: string, message: string, diagnostics?: string[]): ToolResult<T> => ({ ok: false, code, message, diagnostics });

export type GetDomResult = {
  snapshotId: string;
  url: string;
  kind: "semantic" | "html";
  content: string;
  nextCursor?: string;
};
export type ExecuteJsResult = {
  url: string;
  result?: JsonValue;
  transition: "none" | "navigation" | "new-page";
};

/**
 * The live-page side of the harness. Non-deterministic (Playwright + a real
 * page), so it is injected. Tests supply a scripted FakeBrowserBridge.
 */
export interface BrowserBridge {
  getDom(request?: { selector?: string; snapshotId?: string; cursor?: string }): Promise<GetDomResult>;
  executeJs(request: { source: string; args?: JsonValue }): Promise<ExecuteJsResult>;
  /** Bundle already produced; execute the exact Stage module in a clean run. */
  runDraft(request: { source: string; input: Record<string, JsonValue>; runId: string }): Promise<FixtureRunResult>;
}

export type HarnessBudget = { maxToolCalls: number; maxRuns: number };

export type HarnessEvent = {
  phase: "preparing" | "observing" | "exploring" | "coding" | "running" | "testing" | "proposing" | "completed" | "failed";
  message: string;
};

export type HarnessDeps = {
  build: EsbuildBuild;
  bridge: BrowserBridge;
  persistModule: (source: string) => Promise<ProgramModuleRef>;
  verifier: CompletionVerifier;
  coreFieldIds?: string[];
  budget?: Partial<HarnessBudget>;
  now?: () => string;
  onEvent?: (event: HarnessEvent) => void;
  makeRunId?: () => string;
};

export type AuthoringSessionContext = {
  goal: string;
  intent?: string;
  /** Human rejection feedback for this retry, with immutable review provenance. */
  reviewFeedback?: { reviewId: string; text: string };
  startUrl?: string;
  observedSuccessUrl?: string;
  modelProxyBaseUrl?: string;
  sampleInput?: Record<string, JsonValue>;
  coreFieldIds: string[];
  specDoc?: CapabilitySpecDoc;
};

export type AuthoringSessionResult =
  | { ok: true; kind: CodingAgentKind; implementation: AuthoredImplementation; workspace: AuthoringWorkspaceSnapshot; report: TestReport }
  | { ok: false; kind: CodingAgentKind; code: string; reasons: string[]; workspace: AuthoringWorkspaceSnapshot; report?: TestReport };

const DEFAULT_BUDGET: HarnessBudget = { maxToolCalls: 80, maxRuns: 24 };

/**
 * The toolset the coding agent drives. Every mutating/observing tool is routed
 * through here so the flow logic (budget, bundling, gating, provenance) is the
 * single source of truth regardless of which agent calls it.
 */
export class AuthoringHarness {
  readonly workspace: AuthoringWorkspace;
  private readonly deps: HarnessDeps;
  private readonly budget: HarnessBudget;
  private toolCalls = 0;
  private runs = 0;
  private lastReport: TestReport | undefined;
  private readonly provingRuns: NonNullable<AuthoringProof["provingRuns"]> = [];
  private submitted: AuthoredImplementation | undefined;
  private cachedBundle: { fingerprint: string; result: BundleResult } | undefined;

  constructor(context: AuthoringSessionContext, deps: HarnessDeps) {
    this.deps = deps;
    this.budget = { ...DEFAULT_BUDGET, ...deps.budget };
    const now = deps.now ?? (() => new Date().toISOString());
    this.workspace = new AuthoringWorkspace(scaffoldWorkspace({
      goal: context.goal,
      intent: context.intent,
      now: now(),
      specDoc: context.specDoc,
      coreFieldIds: context.coreFieldIds,
      sampleInput: context.sampleInput,
    }), now);
  }

  private emit(event: HarnessEvent) {
    this.deps.onEvent?.(event);
  }

  private guard<T>(): ToolResult<T> | undefined {
    if (this.toolCalls >= this.budget.maxToolCalls) return fail("budget_exhausted", `tool-call budget of ${this.budget.maxToolCalls} reached`);
    this.toolCalls += 1;
    return undefined;
  }

  get stats() {
    return { toolCalls: this.toolCalls, runs: this.runs, budget: this.budget, submitted: Boolean(this.submitted) };
  }

  // --- file tools -----------------------------------------------------------
  listFiles(): ToolResult<WorkspaceListing> {
    const blocked = this.guard<WorkspaceListing>();
    if (blocked) return blocked;
    return ok(this.workspace.list());
  }

  readFile(path: string): ToolResult<string> {
    const blocked = this.guard<string>();
    if (blocked) return blocked;
    try {
      return ok(this.workspace.read(path));
    } catch (error) {
      return fail("read_failed", error instanceof Error ? error.message : String(error));
    }
  }

  writeFile(path: string, content: string): ToolResult<{ path: string; bytes: number }> {
    const blocked = this.guard<{ path: string; bytes: number }>();
    if (blocked) return blocked;
    try {
      const record = this.workspace.write(path, content);
      this.cachedBundle = undefined; // invalidate bundle cache on any edit
      this.emit({ phase: "coding", message: `wrote ${record.path}` });
      return ok({ path: record.path, bytes: new TextEncoder().encode(record.content).length });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "write_failed";
      return fail(code, error instanceof Error ? error.message : String(error));
    }
  }

  deleteFile(path: string): ToolResult<{ deleted: boolean }> {
    const blocked = this.guard<{ deleted: boolean }>();
    if (blocked) return blocked;
    try {
      const deleted = this.workspace.delete(path);
      this.cachedBundle = undefined;
      return ok({ deleted });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "delete_failed";
      return fail(code, error instanceof Error ? error.message : String(error));
    }
  }

  // --- browser tools --------------------------------------------------------
  async getDom(request?: { selector?: string; snapshotId?: string; cursor?: string }): Promise<ToolResult<GetDomResult>> {
    const blocked = this.guard<GetDomResult>();
    if (blocked) return blocked;
    this.emit({ phase: "observing", message: request?.selector ? `get_dom:${request.selector}` : "get_dom" });
    return ok(await this.deps.bridge.getDom(request));
  }

  async executeJs(request: { source: string; args?: JsonValue }): Promise<ToolResult<ExecuteJsResult>> {
    const blocked = this.guard<ExecuteJsResult>();
    if (blocked) return blocked;
    this.emit({ phase: "exploring", message: "execute_js" });
    return ok(await this.deps.bridge.executeJs(request));
  }

  // --- run / test -----------------------------------------------------------
  private async bundle(): Promise<BundleResult> {
    const files = this.workspace.toFiles();
    const fingerprint = files.map((file) => `${file.path}:${file.content.length}:${file.updatedAt}`).join("|");
    if (this.cachedBundle && this.cachedBundle.fingerprint === fingerprint) return this.cachedBundle.result;
    const result = await bundleWorkspace(files, { build: this.deps.build });
    this.cachedBundle = { fingerprint, result };
    return result;
  }

  async runDraft(input: Record<string, JsonValue>): Promise<ToolResult<FixtureRunResult>> {
    const blocked = this.guard<FixtureRunResult>();
    if (blocked) return blocked;
    if (this.runs >= this.budget.maxRuns) return fail("run_budget_exhausted", `run budget of ${this.budget.maxRuns} reached`);
    const bundled = await this.bundle();
    if (!bundled.ok) return fail(bundled.code, bundled.message, bundled.diagnostics);
    this.runs += 1;
    const runId = this.deps.makeRunId?.() ?? `run-${this.runs}`;
    this.emit({ phase: "running", message: `run_draft ${runId}` });
    const result = await this.deps.bridge.runDraft({ source: bundled.source, input, runId });
    if (result.outcome === "success") {
      this.provingRuns.push({
        runId,
        input,
        outcome: result.outcome,
        producedFieldIds: result.producedFieldIds,
        producedValues: result.producedValues,
        replayChunkIds: undefined,
        at: (this.deps.now ?? (() => new Date().toISOString()))(),
      });
    }
    return ok(result);
  }

  private readFixtures(): { ok: true; cases: CapabilityFixture[] } | { ok: false; code: string; message: string } {
    let json: string;
    try {
      json = this.workspace.read(FIXTURES_PATH);
    } catch {
      return { ok: false, code: "fixtures_missing", message: `${FIXTURES_PATH} not found` };
    }
    const parsed = parseFixtures(json);
    if (!parsed.ok) return parsed;
    return { ok: true, cases: parsed.cases };
  }

  async runTests(): Promise<ToolResult<TestReport>> {
    const blocked = this.guard<TestReport>();
    if (blocked) return blocked;
    const fixtures = this.readFixtures();
    if (!fixtures.ok) return fail(fixtures.code, fixtures.message);
    this.emit({ phase: "testing", message: `run_tests (${fixtures.cases.length} cases)` });
    const bundled = await this.bundle();
    if (!bundled.ok) return fail(bundled.code, bundled.message, bundled.diagnostics);
    const results: FixtureRunResult[] = [];
    for (const fixture of fixtures.cases) {
      if (this.runs >= this.budget.maxRuns) {
        results.push({ fixtureId: fixture.id, outcome: "no-result", producedFieldIds: [], error: "run budget exhausted" });
        continue;
      }
      this.runs += 1;
      const runId = this.deps.makeRunId?.() ?? `test-${this.runs}`;
      const result = await this.deps.bridge.runDraft({ source: bundled.source, input: fixture.input, runId });
      if (result.outcome === "success") {
        this.provingRuns.push({
          runId,
          input: fixture.input,
          outcome: result.outcome,
          producedFieldIds: result.producedFieldIds,
          producedValues: result.producedValues,
          at: (this.deps.now ?? (() => new Date().toISOString()))(),
        });
      }
      results.push({ ...result, fixtureId: fixture.id });
    }
    this.lastReport = summarizeTestReport(fixtures.cases, results);
    return ok(this.lastReport);
  }

  // --- submit ---------------------------------------------------------------
  async submit(): Promise<ToolResult<AuthoredImplementation>> {
    const blocked = this.guard<AuthoredImplementation>();
    if (blocked) return blocked;
    if (!this.lastReport) {
      const report = await this.runTests();
      if (!report.ok) return fail("submit_tests_failed", `run_tests must pass before submit: ${report.message}`, report.diagnostics);
    }
    const gate = evaluateSubmitGate({
      report: this.lastReport!,
      provingRuns: this.provingRuns,
    });
    if (!gate.ok) return fail("submit_gate_rejected", "self-verification gate rejected submit", gate.reasons);
    const bundled = await this.bundle();
    if (!bundled.ok) return fail(bundled.code, bundled.message, bundled.diagnostics);
    let moduleRef: ProgramModuleRef;
    try {
      moduleRef = await this.deps.persistModule(bundled.source);
    } catch (error) {
      return fail("persist_failed", error instanceof Error ? error.message : String(error));
    }
    const snapshot = await this.workspace.snapshot();
    const now = (this.deps.now ?? (() => new Date().toISOString()))();
    const proof: AuthoringProof = {
      version: 1,
      iterationId: `authoring-${snapshot.hash.slice(0, 12)}`,
      author: "ai-program-author",
      rationale: `Bundled from a ${snapshot.files.length}-file workspace and self-verified against ${this.lastReport!.total} fixtures.`,
      alternativeIds: [],
      verifier: this.deps.verifier,
      groundedTargetIds: [],
      provingRuns: this.provingRuns.slice(),
      workspaceHash: snapshot.hash,
      createdAt: now,
    };
    this.submitted = { kind: "module", module: moduleRef, proof };
    this.emit({ phase: "proposing", message: `submit ${moduleRef.contentHash.slice(0, 12)}` });
    return ok(this.submitted);
  }

  get result(): AuthoredImplementation | undefined {
    return this.submitted;
  }

  get report(): TestReport | undefined {
    return this.lastReport;
  }
}

/**
 * Codex drives production authoring. `fake` is only a deterministic test
 * driver for the same harness.
 */
export interface CodingAgentDriver {
  readonly kind: CodingAgentKind;
  drive(harness: AuthoringHarness, context: AuthoringSessionContext): Promise<void>;
}

/** Run a full authoring session: scaffold is seeded, the driver drives, the gate decides. */
export async function runAuthoringSession(
  driver: CodingAgentDriver,
  context: AuthoringSessionContext,
  deps: HarnessDeps,
): Promise<AuthoringSessionResult> {
  const harness = new AuthoringHarness(context, deps);
  deps.onEvent?.({ phase: "preparing", message: `authoring with ${driver.kind}` });
  try {
    await driver.drive(harness, context);
  } catch (error) {
    const snapshot = await harness.workspace.snapshot();
    return { ok: false, kind: driver.kind, code: "driver_error", reasons: [error instanceof Error ? error.message : String(error)], workspace: snapshot, report: harness.report };
  }
  const snapshot = await harness.workspace.snapshot();
  const implementation = harness.result;
  if (implementation) {
    implementation.proof.codingAgent = driver.kind;
    deps.onEvent?.({ phase: "completed", message: "submitted" });
    return { ok: true, kind: driver.kind, implementation, workspace: snapshot, report: harness.report! };
  }
  deps.onEvent?.({ phase: "failed", message: "session ended without a passing submit" });
  return { ok: false, kind: driver.kind, code: "no_submit", reasons: ["session ended without a passing submit"], workspace: snapshot, report: harness.report };
}

export type FakeStep =
  | { tool: "write_file"; path: string; content: string }
  | { tool: "delete_file"; path: string }
  | { tool: "get_dom"; selector?: string }
  | { tool: "execute_js"; source: string; args?: JsonValue }
  | { tool: "run_draft"; input: Record<string, JsonValue> }
  | { tool: "run_tests" }
  | { tool: "submit" };

/**
 * A deterministic scripted driver used by tests to exercise the whole flow
 * without a model. If a FakeDriver script that mirrors a correct session goes
 * green, the flow is proven sound.
 */
export class FakeDriver implements CodingAgentDriver {
  readonly kind: CodingAgentKind = "fake";
  private readonly steps: FakeStep[];
  constructor(steps: FakeStep[]) {
    this.steps = steps;
  }
  async drive(harness: AuthoringHarness): Promise<void> {
    for (const step of this.steps) {
      switch (step.tool) {
        case "write_file":
          harness.writeFile(step.path, step.content);
          break;
        case "delete_file":
          harness.deleteFile(step.path);
          break;
        case "get_dom":
          await harness.getDom({ selector: step.selector });
          break;
        case "execute_js":
          await harness.executeJs({ source: step.source, args: step.args });
          break;
        case "run_draft":
          await harness.runDraft(step.input);
          break;
        case "run_tests":
          await harness.runTests();
          break;
        case "submit":
          await harness.submit();
          break;
      }
    }
  }
}
