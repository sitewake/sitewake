import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runner = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");
const heartbeatRoute = await readFile(new URL("../app/api/validation/runners/[runnerId]/heartbeat/route.ts", import.meta.url), "utf8");

test("runner uses configured identity or lets the server issue an ephemeral one", () => {
  assert.match(runner, /const runnerId = process\.env\.SITEWAKE_RUNNER_ID\?\.trim\(\)/);
  assert.match(runner, /const browserChannel = process\.env\.SITEWAKE_BROWSER_CHANNEL\?\.trim\(\)/);
  assert.match(runner, /\.\.\.\(browserChannel \? \{ channel: browserChannel \} : \{\}\)/);
  assert.doesNotMatch(runner, /const runnerId[\s\S]{0,160}stableHash/);
  assert.match(runner, /sessionId: runnerSessionId/);
  assert.match(runner, /sessionToken: runnerSessionToken/);
  assert.match(runner, /setInterval\(\(\) => \{[\s\S]*\}, 5_000\)/);
  assert.match(runner, /setInterval\(renew, 30_000\)/);
  assert.match(runner, /if \(result\.desiredState\) draining = result\.desiredState === "draining"/);
});

test("reported runner capacity matches the number of live consumers", () => {
  assert.match(runner, /const runnerConsumerCount = once \? 1 : runnerConcurrency/);
  assert.match(runner, /maxConcurrency: runnerConsumerCount/);
  const cappedReadySlotReports = runner.match(/readySlots: Math\.min\(browserReadyPool\?\.ready \|\| 0, runnerConsumerCount\)/g) || [];
  assert.equal(cappedReadySlotReports.length, 2);
  assert.match(runner, /else if \(runnerRole\) \{[\s\S]*Array\.from\(\{ length: runnerConsumerCount \}, \(\) => consume\(runnerRole, idleMs\)\)/);
  assert.match(runner, /Array\.from\(\{ length: runnerConsumerCount - 1 \}, \(\) => consume\("background", 800\)\)/);
  assert.doesNotMatch(runner, /else if \(runnerRole\) await consume\(runnerRole/);
});

test("draining pauses claims until heartbeat resumes the runner without exiting", () => {
  assert.match(runner, /let draining = false;\s*let shuttingDown = false;/);
  assert.match(runner, /if \(draining\) \{[\s\S]*await waitForShutdownOrDelay[\s\S]*continue;/);
  assert.match(runner, /if \(result\.desiredState\) draining = result\.desiredState === "draining"/);
  assert.match(runner, /if \(heartbeatResult\?\.desiredState\) draining = heartbeatResult\.desiredState === "draining"/);
  assert.match(runner, /while \(!once && !shuttingDown\)/);
  assert.doesNotMatch(runner, /if \(draining\) break;/);
  assert.doesNotMatch(runner, /while \(!once && !draining\)/);
  assert.match(runner, /process\.once\(signal, \(\) => \{\s*shuttingDown = true;\s*draining = true;\s*resolveShutdownRequest\?\.\(\);/);
});

test("registration backoff exits promptly when the process is asked to stop", () => {
  assert.match(runner, /const shutdownRequested = new Promise<void>/);
  assert.match(runner, /async function waitForShutdownOrDelay\(delayMs: number\)/);
  assert.match(runner, /while \(!shuttingDown\) \{[\s\S]*runner_registration_retry[\s\S]*await waitForShutdownOrDelay\(retryMs\)/);
  assert.match(runner, /if \(!registration\) \{[\s\S]*await browserReadyPool\.close\(\);[\s\S]*await browser\.close\(\);[\s\S]*return;/);
});

test("runner heartbeats expose safe progress and retain a sanitized last error", () => {
  assert.match(runner, /function safeRunnerMessage\(value: string\)/);
  assert.match(runner, /heartbeat\(runnerId, "busy", runnerActivity\(stage, message, run\.learningJobId\)\)/);
  assert.match(runner, /heartbeat\(runnerId, "busy", runnerActivity\(run\.progress\.stage, run\.progress\.message, `capability_run:\$\{run\.id\}`\)\)/);
  assert.match(runner, /\.\.\.\(runnerLastError \? \{ lastError: runnerLastError \} : \{\}\)/);
  assert.match(runner, /stage: "failed",\s*phase: "failed",\s*message,/);
  assert.match(runner, /await reportRunnerFailure\(runnerId, "authoring", error, run\.learningJobId\)/);
  assert.match(runner, /await reportRunnerFailure\(runnerId, "validating", error, run\.learningJobId\)/);
  assert.match(runner, /await reportRunnerFailure\(runnerId, "executing", error, `capability_run:\$\{job\.id\}`\)/);
  assert.match(runner, /await reportRunnerFailure\(registeredRunnerId, `consume:\$\{queue\}`, error\)/);
  assert.doesNotMatch(runner, /lastError:[\s\S]{0,120}(?:stack|process\.env)/);
  assert.match(heartbeatRoute, /input\.activity,\s*\{/);
  assert.match(heartbeatRoute, /lastError: input\.lastError/);
  assert.doesNotMatch(heartbeatRoute, /input\.activity \|\| undefined/);
});

test("every recorded task closes its context and waits for evidence", async () => {
  assert.doesNotMatch(runner, /void saveEvidence\(\)/);
  assert.match(runner, /await saveEvidence\(\)/);
  const taskCleanupCalls = runner.match(/await cleanupRecordedContext\(setup\.context/g) || [];
  assert.equal(taskCleanupCalls.length, 3);
  assert.match(runner, /await removeLocalMedia\(\[paths\.screenshotPath, paths\.beforeScreenshotPath, paths\.afterScreenshotPath, \.\.\.\(paths\.keyframePaths \|\| \[\]\), paths\.tracePath, videoPath/);
  assert.match(runner, /updateExecution\(runnerId, token, job, leaseGuard, evidenceRun\)/);
  assert.match(runner, /\.\.\.\(browserRun \? \{ browserRun \} : \{\}\)/);
  const store = await readFile(new URL("../db/site-agent-store.ts", import.meta.url), "utf8");
  assert.match(store, /learningJobId: `capability_run:\$\{runId\}`/);
  assert.match(store, /INSERT OR REPLACE INTO site_agent_v2_browser_runs/);
});

test("runner-only API responses do not reuse wildcard site CORS", async () => {
  const http = await readFile(new URL("../app/api/validation/runners/http.ts", import.meta.url), "utf8");
  assert.doesNotMatch(http, /access-control-allow-origin/i);
  assert.doesNotMatch(http, /SITE_AGENT_CORS_HEADERS/);
  assert.match(http, /SITEWAKE_RUNNER_ENROLLMENT_TOKEN/);
  assert.match(http, /SITEWAKE_LEGACY_RUNNER_PROTOCOL === "true"/);
  assert.match(http, /configuredRunnerLeaseAuthority\(\) === "legacy"/);
  assert.match(http, /if \(runnerSessionToken\(request, body\)\) return true/);
  const missingLegacyTokenGuards = http.match(/if \(!legacy\) return false;/g) || [];
  assert.equal(missingLegacyTokenGuards.length, 2);
  assert.doesNotMatch(http, /return !legacy \|\|/);

  for (const path of [
    "../app/api/validation/runners/register/route.ts",
    "../app/api/validation/runners/[runnerId]/heartbeat/route.ts",
    "../app/api/validation/runners/[runnerId]/lease/route.ts",
    "../app/api/validation/runners/[runnerId]/runs/start/route.ts",
    "../app/api/validation/runners/[runnerId]/runs/complete/route.ts",
    "../app/api/validation/runners/[runnerId]/capability-runs/[runId]/route.ts",
    "../app/api/validation/runners/[runnerId]/leases/[leaseId]/renew/route.ts",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /siteAgentJson|siteAgentOptions/);
    assert.doesNotMatch(source, /message\s*:\s*(?:error instanceof Error|error\.message|String\(error\))/);
  }
});

test("legacy runner paths enforce the central lease fence", async () => {
  const start = await readFile(new URL("../app/api/validation/runners/[runnerId]/runs/start/route.ts", import.meta.url), "utf8");
  const complete = await readFile(new URL("../app/api/validation/runners/[runnerId]/runs/complete/route.ts", import.meta.url), "utf8");
  const capability = await readFile(new URL("../app/api/validation/runners/[runnerId]/capability-runs/[runId]/route.ts", import.meta.url), "utf8");
  const renew = await readFile(new URL("../app/api/validation/runners/[runnerId]/leases/[leaseId]/renew/route.ts", import.meta.url), "utf8");
  const browserRunner = await readFile(new URL("../runner/browser-runner.ts", import.meta.url), "utf8");

  assert.match(start, /renewRunnerLease\(control\)/);
  assert.match(complete, /acquireRunnerLeaseCompletion\(control\)/);
  assert.match(complete, /beginning\.inProgress/);
  assert.match(complete, /completionOwned/);
  assert.match(complete, /status: "failed"/);
  assert.match(complete, /resolveBrowserRunLeaseControl\(decodedRunnerId, token, body\.run\)/);
  assert.doesNotMatch(complete, /inProgress: true \}, 202/);
  assert.match(complete, /completeRunnerLease\(/);
  assert.ok(complete.indexOf("acquireRunnerLeaseCompletion(control)") < complete.indexOf("result = await completeAuthoring("));
  assert.ok(complete.indexOf("acquireRunnerLeaseCompletion(control)") < complete.indexOf("result = await completeValidation("));
  assert.doesNotMatch(capability, /evidencePending/);
  assert.match(capability, /acquireRunnerLeaseCompletion\(control\)/);
  assert.match(capability, /beginning\.inProgress/);
  assert.match(capability, /completionOwned/);
  assert.match(capability, /businessCommitted/);
  assert.match(capability, /abortRunnerLeaseCompletion\(completionControl\)/);
  assert.match(
    capability,
    /completionOwned\s*&&\s*!completionResumed\s*&&\s*!businessCommitted/,
  );
  assert.match(capability, /status: result\.run\.status === "completed" \? "completed" : "failed"/);
  assert.match(capability, /\{ allowCompletedRetry: true \}/);
  assert.match(capability, /resolveCapabilityRunLeaseControl\(decodedRunnerId, token, decodedRunId\)/);
  assert.doesNotMatch(capability, /inProgress: true \}, 202/);
  assert.ok(capability.indexOf("acquireRunnerLeaseCompletion(control)") < capability.indexOf("const result = await updateCapabilityRunFromRunner("));
  assert.match(browserRunner, /let terminalStatus:[^=]+ = "completed"/);
  assert.match(browserRunner, /job\.status = "running";[\s\S]+stage: "recording"/);
  assert.match(
    browserRunner,
    /\.\.\.\(terminal \? \{\s*output: run\.output,\s*outcome: run\.outcome,\s*resultUrl: run\.resultUrl,\s*error: run\.error,\s*completedAt: run\.completedAt,/,
  );
  assert.match(browserRunner, /job\.status = terminalStatus;[\s\S]+updateExecution\(runnerId, token, job, leaseGuard, evidenceRun\)/);
  assert.ok(
    browserRunner.lastIndexOf("job.status = terminalStatus;")
      < browserRunner.lastIndexOf("updateExecution(runnerId, token, job, leaseGuard, evidenceRun)"),
  );
  assert.match(renew, /runnerSessionId:/);
  assert.match(renew, /fence:/);
});

test("container deployment leaves enrollment configuration server-owned", async () => {
  const deploy = await readFile(new URL("../scripts/deploy-container-server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(deploy, /SITEWAKE_RUNNER_ENROLLMENT_TOKEN|SITEWAKE_RUNNER_TOKEN|OPENAI_API_KEY/);
  assert.match(deploy, /configShaBefore[\s\S]+configShaAfter/);
});
