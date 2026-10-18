/**
 * Extracted UI files must not contain Chinese literals again.
 *
 * A "done list" rather than a global ban, because a global ban is red on day one and
 * cannot guard anything. A list guard lets each extraction batch lock itself in: once
 * a file is clean it cannot regress. The list length is also the coverage — no separate
 * bookkeeping.
 *
 * The check is deliberately coarse: after stripping comments, any Chinese on any line
 * counts. It does not decide whether a string is really rendered — that would require
 * telling the TS generic `Record<Locale, string>` from a JSX opening tag, which a
 * character scan cannot and an AST is not worth. Coarse means false positives, and
 * false positives are right here: the guard would rather demand a one-line exemption
 * than silently miss real copy.
 *
 * Exempt with `i18n-exempt:<reason>` on the same or the previous line. The locale
 * switcher's "中文 / English" is such a case — they must always show their own
 * language; translating them would be the bug.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Files whose extraction is complete. Adding a file here declares "all its UI copy is
 * in the dictionary"; from then on any Chinese literal written into it turns this red.
 */
const EXTRACTED = [
  "components/locale-switcher.tsx",
  // The two screens an unauthenticated visitor sees first — the whole point of the switcher there is that they can be read
  "components/access-gate.tsx",
  "components/access-manage-panel.tsx",
  // Console shell: the layer seen as soon as it opens
  "components/site-agent-console.tsx",
  "components/console/shell-states.tsx",
  // Standalone onboarding: all its copy is in the dictionary; listed to lock it in
  "components/console/onboarding.tsx",
  "components/console/system-settings.tsx",
  "app/layout.tsx",
  // Overview and business topology
  "components/console/living-overview.tsx",
  "components/console/session-history.tsx",
  "components/console/topology-graph.tsx",
  "components/console/settings.tsx",
  "components/effect-center.tsx",
  "components/console/site-model.tsx",
  // Runner management: the largest screen in this migration
  "components/runner-management.tsx",
  "components/console/runner-vocabulary.ts",
  // Capability center
  "components/capability-center/capability-center-screen.tsx",
  "components/capability-center-v2-screen.tsx",
  "components/capability-center-v1.tsx",
  "components/dom-replay-player.tsx",
  // Shared controls: clean now, listed so they stay clean
  "components/ui/data.tsx",
  "components/ui/modal.tsx",
  "components/ui/badge.tsx",
  "app/access/page.tsx",
  "app/page.tsx",
  // The widget itself: every status line a visitor reads while a task runs
  "client/user-agent-port.ts",
  "client/user-agent-adaptive.ts",
  "client/user-agent-client.ts",
  "client/user-agent-trace.ts",
  "client/user-agent-shared.ts",
  "client/user-agent-page-controller.ts",
  "client/user-agent-judge.ts",
  // Server-derived copy. The guard stopped at components, so text produced here —
  // a contract's field labels, an invented topology area, an API diagnostic — reached
  // the reader in the build language whatever they had selected.
  "lib/capability-center-v2/result-presentation.ts",
  "lib/site-knowledge/business-topology.ts",
  "lib/site-knowledge/errors.ts",
  "lib/console/knowledge-view.ts",
  "app/api/site-agents/[siteAgentId]/route.ts",
  "app/api/site-agents/[siteAgentId]/capabilities/[capabilityId]/runs/route.ts",
  "app/api/site-agents/[siteAgentId]/model/v2/chat/completions/route.ts",
];

const HAN = /[一-鿿]/;
const EXEMPT = /i18n-exempt:/;

/**
 * Strips comments, preserving line numbers. Chinese in comments does not count.
 *
 * A character scan rather than a regex: a regex cannot tell a `//` comment from the
 * double slash in a URL, nor a quote inside a string from one inside a comment.
 *
 * Regex literals have to be skipped too, and that is not optional pedantry: a single
 * `/\/$/` the scanner reads as division leaves it convinced the rest of the file is
 * one long string, and from there every comment reads as copy. That is what kept
 * `client/user-agent-client.ts` off the list with five phantom hits inside comments.
 * A `/` starts a regex when the last meaningful character cannot end an expression.
 */
