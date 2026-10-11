import assert from 'node:assert/strict';
import test from 'node:test';
import {capabilityCompletionText} from '../lib/capability-center-v2/result-presentation.ts';
import {validateCapabilityResultOutput,normalizeContractOutputSchema,ensureResultOutputCondition,reconcileOutputConditionsWithSchema,evidenceThatSurvivedSettling,alignSuccessConditionsToEvidence} from '../runner/capability-v2/browser-runtime.ts';
import {assertCapabilityOutput} from '../lib/site-knowledge/capability-output.ts';

const schema={type:'object',properties:{targetTitle:{type:'string',minLength:1},targetUrl:{type:'string',format:'uri'},currentRank:{type:'number',title:'当前排名'},heat:{type:'string',title:'热度'}},required:['targetTitle'],additionalProperties:false};
test('hotsearch reply displays returned business identity, link and actual rank',()=>{
 const reply=capabilityCompletionText('打开第 {{rank}} 个热搜',{rank:3},{targetTitle:'真实话题',targetUrl:'https://example.test/?topic=actual',currentRank:14,heat:'182.7万'},schema);
 assert.equal(reply,'已完成：打开第 3 个热搜「真实话题」\n\n- 当前排名：14\n- 热度：182.7万\n\n[查看详情](https://example.test/?topic=actual)');
 const optional=capabilityCompletionText('打开第 {{rank}} 个热搜',{rank:3},{targetTitle:'真实话题'},schema);
 assert.doesNotMatch(optional,/当前排名|热度|undefined|查看详情/);
});
test('legacy outputs remain useful without inventing an entity title',()=>{
 const reply=capabilityCompletionText('打开第 {{rank}} 个热搜',{rank:3},{pageUrl:'https://example.test/?topic=actual',pageTitle:'热搜时光机'});
 assert.match(reply,/查看详情/);assert.doesNotMatch(reply,/热搜时光机|「|\{\{/);
 assert.equal(capabilityCompletionText('筛选商品',{},{}),'已完成：筛选商品');
});
test('result text cannot inject Markdown links or unsafe URL schemes',()=>{
 const reply=capabilityCompletionText('打开条目',{}, {targetTitle:'[假链接](https://evil.test)',targetUrl:'javascript:alert(1)',resultSummary:'<img src=x> **指令**'});
 assert.doesNotMatch(reply,/\[假链接\]|javascript:|<img|\*\*/);
 assert.doesNotMatch(capabilityCompletionText('查看',{}, {targetUrl:'https://user:secret@example.test'}),/secret|查看详情/);
 assert.match(capabilityCompletionText('查看',{}, {targetUrl:'https://example.test/a(b)'}),/a%28b%29/);
});
test('authoring and SDK both reject absent or empty required business output',()=>{
 const contract={outputSchema:schema};
 for(const output of [{},{targetTitle:''},{targetTitle:42},{targetTitle:'话题',targetUrl:'not-a-url'}]){
  assert.throws(()=>validateCapabilityResultOutput(contract,output),/output_schema_invalid/);
  assert.throws(()=>assertCapabilityOutput(schema,output),/capability_output/);
 }
 const valid={targetTitle:'实际话题',currentRank:14};
 assert.doesNotThrow(()=>validateCapabilityResultOutput(contract,valid));assert.doesNotThrow(()=>assertCapabilityOutput(schema,valid));
 assert.deepEqual(normalizeContractOutputSchema(schema,{pageUrl:'https://example.test',pageTitle:'Generic'}),schema,'exploration outputs must not erase authored business fields');
});
test('the fallback output predicate names a field the Contract declares, never an exploration-only key',()=>{
 // Discovery output always carries pageUrl/pageTitle; the authored schema here declares neither.
 const exploration={pageUrl:'https://example.test/search?q=x',pageTitle:'热搜时光机'};
 const authored={type:'object',properties:{targetTitle:{type:'string'},targetUrl:{type:'string'}},required:['targetTitle','targetUrl'],additionalProperties:false};
 assert.deepEqual(ensureResultOutputCondition([{type:'inputExists',path:'keyword'}],exploration,authored),
  [{type:'inputExists',path:'keyword'},{type:'outputExists',path:'targetTitle'}],'stage_verify may only write declared fields, so the predicate must be declared too');
 assert.deepEqual(ensureResultOutputCondition([],exploration,{type:'object',properties:{pageUrl:{type:'string'},pageTitle:{type:'string'}}}),
  [{type:'outputExists',path:'pageUrl'}],'pageUrl stays the preferred envelope field when it is declared');
 assert.deepEqual(ensureResultOutputCondition([],exploration,{type:'object',properties:{}}),
  [{type:'outputExists',path:'pageUrl'}],'a schema without fields leaves the output free-form');
 assert.deepEqual(ensureResultOutputCondition([],exploration,{type:'object',properties:{},additionalProperties:false}),[],'a closed empty schema admits no output predicate');
 assert.deepEqual(ensureResultOutputCondition([{type:'textTemplate',template:'{{keyword}}'}],exploration,authored),
  [{type:'textTemplate',template:'{{keyword}}'}],'an existing business predicate is left alone');
});
test('output predicates on undeclared fields are dropped before the Contract freezes',()=>{
 const authored={type:'object',properties:{targetTitle:{type:'string'},targetUrl:{type:'string'}},additionalProperties:false};
 const conditions=[{type:'inputExists',path:'keyword'},{type:'outputExists',path:'pageUrl'},{type:'outputEquals',path:'targetUrl',value:'x'},{type:'outputExists',path:'targetTitle.text'},'free text'];
 assert.deepEqual(reconcileOutputConditionsWithSchema(conditions,authored),
  [{type:'inputExists',path:'keyword'},{type:'outputEquals',path:'targetUrl',value:'x'},{type:'outputExists',path:'targetTitle.text'},'free text']);
 assert.deepEqual(reconcileOutputConditionsWithSchema(conditions,{type:'object',properties:{}}),conditions,'a schema without fields constrains nothing');
});

test('a page still announcing its work cannot freeze that announcement into the Contract',()=>{
 // The site answers a search with a live region: first "正在查找包含…", then the
 // results. The explorer called done on the first frame, so a sentence the page
 // was about to withdraw became a success condition, and every draft that
 // waited for the search to finish was rejected with success_text_missing.
 const observed={url:'https://example.test/',title:'示例站点',heading:'示例站点',text:'搜索 正在查找包含“周杰伦”的词条 最近热点',signals:['正在查找包含“周杰伦”的词条']};
 const settled={url:'https://example.test/',title:'示例站点',heading:'示例站点',text:'搜索 找到 12 条包含“周杰伦”的词条 相关词条 A 相关词条 B',signals:['找到 12 条包含“周杰伦”的词条']};
 const survived=evidenceThatSurvivedSettling(observed,settled);
 assert.deepEqual(survived.signals,['找到 12 条包含“周杰伦”的词条'],'the progress line is gone; the result line is the completion signal');
 assert.equal(survived.text,settled.text,'the Contract is designed against the settled page');
 const plan={intent:'查询 {{celebrityName}} 的热搜',name:'查询人物热搜',description:'',aliases:[],parameters:[{name:'celebrityName',type:'string',description:'',required:true,exampleValue:'周杰伦'}],groundingExamples:[],scope:{kind:'site-global',onMismatch:'page-agent'}};
 const designed=[{type:'textTemplate',template:'正在查找包含“{{celebrityName}}”的词条'},{type:'textTemplate',template:'{{celebrityName}}'}];
 assert.deepEqual(alignSuccessConditionsToEvidence(designed,plan,survived.url,{celebrityName:'周杰伦'},survived.text),
  [{type:'textTemplate',template:'{{celebrityName}}'}],'a condition the settled page does not carry is not a condition');
 assert.deepEqual(alignSuccessConditionsToEvidence(designed,plan,observed.url,{celebrityName:'周杰伦'},observed.text),designed,
  'without settling, the progress sentence survives alignment: that is the failure this guards');
});
test('settling never discards the only account of what happened',()=>{
 const observed={url:'https://example.test/cart',title:'',heading:'',text:'已加入购物车',signals:['已加入购物车']};
 assert.deepEqual(evidenceThatSurvivedSettling(observed,undefined),observed,'a page that cannot be read again leaves the observation standing');
 assert.deepEqual(evidenceThatSurvivedSettling(observed,{...observed,url:'https://example.test/checkout',text:'结算',signals:[]}),observed,
  'the page moved on: the observation still describes the address it was taken at');
 const kept=evidenceThatSurvivedSettling(observed,{...observed,text:'已加入购物车 共 1 件商品',signals:['共 1 件商品']});
 assert.deepEqual(kept.signals,['已加入购物车','共 1 件商品'],'evidence that outlived the settle is kept, and what the settled page adds joins it');
 assert.deepEqual(evidenceThatSurvivedSettling(observed,{...observed,signals:['购物车已更新']}).signals,['已加入购物车'],
  'a signal the page text does not carry could only fail the text check it would become');
});

test("text that was already on the page is not evidence that the capability did anything",()=>{
 // A by-date capability was published on the strength of 「热搜时光机」, the
 // site's own name, which every page carries. It clicked a date picker,
 // reported the document title, echoed the date back and passed — and once
 // called it returned the home page's title for any day it was asked about.
 const plan={intent:'查看{{date}}热搜',name:'查看指定日期热搜',description:'',aliases:[],parameters:[{name:'date',type:'string',description:'',required:true,exampleValue:'2026年9月20日'}],groundingExamples:[],scope:{kind:'site-global',onMismatch:'page-agent'}};
 const entry='热搜时光机 实时热搜 日榜 词云';
 const result='热搜时光机 2026年09月20日微博热搜榜 全天热搜聚合 601 个独立话题';
 const designed=[{type:'textIncludes',value:'热搜时光机'},{type:'textIncludes',value:'全天热搜聚合'},{type:'textTemplate',template:'{{date}}'}];
 assert.deepEqual(alignSuccessConditionsToEvidence(designed,plan,'https://example.test/daily/2026-09-20',{date:'2026年09月20日'},result,entry),
  [{type:'textIncludes',value:'全天热搜聚合'},{type:'textTemplate',template:'{{date}}'}],
  '品牌名两边都有，不能作为成功条件；只在结果页出现的文案和参数化模板保留');
 // Without an entry page to compare against, nothing changes.
 assert.equal(alignSuccessConditionsToEvidence(designed,plan,'https://example.test/daily/2026-09-20',{date:'2026年09月20日'},result).length,3);
});
