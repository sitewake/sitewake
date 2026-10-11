import assert from 'node:assert/strict';
import test from 'node:test';
import {withRequestTiming} from '../lib/http/request-timing.ts';

test('request timing correlates client and server without logging request content',async()=>{
 const logs=[];const original=console.info;console.info=value=>logs.push(JSON.parse(value));
 try {
  const response=await withRequestTiming('capability.runtime',async request=>new Response('{}',{headers:{'access-control-allow-origin':'*'}}))(new Request('https://test.invalid/?secret=private',{headers:{authorization:'Bearer private'}}));
  assert.match(response.headers.get('server-timing'),/^app;dur=\d/);
  assert.equal(logs[0].requestId,response.headers.get('x-request-id'));assert.equal(logs[0].status,200);
  assert.equal(response.headers.get('access-control-allow-origin'),'*');
  assert.match(response.headers.get('access-control-expose-headers'),/server-timing/);
  await assert.rejects(withRequestTiming('run.create',async()=>{throw Error('private')})());
  assert.equal(logs[1].status,500);assert.doesNotMatch(JSON.stringify(logs),/private|authorization|secret/);
 }finally{console.info=original}
});
