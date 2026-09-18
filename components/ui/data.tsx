"use client";

import { activeLocale, t } from "@/lib/i18n";

import { useState } from "react";

/**
 * Truncated identifier that stays inspectable.
 *
 * The console truncates actor keys, capability ids and content hashes to 8
 * characters with no way to see or copy the rest, which makes records hard to
 * correlate with logs. The full value is exposed via `title` and one click.
 */
export function TruncatedId({
  value,
  head = 8,
  label,
}: {
  value: string;
  head?: number;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const shortened = value.length > head ? value.slice(0, head) : value;

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard is unavailable over plain HTTP; `title` still shows the value.
    }
  }

  return (
    <button
      type="button"
      className="sa-truncated"
      title={copied ? t().common.copied : `${label ? `${label}：` : ""}${value}（${t().common.copyHint}）`}
      aria-label={`${label ? `${label} ` : ""}${value}，${copied ? t().common.copied : t().common.copyHint}`}
      onClick={() => void copy()}
    >
      <code>{shortened}</code>
      {value.length > head && <span aria-hidden="true">…</span>}
    </button>
  );
}

/** Thousands separators, so large counts stay readable at a glance. */
export function formatCount(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

/**
 * Absolute timestamp rendered as a relative phrase, with the exact value on
 * hover. "3 分钟前" answers "is this current?"; the tooltip answers "when
 * exactly?" — the console previously offered only one or the other.
 */
export function relativeTime(value?: string, now = Date.now()) {
  if (!value) return "";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((now - then) / 1000);
  const copy = t().time;
  if (seconds < 60) return copy.justNow;
  if (seconds < 3600) return copy.minutesAgo(Math.floor(seconds / 60));
  if (seconds < 86_400) return copy.hoursAgo(Math.floor(seconds / 3600));
  if (seconds < 2_592_000) return copy.daysAgo(Math.floor(seconds / 86_400));
  return new Date(value).toLocaleDateString(activeLocale());
}

export function Timestamp({ value }: { value?: string }) {
  if (!value) return null;
  return (
    <time dateTime={value} title={new Date(value).toLocaleString(activeLocale())}>
      {relativeTime(value)}
    </time>
  );
}
