/**
 * The setup wizard end to end, driven in-process.
 *
 * Why not a child process with piped answers: the provider payload policy
 * fails closed for unknown hosts, so a local stub provider on 127.0.0.1 can
 * never pass the page-execution stage — and adding a "skip verification"
 * switch to production code just for tests would defeat the spec. Instead the
 * wizard takes its IO as an injected object and the provider is a mocked
 * `fetch` answering as api.openai.com would, exactly as tests/setup-model.test.mjs
 * already does. The non-interactive path is covered by a real child process
 * because that one needs no provider.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  runWizard, parseEnvFile, applyEnvValues, isPrivateHostname, derivePrivateOrigin, normalizeOrigin,
  lanAddress, generatedSecrets, defaultOrigin, TOKEN_KEYS, PASSWORD_KEYS, writeModelConfig,
} from "../scripts/setup.mjs";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXAMPLE = await readFile(join(ROOT, ".env.container.example"), "utf8");
const KEY = "sk-live-0123456789abcdef";

/** Scripted answers in order; every prompt and log line is recorded. */
function scriptedIo(answers) {
  const queue = [...answers];
  const out = [];
  const err = [];
  const take = (prompt, fallback) => {
    assert.ok(queue.length, `no scripted answer left for prompt: ${prompt}`);
    const answer = queue.shift();
    out.push(`? ${prompt}`);
    return answer === "" ? (fallback || "") : answer;
  };
  return {
    out, err,
    log: (line) => out.push(String(line)),
    error: (line) => err.push(String(line)),
    ask: async (prompt, fallback) => take(prompt, fallback),
    askSecret: async (prompt, fallback) => take(prompt, fallback),
    remaining: () => queue.length,
  };
}

