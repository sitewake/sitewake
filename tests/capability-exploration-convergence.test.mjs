import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { startClickableCardSite } from "./helpers/clickable-card-site.mjs";
import { inspectPage, strategiesFor, executeProgram } from "../runner/capability-v2/browser-runtime.ts";
import { authoringManifest } from "../runner/capability-v2/javascript-author.ts";
import { runCapabilityJavaScriptStages } from "../runner/capability-v2/javascript-stage-runner.ts";
import { capabilityModuleHash } from "../lib/capability-center-v2/javascript-runtime.ts";

test("React card targets are visible and distinguishable from their nested external links", async () => {
  const site = await startClickableCardSite();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(site.origin);
    await page.locator('.topic-card').first().waitFor();
    const snapshot = await inspectPage(page);
    const cards = snapshot.elements.filter(element => element.tag === 'div' && element.interactionSource === 'handler');
    assert.equal(cards.length, 3);
    assert.equal(snapshot.elements.filter(element => element.tag === 'span').length, 0, 'inherited pointer cursor must not duplicate child targets');
    assert.equal(snapshot.elements.filter(element => element.opensNewPage).length, 3);
    assert.match(cards[2].name, /3城市观察/);
    const input = { parameters: {rank: 3}, context: {}, trigger: {}, interactions: [] };
    await executeProgram(page, {schemaVersion: '1.0', entry: {mode: 'CurrentPage'}, defaults: {timeoutMs: 1500, retryCount: 0}, steps: [
      {id: 'open', action: 'click', target: {strategies: strategiesFor(cards[2], input)}}
    ], result: {}}, input);
    assert.equal(new URL(page.url()).searchParams.get('topic'), '3');
    assert.equal(await page.getByRole('heading', {level: 2}).innerText(), '城市观察');
    assert.equal(page.context().pages().length, 1);
  } finally { await browser.close(); await site.close(); }
});

async function withExplorerModel(selectAction, run) {
  const calls = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks));
      const schema = body.response_format?.json_schema?.name;
      const payload = JSON.parse(body.messages.find(message => message.role === 'user').content);
      let result;
      if (schema === 'capability_v2_specification' && payload.aliasRepairMissing) result = { siteTerms: [] };
      else if (schema === 'capability_v2_specification' && payload.suppliedParameters?.keyword !== undefined) result = {
        name: '搜索微博历史热搜', description: '在热搜历史站搜索关键词', intent: '搜索{{keyword}}热搜', aliases: [], siteTerms: [],
        parameters: [{name:'keyword',type:'string',description:'关键词',required:true,exampleValue:'周杰伦'}],
        groundingExamples: [{keyword:'周杰伦'},{keyword:'热搜'}], scope: {kind:'site-global',onMismatch:'no-match'}
      };
      else if (schema === 'capability_v2_specification') result = {
        name: '查看指定排名的热搜详情', description: '按排名打开站内热搜详情', intent: '打开指定排名热搜详情', aliases: [],
        parameters: [{name:'rank',type:'number',description:'榜单排名',required:true,exampleValue:3}],
        groundingExamples: [{rank:3},{rank:1}], scope: {kind:'site-global',onMismatch:'no-match'}
      };
      else if (schema === 'capability_v2_explorer_action') { calls.push(payload); result = selectAction(payload, calls.length); }
      else if (schema === 'capability_v2_contract') result = {
        outputSchema: {type:'object',properties:{},additionalProperties:true}, preconditions: [],
        successConditions: [{type:'urlTemplate',template:'/?topic={{rank}}'}, {type:'textIncludes',value:'上榜次数'}]
      };
      else throw new Error(`Unexpected model request: ${schema}`);
      response.writeHead(200, {'content-type':'application/json'});
      response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(result)}}]}));
    } catch (error) { response.writeHead(500).end(JSON.stringify({error:String(error)})); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const names = ['MODEL_API_KEY','MODEL_BASE_URL','MODEL','MODEL_EXECUTION','MODEL_SEMANTIC','OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODEL'];
  const saved = Object.fromEntries(names.map(name => [name,process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env,{OPENAI_API_KEY:'fixture-only',OPENAI_BASE_URL:`http://127.0.0.1:${server.address().port}/v1`,OPENAI_MODEL:'fixture-only'});
  try { await run(calls); }
  finally { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } await new Promise(resolve => server.close(resolve)); }
}

test("plain DOM pointer targets get an exact selector without inventing a role", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<main><div class="card" style="cursor:pointer"><span>打开详情</span><a href="https://external.example">来源</a></div><div data-test="secondary" onclick="this.textContent=\'已打开\'">其他详情</div><div hidden onclick="void 0">隐藏</div></main>');
    await page.locator('.card').evaluate(element => element.addEventListener('click', () => { element.textContent = '详情已打开'; }));
    const snapshot = await inspectPage(page);
    const card = snapshot.elements.find(element => element.interactionSource === 'pointer');
    assert.ok(card);
    assert.equal(card.role, undefined);
    assert.equal(snapshot.elements.some(element => element.name === '隐藏'), false);
    assert.equal(snapshot.elements.find(element => element.name === '其他详情').css, '[data-test="secondary"]');
    await page.locator(card.css).click();
    assert.equal(await page.locator('.card').innerText(), '详情已打开');
  } finally { await browser.close(); }
});

