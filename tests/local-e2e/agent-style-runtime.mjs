import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { AGENT_STYLES, applyAgentStyle } from "../../lib/console/agent-style-presets.ts";
import { normalizeAgentConfig } from "../../lib/site-knowledge/protocol.ts";
const browser = await chromium.launch({ headless: true });
const output = new URL("../../.artifacts/system-settings-presets/", import.meta.url).pathname;
await mkdir(output, { recursive: true });
try {
  for (const style of AGENT_STYLES) {
    const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1365, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const response = await context.request.get("http://localhost:3000/api/site-agents/shop/release?runtime=1&capabilityAdapters=0");
    const body = await response.json();
    const config = applyAgentStyle(normalizeAgentConfig(body.release.agentConfig), style.id);
    body.release.agentConfig = config;
    await page.route("**/api/site-agents/shop/release?*", route => route.fulfill({ json: body, headers: { "access-control-allow-origin": "*" } }));
    await page.goto("http://localhost:4001/");
    const host = page.locator('[data-sitewake-agent="widget"]');
    await page.waitForFunction(({ surface, accent }) => {
      const element = document.querySelector('[data-sitewake-agent="widget"]');
      return element?.dataset.surface === surface && element.style.getPropertyValue("--accent") === accent;
    }, { surface: style.surface, accent: config.theme.accentColor });
    await host.locator(".launcher").click();
    await host.locator(".panel").waitFor({ state: "visible" });
    const rendered = await host.evaluate(element => {
      const root = element.shadowRoot;
      return { surface: element.dataset.surface, preset: element.dataset.preset,
        accent: getComputedStyle(element).getPropertyValue("--accent").trim(),
        header: getComputedStyle(root.querySelector(".head")).backgroundColor,
        radius: getComputedStyle(root.querySelector(".panel")).borderRadius };
    });
    assert.equal(rendered.surface, style.surface);
    assert.equal(rendered.preset, style.preset);
    if (style.surface === "soft") assert.equal(rendered.radius, "26px");
    if (style.surface === "contrast") assert.equal(rendered.header, "rgb(124, 92, 255)");
    await page.screenshot({ path: `${output}widget-${style.id}.png`, animations: "disabled" });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("PASS: all four styles render in the real embedded SDK from release configuration.");
} finally { await browser.close(); }
