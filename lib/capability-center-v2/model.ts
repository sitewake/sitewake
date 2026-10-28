import type { FailureClass } from "./failure-class";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type CapabilityStatus = "Building" | "Active" | "Disabled" | "Deleted";
export type CapabilityVersionStatus = "Draft" | "Published" | "Disabled" | "Deleted";
export type CapabilityVersionSource = "Knowledge" | "Admin" | "User";
export type CapabilityTaskType = "Discovery" | "Validation" | "Repair";
export type CapabilityTaskStatus = "Pending" | "Running" | "WaitingInput" | "Succeeded" | "Failed" | "Cancelled" | "Deleted";
export type RunnerStatus = "Launching" | "Starting" | "Running" | "WaitingInput" | "Completing" | "Lost" | "Disposing" | "Terminated";

export type JsonSchema = JsonObject;

/**
 * Logical contracts exchanged by the four capability-generation modules.
 *
 * These types intentionally do not mirror a database row.  Physical task
 * records may still carry lease, timestamps and compatibility columns, but
 * those fields are not part of the B/C/D business boundary.
 */
export type AuthoringEvidenceRef = {
  kind: "observation" | "action-receipt" | "episode" | "artifact";
  id: string;
};

export type AuthoringRequirement = {
  text: string;
  authority: "Admin" | "Policy";
};

export type DerivedAuthoringGuidance = {
  text: string;
  basedOn: AuthoringEvidenceRef[];
};

export type AuthoringGuidance = {
  requirements?: AuthoringRequirement[];
  derived?: DerivedAuthoringGuidance[];
};

export type CapabilityRequest = {
  goal: string;
  parameters: JsonObject;
  entryUrl: string;
  locale?: string;
};

export type CapabilityGenerationInput = {
  request: CapabilityRequest;
  requirements?: AuthoringRequirement[];
} & (
  | {
      source: "Episode";
      experience: {
        episodeId: string;
        mode: string;
        execution: JsonObject;
        outcome: JsonObject;
        evidence: JsonObject;
        capabilityContext?: JsonObject;
      };
    }
  | {
      source: "Admin";
      instruction: {
        operation: "create" | "repair" | "rebuild";
        targetCapabilityId?: string;
      };
    }
);

export type CapabilityReplacementPlan = {
  replacesCapabilityIds: string[];
  reason: string;
  disableAfterPublish: boolean;
};

/** Minimal B -> C1 authoring hint. Semantic analysis is recomputed by C1. */
export type CapabilityAuthoringSeed = {
  name: string;
  description: string;
  aliases: string[];
};

export type DiscoveryRunSpec = {
  protocolVersion: "2.0";
  id: string;
  goal: string;
  guidance?: AuthoringGuidance;
  browser: { startUrl: string; recording: boolean };
  input: {
    parameters: JsonObject;
    locale?: string;
    capabilitySeed?: CapabilityAuthoringSeed;
    authoringEvidence?: JsonObject;
  };
  replacementPlan?: CapabilityReplacementPlan;
};

export type RepairRunSpec = DiscoveryRunSpec & {
  baseCapabilityId: string;
  baseVersionId: string;
};

export type GenerationTask = {
  id: string;
  siteId: string;
  source: "Episode" | "Admin";
} & (
  | { type: "Discovery"; status: "Pending"; runSpec: DiscoveryRunSpec }
  | { type: "Repair"; status: "Pending"; runSpec: RepairRunSpec }
  | { type: "Discovery" | "Repair"; status: "WaitingInput"; interactions: TaskInteraction[]; runSpec?: never }
);

export type CapabilityValidationCase = {
  caseId: string;
  input: JsonObject;
  expected: JsonObject;
};

/**
 * Historical C1-produced context reference.
 *
 * This type is retained only so explicit legacy readers can decode persisted
 * records. New C1/C2 boundaries must not emit or consume it.
 */
export type CapabilityCaseContextRef = {
  artifactRef: string;
  contentHash: string;
  byteLength?: number;
};

/** Legacy projection derived from CapabilityCaseContext examples. */
export type CapabilityCaseEvidenceRegion = {
  regionId: string;
  values: JsonObject;
  evidenceRefs?: string[];
};

