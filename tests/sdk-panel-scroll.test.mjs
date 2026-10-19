import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { emptyRelease } from "../lib/site-knowledge/protocol.ts";

/**
 * The conversation scrolls vertically only, and a reset brings its questions back.
 *
 * Both were reported from a real panel: a wide reply (a markdown table carries
 * `min-width:max-content`) widened the grid track, because a grid track does not shrink
 * below its content, and the panel gained a horizontal scrollbar. And the suggested
 * questions returned after a reset only when a `ready` status happened to arrive
 * afterwards, so they were sometimes there and sometimes not.
 *
 * Measured in a real browser against the built artifact: `scrollWidth` versus
 * `clientWidth` is the only honest test of "no sideways scrolling", and a source
 * assertion would not have caught the grid blowout at all.
 */
const sdk = await readFile(new URL("../public/sitewake.js", import.meta.url), "utf8");
const sdkCss = await readFile(new URL("../public/sitewake.css", import.meta.url), "utf8");

const QUESTIONS = ["What is the warranty on the Lune table lamp?", "Which lamps are dimmable?"];

function site() {
  const base = emptyRelease("scroll-test");
  const release = {
    ...base,
    profile: { ...base.profile, name: "Orvelle", suggestedQuestions: QUESTIONS, language: "en" },
    agentConfig: {
      appearance: { preset: "orb", palette: "mint", launcherPosition: "bottom-right" },
      overrides: { pinnedSuggestions: QUESTIONS },
      features: { showSuggestions: true, showNewChat: true },
    },
  };
  return createServer((request, response) => {
    const path = new URL(request.url, "http://x").pathname;
    if (path === "/sitewake.js") { response.writeHead(200, { "content-type": "application/javascript" }); response.end(sdk); return; }
    if (path === "/sitewake.css") { response.writeHead(200, { "content-type": "text/css" }); response.end(sdkCss); return; }
    if (path.endsWith("/release")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ release })); return; }
    if (path.startsWith("/api/")) { response.writeHead(503, { "content-type": "application/json" }); response.end("{}"); return; }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Scroll test</title><h1>site</h1>
      <script src="/sitewake.js" data-site-agent="scroll-test" data-endpoint="http://${request.headers.host}" data-open="true" defer></script>`);
  });
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

async function openPanel(page) {
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-sitewake-agent="widget"]')?.shadowRoot?.querySelector(".panel");
    return Boolean(panel && !panel.hidden && panel.getBoundingClientRect().width > 0);
  }, undefined, { timeout: 15_000 });
  await page.evaluate(async () => {
    const panel = document.querySelector('[data-sitewake-agent="widget"]').shadowRoot.querySelector(".panel");
    await Promise.all(panel.getAnimations().map((animation) => animation.finished));
  });
}

test("a reply far wider than the panel does not make it scroll sideways", async () => {
  const server = site();
  let browser;
  try {
    const origin = await listen(server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(origin, { waitUntil: "load" });
    await openPanel(page);
    const overflow = await page.evaluate(() => {
      const root = document.querySelector('[data-sitewake-agent="widget"]').shadowRoot;
      const list = root.querySelector(".messages");
      // A child wider than the panel, with no width cap of its own. Whatever produces
      // one -- a nowrap label, a table, future markup nobody has written yet -- the
      // conversation must not start scrolling sideways because of it.
      const row = document.createElement("div");
      row.className = "message-row assistant";
      row.innerHTML = `<span class="avatar">A</span><div class="message markdown">`
        + `<p>${"x".repeat(400)}</p>`
        + `<div style="width:2000px">wider than the panel</div>`
        + `<div style="white-space:nowrap">${"a long unbroken label ".repeat(20)}</div>`
        + `</div>`;
      list.appendChild(row);
      // scrollWidth still reports clipped content, so it answers the wrong question.
      // Whether it *scrolls* is the thing: ask it to, and see if it moves.
      const canScroll = (element) => {
        element.scrollLeft = 400;
        const moved = element.scrollLeft;
        element.scrollLeft = 0;
        return moved;
      };
      const body = root.querySelector(".body");
      const panel = root.querySelector(".panel");
      return {
        bodyMoved: canScroll(body), panelMoved: canScroll(panel),
        bodyOverflowX: getComputedStyle(body).overflowX,
      };
    });
    assert.equal(overflow.bodyMoved, 0, "the conversation scrolled sideways");
    assert.equal(overflow.panelMoved, 0, "the panel scrolled sideways");
    assert.equal(overflow.bodyOverflowX, "hidden", "the conversation must not offer a horizontal axis");
  } finally {
    if (browser) await browser.close();
    await close(server);
  }
});

test("resetting the conversation brings the suggested questions back", async () => {
  const server = site();
  let browser;
  try {
    const origin = await listen(server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(origin, { waitUntil: "load" });
    await openPanel(page);
    const read = () => page.evaluate(() => {
      const root = document.querySelector('[data-sitewake-agent="widget"]').shadowRoot;
      return root.querySelectorAll(".suggestions button").length;
    });
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-sitewake-agent="widget"]').shadowRoot;
      return root.querySelectorAll(".suggestions button").length > 0;
    }, undefined, { timeout: 15_000 });
    const before = await read();
    assert.ok(before > 0, "the questions should be there to begin with");
    // A message makes the empty state give way, as a real turn would.
    await page.evaluate(() => {
      const root = document.querySelector('[data-sitewake-agent="widget"]').shadowRoot;
      const input = root.querySelector("textarea");
      input.value = "hello";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      root.querySelector("form").requestSubmit();
    });
    await page.evaluate(() => document.querySelector('[data-sitewake-agent="widget"]').shadowRoot.querySelector(".new-chat").click());
    await page.waitForFunction(() => {
      const root = document.querySelector('[data-sitewake-agent="widget"]').shadowRoot;
      return root.querySelectorAll(".suggestions button").length > 0;
    }, undefined, { timeout: 15_000 });
    assert.equal(await read(), before, "a reset restores the same questions the empty conversation had");
  } finally {
    if (browser) await browser.close();
    await close(server);
  }
});