function providerOk(t) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const payload = JSON.parse(init.body);
    requests.push(payload);
    const name = payload.tool_choice?.function?.name || payload.tools[0].function.name;
    return Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: { name, arguments: "{}" } }] } }] });
  });
  return requests;
}

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), "sitewake-wizard-"));
  const paths = {
    envFile: join(dir, ".env.local"),
    dockerEnvFile: join(dir, ".env"),
    containerExampleFile: join(dir, ".env.container.example"),
  };
  await writeFile(paths.containerExampleFile, EXAMPLE);
  return { dir, paths, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const ENV_EN = { LANG: "en_US.UTF-8" };

test("an invalid --target names the valid values and writes nothing", async () => {
  const { paths, cleanup } = await tempRoot();
  try {
    const io = scriptedIo([]);
    const code = await runWizard({ argv: ["--target", "k8s"], env: ENV_EN, io, paths });
    assert.equal(code, 2);
    assert.match(io.err.join("\n"), /local, docker/);
    await assert.rejects(stat(paths.envFile));
    await assert.rejects(stat(paths.dockerEnvFile));
  } finally { await cleanup(); }
});

test("--target local skips the first question and writes .env.local with only the model keys", async (t) => {
  const { paths, cleanup } = await tempRoot();
  try {
    const requests = providerOk(t);
    const io = scriptedIo(["", "1", KEY, "gpt-test"]);
    const code = await runWizard({ argv: ["--target", "local"], env: ENV_EN, io, paths });
    assert.equal(code, 0, io.out.join("\n"));
    assert.equal(io.remaining(), 0);
    assert.doesNotMatch(io.out.join("\n"), /How will SiteWake run/);
    assert.match(io.out.join("\n"), /Language \/ 语言/, "the language is asked when --lang is absent");
    assert.equal(requests.length, 2, "both stages were verified before writing");

    const written = parseEnvFile(await readFile(paths.envFile, "utf8"));
    assert.equal(written.get("MODEL_API_KEY"), KEY);
    assert.equal(written.get("MODEL"), "gpt-test");
    assert.equal(written.has("SITEWAKE_PUBLIC_ORIGIN"), false);
    assert.equal(written.has("POSTGRES_PASSWORD"), false);
    if (process.platform !== "win32") assert.equal((await stat(paths.envFile)).mode & 0o777, 0o600);

    const output = io.out.join("\n");
    for (const command of ["npm install", "npx playwright install chromium", "npm run dev", "http://localhost:3000"]) {
      assert.ok(output.includes(command), `next steps must include ${command}`);
    }
    assert.ok(!output.includes(KEY), "the full key never appears in the output");
  } finally { await cleanup(); }
});

test("without --target the run-mode question chooses the file; '2' means Docker Compose", async (t) => {
  const { paths, cleanup } = await tempRoot();
  try {
    providerOk(t);
    const io = scriptedIo(["", "nope", "2", "1", KEY, "gpt-test"]);
    const code = await runWizard({ argv: [], env: ENV_EN, io, paths });
    assert.equal(code, 0, io.out.join("\n"));
    const output = io.out.join("\n");
    assert.match(output, /How will SiteWake run\?/);
    assert.match(output, /1\. From source with Node\.js — for development  \(writes \.env\.local\)/);
    assert.match(output, /2\. As a Docker Compose stack — for deployment  \(writes \.env\)/);
    assert.doesNotMatch(output, /Here, for local|on this machine  \(writes/, "the choice is a way of running, not a place");
    assert.match(output, /Please answer with one of: 1, 2/);
    await stat(paths.dockerEnvFile);
    await assert.rejects(stat(paths.envFile));
  } finally { await cleanup(); }
});

test("--lang skips the language question; LANG=C with '2' gives Chinese throughout", async (t) => {
  const { paths, cleanup } = await tempRoot();
  try {
    providerOk(t);
    const flagged = scriptedIo(["1", KEY, "gpt-test"]);
    assert.equal(await runWizard({ argv: ["--lang", "zh", "--target", "local"], env: { LANG: "C" }, io: flagged, paths }), 0, flagged.out.join("\n"));
    assert.doesNotMatch(flagged.out.join("\n"), /Language \/ 语言/);
    assert.match(flagged.out.join("\n"), /SiteWake 配置向导/);

    const chosen = scriptedIo(["2", "1", KEY, "gpt-test"]);
    assert.equal(await runWizard({ argv: ["--target", "local"], env: { LANG: "C" }, io: chosen, paths }), 0, chosen.out.join("\n"));
    const output = chosen.out.join("\n");
    assert.match(output, /Language \/ 语言\n  .*\n  1\. English  \(default \/ 默认\)\n  2\. 中文\n\? $/m, "the environment's language is marked as the default; the prompt stays bare");
    assert.match(output, /模型服务。SiteWake 需要一个 OpenAI 兼容/);
    assert.match(output, /验证成功/);
    assert.doesNotMatch(output.split("中文")[1], /Verified|Which provider/);
  } finally { await cleanup(); }
});

test("a verified provider fixes the base URL and names the families; 'other' asks for the URL; no model is prefilled", async (t) => {
  const { paths, cleanup } = await tempRoot();
  try {
    const requests = providerOk(t);
    const bailian = scriptedIo(["", "2", KEY, "qwen-plus"]);
    assert.equal(await runWizard({ argv: ["--target", "local"], env: ENV_EN, io: bailian, paths }), 0, bailian.out.join("\n"));
    const output = bailian.out.join("\n");
    assert.match(output, /Which provider\?/);
    assert.match(output, /2\. Alibaba Cloud Bailian\s+https:\/\/dashscope\.aliyuncs\.com\/compatible-mode\/v1\s+qwen\*/);
    assert.match(output, /5\. Another OpenAI-compatible service/);
    assert.doesNotMatch(output, /\? Base URL/, "a verified provider is never asked for its URL");
    assert.match(output, /\? API key for Alibaba Cloud Bailian — created in the provider's console\. Typed without echo; stored only in the configuration file written here, never sent to visitors' browsers\.$/m);
    assert.match(output, /\? Model — the exact model id from Alibaba Cloud Bailian's model list\. It must support tool calls; verified families: qwen\*\.$/m, "no default model in brackets on a first run");
    assert.ok(requests.every((payload) => !("enable_thinking" in payload && payload.enable_thinking)), "the Bailian policy was applied");
    let written = parseEnvFile(await readFile(paths.envFile, "utf8"));
    assert.equal(written.get("MODEL_BASE_URL"), "https://dashscope.aliyuncs.com/compatible-mode/v1");
    assert.equal(written.get("MODEL"), "qwen-plus");

    // Rerun: the existing URL preselects the provider, the model is the default.
    const rerun = scriptedIo(["", "", "", ""]);
    assert.equal(await runWizard({ argv: ["--target", "local"], env: ENV_EN, io: rerun, paths }), 0, rerun.out.join("\n"));
    assert.match(rerun.out.join("\n"), /2\. Alibaba Cloud Bailian[^\n]*\(default — Enter keeps it\)/, "Bailian is preselected");
    assert.match(rerun.out.join("\n"), /\? Model — [^\n]* \[qwen-plus\]$/m);

    // Other: the URL is asked, with the existing one as the default. An Ark
    // region the menu does not list is the realistic case; the policy accepts
    // any Ark region, so verification passes.
    const other = scriptedIo(["", "5", "https://ark.cn-shanghai.volces.com/api/v3", KEY, "doubao-seed"]);
    assert.equal(await runWizard({ argv: ["--target", "local"], env: ENV_EN, io: other, paths }), 0, other.out.join("\n"));
    assert.match(other.out.join("\n"), /\? Base URL of the service — [^\n]* \[https:\/\/dashscope\.aliyuncs\.com\/compatible-mode\/v1\]$/m);
    assert.match(other.out.join("\n"), /\? API key for ark\.cn-shanghai\.volces\.com — /);
    assert.match(other.out.join("\n"), /\? Model — the exact model id as your service names it\./);
    written = parseEnvFile(await readFile(paths.envFile, "utf8"));
    assert.equal(written.get("MODEL_BASE_URL"), "https://ark.cn-shanghai.volces.com/api/v3");

    // A service the policy has never verified fails closed, as before.
    const unknown = scriptedIo(["", "5", "https://llm.example.com/v1", KEY, "my-model", "n"]);
    assert.equal(await runWizard({ argv: ["--target", "local"], env: ENV_EN, io: unknown, paths }), 1);
    assert.match(unknown.out.join("\n"), /Verification failed/);
  } finally { await cleanup(); }
});

test("Docker on a fresh install: example as the base, secrets generated, private origin derived", async (t) => {
  const { paths, cleanup } = await tempRoot();
  try {
    providerOk(t);
    const io = scriptedIo(["", "1", KEY, "gpt-test"]);
    const env = { ...ENV_EN, SITEWAKE_SETUP_HOST_IP: "192.168.1.20" };
    const code = await runWizard({ argv: ["--target", "docker"], env, io, paths });
    assert.equal(code, 0, io.out.join("\n"));
    assert.equal(io.remaining(), 0, "the server address is announced, never asked");

    const text = await readFile(paths.dockerEnvFile, "utf8");
    const written = parseEnvFile(text);
    assert.match(io.out.join("\n"), /Server address: http:\/\/192\.168\.1\.20:3000\n  Visitors' browsers load the SDK from this address/);
    assert.doesNotMatch(io.out.join("\n"), /How will visitors reach/);
    assert.equal(written.get("SITEWAKE_PUBLIC_ORIGIN"), "http://192.168.1.20:3000", "the detected address and compose's port");
    assert.equal(written.get("CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN"), "1");
    assert.match(io.out.join("\n"), /CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN=1\) because the origin is on a private network/);

    const tokens = TOKEN_KEYS.map((key) => written.get(key));
    for (const token of tokens) assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(new Set(tokens).size, 4, "tokens are independent");
    for (const key of PASSWORD_KEYS) {
      assert.match(written.get(key), /^[A-Za-z0-9_-]{20,}$/);
      assert.notEqual(written.get(key), parseEnvFile(EXAMPLE).get(key));
    }
    assert.ok(text.includes("# Browser-visible SiteWake origin"), "the example's comments survive as the base of a fresh .env");
    if (process.platform !== "win32") assert.equal((await stat(paths.dockerEnvFile)).mode & 0o777, 0o600);

    const output = io.out.join("\n");
    assert.match(output, new RegExp(`Generated: ${[...TOKEN_KEYS, ...PASSWORD_KEYS].join(", ")}`));
    assert.doesNotMatch(output, /Kept:/);
    for (const value of [...tokens, ...PASSWORD_KEYS.map((key) => written.get(key)), KEY]) {
      assert.ok(!output.includes(value), "generated values and the key never appear in the output");
    }
    for (const command of ["docker compose up -d --build", "http://192.168.1.20:3000", "node scripts/container-smoke.mjs", "compose.compact.yaml"]) {
      assert.ok(output.includes(command), `next steps must include ${command}`);
    }
  } finally { await cleanup(); }
});

test("Docker on an existing install keeps real secrets verbatim and regenerates only placeholders", async (t) => {
  const { paths, cleanup } = await tempRoot();
  try {
    providerOk(t);
    const realToken = "a".repeat(64);
    const before = [
      "POSTGRES_PASSWORD=s3cr3t",
      "MINIO_ROOT_PASSWORD=change-me-too",
      `SITEWAKE_RUNNER_ENROLLMENT_TOKEN=${realToken}`,
      "CAPABILITY_V2_RUNNER_SECRET=replace-with-a-random-64-character-hex-secret",
      "CAPABILITY_V2_DISPATCH_TOKEN=",
      "SITEWAKE_PUBLIC_ORIGIN=https://agent.example.com",
      "SITEWAKE_MODEL_MAX_REQUESTS_PER_SITE_DAY=500   # tuned by hand",
      "OPENAI_MODEL=old-model",
      "MODEL_API_KEY=old-key",
      "",
    ].join("\n");
    await writeFile(paths.dockerEnvFile, before);

    const io = scriptedIo(["", "1", "", "gpt-new"]);
    const code = await runWizard({ argv: ["--target", "docker"], env: ENV_EN, io, paths });
    assert.equal(code, 0, io.out.join("\n"));

    const text = await readFile(paths.dockerEnvFile, "utf8");
    const written = parseEnvFile(text);
    assert.match(io.out.join("\n"), /Server address: https:\/\/agent\.example\.com/, "an existing origin is kept as is");
    assert.equal(written.get("POSTGRES_PASSWORD"), "s3cr3t", "a real password is never regenerated");
    assert.equal(written.get("SITEWAKE_RUNNER_ENROLLMENT_TOKEN"), realToken);
    assert.notEqual(written.get("MINIO_ROOT_PASSWORD"), "change-me-too", "the example placeholder counts as unset");
    assert.match(written.get("CAPABILITY_V2_RUNNER_SECRET"), /^[0-9a-f]{64}$/, "a replace-with- placeholder counts as unset");
    assert.match(written.get("CAPABILITY_V2_DISPATCH_TOKEN"), /^[0-9a-f]{64}$/, "an empty value counts as unset");
    assert.match(written.get("CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN"), /^[0-9a-f]{64}$/, "a missing key is generated");
    assert.equal(written.get("SITEWAKE_PUBLIC_ORIGIN"), "https://agent.example.com", "the existing origin was the default");
    assert.equal(written.get("CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN"), "0");
    assert.equal(written.get("MODEL_API_KEY"), "old-key", "Enter on the key question keeps the existing key");
    assert.equal(written.get("MODEL"), "gpt-new");
    assert.equal(written.has("OPENAI_MODEL"), false, "superseded names are removed");
    assert.ok(text.includes("SITEWAKE_MODEL_MAX_REQUESTS_PER_SITE_DAY=500   # tuned by hand"), "unrelated lines survive verbatim");

    const output = io.out.join("\n");
    assert.match(output, /Kept: SITEWAKE_RUNNER_ENROLLMENT_TOKEN, POSTGRES_PASSWORD/);
    assert.match(output, /Generated: CAPABILITY_V2_RUNNER_SECRET, CAPABILITY_V2_DISPATCH_TOKEN, CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN, MINIO_ROOT_PASSWORD/);
    assert.match(output, /Removed superseded names: OPENAI_MODEL/);
    assert.match(output, /CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN=0\)/);
    assert.match(output, /\? API key for OpenAI — [^\n]* \[current \*{7}, Enter to keep\]/, "short secrets are fully masked");
    assert.ok(!output.includes("[old-key]"), "the existing key is masked in the prompt itself, not by the terminal adapter");
  } finally { await cleanup(); }
});

test("the server address is derived, announced with where to change it, and the example's placeholder is never used", async (t) => {
  const { paths, cleanup } = await tempRoot();
  try {
    providerOk(t);
    await writeFile(paths.dockerEnvFile, EXAMPLE);
    const io = scriptedIo(["", "1", KEY, "gpt-test"]);
    const env = { ...ENV_EN, SITEWAKE_SETUP_HOST_IP: "10.0.0.7" };
    assert.equal(await runWizard({ argv: ["--target", "docker"], env, io, paths }), 0, io.out.join("\n"));
    const output = io.out.join("\n");
    assert.match(output, /Server address: http:\/\/10\.0\.0\.7:3000/);
    assert.match(output, /set SITEWAKE_PUBLIC_ORIGIN in \.env/);
    assert.match(output, /https:\/\/ address with a TLS reverse proxy in front of port 3000/);
    let written = parseEnvFile(await readFile(paths.dockerEnvFile, "utf8"));
    assert.equal(written.get("SITEWAKE_PUBLIC_ORIGIN"), "http://10.0.0.7:3000");
    assert.equal(written.get("CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN"), "1");

    // Inside the container with no host address at all: localhost, still not a question.
    await rm(paths.dockerEnvFile);
    const bare = scriptedIo(["", "1", KEY, "gpt-test"]);
    assert.equal(await runWizard({ argv: ["--target", "docker"], env: { ...ENV_EN, SITEWAKE_SETUP_RUNNER: "docker" }, io: bare, paths, interfaces: {} }), 0, bare.out.join("\n"));
    written = parseEnvFile(await readFile(paths.dockerEnvFile, "utf8"));
    assert.equal(written.get("SITEWAKE_PUBLIC_ORIGIN"), "http://localhost:3000");
  } finally { await cleanup(); }
});

test("verification failure leaves the file untouched, explains the status, and can be declined", async (t) => {
  const { paths, cleanup } = await tempRoot();
  try {
    const before = "MODEL_API_KEY=keep-me\nMODEL=keep-model\n";
    await writeFile(paths.envFile, before);
    t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: `bad key ${KEY}` } }, { status: 401 }));
    const io = scriptedIo(["", "1", KEY, "gpt-test", "n"]);
    const code = await runWizard({ argv: ["--target", "local"], env: ENV_EN, io, paths });
    assert.equal(code, 1);
    const output = io.out.join("\n");
    assert.match(output, /Verification failed: runtime-router: HTTP 401/);
    assert.match(output, /401\/403 — the key was not accepted/);
    assert.match(output, /has not been changed/);
    assert.match(output, /Cancelled\. Nothing was written\./);
    assert.ok(!output.includes(KEY), "the rejected key is redacted in the diagnostics");
    assert.equal(await readFile(paths.envFile, "utf8"), before);
  } finally { await cleanup(); }
});

