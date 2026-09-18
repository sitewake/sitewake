import type {
  CapabilityArtifact,
  CapabilityTask,
  CapabilityTaskEvent,
  JsonObject,
  JsonValue,
} from "./model";
import type {
  AgentRun,
  AgentRunEvent,
  DomReplayChunk,
} from "../site-knowledge/protocol";

export const CAPABILITY_DEBUG_SCHEMA_VERSION = "capability-debug.v1" as const;

export type DebugTraceKind = "generation" | "usage" | "evolution";
export type DebugTraceStatus = "running" | "waiting" | "succeeded" | "handled" | "rejected" | "failed" | "cancelled";
export type DebugNodeState = "pending" | "running" | "succeeded" | "handled" | "failed" | "skipped" | "unavailable";
export type DebugLifecycle = "started" | "progress" | "output" | "completed" | "handled" | "failed" | "skipped";
export type DebugComponent = "client-sdk" | "agent-run-api" | "experience-api" | "control-plane" | "runner" | "model" | "browser" | "reviewer" | "effect";
export type DebugDataQuality = "complete" | "partial" | "legacy" | "retention-limited" | "write-unconfirmed";

export type DebugValue = {
  schemaRef: string;
  value?: JsonValue;
  hash?: string;
  bytes?: number;
  omittedReason?: "sensitive" | "oversize";
};

export type CapabilityDebugEvent = {
  schemaVersion: typeof CAPABILITY_DEBUG_SCHEMA_VERSION;
  eventId: string;
  occurredAt: string;
  trace: {
    id: string;
    kind: DebugTraceKind;
    parentTraceId?: string;
    relatedTraceIds?: string[];
  };
  lifecycle: DebugLifecycle;
  severity: "debug" | "info" | "warn" | "error";
  module: {
    id: string;
    phase: string;
    component: DebugComponent;
    attempt: number;
  };
  correlation: {
    siteId: string;
    agentRunId?: string;
    episodeId?: string;
    taskId?: string;
    runnerId?: string;
    invocationId?: string;
    capabilityId?: string;
    versionId?: string;
    validationCaseId?: string;
    stageId?: string;
    pageEpoch?: number;
  };
  message?: string;
  io?: { input?: DebugValue; output?: DebugValue };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    sideEffectStarted?: boolean;
    rootCause?: boolean;
  };
  evidence?: {
    artifactIds?: string[];
    replayRunId?: string;
    urlBefore?: string;
    urlAfter?: string;
  };
  redaction: {
    mode: "allowlist";
    redactedPaths: string[];
    truncated: boolean;
  };
};

export type DebugModuleDefinition = {
  id: string;
  traceKinds: DebugTraceKind[];
  phase: string;
  label: string;
  component: DebugComponent;
  inputSchema: JsonObject;
  outputSchema: JsonObject;
};

export type DebugTraceNode = {
  id: string;
  moduleId: string;
  label: string;
  phase: string;
  component: DebugComponent;
  state: DebugNodeState;
  observed: boolean;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  input?: DebugValue;
  output?: DebugValue;
  error?: CapabilityDebugEvent["error"];
  evidence?: CapabilityDebugEvent["evidence"];
  correlation: CapabilityDebugEvent["correlation"];
  dataQuality: DebugDataQuality;
  eventIds: string[];
};

export type DebugTraceEdge = { id: string; from: string; to: string };

export type DebugTraceSummary = {
  id: string;
  kind: DebugTraceKind;
  title: string;
  source: "User" | "Admin" | "System";
  status: DebugTraceStatus;
  userOutcome?: string;
  automationOutcome?: string;
  startedAt: string;
  updatedAt: string;
  durationMs?: number;
  currentModuleId?: string;
  firstFailure?: { moduleId: string; code: string; message: string; eventId?: string };
  siteId: string;
  agentRunId?: string;
  rootTaskId?: string;
  capabilityId?: string;
  versionId?: string;
  relatedTraceIds: string[];
  dataQuality: DebugDataQuality;
};

export type DebugValidationCell = {
  caseId: string;
  stageId: string;
  state: DebugNodeState;
  durationMs?: number;
  eventId?: string;
};

export type DebugTraceDetail = {
  summary: DebugTraceSummary;
  phases: Array<{ id: string; label: string; state: DebugNodeState; nodeIds: string[] }>;
  nodes: DebugTraceNode[];
  edges: DebugTraceEdge[];
  events: CapabilityDebugEvent[];
  moduleDefinitions: DebugModuleDefinition[];
  artifacts: CapabilityArtifact[];
  replayChunks: DomReplayChunk[];
  validationMatrix: {
    cases: Array<{ id: string; label: string; input: JsonValue }>;
    stages: Array<{ id: string; label: string }>;
    cells: DebugValidationCell[];
  };
  relatedTraces: DebugTraceSummary[];
  cursor: string;
};

const objectSchema = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: "object",
  properties,
  required,
  additionalProperties: true,
});

const stringSchema = { type: "string" } satisfies JsonObject;
const booleanSchema = { type: "boolean" } satisfies JsonObject;
const jsonSchema = {} satisfies JsonObject;

