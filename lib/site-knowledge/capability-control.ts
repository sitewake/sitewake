import {
  normalizeGoal,
  stableHash,
  type AuthoredImplementation,
  type BrowserRun,
  type CapabilityDefinition,
  type CapabilityEvent,
  type CapabilityFailureClass,
  type CapabilityProductionStage,
  type CapabilityProject,
  type CapabilityRevision,
  type CapabilityRevisionImplementation,
  type KnowledgeCandidate,
  type LearningJob,
  type TaskEpisodeSummary,
  type ValidationJob,
  type SiteAgentReleaseV2,
} from "./protocol";
import { classifyGoal } from "./navigation-tools";
import {
  capabilityContractFingerprint,
  capabilityProjectStableKey,
} from "./capability-identity";

export type CapabilityControlProjection = {
  projects: CapabilityProject[];
  revisions: CapabilityRevision[];
  events: CapabilityEvent[];
};

type Group = {
  intentKey: string;
  kind: "navigation" | "task";
  jobs: LearningJob[];
  candidates: KnowledgeCandidate[];
  capabilities: CapabilityDefinition[];
};

const META_OUTPUTS = new Set(["pageUrl", "pageTitle", "pageHeading", "sceneId"]);

function capabilityKind(capability: CapabilityDefinition) {
  return capability.kind || (classifyGoal(capability.goalTemplate || capability.name) === "navigation" ? "navigation" as const : "task" as const);
}

function managedCapability(capability: CapabilityDefinition) {
  return capability.status === "available"
    && isFormalCapability(capability);
}

export function isFormalCapability(capability: Pick<CapabilityDefinition, "id">) {
  return !capability.id.startsWith("navigation-tool:")
    && !capability.id.startsWith("capability_shared_nav_");
}

export function pinCapabilityContract<T extends KnowledgeCandidate>(
  candidate: T,
  published: CapabilityDefinition,
): T {
  return {
    ...candidate,
    normalizedGoal: normalizeGoal(published.goalTemplate || published.name),
    capability: {
      ...published,
      sourceEpisodeIds: [...new Set([
        ...published.sourceEpisodeIds,
        ...candidate.capability.sourceEpisodeIds,
      ])],
      updatedAt: candidate.updatedAt,
    },
    authoring: candidate.authoring
      ? {
          ...candidate.authoring,
          capabilityKind: published.kind,
          goalTemplate: published.goalTemplate || published.name,
        }
      : candidate.authoring,
  } as T;
}

/**
 * An enhancement can improve a Revision implementation, but it cannot silently
 * redefine the Capability contract. Semantic design is allowed to identify the
 * existing intent; once it does, pin the candidate back to that published
 * contract before canonical identity is claimed.
 */
export function pinStrengthenedCapabilityContract<T extends KnowledgeCandidate>(
  release: SiteAgentReleaseV2,
  candidate: T,
): T {
  if (candidate.authoring?.reuseDecision !== "strengthen-capability") return candidate;
  const published = release.capabilities.find((capability) =>
    isFormalCapability(capability)
    && (capability.status === "available" || capability.status === "improving")
    && (capability.id === candidate.capability.id
      || `capability_${capability.id}` === candidate.authoring?.intentKey));
  if (!published) return candidate;
  return pinCapabilityContract(candidate, published);
}

function capabilityResultKind(capability: CapabilityDefinition) {
  if (capability.resultKind) return capability.resultKind;
  const businessOutputs = Object.keys(capability.outputs.properties || {}).filter((key) => !META_OUTPUTS.has(key));
  return businessOutputs.length ? "data" as const : "page" as const;
}

function intentKeyFor(job: LearningJob, candidate?: KnowledgeCandidate) {
  return job.intentKey || candidate?.authoring?.intentKey || `intent_${stableHash(normalizeGoal(job.goalTemplate || candidate?.capability.name || job.id))}`;
}

export function capabilityProjectId(
  siteAgentId: string,
  job: LearningJob,
  candidate?: KnowledgeCandidate,
) {
  const persisted = job.result?.projectId;
  if (typeof persisted === "string" && persisted) return persisted;
  const intentKey = intentKeyFor(job, candidate);
  const kind = candidate
    ? capabilityKind(candidate.capability)
    : classifyGoal(job.goalTemplate || "") === "navigation" ? "navigation" : "task";
  return `project_${stableHash(`${siteAgentId}:${intentKey}:${kind}`)}`;
}

