import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {runCapabilityJavaScriptStages} from '../runner/capability-v2/javascript-stage-runner.ts';

// Protocol fixture only: the model choice and durable storage are deterministic.
// The main loop, runtime HTTP request, module fetch/hash/import, stage execution,
// navigation decision, document reload and resumeCheckpoint are production code.
const bootstrap = `
import {AgentPort} from './client/user-agent-port';
const config=window.fixture;
const session={id:'fixture-run',goal:'点开第三个热搜',input:{},conversation:[],status:'running'};
const port=Object.create(AgentPort.prototype);
const save=(key,value)=>value===undefined?sessionStorage.removeItem(key):sessionStorage.setItem(key,JSON.stringify(value));
const read=key=>JSON.parse(sessionStorage.getItem(key)||'null');
Object.assign(port,{
 release:{capabilities:[],scenes:[],navigationTools:[],operations:[],profile:{name:'热搜时光机'}},taskGenerations:new Map(),taskGeneration:0,
 options:{siteAgentId:'fixture',endpoint:config.api,runtimeMode:'full'},sequence:0,activityTimeline:read('activities')||[],activeSession:session,activeAbort:new AbortController(),
 capabilityAllowed:()=>true,assertCapabilityAllowed:()=>{},requireAgentRunToken:()=> 'fixture-token',readRunPointer:()=>({resumeToken:'fixture-token'}),
 acquireLease:()=>true,releaseLease:()=>{},executionPinFrom:()=>undefined,session:async()=>session,
 armNavigationIntent:async()=>{sessionStorage.setItem("arms",String(Number(sessionStorage.getItem("arms")||0)+1));sessionStorage.setItem("grant","1");sessionStorage.setItem("armedCheckpoint",sessionStorage.getItem("checkpoint")||"null");},clearNavigationIntent:(force)=>{if(force)sessionStorage.removeItem("grant");},prepareRunHandoff:async url=>{sessionStorage.setItem("handoffs",String(Number(sessionStorage.getItem("handoffs")||0)+1));const armed=sessionStorage.getItem("armedCheckpoint");if(armed&&armed!=="null")sessionStorage.setItem("checkpoint",armed);return url;},
 storeCheckpointLocally:cp=>save('checkpoint',cp),
 saveCheckpoint(cp){if(cp)cp.activityTimeline=this.activityTimeline;save('checkpoint',cp);},readCheckpoint:()=>read('checkpoint'),
 flushCheckpoint:async()=>{throw Error('duplicate_checkpoint_roundtrip')},patchSession:async(_,patch)=>{if(config.slow)await new Promise(r=>setTimeout(r,1500));window.projectionComplete=true;return {...session,...patch};},
 status(phase,message,detail={}){if(detail.activity){const a=detail.activity;this.activityTimeline=this.activityTimeline.filter(i=>i.id!==a.id).concat(a);save('activities',this.activityTimeline);}window.lastStatus={phase,message};},
 finishRun:async(status,outcome,output,text)=>{const result={status,outcome,output,text,activities:read('activities'),projectionComplete:Boolean(window.projectionComplete),timings:port.runtimeTimings,clicks:Number(sessionStorage.getItem('clicks')||0)};save('result',result);await fetch(config.api+'/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(result)});window.result=result;},
});
if(config.observe){port.readRunPointer=()=>({resumeToken:'fixture-token',runId:'fixture-run'});port.nativeWindowOpen=window.open.bind(window);port.submitObservation=async()=>undefined;port.installObserver();}
window.port=port;
const cp=read('checkpoint');
window.start=()=>port.runMainAgent(session);
if(cp&&sessionStorage.getItem('grant')){sessionStorage.removeItem('grant');port.resumeCheckpoint().catch(e=>window.fatal=String(e));}
else if(cp){save('checkpoint');window.fatal='stranded: the destination had no continuation grant';}
`;
const listen = s=>new Promise(resolve=>s.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+s.address().port)));
const close = s=>new Promise(resolve=>{s.closeAllConnections();s.close(resolve)});

