import type { CapabilityTask, CapabilityTaskEvent } from './model';

/** Business progress is a projection, never an alternative publication authority. */
export type CapabilityProductionStatus = {
  taskId: string;
  phase: 'Production' | 'Validation' | 'Review' | 'Publication';
  state: 'Queued' | 'Running' | 'WaitingInput' | 'Failed' | 'Rejected' | 'Cancelled' | 'StageCompleted' | 'Published' | 'NeedsAttention';
  message: string;
  code?: string;
  nextTaskId?: string;
  capabilityId?: string;
  versionId?: string;
  recovery: 'None' | 'ProvideInput' | 'RetryProduction' | 'RetryValidation' | 'RetryReview' | 'InspectConflict';
};

export function projectProductionStatus(task: CapabilityTask, events: CapabilityTaskEvent[] = [], now = Date.now()): CapabilityProductionStatus {
  const phase = task.type === 'Validation' ? 'Validation' : 'Production';
  const base: CapabilityProductionStatus = { taskId: task.id, phase, state: 'Queued', message: '等待执行资源', recovery: 'None' };
  // Only the transaction's persisted publication identifiers mean published.
  if (task.input.context.__pipelineVersion === '2.0' && task.result?.capabilityId && task.result?.versionId && task.status === 'Succeeded') return { ...base, phase: 'Publication', state: 'Published', message: '版本已发布，可供新的用户任务使用', capabilityId: task.result.capabilityId, versionId: task.result.versionId };
  if (task.status === 'Cancelled' || task.status === 'Deleted') return { ...base, state: 'Cancelled', message: '任务已停止，已发布版本不受影响', recovery: task.status === 'Deleted' ? 'None' : phase === 'Validation' ? 'RetryValidation' : 'RetryProduction' };
  if (task.status === 'WaitingInput') return { ...base, state: 'WaitingInput', message: '需要补充信息后才能继续', recovery: 'ProvideInput' };
  if (task.status === 'Failed') return { ...base, state: 'Failed', message: task.error?.message || '本次执行未完成，已发布版本不受影响', code: task.error?.code, recovery: phase === 'Validation' ? 'RetryValidation' : 'RetryProduction' };
  if (task.status === 'Running') {
    const lastPhase = [...events].sort((a,b)=>a.sequence-b.sequence).filter(e=>e.eventType==='PhaseChanged').at(-1);
    const stage = String(lastPhase?.payload.phase || '');
    const descriptions: Record<string,string> = {
      Specification:'正在理解原始任务与页面证据', Exploring:'已取得探索路径，准备编写能力',
      Authoring:'正在编写工程文件', Building:'正在构建并检查能力模块',
      DraftReplay:'正在通过真实 SDK 自测，失败会反馈给作者修正',
      CaseGeneration:'正在独立采集证据并编写验收用例',
      AuthoringRestored:'已恢复通过自测的源码，继续独立取证',
      Validating:'正在独立浏览器中验证冻结能力包',
    };
    return {...base,state:'Running',message:descriptions[stage] || (phase==='Validation'?'正在独立浏览器中回放并核验结果':'正在生成程序、采集证据与构建测试用例')};
  }
  if (task.status !== 'Succeeded') return base;
  if (task.result?.validationTaskId) return { ...base, state: 'StageCompleted', message: '候选包已冻结，已交给独立验证', nextTaskId: task.result.validationTaskId };
  if (task.result?.buildResult?.outcome !== 'Validated') return { ...base, state: 'StageCompleted', message: '本阶段已完成；尚无正式发布回执' };
  const last = [...events].sort((a,b) => a.sequence - b.sequence).filter(e => ['ReviewCompleted','ReviewFailed','PublicationFailed','PublicationStarted','ReviewStarted'].includes(e.eventType) || (e.eventType === 'PhaseChanged' && e.payload.phase === 'Reviewing')).at(-1);
  const reason = typeof last?.payload.reason === 'string' ? last.payload.reason : undefined;
  if (last?.eventType === 'PublicationFailed') return { ...base, phase: 'Publication', state: 'Failed', message: reason || '发布未完成', code: String(last.payload.code || 'publication_failed'), recovery: last.payload.conflict === true ? 'InspectConflict' : 'RetryReview' };
  if (last?.eventType === 'ReviewFailed') return { ...base, phase: 'Review', state: 'Failed', message: reason || '审核服务暂不可用', recovery: 'RetryReview' };
  if (last?.eventType === 'ReviewCompleted' && last.payload.decision !== 'Approved') return { ...base, phase: 'Review', state: 'Rejected', message: reason || '审核未通过，请检查证据或重新生成', recovery: 'RetryProduction' };
  const stalled = now - Date.parse(last?.createdAt || task.finishedAt || task.updatedAt) > 10 * 60_000;
  return { ...base, phase: last?.eventType === 'PublicationStarted' || last?.payload.decision === 'Approved' ? 'Publication' : 'Review', state: stalled ? 'NeedsAttention' : 'Running', message: stalled ? '验证已通过，但后续处理长时间没有完成回执，可重新审核并尝试发布' : '验证已通过，正在审核与发布', recovery: stalled ? 'RetryReview' : 'None' };
}
