import { lookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { getD1Binding } from "@/db";
import { ensureInstallationId, getPublicAddress, savePublicAddress } from "@/lib/public-address";
import {
  attributePublicAddressFailure,
  normalizePublicAddress,
  publicAddressVerified,
  publicMachineAddresses,
  type PublicAddressProbe,
} from "@/lib/console/public-address-check";
import { managementAuthorized, managementMutationAuthorized, siteAgentJson } from "../../site-agents/http";

/**
 * The address visitors load SiteWake from. A read says what is configured and
 * where it came from; a write only succeeds for an address that was shown to
 * reach this control plane, either from here or from the administrator's own
 * browser (see lib/console/public-address-check.ts for why both).
 */

export const runtime = "nodejs";

/** Ask one address whether this control plane is behind it. */
async function probe(origin: string): Promise<PublicAddressProbe> {
  try {
    const response = await fetch(`${origin}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
    const body = await response.json().catch(() => ({})) as { installationId?: string };
    if (!body.installationId) return { ok: false, error: `no installation id (status ${response.status})` };
    return { ok: true, installationId: body.installationId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown" };
  }
}

/** What this machine can honestly claim as its own, for explaining a DNS record. */
function localAddresses() {
  const configured = process.env.SITEWAKE_PUBLIC_IP?.trim();
  const interfaces = Object.values(networkInterfaces()).flat()
    .filter((entry) => entry && !entry.internal)
    .map((entry) => entry!.address);
  return publicMachineAddresses([...(configured ? [configured] : []), ...interfaces]);
}

export async function GET(request: Request) {
  if (!(await managementAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  const address = getPublicAddress();
  // Which rule an address falls foul of decides what the console says about
  // it: http is mixed content, a local address is the local network rule, and
  // no address at all is simply local mode.
  const shape = address.origin ? normalizePublicAddress(address.origin) : { reason: "unset" as const, detail: "" };
  const unusable = "reason" in shape ? shape.reason : undefined;
  return siteAgentJson({
    ...address,
    installationId: await ensureInstallationId(getD1Binding()),
    usableForPublicSites: !unusable,
    ...(unusable ? { unusable } : {}),
  }, 200, { "cache-control": "no-store" });
}

export async function PUT(request: Request) {
  if (!(await managementMutationAuthorized(request))) return siteAgentJson({ error: "unauthorized" }, 401);
  let body: { origin?: unknown; browserProbe?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return siteAgentJson({ error: "invalid_json" }, 400); }

  const normalized = normalizePublicAddress(String(body.origin || ""));
  if ("reason" in normalized) return siteAgentJson({ error: "public_address_rejected", ...normalized }, 400);

  const installationId = await ensureInstallationId(getD1Binding());
  const serverProbe = await probe(normalized.origin);
  const browserProbe = parseBrowserProbe(body.browserProbe);
  if (!publicAddressVerified({ serverProbe, browserProbe, installationId })) {
    const resolved = await resolveAll(normalized.origin);
    const failure = attributePublicAddressFailure({
      serverProbe,
      browserProbe,
      installationId,
      resolved,
      expected: localAddresses(),
    });
    return siteAgentJson({ error: "public_address_unverified", ...failure }, 400);
  }

  try {
    const saved = await savePublicAddress(normalized.origin, getD1Binding());
    return siteAgentJson({ ...saved, installationId, usableForPublicSites: true }, 200, { "cache-control": "no-store" });
  } catch (error) {
    return siteAgentJson({ error: "public_address_save_failed", message: error instanceof Error ? error.message : "unknown" }, 503);
  }
}

/** The administrator's browser reports what it saw; it is evidence, not authority. */
function parseBrowserProbe(value: unknown): PublicAddressProbe | undefined {
  if (!value || typeof value !== "object") return undefined;
  const probe = value as { ok?: unknown; installationId?: unknown; error?: unknown };
  if (probe.ok === true && typeof probe.installationId === "string") return { ok: true, installationId: probe.installationId };
  if (probe.ok === false) return { ok: false, error: typeof probe.error === "string" ? probe.error : "unknown" };
  return undefined;
}

async function resolveAll(origin: string) {
  try {
    const entries = await lookup(new URL(origin).hostname, { all: true });
    return entries.map((entry) => entry.address);
  } catch {
    return [];
  }
}