test("C1 adopts authored I/O within the Contract; C3 replays the frozen declaration on independent ranks", async () => {
  const source = `export const capability={version:2,stages:[
    {id:'stage_1',io:{reads:{input:['rank'],state:[]},writes:{state:[],output:[]}},navigation:'optional',run({input}){
      const target=document.querySelector('.topic-card:nth-of-type('+input.rank+')');
      if(!target)return {outcome:'NoResult',reason:'rank_not_found'};
      target.click();return {outcome:'Continue'};
    }},
    {id:'stage_verify',io:{reads:{input:['rank'],state:[]},writes:{state:[],output:['rank','pageUrl']}},navigation:'none',run({input}){
      const rank=Number(new URL(location.href).searchParams.get('topic'));
      return rank===input.rank?{outcome:'Success',output:{rank,pageUrl:location.href}}:{outcome:'NoResult',reason:'wrong_rank'};
    }}]};`;
  const hash = await capabilityModuleHash(source);
  const modules = new Map([[hash,source]]);
  const site = await startClickableCardSite(modules);
  const browser = await chromium.launch();
  try {
    const contract = {inputSchema:{type:'object',properties:{rank:{type:'number'}}},outputSchema:{type:'object',properties:{rank:{type:'number'},pageUrl:{type:'string'}}}};
    const manifest = authoringManifest({steps:[{id:'click',action:'click',target:{strategies:[{type:'css',value:'.topic-card:nth-of-type(3)'}]}}]},contract);
    assert.deepEqual(manifest.stages[0].io.reads.input, [], 'the concrete observation cannot infer rank usage in authored code');
    const program = {schemaVersion:'2.0',runtime:'BrowserJavaScriptStage',module:{contentHash:hash,moduleUrl:`/api/capability-v2/modules/${hash}`,exportName:'capability'},entry:{mode:'CurrentPage'},...manifest};
    const page = await browser.newPage();
    await page.goto(site.origin); await page.locator('.topic-card').first().waitFor();
    const draft = await runCapabilityJavaScriptStages({page,moduleUrl:site.origin+program.module.moduleUrl,program,input:{rank:3},allowModuleGraphAdoption:true,draftInputPaths:['rank']});
    assert.equal(draft.outcome, 'Success');
    assert.deepEqual(draft.stageManifest[0].io.reads.input, ['rank']);
    const frozen = {...program,stages:draft.stageManifest};
    for (const rank of [1,2,3]) {
      await page.goto(site.origin); await page.locator('.topic-card').first().waitFor();
      const result = await runCapabilityJavaScriptStages({page,moduleUrl:site.origin+program.module.moduleUrl,program:frozen,input:{rank}});
      assert.equal(result.outcome,'Success'); assert.equal(result.output.rank,rank);
    }
    await assert.rejects(runCapabilityJavaScriptStages({page,moduleUrl:site.origin+program.module.moduleUrl,program,input:{rank:3}}), /capability_stage_transition_manifest_mismatch/);
    await assert.rejects(runCapabilityJavaScriptStages({page,moduleUrl:site.origin+program.module.moduleUrl,program,input:{rank:3},allowModuleGraphAdoption:true,draftInputPaths:['unrelated']}), /capability_stage_input_outside_contract/);
  } finally { await browser.close(); await site.close(); }
});

