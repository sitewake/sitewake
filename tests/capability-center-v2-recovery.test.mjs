import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { prepareFormalPipeline, withModel, closeFixtureSite } from './capability-center-v2-module-io-harness.mjs';
import { GET, POST } from '../app/api/admin/capability-v2/[...path]/route.ts';
import { cancelTask, claimTask, submitTaskResult, resetCapabilityCenterV2ForTests } from '../db/capability-center-v2-store.ts';

test('revalidation retains generation lineage; failed review can recover and publish exactly one version', async () => {
  process.env.SITEWAKE_LOCAL_DEV = '1';
  process.env.CAPABILITY_V2_AUTO_DISPATCH = '0';
  resetCapabilityCenterV2ForTests();
  const siteId = 'recovery-contract-test';
  const input = JSON.parse(await readFile(new URL('./fixtures/capability-center-v2/module-io-harness/bases/c2-input.json', import.meta.url), 'utf8'));
  const prepared = await prepareFormalPipeline(siteId, input);
  const call = async (method, path) => {
    const request = new Request('http://localhost/api/admin/capability-v2/' + path, { method, headers: { 'content-type':'application/json', 'x-sitewake-site-id':siteId }, ...(method === 'POST' ? { body: '{}' } : {}) });
    const response = await (method === 'GET' ? GET : POST)(request, { params: { path: path.split('/') } });
    assert.equal(response.status, method === 'POST' && path.endsWith('/rerun') ? 202 : 200, await response.clone().text());
    return response.json();
  };
  try {
    const rerun = await call('POST', `tasks/${prepared.validationTask.id}/rerun`);
    assert.equal(rerun.task.rerunOfTaskId, prepared.task.id);
    assert.equal(rerun.task.input.context.__retryOfTaskId, prepared.validationTask.id);
    await claimTask(siteId, rerun.task.id, 'recovery-runner');
    await submitTaskResult(siteId, rerun.task.id, 'recovery-runner', { outcome: 'Success', validationResults: prepared.validationTask.result.validationResults });
    await withModel(() => ({ httpStatus: 500, body: 'temporary_review_failure' }), () => call('POST', `tasks/${rerun.task.id}/retry-review`));
    let progress = (await call('GET', `tasks/${rerun.task.id}/progress`)).progress;
    assert.equal(progress.state, 'Failed'); assert.equal(progress.recovery, 'RetryReview');
    const list = await call('GET', 'tasks');
    assert.equal(list.progress[rerun.task.id].state, 'Failed', 'review failure must be visible in task list');
    let calls = 0;
    await withModel(async () => { calls++; return JSON.parse(await readFile(new URL('./fixtures/capability-center-v2/notebook-search/05-review-model-fixture.json', import.meta.url), 'utf8')); }, async () => {
      const recovered = await call('POST', `tasks/${rerun.task.id}/retry-review`);
      assert.equal(recovered.review.outcome, 'Published');
      assert.equal((await call('POST', `tasks/${rerun.task.id}/retry-review`)).alreadyPublished, true);
    });
    assert.equal(calls, 1);
    progress = (await call('GET', `tasks/${rerun.task.id}/progress`)).progress;
    assert.equal(progress.state, 'Published');
    const versions = await call('GET', `capabilities/${progress.capabilityId}/versions`);
    assert.equal(versions.versions.length, 1);
    // A version the 2.0 pipeline published is found from its generation, so a
    // rebuild starts where that generation did and with its values.
    const defaults = await call('GET', `capabilities/${progress.capabilityId}/maintenance-defaults`);
    assert.equal(defaults.sourceTaskId, prepared.task.id);
    assert.equal(typeof defaults.startUrl, 'string');
    assert.deepEqual(defaults.parameters, prepared.task.input.parameters);
    // Rerunning the generation now builds the next version of what it
    // published; as a fresh generation it was set aside as a duplicate name.
    // The fixture leaves the generation running; only an ended task is rerun.
    await cancelTask(siteId, prepared.task.id);
    const rebuild = await call('POST', `tasks/${prepared.task.id}/rerun`);
    assert.equal(rebuild.task.rerunOfTaskId, prepared.task.id);
    assert.equal(rebuild.task.input.trigger.baseVersionId, versions.versions[0].id);
  } finally { await closeFixtureSite(prepared.site); }
});

