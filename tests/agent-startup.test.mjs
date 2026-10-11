import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

// The widget links its stylesheet from the control plane: an injected <style>
// is refused by `style-src 'self'`, so nothing in the shadow root is clickable
// until the fixture serves the sheet the way the control plane does. Without it
// `pointer-events` never turns back on and the send button cannot be clicked.
const sdkCss=await readFile(new URL('../public/sitewake.css',import.meta.url),'utf8');

// Exercise the actual new-task entry point, not just runMainAgent after startup.
test('new task startup revalidates release and never damages the previous run on failure',async()=>{
 const bundle=await build({stdin:{contents:`export {AgentPort} from './client/user-agent-port'; export {RuntimeReleaseClient,AgentStartupError} from './client/runtime-release-client'; export {SITE_AGENT_SCHEMA_VERSION} from './lib/site-knowledge/protocol';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'iife',globalName:'Startup',write:false,platform:'browser'});
 const browser=await chromium.launch();
 const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><title>Startup fixture</title>')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const page=await browser.newPage({locale:"zh-CN"});await page.goto('http://127.0.0.1:'+server.address().port);await page.addScriptTag({content:bundle.outputFiles[0].text});
  const result=await page.evaluate(async()=>{
   const release={schemaVersion:Startup.SITE_AGENT_SCHEMA_VERSION,siteAgentId:'fixture',id:'release-1',version:1,scenes:[],operations:[],capabilities:[]};
   const cache=new Startup.RuntimeReleaseClient();let headers=[],bodies=0;
   const request=async(url,init)=>{headers.push(init.headers||{});if(init.headers?.['if-none-match']==='"v1"')return new Response(null,{status:304});bodies++;return new Response(JSON.stringify({release}),{headers:{etag:'"v1"'}})};
   const first=await cache.read('/release?runtime=1',request);const second=await cache.read('/release?runtime=1',request);
   const pinned=await cache.read('/release?runtime=1&releaseId=frozen',request);
   let revalidationError='';try{await cache.read('/release?runtime=1',async()=>{throw Error('Failed to fetch')})}catch(e){revalidationError=e.message}
   const updated=await cache.read('/release?runtime=1',async()=>new Response(JSON.stringify({release:{...release,id:'release-2',version:2}}),{headers:{etag:'"v2"'}}));
   const cases=[];
   for(const phase of ['readiness','release','create','success']){
    const port=Object.create(Startup.AgentPort.prototype);let createCount=0,loopCount=0,patchCount=0,finishCount=0;
    // `run` records the task's generation per session before handing over to
    // the main loop. Without the map the success case throws inside `run`'s
    // own body and lands in the failure branch, which then marks the
    // *previous* run failed — the very damage this test is about.
    Object.assign(port,{taskGeneration:0,taskGenerations:new Map(),activeSession:{id:'old-run',status:'completed'},
     ready:async()=>{if(phase==='readiness')throw Error('Failed to fetch')},
     refresh:async()=>{if(phase==='release')throw Error('fetch_timeout_after_5000ms')},
     createSession:async()=>{createCount++;if(phase==='create')throw Error('agent_run_origin_rejected');return {id:'new-run'}},
     acquireLease:()=>true,runMainAgent:async()=>{loopCount++;return 'finished'},
     patchSession:async()=>{patchCount++},finishRun:async()=>{finishCount++}
    });
    let result;try{result=await port.run('open third')}catch(e){result={phase:e.phase,code:e.code,id:e.diagnosticId,startup:e instanceof Startup.AgentStartupError}}
    cases.push({phase,result,createCount,loopCount,patchCount,finishCount,inFlight:port.taskInFlight===true});
   }
   return {headers,bodies,same:first.release===second.release,pinned:pinned.release.id,updated:updated.release.version,revalidationError,cases};
  });
  assert.equal(result.bodies,2,'one full download per exact release projection');assert.equal(result.same,true);
  assert.deepEqual(result.headers,[{}, {'if-none-match':'"v1"'},{}]);assert.equal(result.updated,2);assert.equal(result.revalidationError,'Failed to fetch','do not execute a stale cache when revalidation fails');
  for(const row of result.cases){assert.equal(row.patchCount,0);assert.equal(row.finishCount,0);assert.equal(row.inFlight,false);if(row.phase==='success'){assert.equal(row.result,'finished');assert.equal(row.loopCount,1)}else{assert.equal(row.result.startup,true);assert.equal(row.result.phase,row.phase);assert.match(row.result.id,/^startup_/);assert.equal(row.loopCount,0)}}
 }finally{await browser.close();await new Promise(r=>server.close(r))}
});

test('complete widget reports pre-run failure without teaching or model execution',async()=>{
 const bundle=await build({entryPoints:['client/user-agent-client.ts'],bundle:true,format:'iife',write:false,platform:'browser'});
 const release={schemaVersion:'site-agent.v2',id:'fixture:release:1',siteAgentId:'fixture',version:1,contentHash:'1',profile:{name:'Fixture',description:'',vocabulary:{},suggestedGoals:[]},scenes:[],targets:[],operations:[],capabilities:[],outcomes:[],sourceEpisodeIds:[]};
 let releaseDownloads=0,revalidations=0,created=0;const diagnostics=[],requests=[];
 const server=createServer(async(req,res)=>{
  requests.push(req.url);
  if(req.url==='/sdk.js'){res.setHeader('content-type','text/javascript; charset=utf-8');return res.end(bundle.outputFiles[0].text)}
  if(req.url==='/sitewake.css'){res.setHeader('content-type','text/css; charset=utf-8');return res.end(sdkCss)}
  if(req.url==='/'){res.setHeader('content-type','text/html; charset=utf-8');return res.end('<!doctype html><meta charset="utf-8"><script src="/sdk.js" data-site-agent="fixture" data-open="true"></script>')}
  res.setHeader('content-type','application/json');
  if(req.url.includes('/release?')){if(req.headers['if-none-match']==='"release-1"'){revalidations++;res.writeHead(304);return res.end()}releaseDownloads++;res.setHeader('etag','"release-1"');return res.end(JSON.stringify({release}))}
  if(req.url==='/api/agent-runs'){created++;res.writeHead(503);return res.end('{"error":"service_temporarily_unavailable"}')}
  if(req.url.endsWith('/effects/events')){let body='';for await(const c of req)body+=c;const event=JSON.parse(body);if(event.type==='runtime-startup-failed')diagnostics.push(event);return res.end('{"accepted":true}')}
  res.end(JSON.stringify({release,items:[]}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 try{
  const page=await browser.newPage({locale:"zh-CN"});await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.SiteWake?.getRelease().version===1);
  await page.locator('textarea[name=goal]').fill('打开第三个热搜');await page.locator('button.send').click();
  await page.waitForFunction(()=>document.querySelector('[data-sitewake-agent="widget"]').shadowRoot.textContent.includes('startup_'));
  const text=await page.locator('.message-row.error').innerText();assert.match(text,/尚未开始/);assert.match(text,/尚未操作网页/);assert.doesNotMatch(text,/我操作一次给你看|执行中断/);
  assert.equal(releaseDownloads,1);assert.equal(revalidations,1);assert.equal(created,1,JSON.stringify({diagnostics,text,requests}));assert.equal(requests.some(p=>p.includes('/chat/completions')),false);
  await new Promise((resolve,reject)=>{const start=Date.now();const check=()=>diagnostics.length?resolve():Date.now()-start>2000?reject(Error('diagnostic_not_received')):setTimeout(check,10);check()});
  assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].metadata.phase,'create');assert.equal(diagnostics[0].metadata.code,'service_temporarily_unavailable');assert.doesNotMatch(JSON.stringify(diagnostics),/打开第三|authorization/);
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
});
