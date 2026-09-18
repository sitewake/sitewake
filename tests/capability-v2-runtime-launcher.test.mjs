import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  buildCapabilityV2RunnerEnvironment,
  capabilityV2BrowserPublicUrl,
} from "../scripts/capability-v2-runtime-config.mjs";

async function loadRuntimeLauncher() {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../runner/capability-v2/runtime-launcher.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [{
      name: "runtime-launcher-dependencies",
      setup(builder) {
        builder.onLoad({ filter: /[\\/]db[\\/]capability-center-v2-store\.ts$/ }, () => ({
          contents: `
            export async function appendTaskEvent() {}
            export async function claimTask() {}
            export async function failTaskDispatch() {}
            export async function getTask() {}
            export async function heartbeatRunner() {}
            export async function listPendingTaskSites() { return []; }
            export async function listRunners() { return { runners: [] }; }
            export async function listTasks() { return { tasks: [] }; }
            export async function markExpiredRunnersLost() {}
            export async function markRunnerLost() {}
            export async function registerRunner() { return { runner: {} }; }
            export async function releaseTaskClaim() {}
            export async function terminateRunner() {}
          `,
          loader: "ts",
        }));
        builder.onLoad({ filter: /[\\/]lib[\\/]capability-center-v2[\\/]runner-auth\.ts$/ }, () => ({
          contents: `export async function issueRunnerToken() { return "unused"; }`,
          loader: "ts",
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

test("remote runtime launch sends distinct control-plane and browser-public URLs", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalControlPlaneUrl = process.env.CAPABILITY_V2_CONTROL_PLANE_URL;
  const originalBrowserPublicUrl = process.env.CAPABILITY_V2_BROWSER_PUBLIC_URL;
  const originalPublicOrigin = process.env.SITEWAKE_PUBLIC_ORIGIN;
  const originalLocalDev = process.env.SITEWAKE_LOCAL_DEV;
  const originalNodeEnv = process.env.NODE_ENV;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalControlPlaneUrl === undefined) delete process.env.CAPABILITY_V2_CONTROL_PLANE_URL;
    else process.env.CAPABILITY_V2_CONTROL_PLANE_URL = originalControlPlaneUrl;
    if (originalBrowserPublicUrl === undefined) delete process.env.CAPABILITY_V2_BROWSER_PUBLIC_URL;
    else process.env.CAPABILITY_V2_BROWSER_PUBLIC_URL = originalBrowserPublicUrl;
    if (originalPublicOrigin === undefined) delete process.env.SITEWAKE_PUBLIC_ORIGIN;
    else process.env.SITEWAKE_PUBLIC_ORIGIN = originalPublicOrigin;
    if (originalLocalDev === undefined) delete process.env.SITEWAKE_LOCAL_DEV;
    else process.env.SITEWAKE_LOCAL_DEV = originalLocalDev;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  process.env.NODE_ENV = "production";
  delete process.env.SITEWAKE_LOCAL_DEV;
  process.env.CAPABILITY_V2_CONTROL_PLANE_URL = "http://control-plane.internal:3000";
  process.env.CAPABILITY_V2_BROWSER_PUBLIC_URL = "https://browser-public.example.test";
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const { RemoteProcessRuntimeAdapter } = await loadRuntimeLauncher();
  const adapter = new RemoteProcessRuntimeAdapter("http://runtime-launcher.internal:3320/", "launcher-token");
  await adapter.launch(
    { id: "task-1", siteId: "site-1" },
    { id: "runner-1" },
    "runner-token",
  );

  assert.equal(request.url, "http://runtime-launcher.internal:3320/launch");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.authorization, "Bearer launcher-token");
  const body = JSON.parse(request.init.body);
  assert.equal(body.controlPlaneUrl, "http://control-plane.internal:3000");
  assert.equal(body.browserPublicUrl, "https://browser-public.example.test");
  assert.notEqual(body.controlPlaneUrl, body.browserPublicUrl);

  delete process.env.CAPABILITY_V2_BROWSER_PUBLIC_URL;
  process.env.SITEWAKE_PUBLIC_ORIGIN = "https://public-origin.example.test";
  await adapter.launch(
    { id: "task-2", siteId: "site-1" },
    { id: "runner-2" },
    "runner-token-2",
  );
  const publicOriginBody = JSON.parse(request.init.body);
  assert.equal(publicOriginBody.controlPlaneUrl, "http://control-plane.internal:3000");
  assert.equal(publicOriginBody.browserPublicUrl, "https://public-origin.example.test");

  delete process.env.SITEWAKE_PUBLIC_ORIGIN;
  await adapter.launch(
    { id: "task-3", siteId: "site-1" },
    { id: "runner-3" },
    "runner-token-3",
  );
  const missingPublicOriginBody = JSON.parse(request.init.body);
  assert.equal(missingPublicOriginBody.controlPlaneUrl, "http://control-plane.internal:3000");
  assert.equal("browserPublicUrl" in missingPublicOriginBody, false);
});

test("broker runner environment keeps public URL absent in production and only falls back in explicit local development", () => {
  const input = {
    siteId: "site-1",
    taskId: "task-1",
    runnerId: "runner-1",
    runnerToken: "runner-token",
    controlPlaneUrl: "http://launch-control.internal:3000",
    browserPublicUrl: "https://launch-browser.example.test",
  };
  const environment = buildCapabilityV2RunnerEnvironment(input, {
    CAPABILITY_V2_CONTROL_PLANE_URL: "http://source-control.internal:3000",
    CAPABILITY_V2_BROWSER_PUBLIC_URL: "https://source-browser.example.test",
  });

  assert.equal(environment.CAPABILITY_V2_CONTROL_PLANE_URL, input.controlPlaneUrl);
  assert.equal(environment.CAPABILITY_V2_BROWSER_PUBLIC_URL, input.browserPublicUrl);

  const publicOriginEnvironment = buildCapabilityV2RunnerEnvironment({
    ...input,
    browserPublicUrl: undefined,
  }, {
    SITEWAKE_PUBLIC_ORIGIN: "https://public-origin.example.test",
  });
  assert.equal(publicOriginEnvironment.CAPABILITY_V2_CONTROL_PLANE_URL, input.controlPlaneUrl);
  assert.equal(publicOriginEnvironment.CAPABILITY_V2_BROWSER_PUBLIC_URL, "https://public-origin.example.test");

  const controlOnlyEnvironment = buildCapabilityV2RunnerEnvironment({
    ...input,
    browserPublicUrl: undefined,
  }, { NODE_ENV: "production" });
  assert.equal(controlOnlyEnvironment.CAPABILITY_V2_CONTROL_PLANE_URL, input.controlPlaneUrl);
  assert.equal("CAPABILITY_V2_BROWSER_PUBLIC_URL" in controlOnlyEnvironment, false);

  const localDevelopmentEnvironment = buildCapabilityV2RunnerEnvironment({
    ...input,
    browserPublicUrl: undefined,
  }, { NODE_ENV: "development", SITEWAKE_LOCAL_DEV: "1" });
  assert.equal(localDevelopmentEnvironment.CAPABILITY_V2_BROWSER_PUBLIC_URL, input.controlPlaneUrl);
});

test("broker runner environment preserves the Playwright browser path without widening the allowlist", () => {
  const environment = buildCapabilityV2RunnerEnvironment({
    siteId: "site-1",
    taskId: "task-1",
    runnerId: "runner-1",
    runnerToken: "runner-token",
  }, {
    PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
    UNRELATED_RUNNER_ENV: "must-not-cross",
  });

  assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright");
  assert.equal("UNRELATED_RUNNER_ENV" in environment, false);
});

test("direct process runner environment preserves the Playwright browser path", async (t) => {
  const originalBrowserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const originalUnrelatedValue = process.env.UNRELATED_RUNNER_ENV;
  t.after(() => {
    if (originalBrowserPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowserPath;
    if (originalUnrelatedValue === undefined) delete process.env.UNRELATED_RUNNER_ENV;
    else process.env.UNRELATED_RUNNER_ENV = originalUnrelatedValue;
  });

  process.env.PLAYWRIGHT_BROWSERS_PATH = "/ms-playwright";
  process.env.UNRELATED_RUNNER_ENV = "must-not-cross";
  const { runnerEnvironment } = await loadRuntimeLauncher();
  const environment = runnerEnvironment(
    { id: "task-1", siteId: "site-1", type: "Discovery" },
    { id: "runner-1" },
    "runner-token",
  );

  assert.equal(environment.PLAYWRIGHT_BROWSERS_PATH, "/ms-playwright");
  assert.equal("UNRELATED_RUNNER_ENV" in environment, false);
});

test("browser-public URL precedence is explicit URL, public origin, then explicit local-development endpoint", () => {
  const fallbackUrl = "http://localhost:3000";
  assert.equal(capabilityV2BrowserPublicUrl({
    CAPABILITY_V2_BROWSER_PUBLIC_URL: " https://modules.example.test ",
    SITEWAKE_PUBLIC_ORIGIN: "https://public-origin.example.test",
  }, fallbackUrl), "https://modules.example.test");
  assert.equal(capabilityV2BrowserPublicUrl({
    SITEWAKE_PUBLIC_ORIGIN: " https://public-origin.example.test ",
  }, fallbackUrl), "https://public-origin.example.test");
  assert.equal(capabilityV2BrowserPublicUrl({ NODE_ENV: "production" }, fallbackUrl), "");
  assert.equal(capabilityV2BrowserPublicUrl({
    NODE_ENV: "development",
    SITEWAKE_LOCAL_DEV: "1",
  }, fallbackUrl), fallbackUrl);
});

test("Validation runner environment strips all model credentials and marks task type", () => {
  const environment = buildCapabilityV2RunnerEnvironment({
    siteId: "site-1",
    taskId: "task-validation",
    runnerId: "runner-validation",
    runnerToken: "runner-token",
    taskType: "Validation",
  }, {
    MODEL_API_KEY: "secret-0",
    MODEL_BASE_URL: "https://canonical.example.test",
    MODEL: "canonical-model",
    OPENAI_API_KEY: "secret",
    OPENAI_BASE_URL: "https://model.example.test",
    OPENAI_MODEL: "real-model",
    MODEL_EXECUTION: "exec-model",
    MODEL_SEMANTIC: "semantic-model",
    NODE_ENV: "test",
  });
  assert.equal(environment.CAPABILITY_V2_TASK_TYPE, "Validation");
  for (const key of ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"]) {
    assert.equal(key in environment, false, `${key} must not cross the C3 process boundary`);
  }
});
