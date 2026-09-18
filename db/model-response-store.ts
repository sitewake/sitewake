import { getD1Binding, type D1DatabaseLike, type D1PreparedStatementLike } from "./index";
import { ensureSiteAgentV2Schema } from "./site-agent-schema";
import type { ResponsesConversation } from "../lib/site-knowledge/responses-protocol";

const memory = new Map<string, { conversation: ResponsesConversation; expiresAt: number }>();

function memoryKey(siteAgentId: string, id: string) {
  return `${siteAgentId}\0${id}`;
}

function pruneMemory(now: number) {
  for (const [key, cached] of memory) {
    if (cached.expiresAt <= now) memory.delete(key);
  }
}

export async function readModelResponseConversation(siteAgentId: string, id: unknown) {
  if (typeof id !== "string" || !id) return undefined;
  const now = Date.now();
  pruneMemory(now);
  const key = memoryKey(siteAgentId, id);
  const cached = memory.get(key);
  if (cached) return cached.conversation;
  const database = getD1Binding();
  if (!database) return undefined;
  await ensureSiteAgentV2Schema(database);
  await database.prepare(
    `DELETE FROM site_agent_v2_model_response_history WHERE expires_at<=?`,
  ).bind(new Date(now).toISOString()).run();
  const result = await database.prepare(
    `SELECT conversation_json, expires_at
       FROM site_agent_v2_model_response_history
      WHERE id=? AND site_agent_id=? AND expires_at>?
      LIMIT 1`,
  ).bind(id, siteAgentId, new Date(now).toISOString()).all<{ conversation_json: string; expires_at: string }>();
  const row = result.results?.[0];
  if (!row) return undefined;
  let conversation: ResponsesConversation;
  try {
    conversation = JSON.parse(row.conversation_json) as ResponsesConversation;
  } catch {
    await database.prepare(
      `DELETE FROM site_agent_v2_model_response_history WHERE id=? AND site_agent_id=?`,
    ).bind(id, siteAgentId).run();
    return undefined;
  }
  memory.set(key, { conversation, expiresAt: Date.parse(row.expires_at) });
  return conversation;
}

export async function saveModelResponseConversation(siteAgentId: string, id: string, conversation: ResponsesConversation, ttlMs = 10 * 60_000) {
  const now = Date.now();
  const expiresAt = now + ttlMs;
  pruneMemory(now);
  if (expiresAt > now) memory.set(memoryKey(siteAgentId, id), { conversation, expiresAt });
  const database = getD1Binding();
  if (!database) return;
  await ensureSiteAgentV2Schema(database);
  await database.prepare(
    `DELETE FROM site_agent_v2_model_response_history WHERE expires_at<=?`,
  ).bind(new Date(now).toISOString()).run();
  await database.prepare(
    `INSERT INTO site_agent_v2_model_response_history
      (id,site_agent_id,conversation_json,expires_at,created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
      site_agent_id=excluded.site_agent_id,
      conversation_json=excluded.conversation_json,
      expires_at=excluded.expires_at`,
  ).bind(id, siteAgentId, JSON.stringify(conversation), new Date(expiresAt).toISOString(), new Date(now).toISOString()).run();
}

/** On site deletion: Responses conversation history. The memory key is `${siteAgentId}\0${id}`. */
export function modelResponseDeletionStatements(database: D1DatabaseLike, siteAgentId: string): D1PreparedStatementLike[] {
  return [database.prepare(`DELETE FROM site_agent_v2_model_response_history WHERE site_agent_id=?`).bind(siteAgentId)];
}

export function deleteMemoryModelResponseData(siteAgentId: string) {
  const prefix = memoryKey(siteAgentId, "");
  for (const key of memory.keys()) if (key.startsWith(prefix)) memory.delete(key);
}
