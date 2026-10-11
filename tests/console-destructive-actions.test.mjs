import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

/**
 * Guards the console's destructive actions.
 *
 * These are site-owner administrative actions in a management UI — distinct from
 * the agent acting on an end user's live page, which docs/product-positioning.md
 * deliberately defers to a later Policy Gate. The requirement here is narrow:
 * nothing that discards configuration, cancels running work or invalidates
 * sessions may fire from a single unconfirmed click.
 */

const DESTRUCTIVE_ACTIONS = [
  {
    file: "../components/console/settings.tsx",
    handler: "restoreDefaults",
    // How the handler appears in the dialog's confirm callback. revokeSessions
    // is dispatched through a generic manage() rather than its own function.
    confirmCall: "restoreDefaults(",
    what: "replaces the current appearance draft with defaults",
  },
  {
    file: "../components/console/site-model.tsx",
    handler: "cancelCrawl",
    confirmCall: "void cancelCrawl(",
    what: "cancels an in-flight site crawl",
  },
  {
    file: "../components/access-manage-panel.tsx",
    handler: "revokeSessions",
    confirmCall: 'void manage("revokeSessions")',
    what: "invalidates every logged-in session including the current one",
  },
  {
    // Both entry points (the site settings danger zone, the system settings site row)
    // only open this dialog; the request is sent from the dialog after confirmation, and
    // confirmation requires typing the site name first.
    file: "../components/console/delete-site-dialog.tsx",
    handler: "requestSiteDeletion",
    confirmCall: "void confirm()",
    what: "deletes a site together with every piece of its data",
  },
];

for (const action of DESTRUCTIVE_ACTIONS) {
  test(`${action.handler} requires confirmation because it ${action.what}`, async () => {
    const source = await readFile(new URL(action.file, import.meta.url), "utf8");

    assert.match(
      source,
      /<ConfirmDialog/,
      `${action.file} performs a destructive action but renders no ConfirmDialog`,
    );

    // The trigger must open the dialog, never invoke the action directly.
    const directCall = new RegExp(
      `onClick=\\{\\(\\) => (void )?${action.handler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\(`,
    );
    assert.doesNotMatch(
      source,
      directCall,
      `${action.handler} is still wired straight to onClick, so one click destroys data`,
    );
    assert.doesNotMatch(
      source,
      new RegExp(`onClick=\\{\\(\\) => manage\\("${action.handler}"\\)`),
      `${action.handler} is still dispatched straight from onClick`,
    );

    // The action must be reachable only from the dialog's confirm callback.
    assert.ok(
      source.includes(`onConfirm={() => ${action.confirmCall}`),
      `${action.handler} is not reachable from a ConfirmDialog confirmation`,
    );
  });
}

test("the two delete-site entry points only open the dialog and the dialog gates confirm on the typed name", async () => {
  const [settings, list, dialog] = await Promise.all([
    readFile(new URL("../components/console/website-settings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/console/system-settings.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/console/delete-site-dialog.tsx", import.meta.url), "utf8"),
  ]);
  for (const [name, source] of [["website-settings", settings], ["system-settings", list]]) {
    assert.doesNotMatch(source, /fetch\([^)]*method: "DELETE"/, `${name} must not send the delete request itself`);
    assert.doesNotMatch(source, /requestSiteDeletion/, `${name} must not call the deletion directly`);
    assert.match(source, /onDeleteSite\(\{ id: /, `${name} opens the shared dialog with the site`);
  }
  assert.match(dialog, /confirmDisabled=\{!matches\}/, "confirm stays disabled until the typed name matches");
  assert.match(dialog, /normalizeSiteName\(typed\) === normalizeSiteName\(site!\.name\)/);
  assert.match(dialog, /if \(!site \|\| !matches \|\| busy\) return;/, "no request without a match, none while busy");
});

test("confirmation copy explains the consequence, not just the action", async () => {
  // The copy lives in the shared catalog, so assert it there. Per
  // docs/product-experience.md every dialog must say what happens to the user's
  // data, making a confirm a decision rather than a speed bump.
  const catalog = await readFile(new URL("../lib/i18n/zh.ts", import.meta.url), "utf8");
  for (const phrase of [
    "会被丢弃",
    "无法撤销",
    "已经读到的页面不会被删除",
    "包括你当前这个会话",
  ]) {
    assert.match(catalog, new RegExp(phrase), `confirmation copy is missing "${phrase}"`);
  }

  // Every confirm entry must carry both halves, not just a restated title.
  const { zh } = await import("../lib/i18n/zh.ts");
  for (const [name, entry] of Object.entries(zh.confirm)) {
    assert.ok(entry.consequence?.length > 8, `${name} does not state a consequence`);
    assert.ok(entry.reversibility?.length > 8, `${name} does not state whether it can be undone`);
  }
});

test("destructive confirmations disable themselves while the request is in flight", async () => {
  for (const action of DESTRUCTIVE_ACTIONS) {
    const source = await readFile(new URL(action.file, import.meta.url), "utf8");
    // Without this a double-click fires the mutation twice.
    assert.match(
      source,
      /busy=\{(busy|saving)\}/,
      `${action.file} does not pass a busy flag to its ConfirmDialog`,
    );
  }
});
