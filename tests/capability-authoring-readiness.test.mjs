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
