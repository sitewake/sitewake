import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capabilityV2BrowserPublicUrl } from "./capability-v2-runtime-config.mjs";
import { preflight, repairPreflight, reportPreflight } from "./preflight.mjs";
import { resolveCliLocale } from "./cli-copy.mjs";
import { loadOptionalInternalModule } from "./optional-internal-module.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const port = String(process.env.PORT || "3000");
const localEndpoint = (process.env.SITEWAKE_LOCAL_URL || `http://localhost:${port}`).replace(/\/$/, "");
const capabilityBrowserPublicUrl = capabilityV2BrowserPublicUrl(
  { ...process.env, SITEWAKE_LOCAL_DEV: "1" },
  localEndpoint,
);
const listenHost = "0.0.0.0";
const sdkBuilder = resolve(root, "scripts", "build-sitewake-sdk.mjs");
const vinext = resolve(root, "node_modules", "vinext", "dist", "cli.js");
const tsx = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
const runner = resolve(root, "runner", "browser-runner.ts");
const capabilityRuntimeLauncher = resolve(root, "scripts", "capability-v2-runtime-launcher.mjs");
const demoSiteServer = resolve(root, "scripts", "internal", "serve-demo-sites.mjs");
const codex = resolve(root, "node_modules", "@openai", "codex", "bin", "codex.js");
const children = new Set();
let stopping = false;

/**
 * Five processes share one terminal. Without a source prefix on every line the
 * combined output is unreadable, and a failure cannot be attributed to a layer.
 */
function pipeWithPrefix(stream, prefix, target) {
  if (!stream) return;
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) target.write(`${prefix} ${line}\n`);
  });
  stream.on("end", () => {
    if (pending) target.write(`${prefix} ${pending}\n`);
    pending = "";
  });
}

function start(command, args, options = {}) {
  const label = options.label || "";
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    stdio: label ? ["ignore", "pipe", "pipe"] : "inherit",
    windowsHide: true,
  });
  if (label) {
    pipeWithPrefix(child.stdout, `[${label}]`, process.stdout);
    pipeWithPrefix(child.stderr, `[${label}]`, process.stderr);
  }
  child.playgroundLabel = label;
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function waitForExit(child) {
  return new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ child, code, signal })));
}

async function run(command, args, label) {
  const result = await waitForExit(start(command, args));
  if (result.code !== 0) throw new Error(`${label}_failed:${result.code ?? result.signal ?? "unknown"}`);
}

async function waitForHealth(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${localEndpoint}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`local_control_plane_not_ready:${lastError}`);
}

async function waitForCapabilityRuntimeLauncher(endpoint, token, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/health`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`capability_runtime_launcher_not_ready:${lastError}`);
}

async function assertPortAvailable(port) {
  await new Promise((resolveAvailable, rejectAvailable) => {
    const probe = createServer();
    const fail = (error) => {
      probe.close(() => rejectAvailable(new Error(`local_control_plane_port_unavailable:${port}:${error?.code || "unknown"}`)));
    };
    probe.once("error", fail);
    probe.listen({ host: listenHost, port: Number(port) }, () => {
      probe.close((error) => error ? rejectAvailable(error) : resolveAvailable());
    });
  });
}

async function waitForRunnerReady(endpoint, runnerId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/api/runner-management/overview`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const projection = await response.json();
        const instance = Array.isArray(projection?.instances)
          ? projection.instances.find((candidate) => candidate?.id === runnerId)
          : undefined;
        const state = String(instance?.observedState || instance?.status || "").toLowerCase();
        const heartbeatAt = Date.parse(String(instance?.lastHeartbeatAt || instance?.heartbeatAt || ""));
        const heartbeatFresh = Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt < 30_000;
        const healthyState = state && !["offline", "lost", "stale", "terminated"].includes(state);
        if (instance && healthyState && heartbeatFresh && projection?.summary?.serviceAvailable !== false) return;
        lastError = instance ? `runner_not_ready:${state || "unknown"}` : "runner_not_registered";
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`local_runner_not_ready:${runnerId}:${lastError}`);
}

async function stopChildren(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
  await Promise.all([...children].map((child) => waitForExit(child)));
}

