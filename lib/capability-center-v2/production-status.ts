import { attributeTaskFailure, classifyFailure, type FailureClass } from './failure-class';
import type { CapabilityTask, CapabilityTaskEvent } from './model';

/**
 * What the progress line says, named rather than written.
 *
 * A projection runs on the server, where the reader's language is not known:
 * the same task is opened by administrators in either language. It names the
 * state it found and the console words it, the way a failure names a code and
 * the console words that.
 */
export type ProductionMessageKey =
  | 'queued'
  | 'published'
  | 'publishedSuperseded'
  | 'cancelled'
  | 'waitingInput'
  | 'failed'
  | 'runningSpecification'
  | 'runningExploring'
  | 'runningAuthoring'
  | 'runningBuilding'
  | 'runningDraftReplay'
  | 'runningCaseGeneration'
  | 'runningAuthoringRestored'
  | 'runningAuthoringRestoreRejected'
  | 'runningValidating'
  | 'runningValidation'
  | 'runningProduction'
  | 'stageCompletedValidationQueued'
  | 'stageCompletedNoReceipt'
  | 'publicationFailed'
  | 'reviewUnavailable'
  | 'reviewRejected'
  | 'repairScheduled'
  | 'reviewStalled'
  | 'reviewRunning';

/** Business progress is a projection, never an alternative publication authority. */
export type CapabilityProductionStatus = {
  taskId: string;
  phase: 'Production' | 'Validation' | 'Review' | 'Publication';
  state: 'Queued' | 'Running' | 'WaitingInput' | 'Failed' | 'Rejected' | 'Cancelled' | 'StageCompleted' | 'Published' | 'NeedsAttention';
  messageKey: ProductionMessageKey;
  /**
   * What was written elsewhere and is not ours to word: a reviewer's reason, a
   * publication failure's reason, or the name of the capability that published
   * first. Shown beside the worded state, never instead of it.
   */
  detail?: string;
  code?: string;
  failureClass?: FailureClass;
  failureStage?: string;
  nextTaskId?: string;
  capabilityId?: string;
  versionId?: string;
  recovery: 'None' | 'ProvideInput' | 'RetryProduction' | 'RetryValidation' | 'RetryReview' | 'InspectConflict';
};

