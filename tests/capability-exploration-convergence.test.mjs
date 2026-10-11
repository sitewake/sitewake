import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { startClickableCardSite } from "./helpers/clickable-card-site.mjs";
import { inspectPage, strategiesFor, executeProgram, exploreCapability } from "../runner/capability-v2/browser-runtime.ts";
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

test("explorer re-plans from a rejected source link to the actual React card, then completes", async () => {
  const site = await startClickableCardSite();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const trace = [];
    await withExplorerModel((payload, turn) => {
      if (turn === 1) return {action:'click',index:payload.page.elements.find(element => element.href?.endsWith('/3')).index};
      if (payload.page.url.includes('?topic=3')) return {action:'done',reason:'站内第3条详情已打开'};
      assert.equal(payload.history.at(-1).reason, 'external_link_outside_exploration_scope');
      return {action:'click',index:payload.page.elements.find(element => element.tag === 'div' && element.name.includes('3城市观察')).index};
    }, async calls => {
      const result = await exploreCapability(page,'查看指定排名的热搜详情',site.origin,
        {parameters:{rank:3},context:{},trigger:{},interactions:[]},5,event => trace.push(event));
      assert.equal(calls.length, 3);
      assert.equal(result.program.steps.length, 1, 'rejected links must not become program steps');
      assert.equal(calls[2].history.at(-1).changed, true);
      assert.match(calls[2].history.at(-1).urlAfter, /topic=3/);
      assert.equal(trace.filter(event => event.stage === 'explorer-action-result').length, 2);
      assert.equal(page.context().pages().length, 1, 'external link must never be opened');
    });
  } finally { await browser.close(); await site.close(); }
});

test("an unchanged click result reaches the next model turn and repeated no-op stops explicitly", async () => {
  const site = await startClickableCardSite();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Use a dedicated static no-op target; no production data or site changes.
    await page.route(site.origin+'/', route => route.fulfill({contentType:'text/html',body:'<h1>榜单</h1><button>3 城市观察</button><p>1 晨间新闻</p>'}));
    await withExplorerModel(payload => ({action:'click',index:payload.page.elements.find(element=>element.tag==='button').index}), async calls => {
      await assert.rejects(exploreCapability(page,'查看指定排名的热搜详情',site.origin,
        {parameters:{rank:3},context:{},trigger:{},interactions:[]},8), /repeated_click_without_page_progress/);
      assert.equal(calls.length, 3);
      assert.equal(calls[1].history.at(-1).changed, false);
      assert.match(calls[1].history.at(-1).feedback, /没有可观察变化/);
    });
  } finally { await browser.close(); await site.close(); }
});

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

test('waitFor without an element index observes the refreshed page instead of failing the task', async () => {
 const site=await startClickableCardSite(); const browser=await chromium.launch();
 try {
  const page=await browser.newPage();
  await withExplorerModel((payload,turn)=>{
   if(turn===1)return {action:'waitFor',value:1};
   if(payload.page.url.includes('topic=3'))return {action:'done',reason:'详情已打开'};
   return {action:'click',index:payload.page.elements.find(e=>e.tag==='div'&&e.name.includes('3城市观察')).index};
  },async()=>{
   const result=await exploreCapability(page,'查看指定排名的热搜详情',site.origin,{parameters:{rank:3},context:{},trigger:{},interactions:[]},5);
   assert.equal(result.program.steps.length,1);
  });
 }finally{await browser.close();await site.close();}
});

/**
 * Production incident (a hot-search lookup): after the search box was filled, a
 * role=status region lit up with "searching…"; the explorer treated the fresh signal
 * as completion and proposed done automatically, but done was rejected because the
 * original task's results page (endPage with a q parameter) had not been reached —
 * and the signal was not marked seen, so next turn it was fresh again, done again,
 * rejected again, and the model was never consulted until the step budget was gone.
 * （capability_exploration_step_limit）。
 */
