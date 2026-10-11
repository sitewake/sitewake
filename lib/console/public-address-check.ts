/**
 * Deciding whether an address a reader typed can actually serve their website,
 * and — when it cannot — which of the three things they have to go and do.
 *
 * The question has exactly one sufficient answer: fetch that address and see
 * whether this control plane answers. That single fact proves the DNS record,
 * the certificate and the reverse proxy all at once. The breakdown below only
 * exists for the failing case, because a reader gets stuck in one of three
 * places and the message has to name the right one.
 *
 * Two parties try the fetch: this server, and the administrator's own browser.
 * A server reaching its own public hostname often fails on NAT hairpinning
 * while every real visitor succeeds, so the browser's attempt is not a
 * courtesy — it is the one whose result matches the question being asked.
 */

export type PublicAddressRejection =
  | { reason: "malformed"; detail: string }
  | { reason: "insecure"; detail: string }
  | { reason: "local"; detail: string };

export type PublicAddressFailure =
  | { reason: "dns"; detail: string; resolved?: string[]; expected?: string[] }
  | { reason: "tls"; detail: string }
  | { reason: "unreachable"; detail: string; resolved?: string[] }
  | { reason: "other-installation"; detail: string };

export type PublicAddressProbe = { ok: true; installationId: string } | { ok: false; error: string };

/** Loopback, private ranges and the names given to machines on a LAN. */
export function localHostname(host: string) {
  const name = host.toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost") || name === "::1" || name === "[::1]") return true;
  if (name.endsWith(".local") || name.endsWith(".internal") || name.endsWith(".home.arpa")) return true;
  const parts = name.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
}

/**
 * The shape rules, checked before anything is fetched: a plain-http address
 * and a local address are refused outright, because no page on the internet
 * can load either — and saying so immediately is more useful than a timeout.
 */
export function normalizePublicAddress(input: string): { origin: string } | PublicAddressRejection {
  const raw = String(input || "").trim();
  if (!raw) return { reason: "malformed", detail: "empty" };
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); }
  catch { return { reason: "malformed", detail: raw }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { reason: "malformed", detail: url.protocol };
  if (url.protocol === "http:") return { reason: "insecure", detail: url.origin };
  if (localHostname(url.hostname)) return { reason: "local", detail: url.hostname };
  return { origin: url.origin };
}

/**
 * The addresses a machine can honestly claim as its own in a DNS explanation.
 *
 * Inside a container every interface address is private — the production
 * server reported 172.18.0.5 — and a public DNS record can never point at one,
 * so naming it would send a reader to set an A record that cannot work. What
 * is left is what can be said; when nothing is, the failure is reported
 * without claiming a mismatch that was never established.
 */
export function publicMachineAddresses(candidates: readonly string[]) {
  return [...new Set(candidates.filter((address) => address && !privateAddress(address)))];
}

function privateAddress(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    // IPv6: unique-local and link-local are equally unusable from outside.
    return /^(fc|fd|fe80)/i.test(address);
  }
  const [first, second] = parts;
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254);
}

/**
 * Why the address did not answer, given what each party saw. Called only when
 * neither the server nor the browser reached this control plane.
 *
 * `resolved` is what the hostname points at, `expected` the addresses this
 * machine believes it has. When both are known and disjoint, the DNS record is
 * the thing to fix; a certificate error is its own case; anything else is
 * reported as unreachable with the resolved addresses shown, because claiming
 * a cause we cannot distinguish is how a reader gets sent to the wrong place.
 */
export function attributePublicAddressFailure(input: {
  serverProbe: PublicAddressProbe;
  browserProbe?: PublicAddressProbe;
  installationId: string;
  resolved?: string[];
  expected?: string[];
}): PublicAddressFailure {
  const probes = [input.serverProbe, input.browserProbe].filter(Boolean) as PublicAddressProbe[];
  const reached = probes.find((probe) => probe.ok) as { ok: true; installationId: string } | undefined;
  if (reached) {
    return {
      reason: "other-installation",
      detail: `${reached.installationId.slice(0, 8)}… ≠ ${input.installationId.slice(0, 8)}…`,
    };
  }
  const errors = probes.filter((probe) => !probe.ok).map((probe) => (probe as { ok: false; error: string }).error);
  const certificate = errors.find((error) => /cert|tls|ssl|self.signed|hostname mismatch/i.test(error));
  const unresolved = errors.find((error) => /ENOTFOUND|EAI_AGAIN|getaddrinfo|NXDOMAIN|dns/i.test(error));
  if (!input.resolved?.length || unresolved) {
    return { reason: "dns", detail: unresolved || errors[0] || "unresolved", resolved: input.resolved, expected: input.expected };
  }
  if (input.expected?.length && !input.resolved.some((address) => input.expected!.includes(address))) {
    return { reason: "dns", detail: "resolved elsewhere", resolved: input.resolved, expected: input.expected };
  }
  if (certificate) return { reason: "tls", detail: certificate };
  return { reason: "unreachable", detail: errors[0] || "no response", resolved: input.resolved };
}

/** Did either party reach this exact control plane? That is the whole test. */
export function publicAddressVerified(input: {
  serverProbe: PublicAddressProbe;
  browserProbe?: PublicAddressProbe;
  installationId: string;
}) {
  return [input.serverProbe, input.browserProbe]
    .filter(Boolean)
    .some((probe) => probe!.ok && probe!.installationId === input.installationId);
}
