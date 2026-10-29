/**
 * The visitor's recording as the authoring trace.
 *
 * A successful run arrives with its actions — each with the element it acted
 * on (role, name, address) and the page it happened on — and the pages it
 * started and ended on. That is the trace the seed is built from; nothing
 * here opens a browser or asks a model. The recording is a person's path,
 * not a program: it carries detours and dead ends, and those are taken out
 * by what the recording itself shows —
 *
 * - an action with no effect: a click that only focused a text box, a fill
 *   that was never submitted, a click repeated on the same element while the
 *   page stayed as it was;
 * - a detour: a link whose address the recording never arrived at, because
 *   the next thing happened back on the page the link was clicked on;
 * - a loop: pages the visitor returned to (paging forward and back through a
 *   list), kept as the shortest way from the start to the page they ended on.
 */
import type { CapabilityDslProgram, CapabilityExperience, CapabilityTaskInput, JsonValue, LocatorStrategy, ProgramStep } from "../../lib/capability-center-v2/model";
import { strategiesFor } from "./browser-runtime";

type RecordedAction = CapabilityExperience["actions"][number];
type RecordedElement = NonNullable<RecordedAction["element"]>;

/** An action with the page the recording shows it led to: the next action's page, or the end page for the last. */
type Move = { action: RecordedAction; index: number; from: string; to: string };

/** Roles a click only focuses; the fill or press that follows is the action. */
const FOCUS_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const FOCUS_TAGS = new Set(["input", "textarea"]);

export type RecordingTrace = {
  program: CapabilityDslProgram;
  /** What was left out, for the trace event and the person reading it. */
  dropped: Array<{ index: number; action: string; name: string; reason: "no-effect" | "focus" | "repeat" | "unsubmitted-fill" | "detour" | "loop" | "off-site" }>;
};

function pageKey(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/index\.html$/u, "/")}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

function samePage(left: string, right: string) {
  return pageKey(left) === pageKey(right);
}

function sameOrigin(url: string, origin: string) {
  try { return new URL(url).origin === origin; } catch { return false; }
}

/** A recorded name without icon-font glyphs (private-use characters), as the kernel matches it. */
function cleanName(value: string | undefined) {
  return (value || "").replace(/\p{Co}/gu, "").replace(/\s+/gu, " ").trim();
}

function nameOf(element: RecordedElement | undefined) {
  return cleanName(element?.accessibleName || element?.label || element?.name || element?.placeholder);
}

function signature(action: RecordedAction) {
  const element = action.element;
  return `${action.action}|${element?.tag || ""}|${element?.role || ""}|${nameOf(element)}|${element?.href || ""}`;
}

function isFocusClick(action: RecordedAction) {
  return action.action === "click" && (FOCUS_ROLES.has(action.element?.role || "") || FOCUS_TAGS.has(action.element?.tag || ""));
}

function filledText(action: RecordedAction) {
  const text = action.input?.text;
  return typeof text === "string" ? text : "";
}

/** A fill counts only when something submitted it: the page changed right after it, or a button or press followed on the same page. */
function fillSubmitted(moves: Move[], at: number) {
  const fill = moves[at];
  if (!samePage(fill.to, fill.from)) return true;
  for (let index = at + 1; index < moves.length; index += 1) {
    const later = moves[index];
    if (!samePage(later.from, fill.from)) return true;
    if (later.action.action === "fill" && signature(later.action) === signature(fill.action)) return false;
    if (later.action.action === "click" && (later.action.element?.role === "button" || later.action.element?.tag === "button" || later.action.element?.tag === "form")) return true;
    if (later.action.action === "click" && !isFocusClick(later.action) && !samePage(later.to, later.from)) return false;
  }
  return false;
}

function pageElement(element: RecordedElement | undefined, index: number) {
  return {
    index,
    tag: element?.tag || "a",
    role: element?.role,
    name: cleanName(element?.accessibleName || element?.name) || undefined,
    label: cleanName(element?.label) || undefined,
    placeholder: element?.placeholder,
    href: element?.href,
  };
}

/**
 * A link named the same in every entry — "(about)" beside each author — is
 * the one in the entry that names the input: the recording's text around the
 * element holds the demonstrated value though its own name does not.
 */
