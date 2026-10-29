import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
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

const discovery = await load("../runner/capability-v2/case-discovery.ts");
const fixtureDir = resolve(fileURLToPath(new URL("../", import.meta.url)), "tests/fixtures/capability-center-v2/notebook-search");

// A catalogue's home page: the category list in the sidebar, product cards in
// the main column. The demonstration chose "Poetry" from the sidebar.
const CATALOGUE = `<!doctype html><title>All products | Books</title>
<ul class="breadcrumb"><li><a href="/">Home</a></li><li><a href="/catalogue/category/books_1/index.html">Books</a></li><li class="active">Poetry</li></ul>
<aside><ul class="nav"><li><a href="/catalogue/category/books_1/index.html">Books</a>
  <ul><li><a href="/c/travel_2">Travel</a></li><li><a href="/c/mystery_3">Mystery</a></li><li><a href="/c/historical-fiction_4">Historical Fiction</a></li><li><a href="/c/poetry_23">Poetry</a></li></ul>
</li></ul></aside>
<main><h1>All products</h1><ol class="row">
  <li><article><a href="/p/1"><img alt="A Light in the Attic"></a><h3><a href="/p/1" title="A Light in the Attic">A Light in the ...</a></h3><p class="price">£51.77</p><p>In stock</p><button>Add to basket</button></article></li>
  <li><article><a href="/p/2"><img alt="Tipping the Velvet"></a><h3><a href="/p/2" title="Tipping the Velvet">Tipping the Velvet</a></h3><p class="price">£53.74</p><p>In stock</p><button>Add to basket</button></article></li>
</ol></main>`;

function serve(html) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url === "/" ? html : "<!doctype html><title>Elsewhere</title><p>elsewhere</p>");
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

function launchTestBrowser() {
  const configuredChannel = process.env.SITEWAKE_BROWSER_CHANNEL?.trim();
  const channel = configuredChannel || (process.platform === "win32" ? "chrome" : undefined);
  return chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
}

test("the harvest keeps the list a demonstrated value was chosen from, as a region of its own, ahead of the cards", async () => {
  // Without it, the cases for the category input were "In stock" and a book's
  // title off the first card, and a working program was rejected for them.
  const { server, origin } = await serve(CATALOGUE);
  const browser = await launchTestBrowser();
  try {
    const input = JSON.parse(await readFile(resolve(fixtureDir, "02-c2-input.json"), "utf8"));
    input.browser = { ...input.browser, baseUrl: origin, startUrl: `${origin}/` };
    input.demonstrationParameters = { query: "Poetry" };
    const snapshot = await discovery.discoverCapabilityCaseEvidence(input, { browser });
    const lists = snapshot.regions.filter((region) => region.kind === "choice-list");
    assert.equal(lists.length, 1, "one list holds the demonstrated value");
    assert.equal(snapshot.regions[0].kind, "choice-list", "the list comes first, ahead of the region budget");
    assert.deepEqual(lists[0].observedValues, ["Travel", "Mystery", "Historical Fiction", "Poetry"], "its items are the inner list's own, by the name each is found by");
    assert.ok(!lists[0].observedValues.includes("Books"), "the outer list's entry is not one of the choices");
    assert.ok(!lists[0].observedValues.includes("Home"), "the breadcrumb that also names the category is where the visitor is, not a choice");
    assert.ok(snapshot.regions.some((region) => region.kind !== "choice-list" && region.observedValues.includes("In stock")), "the cards are still harvested, after it");
  } finally {
    await browser.close();
    server.close();
  }
});

test("the start page is harvested once, before authoring: the lists as regions and each input's siblings", async () => {
  const { server, origin } = await serve(CATALOGUE);
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/`);
    const { snapshot, siblings } = await discovery.harvestStartPage(page, { generationTaskId: "generation_1", siteId: "site_1", parameters: { category: "Poetry", query: "Brass" } });
    assert.equal(snapshot.generationTaskId, "generation_1");
    assert.equal(snapshot.regions[0].kind, "choice-list");
    assert.deepEqual(siblings, { category: ["Travel", "Mystery", "Historical Fiction"] }, "the other items of the list Poetry sits in; a value no list offers has no siblings");
    assert.ok(snapshot.regions.some((region) => region.kind !== "choice-list"), "the cards are harvested too, for the cases of inputs no list offers");
  } finally {
    await browser.close();
    server.close();
  }
});

test("a demonstrated value that sits in no list on the page adds no region", async () => {
  const { server, origin } = await serve(CATALOGUE);
  const browser = await launchTestBrowser();
  try {
    const input = JSON.parse(await readFile(resolve(fixtureDir, "02-c2-input.json"), "utf8"));
    input.browser = { ...input.browser, baseUrl: origin, startUrl: `${origin}/` };
    input.demonstrationParameters = { query: "notebook" };
    const snapshot = await discovery.discoverCapabilityCaseEvidence(input, { browser });
    assert.equal(snapshot.regions.filter((region) => region.kind === "choice-list").length, 0);
    assert.ok(snapshot.regions.length > 0, "the ordinary harvest still ran");
  } finally {
    await browser.close();
    server.close();
  }
});

test("a list the page draws in capitals is harvested by the names the page holds", async () => {
  // PrestaShop's top menu is upper-cased by CSS; the cases came out as
  // "CLOTHES" and "ACCESSORIES", and a program that finds a link by its name
  // could not find either.
  const page = CATALOGUE.replace("<aside>", '<style>.nav a { text-transform: uppercase }</style><aside>');
  const { server, origin } = await serve(page);
  const browser = await launchTestBrowser();
  try {
    const tab = await browser.newPage();
    await tab.goto(`${origin}/`);
    const { siblings } = await discovery.harvestStartPage(tab, { generationTaskId: "generation_1", siteId: "site_1", parameters: { category: "Poetry" } });
    assert.deepEqual(siblings, { category: ["Travel", "Mystery", "Historical Fiction"] });
  } finally {
    await browser.close();
    server.close();
  }
});

test("icon-font glyphs inside a list's links are no part of the names harvested", async () => {
  // PrestaShop draws its menu arrows as private-use characters in the link
  // text; the cases asked for "  Clothes".
  const page = CATALOGUE.replace('<a href="/c/travel_2">Travel</a>', '<a href="/c/travel_2"><i></i> <i></i> Travel</a>');
  const { server, origin } = await serve(page);
  const browser = await launchTestBrowser();
  try {
    const tab = await browser.newPage();
    await tab.goto(`${origin}/`);
    const { siblings } = await discovery.harvestStartPage(tab, { generationTaskId: "generation_1", siteId: "site_1", parameters: { category: "Poetry" } });
    assert.deepEqual(siblings, { category: ["Travel", "Mystery", "Historical Fiction"] });
  } finally {
    await browser.close();
    server.close();
  }
});
