import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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

const { traceFromExperience } = await load("../runner/capability-v2/recording-trace.ts");

// Recordings the benchmark's visitors left on 2026-10-28: a category click,
// a detour into a detail page and back, a search typed and abandoned for the
// category menu, and a tag page paged back and forth.
function recording(name) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/capability-center-v2/recordings/${name}.json`, import.meta.url)), "utf8"));
}

const describe = (step) => `${step.action}${step.key ? ` ${step.key}` : ""}:${step.target ? JSON.stringify(step.target.strategies[0]) : JSON.stringify(step.value)}`;
const names = (step) => step.target.strategies.map((strategy) => JSON.stringify(strategy.name ?? strategy.value));

test("a click on the category named by the input is the whole trace", () => {
  const { goal, parameters, experience } = recording("books-count-poetry");
  const { program, dropped } = traceFromExperience(experience, parameters);
  assert.equal(goal, "How many books are in the Poetry category?");
  assert.deepEqual(program.entry, { mode: "Navigate", url: "http://books.bench:8101/" });
  assert.equal(program.steps.length, 1);
  assert.equal(program.steps[0].action, "click");
  assert.ok(names(program.steps[0]).includes(JSON.stringify({ source: "input", path: "category" })), "the link named by the demonstration value is found by the input");
  assert.deepEqual(dropped, []);
});

test("a detail page opened and left again is a detour, not a step", () => {
  // The visitor opened the cheapest book to read it and came back; the
  // recording ends on the category page, not on the book.
  const { parameters, experience } = recording("books-cheapest-travel");
  const { program, dropped } = traceFromExperience(experience, parameters);
  assert.deepEqual(program.steps.map((step) => step.action), ["click"]);
  assert.ok(names(program.steps[0]).includes(JSON.stringify({ source: "input", path: "category" })));
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].name, /^The Road to Little Dribbling/);
  assert.equal(dropped[0].reason, "detour");
});

test("a search typed and never submitted, and the click that only focused its box, are not steps", () => {
  // The visitor typed the product into the search box twice, clicked the box,
  // then went through the Accessories menu instead; the cart received the
  // cushion from the product page.
  const { parameters, experience } = recording("ps-add-cushion");
  const { program, dropped } = traceFromExperience(experience, parameters);
  assert.deepEqual(program.steps.map((step) => step.action), ["click", "click", "click"]);
  assert.ok(names(program.steps[0]).some((name) => /Accessories/.test(name)), "the menu entry is a literal: it is not an input");
  assert.ok(names(program.steps[1]).includes(JSON.stringify({ source: "input", path: "productName" })), "the product card is found by the input");
  assert.ok(names(program.steps[2]).some((name) => /Add to cart/.test(name)));
  assert.deepEqual(dropped.map((item) => item.reason), ["unsubmitted-fill", "unsubmitted-fill", "focus"]);
});

test("paging back and forth collapses to the shortest way to the page the visitor ended on", () => {
  // Seventeen Next/Previous clicks between page 1 and page 2 of the tag.
  const { parameters, experience } = recording("quotes-tag-count");
  const { program, dropped } = traceFromExperience(experience, parameters);
  assert.deepEqual(program.steps.map(describe).map((text) => text.replace(/:\{.*$/u, "")), ["click", "click"]);
  assert.ok(names(program.steps[0]).includes(JSON.stringify({ source: "input", path: "tag" })), "the tag link is found by the input");
  assert.ok(names(program.steps[1]).some((name) => /Next/.test(name)), "one page turn remains");
  assert.ok(dropped.length >= 15 && dropped.every((item) => ["repeat", "loop"].includes(item.reason)), `the rest were loops: ${JSON.stringify(dropped.map((item) => item.reason))}`);
  assert.equal(experience.endPage.url, "http://quotes.bench:8102/tag/humor/page/2/index.html");
});

test("an image link in the recording is found by the name the recording gave it, its image's alt", () => {
  // A product card's image link has no text; the widget recorded its
  // accessible name from the image, and that is what finds it again.
  const { parameters, experience } = recording("ps-add-cushion");
  const card = experience.actions[4];
  const image = { ...card, element: { tag: "a", role: "link", accessibleName: "Brown bear cushion", href: card.element.href } };
  const { program } = traceFromExperience({ ...experience, actions: [experience.actions[3], image] }, parameters);
  assert.deepEqual(program.steps.map((step) => step.action), ["click", "click"]);
  assert.ok(names(program.steps[1]).includes(JSON.stringify({ source: "input", path: "productName" })), "the alt names the product, so the step is found by the input");
});

test("a typed value equal to an input is written as that input, and Enter becomes a press", () => {
  const { parameters, experience } = recording("ps-add-cushion");
  const search = { ...experience, actions: [experience.actions[1]], endPage: { url: "http://prestashop.bench/search?controller=search&s=Brown+bear+cushion" } };
  const { program } = traceFromExperience(search, parameters);
  assert.deepEqual(program.steps.map((step) => step.action), ["fill", "press"]);
  assert.deepEqual(program.steps[0].value, { source: "input", path: "productName" });
  assert.equal(program.steps[1].key, "Enter");
});

test("a quantity typed as text is the numeric input it equals", () => {
  // The recording holds the text "2"; the parameter is the number 2. Left a
  // literal, the seed added two mugs whatever quantity was asked for.
  const { parameters, experience } = recording("ps-add-mug-quantity");
  const { program } = traceFromExperience(experience, parameters);
  const fill = program.steps.find((step) => step.action === "fill");
  assert.deepEqual(fill.value, { source: "input", path: "quantity" });
  assert.ok(names(program.steps[0]).includes(JSON.stringify({ source: "input", path: "productName" })));
});

test("a run that began on the page an input chooses opens it from the home page by the link the input names", () => {
  // Read-only: the visitor opened /9-art and read it. No action, so there was
  // no trace at all, and the generation stopped before authoring.
  const read = recording("ps-category-count-read-only");
  assert.equal(read.experience.actions.length, 0);
  const readTrace = traceFromExperience(read.experience, read.parameters).program;
  assert.deepEqual(readTrace.entry, { mode: "Navigate", url: "http://prestashop.bench/" });
  assert.deepEqual(readTrace.steps.map((step) => step.action), ["click"]);
  assert.ok(names(readTrace.steps[0]).includes(JSON.stringify({ source: "input", path: "category" })));
  // Began on /6-accessories and sorted it: the sort is kept, after the input's page is opened.
  const sorted = recording("ps-cheapest-accessory");
  const sortedTrace = traceFromExperience(sorted.experience, sorted.parameters).program;
  assert.equal(sortedTrace.entry.url, "http://prestashop.bench/");
  assert.ok(names(sortedTrace.steps[0]).includes(JSON.stringify({ source: "input", path: "category" })));
  assert.ok(sortedTrace.steps.slice(1).some((step) => names(step).some((name) => /Price, low to high/.test(name))));
  // A run whose steps already use the input keeps the page it began on.
  const poetry = recording("books-count-poetry");
  assert.equal(traceFromExperience(poetry.experience, poetry.parameters).program.entry.url, "http://books.bench:8101/");
});

test("a link named alike in every entry is the one in the entry its address names, and a return by the back button is not a step", () => {
  // Every quote has an "(about)" link; the visitor's leads to
  // /author/Albert-Einstein.html. They opened it, came back with the browser's
  // back button (not recorded), and opened it again.
  const { parameters, experience } = recording("quotes-by-author");
  const { program } = traceFromExperience(experience, parameters);
  assert.equal(program.steps.length, 1);
  assert.deepEqual(program.steps[0].target.strategies[0], { type: "role", role: "link", name: "(about)", match: "exact", containsText: { source: "input", path: "authorName" } });
});