function entryInput(action: RecordedAction, input: CapabilityTaskInput, strategies: LocatorStrategy[]) {
  if (JSON.stringify(strategies).includes('"source":"input"')) return undefined;
  const around = (action.element?.contextText || "").normalize("NFKC").toLocaleLowerCase();
  // The address it leads to spells the value: /author/Albert-Einstein.html.
  // A link back to the page it is on (a sort order, a filter) is a control
  // of that page, whatever its address spells.
  const leadsTo = (() => {
    try {
      const target = new URL(action.element?.href || "");
      if (action.page?.url && new URL(action.page.url).pathname === target.pathname) return "";
      return slugWords((target.pathname.split("/").filter(Boolean).at(-1) || "").replace(/\.html?$/u, "")).join(" ");
    } catch { return ""; }
  })();
  return Object.entries(input.parameters).find(([, value]) => typeof value === "string" && value.trim().length > 1
    && ((around && around.includes(value.normalize("NFKC").trim().toLocaleLowerCase())) || (leadsTo && leadsTo === slugWords(value).join(" "))))?.[0];
}

function targetFor(action: RecordedAction, index: number, input: CapabilityTaskInput): ProgramStep["target"] {
  const strategies: LocatorStrategy[] = strategiesFor(pageElement(action.element, index), input);
  const name = nameOf(action.element);
  if (!strategies.length && name) strategies.push({ type: "text", value: name, match: "exact" });
  const path = entryInput(action, input, strategies);
  if (path && name && action.element?.role) strategies.unshift({ type: "role", role: action.element.role, name, match: "exact", containsText: { source: "input", path } });
  return { strategies };
}

/**
 * A typed value equal to an input is that input. Numbers count: a quantity of
 * 2 arrives in the recording as the text "2", and left a literal it made the
 * seed add two mugs whatever quantity was asked for.
 */
function valueFor(text: string, input: CapabilityTaskInput): ProgramStep["value"] {
  const typed = text.trim();
  const path = typed ? Object.entries(input.parameters).find(([, value]) => (typeof value === "string" || typeof value === "number") && String(value).trim() === typed)?.[0] : undefined;
  return path ? { source: "input", path } : { source: "literal", value: text };
}

function slugWords(value: string) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word && !/^\d+$/u.test(word));
}

/**
 * Whether the page the run started on is the one an input's value chose: its
 * heading or title is the value, or the last segment of its address spells
 * it (`/9-art` for "Art", `/6-accessories` for "Accessories" — the number is
 * the site's id, which no template can know).
 */
function pageNamedBy(page: CapabilityExperience["startPage"], value: string) {
  const want = slugWords(value).join(" ");
  if (!want) return false;
  if ([page.heading, page.title].some((text) => text && slugWords(text).join(" ") === want)) return true;
  try {
    const segment = new URL(page.url).pathname.split("/").filter(Boolean).at(-1) || "";
    return slugWords(segment.replace(/\.html?$/u, "")).join(" ") === want;
  } catch {
    return false;
  }
}

function usesInput(step: ProgramStep, path: string): boolean {
  return JSON.stringify(step).includes(JSON.stringify({ source: "input", path }));
}

/**
 * The trace the recording describes, as the program the seed is built from.
 * `parameters` are the demonstration's inputs: an element named by one of
 * them, or a text typed equal to one, is written as that input.
 */
