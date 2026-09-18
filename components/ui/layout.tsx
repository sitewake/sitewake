"use client";

import { useId, useRef, type ReactNode } from "react";
import { useArrowNavigation } from "./behavior";

export function Card({
  title,
  eyebrow,
  actions,
  children,
}: {
  title?: ReactNode;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sa-card">
      {(title || eyebrow || actions) && (
        <header className="sa-card__head">
          <div>
            {eyebrow && <span className="sa-eyebrow">{eyebrow}</span>}
            {title && <h3>{title}</h3>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="sa-stat-card" title={hint}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="sa-stat-grid">{children}</div>;
}

export type TabItem = { id: string; label: string; hint?: string };

/**
 * Accessible tablist. Arrow keys move between tabs, which the console's
 * hand-rolled nav did not support.
 */
export function Tabs({
  items,
  active,
  onChange,
  label,
}: {
  items: TabItem[];
  active: string;
  onChange: (id: string) => void;
  label: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  useArrowNavigation(list);
  return (
    <div ref={list} className="sa-tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          role="tab"
          type="button"
          aria-selected={item.id === active}
          // Only the active tab is in the tab order; arrows move within the list.
          tabIndex={item.id === active ? 0 : -1}
          title={item.hint}
          className={item.id === active ? "is-active" : undefined}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Label + hint + error wrapper, so form rows are consistent and associated. */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : "", error ? errorId : ""].filter(Boolean).join(" ");
  return (
    <div className={`sa-field${error ? " has-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children({
        id,
        "aria-describedby": describedBy || undefined,
        "aria-invalid": error ? true : undefined,
      })}
      {hint && !error && (
        <p id={hintId} className="sa-field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="sa-field__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
