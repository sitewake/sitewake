import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

async function load(entry) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false, external: ["playwright"] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { assertCapabilityOutput, runPlaywrightCapabilityStages } = await load("../runner/playwright-stage-runner.ts");

function launchTestBrowser() {
  const configuredChannel = process.env.SITEWAKE_BROWSER_CHANNEL?.trim();
  const channel = configuredChannel || (process.platform === "win32" ? "chrome" : undefined);
  return chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
}

async function fixtureServer() {
  const server = createServer((request, response) => {
    if (request.url === "/module.js") {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      response.end(`export const capability={version:1,stages:[
        {id:"navigate",run(){document.querySelector("#go").click()}},
        {id:"extract",run({input}){return {output:{title:document.querySelector("h1").textContent,query:input.query}}}}
      ]}`);
      return;
    }
    if (request.url === "/popup-module.js") {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      response.end(`export const capability={version:1,stages:[
        {id:"open",run(){document.querySelector("#go").click()}},
        {id:"extract",run(){return {output:{title:document.querySelector("h1").textContent}}}}
      ]}`);
      return;
    }
    if (request.url === "/delayed-module.js") {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      response.end(`export const capability={version:1,stages:[
        {id:"schedule",run(){setTimeout(()=>location.assign("/next"),800);return {state:{scheduled:true}}}},
        {id:"extract",run({state}){return {output:{title:document.querySelector("h1").textContent,scheduled:state.scheduled}}}}
      ]}`);
      return;
    }
    if (request.url === "/invalid-output-module.js") {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      response.end(`export const capability={version:1,stages:[
        {id:"extract",run(){return {output:{error:"target missing"}}}}
      ]}`);
      return;
    }
    if (request.url === "/next") {
      response.writeHead(200, { "content-type": "text/html" }); response.end(`<h1>Destination</h1>`); return;
    }
    if (request.url === "/popup") {
      response.writeHead(200, { "content-type": "text/html" }); response.end(`<h1>Popup destination</h1>`); return;
    }
    const popup = request.url === "/popup-start";
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<h1>Start</h1><a id="go" href="${popup ? "/popup" : "/next"}"${popup ? ` target="_blank"` : ""}>go</a>`);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

test("Stage Runner continues after same-tab navigation", async () => {
  const { server, origin } = await fixtureServer();
  let browser;
  try {
    browser = await launchTestBrowser();
    const page = await browser.newPage();
    await page.goto(`${origin}/start`);
    const result = await runPlaywrightCapabilityStages({ page, moduleUrl: `${origin}/module.js`, input: { query: "x" } });
    assert.deepEqual(result.output, { title: "Destination", query: "x" });
    assert.deepEqual(result.receipts.map((item) => item.transition), ["navigation", "none"]);
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
});

test("Stage Runner switches to a newly opened page", async () => {
  const { server, origin } = await fixtureServer();
  let browser;
  try {
    browser = await launchTestBrowser();
    const page = await browser.newPage();
    await page.goto(`${origin}/popup-start`);
    const result = await runPlaywrightCapabilityStages({ page, moduleUrl: `${origin}/popup-module.js`, input: {} });
    assert.deepEqual(result.output, { title: "Popup destination" });
    assert.deepEqual(result.receipts.map((item) => item.transition), ["new-page", "none"]);
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
});

test("Stage Runner waits for a navigation scheduled at the end of a Stage", async () => {
  const { server, origin } = await fixtureServer();
  let browser;
  try {
    browser = await launchTestBrowser();
    const page = await browser.newPage();
    await page.goto(`${origin}/start`);
    const result = await runPlaywrightCapabilityStages({ page, moduleUrl: `${origin}/delayed-module.js`, input: {} });
    assert.deepEqual(result.output, { title: "Destination", scheduled: true });
    assert.deepEqual(result.receipts.map((item) => item.transition), ["navigation", "none"]);
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
});

test("Stage Runner rejects a nominal output that omits required contract fields", () => {
  assert.throws(
    () => assertCapabilityOutput({
      type: "object",
      properties: {
        productName: { type: "string" },
        price: { type: "string" },
      },
      required: ["productName", "price"],
    }, { error: "未找到搜索输入框" }),
    /capability_output_required:output\.productName,output\.price/,
  );
});

test("Stage Runner validates nested output types while allowing extra evidence fields", () => {
  assert.doesNotThrow(() => assertCapabilityOutput({
    type: "object",
    properties: {
      products: {
        type: "array",
        items: {
          type: "object",
          properties: {
            productName: { type: "string", minLength: 1 },
            price: { type: "string", minLength: 1 },
          },
          required: ["productName", "price"],
        },
      },
    },
    required: ["products"],
  }, {
    products: [{ productName: "Arc 弧光台灯", price: "¥699", source: "page" }],
    pageUrl: "http://localhost/demo/search?q=Arc",
  }));
});

test("Stage Runner preserves receipts when a module returns a schema-invalid output", async () => {
  const { server, origin } = await fixtureServer();
  let browser;
  try {
    browser = await launchTestBrowser();
    const page = await browser.newPage();
    await page.goto(`${origin}/start`);
    await assert.rejects(
      () => runPlaywrightCapabilityStages({
        page,
        moduleUrl: `${origin}/invalid-output-module.js`,
        input: {},
        outputSchema: {
          type: "object",
          properties: { productName: { type: "string" }, price: { type: "string" } },
          required: ["productName", "price"],
        },
      }),
      (error) => {
        assert.equal(error.name, "PlaywrightStageRunError");
        assert.match(error.message, /capability_output_required/);
        assert.deepEqual(error.receipts.map((receipt) => receipt.stageId), ["extract"]);
        return true;
      },
    );
  } finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
});