/** Historical C1 sidecar. New production C1/C2 paths use no CaseContext. */
export type CapabilityCaseContext = {
  schemaVersion: "1.0";
  generationTaskId: string;
  demonstrationInput: JsonObject;
  examples: Array<{
    input: JsonObject;
    source: "demonstration" | "page-evidence" | "default-omission";
    evidence: Array<{
      url: string;
      regionText: string;
      regionId?: string;
    }>;
  }>;
};

/** Content-addressed reference to evidence discovered and owned by C2. */
export type CapabilityCaseDiscoveryEvidenceRef = {
  artifactRef: string;
  contentHash: string;
  byteLength: number;
};

export type CapabilityCaseDiscoveryRegion = {
  regionId: string;
  url: string;
  kind: "page-summary" | "business-region" | "control-group";
  text: string;
  /** Typed values actually observed in this region, never model proposals. */
  observedValues: JsonValue[];
  /** Values exposed by controls such as select/radio/filter options. */
  controlOptions?: JsonValue[];
};

/** An explorer-observed relationship that may safely join multiple regions. */
export type CapabilityCaseDiscoveryAssociation = {
  associationId: string;
  regionIds: string[];
  inputPaths: string[];
  reason: string;
};

export type CapabilityCaseDiscoveryEvidence = {
  schemaVersion: "1.0";
  generationTaskId: string;
  siteId: string;
  candidateHash: string;
  explorationMode: "read-only-interactive" | "evidence-only";
  regions: CapabilityCaseDiscoveryRegion[];
  associations?: CapabilityCaseDiscoveryAssociation[];
  actions: Array<{
    action: "navigate" | "inspect" | "search" | "filter" | "submit";
    outcome: "performed" | "blocked";
    url: string;
    reason: string;
    /** Present when the action caused or attempted a network request. */
    requestMethod?: string;
  }>;
  cases: Array<{
    caseId: string;
    parameters: Array<{
      inputPath: string;
      regionId: string;
      observedValue: JsonValue;
    }>;
    associationId?: string;
  }>;
};

export type CapabilityCandidate = {
  name: string;
  description: string;
  aliases: string[];
  contract: CapabilityContract;
  program: CapabilityProgram;
  replacementPlan?: CapabilityReplacementPlan;
};

/** Public C1 output. Source and bundle bytes remain sidecar artifacts. */
export type C1AuthoringOutput = {
  generationTaskId: string;
  name: string;
  description: string;
  aliases: string[];
  contract: CapabilityContract;
  program: CapabilityProgram;
  replacementPlan?: CapabilityReplacementPlan;
};

/** C2 receives the authored Candidate plus only the information needed to open the target site. */
export type C2CaseGenerationInput = {
  generationTaskId: string;
  siteId: string;
  candidate: CapabilityCandidate;
  /**
   * The input values the C1 exploration succeeded with. C2 reads them as the
   * shape witness for each input — a date looks like this, a rank like that —
   * never as a case: a case value has to be observed on the site.
   */
  demonstrationParameters?: Record<string, JsonValue>;
  browser: {
    baseUrl: string;
    startUrl: string;
    recording: boolean;
    session: { mode: "Anonymous" | "AuthenticatedSnapshot" };
    /** Optional server-owned allowlist for additional read-only GET discovery. */
    readOnlyPathPrefixes?: string[];
  };
};

export type C2CaseGenerationOutput = {
  generationTaskId: string;
  candidate: CapabilityCandidate;
  validationSuite: { cases: CapabilityValidationCase[] };
  caseDiscoveryEvidenceRef: CapabilityCaseDiscoveryEvidenceRef;
  validationSuiteHash: string;
};

export type CapabilityCandidateArtifact = {
  candidateId: string;
  generationTaskId: string;
  candidate: CapabilityCandidate;
  validationSuite: { cases: CapabilityValidationCase[] };
  contractHash: string;
  programHash: string;
  /** Absent only on artifacts persisted before independent C2 page discovery existed. */
  caseDiscoveryEvidenceRef?: CapabilityCaseDiscoveryEvidenceRef;
  /** Absent only on artifacts persisted before independent C2 existed. */
  validationSuiteHash?: string;
};