export const CAPABILITY_DEBUG_MODULES: DebugModuleDefinition[] = [
  { id: "request.receive", traceKinds: ["generation", "usage", "evolution"], phase: "request", label: "用户问题 / 自动化触发", component: "client-sdk", inputSchema: objectSchema({ goal: stringSchema, input: jsonSchema, conversation: { type: "array" } }), outputSchema: objectSchema({ agentRunId: stringSchema, accepted: booleanSchema }) },
  { id: "agent-run.authorize", traceKinds: ["generation"], phase: "trust", label: "AgentRun 授权", component: "agent-run-api", inputSchema: objectSchema({ siteId: stringSchema, agentRunId: stringSchema, episodeId: stringSchema, browserSessionId: stringSchema }), outputSchema: objectSchema({ authorized: booleanSchema, triggerAuthority: stringSchema }) },
  { id: "experience.compact", traceKinds: ["generation"], phase: "trust", label: "Experience 抽取与压缩", component: "client-sdk", inputSchema: objectSchema({ episode: jsonSchema, output: jsonSchema }), outputSchema: objectSchema({ experience: jsonSchema, bytes: { type: "number" } }) },
  { id: "experience.validate", traceKinds: ["generation"], phase: "trust", label: "Experience Schema / URL / 大小校验", component: "experience-api", inputSchema: objectSchema({ sourceAgentRunId: stringSchema, experience: jsonSchema }), outputSchema: objectSchema({ accepted: booleanSchema }) },
  { id: "request.idempotency", traceKinds: ["generation", "evolution"], phase: "trust", label: "幂等检查", component: "control-plane", inputSchema: objectSchema({ scope: stringSchema, idempotencyKey: stringSchema, requestHash: stringSchema }), outputSchema: objectSchema({ replay: booleanSchema }) },
  { id: "experience.abstract", traceKinds: ["generation"], phase: "semantics", label: "AI 语义抽象", component: "model", inputSchema: objectSchema({ experience: jsonSchema }), outputSchema: objectSchema({ name: stringSchema, description: stringSchema, aliases: { type: "array" }, intent: stringSchema, parameters: { type: "array" }, scope: jsonSchema }) },
  { id: "semantic.analyze", traceKinds: ["generation", "evolution"], phase: "semantics", label: "Trace Semantic Analyzer", component: "control-plane", inputSchema: objectSchema({ goal: stringSchema, experience: jsonSchema, trace: jsonSchema }), outputSchema: objectSchema({ semantic: jsonSchema, dependencies: { type: "array" } }) },
  { id: "dependency.ledger", traceKinds: ["generation", "evolution"], phase: "semantics", label: "Dependency Ledger", component: "control-plane", inputSchema: objectSchema({ semantic: jsonSchema, observations: { type: "array" }, program: jsonSchema }), outputSchema: objectSchema({ entries: { type: "array" }, decisions: { type: "array" } }) },
  { id: "scope.resolve", traceKinds: ["generation", "evolution"], phase: "semantics", label: "Scope Resolver", component: "control-plane", inputSchema: objectSchema({ dependencies: { type: "array" }, parameters: jsonSchema, paths: { type: "array" } }), outputSchema: objectSchema({ scope: jsonSchema, decision: stringSchema, entryPolicy: jsonSchema }) },
  { id: "seed.build", traceKinds: ["generation", "evolution"], phase: "semantics", label: "Capability Seed", component: "control-plane", inputSchema: objectSchema({ semantic: jsonSchema, scope: jsonSchema, summary: jsonSchema }), outputSchema: objectSchema({ seed: jsonSchema, contractSeed: jsonSchema }) },
  { id: "capability.classify", traceKinds: ["generation", "evolution"], phase: "semantics", label: "能力分类（B 边界）", component: "control-plane", inputSchema: objectSchema({ capabilityGenerationInput: jsonSchema }), outputSchema: objectSchema({ classification: jsonSchema }) },
  { id: "capability.dedupe", traceKinds: ["generation", "evolution"], phase: "semantics", label: "语义去重", component: "control-plane", inputSchema: objectSchema({ name: stringSchema, candidateSummary: jsonSchema }), outputSchema: objectSchema({ duplicate: booleanSchema, existingCapabilityId: stringSchema }) },
  { id: "task.create", traceKinds: ["generation", "evolution"], phase: "build", label: "GenerationTask 创建（B 输出）", component: "control-plane", inputSchema: objectSchema({ capabilityGenerationInput: jsonSchema }), outputSchema: objectSchema({ generationTask: jsonSchema }) },
  { id: "runspec.build", traceKinds: ["generation", "evolution"], phase: "build", label: "Discovery RunSpec 编译（B 内部）", component: "control-plane", inputSchema: objectSchema({ generationTask: jsonSchema }), outputSchema: objectSchema({ runSpec: jsonSchema }) },
  { id: "runner.dispatch", traceKinds: ["generation", "evolution"], phase: "build", label: "Runner 调度与租约", component: "control-plane", inputSchema: objectSchema({ taskId: stringSchema, runSpecId: stringSchema }), outputSchema: objectSchema({ runnerId: stringSchema, lease: jsonSchema }) },
  { id: "runner.preflight", traceKinds: ["generation", "evolution"], phase: "build", label: "Runner Preflight", component: "runner", inputSchema: objectSchema({ runSpec: jsonSchema }), outputSchema: objectSchema({ valid: booleanSchema, startUrl: stringSchema }) },
  { id: "browser.authenticate", traceKinds: ["generation", "evolution"], phase: "build", label: "认证状态初始化", component: "browser", inputSchema: objectSchema({ auth: jsonSchema, startUrl: stringSchema }), outputSchema: objectSchema({ storageStateReady: booleanSchema }) },
  { id: "browser.explore", traceKinds: ["generation", "evolution"], phase: "build", label: "浏览器探索", component: "browser", inputSchema: objectSchema({ goal: stringSchema, parameters: jsonSchema, page: jsonSchema }), outputSchema: objectSchema({ actions: { type: "array" }, endPage: jsonSchema, targetEvidence: { type: "array" }, scope: jsonSchema, inputAliases: jsonSchema }) },
  { id: "contract.design", traceKinds: ["generation", "evolution"], phase: "build", label: "Contract 设计（C1）", component: "model", inputSchema: objectSchema({ goal: stringSchema, exploration: jsonSchema, scope: jsonSchema }), outputSchema: objectSchema({ contract: jsonSchema, groundingExamples: { type: "array" }, scope: jsonSchema, inputAliases: jsonSchema }) },
  { id: "program.author", traceKinds: ["generation", "evolution"], phase: "build", label: "Program / Stage 编写", component: "model", inputSchema: objectSchema({ contract: jsonSchema, trace: jsonSchema }), outputSchema: objectSchema({ source: stringSchema, program: jsonSchema, promptProvenance: { type: "array" } }) },
  { id: "module.persist", traceKinds: ["generation", "evolution"], phase: "build", label: "Module 持久化与完整性", component: "control-plane", inputSchema: objectSchema({ source: stringSchema }), outputSchema: objectSchema({ moduleUrl: stringSchema, contentHash: stringSchema }) },
  { id: "draft.replay", traceKinds: ["generation", "evolution"], phase: "build", label: "候选 Program 编写回放（C1）", component: "runner", inputSchema: objectSchema({ program: jsonSchema, demonstrationParameters: jsonSchema }), outputSchema: objectSchema({ stageReceipts: { type: "array" }, output: jsonSchema }) },
  { id: "quality.gate", traceKinds: ["generation", "evolution"], phase: "build", label: "确定性质量门禁", component: "control-plane", inputSchema: objectSchema({ contract: jsonSchema, program: jsonSchema, source: stringSchema }), outputSchema: objectSchema({ valid: booleanSchema, issues: { type: "array" } }) },
  { id: "case.generate-compile", traceKinds: ["generation", "evolution"], phase: "build", label: "真实页面探索、ValidationSuite 生成、校验与 Artifact 提交（C2）", component: "model", inputSchema: objectSchema({ c2CaseGenerationInput: jsonSchema }), outputSchema: objectSchema({ c2CaseGenerationOutput: jsonSchema, candidateArtifact: jsonSchema, validationTaskId: stringSchema, caseDiscoveryEvidenceRef: jsonSchema, validationSuiteHash: stringSchema }) },
  { id: "capability.materialize", traceKinds: ["generation", "evolution"], phase: "build", label: "历史能力结果物化", component: "control-plane", inputSchema: objectSchema({ candidateSummary: jsonSchema, candidateProgram: jsonSchema }), outputSchema: objectSchema({ capabilityId: stringSchema, versionId: stringSchema }) },
  { id: "validation.create", traceKinds: ["generation", "evolution"], phase: "validate", label: "C3 ValidationTask 创建（C2 内部提交）", component: "control-plane", inputSchema: objectSchema({ candidateArtifact: jsonSchema }), outputSchema: objectSchema({ candidateValidationTask: jsonSchema }) },
  { id: "validation.replay", traceKinds: ["generation", "evolution"], phase: "validate", label: "独立 Case 回放", component: "runner", inputSchema: objectSchema({ case: jsonSchema, program: jsonSchema, caseIndex: { type: "number" }, caseCount: { type: "number" } }), outputSchema: objectSchema({ outcome: stringSchema, stageReceipts: { type: "array" }, evidence: { type: "array" } }) },
  { id: "validation.judge", traceKinds: ["generation", "evolution"], phase: "validate", label: "C3 确定性验证结果（无 AI）", component: "runner", inputSchema: objectSchema({ candidateValidationTask: jsonSchema, caseResults: { type: "array" }, contractHash: stringSchema, programHash: stringSchema, validationSuiteHash: stringSchema }), outputSchema: objectSchema({ buildResult: jsonSchema, validationResults: { type: "array" } }) },
  { id: "review.ai", traceKinds: ["generation", "evolution"], phase: "publish", label: "AI Review", component: "reviewer", inputSchema: objectSchema({ capability: jsonSchema, version: jsonSchema, validation: jsonSchema }), outputSchema: objectSchema({ decision: stringSchema, reason: stringSchema }) },
  { id: "version.publish", traceKinds: ["generation", "evolution"], phase: "publish", label: "D 能力入库（一次性写入）", component: "control-plane", inputSchema: objectSchema({ publishInput: jsonSchema }), outputSchema: objectSchema({ publishResult: jsonSchema }) },
  { id: "capability.search", traceKinds: ["usage"], phase: "select", label: "能力搜索与选择", component: "client-sdk", inputSchema: objectSchema({ queries: { type: "array" }, limit: { type: "number" } }), outputSchema: objectSchema({ capabilityId: stringSchema, versionId: stringSchema, candidates: { type: "array" } }) },
  { id: "runtime.fetch", traceKinds: ["usage"], phase: "load", label: "Runtime Snapshot 获取", component: "client-sdk", inputSchema: objectSchema({ capabilityId: stringSchema }), outputSchema: objectSchema({ contract: jsonSchema, program: jsonSchema, versionId: stringSchema }) },
  { id: "runtime.integrity", traceKinds: ["usage"], phase: "load", label: "Module Hash / Manifest 校验", component: "client-sdk", inputSchema: objectSchema({ moduleUrl: stringSchema, expectedHash: stringSchema, manifest: jsonSchema }), outputSchema: objectSchema({ actualHash: stringSchema, valid: booleanSchema }) },
  { id: "runtime.input", traceKinds: ["usage"], phase: "guard", label: "Input Schema 校验", component: "client-sdk", inputSchema: objectSchema({ schema: jsonSchema, value: jsonSchema }), outputSchema: objectSchema({ valid: booleanSchema, missing: { type: "array" } }) },
  { id: "runtime.preconditions", traceKinds: ["usage"], phase: "guard", label: "入口导航与 Preconditions", component: "client-sdk", inputSchema: objectSchema({ entry: jsonSchema, conditions: { type: "array" }, page: jsonSchema }), outputSchema: objectSchema({ valid: booleanSchema, pageEpoch: { type: "number" } }) },
  { id: "runtime.stage", traceKinds: ["usage"], phase: "execute", label: "JavaScript Stage", component: "browser", inputSchema: objectSchema({ stage: jsonSchema, input: jsonSchema, state: jsonSchema, urlBefore: stringSchema }), outputSchema: objectSchema({ outcome: stringSchema, state: jsonSchema, output: jsonSchema, evidence: { type: "array" }, urlAfter: stringSchema }) },
  { id: "runtime.handoff", traceKinds: ["usage"], phase: "execute", label: "Checkpoint / Handoff", component: "agent-run-api", inputSchema: objectSchema({ pageEpoch: { type: "number" }, cursor: jsonSchema, destinationUrl: stringSchema }), outputSchema: objectSchema({ resumed: booleanSchema, pageEpoch: { type: "number" } }) },
  { id: "runtime.output", traceKinds: ["usage"], phase: "verify", label: "Output / Success Conditions", component: "client-sdk", inputSchema: objectSchema({ schema: jsonSchema, output: jsonSchema, conditions: { type: "array" } }), outputSchema: objectSchema({ valid: booleanSchema, outcome: stringSchema }) },
  { id: "run.finish", traceKinds: ["usage"], phase: "complete", label: "AgentRun 终态", component: "agent-run-api", inputSchema: objectSchema({ outcome: jsonSchema, output: jsonSchema }), outputSchema: objectSchema({ status: stringSchema, persisted: booleanSchema }) },
  { id: "effect.project", traceKinds: ["usage"], phase: "complete", label: "Effect 投影", component: "effect", inputSchema: objectSchema({ agentRun: jsonSchema, receipts: { type: "array" } }), outputSchema: objectSchema({ fact: jsonSchema, analysis: jsonSchema }) },
];

