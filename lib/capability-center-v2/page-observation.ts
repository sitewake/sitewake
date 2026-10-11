import type { JsonValue, PageAgentObservation } from "../site-knowledge/protocol";
import { sha256HexText } from "../site-knowledge/sha256";

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
}

/** Retention metadata and the digest itself are mutable/derived, not evidence. */
export function pageObservationHashPayload(observation: PageAgentObservation) {
  const { sha256, expiresAt, ...evidence } = observation;
  void sha256;
  void expiresAt;
  return JSON.stringify(canonical(evidence as unknown as JsonValue));
}

export async function pageObservationSha256(observation: PageAgentObservation) {
  return sha256HexText(pageObservationHashPayload(observation));
}
