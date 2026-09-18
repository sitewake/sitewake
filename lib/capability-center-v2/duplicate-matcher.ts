import { listCapabilities } from "../../db/capability-center-v2-store";
import { getModelConfig } from "../model-config";
import type { CapabilityTaskInput } from "./model";
import { requestStructuredModelJson } from "./model-json";
import { DUPLICATE_CHECK_PROMPT } from "./prompts/duplicate-check";

function normalize(value: string) { return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, "").trim(); }
function score(query: string, candidate: string) {
  const characters = [...new Set(normalize(query))];
  if (!characters.length) return 0;
  const target = normalize(candidate); return characters.filter((character) => target.includes(character)).length / characters.length;
}
export async function findDuplicateCapability(siteId: string, goal: string, summary?: CapabilityTaskInput["candidateSummary"]) {
  const query = [goal, summary?.name, summary?.description, ...(summary?.aliases || [])].filter(Boolean).join(" ");
  const capabilities = (await listCapabilities(siteId, { includeDeleted: false })).capabilities.filter((item) => ["Active", "Disabled", "Building"].includes(item.status));
  const exact = capabilities.find((item) => normalize(item.name) === normalize(summary?.name || goal));
  if (exact) return exact;
  const candidates = capabilities.map((item) => ({ item, score: score(query, item.searchText) })).filter((entry) => entry.score >= 0.25).sort((a, b) => b.score - a.score).slice(0, 30);
  if (!candidates.length) return undefined;
  const config = getModelConfig("semantic");
  if (!config.configured) throw new Error("capability_duplicate_check_unavailable: semantic_model_not_configured");
  try {
    const candidateIds = new Set(candidates.map(({ item }) => item.id));
    const result = await requestStructuredModelJson(config, {
      system: DUPLICATE_CHECK_PROMPT.text,
      payload: { proposed: { goal, summary }, candidates: candidates.map(({ item }) => ({ capabilityId: item.id, name: item.name, description: item.description, aliases: item.aliases, contract: item.contract, status: item.status })) },
      timeoutMs: 30_000,
      attempts: 2,
      jsonSchema: DUPLICATE_CHECK_PROMPT.outputSchema,
      validate: (value) => {
        if (value.capabilityId !== null && (typeof value.capabilityId !== "string" || !candidateIds.has(value.capabilityId))) throw new Error("duplicate_capability_id_invalid");
        if (typeof value.reason !== "string") throw new Error("duplicate_reason_required");
      },
    });
    const capabilityId = typeof result.capabilityId === "string" ? result.capabilityId : undefined;
    return capabilityId ? candidates.find(({ item }) => item.id === capabilityId)?.item : undefined;
  } catch (cause) {
    // Unknown is not a negative decision. The durable intake retries this error
    // instead of creating another ability during a provider outage.
    throw new Error("capability_duplicate_check_unavailable", { cause });
  }
}
