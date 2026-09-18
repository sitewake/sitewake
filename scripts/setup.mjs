/**
 * The setup wizard: `./setup` and `npm run setup`.
 *
 * Asks the language, how SiteWake will run, which model provider (from the
 * verified list, or any OpenAI-compatible base URL), the key and the model,
 * verifies the model with both runtime stages, and only then writes the
 * configuration file for that target — `.env.local` for development from
 * source, `.env` for Docker Compose. On the Docker path it first asks how
 * visitors will reach the server, derives the browser-visible origin from
 * that, generates the random secrets compose requires, and derives the
 * private-network switch.
 *
 * Runs right after `git clone`, before `npm install`: only `node:` modules and
 * relative files are imported. The page-execution request is replayed from
 * the committed fixture, and the provider payload policy is loaded from its
 * TypeScript source with Node's type stripping (`./setup` passes the flag).
 *
 * Everything a person reads comes from `cli-copy.mjs`; English by default.
 */
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import { randomUUID, randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { verifyStages } from "./model-check-core.mjs";
import { cli, hasLangFlag, resolveCliLocale, withoutLangFlag } from "./cli-copy.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, "..");
export const ENV_FILE = resolve(root, ".env.local");
export const DOCKER_ENV_FILE = resolve(root, ".env");
export const CONTAINER_EXAMPLE_FILE = resolve(root, ".env.container.example");
const FIXTURE_FILE = resolve(scriptsDir, "fixtures", "page-execution-request.json");
const POLICY_FILE = resolve(root, "lib", "site-knowledge", "provider-payload-policy.ts");

export const TARGETS = ["local", "docker"];

// The canonical names carry no product name, so they survive a rebrand.
const CANONICAL = ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC"];
// The OpenAI-compatible convention. Still read by lib/model-config.ts as a
// read-only alias; never written here.
const LEGACY_MODEL_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"];

/** compose.yaml refuses to start without these (`${…:?}`). */
export const TOKEN_KEYS = [
  "SITEWAKE_RUNNER_ENROLLMENT_TOKEN",
  "CAPABILITY_V2_RUNNER_SECRET",
  "CAPABILITY_V2_DISPATCH_TOKEN",
  "CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN",
];
/** compose.yaml has weak defaults for these; a real install must not use them. */
export const PASSWORD_KEYS = ["POSTGRES_PASSWORD", "MINIO_ROOT_PASSWORD"];

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_PORT = 3000;
export const REACHABILITY = ["localhost", "domain", "ip", "lan"];

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
export async function writeModelConfig(text, path = ENV_FILE) {
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

export function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
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

/** The model keys only — what the local target writes. */
export function applyModelConfig(text, config, options = {}) {
  const values = Object.fromEntries(CANONICAL.map((key) => [key, config[key] ?? ""]));
  return applyEnvValues(text, values, { ...options, remove: LEGACY_MODEL_KEYS });
}

async function loadPolicyModule(copy) {
  try {
    const module = await import(pathToFileURL(POLICY_FILE).href);
    if (typeof module.applyProviderPayloadPolicy !== "function") throw new Error("applyProviderPayloadPolicy_missing");
    if (!Array.isArray(module.VERIFIED_PROVIDERS)) throw new Error("VERIFIED_PROVIDERS_missing");
    return module;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${copy.stripTypesMissing} (${detail})`);
  }
}

async function loadPolicy(copy) {
  return (await loadPolicyModule(copy)).applyProviderPayloadPolicy;
}

/** The verified providers as the wizard offers them, straight from the policy file. */
export async function verifiedProviders(copy = cli("en").setup) {
  const module = await loadPolicyModule(copy);
  return { providers: module.VERIFIED_PROVIDERS, providerFor: module.verifiedProviderFor };
}

/**
 * Verify routing and the real page-agent request before persisting anything.
 * The page request is the committed capture; `check:model-compat` sends the
 * live one, and tests/model-check-fixture.test.mjs keeps the two identical.
 */
export async function verifyModel(config, timeoutMs = 30_000, locale = "en") {
  const copy = cli(locale).setup;
  const started = Date.now();
  try {
    const pageRequest = JSON.parse(await readFile(FIXTURE_FILE, "utf8"));
    const applyPolicy = await loadPolicy(copy);
    const result = await verifyStages({ ...config, pageRequest, applyPolicy, timeoutMs, locale });
    if (result.passed) return { ok: true, ms: Date.now() - started, results: result.results };
    const failures = result.results.filter((stage) => !stage.ok);
    return {
      ok: false,
      results: result.results,
      reason: failures.map((stage) => `${stage.stage}: HTTP ${stage.status || "—"} — ${stage.detail}`).join("; "),
      hint: copy.verifyHintPage,
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), hint: copy.verifyHintRetry };
  }
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
 * Default for the public origin question, most specific signal first: what
 * the file already says (unless it is the example), the host address the
 * `./setup` wrapper detected before entering the container, this machine's
 * own LAN address, or nothing.
 */
export function defaultOrigin({ existing, example, env, interfaces }) {
  const current = existing.get("SITEWAKE_PUBLIC_ORIGIN");
  if (!isPlaceholder(current, "SITEWAKE_PUBLIC_ORIGIN", example)) return normalizeOrigin(current) || "";
  const port = Number(existing.get("SITEWAKE_PORT") || example.get("SITEWAKE_PORT") || DEFAULT_PORT) || DEFAULT_PORT;
  const host = String(env.SITEWAKE_SETUP_HOST_IP || "").trim()
    || (env.SITEWAKE_SETUP_RUNNER === "docker" ? "" : lanAddress(interfaces));
  return host ? `http://${host}:${port}` : "";
}

function parseTarget(argv, copy) {
  let target;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--target") target = argv[index + 1] ?? "";
    else if (argv[index].startsWith("--target=")) target = argv[index].slice("--target=".length);
    else continue;
    const normalized = String(target).trim().toLowerCase();
    if (!TARGETS.includes(normalized)) throw new Error(copy.targetInvalid(target, TARGETS));
    return normalized;
  }
  return undefined;
}

function firstOf(existing, keys, fallback) {
  for (const key of keys) {
    const value = existing.get(key);
    if (value) return value;
  }
  return fallback;
}

function printManual(target, copy, log) {
  log(copy.needsTty);
  log(copy.manualIntro);
  const targets = target ? [target] : TARGETS;
  for (const item of targets) {
    log("");
    if (item === "local") {
      log(copy.manualLocalHeader);
      log(`  ${copy.manualKey}`);
      log(`  ${copy.manualBaseUrl(DEFAULT_BASE_URL)}`);
      log(`  ${copy.manualModel}`);
    } else {
      log(copy.manualDockerHeader);
      log(`  ${copy.manualKey}`);
      log(`  ${copy.manualBaseUrl(DEFAULT_BASE_URL)}`);
      log(`  ${copy.manualModel}`);
      log(`  ${copy.manualOrigin}`);
      log(`  ${copy.manualPrivate}`);
      log(`  ${copy.manualTokens(TOKEN_KEYS)}`);
      log(`  ${copy.manualPasswords(PASSWORD_KEYS)}`);
    }
  }
}

/** `Prompt [hint]` — the hint is what Enter keeps, or a masked stand-in for it. */
function withFallback(prompt, hint) {
  return hint ? `${prompt} [${hint}]` : prompt;
}

function statusHint(results, copy) {
  const statuses = new Set((results || []).map((stage) => stage.status));
  if (statuses.has(401) || statuses.has(403)) return copy.hint401;
  if (statuses.has(404)) return copy.hint404;
  if (statuses.has(0)) return copy.hintNetwork;
  return undefined;
}

/** Terminal columns a string takes: CJK and full-width characters count double. */
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) width += char.codePointAt(0) > 0x2e7f ? 2 : 1;
  return width;
}

