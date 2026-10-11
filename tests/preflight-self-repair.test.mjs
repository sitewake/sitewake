import assert from "node:assert/strict";
import test from "node:test";
import { repairPreflight } from "../scripts/preflight.mjs";

// A first run on a fresh Linux machine is missing the Playwright browser and
// its system libraries. Nothing about that needs a person: `npm run dev`
// installs what it can and only reports what it could not.
function recorder(results = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(" "));
    return results[command] ?? { status: 0 };
  };
  return { calls, run };
}

const logs = () => {
  const lines = [];
  return { lines, log: (line) => lines.push(String(line).trim()) };
};

test("the browser is installed without asking, and the checks are re-run rather than assumed", async () => {
  const { calls, run } = recorder();
  const { lines, log } = logs();
  let rechecked = 0;
  const remaining = await repairPreflight([{ code: "chromium-missing" }], {
    run, log, locale: "zh", recheck: async () => { rechecked += 1; return []; },
  });
  assert.equal(rechecked, 1, "a repair is verified by running every check again");
  assert.deepEqual(remaining, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /playwright\/cli\.js install chromium$/);
  assert.ok(lines.some((line) => line.includes("正在安装")), lines.join(" | "));
});

test("system libraries are installed with the privileges at hand — root directly, sudo when it needs no password", async () => {
  const uid = process.getuid;
  try {
    process.getuid = () => 0;
    const asRoot = recorder();
    await repairPreflight([{ code: "chromium-deps-missing", libraries: ["libnss3.so"] }], { ...asRoot, log: () => {}, recheck: async () => [] });
    assert.equal(asRoot.calls.length, 1, "root needs no sudo probe");
    assert.match(asRoot.calls[0], /playwright\/cli\.js install-deps chromium$/);

    process.getuid = () => 1000;
    const withSudo = recorder();
    await repairPreflight([{ code: "chromium-deps-missing", libraries: ["libnss3.so"] }], { ...withSudo, log: () => {}, recheck: async () => [] });
    assert.deepEqual(withSudo.calls.map((call) => call.split(" ").slice(0, 2).join(" ")), ["sudo -n", "sudo -n"]);
    assert.match(withSudo.calls[1], /^sudo -n \S+node\S* .*playwright\/cli\.js install-deps chromium$/);

    // No password-less sudo: the issue survives with its printed command.
    process.getuid = () => 1000;
    const issue = { code: "chromium-deps-missing", libraries: ["libnss3.so"] };
    const denied = recorder({ sudo: { status: 1 } });
    const remaining = await repairPreflight([issue], { ...denied, log: () => {}, recheck: async () => { throw new Error("must not re-check when nothing was attempted"); } });
    assert.deepEqual(remaining, [issue]);
    assert.deepEqual(denied.calls, ["sudo -n true"]);
  } finally {
    process.getuid = uid;
  }
});

test("an issue nobody can repair automatically is left to the report", async () => {
  const { calls, run } = recorder();
  const issues = [{ code: "port-busy", port: 3000, component: { key: "componentControlPlane" } }, { code: "node-too-old", current: "20.0.0", required: "22.12.0" }];
  const remaining = await repairPreflight(issues, { run, log: () => {}, recheck: async () => { throw new Error("nothing was attempted"); } });
  assert.deepEqual(remaining, issues);
  assert.deepEqual(calls, []);
});
