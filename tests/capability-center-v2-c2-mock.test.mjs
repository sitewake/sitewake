import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { capabilityCandidateHash, parseCapabilityCaseDiscoveryEvidenceSidecar } from "../lib/capability-center-v2/case-generation.ts";
import { runCapabilityCaseGeneration } from "../runner/capability-v2/case-generation.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = resolve(
  root,
  "tests/fixtures/capability-center-v2/notebook-search",
);
const siteDir = resolve(fixtureDir, "c1-site");

async function fixture(name) {
  return JSON.parse(await readFile(resolve(fixtureDir, name), "utf8"));
}

async function startFixtureSite({
  triggerPost = false,
  triggerUnsafeGet = false,
  crossOriginUrl,
  crossOriginWebSocketUrl,
  sameOriginSearchLink = false,
  dailyLinks = false,
} = {}) {
  const [homeSource, searchSource] = await Promise.all([
    readFile(resolve(siteDir, "home.html"), "utf8"),
    readFile(resolve(siteDir, "search.html"), "utf8"),
  ]);
  let home = triggerPost
    ? homeSource.replace(
        "</body>",
        '<script>fetch("/unsafe-write", { method: "POST", body: "blocked" }).catch(() => {});</script></body>',
      )
    : homeSource;
  if (crossOriginUrl)
    home = home.replace(
      "</body>",
      `<script>fetch(${JSON.stringify(crossOriginUrl)}, { mode: "no-cors" }).catch(() => {});</script></body>`,
    );
  if (crossOriginWebSocketUrl)
    home = home.replace(
      "</body>",
      `<script>new WebSocket(${JSON.stringify(crossOriginWebSocketUrl)});</script></body>`,
    );
  if (triggerUnsafeGet)
    home = home.replace(
      "</body>",
      '<script>fetch("/unsafe-get").catch(() => {});</script></body>',
    );
  if (sameOriginSearchLink)
    home = home.replace(
      "</body>",
      '<a href="/search?s=notebook">搜索商品结果</a></body>',
    );
  // An archive page per day, linking to the day before and after, the way a
  // site addresses one input value per page.
  const shiftDay = (date, days) => {
    const next = new Date(`${date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + days);
    return next.toISOString().slice(0, 10);
  };
  // A rich page: a header of section links, twenty topic entries each with
  // its own link, and only then the previous/next-day links. The values of
  // the day links must survive both the value cap and the region budget.
  const dailyPage = (date) => {
    const header = ["daily", "wordcloud", "celebrity", "city", "search"].map((path) => `<a href="/${path}">${path}</a>`).join(" ");
    const topics = Array.from({ length: 20 }, (_, index) =>
      `<article><h2>话题 ${index + 1}</h2><p>记录 ${index + 3} 次</p><a href="/search?topic=Wn${String(index).padStart(4, "0")}">详情</a></article>`).join("");
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${date} 热搜榜</title></head><body><header>${header}</header><main><h1>${date} 全天热搜聚合</h1><p>共记录 20 个独立话题</p><section>${topics}</section><nav><a href="/daily/${shiftDay(date, -1)}">前一天</a> <a href="/daily/${shiftDay(date, 1)}">后一天</a> <a href="/daily">归档</a></nav></main></body></html>`;
  };
  const received = [];
  const server = createServer((request, response) => {
    received.push({ method: request.method, url: request.url });
    const url = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(home);
      return;
    }
    const daily = dailyLinks && url.pathname.match(/^\/daily\/(\d{4}-\d{2}-\d{2})$/u);
    if (request.method === "GET" && daily) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(dailyPage(daily[1]));
      return;
    }
    if (request.method === "GET" && url.pathname === "/search") {
      const query =
        url.searchParams.get("s") || url.searchParams.get("query") || "";
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(searchSource.replaceAll("{{query}}", query));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    received,
    close: () =>
      new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      ),
  };
}

