// Drives one visitor goal through the real widget injected into a site page,
// the way a visitor would use it, and reports what the widget showed and
// which run the console recorded.
//
//   node scripts/benchmark/drive.mjs --site <slug> --task <id> [--reuse] [--limit <seconds>]
import { chromium } from "playwright";
import { CONSOLE_URL, IN_NETWORK, loadSites, log, parseFlags, siteBaseUrl } from "./lib.mjs";

const WIDGET = "[data-sitewake-agent='widget']";
const CHROMIUM_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests",
];

export async function launchBrowser() {
  return chromium.launch({ headless: true, args: CHROMIUM_ARGS });
}

/** A fresh visitor: new storage, the site's locale, the widget script injected into every top-level page. */
export async function visitorContext(browser, { locale, consoleUrl = CONSOLE_URL, siteId }) {
  const context = await browser.newContext({ locale, viewport: { width: 1280, height: 900 } });
  await context.addInitScript(([src, id]) => {
    if (window.top !== window) return;
    const add = () => {
      if (document.querySelector("script[data-site-agent]")) return;
      const script = document.createElement("script");
      script.src = src; script.defer = true; script.setAttribute("data-site-agent", id);
      document.head.appendChild(script);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
  }, [`${consoleUrl}/sitewake.js`, siteId]);
  return context;
}

const inShadow = (page, body, arg) => page.evaluate(([code, value]) => {
  const root = document.querySelector("[data-sitewake-agent='widget']")?.shadowRoot;
  return new Function("r", "a", code)(root, value);
}, [body, arg]);

async function shadow(page, body, arg) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { return await inShadow(page, body, arg); } catch { await page.waitForTimeout(1000); }
  }
  return {};
}

/**
 * Opens `startUrl`, sends `goal` to the widget and waits for the run to end.
 * Returns the widget's final text with the goal removed (`answer`), the run id
 * the console assigned, and what happened along the way.
 */
export async function driveGoal({ context, siteBase, startUrl, goal, limitMs = 300_000, onLine }) {
  const page = await context.newPage();
  const consoleErrors = [];
  const navigations = [];
  let runId = "";
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 200)); });
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  page.on("request", (request) => {
    const match = request.url().match(/\/api\/agent-runs\/(run_[A-Za-z0-9-]+)/) || request.url().match(/\/sessions\/(run_[A-Za-z0-9-]+)/);
    if (match && !runId) runId = match[1];
  });
  const started = Date.now();
  const result = { goal, startUrl, runId: "", seconds: 0, timedOut: false, outcome: "", finalStatus: "", answer: "", messages: "", navigations, consoleErrors, timeline: [] };
  try {
    await page.goto(`${siteBase}${startUrl}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await page.waitForFunction((selector) => Boolean(document.querySelector(selector)?.shadowRoot?.querySelector(".launcher")), WIDGET, { timeout: 45_000 });
    } catch {
      result.outcome = "widget_missing";
      return finish();
    }
    await shadow(page, "const p=r.querySelector('.panel'); if (!p || p.hidden) r.querySelector('.launcher').click();");
    await page.waitForTimeout(1500);
    await shadow(page, "const t=r.querySelector('textarea'); t.value=a; t.dispatchEvent(new Event('input',{bubbles:true})); r.querySelector('button.send').click();", goal);
    let last = "";
    let quietSince = Date.now();
    while (Date.now() - started < limitMs) {
      await page.waitForTimeout(3000);
      const state = await shadow(page, "if(!r) return {busy:true,text:'',status:''}; return { busy: !!r.querySelector('.composer')?.classList.contains('running'), text: r.querySelector('.messages')?.innerText || '', status: r.querySelector('.status')?.textContent || '' };");
      const snapshot = `${state.status || ""} | ${(state.text || "").slice(-160).replace(/\s+/g, " ")}`;
      if (snapshot !== last) {
        const line = `[${Math.round((Date.now() - started) / 1000)}s] ${snapshot}`;
        result.timeline.push(line);
        onLine?.(line);
        last = snapshot;
        quietSince = Date.now();
      }
      if (!state.busy && Date.now() - started > 10_000 && Date.now() - quietSince > 6_000) break;
    }
    const final = await shadow(page, "return { text: r.querySelector('.messages')?.innerText || '', status: r.querySelector('.status')?.textContent || '', busy: !!r.querySelector('.composer')?.classList.contains('running') };");
    result.timedOut = Date.now() - started >= limitMs;
    result.finalStatus = final.status || "";
    result.messages = final.text || "";
    result.answer = (final.text || "").replace(goal, " ").trim();
    result.outcome = result.timedOut ? "timed_out" : final.busy ? "still_busy" : "ended";
    return finish();
  } finally {
    // A page Chromium no longer answers for must not hold the whole run hostage.
    await Promise.race([page.close().catch(() => undefined), new Promise((resolveClose) => setTimeout(resolveClose, 10_000))]);
  }

  function finish() {
    result.runId = runId;
    result.seconds = Math.round((Date.now() - started) / 1000);
    result.endUrl = navigations.at(-1) || `${siteBase}${startUrl}`;
    return result;
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const flags = parseFlags();
  const { loadTaskSet } = await import("./tasks.mjs");
  const site = loadSites({ configuredOnly: true }).find((item) => item.slug === flags.site);
  if (!site) { console.error("--site <slug> is required (a configured site)"); process.exit(1); }
  const { tasks, errors } = loadTaskSet(site);
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  const task = tasks.find((item) => item.id === flags.task);
  if (!task) { console.error(`--task <id> must be one of ${tasks.map((item) => item.id).join(", ")}`); process.exit(1); }
  const ask = flags.reuse ? task.reuse : task;
  const limitMs = Number(flags.limit || 300) * 1000;
  // The run has a hard end even if the browser stops answering.
  setTimeout(() => { console.error(`driver watchdog: no result after ${Math.round(limitMs / 1000) + 180}s`); process.exit(3); }, limitMs + 180_000).unref();
  const browser = await launchBrowser();
  try {
    const context = await visitorContext(browser, { locale: task.locale, siteId: site.id });
    log(`${IN_NETWORK ? "in-network" : "host"} driver; site ${siteBaseUrl(site)}; console ${CONSOLE_URL}`);
    const outcome = await driveGoal({ context, siteBase: siteBaseUrl(site), startUrl: task.startUrl, goal: ask.goal, limitMs, onLine: (line) => log(line) });
    await context.close();
    console.log(JSON.stringify(outcome, null, 2));
  } finally {
    await browser.close();
  }
}
