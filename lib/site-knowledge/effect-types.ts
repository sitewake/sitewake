import type { FailureClass } from "../capability-center-v2/failure-class";
import type {
  AgentRunActivity,
  AgentRunConversationTurn,
  DomReplayChunk,
  JsonValue,
  OutcomeStatus,
} from "./protocol";

export type EffectRunMode =
  | "compiled"
  | "adaptive"
  | "repair"
  | "demonstration"
  | "unknown";

export type EffectFailureCategory =
  | "none"
  | "user-cancelled"
  | "capability-gap"
  | "capability-mismatch"
  | "knowledge-gap"
  | "page-drift"
  | "human-boundary"
  | "runtime-timeout"
  | "runner-unavailable"
  | "model-error"
  | "business-result"
  | "unknown";

export type EffectAssessmentStatus = "evaluated" | "legacy";

export type EffectCompletionVerdict =
  | "verified-success"
  | "valid-no-result"
  | "valid-business-rejection"
  | "claimed-success"
  | "unknown"
  | "failed"
  | "cancelled";

export type EffectCompletionMethod =
  | "capability-direct"
  | "capability-assisted"
  | "knowledge-route"
  | "current-page-reading"
  | "exploration"
  | "exploration-recovery"
  | "conversation"
  | "mixed"
  | "unknown";

export type EffectEvidenceRef = {
  id: string;
  kind:
    | "program-postcondition"
    | "page-snapshot"
    | "page-transition"
    | "knowledge-receipt"
    | "capability-receipt"
    | "business-outcome"
    | "agent-report";
  label: string;
  url?: string;
};

export type EffectKnowledgeContribution =
  | "none"
  | "queried-only"
  | "route-assisted"
  | "answer-grounded"
  | "decisive"
  | "gap";

export type EffectCapabilityContribution =
  | "none"
  | "invoked-only"
  | "assisted"
  | "direct"
  | "failed-recovered"
  | "failed";

export type EffectRunFact = {
  runId: string;
  siteAgentId: string;
  actorKey: string;
  source: "agent-run" | "episode";
  goal: string;
  status: "completed" | "failed" | "cancelled";
  outcomeStatus: OutcomeStatus | "cancelled";
  outcomeCode: string;
  outcomeSummary: string;
  mode: EffectRunMode;
  capabilityId?: string;
  capabilityIds: string[];
  capabilityUsed: boolean;
  knowledgeUsed: boolean;
  knowledgeSucceeded: boolean;
  assessmentStatus: EffectAssessmentStatus;
  completionVerdict: EffectCompletionVerdict;
  completionMethod: EffectCompletionMethod;
  completionConfidence: "high" | "medium" | "low";
  completionReason: string;
  evidenceRefs: EffectEvidenceRef[];
  knowledgeContribution: EffectKnowledgeContribution;
  knowledgeReason: string;
  capabilityContribution: EffectCapabilityContribution;
  capabilityReason: string;
  adaptive: boolean;
  repair: boolean;
  humanHandoff: boolean;
  failureCategory: EffectFailureCategory;
  /** The failure's class and stage (lib/capability-center-v2/failure-class.ts); absent on a successful run. */
  failureClass?: FailureClass;
  failureStage?: string;
  durationMs: number;
  pageCount: number;
  releaseId?: string;
  releaseVersion?: number;
  startUrl?: string;
  endUrl?: string;
  startedAt: string;
  endedAt: string;
};

export type EffectTrendPoint = {
  date: string;
  tasks: number;
  validResults: number;
  successes: number;
  capabilityRuns: number;
  knowledgeGaps: number;
};

export type EffectCapabilityMetric = {
  capabilityId: string;
  tasks: number;
  users: number;
  successes: number;
  validResults: number;
  failures: number;
  directResults: number;
  assistedResults: number;
  recoveredResults: number;
  validRate: number;
  p95DurationMs: number;
};

export type EffectKnowledgeMetric = {
  queriedTasks: number;
  usedTasks: number;
  successfulLookups: number;
  contributedTasks: number;
  groundedAnswers: number;
  routeAssists: number;
  validResults: number;
  gaps: number;
  validRate: number;
};

