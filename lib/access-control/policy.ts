import { getD1Binding } from "../../db";
import { ensureAccessControlSchema } from "../../db/access-control-schema";
import {
  PBKDF2_ITERATIONS,
  hashPassword,
  randomHex,
  secretEquals,
  timingSafeEqualHex,
  verifySessionCookieValue,
} from "./session";

// The public, secret-free view of the policy. This is safe to serve to the
// browser and to embed in the gate UI.
export type AccessStatus = {
  configured: boolean;
  enabled: boolean;
  updatedAt: string | null;
};

export type AccessGateState = {
  locked: boolean;
  configured: boolean;
  enabled: boolean;
  unavailable?: boolean;
};

export type ManageAction = "setPassword" | "enable" | "disable" | "revokeSessions";

export type ManageInput = {
  password?: string;
  currentPassword?: string;
  adminKey?: string;
};

export type ManageResult =
  | { ok: true; status: AccessStatus }
  | { ok: false; error: string; code: number };

type PolicyRecord = {
  enabled: boolean;
  passwordHash: string | null;
  passwordSalt: string | null;
  hashIterations: number;
  sessionSecret: string | null;
  updatedAt: string | null;
};

function adminKeyConfigured(): string | null {
  const key = process.env.ACCESS_ADMIN_KEY?.trim();
  return key ? key : null;
}

function isConfigured(record: PolicyRecord | null): boolean {
  return !!(record?.passwordHash && record?.passwordSalt);
}

function statusOf(record: PolicyRecord | null): AccessStatus {
  const configured = isConfigured(record);
  return {
    configured,
    enabled: !!(record?.enabled && configured),
    updatedAt: record?.updatedAt ?? null,
  };
}

async function loadPolicyRecord(): Promise<PolicyRecord | null> {
  const database = getD1Binding();
  if (!database) return null;
  await ensureAccessControlSchema(database);
  const result = await database
    .prepare(
      `SELECT enabled, password_hash, password_salt, hash_iterations, session_secret, updated_at
       FROM site_access_v1_policy WHERE id='default' LIMIT 1`,
    )
    .all<{
      enabled: number;
      password_hash: string | null;
      password_salt: string | null;
      hash_iterations: number;
      session_secret: string | null;
      updated_at: string | null;
    }>();
  if (!result.success) throw new Error(result.error || "access_policy_read_failed");
  const row = result.results?.[0];
  if (!row) return null;
  return {
    enabled: Number(row.enabled) === 1,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    hashIterations: Number(row.hash_iterations) || PBKDF2_ITERATIONS,
    sessionSecret: row.session_secret,
    updatedAt: row.updated_at,
  };
}