export const CAPABILITY_DEBUG_PHASE_LABELS: Record<string, string> = {
  request: "触发",
  trust: "授权与接入",
  semantics: "抽象与去重",
  build: "构建",
  validate: "独立验证",
  publish: "审核与发布",
  select: "检索与选择",
  load: "运行时加载",
  guard: "输入与前置条件",
  execute: "Stage 执行",
  verify: "结果验证",
  complete: "终态与 Effect",
};

// `storageState` itself contains cookies and must be redacted, but the
// boolean audit field `storageStateReady` is safe and is part of the public
// browser.authenticate output schema.  Anchor the sensitive token so the
// readiness flag remains visible in data-flow logs.
const sensitiveKey = /(?:password|passwd|secret|token|cookie|authorization|otp|credential|storage[_-]?state(?:$|[_-]?(?:json|value|data))|browser[_-]?session[_-]?id|session[_-]?(?:cookie|token)|private[_-]?key|api[_-]?key|raw[_-]?(?:html|dom)|page[_-]?(?:html|text)|body[_-]?(?:html|text))/iu;
const urlKey = /(?:url|href)(?:before|after)?$/iu;
const MAX_STRING = 1_000;
const MAX_ARRAY = 20;
const MAX_KEYS = 30;
const MAX_DEPTH = 5;
const MAX_INLINE_BYTES = 16 * 1024;