test("a page-stage failure gets the page hint, and a retry can succeed", async (t) => {
  const { paths, cleanup } = await tempRoot();
  try {
    let attempt = 0;
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      const payload = JSON.parse(init.body);
      const forced = payload.tool_choice?.type === "function";
      attempt += forced ? 1 : 0;
      if (forced && attempt === 1) return Response.json({ error: { message: "tool_choice not supported" } }, { status: 400 });
      const name = payload.tool_choice?.function?.name || payload.tools[0].function.name;
      return Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: { name, arguments: "{}" } }] } }] });
    });
    const io = scriptedIo(["", "1", KEY, "gpt-test", "", "1", KEY, "gpt-test"]);
    const code = await runWizard({ argv: ["--target", "local"], env: ENV_EN, io, paths });
    assert.equal(code, 0, io.out.join("\n"));
    const output = io.out.join("\n");
    assert.match(output, /runtime-page-agent: HTTP 400/);
    assert.match(output, /A model that chats fine may still be unable to operate pages/);
    assert.match(output, /Verified \(\d+ ms\)/);
  } finally { await cleanup(); }
});

test("Chinese terminal: every person-facing line is Chinese, identifiers stay as they are", async (t) => {
  const { paths, cleanup } = await tempRoot();
  try {
    providerOk(t);
    const io = scriptedIo(["", "1", KEY, "gpt-test"]);
    const code = await runWizard({ argv: ["--target", "docker"], env: { LANG: "zh_CN.UTF-8" }, io, paths });
    assert.equal(code, 0, io.out.join("\n"));
    const output = io.out.join("\n");
    assert.match(output, /SiteWake 配置向导/);
    assert.match(output, /2\. 中文  \(default \/ 默认\)/, "Chinese is the default when LANG says so");
    assert.match(output, /服务器地址：http:\/\/[^\n]+\n  访客的浏览器从这个地址加载 SDK/);
    assert.match(output, /2\. 阿里云百炼\s+https:\/\/dashscope/);
    assert.match(output, /验证成功/);
    assert.match(output, /本次生成：SITEWAKE_RUNNER_ENROLLMENT_TOKEN/);
    assert.match(output, /docker compose up -d --build/);
    assert.doesNotMatch(output, /Verified|Generated:|Next\b/);
  } finally { await cleanup(); }
});

