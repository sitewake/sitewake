import { en } from "./en";
import { zh } from "./zh";
import type { ConsoleCopy } from "./zh";

import { localizedValue, type Locale, type LocalizedStrings } from "./locale";
export type { Locale, LocalizedStrings };
export { localizedValue };
export type { ConsoleCopy };

const CATALOGS: Record<Locale, ConsoleCopy> = { zh, en };

/**
 * English is the fallback. It only decides for a visitor whose browser asks
 * for neither Chinese nor English (and has saved no choice); an international
 * product answers that visitor in English. Both catalogs are complete —
 * `ConsoleCopy` makes `tsc` fail on any missing key — so completeness no
 * longer picks the default.
 */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Where the chosen locale is remembered.
 *
 * A cookie, not localStorage — deliberately. The console is server-rendered, so
 * the server has to know the language *before* it emits any HTML; localStorage
 * is unreadable there and would leave the first paint in the wrong language
 * until JavaScript corrected it. A cookie travels with the request, so the very
 * first byte is already right.
 */
export const LOCALE_COOKIE_NAME = "sitewake_locale";
/** A year: this is a preference, not a session. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en";
}

/** The first supported language in an ordered list of BCP-47 tags. */
function firstSupported(tags: readonly string[]): Locale | undefined {
  for (const tag of tags) {
    const base = String(tag).toLowerCase().trim().split(/[-_;]/)[0];
    if (base === "zh" || base === "en") return base;
  }
  return undefined;
}

/**
 * Parse an `Accept-Language` header, honouring its quality weights.
 *
 * `zh;q=0.8, en;q=0.9` means English is preferred even though Chinese is
 * written first — reading the header in document order would get that backwards.
 */
export function localeFromAcceptLanguage(header?: string | null): Locale | undefined {
  if (!header) return undefined;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const quality = params
        .map((param) => /^\s*q=([0-9.]+)\s*$/i.exec(param))
        .find(Boolean);
      return { tag, quality: quality ? Number(quality[1]) : 1 };
    })
    .filter((entry) => entry.tag && Number.isFinite(entry.quality))
    .sort((left, right) => right.quality - left.quality);
  return firstSupported(ranked.map((entry) => entry.tag));
}

/**
 * The locale the server should render in.
 *
 * Order: the visitor's own saved choice, then what their browser asks for, then
 * Chinese. An explicit choice outranks the browser because it is the newer and
 * more specific signal — someone who switched to English on a Chinese-locale
 * machine meant it.
 */
export function resolveServerLocale(input: {
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  return localeFromAcceptLanguage(input.acceptLanguage) ?? DEFAULT_LOCALE;
}

/**
 * The locale this document is rendered in, read off `<html lang>`.
 *
 * `<html lang>` is the single source of truth on purpose. The server writes it
 * from the cookie and `Accept-Language`; the client reads back the exact same
 * value, so server output and hydration can never disagree about the language.
 * Reading the cookie or `navigator.languages` here instead would reintroduce
 * precisely that mismatch.
 */
export function activeLocale(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const declared = document.documentElement.lang.toLowerCase().split("-")[0];
  return isLocale(declared) ? declared : DEFAULT_LOCALE;
}

/**
 * Remember a choice and re-render the console in it.
 *
 * A full reload rather than a re-render: copy is read from plain functions and
 * non-component modules as well as JSX (see `t` below), so there is no render
 * tree to invalidate. The reload is also what makes the server-rendered half —
 * metadata, `<html lang>` — switch with it.
 */
export function setLocale(locale: Locale) {
  if (typeof document === "undefined") return;
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
  window.location.reload();
}

/** Returns the copy catalog for a locale. */
export function copy(locale: Locale = DEFAULT_LOCALE): ConsoleCopy {
  return CATALOGS[locale] || CATALOGS[DEFAULT_LOCALE];
}

/**
 * The catalog for the active locale.
 *
 * Deliberately a plain function rather than a React context: console copy is
 * read from helper functions and non-component modules as well as JSX, and a
 * context would not reach those. Calling it with no argument resolves the
 * locale this document is rendered in, which is why every existing `t()` call
 * site started following the visitor's language without being touched.
 */
export function t(locale?: Locale): ConsoleCopy {
  return copy(locale ?? activeLocale());
}

export { zh, en };