test('publication is recoverable before task projection is saved, and replay returns the original version after an upgrade', async () => {
  const { publishValidatedCapability, getGenerationPublication } = await import('../db/capability-center-v2-store.ts');
  const input = JSON.parse(await readFile(new URL('./fixtures/capability-center-v2/module-io-harness/bases/c2-input.json', import.meta.url), 'utf8'));
  resetCapabilityCenterV2ForTests();
  const siteId = 'publication-receipt-test';
  const first = await prepareFormalPipeline(siteId, input);
  const command = { generationTaskId: first.task.id, validated: first.validated, authorization: { mode: 'AdminOverride', adminId: 'fixture', reason: 'contract test' } };
  try {
    const initial = await publishValidatedCapability(siteId, command);
    assert.equal(initial.outcome, 'Published');
    assert.equal((await getGenerationPublication(siteId, first.task.id)).version.id, initial.version.id);
    await closeFixtureSite(first.site);
    const upgradeInput = structuredClone(input);
    upgradeInput.candidate.name = "升级搜索能力"; upgradeInput.candidate.description = "升级搜索能力"; upgradeInput.candidate.aliases = [];
    const next = await prepareFormalPipeline(siteId, upgradeInput, { trigger: { baseVersionId: initial.version.id } });
    try {
      const upgraded = await publishValidatedCapability(siteId, { ...command, generationTaskId: next.task.id, validated: next.validated });
      assert.equal(upgraded.outcome, 'Published');
      assert.notEqual(upgraded.version.id, initial.version.id);
      const replay = await publishValidatedCapability(siteId, command);
      assert.equal(replay.version.id, initial.version.id, 'replayed command must not return the newer current version');
      assert.equal(replay.capability.currentVersionId, upgraded.version.id, 'replay must not roll back the active pointer');
    } finally { await closeFixtureSite(next.site); }
  } finally { if (first.site.server.listening) await closeFixtureSite(first.site); }
});


test('database publication compare-and-swap rolls back a concurrent baseline change', async () => {
  const { runD1PublicationRecoveryFixture } = await import('./helpers/capability-v2-d1-transaction-fixture.mjs');
  const result = await runD1PublicationRecoveryFixture();
  assert.equal(result.upgrade.versions.length, 2);
  assert.equal(result.raced.published.outcome, 'WriteConflict');
  assert.equal(result.raced.published.code, 'BASE_VERSION_CHANGED');
  assert.equal(result.raced.reservation.status, 'Active');
  assert.equal(result.versions.length, 3, 'only the two successful versions and the concurrent version survive');
  assert.equal(result.current.current_version_id, 'raced-version');
});

test('the generation record follows its validation task: review failure and publication show on the record the user opened', async () => {
  // The four-step bar on a generation record used to stay on "authoring" forever:
  // validation, review and publication happen on a separate task.
  process.env.SITEWAKE_LOCAL_DEV = '1';
  process.env.CAPABILITY_V2_AUTO_DISPATCH = '0';
  resetCapabilityCenterV2ForTests();
  const siteId = 'progress-chain-test';
  const input = JSON.parse(await readFile(new URL('./fixtures/capability-center-v2/module-io-harness/bases/c2-input.json', import.meta.url), 'utf8'));
  const prepared = await prepareFormalPipeline(siteId, input);
  const call = async (method, path) => {
    const request = new Request('http://localhost/api/admin/capability-v2/' + path, { method, headers: { 'content-type':'application/json', 'x-sitewake-site-id':siteId }, ...(method === 'POST' ? { body: '{}' } : {}) });
    const response = await (method === 'GET' ? GET : POST)(request, { params: { path: path.split('/') } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  try {
    const generationId = prepared.task.id;
    await withModel(() => ({ httpStatus: 500, body: 'temporary_review_failure' }), () => call('POST', `tasks/${prepared.validationTask.id}/retry-review`));
    let progress = (await call('GET', `tasks/${generationId}/progress`)).progress;
    assert.equal(progress.taskId, generationId, 'the record keeps its own id');
    assert.equal(progress.nextTaskId, prepared.validationTask.id);
    assert.equal(progress.phase, 'Review', 'the generation record shows the review phase of its validation task');
    assert.equal(progress.state, 'Failed');
    await withModel(async () => JSON.parse(await readFile(new URL('./fixtures/capability-center-v2/notebook-search/05-review-model-fixture.json', import.meta.url), 'utf8')), () => call('POST', `tasks/${prepared.validationTask.id}/retry-review`));
    progress = (await call('GET', `tasks/${generationId}/progress`)).progress;
    assert.equal(progress.phase, 'Publication');
    assert.equal(progress.state, 'Published');
    const list = await call('GET', 'tasks');
    assert.equal(list.progress[generationId].state, 'Published', 'the task list follows the chain too');
  } finally { await closeFixtureSite(prepared.site); }
});
