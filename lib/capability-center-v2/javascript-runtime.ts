import type {
  CapabilityProgram,
  CapabilityInputAliases,
  CapabilityPromptProvenance,
  CapabilityStageManifest,
  CapabilityControlFlow,
  CapabilityTargetBinding,
  CapabilityParameterRole,
  CapabilitySemanticIR,
  DependencyLedgerEntry,
  EntryPolicy,
  JsonObject,
} from "./model";
import {
  normalizeCapabilityStageIO,
  normalizeCapabilityStageNavigation,
} from "./stage-io";

export const CAPABILITY_V2_MAX_MODULE_BYTES = 120_000;
export const CAPABILITY_V2_MODULE_MIME = "text/javascript; charset=utf-8";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

/**
 * Remove comments for source heuristics while preserving quoted JavaScript
 * strings.  Comments are not executable capability semantics, so a model
 * explaining a forbidden example must not make the executable source fail a
 * quality gate.  This intentionally remains a small lexer rather than a
 * parser; it only needs to distinguish quotes, escapes and comment markers.
 */
function stripJavaScriptComments(source: string) {
  let output = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      output += current;
      if (escaped) { escaped = false; continue; }
      if (current === "\\") { escaped = true; continue; }
      if (current === quote) quote = "";
      continue;
    }
    if (current === "\"" || current === "'" || current === "`") {
      quote = current;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      if (index < source.length) output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      output += " ";
      continue;
    }
    output += current;
  }
  return output;
}

/**
 * The bodies of a pattern's capturing groups, character classes and escapes
 * respected. Used to tell a captured identity from a captured count.
 */
function capturingGroupBodies(patternBody: string) {
  const groups: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < patternBody.length; index += 1) {
    const character = patternBody[index];
    if (character === "\\") { index += 1; continue; }
    if (character === "[") {
      index += 1;
      while (index < patternBody.length && patternBody[index] !== "]") {
        if (patternBody[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (character === "(") {
      if (depth === 0 && patternBody[index + 1] !== "?") start = index + 1;
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth === 0 && start >= 0) { groups.push(patternBody.slice(start, index)); start = -1; }
    }
  }
  return groups;
}



/**
 * The same source with the bodies of string, template and regular-expression
 * literals replaced by filler of the same length, delimiters kept. Every
 * scanner that counts brackets or looks for a separator runs on this and
 * slices the original at the same indices, so a `+` inside `/\d+/` or a `,`
 * inside a string never splits an expression. Template interpolations stay
 * unmasked: they are code.
 */
function maskLiterals(source: string) {
  const out = source.split("");
  const regexMayStartAfter = /[(,=:[!&|?{};+\-*%<>~^]$/u;
  let index = 0;
  const templateDepth: number[] = [];
  while (index < source.length) {
    const character = source[index];
    if (character === '"' || character === "'") {
      index += 1;
      while (index < source.length && source[index] !== character) {
        if (source[index] === "\\") { out[index] = "_"; index += 1; }
        if (index < source.length) out[index] = "_";
        index += 1;
      }
      index += 1;
      continue;
    }
    if (character === "`") {
      index += 1;
      while (index < source.length && source[index] !== "`") {
        if (source[index] === "\\") { out[index] = "_"; index += 1; if (index < source.length) out[index] = "_"; index += 1; continue; }
        if (source[index] === "$" && source[index + 1] === "{") {
          // Interpolated code: copy through to the matching brace.
          let depth = 0;
          while (index < source.length) {
            if (source[index] === "{") depth += 1;
            else if (source[index] === "}") { depth -= 1; if (depth === 0) { index += 1; break; } }
            index += 1;
          }
          continue;
        }
        out[index] = "_";
        index += 1;
      }
      index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] !== "/" && source[index + 1] !== "*") {
      const before = source.slice(0, index).replace(/\s+$/u, "");
      if (!before || regexMayStartAfter.test(before) || /\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw)$/u.test(before)) {
        index += 1;
        let inClass = false;
        while (index < source.length) {
          const inner = source[index];
          if (inner === "\\") { out[index] = "_"; index += 1; if (index < source.length) out[index] = "_"; index += 1; continue; }
          if (inner === "\n") break;
          if (inClass) { if (inner === "]") inClass = false; out[index] = "_"; index += 1; continue; }
          if (inner === "[") { inClass = true; out[index] = "_"; index += 1; continue; }
          if (inner === "/") break;
          out[index] = "_";
          index += 1;
        }
        index += 1;
        while (index < source.length && /[a-z]/u.test(source[index])) index += 1;
        continue;
      }
    }
    index += 1;
    void templateDepth;
  }
  return out.join("");
}

/** The body of the balanced `{…}` block whose opening brace is at `index`, or undefined. */
function balancedBlockBody(source: string, index: number) {
  if (source[index] !== "{") return undefined;
  const masked = maskLiterals(source);
  let depth = 0;
  for (let cursor = index; cursor < masked.length; cursor += 1) {
    const character = masked[cursor];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(index + 1, cursor);
    }
  }
  return undefined;
}

/** The text inside the balanced `(…)` starting at `index`, and where it ends. */
/**
 * The steps of a member or call chain, or nothing when the text is not one.
 *
 * The scanners used to read a chain with a regular expression that allowed a
 * call's arguments to nest parentheses one level deep. A callback body nests
 * more than that the moment it does any work, so the chain stopped being
 * recognised — and the output built by `links.map(link => { … })` could not be
 * traced to the page it plainly came from. A capability that returns a list
 * could not be written at all: the same rule refused it twice in a row and
 * authoring gave up. Counting brackets has no such limit.
 */
function chainSteps(rest: string): string[] | undefined {
  const masked = maskLiterals(rest);
  const steps: string[] = [];
  let index = 0;
  while (index < rest.length) {
    const start = index;
    while (index < rest.length && /\s/u.test(masked[index])) index += 1;
    if (index >= rest.length) break;
    if (masked[index] === "[") {
      const close = balancedFrom(masked, index, "[", "]");
      if (close === undefined) return undefined;
      steps.push(rest.slice(start, close + 1));
      index = close + 1;
      continue;
    }
    const optional = masked.startsWith("?.", index);
    if (!optional && masked[index] !== ".") return undefined;
    index += optional ? 2 : 1;
    while (index < rest.length && /\s/u.test(masked[index])) index += 1;
    const name = /^[A-Za-z_$][\w$]*/u.exec(rest.slice(index));
    if (!name) return undefined;
    index += name[0].length;
    let after = index;
    while (after < rest.length && /\s/u.test(masked[after])) after += 1;
    if (masked[after] === "(") {
      const close = balancedFrom(masked, after, "(", ")");
      if (close === undefined) return undefined;
      index = close + 1;
    }
    steps.push(rest.slice(start, index));
  }
  return steps;
}

function balancedFrom(masked: string, index: number, open: string, close: string) {
  let depth = 0;
  for (let cursor = index; cursor < masked.length; cursor += 1) {
    const character = masked[cursor];
    if (character === open || character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === close || character === ")" || character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0) return character === close ? cursor : undefined;
    }
  }
  return undefined;
}

function balancedParens(source: string, index: number) {
  if (source[index] !== "(") return undefined;
  const masked = maskLiterals(source);
  let depth = 0;
  for (let cursor = index; cursor < masked.length; cursor += 1) {
    const character = masked[cursor];
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return { inner: source.slice(index + 1, cursor), end: cursor };
    }
  }
  return undefined;
}


/**
 * A capture that can match open-ended text: built from `.`, `\S`, `\w`, a
 * negated class, `[\s\S]`, a letter or CJK class. A capture built only from
 * digits, escaped punctuation and literal characters matches a value, and a
 * value is a reading wherever the text came from.
 */