test("non-interactive: prints the manual list for the target, exits 1, writes nothing", async () => {
  const { dir, cleanup } = await tempRoot();
  try {
    const script = join(ROOT, "scripts", "setup.mjs");
    for (const [lang, expected] of [["C", /setup needs an interactive terminal/], ["zh_CN.UTF-8", /setup 需要交互式终端/]]) {
      const { stderr, code } = await run(process.execPath, [script, "--target", "docker"], { cwd: dir, env: { ...process.env, LANG: lang, LC_ALL: "", LC_MESSAGES: "", LANGUAGE: "" } })
        .then((result) => ({ ...result, code: 0 }))
        .catch((error) => ({ stdout: error.stdout, stderr: error.stderr, code: error.code }));
      assert.equal(code, 1);
      assert.match(stderr, expected);
      assert.match(stderr, /SITEWAKE_PUBLIC_ORIGIN/);
      assert.doesNotMatch(stderr, /\.env\.local/, "only the requested target is listed");
    }
    assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith(".env") && name !== ".env.container.example"), []);
  } finally { await cleanup(); }
});

test("origin normalization accepts bare origins only", () => {
  assert.equal(normalizeOrigin("https://agent.example.com"), "https://agent.example.com");
  assert.equal(normalizeOrigin("https://agent.example.com/"), "https://agent.example.com");
  assert.equal(normalizeOrigin("http://192.168.1.20:3000"), "http://192.168.1.20:3000");
  assert.equal(normalizeOrigin("  https://Agent.Example.com:8443 "), "https://agent.example.com:8443");
  assert.equal(normalizeOrigin("https://agent.example.com/console"), null);
  assert.equal(normalizeOrigin("https://agent.example.com/?x=1"), null);
  assert.equal(normalizeOrigin("https://user:pw@agent.example.com"), null);
  assert.equal(normalizeOrigin("agent.example.com"), null);
  assert.equal(normalizeOrigin("ftp://agent.example.com"), null);
  assert.equal(normalizeOrigin(""), null);
});

