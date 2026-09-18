import type { AgentRunActivity, JsonValue } from '../lib/site-knowledge/protocol';

export function operationLabel(item: AgentRunActivity) {
  const values = item.input || {};
  return (item.capabilityName || item.label).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => {
    const value = key.split('.').reduce<JsonValue | undefined>((value, part) => value && typeof value === 'object' && !Array.isArray(value) ? value[part] : undefined, values);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }).trim();
}

export function operationRows(entries: AgentRunActivity[]) {
  return entries.filter(item => item.kind !== 'reasoning' && item.kind !== 'result'
    && !(item.kind === 'page' && item.capabilityId && entries.some(parent => parent.kind === 'capability' && parent.capabilityId === item.capabilityId)));
}

/**
 * Whether this turn actually operated: touched the page, ran a capability,
 * navigated, or asked the user. A plain chat answer that only searched the
 * capability catalog or site knowledge ("what's your name", "thanks") does not
 * count — hanging a "completed · view steps" disclosure on it only suggests it did something.
 */
export function hasVisibleOperations(entries: AgentRunActivity[]) {
  return operationRows(entries).some(item => ['capability', 'page', 'navigation', 'transition', 'human'].includes(item.kind));
}

/** One disclosure per response. Keep its native summary node/focus/open state.
 * `inFlight` says the owning run is still working. Between two tool calls no
 * row is running yet, so rows alone would read as "all done" too early. */
export function renderOperationTrace(target: HTMLDetailsElement, entries: AgentRunActivity[], english = false, inFlight = false, stopped = false) {
  const rows = operationRows(entries);
  const running = stopped ? undefined : rows.findLast(item => item.state === 'running');
  const failed = stopped || (!running && !inFlight && rows.some(item => item.state === 'failed'));
  if (stopped) inFlight = false;
  target.dataset.state = running || inFlight ? 'running' : failed ? 'failed' : 'completed';
  let summary = target.querySelector<HTMLElement>(':scope > summary');
  if (!summary) { summary = document.createElement('summary'); summary.className = 'run-trace-head'; target.prepend(summary); }
  let title = summary.querySelector('span');
  if (!title) { title = document.createElement('span'); summary.append(title); }
  // A stopped turn is neither "completed" nor "needs attention": say what happened.
  title.textContent = stopped ? (english ? 'Stopped' : '已停止')
    : running ? `${operationLabel(running)}…`
    : inFlight ? (english ? 'Working out the next step…' : '正在思考下一步…')
    : failed ? (english ? 'Some actions need attention' : '部分操作未完成') : (english ? 'Actions completed' : '已完成操作');
  let hint = summary.querySelector('em');
  if (!hint) { hint = document.createElement('em'); summary.append(hint); }
  hint.textContent = english ? 'Details' : '查看过程';
  let list = target.querySelector<HTMLOListElement>(':scope > ol');
  if (!list) { list = document.createElement('ol'); list.className = 'operation-list'; target.append(list); }
  list.replaceChildren();
  for (const item of rows) {
    const row = document.createElement('li'); row.className = `operation-row ${item.state}`;
    const marker = document.createElement('span'); marker.className = 'operation-marker'; marker.setAttribute('aria-hidden','true'); marker.textContent = item.state === 'failed' ? '!' : item.state === 'completed' ? '✓' : '';
    const label = document.createElement('span'); label.className = 'operation-name'; label.textContent = operationLabel(item);
    const state = document.createElement('small'); state.textContent = item.state === 'running' ? (english ? 'In progress' : '进行中') : item.state === 'failed' ? (english ? 'Not completed' : '未完成') : (english ? 'Done' : '完成');
    row.append(marker,label,state); list.append(row);
  }
}
