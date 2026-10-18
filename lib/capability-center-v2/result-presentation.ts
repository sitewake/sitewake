import { localizedValue, type Locale, type LocalizedStrings } from '../i18n/locale';
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

/**
 * The frame this summary is built from: interface copy, not authored text, so it belongs
 * in a catalog and is passed in. The widget supplies the visitor's catalog; the English
 * default below keeps every other caller — and a server-side render with no visitor —
 * readable rather than silently Chinese.
 */
export type CompletionCopy = {
  completed: string;
  action: string;
  separator: string;
  titleOpen: string;
  titleClose: string;
  yes: string;
  no: string;
  viewDetails: string;
};

export const COMPLETION_COPY_EN: CompletionCopy = {
  completed: 'Completed',
  action: 'the action',
  separator: ': ',
  titleOpen: '“',
  titleClose: '”',
  yes: 'Yes',
  no: 'No',
  viewDetails: 'View details',
};

/** A contract field's label: authored per site, so stored in both languages. */
function fieldLabel(schema: Record<string, unknown>, locale: Locale) {
  const stored = typeof schema.title === 'string' ? schema.title : '';
  return text(localizedValue(locale, schema.localizedTitles as LocalizedStrings | undefined, stored), 40);
}

/** Render verified public outputs without another model call or DOM scrape. */
export function capabilityCompletionText(
  name: string,
  input: Record<string, JsonValue>,
  output: Record<string, JsonValue>,
  outputSchema: unknown = {},
  presentation: { copy?: CompletionCopy; locale?: Locale } = {},
) {
  const copy = presentation.copy || COMPLETION_COPY_EN;
  const locale = presentation.locale || 'en';
  const rendered = name.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, key: string) => {
    const value = key.split('.').reduce<unknown>((v, part) => object(v)[part], input);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  });
  const titleKeys = ['targetTitle', 'topicTitle', 'itemTitle', 'productName'];
  const titleKey = titleKeys.find(key => text(output[key]));
  const title = titleKey ? text(output[titleKey]) : '';
  const head = `${copy.completed}${copy.separator}${text(rendered) || copy.action}`;
  const lines = [`${head}${title ? `${copy.titleOpen}${title}${copy.titleClose}` : ''}`];
  const summary = text(output.resultSummary, 400);
  if (summary && summary !== title) lines.push(summary);
  const reserved = new Set([...titleKeys, 'targetUrl', 'pageUrl', 'pageTitle', 'resultSummary']);
  // Other scalar business facts opt into display via the public schema title.
  const facts: string[] = [];
  for (const [key, schema] of Object.entries(object(object(outputSchema).properties))) {
    if (reserved.has(key)) continue;
    const label = fieldLabel(object(schema), locale); const value = output[key];
    if (!label || value === undefined || value === null) continue;
    const renderedValue = typeof value === 'number' && Number.isFinite(value) ? String(value)
      : typeof value === 'boolean' ? (value ? copy.yes : copy.no) : text(value, 160);
    if (renderedValue) facts.push(`${label}${copy.separator}${renderedValue}`);
    if (facts.length === 4) break;
  }
  if (facts.length) lines.push(facts.map(fact => `- ${fact}`).join('\n'));
  const url = link(output.targetUrl) || link(output.pageUrl);
  if (url) lines.push(`[${copy.viewDetails}](${url})`);
  return lines.join('\n\n');
}
