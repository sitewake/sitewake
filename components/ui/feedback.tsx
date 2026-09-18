"use client";

import { t } from "@/lib/i18n";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";

/** Announced loading indicator. `role="status"` is what makes it audible. */
export function Spinner({ label = t().common.loading }: { label?: string }) {
  return (
    <p className="sa-spinner" role="status" aria-live="polite">
      <span className="sa-spinner__dot" aria-hidden="true" />
      {label}
    </p>
  );
}

/**
 * First-run and no-data state.
 *
 * Every list in the console needs one of these: an empty console is the
 * product's actual first impression, not an edge case.
 */
export function EmptyState({
  title,
  text,
  action,
}: {
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="sa-empty">
      <b>{title}</b>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

/** Failure state with a retry affordance, so a failed view is never a blank box. */
export function ErrorState({
  title = t().state.loadFailedTitle,
  message,
  onRetry,
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="sa-error-block" role="alert">
      <b>{title}</b>
      {message && <p>{message}</p>}
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {t().common.retry}
        </Button>
      )}
    </div>
  );
}

export type ToastTone = "ok" | "danger" | "info";
export type ToastMessage = { id: number; tone: ToastTone; text: string };

/**
 * Transient feedback for completed actions.
 *
 * Replaces the ad-hoc `message` state divs each view kept, which appeared in
 * different places with different styling and never auto-dismissed.
 */
export function useToasts(timeoutMs = 4000) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const sequence = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (text: string, tone: ToastTone = "ok") => {
      sequence.current += 1;
      const id = sequence.current;
      setToasts((current) => [...current, { id, tone, text }]);
      timers.current.push(setTimeout(() => dismiss(id), timeoutMs));
      return id;
    },
    [dismiss, timeoutMs],
  );

  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
  }, []);

  return { toasts, push, dismiss };
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastMessage[];
  onDismiss: (id: number) => void;
}) {
  if (!toasts.length) return null;
  return (
    // `aria-live` on the container, not each toast, so additions are announced
    // without re-reading the whole stack.
    <div className="sa-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`sa-toast sa-toast--${toast.tone}`}>
          <span>{toast.text}</span>
          <Button variant="ghost" size="sm" aria-label={t().common.closeHint} onClick={() => onDismiss(toast.id)}>
            ×
          </Button>
        </div>
      ))}
    </div>
  );
}
