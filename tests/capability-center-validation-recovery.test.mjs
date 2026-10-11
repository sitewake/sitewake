import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("validation recovery stays inside four-table Capability Tasks", async () => {
  const source = await readFile(
    new URL("../components/capability-center/capability-center-screen.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /capabilityCenterApi\.createTask\([\s\S]*?type:\s*["']validate["']/,
    "system validation creates a four-table validation Task",
  );
  assert.match(
    source,
    /selectedTask\.status === ["']failed["'][\s\S]*?taskAction\(["']retry["']\)[\s\S]*?taskAction\(["']rebuild["']\)/,
    "a failed Task offers both same-task retry and a new-version rebuild",
  );
  assert.doesNotMatch(source, /CapabilityProject|CapabilityRevision|validationJob/i);
});
