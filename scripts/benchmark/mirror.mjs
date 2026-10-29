// Mirrors the static practice sites into .artifacts/benchmark/sites/<site>/www
// so the benchmark never reads the public internet. A manifest records what
// was fetched; a site whose files still match it is not fetched again.
//
//   node scripts/benchmark/mirror.mjs [--site <slug>] [--force] [--check]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ARTIFACTS, loadSites, log, parseFlags, run } from "./lib.mjs";

const flags = parseFlags();
const sites = loadSites({ configuredOnly: true }).filter((site) => site.kind === "mirror" && (!flags.site || site.slug === flags.site));
if (!sites.length) { console.error("no mirror sites selected"); process.exit(1); }

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, base));
    else out.push({ path: relative(base, path), size: statSync(path).size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function digestOf(files) {
  return createHash("sha256").update(files.map((file) => `${file.path}\t${file.size}`).join("\n")).digest("hex");
}

function currentManifest(www) {
  if (!existsSync(www)) return undefined;
  const files = listFiles(www);
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), digest: digestOf(files) };
}

function markerPresent(www, marker) {
  const index = join(www, "index.html");
  return existsSync(index) && readFileSync(index, "utf8").includes(marker);
}

let failures = 0;
for (const site of sites) {
  const root = join(ARTIFACTS, "sites", site.slug);
  const www = join(root, "www");
  const manifestPath = join(root, "manifest.json");
  const saved = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : undefined;
  const now = currentManifest(www);
  const intact = saved && now && saved.digest === now.digest && markerPresent(www, site.mirror.marker);
  if (flags.check) {
    log(site.slug, intact ? `ok (${now.files} files)` : saved ? "changed since mirrored" : "not mirrored");
    if (!intact) failures += 1;
    continue;
  }
  if (intact && !flags.force) { log(site.slug, `already mirrored (${now.files} files, ${Math.round(now.bytes / 1024 / 1024)} MB)`); continue; }
  rmSync(www, { recursive: true, force: true });
  mkdirSync(www, { recursive: true });
  log(site.slug, `mirroring ${site.mirror.source} …`);
  const args = [
    "--mirror", "--convert-links", "--adjust-extension", "--page-requisites", "--no-parent",
    "--no-host-directories", "--directory-prefix", www, "-e", "robots=off",
    "--tries", "3", "--timeout", "20", "--quiet", "--user-agent", "SiteWakeBenchmarkMirror/1.0",
    ...(site.mirror.reject ? ["--reject", site.mirror.reject] : []),
    site.mirror.source,
  ];
  // wget exits 8 when any single URL answered with an error (a 404 image, say);
  // the mirror is judged by its marker and manifest, not by that code.
  await run("wget", args).catch((error) => { if (!/exited with 8/.test(error.message)) throw error; });
  if (!markerPresent(www, site.mirror.marker)) {
    log(site.slug, `FAILED: index.html does not contain "${site.mirror.marker}"`);
    failures += 1;
    continue;
  }
  const fresh = currentManifest(www);
  writeFileSync(manifestPath, JSON.stringify({ site: site.slug, source: site.mirror.source, fetchedAt: new Date().toISOString(), ...fresh }, null, 2));
  log(site.slug, `mirrored ${fresh.files} files, ${Math.round(fresh.bytes / 1024 / 1024)} MB`);
}
process.exit(failures ? 1 : 0);