function lanUrls() {
  return Object.values(networkInterfaces())
    .flatMap((addresses) => addresses || [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => `http://${address.address}:${port}`);
}

function readyTable(sites) {
  const rows = [
    ["控制台", localEndpoint, "← 主界面：Agent 学到什么、形成了哪些能力"],
    ...sites.map((site) => [site.name, site.origin, `demo 站点（调试靶子）· id: ${site.id}`]),
  ];
  const width = Math.max(...rows.map(([name]) => [...name].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
  const pad = (text) => {
    const visual = [...text].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
    return text + " ".repeat(Math.max(0, width - visual));
  };
  const lines = [
    "",
    "  本地环境已就绪",
    "",
    ...rows.map(([name, url, note]) => `  ${pad(name)}   ${url.padEnd(24)} ${note}`),
    "",
    ...(sites.length
      ? [
          `  先打开控制台 ${localEndpoint} —— 三个 demo 站都应该已经在站点列表里`,
          `  再打开 ${sites[0].origin} ，点右下角助手说「帮我买一个护眼台灯」，然后回控制台看它记下了什么`,
        ]
      : [`  打开控制台 ${localEndpoint} ，按引导接入你自己的网站`]),
    "",
  ];
  for (const url of lanUrls()) lines.push(`  局域网访问控制台：${url}`);
  return lines.join("\n");
}

async function main() {
  const locale = resolveCliLocale();
  // Whatever this machine is missing and `npm run dev` can install itself is
  // installed here; only what still needs a person is reported.
  const issues = await repairPreflight(await preflight(), { locale, log: console.error });
  if (!reportPreflight(issues, console.error, locale)) {
    process.exitCode = 1;
    return;
  }
  // preflight probes 127.0.0.1; the control plane binds listenHost. A port taken
  // only on another interface passes the first check and fails the real bind.
  await assertPortAvailable(port);
  await access(codex).catch(() => {
    throw new Error("local_codex_cli_missing: run `npm install` before `npm run dev`");
  });
  // Demo sites ship only with the maintainers' checkout; a public checkout has
  // neither the module nor the sites, and runs without them.
  const demoSitesModule = await loadOptionalInternalModule("./internal/demo-sites.mjs", import.meta.url);
  const demoSites = demoSitesModule ? await demoSitesModule.loadDemoSites() : [];
  await run(node, [sdkBuilder], "sdk_build");
  const runnerEnrollmentToken = randomBytes(32).toString("hex");
  const configuredCapabilityLauncherUrl = process.env.CAPABILITY_V2_RUNTIME_LAUNCHER_URL?.trim();
  const capabilityLauncherPort = String(process.env.CAPABILITY_V2_RUNTIME_LAUNCHER_PORT || "3320");
  const capabilityLauncherUrl = configuredCapabilityLauncherUrl || `http://127.0.0.1:${capabilityLauncherPort}`;
  const capabilityLauncherToken = process.env.CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN?.trim() || randomBytes(32).toString("hex");
  const capabilityDispatchToken = process.env.CAPABILITY_V2_DISPATCH_TOKEN?.trim() || randomBytes(32).toString("hex");
  // Same topology as the container stack: only the control plane holds the
  // provider key; the runner and the launcher (and every process it spawns)
  // call the model through the control plane's internal proxy. The empty
  // values shadow anything the shell or .env.local would otherwise hand them.
  const modelProxyEnv = {
    SITEWAKE_MODEL_PROXY_URL: `${localEndpoint}/api/internal/model`,
    CAPABILITY_V2_DISPATCH_TOKEN: capabilityDispatchToken,
    MODEL_API_KEY: "", MODEL_BASE_URL: "", MODEL: "", MODEL_EXECUTION: "", MODEL_SEMANTIC: "",
    OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "",
  };
  const localCapabilityLauncher = configuredCapabilityLauncherUrl
    ? null
    : start(node, [capabilityRuntimeLauncher], {
      label: "launcher",
      env: {
        ...modelProxyEnv,
        CAPABILITY_V2_RUNTIME_LAUNCHER_PORT: capabilityLauncherPort,
        CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN: capabilityLauncherToken,
        CAPABILITY_V2_CONTROL_PLANE_URL: localEndpoint,
        CAPABILITY_V2_BROWSER_PUBLIC_URL: capabilityBrowserPublicUrl,
      },
    });
  const capabilityLauncherExit = localCapabilityLauncher ? waitForExit(localCapabilityLauncher) : null;
  if (capabilityLauncherExit) {
    await Promise.race([
      waitForCapabilityRuntimeLauncher(capabilityLauncherUrl, capabilityLauncherToken),
      capabilityLauncherExit.then(({ code, signal }) => { throw new Error(`capability_runtime_launcher_exited:${code ?? signal ?? "unknown"}`); }),
    ]);
  }

  const server = start(
    node,
    [
      "--env-file-if-exists=.env.local",
      vinext,
      "dev",
      "--hostname",
      listenHost,
      "--port",
      port,
      "--strictPort",
    ],
    {
      label: "cp",
      env: {
        PORT: port,
        WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
        SITEWAKE_RUNNER_ENROLLMENT_TOKEN: runnerEnrollmentToken,
        SITEWAKE_LOCAL_DEV: "1",
        CAPABILITY_V2_RUNTIME_LAUNCHER_URL: capabilityLauncherUrl,
        CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN: capabilityLauncherToken,
        CAPABILITY_V2_DISPATCH_TOKEN: capabilityDispatchToken,
        CAPABILITY_V2_CONTROL_PLANE_URL: localEndpoint,
        CAPABILITY_V2_BROWSER_PUBLIC_URL: capabilityBrowserPublicUrl,
        CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN: "1",
      },
    },
  );
  const serverExit = waitForExit(server);
  await Promise.race([
    waitForHealth(),
    serverExit.then(({ code, signal }) => { throw new Error(`local_control_plane_exited:${code ?? signal ?? "unknown"}`); }),
  ]);

  const localRunnerId = `local-dev-${port}`;
  const localRunner = start(node, ["--env-file-if-exists=.env.local", tsx, runner], {
    label: "runner",
    env: {
      ...modelProxyEnv,
      SITEWAKE_CONTROL_PLANE_URL: localEndpoint,
      SITEWAKE_BROWSER_PUBLIC_URL: localEndpoint,
      SITEWAKE_RUNNER_ID: localRunnerId,
      SITEWAKE_RUNNER_NAME: "Local Development Runner",
      SITEWAKE_RUNNER_ROLE: "any",
      SITEWAKE_RUNNER_PREWARM: "0",
      SITEWAKE_RUNNER_CONCURRENCY: "1",
      SITEWAKE_RUNNER_ENROLLMENT_TOKEN: runnerEnrollmentToken,
      SITEWAKE_CODEX_BIN: codex,
      // Explicitly scoped to this localhost control plane so demo sites can be
      // crawled without weakening the production runner's SSRF boundary.
      SITEWAKE_CRAWL_ALLOW_PRIVATE_NETWORK: "1",
    },
  });
  const runnerExit = waitForExit(localRunner);
  await Promise.race([
    waitForRunnerReady(localEndpoint, localRunnerId),
    runnerExit.then(({ code, signal }) => {
      throw new Error(`local_runner_exited_before_ready:${code ?? signal ?? "unknown"}`);
    }),
  ]);

  let demoServer = null;
  let demoServerExit = null;
  if (demoSitesModule) {
    demoServer = start(node, [demoSiteServer], {
      label: "demos",
      env: { SITEWAKE_LOCAL_URL: localEndpoint },
    });
    demoServerExit = waitForExit(demoServer);

    // Registering the demo sites is what lets their cross-origin SDK connection
    // pass the site-exists and allowed-origin checks. Do it before announcing
    // readiness, so the first page a developer opens already works.
    const { seedDemoSites } = await import("./internal/seed-demo-sites.mjs");
    await seedDemoSites({ endpoint: localEndpoint, log: (message) => console.log(message) });
  }

  console.log(readyTable(demoSites));

  const ended = await Promise.race([
    serverExit,
    runnerExit,
    ...(demoServerExit ? [demoServerExit] : []),
    ...(capabilityLauncherExit ? [capabilityLauncherExit] : []),
  ]);
  if (!stopping) {
    const component = ended.child === server
      ? "控制台 Control Plane"
      : ended.child === localRunner
        ? "Runner"
        : ended.child === demoServer
          ? "demo 站点服务器"
          : "Capability Runtime Launcher";
    console.error(`\n[dev-local] ${component} 意外退出，正在停止其余组件。`);
    await stopChildren();
    process.exitCode = ended.code ?? 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void stopChildren(signal).finally(() => {
      process.exitCode = signal === "SIGINT" ? 130 : 143;
    });
  });
}

main().catch(async (error) => {
  console.error(`[dev-local] ${error instanceof Error ? error.message : String(error)}`);
  await stopChildren();
  process.exitCode = 1;
});