export function traceFromExperience(experience: CapabilityExperience, parameters: Record<string, JsonValue>): RecordingTrace {
  const input: CapabilityTaskInput = { parameters, context: {}, interactions: [], trigger: {} };
  const start = experience.startPage.url;
  const end = experience.endPage.url;
  const origin = (() => { try { return new URL(start).origin; } catch { return ""; } })();
  const dropped: RecordingTrace["dropped"] = [];
  const drop = (move: Move, reason: RecordingTrace["dropped"][number]["reason"]) => dropped.push({ index: move.index, action: move.action.action, name: nameOf(move.action.element), reason });

  // Every action with where it led; actions that act on nothing, or off the site, are not steps.
  let moves: Move[] = experience.actions.map((action, index) => ({
    action, index, from: action.page.url,
    to: experience.actions[index + 1]?.page.url || end,
  }));
  moves = moves.filter((move) => {
    if (!["click", "fill", "select"].includes(move.action.action)) { drop(move, "no-effect"); return false; }
    if (origin && !sameOrigin(move.from, origin)) { drop(move, "off-site"); return false; }
    if (isFocusClick(move.action)) { drop(move, "focus"); return false; }
    return true;
  });
  // A click repeated on the same element while the page stayed as it was.
  moves = moves.filter((move, index) => {
    const next = moves[index + 1];
    if (move.action.action === "click" && next && signature(next.action) === signature(move.action) && samePage(move.to, move.from) && samePage(next.from, move.from)) { drop(move, "repeat"); return false; }
    return true;
  });
  // A fill nothing submitted, or one typed over again before it was.
  moves = moves.filter((move, index) => {
    if (move.action.action !== "fill") return true;
    if (!fillSubmitted(moves, index)) { drop(move, "unsubmitted-fill"); return false; }
    return true;
  });
  // A link whose address the recording never arrived at: the next thing
  // happened back on the page it was clicked on.
  moves = moves.filter((move) => {
    const href = move.action.element?.href;
    if (move.action.action === "click" && href && !samePage(href, move.to) && samePage(move.to, move.from)) { drop(move, "detour"); return false; }
    return true;
  });
  // Loops: returning to a page already on the trail cuts the trail back to it.
  const trail: Move[] = [];
  for (const move of moves) {
    const back = trail.findIndex((kept) => samePage(kept.from, move.to));
    if (back >= 0 && !samePage(move.to, move.from)) {
      for (const cut of trail.splice(back)) drop(cut, "loop");
      drop(move, "loop");
      continue;
    }
    // An action taken from a page the trail already left from: the visitor
    // went back to it (the browser's back button is not recorded), and what
    // they did after leaving it the first time is not on the way.
    const current = trail.at(-1)?.to;
    const returned = current && !samePage(current, move.from) ? trail.findIndex((kept) => samePage(kept.from, move.from) && !samePage(kept.to, kept.from)) : -1;
    if (returned >= 0) for (const cut of trail.splice(returned)) drop(cut, "loop");
    trail.push(move);
  }

  const steps: ProgramStep[] = [];
  const first = trail[0];
  if (first && !samePage(first.from, start)) {
    steps.push({ id: "step_open", action: "navigate", value: { source: "literal", value: first.from } });
  }
  for (const move of trail) {
    const index = steps.length + 1;
    const id = `step_${index}`;
    if (move.action.action === "fill") {
      const text = filledText(move.action);
      const submitted = text.endsWith("\n");
      steps.push({ id, action: "fill", target: targetFor(move.action, move.index, input), value: valueFor(text.replace(/\n+$/u, ""), input) });
      if (submitted) steps.push({ id: `step_${steps.length + 1}`, action: "press", target: targetFor(move.action, move.index, input), key: "Enter" });
      continue;
    }
    if (move.action.action === "select") {
      steps.push({ id, action: "select", target: targetFor(move.action, move.index, input), value: valueFor(filledText(move.action) || nameOf(move.action.element), input) });
      continue;
    }
    steps.push({ id, action: "click", target: targetFor(move.action, move.index, input) });
  }
  // The visitor began on the page an input chooses — a category page opened
  // straight from a link elsewhere, or read without a click — so no recorded
  // step uses that input, and a program built from the steps alone opens the
  // demonstrated page for every value. The way to that page is the site's own
  // link named by the value, from the home page; the draft's replay on the
  // other values the site lists proves the link is there.
  let entryUrl = start;
  // Or the run reached that page without a recorded click — the agent went
  // there by its address and only scrolled — and ended on it.
  const chosen = Object.entries(parameters).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0
    && !steps.some((step) => usesInput(step, entry[0]))
    && (pageNamedBy(experience.startPage, entry[1]) || (!steps.length && pageNamedBy(experience.endPage, entry[1]))));
  if (chosen.length === 1 && origin) {
    const [path] = chosen[0];
    const named = { source: "input" as const, path };
    entryUrl = `${origin}/`;
    steps.unshift({ id: "step_choose", action: "click", target: { strategies: [{ type: "role", role: "link", name: named, match: "exact" }, { type: "text", value: named, match: "exact" }] as LocatorStrategy[] } });
  }
  const program: CapabilityDslProgram = {
    schemaVersion: "1.0",
    entry: { mode: "Navigate", url: entryUrl },
    defaults: { timeoutMs: 15_000, retryCount: 1 },
    steps,
    result: { pageUrl: { source: "variable", name: "__pageUrl" }, pageTitle: { source: "variable", name: "__pageTitle" } },
  };
  return { program, dropped: dropped.sort((left, right) => left.index - right.index) };
}