/** The authoring phase a `PhaseChanged` event names, as a key of its own. */
const RUNNING_STAGE_KEYS: Record<string, ProductionMessageKey> = {
  Specification: 'runningSpecification',
  Exploring: 'runningExploring',
  Authoring: 'runningAuthoring',
  Building: 'runningBuilding',
  DraftReplay: 'runningDraftReplay',
  CaseGeneration: 'runningCaseGeneration',
  AuthoringRestored: 'runningAuthoringRestored',
  AuthoringRestoreRejected: 'runningAuthoringRestoreRejected',
  Validating: 'runningValidating',
};

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function projectProductionStatus(task: CapabilityTask, events: CapabilityTaskEvent[] = [], now = Date.now()): CapabilityProductionStatus {
  const phase = task.type === 'Validation' ? 'Validation' : 'Production';
  const base: CapabilityProductionStatus = { taskId: task.id, phase, state: 'Queued', messageKey: 'queued', recovery: 'None' };
  // Only the transaction's persisted publication identifiers mean published.
  if (task.input.context.__pipelineVersion === '2.0' && task.result?.capabilityId && task.result?.versionId && task.status === 'Succeeded') return { ...base, phase: 'Publication', state: 'Published', messageKey: 'published', capabilityId: task.result.capabilityId, versionId: task.result.versionId };
  if (task.status === 'Cancelled' || task.status === 'Deleted') return { ...base, state: 'Cancelled', messageKey: 'cancelled', recovery: task.status === 'Deleted' ? 'None' : phase === 'Validation' ? 'RetryValidation' : 'RetryProduction' };
  if (task.status === 'WaitingInput') return { ...base, state: 'WaitingInput', messageKey: 'waitingInput', recovery: 'ProvideInput' };
  // The failure's own code is what the console words; `message` carries the
  // code too, so there is nothing here worth passing through as detail.
  if (task.status === 'Failed') {
    const attribution = task.error ? { failureClass: task.error.failureClass, failureStage: task.error.failureStage, ...(task.error.failureClass ? {} : attributeTaskFailure(task)) } : undefined;
    return { ...base, state: 'Failed', messageKey: 'failed', code: task.error?.code, ...attribution, recovery: phase === 'Validation' ? 'RetryValidation' : 'RetryProduction' };
  }
  if (task.status === 'Running') {
    const lastPhase = [...events].sort((a, b) => a.sequence - b.sequence).filter(e => e.eventType === 'PhaseChanged').at(-1);
    const stage = String(lastPhase?.payload.phase || '');
    const fallback: ProductionMessageKey = phase === 'Validation' ? 'runningValidation' : 'runningProduction';
    return { ...base, state: 'Running', messageKey: RUNNING_STAGE_KEYS[stage] || fallback };
  }
  if (task.status !== 'Succeeded') return base;
  if (task.result?.validationTaskId) return { ...base, state: 'StageCompleted', messageKey: 'stageCompletedValidationQueued', nextTaskId: task.result.validationTaskId };
  if (task.result?.buildResult?.outcome !== 'Validated') return { ...base, state: 'StageCompleted', messageKey: 'stageCompletedNoReceipt' };
  const last = [...events].sort((a, b) => a.sequence - b.sequence).filter(e => ['ReviewCompleted', 'ReviewFailed', 'PublicationFailed', 'PublicationSuperseded', 'PublicationStarted', 'ReviewStarted', 'RepairScheduled'].includes(e.eventType) || (e.eventType === 'PhaseChanged' && e.payload.phase === 'Reviewing')).at(-1);
  const reason = text(last?.payload.reason);
  // Another generation of the same capability published first: what the user
  // asked for is available, so this is the done state, not a failure.
  if (last?.eventType === 'PublicationSuperseded') return { ...base, phase: 'Publication', state: 'Published', messageKey: 'publishedSuperseded', detail: text(last.payload.capabilityName), capabilityId: text(last.payload.capabilityId), versionId: text(last.payload.versionId) };
  if (last?.eventType === 'PublicationFailed') {
    const code = String(last.payload.code || 'publication_failed');
    return { ...base, phase: 'Publication', state: 'Failed', messageKey: 'publicationFailed', detail: reason, code, failureClass: classifyFailure({ code, message: reason }), failureStage: 'Publication', recovery: last.payload.conflict === true ? 'InspectConflict' : 'RetryReview' };
  }
  if (last?.eventType === 'ReviewFailed') return { ...base, phase: 'Review', state: 'Failed', messageKey: 'reviewUnavailable', detail: reason, failureClass: classifyFailure({ code: 'review_failed', message: reason }), failureStage: 'Review', recovery: 'RetryReview' };
  // The verdict rejected it and a second authoring was started from the
  // failure: the record runs on, into that task.
  if (last?.eventType === 'RepairScheduled') return { ...base, phase: 'Review', state: 'Running', messageKey: 'repairScheduled', detail: reason, nextTaskId: text(last.payload.repairTaskId), recovery: 'None' };
  if (last?.eventType === 'ReviewCompleted' && last.payload.decision !== 'Approved') return { ...base, phase: 'Review', state: 'Rejected', messageKey: 'reviewRejected', detail: reason, recovery: 'RetryProduction' };
  const stalled = now - Date.parse(last?.createdAt || task.finishedAt || task.updatedAt) > 10 * 60_000;
  return { ...base, phase: last?.eventType === 'PublicationStarted' || last?.payload.decision === 'Approved' ? 'Publication' : 'Review', state: stalled ? 'NeedsAttention' : 'Running', messageKey: stalled ? 'reviewStalled' : 'reviewRunning', recovery: stalled ? 'RetryReview' : 'None' };
}
