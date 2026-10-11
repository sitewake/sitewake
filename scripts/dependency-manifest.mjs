// Writes a package.json that carries only what `npm ci` reads: name, engines,
// the dependency maps and overrides. Docker caches the `npm ci` layer on the
// content of the files copied before it; with the full package.json every
// script edit and every version bump (each release) evicted that layer and
// rebuilt node_modules on every machine. Copying this manifest instead keeps
// the layer until a dependency actually changes.
//
//   node scripts/dependency-manifest.mjs <source package.json> <output package.json>
import { readFileSync, writeFileSync } from "node:fs";

const KEEP = ["name", "private", "type", "engines", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "workspaces"];

export function dependencyManifest(packageJson) {
  const source = JSON.parse(packageJson);
  const kept = {};
  for (const key of KEEP) if (key in source) kept[key] = source[key];
  return `${JSON.stringify(kept, null, 2)}\n`;
}

if (process.argv[1] && new URL(process.argv[1], "file://").pathname.endsWith("dependency-manifest.mjs")) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) { console.error("usage: node scripts/dependency-manifest.mjs <package.json> <output>"); process.exit(2); }
  writeFileSync(output, dependencyManifest(readFileSync(source, "utf8")));
}