type SanitizeState = { redactedPaths: string[]; truncated: boolean };

function stripUrlSecrets(value: string) {
  return value.replace(/https?:\/\/[^\s<>"']+/giu, (candidate) => {
    try {
      const url = new URL(candidate);
      return `${url.origin}${url.pathname}`;
    } catch {
      return candidate;
    }
  });
}

function authenticationPageUrl(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    return /(?:^|\/)(?:login|log-in|signin|sign-in|auth|oauth|sso|verify|mfa|2fa)(?:\/|$)/iu.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

function sanitizeValue(value: unknown, path: string, depth: number, state: SanitizeState): JsonValue {
  if (depth > MAX_DEPTH) { state.truncated = true; return "[truncated]"; }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    let safeValue = value;
    if (urlKey.test(path.split(".").at(-1) || "")) {
      try { const url = new URL(value); safeValue = `${url.origin}${url.pathname}`; } catch { /* not a URL */ }
    } else {
      safeValue = stripUrlSecrets(value);
    }
    const redacted = safeValue
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/giu, "[redacted-auth]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted-jwt]")
      .replace(/\b(?:password|passwd|token|secret|otp|验证码)\s*[:=：]\s*[^\s,;，；]+/giu, "[redacted-credential]")
      .replace(/\b\d{6}\b/gu, "[redacted-otp]");
    if (redacted !== value) state.redactedPaths.push(path || "$value");
    if (redacted.length > MAX_STRING) { state.truncated = true; return `${redacted.slice(0, MAX_STRING)}…`; }
    return redacted;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY) state.truncated = true;
    return value.slice(0, MAX_ARRAY).map((item, index) => sanitizeValue(item, `${path}.${index}`, depth + 1, state));
  }
  if (!value || typeof value !== "object") return String(value ?? "");
  const source = value as Record<string, unknown>;
  const startPage = source.startPage && typeof source.startPage === "object" && !Array.isArray(source.startPage) ? source.startPage as Record<string, unknown> : undefined;
  const endPage = source.endPage && typeof source.endPage === "object" && !Array.isArray(source.endPage) ? source.endPage as Record<string, unknown> : undefined;
  if (authenticationPageUrl(startPage?.url) || authenticationPageUrl(endPage?.url)) {
    state.redactedPaths.push(...["browserSessionId", "outcomeSummary", "actions", "output"].map((key) => path ? `${path}.${key}` : key));
    state.truncated = true;
    return {
      schemaVersion: sanitizeValue(source.schemaVersion, `${path}.schemaVersion`, depth + 1, state),
      episodeId: sanitizeValue(source.episodeId, `${path}.episodeId`, depth + 1, state),
      agentRunId: sanitizeValue(source.agentRunId, `${path}.agentRunId`, depth + 1, state),
      browserSessionId: "[redacted]",
      originalGoal: sanitizeValue(source.originalGoal, `${path}.originalGoal`, depth + 1, state),
      outcome: sanitizeValue(source.outcome, `${path}.outcome`, depth + 1, state),
      outcomeSummary: "[authentication-page-content-redacted]",
      startPage: sanitizeValue(startPage, `${path}.startPage`, depth + 1, state),
      endPage: sanitizeValue(endPage, `${path}.endPage`, depth + 1, state),
      actions: [],
      output: {},
    };
  }
  const nestedPage = source.page && typeof source.page === "object" && !Array.isArray(source.page) ? source.page as Record<string, unknown> : undefined;
  if (authenticationPageUrl(nestedPage?.url)) {
    state.redactedPaths.push(...["rawAction", "input", "element"].map((key) => path ? `${path}.${key}` : key));
    state.truncated = true;
    return {
      action: sanitizeValue(source.action, `${path}.action`, depth + 1, state),
      rawAction: "[authentication-page-content-redacted]",
      input: {},
      page: sanitizeValue(nestedPage, `${path}.page`, depth + 1, state),
      observedAt: sanitizeValue(source.observedAt, `${path}.observedAt`, depth + 1, state),
    };
  }
  if (authenticationPageUrl(source.url)) {
    state.redactedPaths.push(path || "$authPage");
    state.truncated = true;
    return {
      url: sanitizeValue(source.url, `${path}.url`, depth + 1, state),
      content: "[authentication-page-content-redacted]",
    };
  }
  const entries = Object.entries(source);
  if (entries.length > MAX_KEYS) state.truncated = true;
  const sanitized: JsonObject = {};
  for (const [key, item] of entries.slice(0, MAX_KEYS)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (sensitiveKey.test(key)) {
      sanitized[key] = "[redacted]";
      state.redactedPaths.push(nextPath);
    } else {
      sanitized[key] = sanitizeValue(item, nextPath, depth + 1, state);
    }
  }
  return sanitized;
}

function fastHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function debugValue(schemaRef: string, value: unknown, allowedTopLevelKeys?: string[]): { value: DebugValue; redaction: CapabilityDebugEvent["redaction"] } {
  const state: SanitizeState = { redactedPaths: [], truncated: false };
  let allowlisted = value;
  if (allowedTopLevelKeys && value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    allowlisted = Object.fromEntries(allowedTopLevelKeys.filter((key) => key in source).map((key) => [key, source[key]]));
    if (Object.keys(source).some((key) => !allowedTopLevelKeys.includes(key))) state.truncated = true;
  }
  const sanitized = sanitizeValue(allowlisted, "", 0, state);
  const serialized = JSON.stringify(sanitized);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_INLINE_BYTES) {
    return {
      value: { schemaRef, hash: fastHash(serialized), bytes, omittedReason: "oversize" },
      redaction: { mode: "allowlist", redactedPaths: state.redactedPaths, truncated: true },
    };
  }
  return {
    value: { schemaRef, value: sanitized, hash: fastHash(serialized), bytes },
    redaction: { mode: "allowlist", redactedPaths: state.redactedPaths, truncated: state.truncated },
  };
}

export function sanitizeDebugText(value: string | undefined, fallback = "") {
  if (!value) return fallback;
  const state: SanitizeState = { redactedPaths: [], truncated: false };
  const sanitized = sanitizeValue(value, "text", 0, state);
  return typeof sanitized === "string" ? sanitized : fallback;
}

