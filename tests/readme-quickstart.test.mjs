/**
 * The two READMEs are the GitHub front door. They must agree with each other
 * and with the repository: every command they show must exist, the two
 * languages must show the same commands in the same order, and nothing meant
 * for the internal team (or the retired demo sites) may leak back in.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { INTERNAL_MARKERS } from "../scripts/public-boundary.mjs";

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FILES = { en: "README.md", zh: "README.zh-CN.md" };

const readme = Object.fromEntries(await Promise.all(
  Object.entries(FILES).map(async ([lang, file]) => [lang, await readFile(new URL(`../${file}`, import.meta.url), "utf8")]),
));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

/** Command lines from ```bash / ```sh fences, trailing comments stripped. */
function commands(markdown) {
  const blocks = [...markdown.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].map((match) => match[1]);
  return blocks.flatMap((block) => block.split("\n"))
    .map((line) => line.replace(/\s+#.*$/, "").trim())
    .filter(Boolean);
}

function headings(markdown) {
  return [...markdown.matchAll(/^(##+) /gm)].map((match) => match[1].length);
}

test("each README links to the other inside the header block", () => {
  // The header is title, tagline, website and badges; the language switch closes it.
  const header = (text) => text.slice(0, text.indexOf("</div>"));
  assert.match(header(readme.en), /\[中文\]\(README\.zh-CN\.md\)/);
  assert.match(header(readme.zh), /\[English\]\(README\.md\)/);
});

test("both languages show the same commands in the same order", () => {
  assert.deepEqual(commands(readme.zh), commands(readme.en));
  assert.ok(commands(readme.en).length >= 10, "the quick start is not empty");
});

test("both languages have the same section structure", () => {
  assert.deepEqual(headings(readme.zh), headings(readme.en));
});

test("the two quick-start paths are exactly the documented sequences", () => {
  const list = commands(readme.en);
  // ./setup starts the stack itself; `docker compose up -d --build` is the --no-start alternative.
  const docker = ["git clone https://github.com/sitewake/sitewake.git", "cd sitewake", "./setup"];
  // Local development never runs ./setup: the model is connected in the console.
  const local = ["git clone https://github.com/sitewake/sitewake.git", "cd sitewake", "npm install", "npx playwright install chromium", "npm run dev"];
  const has = (sequence) => list.some((_, index) => sequence.every((command, offset) => list[index + offset] === command));
  assert.ok(has(docker), `Docker path missing or out of order:\n${list.join("\n")}`);
  assert.ok(has(local), `local path missing or out of order:\n${list.join("\n")}`);
  assert.equal(list.filter((command) => command === "./setup").length, 1, "./setup appears on the Docker path only");
});

test("the wizard's --no-start next steps and the model's place are the README's", async () => {
  const { en } = await import("../scripts/cli-copy.mjs");
  // The manual Docker path (--no-start) and the smoke test stay documented in prose.
  for (const command of [en.setup.nextDocker, "docker compose exec -T control-plane node scripts/container-smoke.mjs"]) {
    assert.ok(readme.en.includes(command), `README must mention ${command}`);
  }
  for (const [lang, text] of Object.entries(readme)) {
    assert.match(text, lang === "en" ? /only the language|asks one thing — the language/ : /只问一件事 —— 语言/, `${FILES[lang]}: ./setup asks only the language`);
    assert.match(text, lang === "en" ? /Settings → Models/ : /设置 → 模型/, `${FILES[lang]}: the model is connected in the console`);
    assert.match(text, lang === "en" ? /model step appears only while none is connected/ : /只在还没有模型时出现/, `${FILES[lang]}: the model step is conditional`);
    assert.doesNotMatch(text, lang === "en" ? /three-step/ : /三步接入/, `${FILES[lang]}: no three-step onboarding left`);
    assert.doesNotMatch(text, /`\.\/setup` (?:says|报|连不上|cannot connect)/, `${FILES[lang]}: verification errors belong to the console, not ./setup`);
  }
});

test("every npm script the READMEs mention exists", () => {
  for (const [lang, text] of Object.entries(readme)) {
    const names = [...text.matchAll(/npm run ([a-z0-9:-]+)/g)].map((match) => match[1]);
    assert.ok(names.length > 0);
    for (const name of names) assert.ok(pkg.scripts[name], `${FILES[lang]} mentions npm run ${name}, which is not in package.json`);
  }
});

test("every script file and the entrypoint the READMEs mention exist", async () => {
  for (const [lang, text] of Object.entries(readme)) {
    const files = new Set([...text.matchAll(/\bnode (scripts\/[a-z0-9./-]+)/g)].map((match) => match[1]));
    files.add("setup");
    for (const file of files) await stat(new URL(`../${file}`, import.meta.url)).catch(() => assert.fail(`${FILES[lang]} mentions ${file}, which does not exist`));
  }
  const { stdout } = await run("git", ["ls-files", "-s", "setup"], { cwd: ROOT });
  assert.match(stdout, /^100755 /, "setup must be executable in git, or `./setup` fails on a fresh clone");
});

test("linked local files exist", async () => {
  for (const [lang, text] of Object.entries(readme)) {
    const links = [...text.matchAll(/\]\(([^)#:]+)(?:#[^)]*)?\)/g)].map((match) => match[1]);
    const images = [...text.matchAll(/src="([^"]+)"/g)].map((match) => match[1]).filter((source) => !/^https?:/.test(source));
    for (const target of [...links, ...images]) {
      await stat(new URL(`../${target}`, import.meta.url)).catch(() => assert.fail(`${FILES[lang]} links to ${target}, which does not exist`));
    }
  }
});

/** Internal-team material and the retired demo sites must not come back. */
const FORBIDDEN = [
  "4001", "4002", "4003", "Nimbus", "demo-sites",
  "architecture:open", "preview:product", "server:deploy", "server:configure", ".cnb.yml", "/etc/sitewake",
  "senwev", ...INTERNAL_MARKERS,
];

test("no internal or demo-site references", () => {
  for (const [lang, text] of Object.entries(readme)) {
    for (const needle of FORBIDDEN) assert.ok(!text.includes(needle), `${FILES[lang]} contains "${needle}"`);
  }
});

test("model requirements and the common failures are covered", () => {
  for (const text of Object.values(readme)) {
    assert.match(text, /tool_choice/);
    assert.match(text, /provider-payload-policy\.ts/);
    assert.match(text, /401/);
    assert.match(text, /404/);
    assert.match(text, /\/v1/);
    assert.match(text, /SITEWAKE_PUBLIC_ORIGIN/);
    assert.match(text, /HTTPS/);
    assert.match(text, /node scripts\/setup\.mjs/, "the Windows path is documented");
    assert.match(text, /\/access/, "the console password is mentioned before exposing it");
  }
});

test("the documentation section promises only what a reader can reach", () => {
  // It used to promise an SDK API reference, an architecture map and
  // deployment notes "on the website". None of the three were there. An entry
  // document that sends a reader somewhere empty is worse than one that says
  // less: the reader concludes the project is unfinished, not the page.
  // Anything named here has to be a file in this repository — "linked local
  // files exist" above then proves it is really there.
  const PROMISED_ELSEWHERE = /API (?:reference|参考)|architecture map|架构地图|架构图|deployment notes|部署说明|guides 都在|Guides,/i;
  for (const [lang, text] of Object.entries(readme)) {
    const start = text.indexOf("## \u{1F4DA}");
    assert.ok(start >= 0, `${FILES[lang]} has no documentation section`);
    const section = text.slice(start, text.indexOf("## ", start + 4));
    assert.doesNotMatch(section, PROMISED_ELSEWHERE,
      `${FILES[lang]} promises a document the website does not host`);
    assert.match(section, /CONTRIBUTING\.md/);
    assert.match(section, /CHANGELOG\.md/);
  }
});
