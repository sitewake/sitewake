/**
 * Guards the input contract itself: every case file must be exactly what the
 * host hands PageAgent — nothing extra, nothing test-only. Running a case end
 * to end is `npm run page-agent:run`, which needs a browser, a target site and
 * a configured model API; this file needs none of them.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const caseRoot = dirname(fileURLToPath(import.meta.url));
const root = resolve(caseRoot, "../../..");

/** The whole of module input. A case file carrying anything else is a bug. */
const REQUIRED = ["schemaVersion", "request", "execution", "release"];
const OPTIONAL = ["services", "runtime"];
const REQUEST_FIELDS = ["goal", "input", "conversation", "origin", "url"];
const BRIEF_FIELDS = [
  "objective", "normalizedGoal", "entities", "effect", "completionCriteria",
  "relevantSceneIds", "relevantCapabilityIds", "rejectedCapabilityReasons", "knowledgeReceiptRefs",
];
const CASE_FILES = ["00-module-input.json", "01-module-output.json", "README.md"];

async function cases() {
  const entries = await readdir(caseRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

// The maintainers' cases are recorded from real sites and are not exported, so
// a public checkout has none. That is reported as a skip, not a pass.
async function casesOrSkip(t) {
  const names = await cases();
  if (!names.length) t.skip("no page-agent cases in this checkout (the recorded cases are not exported)");
  return names;
}

async function moduleInput(name) {
  return JSON.parse(await readFile(join(caseRoot, name, "00-module-input.json"), "utf8"));
}

test("a case folder holds an input, its output, and the note explaining them", async (t) => {
  const names = await casesOrSkip(t);
  for (const name of names) {
    const files = (await readdir(join(caseRoot, name))).sort();
    assert.ok(files.includes("00-module-input.json"), `${name} is missing its input`);
    // JSON cannot carry comments and the input must stay exactly what the host
    // hands over, so the explanation lives beside it.
    assert.ok(files.includes("README.md"), `${name} is missing the note explaining its input`);
    const unexpected = files.filter((file) => !CASE_FILES.includes(file));
    assert.deepEqual(unexpected, [], `${name} carries files that are not part of a case: ${unexpected.join(", ")}`);
  }
});

test("input carries only what the host actually hands PageAgent", async (t) => {
  for (const name of await casesOrSkip(t)) {
    const input = await moduleInput(name);
    assert.equal(input.schemaVersion, "page-agent-module.v1", `${name} declares the wrong schema`);
    for (const key of REQUIRED) assert.ok(key in input, `${name} is missing ${key}`);
    const extra = Object.keys(input).filter((key) => !REQUIRED.includes(key) && !OPTIONAL.includes(key));
    assert.deepEqual(extra, [], `${name} carries fields the module is never handed: ${extra.join(", ")}`);
  }
});

test("no case smuggles in environment configuration", async (t) => {
  // The API, the endpoint and the run token belong to the environment. A case
  // that names one of them has stopped describing a task.
  const forbidden = /api[_-]?key|apiKey|baseUrl|base_url|endpoint|agentRunToken|resumeToken|OPENAI|MODEL_/i;
  for (const name of await casesOrSkip(t)) {
    const raw = await readFile(join(caseRoot, name, "00-module-input.json"), "utf8");
    const hit = raw.split("\n").find((line) => forbidden.test(line));
    assert.equal(hit, undefined, `${name} names environment configuration in its input: ${hit}`);
  }
});

test("request states the task and nothing about the browser", async (t) => {
  for (const name of await casesOrSkip(t)) {
    const { request } = await moduleInput(name);
    for (const field of REQUEST_FIELDS) assert.ok(field in request, `${name}.request is missing ${field}`);
    // documentId / browserSessionId are the live browser's own, derived at run
    // time. A case that pins them is describing the harness, not the task.
    for (const field of ["documentId", "browserSessionId"]) {
      assert.ok(!(field in request), `${name}.request pins ${field}, which the browser derives itself`);
    }
    assert.ok(request.url.startsWith(request.origin), `${name}.request.url is not on its own origin`);
    assert.equal(typeof request.goal, "string");
    assert.ok(request.goal.trim().length > 0, `${name}.request.goal is empty`);
  }
});

test("the brief is complete, because it is the run's authority", async (t) => {
  for (const name of await casesOrSkip(t)) {
    const { execution } = await moduleInput(name);
    for (const field of BRIEF_FIELDS) {
      assert.ok(field in execution.brief, `${name}.execution.brief is missing ${field}`);
    }
    assert.ok(execution.brief.completionCriteria.length > 0, `${name} has no completion criteria, so nothing defines "done"`);
    // Every scene the brief points at must exist in the same file.
    const { release } = await moduleInput(name);
    const sceneIds = new Set(release.scenes.map((scene) => scene.id));
    for (const id of execution.brief.relevantSceneIds) {
      assert.ok(sceneIds.has(id), `${name}.execution.brief points at scene ${id}, which its release does not carry`);
    }
  }
});

test("read-only cases do not claim trusted entities they cannot produce", async (t) => {
  for (const name of await casesOrSkip(t)) {
    const input = await moduleInput(name);
    if (input.runtime?.mode !== "read-only") continue;
    assert.deepEqual(
      input.execution.brief.entities,
      {},
      `${name} is read-only but declares entities; a read-only run does not fill fields`,
    );
  }
});

test("services are declared, never scripted", async (t) => {
  for (const name of await casesOrSkip(t)) {
    const { services } = await moduleInput(name);
    if (!services) continue;
    // `navigation` is deliberately not a service: saying yes to onNavigateAction
    // means "the host will carry this task onto the next document", and a unit
    // has no host. See the note in module-contract.ts.
    const known = ["askUser"];
    const extra = Object.keys(services).filter((key) => !known.includes(key));
    assert.deepEqual(extra, [], `${name}.services declares unknown services: ${extra.join(", ")}`);
    if (services.askUser) {
      assert.equal(typeof services.askUser.answer, "string", `${name}.services.askUser must be one fixed answer`);
      // A list of answers would be a script: the case author deciding turn by
      // turn what the environment says.
      assert.ok(!Array.isArray(services.askUser.answer), `${name}.services.askUser.answer must not be a sequence`);
    }
  }
});

test("the release carries only what PageAgent reads", async (t) => {
  const known = ["id", "siteAgentId", "profile", "scenes", "targets", "capabilities"];
  for (const name of await casesOrSkip(t)) {
    const { release } = await moduleInput(name);
    const extra = Object.keys(release).filter((key) => !known.includes(key));
    assert.deepEqual(extra, [], `${name}.release carries fields PageAgent never reads: ${extra.join(", ")}`);
    // These are the user Agent's bookkeeping about which knowledge an answer
    // was produced against. A page operator has no use for them.
    for (const field of ["version", "knowledgeContentHash", "linkReferences", "runtimeFeatures"]) {
      assert.ok(!(field in release), `${name}.release carries ${field}, which belongs to the user Agent's contract`);
    }
    assert.ok(release.scenes.length > 0, `${name}.release has no scenes`);
  }
});

test("the input type accepts every case file", async (t) => {
  const { readPageAgentInput } = await import(resolve(root, "lib/page-agent/real-runner.ts"));
  for (const name of await casesOrSkip(t)) {
    const parsed = await readPageAgentInput(join(caseRoot, name, "00-module-input.json"));
    assert.equal(parsed.schemaVersion, "page-agent-module.v1");
  }
});

test("the output contract names exactly the three destinations", async (t) => {
  const source = await readFile(resolve(root, "lib/page-agent/module-contract.ts"), "utf8");
  const output = source.slice(source.indexOf("export type PageAgentModuleOutput"));
  for (const field of ["result", "episode", "evidence"]) {
    assert.match(output, new RegExp(`\\b${field}:`), `the output contract is missing ${field}`);
  }
  // The run record is the host's. PageAgent borrows a token from it and
  // produces nothing that belongs in it.
  assert.ok(!/\bagentRun:/.test(output), "the output contract claims the AgentRun, which belongs to the host");
  // Diagnostics live on the runner, never in the file the module hands out.
  for (const field of ["provenance:", "handoff:", "diagnostics:"]) {
    assert.ok(!output.includes(field), `the output contract carries ${field}, which is not handed to anyone`);
  }
});
