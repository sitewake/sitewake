/**
 * The setup wizard end to end, driven in-process.
 *
 * The wizard takes its IO as an injected object, so a test scripts the one
 * answer (the language) and reads every line it printed. It never contacts
 * anything: the model is the console's job, so there is no provider to stub.
 * The non-interactive path is the same function with `interactive: false`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runWizard, parseEnvFile, applyEnvValues, isPrivateHostname, derivePrivateOrigin, normalizeOrigin,
  lanAddress, generatedSecrets, defaultOrigin, TOKEN_KEYS, PASSWORD_KEYS, writeEnvFile,
} from "../scripts/setup.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXAMPLE = await readFile(join(ROOT, ".env.container.example"), "utf8");
const HAN = /[一-鿿]/;
/** Words that must never appear: the wizard has nothing to say about the model. */
const MODEL_WORDS = /model|api key|api_key|token|secret|password|密钥|模型|令牌|口令/i;

/** Scripted answers in order; every prompt and log line is recorded. */
function scriptedIo(answers) {
  const queue = [...answers];
  const out = [];
  const err = [];
  return {
    out, err,
    log: (line) => out.push(String(line)),
    error: (line) => err.push(String(line)),
    ask: async (prompt, fallback) => {
      assert.ok(queue.length, `no scripted answer left for prompt: ${prompt}`);
      const answer = queue.shift();
      out.push(`? ${prompt}`);
      return answer === "" ? (fallback || "") : answer;
    },
    remaining: () => queue.length,
  };
}

