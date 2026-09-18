import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

// The drawer's assembly runs against a D1 binding, so these cover the
// decisions that do not need one: which conclusions are reachable, what is
// never conflated with what, and that nothing reaches the client unredacted.
// Task 8.2 checks the assembled result against the five known production runs.
const STORE = await readFile(new URL("../db/effect-store.ts", import.meta.url), "utf8");
const TYPES = await readFile(new URL("../lib/site-knowledge/effect-types.ts", import.meta.url), "utf8");
const { zh } = await import("../lib/i18n/zh.ts").catch(async () => {
  const { build } = await import("esbuild");
  const r = await build({ entryPoints: [new URL("../lib/i18n/zh.ts", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString("base64")}`);
});

function block(source, header) {
  const start = source.indexOf(header);
  if (start < 0) return "";
  const end = source.indexOf("\nasync function ", start + header.length);
  const alt = source.indexOf("\nexport async function ", start + header.length);
  const stop = [end, alt].filter((index) => index > 0).sort((a, b) => a - b)[0];
  return source.slice(start, stop > 0 ? stop : source.length);
}

test("a run with no Episode is reported as such, not left blank", () => {
  const body = block(STORE, "async function capabilityHandoffForRun");

  assert.match(body, /"noEpisode" as const/,
    "answering without driving the page produces no Episode; the drawer has to say so");
  assert.match(body, /task_session_id=\?/, "Episodes are found by the run they belong to");
});

test("a cancelled or failed run is not filed as working-as-designed", () => {
  const body = block(STORE, "async function capabilityHandoffForRun");

  // Production has 3 cancelled and 11 failed runs with no Episode. Giving all
  // of them the "answered without touching the page, by design" reason files
  // real faults as intended behaviour — which is what shipped first.
  assert.match(body, /runStatus === "cancelled"[\s\S]{0,60}"run-cancelled"/);
  assert.match(body, /runStatus === "failed"[\s\S]{0,60}"run-unfinished"/);

  for (const [reason, mustSay] of [["run-cancelled", /取消/], ["run-unfinished", /没有正常结束/]]) {
    assert.match(zh.effect.handoffReason[reason], mustSay);
    assert.doesNotMatch(zh.effect.handoffReason[reason], /既有设计/,
      `${reason} is not the design working`);
  }
});

test("the no-Episode reason claims only what the record supports", () => {
  // A knowledge-base Scene entry hands the run to the destination document, so
  // the stored run keeps that document's activity and cannot be told apart
  // from a plain direct answer. Naming only one of them would be a guess:
  // run_a22a022f is a Scene entry and carries no knowledge activity at all.
  const copy = zh.effect.handoffReason.noEpisode;

  assert.match(copy, /直接回答/);
  assert.match(copy, /知识库/);
  assert.match(copy, /既有设计/, "this one genuinely is the design working");
});

test("an unfinished run is pending, never 'not delivered'", () => {
  const body = block(STORE, "async function capabilityHandoffForRun");

  assert.match(body, /IN_PROGRESS_RUN_STATUS\.has\(runStatus\)/);
  assert.match(STORE, /IN_PROGRESS_RUN_STATUS = new Set\(\["running", "awaiting-page", "awaiting-user"\]\)/);
  // The empty-Episode branch must check pending before concluding noEpisode,
  // or every in-flight run would read as a permanent failure.
  const empty = body.slice(body.indexOf("if (!episodeRows.length)"));
  assert.ok(empty.indexOf("IN_PROGRESS_RUN_STATUS") < empty.indexOf('"noEpisode" as const'),
    "pending has to be decided before any not-delivered reason");
  assert.ok(empty.indexOf("IN_PROGRESS_RUN_STATUS") < empty.indexOf('"run-cancelled"'),
    "an in-flight run must not be read as cancelled");
});

test("every Episode of a run is listed, with no primary chosen", () => {
  const body = block(STORE, "async function capabilityHandoffForRun");

  assert.match(body, /ORDER BY started_at LIMIT 20/);
  assert.match(body, /for \(const row of episodeRows\)/,
    "production has runs with two Episodes; picking one would be a guess");
  assert.doesNotMatch(body, /episodeRows\[0\]/);
});

test("a single shared cause is reported; mixed causes are not flattened", () => {
  const body = block(STORE, "async function capabilityHandoffForRun");

  assert.match(body, /reasons\.size === 1 \? \{ reason: \[\.\.\.reasons\]\[0\] \}/,
    "two Episodes blocked for different reasons must not be given one label");
});

test("a derived payload is never presented as a delivered one", () => {
  assert.match(TYPES, /derived: true/, "the view has to carry that it was recomputed");

  const body = block(STORE, "async function downstreamForEpisode");
  assert.match(body, /return \{ state: "unconfirmed" \}/,
    "no downstream record means unconfirmed, which is the far side's state");
  assert.doesNotMatch(body, /state: "rejected" \}[\s\S]{0,40}no signal/i);
});

test("downstream provenance is confirmed, not assumed from a substring match", () => {
  const body = block(STORE, "async function downstreamForEpisode");

  // The lookup is a LIKE over the signal row, which can match text elsewhere.
  assert.match(body, /episodeIds\.includes\(episodeId\)/,
    "a LIKE hit has to be confirmed against the signal's own episodeIds");
  assert.match(body, /signal_json LIKE \?/);
});

test("both sides' readings are kept, and neither is filled in from the other", () => {
  const body = block(STORE, "function judgementFor");

  assert.match(body, /executionRequirementForGoal\(goal\)\.effect/);
  assert.match(body, /parsed\.operation === "read" \|\| parsed\.operation === "write"/);
  assert.match(body, /if \(!userAgentEffect \|\| !capabilityOperation\)/,
    "one side missing must leave the other alone rather than infer it");
  assert.match(body, /agrees: \(userAgentEffect === "read"\) === \(capabilityOperation === "read"\)/);
});

test("everything that leaves the server is redacted", () => {
  const body = block(STORE, "async function capabilityHandoffForRun");

  assert.match(body, /generationInput: redactJson\(/,
    "the delivered contract carries whole paragraphs of page text");
  for (const field of ["goal", "startPageUrl", "endPageUrl"]) {
    assert.match(body, new RegExp(`${field}: redactText\\(`), `${field} must be redacted too`);
  }
  const downstream = block(STORE, "async function downstreamForEpisode");
  assert.match(downstream, /summary: redactText\(/,
    "the capability centre's own summary quotes the page and the goal");
});

test("the drawer response does not carry the page snapshots", () => {
  const body = block(STORE, "async function capabilityHandoffForRun");

  // A stored Episode is ~173KB, 97% of it snapshots. Only the two URLs travel.
  assert.match(body, /startPageUrl:/);
  assert.doesNotMatch(body, /startSnapshot: episode\.startSnapshot/);
  assert.doesNotMatch(body, /episodeJson: row\.episodeJson/);
  assert.match(body, /episodeBytes: row\.episodeJson\.length/,
    "the size is reported so the omission is visible rather than silent");
});
