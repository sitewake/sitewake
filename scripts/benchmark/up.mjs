// Brings the benchmark up from nothing: env file, mirrored sites, images,
// the compose stack, the console password, every site registered and crawled.
// Safe to re-run; each step skips what is already in place.
//
//   node scripts/benchmark/up.mjs [--build] [--no-mirror] [--no-crawl] [--crawl-timeout <min>] [--doctor]
//
// --doctor only reports: Docker, port conflicts, console health, each site
// from the host and from inside the network, registration and crawl state.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACTS, ConsoleClient, CONSOLE_URL, ENV_FILE, PROJECT, ROOT,
  capture, composeArgs, loadSites, log, modelEnvFromLocal, parseFlags, readEnvFile, readState, run, waitFor, writeEnvFile, writeState,
} from "./lib.mjs";

const flags = parseFlags();
const doctor = Boolean(flags.doctor);
const sites = loadSites({ configuredOnly: true });
const unconfigured = loadSites().filter((site) => !site.configured);
const PORTS = [3100, 8101, 8102, 8103, 18081];
const report = [];
const note = (subject, status, detail = "") => { report.push({ subject, status, detail }); log(`${status.padEnd(7)} ${subject}${detail ? ` — ${detail}` : ""}`); };

// 1. Docker and port conflicts with other compose projects.
const info = await capture("docker", ["info", "--format", "{{.MemTotal}} {{.NCPU}}"]).catch(() => "");
if (!info) { note("docker", "FAIL", "docker is not running"); finish(1); }
const [memTotal] = info.trim().split(" ").map(Number);
note("docker", "ok", `${Math.round(memTotal / 1024 / 1024 / 1024 * 10) / 10} GB for containers`);
const running = (await capture("docker", ["ps", "--format", "{{.Names}}\t{{.Label \"com.docker.compose.project\"}}\t{{.Ports}}"])).trim().split("\n").filter(Boolean);
const conflicts = running.flatMap((line) => {
  const [name, project, ports] = line.split("\t");
  if (project === PROJECT) return [];
  const taken = PORTS.filter((port) => new RegExp(`:${port}->`).test(ports || ""));
  return taken.length ? [`${name}${project ? ` (project ${project})` : ""} publishes ${taken.join(", ")}`] : [];
});
if (conflicts.length) {
  note("ports", "FAIL", conflicts.join("; "));
  log("Stop that project first (for example `docker compose -p <project> stop`); the benchmark does not stop other stacks.");
  if (!doctor) finish(1);
} else note("ports", "ok", PORTS.join(", "));

// 2. The env file: random secrets, the model from .env.local, the build sha.
mkdirSync(ARTIFACTS, { recursive: true });
const existingEnv = readEnvFile();
const buildSha = (await capture("git", ["rev-parse", "HEAD"]).catch(() => "unknown")).trim();
const secret = () => randomBytes(24).toString("hex");
const model = modelEnvFromLocal();
// BENCH_MODEL overrides the model name for every role; the key and base URL
// still come from .env.local. The gateway the demo uses sells some models and
// not others, so the benchmark has to be able to name the one that answers.
const benchModel = process.env.BENCH_MODEL || existingEnv.BENCH_MODEL || "";
if (benchModel) Object.assign(model, { MODEL: benchModel, MODEL_EXECUTION: benchModel, MODEL_SEMANTIC: benchModel, BENCH_MODEL: benchModel });
if (!Object.keys(model).length && !existingEnv.MODEL_API_KEY) note("model", "FAIL", "no MODEL_* in .env.local and none in the benchmark env");
else note("model", "ok", `${model.MODEL || existingEnv.MODEL || "(model from env)"} via ${model.MODEL_BASE_URL || existingEnv.MODEL_BASE_URL || "(base url from env)"}${benchModel ? " (BENCH_MODEL)" : ""}`);
if (!doctor) {
  writeEnvFile({
    COMPOSE_PROJECT_NAME: PROJECT,
    SITEWAKE_IMAGE_TAG: "benchmark",
    SITEWAKE_PORT: "3100",
    SITEWAKE_BIND_ADDRESS: "127.0.0.1",
    SITEWAKE_PUBLIC_ORIGIN: "http://control-plane:3000",
    SITEWAKE_RUNNER_ENROLLMENT_TOKEN: existingEnv.SITEWAKE_RUNNER_ENROLLMENT_TOKEN || secret(),
    CAPABILITY_V2_RUNNER_SECRET: existingEnv.CAPABILITY_V2_RUNNER_SECRET || secret(),
    CAPABILITY_V2_DISPATCH_TOKEN: existingEnv.CAPABILITY_V2_DISPATCH_TOKEN || secret(),
    CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN: existingEnv.CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN || secret(),
    POSTGRES_PASSWORD: existingEnv.POSTGRES_PASSWORD || secret(),
    MINIO_ROOT_PASSWORD: existingEnv.MINIO_ROOT_PASSWORD || secret(),
    SITEWAKE_IDEMPOTENCY_SECRET: existingEnv.SITEWAKE_IDEMPOTENCY_SECRET || secret(),
    SITEWAKE_ANALYTICS_SALT: existingEnv.SITEWAKE_ANALYTICS_SALT || secret(),
    BENCH_CONSOLE_PASSWORD: existingEnv.BENCH_CONSOLE_PASSWORD || secret(),
    SITEWAKE_BUILD_SHA: buildSha,
    ...Object.fromEntries(Object.entries(existingEnv).filter(([key]) => /^(MODEL|OPENAI)(_|$)/.test(key))),
    ...model,
  });
}
const env = readEnvFile();