test("an input is a target only where a stage picks that target off the page", () => {
  // Production: 「查询关键词的历史热搜」 reaches its result by opening
  // /search?q=<keyword> and reading it. The manifest still declared keyword a
  // page-business-object whose identity lives at targets.keyword, and no stage
  // writes state at all, so C2 refused the candidate outright with
  // case_generation_target_binding_unwritten and the capability was never made.
  const contract = {
    inputSchema: { type: "object", properties: { keyword: { type: "string" } }, required: ["keyword"] },
    outputSchema: { type: "object", properties: { items: { type: "array" } } },
  };
  const opened = authoringManifest({ steps: [] }, contract, { entryUrl: "https://example.test/search?q=phone" });
  assert.deepEqual(opened.targetBindings, [], "没有选取目标的阶段，就不该声明目标绑定");
  assert.deepEqual(opened.parameterRoles, [{ inputPath: "keyword", role: "context" }]);
  const writes = new Set(opened.stages.flatMap((stage) => stage.io.writes.state));
  for (const binding of opened.targetBindings) {
    assert.ok(writes.has(binding.identityStatePath), `${binding.identityStatePath} 必须有阶段写入`);
  }

  // A route that acts on the page keeps its target: the select stage writes
  // the identity the verification stage reads.
  const acting = authoringManifest({
    steps: [{ id: "step_1", action: "click", target: { strategies: [{ type: "css", value: ".result:nth-of-type(1)" }] } }],
  }, contract);
  assert.deepEqual(acting.targetBindings.map((binding) => binding.inputPath), ["keyword"]);
  const actingWrites = new Set(acting.stages.flatMap((stage) => stage.io.writes.state));
  for (const binding of acting.targetBindings) {
    assert.ok(actingWrites.has(binding.identityStatePath), `${binding.identityStatePath} 必须有阶段写入`);
  }
});

/**
 * A small shop that announces its result count in a status region, the way
 * most listing pages do. A visitor's recorded path goes past that list.
 */
async function startCountingShop() {
  const page = (body) => `<!doctype html><html><head><title>Shop</title></head><body>${body}</body></html>`;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://shop.test");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/shop") return response.end(page(`<h1>Lamps</h1><p role="status">Showing 2 of 2 items</p><ul><li><a href="/product/aurora">Aurora Lamp</a></li><li><a href="/product/borealis">Borealis Lamp</a></li></ul>`));
    if (url.pathname.startsWith("/product/")) return response.end(page(`<h1>Aurora Lamp</h1>
      <div><button type="button" aria-pressed="false" onclick="this.setAttribute('aria-pressed','true');window.finish=this.textContent">Copper</button>
      <button type="button" aria-pressed="false" onclick="this.setAttribute('aria-pressed','true');window.finish=this.textContent">Steel</button></div>
      <button type="button" onclick="document.getElementById('cart').textContent='Added Aurora Lamp in '+(window.finish||'')+' to cart'">Add to cart</button>
      <div id="cart" role="status"></div>`));
    return response.end(page(`<h1>Welcome</h1><a href="/shop?type=table">Shop</a>`));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function withShopModel(run) {
  const explorerCalls = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const schema = body.response_format?.json_schema?.name;
    const payload = JSON.parse(body.messages.find((message) => message.role === "user").content);
    let result;
    if (schema === "capability_v2_specification" && payload.aliasRepairMissing) result = { siteTerms: [] };
    else if (schema === "capability_v2_specification") result = {
      name: "Add a lamp to the cart", description: "Add a lamp in a chosen finish to the cart", intent: "Add a lamp in {{finish}} to the cart", aliases: [], siteTerms: [],
      parameters: [{ name: "finish", type: "string", description: "Lamp finish", required: true, exampleValue: "Copper" }],
      groundingExamples: [{ finish: "Copper" }], scope: { kind: "site-global", onMismatch: "no-match" },
    };
    else if (schema === "capability_v2_explorer_action") { explorerCalls.push(payload); result = { action: "done", reason: "added to cart" }; }
    else if (schema === "capability_v2_contract") result = { outputSchema: { type: "object", properties: {}, additionalProperties: true }, preconditions: [], successConditions: [{ type: "textIncludes", value: "Added" }] };
    else { response.writeHead(500).end(JSON.stringify({ error: `unexpected ${schema}` })); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(result) } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const names = ["MODEL_API_KEY", "MODEL_BASE_URL", "MODEL", "MODEL_EXECUTION", "MODEL_SEMANTIC", "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_MODEL"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, { OPENAI_API_KEY: "fixture-only", OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_MODEL: "fixture-only" });
  try { await run(explorerCalls); }
  finally { for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } await new Promise((resolve) => server.close(resolve)); }
}

