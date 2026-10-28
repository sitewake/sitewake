// Shared pieces of the capability benchmark scripts: paths, the site
// registry, the compose invocation, a small console client and waits.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ARTIFACTS = process.env.BENCH_ARTIFACTS || join(ROOT, ".artifacts", "benchmark");
export const SITES_DIR = join(ROOT, "benchmark", "sites");
export const ENV_FILE = join(ARTIFACTS, "benchmark.env");
export const STATE_FILE = join(ARTIFACTS, "state.json");
export const PROJECT = "sitewake-benchmark";
export const IN_NETWORK = process.env.BENCH_IN_NETWORK === "1";
/** The console as the benchmark scripts reach it: on the host via the published port, inside the network by service name. */
export const CONSOLE_URL = (process.env.BENCH_CONSOLE_URL || "http://localhost:3100").replace(/\/$/, "");

export function log(...parts) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}]`, ...parts);
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Polls `probe` until it returns a truthy value; throws with `label` on timeout. */
export async function waitFor(label, probe, { timeoutMs = 120_000, intervalMs = 3_000 } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label}: not ready after ${Math.round(timeoutMs / 1000)}s${lastError ? ` (${lastError.message || lastError})` : ""}`);
}

export function parseFlags(argv = process.argv.slice(2)) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) { flags._.push(arg); continue; }
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) { flags[key] = inline; continue; }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[key] = next; index += 1; } else flags[key] = true;
  }
  return flags;
}

/** Every site under benchmark/sites, each with its directory attached. */
export function loadSites({ configuredOnly = false } = {}) {
  if (!existsSync(SITES_DIR)) return [];
  return readdirSync(SITES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SITES_DIR, entry.name, "site.json")))
    .map((entry) => {
      const site = JSON.parse(readFileSync(join(SITES_DIR, entry.name, "site.json"), "utf8"));
      return { ...site, dir: join(SITES_DIR, entry.name), slug: entry.name, configured: site.configured !== false };
    })
    .filter((site) => !configuredOnly || site.configured);
}

/** The address a benchmark script should use for a site from where it runs. */
export function siteBaseUrl(site) {
  const url = IN_NETWORK ? site.internalUrl : site.hostUrl;
  return url.replace(/\/$/, "");
}

export function readEnvFile(path = ENV_FILE) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, "utf8").split("\n")
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
}

export function writeEnvFile(values, path = ENV_FILE) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
}

export function readState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

export function writeState(patch) {
  const next = { ...readState(), ...patch };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function composeArgs(...rest) {
  return ["compose", "-p", PROJECT, "--env-file", ENV_FILE, "-f", "compose.yaml", "-f", "compose.compact.yaml", "-f", "compose.benchmark.yaml", ...rest];
}

/** Runs a command, streaming its output; rejects on a non-zero exit. */
export function run(command, args, { cwd = ROOT, env = process.env, quiet = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

/** Runs a command and returns its stdout; rejects on a non-zero exit. */
export function capture(command, args, { cwd = ROOT, env = process.env, input } = {}) {
  return new Promise((resolveCapture, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let out = ""; let err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveCapture(out);
      else reject(new Error(`${command} ${args.slice(0, 3).join(" ")}… exited with ${code}: ${err.trim().slice(-400)}`));
    });
    if (input !== undefined) { child.stdin.end(input); }
  });
}

/**
 * The console over HTTP with the management cookie. Mutations carry the
 * console's own origin, which the management guard requires.
 */
export class ConsoleClient {
  constructor(baseUrl = CONSOLE_URL, cookie = readState().consoleCookie || "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.cookie = cookie;
  }

  async request(path, { method = "GET", body, headers = {}, timeoutMs = 30_000 } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(method !== "GET" ? { origin: this.baseUrl } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0];
      if (pair.includes("=")) this.cookie = pair.split("=")[1] ? pair : this.cookie;
    }
    let payload;
    const text = await response.text();
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text.slice(0, 400) }; }
    return { status: response.status, ok: response.ok, payload };
  }

  json(path, init) { return this.request(path, init).then((result) => result.payload); }
}

/** Keys of the model configuration copied from .env.local into the benchmark env; values are never printed. */
export function modelEnvFromLocal() {
  const local = join(ROOT, ".env.local");
  if (!existsSync(local)) return {};
  return Object.fromEntries(readFileSync(local, "utf8").split("\n")
    .filter((line) => /^(MODEL|OPENAI)(_[A-Z_]+)?=/.test(line))
    .map((line) => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1).replace(/^"(.*)"$/, "$1")]; }));
}
