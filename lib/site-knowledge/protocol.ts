import type { RunnerControlProjection, RunnerLastError, RunnerObservedState, RunnerRole, RunnerWorkKind } from "../runner-control/protocol";

export type {
  BeginRunnerLeaseCompletionResult,
  RunnerAggregateProjection,
  RunnerControlProjection,
  RunnerControlSummary,
  RunnerFullProjection,
  RunnerHiddenProjection,
  RunnerInstance,
  RunnerLeaseGrant,
  RunnerLeaseRecord,
  RunnerPublicActiveLease,
  RunnerPublicInstance,
  RunnerLastError,
  RunnerPlacementBinding,
  RunnerPool,
  RunnerProjectionMode,
  RunnerQueueHealth,
  RunnerRole,
  RunnerTaskProjection,
  RunnerTaskAttemptProjection,
  RunnerTaskBrowserRunProjection,
  RunnerTaskStatus,
  RunnerVisibilityProvider,
  RunnerWorkKind,
} from "../runner-control/protocol";

export const SITE_AGENT_SCHEMA_VERSION = "site-agent.v2" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = {
  type: "object" | "array" | "string" | "number" | "boolean";
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  description?: string;
  format?: "date" | "date-time" | "uri" | "email";
  examples?: JsonValue[];
  enum?: JsonPrimitive[];
  pattern?: string;
  default?: JsonValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
};

export type OutcomeStatus =
  | "success"
  | "no-result"
  | "business-rejection"
  | "execution-fault"
  | "unknown";

export type SceneVerifier = {
  titleIncludes?: string[];
  headingIncludes?: string[];
  targetIds?: string[];
  textIncludes?: string[];
};

export type UrlTemplate = {
  id: string;
  originPattern: string;
  pathnamePattern: string;
  query: Record<string, string>;
  hashPattern?: string;
  ignoredQueryKeys?: string[];
  /**
   * Hash-router SPAs (`#/route`) put the real page in the fragment. When set to
   * "hash", `pathnamePattern` describes the effective route (basePath + hash
   * route) so distinct routes are distinct Scenes; `basePath` is the real
   * pathname the fragment hangs off (usually "/").
   */
  routeMode?: "hash";
  basePath?: string;
};

export type SceneDefinition = {
  id: string;
  name: string;
  description?: string;
  semanticSource?: "program" | "ai" | "human";
  businessArea?: string;
  /**
   * Evidence ladder, weakest→strongest: `referenced` (only seen as a link) →
   * `crawled` (the onboarding crawler fetched the page, so it certainly exists,
   * but nobody has really used it) → `observed` (a real user/agent was on it) →
   * `entry-verified` (confirmed reachable as a direct entry).
   */
  evidenceStatus?: "referenced" | "crawled" | "observed" | "entry-verified";
  /**
   * Which production pipeline created/last-touched this scene. `crawl` = the
   * onboarding crawler; `usage` = real user/agent behaviour. A scene touched by
   * both keeps every origin in `origins`; `origin` names the primary/creator.
   */
  origin?: "crawl" | "usage";
  origins?: Array<"crawl" | "usage">;
  /** Concrete URLs a crawl folded into this scene's template without rendering each. */
  sampleCount?: number;
  semanticReview?: {
    status: "pending" | "reviewed" | "failed";
    evidenceHash: string;
    model?: string;
    attemptedAt: string;
    reviewedAt?: string;
  };
  /** @deprecated use evidenceStatus and semanticReview; retained for v2 release compatibility */
  lifecycle?: "referenced" | "crawled" | "observed" | "semantic-reviewed" | "entry-verified";
  identityConfidence?: number;
  evidence?: {
    linkLabels: string[];
    observedUrls: string[];
    titles: string[];
    headings: string[];
  };
  urlTemplates: UrlTemplate[];
  parameters: Array<{
    id: string;
    name: string;
    type: "string" | "number" | "boolean";
    description?: string;
    required: boolean;
    examples: JsonPrimitive[];
  }>;
  verifier: SceneVerifier;
  /**
   * Direct-entry readiness (execution layer). `candidate` = not yet proven
   * reachable; `verified` = a real run reached it via its URL template and the
   * verifier passed; `needs-reverify` = was verified but a run failed or the site
   * drifted, awaiting re-check; `failed` = repeatedly unreachable.
   */
  directEntry: "candidate" | "verified" | "needs-reverify" | "failed";
  /** Execution health that drives promotion/demotion. Counters/timestamps only —
   *  excluded from the material knowledge hash so they never re-version the release. */
  entryHealth?: { successes: number; failures: number; failStreak: number; lastOkAt?: string; lastFailAt?: string };
  /** When the entry was last proven reachable (freshness / TTL re-verify anchor). */
  lastVerifiedAt?: string;
  /** When the entry was last demoted, and why (surfaced as "why not promoted"). */
  demotedAt?: string;
  verificationFailure?: string;
  sourceObservationIds: string[];
  /**
   * When the page was first created, whether from a crawl or a visitor; preserved when
   * evidence is merged. The console marks "new" from it. Listed among the fingerprint's
   * volatile keys, so it never triggers a new version on its own; old knowledge bases
   * lack it and read as unknown.
   */
  createdAt?: string;
  updatedAt: string;
};

export type SceneInstance = {
  sceneId: string;
  url: string;
  bindings: Record<string, JsonPrimitive>;
  confidence: number;
  observedAt: string;
};

export type SceneRef<TScene extends string = string> = {
  sceneId: TScene;
  url: string;
  bindings: Record<string, JsonPrimitive>;
  label?: string;
  evidence?: Record<string, JsonValue>;
};

