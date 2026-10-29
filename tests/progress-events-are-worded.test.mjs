/**
 * Every progress event a runner or the control plane records is a stable
 * marker that the console words in the reader's language.
 *
 * The emitters are found with the TypeScript compiler, not by matching line
 * shapes: an earlier guard that matched `message:` lines missed twenty Chinese
 * messages passed as plain call arguments, and an English console showed them.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EMITTER_ROOTS = ["runner/capability-v2", "lib/capability-center-v2", "db"];
const HAN = /\p{Script=Han}/u;

function sourceFiles(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(join(ROOT, path)).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

/** The string literals an expression can evaluate to, or undefined when it is not only literals. */
function literals(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return literals(node.expression);
  if (ts.isConditionalExpression(node)) {
    const whenTrue = literals(node.whenTrue);
    const whenFalse = literals(node.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : undefined;
  }
  return undefined;
}

function property(objectLiteral, name) {
  const found = objectLiteral.properties.find((item) => item.name?.getText() === name);
  if (!found) return undefined;
  return ts.isShorthandPropertyAssignment(found) ? found.name : found.initializer;
}

/** Every progress message expression in the emitter roots, with where it is. */
function emittedMessages() {
  const found = [];
  for (const file of EMITTER_ROOTS.flatMap(sourceFiles)) {
    const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
    const at = (node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const visit = (node) => {
      // An event posted straight to the events endpoint: { eventType, message }.
      if (ts.isObjectLiteralExpression(node) && property(node, "eventType") && property(node, "message")) {
        const message = property(node, "message");
        found.push({ at: at(node), expression: message, text: message.getText(source) });
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(source).replace(/\?\.$/, "");
        if (/(?:^|\.)onEvent$/.test(callee)) {
          const [first, second] = node.arguments;
          const message = first && ts.isObjectLiteralExpression(first) ? property(first, "message") : second;
          if (message) found.push({ at: at(node), expression: message, text: message.getText(source) });
        }
        if (/(?:^|\.)appendTaskEvent$/.test(callee)) {
          const event = node.arguments[2];
          const payload = event && ts.isObjectLiteralExpression(event) ? property(event, "payload") : undefined;
          const message = payload && ts.isObjectLiteralExpression(payload) ? property(payload, "message") : undefined;
          if (message) found.push({ at: at(node), expression: message, text: message.getText(source) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/**
 * A relay forwards a marker its caller chose: a function's own parameter (the
 * onEvent implementation posting `message`) or that parameter's field. The
 * callers are emitters too, and are checked where they choose the marker.
 */
function isRelay(expression) {
  const root = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
  if (!ts.isIdentifier(root)) return false;
  for (let node = expression.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node) && node.parameters?.some((parameter) => parameter.name.getText() === root.text)) return true;
  }
  return false;
}

async function catalogs() {
  const load = async (file) => {
    const result = await build({ entryPoints: [join(ROOT, file)], bundle: true, platform: "node", format: "esm", write: false });
    const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
    return Object.values(module).find((value) => value && typeof value === "object" && value.capability);
  };
  const [zh, en] = await Promise.all([load("lib/i18n/zh.ts"), load("lib/i18n/en.ts")]);
  return { zh: zh.capability.v2.screen.activityMessage, en: en.capability.v2.screen.activityMessage };
}

const SAMPLE = { turn: 3, example: 2, caseIndex: 2, caseId: "case_2", caseCount: 3, field: "status" };
const worded = (entry) => (typeof entry === "function" ? entry(SAMPLE) : entry);

test("every progress message is a fixed marker, never prose built at run time", () => {
  const messages = emittedMessages();
  assert.ok(messages.length >= 30, `expected the known emitters to be found, found ${messages.length}`);
  for (const message of messages) {
    if (isRelay(message.expression)) continue;
    const values = literals(message.expression);
    assert.ok(values, `${message.at} emits ${message.text}: a progress message must be a marker; put the varying part in the payload`);
    for (const value of values) assert.ok(!HAN.test(value), `${message.at} emits prose a reader has to be fluent in: ${value}`);
  }
});

/** The fixed text of an expression: literals, and the literal spans of a template. */
function fixedText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.flatMap((span) => [span.literal.text, ...fixedText(span.expression)])];
  if (ts.isParenthesizedExpression(node)) return fixedText(node.expression);
  if (ts.isConditionalExpression(node)) return [...fixedText(node.whenTrue), ...fixedText(node.whenFalse)];
  if (ts.isBinaryExpression(node)) return [...fixedText(node.left), ...fixedText(node.right)];
  return [];
}

test("a debug trace message is engineering text in English, wherever it is built", () => {
  // Trace events ({ stage, message }) are shown verbatim in the engineering
  // record, not worded from a catalog; "navigate · 页面 · 页面已变化" reached an
  // English console this way.
  const offenders = [];
  for (const file of EMITTER_ROOTS.flatMap(sourceFiles)) {
    const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node) && property(node, "stage") && property(node, "message")) {
        const text = fixedText(property(node, "message")).join("");
        if (HAN.test(text)) offenders.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${text.slice(0, 60)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(offenders, []);
});

test("guidance a task record carries is English, wherever it is written", () => {
  // Task guidance is read by the authoring models and shown verbatim in the
  // console's engineering details; "能力目标已由 B 抽象为：…" reached an
  // English reader that way.
  const offenders = [];
  for (const file of EMITTER_ROOTS.flatMap(sourceFiles)) {
    const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      const guidance = ts.isPropertyAssignment(node) && node.name.getText(source) === "guidance";
      const derived = ts.isPropertyAssignment(node) && node.name.getText(source) === "text"
        && node.parent?.parent?.parent && ts.isPropertyAssignment(node.parent.parent.parent) && node.parent.parent.parent.name.getText(source) === "__derivedGuidance";
      if (guidance || derived) {
        const text = fixedText(node.initializer).join("");
        if (HAN.test(text)) offenders.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${text.slice(0, 60)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(offenders, []);
});

test("every marker an emitter can produce is worded in both languages", async () => {
  const { zh, en } = await catalogs();
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "the two catalogs word the same markers");
  const markers = new Set(emittedMessages().flatMap((message) => literals(message.expression) || []));
  for (const marker of markers) {
    for (const [locale, catalog] of [["zh", zh], ["en", en]]) {
      const copy = worded(catalog[marker]);
      assert.ok(typeof copy === "string" && copy.trim().length >= 2, `"${marker}" is emitted but has no ${locale} wording`);
    }
    assert.ok(!HAN.test(worded(en[marker])), `the English wording of "${marker}" is not English`);
  }
  // A worded marker nobody emits is a rename that left the catalog behind.
  const unused = Object.keys(en).filter((key) => !markers.has(key) && !["review approved", "review rejected", "review failed", "approved on validation: the demonstrated case and the offered values passed", "review rejected: the demonstrated input's case did not pass", "review rejected: the demonstrated input's case found nothing where the visitor's run found a result", "review rejected: a case found nothing for a value the site lists beside the demonstrated one", "review rejected: no validation case passed", "review rejected: a case failed for a value the site lists beside the demonstrated one", "review rejected: a demonstrated value is written into the source"].includes(key));
  assert.deepEqual(unused, [], "catalog entries no emitter produces");
});
