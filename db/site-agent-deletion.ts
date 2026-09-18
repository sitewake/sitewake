/**
 * Deletes a site along with everything it left in the control plane.
 *
 * Orchestration lives here, cleaners in their own store modules: whoever owns a table
 * hands over its DELETE statements, its object-storage keys and its memory-mode
 * cleanup. This file only owns order and atomicity:
 *
 * 1. Delete storage objects first. The bucket has no list and keys exist only in rows —
 *    objects must go before the rows, or one failure loses them forever. If any object
 *    cannot be deleted, abort with the database untouched; the site stays visible and
 *    retryable (delete on a missing key is idempotent).
 * 2. Then run every module's DELETEs as one batch (the D1 and Postgres adapters are
 *    both transactional), with the `site_agent_v2_agents` row last: if anything before
 *    it fails, the site still exists.
 * 3. Memory mode calls each module's in-memory cleaner in turn.
 *
 * A separate module rather than part of `site-agent-store.ts` because the capability
 * center stores import from `site-agent-store`; the orchestrator importing them back
 * would form a cycle.
 */
import { getArtifactBinding, getD1Binding, type D1DatabaseLike, type D1PreparedStatementLike } from "./index";
import { SiteAgentDataError } from "../lib/site-knowledge/errors";
import { ensureSiteAgentV2Schema, ensureSiteAgentV3Schema } from "./site-agent-schema";
import { ensureCapabilityCenterV2Schema } from "./capability-center-v2-schema";
import {
  deleteMemorySiteAgentData,
  siteAgentDeletionStatements,
  siteAgentExists,
  siteAgentObjectKeys,
} from "./site-agent-store";
import { capabilityCenterDeletionStatements, deleteMemoryCapabilityCenterData } from "./capability-center-store";
import {
  capabilityCenterV2DeletionStatements,
  capabilityCenterV2ObjectKeys,
  deleteMemoryCapabilityCenterV2Data,
} from "./capability-center-v2-store";
import {
  capabilityModuleDeletionStatements,
  capabilityModuleObjectKeys,
  deleteMemoryCapabilityModules,
} from "./capability-center-v2-module-store";
import { agentRunDeletionStatements, deleteMemoryAgentRunData } from "./agent-run-store";
import { deleteMemoryEffectData, effectDeletionStatements } from "./effect-store";
import { deleteMemoryPageObservationData, pageObservationDeletionStatements } from "./page-observation-store";
import { deleteMemoryModelResponseData, modelResponseDeletionStatements } from "./model-response-store";
import {
  capabilityExperienceOutboxDeletionStatements,
  deleteMemoryCapabilityExperienceOutbox,
} from "./capability-experience-outbox-store";
import { deleteMemoryRunnerControlData, runnerControlDeletionStatements } from "./runner-control-store";
import { deleteMemoryCapabilityDebugData } from "./capability-debug-store";

export type SiteAgentDeletionResult = {
  deleted: true;
  persistence: "memory" | "d1";
  /** Number of storage objects deleted, for logs and tests only. */
  objects: number;
  /** Number of statements in this batch, for logs and tests only (design.md asks to record a real size once). */
  statements: number;
};

/** DELETE statements handed over by each module in dependency order; the site row is not among them. Exported for the schema-comparison test. */
export function siteAgentDeletionPlan(database: D1DatabaseLike, siteAgentId: string): D1PreparedStatementLike[] {
  return [
    ...agentRunDeletionStatements(database, siteAgentId),
    ...effectDeletionStatements(database, siteAgentId),
    ...pageObservationDeletionStatements(database, siteAgentId),
    ...capabilityExperienceOutboxDeletionStatements(database, siteAgentId),
    ...modelResponseDeletionStatements(database, siteAgentId),
    ...runnerControlDeletionStatements(database, siteAgentId),
    ...capabilityCenterV2DeletionStatements(database, siteAgentId),
    ...capabilityModuleDeletionStatements(database, siteAgentId),
    ...capabilityCenterDeletionStatements(database, siteAgentId),
    ...siteAgentDeletionStatements(database, siteAgentId),
  ];
}

