import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, resolveCliLocale } from "./cli-copy.mjs";
import { controlPlaneUrl } from "./local-endpoint.mjs";
import { loadOptionalInternalModule } from "./optional-internal-module.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MODEL_KEY_NAMES = [
  "MODEL_API_KEY", "OPENAI_API_KEY", 
];

async function envFileValues() {
  try {
    const text = await readFile(resolve(root, ".env.local"), "utf8");
    const values = new Map();
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
      if (match) values.set(match[1], match[2].trim());
    }
    return values;
  } catch {
    return new Map();
  }
}

function portFree(port) {
  return new Promise((resolveCheck) => {
    const server = createServer();
    server.once("error", (error) => resolveCheck(error.code !== "EADDRINUSE"));
    server.once("listening", () => server.close(() => resolveCheck(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function checkNodeVersion() {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const required = String(pkg.engines?.node || "").replace(/^[^\d]*/, "");
  if (!required) return null;
  const wanted = required.split(".").map(Number);
  const actual = process.versions.node.split(".").map(Number);
  for (let index = 0; index < wanted.length; index += 1) {
    const current = actual[index] || 0;
    if (current > wanted[index]) return null;
    if (current < wanted[index]) {
      return { code: "node-too-old", current: process.versions.node, required: pkg.engines.node };
    }
  }
  return null;
}

async function checkChromium() {
  try {
    const { chromium } = await import("playwright");
    if (existsSync(chromium.executablePath())) return null;
  } catch {
    // Falls through to the same actionable message: the browser is unusable.
  }
  return { code: "chromium-missing" };
}

function checkCodex() {
  if (existsSync(resolve(root, "node_modules", "@openai", "codex", "bin", "codex.js"))) return null;
  return { code: "codex-missing" };
}

async function checkModel() {
  const fileValues = await envFileValues();
  const configured = MODEL_KEY_NAMES.some((name) => (process.env[name] || fileValues.get(name) || "").trim());
  if (configured) return null;
  return { code: "model-missing" };
}

async function checkPorts() {
  // Demo sites exist only in the maintainers' checkout; without the module
  // there are no demo ports to check.
  const demoSitesModule = await loadOptionalInternalModule("./internal/demo-sites.mjs", import.meta.url);
  const sites = demoSitesModule ? await demoSitesModule.loadDemoSites() : [];
  const endpoint = new URL(controlPlaneUrl());
  const launcherPort = Number(process.env.CAPABILITY_V2_RUNTIME_LAUNCHER_PORT || 3320);
  // `component` is a catalog key, resolved in the reader's language at report time.
  const wanted = [
    { port: Number(endpoint.port || 80), component: { key: "componentControlPlane" } },
    { port: launcherPort, component: { key: "componentLauncher" } },
    ...sites.map((site) => ({ port: site.port, component: { key: "componentDemoSite", args: [site.id, site.name] } })),
  ];
  const issues = [];
  for (const item of wanted) {
    if (await portFree(item.port)) continue;
    issues.push({ code: "port-busy", port: item.port, component: item.component });
  }
  return issues;
}

/** Runs every check and reports all failures at once, never just the first. */
export async function preflight() {
  const results = await Promise.all([
    checkNodeVersion(),
    checkChromium(),
    Promise.resolve(checkCodex()),
    checkModel(),
    checkPorts(),
  ]);
  return results.flat().filter(Boolean);
}

/** Title and fix for one issue, in the reader's language. */
export function describeIssue(issue, locale = "en") {
  const copy = cli(locale).preflight;
  switch (issue.code) {
    case "node-too-old": return { title: copy.nodeTooOld(issue.current, issue.required), fix: copy.nodeTooOldFix };
    case "chromium-missing": return { title: copy.chromiumMissing, fix: copy.chromiumMissingFix };
    case "codex-missing": return { title: copy.codexMissing, fix: copy.codexMissingFix };
    case "model-missing": return { title: copy.modelMissing, fix: copy.modelMissingFix };
    case "port-busy": {
      const component = typeof copy[issue.component.key] === "function"
        ? copy[issue.component.key](...(issue.component.args || []))
        : copy[issue.component.key];
      return { title: copy.portBusy(issue.port, component), fix: copy.portBusyFix(issue.port) };
    }
    default: throw new Error(`unknown preflight issue: ${issue.code}`);
  }
}

export function reportPreflight(issues, log = console.error, locale = resolveCliLocale()) {
  if (!issues.length) return true;
  const copy = cli(locale).preflight;
  log(`\n${copy.header(issues.length)}\n`);
  issues.forEach((issue, index) => {
    const { title, fix } = describeIssue(issue, locale);
    log(`  ${index + 1}. ${title}`);
    log(`     ${copy.fixLabel} ${fix}\n`);
  });
  log(`${copy.footer}\n`);
  return false;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const locale = resolveCliLocale();
  const issues = await preflight();
  if (reportPreflight(issues, console.error, locale)) console.log(cli(locale).preflight.allPassed);
  else process.exitCode = 1;
}