export function makeDebugEvent(input: {
  eventId?: string;
  occurredAt?: string;
  traceId: string;
  traceKind: DebugTraceKind;
  parentTraceId?: string;
  relatedTraceIds?: string[];
  lifecycle: DebugLifecycle;
  severity?: CapabilityDebugEvent["severity"];
  moduleId: string;
  siteId: string;
  correlation?: Partial<CapabilityDebugEvent["correlation"]>;
  message?: string;
  input?: unknown;
  inputSchemaRef?: string;
  output?: unknown;
  outputSchemaRef?: string;
  error?: CapabilityDebugEvent["error"];
  evidence?: CapabilityDebugEvent["evidence"];
  attempt?: number;
}): CapabilityDebugEvent {
  const definition = CAPABILITY_DEBUG_MODULES.find((item) => item.id === input.moduleId);
  const schemaKeys = (schema: JsonObject | undefined) => {
    const properties = schema?.properties;
    return properties && typeof properties === "object" && !Array.isArray(properties) ? Object.keys(properties) : undefined;
  };
  const inputValue = input.input === undefined ? undefined : debugValue(input.inputSchemaRef || `${input.moduleId}.input`, input.input, schemaKeys(definition?.inputSchema));
  const outputValue = input.output === undefined ? undefined : debugValue(input.outputSchemaRef || `${input.moduleId}.output`, input.output, schemaKeys(definition?.outputSchema));
  const metadataState: SanitizeState = { redactedPaths: [], truncated: false };
  const message = input.message === undefined ? undefined : sanitizeValue(input.message, "message", 0, metadataState) as string;
  const error = input.error ? sanitizeValue(input.error, "error", 0, metadataState) as CapabilityDebugEvent["error"] : undefined;
  const evidence = input.evidence ? sanitizeValue(input.evidence, "evidence", 0, metadataState) as CapabilityDebugEvent["evidence"] : undefined;
  const redactedPaths = [...(inputValue?.redaction.redactedPaths || []), ...(outputValue?.redaction.redactedPaths || []), ...metadataState.redactedPaths];
  return {
    schemaVersion: CAPABILITY_DEBUG_SCHEMA_VERSION,
    eventId: input.eventId || crypto.randomUUID(),
    occurredAt: input.occurredAt || new Date().toISOString(),
    trace: { id: input.traceId, kind: input.traceKind, parentTraceId: input.parentTraceId, relatedTraceIds: input.relatedTraceIds },
    lifecycle: input.lifecycle,
    severity: input.severity || (input.lifecycle === "failed" ? "error" : input.lifecycle === "handled" ? "warn" : "info"),
    module: { id: input.moduleId, phase: definition?.phase || "request", component: definition?.component || "control-plane", attempt: Math.max(1, input.attempt || 1) },
    correlation: { siteId: input.siteId, ...input.correlation },
    message,
    io: inputValue || outputValue ? { input: inputValue?.value, output: outputValue?.value } : undefined,
    error,
    evidence,
    redaction: { mode: "allowlist", redactedPaths: [...new Set(redactedPaths)], truncated: Boolean(inputValue?.redaction.truncated || outputValue?.redaction.truncated || metadataState.truncated) },
  };
}

export function isCapabilityDebugEvent(value: unknown): value is CapabilityDebugEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<CapabilityDebugEvent>;
  return event.schemaVersion === CAPABILITY_DEBUG_SCHEMA_VERSION
    && typeof event.eventId === "string"
    && typeof event.occurredAt === "string"
    && Boolean(event.trace && typeof event.trace.id === "string")
    && Boolean(event.module && typeof event.module.id === "string");
}

export function taskTraceKind(task: CapabilityTask): DebugTraceKind {
  const mode = task.input.context.__maintenanceMode;
  return mode === "Repair" || mode === "Rebuild" || task.type === "Repair" ? "evolution" : "generation";
}

export function taskTraceId(task: CapabilityTask, rootTaskId = task.id) {
  const kind = taskTraceKind(task);
  if (kind === "generation" && task.input.experience?.episodeId) return `generation:${task.input.experience.episodeId}`;
  return `${kind}:${rootTaskId}`;
}

function moduleForTaskPayload(eventType: string, payload: JsonObject, task: CapabilityTask) {
  if (typeof payload.moduleId === "string" && CAPABILITY_DEBUG_MODULES.some((module) => module.id === payload.moduleId)) return payload.moduleId;
  const phase = typeof payload.phase === "string" ? payload.phase.toLocaleLowerCase() : "";
  if (eventType === "TaskCreated") return task.type === "Validation" ? "validation.create" : "task.create";
  if (eventType === "CandidateFrozen" || phase.includes("candidateartifact") || phase.includes("candidate-artifact")) return "case.generate-compile";
  if (eventType === "CapabilityPublished") return "version.publish";
  if (eventType === "RunSpecBuilt" || phase.includes("runspec")) return "runspec.build";
  if (eventType === "Published") return "version.publish";
  if (eventType.startsWith("Review")) return "review.ai";
  if (eventType.includes("Dispatch") || eventType.includes("RunnerLost")) return "runner.dispatch";
  if (eventType === "TaskFailed") {
    if (task.type !== "Validation") return "browser.explore";
    const step = `${task.error?.stepId || ""} ${task.error?.code || ""} ${task.error?.message || ""}`.toLocaleLowerCase();
    return step.includes("judge") || step.includes("evaluat") || /(?:^|\s)(?:success_|output_schema|capability_result)/u.test(step)
      ? "validation.judge"
      : "validation.replay";
  }
  if (eventType === "TaskCompleted") return task.type === "Validation" ? "validation.judge" : "case.generate-compile";
  if (phase.includes("preflight")) return "runner.preflight";
  // "Authoring" begins with "auth"; test the more specific authoring phase
  // first so model/program work is never mislabeled as browser authentication.
  if (phase.includes("author") || phase.includes("program") || phase.includes("building")) return "program.author";
  if (phase.includes("auth")) return "browser.authenticate";
  if (phase.includes("explor")) return "browser.explore";
  if (phase.includes("contract") || phase.includes("specification")) return "contract.design";
  if (eventType === "ModulePersisted" || phase.includes("module")) return "module.persist";
  if (phase.includes("replay")) return task.type === "Validation" ? "validation.replay" : "draft.replay";
  if (task.type === "Validation" && (phase.includes("judge") || phase.includes("evaluat") || phase.includes("buildresult") || phase.includes("validated"))) return "validation.judge";
  if (phase.includes("quality") || phase.includes("evaluat")) return "quality.gate";
  if (phase.includes("review")) return "review.ai";
  if (phase.includes("validation")) return "validation.replay";
  if (phase.includes("complete")) return task.type === "Validation" ? "validation.judge" : "capability.materialize";
  return task.type === "Validation" ? "validation.replay" : "browser.explore";
}