// 3. Mirrors.
if (!doctor && !flags["no-mirror"]) await run(process.execPath, [join(ROOT, "scripts", "benchmark", "mirror.mjs")]);
else if (doctor) await run(process.execPath, [join(ROOT, "scripts", "benchmark", "mirror.mjs"), "--check"]).then(() => note("mirrors", "ok"), () => note("mirrors", "FAIL", "run `npm run benchmark:mirror`"));

// 4. Images and the stack. The three self-built images are built with the
// stack stopped: the control-plane build is killed on a 4 GB host otherwise.
if (!doctor) {
  const images = ["sitewake-control-plane", "sitewake-launcher", "sitewake-worker"].map((name) => `ghcr.io/sitewake/${name}:benchmark`);
  const missing = [];
  for (const image of images) await capture("docker", ["image", "inspect", image]).catch(() => missing.push(image));
  if (flags.build || missing.length) {
    log(missing.length ? `building images (${missing.length} missing) …` : "building images (--build) …");
    await run("docker", composeArgs("stop")).catch(() => undefined);
    await run("docker", composeArgs("build", "control-plane", "capability-v2-runtime-launcher", "authoring-worker"));
  }
  await run("docker", composeArgs("up", "-d", "--remove-orphans"));
}

// 5. Readiness from the host.
const console_ = new ConsoleClient(CONSOLE_URL, readState().consoleCookie || "");
await waitFor("console health", async () => (await fetch(`${CONSOLE_URL}/api/health`)).ok, { timeoutMs: doctor ? 10_000 : 300_000 })
  .then(() => note("console", "ok", CONSOLE_URL), (error) => { note("console", "FAIL", error.message); finish(1); });