async function savePolicyRecord(record: PolicyRecord): Promise<string> {
  const database = getD1Binding();
  if (!database) throw new Error("access_policy_store_unavailable");
  await ensureAccessControlSchema(database);
  const updatedAt = new Date().toISOString();
  const result = await database
    .prepare(
      `INSERT OR REPLACE INTO site_access_v1_policy
         (id, enabled, password_hash, password_salt, hash_iterations, session_secret, updated_at)
       VALUES ('default', ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.enabled ? 1 : 0,
      record.passwordHash,
      record.passwordSalt,
      record.hashIterations,
      record.sessionSecret,
      updatedAt,
    )
    .run();
  if (!result.success) throw new Error(result.error || "access_policy_write_failed");
  return updatedAt;
}

// Availability over strictness: if the policy cannot be read (no database, or a
// transient error), the gate opens rather than locking every visitor — and the
// admin — out of the site. The management API refuses to write in that state.
export async function getAccessStatus(): Promise<AccessStatus> {
  try {
    return statusOf(await loadPolicyRecord());
  } catch {
    return { configured: false, enabled: false, updatedAt: null };
  }
}

export async function resolveAccessGate(cookieValue: string | undefined): Promise<AccessGateState> {
  let record: PolicyRecord | null;
  try {
    record = await loadPolicyRecord();
  } catch {
    return {
      locked: false,
      configured: false,
      enabled: false,
      unavailable: true,
    };
  }
  const status = statusOf(record);
  if (!status.enabled || !record?.sessionSecret) return { locked: false, configured: status.configured, enabled: status.enabled };
  const valid = await verifySessionCookieValue(record.sessionSecret, cookieValue, Date.now());
  return { locked: !valid, configured: status.configured, enabled: status.enabled };
}

// Control-plane writes must fail closed when the policy store cannot be read.
// A missing policy is an intentional open installation; a read failure is not.
export async function authorizeManagementSession(cookieValue: string | undefined): Promise<boolean> {
  let record: PolicyRecord | null;
  try {
    record = await loadPolicyRecord();
  } catch {
    return false;
  }
  const status = statusOf(record);
  if (!status.enabled) return true;
  if (!record?.sessionSecret) return false;
  return verifySessionCookieValue(record.sessionSecret, cookieValue, Date.now());
}

// Returns the active session secret only on a correct password so the caller can
// mint a signed cookie. A wrong password reveals nothing about configuration.
export async function verifyAccessPassword(password: string): Promise<{ ok: boolean; sessionSecret?: string }> {
  const record = await loadPolicyRecord();
  if (!isConfigured(record) || !record) return { ok: false };
  const candidate = await hashPassword(password, record.passwordSalt as string, record.hashIterations);
  const ok = timingSafeEqualHex(candidate, record.passwordHash as string);
  if (!ok || !record.sessionSecret) return { ok };
  return { ok: true, sessionSecret: record.sessionSecret };
}

// Management is authorized by the environment master key when one is set;
// otherwise by the current password. Before any password exists the site is open
// anyway, so the first setup is unauthenticated by design (bootstrap).
async function authorizeManagement(record: PolicyRecord | null, input: ManageInput): Promise<boolean> {
  const adminKey = adminKeyConfigured();
  if (adminKey) return typeof input.adminKey === "string" && (await secretEquals(input.adminKey, adminKey));
  if (!isConfigured(record)) return true;
  if (typeof input.currentPassword !== "string") return false;
  const candidate = await hashPassword(input.currentPassword, record!.passwordSalt as string, record!.hashIterations);
  return timingSafeEqualHex(candidate, record!.passwordHash as string);
}

export async function applyManagement(action: ManageAction, input: ManageInput): Promise<ManageResult> {
  if (!getD1Binding()) return { ok: false, error: "storage_unavailable", code: 503 };
  const record = await loadPolicyRecord();
  if (!(await authorizeManagement(record, input))) return { ok: false, error: "unauthorized", code: 401 };

  const next: PolicyRecord = record ?? {
    enabled: false,
    passwordHash: null,
    passwordSalt: null,
    hashIterations: PBKDF2_ITERATIONS,
    sessionSecret: null,
    updatedAt: null,
  };

  switch (action) {
    case "setPassword": {
      const password = typeof input.password === "string" ? input.password : "";
      if (password.length < 6) return { ok: false, error: "password_too_short", code: 400 };
      const salt = randomHex(16);
      next.passwordSalt = salt;
      next.hashIterations = PBKDF2_ITERATIONS;
      next.passwordHash = await hashPassword(password, salt, PBKDF2_ITERATIONS);
      // A new password rotates the session secret (old cookies stop working) and
      // turns the gate on, so setting a password immediately protects the site.
      next.sessionSecret = randomHex(32);
      next.enabled = true;
      break;
    }
    case "enable": {
      if (!isConfigured(next)) return { ok: false, error: "not_configured", code: 400 };
      if (!next.sessionSecret) next.sessionSecret = randomHex(32);
      next.enabled = true;
      break;
    }
    case "disable": {
      next.enabled = false;
      break;
    }
    case "revokeSessions": {
      next.sessionSecret = randomHex(32);
      break;
    }
    default:
      return { ok: false, error: "unknown_action", code: 400 };
  }

  next.updatedAt = await savePolicyRecord(next);
  return { ok: true, status: statusOf(next) };
}
