import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Read-only used to refuse every click, which meant the assistant could only
// reach pages whose URL the knowledge base already recorded. "Open that
// hot-search entry" was refused even though the goal classifier reads it as a
// read, and the mode's own text promises the user it can "enter public pages".
//
// The rule now is narrower than "clicks are allowed": a click is a read only
// when following its link is the whole of its effect. These tests pin both
// halves — the destinations that qualify, and the ones that must keep refusing.
async function moduleFrom(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { isReadOnlyNavigationClick, runtimeActionAllowed } = await moduleFrom("../lib/site-knowledge/runtime-policy.ts");
const { executionRequirementForGoal } = await moduleFrom("../lib/site-knowledge/execution-requirement.ts");

const HERE = "https://www.example.org/search?q=hotel";

test("a link to another page of the same site is a read", () => {
  for (const href of ["/detail/123", "detail/123", "?q=other", "https://www.example.org/rank"]) {
    assert.equal(isReadOnlyNavigationClick(href, HERE), true, `${href} only navigates`);
  }
});

test("a link into the same document is a read", () => {
  assert.equal(isReadOnlyNavigationClick("#section-3", HERE), true);
});

test("a link that navigates nowhere is not a read", () => {
  // These are how a button gets styled as a link. Nothing follows from the
  // href, so whatever the click does happens in a script handler — which is
  // exactly the write this mode exists to refuse.
  for (const href of ["#", "", "   ", null, undefined]) {
    assert.equal(isReadOnlyNavigationClick(href, HERE), false, `${JSON.stringify(href)} has no destination`);
  }
  assert.equal(isReadOnlyNavigationClick(HERE, HERE), false, "a link to where we already are navigates nowhere");
});

test("a link off this site is not a read", () => {
  for (const href of ["https://evil.example/steal", "//evil.example/steal", "https://api.example.org/x"]) {
    assert.equal(isReadOnlyNavigationClick(href, HERE), false, `${href} leaves this origin`);
  }
});

test("a scheme that is not a page load is not a read", () => {
  for (const href of ["javascript:doDelete()", "mailto:a@b.c", "tel:123", "data:text/html,<b>x", "blob:https://www.example.org/x"]) {
    assert.equal(isReadOnlyNavigationClick(href, HERE), false, `${href} does not load a page of this site`);
  }
});

test("an unparseable href is refused rather than throwing", () => {
  assert.doesNotThrow(() => isReadOnlyNavigationClick("http://[", HERE));
  assert.equal(isReadOnlyNavigationClick("http://[", HERE), false);
});

test("an odd href that still resolves inside this site stays a navigation", () => {
  // `://nope` looks malformed but is a perfectly ordinary relative path once
  // resolved, and lands on this origin. Following it is still only a page load,
  // so the judgement here is by destination, never by how the href is spelled.
  assert.equal(new URL("://nope", HERE).origin, new URL(HERE).origin);
  assert.equal(isReadOnlyNavigationClick("://nope", HERE), true);
});

test("nothing else about read-only moved", () => {
  // The allowance is decided per click, from its destination. The action-level
  // policy is untouched, so a click with no link behind it still refuses.
  for (const action of ["click", "fill", "submit", "delete", "upload", "select"]) {
    assert.equal(runtimeActionAllowed("read-only", action), false, `${action} must still be refused outright`);
  }
  assert.equal(runtimeActionAllowed("full", "click"), true);
});

test("the click gate runs after the link is resolved, not before", async () => {
  const source = await readFile(new URL("../client/user-agent-adaptive.ts", import.meta.url), "utf8");
  const body = /controller\.clickElement = async \(index\) => \{[\s\S]*?\n    await animatePointerTo/.exec(source)?.[0] || "";

  assert.ok(body, "the click path has to exist");
  const resolved = body.indexOf("closest<HTMLAnchorElement>");
  const gated = body.indexOf("ensureWriteAuthorized");
  assert.ok(resolved > 0 && gated > 0, "both the link resolution and the gate have to be there");
  assert.ok(resolved < gated,
    "resolving the link after the gate is what made read-only refuse every navigation");

  assert.match(body, /isSensitiveElement\(element\)/,
    "a sensitive control dressed as a link must not become clickable through this path");
  assert.match(body, /isReadOnlyNavigationClick\(anchor\?\.getAttribute\("href"\)/,
    "the raw attribute is what tells `#` apart from a real destination");
});

test("a read goal is no longer refused before PageAgent starts", async () => {
  // The production routing path builds its own requirement shape and labelled
  // every page operation an irreversible write, so this goal never got as far
  // as the click policy above.
  assert.equal(executionRequirementForGoal("我给点进去看看").effect, "read");

  const source = await readFile(new URL("../client/user-agent-port.ts", import.meta.url), "utf8");
  const gate = /const executionRequirement = [\s\S]{0,600}?只读模式/.exec(source)?.[0] || "";

  assert.ok(gate, "the read-only early return has to consult the classifier");
  assert.match(gate, /executionRequirementForGoal\(session\.goal\)/);
  assert.match(gate, /executionRequirement\.effect !== "read"/,
    "a goal the classifier reads as a read must reach PageAgent");
});

test("a write goal is still refused before PageAgent starts", () => {
  for (const goal of ["帮我下单买这个", "把这个提交了"]) {
    assert.notEqual(executionRequirementForGoal(goal).effect, "read", `${goal} must not be treated as a read`);
  }
});
