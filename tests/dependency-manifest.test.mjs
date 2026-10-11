/**
 * The Docker dependency layer must survive edits that do not change what npm
 * installs: scripts, the version bump of every release, metadata.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dependencyManifest } from "../scripts/dependency-manifest.mjs";

test("the manifest keeps what npm ci reads and drops what changes for other reasons", () => {
  const a = dependencyManifest(JSON.stringify({ name: "x", version: "1.0.0", private: true, type: "module", scripts: { dev: "a" }, engines: { node: ">=22" }, dependencies: { pg: "1" }, devDependencies: { esbuild: "2" }, overrides: { hono: "3" }, description: "d" }));
  const b = dependencyManifest(JSON.stringify({ name: "x", version: "1.1.0", private: true, type: "module", scripts: { dev: "b", test: "c" }, engines: { node: ">=22" }, dependencies: { pg: "1" }, devDependencies: { esbuild: "2" }, overrides: { hono: "3" }, description: "e" }));
  assert.equal(a, b, "a version bump and script edits leave the manifest byte-identical");
  assert.deepEqual(Object.keys(JSON.parse(a)), ["name", "private", "type", "engines", "dependencies", "devDependencies", "overrides"]);
  const c = dependencyManifest(JSON.stringify({ name: "x", version: "1.1.0", dependencies: { pg: "2" } }));
  assert.notEqual(a, c, "a dependency change does change it");
});

test("every Dockerfile copies the manifest, not the raw package.json, before npm ci", async () => {
  for (const file of ["Dockerfile", "Dockerfile.worker", "Dockerfile.capability-v2-runner"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /COPY package\.json package-lock\.json scripts\/dependency-manifest\.mjs \.\/\nRUN node dependency-manifest\.mjs package\.json package\.json/, file);
    assert.match(source, /COPY --from=manifest \/manifest\/package\.json \/manifest\/package-lock\.json \.\//, file);
    const ci = source.search(/^RUN .*sh scripts\/npm-ci-retry\.sh/m);
    assert.ok(ci > source.indexOf("COPY --from=manifest"), `${file}: npm ci runs on the manifest`);
    assert.ok(!/^COPY package\.json package-lock\.json \.\/$/m.test(source), `${file}: the raw package.json is never the dependency layer's input`);
  }
});
