import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const zoneName = process.env.CLOUDFLARE_ZONE_NAME;
const tunnelName = process.env.SITEWAKE_TUNNEL_NAME || "sitewake-validation";
const publicHostname = process.env.SITEWAKE_PUBLIC_HOSTNAME || process.env.CLOUDFLARE_ROUTE_HOSTNAME;
// The validation plane must never silently inherit the public Worker hostname.
// Keeping its own stable hostname avoids accidentally sending a lab visitor to
// a legacy route or an unrelated host-level redirect.
const hostname = process.env.SITEWAKE_LAB_HOSTNAME || `lab-sitewake.${zoneName}`;
if (!accountId || !apiToken || !zoneName || !publicHostname) throw new Error("Cloudflare tunnel coordinates are required");

async function cloudflare(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(`cloudflare_api_failed:${response.status}:${JSON.stringify(payload.errors || payload)}`);
  return payload.result;
}

const tunnels = await cloudflare(`/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(tunnelName)}`);
let tunnel = tunnels.find((item) => item.name === tunnelName);
if (!tunnel) tunnel = await cloudflare(`/accounts/${accountId}/cfd_tunnel`, { method: "POST", body: JSON.stringify({ name: tunnelName, tunnel_secret: randomBytes(32).toString("base64") }) });

await cloudflare(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, {
  method: "PUT",
  body: JSON.stringify({ config: { ingress: [[...new Set([publicHostname, hostname])].map((host) => ({ hostname: host, service: "http://control-plane:3000" })), [{ service: "http_status:404" }]].flat() } }),
});
const zones = await cloudflare(`/zones?name=${encodeURIComponent(zoneName)}`);
if (!zones[0]) throw new Error(`cloudflare_zone_not_found:${zoneName}`);
const zoneId = zones[0].id;
const records = await cloudflare(`/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`);
const record = { type: "CNAME", name: hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, ttl: 1 };
if (records[0]) await cloudflare(`/zones/${zoneId}/dns_records/${records[0].id}`, { method: "PUT", body: JSON.stringify(record) });
else await cloudflare(`/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(record) });
const token = await cloudflare(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);
await writeFile(".env.tunnel.local", `CLOUDFLARE_TUNNEL_TOKEN=${token}\nSITEWAKE_PUBLIC_HOSTNAME=${publicHostname}\nSITEWAKE_LAB_HOSTNAME=${hostname}\n`, { mode: 0o600 });
console.log(`Provisioned ${[publicHostname, hostname].map((host) => `https://${host}`).join(" and ")} through tunnel ${tunnelName} (${tunnel.id}).`);
