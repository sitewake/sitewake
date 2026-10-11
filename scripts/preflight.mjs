import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, resolveCliLocale } from "./cli-copy.mjs";
import { controlPlaneUrl } from "./local-endpoint.mjs";
import { loadOptionalInternalModule } from "./optional-internal-module.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

/**
 * Shared libraries the binary needs and the system does not have, from
 * `ldd`. Linux only: `npx playwright install chromium` downloads the browser
 * but not its system libraries, and a missing one fails the launch with a
 * bare loader error deep in the runner's log. Empty when `ldd` is not
 * available — better to start than to block on a tool we cannot run.
 */
export function missingSharedLibraries(executable, run = spawnSync) {
  const result = run("ldd", [executable], { encoding: "utf8" });
  if (result.error || typeof result.stdout !== "string") return [];
  return [...new Set(result.stdout.split("\n")
    .filter((line) => /=>\s*not found/.test(line))
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean))];
}

async function checkChromium() {
  let executable;
  try {
    const { chromium } = await import("playwright");
    executable = chromium.executablePath();
  } catch {
    // Falls through to the same actionable message: the browser is unusable.
  }
  if (!executable || !existsSync(executable)) return { code: "chromium-missing" };
  if (process.platform === "linux") {
    const libraries = missingSharedLibraries(executable);
    if (libraries.length) return { code: "chromium-deps-missing", libraries };
  }
  return null;
}

function checkCodex() {
  if (existsSync(resolve(root, "node_modules", "@openai", "codex", "bin", "codex.js"))) return null;
  return { code: "codex-missing" };
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
    // No model check: the model is connected in the console (onboarding step
    // three or Settings), so a missing key is not a reason to refuse to start.
    checkPorts(),
  ]);
  return results.flat().filter(Boolean);
}

/**
 * What `npm run dev` can put right by itself instead of asking the reader to.
 * The Playwright browser is a download into this checkout; its system
 * libraries need root, so they are installed when the process already has it
 * (a container) or when sudo needs no password, and otherwise stay a reported
 * issue with the exact command. The Playwright CLI is resolved inside
 * node_modules so it also runs under sudo, where npx may not be on PATH.
 */
function playwrightCli() {
  const cli = resolve(root, "node_modules", "playwright", "cli.js");
  return existsSync(cli) ? cli : null;
}

function repairPlan(issue, run) {
  const cli = playwrightCli();
  if (!cli) return null;
  if (issue.code === "chromium-missing") {
    return { announce: "installingChromium", command: [process.execPath, cli, "install", "chromium"] };
  }
  if (issue.code === "chromium-deps-missing") {
    if (process.getuid?.() === 0) {
      return { announce: "installingChromiumDeps", command: [process.execPath, cli, "install-deps", "chromium"] };
    }
    const sudo = run("sudo", ["-n", "true"], { stdio: "ignore" });
    if (sudo.error || sudo.status !== 0) return null;
    return { announce: "installingChromiumDeps", command: ["sudo", "-n", process.execPath, cli, "install-deps", "chromium"] };
  }
  return null;
}

/**
 * Attempts the repairs above, then re-runs every check: what comes back is
 * what is still broken, never an assumption that a repair worked.
 */
export async function repairPreflight(issues, { log = console.error, locale = "en", run = spawnSync, recheck = preflight } = {}) {
  const copy = cli(locale).preflight;
  let attempted = false;
  for (const issue of issues) {
    const plan = repairPlan(issue, run);
    if (!plan) continue;
    log(`\n${copy[plan.announce]}`);
    run(plan.command[0], plan.command.slice(1), { stdio: "inherit", cwd: root });
    attempted = true;
  }
  return attempted ? recheck() : issues;
}

/** Title and fix for one issue, in the reader's language. */
export function describeIssue(issue, locale = "en") {
  const copy = cli(locale).preflight;
  switch (issue.code) {
    case "node-too-old": return { title: copy.nodeTooOld(issue.current, issue.required), fix: copy.nodeTooOldFix };
    case "chromium-missing": return { title: copy.chromiumMissing, fix: copy.chromiumMissingFix };
    case "chromium-deps-missing": return { title: copy.chromiumDepsMissing(issue.libraries), fix: copy.chromiumDepsMissingFix };
    case "codex-missing": return { title: copy.codexMissing, fix: copy.codexMissingFix };
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
