import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { getTask, getTaskArtifact, listTaskArtifacts } from './capability-center-v2-store';
import { decodeC1AuthoringOutput } from '../lib/capability-center-v2/case-generation';
import { capabilityModuleHash } from '../lib/capability-center-v2/javascript-runtime';

/** Restore only a prior attempt owned by the same task lineage and site. */
export async function loadAuthorCheckpoint(siteId: string, taskId: string) {
  const task = await getTask(siteId,taskId,true);
  if (!task?.rerunOfTaskId) return null;
  const parent = await getTask(siteId,task.rerunOfTaskId,true);
  if (!parent || parent.deletedAt || parent.type === 'Validation' || parent.goal !== task.goal || parent.guidance !== task.guidance || JSON.stringify(parent.input.parameters) !== JSON.stringify(task.input.parameters)) return null;
  const artifacts = (await listTaskArtifacts(siteId,parent.id)).filter(a => a.contentType.startsWith('application/vnd.sitewake.workspace')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  for (const artifact of artifacts) {
    const stored = await getTaskArtifact(siteId,artifact.id);
    if (!stored) continue;
    const bytes = Buffer.from(await new Response(('stream' in stored ? stored.stream : stored.bytes) as BodyInit).arrayBuffer());
    const bundle = JSON.parse(gunzipSync(bytes,{maxOutputLength:32*1024*1024}).toString());
    if (bundle.schemaVersion !== 'capability-workspace.v1' || !Array.isArray(bundle.files)) throw new Error('workspace_schema_invalid');
    const runtimeFile = bundle.files.find((file: {path:string})=>file.path==='context/runtime.json');
    if (!runtimeFile || createHash('sha256').update(runtimeFile.content).digest('hex') !== runtimeFile.sha256) return null;
    const runtime = JSON.parse(runtimeFile.content);
    if (runtime.target !== 'browser-sdk' || runtime.kernelVersion !== '2') return null;
    const item = bundle.files.find((file: {path:string})=>file.path==='reports/c1-checkpoint.json');
    if (!item) continue;
    if (createHash('sha256').update(item.content).digest('hex') !== item.sha256) throw new Error('workspace_checkpoint_integrity_failed');
    const checkpoint = JSON.parse(item.content);
    const authored = checkpoint.authored;
    const c1 = decodeC1AuthoringOutput(authored.c1AuthoringOutput);
    if (c1.generationTaskId !== parent.id || await capabilityModuleHash(authored.candidateBundle) !== c1.program.module.contentHash) throw new Error('workspace_checkpoint_identity_mismatch');
    return {...authored,c1AuthoringOutput:{...c1,generationTaskId:task.id},artifactRefs:[]};
  }
  return null;
}
