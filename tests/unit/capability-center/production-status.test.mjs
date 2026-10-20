import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectProductionStatus } from '../../../lib/capability-center-v2/production-status.ts';
const now = Date.now();
const task = { id: 'v', type: 'Validation', status: 'Succeeded', updatedAt: new Date(now).toISOString(), input: { context: { __pipelineVersion: '2.0' } }, result: { outcome: 'Success', buildResult: { outcome: 'Validated', package: {} } } };
const event = (eventType, payload = {}, sequence = 1) => ({ eventType, payload, sequence, createdAt: new Date(now).toISOString() });
test('validation success never means published', () => {
  assert.equal(projectProductionStatus(task).state, 'Running');
  assert.equal(projectProductionStatus({ ...task, type: 'Discovery', result: { validationTaskId: 'next' } }).nextTaskId, 'next');
});
test('review failure retries review; rejection requires a new candidate', () => {
  assert.equal(projectProductionStatus(task, [event('ReviewFailed', { reason: 'timeout' })]).recovery, 'RetryReview');
  assert.equal(projectProductionStatus(task, [event('ReviewCompleted', { decision: 'Rejected' })]).recovery, 'RetryProduction');
});
test('new attempt supersedes the old failure, regardless of event ordering', () => {
  assert.equal(projectProductionStatus(task, [event('ReviewStarted', {}, 2), event('ReviewFailed')]).state, 'Running');
});
test('publication conflict does not offer blind publication retry', () => {
  const state = projectProductionStatus(task, [event('PublicationFailed', { conflict: true, code: 'BASE_VERSION_CHANGED' })]);
  assert.equal(state.phase, 'Publication'); assert.equal(state.recovery, 'InspectConflict');
});
test('stalled review has an explicit recovery; waiting input is not failure', () => {
  assert.equal(projectProductionStatus(task, [], now + 11 * 60_000).recovery, 'RetryReview');
  assert.equal(projectProductionStatus({ ...task, status: 'WaitingInput' }).recovery, 'ProvideInput');
});
test('published projection overrides stale errors; failures retry the correct module', () => {
  assert.equal(projectProductionStatus({ ...task, result: { capabilityId: 'cap', versionId: 'ver' } }, [event('ReviewFailed')]).state, 'Published');
  assert.equal(projectProductionStatus({ ...task, status: 'Failed' }).recovery, 'RetryValidation');
  assert.equal(projectProductionStatus({ ...task, type: 'Discovery', status: 'Failed' }).recovery, 'RetryProduction');
});
test('a generation superseded by an earlier publication of the same capability is done, not failed', () => {
  const state = projectProductionStatus(task, [event('PublicationStarted', {}, 1), event('PublicationSuperseded', { phase: 'Published', capabilityId: 'cap', versionId: 'ver', capabilityName: '查询记录', message: 'publication superseded' }, 2)]);
  assert.equal(state.phase, 'Publication');
  assert.equal(state.state, 'Published');
  assert.equal(state.capabilityId, 'cap');
  assert.equal(state.versionId, 'ver');
  assert.equal(state.code, undefined, 'no error number for a capability that is available');
  assert.equal(state.recovery, 'None');
  assert.equal(state.messageKey, 'publishedSuperseded', 'the console words the outcome');
  assert.equal(state.detail, '查询记录', 'the name of the capability that published first is data, not copy');
});

test('the projection names states and never writes prose', async () => {
  // The projector runs on the server, where the reader's language is unknown.
  const source = await (await import('node:fs/promises')).readFile(new URL('../../../lib/capability-center-v2/production-status.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /[\u4e00-\u9fff]/, 'the projector carries no copy of its own');
  const cases = [
    [{ ...task, status: 'Running' }, []],
    [{ ...task, status: 'Running' }, [event('PhaseChanged', { phase: 'DraftReplay' })]],
    [{ ...task, status: 'Failed' }, []],
    [{ ...task, status: 'WaitingInput' }, []],
    [{ ...task, status: 'Cancelled' }, []],
    [task, [event('ReviewFailed', { reason: 'timeout' })]],
    [task, [event('ReviewCompleted', { decision: 'Rejected', reason: 'no evidence' })]],
    [task, [event('PublicationFailed', { code: 'X', reason: 'conflict' })]],
  ];
  for (const [input, events] of cases) {
    const state = projectProductionStatus(input, events);
    assert.equal(typeof state.messageKey, 'string');
    assert.doesNotMatch(state.messageKey, /\s/, `${state.messageKey} is a key, not a sentence`);
    if (state.detail !== undefined) assert.equal(typeof state.detail, 'string');
  }
});