function padDisplay(text, width) {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
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
 * Which of the four reachability cases an existing origin describes, so a
 * rerun preselects it: localhost, an https domain, a public IP, or a private
 * address (the LAN case).
 */
export function reachabilityOf(origin) {
  let url;
  try { url = new URL(origin); } catch { return undefined; }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") return "localhost";
  if (url.protocol === "https:") return "domain";
  if (isPrivateHostname(host)) return "lan";
  return "ip";
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** The address the "domain" case accepts: https:// plus a hostname that is not an IP. */
export function normalizeDomainOrigin(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
  const origin = normalizeOrigin(withScheme);
  if (!origin) return null;
  const url = new URL(origin);
  if (url.protocol !== "https:" || IPV4.test(url.hostname) || url.hostname === "localhost") return null;
  return origin;
}

/** The address the IP and LAN cases accept: an http(s) origin, or a bare host that gets http:// and the port. */
export function normalizeHostOrigin(input, port = DEFAULT_PORT) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  if (/^[a-z]+:\/\//i.test(text)) return normalizeOrigin(text);
  return normalizeOrigin(`http://${text}:${port}`);
}

/**
 * The wizard proper. `io` is injected so tests can script answers and read
 * output without a terminal; `main()` wires up readline.
 *
 * Returns the exit status: 0 written, 1 declined or non-interactive, 2 bad
 * arguments.
 */
export async function runWizard({
  argv = [],
  env = process.env,
  io,
  interactive = true,
  paths = {},
  timeoutMs = 30_000,
  interfaces,
} = {}) {
  let locale;
  try { locale = resolveCliLocale({ argv, env }); }
  catch (error) { io.error(error.message); return 2; }
  let copy = cli(locale);
  const log = (line = "") => io.log(line);

  let target;
  try { target = parseTarget(withoutLangFlag(argv), copy.setup); }
  catch (error) { io.error(error.message); return 2; }

  if (!interactive) { printManual(target, copy.setup, io.error); return 1; }

  log("");
  log(copy.setup.title);
  log("");

  // Language first, unless --lang already said. The menu is bilingual because
  // no language has been chosen yet; the environment's language is the default.
  if (!hasLangFlag(argv)) {
    log(copy.setup.languageQuestion);
    log(`  ${copy.setup.languageHint}`);
    const choice = await askChoice(io, log, copy, copy.setup.languageOptions, locale === "zh" ? 2 : 1, copy.setup.languageDefaultMarker);
    locale = choice === 2 ? "zh" : "en";
    copy = cli(locale);
    log("");
  }

  if (!target) {
    log(copy.setup.targetQuestion);
    const choice = await askChoice(io, log, copy, [
      `${copy.setup.targetLocal}  (${copy.setup.targetLocalFile})`,
      `${copy.setup.targetDocker}  (${copy.setup.targetDockerFile})`,
    ]);
    target = choice === 2 ? "docker" : "local";
    log("");
  }

  const envFile = target === "docker" ? (paths.dockerEnvFile || DOCKER_ENV_FILE) : (paths.envFile || ENV_FILE);
  const exampleFile = paths.containerExampleFile || CONTAINER_EXAMPLE_FILE;
  const currentText = await readOptional(envFile);
  const exampleText = target === "docker" ? (await readOptional(exampleFile)) || "" : "";
  const baseText = currentText ?? exampleText;
  const existing = parseEnvFile(currentText ?? "");
  const example = parseEnvFile(exampleText);

  const currentKey = firstOf(existing, ["MODEL_API_KEY", "OPENAI_API_KEY"], "");
  const currentBaseUrl = firstOf(existing, ["MODEL_BASE_URL", "OPENAI_BASE_URL"], "");
  const currentModel = firstOf(existing, ["MODEL", "OPENAI_MODEL"], "");
  const executionModel = firstOf(existing, ["MODEL_EXECUTION"], "");
  const semanticModel = firstOf(existing, ["MODEL_SEMANTIC"], "");

  let providers;
  let providerFor;
  try { ({ providers, providerFor } = await verifiedProviders(copy.setup)); }
  catch (error) { io.error(error.message); return 2; }

  log(copy.setup.modelIntro);
  log("");

  for (;;) {
    // Provider: a verified one fixes the base URL; "other" asks for it.
    log(copy.setup.providerQuestion);
    const width = Math.max(...providers.map((provider) => displayWidth(copy.setup.providerName(provider.id))));
    const providerLines = providers.map((provider) =>
      `${padDisplay(copy.setup.providerName(provider.id), width)}  ${provider.baseUrl}  ${provider.families.join(", ")}`);
    const preselected = currentBaseUrl ? providerFor(currentBaseUrl) : undefined;
    const preselectedIndex = preselected ? providers.findIndex((provider) => provider.id === preselected) + 1
      : currentBaseUrl ? providers.length + 1 : 0;
    const providerChoice = await askChoice(io, log, copy, [...providerLines, copy.setup.providerOther], preselectedIndex);
    const provider = providers[providerChoice - 1];
    const providerName = provider ? copy.setup.providerName(provider.id) : "";
    log("");
    let baseUrl;
    if (provider) {
      baseUrl = provider.baseUrl;
    } else {
      baseUrl = await io.ask(withFallback(copy.setup.baseUrl, currentBaseUrl), currentBaseUrl);
    }

    const apiKeyPrompt = provider ? copy.setup.apiKeyFor(providerName) : copy.setup.apiKeyFor(new URL(baseUrl).hostname);
    const apiKey = await io.askSecret(withFallback(apiKeyPrompt, currentKey && copy.setup.apiKeyKeep(maskSecret(currentKey))), currentKey);
    const modelPrompt = provider ? copy.setup.modelFor(providerName, provider.families) : copy.setup.modelOther;
    const model = await io.ask(withFallback(modelPrompt, currentModel), currentModel);

    if (!apiKey) {
      log("");
      log(copy.setup.apiKeyMissing);
      log("");
      continue;
    }
    if (!model) {
      log("");
      log(copy.setup.modelMissing);
      log("");
      continue;
    }

    let origin;
    let reachability;
    if (target === "docker") {
      log("");
      log(copy.setup.originIntro);
      log(copy.setup.originReachQuestion);
      // The address detected by ./setup (or this machine's LAN address) is a
      // sensible default only for the LAN case, or for the public-IP case when
      // it is not a private address.
      const detected = defaultOrigin({ existing: new Map(), example, env, interfaces });
      const detectedHost = detected ? new URL(detected).hostname : "";
      const publicDefault = detectedHost && !isPrivateHostname(detectedHost) ? detected : "";
      const currentOrigin = defaultOrigin({ existing, example, env: {}, interfaces: {} });
      const preselectedReach = currentOrigin ? REACHABILITY.indexOf(reachabilityOf(currentOrigin)) + 1 : 0;
      const reachChoice = await askChoice(io, log, copy, [
        `${copy.setup.originReachLocalhost}  ${copy.setup.originReachLocalhostValue}`,
        `${copy.setup.originReachDomain}  ${copy.setup.originReachDomainValue}`,
        `${copy.setup.originReachIp}  ${copy.setup.originReachIpValue(publicDefault ? detectedHost : "")}`,
        `${copy.setup.originReachLan}  ${copy.setup.originReachLanValue(detectedHost)}`,
      ], preselectedReach);
      reachability = REACHABILITY[reachChoice - 1];
      const port = Number(existing.get("SITEWAKE_PORT") || example.get("SITEWAKE_PORT") || DEFAULT_PORT) || DEFAULT_PORT;
      const keepCurrent = reachabilityOf(currentOrigin) === reachability ? currentOrigin : "";
      if (reachability === "localhost") {
        origin = `http://localhost:${port}`;
      } else if (reachability === "domain") {
        for (;;) {
          const answer = await io.ask(withFallback(copy.setup.originDomainQuestion, keepCurrent), keepCurrent);
          origin = normalizeDomainOrigin(answer);
          if (origin) break;
          log(copy.setup.originDomainInvalid);
        }
      } else {
        const fallback = keepCurrent || (reachability === "ip" ? publicDefault : detected);
        const question = reachability === "ip" ? copy.setup.originIpQuestion : copy.setup.originLanQuestion;
        for (;;) {
          const answer = await io.ask(withFallback(question, fallback), fallback);
          origin = normalizeHostOrigin(answer, port);
          if (origin) break;
          log(copy.setup.originInvalid);
        }
      }
      log(`  ${copy.setup.originLine(origin)}`);
    }

    log("");
    log(copy.setup.verifying);
    const result = await verifyModel({ baseUrl, apiKey, model, executionModel: executionModel || model }, timeoutMs, locale);
    if (result.ok) {
      const values = {
        MODEL_API_KEY: apiKey,
        MODEL_BASE_URL: baseUrl,
        MODEL: model,
        MODEL_EXECUTION: executionModel,
        MODEL_SEMANTIC: semanticModel,
      };
      let secrets;
      if (target === "docker") {
        secrets = generatedSecrets(existing, example);
        Object.assign(values, {
          SITEWAKE_PUBLIC_ORIGIN: origin,
          CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN: derivePrivateOrigin(origin),
        }, secrets.values);
      }
      const { text, removed } = applyEnvValues(baseText, values, { remove: LEGACY_MODEL_KEYS, locale });
      await writeModelConfig(text, envFile);

      log(copy.setup.verified(result.ms));
      log("");
      log(copy.setup.summary);
      log(`  ${copy.setup.written(envFile)}`);
      log(`  ${copy.setup.modelLine(model, baseUrl)}`);
      if (target === "docker") {
        log(`  ${copy.setup.originLine(origin)}`);
        if (reachability === "domain") log(`  ${copy.setup.originTlsReminder}`);
        log(`  ${values.CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN === "1" ? copy.setup.privateAllowed : copy.setup.privateDenied}`);
        if (secrets.generated.length) log(`  ${copy.setup.generated(secrets.generated)}`);
        if (secrets.kept.length) log(`  ${copy.setup.kept(secrets.kept)}`);
      }
      if (removed.length) log(`  ${copy.setup.removedLegacy(removed)}`);
      log("");
      log(copy.setup.next);
      if (target === "docker") {
        log(`  ${copy.setup.nextDocker}`);
        log(`  ${copy.setup.nextDockerOpen(origin)}`);
        log(`  ${copy.setup.nextDockerSmoke}`);
        log(`  ${copy.setup.nextDockerCompact}`);
      } else {
        for (const command of copy.setup.nextLocal) log(`  ${command}`);
        log(`  ${copy.setup.nextLocalOpen}`);
      }
      log("");
      return 0;
    }

    log("");
    log(copy.setup.verifyFailed(result.reason));
    log(`  ${result.hint}`);
    const hint = statusHint(result.results, copy.setup);
    if (hint) log(`  ${hint}`);
    log(`  ${copy.setup.unchanged}`);
    log("");
    const retry = (await io.ask(withFallback(copy.common.retryPrompt, copy.common.yes), copy.common.yes)).trim().toLowerCase();
    if (retry === "n" || retry === "no") {
      log("");
      log(copy.common.cancelled);
      log("");
      return 1;
    }
    log("");
  }
}

/**
 * Readline-backed IO for a real terminal. Prompts arrive fully formed (the
 * wizard adds the `[default]` hint, masked for secrets), so this adapter
 * never sees a choice about what to show; secrets are typed without echo.
 */
function terminalIo() {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    async ask(prompt, fallback) {
      const answer = (await rl.question(`${prompt}\n> `)).trim();
      return answer || fallback || "";
    },
    async askSecret(prompt, fallback) {
      const query = rl.question(`${prompt}\n> `);
      muted = true;
      const answer = (await query).trim();
      muted = false;
      process.stdout.write("\n");
      return answer || fallback || "";
    },
    close() { muted = false; rl.close(); },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const interactive = Boolean(process.stdin.isTTY);
  const io = interactive ? terminalIo() : { log: (line) => console.log(line), error: (line) => console.error(line), ask: async () => "", askSecret: async () => "", close() {} };
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
