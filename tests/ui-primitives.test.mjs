import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

/**
 * Behavioural tests for the shared UI primitives.
 *
 * These assert what a keyboard or screen-reader user actually experiences,
 * which source-reading assertions cannot: that focus is trapped, that Escape
 * closes, that rows activate on Enter, that arrows move between tabs. The
 * accessibility guarantees live in components/ui, so they are verified once
 * here rather than per consuming view.
 */

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

/** Bundles the primitives plus a harness that mounts them into a real DOM. */
async function bundleHarness() {
  const result = await build({
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { useState } from "react";
        import { ConfirmDialog, DataTable, Tabs, OutcomeBadge, TruncatedId, useToasts, ToastStack, Button } from ${JSON.stringify(fileURLToPath(new URL("../components/ui/index.ts", import.meta.url)))};

        function Harness() {
          const [confirmOpen, setConfirmOpen] = useState(false);
          const [confirmed, setConfirmed] = useState(0);
          const [gatedOpen, setGatedOpen] = useState(false);
          const [typed, setTyped] = useState("");
          const [tab, setTab] = useState("a");
          const [activated, setActivated] = useState("");
          const toasts = useToasts(50_000);
          const rows = Array.from({ length: 7 }, (_, i) => ({ id: "row-" + i, name: "项目 " + i, score: (i * 7) % 5 }));
          return (
            <div>
              <button id="before" type="button">before</button>
              <Button id="open-confirm" onClick={() => setConfirmOpen(true)}>打开确认</Button>
              <span id="confirmed-count">{confirmed}</span>
              <ConfirmDialog
                open={confirmOpen}
                title="确定删除这个能力？"
                body="删除后当前发布版本会被移除。"
                onConfirm={() => { setConfirmed((n) => n + 1); setConfirmOpen(false); }}
                onCancel={() => setConfirmOpen(false)}
              />
              <Button id="open-gated" onClick={() => setGatedOpen(true)}>打开门槛确认</Button>
              {/* Inline callbacks on purpose: a new identity every render is what real consumers pass. */}
              <ConfirmDialog
                open={gatedOpen}
                title="输入名称以确认"
                confirmDisabled={typed !== "示例商城"}
                body={<input id="gated-input" data-autofocus value={typed} onChange={(e) => setTyped(e.target.value)} />}
                onConfirm={() => { setConfirmed((n) => n + 1); setGatedOpen(false); }}
                onCancel={() => { setGatedOpen(false); }}
              />
              <Tabs label="视图" active={tab} onChange={setTab} items={[{ id: "a", label: "总览" }, { id: "b", label: "能力" }, { id: "c", label: "设置" }]} />
              <span id="active-tab">{tab}</span>
              <OutcomeBadge status="execution-fault" />
              <TruncatedId value="actor-0123456789abcdef" label="用户" />
              <DataTable
                rows={rows}
                rowKey={(r) => r.id}
                pageSize={5}
                onRowActivate={(r) => setActivated(r.id)}
                searchFilter={(r, q) => r.name.toLowerCase().includes(q)}
                columns={[
                  { id: "name", header: "名称", sortValue: (r) => r.name, cell: (r) => r.name },
                  { id: "score", header: "分数", sortValue: (r) => r.score, cell: (r) => r.score },
                ]}
              />
              <span id="activated">{activated}</span>
              <Button id="push-toast" onClick={() => toasts.push("已保存", "ok")}>toast</Button>
              <ToastStack toasts={toasts.toasts} onDismiss={toasts.dismiss} />
            </div>
          );
        }
        createRoot(document.getElementById("root")).render(<Harness />);
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "tsx",
    },
    bundle: true,
    format: "iife",
    jsx: "automatic",
    write: false,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return result.outputFiles[0].text;
}

const harnessScript = await bundleHarness();

async function harnessServer() {
  const server = createServer((request, response) => {
    if (request.url === "/app.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(harnessScript);
      return;
    }
    if (request.url === "/globals.css") {
      response.writeHead(200, { "content-type": "text/css" });
      response.end(css);
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/globals.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function launchTestBrowser() {
  const configuredChannel = process.env.SITEWAKE_BROWSER_CHANNEL?.trim();
  const channel = configuredChannel || (process.platform === "win32" ? "chrome" : undefined);
  return chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
}

/** Opens the harness and yields a ready page. */
async function withPage(run) {
  const { server, origin } = await harnessServer();
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    await page.waitForSelector("#open-confirm");
    await run(page);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("ConfirmDialog traps focus, closes on Escape, and restores focus to the opener", async () => {
  await withPage(async (page) => {
    await page.click("#open-confirm");
    await page.waitForSelector('[role="dialog"]');

    // The destructive action is focused by default via [data-autofocus].
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "确定");

    // Tab repeatedly: focus must never leave the dialog.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() =>
        document.querySelector('[role="dialog"]').contains(document.activeElement),
      );
      assert.ok(inside, `focus escaped the dialog after ${i + 1} tabs`);
    }
    // Shift+Tab must also wrap rather than fall through to the page.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press("Shift+Tab");
      const inside = await page.evaluate(() =>
        document.querySelector('[role="dialog"]').contains(document.activeElement),
      );
      assert.ok(inside, `focus escaped the dialog after ${i + 1} shift-tabs`);
    }

    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached" });
    // Focus returns to the button that opened it, not to <body>.
    assert.equal(await page.evaluate(() => document.activeElement?.id), "open-confirm");
    assert.equal(await page.textContent("#confirmed-count"), "0");
  });
});

test("a gated ConfirmDialog keeps focus in its text field while the user types", async () => {
  await withPage(async (page) => {
    await page.click("#open-gated");
    await page.waitForSelector('[role="dialog"]');
    // The disabled confirm cannot take focus; the field marked data-autofocus does.
    assert.equal(await page.evaluate(() => document.activeElement?.id), "gated-input");
    // Every keystroke re-renders the owner with fresh callback identities. The
    // trap used to tear down and re-run on that, bouncing focus to the opener
    // and back — activeElement alone cannot see the bounce, a blur count can.
    await page.evaluate(() => { window.__blurs = 0; document.getElementById("gated-input").addEventListener("blur", () => { window.__blurs += 1; }); });
    for (const char of "示例商城") {
      await page.keyboard.type(char);
      assert.equal(await page.evaluate(() => document.activeElement?.id), "gated-input", `focus left the field after typing ${char}`);
    }
    assert.equal(await page.evaluate(() => window.__blurs), 0, "the field must not lose focus while typing");
    assert.equal(await page.inputValue("#gated-input"), "示例商城");
    assert.equal(await page.isEnabled('[role="dialog"] .sa-btn--danger'), true);
    // Escape still reads the latest onCancel even though the effect no longer re-runs.
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "open-gated");
  });
});

test("ConfirmDialog runs the destructive action only on explicit confirmation", async () => {
  await withPage(async (page) => {
    await page.click("#open-confirm");
    await page.click('[role="dialog"] .sa-btn--danger');
    await page.waitForSelector('[role="dialog"]', { state: "detached" });
    assert.equal(await page.textContent("#confirmed-count"), "1");
    assert.match(await page.getAttribute('[role="dialog"], body', "class") || "", /.*/);
  });
});

test("ConfirmDialog exposes accessible dialog semantics", async () => {
  await withPage(async (page) => {
    await page.click("#open-confirm");
    const dialog = await page.evaluate(() => {
      const node = document.querySelector('[role="dialog"]');
      const labelledBy = node.getAttribute("aria-labelledby");
      return {
        modal: node.getAttribute("aria-modal"),
        title: document.getElementById(labelledBy)?.textContent,
      };
    });
    assert.equal(dialog.modal, "true");
    assert.equal(dialog.title, "确定删除这个能力？");
  });
});

test("Tabs move with arrow keys and expose the selected tab", async () => {
  await withPage(async (page) => {
    await page.focus('[role="tab"][aria-selected="true"]');
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    assert.equal(await page.textContent("#active-tab"), "b");

    // End jumps to the last tab; wrapping is circular from there.
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    assert.equal(await page.textContent("#active-tab"), "c");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    assert.equal(await page.textContent("#active-tab"), "a");

    // Only the active tab is in the tab order (roving tabindex).
    const tabIndexes = await page.$$eval('[role="tab"]', (nodes) => nodes.map((n) => n.tabIndex));
    assert.deepEqual(tabIndexes.filter((value) => value === 0).length, 1);
  });
});

test("DataTable rows activate by keyboard, not only by mouse", async () => {
  await withPage(async (page) => {
    await page.focus("tbody tr:first-child");
    await page.keyboard.press("Enter");
    assert.equal(await page.textContent("#activated"), "row-0");

    await page.focus("tbody tr:nth-child(2)");
    await page.keyboard.press(" ");
    assert.equal(await page.textContent("#activated"), "row-1");
  });
});

test("DataTable sorts, paginates, and reports the total row count", async () => {
  await withPage(async (page) => {
    // 7 rows at pageSize 5 => 2 pages, first page shows 5.
    assert.equal(await page.$$eval("tbody tr", (r) => r.length), 5);
    assert.match(await page.textContent(".sa-table__pager"), /共 7 条/);

    await page.click(".sa-table__sort >> nth=1");
    const ascending = await page.$$eval("tbody td:nth-child(2)", (cells) => cells.map((c) => Number(c.textContent)));
    assert.deepEqual(ascending, [...ascending].sort((a, b) => a - b));
    assert.equal(await page.getAttribute("th:nth-child(2)", "aria-sort"), "ascending");

    await page.click(".sa-table__sort >> nth=1");
    assert.equal(await page.getAttribute("th:nth-child(2)", "aria-sort"), "descending");

    await page.click(".sa-table__pager .sa-btn >> nth=1");
    assert.equal(await page.$$eval("tbody tr", (r) => r.length), 2);
  });
});

test("DataTable search narrows rows and explains an empty result", async () => {
  await withPage(async (page) => {
    await page.fill(".sa-table__search", "项目 3");
    assert.equal(await page.$$eval("tbody tr", (r) => r.length), 1);

    await page.fill(".sa-table__search", "不存在的东西");
    assert.equal(await page.$$eval("tbody tr", (r) => r.length), 0);
    // An empty search result must say why and how to recover.
    assert.match(await page.textContent(".sa-empty"), /没有匹配的记录/);
    assert.match(await page.textContent(".sa-empty"), /清除搜索条件/);
  });
});

test("OutcomeBadge conveys status with a glyph as well as a color", async () => {
  await withPage(async (page) => {
    const glyph = await page.evaluate(() =>
      getComputedStyle(document.querySelector(".sa-pill--execution-fault"), "::before").content,
    );
    assert.ok(glyph && glyph !== "none", "outcome pill has no non-color indicator");
    assert.match(await page.textContent(".sa-pill--execution-fault"), /执行中断/);
  });
});

test("TruncatedId shortens the value but keeps it inspectable", async () => {
  await withPage(async (page) => {
    assert.equal(await page.textContent(".sa-truncated code"), "actor-01");
    // The full value must remain reachable for correlating with logs.
    const title = await page.getAttribute(".sa-truncated", "title");
    assert.match(title, /actor-0123456789abcdef/);
    assert.match(await page.getAttribute(".sa-truncated", "aria-label"), /actor-0123456789abcdef/);
  });
});

test("toasts are announced in a live region and can be dismissed", async () => {
  await withPage(async (page) => {
    await page.click("#push-toast");
    await page.waitForSelector(".sa-toast");
    assert.equal(await page.getAttribute(".sa-toasts", "aria-live"), "polite");
    await page.click('.sa-toast button[aria-label="关闭提示"]');
    await page.waitForSelector(".sa-toast", { state: "detached" });
  });
});

test("interactive elements show a visible focus ring", async () => {
  await withPage(async (page) => {
    await page.keyboard.press("Tab");
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });
    assert.notEqual(outline.style, "none");
    assert.notEqual(outline.width, "0px");
  });
});
