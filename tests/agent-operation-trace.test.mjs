import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';

test('conversation operations stay compact, keyboard accessible and attached to their disclosure',async()=>{
 const bundle=await build({entryPoints:['client/user-agent-trace.ts'],bundle:true,format:'iife',globalName:'Trace',write:false});
 const browser=await chromium.launch();
 try{const page=await browser.newPage();await page.setContent('<details id="trace"></details>');await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.evaluate(()=>{
   window.entries=[{id:'lookup',kind:'capability-search',state:'completed',label:'查询可用能力'},
    {id:'cap',kind:'capability',capabilityId:'rank',capabilityName:'打开第 {{rank}} 个热搜',input:{rank:5},state:'running'},
    {id:'step',kind:'page',capabilityId:'rank',stepTotal:2,label:'technical_step_1',state:'running'}];
   Trace.renderOperationTrace(document.querySelector('#trace'),entries);
  });
  assert.equal(await page.locator('#trace').evaluate(el=>el.open),false);
  assert.equal((await page.locator('summary').innerText()).replace(/\s+/g,''),'打开第5个热搜…查看过程');
  assert.equal(await page.locator('.operation-row').count(),2,'one semantic operation, no duplicate nested stage card');
  await page.locator('summary').focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('#trace').evaluate(el=>el.open),true);
  await page.evaluate(()=>{window.oldSummary=document.querySelector('summary');entries.forEach(e=>e.state='completed');Trace.renderOperationTrace(document.querySelector('#trace'),entries)});
  assert.equal(await page.evaluate(()=>document.activeElement===oldSummary&&document.querySelector('summary')===oldSummary),true);
  assert.equal(await page.locator('#trace').evaluate(el=>el.open),true);
  assert.match(await page.locator('summary').innerText(),/已完成操作/);
  assert.doesNotMatch(await page.locator('#trace').innerText(),/\{\{|rank:|technical_step/);
  // No row is running between two tool calls, but the turn is not over — the title must not announce "done" early.
  await page.evaluate(()=>Trace.renderOperationTrace(document.querySelector('#trace'),entries,false,true));
  assert.match(await page.locator('summary').innerText(),/正在思考下一步…/);
  assert.equal(await page.locator('#trace').getAttribute('data-state'),'running');
  await page.evaluate(()=>{entries[0].state='failed';Trace.renderOperationTrace(document.querySelector('#trace'),entries,false,true)});
  assert.doesNotMatch(await page.locator('summary').innerText(),/部分操作未完成/,'a failed step mid-run is not a verdict yet');
  await page.evaluate(()=>{Trace.renderOperationTrace(document.querySelector('#trace'),entries,false,false)});
  assert.match(await page.locator('summary').innerText(),/部分操作未完成/);
  await page.evaluate(()=>{entries[0].state='completed';Trace.renderOperationTrace(document.querySelector('#trace'),entries,true,true)});
  assert.match(await page.locator('summary').innerText(),/Working out the next step…/);
  await page.evaluate(()=>{entries[1].capabilityName='<img src=x onerror=alert(1)>';Trace.renderOperationTrace(document.querySelector('#trace'),entries,true)});
  assert.equal(await page.locator('#trace img').count(),0);
  assert.match(await page.locator('summary').innerText(),/Actions completed/);
  // A stopped turn is neither completed nor "needs attention" — even when every
  // recorded step had already completed (a stop during the model turn).
  await page.evaluate(()=>{entries.forEach(e=>e.state='completed');Trace.renderOperationTrace(document.querySelector('#trace'),entries,false,true,true)});
  assert.match(await page.locator('summary').innerText(),/已停止/);
  assert.equal(await page.locator('#trace').getAttribute('data-state'),'failed');
  await page.evaluate(()=>{Trace.renderOperationTrace(document.querySelector('#trace'),entries,true,false,true)});
  assert.match(await page.locator('summary').innerText(),/Stopped/);
 }finally{await browser.close()}
});

test('plain chat turns get no operation disclosure; a turn that touched the page keeps it', async () => {
 const bundle = await build({ entryPoints: ['client/user-agent-trace.ts'], bundle: true, format: 'iife', globalName: 'Trace', write: false });
 const browser = await chromium.launch();
 try {
  const page = await browser.newPage();
  await page.setContent('<div></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const verdicts = await page.evaluate(() => ({
   // "What's your name": routing looked up the capability catalog and site knowledge, then answered — no operation.
   chat: Trace.hasVisibleOperations([
    { id: 'lookup', kind: 'capability-search', state: 'completed', label: '查询可用能力' },
    { id: 'knowledge', kind: 'knowledge', state: 'completed', label: '查看网站知识' },
    { id: 'reasoning', kind: 'reasoning', state: 'completed', label: '思考' },
    { id: 'result', kind: 'result', state: 'completed', label: '回答' },
   ]),
   empty: Trace.hasVisibleOperations([]),
   // "Search hot topics for X": ran a capability and touched the page.
   task: Trace.hasVisibleOperations([
    { id: 'lookup', kind: 'capability-search', state: 'completed', label: '查询可用能力' },
    { id: 'cap', kind: 'capability', capabilityId: 'search', capabilityName: '搜索 {{keyword}}', input: { keyword: '周杰伦' }, state: 'completed' },
    { id: 'step', kind: 'page', capabilityId: 'search', state: 'completed', label: 'technical_step_1' },
   ]),
   navigation: Trace.hasVisibleOperations([{ id: 'nav', kind: 'navigation', state: 'completed', label: '打开搜索页' }]),
   asked: Trace.hasVisibleOperations([{ id: 'ask', kind: 'human', state: 'completed', label: '请确认' }]),
  }));
  assert.deepEqual(verdicts, { chat: false, empty: false, task: true, navigation: true, asked: true });
  // The widget uses this to decide whether to show the "completed · view steps" disclosure.
  const client = await readFile(new URL('../client/user-agent-client.ts', import.meta.url), 'utf8');
  assert.match(client, /if \(!hasVisibleOperations\(items\)\) \{ trace\?\.remove\(\); continue; \}/);
 } finally { await browser.close(); }
});