export type EffectIssue = {
  id: string;
  category: EffectFailureCategory;
  label: string;
  goal: string;
  tasks: number;
  users: number;
  latestAt: string;
  priority: "high" | "medium" | "low";
};

export type EffectSummary = {
  range: { from: string; to: string };
  engagement: {
    seenUsers: number;
    openedUsers: number;
    goalUsers: number;
    resultUsers: number;
    openRate: number;
    goalRate: number;
    resultRate: number;
  };
  totals: {
    tasks: number;
    users: number;
    successes: number;
    validResults: number;
    cancelled: number;
    capabilityRuns: number;
    adaptiveRuns: number;
    knowledgeGaps: number;
    verifiedResults: number;
    claimedResults: number;
    unknownResults: number;
    capabilityContributed: number;
    knowledgeContributed: number;
    explorationCompleted: number;
  };
  rates: {
    goalSuccess: number;
    validResult: number;
    capabilityReuse: number;
    adaptive: number;
    knowledgeGap: number;
    cancellation: number;
    verifiedCompletion: number;
    claimedOnly: number;
    capabilityContribution: number;
    knowledgeContribution: number;
  };
  latency: { p50Ms: number; p95Ms: number };
  trend: EffectTrendPoint[];
  capabilities: EffectCapabilityMetric[];
  knowledge: EffectKnowledgeMetric;
  issues: EffectIssue[];
  sampleLimited: boolean;
};

export type EffectRunList = {
  records: EffectRunFact[];
  nextCursor?: string;
  total: number;
};

export type EffectRunDetail = {
  fact: EffectRunFact;
  conversation: AgentRunConversationTurn[];
  activityTimeline: AgentRunActivity[];
  input: Record<string, JsonValue>;
  output: Record<string, JsonValue>;
  events: Array<{
    id: string;
    type: string;
    sequence: number;
    payload: Record<string, JsonValue>;
    createdAt: string;
  }>;
  receipts: Array<{
    id: string;
    status: string;
    payload: Record<string, JsonValue>;
    createdAt: string;
  }>;
  replayChunks: DomReplayChunk[];
};

export type EffectAnalysisStatus =
  | "queued"
  | "analyzing"
  | "reviewing"
  | "completed"
  | "failed";

export type EffectGoalStatus =
  | "achieved"
  | "partially-achieved"
  | "not-achieved"
  | "insufficient-evidence";

export type EffectContribution =
  | "direct"
  | "supporting"
  | "none"
  | "unknown";

export type EffectAttributionArea = "capability" | "knowledge" | "page";

export type EffectIssueCode =
  | "none"
  | "capability-unavailable"
  | "capability-routing-missed"
  | "capability-call-failed"
  | "capability-output-mismatch"
  | "knowledge-query-failed"
  | "knowledge-missing"
  | "knowledge-irrelevant"
  | "knowledge-unused"
  | "page-target-not-found"
  | "page-operation-failed"
  | "page-state-unchanged"
  | "page-unverifiable";

export type EffectImprovementKind =
  | "create-capability"
  | "repair-capability"
  | "improve-routing"
  | "add-knowledge";

export type EffectFactRef = {
  id: string;
  source: "activity" | "receipt" | "outcome" | "conversation";
  label: string;
};

export type EffectGoalCheck = {
  id: string;
  requirement: string;
  status: "met" | "partially-met" | "unmet" | "unknown";
  factRefs: EffectFactRef[];
};

export type EffectAttribution = {
  area: EffectAttributionArea;
  subjectId?: string;
  subjectName: string;
  used: boolean;
  execution: "not-used" | "succeeded" | "failed" | "unknown";
  contribution: EffectContribution;
  issue: EffectIssueCode;
  factRefs: EffectFactRef[];
};

export type EffectImprovementItem = {
  id: string;
  runId: string;
  siteAgentId: string;
  kind: EffectImprovementKind;
  status: "pending";
  targetId?: string;
  title: string;
  factRefs: EffectFactRef[];
  sourceRunIds: string[];
  reviewed: boolean;
  createdAt: string;
};