function installModelHttpMock(modelOutput) {
  const names = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_MODEL",
  ];
  const previousEnv = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  const originalFetch = globalThis.fetch;
  const requests = [];
  process.env.OPENAI_API_KEY = "c2-http-mock-key";
  process.env.OPENAI_BASE_URL = "https://c2-model.test/v1";
  process.env.OPENAI_MODEL = "c2-http-mock-model";
  for (const name of names.slice(3)) delete process.env[name];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://c2-model.test/v1/chat/completions");
    requests.push({
      url: String(url),
      headers: init.headers,
      body: JSON.parse(String(init.body)),
    });
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(modelOutput) },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
      for (const name of names) {
        const value = previousEnv[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

async function runOfficialC2({
  modelOutput,
  triggerPost = false,
  triggerUnsafeGet = false,
  crossOriginUrl,
  crossOriginWebSocketUrl,
  sameOriginSearchLink = false,
  dailyLinks = false,
  startPath = "/",
  prepareInput,
  requestModel,
  readOnlyPathPrefixes,
  sessionMode = "Anonymous",
}) {
  const [input, site] = await Promise.all([
    fixture("02-c2-input.json"),
    startFixtureSite({
      triggerPost,
      triggerUnsafeGet,
      crossOriginUrl,
      crossOriginWebSocketUrl,
      sameOriginSearchLink,
      dailyLinks,
    }),
  ]);
  input.browser.baseUrl = site.baseUrl;
  input.browser.startUrl = `${site.baseUrl}${startPath}`;
  input.browser.session.mode = sessionMode;
  if (readOnlyPathPrefixes)
    input.browser.readOnlyPathPrefixes = readOnlyPathPrefixes;
  prepareInput?.(input);
  const browser = await chromium.launch({ headless: true });
  const contexts = { created: 0, closed: 0 };
  const managedBrowser = {
    async newContext(options) {
      contexts.created += 1;
      const context = await browser.newContext(options);
      context.once("close", () => {
        contexts.closed += 1;
      });
      return context;
    },
  };
  const model = installModelHttpMock(modelOutput);
  let persistedBytes;
  let persistCalls = 0;
  try {
    const output = await runCapabilityCaseGeneration(input, {
      browser: managedBrowser,
      ...(requestModel ? { requestModel } : {}),
      ...(sessionMode === "AuthenticatedSnapshot" ? { storageState: {} } : {}),
      persistEvidence: async (bytes) => {
        persistCalls += 1;
        persistedBytes = Uint8Array.from(bytes);
        return { artifactRef: "artifact://tests/c2-real-page-evidence" };
      },
    });
    return {
      input,
      output,
      requests: model.requests,
      persistedBytes,
      persistCalls,
      contexts,
      site,
    };
  } catch (error) {
    error.c2TestState = {
      input,
      requests: model.requests,
      persistedBytes,
      persistCalls,
      contexts,
      site,
    };
    throw error;
  } finally {
    model.restore();
    await browser.close();
    await site.close();
  }
}

test("C2 mock executes the formal explorer, derivation, enrichment client, compiler, and persistence chain", async () => {
  const modelOutput = await fixture("02-c2-enrichment-fixture.json");
  const result = await runOfficialC2({ modelOutput });
  assert.equal(result.contexts.created, 1);
  assert.equal(result.contexts.closed, 1);
  // One model call, for enrichment, after the cases exist.
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].body.model, "c2-http-mock-model");
  assert.equal(result.requests[0].body.response_format.type, "json_schema");
  assert.equal(
    result.requests[0].body.response_format.json_schema.name,
    "capability_v2_case_enrichment",
  );
  assert.equal(
    result.requests[0].body.response_format.json_schema.strict,
    true,
  );
  assert.match(result.requests[0].body.messages[0].content, /只返回 cases/);
  const payload = JSON.parse(
    result.requests[0].body.messages.find((message) => message.role === "user")
      .content,
  );
  assert.equal(payload.caseDiscoveryEvidence.regions.length > 0, true);
  // The request carries the derived cases with their alternatives; the model
  // is asked to fill in, not to invent. The first case is the demonstration —
  // the one input this capability is known to work for — and what the page
  // showed follows it.
  assert.deepEqual(payload.cases.map((item) => item.input), [
    { query: "notebook" }, { query: "Notebook" }, { query: "Mug" },
  ]);
  assert.deepEqual(payload.cases[0].alternatives.query, [
    "Notebook", "Hardcover ruled notebook", "Hardcover", "ruled", "Mug", "Ceramic coffee mug", "Ceramic", "coffee",
  ]);
  assert.deepEqual(payload.expectedFields, ["query", "resultUrl", "heading"]);
  const schema = result.requests[0].body.response_format.json_schema.schema;
  assert.equal(schema.properties.cases.minItems, 3);
  assert.deepEqual(Object.keys(schema.properties.cases.items.properties.expected.properties), ["query", "resultUrl", "heading"]);

  assert.equal(result.output.generationTaskId, result.input.generationTaskId);
  assert.deepEqual(result.output.validationSuite.cases.map((item) => item.input), [
    { query: "notebook" }, { query: "Notebook" }, { query: "Mug" },
  ]);
  // The echo of the input, and the one enrichment the page supports.
  assert.deepEqual(result.output.validationSuite.cases[0].expected, { heading: "Notebook", query: "notebook" });
  assert.deepEqual(result.output.validationSuite.cases[1].expected, { query: "Notebook" });
  assert.equal(result.persistCalls, 1);
  const evidence = parseCapabilityCaseDiscoveryEvidenceSidecar(
    result.persistedBytes,
    result.output.caseDiscoveryEvidenceRef,
  ).value;
  assert.equal(evidence.cases.length, 3);
  assert.equal(evidence.candidateHash, capabilityCandidateHash(result.input.candidate));
});

