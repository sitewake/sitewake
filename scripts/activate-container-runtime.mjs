/**
 * Makes the container control plane the only runtime behind the public SDK
 * origin. Cloudflare remains the DNS/Tunnel edge; it no longer runs a Worker
 * or D1 for this hostname.
 */
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = process.env.CLOUDFLARE_API_TOKEN;
const zoneName = process.env.CLOUDFLARE_ZONE_NAME;
const publicHostname = process.env.SITEWAKE_PUBLIC_HOSTNAME || process.env.CLOUDFLARE_ROUTE_HOSTNAME;
const tunnelName = process.env.SITEWAKE_TUNNEL_NAME || "sitewake-validation";
if (!accountId || !apiToken || !zoneName || !publicHostname) throw new Error("container_activation_coordinates_missing");

async function cloudflare(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  const payload = await response.json();
  if (!response.ok || payload.success === false) throw new Error(`cloudflare_api_failed:${response.status}:${JSON.stringify(payload.errors || payload)}`);
  return payload.result;
}

const zones = await cloudflare(`/zones?name=${encodeURIComponent(zoneName)}`);
const zoneId = zones[0]?.id;
if (!zoneId) throw new Error("cloudflare_zone_not_found");
const tunnels = await cloudflare(`/accounts/${accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(tunnelName)}`);
const tunnel = tunnels.find((item) => item.name === tunnelName);
if (!tunnel) throw new Error("container_tunnel_not_found");

async function pointHostnameToTunnel(hostname) {
  const records = await cloudflare(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
  const primary = records.find((record) => record.type === "CNAME") || records.find((record) => record.type === "A") || records[0];
  for (const record of records) if (record.id !== primary?.id) await cloudflare(`/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
  const desired = { type: "CNAME", name: hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, ttl: 1 };
  if (!primary) return cloudflare(`/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(desired) });
  try {
    return await cloudflare(`/zones/${zoneId}/dns_records/${primary.id}`, { method: "PUT", body: JSON.stringify(desired) });
  } catch {
    await cloudflare(`/zones/${zoneId}/dns_records/${primary.id}`, { method: "DELETE" });
    return cloudflare(`/zones/${zoneId}/dns_records`, { method: "POST", body: JSON.stringify(desired) });
  }
}

// The Tunnel ingress is created before this command. Keep the Worker route in
// place until DNS already targets the healthy container, then remove only the
// exact public-host route — never a sibling hostname.
await pointHostnameToTunnel(publicHostname);
const routes = await cloudflare(`/zones/${zoneId}/workers/routes`);
for (const route of routes.filter((item) => item.pattern === `${publicHostname}/*`)) {
  await cloudflare(`/zones/${zoneId}/workers/routes/${route.id}`, { method: "DELETE" });
}

let lastError;
for (let attempt = 0; attempt < 18; attempt += 1) {
  try {
    const response = await fetch(`https://${publicHostname}/api/health?container-activation=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
    const health = await response.json();
    if (!response.ok || health.runtime !== "container") throw new Error(`container_health_unconfirmed:${response.status}:${health.runtime || "unknown"}`);
    console.log(`Activated container runtime at https://${publicHostname}.`);
    lastError = undefined;
    break;
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
if (lastError) throw lastError;