/**
 * Whatever the capability runner treats as private, the wizard must too;
 * otherwise a LAN install would be written with the switch at 0 and the
 * runner would refuse every task. The wizard may be stricter (names that can
 * only be private), never looser. Mirror of runner/capability-v2/process-runner.ts.
 */
function runnerIsPrivateHostname(hostname) {
  const value = hostname.toLowerCase();
  return value === "localhost" || value === "::1" || value === "0.0.0.0" || value === "169.254.169.254"
    || /^127\./.test(value) || /^10\./.test(value) || /^192\.168\./.test(value) || /^172\.(1[6-9]|2\d|3[01])\./.test(value);
}

test("private hostnames: the wizard is a superset of the runner's rule", () => {
  const samples = {
    "localhost": true, "127.0.0.1": true, "10.0.0.5": true, "172.20.1.1": true, "192.168.1.20": true,
    "169.254.1.1": true, "::1": true, "[::1]": true, "0.0.0.0": true, "169.254.169.254": true,
    "nas": true, "agent.local": true, "agent.internal": true, "app.localhost": true, "fd12:3456::1": true,
    "agent.example.com": false, "172.32.0.1": false, "11.0.0.1": false, "1.1.1.1": false, "example.com": false,
  };
  for (const [hostname, expected] of Object.entries(samples)) {
    assert.equal(isPrivateHostname(hostname), expected, hostname);
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (runnerIsPrivateHostname(bare)) assert.equal(isPrivateHostname(hostname), true, `runner says private, wizard must agree: ${hostname}`);
  }
  assert.equal(derivePrivateOrigin("http://192.168.1.20:3000"), "1");
  assert.equal(derivePrivateOrigin("https://agent.example.com"), "0");
  assert.equal(derivePrivateOrigin("not a url"), "0");
});

