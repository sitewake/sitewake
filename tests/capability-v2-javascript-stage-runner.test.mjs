import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

async function load(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    external: ["playwright"],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const stageRunner = await load("../runner/capability-v2/javascript-stage-runner.ts");
const moduleDelivery = await load("../runner/capability-v2/module-delivery.ts");

test("logical stage receipt projection ignores lifecycle Started and treats Continue as success", () => {
  assert.deepEqual(
    stageRunner.projectStageReceipts([
      { stageId: "stage_1", stageIndex: 0, status: "Started", urlBefore: "https://target.test/start" },
      { stageId: "stage_1", stageIndex: 0, status: "Completed", urlBefore: "https://target.test/start", outcome: "Continue" },
      { stageId: "stage_verify", stageIndex: 1, status: "Started", urlBefore: "https://target.test/start" },
      { stageId: "stage_verify", stageIndex: 1, status: "Completed", urlBefore: "https://target.test/start", outcome: "Success" },
    ],
      ["evidence://validation/task/case/1"],
    ),
    [
      { stageId: "stage_1", outcome: "Success", evidenceRefs: ["evidence://validation/task/case/1"] },
      { stageId: "stage_verify", outcome: "Success", evidenceRefs: ["evidence://validation/task/case/1"] },
    ],
  );
});

test("visible menu option reconciliation preserves site punctuation and maps directional shorthand", async () => {
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><button id="trigger">Sort</button><div role="menu"><a role="menuitem">Name, A to Z</a><a role="menuitem">Name, Z to A</a></div>`);
    const resolved = await stageRunner.reconcileVisibleCapabilityOptions({ sortOrder: "A到Z" }, page);
    assert.equal(resolved.sortOrder, "Name, A to Z");
  } finally {
    await browser.close();
  }
});

function launchTestBrowser() {
  const configuredChannel = process.env.SITEWAKE_BROWSER_CHANNEL?.trim();
  const channel = configuredChannel || (process.platform === "win32" ? "chrome" : undefined);
  return chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
}

const program = {
  schemaVersion: "2.0",
  runtime: "BrowserJavaScriptStage",
  module: { contentHash: "a".repeat(64), moduleUrl: "/api/capability-v2/modules/test", exportName: "capability" },
  entry: { mode: "Navigate", url: "https://target.test/start" },
  stages: [{ id: "stage_verify", title: "Verify", purpose: "Verify", effect: "read", resumePolicy: "skip-completed", io: { reads: { input: ["query"], state: [] }, writes: { state: [], output: ["query"] } }, navigation: "none" }],
  parameterRoles: [],
  targetBindings: [],
  promptProvenance: [],
};

const validModule = `export const capability={version:2,stages:[{id:"stage_verify",io:{reads:{input:["query"],state:[]},writes:{state:[],output:["query"]}},navigation:"none",run({input}){return {outcome:"Success",output:{query:input.query??null},evidence:[]}}}]}`;

async function routedPage(browser, moduleResponse = {}) {
  const context = await browser.newContext();
  const requests = [];
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (url === "https://target.test/start") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: { "content-security-policy": moduleResponse.csp || "default-src 'self'; script-src 'self' https://public.test" },
        body: "<!doctype html><title>Target</title><h1>Target</h1>",
      });
      return;
    }
    if (url === "https://public.test/module.js") {
      await route.fulfill({
        status: moduleResponse.status || 200,
        headers: {
          "content-type": moduleResponse.contentType || "text/javascript; charset=utf-8",
          ...(moduleResponse.cors === false
            ? {}
            : { "access-control-allow-origin": typeof moduleResponse.cors === "string" ? moduleResponse.cors : "*" }),
        },
        body: moduleResponse.body ?? validModule,
      });
      return;
    }
    await route.abort("failed");
  });
  const page = await context.newPage();
  await page.goto("https://target.test/start");
  return { context, page, requests };
}

test("HTTPS page imports a CORS-enabled capability module from the browser-public HTTPS origin", async () => {
  const browser = await launchTestBrowser();
  const fixture = await routedPage(browser);
  try {
    const result = await stageRunner.runCapabilityJavaScriptStages({
      page: fixture.page,
      moduleUrl: "https://public.test/module.js",
      program,
      input: { query: "cushion" },
    });
    assert.equal(result.outcome, "Success");
    assert.deepEqual(result.output, { query: "cushion" });
    assert.deepEqual(result.receipts.map((receipt) => receipt.status), ["Started", "Completed"]);
    assert.ok(fixture.requests.includes("https://public.test/module.js"));
    assert.equal(fixture.requests.some((url) => url.startsWith("http://control-plane:3000")), false);
  } finally {
    await fixture.context.close();
    await browser.close();
  }
});

for (const scenario of [
  { name: "CSP blocks the public module", response: { csp: "default-src 'self'; script-src 'self'" } },
  { name: "module endpoint returns a non-success response", response: { status: 503, body: "unavailable" } },
  { name: "module endpoint returns a non-JavaScript MIME type", response: { contentType: "text/plain" } },
  { name: "module endpoint rejects the target origin through CORS", response: { cors: "https://wrong-origin.test" } },
]) {
  test(`${scenario.name} is a terminal module-load failure before a stage is dispatched`, async () => {
    const browser = await launchTestBrowser();
    const fixture = await routedPage(browser, scenario.response);
    try {
      await assert.rejects(
        () => stageRunner.runCapabilityJavaScriptStages({ page: fixture.page, moduleUrl: "https://public.test/module.js", program, input: {} }),
        (error) => {
          assert.equal(error.code, "module_load_failed");
          assert.equal(error.authorRepairable, false);
          assert.equal(error.taskRetryable, true);
          assert.deepEqual(error.receipts, []);
          assert.match(String(error.cause?.message || error.message), /failed to fetch dynamically imported module|module script/i);
          return true;
        },
      );
    } finally {
      await fixture.context.close();
      await browser.close();
    }
  });
}

test("HTTPS page rejects an internal HTTP module URL before Chromium requests it", async () => {
  const browser = await launchTestBrowser();
  const fixture = await routedPage(browser);
  try {
    await assert.rejects(
      () => stageRunner.runCapabilityJavaScriptStages({ page: fixture.page, moduleUrl: "http://control-plane:3000/api/capability-v2/modules/test", program, input: {} }),
      (error) => error.code === "browser_module_url_invalid" && error.authorRepairable === false,
    );
    assert.equal(fixture.requests.some((url) => url.startsWith("http://control-plane:3000")), false);
  } finally {
    await fixture.context.close();
    await browser.close();
  }
});

test("ordinary stage code containing a Chromium network error string remains author-repairable", async () => {
  const browser = await launchTestBrowser();
  const fixture = await routedPage(browser, {
    body: `export const capability={version:2,stages:[{id:"stage_verify",io:{reads:{input:["query"],state:[]},writes:{state:[],output:["query"]}},navigation:"none",run(){throw new Error("net::ERR_FAILED from authored stage")}}]}`,
  });
  try {
    await assert.rejects(
      () => stageRunner.runCapabilityJavaScriptStages({
        page: fixture.page,
        moduleUrl: "https://public.test/module.js",
        program,
        input: {},
      }),
      (error) => {
        assert.equal(error.name, "JavaScriptStageRunError");
        assert.equal(error.code, undefined);
        assert.equal(error.authorRepairable, undefined);
        assert.match(error.message, /net::ERR_FAILED from authored stage/);
        assert.deepEqual(error.receipts.map((receipt) => receipt.status), ["Started"]);
        return true;
      },
    );
  } finally {
    await fixture.context.close();
    await browser.close();
  }
});

test("authored module syntax errors remain author-repairable instead of becoming delivery failures", async () => {
  const browser = await launchTestBrowser();
  const fixture = await routedPage(browser, { body: "export const capability={" });
  try {
    await assert.rejects(
      () => stageRunner.runCapabilityJavaScriptStages({
        page: fixture.page,
        moduleUrl: "https://public.test/module.js",
        program,
        input: {},
      }),
      (error) => {
        assert.equal(error.code, undefined);
        assert.equal(error.authorRepairable, undefined);
        assert.match(error.message, /SyntaxError|Unexpected token|Unexpected end/i);
        return true;
      },
    );
  } finally {
    await fixture.context.close();
    await browser.close();
  }
});

test("runtime endpoints preserve separate internal API and browser module origins", () => {
  const endpoints = moduleDelivery.capabilityV2RuntimeEndpoints({
    CAPABILITY_V2_CONTROL_PLANE_URL: "http://control-plane:3000/",
    CAPABILITY_V2_BROWSER_PUBLIC_URL: "https://agent.example.org",
  });
  assert.deepEqual(endpoints, {
    controlPlaneUrl: "http://control-plane:3000",
    browserPublicUrl: "https://agent.example.org",
  });
  const moduleUrl = moduleDelivery.resolveCapabilityModuleUrl(
    `/api/capability-v2/modules/${"a".repeat(64)}?siteId=acme-production`,
    endpoints.browserPublicUrl,
  );
  assert.equal(moduleUrl, `https://agent.example.org/api/capability-v2/modules/${"a".repeat(64)}?siteId=acme-production`);
  assert.throws(
    () => moduleDelivery.resolveCapabilityModuleUrl(
      `/api/capability-v2/modules/${"a".repeat(64)}`,
      endpoints.browserPublicUrl,
      "b".repeat(64),
    ),
    (error) => error.code === "browser_module_url_invalid" && /content_hash_mismatch/.test(error.message),
  );
});

test("production keeps a missing browser-public origin unconfigured and rejects it before module resolution", () => {
  const endpoints = moduleDelivery.capabilityV2RuntimeEndpoints({
    NODE_ENV: "production",
    CAPABILITY_V2_CONTROL_PLANE_URL: "https://control-plane.internal:3000",
  });
  assert.equal(endpoints.controlPlaneUrl, "https://control-plane.internal:3000");
  assert.equal(endpoints.browserPublicUrl, undefined);
  assert.throws(
    () => moduleDelivery.resolveCapabilityModuleUrl(`/api/capability-v2/modules/${"a".repeat(64)}`, endpoints.browserPublicUrl),
    (error) => error.code === "browser_module_url_invalid" && /public_url_required/.test(error.message),
  );
});

test("browser-public configuration must be an origin, not a path-prefixed URL", () => {
  assert.throws(
    () => moduleDelivery.resolveCapabilityModuleUrl(
      `/api/capability-v2/modules/${"a".repeat(64)}`,
      "https://agent.example.org/modules-base/",
    ),
    (error) => error.code === "browser_module_url_invalid" && /public_url_must_be_http_origin/.test(error.message),
  );
});

/**
 * Root of a production failure: the stage clicked the real search button, the site
 * navigated to the results page on its own, and the document was unloaded while the
 * stage was still in waitUntil. This used to be judged direct_navigation_forbidden —
 * branding the correct approach as a violation and steering the model toward
 * constructing URLs. A context lost during a real transition is an ordinary transition: continue.
 */
test("a click that navigates the document mid-stage is a transition, not a direct-navigation violation", async () => {
  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  try {
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      const csp = "default-src 'self'; script-src 'self' https://public.test 'unsafe-inline'";
      if (url === "https://target.test/start") {
        return route.fulfill({ status: 200, contentType: "text/html", headers: { "content-security-policy": csp }, body: `<!doctype html><title>Start</title><h1>Start</h1><button id="go" onclick="location.href='/search?q=x'">搜索</button>` });
      }
      if (url === "https://target.test/search?q=x") {
        return route.fulfill({ status: 200, contentType: "text/html", headers: { "content-security-policy": csp }, body: `<!doctype html><title>Results</title><h1>Results</h1><main>找到 3 条</main>` });
      }
      if (url === "https://public.test/module.js") {
        return route.fulfill({ status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*" }, body: `export const capability={version:2,stages:[
          {id:"stage_search",io:{reads:{input:[],state:[]},writes:{state:[],output:[]}},navigation:"optional",async run({waitUntil}){document.getElementById("go").click();await waitUntil(()=>location.href.includes("q="));return {outcome:"Continue"}}},
          {id:"stage_verify",io:{reads:{input:[],state:[]},writes:{state:[],output:["title"]}},navigation:"none",run(){return {outcome:"Success",output:{title:document.title},evidence:[]}}}]}` });
      }
      await route.abort("failed");
    });
    const page = await context.newPage();
    await page.goto("https://target.test/start");
    const result = await stageRunner.runCapabilityJavaScriptStages({
      page,
      moduleUrl: "https://public.test/module.js",
      program: {
        ...program,
        stages: [
          { id: "stage_search", title: "Search", purpose: "Submit", effect: "write", resumePolicy: "reconcile-before-retry", io: { reads: { input: [], state: [] }, writes: { state: [], output: [] } }, navigation: "optional" },
          { id: "stage_verify", title: "Verify", purpose: "Verify", effect: "read", resumePolicy: "skip-completed", io: { reads: { input: [], state: [] }, writes: { state: [], output: ["title"] } }, navigation: "none" },
        ],
      },
      input: {},
    });
    assert.equal(result.outcome, "Success");
    assert.deepEqual(result.output, { title: "Results" });
    assert.equal(page.url(), "https://target.test/search?q=x");
  } finally {
    await context.close();
    await browser.close();
  }
});

/**
 * One production run wrote `input.value = keyword` plus an input event in all four
 * drafts. A React controlled input's value tracker sees no change, onChange never
 * fires, the next render writes the empty string back — empty search box, a click
 * that does not navigate, a timeout. A controlled input that hijacks `value` the
 * way React does proves fill() gets through while direct assignment does not.
 */
test("fill() writes through a React-style controlled input; direct .value assignment does not", async () => {
  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  try {
    const controlledInputPage = `<!doctype html><title>Start</title><form id="f"><input id="q" placeholder="搜索"><button id="go" type="submit">搜索</button></form><script>
      // Mimic a React controlled input: the tracker remembers the last value it set,
      // an input event whose value equals it is ignored, and an unchanged state
      // resets the DOM value on the next tick.
      const node = document.getElementById("q");
      const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      let tracked = ""; let state = "";
      Object.defineProperty(node, "value", { configurable: true, get() { return native.get.call(node); }, set(v) { tracked = String(v); native.set.call(node, v); } });
      node.addEventListener("input", () => { const current = native.get.call(node); if (current === tracked) return; state = current; tracked = current; });
      setInterval(() => { if (native.get.call(node) !== state) { tracked = state; native.set.call(node, state); } }, 20);
      document.getElementById("f").addEventListener("submit", (event) => { event.preventDefault(); if (state) location.href = "/search?q=" + encodeURIComponent(state); });
    </script>`;
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === "https://target.test/start") return route.fulfill({ status: 200, contentType: "text/html", body: controlledInputPage });
      if (url.startsWith("https://target.test/search?q=")) return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Results</title><main>找到 3 条</main>` });
      if (url === "https://public.test/module.js") {
        return route.fulfill({ status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*" }, body: `export const capability={version:2,stages:[
          {id:"stage_fill",io:{reads:{input:["keyword"],state:[]},writes:{state:[],output:[]}},navigation:"optional",async run({input,waitFor,fill}){const box=await waitFor("#q");fill(box,input.keyword);await new Promise(r=>setTimeout(r,60));if(box.value!==input.keyword)throw new Error("value_reverted");return {outcome:"Continue"}}},
          {id:"stage_submit",io:{reads:{input:[],state:[]},writes:{state:[],output:[]}},navigation:"required",async run({waitUntil}){document.getElementById("go").click();await waitUntil(()=>location.href.includes("q="));return {outcome:"Continue"}}},
          {id:"stage_verify",io:{reads:{input:[],state:[]},writes:{state:[],output:["title"]}},navigation:"none",run(){return {outcome:"Success",output:{title:document.title},evidence:[]}}}]}` });
      }
      await route.abort("failed");
    });
    const page = await context.newPage();
    await page.goto("https://target.test/start");
    // Control: direct assignment plus an event is reverted by the framework.
    await page.evaluate(() => { const box = document.getElementById("q"); box.value = "周杰伦"; box.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => document.getElementById("q").value), "", "直接赋值被受控输入还原");
    const stages = [
      { id: "stage_fill", title: "Fill", purpose: "Fill", effect: "write", resumePolicy: "reconcile-before-retry", io: { reads: { input: ["keyword"], state: [] }, writes: { state: [], output: [] } }, navigation: "optional" },
      { id: "stage_submit", title: "Submit", purpose: "Submit", effect: "write", resumePolicy: "reconcile-before-retry", io: { reads: { input: [], state: [] }, writes: { state: [], output: [] } }, navigation: "required" },
      { id: "stage_verify", title: "Verify", purpose: "Verify", effect: "read", resumePolicy: "skip-completed", io: { reads: { input: [], state: [] }, writes: { state: [], output: ["title"] } }, navigation: "none" },
    ];
    const result = await stageRunner.runCapabilityJavaScriptStages({ page, moduleUrl: "https://public.test/module.js", program: { ...program, stages }, input: { keyword: "周杰伦" } });
    assert.equal(result.outcome, "Success", JSON.stringify(result));
    assert.equal(page.url(), "https://target.test/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6");
  } finally {
    await context.close();
    await browser.close();
  }
});

/**
 * A production self-test ran the first stage right after goto, before Next.js had
 * hydrated. The form was plain HTML, submit was a native GET, the name-less search
 * box carried nothing, and the page landed on `/?`. A real visitor triggers a
 * capability on a page that is long alive; the first stage must wait for the page to settle.
 */
test("the first stage waits for the page to settle, so a submit handler attached by a late script is in place", async () => {
  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  try {
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === "https://target.test/start") {
        return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Start</title><form id="f" action="/" method="get"><input id="q" placeholder="搜索"><button id="go" type="submit">搜索</button></form><script async src="/hydrate.js"></script>` });
      }
      if (url === "https://target.test/hydrate.js") {
        // Mimic hydration: the script arrives 900ms late and only then takes over submit.
        await new Promise((resolve) => setTimeout(resolve, 900));
        return route.fulfill({ status: 200, contentType: "text/javascript", body: `document.getElementById("f").addEventListener("submit", (event) => { event.preventDefault(); location.href = "/search?q=" + encodeURIComponent(document.getElementById("q").value); });` });
      }
      if (url.startsWith("https://target.test/search?q=")) return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Results</title><main>找到 3 条</main>` });
      if (url.startsWith("https://target.test/?")) return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Native submit</title>` });
      if (url === "https://public.test/module.js") {
        return route.fulfill({ status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*" }, body: `export const capability={version:2,stages:[
          {id:"stage_search",io:{reads:{input:["keyword"],state:[]},writes:{state:[],output:[]}},navigation:"required",async run({input,waitFor,waitUntil,fill}){fill(await waitFor("#q"),input.keyword);document.getElementById("go").click();await waitUntil(()=>location.href.includes("q="));return {outcome:"Continue"}}},
          {id:"stage_verify",io:{reads:{input:[],state:[]},writes:{state:[],output:["title"]}},navigation:"none",run(){return {outcome:"Success",output:{title:document.title},evidence:[]}}}]}` });
      }
      await route.abort("failed");
    });
    const stages = [
      { id: "stage_search", title: "Search", purpose: "Submit", effect: "write", resumePolicy: "reconcile-before-retry", io: { reads: { input: ["keyword"], state: [] }, writes: { state: [], output: [] } }, navigation: "required" },
      { id: "stage_verify", title: "Verify", purpose: "Verify", effect: "read", resumePolicy: "skip-completed", io: { reads: { input: [], state: [] }, writes: { state: [], output: ["title"] } }, navigation: "none" },
    ];
    const page = await context.newPage();
    await page.goto("https://target.test/start", { waitUntil: "domcontentloaded" });
    const result = await stageRunner.runCapabilityJavaScriptStages({ page, moduleUrl: "https://public.test/module.js", program: { ...program, stages }, input: { keyword: "周杰伦" } });
    assert.equal(result.outcome, "Success", JSON.stringify(result.receipts));
    assert.equal(page.url(), "https://target.test/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6");
    // Counter-example: without the wait the stage runs before the takeover — a native GET submit that carries nothing.
    const raw = await context.newPage();
    await raw.goto("https://target.test/start", { waitUntil: "domcontentloaded" });
    await stageRunner.runCapabilityJavaScriptStages({ page: raw, moduleUrl: "https://public.test/module.js", program: { ...program, stages }, input: { keyword: "周杰伦" }, settleBeforeFirstStageMs: 0 }).catch(() => undefined);
    assert.match(raw.url(), /^https:\/\/target\.test\/\?/, "没等水合就提交，落在原生 GET 的页面上");
  } finally {
    await context.close();
    await browser.close();
  }
});

test("a stage that times out names the wait that never settled", async () => {
  // Production: waitFor on a selector built from an accessible name waited the full
  // three minutes and reported only capability_control_flow_timeout; the model could
  // not tell the selector matched nothing.
  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  try {
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === "https://target.test/start") return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Start</title><input placeholder="搜索">` });
      if (url === "https://public.test/module.js") {
        return route.fulfill({ status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*" }, body: `export const capability={version:2,controlFlow:{totalTimeoutMs:2500,maxTransitions:8},stages:[
          {id:"stage_1",io:{reads:{input:[],state:[]},writes:{state:[],output:[]}},navigation:"optional",async run({waitFor}){await waitFor('input[name="搜索历史热搜"]');return {outcome:"Continue"}}}]}` });
      }
      await route.abort("failed");
    });
    const page = await context.newPage();
    await page.goto("https://target.test/start");
    await assert.rejects(
      () => stageRunner.runCapabilityJavaScriptStages({ page, moduleUrl: "https://public.test/module.js", program: { ...program, controlFlow: { totalTimeoutMs: 2_500, maxTransitions: 8 }, stages: [{ id: "stage_1", title: "Fill", purpose: "Fill", effect: "write", resumePolicy: "reconcile-before-retry", io: { reads: { input: [], state: [] }, writes: { state: [], output: [] } }, navigation: "optional" }] }, input: {}, settleBeforeFirstStageMs: 0 }),
      (error) => {
        assert.match(error.message, /^capability_control_flow_timeout:stage_1:pending=waitFor\("input\[name=\\"搜索历史热搜\\"\]"\)/u);
        return true;
      },
    );
  } finally {
    await context.close();
    await browser.close();
  }
});

/**
 * The first draft is generated from the exploration that already succeeded: the
 * explorer's role/name targets resolve in-page through find(), values go through
 * fill(), a click waits for the page to react. Only stage_verify is left to the
 * model. Against a React-style controlled search box the seeded action stages
 * must carry the page to the results URL on their own.
 */
test("a draft seeded from the exploration replays fill and click through the kernel and stops at the verify stub", async () => {
  const author = await import("../runner/capability-v2/javascript-author.ts");
  const trace = {
    schemaVersion: "1.0", entry: { mode: "Navigate", url: "https://target.test/start" }, defaults: { timeoutMs: 15000, retryCount: 1 },
    steps: [
      { id: "step_1", action: "fill", target: { strategies: [{ type: "role", role: "combobox", name: "搜索历史热搜", match: "exact" }, { type: "css", value: "#base-ui-\\:R9b9cja\\:" }] }, value: { source: "input", path: "keyword" } },
      { id: "step_3", action: "click", target: { strategies: [{ type: "role", role: "button", name: "搜索", match: "exact" }, { type: "text", value: "搜索", match: "exact" }] } },
    ],
    result: {},
  };
  const contract = {
    inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
    outputSchema: { type: "object", properties: { resultCount: { type: "integer" } }, required: ["resultCount"] },
    preconditions: [], successConditions: [{ type: "urlIncludes", value: "?q=" }],
  };
  const manifest = author.authoringManifest(trace, contract);
  const seed = author.seedCapabilitySource(manifest, trace, contract);
  assert.match(seed, /waitForTarget\(\{strategies:\[\{type:"role",role:"combobox",name:"搜索历史热搜",match:"exact"\}/);
  assert.match(seed, /fill\(element, input\["keyword"\]\)/);
  assert.match(seed, /stage_verify_not_authored/);
  const { validateCapabilityJavaScriptSource } = await import("../lib/capability-center-v2/javascript-runtime.ts");
  assert.deepEqual(validateCapabilityJavaScriptSource(seed, ["keyword"], ["keyword"]), { ok: true });

  const browser = await launchTestBrowser();
  const context = await browser.newContext();
  try {
    const page = `<!doctype html><title>Start</title><header><form id="f"><input id="base-ui-:R9b9cja:" role="combobox" aria-label="搜索历史热搜" placeholder="搜索历史热搜"><button type="submit">搜索</button></form></header><script>
      const node = document.querySelector("input"); const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      let tracked = ""; let state = "";
      Object.defineProperty(node, "value", { configurable: true, get() { return native.get.call(node); }, set(v) { tracked = String(v); native.set.call(node, v); } });
      node.addEventListener("input", () => { const current = native.get.call(node); if (current === tracked) return; state = current; tracked = current; });
      setInterval(() => { if (native.get.call(node) !== state) { tracked = state; native.set.call(node, state); } }, 20);
      document.getElementById("f").addEventListener("submit", (event) => { event.preventDefault(); if (state) location.href = "/search?q=" + encodeURIComponent(state); });
    </script>`;
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      // Chinese accessible names only survive with an explicit charset.
      if (url === "https://target.test/start") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: page });
      if (url.startsWith("https://target.test/search?q=")) return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: `<!doctype html><title>Results</title><main>找到 3 条包含“周杰伦”的历史热搜</main>` });
      if (url === "https://public.test/module.js") return route.fulfill({ status: 200, headers: { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*" }, body: seed });
      await route.abort("failed");
    });
    const tab = await context.newPage();
    await tab.goto("https://target.test/start");
    await assert.rejects(
      () => stageRunner.runCapabilityJavaScriptStages({ page: tab, moduleUrl: "https://public.test/module.js", program: { ...program, stages: manifest.stages }, input: { keyword: "周杰伦" }, allowModuleGraphAdoption: true, deadlineCapMs: 15_000 }),
      (error) => {
        assert.match(error.message, /stage_verify_not_authored/);
        const completed = error.receipts.filter((receipt) => receipt.status === "Completed").map((receipt) => [receipt.stageId, receipt.outcome]);
        assert.deepEqual(completed, [["stage_resolve_target", "Continue"], ["stage_select_target", "Continue"], ["stage_1", "Continue"], ["stage_2", "Continue"]], JSON.stringify(error.receipts));
        return true;
      },
    );
    assert.equal(tab.url(), "https://target.test/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6");
  } finally {
    await context.close();
    await browser.close();
  }
});

test("the last stage's answer is not turned into Continue", async () => {
  // Production: the final stage answered NoResult, a recovery meant for an
  // unfinished search rewrote it to Continue, there was no stage after it, and
  // the run failed with capability_output_missing. The model had written a
  // correct program; it hit the identical failure twice and authoring gave up.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../runner/capability-v2/javascript-stage-runner.ts", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("const hasNextStage ="), source.indexOf("// A final verification stage is read-only"));
  assert.match(block, /const hasNextStage = stageIndex < program\.stages\.length - 1;/, "要知道后面还有没有阶段");
  for (const recovery of ["recoverUnavailableDetailTarget", "recoverSearchResultTarget"]) {
    const at = block.indexOf(recovery);
    assert.ok(at > 0, `${recovery} 应当在这段里`);
    const guard = block.slice(0, at);
    assert.ok(guard.lastIndexOf("hasNextStage") > guard.lastIndexOf("if ("), `${recovery} 必须由 hasNextStage 守着`);
  }
});
