import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const configPath = "dist/server/wrangler.json";
const forbiddenLegacyMarkers = ["TRUSTED WEBSITE MODEL", "iframe 是体验层", "正在等待 SDK 握手"];
const requiredMarkers = ["网站知识", "能力中心"];

const config = JSON.parse(await readFile(configPath, "utf8"));
const expectedName = process.env.CLOUDFLARE_WORKER_NAME?.trim();
const expectedHost = process.env.CLOUDFLARE_ROUTE_HOSTNAME?.trim();
if (!expectedName || config.name !== expectedName) throw new Error(`deploy_config_worker_mismatch:${config.name || "missing"}`);
if (!expectedHost || !config.routes?.some((route) => route.pattern === `${expectedHost}/*`)) throw new Error("deploy_config_route_mismatch");

const assetDirectory = "dist/client/assets";
const assetFiles = (await readdir(assetDirectory)).filter((name) => /^site-agent-console-.*\.js$/.test(name));
if (assetFiles.length !== 1) throw new Error(`deploy_console_asset_ambiguous:${assetFiles.length}`);
const localConsole = await readFile(`${assetDirectory}/${assetFiles[0]}`, "utf8");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const localDigest = digest(localConsole);
for (const marker of forbiddenLegacyMarkers) if (localConsole.includes(marker)) throw new Error(`deploy_rejected_legacy_console:${marker}`);
for (const marker of requiredMarkers) if (!localConsole.includes(marker)) throw new Error(`deploy_rejected_unknown_console:${marker}`);

// Runtime model and Runner credentials are managed as Worker secrets. Preserve
// them when publishing a new source version; otherwise a code deployment can
// silently reactivate an older secret binding, producing alternating 401/404
// failures between otherwise valid Worker versions.
const result = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "deploy", "--config", configPath, "--keep-vars"], { stdio: "inherit", env: process.env });
if (result.status !== 0) process.exit(result.status ?? 1);

const origin = `https://${expectedHost}`;
let lastError;
for (let attempt = 0; attempt < 18; attempt += 1) {
  try {
    const html = await fetch(`${origin}/?sitewake-deploy-check=${Date.now()}`, { headers: { "user-agent": "SiteWake-Deployment-Check/1.0", "cache-control": "no-cache" } }).then((response) => {
      if (!response.ok) throw new Error(`homepage_http_${response.status}`);
      return response.text();
    });
    const assetPath = html.match(/(?:src|href)="([^"]*site-agent-console-[^"]+\.js)"/)?.[1];
    if (!assetPath) throw new Error("online_console_asset_missing");
    const onlineConsole = await fetch(new URL(assetPath, origin), { headers: { "user-agent": "SiteWake-Deployment-Check/1.0", "cache-control": "no-cache" } }).then((response) => {
      if (!response.ok) throw new Error(`asset_http_${response.status}`);
      return response.text();
    });
    for (const marker of forbiddenLegacyMarkers) if (onlineConsole.includes(marker)) throw new Error(`online_legacy_console:${marker}`);
    for (const marker of requiredMarkers) if (!onlineConsole.includes(marker)) throw new Error(`online_unknown_console:${marker}`);
    if (digest(onlineConsole) !== localDigest) throw new Error(`online_asset_digest_mismatch:${digest(onlineConsole).slice(0, 12)}:${localDigest.slice(0, 12)}`);
    console.log(`Verified ${origin}: ${assetFiles[0]} (${localDigest.slice(0, 12)}), no legacy iframe console.`);
    lastError = undefined;
    break;
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
if (lastError) throw lastError;
