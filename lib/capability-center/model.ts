import type {
  CapabilityRevisionImplementation,
  BrowserArtifact,
  ExecutionRequirements,
  JsonSchema,
  JsonValue,
} from "../site-knowledge/protocol";

export type CapabilityStatus = "draft" | "draft_failed" | "active" | "degraded" | "unpublished" | "deleted";
export type CapabilityVersionStatus = "draft" | "awaiting-review" | "published" | "failed" | "superseded";
export type CapabilityProposalKind = "new" | "improvement" | "repair";
export type CapabilityProposalStatus = "pending" | "analyzing" | "accepted" | "duplicate" | "blocked" | "rejected" | "failed";
export type CapabilityTaskType = "generate" | "repair" | "validate";
export type CapabilityTaskStatus = "queued" | "running" | "awaiting-review" | "completed" | "failed" | "rejected" | "cancelled" | "archived";
export type CapabilityTaskStage = "queued" | "author" | "validate" | "review" | "publish" | "complete";

export type CapabilityAcceptanceCriterion = {
  id: string;
  label: string;
  kind: "url" | "text" | "output" | "checkpoint" | "side-effect";
  operator: "equals" | "contains" | "exists" | "changed" | "unchanged" | "recorded";
  expected?: JsonValue;
  field?: string;
  required: boolean;
};

/**
 * Stable, implementation-independent definition of what proves a Capability
 * has completed. Like the input/output schema, this belongs to Capability and
 * must not drift between versions.
 */
export type CapabilityAcceptanceSpec = {
  version: 1;
  criteria: CapabilityAcceptanceCriterion[];
  requiredEvidence: Array<"before-screenshot" | "after-screenshot" | "validation-video">;
  sideEffectPolicy: {
    mode: "read-only" | "reversible" | "irreversible";
    requiredCheckpoints: Array<"login" | "captcha" | "payment" | "confirmation">;
    requireIdempotencyKey: boolean;
  };
};

/** Stable capability identity and public contract. Implementations belong to versions. */
export type Capability = {
  id: string;
  siteAgentId: string;
  stableKey: string;
  intentKey: string;
  name: string;
  localizedNames: { zhCN: string; en: string };
  description: string;
  goalTemplate: string;
  kind: "navigation" | "task";
  structure: "atomic" | "composite";
  operation: "read" | "write";
  exposure: "public" | "internal";
  resultKind: "page" | "data" | "action";
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  acceptanceSpec: CapabilityAcceptanceSpec;
  executionRequirements: ExecutionRequirements;
  status: CapabilityStatus;
  currentVersionId?: string;
  latestVersionId?: string;
  unpublishedAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CapabilityTaskDetail = {
  task: CapabilityTask;
  artifacts: BrowserArtifact[];
  capability?: Capability;
  version?: CapabilityVersion;
  verification: CapabilityVerificationProof;
};

export type CapabilityVerificationCheck = {
  id: string;
  label: string;
  expected: string;
  actual: string;
  status: "passed" | "failed" | "incomplete";
  evidenceArtifactIds: string[];
};

export type CapabilityVerificationProof = {
  status: "passed" | "failed" | "incomplete";
  summary: string;
  runId?: string;
  goal?: string;
  startUrl?: string;
  endUrl?: string;
  checkedAt?: string;
  checks: CapabilityVerificationCheck[];
  evidenceArtifactIds: string[];
  evidenceRoles: Partial<Record<"before-screenshot" | "after-screenshot" | "keyframe" | "validation-video" | "trace", string[]>>;
  source: "task-runner" | "legacy-browser-run" | "version-only" | "missing";
};

/** Immutable executable snapshot. The input/output contract is intentionally not copied here. */
export type CapabilityVersion = {
  id: string;
  siteAgentId: string;
  capabilityId: string;
  version: number;
  status: CapabilityVersionStatus;
  implementation?: CapabilityRevisionImplementation;
  validation?: {
    status: "pending" | "running" | "passed" | "failed";
    input?: Record<string, JsonValue>;
    runId?: string;
    startUrl?: string;
    validatedContentHash?: string;
    failureClass?: string;
    summary?: string;
  };
  sourceReleaseId?: string;
  sourceReleaseVersion?: number;
  publishedReleaseId?: string;
  publishedReleaseVersion?: number;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
};

export type CapabilityProposal = {
  id: string;
  siteAgentId: string;
  kind: CapabilityProposalKind;
  status: CapabilityProposalStatus;
  title: string;
  description: string;
  requestedGoal: string;
  input: Record<string, JsonValue>;
  capabilityId?: string;
  duplicateCapabilityId?: string;
  sourceEpisodeId?: string;
  analysis?: Record<string, JsonValue>;
  failure?: { code: string; summary: string };
  archivedAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CapabilityTaskAttempt = {
  number: number;
  startedAt: string;
  endedAt?: string;
  status: "running" | "passed" | "failed";
  runnerId?: string;
  error?: { code: string; summary: string };
};

export type CapabilityTask = {
  id: string;
  siteAgentId: string;
  proposalId?: string;
  capabilityId?: string;
  capabilityVersionId?: string;
  type: CapabilityTaskType;
  status: CapabilityTaskStatus;
  stage: CapabilityTaskStage;
  attempts: CapabilityTaskAttempt[];
  result: Record<string, JsonValue>;
  evidence: Record<string, JsonValue>;
  error?: { code: string; summary: string };
  review?: {
    status: "pending" | "approved" | "rejected";
    reviewer?: "administrator" | "ai";
    feedback?: string;
    decidedAt?: string;
  };
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CapabilityExecutionSummary = {
  id: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  summary?: string;
};

export type CapabilityDetail = {
  capability: Capability;
  versions: CapabilityVersion[];
  tasks: CapabilityTask[];
  userExecutions: CapabilityExecutionSummary[];
  systemValidations: CapabilityTask[];
};
