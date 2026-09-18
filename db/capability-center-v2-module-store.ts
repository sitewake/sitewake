import { getArtifactBinding, getD1Binding, type D1DatabaseLike, type D1PreparedStatementLike } from "./index";
import { ensureCapabilityCenterV2Schema } from "./capability-center-v2-schema";
import {
  CAPABILITY_V2_MODULE_MIME,
  capabilityModuleHash,
  validateCapabilityJavaScriptSource,
} from "../lib/capability-center-v2/javascript-runtime";
import type { CapabilityModuleRef } from "../lib/capability-center-v2/model";

const memoryModules = new Map<string, { siteId: string; source: string; createdAt: string }>();

function key(siteId: string, contentHash: string) {
  return `ccv2/modules/${encodeURIComponent(siteId)}/${contentHash}.mjs`;
}

function moduleUrl(siteId: string, contentHash: string) {
  return `/api/capability-v2/modules/${contentHash}?siteId=${encodeURIComponent(siteId)}`;
}

async function readDatabaseModule(database: D1DatabaseLike, siteId: string, contentHash: string) {
  await ensureCapabilityCenterV2Schema(database);
  const result = await database.prepare(`SELECT source_text,storage_key,created_at FROM ccv2_program_modules WHERE site_id=? AND content_hash=? LIMIT 1`).bind(siteId, contentHash).all<{
    source_text: string;
    storage_key: string;
    created_at: string;
  }>();
  if (!result.success) throw new Error(result.error || "capability_module_read_failed");
  return result.results?.[0];
}

async function saveDatabaseModule(database: D1DatabaseLike, siteId: string, contentHash: string, source: string, storageKey: string) {
  await ensureCapabilityCenterV2Schema(database);
  const result = await database.prepare(`INSERT INTO ccv2_program_modules (site_id,content_hash,source_text,storage_key,size,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(site_id,content_hash) DO NOTHING`)
    .bind(siteId, contentHash, source, storageKey, new TextEncoder().encode(source).byteLength, new Date().toISOString())
    .run();
  if (!result.success) throw new Error(result.error || "capability_module_write_failed");
}

export async function putCapabilityV2Module(siteId: string, source: string): Promise<{ module: CapabilityModuleRef; created: boolean }> {
  const normalized = source.replace(/\r\n/g, "\n").trim();
  const validation = validateCapabilityJavaScriptSource(normalized);
  if (!validation.ok) throw Object.assign(new Error(validation.message), { code: validation.code, status: 400 });
  const contentHash = await capabilityModuleHash(normalized);
  const storageKey = key(siteId, contentHash);
  const binding = getArtifactBinding();
  const database = getD1Binding();
  let created = false;
  const existingDatabaseModule = database ? await readDatabaseModule(database, siteId, contentHash) : undefined;
  if (binding) {
    const existing = await binding.get(storageKey);
    if (!existing) {
      const bytes = new TextEncoder().encode(normalized);
      const buffer = new ArrayBuffer(bytes.byteLength); new Uint8Array(buffer).set(bytes);
      await binding.put(storageKey, buffer, {
        httpMetadata: { contentType: CAPABILITY_V2_MODULE_MIME },
        customMetadata: { siteId, contentHash, immutable: "true" },
      });
      created = true;
    }
  }
  if (database) {
    await saveDatabaseModule(database, siteId, contentHash, normalized, storageKey);
    if (!existingDatabaseModule) created = true;
  } else if (!binding && !memoryModules.has(storageKey)) {
    memoryModules.set(storageKey, { siteId, source: normalized, createdAt: new Date().toISOString() });
    created = true;
  }
  return { module: { contentHash, moduleUrl: moduleUrl(siteId, contentHash), exportName: "capability" }, created };
}

export async function getCapabilityV2Module(siteId: string, contentHash: string) {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) return undefined;
  const storageKey = key(siteId, contentHash);
  const binding = getArtifactBinding();
  const database = getD1Binding();
  let source: string | undefined;
  if (binding) {
    const stored = await binding.get(storageKey);
    if (stored) source = await new Response(stored.body).text();
  }
  if (!source && database) source = (await readDatabaseModule(database, siteId, contentHash))?.source_text;
  if (!source && !binding && !database) {
    const stored = memoryModules.get(storageKey);
    if (!stored || stored.siteId !== siteId) return undefined;
    source = stored.source;
  }
  if (!source) return undefined;
  const actualHash = await capabilityModuleHash(source);
  if (actualHash !== contentHash) throw Object.assign(new Error("capability_module_hash_mismatch"), { code: "capability_module_hash_mismatch", status: 409 });
  const validation = validateCapabilityJavaScriptSource(source);
  if (!validation.ok) throw Object.assign(new Error(validation.message), { code: validation.code, status: 409 });
  return { source, contentHash, contentType: CAPABILITY_V2_MODULE_MIME, storageKey };
}

export function resetCapabilityV2ModulesForTests() {
  memoryModules.clear();
}

/** On site deletion: program module rows, their source files in object storage, and the memory-mode module cache. */
export function capabilityModuleDeletionStatements(database: D1DatabaseLike, siteId: string): D1PreparedStatementLike[] {
  return [database.prepare(`DELETE FROM ccv2_program_modules WHERE site_id=?`).bind(siteId)];
}

export async function capabilityModuleObjectKeys(database: D1DatabaseLike, siteId: string): Promise<string[]> {
  const rows = await database.prepare(`SELECT storage_key AS storageKey FROM ccv2_program_modules WHERE site_id=?`).bind(siteId).all<{ storageKey: string }>();
  return (rows.results || []).map((row) => row.storageKey).filter(Boolean);
}

export function deleteMemoryCapabilityModules(siteId: string) {
  for (const [key, item] of memoryModules) if (item.siteId === siteId) memoryModules.delete(key);
}