function isIdentityCapture(group: string) {
  return /(?<!\\)\.|\\[SwW]|\[\^|\[\\s\\S\]|\[\\S\\s\]|\\u[0-9a-fA-F]{4}|\\p\{|\[[^\]]*[A-Za-z]-[A-Za-z]/u.test(group);
}

/** Split `a, b, c` at depth zero, respecting (), [], {}, strings and templates. */
function splitTopLevel(source: string, separator: string) {
  const parts: string[] = [];
  const masked = maskLiterals(source);
  let depth = 0;
  let start = 0;
  for (let index = 0; index < masked.length; index += 1) {
    const character = masked[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (depth === 0 && masked.startsWith(separator, index)) {
      parts.push(source.slice(start, index));
      start = index + separator.length;
      index += separator.length - 1;
    }
  }
  parts.push(source.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Strip one layer of wrapping parentheses, repeatedly. */
function unwrap(expression: string) {
  let current = expression.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    const inner = balancedParens(current, 0);
    if (!inner || inner.end !== current.length - 1) break;
    current = inner.inner.trim();
  }
  return current;
}

type Provenance = "ok" | "blob" | "unknown";

/**
 * Where a value in stage_verify comes from.
 *
 * Every earlier rule about the verify stage named one bad shape — text sliced
 * between two phrases, a guard with an empty body, a guard that rewrote its
 * value, a URL assembled from a literal — and each was written after a module
 * had already shipped with it. A model has more ways to guess a title out of a
 * text blob than a list of regular expressions will ever hold. This reads the
 * other way round: an output is accepted when it can be traced to something
 * the page actually provides, and refused otherwise, whatever the shape.
 *
 * Accepted sources: a property of a located element (querySelector, closest,
 * waitFor, find, waitForTarget, or a child/loop element of those); location;
 * state; input; a literal; and trim/replace/slice/split/parseInt/Number or a
 * regular-expression capture applied to one of those. The text of the whole
 * document or of a dialog is a blob: a string cut out of it is refused, a
 * number parsed out of it is a reading.
 */
/**
 * The expressions a function body returns.
 *
 * A capability that reads a list off the page is naturally written with a
 * helper — `const topics = collectTopics()` — and the trace stopped at the
 * call: output.topics could not be traced to anything the page provides, and
 * the capability was refused for a list it had read correctly.
 */
function returnExpressions(body: string): string[] {
  const masked = maskLiterals(body);
  const found: string[] = [];
  for (const match of masked.matchAll(/\breturn\b/gu)) {
    const start = match.index + match[0].length;
    let depth = 0;
    let end = masked.length;
    for (let cursor = start; cursor < masked.length; cursor += 1) {
      const character = masked[cursor];
      if (character === "(" || character === "[" || character === "{") depth += 1;
      else if (character === ")" || character === "]" || character === "}") {
        if (depth === 0) { end = cursor; break; }
        depth -= 1;
      } else if (depth === 0 && character === ";") { end = cursor; break; }
    }
    const expression = body.slice(start, end).trim();
    if (expression) found.push(expression);
  }
  return found;
}

/**
 * The expressions a function named in the source returns, whether it was
 * declared or assigned, and whether its body is a block or a single
 * expression.
 */
function functionBodyReturns(text: string): string[] | undefined {
  const trimmed = text.trim();
  const arrow = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/u.exec(trimmed);
  if (arrow) {
    const rest = trimmed.slice(arrow[0].length).trim();
    if (!rest.startsWith("{")) return [rest];
    const body = balancedBlockBody(rest, 0);
    return body === undefined ? undefined : returnExpressions(body);
  }
  const classic = /^(?:async\s+)?function\b[^(]*\([^)]*\)\s*/u.exec(trimmed);
  if (classic) {
    const rest = trimmed.slice(classic[0].length).trim();
    const body = balancedBlockBody(rest, 0);
    return body === undefined ? undefined : returnExpressions(body);
  }
  return undefined;
}

export class ProvenanceResolver {
  private readonly assignments = new Map<string, string[]>();
  private readonly functionReturns = new Map<string, string[]>();
  private readonly nodeNames = new Set<string>();
  private readonly memo = new Map<string, Provenance>();
  private readonly visiting = new Set<string>();

  private readonly masked: string;
  private readonly nodeStep = /^(?:\?\.|\.)\s*(?:querySelector|querySelectorAll|getElementById|getElementsByClassName|getElementsByTagName|closest|parentElement|parentNode|firstElementChild|lastElementChild|nextElementSibling|previousElementSibling|children|childNodes|item|at|filter|find|slice|map)\b|^\[/u;

  constructor(private readonly source: string) {
    this.masked = maskLiterals(source);
    // `const NAME = EXPR` and `NAME = EXPR`, both to the end of the statement.
    const masked = this.masked;
    for (const found of masked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/gu)) {
      this.record(found[1], this.statementAfter(found.index + found[0].length));
    }
    for (const found of masked.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*=(?![=>])/gu)) {
      if (/(?:const|let|var)\s+$/u.test(masked.slice(Math.max(0, found.index - 6), found.index))) continue;
      this.record(found[1], this.statementAfter(found.index + found[0].length));
    }
    // A helper the module declares is followed into: a list read off the page
    // through `function collectTopics() { … }` is still read off the page.
    for (const found of masked.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/gu)) {
      const head = balancedParens(masked, found.index + found[0].length - 1);
      if (!head) continue;
      const after = head.end + 1;
      const rest = this.source.slice(after).replace(/^\s*/u, "");
      const offset = after + (this.source.length - after - rest.length);
      const body = balancedBlockBody(this.source, offset);
      if (body === undefined) continue;
      this.functionReturns.set(found[1], returnExpressions(body));
    }
    // Loop and callback variables over a collection of elements are elements.
    // The head is read to its own closing parenthesis: `for (const el of
    // dialog.querySelectorAll("h1, h2"))` has parentheses inside it, and a
    // pattern that stopped at the first one saw an unbalanced expression,
    // decided it was not a collection of elements, and refused every module
    // that searches with a loop.
    for (const found of masked.matchAll(/\bfor\s*\(/gu)) {
      const head = balancedParens(masked, found.index + found[0].length - 1);
      if (!head) continue;
      const parsed = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([\s\S]+)$/u.exec(head.inner);
      if (!parsed) continue;
      const start = head.end - parsed[2].length;
      if (this.isNodes(source.slice(start, head.end))) this.nodeNames.add(parsed[1]);
    }
    for (const found of masked.matchAll(/([A-Za-z_$][\w$.()\[\]'"_]*?)\s*\.\s*(?:map|forEach|find|filter|some|every|flatMap)\s*\(\s*(?:\(\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*=>)/gu)) {
      const name = found[2] || found[3];
      if (name && this.isNodes(source.slice(found.index, found.index + found[1].length))) this.nodeNames.add(name);
    }
  }

  private statementAfter(index: number) {
    let depth = 0;
    for (let cursor = index; cursor < this.masked.length; cursor += 1) {
      const character = this.masked[cursor];
      if (character === "(" || character === "[" || character === "{") depth += 1;
      else if (character === ")" || character === "]" || character === "}") {
        if (depth === 0) return this.source.slice(index, cursor).trim();
        depth -= 1;
      } else if (depth === 0 && (character === ";" || character === "\n")) return this.source.slice(index, cursor).trim();
    }
    return this.source.slice(index).trim();
  }

  private record(name: string, expression: string) {
    if (!expression) return;
    const list = this.assignments.get(name) || [];
    list.push(expression);
    this.assignments.set(name, list);
  }

  /** An expression that evaluates to an element or a list of elements. */
  isNodes(raw: string): boolean {
    const expression = unwrap(raw.replace(/^await\s+/u, ""));
    if (/^\[\s*\.\.\.[^]+\]$/u.test(expression)) return this.isNodes(expression.replace(/^\[\s*\.\.\./u, "").replace(/\]$/u, ""));
    if (/^Array\s*\.\s*from\s*\(/u.test(expression)) return this.isNodes(balancedParens(expression, expression.indexOf("("))?.inner || "");
    // A locator call is an element only when nothing but element steps follow
    // it: `waitFor(".x")` is, `waitFor(".x").textContent` is not.
    if (/^(?:await\s+)?(?:waitFor|find|waitForTarget)\s*\(/u.test(expression)) {
      const args = balancedParens(expression, expression.indexOf("("));
      if (!args) return false;
      const rest = expression.slice(args.end + 1);
      const steps = chainSteps(rest);
      if (!steps) return false;
      return steps.every((step) => this.nodeStep.test(step.trim()));
    }
    const chain = /^([A-Za-z_$][\w$]*)/u.exec(expression);
    if (!chain) return false;
    const head = chain[1];
    const steps = chainSteps(expression.slice(head.length));
    if (!steps) return false;
    if (!steps.length) return this.isNodeName(head);
    if (!steps.every((step) => this.nodeStep.test(step.trim()))) return false;
    return head === "document" || this.isNodeName(head);
  }

  private isNodeName(name: string) {
    if (this.nodeNames.has(name)) return true;
    const assigned = this.assignments.get(name);
    if (!assigned) return false;
    if (this.visiting.has(`node:${name}`)) return false;
    // `let el = null; … el = candidate;` is how every hand-written module
    // searches for an element. The placeholder an element is later assigned
    // into is not a value the output can carry — nothing reads it while it is
    // still empty, because the search returns NoResult — so it says nothing
    // about whether the name holds an element. Refusing it made the gate
    // reject the ordinary "find the first matching element" loop.
    const candidates = assigned.filter((expression) => !/^(?:null|undefined|void\s+0)$/u.test(unwrap(expression)));
    if (!candidates.length) return false;
    this.visiting.add(`node:${name}`);
    const result = candidates.every((expression) => this.isNodes(expression));
    this.visiting.delete(`node:${name}`);
    if (result) this.nodeNames.add(name);
    return result;
  }

  /** The text of the whole document or of a dialog, rather than of one located element. */
  private isBlobText(expression: string) {
    return /^(?:document\s*\.\s*)?(?:body|documentElement)\s*\.\s*(?:innerText|textContent)\b/u.test(expression)
      || /^(?:document\s*\.\s*)?(?:body|documentElement)$/u.test(expression)
      || /^dialog\w*\s*\.\s*(?:innerText|textContent)\b/iu.test(expression);
  }

  resolve(raw: string, depth = 0): Provenance {
    const expression = unwrap(raw.replace(/^await\s+/u, ""));
    if (!expression || depth > 16) return "unknown";
    const key = `${depth}:${expression}`;
    const cached = this.memo.get(expression);
    if (cached) return cached;
    const result = this.compute(expression, depth);
    this.memo.set(expression, result);
    void key;
    return result;
  }

  private worst(values: Provenance[]): Provenance {
    if (values.includes("unknown")) return "unknown";
    if (values.includes("blob")) return "blob";
    return "ok";
  }

  private compute(expression: string, depth: number): Provenance {
    // A call to a helper this module declares is the expressions it returns.
    const called = this.callReturns(expression);
    if (called) return this.worst(called.map((item) => this.resolve(item, depth + 1)));
    // Literals.
    if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|true|false|null|undefined|void\s+0)$/u.test(expression)) return "ok";
    if (/^`/u.test(expression)) {
      const parts: Provenance[] = [];
      for (const found of expression.matchAll(/\$\{/gu)) {
        const body = balancedBlockBody(expression, found.index + 1);
        if (body === undefined) return "unknown";
        parts.push(this.resolve(body, depth + 1));
      }
      return this.worst(parts);
    }
    // Empty containers, and objects/arrays whose members are all traceable.
    if (/^\{\s*\}$|^\[\s*\]$/u.test(expression)) return "ok";
    if (expression.startsWith("{") && expression.endsWith("}")) {
      const body = balancedBlockBody(expression, 0);
      if (body === undefined) return "unknown";
      return this.worst(splitTopLevel(body, ",").map((entry) => this.resolveEntry(entry, depth + 1)));
    }
    if (expression.startsWith("[") && expression.endsWith("]") && !expression.startsWith("[...")) {
      return this.worst(splitTopLevel(expression.slice(1, -1), ",").map((item) => this.resolve(item, depth + 1)));
    }
    // Ternary and logical combinations: every branch that can be the value.
    const ternary = this.splitTernary(expression);
    if (ternary) return this.worst([this.resolve(ternary.consequent, depth + 1), this.resolve(ternary.alternate, depth + 1)]);
    for (const operator of ["??", "||", "&&"]) {
      const operands = splitTopLevel(expression, operator);
      if (operands.length > 1) return this.worst(operands.map((operand) => this.resolve(operand, depth + 1)));
    }
    if (/^!+/u.test(expression) || /^typeof\s/u.test(expression)) return "ok";
    for (const operator of [" + ", "+"]) {
      const operands = splitTopLevel(expression, operator);
      if (operands.length > 1 && operands.every((operand) => operand)) return this.worst(operands.map((operand) => this.resolve(operand, depth + 1)));
    }
    // Run arguments and the page's own address.
    if (/^input\b/u.test(expression) || /^state\b/u.test(expression)) return "ok";
    if (/^(?:window\s*\.\s*)?location\s*\.\s*(?:href|search|pathname|origin|hash|host|hostname)\b/u.test(expression)) return "ok";
    if (/^document\s*\.\s*(?:title|URL|referrer)\b/u.test(expression)) return "ok";
    if (this.isBlobText(expression)) return "blob";
    // Numeric parsing makes a blob-derived value a reading.
    const numeric = /^(?:parseInt|parseFloat|Number|Math\s*\.\s*\w+)\s*\(/u.exec(expression);
    if (numeric) {
      const args = balancedParens(expression, expression.indexOf("("));
      if (!args) return "unknown";
      const first = splitTopLevel(args.inner, ",")[0] || "";
      const inner = this.resolve(first, depth + 1);
      return inner === "unknown" ? "unknown" : "ok";
    }
    const wrapper = /^(?:String|Boolean|encodeURIComponent|decodeURIComponent|encodeURI|decodeURI|JSON\s*\.\s*stringify|Array\s*\.\s*from|Object\s*\.\s*(?:keys|values|entries))\s*\(/u.exec(expression);
    if (wrapper) {
      const args = balancedParens(expression, expression.indexOf("("));
      if (!args) return "unknown";
      return this.resolve(splitTopLevel(args.inner, ",")[0] || "", depth + 1);
    }
    // A parenthesised value with operations applied to it —
    // `(el?.textContent || "").replace(…).trim()`, `(a ?? b).slice(0, 8)` —
    // keeps the provenance of what is inside the parentheses.
    if (expression.startsWith("(")) {
      const group = balancedParens(expression, 0);
      if (!group) return "unknown";
      const inner = this.resolve(group.inner, depth + 1);
      if (inner === "unknown") return "unknown";
      return this.afterText(expression.slice(group.end + 1), depth, inner);
    }
    // A collection built from elements — `[...nodes]` or `Array.from(nodes)` —
    // with operations applied to it: `.map(li => ({…}))`, `.length`, `.filter`.
    const collection = this.leadingCollection(expression);
    if (collection) {
      if (!this.isNodes(collection.prefix)) return "unknown";
      if (!collection.rest.trim()) return "ok";
      if (/^\s*(?:\?\.|\.)\s*(?:map|filter|find|some|every|flatMap|forEach|slice|at)\s*\(|^\s*(?:\?\.|\.)\s*length\b|^\s*\[/u.test(collection.rest)) {
        return /\b(?:body|documentElement)\s*\.\s*(?:innerText|textContent)|\bdialog\w*\s*\.\s*(?:innerText|textContent)/iu.test(collection.rest) ? "blob" : "ok";
      }
      return "unknown";
    }
    // A member or call chain: read from the head and each step.
    const head = /^([A-Za-z_$][\w$]*)/u.exec(expression);
    if (!head) return "unknown";
    const rest = expression.slice(head[1].length);
    if (!rest) return this.resolveName(head[1], depth);
    return this.resolveChain(head[1], rest, depth);
  }

  /** `[...X]` or `Array.from(X)` at the start of an expression, and whatever follows it. */
  private leadingCollection(expression: string) {
    if (/^\[\s*\.\.\./u.test(expression)) {
      let depth = 0;
      for (let index = 0; index < expression.length; index += 1) {
        const character = expression[index];
        if (character === "[" || character === "(" || character === "{") depth += 1;
        else if (character === "]" || character === ")" || character === "}") {
          depth -= 1;
          if (depth === 0) return { prefix: expression.slice(0, index + 1), rest: expression.slice(index + 1) };
        }
      }
      return undefined;
    }
    if (/^Array\s*\.\s*from\s*\(/u.test(expression)) {
      const args = balancedParens(expression, expression.indexOf("("));
      if (!args) return undefined;
      return { prefix: expression.slice(0, args.end + 1), rest: expression.slice(args.end + 1) };
    }
    return undefined;
  }

  private resolveEntry(entry: string, depth: number): Provenance {
    if (entry.startsWith("...")) return "unknown";
    const colon = this.topLevelColon(entry);
    if (colon < 0) return this.resolve(entry, depth);
    return this.resolve(entry.slice(colon + 1), depth);
  }

  private topLevelColon(entry: string) {
    const masked = maskLiterals(entry);
    let depth = 0;
    for (let index = 0; index < masked.length; index += 1) {
      const character = masked[index];
      if (character === "(" || character === "[" || character === "{") depth += 1;
      else if (character === ")" || character === "]" || character === "}") depth -= 1;
      else if (depth === 0 && character === ":" ) return index;
      else if (depth === 0 && character === "?") return -1;
    }
    return -1;
  }

  private splitTernary(expression: string) {
    const masked = maskLiterals(expression);
    let depth = 0;
    let question = -1;
    for (let index = 0; index < masked.length; index += 1) {
      const character = masked[index];
      if (character === "(" || character === "[" || character === "{") depth += 1;
      else if (character === ")" || character === "]" || character === "}") depth -= 1;
      else if (depth === 0 && character === "?" && masked[index + 1] !== "." && masked[index + 1] !== "?" && question < 0) question = index;
      else if (depth === 0 && character === ":" && question >= 0) {
        return { consequent: expression.slice(question + 1, index), alternate: expression.slice(index + 1) };
      }
    }
    return undefined;
  }

  /**
   * The expressions a whole-expression call to a module-declared helper
   * returns, or nothing when this is not such a call.
   */
  private callReturns(expression: string): string[] | undefined {
    const head = /^([A-Za-z_$][\w$]*)\s*\(/u.exec(expression);
    if (!head) return undefined;
    const parens = balancedParens(maskLiterals(expression), head[0].length - 1);
    if (!parens || parens.end !== expression.length - 1) return undefined;
    const declared = this.functionReturns.get(head[1]);
    if (declared) return declared.length ? declared : undefined;
    if (this.visiting.has(head[1])) return undefined;
    const assigned = this.assignments.get(head[1]) || [];
    const returns = assigned.flatMap((text) => functionBodyReturns(text) || []);
    return returns.length ? returns : undefined;
  }

  private resolveName(name: string, depth: number): Provenance {
    if (name === "input" || name === "state") return "ok";
    if (this.nodeNames.has(name)) return "ok";
    const assigned = this.assignments.get(name);
    if (!assigned) return this.isNodeName(name) ? "ok" : "unknown";
    if (this.visiting.has(name)) return "ok";
    this.visiting.add(name);
    // Every assignment can be the value the output carries.
    const result = this.worst(assigned.map((expression) => this.resolve(expression, depth + 1)));
    this.visiting.delete(name);
    return result;
  }

  private resolveChain(head: string, rest: string, depth: number): Provenance {
    // Element property reads.
    const property = /^\s*(?:\?\.|\.)\s*(textContent|innerText|innerHTML|href|src|value|title|alt|id|className|checked|selected|tagName|dataset(?:\s*(?:\.|\[)[^.\[\]]*\]?)?|getAttribute\s*\([^)]*\)|length|childElementCount)\b/u;
    const full = head + rest;
    const blobRoot = this.isBlobText(full) || /^dialog/iu.test(head) && /^\s*(?:\?\.|\.)\s*(?:innerText|textContent)\b/u.test(rest);
    if (blobRoot) return this.afterText(full, depth, "blob");
    // Find the longest prefix that is an element (or list) and read the step after it.
    const steps = chainSteps(rest) || [];
    for (let count = steps.length; count >= 0; count -= 1) {
      const prefix = head + steps.slice(0, count).join("");
      const remainder = steps.slice(count).join("");
      if (count === 0 ? this.isNodeName(head) : this.isNodes(prefix)) {
        if (!remainder) return "ok";
        if (property.test(remainder)) {
          // The text of the dialog, the main region or the body is the text of
          // the whole result, not of the element that carries one value.
          const containerText = /querySelector\s*\(\s*['"](?:\[role\s*=\s*["']?dialog["']?\]|dialog|main|body|html|\[role\s*=\s*["']?main["']?\])['"]\s*\)\s*$/u.test(prefix)
            && /^\s*(?:\?\.|\.)\s*(?:innerText|textContent)\b/u.test(remainder);
          return this.afterText(remainder.replace(property, ""), depth, containerText ? "blob" : "ok");
        }
        if (/^\s*(?:\?\.|\.)\s*(?:map|filter|find|some|every|flatMap|forEach)\s*\(/u.test(remainder)) {
          return /\b(?:body|documentElement)\s*\.\s*(?:innerText|textContent)|\bdialog\w*\s*\.\s*(?:innerText|textContent)/iu.test(remainder) ? "blob" : "ok";
        }
        return "unknown";
      }
    }
    // A plain value with string/array operations applied; the head decides.
    const base = this.resolveName(head, depth);
    if (base === "unknown") return "unknown";
    return this.afterText(rest, depth, base);
  }

  /** Operations applied to a text value: they keep its provenance, except a capture from a blob. */
  private afterText(operations: string, depth: number, base: Provenance): Provenance {
    if (!operations.trim()) return base;
    const steps = [...operations.matchAll(/\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)(?:\s*\(((?:[^()]|\([^()]*\))*)\))?|\s*\[((?:[^\[\]]|\[[^\]]*\])*)\]/gu)];
    let current = base;
    for (const step of steps) {
      const name = step[1];
      const args = step[2];
      if (name === undefined) continue; // an index keeps provenance
      if (/^(?:trim|trimStart|trimEnd|toLowerCase|toUpperCase|replace|replaceAll|slice|substring|substr|split|join|normalize|padStart|padEnd|at|filter|map|find|some|every|includes|startsWith|endsWith|indexOf|length|toString|localeCompare|concat|flat)$/u.test(name)) continue;
      if (name === "match" || name === "matchAll" || name === "exec") {
        if (current !== "blob") continue;
        // A capture that cannot match open-ended text is a value, and a value is a reading.
        const pattern = /\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+)\/[a-z]*/u.exec(args || "");
        if (pattern && !capturingGroupBodies(pattern[1]).some(isIdentityCapture)) return "ok";
        return "blob";
      }
      if (name === "push" || name === "unshift") continue;
      return "unknown";
    }
    return current;
  }

  /**
   * The entries of every `output` a Success return carries, as (key,
   * expression). The io manifest also has an `output:` — the declared key
   * list — which is not a value and is skipped; only `return { outcome:
   * "Success", output: … }` is read. Undefined means a return that names an
   * output could not be parsed, which the caller treats as a refusal.
   */
  outputEntries(): Array<{ key: string; expression: string }> | undefined {
    const entries: Array<{ key: string; expression: string }> = [];
    for (const found of this.masked.matchAll(/\breturn\s*\{/gu)) {
      const open = found.index + found[0].length - 1;
      const body = balancedBlockBody(this.source, open);
      if (body === undefined) return undefined;
      const maskedBody = maskLiterals(body);
      if (!/\boutcome\s*:/u.test(maskedBody)) continue;
      if (!/\boutcome\s*:\s*["']Success["']/u.test(body)) continue;
      const output = /\boutput\s*:\s*/u.exec(maskedBody);
      if (!output) continue;
      const parsed = this.entriesAt(body, output.index + output[0].length);
      if (parsed === undefined) return undefined;
      entries.push(...parsed);
    }
    return entries;
  }

  private entriesAt(source: string, start: number): Array<{ key: string; expression: string }> | undefined {
    let literal: string | undefined;
    if (source[start] === "{") {
      const body = balancedBlockBody(source, start);
      if (body === undefined) return undefined;
      literal = body;
    } else {
      // `output` is an identifier: gather its literal and later member writes.
      const name = /^[A-Za-z_$][\w$]*/u.exec(source.slice(start))?.[0];
      if (!name) return undefined;
      const assigned = this.assignments.get(name) || [];
      const objectLiteral = assigned.find((expression) => expression.startsWith("{"));
      literal = objectLiteral ? balancedBlockBody(objectLiteral, 0) ?? "" : "";
      const writes = [...this.source.matchAll(new RegExp(`\\b${name.replace(/\$/gu, "\\$")}\\s*(?:\\.\\s*([A-Za-z_$][\\w$]*)|\\[\\s*["']([^"']+)["']\\s*\\])\\s*=(?!=)`, "gu"))];
      const extra = writes.map((write) => `${write[1] || write[2]}: ${this.statementAfter(write.index + write[0].length)}`);
      literal = [literal, ...extra].filter(Boolean).join(", ");
    }
    const entries: Array<{ key: string; expression: string }> = [];
    for (const entry of splitTopLevel(literal, ",")) {
      if (entry.startsWith("...")) { entries.push({ key: entry, expression: entry }); continue; }
      const colon = this.topLevelColon(entry);
      if (colon < 0) entries.push({ key: entry.trim(), expression: entry.trim() });
      else entries.push({ key: entry.slice(0, colon).trim().replace(/^["']|["']$/gu, ""), expression: entry.slice(colon + 1).trim() });
    }
    return entries;
  }
}

/** Text of the whole page or the whole dialog, rather than of one located element. */
function isWholeDocumentText(expression: string) {
  return /\b(?:body|documentElement)\s*\.\s*(?:innerText|textContent)/u.test(expression)
    || /\bdialog\w*\s*\.\s*(?:innerText|textContent)/iu.test(expression);
}

/** Local names holding such a blob, so `const dialogText = dialog.innerText` is seen at its use. */
function wholeDocumentTextNames(source: string) {
  const names = new Set<string>();
  for (const assignment of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/gu)) {
    if (isWholeDocumentText(assignment[2])) names.add(assignment[1]);
  }
  return names;
}

/** Remove comments and quoted literals for conservative executable-loop checks. */
function stripJavaScriptCommentsAndLiterals(source: string) {
  const withoutComments = stripJavaScriptComments(source);
  let output = "";
  let quote = "";
  let escaped = false;
  for (const current of withoutComments) {
    if (quote) {
      output += " ";
      if (escaped) { escaped = false; continue; }
      if (current === "\\") { escaped = true; continue; }
      if (current === quote) quote = "";
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      output += " ";
      continue;
    }
    output += current;
  }
  return output;
}

export type JavaScriptModuleValidation =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Return the number of statically visible reads of one public input path.
 *
 * Generated modules are ordinary JavaScript, so a model may spell a read as
 * `input.name`, `input["name"]`, `input?.["name"]`, or destructure the
 * property before using its local alias.  Treating only ASCII dot notation as
 * valid made perfectly executable modules with Unicode contract keys fail the
 * source gate.  This remains a source-level proof (not a runtime fallback):
 * the property must be named explicitly and the alias must be referenced after
 * the destructuring/alias declaration.
 */
export function sourceInputPathUsageCount(source: string, name: string): number {
  const normalized = String(source || "");
  const escaped = String(name || "").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  if (!escaped) return 0;
  const identifierBoundary = `(?![\\p{L}\\p{N}_$-])`;
  const directDot = new RegExp(`(?:^|[^\\p{L}\\p{N}_$-])input\\s*(?:\\?\\.|\\.)\\s*${escaped}${identifierBoundary}`, "gu");
  const directBracket = new RegExp(`(?:^|[^\\p{L}\\p{N}_$-])input\\s*(?:\\?\\.\\s*)?\\[\\s*[\"']${escaped}[\"']\\s*\\]`, "gu");
  let count = [...normalized.matchAll(directDot)].length + [...normalized.matchAll(directBracket)].length;

  // `const { 商品类别: category } = input` and `const { 商品类别 } = input`.
  // The property has to be explicitly present in the destructuring pattern,
  // and the local binding must be read in the remainder of the source.
  const destructuring = /(?:const|let|var)\s*\{([\s\S]{0,4000})\}\s*=\s*input\b/gu;
  for (const match of normalized.matchAll(destructuring)) {
    const body = match[1] || "";
    const property = new RegExp(`(?:^|,)\\s*${escaped}\\s*(?::\\s*([\\p{L}_$][\\p{L}\\p{N}_$-]*))?(?:\\s*=|\\s*(?:,|$))`, "u").exec(body);
    if (!property) continue;
    const alias = property[1] || name;
    const declarationEnd = (match.index || 0) + match[0].length;
    const remainder = normalized.slice(declarationEnd);
    const aliasPattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_$-])${String(alias).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}(?![\\p{L}\\p{N}_$-])`, "gu");
    count += [...remainder.matchAll(aliasPattern)].length;
  }

  // A module may keep the input object under a local name before reading it,
  // e.g. `const params = input; params["商品类别"]`.  Only accept an alias
  // declared directly from the runtime input object.
  const objectAliases = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*input\b/gu;
  for (const match of normalized.matchAll(objectAliases)) {
    const alias = match[1];
    if (!alias || alias === "input") continue;
    const aliasEscaped = alias.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    const aliasDot = new RegExp(`(?:^|[^\\p{L}\\p{N}_$-])${aliasEscaped}\\s*(?:\\?\\.|\\.)\\s*${escaped}${identifierBoundary}`, "gu");
    const aliasBracket = new RegExp(`(?:^|[^\\p{L}\\p{N}_$-])${aliasEscaped}\\s*(?:\\?\\.\\s*)?\\[\\s*[\"']${escaped}[\"']\\s*\\]`, "gu");
    count += [...normalized.matchAll(aliasDot)].length + [...normalized.matchAll(aliasBracket)].length;
  }

  // Some generated modules accept both the flat runtime input object and an
  // envelope-shaped object emitted by an older authoring prompt, e.g.
  // `const params = input?.parameters ?? input`.  The fallback is important:
  // the BrowserJavaScriptStage runtime passes the flat `parameters` object,
  // so an alias without `?? input`/`|| input` would not be executable.  Treat
  // only this explicit, input-preserving form as consumption of the public
  // property; do not accept an arbitrary nested object merely because it
  // contains the same spelling.
  const objectFallbackAliases = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*input\s*(?:\?\.\s*)?(?:parameters|params|["']parameters["'])\s*(?:\?\?|\|\|)\s*input\b/gu;
  for (const match of normalized.matchAll(objectFallbackAliases)) {
    const alias = match[1];
    if (!alias || alias === "input") continue;
    const aliasEscaped = alias.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    const aliasDot = new RegExp(`(?:^|[^\\p{L}\\p{N}_$-])${aliasEscaped}\\s*(?:\\?\\.|\\.)\\s*${escaped}${identifierBoundary}`, "gu");
    const aliasBracket = new RegExp(`(?:^|[^\\p{L}\\p{N}_$-])${aliasEscaped}\\s*(?:\\?\\.\\s*)?\\[\\s*["']${escaped}["']\\s*\\]`, "gu");
    count += [...normalized.matchAll(aliasDot)].length + [...normalized.matchAll(aliasBracket)].length;
  }

  // A common, readable form is `const query = input.searchTerm;` followed by
  // several uses of `query` in search and candidate-selection stages.  Count
  // those post-assignment alias reads as additional consumption of the public
  // field; otherwise the target gate would reject a semantically safe module
  // merely because it avoids repeating the property access in every stage.
  const valueAliases = [
    new RegExp(`(?:const|let|var)\\s+([\\p{L}_$][\\p{L}\\p{N}_$-]*)\\s*=\\s*input\\s*(?:\\?\\.\\s*|\\.\\s*)${escaped}${identifierBoundary}`, "gu"),
    new RegExp(`(?:const|let|var)\\s+([\\p{L}_$][\\p{L}\\p{N}_$-]*)\\s*=\\s*input\\s*(?:\\?\\.\\s*)?\\[\\s*[\"']${escaped}[\"']\\s*\\]`, "gu"),
  ];
  for (const declarationPattern of valueAliases) {
    for (const match of normalized.matchAll(declarationPattern)) {
      const alias = match[1];
      const declarationEnd = (match.index || 0) + match[0].length;
      const remainder = normalized.slice(declarationEnd);
      const aliasPattern = new RegExp(`(?:^|[^\\p{L}\\p{N}_$-])${String(alias).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}(?![\\p{L}\\p{N}_$-])`, "gu");
      count += [...remainder.matchAll(aliasPattern)].length;
    }
  }
  return count;
}

export function sourceConsumesInputPath(source: string, name: string) {
  return sourceInputPathUsageCount(source, name) > 0;
}

/**
 * A generated module must not turn "find a matching item" into
 * "take whatever happens to be first".  Keep this check deliberately
 * structural and vocabulary-neutral: it only covers collection variables
 * whose names conventionally represent the candidate set, never a concrete
 * site, product or category.
 */
export function hasUnsafeFirstCandidateSelection(source: string) {
  return Boolean(unsafeFirstCandidateExpression(source));
}

function unsafeFirstCandidateExpression(source: string) {
  // Models often add a descriptive prefix (for example
  // `fullyMatchedCandidates`) after a repair. Match the semantic collection
  // name rather than only the exact plural so a rename cannot bypass the gate.
  const candidateCollection = "(?:(?:fullyMatched|matched|filtered|eligible|target|executable|available|all|attr|facet|valid|exact|primary|enabled)?(?:candidates?|matches?|results?|links?|items?|products?|cards?|options?|selections?))";
  return new RegExp(`(?:\\b${candidateCollection}\\s*\\[\\s*0\\s*\\]|\\b${candidateCollection}\\s*\\.\\s*at\\s*\\(\\s*0\\s*\\)|\\[\\s*first\\s*\\]\\s*=\\s*${candidateCollection}|\\bfirst\\s*=\\s*${candidateCollection}\\s*\\[\\s*0\\s*\\])`, "iu").exec(String(source || ""))?.[0];
}

/**
 * A `.find()` call is only safe for target resolution when its predicate
 * proves both halves of the decision: complete public target/facet identity
 * and an executable action. Otherwise `candidates.find(candidate =>
 * candidate.href)` is a disguised first-item fallback. Keep this generic;
 * the authoring prompt emits `matchesAllInputs && enabledAction`, while
 * readable aliases such as `fullMatch` remain accepted.
 */
function unsafeIncompleteCandidateFindExpression(source: string) {
  const candidateCollection = "(?:(?:fullyMatched|matched|filtered|eligible|target|executable|available|all|attr|facet|valid|exact|primary|enabled)?(?:candidates?|matches?|results?|links?|items?|products?|cards?|options?|selections?))";
  const collectionPattern = new RegExp(`\\b${candidateCollection}\\s*\\.\\s*find\\s*\\(`, "giu");
  const inputProof = /(?:matchesAllInputs|matchesAll|matchesTarget|matchesIdentity|fullMatch|allInputs|targetMatch|completeMatch)/iu;
  const actionProof = /(?:enabledAction|enabled|executable|action|button|href)/iu;
  const normalized = String(source || "");
  for (const match of normalized.matchAll(collectionPattern)) {
    const start = match.index || 0;
    const open = normalized.indexOf("(", start);
    if (open < 0) continue;
    let depth = 0;
    let quote = "";
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let close = -1;
    for (let index = open; index < normalized.length; index += 1) {
      const current = normalized[index];
      const next = normalized[index + 1];
      if (lineComment) {
        if (current === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (current === "*" && next === "/") { blockComment = false; index += 1; }
        continue;
      }
      if (quote) {
        if (escaped) { escaped = false; continue; }
        if (current === "\\") { escaped = true; continue; }
        if (current === quote) quote = "";
        continue;
      }
      if (current === "/" && next === "/") { lineComment = true; index += 1; continue; }
      if (current === "/" && next === "*") { blockComment = true; index += 1; continue; }
      if (current === "\"" || current === "'" || current === "`") { quote = current; continue; }
      if (current === "(") depth += 1;
      if (current === ")") {
        depth -= 1;
        if (depth === 0) { close = index; break; }
      }
    }
    if (close < 0) continue;
    const call = normalized.slice(open + 1, close);
    const arrow = call.indexOf("=>");
    if (arrow < 0) continue;
    const predicate = call.slice(arrow + 2);
    if (!inputProof.test(predicate) || !actionProof.test(predicate)) return normalized.slice(start, close + 1).slice(0, 320);
  }
  return undefined;
}

/**
 * A static envelope, not a sandbox. Published modules are trusted code, but
 * obvious dynamic-code and dependency-loading escape hatches are rejected.
 */
export function validateCapabilityJavaScriptSource(
  source: string,
  requiredInputPaths: readonly string[] = [],
  targetInputPaths: readonly string[] = [],
  options: { scope?: "authoring" | "execution" } = {},
): JavaScriptModuleValidation {
  const normalized = source.replace(/\r\n/g, "\n").trim();
  const bytes = new TextEncoder().encode(normalized).byteLength;
  if (!normalized) return { ok: false, code: "capability_module_empty", message: "module source is empty" };
  if (bytes > CAPABILITY_V2_MAX_MODULE_BYTES) return { ok: false, code: "capability_module_too_large", message: `module exceeds ${CAPABILITY_V2_MAX_MODULE_BYTES} bytes` };
  if (!/\bexport\s+(?:const|let|var)\s+capability\b/m.test(normalized) && !/\bexport\s*\{[^}]*\bcapability\b[^}]*\}/m.test(normalized)) {
    return { ok: false, code: "capability_module_export_missing", message: "module must export `capability`" };
  }
  if (/\b(?:eval|Function)\s*\(/.test(normalized)) return { ok: false, code: "capability_module_dynamic_code_forbidden", message: "eval/Function are forbidden" };
  if (/\bimport\s*\(/.test(normalized)) return { ok: false, code: "capability_module_dynamic_import_forbidden", message: "dynamic import is forbidden" };
  if (/^\s*import\s/m.test(normalized)) return { ok: false, code: "capability_module_external_import_forbidden", message: "published bundle must be self contained" };
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker)\b/.test(normalized) || /\b(?:navigator\s*\.\s*sendBeacon|serviceWorker\s*\.\s*register)\b/.test(normalized)) {
    return { ok: false, code: "capability_module_network_forbidden", message: "capability modules must operate through the current page DOM and cannot initiate independent network requests" };
  }
  const executableSource = stripJavaScriptCommentsAndLiterals(normalized);
  if (/\bwhile\s*\(\s*(?:true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/u.test(executableSource)) {
    return { ok: false, code: "capability_module_unbounded_loop_forbidden", message: "unbounded loops are forbidden; use a bounded Stage-local wait or declare a finite capability.controlFlow loop" };
  }
  // Everything above protects the page the module runs in: no network of its
  // own, no dynamic code, no unbounded loop, nothing but the source it claims
  // to be. Everything below judges whether the capability is any good, which
  // is the authoring loop's business.
  //
  // The two were one list, and the module endpoint ran the whole list every
  // time a browser asked for a stored module. Adding an authoring rule then
  // took a published capability off the air for a rule that did not exist
  // when it was written: 打开热搜榜指定排名详情 answered 409 to every visitor
  // the moment `capability_module_empty_branch` shipped. A rule about quality
  // must not be able to do that.
  if (options.scope === "execution") {
    if (/\/\/[#@]\s*sourceMappingURL=/i.test(normalized)) {
      return { ok: false, code: "capability_module_source_map_forbidden", message: "source maps are not published with capability modules" };
    }
    return { ok: true };
  }
  if (/(?:^|[\s("'`])(?:button|a|input|select|textarea|\*)\s*\[\s*role\s*=|\[\s*role\s*=\s*["'](?:button|link)["']/iu.test(normalized)) {
    return { ok: false, code: "capability_module_computed_aria_selector_forbidden", message: "get_dom roles are computed accessibility metadata; use real HTML elements and semantic text instead of CSS role attributes" };
  }
  // `name` in get_dom is the computed accessible name (button text, placeholder),
  // not the HTML name attribute. A [name="…"] selector containing non-ASCII text
  // or spaces never matches anything and only waits until the timeout.
  if ([...normalized.matchAll(/\[\s*name\s*=\s*\\?["']([^"'\\]*)\\?["']\s*\]/gu)].some((match) => /[^\x00-\x7F]|\s/u.test(match[1]))) {
    return { ok: false, code: "capability_module_computed_aria_selector_forbidden", message: "get_dom's `name` is the computed accessible name (button text, placeholder), not an HTML name attribute; a [name=\"…\"] selector built from it never matches. Select by the element's css from get_dom, its placeholder/type/id attributes, or its visible text" };
  }
  for (const path of requiredInputPaths) {
    const name = string(path).split(".")[0];
    if (!name) continue;
    if (!sourceConsumesInputPath(normalized, name)) {
      return { ok: false, code: `capability_module_input_unused:${name}`, message: `capability source must consume input.${name}` };
    }
  }
  // Consuming an input is not the same as acting on it. A capability whose
  // goal was "the topic at rank N" read `input.rank` in its terminal stage,
  // put it in the evidence, and clicked a recorded nth-of-type path — the same
  // topic whatever rank was asked for. It satisfied the loop above, passed its
  // own replay, and was caught only by independent validation, and there only
  // because the predicted output happened to repeat the input. So a required
  // input must also be consumed before the terminal stage, which is where the
  // acting is done. A module that only reads has no stage before it and is
  // left alone.
  const terminalStageStart = normalized.indexOf("stage_verify");
  if (terminalStageStart > 0) {
    const actingSection = normalized.slice(0, terminalStageStart);
    if (/\bid\s*:\s*["']stage_/u.test(actingSection)) {
      for (const path of requiredInputPaths) {
        const name = string(path).split(".")[0];
        if (!name) continue;
        if (!sourceConsumesInputPath(actingSection, name)) {
          return {
            ok: false,
            code: `capability_module_input_not_acted_on:${name}`,
            message: `input.${name} is only read by the final stage, so the capability acts the same way whatever its value is; use input.${name} to choose what the action stage acts on (the nth item, the matching row, the query it sends), not only to report it back`,
          };
        }
      }
    }
  }
  // A guard that was written and then thrown away. The authoring model wrote
  // `if (title && !identityMatches(actedOn, title)) {}` — the check that the
  // result belongs to the item the action acted on, with an empty body — and
  // the capability shipped reading a title from the wrong place. An empty
  // branch is never the intent; either act on the condition or drop it.
  // The condition may nest parentheses but never braces, so the scan cannot
  // run past the end of the statement it is reading.
  const emptyBranch = /\b(?:if|else\s+if)\s*\((?:[^(){}]|\((?:[^()]|\([^()]*\))*\))*\)\s*\{\s*\}|\belse\s*\{\s*\}/u.exec(stripJavaScriptComments(normalized));
  if (emptyBranch) {
    return {
      ok: false,
      code: "capability_module_empty_branch",
      message: `a condition is checked and then nothing is done with it: ${emptyBranch[0].slice(0, 120)}. Either return NoResult (or take the other path) when it holds, or remove the check`,
    };
  }
  // The identity check decides; it is not overruled. After the empty-branch
  // rule shipped, the next capability gave the branch a body that rewrote the
  // title out of the acted-on text until the check would have passed — the
  // guard existed and guarded nothing, again. The failing side of an
  // identityMatches check has to leave the stage: return NoResult, or throw.
  const executableWithoutComments = stripJavaScriptComments(normalized);
  const identityChecks = /\bif\s*\(/gu;
  for (const found of executableWithoutComments.matchAll(identityChecks)) {
    const open = found.index + found[0].length - 1;
    const condition = balancedParens(executableWithoutComments, open);
    if (!condition || !/\bidentityMatches\s*\(/u.test(condition.inner)) continue;
    const negated = /!\s*identityMatches\s*\(/u.test(condition.inner);
    let braceIndex = condition.end + 1;
    while (braceIndex < executableWithoutComments.length && /\s/u.test(executableWithoutComments[braceIndex])) braceIndex += 1;
    const thenBody = balancedBlockBody(executableWithoutComments, braceIndex);
    if (thenBody === undefined) continue;
    let failureBody: string | undefined;
    if (negated) failureBody = thenBody;
    else {
      const afterThen = executableWithoutComments.slice(braceIndex + thenBody.length + 2);
      const elseMatch = /^\s*else\s*(\{)/u.exec(afterThen);
      failureBody = elseMatch ? balancedBlockBody(afterThen, elseMatch.index + elseMatch[0].length - 1) : "";
    }
    if (failureBody !== undefined && !/\b(?:return|throw)\b/u.test(failureBody)) {
      return {
        ok: false,
        code: "capability_module_identity_check_overruled",
        message: "when identityMatches says the result is not the item the action acted on, the stage must return NoResult or throw; it must not rewrite the value until the check passes, and it must not fall through as if the check had passed",
      };
    }
  }
  // An output the page did not give. A verify stage that could not find the
  // topic's link built one — `https://www.example.test/?topic=${title}` — and
  // returned it as targetUrl. A URL assembled from a hard-coded origin is a
  // guess dressed as a fact; what the page did not provide is NoResult.
  const verifyStart = executableWithoutComments.indexOf("stage_verify");
  if (verifyStart >= 0) {
    const verifySource = executableWithoutComments.slice(verifyStart);
    const assembled = /`https?:\/\/[^`]*\$\{|["']https?:\/\/[^"']*["']\s*\+/u.exec(verifySource);
    if (assembled) {
      return {
        ok: false,
        code: "capability_module_output_fabricated",
        message: `an output is being assembled from a hard-coded address (${assembled[0].slice(0, 60)}…) instead of read from the page; take the URL from location.href or a link's href, and return NoResult when the page does not provide it`,
      };
    }
  }
  // A target is not consumed merely because it drives the initial search. It
  // must also participate in candidate selection; otherwise a generated
  // module can navigate to a result page and then click an arbitrary card (or
  // filter only by a secondary facet such as colour). Requiring two direct
  // reads keeps this gate structural and leaves the public module I/O schema
  // untouched. The authoring model receives the error and repairs the source.
  for (const path of targetInputPaths) {
    const name = string(path).split(".")[0];
    if (!name) continue;
    const count = sourceInputPathUsageCount(normalized, name);
    if (count < 2) {
      return {
        ok: false,
        code: `capability_module_target_input_not_reused:${name}`,
        message: `target input.${name} must be used for both target resolution and candidate selection`,
      };
    }
  }
  const heuristicSource = stripJavaScriptComments(normalized);
  const unsafeFirst = unsafeFirstCandidateExpression(heuristicSource);
  const unsafeIncompleteFind = unsafeIncompleteCandidateFindExpression(heuristicSource);
  if (targetInputPaths.length && (unsafeFirst || unsafeIncompleteFind)) {
    return {
      ok: false,
      code: "capability_module_target_first_candidate_forbidden",
      message: `target resolution must match all public target/facet inputs; source still selects a candidate collection without a complete match and executable-action proof (${unsafeFirst || unsafeIncompleteFind || "expression"}). Filter all candidates for full input identity and an enabled executable action, then choose a matching candidate or return NoResult/Ambiguous`,
    };
  }
  // A customization field is user-owned data.  A generated module must never
  // invent a literal textarea value ("Hello", "test", etc.) merely to enable
  // a disabled product button; it must choose another executable candidate or
  // return an explicit clarification/no-result.  This is a source-level guard
  // and does not alter the public capability input/output envelope.
  if (
    (
      /(?:textarea|custom(?:ization)?\s*area)[^;{}]{0,240}\.\s*value\s*=\s*["'`][^"'`\r\n]+["'`]/iu.test(normalized)
      || /querySelector\(\s*["'`][^"'`]*textarea[^"'`]*["'`]\s*\)[^{}]{0,240}\.\s*value\s*=\s*["'`][^"'`\r\n]+["'`]/iu.test(normalized)
    )
    && !/\.\s*value\s*=\s*(?:input\s*\.|input\s*\[)/iu.test(normalized)
  ) {
    return {
      ok: false,
      code: "capability_module_invented_customization",
      message: "do not invent customization text; consume a user-provided customization input or choose another executable product",
    };
  }
  // Native searchForm.submit() is unreliable on the client-rendered
  // PrestaShop search widget and can leave the following Stage on an empty
  // result document.  Require the input-driven same-origin URL handoff so the
  // runner can settle the new page before candidate selection.
  if (/\bsearchForm\s*\.\s*submit\s*\(\s*\)/iu.test(normalized)) {
    return {
      ok: false,
      code: "capability_module_search_form_submit_unsafe",
      message: "use an input-driven /search?controller=search&s=... navigation handoff instead of searchForm.submit()",
    };
  }
  // A product-detail page often renders related product cards below the main
  // product. A document-wide enabled-button fallback can therefore click a
  // related card's Add-to-cart control after the selected detail's own control
  // was disabled (for example, a product requiring customization). Reject
  // that unsafe pattern before browser replay; the author must scope the write
  // to the primary business region and explicitly skip related cards.
  if (
    /document\s*\.\s*querySelectorAll\s*\(\s*["'`]button\s*:\s*not\s*\(\s*\[\s*disabled\s*\]\s*\)/iu.test(normalized)
    && /add\s*(?:to\s*)?cart/iu.test(normalized)
    && !/closest\s*\(\s*["'`]article["'`]\s*\)/iu.test(normalized)
  ) {
    return {
      ok: false,
      code: "capability_module_related_add_to_cart_fallback",
      message: "document-wide Add-to-cart fallback can click a related product; scope the write to the primary detail region and skip disabled/related candidates",
    };
  }
  // Variant links are often rendered for related products as well as the
  // primary detail. A document-wide `a[href*=color-/variant-]` navigation can
  // silently leave the requested product and change only the URL/hash. Keep
  // this as a generic source gate; the author can still use a link inside the
  // current product region or select a real variant control.
  const documentWideVariantSelector = /document\s*\.\s*querySelectorAll\s*\(\s*["'`][\s\S]{0,300}?(?:href\s*[*^$]?=\s*\\?["']?(?:color|colour|variant)|(?:color|colour|variant)[\s\S]{0,100}href)/iu;
  if (
    targetInputPaths.length
    && documentWideVariantSelector.test(normalized)
    && /(?:__SiteWakeNavigate|location\s*\.\s*(?:assign|replace|href)|\.\s*click\s*\(\s*\)|dispatchEvent\s*\()/iu.test(normalized)
  ) {
    return {
      ok: false,
      code: "capability_module_related_variant_navigation",
      message: "do not navigate document-wide color/variant links; scope variant selection to the requested primary product region and never leave the selected target for a related card",
    };
  }
  // Assigning .value directly is reverted by React/Vue controlled inputs: the
  // framework's value tracker sees no change, onChange never fires, and the next
  // render writes the empty string back. In self-tests that looks like "the search
  // box is still empty, the click does not navigate, the wait times out" and costs
  // a full totalTimeout every time. The host provides fill(element, value).
  const domHandles = [...executableSource.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:waitFor\s*\(|document\s*\.\s*(?:querySelector|getElementById)\s*\()/gu)].map((match) => match[1]);
  const directValueAssignment = new RegExp(`(?:\\b(?:${[...new Set(domHandles), "document\\s*\\.\\s*querySelector\\s*\\([^)]*\\)"].join("|")})|\\(\\s*await\\s+waitFor\\s*\\([^)]*\\)\\s*\\))\\s*\\.\\s*value\\s*=(?!=)`, "u");
  if (directValueAssignment.test(executableSource)) {
    return {
      ok: false,
      code: "capability_module_direct_value_assignment",
      message: "do not assign element.value directly; React/Vue controlled inputs revert it. Use fill(element, value) from the run arguments, which writes through the native setter and dispatches input/change like real typing",
    };
  }
  if (/(?:__SiteWakeNavigate|location\s*\.\s*(?:assign|replace|reload)|location\s*=|location\s*\.\s*href\s*=(?!=))/iu.test(executableSource)) {
    return {
      ok: false,
      code: "capability_module_direct_navigation_forbidden",
      message: "do not set location/location.href or call location.assign/replace; click the real control (button/link) or return a same-origin navigation intent from the Stage result — the host commits state/cursor/receipt before navigating",
    };
  }
  // A concrete locale sentence (especially one containing a fixed quantity)
  // is not a reusable success proof.  It changes with locale, theme and cart
  // contents, and was the source of a real failure where the module required
  // `Your cart contains 1 ...` while the site emitted a modal plus a cart
  // badge.  Require the author to inspect a structural/semantic signal (or a
  // state transition) instead of freezing one observed sentence.  This is a
  // generic source guard; it does not name a site, product or field.
  const fixedCartSentenceLiteral = /["'`][^"'`]{0,180}(?:cart|shopping\s+bag|购物车|购物袋)[^"'`]{0,100}(?:contains?|has|有|包含)[^"'`]{0,80}(?:\b(?:one|two|three|[0-9]+)\b|\d+\s*(?:item|items|product|products|件|个|只|台|份))[^"'`]{0,80}["'`]/iu;
  if (
    fixedCartSentenceLiteral.test(heuristicSource)
    && /(?:includes|indexOf|match|===|!==)/iu.test(heuristicSource)
    && /(?:innerText|textContent|body|dialog|status|aria-live)/iu.test(heuristicSource)
  ) {
    return {
      ok: false,
      code: "capability_module_fixed_cart_success_text",
      message: "do not assert a literal cart sentence or fixed quantity; verify structural success evidence such as a visible status/dialog, item identity, or a cart-count/state transition derived from the page",
    };
  }
  // A business identity sliced out of a text blob between literal page phrases
  // is not a reusable reading of the result: those phrases are editorial copy
  // that varies per record and per day. A production capability extracted the
  // hot-search title as the text between "Close" and one of three badge
  // phrases; it passed its own replay and both validation cases, then failed
  // for every topic whose dialog carried none of them.
  //
  // Only that shape is refused, and it is recognised by where the text came
  // from and what is captured — not by counting the characters of the literal.
  // Counting was tried and was wrong in both directions: the production case
  // above (`/Close\s*([\s\S]+?)\s*冲进/`) passed, because "冲进" is two
  // characters and "Close" one word, while a correct capability that read
  // `上榜记录 5 条` off the very span carrying it was refused three times in a
  // row and gave up. Reading a labelled value from the element that holds it
  // is how a page yields that value; presence checks (`/…/.test(text)`) were
  // always allowed and still are.
  const verifySectionStart = normalized.indexOf("stage_verify");
  if (verifySectionStart >= 0) {
    const verifySection = stripJavaScriptComments(normalized.slice(verifySectionStart));
    if (/innerText|textContent/u.test(verifySection)) {
      const blobs = wholeDocumentTextNames(verifySection);
      const extraction = /\.\s*(?:match|exec)\s*\(\s*(\/(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+\/[a-z]*)/giu;
      for (const found of verifySection.matchAll(extraction)) {
        const pattern = found[1];
        const lastSlash = pattern.lastIndexOf("/");
        const body = pattern.slice(1, lastSlash);
        const flags = pattern.slice(lastSlash + 1);
        // A captured value is not an identity. `找到 (\d+) 条` and `(\d+\.?\d*万)`
        // are the only way those numbers are published, on any page; what the
        // rule is after is a capture that can match free text — one built from
        // `.`, `\S`, `\w`, a negated class, `[\s\S]`, or a letter/CJK class.
        // A capture built only from digits, escaped punctuation and literal
        // characters is a reading, wherever the text came from.
        const identities = capturingGroupBodies(body).filter(isIdentityCapture);
        if (!identities.length) continue;
        // A label and its value sit on one line. Only a slice out of a
        // multi-line blob needs a class that crosses line boundaries.
        const crossesLines = flags.includes("s") || identities.some((group) => /\[\\s\\S\]|\[\\S\\s\]/u.test(group));
        // The slice ends just before the `.` of `.match(`, so the receiver is
        // whatever identifier chain ends the slice. Demanding the dot too meant
        // this never matched, `fromWholeDocument` was always false, and a title
        // sliced out of the dialog's text on one line — anchored on 冲进前三 —
        // was published.
        const receiver = /([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*$/u.exec(verifySection.slice(Math.max(0, found.index - 200), found.index))?.[1] || "";
        const fromWholeDocument = blobs.has(receiver.trim()) || isWholeDocumentText(receiver);
        if (crossesLines || fromWholeDocument) {
          return {
            ok: false,
            code: "capability_module_verification_text_slicing",
            message: "do not capture a business identity from between literal page phrases; read it from structure (the element the action acted on via state, a heading/title node, a link URL parameter or a data attribute)",
          };
        }
      }
    }
  }
  // The terminal verifier must read the same identity/facet inputs that drive
  // selection. Otherwise a module can select an arbitrary fallback candidate
  // and report success based only on a generic cart toast. Keep this as an
  // internal source gate; legacy modules without a stage_verify are left
  // untouched for compatibility.
  const verifyMarker = normalized.indexOf("stage_verify");
  if (targetInputPaths.length > 0 && verifyMarker >= 0) {
    const verifySource = normalized.slice(verifyMarker);
    for (const path of targetInputPaths) {
      const name = string(path).split(".")[0];
      if (!name) continue;
      // Reuse the same source-level reader used by the public input gate so
      // stage_verify accepts optional chaining (`input?.field`), Unicode
      // bracket access and an input-preserving alias. Keeping one analyzer
      // avoids a false rejection where the action stages accept the exact
      // input but the terminal verifier happens to spell the access safely.
      const directUsage = sourceInputPathUsageCount(verifySource, name);
      if (directUsage <= 0) {
        return {
          ok: false,
          code: `capability_module_input_not_verified:${name}`,
          message: `stage_verify must verify input.${name} against the final business state`,
        };
      }
    }
  }
  // Every output of stage_verify must be traceable to something the page
  // provides. This is the general form of every verify-stage rule above: they
  // name shapes that shipped and give the model a specific message; this one
  // runs last, accepts sources, and refuses whatever the others did not name.
  if (verifyStart >= 0) {
    // `stage_verify` is found inside its own string literal. A slice that
    // starts mid-string inverts quote parity for everything after it, and the
    // scanners then never find a statement's end. Start on the quote instead.
    const verifyFrom = /["']/u.test(executableWithoutComments[verifyStart - 1] || "") ? verifyStart - 1 : verifyStart;
    const verifySource = executableWithoutComments.slice(verifyFrom);
    const resolver = new ProvenanceResolver(verifySource);
    // A verify stage whose output cannot be read is refused, not waved through:
    // this rule fails closed.
    const entries = resolver.outputEntries() ?? [{ key: "output", expression: "<the output object could not be parsed>" }];
    {
      for (const entry of entries) {
        const provenance = resolver.resolve(entry.expression);
        if (provenance === "ok") continue;
        return {
          ok: false,
          code: `capability_module_output_provenance_unknown:${entry.key}`,
          message: provenance === "blob"
            ? `output.${entry.key} is cut out of the text of the whole document or dialog. Read it from the element that carries it — a heading, a link, a cell — via querySelector/closest on the result container, or from state.targets.__actedOn when it is the acted-on identity; a number may be parsed out of the text with parseInt/Number. When the page does not provide it, return NoResult`
            : `output.${entry.key} cannot be traced to anything the page provides (expression: ${entry.expression.slice(0, 80)}). Accepted sources: a located element's textContent/innerText/href/value/getAttribute/dataset, location.href, state.*, input.*, a literal, and trim/replace/slice/split/parseInt/Number or a regular-expression capture applied to one of those. When the page does not provide it, return NoResult`,
        };
      }
    }
  }
  if (/\/\/[#@]\s*sourceMappingURL=/i.test(normalized)) return { ok: false, code: "capability_module_source_map_forbidden", message: "source maps are not published with capability modules" };
  return { ok: true };
}

export async function capabilityModuleHash(source: string) {
  const normalized = source.replace(/\r\n/g, "\n").trim();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeStages(value: unknown): CapabilityStageManifest[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): CapabilityStageManifest[] => {
    const item = record(raw); const id = string(item.id);
    if (!id) return [];
    const transitions = record(item.transitions);
    const normalizedTransitions = Object.fromEntries(
      Object.entries(transitions)
        .map(([signal, target]) => [signal.trim(), string(target)] as const)
        .filter(([signal, target]) => Boolean(signal && target)),
    );
    const io = normalizeCapabilityStageIO(item.io);
    const navigation = normalizeCapabilityStageNavigation(item.navigation);
    return [{
      id,
      title: string(item.title) || id,
      purpose: string(item.purpose) || string(item.title) || id,
      effect: item.effect === "write" ? "write" : "read",
      resumePolicy: item.resumePolicy === "reconcile-before-retry" ? "reconcile-before-retry" : "skip-completed",
      io: io as CapabilityStageManifest["io"],
      navigation: navigation as CapabilityStageManifest["navigation"],
      ...(Object.keys(normalizedTransitions).length ? { transitions: normalizedTransitions } : {}),
    }];
  });
}

function normalizeControlFlow(value: unknown): CapabilityControlFlow | undefined {
  if (value === undefined) return undefined;
  // Preserve malformed declarations so the inspection boundary can reject
  // them. Silently dropping an invalid loop changes the graph being checked
  // and can turn an unbounded back edge into an apparently linear program.
  if (!value || typeof value !== "object" || Array.isArray(value)) return value as CapabilityControlFlow;
  const raw = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...raw };
  if (Array.isArray(raw.loops)) {
    normalized.loops = raw.loops.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
      const item = candidate as Record<string, unknown>;
      return {
        ...item,
        ...(typeof item.id === "string" ? { id: item.id.trim() } : {}),
        ...(typeof item.entry === "string" ? { entry: item.entry.trim() } : {}),
        ...(Array.isArray(item.stageIds) ? { stageIds: item.stageIds.map((stageId) => typeof stageId === "string" ? stageId.trim() : stageId) } : {}),
        ...(Array.isArray(item.progressPaths) ? { progressPaths: item.progressPaths.map((path) => typeof path === "string" ? path.trim() : path) } : {}),
      };
    });
  }
  return normalized as CapabilityControlFlow;
}

function normalizeParameterRoles(value: unknown): CapabilityParameterRole[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): CapabilityParameterRole[] => {
    const item = record(raw); const inputPath = string(item.inputPath);
    if (!inputPath) return [];
    const role = item.role === "target" || item.role === "context" ? item.role : "value";
    return [{ inputPath, role }];
  });
}

function normalizeTargetBindings(value: unknown): CapabilityTargetBinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): CapabilityTargetBinding[] => {
    const item = record(raw); const inputPath = string(item.inputPath); const identityStatePath = string(item.identityStatePath);
    if (!inputPath || !identityStatePath) return [];
    return [{ inputPath, identityStatePath, targetKind: string(item.targetKind) || "business-object", required: item.required !== false }];
  });
}

function normalizeProvenance(value: unknown): CapabilityPromptProvenance[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): CapabilityPromptProvenance[] => {
    const item = record(raw); const promptKey = string(item.promptKey); const promptVersion = string(item.promptVersion); const promptHash = string(item.promptHash); const model = string(item.model);
    return promptKey && promptVersion && promptHash && model ? [{ promptKey, promptVersion, promptHash, model }] : [];
  });
}

function normalizeInputAliases(value: unknown): CapabilityInputAliases | undefined {
  const raw = record(value);
  const aliases: CapabilityInputAliases = {};
  for (const [name, values] of Object.entries(raw)) {
    const map = record(values);
    const normalized = Object.fromEntries(Object.entries(map).filter(([from, to]) => from.trim() && typeof to === "string" && to.trim()).map(([from, to]) => [from, String(to).trim()]));
    if (Object.keys(normalized).length) aliases[name] = normalized;
  }
  return Object.keys(aliases).length ? aliases : undefined;
}

export function normalizeCapabilityJavaScriptProgram(value: unknown): CapabilityProgram {
  const raw = record(value); const moduleRecord = record(raw.module); const entry = record(raw.entry);
  const controlFlow = normalizeControlFlow(raw.controlFlow);
  return {
    schemaVersion: "2.0",
    runtime: "BrowserJavaScriptStage",
    module: {
      contentHash: string(moduleRecord.contentHash),
      moduleUrl: string(moduleRecord.moduleUrl),
      exportName: "capability",
    },
    entry: {
      mode: entry.mode === "Navigate" ? "Navigate" : "CurrentPage",
      ...(string(entry.url) ? { url: string(entry.url) } : {}),
    },
    stages: normalizeStages(raw.stages),
    ...(controlFlow !== undefined ? { controlFlow } : {}),
    parameterRoles: normalizeParameterRoles(raw.parameterRoles),
    targetBindings: normalizeTargetBindings(raw.targetBindings),
    promptProvenance: normalizeProvenance(raw.promptProvenance),
    ...(normalizeInputAliases(raw.inputAliases) ? { inputAliases: normalizeInputAliases(raw.inputAliases) } : {}),
    ...(raw.semantic && typeof raw.semantic === "object" ? { semantic: raw.semantic as CapabilitySemanticIR } : {}),
    ...(Array.isArray(raw.dependencyLedger) ? { dependencyLedger: raw.dependencyLedger as DependencyLedgerEntry[] } : {}),
    ...(raw.entryPolicy && typeof raw.entryPolicy === "object" ? { entryPolicy: raw.entryPolicy as EntryPolicy } : {}),
  };
}

export function inspectCapabilityJavaScriptProgram(program: CapabilityProgram) {
  const issues: string[] = [];
  const raw = program as unknown as Partial<CapabilityProgram>;
  const moduleRef = raw.module || { contentHash: "", moduleUrl: "", exportName: "capability" as const };
  const stages = Array.isArray(raw.stages) ? raw.stages : [];
  const parameterRoles = Array.isArray(raw.parameterRoles) ? raw.parameterRoles : [];
  const targetBindings = Array.isArray(raw.targetBindings) ? raw.targetBindings : [];
  const entry = raw.entry || { mode: "CurrentPage" as const };
  if (raw.schemaVersion !== "2.0" || raw.runtime !== "BrowserJavaScriptStage") issues.push("program_protocol_invalid");
  if (!/^[a-f0-9]{64}$/.test(moduleRef.contentHash)) issues.push("module_hash_invalid");
  if (!moduleRef.moduleUrl) issues.push("module_url_required");
  if (!stages.length) issues.push("stage_manifest_required");
  if (new Set(stages.map((stage) => stage.id)).size !== stages.length) issues.push("stage_id_duplicate");
  const stageIds = new Set(stages.map((stage) => stage.id).filter(Boolean));
  for (const stage of stages) if (!stage.id) issues.push("stage_id_required");
  for (const stage of stages) {
    const io = stage.io as unknown;
    if (!io || typeof io !== "object" || Array.isArray(io)) {
      issues.push(`stage_io_required:${stage.id}`);
    } else {
      const ioRecord = io as Record<string, unknown>;
      const reads = ioRecord.reads && typeof ioRecord.reads === "object" && !Array.isArray(ioRecord.reads) ? ioRecord.reads as Record<string, unknown> : undefined;
      const writes = ioRecord.writes && typeof ioRecord.writes === "object" && !Array.isArray(ioRecord.writes) ? ioRecord.writes as Record<string, unknown> : undefined;
      for (const [label, value] of [["reads.input", reads?.input], ["reads.state", reads?.state], ["writes.state", writes?.state], ["writes.output", writes?.output]] as const) {
        if (!Array.isArray(value) || value.some((path) => typeof path !== "string" || !path.trim())) issues.push(`stage_io_${label.replace(".", "_")}_invalid:${stage.id}`);
      }
    }
    if (!normalizeCapabilityStageNavigation(stage.navigation)) issues.push(`stage_navigation_invalid:${stage.id}`);
  }
  if (entry.mode === "Navigate" && !entry.url) issues.push("entry_url_required");
  const roles = new Map(parameterRoles.map((item) => [item.inputPath, item.role]));
  for (const binding of targetBindings) if (roles.get(binding.inputPath) !== "target") issues.push(`target_binding_role_invalid:${binding.inputPath}`);
  for (const [path, role] of roles) if (role === "target" && !targetBindings.some((binding) => binding.inputPath === path)) issues.push(`target_binding_required:${path}`);
  const hasControlFlow = raw.controlFlow !== undefined;
  const controlFlow = raw.controlFlow;
  let loops: unknown[] = [];
  if (hasControlFlow) {
    if (!controlFlow || typeof controlFlow !== "object" || Array.isArray(controlFlow)) issues.push("control_flow_invalid");
    const controlFlowRecord = controlFlow && typeof controlFlow === "object" && !Array.isArray(controlFlow)
      ? controlFlow as Record<string, unknown>
      : {};
    if (!Array.isArray(controlFlowRecord.loops)) issues.push("control_flow_loops_invalid");
    loops = Array.isArray(controlFlowRecord.loops) ? controlFlowRecord.loops : [];
    const loopIds = new Set<string>();
    for (const loop of loops) {
      if (!loop || typeof loop !== "object") {
        issues.push("control_flow_loop_invalid");
        continue;
      }
      const loopRecord = loop as Record<string, unknown>;
      const loopId = typeof loopRecord.id === "string" ? loopRecord.id : "";
      const entry = typeof loopRecord.entry === "string" ? loopRecord.entry : "";
      const stageList = Array.isArray(loopRecord.stageIds) ? loopRecord.stageIds : [];
      if (!loopId || loopIds.has(loopId)) issues.push(`control_flow_loop_id_invalid:${String(loopRecord.id || "")}`);
      loopIds.add(loopId);
      if (!stageIds.has(entry)) issues.push(`control_flow_loop_entry_missing:${loopId}`);
      if (!Array.isArray(loopRecord.stageIds) || !stageList.length) issues.push(`control_flow_loop_stages_required:${loopId}`);
      for (const stageId of stageList) {
        if (!stageIds.has(stageId)) issues.push(`control_flow_loop_stage_missing:${loopId}:${String(stageId)}`);
      }
      if (!Array.isArray(loopRecord.stageIds) || !stageList.includes(entry)) issues.push(`control_flow_loop_entry_not_member:${loopId}`);
      if (!Number.isInteger(loopRecord.maxIterations) || Number(loopRecord.maxIterations) <= 0) issues.push(`control_flow_loop_max_iterations_invalid:${loopId}`);
      if (!Number.isInteger(loopRecord.maxNoProgress) || Number(loopRecord.maxNoProgress) <= 0) issues.push(`control_flow_loop_max_no_progress_invalid:${loopId}`);
      if (typeof loopRecord.timeoutMs !== "number" || !Number.isFinite(loopRecord.timeoutMs) || loopRecord.timeoutMs <= 0) issues.push(`control_flow_loop_timeout_invalid:${loopId}`);
      if (loopRecord.progressPaths !== undefined && (!Array.isArray(loopRecord.progressPaths) || loopRecord.progressPaths.some((path: unknown) => typeof path !== "string" || !path.trim()))) {
        issues.push(`control_flow_loop_progress_paths_invalid:${loopId}`);
      }
    }
    if (controlFlowRecord.maxTransitions !== undefined && (!Number.isInteger(controlFlowRecord.maxTransitions) || Number(controlFlowRecord.maxTransitions) <= 0)) issues.push("control_flow_max_transitions_invalid");
    if (controlFlowRecord.totalTimeoutMs !== undefined && (typeof controlFlowRecord.totalTimeoutMs !== "number" || !Number.isFinite(controlFlowRecord.totalTimeoutMs) || controlFlowRecord.totalTimeoutMs <= 0)) issues.push("control_flow_total_timeout_invalid");
  }
  // Graph safety is independent of whether a controlFlow object was supplied:
  // every backwards edge must be covered by a declared finite loop.
  for (const stage of stages) {
    const transitions = stage.transitions && typeof stage.transitions === "object" && !Array.isArray(stage.transitions)
      ? stage.transitions
      : {};
    for (const [signal, target] of Object.entries(transitions)) {
      if (!stageIds.has(target)) issues.push(`control_flow_transition_target_missing:${stage.id}:${signal}`);
      const fromIndex = stages.findIndex((candidate) => candidate.id === stage.id);
      const targetIndex = stages.findIndex((candidate) => candidate.id === target);
      if (targetIndex >= 0 && targetIndex <= fromIndex) {
        const bounded = loops.some((loop) => {
          if (!loop || typeof loop !== "object" || Array.isArray(loop)) return false;
          const loopRecord = loop as Record<string, unknown>;
          const stageList = Array.isArray(loopRecord.stageIds) ? loopRecord.stageIds : [];
          return loopRecord.entry === target && stageList.includes(stage.id) && stageList.includes(target);
        });
        if (!bounded) issues.push(`control_flow_back_edge_unbounded:${stage.id}:${signal}`);
      }
    }
  }
  return { valid: issues.length === 0, issues };
}

export function publicCapabilityProgram(program: CapabilityProgram): JsonObject {
  return JSON.parse(JSON.stringify(program)) as JsonObject;
}
