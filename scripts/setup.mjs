/**
 * The setup wizard behind `./setup`.
 *
 * Asks one thing — the language — and does the rest itself: works out this
 * server's address, generates the random values compose needs (keeping any
 * it finds), writes `.env`, and leaves a marker for `./setup` to start the
 * stack and print the report. The model is not part of this: it is connected
 * in the console once the stack is up (onboarding step three, or Settings).
 * Any MODEL_* already in .env is kept, untouched and unmentioned.
 *
 * Runs right after `git clone`, before `npm install`: only `node:` modules and
 * relative files are imported.
 *
 * Everything a person reads comes from `cli-copy.mjs`; English by default.
 * The language question itself is English in both catalogs: nothing in
 * another language is printed before the person has chosen one.
 */
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import { randomUUID, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { cli, hasLangFlag, resolveCliLocale } from "./cli-copy.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, "..");
export const DOCKER_ENV_FILE = resolve(root, ".env");
export const CONTAINER_EXAMPLE_FILE = resolve(root, ".env.container.example");
/** Left for ./setup when the stack is to be started; holds the chosen language. */
export const START_MARKER = resolve(root, ".sitewake-setup-start");

/** compose.yaml refuses to start without these (`${…:?}`). */
export const TOKEN_KEYS = [
  "SITEWAKE_RUNNER_ENROLLMENT_TOKEN",
  "CAPABILITY_V2_RUNNER_SECRET",
  "CAPABILITY_V2_DISPATCH_TOKEN",
  "CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN",
];
/** compose.yaml has weak defaults for these; a real install must not use them. */
export const PASSWORD_KEYS = ["POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD"];

/**
 * Each install gets its own Compose project name, so its containers and data
 * volumes never collide with another install on the same machine (compose.yaml
 * names the project `sitewake`, which every checkout would otherwise share —
 * and Postgres keeps the password its volume was first started with). An
 * existing name is kept; a new one is generated once per .env.
 */
export function composeProjectName(existing) {
  const current = String(existing.get("COMPOSE_PROJECT_NAME") || "").trim();
  if (/^[a-z0-9][a-z0-9_-]*$/.test(current)) return { name: current, generated: false };
  return { name: `sitewake-${randomBytes(2).toString("hex")}`, generated: true };
}

const DEFAULT_PORT = 3000;

export function parseEnvFile(text) {
  return new Map(Object.entries(parseEnv(text)));
}

function envValue(value, copy = cli("en").setup) {
  const text = String(value ?? "");
  if (/[\r\n\0]/.test(text)) throw new Error(copy.envValueNewline);
  if (!/[\s#'"`]/.test(text)) return text;
  const quote = ["'", '"', "`"].find((candidate) => !text.includes(candidate));
  if (!quote) throw new Error(copy.envValueQuotes);
  return `${quote}${text}${quote}`;
}

/** Write privately and atomically; a failed write must leave the old config intact. */
export async function writeEnvFile(text, path = DOCKER_ENV_FILE) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Rewrite exactly the keys in `values`, leave every other line untouched, and
 * drop the keys in `remove` so the file never carries two names for the same
 * setting. Keys the file did not have are appended under one comment.
 */
export function applyEnvValues(text, values, { remove = [], locale = "en" } = {}) {
  const copy = cli(locale).setup;
  const keys = Object.keys(values);
  const lines = text ? text.split(/\r?\n/) : [];
  const written = new Set();
  const removed = [];
  const next = [];

  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (key && keys.includes(key)) {
      if (written.has(key)) continue;
      written.add(key);
      next.push(`${key}=${envValue(values[key], copy)}`);
      continue;
    }
    if (key && remove.includes(key)) {
      removed.push(key);
      continue;
    }
    next.push(line);
  }

  const missing = keys.filter((key) => !written.has(key));
  if (missing.length) {
    if (next.length && next[next.length - 1].trim() !== "") next.push("");
    next.push("# Written by `./setup`.");
    for (const key of missing) next.push(`${key}=${envValue(values[key], copy)}`);
  }
  const body = next.join("\n");
  return { text: body.endsWith("\n") ? body : `${body}\n`, removed: [...new Set(removed)] };
}

/**
 * Whether a hostname is one the capability runner treats as private (see
 * runner/capability-v2/process-runner.ts), plus names that can only mean a
 * private network: no dot, `.local`, `.internal`, link-local. A superset on
 * purpose — the failure this prevents is a LAN install whose runner refuses
 * every task because the switch was left at 0.
 */
export function isPrivateHostname(hostname) {
  const value = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (!value) return false;
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  if (value === "::1" || value === "0.0.0.0") return true;
  if (/^127\./.test(value) || /^10\./.test(value) || /^192\.168\./.test(value)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(value) || /^169\.254\./.test(value)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(value) || /^fe80:/.test(value)) return true;
  if (value.endsWith(".local") || value.endsWith(".internal")) return true;
  if (!value.includes(".") && !value.includes(":")) return true;
  return false;
}

export function derivePrivateOrigin(origin) {
  try { return isPrivateHostname(new URL(origin).hostname) ? "1" : "0"; }
  catch { return "0"; }
}

/** A full http(s) origin, or null. Paths, queries and credentials are refused. */
export function normalizeOrigin(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (text.endsWith("/") && text.slice(0, -1) !== url.origin) return null;
  return url.origin;
}

/**
 * A usable LAN address of this machine, if any. Bridges and virtual
 * interfaces are skipped; private ranges are preferred in the order people
 * actually have them at home and in offices.
 */
export function lanAddress(interfaces = networkInterfaces()) {
  const candidates = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (/^(docker|br-|veth|virbr|lo\b|utun|tun|tap)/.test(name)) continue;
    for (const entry of entries || []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      candidates.push(entry.address);
    }
  }
  const rank = (address) => /^192\.168\./.test(address) ? 0 : /^10\./.test(address) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3;
  candidates.sort((left, right) => rank(left) - rank(right));
  return candidates[0];
}

/** Values from `.env.container.example` count as unset. */
function isPlaceholder(value, key, example) {
  const text = String(value ?? "").trim();
  if (!text) return true;
  if (example.has(key) && text === String(example.get(key)).trim()) return true;
  return text.startsWith("replace-with-");
}

/**
 * The secrets compose needs: fresh random values where the file has none or
 * still has the example's, existing values kept verbatim. Regenerating a
 * database password on a reinstall would lock the owner out of their own
 * volume, so "kept" is the important half.
 */
export function generatedSecrets(existing, example) {
  const values = {};
  const generated = [];
  const kept = [];
  for (const key of TOKEN_KEYS) {
    if (isPlaceholder(existing.get(key), key, example)) { values[key] = randomBytes(32).toString("hex"); generated.push(key); }
    else { values[key] = existing.get(key); kept.push(key); }
  }
  for (const key of PASSWORD_KEYS) {
    // base64url only: safe inside the postgresql:// URL compose builds and on
    // the `mc alias set` command line, and never needs quoting in the file.
    if (isPlaceholder(existing.get(key), key, example)) { values[key] = randomBytes(24).toString("base64url"); generated.push(key); }
    else { values[key] = existing.get(key); kept.push(key); }
  }
  return { values, generated, kept };
}

/**
 * Default for the public origin, most specific signal first: what the file
 * already says (unless it is the example), the cloud VM's public address the
 * `./setup` wrapper read from the metadata service, the host address the
 * wrapper detected before entering the container, this machine's own LAN
 * address, or nothing.
 */
export function defaultOrigin({ existing, example, env, interfaces }) {
  const current = existing.get("SITEWAKE_PUBLIC_ORIGIN");
  if (!isPlaceholder(current, "SITEWAKE_PUBLIC_ORIGIN", example)) return normalizeOrigin(current) || "";
  const port = Number(existing.get("SITEWAKE_PORT") || example.get("SITEWAKE_PORT") || DEFAULT_PORT) || DEFAULT_PORT;
  const host = String(env.SITEWAKE_SETUP_PUBLIC_IP || "").trim()
    || String(env.SITEWAKE_SETUP_HOST_IP || "").trim()
    || (env.SITEWAKE_SETUP_RUNNER === "docker" ? "" : lanAddress(interfaces));
  return host ? `http://${host}:${port}` : "";
}

/** The LAN-address origin, when it differs from the one chosen — shown as the alternative. */
function lanOriginBesides(origin, { existing, example, env, interfaces }) {
  const port = Number(existing.get("SITEWAKE_PORT") || example.get("SITEWAKE_PORT") || DEFAULT_PORT) || DEFAULT_PORT;
  const host = String(env.SITEWAKE_SETUP_HOST_IP || "").trim() || (env.SITEWAKE_SETUP_RUNNER === "docker" ? "" : lanAddress(interfaces));
  const lan = host ? `http://${host}:${port}` : "";
  return lan && lan !== origin ? lan : "";
}

/**
 * Asks a numbered menu until a valid number is given. The default (1-based
 * `fallback`) is marked on its own line, so the prompt stays a bare `>`.
 */
async function askChoice(io, log, copy, lines, fallback, marker = copy.common.defaultMarker) {
  for (const [index, line] of lines.entries()) {
    log(`  ${index + 1}. ${line}${index + 1 === fallback ? `  ${marker}` : ""}`);
  }
  for (;;) {
    const answer = (await io.ask("", fallback ? String(fallback) : "")).trim();
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= lines.length) return index;
    log(copy.common.invalidChoice(lines.map((_, i) => String(i + 1))));
  }
}