const status = await console_.json("/api/system/status").catch(() => ({}));
note("build", status.build && status.build !== "development" ? "ok" : "warn", `console reports build ${status.build || "?"}; env says ${env.SITEWAKE_BUILD_SHA}`);
// A mirror answers any Host; an app such as PrestaShop answers only the
// network name it was installed with and redirects the published port there,
// so from the host an app only has to answer, and its content is checked
// from inside the network below.
for (const site of sites) {
  const marker = site.kind === "mirror" ? site.mirror.marker : "";
  const timeoutMs = (site.ready?.timeoutMinutes || 2) * 60_000;
  await waitFor(`${site.slug} from host`, async () => {
    const response = await fetch(site.hostUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    const body = await response.text();
    return response.status < 400 && (!marker || body.includes(marker));
  }, { timeoutMs: doctor ? 10_000 : timeoutMs, intervalMs: 5_000 })
    .then(() => note(`${site.slug} (host)`, "ok", site.hostUrl), (error) => note(`${site.slug} (host)`, "FAIL", error.message));
}

// 6. Reachability and content from inside the network, as the crawler and runners see it.
for (const site of sites) {
  const marker = site.kind === "mirror" ? site.mirror.marker : site.ready?.marker || "";
  const probe = "fetch(process.argv[1],{redirect:'follow'}).then(r=>r.text().then(t=>console.log(r.status+' '+t.length+' '+(process.argv[2]?t.includes(process.argv[2]):true)))).catch(e=>console.log('ERR '+e.message))";
  const out = await capture("docker", composeArgs("exec", "-T", "control-plane", "node", "-e", probe, site.internalUrl, marker)).catch((error) => `ERR ${error.message}`);
  note(`${site.slug} (network)`, /^200 \d+ true/.test(out.trim()) ? "ok" : "FAIL", `${site.internalUrl} → ${out.trim().slice(0, 80)}`);
}

// 7. Console password and session.
const access = await console_.json("/api/access").catch(() => ({}));
if (!access.configured) {
  const set = await console_.request("/api/access", { method: "PUT", body: { action: "setPassword", password: env.BENCH_CONSOLE_PASSWORD } });
  note("console password", set.ok ? "ok" : "FAIL", set.ok ? "set" : JSON.stringify(set.payload).slice(0, 120));
} else {
  const me = await console_.request("/api/site-agents");
  if (me.status === 401) {
    const login = await console_.request("/api/access", { method: "POST", body: { action: "login", password: env.BENCH_CONSOLE_PASSWORD } });
    note("console login", login.ok ? "ok" : "FAIL", login.ok ? "" : JSON.stringify(login.payload).slice(0, 120));
  } else note("console login", "ok", "session still valid");
}
writeState({ consoleCookie: console_.cookie, buildSha, consoleUrl: CONSOLE_URL });

// 8. Sites registered and crawled.
const crawlTimeoutMs = Number(flags["crawl-timeout"] || 20) * 60_000;
const siteState = {};
for (const site of sites) {
  const existing = await console_.request(`/api/site-agents/${encodeURIComponent(site.id)}`);
  if (existing.status === 404 && !doctor) {
    const created = await console_.request("/api/site-agents", { method: "POST", body: { id: site.id, name: site.name, url: site.internalUrl } });
    if (!created.ok) { note(`${site.slug} registered`, "FAIL", JSON.stringify(created.payload).slice(0, 160)); continue; }
    note(`${site.slug} registered`, "ok", site.id);
  } else note(`${site.slug} registered`, existing.ok ? "ok" : "FAIL", existing.ok ? site.id : `GET → ${existing.status}`);
  const jobsOf = async () => (await console_.json(`/api/site-agents/${encodeURIComponent(site.id)}/crawl`)).jobs || [];
  let jobs = await jobsOf();
  const done = jobs.find((job) => job.status === "succeeded");
  if (done) { note(`${site.slug} crawl`, "ok", `job ${done.id.slice(0, 8)} succeeded`); siteState[site.id] = { crawl: "succeeded" }; continue; }
  if (doctor || flags["no-crawl"]) { note(`${site.slug} crawl`, jobs.length ? "warn" : "none", jobs.map((job) => job.status).join(",")); continue; }
  // Only a job started now, or one still running, is waited for: an earlier
  // failed job stays in the list and must not be read as this run's answer.
  const earlier = new Set(jobs.filter((job) => !["queued", "leased", "running"].includes(job.status)).map((job) => job.id));
  if (!jobs.some((job) => ["queued", "leased", "running"].includes(job.status))) {
    const origin = new URL(site.internalUrl).origin;
    const started = await console_.request(`/api/site-agents/${encodeURIComponent(site.id)}/crawl`, { method: "POST", body: { origin, ...(site.crawl?.limits ? { limits: site.crawl.limits } : {}) } });
    if (!started.ok) { note(`${site.slug} crawl`, "FAIL", JSON.stringify(started.payload).slice(0, 160)); continue; }
  }
  await waitFor(`${site.slug} crawl`, async () => {
    jobs = await jobsOf();
    return jobs.find((job) => !earlier.has(job.id) && (job.status === "succeeded" || job.status === "failed"));
  }, { timeoutMs: crawlTimeoutMs, intervalMs: 10_000 })
    .then((job) => { note(`${site.slug} crawl`, job.status === "succeeded" ? "ok" : "FAIL", `job ${job.id.slice(0, 8)} ${job.status}${job.error ? `: ${String(job.error).slice(0, 100)}` : ""}`); siteState[site.id] = { crawl: job.status }; },
      (error) => note(`${site.slug} crawl`, "FAIL", error.message));
}
writeState({ sites: siteState });
for (const site of unconfigured) note(`${site.slug}`, "skip", site.note || "not configured");

finish(report.some((row) => row.status === "FAIL") ? 1 : 0);

function finish(code) {
  const failed = report.filter((row) => row.status === "FAIL");
  log(failed.length ? `${failed.length} check(s) failed` : doctor ? "all checks ok" : `benchmark stack ready at ${CONSOLE_URL} (env: ${ENV_FILE})`);
  process.exit(code);
}