test("LAN address detection skips bridges and prefers home/office ranges", () => {
  const interfaces = {
    lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    "br-1234": [{ address: "172.18.0.1", family: "IPv4", internal: false }],
    en0: [{ address: "fe80::1", family: "IPv6", internal: false }, { address: "10.1.2.3", family: "IPv4", internal: false }],
    eth1: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
  };
  assert.equal(lanAddress(interfaces), "192.168.1.20");
  assert.equal(lanAddress({ docker0: interfaces.docker0, en0: interfaces.en0 }), "10.1.2.3");
  assert.equal(lanAddress({ lo0: interfaces.lo0, docker0: interfaces.docker0 }), undefined);
});

test("defaultOrigin follows the chain: file, wrapper-detected host, own LAN, nothing", () => {
  const example = parseEnvFile(EXAMPLE);
  const none = new Map();
  const eth = { eth0: [{ address: "192.168.9.9", family: "IPv4", internal: false }] };
  assert.equal(defaultOrigin({ existing: new Map([["SITEWAKE_PUBLIC_ORIGIN", "https://agent.example.com/"]]), example, env: {}, interfaces: eth }), "https://agent.example.com");
  assert.equal(defaultOrigin({ existing: new Map([["SITEWAKE_PUBLIC_ORIGIN", example.get("SITEWAKE_PUBLIC_ORIGIN")]]), example, env: {}, interfaces: eth }), "http://192.168.9.9:3000");
  assert.equal(defaultOrigin({ existing: none, example, env: { SITEWAKE_SETUP_HOST_IP: "10.0.0.7" }, interfaces: eth }), "http://10.0.0.7:3000");
  assert.equal(defaultOrigin({ existing: new Map([["SITEWAKE_PORT", "8080"]]), example, env: {}, interfaces: eth }), "http://192.168.9.9:8080");
  assert.equal(defaultOrigin({ existing: none, example, env: { SITEWAKE_SETUP_RUNNER: "docker" }, interfaces: eth }), "", "inside the container the container's own interfaces are meaningless");
  assert.equal(defaultOrigin({ existing: none, example, env: {}, interfaces: {} }), "");
});

