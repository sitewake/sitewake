/**
 * PageAgent module contract — the two structures that define this module from the outside.
 *
 * PageAgent is not the user agent. It is a submodule: once the user agent has decided
 * the task requires operating the page, PageAgent is the layer that actually does it —
 * reads what is on screen, picks the next action, executes it, until the brief says the
 * task is done. Everything before that decision (which route, which capability to try,
 * how to word the answer) and after it (run records, widget UI) belongs to the host.
 *
 * This boundary is not invented here; the product already has it: PageAgent is a
 * separate bundle (`client/user-agent-adaptive.ts` -> `public/sitewake-adaptive.js`)
 * that the host loads with a `<script>` tag and drives via
 * `window.SiteWakeAdaptive.run(options)`. It shares no state with the host — everything
 * it needs enters through that options object, everything it produces leaves through
 * callbacks or the return value. This file is that options object written down as a
 * file format, minus the host's own plumbing (endpoint, run token, page epoch), which
 * belongs to the runtime environment rather than the task.
 *
 * Member types reuse the runtime protocol instead of re-declaring it, so this file can
 * never describe a structure the runtime cannot actually produce.
 */
import type {
  ActionReceiptV2,
  JsonValue,
  PageAgentObservation,
  PageExecutionBrief,
  PageExecutionBudget,
  SceneDefinition,
  SiteProfile,
  TaskEpisode,
  TaskSession,
} from "../site-knowledge/protocol";
import type { CapabilityV2Candidate } from "../../client/user-agent-port";

export const PAGE_AGENT_MODULE_SCHEMA_VERSION = "page-agent-module.v1";

/**
 * Module input ①. The task itself, handed down verbatim by the user agent. `goal` and
 * `input` are the two values the user agent received; `url` is where PageAgent starts —
 * the page is already chosen at this point (the user agent may have navigated first).
 */
export type PageAgentRequestInput = {
  goal: string;
  /** Business values the user filled into the form field by field. `{}` for plain chat. */
  input: Record<string, JsonValue>;
  /** Recent chat turns as model context. May be empty. */
  conversation: TaskSession["conversation"];
  origin: string;
  url: string;
};

/**
 * Module input ②. The upstream decisions about this run, and the most important part
 * of this file: it is the **authorization** PageAgent runs under, not a hint. `effect`
 * bounds how far the page may be changed and `completionCriteria` defines what counts as
 * done — the model may relax neither.
 *
 * `entities` is the set of trusted values for this run. Worth writing carefully: with
 * `entities: {}` in the brief, the capability center learns nothing from the run's
 * experience, because proving a query goal complete starts by requiring at least one
 * trusted entity.
 */
export type PageAgentBriefInput = {
  brief: PageExecutionBrief;
  /**
   * The run's starting budget. Omitted means production defaults (180 s active time,
   * 100 model requests). PageAgent counts down from here and writes the actual usage
   * back into the episode.
   */
  budget?: PageExecutionBudget;
};

/** The site profile PageAgent reads. Narrowed the same way as the user agent input. */
export type PageAgentProfileInput = Pick<SiteProfile,
  "name" | "description" | "suggestedGoals" | "taskTemplates" | "vocabulary" | "jobsToBeDone">;

/** The page knowledge PageAgent reads. The other Scene fields are authoring-time state, irrelevant at runtime. */
export type PageAgentSceneInput = Pick<SceneDefinition,
  "id" | "name" | "description" | "businessArea" | "urlTemplates">;

/**
 * Module input ③. The knowledge half of a release, narrowed to what PageAgent actually
 * reads: `profile` goes into the prompt as site background, `scenes` decides where
 * `navigate_scene` may go, `targets` recognizes previously named elements, and
 * `capabilities` tells it what `call_capability` can reach.
 *
 * Deliberately excluded: `version`, `knowledgeContentHash`, `linkReferences`. PageAgent
 * never reads them — the user agent uses them to record which knowledge version an
 * answer was based on, which a page operator does not need.
 */
export type PageAgentReleaseInput = {
  id: string;
  siteAgentId: string;
  profile: PageAgentProfileInput;
  scenes: PageAgentSceneInput[];
  /**
   * Known element targets on this site. Optional and usually empty: when nothing
   * matches, PageAgent describes one from what it sees on screen, so leaving it empty
   * only lowers recognition quality; it does not decide whether the run can proceed.
   */
  targets?: SiteAgentReleaseTargets;
  /** What `call_capability` can reach. Empty means the tool has nothing to do. */
  capabilities?: CapabilityV2Candidate[];
};