function searchSiteRoutes(page, origin) {
  const shell = (body) => `<!doctype html><html lang="zh-CN"><body><h1>热搜时光机</h1>${body}</body></html>`;
  return page.route(`${origin}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/search') {
      return route.fulfill({ contentType: 'text/html', body: shell(`<h2>搜索结果</h2><p>周杰伦 上榜次数 12</p>`) });
    }
    return route.fulfill({ contentType: 'text/html', body: shell(`
      <input id="q" placeholder="搜索历史热搜" aria-label="搜索历史热搜">
      <div id="live" role="status"></div>
      <script>
        const input = document.getElementById('q');
        const live = document.getElementById('live');
        input.addEventListener('input', () => { live.textContent = '正在查找包含“' + (input.value || input.placeholder) + '”的词条'; setTimeout(() => { live.textContent = '没有找到包含“' + (input.value || input.placeholder) + '”的词条'; }, 50); });
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') location.href = '/search?q=' + encodeURIComponent(input.value); });
      </script>`) });
  });
}

test('a rejected auto-done from a page status signal hands the next step back to the model instead of looping', async () => {
  const site = await startClickableCardSite();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await searchSiteRoutes(page, site.origin);
    const trace = [];
    const input = { parameters: { keyword: '周杰伦' }, context: {}, trigger: {}, interactions: [],
      experience: { schemaVersion: '1.0', actions: [], endPage: { url: `${site.origin}/search?q=%E5%91%A8%E6%9D%B0%E4%BC%A6` } } };
    await withExplorerModel((payload, turn) => {
      const box = payload.page.elements.find((element) => element.tag === 'input');
      if (turn === 1) return { action: 'fill', index: box.index, inputPath: 'keyword' };
      if (payload.page.url.includes('/search?q=')) return { action: 'done', reason: '结果页已打开' };
      // Second consultation: the history must carry the rejection and its reason, and the page signal no longer poses as completion.
      assert.equal(payload.history.at(-1).reason, 'completion_evidence_missing');
      assert.match(payload.history.at(-1).feedback, /提交搜索/);
      return { action: 'press', index: box.index, key: 'Enter' };
    }, async (calls) => {
      const result = await exploreCapability(page, '搜索微博历史热搜', site.origin, input, 12, (event) => trace.push(event));
      // fill → the signal-triggered automatic done is rejected → the model is consulted
      // (press Enter) → once /search?q= is reached, input_navigation_applied completes
      // automatically. The model was consulted twice instead of never.
      assert.equal(calls.length, 2, `flow=${trace.map((event) => event.stage).join(' | ')}`);
      assert.ok(trace.some((event) => event.stage === 'explorer-auto-complete'));
      assert.deepEqual(result.program.steps.map((step) => step.action), ['fill', 'press']);
      const rejections = trace.filter((event) => event.stage === 'explorer-action-result' && event.response?.reason === 'completion_evidence_missing');
      assert.equal(rejections.length, 1, '驳回只发生一次，不再原地打转');
      assert.match(page.url(), /\/search\?q=/);
    });
  } finally { await browser.close(); await site.close(); }
});

test('three completion rejections on the same page fail explicitly instead of burning the step budget', async () => {
  const site = await startClickableCardSite();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await searchSiteRoutes(page, site.origin);
    const input = { parameters: { keyword: '周杰伦' }, context: {}, trigger: {}, interactions: [],
      experience: { schemaVersion: '1.0', actions: [], endPage: { url: `${site.origin}/search?q=x` } } };
    // A stubborn model: keeps saying done after the fill.
    await withExplorerModel((payload, turn) => {
      const box = payload.page.elements.find((element) => element.tag === 'input');
      return turn === 1 ? { action: 'fill', index: box.index, inputPath: 'keyword' } : { action: 'done', reason: '我觉得完成了' };
    }, async (calls) => {
      await assert.rejects(exploreCapability(page, '搜索微博历史热搜', site.origin, input, 16), /capability_exploration_failed:completion_evidence_missing/);
      assert.ok(calls.length <= 4, `不该把 16 步烧光: ${calls.length}`);
    });
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