test("generatedSecrets: placeholders are the example's values, empties and replace-with-", () => {
  const example = parseEnvFile(EXAMPLE);
  const fresh = generatedSecrets(new Map(), example);
  assert.deepEqual(fresh.kept, []);
  assert.deepEqual(fresh.generated, [...TOKEN_KEYS, ...PASSWORD_KEYS]);
  const again = generatedSecrets(new Map(Object.entries(fresh.values)), example);
  assert.deepEqual(again.generated, []);
  assert.deepEqual(again.values, fresh.values, "real values are kept verbatim");
  const mixed = generatedSecrets(new Map([["POSTGRES_PASSWORD", "change-me"], ["MINIO_ROOT_PASSWORD", "real"]]), example);
  assert.ok(mixed.generated.includes("POSTGRES_PASSWORD"));
  assert.deepEqual(mixed.kept, ["MINIO_ROOT_PASSWORD"]);
});

test("applyEnvValues: arbitrary keys, no duplicates, user lines verbatim, removal reported once", () => {
  const original = "# top comment\nA=1\nB=old\nB=older\nKEEP=\"x # y\"\nLEGACY=1\nLEGACY=2\n";
  const { text, removed } = applyEnvValues(original, { B: "new", C: "added" }, { remove: ["LEGACY"] });
  assert.equal(text, "# top comment\nA=1\nB=new\nKEEP=\"x # y\"\n\n# Written by `./setup`.\nC=added\n");
  assert.deepEqual(removed, ["LEGACY"]);
  assert.throws(() => applyEnvValues("", { A: "a\nB=1" }), /line break/);
  assert.throws(() => applyEnvValues("", { A: "a\nB=1" }, { locale: "zh" }), /换行/);
});

test("a failed write leaves the original file intact and no temp file behind", async () => {
  const { dir, cleanup } = await tempRoot();
  try {
    const path = join(dir, ".env");
    await writeFile(path, "ORIGINAL=1\n");
    // Writing into a path whose parent is a file cannot succeed at the temp-file stage.
    await assert.rejects(writeModelConfig("NEW=1\n", join(path, "child")));
    assert.equal(await readFile(path, "utf8"), "ORIGINAL=1\n");
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally { await cleanup(); }
});
