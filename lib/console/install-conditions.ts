import type { PolicyVerdict } from "./policy-findings";
import type { InstallReadiness } from "./install-readiness";
import { localHostname } from "./public-address-check";

/**
 * The three things that decide whether an install can work, in the order a
 * reader has to settle them:
 *
 *  1. this installation has an address a visitor's browser can load,
 *  2. the website answers at the address it is registered under,
 *  3. the website's own policy admits that address.
 *
 * The order is not cosmetic. Without (1) there is nothing to check (3) against,
 * so a console that reported policy directives before the address was settled
 * would be sending readers to edit the wrong thing. An unsettled condition
 * therefore leaves the ones below it pending rather than failing them.
 *
 * Both ends local — a site on this machine and a console on this machine — is
 * how development runs and a browser allows it, so there are no conditions at
 * all to report.
 */

export type ConditionState = "met" | "unmet" | "pending" | "unknown";

export type InstallCondition =
  | { id: "address"; state: ConditionState; origin: string; reason?: "insecure" | "local" | "malformed" | "unset" | "unreachable" }
  | { id: "site-address"; state: ConditionState; registered?: string; actual?: string; unreachable?: InstallReadiness["unreachable"] }
  | { id: "policy"; state: ConditionState; verdict?: PolicyVerdict; platform?: string };

export function installConditions(input: {
  siteUrl: string;
  /** The address the snippet will carry. */
  sdkOrigin: string;
  /** Whether that address is one a public website could load. */
  addressUsable: boolean;
  readiness?: InstallReadiness;
  policy?: PolicyVerdict | { source: "unknown" };
  platform?: string;
  /** Which rule the address falls foul of, when it cannot serve public sites. */
  addressUnusable?: "insecure" | "local" | "malformed" | "unset";
  /** What the last browser run proves about the address, when one has run. */
  rehearsal?: { ran: boolean; snippetPresent: boolean; connected: boolean };
}): InstallCondition[] {
  if (developmentPair(input.siteUrl, input.sdkOrigin)) return [];

  // The shape rules out mixed content; the rehearsal rules out an address that
  // simply does not answer. A snippet that reached the page and did not boot,
  // with no policy blocking it, is that second case.
  const policyBlocking = input.policy && input.policy.source !== "unknown" ? input.policy.blocked : false;
  const unreachable = Boolean(
    input.addressUsable
    && input.rehearsal?.ran
    && input.rehearsal.snippetPresent
    && !input.rehearsal.connected
    && !policyBlocking,
  );
  const address: InstallCondition = {
    id: "address",
    state: input.addressUsable && !unreachable ? "met" : "unmet",
    origin: input.sdkOrigin,
    ...(input.addressUsable
      ? (unreachable ? { reason: "unreachable" as const } : {})
      : { reason: input.addressUnusable || shapeReason(input.sdkOrigin) }),
  };
  if (address.state === "unmet") {
    return [address, { id: "site-address", state: "pending" }, { id: "policy", state: "pending" }];
  }

  const readiness = input.readiness;
  const siteAddress: InstallCondition = readiness?.unreachable
    ? { id: "site-address", state: "unknown", unreachable: readiness.unreachable }
    : readiness?.originMismatch
      ? { id: "site-address", state: "unmet", registered: readiness.originMismatch.registered, actual: readiness.originMismatch.actual }
      : { id: "site-address", state: readiness ? "met" : "pending" };

  const verdict = input.policy;
  const policy: InstallCondition = !verdict || verdict.source === "unknown"
    ? { id: "policy", state: "unknown" }
    : {
      id: "policy",
      state: verdict.blocked ? "unmet" : "met",
      verdict,
      ...(input.platform ? { platform: input.platform } : {}),
    };

  return [address, siteAddress, policy];
}

/** Which rule an address falls foul of, read from the address itself. */
function shapeReason(origin: string): "insecure" | "local" | "malformed" | "unset" {
  if (!origin) return "unset";
  let url: URL;
  try { url = new URL(origin); } catch { return "malformed"; }
  if (localHostname(url.hostname)) return "local";
  return url.protocol === "http:" ? "insecure" : "malformed";
}

/** Anything a reader still has to act on before the snippet can work. */
export function conditionsBlocked(conditions: readonly InstallCondition[]) {
  return conditions.some((condition) => condition.state === "unmet");
}

/** A website and a console that are both on this machine or this LAN. */
export function developmentPair(siteUrl: string, sdkOrigin: string) {
  try {
    return localHostname(new URL(siteUrl).hostname) && localHostname(new URL(sdkOrigin).hostname);
  } catch {
    return false;
  }
}
