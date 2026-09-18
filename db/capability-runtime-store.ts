import { getD1Binding, type D1DatabaseLike } from "./index";
import { ensureSiteAgentV2Schema } from "./site-agent-schema";
import type { Capability, CapabilityVersion } from "../lib/capability-center/model";

type CapabilityMemory = {
  capabilities: Capability[];
  versions: CapabilityVersion[];
};

type CapabilityMemoryRoot = typeof globalThis & {
  __SITEWAKE_CAPABILITY_CENTER_V2__?: Map<string, CapabilityMemory>;
};

type CapabilityRuntimeRow = {
  id: string;
  siteAgentId: string;
  stableKey: string;
  intentKey: string;
  name: string;
  description: string;
  goalTemplate: string;
  status: Capability["status"];
  capabilityJson: string;
  contractJson: string;
  currentVersionId?: string | null;
  latestVersionId?: string | null;
  unpublishedAt?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type CapabilityVersionRuntimeRow = {
  id: string;
  siteAgentId: string;
  capabilityId: string;
  version: number | string;
  status: CapabilityVersion["status"];
  implementationJson: string;
  validationJson: string;
  versionJson: string;
  publishedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

async function all<T>(database: D1DatabaseLike, sql: string, values: unknown[]) {
  const result = await database.prepare(sql).bind(...values).all<T>();
  if (!result.success) throw new Error(result.error || "capability_runtime_query_failed");
  return result.results || [];
}

function json<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

async function exactCapabilityAndVersion(
  siteAgentId: string,
  capabilityId: string,
  versionId?: string,
): Promise<{ capability?: Capability; version?: CapabilityVersion }> {
  const database = getD1Binding();
  if (!database) {
    const memory = (globalThis as CapabilityMemoryRoot)
      .__SITEWAKE_CAPABILITY_CENTER_V2__?.get(siteAgentId);
    const capability = memory?.capabilities.find((item) => item.id === capabilityId);
    const selectedVersionId = versionId || capability?.currentVersionId;
    return {
      capability,
      version: memory?.versions.find((item) => item.id === selectedVersionId),
    };
  }
  await ensureSiteAgentV2Schema(database);
  const capabilities = await all<CapabilityRuntimeRow>(database, `SELECT
      id,
      site_agent_id AS siteAgentId,
      stable_key AS stableKey,
      intent_key AS intentKey,
      name,
      description,
      goal_template AS goalTemplate,
      status,
      capability_json AS capabilityJson,
      contract_json AS contractJson,
      current_version_id AS currentVersionId,
      latest_version_id AS latestVersionId,
      unpublished_at AS unpublishedAt,
      deleted_at AS deletedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM site_agent_v2_capabilities
    WHERE id=? AND site_agent_id=? LIMIT 1`, [capabilityId, siteAgentId]);
  if (!capabilities[0]) return {};
  const capabilityMetadata = json<Partial<Capability>>(capabilities[0].capabilityJson, {});
  const contract = json<Pick<Capability, "inputSchema" | "outputSchema">>(
    capabilities[0].contractJson,
    { inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: {} } },
  );
  const capability = {
    ...capabilityMetadata,
    ...contract,
    id: capabilities[0].id,
    siteAgentId: capabilities[0].siteAgentId,
    stableKey: capabilities[0].stableKey,
    intentKey: capabilities[0].intentKey,
    name: capabilities[0].name,
    description: capabilities[0].description,
    goalTemplate: capabilities[0].goalTemplate,
    status: capabilities[0].status,
    currentVersionId: capabilities[0].currentVersionId || undefined,
    latestVersionId: capabilities[0].latestVersionId || undefined,
    unpublishedAt: capabilities[0].unpublishedAt || undefined,
    deletedAt: capabilities[0].deletedAt || undefined,
    createdAt: capabilities[0].createdAt,
    updatedAt: capabilities[0].updatedAt,
  } as Capability;
  const selectedVersionId = versionId || capability.currentVersionId;
  if (!selectedVersionId) return { capability };
  const versions = await all<CapabilityVersionRuntimeRow>(database, `SELECT
      id,
      site_agent_id AS siteAgentId,
      capability_id AS capabilityId,
      version,
      status,
      implementation_json AS implementationJson,
      validation_json AS validationJson,
      version_json AS versionJson,
      published_at AS publishedAt,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM site_agent_v2_capability_versions
    WHERE id=? AND site_agent_id=? AND capability_id=? LIMIT 1`,
  [selectedVersionId, siteAgentId, capabilityId]);
  if (!versions[0]) return { capability };
  const versionMetadata = json<Partial<CapabilityVersion>>(versions[0].versionJson, {});
  const version = {
    ...versionMetadata,
    id: versions[0].id,
    siteAgentId: versions[0].siteAgentId,
    capabilityId: versions[0].capabilityId,
    version: Number(versions[0].version),
    status: versions[0].status,
    implementation: json(versions[0].implementationJson, undefined),
    validation: json(versions[0].validationJson, undefined),
    publishedAt: versions[0].publishedAt || versionMetadata.publishedAt,
    createdAt: versions[0].createdAt,
    updatedAt: versions[0].updatedAt,
  } as CapabilityVersion;
  return { capability, version };
}

function assertExecutable(
  capability: Capability,
  version: CapabilityVersion | undefined,
  expectedRelease?: { id: string; version: number },
) {
  if (capability.deletedAt || capability.status === "deleted") {
    throw new Error("capability_deleted");
  }
  if (capability.status === "unpublished") {
    throw new Error("capability_unpublished");
  }
  if (capability.status !== "active" && capability.status !== "degraded") {
    throw new Error("capability_not_published");
  }
  if (!capability.currentVersionId) throw new Error("capability_current_version_missing");
  if (!version || version.id !== capability.currentVersionId) {
    throw new Error("capability_current_version_mismatch");
  }
  if (version.status !== "published") throw new Error("capability_version_not_published");
  if (version.validation?.status !== "passed") throw new Error("capability_version_not_validated");
  if (!version.validation.startUrl) throw new Error("capability_version_start_url_missing");
  if (!version.publishedReleaseId || version.publishedReleaseVersion === undefined) {
    throw new Error("capability_version_release_missing");
  }
  if (expectedRelease
    && (version.publishedReleaseId !== expectedRelease.id
      || version.publishedReleaseVersion !== expectedRelease.version)) {
    throw new Error("capability_version_release_mismatch");
  }
}

/** Returns undefined only when no four-table Capability exists, enabling legacy fallback. */
export async function resolveCurrentCapabilityVersion(
  siteAgentId: string,
  capabilityId: string,
) {
  const resolved = await exactCapabilityAndVersion(siteAgentId, capabilityId);
  if (!resolved.capability) return undefined;
  assertExecutable(resolved.capability, resolved.version);
  return { capability: resolved.capability, version: resolved.version! };
}

/** Revalidates the exact Version/Release pins carried by an immutable Run. */
export async function assertPinnedCapabilityVersion(input: {
  siteAgentId: string;
  capabilityId: string;
  capabilityVersionId: string;
  releaseId: string;
  releaseVersion: number;
}) {
  const resolved = await exactCapabilityAndVersion(
    input.siteAgentId,
    input.capabilityId,
    input.capabilityVersionId,
  );
  if (!resolved.capability || !resolved.version) {
    throw new Error("capability_version_not_found");
  }
  if (resolved.version.status !== "published") {
    throw new Error("capability_version_not_published");
  }
  if (resolved.version.validation?.status !== "passed") {
    throw new Error("capability_version_not_validated");
  }
  if (resolved.version.publishedReleaseId !== input.releaseId
    || resolved.version.publishedReleaseVersion !== input.releaseVersion) {
    throw new Error("capability_version_release_mismatch");
  }
  return { capability: resolved.capability, version: resolved.version };
}
