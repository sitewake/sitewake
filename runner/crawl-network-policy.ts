import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import ipaddr from "ipaddr.js";

export type PinnedCrawlOrigin = {
  origin: string;
  hostname: string;
  address: string;
  family: 4 | 6;
};

export function crawlArtifactFilename(rawOrigin: string) {
  const parsed = new URL(rawOrigin);
  const label = [normalizedHostname(parsed.hostname), parsed.port]
    .filter(Boolean)
    .join("-")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return `crawl-${label || "site"}.json`;
}

function normalizedHostname(value: string) {
  return value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
}

function validResolverHostname(hostname: string) {
  if (hostname.length < 1 || hostname.length > 253 || hostname.endsWith(".")) {
    return false;
  }
  return hostname.split(".").every((label) =>
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
}

export function crawlAddressIsPublic(address: string) {
  try {
    // ipaddr.process also unwraps IPv4-mapped/compatible IPv6 forms before the
    // range check. Only ordinary global unicast is allowed; transition,
    // translation, private, loopback, documentation and reserved ranges fail.
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

export async function resolvePinnedCrawlOrigin(
  rawOrigin: string,
  options: {
    allowPrivateNetwork?: boolean;
    dnsTimeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<PinnedCrawlOrigin> {
  options.signal?.throwIfAborted();
  const parsed = new URL(rawOrigin);
  if (!/^https?:$/.test(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) {
    throw new Error("crawl_origin_invalid");
  }
  const hostname = normalizedHostname(parsed.hostname);
  const literalFamily = isIP(hostname);
  if (!literalFamily && !validResolverHostname(hostname)) {
    throw new Error("crawl_origin_hostname_rejected");
  }
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
        let settled = false;
        const finish = (
          callback: () => void,
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          options.signal?.removeEventListener("abort", abort);
          callback();
        };
        const abort = () => finish(() => reject(
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error("crawl_origin_dns_aborted"),
        ));
        const timeout = setTimeout(
          () => finish(() => reject(new Error("crawl_origin_dns_timeout"))),
          Math.max(1, options.dnsTimeoutMs ?? 5_000),
        );
        options.signal?.addEventListener("abort", abort, { once: true });
        lookup(hostname, { all: true, verbatim: true }).then(
          (addresses) => finish(() => resolve(addresses)),
          (error) => finish(() => reject(error)),
        );
      });
  options.signal?.throwIfAborted();
  const addresses = [...new Map(resolved.map((entry) =>
    [`${entry.family}:${entry.address}`, entry] as const)).values()];
  if (!addresses.length) throw new Error("crawl_origin_dns_empty");
  if (!options.allowPrivateNetwork
    && addresses.some((entry) => !crawlAddressIsPublic(entry.address))) {
    throw new Error("crawl_origin_private_network_rejected");
  }
  const selected = addresses.find((entry) => entry.family === 4) || addresses[0];
  if (selected.family !== 4 && selected.family !== 6) {
    throw new Error("crawl_origin_dns_family_rejected");
  }
  return {
    origin: parsed.origin,
    hostname,
    address: selected.address,
    family: selected.family,
  };
}

export function chromiumPinnedOriginArgs(pin: PinnedCrawlOrigin, options: { allowPrivateNetwork?: boolean } = {}) {
  // An installation allowed to reach private addresses must also let its
  // browser reach them. Chrome otherwise refuses a request from a page it
  // classifies as public to a loopback or LAN address — and a page served
  // through request interception is classified that way even when it came from
  // loopback, which would make every rehearsal on an intranet site look like
  // "nothing loaded" with no violation to explain it.
  const local = options.allowPrivateNetwork
    ? ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights"]
    : [];
  if (isIP(pin.hostname)) return ["--no-proxy-server", ...local];
  const target = pin.family === 6 ? `[${pin.address}]` : pin.address;
  return [
    "--no-proxy-server",
    `--host-resolver-rules=MAP ${pin.hostname} ${target}`,
    ...local,
  ];
}

function pinnedLookup(pin: PinnedCrawlOrigin): LookupFunction {
  const resolver = (
    _hostname: string,
    options: { all?: boolean },
    callback: (error: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
  ) => {
    if (options?.all) {
      callback(null, [{ address: pin.address, family: pin.family }]);
      return;
    }
    callback(null, pin.address, pin.family);
  };
  return resolver as unknown as LookupFunction;
}

/**
 * Node fetch implementation whose socket lookup is pinned to the address that
 * passed the crawl egress policy. Redirects are still handled by
 * fetchSameOriginText, which validates every hop.
 */
export function pinnedOriginFetch(pin: PinnedCrawlOrigin): typeof fetch {
  return (async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const target = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (target.origin !== pin.origin
      || normalizedHostname(target.hostname) !== pin.hostname) {
      throw new Error("crawl_fetch_origin_rejected");
    }
    if (init.method && init.method.toUpperCase() !== "GET") {
      throw new Error("crawl_fetch_method_rejected");
    }
    const transport = target.protocol === "https:" ? https : http;
    const requestHeaders: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      requestHeaders[name] = value;
    });
    return await new Promise<Response>((resolve, reject) => {
      const request = transport.request(target, {
        method: "GET",
        headers: requestHeaders,
        lookup: pinnedLookup(pin),
        agent: false,
        signal: init.signal || undefined,
      }, (response) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) headers.append(name, item);
          } else if (value !== undefined) {
            headers.set(name, String(value));
          }
        }
        resolve(new Response(
          Readable.toWeb(response) as ReadableStream<Uint8Array>,
          {
            status: response.statusCode || 500,
            statusText: response.statusMessage,
            headers,
          },
        ));
      });
      request.once("error", reject);
      request.end();
    });
  }) as typeof fetch;
}
