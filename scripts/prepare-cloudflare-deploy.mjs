import { readFile, writeFile } from "node:fs/promises";

const configPath = "dist/server/wrangler.json";

const required = [
  "CLOUDFLARE_WORKER_NAME",
  "CLOUDFLARE_D1_DATABASE_NAME",
  "CLOUDFLARE_D1_DATABASE_ID",
  "CLOUDFLARE_ZONE_NAME",
  "CLOUDFLARE_ROUTE_HOSTNAME",
];

for (const name of required) {
  if (!process.env[name]?.trim()) {
    throw new Error(`${name} is required`);
  }
}

const config = JSON.parse(await readFile(configPath, "utf8"));

config.name = process.env.CLOUDFLARE_WORKER_NAME;
config.topLevelName = process.env.CLOUDFLARE_WORKER_NAME;
config.compatibility_flags = Array.from(new Set([...(config.compatibility_flags || []), "nodejs_compat"]));
config.d1_databases = [
  {
    binding: "DB",
    database_name: process.env.CLOUDFLARE_D1_DATABASE_NAME,
    database_id: process.env.CLOUDFLARE_D1_DATABASE_ID,
  },
];
if (process.env.CLOUDFLARE_R2_BUCKET_NAME?.trim()) {
  config.r2_buckets = [{ binding: "ARTIFACTS", bucket_name: process.env.CLOUDFLARE_R2_BUCKET_NAME.trim() }];
}
config.routes = [
  {
    pattern: `${process.env.CLOUDFLARE_ROUTE_HOSTNAME}/*`,
    zone_name: process.env.CLOUDFLARE_ZONE_NAME,
  },
];
config.vars = {
  ...(config.vars || {}),
  SITEWAKE_PUBLIC_ORIGIN: `https://${process.env.CLOUDFLARE_ROUTE_HOSTNAME.trim()}`,
  SITEWAKE_RUNNER_VISIBILITY:
    process.env.SITEWAKE_RUNNER_VISIBILITY?.trim() || "full",
  SITEWAKE_LEGACY_RUNNER_PROTOCOL:
    process.env.SITEWAKE_LEGACY_RUNNER_PROTOCOL === "true" ? "true" : "false",
  SITEWAKE_RUNNER_LEASE_AUTHORITY:
    process.env.SITEWAKE_RUNNER_LEASE_AUTHORITY === "legacy" ? "legacy" : "central",
};
config.observability = { enabled: true };
// Capability contract design is model-only background work.  A Worker cron
// owns this queue so it survives local browser-runner restarts and deploys.
config.triggers = { ...(config.triggers || {}), crons: ["* * * * *"] };

await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Prepared ${configPath} for ${config.name} on ${process.env.CLOUDFLARE_ROUTE_HOSTNAME}`);
