import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const PRODUCTION_RUNTIME_ENV_PATH = "/etc/sitewake/runtime.env";
export const PRODUCTION_CONFIRMATION = "sitewake-production";

export const RUNTIME_ENV_ALLOWLIST = new Set([
  "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB",
  "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "S3_BUCKET", "SITEWAKE_MINIO_IMAGE", "SITEWAKE_MC_IMAGE", "SITEWAKE_IMAGE_REGISTRY", "SITEWAKE_IMAGE_TAG", "SITEWAKE_NPM_REGISTRY",
  "SITEWAKE_BIND_ADDRESS", "SITEWAKE_PORT", "SITEWAKE_PUBLIC_ORIGIN", "SITEWAKE_PUBLIC_HOSTNAME", "SITEWAKE_DEMO_LOCK",
  "SITEWAKE_PAGE_AGENT_RUNTIME_V2", "SITEWAKE_PAGE_AGENT_EVIDENCE_V2", "SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX",
  "CAPABILITY_V2_BROWSER_PUBLIC_URL", "CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN", "CAPABILITY_V2_RUNNER_SECRET",
  "CAPABILITY_V2_DISPATCH_TOKEN", "CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN",
  "SITEWAKE_RUNNER_ENROLLMENT_TOKEN", "SITEWAKE_LEGACY_RUNNER_PROTOCOL", "SITEWAKE_RUNNER_LEASE_AUTHORITY",
  "SITEWAKE_RUNNER_VISIBILITY", "SITEWAKE_RUNNER_TOKEN", "SITEWAKE_AUTHORING_RUNNER_ID", "SITEWAKE_VALIDATION_RUNNER_ID",
  "SITEWAKE_EXECUTION_RUNNER_ID", "SITEWAKE_EXECUTION_RUNNER_CONCURRENCY", "SITEWAKE_EXECUTION_RUNNER_PREWARM",
  "SITEWAKE_CODEX_AUTHORING_TIMEOUT_MS", "SITEWAKE_CODEX_AUTHORING_MAX_TOOL_CALLS",
  "MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC",
  "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL",
  
  "SITEWAKE_IDEMPOTENCY_SECRET", "SITEWAKE_ANALYTICS_SALT",
  "CAPABILITY_V2_INPUT_KEY", "CAPABILITY_V2_AUTO_DISPATCH", "POSTGRES_POOL_SIZE",
  
  "CLOUDFLARE_TUNNEL_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_D1_DATABASE_ID",
  "CLOUDFLARE_ZONE_NAME", "CLOUDFLARE_ROUTE_HOSTNAME", "SITEWAKE_LAB_HOSTNAME", "ACCESS_ADMIN_KEY",
]);

const FORBIDDEN_RELEASE_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/i,
  /(^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/i,
  /(^|\/)\.ssh(?:\/|$)/i,
  /(^|\/)(?:\.npmrc|\.pypirc|\.netrc|\.dockercfg|application_default_credentials\.json|service-account[^/]*\.json|[^/]+\.kdbx)$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)(?:\.git-credentials|auth\.json|token\.txt)$/i,
];

export function normalizeReleasePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isForbiddenReleasePath(value) {
  const path = normalizeReleasePath(value);
  return !path || path.startsWith("/") || path.includes("../")
    || FORBIDDEN_RELEASE_PATTERNS.some((pattern) => pattern.test(path));
}

export function filterReleaseFiles(files) {
  return [...new Set(files.map(normalizeReleasePath))]
    .filter((path) => !isForbiddenReleasePath(path))
    .sort();
}

export function assertReleaseContainsNoSensitivePaths(files) {
  const forbidden = files.map(normalizeReleasePath).filter(isForbiddenReleasePath);
  if (forbidden.length) throw new Error(`release_contains_forbidden_paths:${forbidden.join(",")}`);
}

const CREDENTIAL_CONTENT_PATTERNS = [
  new RegExp(["-----BEGIN ", "(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"].join("")),
  /AKIA[0-9A-Z]{16}/,
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /sk-[A-Za-z0-9_-]{32,}/,
];

export function assertReleaseContainsNoCredentialMaterial(root, files) {
  for (const relativePath of files) {
    const path = join(root, relativePath);
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > 2 * 1024 * 1024) continue;
    const content = readFileSync(path);
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    if (CREDENTIAL_CONTENT_PATTERNS.some((pattern) => pattern.test(text))) {
      throw new Error(`release_contains_credential_material:${relativePath}`);
    }
  }
}

export function parseRuntimeEnv(source) {
  const values = new Map();
  for (const [index, rawLine] of String(source).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`runtime_env_invalid_line:${index + 1}`);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`runtime_env_invalid_key:${key}`);
    if (!RUNTIME_ENV_ALLOWLIST.has(key)) throw new Error(`runtime_env_key_not_allowed:${key}`);
    if (values.has(key)) throw new Error(`runtime_env_duplicate_key:${key}`);
    if (/[\r\n\0]/.test(value)) throw new Error(`runtime_env_invalid_value:${key}`);
    values.set(key, value);
  }
  if (!values.size) throw new Error("runtime_env_empty");
  return values;
}

export function serializeRuntimeEnv(values) {
  return `${[...values.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

export function parseRuntimePatch(source) {
  const changes = new Map();
  for (const [index, rawLine] of String(source).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const deleting = line.startsWith("!");
    const separator = line.indexOf("=");
    const key = deleting ? line.slice(1) : separator > 0 ? line.slice(0, separator).trim() : "";
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`runtime_patch_invalid_line:${index + 1}`);
    if (!RUNTIME_ENV_ALLOWLIST.has(key)) throw new Error(`runtime_env_key_not_allowed:${key}`);
    if (changes.has(key)) throw new Error(`runtime_env_duplicate_key:${key}`);
    if (deleting && line !== `!${key}`) throw new Error(`runtime_patch_invalid_delete:${key}`);
    const value = deleting ? undefined : line.slice(separator + 1);
    if (value !== undefined && /[\r\n\0]/.test(value)) throw new Error(`runtime_env_invalid_value:${key}`);
    changes.set(key, value);
  }
  if (!changes.size) throw new Error("runtime_patch_empty");
  return changes;
}

export function serializeRuntimePatch(changes) {
  return `${[...changes.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => value === undefined ? `!${key}` : `${key}=${value}`).join("\n")}\n`;
}

export function redactedRuntimeDiff(current, proposed) {
  const keys = [...new Set([...current.keys(), ...proposed.keys()])].sort();
  return keys.flatMap((key) => {
    if (!current.has(key)) return [`+ ${key}=<redacted>`];
    if (!proposed.has(key)) return [`- ${key}=<redacted>`];
    return current.get(key) === proposed.get(key) ? [] : [`~ ${key}=<redacted>`];
  });
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
