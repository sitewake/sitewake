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
  /** Said after the shown items of a longer list; `{count}` is how many were left out. */
  moreItems: string;
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
  moreItems: 'and {count} more',
};

const LIST_ITEMS_SHOWN = 8;

/**
 * A list output, one line per item. A list was the answer to most "show me"
 * capabilities and it was never shown: the summary rendered scalars only, so
 * a visitor who asked for living-room floor lamps read a count and not one lamp.
 */
function listLines(value: unknown, schema: Record<string, unknown>, copy: CompletionCopy): string[] {
  if (!Array.isArray(value) || !value.length) return [];
  const fields = Object.keys(object(object(schema.items).properties));
  const line = (item: unknown) => {
    if (typeof item === 'number' && Number.isFinite(item)) return String(item);
    if (typeof item === 'string') return text(item, 160);
    const record = object(item);
    const keys = fields.length ? fields : Object.keys(record);
    return keys.map(key => record[key])
      .map(part => typeof part === 'number' && Number.isFinite(part) ? String(part) : text(part, 80))
      .filter(Boolean).join(' · ').slice(0, 240);
  };
  const lines = value.slice(0, LIST_ITEMS_SHOWN).map(line).filter(Boolean).map(entry => `- ${entry}`);
  if (value.length > LIST_ITEMS_SHOWN) lines.push(`- ${copy.moreItems.replace('{count}', String(value.length - LIST_ITEMS_SHOWN))}`);
  return lines;
}

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
  const lists: string[] = [];
  for (const [key, schema] of Object.entries(object(object(outputSchema).properties))) {
    if (reserved.has(key)) continue;
    const label = fieldLabel(object(schema), locale); const value = output[key];
    if (!label || value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const items = listLines(value, object(schema), copy);
      if (items.length && !lists.length) lists.push(`${label}${copy.separator}\n${items.join('\n')}`);
      continue;
    }
    const renderedValue = typeof value === 'number' && Number.isFinite(value) ? String(value)
      : typeof value === 'boolean' ? (value ? copy.yes : copy.no) : text(value, 160);
    if (renderedValue) facts.push(`${label}${copy.separator}${renderedValue}`);
    if (facts.length === 4) break;
  }
  if (facts.length) lines.push(facts.map(fact => `- ${fact}`).join('\n'));
  lines.push(...lists);
  const url = link(output.targetUrl) || link(output.pageUrl);
  if (url) lines.push(`[${copy.viewDetails}](${url})`);
  return lines.join('\n\n');
}
