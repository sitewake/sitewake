import assert from 'node:assert/strict';
import test from 'node:test';
import {capabilityCompletionText} from '../lib/capability-center-v2/result-presentation.ts';
import {validateCapabilityResultOutput,normalizeContractOutputSchema} from '../runner/capability-v2/browser-runtime.ts';
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