test("C2 needs no model: with the model unreachable the derived cases are what gets frozen", async () => {
  const result = await runOfficialC2({
    modelOutput: {},
    requestModel: async () => {
      throw new Error("model_unreachable");
    },
  });
  assert.equal(result.requests.length, 0);
  assert.deepEqual(result.output.validationSuite.cases.map((item) => item.input), [
    { query: "notebook" }, { query: "Notebook" }, { query: "Mug" },
  ]);
  assert.deepEqual(result.output.validationSuite.cases[0].expected, { query: "notebook" });
  assert.equal(result.persistCalls, 1);
});

test("a page's own address and links are observed values, and a sibling page is visited for its own", async () => {
  const result = await runOfficialC2({
    modelOutput: {},
    requestModel: async () => ({ cases: [] }),
    dailyLinks: true,
    startPath: "/daily/2026-03-11",
    readOnlyPathPrefixes: ["/daily"],
    prepareInput: (input) => {
      input.candidate.contract.inputSchema = {
        type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD" } }, required: ["date"], additionalProperties: false,
      };
      input.candidate.contract.preconditions = [{ type: "inputExists", path: "date" }];
      input.candidate.contract.successConditions = [{ type: "textTemplate", template: "{{date}}" }, { type: "outputExists", path: "heading" }];
      input.candidate.program.parameterRoles = [{ inputPath: "date", role: "context" }];
      input.candidate.program.targetBindings = [];
      for (const stage of input.candidate.program.stages) stage.io.reads.input = ["date"];
      input.demonstrationParameters = { date: "2026-03-11" };
    },
  });
  const evidence = parseCapabilityCaseDiscoveryEvidenceSidecar(
    result.persistedBytes,
    result.output.caseDiscoveryEvidenceRef,
  ).value;
  const observed = new Set(evidence.regions.flatMap((region) => region.observedValues));
  // The dates the page links to are the dates the site serves.
  assert.ok(observed.has("2026-03-10") && observed.has("2026-03-12"), [...observed].join(", "));
  // The sibling page — same path shape, one segment different — was visited
  // although no capability term matches its link text, and although the first
  // page alone offered more regions than the whole budget.
  assert.ok(
    evidence.actions.some((action) => action.reason === "bounded_same_origin_get_exploration" && action.url.endsWith("/daily/2026-03-10")),
    JSON.stringify(evidence.actions),
  );
  assert.ok(evidence.regions.some((region) => region.url.endsWith("/daily/2026-03-10")), "the sibling page contributed regions");
  // Three distinct dates, each one the site addressed on a visited page —
  // which three depends on page order, not on a model.
  const dates = result.output.validationSuite.cases.map((item) => item.input.date);
  assert.equal(new Set(dates).size, 3);
  for (const date of dates) {
    assert.match(date, /^2026-03-\d{2}$/u);
    assert.ok(observed.has(date), `${date} was never observed`);
  }
});

test("C2 mock persists mug only when it is observed in the real fixture page sidecar", async () => {
  const modelOutput = await fixture("02-c2-enrichment-fixture.json");
  const result = await runOfficialC2({ modelOutput });
  const evidence = parseCapabilityCaseDiscoveryEvidenceSidecar(
    result.persistedBytes,
    result.output.caseDiscoveryEvidenceRef,
  ).value;
  // Case 0 is the demonstration; the page's own values follow it.
  const mugParameter = evidence.cases[2].parameters.find(
    (item) => item.inputPath === "query",
  );
  const region = evidence.regions.find(
    (item) => item.regionId === mugParameter.regionId,
  );
  assert.equal(String(mugParameter.observedValue).toLocaleLowerCase(), "mug");
  assert.equal(
    [...region.observedValues, ...(region.controlOptions || [])].includes(
      mugParameter.observedValue,
    ),
    true,
  );
});

test("C2 mock has no model-value-as-evidence path: a value the page never showed is ignored, and the run goes on", async () => {
  const modelOutput = {
    cases: [
      { input: { query: "model-only-value" }, expected: {} },
      { expected: { heading: "invented heading" } },
      { expected: {} },
    ],
  };
  const result = await runOfficialC2({ modelOutput });
  assert.deepEqual(result.output.validationSuite.cases.map((item) => item.input), [
    { query: "notebook" }, { query: "Notebook" }, { query: "Mug" },
  ]);
  assert.deepEqual(result.output.validationSuite.cases[1].expected, { query: "Notebook" });
  assert.equal(result.persistCalls, 1);
});