function artifact(mode){
 const stages=[{id:'click',title:'打开条目',effect:'write',resumePolicy:'reconcile-before-retry',navigation:'optional',io:{reads:{input:mode==='link'?['rank','via']:['rank'],state:[]},writes:{state:[],output:[]}}},{id:'verify',title:'验证结果',effect:'read',resumePolicy:'skip-completed',navigation:'none',io:{reads:{input:['rank'],state:[]},writes:{state:[],output:['pageUrl','rank','targetTitle']}}}];
 const source=`export const capability={version:2,stages:[{...${JSON.stringify(stages[0])},async run({input}){
 if(input.rank>3)return {outcome:'NoResult',reason:'排名不存在'};
 ${mode==='link'?`
 // A seeded Stage: click the link the explorer clicked, then wait for the page to change.
 if(input.via!=='link')throw Error('default_input_missing:'+input.via);
 const before=location.href;document.querySelector('#open').click();
 await new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(location.href!==before){clearInterval(timer);resolve();}else if(Date.now()-started>3000){clearInterval(timer);reject(Error('link_click_never_navigated'));}},25);});
 return {outcome:'Continue'};`:''}
 document.querySelector('[data-rank="'+input.rank+'"]').click();
 ${mode==='failure'?"throw Error('fixture_execution_failed');":''}

 return {outcome:'Continue'${mode==='plain'||mode==='native'||mode==='link'?'':",navigation:{url:"+(mode==='hard'||mode==='entry-hard'?"new URL('/detail?rank='+input.rank,location.href).href":'location.href')+",target:'_self'}"}};
 }},{...${JSON.stringify(stages[1])},async run({input}){
 // Like an authored verify Stage: wait for the result to be on the page. In
 // 'native' this wait spans the document navigation the click started.
 await new Promise((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(document.querySelector('#detail')?.textContent===String(input.rank)){clearInterval(timer);resolve();}else if(Date.now()-started>3000){clearInterval(timer);reject(Error('wrong_detail'));}},25);});
 return {outcome:'Success',output:{pageUrl:location.href,rank:input.rank,targetTitle:document.querySelector('#topic-title').textContent}};
 }}]};`;
 return {source,stages,hash:createHash('sha256').update(source).digest('hex')};
}

