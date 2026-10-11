import type { BrowserContext, Frame, Page } from "playwright";
import { assertCapabilityOutput } from "../lib/site-knowledge/capability-output";
import type { CapabilityStageResult, JsonSchema, JsonValue } from "../lib/site-knowledge/protocol";

export { assertCapabilityOutput } from "../lib/site-knowledge/capability-output";

export type StageTransition = "none" | "navigation" | "new-page";

export type StageRunReceipt = {
  stageId: string;
  stageIndex: number;
  urlBefore: string;
  urlAfter: string;
  transition: StageTransition;
  durationMs: number;
};

export type PlaywrightStageRunResult = {
  page: Page;
  output: Record<string, JsonValue>;
  state: Record<string, JsonValue>;
  receipts: StageRunReceipt[];
};

export class PlaywrightStageRunError extends Error {
  constructor(message: string, readonly receipts: StageRunReceipt[]) {
    super(message);
    this.name = "PlaywrightStageRunError";
  }
}

type ModuleShape = { version: number; stageIds: string[] };

async function moduleShape(page: Page, moduleUrl: string): Promise<ModuleShape> {
  return page.evaluate(async (url) => {
    const loaded = await import(/* @vite-ignore */ url) as { capability?: { version?: number; stages?: Array<{ id?: string; run?: unknown }> } };
    const capability = loaded.capability;
    if (capability?.version !== 1 || !Array.isArray(capability.stages) || capability.stages.length === 0) throw new Error("capability_module_invalid");
    const stageIds = capability.stages.map((stage, index) => {
      if (!stage || typeof stage.id !== "string" || !stage.id || typeof stage.run !== "function") throw new Error(`capability_stage_invalid:${index}`);
      return stage.id;
    });
    if (new Set(stageIds).size !== stageIds.length) throw new Error("capability_stage_id_duplicate");
    return { version: capability.version, stageIds };
  }, moduleUrl);
}

async function executeStage(
  page: Page,
  moduleUrl: string,
  stageIndex: number,
  input: Record<string, JsonValue>,
  state: Record<string, JsonValue>,
) {
  const evaluate = page.evaluate.bind(page) as (fn: (args: { url: string; index: number; stageInput: Record<string, JsonValue>; stageState: Record<string, JsonValue> }) => Promise<CapabilityStageResult>, args: { url: string; index: number; stageInput: Record<string, JsonValue>; stageState: Record<string, JsonValue> }) => Promise<CapabilityStageResult>;
  return evaluate(async ({ url, index, stageInput, stageState }) => {
    const loaded = await import(/* @vite-ignore */ url) as { capability?: { stages?: Array<{ run?: (context: unknown) => unknown }> } };
    const stage = loaded.capability?.stages?.[index];
    if (!stage || typeof stage.run !== "function") throw new Error(`capability_stage_missing:${index}`);
    const value = await stage.run({ input: stageInput, state: stageState });
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`capability_stage_result_invalid:${index}`);
    return value as CapabilityStageResult;
  }, { url: moduleUrl, index: stageIndex, stageInput: input, stageState: state });
}

function isDestroyedContext(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed|target page, context or browser has been closed|frame was detached/i.test(message);
}

/**
 * The exact Stage Runner used by authoring proof, independent validation and
 * cloud execution. Playwright owns page/tab transitions; the authored module
 * contains only native page JavaScript.
 */
export async function runPlaywrightCapabilityStages(options: {
  page: Page;
  moduleUrl: string;
  input: Record<string, JsonValue>;
  outputSchema?: JsonSchema;
  transitionGraceMs?: number;
  onStage?: (page: Page, receipt: StageRunReceipt) => void | Promise<void>;
}): Promise<PlaywrightStageRunResult> {
  let page = options.page;
  const context: BrowserContext = page.context();
  const shape = await moduleShape(page, options.moduleUrl);
  const state: Record<string, JsonValue> = {};
  const receipts: StageRunReceipt[] = [];
  let output: Record<string, JsonValue> | undefined;

  for (let stageIndex = 0; stageIndex < shape.stageIds.length; stageIndex += 1) {
    const stageId = shape.stageIds[stageIndex];
    const urlBefore = page.url();
    const startedAt = Date.now();
    let openedPage: Page | undefined;
    let navigated = false;
    const onPage = (candidate: Page) => { if (candidate !== page) openedPage = candidate; };
    const onFrame = (frame: Frame) => {
      if (frame.page() === page && frame.parentFrame() === null) navigated = true;
    };
    context.on("page", onPage);
    page.on("framenavigated", onFrame);
    let result: CapabilityStageResult | undefined;
    try {
      try {
        result = await executeStage(page, options.moduleUrl, stageIndex, options.input, state);
      } catch (error) {
        if (!isDestroyedContext(error)) throw error;
      }
      // Give an assignment to location/open() one event-loop window to become
      // observable, then wait for the destination itself. This is one
      // deterministic transition barrier, not a retry policy.
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (!result?.output && stageIndex < shape.stageIds.length - 1 && !openedPage && !navigated && page.url() === urlBefore) {
        const transitionDeadline = Date.now() + 5_000;
        while (!openedPage && !navigated && page.url() === urlBefore && Date.now() < transitionDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (page.url() !== urlBefore) navigated = true;
      }
      if (openedPage) {
        page = openedPage;
        await page.waitForLoadState("domcontentloaded", { timeout: 20_000 });
      } else if (navigated) {
        await page.waitForLoadState("domcontentloaded", { timeout: 20_000 });
      }
      if (openedPage || navigated) {
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, options.transitionGraceMs ?? 500));
      }
    } finally {
      context.off("page", onPage);
      page.off("framenavigated", onFrame);
    }
    if (result?.state) Object.assign(state, result.state);
    if (result?.output) output = result.output;
    const receipt = {
      stageId,
      stageIndex,
      urlBefore,
      urlAfter: page.url(),
      transition: openedPage ? "new-page" : navigated || page.url() !== urlBefore ? "navigation" : "none",
      durationMs: Date.now() - startedAt,
    } satisfies StageRunReceipt;
    receipts.push(receipt);
    await options.onStage?.(page, receipt);
    if (output) break;
  }

  if (!output) throw new PlaywrightStageRunError("capability_output_missing", receipts);
  if (options.outputSchema) {
    try {
      assertCapabilityOutput(options.outputSchema, output);
    } catch (error) {
      throw new PlaywrightStageRunError(error instanceof Error ? error.message : String(error), receipts);
    }
  }
  return { page, output, state, receipts };
}
