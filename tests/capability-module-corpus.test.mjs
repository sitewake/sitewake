import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/**
 * Every capability module the authoring pipeline produced on a real
 * installation this week, verbatim except for the site's address, with the
 * verdict the gate must give it.
 *
 * Each rule in the module validator was written after one of these shipped.
 * A rule that refuses one of the good modules, or passes one of the bad ones,
 * is a regression however reasonable it looks on its own — so every change to
 * the validator is checked against all of them, in the public gate.
 */

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../lib/capability-center-v2/javascript-runtime.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
});
const { validateCapabilityJavaScriptSource } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const root = new URL("./fixtures/capability-modules/", import.meta.url);
const verdicts = JSON.parse(await readFile(new URL("verdicts.json", root), "utf8"));

test("every module in the corpus has a recorded verdict", async () => {
  const files = (await readdir(root)).filter((name) => name.endsWith(".js")).sort();
  assert.deepEqual(files, Object.keys(verdicts).sort());
});

for (const [name, { expected, about, requiredInputs }] of Object.entries(verdicts)) {
  test(`${name}: ${expected === "ok" ? "accepted" : expected} — ${about}`, async () => {
    const source = await readFile(new URL(name, root), "utf8");
    const verdict = validateCapabilityJavaScriptSource(source, requiredInputs, []);
    const got = verdict.ok ? "ok" : verdict.code.split(":")[0];
    assert.equal(got, expected, verdict.ok ? "accepted" : verdict.message);
    // Whatever the authoring verdict, a module already published stays servable.
    assert.deepEqual(validateCapabilityJavaScriptSource(source, [], [], { scope: "execution" }), { ok: true });
  });
}

/**
 * The point of the provenance rule is that it does not need to have seen a
 * shape before. None of these is named by any specific rule; every one of
 * them is a way of guessing a title out of a text blob, and every one must be
 * refused. Below them, novel *legitimate* readings must be accepted.
 */
const stage = (body) => `export const capability={version:2,stages:[{id:"stage_verify",async run({input,state,waitFor,identityMatches}){${body}}}]};`;

test("a shape no specific rule names is still refused when it comes from a blob", () => {
  const refused = [
    ["indexing into the split blob", `const lines=document.body.innerText.split("\\n");const title=lines[2];return{outcome:"Success",output:{title}}`],
    ["substring between two indexOf positions", `const t=document.querySelector('[role="dialog"]').innerText;const title=t.substring(t.indexOf("Close")+5,t.indexOf("热度"));return{outcome:"Success",output:{title}}`],
    ["filtering the blob's lines by length", `const dialogText=document.querySelector('[role="dialog"]').innerText;const title=dialogText.split("\\n").map(l=>l.trim()).filter(l=>l.length>5)[0];return{outcome:"Success",output:{title}}`],
    ["a dialog variable's text with a replace chain", `const dialog=document.querySelector('[role="dialog"]');const title=dialog.innerText.replace(/^Close/,"").trim().split("\\n")[0];return{outcome:"Success",output:{title}}`],
    ["a value from nowhere", `let title="";try{title=window.__lastTitle}catch{}return{outcome:"Success",output:{title}}`],
    // A placeholder that is filled from somewhere other than the page is still refused.
    ["a null placeholder filled from nowhere", `let el=null;el=window.__lastCard;const title=(el?.textContent||"").trim();return{outcome:"Success",output:{title}}`],
    ["a title assembled from pieces of the blob", `const t=document.body.innerText;const title=t.split(" ")[3]+" "+t.split(" ")[4];return{outcome:"Success",output:{title}}`],
    ["a parenthesised blob with string operations", `const title=(document.body.innerText||"").split("\\n")[1];return{outcome:"Success",output:{title}}`],
    // Following a helper must not become "any call is fine": one the module
    // never declares is still a value from nowhere, and so is a helper that
    // reads the blob.
    ["a call to something the module never declares", `const title=buildTitle();return{outcome:"Success",output:{title}}`],
    ["a helper that reads the blob", `function pick(){return document.body.innerText.split("\\n")[2]}const title=pick();return{outcome:"Success",output:{title}}`],
  ];
  for (const [label, body] of refused) {
    const verdict = validateCapabilityJavaScriptSource(stage(body), []);
    assert.equal(verdict.ok, false, `${label}: should be refused`);
    assert.match(verdict.code, /^capability_module_output_provenance_unknown:title$/, `${label}: ${verdict.code}`);
  }
});

