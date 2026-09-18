import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { runCapabilityJavaScriptStages } from '../runner/capability-v2/javascript-stage-runner.ts';
import { capabilityModuleHash } from "../lib/capability-center-v2/javascript-runtime.ts";
import { evaluateResultDeterministic } from '../runner/capability-v2/browser-runtime.ts';

const [command, location, ...rest] = process.argv.slice(2);
const option = name => rest[rest.indexOf(name) + 1];
const hash = value => createHash('sha256').update(value).digest('hex');
if (command === 'unpack') {
  const bytes = await readFile(location);
  const bundle = JSON.parse((bytes[0] === 31 && bytes[1] === 139 ? gunzipSync(bytes) : bytes).toString());
  if (bundle.schemaVersion !== 'capability-workspace.v1' || !Array.isArray(bundle.files)) throw new Error('workspace_schema_invalid');
  const destination = resolve(option('--out') || location + '.project');
  // Never unpack into an existing tree (including symlinks).
  await mkdir(destination, {recursive:false,mode:0o700});
  const seen = new Set();
  for (const file of bundle.files) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.startsWith('/') || file.path.split('/').some(p => p === '..' || p === '.') || seen.has(file.path)) throw new Error('workspace_path_invalid');
    if (hash(file.content) !== file.sha256) throw new Error('workspace_integrity_failed:'+file.path);
    seen.add(file.path);
  }
  for (const file of bundle.files) {
    const path = join(destination,file.path);
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    await writeFile(path,file.content,{flag:'wx',mode:0o600});
  }
  console.log(JSON.stringify({directory:destination,files:bundle.files.length}));
} else if (command === 'run') {
  const root = resolve(location);
  const runtime = JSON.parse(await readFile(join(root,'context/runtime.json'),'utf8'));
  if (runtime.target !== 'browser-sdk' || !['1','2'].includes(runtime.kernelVersion)) throw new Error('workspace_runtime_incompatible');
  const program = JSON.parse(await readFile(join(root,'dist/program.json'),'utf8'));
  const contract = JSON.parse(await readFile(join(root,'dist/contract.json'),'utf8'));
  const source = await readFile(join(root,'dist/capability.js'),'utf8');
  if (await capabilityModuleHash(source) !== program.module.contentHash) throw new Error('workspace_module_integrity_failed');
  const input = JSON.parse(await readFile(option('--input'),'utf8'));
  const url = option('--url');
  if (!url || !/^https?:/.test(url)) throw new Error('workspace_start_url_required');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const moduleUrl = new URL(`/api/capability-v2/modules/${program.module.contentHash}`,url).href;
    await page.route(moduleUrl, route => route.fulfill({status:200,contentType:'text/javascript',body:source}));
    await page.goto(url,{waitUntil:'networkidle'});
    const result = await runCapabilityJavaScriptStages({page,moduleUrl,program,input});
    const {page: _page,...receipt} = result;
    if (receipt.outcome === 'Success') await evaluateResultDeterministic(page,contract,receipt.output,{parameters:input,context:{},trigger:{},interactions:[]},receipt.observedText);
    await mkdir(join(root,'reports'),{recursive:true});
    await writeFile(join(root,'reports/local-replay.json'),JSON.stringify(receipt,null,2),{mode:0o600});
    console.log(JSON.stringify({outcome:receipt.outcome,output:receipt.output,report:join(root,'reports/local-replay.json')}));
    if (receipt.outcome !== 'Success') process.exitCode=1;
  } finally {await browser.close();}
} else throw new Error('Usage: npm run capability:workspace -- unpack <export> --out <new-directory> | run <directory> --url <site> --input <input.json>');