const BEFORE_REGEX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", ""]);

function stripComments(source) {
  const lines = source.split("\n").map(() => "");
  let line = 0, index = 0;
  let inLine = false, inBlock = false, inRegex = false, quote = "", previous = "";
  while (index < source.length) {
    const char = source[index];
    const pair = source.slice(index, index + 2);
    if (char === "\n") { line += 1; index += 1; inLine = false; inRegex = false; continue; }
    if (inLine) { index += 1; continue; }
    if (inBlock) { if (pair === "*/") { inBlock = false; index += 2; } else index += 1; continue; }
    if (inRegex) {
      if (char === "\\") { lines[line] += "  "; index += 2; continue; }
      if (char === "[") inRegex = "class";
      else if (char === "]" && inRegex === "class") inRegex = true;
      else if (char === "/" && inRegex !== "class") { inRegex = false; previous = "/"; }
      lines[line] += char; index += 1; continue;
    }
    if (quote) {
      if (char === "\\") { lines[line] += "  "; index += 2; continue; }
      if (char === quote) { quote = ""; previous = char; }
      lines[line] += char; index += 1; continue;
    }
    if (pair === "//") { inLine = true; index += 2; continue; }
    if (pair === "/*") { inBlock = true; index += 2; continue; }
    if (char === "/" && BEFORE_REGEX.has(previous)) { inRegex = true; lines[line] += char; index += 1; continue; }
    if (char === '"' || char === "'" || char === "`") quote = char;
    if (!/\s/.test(char)) previous = char;
    lines[line] += char; index += 1;
  }
  return lines;
}

/** Non-exempt lines containing Chinese. */
function offendingLines(source) {
  const stripped = stripComments(source);
  const raw = source.split("\n");
  return stripped.flatMap((text, index) => {
    if (!HAN.test(text)) return [];
    // The exemption may sit at the end of the same line or on the previous one (when the line is too long)
    if (EXEMPT.test(raw[index]) || (index > 0 && EXEMPT.test(raw[index - 1]))) return [];
    return [{ line: index + 1, text: text.trim().slice(0, 80) }];
  });
}

test("已抽取的文件不再含未豁免的中文", async () => {
  const offenders = [];
  for (const relative of EXTRACTED) {
    const source = await readFile(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8");
    for (const hit of offendingLines(source)) offenders.push(`${relative}:${hit.line}  ${hit.text}`);
  }
  assert.deepEqual(offenders, [],
    `这些文件已宣布抽取完成，界面文案必须来自词表。\n`
    + `确属刻意保留的（例如语言切换控件里的语言名），在该行标 i18n-exempt:<理由>。\n  `
    + offenders.join("\n  "));
});

test("注释里的中文不算", () => {
  assert.deepEqual(offendingLines("// 这是注释\nconst a = 1;"), []);
  assert.deepEqual(offendingLines("/* 块注释\n   跨行的中文 */\nconst a = 1;"), []);
  assert.deepEqual(offendingLines("const a = 1; // 行尾注释"), []);
});

test("代码里的中文算，且报出行号", () => {
  const hits = offendingLines('const a = 1;\nconst b = "请输入密码";');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2, "行号要对得上，否则这条报错没法用");
});

test("豁免标记能写在同一行或上一行", () => {
  assert.deepEqual(offendingLines('const zh = "中文"; // i18n-exempt:语言名必须显示自己那门语言'), []);
  assert.deepEqual(offendingLines('// i18n-exempt:同上\nconst zh = "中文";'), []);
  // But it cannot exempt the whole file: the next line is no longer exempt
  const hits = offendingLines('// i18n-exempt:理由\nconst a = "中文";\nconst b = "英文";');
  assert.equal(hits.length, 1, "豁免只覆盖紧邻的一行");
  assert.equal(hits[0].line, 3);
});

test("清单只增不减——删掉条目等于放弃已经拿到的覆盖率", () => {
  assert.ok(EXTRACTED.length >= 1, "清单不该为空");
  assert.equal(new Set(EXTRACTED).size, EXTRACTED.length, "清单里有重复条目");
});
