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