export type LinkReference = {
  id: string;
  fromSceneId: string;
  toSceneId: string;
  label: string;
  href: string;
  landmark: "header" | "nav" | "main" | "aside" | "footer" | "unknown";
  observations: number;
  /** Provenance of this link edge; see SceneDefinition.origin. */
  origin?: "crawl" | "usage";
  origins?: Array<"crawl" | "usage">;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type LocatorStrategy =
  | "role"
  | "label"
  | "placeholder"
  | "name"
  | "text"
  | "href-template"
  | "relative"
  | "css";

export type LocatorVariant = {
  id: string;
  strategy: LocatorStrategy;
  value: string;
  role?: string;
  contextTargetId?: string;
  score: number;
  successes: number;
  failures: number;
  lastSeenAt: string;
};

export type TargetSpec = {
  id: string;
  name: string;
  /** Sensitive controls are human boundaries and can never be executable targets. */
  sensitive?: boolean;
  purpose?: string;
  sceneIds: string[];
  role?: string;
  accessibleNames: string[];
  attributes: Record<string, string>;
  hrefTemplateId?: string;
  contextTargetId?: string;
  locatorVariants: LocatorVariant[];
  updatedAt: string;
};

export type ValueExpression =
  | { source: "literal"; value: JsonValue }
  | { source: "input"; path: string }
  | { source: "state"; path: string }
  | { source: "step"; path: string };

export type PageProgramStep =
  | { id: string; op: "navigate"; sceneId: string; bindings: Record<string, ValueExpression>; timeoutMs: number; transition?: TransitionContract }
  | { id: string; op: "click"; targetId: string; timeoutMs: number; transition?: TransitionContract }
  | { id: string; op: "fill" | "type"; targetId: string; value: ValueExpression; timeoutMs: number }
  | { id: string; op: "press"; targetId?: string; key: string; timeoutMs: number }
  | { id: string; op: "select"; targetId: string; value: ValueExpression; timeoutMs: number }
  | { id: string; op: "scroll"; targetId?: string; direction: "up" | "down"; amount?: number; timeoutMs: number }
  | { id: string; op: "waitForScene"; sceneId: string; timeoutMs: number }
  | { id: string; op: "waitForTarget"; targetId: string; timeoutMs: number }
  | { id: string; op: "waitForCondition"; text?: string; urlPattern?: string; timeoutMs: number }
  | { id: string; op: "extract"; targetId: string; attribute?: string; schema: JsonSchema; saveAs: string; timeoutMs: number }
  | { id: string; op: "map" | "filter" | "sort" | "pick" | "limit"; input: ValueExpression; expression?: string; saveAs: string }
  | { id: string; op: "assertScene"; sceneId: string; timeoutMs: number }
  | { id: string; op: "assertTarget"; targetId: string; timeoutMs: number }
  | { id: string; op: "assertOutcome"; outcomeId: string; timeoutMs: number };

export type PageProgram = {
  version: 2;
  steps: PageProgramStep[];
};

/**
 * Runtime scope is deliberately wider than today's exact-origin product
 * boundary. A future Agent Space can add namespaces/origins without changing
 * the run, program or BrowserPort protocols.
 */
export type ExecutionScope = {
  kind: "site";
  siteAgentId: string;
  allowedOrigins: string[];
  knowledgeNamespaceIds: string[];
};

export type TransitionContract = {
  kind: "spa" | "document" | "new-tab";
  expectedSceneIds: string[];
  expectedOrigin: string;
  outputBindings?: BindingExpressionMap;
};

export type ProgramCursor = {
  capabilityProgramId?: string;
  operationIndex: number;
  programStepIndex: number;
  sliceId?: string;
};

export type CapabilityProgramStep = {
  operationId: string;
  siteAgentId: string;
  inputBindings: BindingExpressionMap;
  outputBindings: BindingExpressionMap;
};

export type CapabilityProgram = {
  id: string;
  capabilityRevisionId: string;
  capabilityId: string;
  scope: ExecutionScope;
  inputs: JsonSchema;
  outputs: JsonSchema;
  plan: CapabilityProgramStep[];
  createdAt: string;
};

export type ExecutionSlice = {
  id: string;
  runId: string;
  toolCallId: string;
  capabilityRevisionId: string;
  operationId: string;
  implementationId: string;
  requiredSiteAgentId: string;
  requiredSceneIds: string[];
  steps: PageProgramStep[];
  expectedTransition?: TransitionContract;
  expectedOutputs: JsonSchema;
  programCursor: ProgramCursor;
};

export type ExecutionReceipt = {
  sliceId: string;
  runId: string;
  toolCallId: string;
  pageEpoch: number;
  status: "completed" | "transitioning" | "failed";
  executedStepIds: string[];
  transition?: SceneRef;
  outputBindings: Record<string, JsonValue>;
  evidenceRefs: string[];
  error?: { code: string; message: string };
  createdAt: string;
};

export type CompletionVerifier = {
  success: Array<{ kind: "scene" | "url" | "text" | "target" | "input-visible"; value: string; inputId?: string }>;
  noResult: Array<{ kind: "url" | "text" | "target"; value: string }>;
  businessRejection: Array<{ kind: "url" | "text" | "target"; value: string }>;
};

export type ProgramModuleRef = {
  contentHash: string;
  moduleUrl: string;
  exportName: "capability";
};

/**
 * The only program artifact produced by Capability Center v1.
 * Every stage executes inside the target page and may only use browser globals
 * plus the serializable input/state supplied by the runner.
 */
export type CapabilityStageContext = {
  input: Record<string, JsonValue>;
  state: Record<string, JsonValue>;
};

export type CapabilityStageResult = {
  state?: Record<string, JsonValue>;
  output?: Record<string, JsonValue>;
};

export type CapabilityStageDefinition = {
  id: string;
  run(context: CapabilityStageContext): CapabilityStageResult | void | Promise<CapabilityStageResult | void>;
};

export type CapabilityModule = {
  version: 1;
  stages: CapabilityStageDefinition[];
};

export type AuthoringProof = {
  version: 1;
  iterationId: string;
  author: "ai-program-author";
  rationale: string;
  alternativeIds: string[];
  verifier: CompletionVerifier;
  groundedTargetIds: string[];
  extractionProofs?: ExtractionProof[];
  /**
   * Evidence that the authored function was actually run to completion by the
   * AI before submission. submit is gated on at least one passing run that
  * produced the required result fields (self-verification, not model claim).
  */
 provingRuns?: Array<{
   runId: string;
   input: Record<string, JsonValue>;
   outcome: OutcomeStatus;
   producedFieldIds: string[];
   producedValues?: Record<string, JsonValue>;
   replayChunkIds?: string[];
   at: string;
 }>;
  /**
   * Hash of the engineering workspace (VFS) at submit time. Lets the console
   * replay "which files the AI wrote". This is authoring craft evidence, not a
   * part of the immutable Release (the Release only carries the bundled module).
   */
  workspaceHash?: string;
  /** Which coding agent produced this implementation. */
  codingAgent?: CodingAgentKind;
  createdAt: string;
};

export type AuthoredImplementation =
  | { kind: "page-program"; program: PageProgram; proof: AuthoringProof }
  | { kind: "module"; module: ProgramModuleRef; proof: AuthoringProof };

export type NavigationToolDependencyPin = {
  toolId: string;
  knowledgeRevision: number;
  dependencyHash: string;
};

/**
 * The implementation owned by a Capability Revision.
 *
 * `page-program` and `module` remain in the union so immutable historical
 * Revision JSON can be read without rewriting it. Newly materialized
 * Revisions use one of the explicit `program | navigation-tool | workflow`
 * variants.
 */
export type CapabilityRevisionImplementation =
  | {
    kind: "program";
    moduleRef?: ProgramModuleRef;
    pageProgram?: PageProgram;
    navigationToolRefs?: NavigationToolDependencyPin[];
    inputBindings?: BindingExpressionMap;
    outputBindings?: BindingExpressionMap;
    proof?: AuthoringProof;
  }
  | {
    kind: "navigation-tool";
    toolRef: NavigationToolDependencyPin;
    inputBindings?: BindingExpressionMap;
    outputBindings?: BindingExpressionMap;
  }
  | {
    kind: "workflow";
    nodes: Array<{ capabilityId: string }>;
    inputBindings?: BindingExpressionMap;
    outputBindings?: BindingExpressionMap;
  }
  | AuthoredImplementation;

/**
 * The engineering workspace (virtual file system) an authoring session works in.
 * It is a writing ergonomic only: the deliverable is always a single hashed
 * ES module bundled from this VFS (see runner/authoring-bundler). Files never
 * touch the runner's Node context and never ship to the terminal browser.
 */
export type AuthoringWorkspaceFile = {
  path: string; // VFS-relative, e.g. "capability.ts" or "lib/extract.ts"
  content: string;
  updatedAt: string;
};

export type AuthoringWorkspaceSnapshot = {
  hash: string; // sha256 over the canonical (path-sorted) file listing
  files: AuthoringWorkspaceFile[];
  createdAt: string;
};

/**
 * A persisted authoring workspace snapshot. Unlike the immutable Release (which
 * only carries the bundled module), this is authoring-craft evidence: it lets
 * the console replay "which files the AI wrote" and how the coding session
 * converged. It is scoped to a project/revision/run for retrieval.
 */
export type PersistedAuthoringWorkspace = {
  id: string;
  siteAgentId: string;
  projectId: string;
  revisionId?: string;
  learningJobId?: string;
  runId?: string;
  hash: string;
  files: AuthoringWorkspaceFile[];
  report?: { total: number; passed: number; failed: number; coveredFieldIds?: string[] };
  provingRuns: number;
  codingAgent: CodingAgentKind;
  moduleContentHash?: string;
  createdAt: string;
};

/**
 * Navigation goals can be explored by the execution model and materialized by
 * a deterministic generator; general business capabilities use Codex. `fake`
 * exists solely to exercise the deterministic harness in tests.
 */
export type CodingAgentKind = "codex" | "navigation-ai" | "fake";

export type AuthoringDraft = {
  id: string;
  version: 1;
  capabilityId: string;
  rationale: string;
  alternatives: Array<{
    id: string;
    kind: "page-program" | "module";
    label: string;
    rationale: string;
    selected: boolean;
  }>;
  targets: TargetSpec[];
  implementation: AuthoredImplementation;
  createdAt: string;
};

export type AuthoringIteration = {
  id: string;
  attempt: number;
  status: "proposed" | "grounded" | "passed" | "failed";
  draft?: AuthoringDraft;
  failure?: { code: string; summary: string };
  runId?: string;
  createdAt: string;
  endedAt?: string;
};

export type OperationImplementation = {
  id: string;
  program: PageProgram;
  authored?: AuthoredImplementation;
  conditions: string[];
  successes: number;
  failures: number;
  sourceEpisodeIds: string[];
};

export type OperationApplicability = {
  scope: "any-scene" | "scene-set" | "context";
  sceneIds?: string[];
  requiredContext?: string[];
  evidenceSceneIds: string[];
};

export type OperationDefinition = {
  id: string;
  name: string;
  description?: string;
  kind?: "navigation" | "business-transition" | "task";
  evidenceSource?: "observed-transition" | "shared-navigation" | "ai-authored" | "compiled-task" | "legacy-link";
  applicability?: OperationApplicability;
  fromSceneId: string | "*";
  toSceneId?: string;
  inputs: JsonSchema;
  outputs: JsonSchema;
  preconditions: string[];
  effects: string[];
  implementations: OperationImplementation[];
  verification: {
    sceneId?: string;
    targetIds?: string[];
    textIncludes?: string[];
    outcomeIds?: string[];
  };
  status: "candidate" | "verified" | "published";
  updatedAt: string;
};

export type NavigationStrategy =
  | { kind: "direct-entry"; operationId: string; urlTemplateId: string }
  | { kind: "shared-component"; operationId: string; evidenceSceneIds: string[] }
  | { kind: "scene-program"; operationId: string };

/**
 * A first-class, knowledge-compiled site tool. It promises arrival at one
 * Scene, never business data. Capabilities may reuse it as implementation.
 */
export type NavigationTool = {
  id: string;
  siteAgentId: string;
  intentKey: string;
  name: string;
  description: string;
  aliases: string[];
  targetSceneId: string;
  inputs: JsonSchema;
  outputs: JsonSchema;
  applicability: OperationApplicability;
  strategies: NavigationStrategy[];
  verifier: { sceneId: string };
  source: {
    kind: "knowledge-compiled" | "ai-reviewed" | "human";
    knowledgeRevision: number;
    dependencyHash: string;
    evidenceRefs: string[];
  };
  status: "candidate" | "verified" | "degraded";
  usedByCapabilityIds: string[];
  updatedAt: string;
};

export type BindingExpressionMap = Record<string, ValueExpression>;

export type CapabilityPlan = {
  id: string;
  entrySceneIds: string[];
  steps: Array<{ operationId: string; bindings: BindingExpressionMap }>;
  outputBindings: BindingExpressionMap;
};

export type OutcomeSpec = {
  id: string;
  status: OutcomeStatus;
  code: string;
  description: string;
  classifiers: Array<{ kind: "text" | "target" | "url"; value: string }>;
};

export type CapabilityOrigin = "administrator" | "ai-exploration" | "knowledge-compiled" | "user-triggered";
export type CapabilityTrigger = "administrator" | "user" | "system";
export type CapabilityGenerator = "administrator" | "ai" | "user-demonstration" | "program";

export type CapabilityImplementationAsset = {
  kind: "navigation-tool";
  id: string;
  capabilityId: string;
  name: string;
  status: NavigationTool["status"];
  targetSceneId: string;
  targetSceneName?: string;
  targetRoute?: string;
  strategyKinds: NavigationStrategy["kind"][];
  strategyCount: number;
  sourceKind: NavigationTool["source"]["kind"];
  knowledgeRevision: number;
  dependencyHash: string;
  evidenceCount: number;
  updatedAt: string;
};

export type CapabilityEvolutionAssessment = {
  decision: "create" | "strengthen" | "skip" | "suppressed";
  summary: string;
  factors: Array<{
    label: string;
    evidence: string;
  }>;
  analyzedAt: string;
  model?: string;
  sourceEpisodeId?: string;
};

export type CapabilityDefinition = {
  id: string;
  origin?: CapabilityOrigin;
  kind?: "navigation" | "task";
  resultKind?: "page" | "data" | "action";
  exposure?: "public" | "internal";
  name: string;
  /**
   * Bilingual capability names. Optional — old releases lack the field and readers fall
   * back to name.
   *
   * The capability center already stores it (Capability.localizedNames) but the release
   * projection dropped it, so the widget could only show name. The proposal path sets
   * name to the **English** name, so Chinese visitors saw English capability names —
   * the Chinese name was in the database all along, just never copied over. Not an
   * i18n feature, a missing projection field.
   */
  localizedNames?: { zhCN?: string; en?: string };
  description: string;
  normalizedGoal: string;
  goalTemplate?: string;
  aliases: string[];
  inputs: JsonSchema;
  outputs: JsonSchema;
  /** Immutable pure-JS Stage artifact used directly by Capability Center v1. */
  module?: ProgramModuleRef;
  outcomes: OutcomeSpec[];
  plans: CapabilityPlan[];
  sourceEpisodeIds: string[];
  confidence: number;
  status: "suggested" | "learning" | "available" | "improving";
  updatedAt: string;
};

export type ParameterizationDecision = {
  id: string;
  observedValue: JsonValue;
  evidence: string;
  decision: "input" | "scene-ref" | "previous-output" | "constant" | "reject";
  inputId?: string;
  reason: string;
};

export type ExtractionProof = {
  fieldId: string;
  containerTargetId?: string;
  relativeTargetId: string;
  sampleValue: JsonValue;
  schemaType: JsonSchema["type"];
  screenshotArtifactId?: string;
  runId: string;
};

export type KnowledgeSource = "program" | "ai" | "human";

export type KnowledgeFieldEvidence = {
  source: KnowledgeSource;
  confidence: number;
  evidence: string[];
  updatedAt: string;
  pinned?: boolean;
};

export type SuggestedTaskDefinition = {
  id: string;
  name: string;
  description: string;
  goalTemplate: string;
  requiredInputs: Array<{
    id: string;
    name: string;
    type: "string" | "number" | "boolean";
    prompt: string;
  }>;
  sceneIds?: string[];
  confidence: number;
};

export type SiteProfile = {
  name: string;
  description: string;
  semanticSource?: KnowledgeSource;
  /** `crawl` when this profile was generated by the onboarding crawler. */
  origin?: "crawl" | "usage";
  /**
   * Browser Origins the runtime is authorized to act on, authorized by the
   * control-plane owner. This is execution policy, not learned website
   * knowledge: browser execution authority derives from these allowed origins
   * and Scene evidence, never from the descriptive hostname, and connection
   * snapshots, AI profile review, and discovered Scenes must never add entries
   * automatically. Normalized in `canonicalizeReleaseKnowledge`.
   */
  allowedOrigins?: string[];
  visibility?: "production" | "sandbox" | "system";
  entryUrl?: string;
  category?: string;
  audiences?: string[];
  jobsToBeDone?: string[];
  /**
   * Concrete questions a visitor can send as-is, written from the same page
   * evidence as the rest of this profile. A job describes a kind of work and
   * leaves the value blank; these carry a real one, so they can be offered as
   * the opening move on a site that has no published capability yet.
   */
  suggestedQuestions?: string[];
  /**
   * The language the fields above are written in. Set by the analysis from the locale it
   * was asked for; absent on records written before it existed, where `profileLanguage`
   * reads it from the shape instead.
   */
  language?: "zh" | "en";
  /**
   * The same site-specific sentences, written once per language the console and
   * the widget can render.
   *
   * A site's own words are not translatable at render time the way a button
   * label is: they are written from that site's pages. Producing only one
   * language meant a reader of the other got the generic assistant instead of
   * this site's, and — when the model followed the page rather than the prompt
   * — a sentence half in each. The product name is a proper noun and stays out.
   */
  localized?: Partial<Record<"zh" | "en", {
    description: string;
    jobsToBeDone: string[];
    suggestedQuestions: string[];
  }>>;
  entityTypes?: Array<{ name: string; description: string; examples: string[] }>;
  businessDomains?: Array<{ name: string; description: string }>;
  vocabulary: Record<string, string[]>;
  taskTemplates?: SuggestedTaskDefinition[];
  suggestedGoals: string[];
  fieldEvidence?: Record<string, KnowledgeFieldEvidence>;
  semanticReview?: {
    status: "pending" | "reviewed" | "failed";
    evidenceHash: string;
    model?: string;
    attemptedAt: string;
    reviewedAt?: string;
  };
};

export type AgentConfig = {
  /**
   * The language the server generated brand/copy in.
   *
   * The widget renders in the visitor's language, but the generated sentences are
   * **site-specific** ("What do you want to do on the Weibo charts?"). The server copy
   * is used only when the visitor's language matches this field — personalized and in
   * the right language; otherwise the widget falls back to its built-in dictionary.
   * Without this field the widget would have to hard-code "generated copy is Chinese",
   * an assumption that silently breaks the day the generator supports a second language.
   */
  generatedLocale?: "zh" | "en";
  /**
   * The generated sentences, one set per language, so a reader of either gets
   * this site's words rather than the built-in ones. `generatedLocale` above
   * remains for records written before there was more than one language.
   */
  generated?: Partial<Record<"zh" | "en", {
    displayName: string;
    launcherLabel: string;
    welcomeTitle: string;
    welcomeDescription: string;
    suggestions: string[];
  }>>;
  appearance?: {
    preset: "orb" | "dock" | "minimal";
    surface?: "clean" | "soft" | "contrast";
    palette: "mint" | "violet" | "blue" | "coral" | "ink";
    launcherPosition: "bottom-right" | "bottom-left";
  };
  overrides?: {
    displayName?: string;
    welcomeTitle?: string;
    welcomeDescription?: string;
    pinnedSuggestions?: string[];
  };
  brand: {
    displayName: string;
    launcherLabel: string;
    avatarText: string;
  };
  theme: {
    accentColor: string;
    accentTextColor: string;
    panelBackground: string;
    launcherPosition: "bottom-right" | "bottom-left";
  };
  copy: {
    welcomeTitle: string;
    welcomeDescription: string;
    composerPlaceholder: string;
    poweredByText: string;
  };
  features: {
    showSuggestions: boolean;
    showTeachAfterFailure: boolean;
    showNewChat: boolean;
    /** The widget no longer shows the knowledge version; kept only for stored configs, has no effect. */
    showKnowledgeVersion: boolean;
  };
  suggestions: string[];
};

export type AgentConfigPatch = Partial<AgentConfig> & { reset?: boolean };

export type EvalSummary = {
  passed: boolean;
  evaluatedEpisodes: number;
  successfulEpisodes: number;
  failedEpisodes: number;
  generatedAt: string;
};

export type SiteAgentRuntimeFeatures = {
  pageAgentRuntimeV2: boolean;
  pageAgentEvidenceV2: boolean;
  capabilityExperienceOutbox: boolean;
};

export type SiteAgentReleaseV2 = {
  schemaVersion: typeof SITE_AGENT_SCHEMA_VERSION;
  id: string;
  siteAgentId: string;
  /** RuntimeRelease version — grows on EVERY publish (config, capability, material). */
  version: number;
  /**
   * The KnowledgeRevision this release's scenes/links come from. Independent of
   * `version`: it advances only on a *material* knowledge change, so a config- or
   * capability-only publish (new `version`) references the SAME revision. Resolve
   * via `knowledgeRevisionOf` (falls back to the legacy pointer / version).
   */
  knowledgeRevision?: number;
  createdAt: string;
  contentHash: string;
  profile: SiteProfile;
  agentConfig: AgentConfig;
  /** URL classes judged "data pages" across instances: instance bodies are not indexed, only this description is kept. */
  dataPageTypes?: Array<{ urlPattern: string; name: string; description: string; instanceCount: number }>;
  scenes: SceneDefinition[];
  linkReferences?: LinkReference[];
  targets: TargetSpec[];
  operations: OperationDefinition[];
  navigationTools?: NavigationTool[];
  capabilities: CapabilityDefinition[];
  outcomes: OutcomeSpec[];
  evalSummary: EvalSummary;
  sourceEpisodeIds: string[];
  /**
   * Runtime-only rollout controls injected by the public Release endpoint.
   * They are deliberately excluded from the persisted knowledge content hash.
   */
  runtimeFeatures?: SiteAgentRuntimeFeatures;
};

export type EvidenceStatus = NonNullable<SceneDefinition["evidenceStatus"]>;

/**
 * Ordered weakest→strongest. `crawled` sits above `referenced` (the page was
 * actually fetched, so it certainly exists) but below `observed` (nobody has
 * really used it yet). The crawl-vs-usage merge relies on this ordering.
 */
export const EVIDENCE_RANK: Record<EvidenceStatus, number> = {
  referenced: 0,
  crawled: 1,
  observed: 2,
  "entry-verified": 3,
};

type LadderInput = SceneDefinition["evidenceStatus"] | SceneDefinition["lifecycle"];

function normalizeEvidenceStatus(status: LadderInput): EvidenceStatus {
  if (status === "entry-verified") return "entry-verified";
  if (status === "observed" || status === "semantic-reviewed") return "observed";
  if (status === "crawled") return "crawled";
  return "referenced";
}

/** Returns the stronger of two evidence statuses, tolerating deprecated `lifecycle` values. */
export function strongerEvidenceStatus(a: LadderInput, b: LadderInput): EvidenceStatus {
  const left = normalizeEvidenceStatus(a);
  const right = normalizeEvidenceStatus(b);
  return EVIDENCE_RANK[left] >= EVIDENCE_RANK[right] ? left : right;
}

/** Deduped union of provenance origins from any mix of arrays/singletons/undefined. */
export function mergeOrigins(
  ...groups: Array<Array<"crawl" | "usage"> | "crawl" | "usage" | undefined>
): Array<"crawl" | "usage"> | undefined {
  const set = new Set<"crawl" | "usage">();
  for (const group of groups) {
    if (!group) continue;
    if (Array.isArray(group)) for (const origin of group) set.add(origin);
    else set.add(group);
  }
  return set.size ? [...set] : undefined;
}

export type ElementEvidence = {
  tag: string;
  /** Legacy raw text, retained for replay compatibility. */
  text?: string;
  role?: string;
  accessibleName?: string;
  label?: string;
  placeholder?: string;
  name?: string;
  href?: string;
  attributes: Record<string, string>;
  contextText?: string;
  landmark?: "header" | "nav" | "main" | "aside" | "footer" | "unknown";
  cssPath?: string;
};

import type { RawBlock } from "./content-filter";

export type PageSnapshot = {
  id: string;
  sessionId: string;
  documentId: string;
  sequence: number;
  url: string;
  title: string;
  heading: string;
  visibleText: string;
  links: Array<{ text: string; url: string }>;
  elements?: ElementEvidence[];
  metadata?: {
    lang?: string;
    canonicalUrl?: string;
    applicationName?: string;
    manifestUrl?: string;
    description?: string;
    ogSiteName?: string;
    ogTitle?: string;
    ogDescription?: string;
    logoAlts?: string[];
    structuredNames?: string[];
    structuredTypes?: string[];
  };
  /**
   * Parallel output of block-level filtering (migration step 1: observe, do not switch).
   * `visibleText` is still the full page text; the upstream switch decides which one is
   * indexed. Once the switch is final this field becomes the body source.
   */
  /**
   * HTTP status of the navigation. The most general "this is not a real page" signal —
   * independent of language and site wording. Non-render sources (widget reports) lack
   * it, hence optional.
   */
  httpStatus?: number;
  contentFilter?: {
    /** Filtered body, taken verbatim from the page. */
    mainText: string;
    /** Dropped blocks with index and truncated text, for the page-level fallback verdict outside the page. */
    dropped: Array<{ id: number; text: string }>;
    /** Blocks with exactly one vote, awaiting LLM arbitration. */
    undecided: number[];
    /** Per-page filter stats, for the console and site-wide health metrics. */
    stats: Record<string, unknown>;
    /** All blocks. Arbitration fetches originals by index on the Node side; no model runs in-page. Not reported. */
    blocks: RawBlock[];
  };
  capturedAt: string;
};

/**
 * rrweb-style serialized DOM node used to rebuild the visual page during
 * replay. This is evidence, never Agent per-step observation and never part of
 * a Release. Sensitive control values are masked at capture time.
 */
export type SerializedNode = {
  /** Stable per-document node id assigned by the recorder. */
  id: number;
  type: "element" | "text" | "comment" | "document" | "doctype";
  tag?: string;
  attrs?: Record<string, string>;
  text?: string;
  children?: SerializedNode[];
  /** True when this node hosts a masked sensitive control (value redacted). */
  masked?: boolean;
};

export type DomMutationOp =
  | { t: "add"; parent: number; next: number | null; node: SerializedNode }
  | { t: "remove"; id: number }
  | { t: "attr"; id: number; attrs: Record<string, string | null> }
  | { t: "text"; id: number; value: string };

/**
 * A single replay frame. The stream begins with a `full` frame and then only
 * carries incremental changes plus low-frequency interaction signals. This is
 * the true original-DOM replay track, orthogonal to the structured action
 * evidence in ExperienceEvidenceBundle.
 */
export type DomReplayFrame = {
  seq: number;
  at: string;
  kind: "full" | "incremental" | "scroll" | "viewport" | "input" | "pointer" | "url";
  full?: SerializedNode;
  mutations?: DomMutationOp[];
  scroll?: { id: number; x: number; y: number };
  viewport?: { w: number; h: number; dpr: number };
  pointer?: { x: number; y: number; type: "move" | "down" | "up" };
  input?: { id: number; value: string; masked?: boolean };
  url?: string;
};

/**
 * Replay frames are persisted in chunks to keep individual records small.
 * Both user Episodes and authoring/validation BrowserRuns produce chunks, so
 * the same Player can replay evidence and AI coding sessions.
 */
export type DomReplayChunk = {
  id: string;
  siteAgentId: string;
  sessionId: string;
  documentId: string;
  episodeId?: string;
  runId?: string;
  origin: string;
  seqStart: number;
  seqEnd: number;
  frames: DomReplayFrame[];
  createdAt: string;
};

export type TransitionObservation = {
  id: string;
  siteAgentId: string;
  sessionId: string;
  fromScene?: SceneInstance;
  toScene?: SceneInstance;
  fromSnapshot?: PageSnapshot;
  toSnapshot?: PageSnapshot;
  steps: PageProgramStep[];
  elementEvidence: ElementEvidence[];
  inputBindings: Record<string, JsonValue>;
  outputBindings: Record<string, JsonValue>;
  outcome?: OutcomeReceipt;
  startedAt: string;
  endedAt: string;
};

export type OutcomeReceipt = {
  status: OutcomeStatus;
  code: string;
  summary: string;
  evaluatedAt: string;
  evidence: Record<string, JsonValue>;
};

/**
 * Code-owned execution policy derived from the user's request. Model output can
 * supply facts used by this decision, but it never grants write authority.
 */
export type ExecutionRequirement = {
  kind: "required" | "not-required" | "uncertain";
  effect: "read" | "reversible-write" | "irreversible-write";
  evidence: "none" | "page-action" | "business-receipt";
  reasons: string[];
};

/** Structured hand-off from the main Agent to the page executor. */
export type PageExecutionBrief = {
  objective: string;
  normalizedGoal: string;
  entities: Record<string, JsonValue>;
  effect: ExecutionRequirement["effect"];
  completionCriteria: string[];
  relevantSceneIds: string[];
  relevantCapabilityIds: string[];
  rejectedCapabilityReasons: string[];
  knowledgeReceiptRefs: string[];
};

export type PageExecutionBudget = {
  activeLimitMs: number;
  modelRequestLimit: number;
  activeElapsedMs: number;
  modelRequests: number;
  noProgressCount: number;
  /**
   * Wall-clock ceiling for the whole task. Unlike `activeLimitMs` it is not
   * suspended while the page is hidden or a model request is retried, so it is
   * the only limit that bounds what the user actually waits. The single
   * exclusion is time spent waiting for an answer the runtime explicitly asked
   * for, which is bounded by `askUserLimitMs` instead.
   *
   * Optional so Episodes recorded before this limit existed still parse.
   */
  wallLimitMs?: number;
  wallElapsedMs?: number;
  /** Ceiling on one continuous stretch of the page being in the background. */
  backgroundWaitLimitMs?: number;
  backgroundWaitMs?: number;
  /** Ceiling on one wait for a user answer. Excluded from the wall clock. */
  askUserLimitMs?: number;
  askUserWaitMs?: number;
  exhaustedReason?:
    | "active-time"
    | "model-requests"
    | "no-progress"
    | "wall-clock"
    | "background-wait"
    | "page-handoff"
    | "user-unanswered";
};

export type StableTargetRef = {
  observationId: string;
  index: number;
  semanticId: string;
  role?: string;
  accessibleName?: string;
  controlType?: string;
  formSignature?: string;
  hrefPath?: string;
  nearbyText?: string;
};

export type PageObservationRef = {
  id: string;
  /** Present in V2 producers; optional keeps already-released SDKs readable. */
  pageEpoch?: number;
  documentId?: string;
  turnIndex: number;
  kind: "full" | "delta";
  sha256: string;
};

/** Exact, sanitized BrowserState delivered to the PageAgent model. */
export type PageAgentObservation = {
  schemaVersion: "page-agent-observation.v1";
  id: string;
  siteAgentId: string;
  runId: string;
  episodeId: string;
  browserSessionId: string;
  documentId: string;
  pageEpoch: number;
  turnIndex: number;
  kind: "full" | "delta";
  baseObservationId?: string;
  state: {
    url: string;
    title: string;
    header: string;
    content: string;
    footer: string;
  };
  targets: StableTargetRef[];
  sha256: string;
  producer: {
    controller: "@page-agent/page-controller";
    controllerVersion: string;
    projection: "user-agent-adaptive";
    projectionVersion: number;
  };
  capturedAt: string;
  expiresAt: string;
  omissionReason?: string;
};

export type ActionReceiptV2 = {
  id: string;
  turnIndex: number;
  action: "click" | "set-text" | "insert-text" | "select" | "submit" | "press" | "focus" | "scroll" | "wait";
  target?: StableTargetRef;
  input: Record<string, JsonValue>;
  beforeObservationId: string;
  afterObservationId?: string;
  dispatched: boolean;
  effect: "changed" | "unchanged" | "unknown";
  effectSignals: Record<string, JsonValue>;
  startedAt: string;
  endedAt: string;
};

export type PageRuntimeMetric = {
  turnIndex: number;
  stage: "turn_before_hook" | "human_boundary" | "observe_raw" | "observe_project" | "evidence_enqueue" | "model_wait" | "action_execute" | "effect_settle" | "checkpoint" | "page_handoff";
  startedAt: string;
  durationMs: number;
  detail?: Record<string, JsonValue>;
};

export type ExperienceActionEvidence = {
  id: string;
  action: "click" | "fill" | "select" | "scroll" | "wait" | "unknown";
  rawAction: string;
  input: Record<string, JsonValue>;
  element?: ElementEvidence;
  page: Pick<PageSnapshot, "url" | "title" | "heading">;
  observedAt: string;
};

/**
 * An address the run entered, and the values bound into it.
 *
 * Going to an address is not an action — nothing on the page was operated.
 * It is the ground the run stood on, and on a site whose answers live at
 * parameterized routes it is the entire method: the reusable capability is
 * that route with its parameters. Kept apart from the action list so it is
 * never replayed as a step, and so a run that only went somewhere still
 * arrives at the capability centre with the one fact that matters.
 */
export type ExperienceRouteEvidence = {
  url: string;
  sceneId?: string;
  bindings: Record<string, JsonValue>;
  observedAt: string;
};

/**
 * The action kinds that count as having operated the page.
 *
 * One definition: the runtime records these and the capability centre admits
 * them. A kind listed on one side and unwritten on the other is a rule that
 * can never fire — scrolling was exactly that, and a run that reached its
 * goal by scrolling was treated as if it had never touched the page.
 * Waiting is not operating: it is deliberately not here.
 */
export const EXPERIENCE_PAGE_ACTIONS: ReadonlyArray<ExperienceActionEvidence["action"]> = ["click", "fill", "select", "scroll"];

export type ExperienceEvidenceBundle = {
  version: 1;
  actions: ExperienceActionEvidence[];
  /** Addresses this run entered. Evidence in its own right, not steps. */
  routes?: ExperienceRouteEvidence[];
  actorSummary: string;
  judgeEvidence: string[];
  /** V2 evidence is additive so old Episodes and SDKs remain readable. */
  actionReceiptsV2?: ActionReceiptV2[];
  observationRefs?: PageObservationRef[];
  budgetEvidence?: PageExecutionBudget;
  runtimeMetrics?: PageRuntimeMetric[];
  /** Tools used by the user-facing Agent. These are receipts, not new knowledge by themselves. */
  toolReceipts?: Array<{
    kind: "knowledge" | "capability" | "page" | "human";
    name: string;
    status: "completed" | "failed";
    summary: string;
    capabilityId?: string;
    output?: Record<string, JsonValue>;
    observedAt: string;
  }>;
};

export type KnowledgeCandidate = {
  id: string;
  siteAgentId: string;
  normalizedGoal: string;
  baseReleaseVersion: number;
  scenes: SceneDefinition[];
  targets: TargetSpec[];
  operations: OperationDefinition[];
  capability: CapabilityDefinition;
  validation: {
    status: "pending" | "validating" | "passed" | "failed";
    attempts: number;
    successfulReplays: number;
    requiredReplays: number;
  };
  authoring?: {
    stage: "evidence" | "designed" | "authored";
    reusableTrace: boolean;
    intentKey?: string;
    parameterizationDecisions?: ParameterizationDecision[];
    capabilityKind?: "navigation" | "task";
    reason?: string;
    reuseDecision?: "create-capability" | "strengthen-capability" | "conversation-only" | "do-not-persist" | "navigation-tool" | "suppressed";
    reuseReason?: string;
    goalTemplate?: string;
    requiredInputs?: Array<{ id: string; name: string; type: "string" | "number" | "boolean"; value?: JsonValue; examples?: JsonValue[] }>;
    resultFields?: Array<{
      id: string;
      name: string;
      type: "string" | "number" | "boolean" | "object" | "array";
      description?: string;
      source: "page-url" | "page-title" | "page-heading" | "input" | "extracted";
      inputId?: string;
      /** Core fields are part of the release promise; optional fields may be enhanced later. */
      importance?: "core" | "optional" | "metadata";
    }>;
    /** The result-page shape guides extraction authoring; it is not demo-specific. */
    resultArchetype?: "navigation" | "search" | "list" | "ranking" | "detail" | "action" | "analysis";
    selectedImplementationId?: string;
    alternatives?: Array<{ id: string; kind: "page-program" | "module"; label: string; rationale: string; selected: boolean }>;
    iterations?: AuthoringIteration[];
    evolutionAssessment?: CapabilityEvolutionAssessment;
  };
  sourceEpisodeIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type CapabilityProjectStatus = "building" | "awaiting-review" | "available" | "duplicate" | "needs-guidance" | "degraded" | "unpublished" | "archived";
export type CapabilityProductionStage = "experience" | "design" | "author" | "validate" | "publish";

export type CapabilitySignal = {
  id: string;
  siteAgentId: string;
  intentBucket: string;
  kind: "new-gap" | "enhancement" | "runtime-regression" | "bad-case";
  status: "pending" | "processing" | "completed" | "failed" | "superseded";
  episodeIds: string[];
  capabilityId?: string;
  missingOutputs?: string[];
  evidenceRefs: string[];
  attempts?: number;
  nextAttemptAt?: string;
  lastError?: {
    code: string;
    summary: string;
    /** Safe provider diagnostics only; response bodies and prompts are never persisted. */
    httpStatus?: number;
    finishReason?: string;
    parseError?: string;
    errorCode?: string;
    attempt?: number;
  };
  resolution?: {
    disposition: "duplicate" | "new" | "improvement" | "repair" | "rejected";
    /** Existing Capability that satisfied a duplicate signal without a Proposal. */
    duplicateCapabilityId?: string;
    proposalId?: string;
    taskId?: string;
    summary?: string;
  };
  createdAt: string;
  updatedAt: string;
};

/**
 * A capability requirement document. This is the human-readable primary
 * output of the design stage; the machine-readable `projected` schema is a
 * hint the AI author may tighten during authoring, not a hard up-front
 * contract. It deliberately favours natural-language intent + acceptance
 * scenarios + explicit non-goals over IDL-like constraints.
 */
export type CapabilitySpecScenario = {
  id: string;
  title: string;
  given: string;
  when: string;
  then: string;
  sampleInput?: Record<string, JsonValue>;
  expectedOutcome?: OutcomeStatus;
};

export type CapabilitySpecDoc = {
  id: string;
  siteAgentId: string;
  projectId: string;
  revisionId: string;
  version: number;
  intent: string;
  whenToUse: string;
  inputsNarrative: string;
  resultNarrative: string;
  scenarios: CapabilitySpecScenario[];
  nonGoals: string[];
  openQuestions: string[];
  projected?: {
    inputs?: JsonSchema;
    resultFields?: Array<{
      id: string;
      name: string;
      type: "string" | "number" | "boolean" | "object" | "array";
      description?: string;
      source: "page-url" | "page-title" | "page-heading" | "input" | "extracted";
      importance: "core" | "optional" | "metadata";
    }>;
    intentKey?: string;
    reuseDecision?: "create" | "strengthen" | "conversation-only" | "navigation-tool";
  };
  source: "program" | "ai" | "human";
  createdAt: string;
  updatedAt: string;
};

export type CapabilityRFC = {
  id: string;
  siteAgentId: string;
  version: number;
  decision: "reuse" | "enhance" | "create" | "merge" | "split" | "conversation-only";
  intentKey: string;
  goalTemplate: string;
  inputs: JsonSchema;
  requiredOutputs: JsonSchema;
  optionalOutputs: JsonSchema;
  legalOutcomes: Array<{ status: OutcomeStatus; description: string }>;
  parameterization: ParameterizationDecision[];
  reusedAssets: Array<{ kind: "capability" | "operation" | "scene" | "target"; id: string; reason: string }>;
  acceptanceCases: Array<{ id: string; name: string; input: Record<string, JsonValue>; expectedOutcome: OutcomeStatus; startSceneId?: string }>;
  implementationStrategy: "existing-assets" | "direct-entry" | "codex-authoring";
  evidenceRefs: string[];
  rationale: string;
  createdAt: string;
};

export type ContractChangeProposal = {
  id: string;
  rfcId: string;
  kind: "optional-output" | "required-output" | "input" | "intent" | "result-kind" | "merge" | "split";
  status: "proposed" | "accepted" | "rejected" | "architect-review";
  summary: string;
  patch: Record<string, JsonValue>;
  extractionProofIds: string[];
  createdAt: string;
};

export type CodexAuthoringEvent = {
  id: string;
  sessionId: string;
  sequence: number;
  phase: "preparing" | "observing" | "exploring" | "coding" | "running" | "testing" | "proposing" | "completed" | "failed";
  message: string;
  artifactIds?: string[];
  tokenUsage?: { input: number; output: number; cached?: number };
  createdAt: string;
};
export type ExecutionMode = "run" | "debug";
export type ExecutionEnvironment =
  | { kind: "connected-browser" }
  | { kind: "cloud-browser" }
  | { kind: "managed-profile"; profileId: string };
export type ExecutionSupport = "supported" | "unverified" | "blocked";
export type ExecutionRequirements = {
  authentication: "none" | "required" | "unknown";
  supportedEnvironments: {
    connectedBrowser: ExecutionSupport;
    cloudBrowser: ExecutionSupport;
    managedProfile: ExecutionSupport;
  };
  checkpoints: Array<"login" | "captcha" | "payment" | "confirmation">;
  evidenceRefs: string[];
};
export type CapabilityFailureClass =
  | "contract-incomplete"
  | "target-grounding-failed"
  | "extractor-mismatch"
  | "verifier-mismatch"
  | "transient-runtime"
  | "duplicate-or-superseded"
  | "runtime-regression"
  | "insufficient-evidence";

export type CapabilityRevision = {
  id: string;
  projectId: string;
  siteAgentId: string;
  number: number;
  status: "building" | "awaiting-review" | "published" | "failed" | "superseded";
  stage: CapabilityProductionStage;
  /**
   * Explains why a published Revision may be executed.
   *
   * `legacy-release-import` is reserved for immutable Capabilities that were
   * already published before the Revision review gate existed. It preserves
   * their execution eligibility without fabricating validation or review
   * evidence.
   */
  publicationProvenance?: "human-reviewed" | "legacy-release-import";
  baseReleaseVersion: number;
  /** Release graph against which the mutable implementation was authored. */
  implementationReleaseId?: string;
  implementationReleaseVersion?: number;
  /** Immutable Release that was approved together with this published Revision. */
  publishedReleaseId?: string;
  publishedReleaseVersion?: number;
  candidateId?: string;
  learningJobId?: string;
  /**
   * Legacy snapshot retained only so historical Revision JSON remains
   * readable. New Revisions reference the immutable contract owned by their
   * Capability root and must not persist another copy here.
   */
  contract?: CapabilityDefinition;
  parameterizationDecisions: ParameterizationDecision[];
  implementation?: CapabilityRevisionImplementation;
  verifier?: CompletionVerifier;
  validation?: {
    status: "pending" | "running" | "passed" | "failed";
    input?: Record<string, JsonValue>;
    runId?: string;
    /** Independently validated execution entry point owned by this Revision. */
    startUrl?: string;
    /** Hash of the exact Candidate content accepted by the independent validator. */
    validatedContentHash?: string;
    failureClass?: CapabilityFailureClass;
    summary?: string;
  };
  guidanceIds: string[];
  createdAt: string;
  updatedAt: string;
};

/**
 * An immutable human decision for one independently validated Candidate.
 *
 * A Revision can be rejected, re-authored in place, and validated again. The
 * validation run and content hash therefore form part of the review identity;
 * an older rejection must never approve or block a later implementation.
 */
export type RevisionReview = {
  id: string;
  siteAgentId: string;
  projectId: string;
  revisionId: string;
  validationRunId: string;
  validatedContentHash: string;
  status: "awaiting-review" | "approved" | "rejected";
  reviewer: "administrator" | "release-gate";
  feedback?: string;
  createdAt: string;
};

export type CapabilityEvent = {
  id: string;
  siteAgentId: string;
  projectId: string;
  revisionId?: string;
  type: "experience" | "design" | "author" | "validate" | "publish" | "guidance" | "runtime" | "archive" | "migration";
  actor: "user" | "program" | "ai" | "browser-runner" | "release-gate";
  status: "info" | "running" | "passed" | "failed" | "superseded";
  title: string;
  summary: string;
  evidence?: Record<string, JsonValue>;
  artifactIds?: string[];
  createdAt: string;
};

export type AuthoringGuidance = {
  id: string;
  siteAgentId: string;
  projectId: string;
  revisionId: string;
  text: string;
  createdAt: string;
};

export type CapabilityProject = {
  id: string;
  siteAgentId: string;
  /** Stable semantic identity. Generated implementation ids are deliberately excluded. */
  stableKey?: string;
  /** Immutable structural fingerprint of the public input/output contract. */
  contractFingerprint?: string;
  /**
   * A legacy migration conflict is isolated instead of merged. The original
   * canonical identity remains auditable while the storage key is made unique
   * and the root waits for explicit human resolution.
   */
  identityConflict?: {
    canonicalStableKey: string;
    canonicalContractFingerprint: string;
    conflictingProjectIds: string[];
  };
  intentKey: string;
  name: string;
  description: string;
  goalTemplate: string;
  /** The first human-visible request that started this project. */
  requestedGoal?: string;
  /** Terminal receipt created when a build request exactly matches an existing capability. */
  duplicateOf?: {
    projectId?: string;
    capabilityId?: string;
    name?: string;
    kind?: "task" | "navigation";
  };
  origin: CapabilityOrigin;
  /** Who caused capability production to start. Kept separate from how it was built. */
  triggeredBy?: CapabilityTrigger;
  /** Who or what produced the executable implementation. */
  generatedBy?: CapabilityGenerator;
  evolutionAssessment?: CapabilityEvolutionAssessment;
  autoGenerationBlocked?: boolean;
  unpublishedAt?: string;
  status: CapabilityProjectStatus;
  /** Exact operational state hidden by a reversible archive overlay. */
  archivedFromStatus?: Exclude<CapabilityProjectStatus, "archived">;
  stage: CapabilityProductionStage;
  /** What the capability accomplishes. Independent from who may call it. */
  kind: "navigation" | "task";
  /** Target-model classification retained alongside the legacy kind during migration. */
  structure?: "atomic" | "composite";
  /** Atomic effect classification. Navigation is a non-mutating read operation. */
  operation?: "read" | "write";
  /** Runtime visibility policy. Independent from capability kind. */
  exposure: "public" | "internal";
  resultKind: "page" | "data" | "action";
  /** Stable runtime identity retained even while the capability is unpublished. */
  canonicalCapabilityId?: string;
  activeCapabilityId?: string;
  activeRevisionId?: string;
  latestRevisionId?: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  /**
   * Legacy projection field. New Capability roots never persist
   * implementation assets; pinned NavigationTool dependencies live only in
   * `CapabilityRevision.implementation`.
   */
  implementationAssets?: CapabilityImplementationAsset[];
  executionRequirements: ExecutionRequirements;
  health: {
    lastValidatedAt?: string;
    lastRunAt?: string;
    recentRuns: number;
    recentSuccesses: number;
    successRate?: number;
    failureClass?: CapabilityFailureClass;
    recommendedAction?: "guide" | "patch-contract" | "re-explore" | "request-demonstration" | "retry-validation" | "inspect";
    enhancementRecommended?: boolean;
  };
  revisionCount: number;
  /** When the first production job actually started. Absent for release-only projections. */
  buildStartedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CapabilitySuppression = {
  id: string;
  siteAgentId: string;
  projectId?: string;
  sourceCapabilityId?: string;
  intentKey: string;
  intentFingerprint: string;
  name: string;
  goalTemplate: string;
  aliases: string[];
  normalizedPatterns: string[];
  reason: string;
  createdBy: "administrator";
  scope: "auto-generation";
  status: "active" | "revoked";
  policyVersion: 1;
  createdAt: string;
  revokedAt?: string;
};

export type CapabilityProjectDeletionHistoryKind =
  | "revisions"
  | "reviews"
  | "events"
  | "capabilityRuns"
  | "taskLaunches"
  | "learningJobs"
  | "candidates"
  | "validationJobs"
  | "browserRuns"
  | "artifacts"
  | "domReplayChunks"
  | "modelInvocations"
  | "authoringEvents"
  | "specDocs"
  | "authoringWorkspaces"
  | "authoringGuidance"
  | "suppressions"
  | "rfcs"
  | "contractProposals";

export type CapabilityProjectDeletionBlocker =
  | "activeCapability"
  | "activeRevision"
  | "publishedLifecycle"
  | "revisionPointer"
  | "buildHistory"
  | "duplicateReceipt"
  | "identityConflict"
  | CapabilityProjectDeletionHistoryKind;

/**
 * Server-authoritative hard-delete facts.
 *
 * Hard delete is intentionally limited to a completely empty Capability root.
 * Every production/history/evidence record makes the project archival instead.
 * Clients must use `allowed`; detail list truncation is not a deletion policy.
 */
export type CapabilityProjectDeletion = {
  allowed: boolean;
  blockers: CapabilityProjectDeletionBlocker[];
  counts: Record<CapabilityProjectDeletionHistoryKind, number>;
};

export type CapabilityProjectDetail = {
  project: CapabilityProject;
  deletion: CapabilityProjectDeletion;
  revisions: CapabilityRevision[];
  activeRevision?: CapabilityRevision;
  workingRevision?: CapabilityRevision;
  /** Immutable review requests and decisions, newest first. */
  reviews?: RevisionReview[];
  events: CapabilityEvent[];
  /** Durable business/debug executions pinned to one published Revision. */
  capabilityRuns?: CapabilityRun[];
  browserRuns: BrowserRun[];
  artifacts: BrowserArtifact[];
  activeJob?: LearningJob;
  /** Position in the per-control-plane capability production FIFO. */
  pipeline?: {
    state: "active" | "queued" | "terminal";
    position: number;
    total: number;
    ahead?: { jobId: string; goalTemplate?: string; phase: LearningJob["phase"] };
  };
  validationJobs?: ValidationJob[];
  modelCalls?: ModelInvocation[];
  rfc?: CapabilityRFC;
  specDoc?: CapabilitySpecDoc;
  contractProposals?: ContractChangeProposal[];
  authoringEvents?: CodexAuthoringEvent[];
  /** Persisted authoring workspace snapshots (VFS the coding agent wrote), newest first. Evidence only. */
  authoringWorkspaces?: PersistedAuthoringWorkspace[];
  /** Raw successful episodes referenced by the selected Revision. */
  sourceEpisodes?: TaskEpisode[];
  /** Original-DOM replay chunks for the referenced episodes/runs (evidence only, never part of a Release). */
  domReplayChunks?: DomReplayChunk[];
};

export type ModelInvocationStage = "profile" | "scene-review" | "capability-design" | "author-plan" | "author-program" | "outcome-judge" | "effect-analysis" | "effect-review" | "runtime-agent" | "runtime-router" | "runtime-page-agent" | "runtime-boundary" | "input-binding" | "human-boundary";
export type ModelInvocation = {
  id: string;
  siteAgentId: string;
  learningJobId?: string;
  stage: ModelInvocationStage;
  model: string;
  status: "running" | "succeeded" | "failed";
  promptTokens?: number;
  completionTokens?: number;
  cachedPromptTokens?: number;
  totalTokens?: number;
  usageExact: boolean;
  durationMs?: number;
  errorCode?: string;
  httpStatus?: number;
  finishReason?: string;
  parseError?: string;
  /**
   * Bounded, redacted excerpt of the provider's error response.
   *
   * A status code alone cannot tell "this model rejects our request shape" from
   * "this account is out of quota" — a production burst of identical HTTP 400s
   * was undiagnosable for exactly this reason.
   */
  errorDetail?: string;
  attempt?: number;
  startedAt: string;
  endedAt?: string;
};

export type HumanCheckpointKind = "authentication" | "captcha" | "mfa" | "consent" | "confirmation" | "payment";
export type HumanCheckpoint = {
  id: string;
  kind: HumanCheckpointKind;
  reason: string;
  source: "runtime" | "agent" | "known-boundary";
  confidence: number;
  evidenceRefs: string[];
  createdAt: string;
  resolvedAt?: string;
};

export type TaskLaunchMode = "run" | "demonstrate";
export type TaskLaunchStatus = "pending" | "claimed" | "running" | "completed" | "failed" | "expired" | "cancelled";
export type CapabilityBuildTask = {
  id: string;
  siteAgentId: string;
  intentKey: string;
  classification: "navigation" | "business";
  assetKind: "navigation-tool" | "capability-build-request";
  goal: string;
  status: TaskLaunchStatus;
  phase?: LearningJob["phase"];
  latestLaunchId: string;
  latestLearningJobId?: string;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  completedAt?: string;
  result?: {
    outcome?: OutcomeReceipt;
    output?: Record<string, JsonValue>;
    url?: string;
  };
  error?: { code: string; summary: string };
  duplicateOf?: {
    projectId: string;
    capabilityId?: string;
    name: string;
  };
};
export type CapabilityBuildTaskPage = {
  hasMoreDuplicates: boolean;
  nextDuplicateCursor?: string;
};
export type TaskLaunch = {
  id: string;
  siteAgentId: string;
  purpose?: "navigation-evidence";
  intentKey?: string;
  /** Monotonic creation order used when multiple attempts share a timestamp. */
  attemptSequence?: number;
  projectId?: string;
  capabilityId?: string;
  goal: string;
  input: Record<string, JsonValue>;
  mode: TaskLaunchMode;
  executionMode?: ExecutionMode;
  capabilityRunId?: string;
  /** Immutable execution graph selected for a CapabilityRun-backed launch. */
  releaseId?: string;
  releaseVersion?: number;
  /** Capability Center Version selected for a new Run-backed launch. */
  capabilityVersionId?: string;
  /** Published Revision whose implementation was verified against releaseId. */
  revisionId?: string;
  /** Exact trusted page on which that Revision was independently validated. */
  startUrl?: string;
  allowedOrigin: string;
  status: TaskLaunchStatus;
  /** Current browser document that exclusively owns execution. */
  executionOwnerId?: string;
  /** Monotonic fence advanced whenever a navigation hands ownership over. */
  executionFence?: number;
  taskSessionId?: string;
  outcome?: OutcomeReceipt;
  output?: Record<string, JsonValue>;
  resultUrl?: string;
  error?: { code: string; summary: string };
  /** Server-side idempotency receipt for the accepted terminal callback. */
  terminalRequestHash?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  claimedAt?: string;
  completedAt?: string;
};

export type CapabilityRunStatus = "queued" | "waiting-for-browser" | "running" | "completed" | "failed" | "expired" | "cancelled";
export type LegacyRunnerLeaseRef = {
  runnerId: string;
  token: string;
  leasedAt: string;
  expiresAt: string;
  leaseId?: string;
  fence?: number;
  runnerSessionId?: string;
};
export type CapabilityRunTimings = {
  queuedMs?: number;
  environmentSetupMs?: number;
  executionMs?: number;
  modelMs?: number;
  totalMs?: number;
};
export type CapabilityRun = {
  id: string;
  siteAgentId: string;
  projectId?: string;
  capabilityId: string;
  capabilityName: string;
  mode: ExecutionMode;
  environment: ExecutionEnvironment;
  /** Immutable Release selected when the Run is created. Legacy rows may omit it. */
  releaseId?: string;
  releaseVersion?: number;
  /** Immutable Capability Center Version selected when a new Run is created. */
  capabilityVersionId?: string;
  /** Published Revision selected when the Run is created. */
  revisionId?: string;
  /** Revision-scoped, independently validated page snapshotted for this Run. */
  startUrl?: string;
  status: CapabilityRunStatus;
  input: Record<string, JsonValue>;
  output?: Record<string, JsonValue>;
  outcome?: OutcomeReceipt;
  resultUrl?: string;
  taskLaunchId?: string;
  runnerId?: string;
  lease?: LegacyRunnerLeaseRef;
  steps: BrowserStepReceipt[];
  progress?: BrowserRun["progress"];
  artifactIds: string[];
  timings: CapabilityRunTimings;
  error?: { code: string; summary: string };
  /** Exact normalized runner completion accepted for this immutable Run. */
  completionReceipt?: {
    runnerId: string;
    payloadHash: string;
    browserRunId?: string;
  };
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type LearningStage = "evidence" | "design" | "author" | "validate" | "publish";

export type LearningStageReceipt = {
  id: string;
  stage: LearningStage;
  actor: "user" | "program" | "ai" | "browser-runner" | "release-gate";
  status: "queued" | "running" | "passed" | "failed" | "skipped";
  title: string;
  summary: string;
  startedAt: string;
  endedAt?: string;
  evidence?: Record<string, JsonValue>;
  artifactIds?: string[];
};

/**
 * A successful user episode is evidence for capability authoring, not an
 * executable contract by itself. Learning jobs are consumed by an isolated
 * browser authoring/validation environment and must never run in the user's
 * active page or TaskSession.
 */
export type LearningJob = {
  id: string;
  siteAgentId: string;
  taskSessionId: string;
  sourceEpisodeId: string;
  candidateId: string;
  origin?: CapabilityOrigin;
  phase: "design" | "author" | "validate" | "publish";
  status: "queued" | "leased" | "running" | "awaiting-review" | "completed" | "failed" | "cancelled";
  attempts: number;
  intentKey?: string;
  goalTemplate?: string;
  receipts: LearningStageReceipt[];
  lease?: LegacyRunnerLeaseRef;
  latestRunId?: string;
  /** Human rejection feedback carried explicitly into every author retry. */
  reviewFeedback?: { reviewId: string; text: string };
  failure?: { code: string; summary: string };
  result: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
};

export type ValidationCase = {
  id: string;
  name: string;
  input: Record<string, JsonValue>;
  inputSource: "observed" | "derived-from-evidence" | "human";
  startUrl: string;
  expectedStatuses: OutcomeStatus[];
  effect: "read-only" | "reversible" | "side-effect";
};

export type ValidationJob = {
  id: string;
  learningJobId: string;
  siteAgentId: string;
  candidateId: string;
  capabilityId: string;
  baseReleaseVersion: number;
  status: "queued" | "leased" | "running" | "passed" | "failed" | "cancelled";
  validationCase: ValidationCase;
  attempt: number;
  maxAttempts: number;
  lease?: LegacyRunnerLeaseRef;
  latestRunId?: string;
  invalidatedAt?: string;
  invalidatedByReviewId?: string;
  invalidatedReason?: string;
  failure?: { code: string; summary: string };
  createdAt: string;
  updatedAt: string;
};

export type BrowserArtifact = {
  id: string;
  siteAgentId: string;
  learningJobId: string;
  runId: string;
  kind: "video" | "screenshot" | "trace" | "dom" | "console";
  ownerKind?: "learning-job" | "preview-job";
  role?: "before-screenshot" | "after-screenshot" | "keyframe" | "validation-video" | "trace" | "diagnostic" | "site-preview";
  label: string;
  contentType: string;
  size: number;
  url: string;
  createdAt: string;
};

export type BrowserStepReceipt = {
  stepId: string;
  op: PageProgramStep["op"] | "adaptive";
  label?: string;
  status: "passed" | "failed" | "skipped";
  startedAt: string;
  endedAt: string;
  evidence?: Record<string, JsonValue>;
  error?: { code: string; message: string };
};

export type BrowserRun = {
  id: string;
  learningJobId: string;
  validationJobId?: string;
  siteAgentId: string;
  candidateId: string;
  runnerId: string;
  mode: "author" | "validate" | "execute" | "debug";
  status: "running" | "passed" | "failed";
  browser: { name: string; version: string; headless: boolean };
  startedAt: string;
  endedAt?: string;
  startUrl: string;
  endUrl?: string;
  progress?: { stage: "observing" | "planning" | "authoring" | "executing" | "judging" | "validating" | "recording" | "complete"; message: string; current?: number; total?: number; updatedAt: string };
  steps: BrowserStepReceipt[];
  outcome?: OutcomeReceipt;
  artifactIds?: string[];
};

export type RunnerRegistration = {
  id: string;
  name: string;
  status: "online" | "offline" | "busy";
  poolId?: "default";
  sessionId?: string;
  generation?: number;
  desiredState?: "active" | "draining";
  observedState?: RunnerObservedState;
  role?: RunnerRole;
  workKinds?: RunnerWorkKind[];
  version?: string;
  capabilities: { browsers: string[]; maxConcurrency: number; recording: boolean; prewarmCapacity?: number; readySlots?: number };
  lastHeartbeatAt: string;
  createdAt: string;
  activity?: {
    stage?: string;
    phase?: string;
    message?: string;
    learningJobId?: string;
    artifactIds?: string[];
    tokenUsage?: { input: number; output: number; cached?: number };
  };
  lastError?: RunnerLastError;
};

export type AuthoringLease = {
  kind: "author";
  job: LearningJob;
  candidate: KnowledgeCandidate;
  episode: TaskEpisode;
  release: SiteAgentReleaseV2;
  /** Latest capability requirement document for the project, if one exists. */
  specDoc?: CapabilitySpecDoc;
  /** Latest human rejection feedback. Older runners also receive it in candidate.authoring.reason. */
  reviewFeedback?: { reviewId: string; text: string };
};

export type ValidationLease = {
  kind: "validate";
  job: ValidationJob;
  learningJob: LearningJob;
  candidate: KnowledgeCandidate;
  release: SiteAgentReleaseV2;
  /** Exact mutable Working Revision whose implementation is being proven. */
  revision: CapabilityRevision;
};

export type CapabilityExecutionLease = {
  kind: "execute";
  job: CapabilityRun;
  capability: CapabilityDefinition;
  release: SiteAgentReleaseV2;
  /** Exact immutable published Revision for historical Runs. New Runs pin capabilityVersionId. */
  revision?: CapabilityRevision;
};

export type CrawlJobLimits = {
  maxRenders?: number;
  maxPerTemplate?: number;
  adaptiveStopAfter?: number;
  maxDepth?: number;
};

/** Onboarding crawl job: proactively spiders a site into a base-layer knowledge document. */
export type CrawlJob = {
  id: string;
  siteAgentId: string;
  status: "queued" | "leased" | "running" | "succeeded" | "failed";
  /** Site origin URL to crawl. */
  origin: string;
  /** Extra seed URLs beyond the entry + sitemap. */
  seeds: string[];
  limits?: CrawlJobLimits;
  /**
   * Who scheduled it: `auto` is the one the server schedules on first connection,
   * `manual` is the console's "read now". Only for logs and UI; execution, limits and
   * completion are identical. Old jobs lack the field and read as manual.
   */
  trigger?: "auto" | "manual";
  attempts: number;
  lease?: { runnerId: string; token: string; leasedAt: string; expiresAt: string };
  result?: {
    scenes: number;
    links: number;
    pagesRendered: number;
    releaseId?: string;
    /** Pages in this release but not the previous one — source of the console's "N new page kinds" status line. */
    newScenes?: number;
    /**
     * Result of the AI review. Review is a step of the crawl (names page types,
     * refreshes the site profile) and runs before publishing, so one crawl publishes one
     * version. A failure still publishes — **a model outage must not block releases**;
     * the UI then says "page types keep their names, just re-crawl once". Crawls are
     * independent: no retry, no queue.
     */
    review?: { reviewed: number; failed: boolean };
    /**
     * Site-wide conclusion of index filtering, kept with the job for the console. **The
     * hint "one more crawl removes more dynamic content" is only visible if it lands
     * here** — re-crawls are manual, and unseen means nonexistent.
     */
    contentFilter?: {
      indexed: number;
      skipped: number;
      purgedPages: number;
      /** Characters actually written to the content store: counted after cross-page chrome removal and only if the page was rewritten. */
      writtenChars?: number;
      /** The Chinese sentence generated at the time. Old crawl records only have this; kept as a fallback. */
      recrawlHint?: string;
      /** The same thing, structured: the console renders it in the current locale. */
      recrawlStage?: "first-crawl" | "needs-one-more" | "ready";
      recrawlPagesNeedingMore?: number;
      recrawlShortestIntervalMinutes?: number;
      baselineIntervalMs?: number | null;
      warnings?: string[];
      /** What this crawl removed, attributed per layer — the console's "what improved this crawl" depends on it. */
      removed?: { shapeChars: number; dataPages: number; changingLines: number; keptChars: number };
    };
  };
  /** Internal idempotency receipt for a terminal runner submission. */
  completion?: {
    runnerId: string;
    leaseTokenHash: string;
    kind: "succeeded" | "failed";
    payloadHash: string;
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
};

/** Management-safe crawl status. Lease and completion secrets never leave D1. */
export type CrawlJobSummary = Omit<CrawlJob, "lease" | "completion"> & {
  lease?: Omit<NonNullable<CrawlJob["lease"]>, "token">;
};

export type CrawlLease = {
  kind: "crawl";
  job: CrawlJob;
  /**
   * Observation records from the site's last two crawls, the cross-time baseline.
   * Shipped with the job instead of fetched by the runner: the release read API needs
   * an admin login, and per-line checksums do not belong on the public runtime surface.
   * Stored in `site_agent_v2_page_observations`, not in the release — a crawl ledger,
   * not knowledge.
   */
  priorObservations?: Record<string, Array<{ at: string; lines: Record<string, string[]>; signature?: string }>>;
};

/**
 * One refusal reported by the browser itself while the page was open.
 *
 * Measured (tests/csp-request-inventory.test.mjs): a browser names the
 * directive that GOVERNS the request in both fields, even when `default-src`
 * is what actually matched — so which written directive to extend is decided
 * from `policy`, never from these names.
 */
export type PolicyViolation = {
  /** The address that was refused, or "inline" for something the page itself carried. */
  blockedUrl: string;
  /** The directive that governs this kind of request. */
  effectiveDirective: string;
  /** What the browser called the violated directive (equal to the above in Chrome). */
  violatedDirective: string;
  /** `enforce` blocks; `report` only tells. */
  disposition: "enforce" | "report";
  /** The full policy that produced this violation. */
  policy: string;
  /** Where that policy came from, when the page makes it knowable. */
  source?: "header" | "meta";
};

export type SitePreviewResult = {
  artifactId: string;
  url: string;
  pageUrl: string;
  capturedAt: string;
  width: number;
  height: number;
  /** Traces of an install on the page: the SDK is mounted, or the HTML carries a script tag with a site id. */
  agentDetected: boolean;
  /**
   * Site ids observed on `script[data-site-agent]` in the page HTML. Even if the script
   * request is blocked the tag is still in the same-origin HTML, so this decides both
   * "is it installed" and "is it this site". Old jobs lack the field; readers treat it
   * as an empty array.
   */
  detectedSiteAgentIds?: string[];
  /**
   * How this page was opened: `live` renders it as it is, `try-install` puts
   * the install snippet into the HTML first so the browser decides what would
   * happen before anyone pastes anything. Old jobs have neither and are read
   * as `live`.
   */
  mode?: SitePreviewMode;
  /** What the browser refused while the page was open, in the order it said so. */
  violations?: PolicyViolation[];
  /** The install snippet reached the page and the SDK handshook from it. */
  installConnected?: boolean;
  /**
   * Set when the rehearsal could not be run as intended — the page could not be
   * opened, or the snippet could not be placed in it. The console then says
   * what it inferred instead of claiming a measurement.
   */
  rehearsalUnavailable?: "unreachable" | "not-injectable";
};

export type SitePreviewMode = "live" | "try-install";

export type SitePreviewJob = {
  id: string;
  siteAgentId: string;
  origin: string;
  url: string;
  /** Defaults to `live`; `try-install` carries the snippet to put into the page. */
  mode?: SitePreviewMode;
  /** The exact markup a reader would paste, used only by `try-install`. */
  installSnippet?: string;
  status: "queued" | "leased" | "running" | "succeeded" | "failed";
  attempts: number;
  lease?: { runnerId: string; token: string; leasedAt: string; expiresAt: string };
  result?: SitePreviewResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type SitePreviewJobSummary = Omit<SitePreviewJob, "lease"> & {
  lease?: Omit<NonNullable<SitePreviewJob["lease"]>, "token">;
};

export type SitePreviewLease = { kind: "site-preview"; job: SitePreviewJob };

export type RunnerLease = AuthoringLease | ValidationLease | CapabilityExecutionLease | CrawlLease | SitePreviewLease;

export type EpisodeMode = "adaptive" | "compiled" | "repair" | "demonstration" | "validation" | "passive" | "author-request";

export type TaskEpisode = {
  schemaVersion: typeof SITE_AGENT_SCHEMA_VERSION;
  id: string;
  siteAgentId: string;
  taskSessionId: string;
  browserSessionId: string;
  documentId: string;
  mode: EpisodeMode;
  goal: string;
  normalizedGoal: string;
  input: Record<string, JsonValue>;
  startedAt: string;
  endedAt: string;
  releaseId?: string;
  capabilityId?: string;
  /** Server-issued before compiled execution; required to authorize drift repair. */
  compiledExecutionGrantId?: string;
  candidateId?: string;
  /** Repair is reserved for a published capability whose implementation drifted. */
  sourceCapabilityId?: string;
  repairKind?: "compiled-capability-drift";
  pageExecutionBrief?: PageExecutionBrief;
  startSnapshot: PageSnapshot;
  endSnapshot: PageSnapshot;
  transitions: TransitionObservation[];
  outcome: OutcomeReceipt;
  experience?: ExperienceEvidenceBundle;
};

/** Lightweight control-plane projection. Full snapshots and traces stay in D1. */
export type TaskEpisodeSummary = {
  id: string;
  taskSessionId: string;
  mode: EpisodeMode;
  goal: string;
  capabilityId?: string;
  input: Record<string, JsonValue>;
  startedAt: string;
  endedAt: string;
  outcome: OutcomeReceipt;
  startSnapshot: Pick<PageSnapshot, "url" | "title" | "heading">;
  endSnapshot: Pick<PageSnapshot, "url" | "title" | "heading">;
};

export type TaskSession = {
  id: string;
  siteAgentId: string;
  browserSessionId: string;
  goal: string;
  input: Record<string, JsonValue>;
  conversation: Array<{ role: "user" | "assistant" | "system"; content: string; at: string }>;
  capabilityId?: string;
  planId?: string;
  nextStepIndex: number;
  bindings: Record<string, JsonValue>;
  checkpoint?: HumanCheckpoint | null;
  status: "running" | "awaiting-human" | "resuming" | "validating" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type AgentRunStatus = "running" | "awaiting-page" | "awaiting-user" | "completed" | "failed" | "cancelled";

export type AgentRunConversationTurn = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  at: string;
  toolCallId?: string;
};

export type AgentRunToolCall = {
  id: string;
  kind: "site-knowledge" | "capability" | "page" | "ask-user";
  name: string;
  input: Record<string, JsonValue>;
  status: "pending" | "running" | "completed" | "failed";
  output?: Record<string, JsonValue>;
  startedAt: string;
  endedAt?: string;
};

/** Durable observable execution history. It retains diagnostic routing stages
 * as well as business actions, never private model chain-of-thought. Customer
 * UI projections deliberately show only the business-action subset. */
export type AgentRunActivity = {
  id: string;
  /** Durable AgentRun/TaskSession owner. UI projections must group activity
   * by this value instead of attaching one global trace to the latest turn. */
  sessionId?: string;
  kind: "reasoning" | "capability-search" | "knowledge" | "capability" | "navigation" | "page" | "transition" | "result" | "human";
  state: "running" | "completed" | "failed";
  label: string;
  detail?: string;
  capabilityId?: string;
  capabilityName?: string;
  input?: Record<string, JsonValue>;
  output?: Record<string, JsonValue>;
  stepIndex?: number;
  stepTotal?: number;
  operationName?: string;
  url?: string;
  pageEpoch?: number;
  createdAt: string;
};

/**
 * A durable, machine-readable statement about how an existing capability was
 * used.  This is deliberately separate from a learning episode: using an
 * already published capability is evidence about its health, not a request to
 * manufacture a second capability with the same user-facing intent.
 */
export type CapabilityUseSignal = {
  capabilityId: string;
  intentKey?: string;
  fullySatisfied: boolean;
  extraObservation: boolean;
  missingOutputFields: string[];
  shorterPathObserved?: boolean;
  outcome: "success" | "no-result" | "business-rejection" | "execution-fault" | "unknown";
  executionMs?: number;
  output: Record<string, JsonValue>;
  observedAt: string;
};

export type BrowserPortLease = {
  id: string;
  documentId: string;
  browserSessionId: string;
  origin: string;
  url: string;
  pageEpoch: number;
  claimedAt: string;
  lastSeenAt: string;
  leaseExpiresAt: string;
  state: "active" | "released" | "superseded";
};

/** Serializable state needed to resume either the main Agent or a compiled tool. */
export type AgentRunCheckpoint = {
  mode: "compiled" | "adaptive" | "repair";
  phase: "running" | "navigating" | "waiting-page-restore" | "awaiting-human";
  capabilityId?: string;
  candidateId?: string;
  input: Record<string, JsonValue>;
  cursor: ProgramCursor;
  output: Record<string, JsonValue>;
  adaptiveState?: JsonValue;
  toolContext?: JsonValue;
  activityTimeline?: AgentRunActivity[];
  savedAt: string;
};

export type AgentRun = {
  id: string;
  revision: number;
  /** Who owns the control loop. Both modes use the same page SDK executor. */
  controller: "page-agent" | "script";
  scope: ExecutionScope;
  status: AgentRunStatus;
  goal: string;
  input: Record<string, JsonValue>;
  conversation: AgentRunConversationTurn[];
  agentState: Record<string, JsonValue>;
  activeToolCall?: AgentRunToolCall;
  activityTimeline: AgentRunActivity[];
  programCursor?: ProgramCursor;
  checkpoint?: AgentRunCheckpoint;
  bindings: Record<string, JsonValue>;
  activePort?: BrowserPortLease;
  pageEpoch: number;
  eventSequence: number;
  outcome?: OutcomeReceipt;
  output?: Record<string, JsonValue>;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type AgentRunEvent = {
  id: string;
  runId: string;
  sequence: number;
  type: "run-created" | "port-claimed" | "port-superseded" | "status" | "checkpoint" | "tool-call" | "tool-receipt" | "conversation" | "completed" | "failed" | "cancelled";
  payload: Record<string, JsonValue>;
  createdAt: string;
};

export type BrowserDirective =
  | { type: "resume-agent"; run: AgentRun }
  | { type: "execute-slice"; run: AgentRun; slice: ExecutionSlice }
  | { type: "await-user"; run: AgentRun; question: string }
  | { type: "complete"; run: AgentRun }
  | { type: "cancelled"; run: AgentRun };

export type ClientDirective =
  | { type: "complete"; session: TaskSession; release?: SiteAgentReleaseV2 }
  | { type: "learning-queued"; session: TaskSession; candidate: KnowledgeCandidate; job: LearningJob }
  | { type: "learning-unavailable"; session: TaskSession; candidate: KnowledgeCandidate; job: LearningJob; reason: string }
  | { type: "validate-candidate"; session: TaskSession; candidate: KnowledgeCandidate }
  | {
      type: "continue-adaptive";
      session: TaskSession;
      reason: string;
      attempt: number;
      sourceCapabilityId?: string;
      repairKind?: "compiled-capability-drift";
      pageExecutionBrief?: PageExecutionBrief;
      budgetEvidence?: PageExecutionBudget;
    }
  | { type: "release-updated"; session: TaskSession; release: SiteAgentReleaseV2 }
  | { type: "recorded"; release: SiteAgentReleaseV2 };

export type SiteConnection = {
  siteAgentId: string;
  origin: string;
  url: string;
  title: string;
  heading: string;
  connectedAt: string;
  lastSeenAt: string;
};

export type SiteAgentSummary = {
  id: string;
  profile: SiteProfile;
  connection?: SiteConnection;
  activeReleaseVersion: number;
  sceneCount: number;
  capabilityCount: number;
  taskCount: number;
  episodeCount: number;
  updatedAt: string;
};

export type SiteAgentOverview = SiteAgentSummary & {
  activeRelease: SiteAgentReleaseV2;
  recentEpisodes: TaskEpisodeSummary[];
  activeSessions: TaskSession[];
  candidates: KnowledgeCandidate[];
  learningJobs: LearningJob[];
  validationJobs: ValidationJob[];
  browserRuns: BrowserRun[];
  artifacts: BrowserArtifact[];
  runners: RunnerRegistration[];
  runnerService?: RunnerControlProjection;
  sitePreview?: SitePreviewResult;
  sitePreviewJob?: SitePreviewJobSummary;
};

export function normalizeGoal(goal: string) {
  return goal
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:："'“”‘’（）()\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stableHash(input: string) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

type RandomIdCrypto = {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint8Array) => Uint8Array;
};

export function uid(prefix: string, randomSource?: RandomIdCrypto) {
  const source = randomSource || (globalThis.crypto as unknown as RandomIdCrypto | undefined);
  if (typeof source?.randomUUID === "function") {
    try {
      return `${prefix}_${source.randomUUID()}`;
    } catch {
      // randomUUID is restricted to secure contexts in some browsers.
    }
  }
  if (typeof source?.getRandomValues === "function") {
    try {
      const bytes = source.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
      return `${prefix}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    } catch {
      // Fall through for older embedded browsers without Web Crypto support.
    }
  }
  return `${prefix}_${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  appearance: {
    preset: "orb",
    palette: "blue",
    launcherPosition: "bottom-right",
  },
  overrides: { pinnedSuggestions: [] },
  brand: {
    displayName: "网站助手",
    launcherLabel: "打开网站助手",
    avatarText: "SiteWake",
  },
  theme: {
    accentColor: "#3b82f6",
    accentTextColor: "#ffffff",
    panelBackground: "#ffffff",
    launcherPosition: "bottom-right",
  },
  copy: {
    welcomeTitle: "今天想在这个网站完成什么？",
    welcomeDescription: "直接说出目标，我会操作当前页面，并在完成后把结果告诉你。",
    composerPlaceholder: "给 SiteWake 一个目标…",
    poweredByText: "由 SiteWake 提供",
  },
  features: {
    showSuggestions: true,
    showTeachAfterFailure: true,
    showNewChat: true,
    showKnowledgeVersion: true,
  },
  suggestions: [],
};

const POWERED_BY = "由 SiteWake 提供";
export const AGENT_PALETTES = {
  mint: { accentColor: "#5ee6b5", accentTextColor: "#172019", panelBackground: "#ffffff", label: "薄荷绿" },
  violet: { accentColor: "#7c5cff", accentTextColor: "#ffffff", panelBackground: "#ffffff", label: "星云紫" },
  blue: { accentColor: "#3b82f6", accentTextColor: "#ffffff", panelBackground: "#ffffff", label: "天空蓝" },
  coral: { accentColor: "#ff765f", accentTextColor: "#ffffff", panelBackground: "#ffffff", label: "珊瑚橙" },
  ink: { accentColor: "#18181b", accentTextColor: "#ffffff", panelBackground: "#ffffff", label: "墨黑" },
} as const;

/** Long enough for a real question in English; Chinese never comes close. */
export const SUGGESTION_MAX_LENGTH = 160;

function text(value: unknown, fallback: string, maxLength: number) {
  const normalized = typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
  return (normalized || fallback).slice(0, maxLength);
}

function color(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(trimmed)) return trimmed;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(trimmed)) return trimmed;
  if (/^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(trimmed)) return trimmed;
  if (/^(black|white|gray|grey|red|green|blue|purple|pink|orange|yellow|cyan|teal|transparent)$/i.test(trimmed)) return trimmed;
  return fallback;
}

type AgentAppearance = NonNullable<AgentConfig["appearance"]>;

function closestPalette(value: unknown, fallback: AgentAppearance["palette"] = "blue") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  for (const [id, palette] of Object.entries(AGENT_PALETTES)) {
    if (normalized === id || normalized === palette.accentColor.toLowerCase()) return id as AgentAppearance["palette"];
  }
  return fallback;
}

function preset(value: unknown, fallback: AgentAppearance["preset"] = "orb") {
  return value === "dock" || value === "minimal" || value === "orb" ? value : fallback;
}

function palette(value: unknown, fallback: AgentAppearance["palette"] = "blue") {
  return value === "violet" || value === "blue" || value === "coral" || value === "ink" || value === "mint" ? value : fallback;
}

function bool(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

export function defaultAgentConfig(): AgentConfig {
  return JSON.parse(JSON.stringify(DEFAULT_AGENT_CONFIG)) as AgentConfig;
}

function compactSiteName(profile: Partial<SiteProfile>) {
  // Only the generic separator cut. The product name is chosen from page
  // evidence rather than taken from the SEO title, so trimming particular
  // sites' title suffixes here has nothing left to act on.
  const raw = text(profile.name, "", 28)
    .replace(/\s*[-_|｜].*$/, "")
    .trim();
  return raw || text(profile.name, "网站", 12) || "网站";
}

function avatarFromName() {
  return "SiteWake";
}

/**
 * What a visitor is offered before they have typed anything.
 *
 * This used to be the names of published capabilities. Those names are written
 * for the operator who reviews them, they read poorly as an opening question,
 * and a site that has just been onboarded has none at all — so the list was
 * empty exactly when a visitor most needs a way in. The knowledge analysis
 * already writes concrete questions from the same page evidence; use those, and
 * fall back to the jobs it recorded when a site's evidence was too thin for
 * questions.
 */
function generatedSuggestions(release: SiteAgentReleaseV2) {
  const values = release.profile.suggestedQuestions?.length
    ? release.profile.suggestedQuestions
    : release.profile.jobsToBeDone || [];
  return [...new Set(values.map((item) => text(item, "", 50)).filter(Boolean))].slice(0, 3);
}

/** The site's own words for one language, or none when it has none in that language. */
/**
 * The frame around a site's own words, once per language.
 *
 * The words come from that site's pages and cannot be translated at render
 * time; only the frame can. It lives here, beside the default copy and the
 * function that builds the generated copy, because this module is reachable
 * from a loader that erases type imports but cannot resolve a value one — a
 * runtime dependency on the widget's catalog would make it unloadable there.
 */
type GeneratedCopyLocale = NonNullable<AgentConfig["generatedLocale"]>;
const GENERATED_COPY_LOCALES = ["zh", "en"] as const satisfies readonly GeneratedCopyLocale[];
const GENERATED_COPY_FRAME: Record<GeneratedCopyLocale, {
  displayName(site: string): string;
  launcherLabel(site: string): string;
  welcomeTitle(site: string): string;
  welcomeDescription(job: string): string;
}> = {
  zh: {
    displayName: (site) => `${site}助手`,
    launcherLabel: (site) => `打开 ${site}助手`,
    welcomeTitle: (site) => `想在${site}完成什么？`,
    welcomeDescription: (job) => `${job}。你也可以直接说出其他目标。`,
  },
  en: {
    displayName: (site) => `${site} assistant`,
    launcherLabel: (site) => `Open the ${site} assistant`,
    welcomeTitle: (site) => `What would you like to do on ${site}?`,
    welcomeDescription: (job) => `${job}. You can also just say what you want.`,
  },
};

/**
 * The language a profile written before there were two is taken to be in, and
 * the one whose copy fills the single resolved `brand`/`copy` pair that older
 * readers still use.
 */
/**
 * Two different questions, which one constant used to answer at once.
 *
 * `LEGACY_` is a fact about stored data: a profile written before there were two
 * languages carries one unlabelled set, and every such record is Chinese. Changing it
 * would relabel old Chinese text as English.
 *
 * `PREFERRED_` fills the top-level brand/copy fields. It stays Chinese: those fields
 * are a compatibility surface for readers that do not resolve per locale, and a site
 * named in Chinese would otherwise be described as "<Chinese name> assistant" — a
 * hybrid belonging to no reader. Every surface a person actually reads resolves for
 * their own language instead: the console by its locale setting, the widget by the
 * visitor's browser.
 */
const LEGACY_KNOWLEDGE_COPY_LOCALE: GeneratedCopyLocale = "zh";
const PREFERRED_GENERATED_COPY_LOCALE: GeneratedCopyLocale = "zh";

/**
 * A site's own description in the reader's language.
 *
 * The analysis writes one language and stores the others under `localized`, so the
 * top-level field is whichever language ran first — not the reader's. Anything showing
 * this description to a person goes through here; reading `profile.description`
 * directly is what showed a Chinese summary to an English console.
 */
export function localizedProfileDescription(
  profile: { description?: string; localized?: Partial<Record<GeneratedCopyLocale, { description?: string }>> },
  locale: GeneratedCopyLocale,
) {
  return profile.localized?.[locale]?.description?.trim() || profile.description?.trim() || "";
}

/**
 * Which language a profile's own top-level fields are written in.
 *
 * The analysis writes the language it was asked for into those fields and puts the other
 * under `localized`, so this is no longer always Chinese. `language` records it; a record
 * written before that field existed is read from the shape instead — the top-level is
 * whichever language `localized` does not hold — and failing that, the legacy default.
 */
export function profileLanguage(profile: {
  language?: GeneratedCopyLocale;
  localized?: Partial<Record<GeneratedCopyLocale, unknown>>;
}): GeneratedCopyLocale {
  if (profile.language) return profile.language;
  const beside = GENERATED_COPY_LOCALES.filter((locale) => profile.localized?.[locale]);
  const absent = GENERATED_COPY_LOCALES.filter((locale) => !beside.includes(locale));
  return beside.length === 1 && absent.length === 1 ? absent[0] : LEGACY_KNOWLEDGE_COPY_LOCALE;
}

function knowledgeCopyFor(release: SiteAgentReleaseV2, locale: GeneratedCopyLocale) {
  const written = release.profile.localized?.[locale];
  // An entry with nothing in it is not a translation: it used to shadow the fields the
  // profile does have, leaving a reader with no greeting and no suggested questions.
  const usable = written
    && (written.description?.trim() || written.jobsToBeDone?.length || written.suggestedQuestions?.length)
    ? written
    : undefined;
  const fallback = locale === profileLanguage(release.profile)
    ? {
        description: release.profile.description,
        jobsToBeDone: release.profile.jobsToBeDone || [],
        suggestedQuestions: release.profile.suggestedQuestions || [],
      }
    : undefined;
  return usable || fallback;
}

function generatedCopyFor(release: SiteAgentReleaseV2, locale: GeneratedCopyLocale) {
  const frame = GENERATED_COPY_FRAME[locale];
  // What a site is called is the same in every language; only the frame around
  // it is translated. Withholding the name from a reader because nobody had
  // written that language's sentences yet greeted them as the generic
  // assistant on a site whose name was known all along.
  const siteName = compactSiteName(release.profile);
  const known = knowledgeCopyFor(release, locale);
  const firstJob = known?.jobsToBeDone?.[0] || known?.description;
  const conciseJob = text(firstJob, "", 86).replace(/[。.!！]+$/, "");
  const offered = known?.suggestedQuestions?.length ? known.suggestedQuestions : known?.jobsToBeDone || [];
  return {
    displayName: frame.displayName(siteName),
    launcherLabel: frame.launcherLabel(siteName),
    welcomeTitle: frame.welcomeTitle(siteName),
    welcomeDescription: conciseJob ? frame.welcomeDescription(conciseJob) : "",
    // Clicking a suggestion sends it as the goal, so cutting one at a character
    // count sends half a sentence. 50 was a Chinese-sized budget and sliced every
    // English question mid-word. Keep them whole — the card ellipsises in CSS —
    // and drop one only when it is too long to be a question at all.
    suggestions: [...new Set(offered.map((item) => text(item, "", SUGGESTION_MAX_LENGTH + 1)).filter((item) => item && item.length <= SUGGESTION_MAX_LENGTH))].slice(0, 3),
  };
}

/**
 * A site's own words, in every language a reader might be using.
 *
 * These sentences are written from that site's pages, so they cannot be
 * translated at render time the way a button label is. Generating only one
 * language meant a reader of the other was shown the built-in assistant
 * instead of this site's — and, when the analysis followed the page rather
 * than the prompt, a greeting half in each.
 */
export function deriveAgentConfigFromKnowledge(release: SiteAgentReleaseV2): AgentConfig {
  const base = defaultAgentConfig();
  const generated: NonNullable<AgentConfig["generated"]> = {};
  for (const locale of GENERATED_COPY_LOCALES) generated[locale] = generatedCopyFor(release, locale);
  const preferred = generated[PREFERRED_GENERATED_COPY_LOCALE] || Object.values(generated)[0];
  if (!preferred) return base;
  return {
    ...base,
    generatedLocale: generated[PREFERRED_GENERATED_COPY_LOCALE] ? PREFERRED_GENERATED_COPY_LOCALE : GENERATED_COPY_LOCALES.find((locale) => generated[locale]),
    generated,
    brand: {
      displayName: preferred.displayName,
      launcherLabel: preferred.launcherLabel,
      avatarText: avatarFromName(),
    },
    copy: {
      welcomeTitle: preferred.welcomeTitle,
      welcomeDescription: preferred.welcomeDescription || base.copy.welcomeDescription,
      composerPlaceholder: base.copy.composerPlaceholder,
      poweredByText: POWERED_BY,
    },
    suggestions: preferred.suggestions,
  };
}

function stripGeneratedDefaults(input: unknown, generated: AgentConfig) {
  if (!input || typeof input !== "object") return input;
  const source = input as Partial<AgentConfig>;
  const defaultValue = defaultAgentConfig();
  const appearance: Partial<NonNullable<AgentConfig["appearance"]>> = source.appearance && typeof source.appearance === "object" ? source.appearance : {};
  const overrides: Partial<NonNullable<AgentConfig["overrides"]>> = source.overrides && typeof source.overrides === "object" ? source.overrides : {};
  // Same to the system, not byte-identical: stored copy has been through NFKC
  // and whitespace folding, while a generated sentence is a template that never
  // takes that trip. The generated welcome title ends in a full-width question
  // mark and anything stored ends in a half-width one, so comparing them raw
  // could never match and the field stayed "customised" forever.
  const sameText = <T>(left: T, right: T) => {
    if (typeof left !== "string" || typeof right !== "string") return left === right;
    const fold = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
    return fold(left) === fold(right);
  };
  const keep = <T>(value: T | undefined, generatedValue: T, legacyValue: T) => {
    if (value === undefined || sameText(value, generatedValue) || sameText(value, legacyValue)) return undefined;
    return value;
  };
  // `brand` and `copy` on a stored config are resolved output, not intent. Only
  // records old enough to predate `overrides` kept a person's wording there, so
  // only those may be read as a customisation. Promoting them from a modern
  // record turned the resolved value frozen in an early Release snapshot into a
  // customisation nobody made: a site is named after its host until the crawl
  // reads its real product name, and the moment that name improved, the stale
  // one was pinned and the site stopped following its own knowledge.
  const legacyRecord = !(source.overrides && typeof source.overrides === "object");
  const writtenBefore = <T>(value: T | undefined) => (legacyRecord ? value : undefined);
  const pinnedSuggestions = Array.isArray(overrides.pinnedSuggestions)
    ? overrides.pinnedSuggestions
    : Array.isArray(source.suggestions) ? source.suggestions : undefined;
  // Early versions wrote mint green into every full config even when the user never
  // touched the appearance. When the default became SiteWake blue, only that exact set
  // of old defaults is migrated; configs with a deliberately chosen style are kept.
  const legacyUntouchedAppearance = appearance.palette === "mint"
    && (!appearance.preset || appearance.preset === "orb")
    && (!appearance.launcherPosition || appearance.launcherPosition === "bottom-right")
    && !overrides.displayName
    && !overrides.welcomeTitle
    && !overrides.welcomeDescription
    && !(Array.isArray(overrides.pinnedSuggestions) && overrides.pinnedSuggestions.length);
  return {
    appearance: {
      preset: appearance.preset,
      palette: legacyUntouchedAppearance
        ? undefined
        : appearance.palette || closestPalette(source.theme?.accentColor),
      launcherPosition: appearance.launcherPosition || source.theme?.launcherPosition,
      surface: appearance.surface,
    },
    overrides: {
      displayName: keep(overrides.displayName || writtenBefore(source.brand?.displayName), generated.brand.displayName, defaultValue.brand.displayName),
      welcomeTitle: keep(overrides.welcomeTitle || writtenBefore(source.copy?.welcomeTitle), generated.copy.welcomeTitle, defaultValue.copy.welcomeTitle),
      welcomeDescription: keep(overrides.welcomeDescription || writtenBefore(source.copy?.welcomeDescription), generated.copy.welcomeDescription, defaultValue.copy.welcomeDescription),
      pinnedSuggestions,
    },
    brand: {
      displayName: keep(source.brand?.displayName, generated.brand.displayName, defaultValue.brand.displayName),
      launcherLabel: keep(source.brand?.launcherLabel, generated.brand.launcherLabel, defaultValue.brand.launcherLabel),
      avatarText: undefined,
    },
    // appearance is the current edit source; theme only reads old records without appearance.
    theme: source.appearance ? undefined : source.theme,
    generatedLocale: generated.generatedLocale,
    generated: generated.generated,
    copy: {
      welcomeTitle: keep(source.copy?.welcomeTitle, generated.copy.welcomeTitle, defaultValue.copy.welcomeTitle),
      welcomeDescription: keep(source.copy?.welcomeDescription, generated.copy.welcomeDescription, defaultValue.copy.welcomeDescription),
      composerPlaceholder: keep(source.copy?.composerPlaceholder, generated.copy.composerPlaceholder, defaultValue.copy.composerPlaceholder),
      poweredByText: undefined,
    },
    features: source.features,
    suggestions: pinnedSuggestions?.length ? pinnedSuggestions : generated.suggestions,
  };
}

export function normalizeAgentConfig(input: unknown, previous: AgentConfig = defaultAgentConfig()): AgentConfig {
  const source = (input && typeof input === "object" ? input : {}) as Partial<AgentConfig>;
  if ((source as AgentConfigPatch).reset) return normalizeAgentConfig({}, deriveAgentConfigFromPrevious(previous));
  const hasOverrides = Boolean(source.overrides && typeof source.overrides === "object");
  const appearance = (source.appearance && typeof source.appearance === "object" ? source.appearance : {}) as Partial<NonNullable<AgentConfig["appearance"]>>;
  const overrides = (hasOverrides ? source.overrides : {}) as Partial<NonNullable<AgentConfig["overrides"]>>;
  const brand = (source.brand && typeof source.brand === "object" ? source.brand : {}) as Partial<AgentConfig["brand"]>;
  const theme = (source.theme && typeof source.theme === "object" ? source.theme : {}) as Partial<AgentConfig["theme"]>;
  const copy = (source.copy && typeof source.copy === "object" ? source.copy : {}) as Partial<AgentConfig["copy"]>;
  const features = (source.features && typeof source.features === "object" ? source.features : {}) as Partial<AgentConfig["features"]>;
  const normalizedAppearance = {
    preset: preset(appearance.preset, previous.appearance?.preset || "orb"),
    surface: appearance.surface === "clean" || appearance.surface === "soft" || appearance.surface === "contrast" ? appearance.surface : previous.appearance?.surface || "clean",
    palette: palette(appearance.palette, previous.appearance?.palette || closestPalette(theme.accentColor, "blue")),
    launcherPosition: appearance.launcherPosition === "bottom-left" || appearance.launcherPosition === "bottom-right" ? appearance.launcherPosition : previous.appearance?.launcherPosition || (theme.launcherPosition === "bottom-left" ? "bottom-left" : "bottom-right"),
  } satisfies NonNullable<AgentConfig["appearance"]>;
  const paletteToken = AGENT_PALETTES[normalizedAppearance.palette];
  const pinnedSuggestions = Array.isArray(overrides.pinnedSuggestions)
    ? overrides.pinnedSuggestions
    : !hasOverrides && Array.isArray(source.suggestions) ? source.suggestions : undefined;
  const written = {
    displayName: text(overrides.displayName || (!hasOverrides ? brand.displayName : undefined), "", 60),
    welcomeTitle: text(overrides.welcomeTitle || (!hasOverrides ? copy.welcomeTitle : undefined), "", 80),
    welcomeDescription: text(overrides.welcomeDescription || (!hasOverrides ? copy.welcomeDescription : undefined), "", 180),
  };
  // A field nobody wrote is absent, not present-and-empty. The console says
  // "not overridden" by deleting the key (`withoutUnchangedOverrides`), so
  // emitting `displayName: undefined` here gave one state two spellings: the
  // same config built two ways stopped comparing equal in memory while staying
  // identical once serialized.
  const normalizedOverrides = {
    ...(written.displayName ? { displayName: written.displayName } : {}),
    ...(written.welcomeTitle ? { welcomeTitle: written.welcomeTitle } : {}),
    ...(written.welcomeDescription ? { welcomeDescription: written.welcomeDescription } : {}),
    pinnedSuggestions: pinnedSuggestions?.map((item) => text(item, "", 50)).filter(Boolean).slice(0, 3) || [],
  } satisfies NonNullable<AgentConfig["overrides"]>;
  const generatedSuggestionsSource = previous.suggestions || [];
  const rawSuggestions = [...(normalizedOverrides.pinnedSuggestions || []), ...generatedSuggestionsSource];
  const displayName = normalizedOverrides.displayName || previous.brand.displayName;
  const welcomeTitle = normalizedOverrides.welcomeTitle || previous.copy.welcomeTitle;
  const welcomeDescription = normalizedOverrides.welcomeDescription || previous.copy.welcomeDescription;
  // The generated locale must survive normalization. The widget and console preview pick
  // copy from the normalized config (resolveChromeCopy); losing it here reverts to the
  // hard-coded "generated copy is Chinese" assumption, which this field exists to replace.
  const generatedLocale = source.generatedLocale === "en" || source.generatedLocale === "zh"
    ? source.generatedLocale
    : previous.generatedLocale;
  return {
    generatedLocale,
    // Derived from the site's knowledge, never set by hand, so it comes from
    // the automatic layer and is carried through rather than rebuilt. Dropping
    // it here left every reader on the single resolved pair below — which is
    // one language — however many the generator had written.
    generated: previous.generated,
    appearance: normalizedAppearance,
    overrides: normalizedOverrides,
    brand: {
      displayName,
      launcherLabel: `打开 ${displayName}`,
      avatarText: "SiteWake",
    },
    theme: {
      accentColor: color(theme.accentColor, paletteToken.accentColor),
      accentTextColor: paletteToken.accentTextColor,
      panelBackground: paletteToken.panelBackground,
      launcherPosition: normalizedAppearance.launcherPosition,
    },
    copy: {
      welcomeTitle,
      welcomeDescription,
      composerPlaceholder: text(copy.composerPlaceholder, previous.copy.composerPlaceholder, 60),
      poweredByText: POWERED_BY,
    },
    features: {
      showSuggestions: bool(features.showSuggestions, previous.features.showSuggestions),
      showTeachAfterFailure: bool(features.showTeachAfterFailure, previous.features.showTeachAfterFailure),
      showNewChat: bool(features.showNewChat, previous.features.showNewChat),
      showKnowledgeVersion: bool(features.showKnowledgeVersion, previous.features.showKnowledgeVersion),
    },
    suggestions: rawSuggestions.map((item) => text(item, "", 50)).filter(Boolean).slice(0, 3),
  };
}

function deriveAgentConfigFromPrevious(previous: AgentConfig): AgentConfig {
  return {
    ...previous,
    overrides: {},
    suggestions: previous.suggestions || [],
  };
}

export function normalizeAgentConfigForRelease(release: SiteAgentReleaseV2, input: unknown): AgentConfig {
  const generated = deriveAgentConfigFromKnowledge(release);
  const patch = (input && typeof input === "object" ? input : {}) as AgentConfigPatch;
  if (patch.reset) return generated;
  return normalizeAgentConfig(stripGeneratedDefaults(input, generated), generated);
}

/**
 * Attaches the widget presentation config to a stored Release.
 *
 * `stored` is the config held on the agent row, which is where it lives now:
 * a Release is an immutable knowledge snapshot whose id derives from its
 * version, so keeping the config inside it made a recolour mint a knowledge
 * version. Pass `undefined` and the value still embedded in the Release is
 * used instead, which is what keeps releases written before the migration
 * readable.
 */
export function withAgentConfigDefaults(release: SiteAgentReleaseV2, stored?: unknown): SiteAgentReleaseV2 {
  const source = stored ?? (release as Partial<SiteAgentReleaseV2>).agentConfig;
  const agentConfig = normalizeAgentConfigForRelease(release, source);
  return { ...release, agentConfig };
}

export function emptyRelease(siteAgentId: string, createdAt = new Date().toISOString()): SiteAgentReleaseV2 {
  const base = {
    schemaVersion: SITE_AGENT_SCHEMA_VERSION,
    id: `${siteAgentId}:release:0`,
    siteAgentId,
    version: 0,
    createdAt,
    profile: {
      name: siteAgentId,
      description: "等待网站首次连接",
      semanticSource: "program",
      visibility: "production",
      vocabulary: {},
      suggestedGoals: [],
    },
    agentConfig: defaultAgentConfig(),
    scenes: [],
    linkReferences: [],
    targets: [],
    operations: [],
    navigationTools: [],
    capabilities: [],
    outcomes: [],
    evalSummary: {
      passed: true,
      evaluatedEpisodes: 0,
      successfulEpisodes: 0,
      failedEpisodes: 0,
      generatedAt: createdAt,
    },
    sourceEpisodeIds: [],
  } satisfies Omit<SiteAgentReleaseV2, "contentHash">;
  return { ...base, contentHash: stableHash(JSON.stringify(base)) };
}

export function isRelease(value: unknown): value is SiteAgentReleaseV2 {
  if (!value || typeof value !== "object") return false;
  const release = value as Partial<SiteAgentReleaseV2>;
  return release.schemaVersion === SITE_AGENT_SCHEMA_VERSION &&
    typeof release.siteAgentId === "string" &&
    typeof release.version === "number" &&
    Array.isArray(release.scenes) &&
    Array.isArray(release.operations) &&
    Array.isArray(release.capabilities);
}

export function isEpisode(value: unknown): value is TaskEpisode {
  if (!value || typeof value !== "object") return false;
  const episode = value as Partial<TaskEpisode>;
  return episode.schemaVersion === SITE_AGENT_SCHEMA_VERSION &&
    typeof episode.id === "string" &&
    typeof episode.siteAgentId === "string" &&
    typeof episode.taskSessionId === "string" &&
    typeof episode.browserSessionId === "string" &&
    typeof episode.documentId === "string" &&
    typeof episode.goal === "string" &&
    typeof episode.normalizedGoal === "string" &&
    Boolean(episode.input) && typeof episode.input === "object" && !Array.isArray(episode.input) &&
    typeof episode.startedAt === "string" && typeof episode.endedAt === "string" &&
    Boolean(episode.startSnapshot) && typeof episode.startSnapshot === "object" &&
    Boolean(episode.endSnapshot) && typeof episode.endSnapshot === "object" &&
    Boolean(episode.outcome) && typeof episode.outcome === "object" &&
    typeof episode.outcome.status === "string" && typeof episode.outcome.code === "string" &&
    typeof episode.outcome.summary === "string" && Boolean(episode.outcome.evidence) &&
    Array.isArray(episode.transitions);
}

export function isDomReplayChunk(value: unknown): value is DomReplayChunk {
  if (!value || typeof value !== "object") return false;
  const chunk = value as Partial<DomReplayChunk>;
  return typeof chunk.id === "string" &&
    typeof chunk.siteAgentId === "string" &&
    typeof chunk.sessionId === "string" &&
    typeof chunk.documentId === "string" &&
    typeof chunk.origin === "string" &&
    typeof chunk.seqStart === "number" &&
    typeof chunk.seqEnd === "number" &&
    Array.isArray(chunk.frames) &&
    chunk.frames.length > 0 &&
    chunk.frames.every((frame) => frame && typeof frame.seq === "number" && typeof frame.kind === "string") &&
    (chunk.episodeId === undefined || typeof chunk.episodeId === "string") &&
    (chunk.runId === undefined || typeof chunk.runId === "string");
}

export function isCapabilitySpecDoc(value: unknown): value is CapabilitySpecDoc {
  if (!value || typeof value !== "object") return false;
  const doc = value as Partial<CapabilitySpecDoc>;
  return typeof doc.intent === "string" &&
    typeof doc.whenToUse === "string" &&
    typeof doc.inputsNarrative === "string" &&
    typeof doc.resultNarrative === "string" &&
    Array.isArray(doc.scenarios) &&
    doc.scenarios.every((scenario) => scenario && typeof scenario.title === "string" && typeof scenario.given === "string" && typeof scenario.when === "string" && typeof scenario.then === "string") &&
    Array.isArray(doc.nonGoals) &&
    Array.isArray(doc.openQuestions);
}

/**
 * Truncates text to a limit **without splitting a character in half**.
 *
 * JS strings count UTF-16 code units; supplementary characters such as emoji take two.
 * A plain `slice(0, n)` can cut right between them and leave a lone surrogate — harmless
 * in JS, `JSON.stringify` happily emits `\ud83d`, and it only blows up in Postgres:
 * `invalid input syntax for type json`. One episode broke this way in production and
 * the whole agent overview page returned 500.
 */
export function clipUtf16(value: string | null | undefined, max: number) {
  const text = value || "";
  const cut = text.length <= max ? text : text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  // A trailing high surrogate (0xD800–0xDBFF) means its partner was cut off; drop it too.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