/**
 * `./setup --report`: printed by the wrapper after `docker compose up`, with the
 * control plane's health JSON (or nothing) in SITEWAKE_SETUP_HEALTH_JSON and
 * what the wrapper did on its own in SITEWAKE_SETUP_EVENTS. Says where to
 * open the console, whether the stack is healthy, and what to do next — or,
 * with --failed, that compose itself did not come up.
 */
export async function printReport({ argv = [], env = process.env, io, paths = {}, interfaces } = {}) {
  const locale = resolveCliLocale({ argv, env });
  const copy = cli(locale);
  const log = (line = "") => io.log(line);
  const envFile = paths.dockerEnvFile || DOCKER_ENV_FILE;
  const existing = parseEnvFile((await readOptional(envFile)) ?? "");
  const example = parseEnvFile((await readOptional(paths.containerExampleFile || CONTAINER_EXAMPLE_FILE)) || "");
  const origin = defaultOrigin({ existing, example, env: {}, interfaces: {} }) || `http://localhost:${existing.get("SITEWAKE_PORT") || DEFAULT_PORT}`;
  const lan = lanOriginBesides(origin, { existing, example, env, interfaces });
  const publicIp = String(env.SITEWAKE_SETUP_PUBLIC_IP || "").trim();
  let health = null;
  try { health = env.SITEWAKE_SETUP_HEALTH_JSON ? JSON.parse(env.SITEWAKE_SETUP_HEALTH_JSON) : null; } catch { health = null; }
  const failed = argv.includes("--failed");
  const ready = !failed && health?.status === "ready";

  log("");
  log(failed ? copy.setup.reportFailed : ready ? copy.setup.reportRunning : copy.setup.reportNotReady);
  log("");
  // What ./setup did on its own to get here: one event per line, `kind:a:b`.
  for (const line of String(env.SITEWAKE_SETUP_EVENTS || "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [kind, a, b] = line.split(":");
    if (kind === "stopped") log(`  ${copy.setup.reportStoppedOther(a)}`);
    else if (kind === "rotated") log(`  ${copy.setup.reportRotatedProject(a, b)}`);
    else if (kind === "port-busy") log(`  ${copy.setup.reportPortBusy(a, b)}`);
  }
  log(`  ${copy.setup.reportConsole(origin)}`);
  if (lan) log(`  ${copy.setup.reportLan(lan)}`);
  if (publicIp && origin.includes(`//${publicIp}:`)) log(`  ${copy.setup.reportSecurityGroup(new URL(origin).port || String(DEFAULT_PORT))}`);
  if (health?.services) {
    const services = health.services;
    log(`  ${copy.setup.reportHealth(health.status, ["database", "objectStorage", "capabilityV2RunnerLauncher"].map((key) => `${key}: ${services[key] ?? "?"}`))}`);
    if (services.databaseHint) log(`  ${services.databaseHint}`);
  }
  log("");
  for (const line of ready ? copy.setup.reportNextReady(origin) : copy.setup.reportNextNotReady) log(`  ${line}`);
  log("");
  return failed ? 1 : 0;
}

/**
 * The wizard proper. `io` is injected so tests can script answers and read
 * output without a terminal; `main()` wires up readline.
 *
 * Returns the exit status: 0 written, 2 bad arguments. Without a terminal the
 * language question cannot be asked, so the environment's language is used
 * and everything else proceeds as usual (`--lang` makes that explicit).
 */
export async function runWizard({
  argv = [],
  env = process.env,
  io,
  interactive = true,
  paths = {},
  interfaces,
} = {}) {
  let locale;
  try { locale = resolveCliLocale({ argv, env }); }
  catch (error) { io.error(error.message); return 2; }
  const log = (line = "") => io.log(line);

  if (argv.includes("--report")) return printReport({ argv, env, io, paths, interfaces });

  // The one question. English only: no language has been chosen yet. The
  // environment's language is the default, so Enter keeps a Chinese terminal
  // Chinese. Once answered, everything — the title included — is in that language.
  if (interactive && !hasLangFlag(argv)) {
    const question = cli("en").setup;
    log("");
    log(question.languageQuestion);
    log(`  ${question.languageHint}`);
    const choice = await askChoice(io, log, cli("en"), question.languageOptions, locale === "zh" ? 2 : 1, question.languageDefaultMarker);
    locale = choice === 2 ? "zh" : "en";
  }
  const copy = cli(locale);

  log("");
  log(copy.setup.title);
  log("");

  const envFile = paths.dockerEnvFile || DOCKER_ENV_FILE;
  const currentText = await readOptional(envFile);
  const exampleText = (await readOptional(paths.containerExampleFile || CONTAINER_EXAMPLE_FILE)) || "";
  const existing = parseEnvFile(currentText ?? "");
  const example = parseEnvFile(exampleText);

  // Not a question: the address is this server's IP and the port compose
  // listens on (an existing configured origin is kept). The note says where
  // to change it.
  const origin = defaultOrigin({ existing, example, env, interfaces }) || `http://localhost:${DEFAULT_PORT}`;
  const secrets = generatedSecrets(existing, example);
  const project = composeProjectName(existing);
  // Only what compose needs. The model keys are the console's business: any
  // MODEL_* / OPENAI_* already in the file pass through untouched.
  const values = {
    COMPOSE_PROJECT_NAME: project.name,
    SITEWAKE_PUBLIC_ORIGIN: origin,
    CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN: derivePrivateOrigin(origin),
    ...secrets.values,
  };
  const { text } = applyEnvValues(currentText ?? exampleText, values, { locale });
  await writeEnvFile(text, envFile);

  log(copy.setup.originLine(origin));
  log(`  ${copy.setup.originNote}`);
  log("");
  // Which of the two modes this installation is in, and what the other one
  // needs. The address itself is set in the console, not here: a domain and a
  // certificate are arranged after the install, not during it.
  log(copy.setup.modeLine);
  log(`  ${copy.setup.modeNote}`);
  const publicIp = String(env.SITEWAKE_SETUP_PUBLIC_IP || "").trim();
  if (publicIp && origin.includes(`//${publicIp}:`)) {
    log(`  ${copy.setup.originPublicNote(new URL(origin).port || String(DEFAULT_PORT), lanOriginBesides(origin, { existing, example, env, interfaces }))}`);
  }
  log("");
  log(`  ${copy.setup.written(envFile)}`);
  log(`  ${copy.setup.projectLine(project.name)}`);
  // Only this project's volumes can hold a password the new one would not match.
  const volumes = String(env.SITEWAKE_SETUP_EXISTING_VOLUMES || "").split(",").map((v) => v.trim())
    .filter((name) => name.startsWith(`${project.name}_`));
  if (volumes.length && PASSWORD_KEYS.some((key) => secrets.generated.includes(key))) {
    log("");
    for (const line of copy.setup.existingVolumesWarning(volumes)) log(`  ${line}`);
  }
  log("");

  if (!argv.includes("--no-start")) {
    // ./setup does the starting (it has docker on the host); the wizard only
    // leaves the marker with the language for the report.
    await writeFile(paths.startMarker || START_MARKER, `${locale}\n`);
    log(copy.setup.starting);
    log("");
    return 0;
  }
  log(copy.setup.next);
  log(`  ${copy.setup.nextDocker}`);
  log(`  ${copy.setup.nextDockerOpen(origin)}`);
  log(`  ${copy.setup.nextDockerSmoke}`);
  log(`  ${copy.setup.nextDockerCompact}`);
  log("");
  return 0;
}

/** Readline-backed IO for a real terminal; the one prompt is a bare `>`. */
function terminalIo() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    async ask(prompt, fallback) {
      const answer = (await rl.question(`${prompt}\n> `)).trim();
      return answer || fallback || "";
    },
    close() { rl.close(); },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const interactive = Boolean(process.stdin.isTTY);
  const io = interactive ? terminalIo() : { log: (line) => console.log(line), error: (line) => console.error(line), ask: async () => "", close() {} };
  try {
    process.exitCode = await runWizard({ argv, env: process.env, io, interactive });
  } finally {
    io.close();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`${cli("en").setup.prefix} ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