export type CandidateValidationTask = {
  id: string;
  siteId: string;
  source: "System";
  type: "Validation";
  status: "Pending";
  runSpec: {
    protocolVersion: "2.0";
    candidateId: string;
    artifactRef: string;
    contractHash: string;
    programHash: string;
    /** Absent only when decoding a historical validation task. */
    validationSuiteHash?: string;
    /** Absent only when decoding a historical validation task. */
    caseDiscoveryEvidenceRef?: CapabilityCaseDiscoveryEvidenceRef;
    contract: CapabilityContract;
    program: CapabilityProgram;
    cases: CapabilityValidationCase[];
    browser: { isolation: "FreshContextPerCase"; recording: true };
  };
};

export type StageReceipt = {
  stageId: string;
  outcome: "Success" | "Failed" | "NoResult" | "BusinessRejection";
  evidenceRefs: string[];
  signal?: string;
  iteration?: number;
  transition?: CapabilityStageTransitionInfo;
};

export type CapabilityStageTransitionInfo = {
  fromStageId: string;
  toStageId?: string;
  signal?: string;
};

export type CapabilityBuildResult =
  | {
      outcome: "Validated";
      package: {
        artifact: CapabilityCandidateArtifact;
        validationTaskId: string;
        validation: {
          candidateId: string;
          contractHash: string;
          programHash: string;
          cases: Array<{
            caseId: string;
            /** A case the capability answered with "nothing to show" is recorded, not failed. */
            outcome: "Passed" | "NoResult" | "Failed";
            resolvedInput: JsonObject;
            output: JsonObject;
            stageReceipts: StageReceipt[];
            evidenceRefs: string[];
            /** Predicted values the replay did not reproduce; the case passed regardless. */
            outputDrift?: Array<{ key: string; expected: JsonValue; actual: JsonValue }>;
            /** Set when the capability answered that this input has nothing to show. */
            noResultReason?: string;
            /** Set when this one case did not work; the other cases and the review decide. */
            failureReason?: string;
          }>;
        };
      };
    }
  | {
      outcome: "Failed";
      stage: "Authoring" | "CaseGeneration" | "ArtifactGate" | "Validation";
      code: string;
      reason: string;
      candidateId?: string;
      evidenceRefs: string[];
    };

export type ValidatedCapabilityPackage = Extract<CapabilityBuildResult, { outcome: "Validated" }>["package"];

export type CapabilityPublishInput = {
  generationTaskId: string;
  validated: ValidatedCapabilityPackage;
  authorization:
    | { mode: "AIApproved"; reviewId: string }
    | { mode: "AdminOverride"; adminId: string; reason: string };
};

export type CapabilityPublishResult =
  | { outcome: "Published"; capability: Capability; version: CapabilityVersion }
  | {
      /**
       * A live capability with this candidate's name was published by another
       * generation before this one reached D. That is not a failure of this
       * build: the capability the user asked for is available. The candidate
       * stays with its validation task; publishing it would need a rebuild
       * from the published capability's latest version.
       */
      outcome: "AlreadyPublished";
      capability: Capability;
      version: CapabilityVersion;
      reason: string;
    }
  | {
      outcome: "WriteConflict";
      code: "PUBLISH_COMMAND_MISMATCH" | "BASE_VERSION_CHANGED" | "CLASSIFICATION_RESERVATION_LOST";
      reason: string;
    };

export type ExperienceClassificationResult =
  | { disposition: "Created"; task: GenerationTask }
  | {
      disposition: "Duplicate" | "Disabled";
      match: { capabilityId?: string; status?: "Active" | "Disabled"; reason: string };
    };

/**
 * Describes the business scope observed while discovering a capability.  A
 * browser path is evidence about the current run, not automatically a
 * reusable capability input.  Keeping this distinction in the contract lets
 * discovery explain when it found a site-wide route versus a route that is
 * still bound to a category/page context.
 */
export type CapabilityScope = {
  kind: "site-global" | "category-scoped" | "page-scoped";
  match?: {
    requiredInputPaths?: string[];
    tokens?: string[];
    urlPatterns?: string[];
  };
  onMismatch: "no-match" | "clarify" | "page-agent";
};

