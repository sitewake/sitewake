import type { D1DatabaseLike } from "../db/index";
import { getRuntimeSetting, putRuntimeSetting } from "../db/runtime-settings-store";

/**
 * The address a visitor's browser loads SiteWake from.
 *
 * It is deliberately not the address an administrator opens the console at:
 * that one may be localhost, a LAN IP or a port-forward, and none of those can
 * serve a website on the internet. The install snippet uses this value and
 * nothing else.
 *
 * Like the model configuration, it is a setting rather than a deployment
 * variable: a domain and a certificate are usually arranged after the install,
 * and editing `.env` plus restarting the stack is where a non-expert gives up.
 * `SITEWAKE_PUBLIC_ORIGIN` remains the factory default the installer writes.
 */

export const PUBLIC_ADDRESS_KEY = "public-address";
export const INSTALLATION_ID_KEY = "installation-id";

export type PublicAddressSource = "console" | "env" | "none";

export type PublicAddress = {
  /** The origin itself, or "" when nothing is configured. */
  origin: string;
  source: PublicAddressSource;
};

type SavedPublicAddress = { origin: string; verifiedAt: string };

let cached: PublicAddress | undefined;

function fromEnvironment(): PublicAddress {
  const raw = process.env.SITEWAKE_PUBLIC_ORIGIN?.trim() || "";
  if (!raw) return { origin: "", source: "none" };
  try { return { origin: new URL(raw).origin, source: "env" }; }
  catch { return { origin: "", source: "none" }; }
}

/**
 * Fill the process cache from `runtime_settings`. A saved address wins over the
 * environment; a missing row or a failed read leaves the environment in charge,
 * which is exactly what a fresh install has.
 */
export async function loadPublicAddress(database: D1DatabaseLike | null) {
  try {
    const row = await getRuntimeSetting<SavedPublicAddress>(PUBLIC_ADDRESS_KEY, database);
    const saved = row?.value?.origin?.trim();
    cached = saved ? { origin: saved, source: "console" } : fromEnvironment();
  } catch {
    cached = fromEnvironment();
  }
  return cached;
}

const loadedByDatabase = new WeakMap<object, Promise<PublicAddress>>();
let loadedWithoutDatabase: Promise<PublicAddress> | undefined;

export function ensurePublicAddressLoaded(database: D1DatabaseLike | null) {
  if (!database) return (loadedWithoutDatabase ??= loadPublicAddress(null));
  let pending = loadedByDatabase.get(database as object);
  if (!pending) {
    pending = loadPublicAddress(database);
    loadedByDatabase.set(database as object, pending);
  }
  return pending;
}

/** The configured address as every reader sees it, without touching the database. */
export function getPublicAddress(): PublicAddress {
  return cached ?? fromEnvironment();
}

export async function savePublicAddress(origin: string, database: D1DatabaseLike | null, updatedBy = "console") {
  const value: SavedPublicAddress = { origin, verifiedAt: new Date().toISOString() };
  await putRuntimeSetting(PUBLIC_ADDRESS_KEY, value, database, updatedBy);
  cached = { origin, source: "console" };
  const settled = Promise.resolve(cached);
  if (database) loadedByDatabase.set(database as object, settled); else loadedWithoutDatabase = settled;
  return cached;
}

/** Test hook: forget what was loaded. */
export function resetPublicAddressCache() {
  cached = undefined;
  loadedWithoutDatabase = undefined;
}

/**
 * This installation's identifier. It exists so that "does this address reach
 * this control plane" has a factual answer: the address is fetched and the
 * identifier compared. It is random, carries no authority, and is readable by
 * anyone who can reach the health endpoint.
 */
let installationId: string | undefined;

export async function ensureInstallationId(database: D1DatabaseLike | null) {
  if (installationId) return installationId;
  const configured = process.env.SITEWAKE_INSTALLATION_ID?.trim();
  if (configured) {
    installationId = configured;
    return installationId;
  }
  try {
    const row = await getRuntimeSetting<{ id: string }>(INSTALLATION_ID_KEY, database);
    if (row?.value?.id) {
      installationId = row.value.id;
      return installationId;
    }
  } catch {
    // A database that cannot be read yet must not stop the control plane from
    // answering; the identifier is generated and stored on the next attempt.
  }
  const generated = crypto.randomUUID();
  try {
    await putRuntimeSetting(INSTALLATION_ID_KEY, { id: generated }, database, "control-plane");
    installationId = generated;
  } catch {
    // Not persisted: still usable for this process, and the next start tries again.
    return generated;
  }
  return installationId;
}

/** Test hook: forget the identifier this process is holding. */
export function resetInstallationId() {
  installationId = undefined;
}