/** The stored release's element targets, in the shape PageAgent consumes. */
export type SiteAgentReleaseTargets = Array<{
  role: string;
  accessibleNames: string[];
  [key: string]: JsonValue | undefined;
}>;

/**
 * Module input ④. The services the host normally provides through callbacks.
 *
 * These are **declarations**, not scripts. A unit case may say "someone will answer
 * yes" — but not "answer X at step 3 and Y at step 5". A script puts the case author
 * back inside the run to decide for it; a declaration only states what the surroundings
 * look like and leaves the rest to the model.
 *
 * Every field is optional, and **omission has meaning**: the corresponding tool is not
 * offered to the model at all, exactly as when a real host passes no such callback.
 */
export type PageAgentServiceInput = {
  /**
   * `ask_user`. Present means the tool exists and every question gets this same answer.
   * Absent means the model cannot ask at all — the right setting for cases that must
   * complete unattended.
   */
  askUser?: { answer: string };
};

/**
 * Why there is no navigation service here.
 *
 * `onNavigateAction` does not mean "may I navigate" but "host, will you perform this
 * navigation and resume me on the target document" — once the host agrees, PageAgent
 * stops on the spot, because a fresh PageAgent over there continues with the handed-over
 * trace. Surviving a full-document navigation is the host's job: checkpoint, let the new
 * document claim the AgentRun, restart via `resumeTrace`.
 *
 * A PageAgent unit run has no such host, so the honest answer is always "no", and the
 * unit's cases are those that finish within a single document. Tasks that need a
 * navigation are about the host and belong to the host's tests.
 */

/** The gates this run operates under; all have production defaults. */
export type PageAgentRuntimeOptions = {
  /** `read-only` removes every write tool. Default `full`. */
  mode?: "full" | "read-only";
  /** Why read-only. Only `runtime-derived` may be lifted by asking the user. */
  readOnlySource?: "site-config" | "runtime-derived";
  visibility?: "production" | "sandbox" | "system";
  /** Maximum model round trips before the loop stops. Production default 24. */
  maxSteps?: number;
  /**
   * The proof an explicit page action must produce before reporting success. `input`
   * means filling the field counts; `material` requires a real page change. Omitted
   * lets PageAgent infer it from the target.
   */
  requiredActionEvidence?: "material" | "input";
  /** Both default on; turning evidence off leaves no page observations for the run. */
  runtimeV2?: boolean;
  evidenceV2?: boolean;
};

/**
 * Everything handed to PageAgent, and nothing else. No endpoint, no run token, no model
 * config: those are the runtime environment of the unit, not the task being described.
 */
export type PageAgentModuleInput = {
  schemaVersion: typeof PAGE_AGENT_MODULE_SCHEMA_VERSION;
  request: PageAgentRequestInput;
  execution: PageAgentBriefInput;
  release: PageAgentReleaseInput;
  services?: PageAgentServiceInput;
  runtime?: PageAgentRuntimeOptions;
};

/**
 * Module output ①. What PageAgent returns to its caller — the host turns it into the
 * answer shown to the user, but the wording is not PageAgent's.
 */
export type PageAgentResult = {
  success: boolean;
  /** PageAgent's own account of what happened. Not the final wording. */
  text: string;
  /** Business data read back from the page. `{}` when the task read nothing. */
  output: Record<string, JsonValue>;
};

/**
 * Module output ③. The page evidence that does not travel with the episode.
 *
 * In production it is shipped to the evidence store in batches **during** the run; the
 * episode then carries only `observationRefs` — id, sha256, turn index. PageAgent does
 * not send it itself: each observation goes to the host via `onObservation`, and the
 * host sends it. Collected here so a case can be read without a database.
 *
 * Action receipts are deliberately not repeated; they are already in
 * `episode.experience.actionReceiptsV2`.
 */
export type PageAgentEvidence = {
  observations: PageAgentObservation[];
};

/**
 * Everything PageAgent hands out, and nothing else. Three of the user agent's four
 * destinations; the fourth — the persisted run record — belongs to the host: the
 * AgentRun is the host's, PageAgent only borrows its token.
 */
export type PageAgentModuleOutput = {
  schemaVersion: typeof PAGE_AGENT_MODULE_SCHEMA_VERSION;
  /** ① Back to the caller. */
  result: PageAgentResult;
  /**
   * ② To the capability center via the host. Carries observation refs and action
   * receipts — that evidence chain is what makes the experience verifiable.
   */
  episode: TaskEpisode;
  /** ③ To the evidence store via the host. */
  evidence: PageAgentEvidence;
};

/** Re-exported so reading a case does not require opening the runtime protocol. */
export type { ActionReceiptV2, PageExecutionBrief, PageExecutionBudget };
