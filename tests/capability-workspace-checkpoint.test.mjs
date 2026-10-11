import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {capabilityModuleHash} from '../lib/capability-center-v2/javascript-runtime.ts';

const source=await build({entryPoints:['db/capability-workspace-checkpoint.ts'],bundle:true,format:'esm',platform:'node',write:false,plugins:[{name:'checkpoint-store',setup(b){b.onLoad({filter:/db\/capability-center-v2-store\.ts$/},()=>({contents:`export const getTask=(site,id)=>globalThis.checkpointDB.tasks.find(t=>t.siteId===site&&t.id===id);export const listTaskArtifacts=()=>globalThis.checkpointDB.artifacts;export const getTaskArtifact=()=>globalThis.checkpointDB.stored;`,loader:'js'}));}}]});
const {loadAuthorCheckpoint}=await import('data:text/javascript;base64,'+Buffer.from(source.outputFiles[0].text).toString('base64'));

test('C2 retries reuse only an integrity-checked C1 checkpoint from the same site and unchanged task',async()=>{
 const candidate=JSON.parse(await readFile('tests/fixtures/capability-center-v2/notebook-search/02-c2-input.json','utf8')).candidate;
 const code='export const capability={version:2,stages:[]};';
 candidate.program.module.contentHash=await capabilityModuleHash(code);
 candidate.program.module.moduleUrl='/api/capability-v2/modules/'+candidate.program.module.contentHash;
 const c1={generationTaskId:'parent',...candidate};
 const content=JSON.stringify({authored:{c1AuthoringOutput:c1,candidateBundle:code}});
 const file={path:'reports/c1-checkpoint.json',content,sha256:createHash('sha256').update(content).digest('hex')};
 const runtimeContent=JSON.stringify({target:'browser-sdk',kernelVersion:'2'});
 const runtimeFile={path:'context/runtime.json',content:runtimeContent,sha256:createHash('sha256').update(runtimeContent).digest('hex')};
 const bytes=()=>gzipSync(Buffer.from(JSON.stringify({schemaVersion:'capability-workspace.v1',files:[file,runtimeFile]})));
 const parent={id:'parent',siteId:'site',type:'Discovery',goal:'search',guidance:'',input:{parameters:{query:'notebook'}}};
 const task={...parent,id:'retry',rerunOfTaskId:'parent'};
 globalThis.checkpointDB={tasks:[parent,task],artifacts:[{id:'artifact',createdAt:'2026-09-06',contentType:'application/vnd.sitewake.workspace+json+gzip'}],stored:{bytes:bytes()}};
 try{
  assert.equal((await loadAuthorCheckpoint('site','retry')).c1AuthoringOutput.generationTaskId,'retry');
  assert.equal(await loadAuthorCheckpoint('other-site','retry'),null);
  task.goal='different';assert.equal(await loadAuthorCheckpoint('site','retry'),null);task.goal=parent.goal;
  file.sha256='corrupt';globalThis.checkpointDB.stored.bytes=bytes();
  await assert.rejects(loadAuthorCheckpoint('site','retry'),/workspace_checkpoint_integrity_failed/);
 }finally{delete globalThis.checkpointDB;}
});
