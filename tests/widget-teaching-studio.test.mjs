/**
 * The teaching studio must be usable on a real page.
 *
 * Its host covers the viewport with `pointer-events:none` so the person can
 * keep operating the site underneath. Everything that makes the studio itself
 * clickable and laid out therefore comes from the widget stylesheet — and the
 * studio linked that stylesheet before writing its markup, which replaced it.
 * The studio drew as an unstyled block over the site's own header and neither
 * of its buttons could be clicked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const client = await readFile(new URL("../client/user-agent-client.ts", import.meta.url), "utf8");
const stylesheet = await readFile(new URL("../public/sitewake.css", import.meta.url), "utf8");

test("the studio's markup is written before its stylesheet is linked", () => {
  const setup = client.slice(client.indexOf("const teachingRoot = teachingHost.attachShadow"), client.indexOf("document.documentElement.appendChild(teachingHost)"));
  const markup = setup.indexOf("teachingRoot.innerHTML");
  const link = setup.indexOf("linkWidgetStylesheet(teachingRoot");
  assert.ok(markup >= 0 && link >= 0, "教学层应当既写入结构又链接样式表");
  assert.ok(markup < link, "innerHTML 会清空 shadow root，样式表必须在结构之后链接");
});

test("the studio's buttons take a click on a page that owns a sticky header", async () => {
  const markup = client.slice(client.indexOf('<section class="studio"'), client.indexOf("</section>`;\n  linkWidgetStylesheet(teachingRoot"));
  assert.match(client, /teachingStudio\.style\.pointerEvents = "auto"/, "样式表到达之前，按钮也必须可点");
  assert.doesNotMatch(markup, /style=/, "严格 CSP 下不能用内联 style 属性");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>body{margin:0}header{position:sticky;top:0;height:64px;background:#111;z-index:9999}</style><header></header><main>${"内容 ".repeat(100)}</main>`);
    for (const withStylesheet of [true, false]) {
      const reached = await page.evaluate(async ({ markup, stylesheet, withStylesheet }) => {
        document.querySelectorAll("[data-studio-probe]").forEach((node) => node.remove());
        const host = document.createElement("div");
        host.dataset.studioProbe = "1";
        host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = `${markup}</section>`;
        shadow.querySelector(".studio").style.pointerEvents = "auto";
        if (withStylesheet) {
          const style = document.createElement("style");
          style.textContent = stylesheet;
          shadow.appendChild(style);
        }
        document.documentElement.appendChild(host);
        const studio = shadow.querySelector(".studio");
        studio.removeAttribute("hidden");
        const finish = shadow.querySelector("button.finish");
        let clicked = false;
        finish.addEventListener("click", () => { clicked = true; });
        const box = finish.getBoundingClientRect();
        finish.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return {
          clicked,
          pointerEvents: getComputedStyle(finish).pointerEvents,
          onTop: shadow.elementFromPoint?.(box.left + box.width / 2, box.top + box.height / 2)?.tagName || "",
        };
      }, { markup, stylesheet, withStylesheet });
      assert.equal(reached.pointerEvents, "auto", `样式表${withStylesheet ? "存在" : "缺失"}时按钮都应可点，实测 ${reached.pointerEvents}`);
      assert.equal(reached.clicked, true, "点击应当到达按钮");
    }
  } finally {
    await browser.close();
  }
});
