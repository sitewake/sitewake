/**
 * No credential reaches the published tree.
 *
 * The export boundary already refuses internal names (`public-export-purity`), but
 * nothing looked for credentials, and those are the failure nobody gets to undo: a
 * key pushed to a public repository is compromised the moment it lands, whether or
 * not a later commit removes it.
 *
 * The audit that produced this file found none — not in either tree, and not in 896
 * commits of history. This keeps it that way. It runs over every tracked file rather
 * than the diff, because a file can be moved into the export boundary long after it
 * was written.
 *
 * Fixtures are expected and must look like fixtures. `sk-console`, `must-not-persist`
 * and a JWT whose signature is the word "signature" all say plainly that they are not
 * real. A value that cannot be told apart from a credential should be rewritten so it
 * can — that is cheaper than arguing with this test.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Shapes that are credentials by construction: the issuer's own prefix and length. */
const ISSUED = [
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{24,}/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/],
  ["GitHub fine-grained PAT", /\bgithub_pat_[A-Za-z0-9_]{36,}/],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{12,}/],
  ["Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/],
  ["private key block", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["credentialed URL", /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[A-Za-z0-9._%-]+:[^@\s"'`$<>{}]{8,}@/],
  ["docker registry auth", /"auth"\s*:\s*"[A-Za-z0-9+/=]{24,}"/],
];

/** A value assigned to a credential-shaped name, which only context can judge. */
const ASSIGNED = /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key)\b\s*[:=]\s*["'`]([^"'`\n]{8,})["'`]/gi;

/**
 * A value that teaches the reader what to put there is not a credential.
 */
const OBVIOUSLY_NOT_REAL = /^(?:\$|process\.env|import\.meta|<|\{|\.\.\.|-+$)|x{4,}|\*{3,}|(?:your|example|sample|dummy|fake|placeholder|redacted|changeme|change[_-]?me|replace|todo|demo|localhost|none|null|undefined|empty)/i;

/**
 * Whether a value could be a credential at all, judged by shape rather than by a
 * list of words the fixtures happen to use.
 *
 * An issued credential is long and close to random: it has to be, or it would be
 * guessable. `sk-first` and `must-not-persist` are short and read as English, and no
 * issuer would ever hand one out. Measuring that is better than maintaining a list
 * of every word a test author might reach for — the list only ever grows, and each
 * entry quietly widens the hole.
 */
function couldBeIssued(value) {
  if (value.length < 20) return false;
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const share = count / value.length;
    entropy -= share * Math.log2(share);
  }
  // English prose and kebab-case fixtures sit near 3 bits per character; a base62
  // secret sits above 4.
  return entropy >= 3.6;
}

const SKIP_FILE = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|eot|mp4|pdf|zip|gz|map)$/i;

/** This file names the shapes it looks for, so it would otherwise flag itself. */
const SELF = "tests/secret-purity.test.mjs";

function trackedFiles() {
  return execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n").filter(Boolean).filter((file) => file !== SELF && !SKIP_FILE.test(file));
}

function readable(file) {
  let text;
  try { text = readFileSync(`${ROOT}${file}`, "utf8"); } catch { return ""; }
  return text.indexOf(String.fromCharCode(0)) === -1 ? text : "";
}

test("no issued credential appears in any tracked file", () => {
  const found = [];
  for (const file of trackedFiles()) {
    const text = readable(file);
    if (!text) continue;
    for (const [name, pattern] of ISSUED) {
      const match = pattern.exec(text);
      if (!match) continue;
      const line = text.slice(0, match.index).split("\n").length;
      found.push(`${file}:${line}  ${name}`);
    }
  }
  assert.deepEqual(found, [], `这些位置看起来是真实凭证，发布出去即已泄漏：\n  ${found.join("\n  ")}`);
});

test("a value assigned to a credential-shaped name reads as a fixture", () => {
  const found = [];
  for (const file of trackedFiles()) {
    const text = readable(file);
    if (!text) continue;
    for (const match of text.matchAll(ASSIGNED)) {
      const value = match[1].trim();
      if (OBVIOUSLY_NOT_REAL.test(value) || !couldBeIssued(value)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      found.push(`${file}:${line}  ${match[0].slice(0, 70)}`);
    }
  }
  assert.deepEqual(found, [],
    `这些值无法一眼看出不是真凭证。改成一眼可辨的 fixture，比在这里争论便宜：\n  ${found.join("\n  ")}`);
});

test("no credential file is tracked, and the ignore rules keep it that way", () => {
  const dangerous = trackedFiles().filter((file) =>
    /(?:^|\/)\.env(?:$|\.(?!example|container\.example))|\.(?:pem|p12|pfx|keystore|jks)$|(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:$|\.)|(?:^|\/)\.(?:netrc|npmrc|pgpass)$/.test(file));
  assert.deepEqual(dangerous, [], `这些文件按名字就不该被追踪：\n  ${dangerous.join("\n  ")}`);

  const ignore = readFileSync(`${ROOT}.gitignore`, "utf8");
  assert.match(ignore, /^\.env\*$/m, "`.env*` 必须被忽略，否则一次 `git add -A` 就够了");
  assert.match(ignore, /^\*\.pem$/m, "私钥文件必须被忽略");
});

test("the example env files carry no value, only the shape of one", () => {
  for (const file of [".env.example", ".env.container.example"]) {
    const text = readable(file);
    assert.ok(text, `${file} 必须存在：它是读者唯一的配置说明`);
    for (const [name, pattern] of ISSUED) {
      assert.doesNotMatch(text, pattern, `${file} 里有 ${name}`);
    }
    for (const match of text.matchAll(/^([A-Z][A-Z0-9_]*)=(.+)$/gm)) {
      const [, key, value] = match;
      if (!/KEY|TOKEN|SECRET|PASSWORD/.test(key)) continue;
      assert.ok(OBVIOUSLY_NOT_REAL.test(value.trim()) || !couldBeIssued(value.trim()),
        `${file} 的 ${key} 应当为空或写成一眼可辨的占位，现在是 ${JSON.stringify(value)}`);
    }
  }
});