test("a scope several cards satisfy still finds a target that only one of them holds", async () => {
  // Replaying the visitor's click on "Lune Table Lamp" was scoped to cards
  // offering the input finish; three cards offered Brass, and the replay
  // failed as ambiguous although only one held that link.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const cards = (second) => `<ul>
      <li class="card"><a href="#aurora">Aurora Lamp</a><p>Finishes: Copper, Steel</p></li>
      <li class="card"><a href="#${second.toLowerCase().replace(" ", "-")}">${second}</a><p>Finishes: Copper</p></li>
      <li class="card"><a href="#cora">Cora Lamp</a><p>Finishes: Steel</p></li></ul>`;
    const input = { parameters: { finish: "Copper" }, context: {}, trigger: {}, interactions: [] };
    const program = { schemaVersion: "1.0", entry: { mode: "CurrentPage" }, defaults: { timeoutMs: 1500, retryCount: 0 }, result: {}, steps: [{
      id: "open", action: "click",
      target: {
        scope: { strategies: [{ type: "css", value: "li.card", containsTextAll: [{ source: "input", path: "finish" }], match: "contains" }] },
        strategies: [{ type: "role", role: "link", name: "Aurora Lamp", match: "exact" }],
      },
    }] };
    await page.setContent(cards("Borealis Lamp"));
    await executeProgram(page, program, input);
    assert.match(page.url(), /#aurora$/);
    // The same name in two of the matching cards is a real ambiguity.
    await page.setContent(cards("Aurora Lamp"));
    await assert.rejects(executeProgram(page, program, input), /target_ambiguous:open:scope/);
  } finally { await browser.close(); }
});

test("a swatch chosen by its label is found by the input, not by its position", async () => {
  // The lamp's finish swatch is a <label> with no role. Located by CSS
  // position alone, the capability clicked the first swatch for any finish.
  const swatch = { index: 3, tag: "label", name: "Copper", css: "form label:nth-of-type(1)" };
  const strategies = strategiesFor(swatch, { parameters: { finish: "Copper" }, context: {}, trigger: {}, interactions: [] });
  assert.ok(strategies.some((strategy) => strategy.type === "text" && strategy.value?.source === "input" && strategy.value.path === "finish"), JSON.stringify(strategies));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<form><label onclick="window.picked='Copper'">Copper</label><label onclick="window.picked='Steel'">Steel</label></form>`);
    const program = { schemaVersion: "1.0", entry: { mode: "CurrentPage" }, defaults: { timeoutMs: 1500, retryCount: 0 }, result: {}, steps: [{ id: "finish", action: "click", target: { strategies } }] };
    await executeProgram(page, program, { parameters: { finish: "Steel" }, context: {}, trigger: {}, interactions: [] });
    assert.equal(await page.evaluate(() => window.picked), "Steel");
  } finally { await browser.close(); }
});