test('published capability executes and terminates through the real SDK across browser states', {timeout:60000},async t=>{
 const bundled=await build({stdin:{contents:bootstrap,loader:'ts',resolveDir:process.cwd()},bundle:true,format:'iife',platform:'browser',write:false});
 const browser=await chromium.launch();
 try{for(const mode of ['plain','spa','hash','hard','entry-hard','native','link','entry-hash','slow-network','failure','no-result','integrity'])await t.test(mode,async()=>{
  const module=artifact(mode);let modelCalls=0,results=[],receipts=[],moduleRequests=0;
  const runtime={capabilityId:'rank',versionId:'v1',name:'按排名打开热搜',contract:{intent:'按排名打开热搜',inputSchema:{type:'object',properties:{rank:{type:'number'},...(mode==='link'?{via:{type:'string',default:'link'}}:{})},required:['rank']},outputSchema:{type:'object',properties:{pageUrl:{type:'string'},rank:{type:'number',title:'请求序号'},targetTitle:{type:'string',minLength:1}},required:['pageUrl','rank','targetTitle']},successConditions:[{type:'outputExists',path:'pageUrl'}]},program:{schemaVersion:'2.0',runtime:'BrowserJavaScriptStage',entry:{mode:'CurrentPage'},stages:module.stages,module:{contentHash:mode==='integrity'?'0'.repeat(64):module.hash,moduleUrl:'/module.js',exportName:'capability'}}};
  const cors={'access-control-allow-origin':'*','access-control-allow-headers':'content-type,authorization,x-sitewake-site-id,x-sitewake-site-agent-id,x-sitewake-site-id,x-sitewake-site-agent-id,x-sitewake-ai-stage,x-capability-input,x-capability-goal,x-capability-current-url','access-control-allow-methods':'GET,POST,OPTIONS'};
  const api=createServer(async(req,res)=>{if(mode==='slow-network')await new Promise(r=>setTimeout(r,80));res.writeHead(req.method==='OPTIONS'?204:200,{...cors,...(req.url==='/module.js'?{'cache-control':'public,max-age=31536000,immutable'}:{}),'content-type':req.url==='/module.js'?'text/javascript':'application/json'});if(req.method==='OPTIONS')return res.end();
   if(req.url==='/module.js'){moduleRequests++;return res.end(module.source)}
   if(req.url.includes('/search'))return res.end(JSON.stringify({items:[{...runtime,description:'操作实时网页'}]}));
   if(req.url.includes('/runtime?'))return res.end(JSON.stringify(runtime));
   if(req.url.includes('/chat/completions')){modelCalls++;let body='';for await(const c of req)body+=c;
    // The capability is one step of the Agent's task: its receipt comes back,
    // and an Agent that needs nothing more answers without another tool.
    const receipt=(JSON.parse(body||'{}').messages||[]).find(m=>m.role==='tool'&&m.name==='capability_v2_1');
    if(receipt){receipts.push(JSON.parse(receipt.content));return res.end(JSON.stringify({choices:[{message:{content:'done'}}]}))}
    return res.end(JSON.stringify({choices:[{message:{tool_calls:[{id:'call',type:'function',function:{name:'capability_v2_1',arguments:JSON.stringify({rank:mode==='no-result'?9:3})}}]}}]}))}
   if(req.url==='/result'){let text='';for await(const c of req)text+=c;results.push(JSON.parse(text));return res.end('{}')}
   res.end('{}');
  });
  const apiOrigin=await listen(api);
  const site=createServer((req,res)=>{if(req.url==='/sdk-test.js'){res.setHeader('content-type','text/javascript');return res.end(bundled.outputFiles[0].text)}
   res.setHeader('content-type','text/html; charset=utf-8');res.end(`<!doctype html><title>热搜时光机</title><main><button data-rank="3">第三个热搜</button><a id="open" href="/detail?rank=3">第三个热搜详情</a><div id="detail"></div><h1 id="topic-title"></h1></main><script>
   window.fixture={api:${JSON.stringify(apiOrigin)},slow:${mode==='slow-network'},observe:${mode==='link'}};
   if(location.pathname==='/detail'){document.querySelector('#detail').textContent=new URL(location.href).searchParams.get('rank');document.querySelector('#topic-title').textContent='本次真实话题';}
   // A client-side router link: the site handles the click itself.
   document.querySelector('#open').onclick=(event)=>{event.preventDefault();sessionStorage.setItem('clicks',String(Number(sessionStorage.getItem('clicks')||0)+1));history.pushState({},'','/detail?rank=3');document.querySelector('#detail').textContent='3';document.querySelector('#topic-title').textContent='本次真实话题';};
   document.querySelector('button').onclick=()=>{sessionStorage.setItem('clicks',String(Number(sessionStorage.getItem('clicks')||0)+1));${mode==='native'?"setTimeout(()=>location.assign('/detail?rank=3'),300);return;":''}document.querySelector('#detail').textContent='3';document.querySelector('#topic-title').textContent='本次真实话题';${mode==='spa'?"history.pushState({},'', '?rank=3');":mode==='hash'?"location.hash='rank=3';":''}};
   </script><script src="/sdk-test.js"></script>`);
  });
  const siteOrigin=await listen(site);if(mode==='entry-hash')runtime.program.entry={mode:'Navigate',url:siteOrigin+'/#ready'};
  // The first Stage leaves the entry page: the destination resumes that Stage, not the program's entry.
  if(mode==='entry-hard')runtime.program.entry={mode:'Navigate',url:siteOrigin+'/'};const context=await browser.newContext();const page=await context.newPage();
  try{
   await page.goto(siteOrigin);await page.waitForFunction(()=>Boolean(window.start));
   await page.evaluate(()=>{window.start().catch(e=>window.fatal=String(e))});
   await page.waitForFunction(()=>Boolean(window.result||window.fatal),null,{timeout:8000});
   const observed=await page.evaluate(()=>({result:window.result,fatal:window.fatal,checkpoint:sessionStorage.getItem('checkpoint')}));
   assert.equal(observed.fatal,undefined);assert.ok(observed.result);
   // A fault ends the task; a handled result goes back to the Agent once, on whichever document the run ended.
   const faulted=['failure','integrity'].includes(mode);
   assert.equal(modelCalls,faulted?1:2);assert.equal(receipts.length,faulted?0:1);
   if(!faulted)assert.equal(receipts[0].status,mode==='no-result'?'no-result':'success');assert.ok(moduleRequests>=1);
   assert.ok(observed.result.timings.some(span=>span.name==='module.fetch'));
   assert.ok(observed.result.timings.some(span=>span.name==='model.choose-tool'));
   assert.equal(await page.evaluate(()=>Number(sessionStorage.getItem('handoffs')||0)),mode==='hard'||mode==='entry-hard'?1:0);
   // Every Stage whose manifest allows navigation arms the one-shot continuation
   // before authored code runs (the click Stage: once); a Stage that cannot
   // navigate (verify) never does. 'integrity' fails before any Stage runs.
   assert.equal(await page.evaluate(()=>Number(sessionStorage.getItem('arms')||0)),mode==='integrity'?0:1,'one arm per navigating Stage');
   if(mode==='slow-network')assert.equal(observed.result.projectionComplete,false,'legacy projection never delays the user receipt');
   assert.equal(results.length,1,'one terminal receipt');
   if(['failure','integrity'].includes(mode)){assert.equal(observed.result.status,'failed');assert.equal(observed.result.clicks,mode==='failure'?1:0)}
   else if(mode==='no-result'){assert.equal(observed.result.outcome.status,'no-result');assert.equal(observed.result.clicks,0)}
   else{assert.equal(observed.result.status,'completed');assert.equal(observed.result.output.rank,3);assert.equal(observed.result.output.targetTitle,'本次真实话题');assert.match(observed.result.text,/本次真实话题/);assert.match(observed.result.text,/\]\(https?:\/\//,'the result links to the page it acted on');assert.equal(observed.result.clicks,1,'never repeat a completed click after navigation');assert.equal(observed.checkpoint,null);
    assert.equal(observed.result.activities.filter(a=>a.kind==='page'&&a.state==='completed').length,2);
    assert.equal(observed.result.activities.filter(a=>a.state==='failed').length,0);}
   if(mode==='native'){
    // The document left through the site's own location assignment mid-Stage;
    // the destination resumed from the Started receipt and finished the program.
    assert.equal(await page.evaluate(()=>location.pathname),'/detail');
   }
   if(['plain','spa','hash','hard'].includes(mode)) {
    const runnerContext=await browser.newContext();
    try {
     const runnerPage=await runnerContext.newPage();await runnerPage.goto(siteOrigin);
     const validated=await runCapabilityJavaScriptStages({page:runnerPage,moduleUrl:apiOrigin+'/module.js',program:runtime.program,input:{rank:3},transitionNetworkIdleMs:10,transitionGraceMs:0});
     assert.equal(validated.outcome,'Success','production validator accepts the same frozen artifact');
     assert.equal(validated.output.rank,observed.result.output.rank);assert.equal(validated.output.targetTitle,observed.result.output.targetTitle);
     assert.equal(await runnerPage.evaluate(()=>Number(sessionStorage.getItem('clicks'))),1);
    }finally{await runnerContext.close()}
   }
  }finally{await context.close();await close(site);await close(api)}
 });}finally{await browser.close()}
});
