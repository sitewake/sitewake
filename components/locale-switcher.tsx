"use client";

import { useEffect, useRef, useState } from "react";
import { setLocale, type Locale } from "../lib/i18n";

// i18n-exempt: language names must always show in their own language — translated they become unrecognizable
const LABELS: Record<Locale, string> = { zh: "中文", en: "English" };
// English first: the console is offered to an international audience; Chinese follows.
const ORDER: Locale[] = ["en", "zh"];

/**
 * The language icon: a globe.
 *
 * It was switched to the "文 A" glyph (Google Translate's convention) and back. "文 A"
 * is semantically sharper — it clearly means "text", while a globe also reads as
 * "region", "public" or "site". But "文 A" marks the act of **translating** content into
 * another language; this control is a **language picker** that changes the UI's own
 * language and leaves content alone. Airbnb, Apple and Booking all use a globe.
 *
 * The two horizontal lines are latitudes, not an equator plus meridian: the meridian
 * version has three curves crossing at the center and blurs into a dot at 14px. With
 * the lines moved off center there is no crossing, and the outline stays clear small.
 *
 * Follows currentColor, so the dark sidebar, the light login gate and the widget's
 * white background share one drawing.
 */
function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M4.2 8.6h15.6M4.2 15.4h15.6" />
      <ellipse cx="12" cy="12" rx="4.1" ry="9" />
    </svg>
  );
}

/**
 * Language switch.
 *
 * A dropdown, not a toggle. A two-state toggle has to be labelled with either
 * the current language or the target one, and neither reads unambiguously: a
 * button saying "English" on a Chinese page could equally mean "you are in
 * English" or "switch to English". A dropdown has no such ambiguity — the
 * trigger states where you are, and the list is plainly a choice. It also
 * survives a third language, which a toggle does not.
 *
 * `locale` is a required prop, handed down by whoever server-rendered the page.
 * Deriving it here instead would break hydration: on the server there is no
 * `document` to read `<html lang>` from, so this component would render the
 * Chinese label into HTML that the browser then re-renders as English. Taking
 * it as a prop keeps both passes identical.
 *
 * Two surfaces, because language is a console-wide preference and the console
 * has two chromes that never appear together:
 *
 *   `rail` — the dark left rail, where every other console-wide control lives.
 *            It sits at the bottom, so its list opens upward.
 *   `card` — the access gate, which replaces the whole console for a visitor
 *            who has not signed in yet. Without a switch there, someone who
 *            cannot read the current language has no way to change it.
 *
 * Styles are scoped here rather than in globals.css so this owns its own
 * appearance in both chromes — including hover and the open state, which inline
 * styles cannot express — without reserving class names in a shared stylesheet.
 */
export function LocaleSwitcher({ locale, variant = "rail" }: {
  locale: Locale;
  variant?: "rail" | "card";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape. Both are what a dropdown is expected to
  // do; without them the panel strands itself open over the rest of the console.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function choose(next: Locale) {
    setOpen(false);
    // Picking the language already in use is a no-op, not a reload.
    if (next !== locale) setLocale(next);
  }

  return (
    <div className={`sw-locale sw-locale-${variant}`} ref={root}>
      <style>{SWITCHER_CSS}</style>
      <button
        type="button"
        className="sw-locale-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <i aria-hidden="true"><GlobeIcon /></i>
        <span>{LABELS[locale]}</span>
        <b aria-hidden="true" className={open ? "open" : ""}>
          ⌄
        </b>
      </button>
      {open && (
        <ul className="sw-locale-menu" role="listbox">
          {ORDER.map((item) => (
            <li key={item}>
              <button
                type="button"
                role="option"
                aria-selected={item === locale}
                className={item === locale ? "current" : ""}
                onClick={() => choose(item)}
              >
                <span>{LABELS[item]}</span>
                {/* i18n-exempt:纯图形勾选标记 */}
                {item === locale && <i aria-hidden="true">✓</i>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The rail variant deliberately borrows `.sw-nav button`'s shape — same radius,
 * same icon tile, same muted-to-white hover. It reads as one more rail control
 * rather than something pasted on top of one. Its menu opens upward because the
 * control sits at the bottom of a full-height rail.
 */
const SWITCHER_CSS = `
.sw-locale{position:relative}
.sw-locale-trigger{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:12px;font:inherit;font-size:13px;text-align:left;cursor:pointer;transition:color .12s,background .12s,border-color .12s}
.sw-locale-trigger > i{display:grid;place-items:center;width:27px;height:27px;border-radius:9px;flex:none}
.sw-locale-trigger > span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sw-locale-trigger > b{flex:none;font-weight:400;font-size:11px;line-height:1;transition:transform .14s}
.sw-locale-trigger > b.open{transform:rotate(180deg)}

.sw-locale-menu{position:absolute;z-index:40;display:flex;flex-direction:column;gap:2px;margin:0;padding:5px;border-radius:12px;list-style:none}
.sw-locale-menu button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:8px 10px;border:0;border-radius:9px;font:inherit;font-size:13px;text-align:left;cursor:pointer}
.sw-locale-menu button > i{font-style:normal;font-size:11px}

.sw-locale-rail .sw-locale-trigger{color:#a8a9b2;background:transparent}
.sw-locale-rail .sw-locale-trigger > i{background:#2e3039}
.sw-locale-rail .sw-locale-trigger:hover{color:#fff;background:#24252f}
.sw-locale-rail .sw-locale-trigger:focus-visible{outline:2px solid var(--sw-mint,#7ee6c1);outline-offset:2px}
.sw-locale-rail .sw-locale-menu{inset:auto 0 calc(100% + 6px) 0;border:1px solid #33353f;background:#1c1d25;box-shadow:0 14px 38px #05060a80}
.sw-locale-rail .sw-locale-menu button{color:#a8a9b2;background:transparent}
.sw-locale-rail .sw-locale-menu button:hover{color:#fff;background:#282a34}
.sw-locale-rail .sw-locale-menu button.current{color:#fff}
.sw-locale-rail .sw-locale-menu button:focus-visible{outline:2px solid var(--sw-mint,#7ee6c1);outline-offset:-2px}

.sw-locale-card .sw-locale-trigger{width:auto;padding:5px 9px 5px 7px;border:1px solid var(--sw-line,#dce5e0);color:var(--sw-muted,#64716b);background:var(--sw-white,#fff);font-size:12px}
.sw-locale-card .sw-locale-trigger > i{width:20px;height:20px;border-radius:7px;background:var(--sw-paper,#f2f6f3)}
.sw-locale-card .sw-locale-trigger:hover{border-color:var(--sw-mint,#7ee6c1);color:var(--sw-ink,#17201d)}
.sw-locale-card .sw-locale-trigger:focus-visible{outline:2px solid var(--sw-mint,#7ee6c1);outline-offset:2px}
.sw-locale-card .sw-locale-menu{inset:calc(100% + 6px) 0 auto auto;min-width:132px;border:1px solid var(--sw-line,#dce5e0);background:var(--sw-white,#fff);box-shadow:0 14px 34px #17201d1f}
.sw-locale-card .sw-locale-menu button{color:var(--sw-muted,#64716b);background:transparent;font-size:12px}
.sw-locale-card .sw-locale-menu button:hover{color:var(--sw-ink,#17201d);background:var(--sw-paper,#f2f6f3)}
.sw-locale-card .sw-locale-menu button.current{color:var(--sw-ink,#17201d)}
.sw-locale-card .sw-locale-menu button:focus-visible{outline:2px solid var(--sw-mint,#7ee6c1);outline-offset:-2px}
`;
