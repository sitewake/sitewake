/** Shared execution kernel used by the website SDK and the Playwright host.
 * Keep this function self-contained: Playwright serializes it into the page.
 * Host navigation, grants and checkpoints stay outside this kernel.
 */
export async function executeBrowserCapabilityStage(payload: string | {
  run?: (context: any) => unknown;
  moduleUrl?: string; index?: number;
  input: Record<string, unknown>; state: Record<string, unknown>;
  inputPaths: string[]; statePaths: string[]; stageId: string;
  deadlineAt: string; signal?: AbortSignal;
}): Promise<unknown> {
  const args = typeof payload === "string" ? JSON.parse(payload) as {run?: (context: any) => unknown;moduleUrl?:string;index?:number;input:Record<string,unknown>;state:Record<string,unknown>;inputPaths:string[];statePaths:string[];stageId:string;deadlineAt:string;signal?:AbortSignal} : payload;
  const pageWindow = globalThis as typeof globalThis & {__name?: (fn: unknown, name?: string) => unknown};
  if (typeof pageWindow.__name !== 'function') pageWindow.__name = fn => fn;
  const {inputPaths,statePaths,stageId} = args;
    const pathAllowed = (path: string, declared: string[]) => declared.some((candidate) => candidate === "*" || path === candidate || path.startsWith(`${candidate}.`));
    const hasDescendant = (path: string, declared: string[]) => declared.some((candidate) => candidate.startsWith(`${path}.`));
    const scopeJson = (value: unknown, declared: string[], kind: "input" | "state") => {
      const wrap = (current: unknown, prefix: string): unknown => {
        if (!current || typeof current !== "object" || Array.isArray(current)) return current;
        return new Proxy(current as Record<string, unknown>, {
          get(target, property, receiver) {
            if (typeof property === "symbol") return Reflect.get(target, property, receiver);
            const path = prefix ? `${prefix}.${property}` : property;
            if (!pathAllowed(path, declared) && !hasDescendant(path, declared)) throw new Error(`capability_stage_${kind}_read_undeclared:${stageId}:${path}`);
            return wrap(Reflect.get(target, property, receiver), path);
          },
          has(target, property) {
            if (typeof property === "symbol") return Reflect.has(target, property);
            const path = prefix ? `${prefix}.${property}` : property;
            if (!pathAllowed(path, declared) && !hasDescendant(path, declared)) throw new Error(`capability_stage_${kind}_read_undeclared:${stageId}:${path}`);
            return Reflect.has(target, property);
          },
          ownKeys(target) {
            return Reflect.ownKeys(target).filter((property) => {
              if (typeof property !== "string") return true;
              const path = prefix ? `${prefix}.${property}` : property;
              return pathAllowed(path, declared) || hasDescendant(path, declared);
            });
          },
        });
      };
      return wrap(value, "");
    };

  const run = args.run || (await import(/* @vite-ignore */ args.moduleUrl!)).capability?.stages?.[args.index!]?.run;
  if (typeof run !== 'function') throw new Error(`capability_stage_missing:${stageId}`);
  const abort = new AbortController();
  const propagate = () => abort.abort(args.signal?.reason);
  if (args.signal?.aborted) propagate();
  args.signal?.addEventListener('abort', propagate, {once:true});
  // The stages before this one used the budget up. Thrown bare, this was the
  // one timeout that said nothing: not which stage was starting, and not that
  // it had never had a chance to wait for anything. A validation spent 196
  // seconds on one case and ended with `capability_control_flow_timeout`,
  // while the same file names the pending wait three lines further down.
  const remaining = Date.parse(args.deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error(`capability_control_flow_timeout:${stageId}:pending=budget-exhausted-before-stage`);
  let rejectAbort: () => void = () => {};
  const cancelled = new Promise<never>((_,reject) => {
    rejectAbort = () => reject(abort.signal.reason || new Error('task_cancelled'));
    abort.signal.addEventListener('abort',rejectAbort,{once:true});
    if (abort.signal.aborted) rejectAbort();
  });
  // Name the wait that never settled when the deadline hits: a wrong selector
  // burns the whole totalTimeout, and a bare capability_control_flow_timeout
  // gives the model no way to tell that the waitFor selector matched nothing.
  let pendingWait = '';
  const waitUntil = async <T>(check: () => T | Promise<T>, label?: string): Promise<NonNullable<T>> => {
    const description = label || `waitUntil(${String(check).replace(/\s+/g, ' ').slice(0, 160)})`;
    pendingWait = description;
    try {
      while (true) {
        if (abort.signal.aborted) throw abort.signal.reason;
        const result = await check();
        if (result) return result as NonNullable<T>;
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { clearTimeout(poll); reject(abort.signal.reason); };
          const poll = setTimeout(() => { abort.signal.removeEventListener('abort', onAbort); resolve(); }, 100);
          abort.signal.addEventListener('abort', onAbort, {once:true});
          if (abort.signal.aborted) onAbort();
        });
      }
    } finally { if (pendingWait === description) pendingWait = ''; }
  };
  const waitFor = (selector: string) => waitUntil(() => {
    const element = document.querySelector(selector);
    return element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' ? element : null;
  }, `waitFor(${JSON.stringify(selector)})`);
  /**
   * Write a value the way real typing does. React/Vue controlled inputs treat a
   * string assigned to element.value as "unchanged": the framework's own value
   * tracker still holds the old value, onChange never fires, and the next render
   * resets the field to empty. In one production run all four drafts did
   * `input.value = keyword` plus an input event, and every self-test ended with an
   * empty search box, a click that did not navigate, and a timeout. Writing
   * through the prototype's native setter bypasses the framework's interception,
   * and the input/change events make it count as user typing.
   */
  const fill = (element: Element | null | undefined, value: string | number) => {
    if (!element || !(element instanceof HTMLElement)) throw new Error(`capability_stage_fill_target_missing:${stageId}`);
    const text = String(value);
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : element instanceof HTMLInputElement ? HTMLInputElement.prototype
      : null;
    if (!prototype) {
      if (element.isContentEditable) { element.focus(); element.textContent = text; element.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text})); return element; }
      throw new Error(`capability_stage_fill_target_not_editable:${stageId}:${element.tagName.toLowerCase()}`);
    }
    element.focus();
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, text); else (element as HTMLInputElement).value = text;
    element.dispatchEvent(new InputEvent('input', {bubbles:true, inputType:'insertText', data:text}));
    element.dispatchEvent(new Event('change', {bubbles:true}));
    return element;
  };
  /**
   * Resolve an exploration-style target ({ strategies: [...] }) inside the page.
   *
   * The explorer proves a path with role/name, text and css strategies. Authored
   * modules used to re-derive selectors by hand, and `[name="…"]` built from a
   * computed accessible name never matches anything. This resolver computes the
   * accessible name the same way, so a module can reuse the proven target as is.
   */
  type Strategy = { type: string; role?: string; name?: unknown; value?: unknown; match?: string; containsText?: unknown };
  const normalizeText = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = (element: Element | null): element is HTMLElement => Boolean(element && element instanceof HTMLElement && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const accessibleName = (element: Element): string => {
    const aria = element.getAttribute('aria-label'); if (aria && aria.trim()) return normalizeText(aria);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) { const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '); if (normalizeText(text)) return normalizeText(text); }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      if (element.id) { const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`); if (label && normalizeText(label.textContent)) return normalizeText(label.textContent); }
      const wrapping = element.closest('label'); if (wrapping && normalizeText(wrapping.textContent)) return normalizeText(wrapping.textContent);
      if (element instanceof HTMLInputElement && (element.type === 'submit' || element.type === 'button') && element.value) return normalizeText(element.value);
      if ('placeholder' in element && element.placeholder) return normalizeText(element.placeholder);
      return normalizeText(element.getAttribute('title'));
    }
    const image = element.querySelector('img[alt]'); const own = normalizeText(element.textContent);
    return own || normalizeText(image?.getAttribute('alt')) || normalizeText(element.getAttribute('title'));
  };
  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute('role'); if (explicit) return explicit.trim().toLowerCase();
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'option') return 'option';
    if (tag === 'input') {
      const type = (element as HTMLInputElement).type;
      if (['submit', 'button', 'image', 'reset'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox'; if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox'; if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    return tag;
  };
  const textFamily = new Set(['textbox', 'searchbox', 'combobox']);
  const roleMatches = (wanted: string, actual: string) => wanted === actual || (textFamily.has(wanted) && textFamily.has(actual));
  const textMatches = (wanted: string, actual: string, match?: string) => match === 'contains' ? actual.includes(wanted) : actual === wanted;
  const CANDIDATES = 'a,button,input,select,textarea,summary,option,label,[role],[tabindex],[contenteditable],li,td,th,h1,h2,h3,h4,span,div,p';
  const findOne = (strategy: Strategy): HTMLElement | null => {
    if (strategy.type === 'css') { const element = document.querySelector(String(strategy.value ?? '')); return visible(element) ? element : null; }
    if (strategy.type === 'testId') { const element = document.querySelector(`[data-testid="${CSS.escape(String(strategy.value ?? ''))}"]`); return visible(element) ? element : null; }
    const wanted = normalizeText(strategy.type === 'role' ? strategy.name : strategy.value);
    if (!wanted && strategy.type !== 'role') return null;
    const elements = [...document.querySelectorAll(CANDIDATES)];
    if (strategy.type === 'role') {
      const role = String(strategy.role || '').toLowerCase();
      return elements.find((element) => visible(element) && roleMatches(role, roleOf(element)) && (!wanted || textMatches(wanted, accessibleName(element), strategy.match))) as HTMLElement || null;
    }
    if (strategy.type === 'label') {
      return elements.find((element) => visible(element) && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && textMatches(wanted, accessibleName(element), strategy.match)) as HTMLElement || null;
    }
    // text: prefer interactive elements, then the smallest element whose own text matches.
    const matching = elements.filter((element) => visible(element) && textMatches(wanted, normalizeText(element.textContent), strategy.match));
    const interactive = matching.find((element) => ['button', 'link', 'option', 'menuitem', 'tab', 'checkbox', 'radio'].includes(roleOf(element)) || element.matches('[tabindex],[contenteditable]'));
    return (interactive || matching.find((element) => !matching.some((other) => other !== element && element.contains(other))) || null) as HTMLElement | null;
  };
  const find = (target: unknown): HTMLElement | null => {
    const strategies: Strategy[] = typeof target === 'string' ? [{ type: 'css', value: target }]
      : Array.isArray(target) ? target as Strategy[]
      : target && typeof target === 'object' && Array.isArray((target as { strategies?: unknown }).strategies) ? (target as { strategies: Strategy[] }).strategies
      : target && typeof target === 'object' ? [target as Strategy] : [];
    for (const strategy of strategies) { try { const element = findOne(strategy); if (element) return element; } catch { /* an invalid selector in one strategy does not disqualify the others */ } }
    return null;
  };
  const waitForTarget = (target: unknown) => waitUntil(() => find(target), `find(${JSON.stringify(target).slice(0, 300)})`);
  /**
   * Let an in-place update finish rendering. A click that opens a drawer or a
   * panel changes the document the moment the container mounts, and a Stage
   * that reads right then sees an empty shell: one production run read the
   * result region three milliseconds after the click and reported no result
   * while the drawer was still painting.
   *
   * Bounded and non-throwing on purpose — a page with a live clock or a ticker
   * never goes quiet, and waiting for it must not fail the capability. Returns
   * once the document has been unchanged for `quietMs`, or once `capMs` has
   * elapsed, whichever comes first.
   */
  /**
   * Does `candidate` name the same business object as the text the action
   * stage acted on? The acted-on text is whatever the clicked element showed —
   * a card carries the title along with its rank, counter, badge and timestamp —
   * so the two are almost never equal. Authored modules kept comparing them
   * with === or containment in the wrong direction and rejecting their own
   * correct result ("3 卫星互联网低轨26组卫星成功发射 95.7万 微博 2小时" vs
   * "卫星互联网低轨26组卫星成功发射"); this is that comparison, once.
   *
   * Compares after collapsing whitespace and dropping pictographs, per line and
   * whole, in both directions. A candidate shorter than two characters proves
   * nothing and never matches.
   */
  const identityMatches = (actedOn: unknown, candidate: unknown) => {
    const clean = (value: unknown) => String(value ?? "")
      .normalize("NFKC")
      .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const target = clean(candidate);
    if (target.length < 2) return false;
    const source = clean(actedOn);
    if (!source) return false;
    const parts = [source, ...String(actedOn ?? "").split(/[\n\r]+/u).map(clean)].filter((part) => part.length >= 2);
    return parts.some((part) => part.includes(target) || target.includes(part));
  };
  const settle = (quietMs = 300, capMs = 1500) => settleCapabilityPage(abort.signal, quietMs, capMs);
  const timer = setTimeout(() => abort.abort(new Error(pendingWait ? `capability_control_flow_timeout:${stageId}:pending=${pendingWait}` : `capability_control_flow_timeout:${stageId}`)), remaining);
  try {
    return await Promise.race([Promise.resolve().then(() => {
      if (abort.signal.aborted) throw abort.signal.reason;
      return run({input:scopeJson(args.input,inputPaths,'input'),state:scopeJson(args.state,statePaths,'state'),signal:abort.signal,deadlineAt:args.deadlineAt,waitFor,waitUntil,settle,identityMatches,fill,find,waitForTarget});
    }),cancelled]);
  } finally { clearTimeout(timer); args.signal?.removeEventListener('abort',propagate); abort.signal.removeEventListener('abort',rejectAbort); }
}


/**
 * Wait until the page stops changing shape, or until the cap runs out.
 *
 * The same wait a Stage asks for through `settle`, and the one the runtime
 * takes before looking again at a read Stage that came back empty. Address,
 * text length and node count together are enough to see a page still putting
 * itself together, and cheap enough to sample every 50ms.
 */
export async function settleCapabilityPage(signal: AbortSignal | undefined, quietMs = 300, capMs = 1500) {
  const started = Date.now();
  let previous = "";
  let quietSince = 0;
  while (Date.now() - started < capMs) {
    if (signal?.aborted) return;
    const shape = `${location.href}|${document.body?.innerText.length ?? 0}|${document.querySelectorAll("*").length}`;
    const now = Date.now();
    if (shape !== previous) { previous = shape; quietSince = now; }
    else if (now - quietSince >= quietMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}