export function debugEventFromTaskEvent(task: CapabilityTask, event: Pick<CapabilityTaskEvent, "id" | "eventType" | "payload" | "createdAt">, rootTaskId = task.id) {
  const moduleId = moduleForTaskPayload(event.eventType, event.payload, task);
  const nestedPayload = event.payload.payload && typeof event.payload.payload === "object" && !Array.isArray(event.payload.payload) ? event.payload.payload as JsonObject : {};
  const failed = /failed|lost|error/iu.test(event.eventType) || typeof event.payload.errorCode === "string";
  const handled = event.payload.decision === "Rejected";
  const message = typeof event.payload.message === "string"
    ? event.payload.message
    : typeof event.payload.reason === "string"
      ? event.payload.reason
      : event.eventType;
  const errorCode = typeof event.payload.errorCode === "string"
    ? event.payload.errorCode
    : typeof nestedPayload.errorCode === "string"
      ? nestedPayload.errorCode
      : failed ? event.eventType : undefined;
  const replayProgress = task.type === "Validation" && moduleId === "validation.replay" && !nestedPayload.output
    ? {
      caseIndex: typeof nestedPayload.caseIndex === "number" ? nestedPayload.caseIndex : undefined,
      caseCount: typeof nestedPayload.caseCount === "number" ? nestedPayload.caseCount : undefined,
    }
    : undefined;
  const replayOutput = replayProgress
    ? { outcome: failed ? errorCode || "Failed" : "Pending", stageReceipts: [], evidence: [] }
    : undefined;
  const taskRef = { id: task.id, type: task.type, goal: task.goal, versionId: task.result?.versionId || task.versionId };
  const startUrl = typeof task.input.context.startUrl === "string" ? task.input.context.startUrl : "";
  const candidateArtifact = task.result?.candidateArtifact;
  // A task event can be read while the task row is being projected (or from
  // an older task snapshot) before the encrypted RunSpec column is exposed to
  // the admin view.  Prefer the persisted RunSpec, but retain a bounded
  // projection from the event/task input so the Debug ledger never loses the
  // module I/O envelope merely because the physical row was redacted.
  const resultRecord = task.result && typeof task.result === "object" ? task.result as unknown as Record<string, unknown> : undefined;
  const runSpec = task.runSpec || (resultRecord?.runSpec && typeof resultRecord.runSpec === "object" ? resultRecord.runSpec as NonNullable<CapabilityTask["runSpec"]> : undefined);
  const runSpecProjection = runSpec || {
    protocolVersion: "2.0" as const,
    id: typeof event.payload.runSpecId === "string" ? event.payload.runSpecId : `runspec:${task.id}`,
    taskId: task.id,
    siteId: task.siteId,
    goal: task.goal,
    browser: { startUrl, recording: true },
    input: task.input,
    plan: [{ type: task.type === "Validation" ? "Replay" as const : "Explore" as const }],
  };
  const candidateValidation = runSpec?.candidateValidation;
  const inferredInput = nestedPayload.input && typeof nestedPayload.input === "object"
    ? nestedPayload.input as JsonObject
    : moduleId === "task.create"
      ? { capabilityGenerationInput: { request: { goal: task.goal, parameters: task.input.parameters, entryUrl: startUrl }, source: task.input.context.__generationSource === "Episode" || task.sourceAgentRunId ? "Episode" : "Admin" } }
      : moduleId === "runspec.build"
        ? { generationTask: taskRef }
        : moduleId === "runner.dispatch"
          ? { taskId: task.id, runSpecId: runSpecProjection.id }
          : moduleId === "runner.preflight"
            ? { runSpec: runSpecProjection }
            : moduleId === "browser.authenticate"
              ? { auth: { required: task.input.interactions.length > 0 }, startUrl }
              : moduleId === "case.generate-compile"
                ? { c2CaseGenerationOutput: task.result?.c2CaseGenerationOutput || {}, candidateArtifact: candidateArtifact || {} }
                : moduleId === "validation.create"
                ? { candidateArtifact: candidateArtifact || candidateValidation || {} }
                : moduleId === "validation.replay"
                  ? { case: candidateValidation?.cases?.[Math.max(0, (Number(nestedPayload.caseIndex) || 1) - 1)] || {}, program: candidateValidation?.program || {}, caseIndex: Number(nestedPayload.caseIndex) || 1, caseCount: Number(nestedPayload.caseCount) || candidateValidation?.cases?.length || 1 }
                  : moduleId === "validation.judge"
                    ? { candidateValidationTask: taskRef, caseResults: task.result?.validationResults || [], contractHash: candidateValidation?.contractHash || "", programHash: candidateValidation?.programHash || "" }
                    : moduleId === "review.ai"
                      ? { capability: { id: task.result?.capabilityId || "", name: task.input.candidateSummary?.name || "" }, version: { id: task.result?.versionId || task.versionId }, validation: { taskId: task.id } }
                      : moduleId === "version.publish"
                        ? { publishInput: { generationTaskId: task.id, versionId: event.payload.versionId || task.result?.versionId || task.versionId } }
                        : event.payload;
  const inferredOutput = nestedPayload.output && typeof nestedPayload.output === "object"
    ? nestedPayload.output as JsonObject
    : replayOutput
      ? replayOutput
      : moduleId === "task.create"
        ? { generationTask: taskRef }
        : moduleId === "runspec.build"
          ? { runSpec: runSpecProjection }
          : moduleId === "runner.dispatch"
            ? { runnerId: event.payload.runnerId || task.runnerId || "", lease: { status: failed ? "failed" : "active" } }
            : moduleId === "runner.preflight"
              ? { valid: !failed, startUrl }
              : moduleId === "browser.authenticate"
                ? { storageStateReady: !failed }
              : moduleId === "case.generate-compile"
                ? { candidateArtifact: candidateArtifact || {}, validationTaskId: task.result?.validationTaskId || "" }
                : moduleId === "validation.create"
                  ? { candidateValidationTask: { id: task.id, candidateId: candidateValidation?.candidateId || candidateArtifact?.candidateId || "", contractHash: candidateValidation?.contractHash || candidateArtifact?.contractHash || "", programHash: candidateValidation?.programHash || candidateArtifact?.programHash || "" } }
                  : moduleId === "validation.judge"
                    ? { buildResult: task.result?.buildResult || {}, validationResults: task.result?.validationResults || [] }
                    : moduleId === "review.ai"
                      ? { decision: event.payload.decision || (failed ? "Error" : "Pending"), reason: typeof event.payload.reason === "string" ? event.payload.reason : message }
                      : moduleId === "version.publish"
                        ? { publishResult: { outcome: failed ? "Failed" : "Published", capabilityId: event.payload.capabilityId || task.result?.capabilityId, versionId: event.payload.versionId || task.result?.versionId } }
                        : {};
  return makeDebugEvent({
    eventId: event.id,
    occurredAt: event.createdAt,
    traceId: taskTraceId(task, rootTaskId),
    traceKind: taskTraceKind(task),
    lifecycle: failed ? "failed" : handled ? "handled" : /completed|published|candidatefrozen/iu.test(event.eventType) ? "completed" : "progress",
    moduleId,
    siteId: task.siteId,
    correlation: {
      taskId: task.id,
      runnerId: typeof event.payload.runnerId === "string" ? event.payload.runnerId : task.runnerId,
      agentRunId: task.sourceAgentRunId,
      episodeId: task.input.experience?.episodeId,
      capabilityId: task.result?.capabilityId,
      versionId: task.result?.versionId || task.versionId,
      validationCaseId: typeof nestedPayload.caseIndex === "number" ? `case-${nestedPayload.caseIndex}` : undefined,
      stageId: typeof nestedPayload.stageId === "string"
        ? nestedPayload.stageId
        : typeof event.payload.stepId === "string" ? event.payload.stepId : undefined,
    },
    message,
    input: inferredInput,
    output: inferredOutput,
    error: errorCode ? { code: errorCode, message, retryable: event.payload.retryable === true || nestedPayload.retryable === true } : undefined,
    evidence: {
      artifactIds: [...(Array.isArray(event.payload.artifactIds) ? event.payload.artifactIds : []), ...(Array.isArray(nestedPayload.artifactIds) ? nestedPayload.artifactIds : [])].filter((value): value is string => typeof value === "string"),
      urlBefore: typeof nestedPayload.urlBefore === "string" ? nestedPayload.urlBefore : undefined,
      urlAfter: typeof nestedPayload.urlAfter === "string" ? nestedPayload.urlAfter : undefined,
    },
  });
}