test("a reading no specific rule has seen is accepted when it comes from an element", () => {
  const accepted = [
    ["a table cell", `const row=document.querySelector("tr.selected");const cell=row.querySelector("td:nth-child(2)");const title=cell.textContent.trim();return{outcome:"Success",output:{title}}`],
    ["the acted-on identity carried through", `const title=state.targets.__actedOn;return{outcome:"Success",output:{title}}`],
    ["closest() then a heading", `const el=await waitFor(".result");const title=el.closest("article").querySelector("h3").innerText;return{outcome:"Success",output:{title}}`],
    ["a data attribute and a link", `const card=document.querySelector("[data-topic-id]");return{outcome:"Success",output:{id:card.dataset.topicId,url:card.querySelector("a").href}}`],
    ["a number parsed out of the blob, and a literal", `const m=document.body.innerText.match(/共\\s*(\\d+)\\s*条/);return{outcome:"Success",output:{total:m?parseInt(m[1],10):0,currency:"CNY"}}`],
    // A parenthesised fallback with operations applied to the group, the
    // idiom every hand-written module uses; the gate refused it as untraceable.
    ["a parenthesised fallback with string operations", `const heading=(document.querySelector("h1")?.textContent||"").replace(/\\s+/g," ").trim();return{outcome:"Success",output:{heading}}`],
    // The ordinary search for an element: a placeholder declared empty, filled
    // by a loop over candidates. Refused as untraceable, it burned a whole
    // authoring budget on a module that was reading the page correctly.
    ["a null placeholder filled by a search loop", `let titleEl=null;const dialog=document.querySelector('[role="dialog"]');for(const el of dialog.querySelectorAll("h1,h2,h3")){const t=(el.innerText||"").trim();if(t&&t!=="Close"){titleEl=el;break}}if(!titleEl){return{outcome:"NoResult",reason:"no title"}}const title=(titleEl.textContent||titleEl.innerText||"").trim();return{outcome:"Success",output:{title}}`],
    ["a list built from elements", `const items=[...document.querySelectorAll("li.result")].map(li=>({title:li.querySelector("h3").textContent.trim(),href:li.querySelector("a").href}));return{outcome:"Success",output:{items}}`],
    ["a capture on the element's own text", `const cell=document.querySelector(".heat");const m=cell.innerText.match(/^(.+?)万$/);return{outcome:"Success",output:{heat:m?m[1]:null}}`],
    ["the page address and the input echoed", `return{outcome:"Success",output:{url:location.href,query:input.keyword}}`],
    // A list read off the page through a helper. 查看某一天的微博热搜榜单 was
    // refused twice for it — output.topics cannot be traced to anything the
    // page provides — and the run stopped with the list read correctly.
    ["a helper the module declares", `function collect(){return [...document.querySelectorAll(".row")].map(row=>({title:row.querySelector("h3").textContent.trim()}))}const topics=collect();return{outcome:"Success",output:{topics}}`],
    ["an arrow helper the module assigns", `const collect=()=>[...document.querySelectorAll(".row")].map(row=>({title:row.textContent.trim()}));const topics=collect();return{outcome:"Success",output:{topics}}`],
    ["a helper with a block body and an early return", `function collect(){const board=document.querySelector("#board");if(!board){return []}return [...board.querySelectorAll(".row")].map(row=>({title:row.textContent.trim()}))}const topics=collect();return{outcome:"Success",output:{topics}}`],
  ];
  for (const [label, body] of accepted) {
    const verdict = validateCapabilityJavaScriptSource(stage(body), []);
    assert.deepEqual(verdict, { ok: true }, `${label}: ${verdict.code} ${verdict.message}`);
  }
});
