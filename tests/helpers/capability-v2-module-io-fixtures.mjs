import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const schemaVersion = "capability-module-harness-case.v1";
const modules = new Set(["B", "C1", "C2", "C3", "Review", "D"]);
const assertionOps = new Set(["equals", "notEquals", "present", "absent", "matches", "lengthAtLeast", "sha256"]);

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_object_required`);
  return value;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function merge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
  const output = base && typeof base === "object" && !Array.isArray(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    output[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(output[key], value)
      : clone(value);
  }
  return output;
}

function removePath(target, path) {
  const parts = String(path).split(".").filter(Boolean);
  if (!parts.length) throw new Error("fixture_remove_path_required");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return;
    current = current[part];
  }
  if (current && typeof current === "object" && !Array.isArray(current)) delete current[parts.at(-1)];
}

function atPath(value, path) {
  return String(path).split(".").filter(Boolean).reduce((current, key) => {
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
    return current && typeof current === "object" ? current[key] : undefined;
  }, value);
}

function validateAssertions(assertions, label) {
  if (!Array.isArray(assertions)) throw new Error(`${label}_array_required`);
  for (const [index, assertion] of assertions.entries()) {
    const item = record(assertion, `${label}_${index}`);
    if (typeof item.path !== "string" || !item.path.trim()) throw new Error(`${label}_${index}_path_required`);
    if (!assertionOps.has(item.op)) throw new Error(`${label}_${index}_op_invalid`);
  }
}

export function validateModuleHarnessCase(value) {
  const item = record(value, "fixture_case");
  if (item.schemaVersion !== schemaVersion) throw new Error("fixture_schema_version_invalid");
  if (!modules.has(item.module)) throw new Error("fixture_module_invalid");
  if (typeof item.caseId !== "string" || !item.caseId.trim()) throw new Error("fixture_case_id_required");
  if (typeof item.title !== "string" || !item.title.trim()) throw new Error("fixture_title_required");
  if (typeof item.baseRef !== "string" || !item.baseRef.trim()) throw new Error("fixture_base_ref_required");
  if (item.inputPatch !== undefined) record(item.inputPatch, "fixture_input_patch");
  if (item.removePaths !== undefined && !Array.isArray(item.removePaths)) throw new Error("fixture_remove_paths_array_required");
  const expected = record(item.expected, "fixture_expected");
  if (expected.outcome !== "success" && expected.outcome !== "error") throw new Error("fixture_expected_outcome_invalid");
  if (expected.outcome === "error" && (typeof expected.errorCode !== "string" || !expected.errorCode.trim())) throw new Error("fixture_expected_error_code_required");
  validateAssertions(expected.assertions || [], "fixture_assertions");
  validateAssertions(expected.sideEffects || [], "fixture_side_effects");
  return item;
}

export async function loadModuleHarnessCase(casePath) {
  const absoluteCasePath = resolve(casePath);
  const definition = validateModuleHarnessCase(JSON.parse(await readFile(absoluteCasePath, "utf8")));
  const absoluteBasePath = resolve(dirname(absoluteCasePath), definition.baseRef);
  const base = JSON.parse(await readFile(absoluteBasePath, "utf8"));
  const input = merge(base, definition.inputPatch || {});
  for (const path of definition.removePaths || []) removePath(input, path);
  return {
    casePath: absoluteCasePath,
    basePath: absoluteBasePath,
    caseId: definition.caseId,
    module: definition.module,
    title: definition.title,
    input,
    setup: clone(definition.setup || {}),
    expected: clone(definition.expected),
  };
}

async function walkJson(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkJson(path));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
  }
  return files;
}

export async function loadAllModuleHarnessCases(root) {
  const files = (await walkJson(resolve(root))).sort();
  return Promise.all(files.map(loadModuleHarnessCase));
}

function stable(value) {
  return JSON.stringify(value);
}

export function assertModuleHarnessResult(actual, expected) {
  for (const assertion of expected.assertions || []) {
    const received = atPath(actual, assertion.path);
    if (assertion.op === "equals" && stable(received) !== stable(assertion.value)) throw new Error(`${assertion.path}: expected ${stable(assertion.value)}, received ${stable(received)}`);
    if (assertion.op === "notEquals" && stable(received) === stable(assertion.value)) throw new Error(`${assertion.path}: must not equal ${stable(assertion.value)}`);
    if (assertion.op === "present" && received === undefined) throw new Error(`${assertion.path}: expected present`);
    if (assertion.op === "absent" && received !== undefined) throw new Error(`${assertion.path}: expected absent, received ${stable(received)}`);
    if (assertion.op === "matches" && (typeof received !== "string" || !new RegExp(String(assertion.value), "u").test(received))) throw new Error(`${assertion.path}: expected to match ${assertion.value}`);
    if (assertion.op === "lengthAtLeast" && (!received || typeof received.length !== "number" || received.length < Number(assertion.value))) throw new Error(`${assertion.path}: expected length >= ${assertion.value}`);
    if (assertion.op === "sha256" && (typeof received !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(received))) throw new Error(`${assertion.path}: expected sha256`);
  }
}