export function debugEventsFromAgentRunEvent(run: AgentRun, event: AgentRunEvent, traceId: string, kind: DebugTraceKind): CapabilityDebugEvent[] {
  const embedded = event.payload.debugEvents;
  if (Array.isArray(embedded)) {
    const valid = embedded.filter(isCapabilityDebugEvent);
    if (valid.length) return valid;
  }
  if (isCapabilityDebugEvent(event.payload.debugEvent)) return [event.payload.debugEvent];
  const checkpoint = event.payload as JsonObject;
  const failed = event.type === "failed";
  const moduleId = event.type === "run-created"
    ? "request.receive"
    : event.type === "port-claimed" || (event.type === "status" && checkpoint.status === "awaiting-page")
      ? "runtime.handoff"
      : event.type === "completed" || event.type === "failed" || event.type === "cancelled"
        ? "run.finish"
        : "runtime.stage";
  return [makeDebugEvent({
    eventId: event.id,
    occurredAt: event.createdAt,
    traceId,
    traceKind: kind,
    lifecycle: failed ? "failed" : event.type === "completed" || event.type === "cancelled" ? "completed" : "progress",
    moduleId,
    siteId: run.scope.siteAgentId,
    correlation: { agentRunId: run.id, capabilityId: capabilityIdFromRun(run), versionId: versionIdFromRun(run), pageEpoch: typeof checkpoint.pageEpoch === "number" ? checkpoint.pageEpoch : run.pageEpoch },
    message: typeof checkpoint.summary === "string" ? checkpoint.summary : event.type,
    input: checkpoint,
    output: event.type === "completed" || event.type === "failed" ? { status: event.type, outcome: run.outcome, output: run.output } : undefined,
    error: failed ? { code: run.outcome?.code || "agent_run_failed", message: run.outcome?.summary || "AgentRun failed", retryable: false } : undefined,
  })];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function capabilityIdFromRun(run: AgentRun) {
  const evidence = objectValue(run.outcome?.evidence);
  if (typeof evidence.capabilityId === "string") return evidence.capabilityId;
  if (typeof run.checkpoint?.capabilityId === "string") return run.checkpoint.capabilityId;
  const adaptive = objectValue(run.checkpoint?.adaptiveState);
  const runtime = objectValue(adaptive.v2Runtime);
  if (typeof runtime.capabilityId === "string") return runtime.capabilityId;
  return run.activityTimeline.findLast((item) => typeof item.capabilityId === "string")?.capabilityId;
}

export function versionIdFromRun(run: AgentRun) {
  const evidence = objectValue(run.outcome?.evidence);
  if (typeof evidence.versionId === "string") return evidence.versionId;
  const adaptive = objectValue(run.checkpoint?.adaptiveState);
  const runtime = objectValue(adaptive.v2Runtime);
  return typeof runtime.versionId === "string" ? runtime.versionId : undefined;
}

export function usageTraceId(run: AgentRun, capabilityId = capabilityIdFromRun(run)) {
  return capabilityId ? `usage:${run.id}:${capabilityId}` : `usage:${run.id}`;
}

function nodeStateForLifecycle(lifecycle: DebugLifecycle): DebugNodeState {
  if (lifecycle === "failed") return "failed";
  if (lifecycle === "handled") return "handled";
  if (lifecycle === "skipped") return "skipped";
  if (lifecycle === "started" || lifecycle === "progress" || lifecycle === "output") return "running";
  return "succeeded";
}

function dynamicNodeSuffix(event: CapabilityDebugEvent) {
  if (event.module.id === "validation.replay" && event.correlation.validationCaseId) return `:${event.correlation.validationCaseId}`;
  if (event.module.id === "runtime.stage" && event.correlation.stageId) return `:${event.correlation.stageId}`;
  return "";
}

function preferDebugValue(current: DebugValue | undefined, incoming: DebugValue | undefined) {
  if (!incoming) return current;
  if (!current) return incoming;
  const incomingValue = incoming.value;
  const currentValue = current.value;
  const incomingEmpty = incomingValue && typeof incomingValue === "object" && !Array.isArray(incomingValue) && Object.keys(incomingValue as JsonObject).length === 0;
  const currentNonEmpty = currentValue && typeof currentValue === "object" && !Array.isArray(currentValue) && Object.keys(currentValue as JsonObject).length > 0;
  // Multiple task envelopes can map to one node (for example the physical
  // RunSpecBuilt event plus the boundary event). Do not let a later legacy
  // envelope containing only `{}` erase a complete observed payload.
  if (incomingEmpty && currentNonEmpty) return current;
  return incoming;
}

// Large RunSpec/Program envelopes are intentionally omitted from the inline
// event payload.  The trace node still needs a concrete, auditable output
// value so the workbench can distinguish "large but captured" from "never
// produced". Keep the original hash/size and expose a bounded summary without
// copying the oversized document back into the response.
function nodeDebugValue(value: DebugValue | undefined): DebugValue | undefined {
  if (!value || value.value !== undefined || value.omittedReason !== "oversize") return value;
  return {
    ...value,
    value: {
      omitted: true,
      reason: value.omittedReason,
      hash: value.hash || "",
      bytes: value.bytes || 0,
    },
  };
}

/**
 * Collapses the append-only event envelope into the node read model used by
 * the workbench. The first error is deliberately kept as root cause even when
 * cleanup, Effect projection or a later retry also reports an error.
 */
export function projectDebugNodes(
  events: CapabilityDebugEvent[],
  options: { expectedModuleIds?: string[]; terminal?: boolean; terminalStatus?: DebugTraceStatus } = {},
): DebugTraceNode[] {
  const ordered = [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId));
  const firstFailureId = ordered.find((event) => event.lifecycle === "failed")?.eventId;
  const firstFailureAt = ordered.find((event) => event.lifecycle === "failed")?.occurredAt;
  const nodes = new Map<string, DebugTraceNode>();
  const lastEventAt = new Map<string, string>();
  for (const event of ordered) {
    const id = `${event.module.id}${dynamicNodeSuffix(event)}`;
    const definition = CAPABILITY_DEBUG_MODULES.find((item) => item.id === event.module.id);
    const existing = nodes.get(id);
    const state = nodeStateForLifecycle(event.lifecycle);
    const startedAt = existing?.startedAt && existing.startedAt < event.occurredAt ? existing.startedAt : event.occurredAt;
    const completedAt = ["completed", "handled", "failed", "skipped"].includes(event.lifecycle) ? event.occurredAt : existing?.completedAt;
    const error = event.error
      ? { ...event.error, rootCause: event.eventId === firstFailureId }
      : existing?.error;
    lastEventAt.set(id, event.occurredAt);
    nodes.set(id, {
      id,
      moduleId: event.module.id,
      label: definition?.label || event.module.id,
      phase: event.module.phase,
      component: event.module.component,
      // A node can fail and then recover on a later lease/retry. Keep the
      // error envelope for root-cause inspection, but let the latest lifecycle
      // event determine the displayed state instead of permanently pinning the
      // node to failed.
      state,
      observed: true,
      startedAt,
      completedAt,
      durationMs: completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : undefined,
      input: nodeDebugValue(preferDebugValue(existing?.input, event.io?.input)),
      output: nodeDebugValue(preferDebugValue(existing?.output, event.io?.output)),
      error,
      evidence: event.evidence || existing?.evidence,
      correlation: { ...(existing?.correlation || { siteId: event.correlation.siteId }), ...event.correlation },
      dataQuality: "complete",
      eventIds: [...(existing?.eventIds || []), event.eventId],
    });
  }
  const terminalStatus = options.terminalStatus;
  if (options.terminal && terminalStatus) {
    for (const node of nodes.values()) {
      if (node.state !== "running") continue;
      const last = lastEventAt.get(node.id) || node.startedAt;
      if (terminalStatus === "succeeded") {
        // A successful terminal trace may contain only progress envelopes for
        // early phases. Their task completed; normalize them to succeeded.
        node.state = "succeeded";
        continue;
      }
      // For a failed/rejected terminal trace, progress before the first error
      // is completed work; progress after it was not confirmed to finish.
      node.state = firstFailureAt && last && last <= firstFailureAt ? "succeeded" : "skipped";
    }
  }
  const expected = options.expectedModuleIds || [];
  for (const moduleId of expected) {
    if ([...nodes.values()].some((node) => node.moduleId === moduleId)) continue;
    const definition = CAPABILITY_DEBUG_MODULES.find((item) => item.id === moduleId);
    if (!definition) continue;
    nodes.set(moduleId, {
      id: moduleId,
      moduleId,
      label: definition.label,
      phase: definition.phase,
      component: definition.component,
      state: options.terminal ? "unavailable" : "pending",
      observed: false,
      correlation: { siteId: events[0]?.correlation.siteId || "" },
      dataQuality: options.terminal ? "legacy" : "partial",
      eventIds: [],
    });
  }
  const order = new Map(CAPABILITY_DEBUG_MODULES.map((item, index) => [item.id, index]));
  return [...nodes.values()].sort((left, right) => (order.get(left.moduleId) ?? 10_000) - (order.get(right.moduleId) ?? 10_000) || (left.startedAt || "").localeCompare(right.startedAt || ""));
}

