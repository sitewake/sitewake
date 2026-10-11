import type { JsonValue } from '../site-knowledge/protocol';

// Page content remains text, never Markdown instructions or injected links.
function text(value: unknown, max = 200): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max)
    .replace(/[\\`*_\[\]<>]/g, c => ({'\\':'＼','`':'｀','*':'＊','_':'＿','[':'［',']':'］','<':'＜','>':'＞'}[c]!)) : '';
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function link(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href.replace(/[()\[\]]/g, c => encodeURIComponent(c).replace('(', '%28').replace(')', '%29'));
  } catch { return ''; }
}

/** Render verified public outputs without another model call or DOM scrape. */
export function capabilityCompletionText(name: string, input: Record<string, JsonValue>, output: Record<string, JsonValue>, outputSchema: unknown = {}) {
  const rendered = name.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => {
    const value = key.split('.').reduce<unknown>((v, part) => object(v)[part], input);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  });
  const titleKeys = ['targetTitle', 'topicTitle', 'itemTitle', 'productName'];
  const titleKey = titleKeys.find(key => text(output[key]));
  const title = titleKey ? text(output[titleKey]) : '';
  const lines = [`已完成：${text(rendered) || '操作'}${title ? `「${title}」` : ''}`];
  const summary = text(output.resultSummary, 400);
  if (summary && summary !== title) lines.push(summary);
  const reserved = new Set([...titleKeys, 'targetUrl', 'pageUrl', 'pageTitle', 'resultSummary']);
  // Other scalar business facts opt into display via the public schema title.
  const facts: string[] = [];
  for (const [key, schema] of Object.entries(object(object(outputSchema).properties))) {
    if (reserved.has(key)) continue;
    const label = text(object(schema).title, 40); const value = output[key];
    if (!label || value === undefined || value === null) continue;
    const renderedValue = typeof value === 'number' && Number.isFinite(value) ? String(value)
      : typeof value === 'boolean' ? (value ? '是' : '否') : text(value, 160);
    if (renderedValue) facts.push(`${label}：${renderedValue}`);
    if (facts.length === 4) break;
  }
  if (facts.length) lines.push(facts.map(fact => `- ${fact}`).join('\n'));
  const url = link(output.targetUrl) || link(output.pageUrl);
  if (url) lines.push(`[查看详情](${url})`);
  return lines.join('\n\n');
}
