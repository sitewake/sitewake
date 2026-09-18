"use client";

import type { ReactNode } from "react";
import { t } from "@/lib/i18n";

/** First-run screen shown when no site has been connected yet. */
export function Welcome({ onCreate }: { onCreate(): void }) {
  const copy = t().shell.empty;
  return (
    <section className="sw-welcome">
      <img className="sw-welcome-mark" src="/brand/sitewake-mark.svg?v=wstar-1" alt="" aria-hidden="true" />
      <small>SITEWAKE</small>
      <h2>
        {copy.titleLine1}
        <br />
        {copy.titleLine2}
      </h2>
      <p>{copy.body}</p>
      <div>
        <button onClick={onCreate}>{copy.cta}</button>
      </div>
    </section>
  );
}

/**
 * Shown when the site list cannot be read. States that data is safe before
 * offering the retry, so a transient network error does not read as data loss.
 */
export function LoadFailure({ onRetry }: { onRetry(): void }) {
  const copy = t().shell.listFailed;
  return (
    <section className="sw-load-failure">
      <span>!</span>
      <h2>{copy.title}</h2>
      <p>{copy.body}</p>
      <button onClick={onRetry}>{copy.retry}</button>
    </section>
  );
}

export function PageHeading({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <header className="sw-page-heading">
      <div>
        <h2>{title}</h2>
        <p>{text}</p>
      </div>
      {action}
    </header>
  );
}

/** In-panel empty state for a section that has no data yet. */
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="sw-empty">
      <span>✦</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