test("C2 mock blocks page-initiated non-GET requests before they reach the fixture server", async () => {
  const modelOutput = await fixture("02-c2-enrichment-fixture.json");
  const result = await runOfficialC2({ modelOutput, triggerPost: true });
  const evidence = parseCapabilityCaseDiscoveryEvidenceSidecar(
    result.persistedBytes,
    result.output.caseDiscoveryEvidenceRef,
  ).value;
  assert.equal(
    evidence.actions.some(
      (action) =>
        action.outcome === "blocked" && action.requestMethod === "POST",
    ),
    true,
  );
  assert.equal(
    result.site.received.some((request) => request.method === "POST"),
    false,
  );
});

test("C2 mock blocks cross-origin GET subresources before they reach another server", async () => {
  const received = [];
  const external = createServer((request, response) => {
    received.push(request.url);
    response.writeHead(204).end();
  });
  await new Promise((resolveListen, reject) => {
    external.once("error", reject);
    external.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = external.address();
    const modelOutput = await fixture("02-c2-enrichment-fixture.json");
    const result = await runOfficialC2({
      modelOutput,
      crossOriginUrl: `http://127.0.0.1:${address.port}/private-probe`,
    });
    const evidence = parseCapabilityCaseDiscoveryEvidenceSidecar(
      result.persistedBytes,
      result.output.caseDiscoveryEvidenceRef,
    ).value;
    assert.equal(
      evidence.actions.some(
        (action) =>
          action.outcome === "blocked" &&
          action.reason === "cross_origin_request_blocked",
      ),
      true,
    );
    assert.equal(received.length, 0);
  } finally {
    await new Promise((resolveClose, reject) =>
      external.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
});

test("C2 blocks page-initiated same-origin GETs outside the server-owned read-only path allowlist", async () => {
  const modelOutput = await fixture("02-c2-enrichment-fixture.json");
  const result = await runOfficialC2({ modelOutput, triggerUnsafeGet: true });
  assert.equal(
    result.site.received.some((request) => request.url === "/unsafe-get"),
    false,
  );
  const evidence = parseCapabilityCaseDiscoveryEvidenceSidecar(
    result.persistedBytes,
    result.output.caseDiscoveryEvidenceRef,
  ).value;
  assert.equal(
    evidence.actions.some(
      (action) => action.reason === "unapproved_get_request_blocked",
    ),
    true,
  );
});

test("C2 authenticated discovery honors an explicit read-only grant", async () => {
  const modelOutput = await fixture("02-c2-enrichment-fixture.json");
  const result = await runOfficialC2({
    modelOutput,
    triggerUnsafeGet: true,
    readOnlyPathPrefixes: ["/unsafe-get"],
    sessionMode: "AuthenticatedSnapshot",
  });
  assert.equal(
    result.site.received.some((request) => request.url === "/unsafe-get"),
    true,
  );
});

test("C2 blocks cross-origin WebSockets before the handshake reaches another server", async () => {
  let upgrades = 0;
  const external = createServer((_request, response) =>
    response.writeHead(404).end(),
  );
  external.on("upgrade", (_request, socket) => {
    upgrades += 1;
    socket.destroy();
  });
  await new Promise((resolveListen, reject) => {
    external.once("error", reject);
    external.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = external.address();
    const modelOutput = await fixture("02-c2-enrichment-fixture.json");
    await runOfficialC2({
      modelOutput,
      crossOriginWebSocketUrl: `ws://127.0.0.1:${address.port}/private-socket`,
    });
    assert.equal(upgrades, 0);
  } finally {
    await new Promise((resolveClose, reject) =>
      external.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
});

test("C2 does not follow same-origin links without a server-owned read-only path allowlist", async () => {
  const modelOutput = await fixture("02-c2-enrichment-fixture.json");
  const result = await runOfficialC2({
    modelOutput,
    sameOriginSearchLink: true,
  });
  assert.equal(
    result.site.received.some((request) => request.url?.startsWith("/search")),
    false,
  );
  const evidence = parseCapabilityCaseDiscoveryEvidenceSidecar(
    result.persistedBytes,
    result.output.caseDiscoveryEvidenceRef,
  ).value;
  assert.equal(
    evidence.actions.some(
      (action) => action.reason === "bounded_same_origin_get_exploration",
    ),
    false,
  );
});

test("C2 follows only capability-related GET links covered by the read-only path allowlist", async () => {
  const modelOutput = await fixture("02-c2-enrichment-fixture.json");
  const result = await runOfficialC2({
    modelOutput,
    sameOriginSearchLink: true,
    readOnlyPathPrefixes: ["/search"],
  });
  assert.equal(
    result.site.received.some((request) => request.url?.startsWith("/search")),
    true,
  );
  const evidence = parseCapabilityCaseDiscoveryEvidenceSidecar(
    result.persistedBytes,
    result.output.caseDiscoveryEvidenceRef,
  ).value;
  assert.equal(
    evidence.actions.some(
      (action) => action.reason === "bounded_same_origin_get_exploration",
    ),
    true,
  );
});
