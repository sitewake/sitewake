/**
 * The dictionary variable must be declared before the hook callbacks that use it.
 *
 * `const copy = t()...` sitting in the second half of a component body while an
 * earlier useMemo callback references it — that callback runs synchronously during
 * render, the const is still in the temporal dead zone, the browser throws
 * "Cannot access 'X' before initialization", and the page goes blank.
 *
 * TypeScript says nothing about this: it checks scope, not evaluation order within a
 * scope. The build passes, unit tests pass — only opening that screen in a real browser
 * blows up. Production did exactly that: clicking a button on the site knowledge page
 * blanked the screen.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

async function sourceFiles(dir) {
  const root = fileURLToPath(new URL(`../${dir}`, import.meta.url));
  const out = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
  };
  await walk(root);
  return out;
}

/** `const x = t()…` / `labels()` / `widgetCopy(…)` — the ways the dictionary is read during render. */
const DECLARATION = /^\s*const (\w+) = (?:t\(\)|labels\(\)|widgetCopy\(|resolveChromeCopy)/;
const HOOK = /use(?:Memo|Callback|Effect|LayoutEffect)\(/;

test("词表变量不能声明在用到它的 hook 回调之后", async () => {
  const offenders = [];
  for (const dir of ["components", "client"]) {
    for (const file of await sourceFiles(dir)) {
      const lines = (await readFile(file, "utf8")).split("\n");
      const declaredAt = new Map();
      lines.forEach((line, index) => {
        const match = DECLARATION.exec(line);
        if (match && !declaredAt.has(match[1])) declaredAt.set(match[1], index);
      });
      if (!declaredAt.size) continue;
      lines.forEach((line, index) => {
        for (const [name, declaration] of declaredAt) {
          if (index >= declaration) continue;
          if (!new RegExp(String.raw`\b${name}\.`).test(line)) continue;
          // Only inside hook callbacks is it a dead zone — plain function bodies evaluate when called.
          const above = lines.slice(Math.max(0, index - 40), index).join("\n");
          if (!HOOK.test(above)) continue;
          offenders.push(
            `${file.split("/internal/")[1]}\n`
            + `    第 ${index + 1} 行的 hook 回调用了 \`${name}\`，但它在第 ${declaration + 1} 行才声明\n`
            + `    ${line.trim().slice(0, 76)}`,
          );
        }
      });
    }
  }
  assert.deepEqual(offenders, [],
    "这些地方会在浏览器里抛 Cannot access 'X' before initialization 并白屏。\n"
    + "把词表声明提到组件体最前面即可。\n  " + offenders.join("\n  "));
});
