import { build } from "esbuild";
import { readdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const REPO = "https://github.com/sitewake/sitewake";
const OWN_NOTICE = "SiteWake SDK - MIT License - Copyright (c) 2026 SiteWake contributors";

// The bundles ship third-party MIT code, and MIT requires each copy to carry
// the original copyright and permission notices. Their sources have no `/*!`
// comments for `legalComments` to keep, so derive the notice block from what
// esbuild actually bundled and append it as the footer.
// Skip the title and our own copyright paragraph; OWN_NOTICE already states them.
const MIT_PERMISSION = readFileSync("LICENSE", "utf8").split("\n\n").slice(2).join("\n\n").trim();

function packageOf(file) {
  let dir = dirname(file);
  while (dir.includes("node_modules")) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (pkg.license) return { dir, pkg };
    } catch {}
    dir = dirname(dir);
  }
  throw new Error(`no licensed package.json above ${file}`);
}

// License files come under many names (LICENSE / LICENSE.md / license / LICENCE …).
// macOS file systems are case-insensitive, so a local `readFileSync("LICENSE")`
// happened to read chalk's `license`; in a Linux container it is ENOENT, and a
// production build failed on that. Look the file up case-insensitively from the
// directory listing, and fall back to the package.json author when there is none.
function licenseFile(dir) {
  const name = readdirSync(dir).find((entry) => /^licen[cs]e(\.(md|txt|markdown))?$/i.test(entry));
  return name ? join(dir, name) : undefined;
}

function copyrightLines(dir, pkg) {
  const file = licenseFile(dir);
  if (!file) {
    const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
    return author ? `Copyright (c) ${author}` : "see package LICENSE";
  }
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => /^copyright/i.test(line) && !/BE LIABLE/.test(line));
  return lines.length ? lines.join("; ") : "see package LICENSE";
}

async function thirdPartyFooter(entry) {
  const { metafile } = await build({
    entryPoints: [entry], bundle: true, write: false, metafile: true,
    platform: "browser", target: ["es2020"], format: "iife", logLevel: "silent",
  });
  const packages = new Map();
  for (const file of Object.keys(metafile.inputs)) {
    if (!file.includes("node_modules/")) continue;
    const { dir, pkg } = packageOf(file);
    if (pkg.license !== "MIT") throw new Error(`${entry} bundles ${pkg.name}@${pkg.version} (${pkg.license}); the footer only covers MIT packages`);
    packages.set(`${pkg.name}@${pkg.version}`, copyrightLines(dir, pkg));
  }
  const lines = [
    OWN_NOTICE,
    `${REPO}/blob/main/LICENSE`,
    "",
    "This file bundles the following MIT-licensed packages:",
    ...[...packages].sort().map(([name, copyright]) => `  ${name} - ${copyright}`),
    "",
    ...MIT_PERMISSION.split("\n"),
    "",
    `Full notices: ${REPO}/blob/main/THIRD_PARTY_NOTICES.md`,
  ];
  return `\n/*!\n${lines.map((line) => ` * ${line}`.trimEnd()).join("\n")}\n */\n`;
}

const shared = {
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ["es2020"],
  platform: "browser",
  legalComments: "eof",
  logLevel: "info",
};

const targets = [
  { entry: "client/user-agent-client.ts", outfile: "public/sitewake.js" },
  { entry: "client/user-agent-adaptive.ts", outfile: "public/sitewake-adaptive.js" },
];

await Promise.all(targets.map(async ({ entry, outfile }) => build({
  ...shared,
  entryPoints: [entry],
  outfile,
  format: "iife",
  footer: { js: await thirdPartyFooter(entry) },
})));

// The widget's stylesheet ships as a file for the same reason the script does:
// a site with `style-src 'self'` refuses an injected <style>, and SiteWake must
// not ask anyone to allow 'unsafe-inline'. One origin covers script, API,
// styles and images.
const stylesheet = await build({
  entryPoints: ["client/user-agent-styles.ts"],
  bundle: true, write: false, format: "esm", platform: "neutral", logLevel: "silent",
});
const { WIDGET_STYLESHEET } = await import(
  `data:text/javascript;base64,${Buffer.from(stylesheet.outputFiles[0].text).toString("base64")}`
);
await writeFile("public/sitewake.css", `/*! ${OWN_NOTICE} */\n${WIDGET_STYLESHEET}`);