/** Historical analyzer shape. It is never emitted in a new Contract. */
export type LegacyCapabilityScope = {
  kind: CapabilityScope["kind"] | "unknown";
  binding: "none" | "user-input" | "derived-context" | "fixed";
  generalizable: boolean;
  observedPaths?: string[];
  scopeTokens?: string[];
  requiredInputPaths?: string[];
  rationale?: string;
};

export type DependencyKind =
  | "start-url"
  | "route"
  | "tenant"
  | "filter"
  | "page"
  | "role"
  | "date"
  | "locale"
  | "device"
  | "dom-position"
  | "product"
  | "other";

export type DependencyAction =
  | "Remove"
  | "Parameterize"
  | "Derive"
  | "Precondition"
  | "Narrow"
  | "Split"
  | "Keep"
  | "Reject";

/** A durable explanation of how Discovery treated an observed dependency. */
export type DependencyLedgerEntry = {
  id: string;
  kind: DependencyKind;
  source: "user-input" | "page-observation" | "action-receipt" | "program" | "model" | "system";
  value: string;
  action: DependencyAction;
  reason: string;
  parameterPath?: string;
  required?: boolean;
  evidenceRefs?: string[];
};

export type ScopeDecision = {
  status: "Generalized" | "Narrowed" | "Split" | "Rejected";
  scope: LegacyCapabilityScope;
  rationale: string;
  assumptions: string[];
  unresolvedDependencies: string[];
};

export type EntryPolicy = {
  kind: "site-global" | "category" | "page" | "explicit-context";
  requiredInputPaths: string[];
  scopeTokens: string[];
  mismatch: "no-match" | "clarify" | "page-agent";
  rationale: string;
};

/** Semantic intermediate representation created before Contract/Program. */
export type CapabilitySemanticIR = {
  schemaVersion: "1.0";
  goal: string;
  effect: "read" | "reversible-write" | "irreversible-write";
  parameters: Array<{
    path: string;
    role: "target" | "value" | "context" | "intent";
    userSupplied: boolean;
    example?: JsonValue;
  }>;
  /** Internal analyzers may populate this ledger; C-facing projections omit it. */
  dependencies?: DependencyLedgerEntry[];
  scopeDecision: ScopeDecision;
  entryPolicy: EntryPolicy;
  evidenceRefs: string[];
};

/** Seed passed from Experience/Discovery into the typed Contract builder. */
export type CapabilitySeed = {
  schemaVersion: "1.0";
  name: string;
  description: string;
  aliases: string[];
  intent: string;
  semantic: CapabilitySemanticIR;
  replacementPlan?: CapabilityReplacementPlan;
};

/** Site-language aliases discovered from visible page evidence. */
export type CapabilityInputAliases = Record<string, Record<string, string>>;

export type CapabilityContract = {
  intent: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  preconditions: JsonValue[];
  successConditions: JsonValue[];
  /** Scope is optional for backwards-compatible persisted V2 contracts. */
  scope?: CapabilityScope;
  /** Optional locale/search aliases; raw user inputs remain the public contract. */
  inputAliases?: CapabilityInputAliases;
};

/**
 * The action DSL is retained only as an in-memory exploration trace. V2
 * versions never persist or publish it after the JavaScript runtime upgrade.
 */
export type LocatorStrategy = {
  type: "role" | "label" | "text" | "testId" | "css";
  role?: string;
  name?: LocatorValue;
  value?: LocatorValue;
  /** Text used to filter a semantic container or a candidate collection. */
  containsText?: LocatorValue;
  /** All supplied business values must be present in the same container. */
  containsTextAll?: LocatorValue[];
  match?: "exact" | "contains";
};

export type ProgramValue =
  | { source: "literal"; value: JsonValue }
  | { source: "input"; path: string }
  | { source: "context"; path: string }
  | { source: "variable"; name: string }
  | { source: "humanInput"; interactionId: string };

export type LocatorValue = string | ProgramValue;

export type ProgramStep = {
  id: string;
  action: "navigate" | "click" | "fill" | "select" | "check" | "press" | "hover" | "upload" | "waitFor" | "extract";
  target?: {
    /** Resolve one stable container first, then resolve the target inside it. */
    scope?: { strategies: LocatorStrategy[] };
    strategies: LocatorStrategy[];
  };
  value?: ProgramValue;
  key?: string;
  timeoutMs?: number;
  extract?: { type: "text" | "value" | "attribute"; name?: string };
  saveAs?: string;
};

