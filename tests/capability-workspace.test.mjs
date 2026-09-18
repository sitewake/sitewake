import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { CapabilityWorkspace } from '../runner/capability-v2/workspace.ts';
import { executeBrowserCapabilityStage } from '../lib/capability-center-v2/browser-stage-sdk.ts';
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

test('workspace preserves failed revisions, ordered tool receipts and redacts connector credentials',async()=>{
 const w=await CapabilityWorkspace.create();
 try{
  await w.write('task/spec.json',{goal:'查看第三名',password:'private',session:{token:'secret'}});
  const a=await w.revision('export const version=1;');
  const b=await w.revision('export const version=2;');
  await Promise.all([w.event('tool.request',{id:'1'}),w.event('tool.result',{id:'1',error:'read_undeclared'})]);
  const bundle=await w.export();
  assert.equal(bundle.files.filter(f=>f.path.startsWith('revisions/')).length,2);
  assert.notEqual(a,b);
  assert.match(await readFile(w.directory+'/src/capability.ts','utf8'),/version=2/);
  for(const f of bundle.files) assert.equal(f.sha256,createHash('sha256').update(f.content).digest('hex'));
  assert.ok(!JSON.stringify(bundle).includes('private'));
  assert.ok(!JSON.stringify(bundle).includes('secret'));
  assert.deepEqual(bundle.files.filter(f=>f.path.startsWith('events/')).map(f=>JSON.parse(f.content).kind),['tool.request','tool.result']);
  await assert.rejects(w.write('../escape','bad'),/workspace_path_invalid/);
 }finally{await rm(w.directory,{recursive:true,force:true});}
});

test('SDK and Playwright execute the identical kernel and enforce the same input boundary',async()=>{
 const browser=await chromium.launch();
 try{
  const page=await browser.newPage();
  const code='export const capability={stages:[{run:({input})=>({outcome:"Success",output:{rank:input.rank}})}]};';
  await page.route('http://sdk.test/**',route=>route.fulfill({contentType:route.request().url().endsWith('.js')?'text/javascript':'text/html',body:route.request().url().endsWith('.js')?code:'<h1>test</h1>'}));
  await page.goto('http://sdk.test/');
  const payload={moduleUrl:'http://sdk.test/module.js',index:0,input:{rank:3},state:{},inputPaths:['rank'],statePaths:[],stageId:'open',deadlineAt:new Date(Date.now()+5000).toISOString()};
  const actual=await page.evaluate(executeBrowserCapabilityStage,JSON.stringify(payload));
  const sdk=await executeBrowserCapabilityStage({...payload,run:({input})=>({outcome:'Success',output:{rank:input.rank}})});
  assert.deepEqual(actual,sdk);
  await assert.rejects(page.evaluate(executeBrowserCapabilityStage,JSON.stringify({...payload,inputPaths:[]})),/input_read_undeclared:open:rank/);
  await assert.rejects(executeBrowserCapabilityStage({...payload,inputPaths:[],run:({input})=>input.rank}),/input_read_undeclared:open:rank/);
 }finally{await browser.close();}
});

test('workspace export refuses path traversal and corrupt file hashes before writing content', async()=>{
 const {spawn}=await import('node:child_process');const {mkdtemp,writeFile}=await import('node:fs/promises');const {tmpdir}=await import('node:os');
 const root=await mkdtemp(tmpdir()+'/workspace-cli-');
 try{
  const exportFile=root+'/bad.json';
  await writeFile(exportFile,JSON.stringify({schemaVersion:'capability-workspace.v1',files:[{path:'../outside',content:'bad',sha256:'bad'}]}));
  const code=await new Promise(resolve=>{const child=spawn(process.execPath,['--import','tsx','scripts/capability-workspace.mjs','unpack',exportFile,'--out',root+'/project'],{stdio:'ignore'});child.on('exit',resolve);});
  assert.notEqual(code,0);
  await assert.rejects(readFile(root+'/outside'),/ENOENT/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a frozen SDK capability continues in a new document through host-managed navigation',async()=>{
 const {createServer}=await import('node:http');
 const {runCapabilityJavaScriptStages}=await import('../runner/capability-v2/javascript-stage-runner.ts');
 const {capabilityModuleHash}=await import('../lib/capability-center-v2/javascript-runtime.ts');
 const module=`export const capability={version:2,stages:[
 {id:'open',io:{reads:{input:[],state:[]},writes:{state:['selected'],output:[]}},navigation:'required',run(){const target=document.querySelector('a');return {outcome:'Continue',state:{selected:target.textContent},navigation:{url:target.href,target:'_self'}}}},
 {id:'verify',io:{reads:{input:[],state:['selected']},writes:{state:[],output:['title']}},navigation:'none',run({state}){const title=document.querySelector('h1').textContent;return title===state.selected?{outcome:'Success',output:{title}}:{outcome:'NoResult',reason:'wrong detail'}}}
 ]};`;
 const hash=await capabilityModuleHash(module);
 const server=createServer((req,res)=>{
  if(req.url.startsWith('/api/')){res.writeHead(200,{'content-type':'text/javascript'});return res.end(module);}
  res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(req.url==='/detail'?'<h1>第三个话题</h1>':'<a href="/detail">第三个话题</a>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;const browser=await chromium.launch();
 try{
  const page=await browser.newPage();await page.goto(origin);
  const program={schemaVersion:'2.0',runtime:'BrowserJavaScriptStage',entry:{mode:'CurrentPage'},module:{contentHash:hash,moduleUrl:'/api/capability-v2/modules/'+hash,exportName:'capability'},stages:[
   {id:'open',title:'打开详情',purpose:'进入详情页',effect:'read',resumePolicy:'skip-completed',io:{reads:{input:[],state:[]},writes:{state:['selected'],output:[]}},navigation:'required'},
   {id:'verify',title:'核对话题',purpose:'读取新页面',effect:'read',resumePolicy:'skip-completed',io:{reads:{input:[],state:['selected']},writes:{state:[],output:['title']}},navigation:'none'}
  ],parameterRoles:[],targetBindings:[],promptProvenance:[]};
  const result=await runCapabilityJavaScriptStages({page,moduleUrl:new URL(program.module.moduleUrl,origin).href,program,input:{}});
  assert.equal(result.outcome,'Success');assert.equal(result.output.title,'第三个话题');
  assert.equal(page.url(),origin+'/detail');
  assert.equal(result.receipts.filter(r=>r.status==='Completed').length,2);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