async function tempRoot() {
  const dir = await mkdtemp(join(tmpdir(), "sitewake-wizard-"));
  const paths = {
    dockerEnvFile: join(dir, ".env"),
    containerExampleFile: join(dir, ".env.container.example"),
    startMarker: join(dir, ".sitewake-setup-start"),
  };
  await writeFile(paths.containerExampleFile, EXAMPLE);
  return { dir, paths, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const ENV_EN = { LANG: "en_US.UTF-8" };

/** Lines printed up to and including the language prompt. */
function beforeAnswer(io) {
  const index = io.out.findIndex((line) => line.startsWith("? "));
  return io.out.slice(0, index + 1).join("\n");
}

test("the only question is the language, in English, with no Chinese before the answer and none after an English answer", async () => {
  const { paths, cleanup } = await tempRoot();
  try {
    const io = scriptedIo(["1"]);
    const code = await runWizard({ argv: ["--no-start"], env: { LANG: "zh_CN.UTF-8", SITEWAKE_SETUP_HOST_IP: "192.168.1.20" }, io, paths });
    assert.equal(code, 0, io.out.join("\n"));
    assert.equal(io.remaining(), 0);
    const prelude = beforeAnswer(io);
    assert.match(prelude, /^\nLanguage\n  Enter keeps the default\.\n  1\. English\n  2\. Chinese  \(default\)\n\? $/, "the question, its hint and the options are English; a Chinese terminal is the default");
    assert.doesNotMatch(prelude, HAN, "nothing Chinese before the person has chosen");
    assert.doesNotMatch(prelude, /SiteWake setup|配置向导/, "the title waits for the language");
    const output = io.out.join("\n");
    assert.equal(io.out.filter((line) => line.startsWith("? ")).length, 1, "exactly one question");
    assert.doesNotMatch(output, HAN, "an English answer on a Chinese terminal gives English");
    assert.match(output, /SiteWake setup/);
    assert.match(output, /Console: http:\/\/192\.168\.1\.20:3000\n  Administer SiteWake at this address/);
    assert.doesNotMatch(output, MODEL_WORDS, "the wizard never mentions the model, keys or tokens");
    assert.doesNotMatch(output, /What do you want to do|Which provider|Generated:|Kept:|Private-network|Verif/);
  } finally { await cleanup(); }
});

test("LANG=C with '2' gives Chinese throughout; --lang skips the question entirely", async () => {
  const { paths, cleanup } = await tempRoot();
  try {
    const io = scriptedIo(["2"]);
    assert.equal(await runWizard({ argv: ["--no-start"], env: { LANG: "C", SITEWAKE_SETUP_HOST_IP: "10.0.0.7" }, io, paths }), 0, io.out.join("\n"));
    assert.match(beforeAnswer(io), /1\. English  \(default\)\n  2\. Chinese\n/);
    assert.doesNotMatch(beforeAnswer(io), HAN);
    const after = io.out.slice(io.out.findIndex((line) => line.startsWith("? ")) + 1).join("\n");
    assert.match(after, /SiteWake 配置向导/);
    assert.match(after, /控制台：http:\/\/10\.0\.0\.7:3000\n  用这个地址管理 SiteWake/);
    assert.match(after, /已写入 /);
    assert.doesNotMatch(after, /Console:|Written to|Next\b/);
    assert.doesNotMatch(after, MODEL_WORDS);

    for (const [lang, expected] of [["en", /SiteWake setup/], ["zh", /SiteWake 配置向导/]]) {
      const silent = scriptedIo([]);
      assert.equal(await runWizard({ argv: ["--lang", lang, "--no-start"], env: ENV_EN, io: silent, paths }), 0, silent.out.join("\n"));
      assert.equal(silent.out.filter((line) => line.startsWith("? ")).length, 0, "--lang: zero questions");
      assert.match(silent.out.join("\n"), expected);
    }
  } finally { await cleanup(); }
});

test("an invalid --lang names the valid values and writes nothing", async () => {
  const { paths, cleanup } = await tempRoot();
  try {
    const io = scriptedIo([]);
    assert.equal(await runWizard({ argv: ["--lang", "fr"], env: ENV_EN, io, paths }), 2);
    assert.match(io.err.join("\n"), /--lang must be one of: en, zh/);
    await assert.rejects(readFile(paths.dockerEnvFile));
  } finally { await cleanup(); }
});

test("a fresh install: example as the base, secrets generated silently, address and private origin derived", async () => {
  const { paths, cleanup } = await tempRoot();
  try {
    const io = scriptedIo([""]);
    const env = { ...ENV_EN, SITEWAKE_SETUP_HOST_IP: "192.168.1.20" };
    const code = await runWizard({ argv: ["--no-start"], env, io, paths });
    assert.equal(code, 0, io.out.join("\n"));

    const text = await readFile(paths.dockerEnvFile, "utf8");
    const written = parseEnvFile(text);
    assert.equal(written.get("SITEWAKE_PUBLIC_ORIGIN"), "http://192.168.1.20:3000", "the detected address and compose's port");
    assert.match(written.get("COMPOSE_PROJECT_NAME"), /^sitewake-[0-9a-f]{4}$/, "each install gets its own Compose project");
    assert.match(io.out.join("\n"), /Compose project: sitewake-[0-9a-f]{4} — its containers and data volumes carry this name/);
    assert.equal(written.get("CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN"), "1");
    assert.equal(written.get("MODEL_API_KEY"), "", "the model keys are left as the example has them: empty, for the console to fill");

    const tokens = TOKEN_KEYS.map((key) => written.get(key));
    for (const token of tokens) assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(new Set(tokens).size, 4, "tokens are independent");
    for (const key of PASSWORD_KEYS) {
      assert.match(written.get(key), /^[A-Za-z0-9_-]{20,}$/);
      assert.notEqual(written.get(key), parseEnvFile(EXAMPLE).get(key));
    }
    assert.ok(text.includes("# The factory default for the address visitors load SiteWake from"), "the example's comments survive as the base of a fresh .env");
    if (process.platform !== "win32") assert.equal((await stat(paths.dockerEnvFile)).mode & 0o777, 0o600);

    const output = io.out.join("\n");
    for (const value of [...tokens, ...PASSWORD_KEYS.map((key) => written.get(key))]) {
      assert.ok(!output.includes(value), "generated values never appear in the output");
    }
    assert.doesNotMatch(output, MODEL_WORDS);
    for (const command of ["docker compose up -d --build", "http://192.168.1.20:3000", "node scripts/container-smoke.mjs", "compose.compact.yaml"]) {
      assert.ok(output.includes(command), `next steps must include ${command}`);
    }
  } finally { await cleanup(); }
});

test("an existing install: real secrets kept verbatim, placeholders regenerated, hand-written model keys preserved and unmentioned", async () => {
  const { paths, cleanup } = await tempRoot();
  try {
    const previous = [
      "# my notes",
      "COMPOSE_PROJECT_NAME=sitewake-ab12",
      "SITEWAKE_PUBLIC_ORIGIN=https://agent.example.com",
      "SITEWAKE_RUNNER_ENROLLMENT_TOKEN=" + "a".repeat(64),
      "CAPABILITY_V2_RUNNER_SECRET=replace-with-a-random-64-character-hex-secret",
      "POSTGRES_PASSWORD=real-password",
      "MODEL_API_KEY=sk-hand-written-0000",
      "MODEL_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1",
      "MODEL=qwen3-max",
      "OPENAI_API_KEY=legacy-alias",
      "",
    ].join("\n");
    await writeFile(paths.dockerEnvFile, previous);
    const io = scriptedIo([""]);
    assert.equal(await runWizard({ argv: ["--no-start"], env: { ...ENV_EN, SITEWAKE_SETUP_HOST_IP: "10.0.0.7" }, io, paths }), 0, io.out.join("\n"));
    const text = await readFile(paths.dockerEnvFile, "utf8");
    const written = parseEnvFile(text);
    assert.equal(written.get("COMPOSE_PROJECT_NAME"), "sitewake-ab12", "an existing project name is kept");
    assert.equal(written.get("SITEWAKE_PUBLIC_ORIGIN"), "https://agent.example.com", "a configured address is kept");
    assert.equal(written.get("CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN"), "0");
    assert.equal(written.get("SITEWAKE_RUNNER_ENROLLMENT_TOKEN"), "a".repeat(64));
    assert.match(written.get("CAPABILITY_V2_RUNNER_SECRET"), /^[0-9a-f]{64}$/, "the placeholder is replaced");
    assert.equal(written.get("POSTGRES_PASSWORD"), "real-password");
    for (const key of ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "OPENAI_API_KEY"]) {
      assert.equal(written.get(key), parseEnvFile(previous).get(key), `${key} passes through untouched`);
    }
    assert.ok(text.startsWith("# my notes\n"), "the person's own lines stay");
    const output = io.out.join("\n");
    assert.doesNotMatch(output, /sk-hand-written|qwen3-max|legacy-alias|real-password/);
    assert.doesNotMatch(output, MODEL_WORDS);
    assert.match(output, /Console: https:\/\/agent\.example\.com/);
  } finally { await cleanup(); }
});

test("the address is derived, the mode is announced with what the other one needs, and the example's placeholder is never used", async () => {
  const { paths, cleanup } = await tempRoot();
  try {
    await writeFile(paths.dockerEnvFile, EXAMPLE);
    const io = scriptedIo([""]);
    const env = { ...ENV_EN, SITEWAKE_SETUP_HOST_IP: "10.0.0.7" };
    assert.equal(await runWizard({ argv: ["--no-start"], env, io, paths }), 0, io.out.join("\n"));
    const output = io.out.join("\n");
    assert.match(output, /Console: http:\/\/10\.0\.0\.7:3000/);
    // Which mode this install is in, what the other one needs, and where the
    // address is set — which is the console, not this file.
    assert.match(output, /local trial mode: websites running on this machine or this LAN/);
    assert.match(output, /needs an https public address/);
    assert.match(output, /under Settings, on the public address page/);
    assert.doesNotMatch(output, /set SITEWAKE_PUBLIC_ORIGIN in \.env/);
    let written = parseEnvFile(await readFile(paths.dockerEnvFile, "utf8"));
    assert.equal(written.get("SITEWAKE_PUBLIC_ORIGIN"), "http://10.0.0.7:3000");
    assert.equal(written.get("CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN"), "1");

    // A cloud VM: the wrapper found the public address; say what to open in the firewall.
    await rm(paths.dockerEnvFile);
    const cloud = scriptedIo([""]);
    assert.equal(await runWizard({ argv: ["--no-start"], env: { ...env, SITEWAKE_SETUP_PUBLIC_IP: "203.0.113.9" }, io: cloud, paths }), 0, cloud.out.join("\n"));
    assert.match(cloud.out.join("\n"), /Console: http:\/\/203\.0\.113\.9:3000/);
    assert.match(cloud.out.join("\n"), /Open TCP 3000 in the cloud security group[^\n]*Inside the private network use http:\/\/10\.0\.0\.7:3000/);

    // Inside the container with no host address at all: localhost, still not a question.
    await rm(paths.dockerEnvFile);
    const bare = scriptedIo([""]);
    assert.equal(await runWizard({ argv: ["--no-start"], env: { ...ENV_EN, SITEWAKE_SETUP_RUNNER: "docker" }, io: bare, paths, interfaces: {} }), 0, bare.out.join("\n"));
    written = parseEnvFile(await readFile(paths.dockerEnvFile, "utf8"));
    assert.equal(written.get("SITEWAKE_PUBLIC_ORIGIN"), "http://localhost:3000");
  } finally { await cleanup(); }
});

test("the volume warning fires only for this project's own volumes", async () => {
  const { paths, cleanup } = await tempRoot();
  try {
    // Fresh install: the project name is new, so another install's volumes are irrelevant.
    const fresh = scriptedIo([""]);
    const env = { ...ENV_EN, SITEWAKE_SETUP_HOST_IP: "10.0.0.7", SITEWAKE_SETUP_EXISTING_VOLUMES: "sitewake_postgres-data,sitewake_minio-data" };
    assert.equal(await runWizard({ argv: ["--no-start"], env, io: fresh, paths }), 0, fresh.out.join("\n"));
    assert.doesNotMatch(fresh.out.join("\n"), /WARNING: data volumes/);

    // A hand-written .env that names an existing project but has placeholder
    // passwords would generate passwords the project's volumes do not know.
    await writeFile(paths.dockerEnvFile, "COMPOSE_PROJECT_NAME=sitewake\n");
    const collide = scriptedIo([""]);
    assert.equal(await runWizard({ argv: ["--no-start"], env, io: collide, paths }), 0, collide.out.join("\n"));
    const output = collide.out.join("\n");
    assert.match(output, /WARNING: data volumes from an earlier install exist on this machine: sitewake_postgres-data, sitewake_minio-data\./);
    assert.match(output, /docker compose down -v/);
    assert.match(output, /put the earlier POSTGRES_PASSWORD and MINIO_ROOT_PASSWORD back/);

    // Same .env again: the passwords are kept, so there is nothing to warn about.
    const rerun = scriptedIo([""]);
    assert.equal(await runWizard({ argv: ["--no-start"], env, io: rerun, paths }), 0, rerun.out.join("\n"));
    assert.doesNotMatch(rerun.out.join("\n"), /WARNING: data volumes/);
  } finally { await cleanup(); }
});

test("the wizard leaves the start marker with the language for ./setup unless --no-start", async () => {
  const { paths, cleanup } = await tempRoot();
  try {
    const io = scriptedIo([""]);
    assert.equal(await runWizard({ argv: [], env: { LANG: "zh_CN.UTF-8" }, io, paths }), 0, io.out.join("\n"));
    const output = io.out.join("\n");
    assert.match(output, /正在用 Docker Compose 启动 SiteWake/);
    assert.doesNotMatch(output, /^  docker compose up -d --build$/m, "the wrapper runs compose; the wizard prints no manual next step");
    assert.doesNotMatch(output, /下一步/);
    assert.equal(await readFile(paths.startMarker, "utf8"), "zh\n");

    // --no-start keeps the manual next steps and leaves no marker.
    await rm(paths.startMarker);
    const manual = scriptedIo([""]);
    assert.equal(await runWizard({ argv: ["--no-start"], env: ENV_EN, io: manual, paths }), 0, manual.out.join("\n"));
    assert.match(manual.out.join("\n"), /^  docker compose up -d --build$/m);
    await assert.rejects(readFile(paths.startMarker));
  } finally { await cleanup(); }
});

test("--report says where to open the console, how healthy the stack is, and sends the person to the onboarding — never to a model", async () => {
  const { paths, cleanup } = await tempRoot();
  try {
    await writeFile(paths.dockerEnvFile, "SITEWAKE_PUBLIC_ORIGIN=http://203.0.113.9:3000\n");
    const healthy = JSON.stringify({ status: "ready", services: { database: "ready", objectStorage: "ready", capabilityV2RunnerLauncher: "ready" } });
    const ready = scriptedIo([]);
    const env = { ...ENV_EN, SITEWAKE_SETUP_PUBLIC_IP: "203.0.113.9", SITEWAKE_SETUP_HOST_IP: "10.0.0.7", SITEWAKE_SETUP_HEALTH_JSON: healthy };
    assert.equal(await runWizard({ argv: ["--report", "--lang", "en"], env, io: ready, paths }), 0);
    const output = ready.out.join("\n");
    assert.match(output, /SiteWake is running\./);
    assert.match(output, /Open the console:  http:\/\/203\.0\.113\.9:3000/);
    assert.match(output, /From the private network:  http:\/\/10\.0\.0\.7:3000/);
    assert.match(output, /TCP 3000 is open in the cloud security group/);
    assert.match(output, /Health: ready \(database: ready, objectStorage: ready, capabilityV2RunnerLauncher: ready\)/);
    assert.match(output, /Next: open the console and follow the onboarding to connect your website\./);
    assert.match(output, /http:\/\/203\.0\.113\.9:3000\/access/);
    assert.doesNotMatch(output, /model|api key|模型|密钥|token|令牌|three-step/i, "the report sends the person to the console, not to a model");

    const degraded = JSON.stringify({ status: "degraded", services: { database: "auth_failed", databaseHint: "Postgres rejected the password in DATABASE_URL.", objectStorage: "ready", capabilityV2RunnerLauncher: "ready" } });
    const notReady = scriptedIo([]);
    assert.equal(await runWizard({ argv: ["--report", "--lang", "zh"], env: { ...env, SITEWAKE_SETUP_HEALTH_JSON: degraded }, io: notReady, paths }), 0);
    assert.match(notReady.out.join("\n"), /SiteWake 已启动，但控制面还没就绪。/);
    assert.match(notReady.out.join("\n"), /database: auth_failed/);
    assert.match(notReady.out.join("\n"), /Postgres rejected the password/);
    assert.match(notReady.out.join("\n"), /docker compose logs --tail=60 control-plane/);

    const failed = scriptedIo([]);
    assert.equal(await runWizard({ argv: ["--report", "--failed"], env: { ...env, SITEWAKE_SETUP_HEALTH_JSON: "", SITEWAKE_SETUP_EVENTS: "port-busy:3000:nginx" }, io: failed, paths }), 1);
    assert.match(failed.out.join("\n"), /docker compose could not start the stack\./);
    assert.match(failed.out.join("\n"), /Port 3000 is in use by "nginx", which is not SiteWake/);

    // Building the images here is a normal install path, not something that
    // went wrong: the report says nothing about it.
    const built = scriptedIo([]);
    assert.equal(await runWizard({ argv: ["--report", "--lang", "en"], env: { ...env, SITEWAKE_SETUP_EVENTS: "built-from-source\n" }, io: built, paths }), 0);
    assert.doesNotMatch(built.out.join("\n"), /could not|failed|source/i);
    assert.match(built.out.join("\n"), /SiteWake is running\./);

    const healed = scriptedIo([]);
    assert.equal(await runWizard({ argv: ["--report", "--lang", "zh"], env: { ...env, SITEWAKE_SETUP_EVENTS: "stopped:sitewake\nrotated:sitewake-a1b2:sitewake-c3d4\n" }, io: healed, paths }), 0);
    assert.match(healed.out.join("\n"), /已停掉占着端口的上一套 SiteWake 安装「sitewake」/);
    assert.match(healed.out.join("\n"), /改以「sitewake-c3d4」运行/);
    assert.match(healed.out.join("\n"), /下一步：打开控制台，按引导接入你的网站。/);
  } finally { await cleanup(); }
});

test("without a terminal there is nothing to ask: the environment's language is used and the file is written", async () => {
  const { paths, cleanup } = await tempRoot();
  try {
    const io = scriptedIo([]);
    const code = await runWizard({ argv: ["--no-start"], env: { LANG: "zh_CN.UTF-8", SITEWAKE_SETUP_HOST_IP: "10.0.0.7" }, io, paths, interactive: false });
    assert.equal(code, 0, io.out.join("\n"));
    const output = io.out.join("\n");
    assert.equal(io.out.filter((line) => line.startsWith("? ")).length, 0);
    assert.match(output, /SiteWake 配置向导/);
    assert.doesNotMatch(output, /Language/);
    assert.doesNotMatch(output, MODEL_WORDS);
    assert.equal(parseEnvFile(await readFile(paths.dockerEnvFile, "utf8")).get("SITEWAKE_PUBLIC_ORIGIN"), "http://10.0.0.7:3000");
    // main() decides interactivity from the terminal, nothing else.
    const source = await readFile(join(ROOT, "scripts", "setup.mjs"), "utf8");
    assert.match(source, /const interactive = Boolean\(process\.stdin\.isTTY\);/);
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
    await assert.rejects(writeEnvFile("NEW=1\n", join(path, "child")));
    assert.equal(await readFile(path, "utf8"), "ORIGINAL=1\n");
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally { await cleanup(); }
});