export type CapabilityDslProgram = {
  schemaVersion: "1.0";
  entry: { mode: "CurrentPage" | "Navigate"; url?: string | null };
  defaults: { timeoutMs: number; retryCount: number };
  steps: ProgramStep[];
  result: Record<string, ProgramValue>;
};

export type CapabilityModuleRef = {
  contentHash: string;
  moduleUrl: string;
  exportName: "capability";
};

export type CapabilityStageOutcome = "Continue" | "Success" | "NoResult" | "Ambiguous" | "BusinessRejection";

export type CapabilityStageEvidence = {
  kind: "target" | "url" | "text" | "output";
  key?: string;
  value: JsonValue;
  unique?: boolean;
};

export type CapabilityStageResult = {
  outcome: CapabilityStageOutcome;
  signal?: string;
  state?: JsonObject;
  output?: JsonObject;
  evidence?: CapabilityStageEvidence[];
  navigation?: CapabilityNavigationIntent;
  reason?: string;
};

export type CapabilityNavigationIntent = {
  url: string;
  target: "_self";
};

export type CapabilityStageIO = {
  reads: {
    input: string[];
    state: string[];
  };
  writes: {
    state: string[];
    output: string[];
  };
};

export type CapabilityStageNavigation = "none" | "optional" | "required";

export type CapabilityStageManifest = {
  id: string;
  title: string;
  purpose: string;
  effect: "read" | "write";
  resumePolicy: "skip-completed" | "reconcile-before-retry";
  io: CapabilityStageIO;
  navigation: CapabilityStageNavigation;
  /** Optional signal-to-stage conditional branches. */
  transitions?: Record<string, string>;
};

export type CapabilityLoopDefinition = {
  id: string;
  /** Stage at which a loop iteration starts. */
  entry: string;
  stageIds: string[];
  maxIterations: number;
  maxNoProgress: number;
  timeoutMs: number;
  /** Optional state paths that define progress for this loop. */
  progressPaths?: string[];
};

export type CapabilityControlFlow = {
  loops: CapabilityLoopDefinition[];
  /** Global safety caps for graph execution. */
  maxTransitions?: number;
  totalTimeoutMs?: number;
};

export type CapabilityExecutionCursor = {
  currentStageId: string;
  /** Total number of stage entries in this execution. */
  iteration: number;
  /** Number of graph edges taken; bounded by controlFlow.maxTransitions. */
  transitionCount: number;
  loopIterations: Record<string, number>;
  loopNoProgress: Record<string, number>;
  loopStartedAt: Record<string, number>;
  loopProgressFingerprints?: Record<string, string>;
  noProgress: number;
  startedAt: number;
  stageStartedAt?: number;
  /** Fingerprint of the last completed stage boundary. */
  progressFingerprint?: string;
  /** Fingerprint captured when the current stage began. */
  stageProgressFingerprint?: string;
  /** The destination selected by the last transition resolution. */
  nextStageId?: string;
};

export type CapabilityParameterRole = {
  inputPath: string;
  role: "target" | "value" | "context";
};

export type CapabilityTargetBinding = {
  inputPath: string;
  targetKind: string;
  identityStatePath: string;
  required: boolean;
};

export type CapabilityPromptProvenance = {
  promptKey: string;
  promptVersion: string;
  promptHash: string;
  model: string;
};

/** Immutable executable artifact persisted by every new Capability V2 version. */
export type CapabilityProgram = {
  schemaVersion: "2.0";
  runtime: "BrowserJavaScriptStage";
  module: CapabilityModuleRef;
  entry: { mode: "CurrentPage" | "Navigate"; url?: string };
  stages: CapabilityStageManifest[];
  controlFlow?: CapabilityControlFlow;
  parameterRoles: CapabilityParameterRole[];
  targetBindings: CapabilityTargetBinding[];
  promptProvenance: CapabilityPromptProvenance[];
  inputAliases?: CapabilityInputAliases;
  /** Findings of quality checks that no longer block (DEMOTED_CHECKS), kept with the version. */
  qualityNotes?: Array<{ code: string; message: string }>;
};