/**
 * Deletes only objects belonging to this site. Keys handed over by modules are prefixed
 * by the site id (`${id}/…` for evidence artifacts, `ccv2/${id}/…` for capability
 * artifacts and program modules); anything else is skipped and logged — better to leak
 * an object than delete someone else's.
 */
export function objectKeyBelongsToSite(key: string, siteAgentId: string) {
  return key.startsWith(`${siteAgentId}/`) || key.startsWith(`ccv2/${siteAgentId}/`);
}

async function deleteSiteObjects(database: D1DatabaseLike, siteAgentId: string) {
  const bucket = getArtifactBinding();
  const keys = [...new Set([
    ...(await siteAgentObjectKeys(database, siteAgentId)),
    ...(await capabilityCenterV2ObjectKeys(database, siteAgentId)),
    ...(await capabilityModuleObjectKeys(database, siteAgentId)),
  ])];
  if (!keys.length) return 0;
  if (!bucket) {
    // Object keys without a bucket binding: the artifacts were written in another
    // environment. Rows are deleted, objects stay — a deployment configuration issue
    // that must not block deletion, but should be said out loud.
    console.warn("site_agent_delete_objects_skipped", { siteAgentId, keys: keys.length, reason: "artifact_binding_unavailable" });
    return 0;
  }
  let deleted = 0;
  for (const key of keys) {
    if (!objectKeyBelongsToSite(key, siteAgentId)) {
      console.warn("site_agent_delete_object_key_foreign", { siteAgentId, key });
      continue;
    }
    try {
      await bucket.delete(key);
      deleted += 1;
    } catch (error) {
      throw new SiteAgentDataError(
        "site_agent_delete_objects_failed",
        `Object ${key} could not be deleted; the site was left intact.`,
        "site_agent_lookup",
        { status: 503, retryable: true, cause: error },
      );
    }
  }
  return deleted;
}

export async function deleteSiteAgent(siteAgentId: string): Promise<SiteAgentDeletionResult> {
  const id = siteAgentId.trim();
  if (!id || !(await siteAgentExists(id))) {
    throw new SiteAgentDataError("site_agent_not_found", "site_agent_not_found", "site_agent_lookup", { status: 404, retryable: false });
  }
  const database = getD1Binding();
  if (!database) {
    deleteMemoryAgentRunData(id);
    deleteMemoryEffectData(id);
    deleteMemoryPageObservationData(id);
    deleteMemoryCapabilityExperienceOutbox(id);
    deleteMemoryModelResponseData(id);
    deleteMemoryRunnerControlData(id);
    deleteMemoryCapabilityCenterV2Data(id);
    deleteMemoryCapabilityModules(id);
    deleteMemoryCapabilityCenterData(id);
    deleteMemoryCapabilityDebugData(id);
    deleteMemorySiteAgentData(id);
    return { deleted: true, persistence: "memory", objects: 0, statements: 0 };
  }
  await ensureSiteAgentV2Schema(database);
  await ensureSiteAgentV3Schema(database);
  await ensureCapabilityCenterV2Schema(database);
  const objects = await deleteSiteObjects(database, id);
  const statements = [
    ...siteAgentDeletionPlan(database, id),
    database.prepare(`DELETE FROM site_agent_v2_agents WHERE id=?`).bind(id),
  ];
  const results = await database.batch(statements);
  const failure = results.find((result) => !result.success);
  if (failure) {
    throw new SiteAgentDataError("site_agent_delete_failed", failure.error || "site_agent_delete_failed", "site_agent_lookup", { status: 503, retryable: true });
  }
  deleteMemoryCapabilityDebugData(id);
  deleteMemorySiteAgentData(id);
  return { deleted: true, persistence: "d1", objects, statements: statements.length };
}