export function projectDebugEdges(nodes: DebugTraceNode[]): DebugTraceEdge[] {
  return nodes.slice(1).map((node, index) => ({ id: `${nodes[index].id}->${node.id}`, from: nodes[index].id, to: node.id }));
}

export function projectDebugPhases(nodes: DebugTraceNode[]) {
  const phaseOrder = [...new Set(nodes.map((node) => node.phase))];
  return phaseOrder.map((phase) => {
    const phaseNodes = nodes.filter((node) => node.phase === phase);
    const state: DebugNodeState = phaseNodes.some((node) => node.state === "failed")
      ? "failed"
      : phaseNodes.some((node) => node.state === "running")
        ? "running"
        : phaseNodes.some((node) => node.state === "pending")
          ? "pending"
          : phaseNodes.every((node) => node.state === "unavailable")
            ? "unavailable"
            : phaseNodes.some((node) => node.state === "handled")
              ? "handled"
              : "succeeded";
    return { id: phase, label: CAPABILITY_DEBUG_PHASE_LABELS[phase] || phase, state, nodeIds: phaseNodes.map((node) => node.id) };
  });
}

export function firstDebugFailure(events: CapabilityDebugEvent[]) {
  const event = [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId))
    .find((item) => item.lifecycle === "failed");
  if (!event) return undefined;
  return {
    moduleId: event.module.id,
    code: sanitizeDebugText(event.error?.code, "debug_stage_failed"),
    message: sanitizeDebugText(event.error?.message || event.message, "阶段失败"),
    eventId: event.eventId,
  };
}