export type Capability = {
  id: string;
  siteId: string;
  name: string;
  description: string;
  aliases: string[];
  searchText: string;
  contract: CapabilityContract;
  status: CapabilityStatus;
  currentVersionId?: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
};

export type Review = {
  ai?: {
    status: "Pending" | "Reviewing" | "Approved" | "Rejected" | "Error";
    reason?: string;
    promptKey?: string;
    promptVersion?: string;
    promptHash?: string;
    model?: string;
    reviewedAt?: string;
    error?: string;
  };
  adminOverride?: { approved: boolean; reason: string; adminId: string; moduleHash: string; createdAt: string };
};

export type CapabilityVersion = {
  id: string;
  siteId: string;
  capabilityId: string;
  source: CapabilityVersionSource;
  program: CapabilityProgram;
  status: CapabilityVersionStatus;
  review?: Review;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  deletedAt?: string;
};

export type InteractionField = {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "select" | "boolean" | "file" | "otp";
  required: boolean;
  sensitive: boolean;
  options?: string[];
};

export type TaskInteraction = {
  id: string;
  status: "Requested" | "Provided" | "Expired";
  audience: "Administrator" | "User";
  message: string;
  resumeMode: "Continue" | "Restart";
  fields: InteractionField[];
  response?: { values: Record<string, JsonValue>; encryptedPayload?: string; keyVersion?: string; expiresAt?: string };
};

/**
 * A compact, administrator-only receipt from a successful terminal PageAgent
 * run. It is deliberately evidence rather than an executable program: the
 * isolated Runner must still explore, author and independently validate the
 * reusable implementation.
 */
export type CapabilityExperience = {
  schemaVersion: "1.0";
  episodeId: string;
  agentRunId: string;
  browserSessionId: string;
  originalGoal: string;
  outcome: "Success" | "NoResult";
  outcomeSummary: string;
  startedAt: string;
  endedAt: string;
  startPage: { url: string; title?: string; heading?: string };
  endPage: { url: string; title?: string; heading?: string };
  actions: Array<{
    action: "click" | "fill" | "select" | "scroll" | "wait" | "unknown";
    rawAction: string;
    input: Record<string, JsonValue>;
    element?: {
      tag?: string;
      role?: string;
      accessibleName?: string;
      label?: string;
      placeholder?: string;
      name?: string;
      href?: string;
      contextText?: string;
      landmark?: string;
    };
    page: { url: string; title?: string; heading?: string };
    observedAt: string;
  }>;
  /**
   * Addresses the run entered, with the values bound into them. Not steps:
   * this is the ground the run stood on, and for a site whose answers live at
   * parameterized routes it is the capability itself.
   */
  routes?: Array<{
    url: string;
    sceneId?: string;
    bindings: Record<string, JsonValue>;
    observedAt: string;
  }>;
  output: JsonObject;
};

export type CapabilityTaskInput = {
  parameters: Record<string, JsonValue>;
  context: { startUrl?: string; locale?: string; [key: string]: JsonValue | undefined };
  interactions: TaskInteraction[];
  trigger: { triggerTaskId?: string | null; baseVersionId?: string | null; errorCode?: string | null };
  candidateSummary?: { name?: string; description?: string; aliases?: string[]; contract?: CapabilityContract; replacementPlan?: CapabilityReplacementPlan };
  experience?: CapabilityExperience;
  program?: CapabilityProgram;
};