function intentText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\{?keyword\}?|\{?query\}?|\{?search[_-]?term\}?/g, "关键词")
    .replace(/\{?rank\}?/g, "序号")
    .replace(/\{?date\}?/g, "日期")
    .replace(/[，。！？、,.!?;；:："'“”‘’（）()\[\]{}\s]/g, "")
    .replace(/^(请|帮我|我要|我想)/, "")
    .replace(/[的按]/g, "");
}

function intentTokens(value: string) {
  const normalized = intentText(value);
  const result = new Set<string>();
  for (const character of normalized) result.add(character);
  for (let index = 0; index < normalized.length - 1; index += 1) {
    result.add(normalized.slice(index, index + 2));
  }
  return result;
}

function intentSimilarity(leftValue: string, rightValue: string) {
  const left = intentTokens(leftValue);
  const right = intentTokens(rightValue);
  if (!left.size || !right.size) return 0;
  const common = [...left].filter((token) => right.has(token)).length;
  return (2 * common) / (left.size + right.size);
}

function capabilityPhrases(capability: CapabilityDefinition) {
  return [
    capability.name,
    capability.normalizedGoal,
    capability.goalTemplate || "",
    ...capability.aliases,
  ].filter(Boolean);
}

function capabilityIdentity(capability: CapabilityDefinition) {
  const kind = capabilityKind(capability);
  const resultKind = capabilityResultKind(capability);
  const structure = "atomic" as const;
  const operation = kind === "navigation" || resultKind !== "action"
    ? "read" as const
    : "write" as const;
  const contractFingerprint = capabilityContractFingerprint({
    kind,
    resultKind,
    structure,
    operation,
    inputs: capability.inputs,
    outputs: capability.outputs,
  });
  return {
    stableKey: capabilityProjectStableKey({
      kind,
      resultKind,
      structure,
      operation,
      goalTemplate: capability.goalTemplate || capability.name,
      name: capability.name,
      inputSchema: capability.inputs,
      outputSchema: capability.outputs,
    }),
    contractFingerprint,
  };
}

function identityKey(capability: CapabilityDefinition) {
  const identity = capabilityIdentity(capability);
  return JSON.stringify([identity.stableKey, identity.contractFingerprint]);
}

function sameCapability(group: Group, capability: CapabilityDefinition) {
  if (group.kind !== capabilityKind(capability)) return false;
  if (group.capabilities.some((published) => published.id !== capability.id)) return false;
  if (group.candidates.some((candidate) => candidate.capability.id === capability.id)) return true;
  const publishedIdentity = identityKey(capability);
  if (group.candidates.some((candidate) =>
    identityKey(candidate.capability) === publishedIdentity)) return true;
  // Once design produced a contract, prose similarity may not override it.
  if (group.candidates.length) return false;
  const publishedPhrases = capabilityPhrases(capability);
  const publishedNames = new Set(publishedPhrases.map(normalizeGoal).filter(Boolean));
  const groupPhrases = [
    ...group.jobs.map((job) => job.goalTemplate || ""),
    ...group.candidates.flatMap((candidate) => [
      ...capabilityPhrases(candidate.capability),
      candidate.authoring?.goalTemplate || "",
    ]),
  ].filter(Boolean);
  if (groupPhrases.some((phrase) => publishedNames.has(normalizeGoal(phrase)))) return true;
  return groupPhrases.some((left) =>
    publishedPhrases.some((right) => intentSimilarity(left, right) >= 0.72));
}

function explicitProjectIds(group: Group) {
  return new Set(group.jobs.flatMap((job) =>
    typeof job.result?.projectId === "string" && job.result.projectId
      ? [job.result.projectId]
      : []));
}

function consolidateIntentGroups(groups: Map<string, Group>) {
  const consolidated: Group[] = [];
  for (const incoming of groups.values()) {
    const incomingProjectIds = explicitProjectIds(incoming);
    const incomingIdentities = new Set(incoming.candidates.map((candidate) =>
      identityKey(candidate.capability)));
    const existing = consolidated.find((candidate) => {
      if (candidate.kind !== incoming.kind) return false;
      const candidateProjectIds = explicitProjectIds(candidate);
      if ([...incomingProjectIds].some((projectId) => candidateProjectIds.has(projectId))) {
        return true;
      }
      // Once both sides carry persisted roots, those IDs are authoritative.
      // An identical contract can legitimately exist under two retained legacy
      // roots and reconciliation must not silently move either history.
      if (incomingProjectIds.size > 0 && candidateProjectIds.size > 0) {
        return false;
      }
      const candidateIdentities = new Set(candidate.candidates.map((item) =>
        identityKey(item.capability)));
      return [...incomingIdentities].some((identity) => candidateIdentities.has(identity));
    });
    if (!existing) {
      consolidated.push({ ...incoming, jobs: [...incoming.jobs], candidates: [...incoming.candidates], capabilities: [...incoming.capabilities] });
      continue;
    }
    existing.jobs.push(...incoming.jobs.filter((job) => !existing.jobs.some((item) => item.id === job.id)));
    existing.candidates.push(...incoming.candidates.filter((candidate) => !existing.candidates.some((item) => item.id === candidate.id)));
    existing.capabilities.push(...incoming.capabilities.filter((capability) => !existing.capabilities.some((item) => item.id === capability.id)));
  }
  return new Map(consolidated.map((group) => {
    const projectIds = explicitProjectIds(group);
    const key = projectIds.size === 1
      ? `project:${[...projectIds][0]}:${group.kind}`
      : `${group.intentKey}:${group.kind}`;
    return [key, group];
  }));
}

function ordinalRank(value: string) {
  const match = value.match(/第\s*([一二三四五六七八九十百千万两\d]+)\s*(?:个|条|名|项|位)/i) || value.match(/top\s*(\d+)/i);
  if (!match) return undefined;
  if (/^\d+$/.test(match[1])) return Number(match[1]);
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const raw = match[1];
  if (raw === "十") return 10;
  if (raw.startsWith("十")) return 10 + (digits[raw[1]] || 0);
  if (raw.endsWith("十")) return (digits[raw[0]] || 0) * 10;
  if (raw.includes("十")) return (digits[raw[0]] || 0) * 10 + (digits[raw.at(-1)!] || 0);
  return digits[raw];
}

function parameterizeOrdinalContract(contract: CapabilityDefinition, experienceGoal = "") {
  const rank = ordinalRank(experienceGoal);
  if (!rank) return { contract, decision: undefined };
  const existing = contract.inputs.properties?.rank;
  const topicDetail = /(热搜|话题|词条).*(详情|内容)|详情.*(热搜|话题|词条)/.test(`${contract.name}${contract.description}${experienceGoal}`);
  const goalTemplate = topicDetail ? "查看榜单第 {rank} 个热搜话题详情" : (contract.goalTemplate || experienceGoal).replace(/第\s*[一二三四五六七八九十百千万两\d]+\s*(个|条|名|项|位)/i, "第 {rank} $1");
  return {
    contract: {
      ...contract,
      name: topicDetail ? "按榜单序号查看热搜话题详情" : contract.name,
      goalTemplate,
      normalizedGoal: normalizeGoal(goalTemplate),
      inputs: {
        type: "object" as const,
        properties: { ...(contract.inputs.properties || {}), rank: existing?.type === "number" ? existing : { type: "number" as const, description: "榜单序号" } },
        required: [...new Set([...(contract.inputs.required || []), "rank"])],
      },
    },
    decision: {
      id: `parameter_rank_${stableHash(`${experienceGoal}:${rank}`)}`,
      observedValue: rank,
      evidence: `真实经验中的具体序号：${experienceGoal}`,
      decision: "input" as const,
      inputId: "rank",
      reason: "序号会随用户目标变化，必须建模为 rank:number，而不能固化为第三项。",
    },
  };
}

function observedDate(value = "") {
  const normalized = value.normalize("NFKC");
  const iso = normalized.match(/(?:^|[^\d])(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日|号)?(?:[^\d]|$)/);
  const short = normalized.match(/(?:^|[^\d])(\d{2})年(\d{1,2})月(\d{1,2})(?:日|号)(?:[^\d]|$)/);
  const match = iso || short;
  if (!match) return undefined;
  const year = match === short ? 2000 + Number(match[1]) : Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function parameterizeDateContract(contract: CapabilityDefinition, experienceGoal = "") {
  // Only a date explicitly present in the user's request is eligible to become
  // an input.  Result pages routinely contain dates (and rankings, cities,
  // prices, …); treating those as inputs was the source of duplicate, bogus
  // "view daily ranking" projects.
  const date = observedDate(experienceGoal);
  if (!date) return { contract, decision: undefined };
  const dateExpression = /(?:20\d{2}|\d{2})[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日|号)?/;
  const dailyContent = /(日榜|榜单|热搜|归档)/.test(`${contract.name}${contract.description}${experienceGoal}`);
  const existing = contract.inputs.properties?.date;
  const fallbackTemplate = (contract.goalTemplate || experienceGoal || contract.name).replace(dateExpression, "{date}");
  const goalTemplate = fallbackTemplate.includes("{date}") ? fallbackTemplate : dailyContent ? "查看 {date} 的热搜日榜" : `查看 {date} 的${contract.name}`;
  return {
    contract: {
      ...contract,
      name: dailyContent ? "按日期查看热搜日榜" : contract.name.replace(dateExpression, "指定日期"),
      goalTemplate,
      normalizedGoal: normalizeGoal(goalTemplate),
      inputs: {
        type: "object" as const,
        properties: {
          ...(contract.inputs.properties || {}),
          date: existing?.type === "string"
            ? { ...existing, format: existing.format || "date", examples: existing.examples?.length ? existing.examples : [date] }
            : { type: "string" as const, format: "date" as const, description: "日期", examples: [date] },
        },
        required: [...new Set([...(contract.inputs.required || []), "date"])],
      },
    },
    decision: {
      id: `parameter_date_${stableHash(`${experienceGoal}:${date}`)}`,
      observedValue: date,
      evidence: `真实经验中的具体日期：${experienceGoal}`,
      decision: "input" as const,
      inputId: "date",
      reason: "日期会随用户目标变化，必须建模为 date 输入，不能固化为一次任务。",
    },
  };
}

function parameterizeConcreteContract(contract: CapabilityDefinition, experienceGoal = "") {
  const ordinal = parameterizeOrdinalContract(contract, experienceGoal);
  const date = parameterizeDateContract(ordinal.contract, experienceGoal);
  const decisions = [ordinal.decision, date.decision].filter((decision): decision is NonNullable<typeof decision> => Boolean(decision));
  return { contract: date.contract, decisions };
}

export function classifyCapabilityFailure(code = "", summary = ""): CapabilityFailureClass {
  const value = `${code} ${summary}`.toLowerCase();
  if (/ai_design|model_(?:failed|empty|unavailable)|tool_call_missing/.test(value)) return "transient-runtime";
  if (/contract_incomplete/.test(value) && /(内部|索引|导航项|页面布局|选择器|非业务输入|非输入|点击结果|结果而非输入|页面显示|未在目标中提及|无关|incidental|not (?:a )?business input|result value)/i.test(value)) return "transient-runtime";
  if (/contract|parameter|input_required|goal_template/.test(value)) return "contract-incomplete";
  if (/extract|output|schema|field/.test(value)) return "extractor-mismatch";
  if (/verifier|scene_assertion|judge|evidence insufficient|证据不足/.test(value)) return "verifier-mismatch";
  if (/target|locator|binding|element|selector/.test(value)) return "target-grounding-failed";
  if (/timeout|network|crash|disconnect|temporar|429|502|503|504/.test(value)) return "transient-runtime";
  if (/duplicate|supersed|already published/.test(value)) return "duplicate-or-superseded";
  if (/regression|drift/.test(value)) return "runtime-regression";
  return "insufficient-evidence";
}

function stageFor(job?: LearningJob): CapabilityProductionStage {
  if (!job) return "publish";
  if (job.phase === "design") return "design";
  if (job.phase === "author") return "author";
  if (job.phase === "validate") return "validate";
  return "publish";
}

function jobContract(job: LearningJob, candidate?: KnowledgeCandidate, published?: CapabilityDefinition): CapabilityDefinition {
  if (candidate) return candidate.capability;
  if (published) return published;
  const now = job.updatedAt;
  const name = job.goalTemplate || "正在理解用户目标";
  return {
    id: `capability_${stableHash(`${job.siteAgentId}:${job.id}`)}`,
    kind: classifyGoal(name) === "navigation" ? "navigation" : "task",
    resultKind: "page",
    exposure: "public",
    name,
    description: "等待 AI 完成能力契约设计",
    normalizedGoal: normalizeGoal(name),
    goalTemplate: name,
    aliases: [],
    inputs: { type: "object", properties: {} },
    outputs: { type: "object", properties: {} },
    outcomes: [],
    plans: [],
    sourceEpisodeIds: [job.sourceEpisodeId],
    confidence: 0,
    status: "learning",
    updatedAt: now,
  };
}

function typedRevisionImplementation(authored?: AuthoredImplementation): CapabilityRevisionImplementation | undefined {
  if (!authored) return undefined;
  if (authored.kind === "module") {
    return {
      kind: "program",
      moduleRef: authored.module,
      proof: authored.proof,
    };
  }
  return {
    kind: "program",
    pageProgram: authored.program,
    proof: authored.proof,
  };
}

function revisionForJob(projectId: string, number: number, job: LearningJob, candidate: KnowledgeCandidate | undefined, published: CapabilityDefinition | undefined, validationJobs: ValidationJob[], browserRuns: BrowserRun[], sourceEpisode?: TaskEpisodeSummary, publishedAt?: string): CapabilityRevision {
  const parameterized = parameterizeConcreteContract(jobContract(job, candidate, published), sourceEpisode?.goal);
  const validationJob = validationJobs.filter((item) => item.learningJobId === job.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const run = browserRuns.filter((item) => item.learningJobId === job.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  // Reusing the identity of an already published capability does not make a
  // new attempt successful. A failed enhancement must remain visible as the
  // working Revision while the last-good published Revision stays active.
  // A completed job is only published when the active Release actually
  // contains the capability. This prevents legacy/completed job receipts from
  // bypassing the human Revision review gate.
  const completed = job.status === "completed" && Boolean(published);
  const awaitingReview = job.status === "awaiting-review";
  const failed = job.status === "failed";
  const status = completed
    ? "published"
    : awaitingReview
      ? "awaiting-review"
      : failed && publishedAt && publishedAt >= job.updatedAt
        ? "superseded"
        : failed
          ? "failed"
          : "building";
  const authoredImplementation = candidate?.operations.flatMap((operation) => operation.implementations).find((item) => item.id === candidate.authoring?.selectedImplementationId)?.authored
    || candidate?.operations.flatMap((operation) => operation.implementations).find((item) => item.authored)?.authored;
  const implementation = typedRevisionImplementation(authoredImplementation);
  const failure = validationJob?.failure || job.failure;
  return {
    id: typeof job.result?.revisionId === "string" && job.result.revisionId
      ? job.result.revisionId
      : `revision_${stableHash(`${projectId}:${job.id}`)}`,
    projectId,
    siteAgentId: job.siteAgentId,
    number,
    status,
    stage: completed ? "publish" : stageFor(job),
    baseReleaseVersion: candidate?.baseReleaseVersion || 0,
    candidateId: candidate?.id || job.candidateId,
    learningJobId: job.id,
    parameterizationDecisions: [
      ...(candidate?.authoring?.parameterizationDecisions || []).filter((decision) => !parameterized.decisions.some((item) => item?.inputId === decision.inputId)),
      ...parameterized.decisions,
    ],
    implementation,
    verifier: implementation?.kind === "program" ? implementation.proof?.verifier : undefined,
    // A design/authoring failure still needs a structured failure class even
    // when no validation job exists yet. The control plane and auto-recovery
    // must not mistake an infrastructure/model interruption for a request for
    // human guidance.
    validation: validationJob || run || failure ? {
      // Authoring/design failures have not been validated. Only an actual
      // ValidationJob may claim that validation passed or failed.
      status: validationJob?.status === "passed"
        ? "passed"
        : validationJob?.status === "running" || validationJob?.status === "leased"
          ? "running"
          : validationJob?.status === "failed" || validationJob?.status === "cancelled"
            ? "failed"
            : "pending",
      input: validationJob?.validationCase.input,
      runId: run?.id,
      validatedContentHash: awaitingReview && candidate
        ? stableHash(JSON.stringify(implementation?.kind === "navigation-tool"
          ? { candidate, navigationToolRef: implementation.toolRef }
          : candidate))
        : undefined,
      failureClass: failure ? classifyCapabilityFailure(failure.code, failure.summary) : undefined,
      summary: failure?.summary || run?.outcome?.summary,
    } : undefined,
    guidanceIds: [],
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function eventForReceipt(projectId: string, revisionId: string, job: LearningJob, receipt: LearningJob["receipts"][number], superseded: boolean): CapabilityEvent {
  return {
    id: `event_${stableHash(`${projectId}:${receipt.id}`)}`,
    siteAgentId: job.siteAgentId,
    projectId,
    revisionId,
    type: receipt.stage === "evidence" ? "experience" : receipt.stage,
    actor: receipt.actor,
    status: superseded && receipt.status === "failed" ? "superseded" : receipt.status === "queued" || receipt.status === "skipped" ? "info" : receipt.status,
    title: superseded && receipt.status === "failed" ? `${receipt.title} · 已由后续版本解决` : receipt.title,
    summary: receipt.summary,
    evidence: receipt.evidence,
    artifactIds: receipt.artifactIds,
    createdAt: receipt.endedAt || receipt.startedAt,
  };
}

export function projectCapabilityControl(input: {
  siteAgentId: string;
  release: SiteAgentReleaseV2;
  candidates: KnowledgeCandidate[];
  learningJobs: LearningJob[];
  validationJobs: ValidationJob[];
  browserRuns: BrowserRun[];
  episodes: TaskEpisodeSummary[];
}): CapabilityControlProjection {
  let groups = new Map<string, Group>();
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const episodeById = new Map(input.episodes.map((episode) => [episode.id, episode]));
  const isCapabilityJob = (job: LearningJob) => {
    if (["conversation-only", "do-not-persist", "navigation-tool", "suppressed"].includes(String(job.result?.reuseDecision || ""))) return false;
    // An explicit rebuild is a new Revision of the named Capability even when
    // its evidence episode is already linked to the current published asset.
    // Dropping it here leaves the persisted Working Revision permanently in
    // "building" after an authoring failure and makes an in-place retry
    // impossible.
    if (job.result?.source === "capability-control"
      && typeof job.result.projectId === "string"
      && job.result.projectId) return true;
    const episode = episodeById.get(job.sourceEpisodeId);
    if (episode?.capabilityId && input.release.capabilities.some((capability) => capability.id === episode.capabilityId)) return false;
    if (episode?.outcome.code === "conversation_completed" || classifyGoal(episode?.goal || job.goalTemplate || "") === "conversation") return false;
    return true;
  };
  for (const job of input.learningJobs.filter(isCapabilityJob)) {
    const candidate = candidateById.get(job.candidateId)
      || input.candidates.find((item) =>
        item.authoring?.intentKey === job.intentKey
        || normalizeGoal(item.authoring?.goalTemplate || item.capability.goalTemplate || item.capability.name) === normalizeGoal(job.goalTemplate || ""));
    const intentKey = intentKeyFor(job, candidate);
    const kind = candidate ? capabilityKind(candidate.capability) : classifyGoal(job.goalTemplate || "") === "navigation" ? "navigation" : "task";
    const projectId = typeof job.result?.projectId === "string" && job.result.projectId
      ? job.result.projectId
      : undefined;
    // Two jobs for the same goal are one project, whatever their intent keys
    // say. A key is minted per request, and legacy jobs carry opaque ones, so
    // grouping by the key alone showed the console one card per click for a
    // single goal — and each card then looked like separate work in flight.
    const goalKey = normalizeGoal(job.goalTemplate || "") || intentKey;
    const key = projectId ? `project:${projectId}:${kind}` : `goal:${goalKey}:${kind}`;
    const group = groups.get(key) || { intentKey, kind, jobs: [], candidates: [], capabilities: [] };
    group.jobs.push(job);
    if (candidate && !group.candidates.some((item) => item.id === candidate.id)) group.candidates.push(candidate);
    groups.set(key, group);
  }
  for (const candidate of input.candidates.filter((item) => !["conversation-only", "do-not-persist", "suppressed"].includes(String(item.authoring?.reuseDecision || ""))
    && !item.sourceEpisodeIds.some((episodeId) => {
      const source = episodeById.get(episodeId);
      return Boolean(source?.capabilityId && input.release.capabilities.some((capability) => capability.id === source.capabilityId))
        || source?.outcome.code === "conversation_completed"
        || classifyGoal(source?.goal || "") === "conversation"
        || (classifyGoal(source?.goal || "") === "navigation" && source?.mode !== "author-request");
    }))) {
    if ([...groups.values()].some((group) => group.candidates.some((item) => item.id === candidate.id))) continue;
    const intentKey = candidate.authoring?.intentKey || `intent_${stableHash(candidate.normalizedGoal)}`;
    const kind = capabilityKind(candidate.capability);
    const key = `${intentKey}:${kind}`;
    groups.set(key, { intentKey, kind, jobs: [], candidates: [candidate], capabilities: [] });
  }
  // Older jobs sometimes received a fresh opaque intent key for an identical
  // goal. Collapse those aliases before attaching the published capability so
  // the control center exposes one durable project, not one row per attempt.
  groups = consolidateIntentGroups(groups);
  for (const capability of input.release.capabilities.filter(managedCapability)) {
    const group = [...groups.values()].find((item) => sameCapability(item, capability));
    if (group) group.capabilities.push(capability);
    else {
      const intentKey = `capability_${capability.id}`;
      const kind = capabilityKind(capability);
      const key = `${intentKey}:${kind}`;
      groups.set(key, { intentKey, kind, jobs: [], candidates: [], capabilities: [capability] });
    }
  }

  const projects: CapabilityProject[] = [];
  const revisions: CapabilityRevision[] = [];
  const events: CapabilityEvent[] = [];
  for (const group of groups.values()) {
    const jobs = [...group.jobs].sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt)
      || a.createdAt.localeCompare(b.createdAt)
      || a.id.localeCompare(b.id),
    );
    const published = [...group.capabilities].sort((a, b) =>
      Number(Boolean(b.module)) - Number(Boolean(a.module))
      || b.updatedAt.localeCompare(a.updatedAt),
    )[0];
    const latestCandidate = [...group.candidates].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const latestJob = jobs.at(-1);
    const contract = published || latestCandidate?.capability || (latestJob ? jobContract(latestJob, latestCandidate, published) : undefined);
    if (!contract) continue;
    const projectId = jobs
      .map((job) => job.result?.projectId)
      .find((value): value is string => typeof value === "string" && Boolean(value))
      || `project_${stableHash(`${input.siteAgentId}:${group.intentKey}:${group.kind}`)}`;
    const available = Boolean(published);
    const groupRevisions = jobs.map((job, index) => revisionForJob(projectId, index + 1, job, candidateById.get(job.candidateId) || group.candidates.find((item) => item.capability.id === contract.id), published, input.validationJobs, input.browserRuns, input.episodes.find((episode) => episode.id === job.sourceEpisodeId), published?.updatedAt));
    if (published && !groupRevisions.some((revision) => revision.status === "published")) {
      groupRevisions.push({
        id: `revision_${stableHash(`${projectId}:release:${published.id}`)}`,
        projectId,
        siteAgentId: input.siteAgentId,
        number: groupRevisions.length + 1,
        status: "published",
        stage: "publish",
        baseReleaseVersion: Math.max(0, input.release.version - 1),
        parameterizationDecisions: [],
        guidanceIds: [],
        createdAt: published.updatedAt,
        updatedAt: published.updatedAt,
      });
    }
    // A synthetic Revision reconstructed from the current Release represents
    // historical last-good state. Insert it into the causal timeline instead
    // of appending it after newer failed/building attempts.
    groupRevisions.sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt)
      || left.createdAt.localeCompare(right.createdAt)
      || Number(Boolean(left.learningJobId)) - Number(Boolean(right.learningJobId))
      || left.id.localeCompare(right.id),
    );
    groupRevisions.forEach((revision, index) => {
      revision.number = index + 1;
    });
    revisions.push(...groupRevisions);
    for (const revision of groupRevisions) {
      const job = revision.learningJobId ? jobs.find((item) => item.id === revision.learningJobId) : undefined;
      if (job) events.push(...job.receipts.map((receipt) => eventForReceipt(projectId, revision.id, job, receipt, revision.status === "superseded")));
      else if (revision.status === "published") events.push({ id: `event_${stableHash(`${revision.id}:publish`)}`, siteAgentId: input.siteAgentId, projectId, revisionId: revision.id, type: "migration", actor: "release-gate", status: "passed", title: "从当前知识版本恢复能力项目", summary: `能力已在 Release v${input.release.version} 中可用。`, createdAt: revision.updatedAt });
    }
    const activeRevision = [...groupRevisions].reverse().find((revision) => revision.status === "published");
    const unresolved = [...groupRevisions].reverse().find((revision) => (revision.status === "failed" || revision.status === "building" || revision.status === "awaiting-review") && (!activeRevision || revision.updatedAt > activeRevision.updatedAt));
    // The active Revision is the canonical contract presented to both humans
    // and agents. It contains parameter format/examples derived from evidence;
    // older Release capabilities may predate those schema fields.
    // The immutable contract belongs to the Capability root. Revision JSON no
    // longer duplicates it; historical Revision.contract remains read-only.
    const projectContract = published || latestCandidate?.capability || contract;
    const recentGoals = new Set([projectContract.name, projectContract.goalTemplate || "", ...projectContract.aliases].map(normalizeGoal).filter(Boolean));
    const matchedEpisodes = input.episodes.filter((episode) => episode.capabilityId === published?.id || recentGoals.has(normalizeGoal(episode.goal))).slice(0, 20);
    const successes = matchedEpisodes.filter((episode) => episode.outcome.status === "success" || episode.outcome.status === "no-result" || episode.outcome.status === "business-rejection").length;
    const failureClass = unresolved?.validation?.failureClass;
    // A failed enhancement is not evidence that the active, last-good
    // Revision regressed. Runtime health may degrade the project only when it
    // is scoped to the active Revision; unresolved production attempts stay
    // visible through latestRevision/workingRevision and health.failureClass.
    const status = available
      ? "available"
      : unresolved?.status === "awaiting-review"
        ? "awaiting-review"
        : unresolved?.status === "failed"
          ? failureClass === "transient-runtime" ? "degraded" : "needs-guidance"
          : "building";
    const resultKind = capabilityResultKind(projectContract);
    const projectIdentity = capabilityIdentity(projectContract);
    const structure = "atomic" as const;
    const operation = capabilityKind(projectContract) === "navigation" || resultKind !== "action"
      ? "read" as const
      : "write" as const;
    const outputKeys = Object.keys(projectContract.outputs.properties || {});
    const enhancementRecommended = available && resultKind === "page" && /(搜索|查询|列表|详情|榜|数据|记录)/.test(`${projectContract.name}${projectContract.description}`) && outputKeys.every((key) => META_OUTPUTS.has(key));
    const latestRevision = groupRevisions.at(-1);
    const orderedJobs = [...jobs].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.updatedAt.localeCompare(right.updatedAt)
        || left.id.localeCompare(right.id),
      );
    const sourceEpisode = orderedJobs
      .map((job) => episodeById.get(job.sourceEpisodeId))
      .find((episode): episode is TaskEpisodeSummary => Boolean(episode));
    const requestedGoal = orderedJobs
      .map((job) => typeof job.result?.requestedGoal === "string" ? job.result.requestedGoal.trim() : "")
      .find(Boolean)
      || sourceEpisode?.goal
      || projectContract.goalTemplate
      || projectContract.name;
    // Trigger attribution is immutable project provenance: the first
    // production request owns it. Later administrator/user enhancements must
    // not rewrite how the project originally entered the factory.
    const triggeredBy = sourceEpisode?.mode === "author-request"
      ? "administrator" as const
      : sourceEpisode?.mode === "adaptive" || sourceEpisode?.mode === "repair" || sourceEpisode?.mode === "demonstration"
        ? "user" as const
        : published?.origin === "administrator"
          ? "administrator" as const
          : published?.origin === "user-triggered"
            ? "user" as const
            : "system" as const;
    // Generator attribution follows the implementation that is actually
    // active (or the latest attempt when nothing is published), rather than
    // being permanently tainted by any historical demonstration.
    const productionRevision = activeRevision || latestRevision;
    const productionJob = productionRevision?.learningJobId
      ? jobs.find((job) => job.id === productionRevision.learningJobId)
      : undefined;
    const productionEpisode = productionJob
      ? episodeById.get(productionJob.sourceEpisodeId)
      : undefined;
    const generatedBy = productionEpisode?.mode === "demonstration"
      ? "user-demonstration" as const
      : productionJob
        ? "ai" as const
        : published?.origin === "administrator"
          ? "administrator" as const
          : "ai" as const;
    const origin = triggeredBy === "administrator"
      ? "administrator"
      : published?.origin
        || group.candidates.find((candidate) => candidate.capability.origin)?.capability.origin
        || jobs.find((job) => job.origin)?.origin
        || (sourceEpisode?.mode === "adaptive" || sourceEpisode?.mode === "repair" || sourceEpisode?.mode === "demonstration"
          ? "user-triggered"
          : projectContract.kind === "navigation" ? "ai-exploration" : "administrator");
    const jobAssessment = latestJob?.result?.evolutionAssessment;
    const evolutionAssessment = latestCandidate?.authoring?.evolutionAssessment
      || (jobAssessment && typeof jobAssessment === "object" && !Array.isArray(jobAssessment)
        ? jobAssessment as CapabilityProject["evolutionAssessment"]
        : undefined);
    const activeImplementation = activeRevision?.implementation;
    const supportsCloudBrowser = Boolean(published?.module)
      || activeImplementation?.kind === "module"
      || activeImplementation?.kind === "navigation-tool"
      || (activeImplementation?.kind === "program"
        && Boolean(activeImplementation.moduleRef));
    projects.push({
      id: projectId,
      siteAgentId: input.siteAgentId,
      intentKey: group.intentKey,
      stableKey: projectIdentity.stableKey,
      contractFingerprint: projectIdentity.contractFingerprint,
      name: projectContract.name,
      description: projectContract.description,
      goalTemplate: projectContract.goalTemplate || projectContract.name,
      requestedGoal,
      origin,
      triggeredBy,
      generatedBy,
      evolutionAssessment,
      status,
      stage: available ? "publish" : unresolved?.stage || "experience",
      kind: capabilityKind(projectContract),
      structure,
      operation,
      exposure: projectContract.exposure || "public",
      resultKind,
      activeCapabilityId: published?.id,
      activeRevisionId: activeRevision?.id,
      latestRevisionId: latestRevision?.id,
      inputSchema: projectContract.inputs,
      outputSchema: projectContract.outputs,
      executionRequirements: {
        authentication: activeRevision ? "none" : "unknown",
        supportedEnvironments: {
          connectedBrowser: "supported",
          cloudBrowser: supportsCloudBrowser ? "supported" : "unverified",
          managedProfile: "blocked",
        },
        checkpoints: [],
        evidenceRefs: activeRevision?.validation?.runId ? [activeRevision.validation.runId] : [],
      },
      health: {
        lastValidatedAt: activeRevision?.updatedAt,
        lastRunAt: matchedEpisodes[0]?.endedAt,
        recentRuns: matchedEpisodes.length,
        recentSuccesses: successes,
        successRate: matchedEpisodes.length ? successes / matchedEpisodes.length : undefined,
        failureClass,
        recommendedAction: status === "needs-guidance" ? failureClass === "contract-incomplete" ? "patch-contract" : unresolved?.stage === "validate" && failureClass === "verifier-mismatch" ? "retry-validation" : "re-explore" : status === "degraded" ? "re-explore" : enhancementRecommended ? "inspect" : undefined,
        enhancementRecommended,
      },
      revisionCount: groupRevisions.length,
      buildStartedAt: orderedJobs[0]?.createdAt,
      createdAt: groupRevisions[0]?.createdAt || projectContract.updatedAt,
      updatedAt: latestRevision?.updatedAt || projectContract.updatedAt,
    });
  }
  return {
    projects: projects.sort((a, b) => (a.status === "available" ? 0 : a.status === "building" ? 1 : 2) - (b.status === "available" ? 0 : b.status === "building" ? 1 : 2) || b.updatedAt.localeCompare(a.updatedAt)),
    revisions,
    events: events.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}
