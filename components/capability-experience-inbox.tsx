"use client";
import { useState } from "react";
import { experienceIntakeLabel, type CapabilityExperienceIntake } from "../lib/capability-center-v2/experience-intake";
import { t } from "../lib/i18n";

export function CapabilityExperienceInbox({ siteId, items, expanded, onTask, onRetry, busy }: {
  siteId: string; items: CapabilityExperienceIntake[]; expanded: boolean;
  onTask(id: string): void; onRetry(id: string): void; busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pending = items.filter(item => item.status !== "completed");
  const copy = t().capability.v2.intake;
  const date = (value: string) => new Date(value).toLocaleString();
  if (!items.length) return null;
  return <section className="ccv2-intake" aria-label={copy.aria}>
    <div className="ccv2-intake-heading"><div><strong>{copy.fromExploration}</strong><p>{pending.length ? copy.pendingSummary(pending.length) : copy.savedSummary}</p></div><button className="secondary" aria-expanded={expanded || open} onClick={() => setOpen(!open)} disabled={expanded}>{expanded || open ? copy.showRecords : copy.showStatus}</button></div>
    {(expanded || open) && <div className="ccv2-intake-items">{items.map(item => <article key={item.id} data-testid="experience-intake" className="ccv2-intake-item">
      <div className="ccv2-intake-title"><strong>{item.goal}</strong><span className={`ccv2-badge ccv2-${item.status === "failed" ? "failed" : item.status === "completed" ? "succeeded" : "pending"}`}>{experienceIntakeLabel(item)}</span></div>
      <p className="ccv2-muted">{date(item.createdAt)}{item.attempts > 0 ? copy.attempts(item.attempts) : copy.received}{item.nextAttemptAt ? copy.nextRetry(date(item.nextAttemptAt)) : ""}</p>
      {item.status === "failed" && <p>{copy.stopped}</p>}
      {item.lastError && <details><summary>{copy.viewError}</summary><p className="ccv2-intake-error">{item.lastError}</p></details>}
      {item.reason && <p className="ccv2-muted">{item.reason}</p>}
      <div className="ccv2-actions"><a href={`/?site=${encodeURIComponent(siteId)}&view=sessions&run=${encodeURIComponent(item.runId)}`}>{copy.viewSession}</a>{item.taskId && <button className="secondary" onClick={() => onTask(item.taskId!)}>{copy.viewProgress}</button>}{["failed", "evidence-pending", "pending"].includes(item.status) && item.lastError && <button disabled={busy} onClick={() => onRetry(item.id)}>{copy.retry}</button>}</div>
    </article>)}{items.length === 100 && <p className="ccv2-muted">{copy.capped}</p>}</div>}
  </section>;
}
