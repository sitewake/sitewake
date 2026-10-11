import {
  claimBlockedCapabilityProposalOverride,
  claimCapabilityProposalAnalysis,
  createCapabilityProposal,
  createCapabilityTask,
  getCapabilityProposal,
  listCapabilities,
  resolveCapabilityProposalAnalysis,
} from "../../db/capability-center-store";
import { getActiveSiteAgentRelease, recordModelInvocation } from "../../db/site-agent-store";
import { stableHash, type JsonValue, type TaskEpisode } from "../site-knowledge/protocol";
import { ModelJsonError, modelJsonFailure } from "../site-knowledge/model-analyzer";
import type { CapabilityProposal, CapabilityProposalKind } from "./model";
import { analyzeCapabilityProposal, taskTypeForAnalysis, type CapabilityProposalAnalysis } from "./proposal-analysis";

export type SubmitCapabilityProposalInput = {
  id?: string;
  kind?: CapabilityProposalKind;
  title: string;
  description?: string;
  requestedGoal: string;
  input?: Record<string, JsonValue>;
  capabilityId?: string;
  sourceEpisodeId?: string;
};

function jsonRecord(value: unknown): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function normalizedStableKey(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

const PROPOSAL_ANALYSIS_STALE_MS = 5 * 60_000;

function proposalAnalysisIsStale(proposal: CapabilityProposal) {
  const updatedAt = Date.parse(proposal.updatedAt);
  return !Number.isFinite(updatedAt) || Date.now() - updatedAt >= PROPOSAL_ANALYSIS_STALE_MS;
}

export function capabilitySignalLastError(error: unknown) {
  const failure = modelJsonFailure(error);
  if (failure) {
    const summary = failure.errorCode === "model_not_configured"
      ? "服务端尚未配置能力分析模型。"
      : failure.errorCode === "model_json_truncated"
        ? "模型输出达到长度上限，扩大输出预算重试后仍未形成完整 JSON。"
        : failure.errorCode === "model_json_invalid" || failure.errorCode === "model_response_json_invalid"
          ? "模型连续返回了无法解析的 JSON，系统将按计划重试。"
          : failure.httpStatus
            ? `模型服务请求失败（HTTP ${failure.httpStatus}），系统将按计划重试。`
            : "模型分析请求失败，系统将按计划重试。";
    return {
      code: failure.errorCode,
      summary,
      ...failure,
    };
  }
  const code = error instanceof Error ? error.message.slice(0, 160) : "capability_signal_analysis_failed";
  return { code, summary: code };
}

export async function submitCapabilityProposal(siteAgentId: string, input: SubmitCapabilityProposalInput) {
  const created = await createCapabilityProposal(siteAgentId, input);
  if (created.proposal.status === "analyzing" && !proposalAnalysisIsStale(created.proposal)) {
    return { proposal: created.proposal, queued: false, persistence: created.persistence };
  }
  if (created.proposal.status !== "pending" && created.proposal.status !== "analyzing") return { proposal: created.proposal, queued: created.proposal.status === "accepted", persistence: created.persistence };
  const proposalFence = created.proposal.updatedAt;
  const claimed = await claimCapabilityProposalAnalysis(siteAgentId, created.proposal.id, proposalFence);
  try {
    const [{ capabilities }, active] = await Promise.all([
      listCapabilities(siteAgentId, { includeDeleted: false }),
      getActiveSiteAgentRelease(siteAgentId),
    ]);
    const analysis = await analyzeCapabilityProposal({ proposal: claimed, capabilities, activeRelease: active.release, telemetry: { record: async (invocation) => { await recordModelInvocation(invocation); } } });
    return applyCapabilityProposalAnalysis(siteAgentId, created, claimed, analysis, active);
  } catch (error) {
    const failure = capabilitySignalLastError(error);
    const current = await resolveCapabilityProposalAnalysis(siteAgentId, claimed.id, {
      status: "failed",
      analysis: { phase: "server-analysis", failure: jsonRecord(failure) },
      expectedUpdatedAt: claimed.updatedAt,
      failure: { code: failure.code, summary: failure.summary },
    }).catch(() => undefined);
    if (current) return { proposal: current, queued: false, persistence: created.persistence };
    throw error;
  }
}

async function applyCapabilityProposalAnalysis(
  siteAgentId: string,
  created: Awaited<ReturnType<typeof createCapabilityProposal>>,
  claimed: CapabilityProposal,
  analysis: CapabilityProposalAnalysis,
  active: Awaited<ReturnType<typeof getActiveSiteAgentRelease>>,
  options: { force?: boolean } = {},
) {
  const analysisJson = jsonRecord(analysis);
    if (analysis.disposition === "duplicate") {
      const proposal = await resolveCapabilityProposalAnalysis(siteAgentId, claimed.id, {
        status: "duplicate",
        expectedUpdatedAt: claimed.updatedAt,
        duplicateCapabilityId: analysis.duplicateCapabilityId,
        analysis: analysisJson,
      });
      return { proposal, analysis, queued: false, persistence: created.persistence };
    }
    if (analysis.disposition === "rejected") {
      const proposal = await resolveCapabilityProposalAnalysis(siteAgentId, claimed.id, {
        status: "rejected",
        expectedUpdatedAt: claimed.updatedAt,
        analysis: analysisJson,
      });
      return { proposal, analysis, queued: false, persistence: created.persistence };
    }
    if (analysis.feasibility?.status === "blocked" && !options.force) {
      const proposal = await resolveCapabilityProposalAnalysis(siteAgentId, claimed.id, {
        status: "blocked",
        expectedUpdatedAt: claimed.updatedAt,
        analysis: analysisJson,
      });
      return { proposal, analysis, queued: false, persistence: created.persistence };
    }

    const taskContext: Record<string, JsonValue> = {
      requestedGoal: claimed.requestedGoal,
      input: claimed.input,
      analysis: analysisJson,
      baseReleaseId: active.release.id,
      baseReleaseVersion: active.release.version,
      ...(active.release.profile.entryUrl ? { startUrl: active.release.profile.entryUrl } : {}),
      ...(claimed.sourceEpisodeId ? { sourceEpisodeId: claimed.sourceEpisodeId } : {}),
    };
    const taskType = taskTypeForAnalysis(analysis.disposition, claimed.kind);
    try {
      const createdTask = await createCapabilityTask(siteAgentId, {
        taskId: claimed.sourceEpisodeId
          ? `capability-task:${stableHash(`${claimed.id}:${taskType}:initial`)}`
          : undefined,
        type: taskType,
        proposalId: claimed.id,
        proposalFence: claimed.updatedAt,
        capabilityId: analysis.targetCapabilityId,
        capability: taskType === "generate" ? analysis.capability : undefined,
        result: taskContext,
        evidence: { proposalId: claimed.id, analysis: analysisJson },
        proposalAnalysis: analysisJson,
      });
      return { ...createdTask, proposal: { ...claimed, status: "accepted" as const, capabilityId: createdTask.capability?.id }, analysis, queued: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      if (taskType === "generate" && /duplicate|unique/i.test(message) && analysis.capability) {
        const refreshed = await listCapabilities(siteAgentId, { includeDeleted: false });
        const winner = refreshed.capabilities.find((item) => normalizedStableKey(item.stableKey) === normalizedStableKey(analysis.capability!.stableKey));
        if (winner) {
          const proposal = await resolveCapabilityProposalAnalysis(siteAgentId, claimed.id, {
            status: "duplicate",
            expectedUpdatedAt: claimed.updatedAt,
            duplicateCapabilityId: winner.id,
            analysis: jsonRecord({ ...analysis, disposition: "duplicate", duplicateCapabilityId: winner.id, summary: `并发分析已由现有能力“${winner.name}”胜出。` }),
          });
          return { proposal, analysis: { ...analysis, disposition: "duplicate" as const, duplicateCapabilityId: winner.id }, queued: false, persistence: created.persistence };
        }
      }
      throw error;
    }
}

export async function forceCapabilityProposalTask(
  siteAgentId: string,
  proposalId: string,
  input: { reason?: string } = {},
) {
  const claimed = await claimBlockedCapabilityProposalOverride(siteAgentId, proposalId, input);
  const analysis = claimed.analysis as unknown as CapabilityProposalAnalysis;
  if (!analysis || !new Set(["new", "improvement", "repair"]).has(analysis.disposition)) {
    throw new Error("capability_proposal_override_analysis_invalid");
  }
  if (analysis.disposition === "new" && !analysis.capability) throw new Error("capability_proposal_override_capability_missing");
  if ((analysis.disposition === "improvement" || analysis.disposition === "repair") && !analysis.targetCapabilityId) {
    throw new Error("capability_proposal_override_target_missing");
  }
  const manualOverride = claimed.analysis?.manualOverride as CapabilityProposalAnalysis["manualOverride"];
  const forcedAnalysis: CapabilityProposalAnalysis = { ...analysis, manualOverride };
  const [{ persistence }, active] = await Promise.all([
    listCapabilities(siteAgentId, { includeDeleted: false }),
    getActiveSiteAgentRelease(siteAgentId),
  ]);
  return applyCapabilityProposalAnalysis(
    siteAgentId,
    { proposal: claimed, persistence },
    claimed,
    forcedAnalysis,
    active,
    { force: true },
  );
}

function compactEpisodeEvidence(episode: TaskEpisode) {
  return {
    start: { url: episode.startSnapshot.url, title: episode.startSnapshot.title, heading: episode.startSnapshot.heading },
    end: { url: episode.endSnapshot.url, title: episode.endSnapshot.title, heading: episode.endSnapshot.heading },
    actions: episode.experience?.actions.slice(-16).map((action) => ({
      action: action.action,
      rawAction: action.rawAction.slice(0, 120),
      input: action.input,
      element: action.element ? {
        tag: action.element.tag,
        role: action.element.role,
        accessibleName: action.element.accessibleName?.slice(0, 200),
        href: action.element.href?.slice(0, 500),
      } : undefined,
      page: action.page,
    })) || [],
    toolReceipts: episode.experience?.toolReceipts?.slice(-12).map((receipt) => ({
      kind: receipt.kind,
      name: receipt.name.slice(0, 120),
      status: receipt.status,
      summary: receipt.summary.slice(0, 500),
      capabilityId: receipt.capabilityId,
      output: receipt.output,
    })) || [],
    outcome: episode.outcome,
    output: episode.outcome.evidence.structuredOutput
      || episode.experience?.toolReceipts?.reduce<Record<string, JsonValue>>(
        (result, receipt) => receipt.output ? { ...result, ...receipt.output } : result,
        {},
      ) || {},
  };
}

/** Analyze a successful terminal-user gap before creating any four-table row. */
export async function submitEpisodeCapabilitySignal(siteAgentId: string, episode: TaskEpisode) {
  const now = episode.endedAt || new Date().toISOString();
  const proposalId = `capability-proposal:${stableHash(`${siteAgentId}:${episode.id}:terminal-user-gap`)}`;
  const evidence = compactEpisodeEvidence(episode);
  const proposed: CapabilityProposal = {
    id: proposalId,
    siteAgentId,
    kind: "new",
    status: "pending",
    title: episode.goal,
    description: episode.outcome.summary,
    requestedGoal: episode.goal,
    input: episode.input,
    sourceEpisodeId: episode.id,
    createdAt: now,
    updatedAt: now,
  };
  const existingBeforeAnalysis = await getCapabilityProposal(siteAgentId, proposalId);
  const existingFence = existingBeforeAnalysis?.updatedAt;
  if (existingBeforeAnalysis?.status === "failed") throw new Error("capability_proposal_retry_required");
  if (existingBeforeAnalysis && existingBeforeAnalysis.status !== "pending" && existingBeforeAnalysis.status !== "analyzing") {
    return {
      disposition: existingBeforeAnalysis.status === "duplicate" ? "duplicate" as const : existingBeforeAnalysis.status === "accepted" ? "new" as const : "rejected" as const,
      proposal: existingBeforeAnalysis,
      queued: existingBeforeAnalysis.status === "accepted",
    };
  }
  if (existingBeforeAnalysis?.status === "analyzing" && !proposalAnalysisIsStale(existingBeforeAnalysis)) {
    throw new Error("capability_proposal_analysis_in_progress");
  }
  const claimedExisting = existingBeforeAnalysis
    ? await claimCapabilityProposalAnalysis(siteAgentId, existingBeforeAnalysis.id, existingFence!)
    : undefined;
  const [catalog, active] = await Promise.all([
    listCapabilities(siteAgentId, { includeDeleted: false }),
    getActiveSiteAgentRelease(siteAgentId),
  ]);
  const { capabilities } = catalog;
  const analysis = await analyzeCapabilityProposal({
    proposal: proposed,
    capabilities,
    activeRelease: active.release,
    runtimeEvidence: jsonRecord(evidence),
    telemetry: { record: async (invocation) => { await recordModelInvocation(invocation); } },
  });
  if (!analysis.modelUsed && analysis.evidence[0] !== "stable-goal-exact-match") {
    throw new ModelJsonError({ errorCode: "model_not_configured", attempt: 0 });
  }
  if (analysis.disposition === "duplicate") {
    // A duplicate is a resolution of the external signal, not work for the
    // Capability Center. Keep the existing Capability reference on the signal
    // and do not create another Proposal/Task row. Only reconcile a row that
    // an older deployment may already have persisted for this deterministic id.
    const existing = claimedExisting || await getCapabilityProposal(siteAgentId, proposalId);
    if (!existing) {
      return {
        disposition: "duplicate" as const,
        duplicateCapabilityId: analysis.duplicateCapabilityId,
        analysis,
        queued: false,
      };
    }
    if (existing.status === "failed") throw new Error("capability_proposal_retry_required");
    if (existing.status !== "pending" && existing.status !== "analyzing") {
      return {
        disposition: "duplicate" as const,
        duplicateCapabilityId: analysis.duplicateCapabilityId || existing.duplicateCapabilityId,
        proposal: existing,
        analysis,
        queued: false,
        persistence: catalog.persistence,
      };
    }
    if (!claimedExisting && existing.status === "analyzing" && !proposalAnalysisIsStale(existing)) throw new Error("capability_proposal_analysis_in_progress");
    const claimed = claimedExisting || await claimCapabilityProposalAnalysis(siteAgentId, existing.id, existing.updatedAt);
    const proposal = await resolveCapabilityProposalAnalysis(siteAgentId, claimed.id, {
      status: "duplicate",
      expectedUpdatedAt: claimed.updatedAt,
      duplicateCapabilityId: analysis.duplicateCapabilityId,
      analysis: jsonRecord(analysis),
    });
    return {
      disposition: "duplicate" as const,
      duplicateCapabilityId: analysis.duplicateCapabilityId,
      proposal,
      analysis,
      queued: false,
      persistence: catalog.persistence,
    };
  }
  if (analysis.disposition === "rejected") {
    const existing = claimedExisting || await getCapabilityProposal(siteAgentId, proposalId);
    if (!existing) return { disposition: "rejected" as const, analysis, queued: false };
    if (existing.status === "failed") throw new Error("capability_proposal_retry_required");
    if (existing.status !== "pending" && existing.status !== "analyzing") {
      return {
        disposition: existing.status === "duplicate" ? "duplicate" as const : existing.status === "accepted" ? "new" as const : "rejected" as const,
        proposal: existing,
        analysis,
        queued: existing.status === "accepted",
        persistence: catalog.persistence,
      };
    }
    if (!claimedExisting && existing.status === "analyzing" && !proposalAnalysisIsStale(existing)) throw new Error("capability_proposal_analysis_in_progress");
    const claimed = claimedExisting || await claimCapabilityProposalAnalysis(siteAgentId, existing.id, existing.updatedAt);
    const proposal = await resolveCapabilityProposalAnalysis(siteAgentId, claimed.id, {
      status: "rejected",
      expectedUpdatedAt: claimed.updatedAt,
      analysis: jsonRecord(analysis),
    });
    return { disposition: "rejected" as const, proposal, analysis, queued: false, persistence: catalog.persistence };
  }

  if (claimedExisting) {
    return applyCapabilityProposalAnalysis(siteAgentId, { proposal: claimedExisting, persistence: catalog.persistence }, claimedExisting, analysis, active);
  }
  const created = await createCapabilityProposal(siteAgentId, {
    id: proposalId,
    kind: analysis.disposition === "improvement" || analysis.disposition === "repair" ? analysis.disposition : "new",
    title: proposed.title,
    description: proposed.description,
    requestedGoal: proposed.requestedGoal,
    input: proposed.input,
    capabilityId: analysis.targetCapabilityId,
    sourceEpisodeId: episode.id,
  });
  if (created.proposal.status === "analyzing") {
    if (!proposalAnalysisIsStale(created.proposal)) throw new Error("capability_proposal_analysis_in_progress");
    const claimed = await claimCapabilityProposalAnalysis(siteAgentId, created.proposal.id, created.proposal.updatedAt);
    return applyCapabilityProposalAnalysis(siteAgentId, created, claimed, analysis, active);
  }
  if (created.proposal.status !== "pending") {
    if (created.proposal.status === "failed") throw new Error("capability_proposal_retry_required");
    return {
      disposition: analysis.disposition,
      proposal: created.proposal,
      queued: created.proposal.status === "accepted",
      persistence: created.persistence,
    };
  }
  const claimed = await claimCapabilityProposalAnalysis(siteAgentId, created.proposal.id, created.proposal.updatedAt);
  return applyCapabilityProposalAnalysis(siteAgentId, created, claimed, analysis, active);
}
