import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The product has exactly one name. Every earlier one is gone from the tracked
// tree — content and paths alike — except inside the cutover record, which has
// to name what it moved away from. The names below are stored as byte sequences
// so this file does not itself trip the check.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LEGACY = ["616374696f6e73646b", "6c657373636c69636b", "736974657265666c6578"].map((hex) => Buffer.from(hex.replace(/\s/g, ""), "hex"));
const WHITELIST_PREFIX = "docs/operations/sitewake-cutover/";

function lowerAscii(buffer) {
  const out = Buffer.allocUnsafe(buffer.length);
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i];
    out[i] = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
  }
  return out;
}

function lineOf(buffer, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (buffer[i] === 0x0a) line += 1;
  return line;
}

function scan(path, buffer) {
  const hits = [];
  const haystack = lowerAscii(buffer);
  for (const needle of LEGACY) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      hits.push(`${path}:${lineOf(buffer, at)}: ${needle.toString()}`);
      from = at + needle.length;
    }
  }
  return hits;
}

test("no earlier product name survives in the tracked tree outside the cutover record", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  assert.ok(files.length > 100, "git ls-files returned the tracked tree");
  const hits = [];
  for (const path of files) {
    if (path.startsWith(WHITELIST_PREFIX)) continue;
    hits.push(...scan(path, Buffer.from(path)).map((hit) => `${hit} (in path)`));
    hits.push(...scan(path, readFileSync(new URL(path, `file://${ROOT}`))));
  }
  if (hits.length) {
    console.log(hits.join("\n"));
    console.log(`${hits.length} 处`);
  }
  assert.equal(hits.length, 0, `${hits.length} legacy product name(s) found — see the list above`);
});

test("the whitelist is exactly the cutover record and the check itself is exercised", () => {
  assert.equal(WHITELIST_PREFIX, "docs/operations/sitewake-cutover/");
  // A hit inside a would-be file is reported with its path and line.
  const sample = Buffer.from(`line one\nsecond ${LEGACY[1].toString().toUpperCase()} here\n`);
  assert.deepEqual(scan("x/y.txt", sample), [`x/y.txt:2: ${LEGACY[1].toString()}`]);
  // Binary content is scanned by bytes too.
  const binary = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]), LEGACY[0], Buffer.from([0x00, 0xff])]);
  assert.equal(scan("img.png", binary).length, 1);
});
