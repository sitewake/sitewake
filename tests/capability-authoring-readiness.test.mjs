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

test("a stage that waits with settle() runs in the page the way the runner sends it", async () => {
  // The runner hands executeBrowserCapabilityStage to page.evaluate, which
  // sends only that function's own text. settle() called a helper declared
  // beside it and every program that waited threw "settleCapabilityPage is
  // not defined".
  const { chromium } = await import("playwright");
  const { executeBrowserCapabilityStage } = await import("../lib/capability-center-v2/browser-stage-sdk.ts");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://stage.test/**", (route) => route.request().url().endsWith(".js")
      ? route.fulfill({ contentType: "text/javascript", body: 'export const capability={version:2,stages:[{id:"wait",async run({settle}){await settle(50,300);return {outcome:"Success",output:{settled:true}};}}]};' })
      : route.fulfill({ contentType: "text/html", body: "<!doctype html><title>stage</title><p>ready</p>" }));
    await page.goto("http://stage.test/");
    const result = await page.evaluate(executeBrowserCapabilityStage, JSON.stringify({
      moduleUrl: "http://stage.test/module.js", index: 0, input: {}, state: {}, inputPaths: [], statePaths: [],
      stageId: "wait", deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    }));
    assert.equal(JSON.stringify(result).includes('"settled":true'), true, JSON.stringify(result).slice(0, 300));
  } finally { await browser.close(); }
});

test("in a self-test a wait that never settles fails in seconds and names itself; elsewhere it keeps waiting", async () => {
  const { chromium } = await import("playwright");
  const { executeBrowserCapabilityStage } = await import("../lib/capability-center-v2/browser-stage-sdk.ts");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://stage.test/**", (route) => route.request().url().endsWith(".js")
      ? route.fulfill({ contentType: "text/javascript", body: 'export const capability={version:2,stages:[{id:"wait",async run({waitUntil}){await waitUntil(()=>document.title==="never","title is never");return {outcome:"Success",output:{}};}}]};' })
      : route.fulfill({ contentType: "text/html", body: "<!doctype html><title>stage</title>" }));
    await page.goto("http://stage.test/");
    const payload = (extra) => JSON.stringify({ moduleUrl: "http://stage.test/module.js", index: 0, input: {}, state: {}, inputPaths: [], statePaths: [], stageId: "wait", deadlineAt: new Date(Date.now() + 4_000).toISOString(), ...extra });
    const started = Date.now();
    await assert.rejects(page.evaluate(executeBrowserCapabilityStage, payload({ waitCapMs: 300 })), /capability_control_flow_timeout:wait:pending=title is never/);
    assert.ok(Date.now() - started < 2_000, "a capped wait fails long before the stage deadline");
    const uncapped = Date.now();
    await assert.rejects(page.evaluate(executeBrowserCapabilityStage, payload({})), /capability_control_flow_timeout:wait/);
    assert.ok(Date.now() - uncapped >= 3_000, "without a cap the wait runs to the deadline, as published capabilities need");
  } finally { await browser.close(); }
});

test("fill() on a dropdown accepts the option a reader sees, and fails loudly on one that is not offered", async () => {
  // The lamp program wrote "US plug (Type A/B)" into a select whose option
  // value is "US"; the dropdown was left empty and the cart never filled.
  const { chromium } = await import("playwright");
  const { executeBrowserCapabilityStage } = await import("../lib/capability-center-v2/browser-stage-sdk.ts");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const module = (wanted) => `export const capability={version:2,stages:[{id:"pick",async run({fill}){fill(document.querySelector("select"),${JSON.stringify(wanted)});return {outcome:"Success",output:{value:document.querySelector("select").value}};}}]};`;
    let wanted = "";
    await page.route("http://stage.test/**", (route) => route.request().url().endsWith(".js")
      ? route.fulfill({ contentType: "text/javascript", body: module(wanted) })
      : route.fulfill({ contentType: "text/html", body: `<!doctype html><select><option value="">Choose a plug type</option><option value="US">US plug (Type A/B)</option><option value="UK">UK plug (Type G)</option></select>` }));
    const run = async (value) => {
      wanted = value;
      await page.goto("http://stage.test/");
      return page.evaluate(executeBrowserCapabilityStage, JSON.stringify({ moduleUrl: `http://stage.test/module-${encodeURIComponent(value)}.js`, index: 0, input: {}, state: {}, inputPaths: [], statePaths: [], stageId: "pick", deadlineAt: new Date(Date.now() + 10_000).toISOString() }));
    };
    assert.match(JSON.stringify(await run("US plug (Type A/B)")), /"value":"US"/, "a label selects its option");
    assert.match(JSON.stringify(await run("uk plug (type g)")), /"value":"UK"/, "case and spacing do not matter");
    assert.match(JSON.stringify(await run("US")), /"value":"US"/, "the value itself still works");
    await assert.rejects(run("EU plug"), /capability_stage_select_option_missing:pick:EU plug; options: Choose a plug type \| US plug \(Type A\/B\) \| UK plug \(Type G\)/);
  } finally { await browser.close(); }
});
