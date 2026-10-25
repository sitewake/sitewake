import type { Page } from "playwright";
import type { CapabilityContract, CapabilityProgram, JsonObject } from "../../lib/capability-center-v2/model";
import { VALIDATION_RESULT_KEY } from "../../lib/capability-center-v2/validation-run";

export type VisitorHostResult = {
  status: string;
  code: string;
  summary: string;
  output: JsonObject;
  url: string;
};

export type VisitorHostCheck =
  | { outcome: "Agreed"; result: VisitorHostResult }
  | { outcome: "Diverged"; reason: string; result?: VisitorHostResult; widgetStatus?: string }
  | { outcome: "Skipped"; reason: string };

/**
 * Run a candidate the way a visitor's run goes, on the page the replay used.
 *
 * Validation replays a program in its own Playwright host, but visitors run it
 * in the widget, and the two had grown apart: the widget held back a stage's
 * own link click (the stage waited forever), filled only required defaults
 * (`maxPrice=undefined`) and, resuming a first stage on a new document, went
 * back to the entry page and started over. Every one of those capabilities
 * passed validation and hung or looped for the visitor. This runs the same
 * input through the widget itself — its executor, a real AgentRun, real
 * handoffs — and reports whether it reached the same result.
 *
 * The page must load the site's widget, as it must for any visitor to use a
 * capability. A page without it, or with a widget too old to take a
 * candidate, is skipped and said so; it is not a defect of the capability.
 */
export async function runCandidateInVisitorHost(options: {
  page: Page;
  startUrl?: string;
  candidate: { name: string; description?: string; contract: CapabilityContract; program: CapabilityProgram };
  input: JsonObject;
  timeoutMs: number;
}): Promise<VisitorHostCheck> {
  const { page } = options;
  await page.context().addInitScript(() => { (window as Window & { __sitewakeValidation?: boolean }).__sitewakeValidation = true; });
  if (options.startUrl) await page.goto(options.startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const widget = await page.waitForFunction(
    () => {
      const api = (window as Window & { SiteWake?: { validateCandidate?: unknown } }).SiteWake;
      return api ? (typeof api.validateCandidate === "function" ? "ready" : "outdated") : false;
    },
    null,
    { timeout: 20_000 },
  ).then((handle) => handle.jsonValue() as Promise<string>).catch(() => "absent");
  if (widget === "absent") return { outcome: "Skipped", reason: "the page does not load the SiteWake widget" };
  if (widget === "outdated") return { outcome: "Skipped", reason: "the page loads a SiteWake widget that cannot run a candidate" };
  const runtime = {
    capabilityId: "validation-candidate",
    versionId: "validation-candidate",
    name: options.candidate.name,
    description: options.candidate.description || "",
    contract: options.candidate.contract,
    program: options.candidate.program,
    executionGrantId: "",
  };
  // Not awaited: a run that leaves the document never settles this promise.
  // The result is read from the session on whichever document the run ends.
  // Passed as JSON text: Playwright's argument typing recurses through the
  // whole contract and program types and gives up.
  await page.evaluate((payload: string) => {
    const { key, definition, input } = JSON.parse(payload) as { key: string; definition: unknown; input: unknown };
    sessionStorage.removeItem(key);
    const api = (window as unknown as { SiteWake: { validateCandidate: (runtime: unknown, input: unknown) => Promise<unknown> } }).SiteWake;
    void api.validateCandidate(definition, input).catch(() => undefined);
  }, JSON.stringify({ key: VALIDATION_RESULT_KEY, definition: runtime, input: options.input }));
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1_000);
    const raw = await page.evaluate((key) => sessionStorage.getItem(key), VALIDATION_RESULT_KEY).catch(() => null);
    if (!raw) continue;
    let result: VisitorHostResult;
    try { result = JSON.parse(raw) as VisitorHostResult; } catch { continue; }
    return result.status === "success"
      ? { outcome: "Agreed", result }
      : { outcome: "Diverged", reason: `${result.code || result.status}: ${result.summary}`, result };
  }
  const widgetStatus = await page.evaluate(() => {
    const root = document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot;
    return root?.querySelector(".status")?.textContent || "";
  }).catch(() => "");
  return { outcome: "Diverged", reason: `the run did not finish within ${Math.round(options.timeoutMs / 1000)}s at ${page.url()}`, widgetStatus };
}