export type SubmissionAnalysis = {
  version: 1;
  runId: string;
  siteAgentId: string;
  actorKey: string;
  submission: string;
  submittedAt: string;
  finishedAt: string;
  status: EffectAnalysisStatus;
  goalStatus?: EffectGoalStatus;
  goalChecks: EffectGoalCheck[];
  attributions: EffectAttribution[];
  primaryIssue: EffectIssueCode;
  improvements: EffectImprovementItem[];
  reviewed: boolean;
  confidence?: number;
  model?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

export type EffectAnalysisJob = {
  id: string;
  runId: string;
  siteAgentId: string;
  status: EffectAnalysisStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type EffectTrackingSummary = {
  range: { from: string; to: string };
  queue: Record<EffectAnalysisStatus, number>;
  goal: { achieved: number; analyzed: number; rate: number };
  capability: { contributed: number; invoked: number; rate: number };
  pendingImprovements: number;
};

export type EffectSubmissionList = {
  records: SubmissionAnalysis[];
  nextCursor?: string;
  total: number;
};

/**
 * What one submission handed over to the capability centre, or why it did not.
 *
 * Two facts are kept apart on purpose. `delivered` is our own side's judgement,
 * recomputed from the stored Episode; `downstream` is the far side's state. A
 * submission whose payload can be derived but which the capability centre never
 * recorded is exactly the failure worth seeing, so it must not be collapsed
 * into a single "handed over" verdict.
 */
export type CapabilityHandoffBlockedReason =
  | "noEpisode"
  | "run-cancelled"
  | "run-unfinished"
  | "not-adaptive"
  | "capability-call"
  | "capability-repair"
  | "no-experience-evidence"
  | "outcome-not-eligible"
  | "no-page-action"
  | "payload-too-large"
  | "malformed";

export type CapabilityHandoffDownstream = {
  state: "new-capability" | "reinforced" | "rejected" | "unconfirmed" | "queued" | "generating" | "intake-failed" | "task-created" | "duplicate" | "disabled" | "legacy";
  intakeId?: string;
  signalId?: string;
  disposition?: string;
  proposalId?: string;
  taskId?: string;
  summary?: string;
  capabilityId?: string;
  capabilityName?: string;
  capabilityStatus?: string;
};

/** Both sides' reading of the same execution, never reconciled by us. */
export type CapabilityHandoffJudgement = {
  userAgentEffect?: "read" | "reversible-write" | "irreversible-write";
  capabilityOperation?: "read" | "write";
  capabilitySideEffectMode?: string;
  agrees?: boolean;
};

export type CapabilityHandoffEpisodeView = {
  episodeId: string;
  mode: string;
  goal: string;
  outcomeStatus: string;
  outcomeCode: string;
  startedAt: string;
  endedAt: string;
  startPageUrl: string;
  endPageUrl: string;
  actionCount: number;
  episodeBytes: number;
  delivered: boolean;
  blockedReason?: CapabilityHandoffBlockedReason;
  payloadBytes?: number;
  /** The redacted CapabilityExperience, shaped exactly as it would be sent. */
  experience?: JsonValue;
  /**
   * The last artefact before a capability is authored: what generation is
   * actually handed, after the capability centre restructures the handover.
   * Shown so the contract between the two modules — including the fields the
   * restructuring drops — can be read without querying the database.
   */
  generationInput?: JsonValue;
  downstream: CapabilityHandoffDownstream;
  judgement: CapabilityHandoffJudgement;
};

export type CapabilityHandoffView = {
  conclusion: "delivered" | "not-delivered" | "pending";
  /** Set when nothing was handed over and one Episode-independent cause explains it. */
  reason?: CapabilityHandoffBlockedReason;
  /** False when every delivery is backed by the durable intake receipt. */
  derived: boolean;
  episodes: CapabilityHandoffEpisodeView[];
};

export type EffectSubmissionDetail = {
  analysis: SubmissionAnalysis;
  conversation: AgentRunConversationTurn[];
  activityTimeline: AgentRunActivity[];
  receipts: Array<{
    id: string;
    status: string;
    payload: Record<string, JsonValue>;
    createdAt: string;
  }>;
  capabilityHandoff: CapabilityHandoffView;
};
