/**
 * The production audit is a gate, not a report.
 *
 * `audit:runtime` used to be a bare `npm audit --omit=dev`, which fails on every
 * advisory including ones with no patched release. A gate that cannot pass gets
 * skipped, and that is how a critical advisory sat in a release candidate while
 * the gate was "known to fail at step one".
 *
 * So the question it asks now is narrower: is every critical or high advisory
 * either fixed or written down with a review date? These tests hold that gate to
 * failing when it should — an unrecorded advisory, an acceptance past its date,
 * an acceptance missing its reasoning — because a gate nobody has watched fail is
 * a gate nobody should trust.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { advisoriesFrom, judge, readAccepted } from "../scripts/audit-runtime.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const advisory = (id, severity = "high") => ({
  id, severity, package: "braces", range: "<=3.0.3", title: "stack exhaustion",
});
const acceptance = (id, overrides = {}) => ({
  id,
  callSurface: ["build time only"],
  mitigation: "not present at runtime",
  noFixExists: "latest published version is inside the range",
  reviewBy: "2099-01-01",
  ...overrides,
});

test("a critical or high advisory nobody recorded fails the gate", () => {
  const verdict = judge([advisory("GHSA-aaaa-bbbb-cccc")], []);
  assert.equal(verdict.blocking, 1);
  assert.deepEqual(verdict.unlisted.map((item) => item.id), ["GHSA-aaaa-bbbb-cccc"]);
});

test("recording it with its reasoning and a future date lets the gate pass", () => {
  const verdict = judge([advisory("GHSA-aaaa-bbbb-cccc")], [acceptance("GHSA-aaaa-bbbb-cccc")]);
  assert.equal(verdict.blocking, 0);
});

test("an acceptance past its review date fails the gate again", () => {
  // The point of the date: an acceptance is a dated decision, not an exemption.
  const verdict = judge(
    [advisory("GHSA-aaaa-bbbb-cccc")],
    [acceptance("GHSA-aaaa-bbbb-cccc", { reviewBy: "2020-01-01" })],
    new Date("2026-10-03T00:00:00Z"),
  );
  assert.equal(verdict.blocking, 1);
  assert.deepEqual(verdict.expired.map((item) => item.id), ["GHSA-aaaa-bbbb-cccc"]);
});

test("an acceptance without reasoning is not an acceptance", () => {
  for (const missing of ["callSurface", "mitigation", "noFixExists", "reviewBy"]) {
    const entry = acceptance("GHSA-aaaa-bbbb-cccc");
    delete entry[missing];
    const verdict = judge([advisory("GHSA-aaaa-bbbb-cccc")], [entry]);
    assert.ok(verdict.blocking >= 1, `a missing ${missing} has to fail the gate`);
  }
});

test("moderate and low advisories do not block, and are not silently accepted either", () => {
  const verdict = judge([advisory("GHSA-mmmm-nnnn-oooo", "moderate")], []);
  assert.equal(verdict.blocking, 0, "the gate is about critical and high");
  assert.equal(verdict.unlisted.length, 0);
});

test("one advisory reached through six packages counts once", () => {
  // npm reports an advisory once per node of the path it travels. Counting paths
  // is how "one DoS in a build-time glob matcher" was read as six findings.
  const chain = ["vinext", "vite-plugin-commonjs", "vite-plugin-dynamic-import", "fast-glob", "micromatch"];
  const audit = {
    vulnerabilities: {
      braces: { via: [{ url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm", source: 1, name: "braces", severity: "high", title: "stack exhaustion", range: "<=3.0.3" }] },
      ...Object.fromEntries(chain.map((name, index) => [name, { via: [chain[index - 1] || "braces"] }])),
    },
  };
  assert.deepEqual(advisoriesFrom(audit).map((item) => item.id), ["GHSA-vfj7-8cjw-p6xm"]);
});

test("an acceptance for something no longer in the tree is reported as stale", () => {
  const verdict = judge([], [acceptance("GHSA-gone-gone-gone")]);
  assert.equal(verdict.blocking, 0, "a stale entry is housekeeping, not a failure");
  assert.deepEqual(verdict.stale, ["GHSA-gone-gone-gone"]);
});

test("the recorded acceptances carry every field the gate requires", async () => {
  const accepted = readAccepted(ROOT);
  assert.ok(accepted.length, "this release has at least one accepted advisory on record");
  for (const entry of accepted) {
    assert.match(entry.id, /^GHSA-/, `${entry.id} is not an advisory id`);
    assert.ok(entry.package, `${entry.id} names no package`);
    assert.ok(Array.isArray(entry.callSurface) && entry.callSurface.length, `${entry.id} records no call surface`);
    assert.ok(entry.mitigation, `${entry.id} records no mitigation`);
    assert.ok(entry.noFixExists, `${entry.id} does not say why there is no upgrade`);
    assert.ok(Number.isFinite(Date.parse(entry.reviewBy)), `${entry.id} has no review date`);
  }
});

test("SECURITY.md points readers at the list", () => {
  const security = readFileSync(`${ROOT}SECURITY.md`, "utf8");
  assert.match(security, /security\/accepted-advisories\.json/,
    "a reader looking for known advisories has to be able to find the list");
});
