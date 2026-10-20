"use client";

import { useCallback, useEffect, useState } from "react";
import { t } from "../../lib/i18n";

/**
 * Says, for as long as it is true, that this console has no password.
 *
 * It follows one fact — whether a password is configured — and nothing else.
 * Skipping the onboarding step stops that step from interrupting anybody; it
 * does not make the console protected, so it must not silence this. Keeping the
 * two on separate facts is what prevents the console from going quiet about a
 * door that is still open.
 *
 * There is deliberately no dismiss: an installation reachable by anyone is not
 * a preference to remember, and the one action that makes the notice go away is
 * the one that fixes it.
 */
export function AccessNotice() {
  const copy = t().settings.accessNotice;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const read = useCallback((signal?: AbortSignal) => fetch("/api/access", { cache: "no-store", signal })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error("unavailable"))))
    .then((value: { configured?: unknown; demoLock?: unknown }) => {
      if (signal?.aborted) return;
      // A read that fails says nothing either way, so it must not accuse a
      // protected console of being open. Only a definite `false` shows this.
      // A demo console is open on purpose and its password cannot be set from
      // here, so it has nothing to warn about.
      setConfigured(value.demoLock === true ? null : typeof value.configured === "boolean" ? value.configured : null);
    })
    .catch(() => { if (!signal?.aborted) setConfigured(null); }), []);

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [read]);

  async function submit() {
    if (password.length < 6) { setError(copy.tooShort); return; }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/access", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "setPassword", password }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) {
        setError(body.error === "password_too_short" ? copy.tooShort : copy.failed);
        return;
      }
      // The reply carries the session, so this browser stays in. The notice goes
      // because the fact it reports stopped being true.
      setPassword("");
      setOpen(false);
      setConfigured(true);
    } catch {
      setError(copy.failed);
    } finally {
      setBusy(false);
    }
  }

  if (configured !== false) return null;

  return (
    <aside className="sw-access-notice" data-access-notice="unprotected" role="status">
      <div>
        <strong>{copy.title}</strong>
        <p>{copy.body}</p>
      </div>
      {open ? (
        <div className="sw-access-notice-form">
          <input
            type="password"
            value={password}
            onChange={(event) => { setPassword(event.target.value); setError(""); }}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }}
            placeholder={copy.placeholder}
            aria-label={copy.action}
            aria-invalid={error ? true : undefined}
            autoComplete="new-password"
            disabled={busy}
          />
          <button type="button" className="sw-primary-button" disabled={busy} onClick={() => void submit()}>{copy.submit}</button>
          {error && <span className="sw-access-notice-error" role="alert">{error}</span>}
        </div>
      ) : (
        <button type="button" className="sw-secondary-button" onClick={() => setOpen(true)}>{copy.action}</button>
      )}
    </aside>
  );
}