export type CapabilityTaskResult = {
  outcome: "Success" | "Duplicate" | "NoResult" | "BusinessRejection" | "ExecutionFailure";
  output?: JsonObject;
  candidateProgram?: CapabilityProgram;
  /** Auditable TypeScript source. The immutable executable is referenced by candidateProgram.module. */
  candidateSource?: string;
  candidateSummary?: CapabilityTaskInput["candidateSummary"];
  /** Concrete values used by the successful exploration demonstration. */
  demonstrationParameters?: Record<string, JsonValue>;
  /** Formal C1 checkpoint for module-v2 generation. */
  c1AuthoringOutput?: C1AuthoringOutput;
  /** C2 generation output before its internal Artifact commit. */
  c2CaseGenerationOutput?: C2CaseGenerationOutput;
  validationCaseCount?: number;
  stageReceipts?: Array<{
    stageId: string;
    stageIndex: number;
    status: "Started" | "Completed";
    urlBefore: string;
    urlAfter?: string;
    outcome?: CapabilityStageOutcome;
    signal?: string;
    iteration?: number;
    transition?: CapabilityStageTransitionInfo;
    evidence?: CapabilityStageEvidence[];
    durationMs?: number;
  }>;
  targetEvidence?: CapabilityStageEvidence[];
  promptProvenance?: CapabilityPromptProvenance[];
  capabilityId?: string;
  versionId?: string;
  existingCapabilityId?: string;
  artifactRefs?: JsonValue[];
  repairSuggested?: boolean;
  /** Final C2 checkpoint: the immutable Artifact handed to C3; absent on legacy task receipts. */
  candidateArtifact?: CapabilityCandidateArtifact;
  validationTaskId?: string;
  buildResult?: CapabilityBuildResult;
  validationResults?: Array<{
    caseId: string;
    resolvedInput: JsonObject;
    output: JsonObject;
    stageReceipts: StageReceipt[];
    evidenceRefs: string[];
    outputDrift?: Array<{ key: string; expected: JsonValue; actual: JsonValue }>;
    /** Set when the capability answered that this input has nothing to show. */
    noResultReason?: string;
    /** Set when this one case did not work; the other cases and the review decide. */
    failureReason?: string;
  }>;
};

export type CapabilityTaskError = {
  code: string;
  message: string;
  retryable: boolean;
  stepId?: string;
  cause?: { code: string; message: string };
  /** The failure's class and stage (lib/capability-center-v2/failure-class.ts), written with the terminal state. */
  failureClass?: FailureClass;
  failureStage?: string;
};

export type CapabilityTaskEvent = {
  id: string;
  sequence: number;
  eventType: string;
  payload: JsonObject;
  createdAt: string;
};

export type RunSpec = {
  protocolVersion: "2.0";
  id: string;
  taskId: string;
  siteId: string;
  goal?: string;
  guidance?: string;
  browser: { startUrl?: string; recording: boolean };
  input: CapabilityTaskInput;
  /** Decrypted only for the authenticated Runner response. Never persisted or exposed to clients/models. */
  resolvedSecrets?: JsonObject;
  contract?: CapabilityContract;
  plan: Array<{ type: "Replay" | "Explore" | "Evaluate"; program?: CapabilityProgram; conditions?: JsonValue[] }>;
  /** Physical transport projection for C3. Not part of the B RunSpec. */
  candidateValidation?: CandidateValidationTask["runSpec"];
};

export type CapabilityTask = {
  id: string;
  siteId: string;
  versionId: string;
  type: CapabilityTaskType;
  status: CapabilityTaskStatus;
  goal: string;
  guidance?: string;
  input: CapabilityTaskInput;
  runSpec?: RunSpec;
  runnerId?: string;
  result?: CapabilityTaskResult;
  error?: CapabilityTaskError;
  sourceAgentRunId?: string;
  rerunOfTaskId?: string;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  archivedAt?: string;
  deletedAt?: string;
};

export type RunnerInstance = {
  id: string;
  siteId: string;
  taskId?: string;
  runtimeType: "Process" | "Container" | "Function";
  runtimeProvider: string;
  runtimeVersion: string;
  status: RunnerStatus;
  heartbeatAt: string;
  heartbeatExpiresAt: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  terminatedAt?: string;
};

export type CapabilityCenterSetting = {
  id: string;
  siteId: string;
  settingKey: string;
  settingValue: JsonObject;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CapabilityArtifact = {
  id: string;
  siteId: string;
  taskId: string;
  kind: "Screenshot" | "Trace" | "Video" | "Log" | "Source" | "Bundle" | "CaseContext" | "CaseDiscoveryEvidence";
  storageKey: string;
  contentType: string;
  size: number;
  createdAt: string;
};

export const EMPTY_TASK_INPUT: CapabilityTaskInput = {
  parameters: {},
  context: {},
  interactions: [],
  trigger: {},
};

export function isTerminalTaskStatus(status: CapabilityTaskStatus) {
  return status === "Succeeded" || status === "Failed" || status === "Cancelled" || status === "Deleted";
}

export function isTerminalRunnerStatus(status: RunnerStatus) {
  return status === "Lost" || status === "Disposing" || status === "Terminated";
}
