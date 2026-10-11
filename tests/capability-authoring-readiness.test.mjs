import test from 'node:test';
import assert from 'node:assert/strict';
import {executeBrowserCapabilityStage} from '../lib/capability-center-v2/browser-stage-sdk.ts';
const args=()=>({input:{},state:{},inputPaths:[],statePaths:[],stageId:'check',deadlineAt:new Date(Date.now()+1500).toISOString()});
test('shared SDK waits for actual business data, not document readiness',async()=>{
 let ready=false;const timer=setTimeout(()=>{ready=true;},250);
 try{const output=await executeBrowserCapabilityStage({...args(),run:async({waitUntil})=>{await waitUntil(()=>ready);return {outcome:'Success'};}});assert.equal(output.outcome,'Success');assert.equal(ready,true);}finally{clearTimeout(timer);}
});
test('shared SDK condition waits stop immediately on cancellation',async()=>{
 const abort=new AbortController();const timer=setTimeout(()=>abort.abort(new Error('operator_cancelled')),30);
 try{await assert.rejects(executeBrowserCapabilityStage({...args(),signal:abort.signal,run:({waitUntil})=>waitUntil(()=>false)}),/operator_cancelled/);}finally{clearTimeout(timer);}
});

// The settle wait is shared by an authored Stage and by the runtime's second
// look at a read Stage that came back empty, so it is tested on its own.
const {settleCapabilityPage}=await import('../lib/capability-center-v2/browser-stage-sdk.ts');
function stubPage(shapes){
 let index=0;
 globalThis.location={href:'https://example.test/'};
 globalThis.document={body:{get innerText(){return 'x'.repeat(shapes[Math.min(index++,shapes.length-1)]);}},querySelectorAll:()=>({length:1})};
 return ()=>{delete globalThis.location;delete globalThis.document;};
}
test('the settle wait returns once the page stops changing shape',async()=>{
 const restore=stubPage([10,20,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30]);
 try{
  const started=Date.now();
  await settleCapabilityPage(undefined,150,2000);
  const elapsed=Date.now()-started;
  assert.ok(elapsed>=150,`应当等到安静，实测 ${elapsed}ms`);
  assert.ok(elapsed<1500,`不应等到上限，实测 ${elapsed}ms`);
 }finally{restore();}
});
test('a page that never stops changing still releases the wait at its cap',async()=>{
 const restore=stubPage(Array.from({length:200},(_ ,i)=>i+1));
 try{
  const started=Date.now();
  await settleCapabilityPage(undefined,300,400);
  assert.ok(Date.now()-started<900,'到达上限即返回');
 }finally{restore();}
});
test('the settle wait stops on cancellation',async()=>{
 const restore=stubPage(Array.from({length:200},(_ ,i)=>i+1));
 const abort=new AbortController();abort.abort();
 try{
  const started=Date.now();
  await settleCapabilityPage(abort.signal,300,5000);
  assert.ok(Date.now()-started<200,'已取消就不再等待');
 }finally{restore();}
});
