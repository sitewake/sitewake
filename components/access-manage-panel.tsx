"use client";

import { useEffect, useState } from "react";
import { ConfirmDialog } from "./ui";
import { t, type ConsoleCopy, type Locale } from "@/lib/i18n";

type Status = { configured: boolean; enabled: boolean; updatedAt: string | null };

// Maps the server's error codes onto the shared copy catalog.
/**
 * Built inside the component, not at module level: a top-level `t()` evaluates at load,
 * before `<html lang>` is read, so the locale would always be the default. Every map
 * that follows the locale must be built at render time.
 */
function errorText(copy: ConsoleCopy["access"]): Record<string, string> {
  return {
    unauthorized: copy.unauthorized,
    password_too_short: copy.passwordTooShort,
    not_configured: copy.notConfigured,
    storage_unavailable: copy.storageUnavailable,
    unknown_action: copy.unknownAction,
  };
}

/**
 * `locale` is a required prop for the same reason the switcher takes one: this
 * renders on the server, where there is no `document` for `t()` to read
 * `<html lang>` from. Deriving it here would server-render Chinese and then
 * hydrate to the visitor's language — a mismatch, and a visible flash of the
 * wrong language across the whole page.
 */
export function AccessManagePanel({ locale, showLogout = false }: { locale: Locale; showLogout?: boolean }) {
  const access = t(locale).access;
  const copy = access.manage;
  const ERROR_TEXT = errorText(access);
  const [status, setStatus] = useState<Status | null>(null);
  const [adminKey, setAdminKey] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch("/api/access", { cache: "no-store" });
        const data = (await response.json()) as Status;
        if (active) setStatus(data);
      } catch {
        if (active) setStatus(null);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function manage(action: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/access", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, password: newPassword, currentPassword, adminKey }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; status?: Status };
      if (response.ok && data.ok) {
        setStatus(data.status ?? null);
        setNewPassword("");
        setMessage({ tone: "ok", text: action === "setPassword" ? copy.passwordUpdated : copy.policyUpdated });
        if (action === "setPassword" || action === "revokeSessions") setMessage({ tone: "ok", text: copy.sessionsRevoked });
      } else {
        setMessage({ tone: "error", text: ERROR_TEXT[data.error ?? ""] ?? copy.actionFailed });
      }
    } catch {
      setMessage({ tone: "error", text: copy.networkError });
    } finally {
      setBusy(false);
      setConfirmingRevoke(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await fetch("/api/access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "logout" }) });
      window.location.reload();
    } catch {
      setBusy(false);
    }
  }

  const statusText = !status
    ? copy.statusLoading
    : !status.configured
      ? copy.statusUnset
      : status.enabled
        ? copy.statusEnabled
        : copy.statusConfiguredDisabled;

  return (
    <div className="sw-mng">
      <div className="sw-mng-status">
        <span>{copy.statusPrefix}</span>
        <b className={status?.enabled ? "on" : undefined}>{statusText}</b>
      </div>

      <div>
        <span className="sw-mng-label">{copy.authLabel}</span>
        <div className="sw-mng-fields">
          <input className="sw-mng-field" type="password" placeholder={copy.adminKeyPlaceholder} value={adminKey} onChange={(event) => setAdminKey(event.target.value)} autoComplete="off" />
          <input className="sw-mng-field" type="password" placeholder={copy.currentPasswordPlaceholder} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="off" />
        </div>
        <p className="sw-mng-hint">
          {copy.authHint}
        </p>
      </div>

      <div>
        <span className="sw-mng-label">{copy.setPasswordLabel}</span>
        <div className="sw-mng-row">
          <input className="sw-mng-field sw-mng-grow" type="password" placeholder={copy.newPasswordPlaceholder} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" />
          <button className="sw-mng-primary" disabled={busy} onClick={() => manage("setPassword")}>{copy.savePassword}</button>
        </div>
      </div>

      <div className="sw-mng-row">
        <button className="sw-mng-ghost" disabled={busy || !status?.configured} onClick={() => manage("enable")}>{copy.enable}</button>
        <button className="sw-mng-ghost" disabled={busy} onClick={() => manage("disable")}>{copy.disable}</button>
        <button className="sw-mng-ghost" disabled={busy || !status?.configured} onClick={() => setConfirmingRevoke(true)}>{copy.revokeSessions}</button>
        {showLogout ? <button className="sw-mng-ghost" disabled={busy} onClick={() => void logout()}>{copy.logout}</button> : null}
      </div>

      <ConfirmDialog
        open={confirmingRevoke}
        title={t(locale).confirm.revokeSessions.title}
        body={
          <>
            <p>{t(locale).confirm.revokeSessions.consequence}</p>
            <p>{t(locale).confirm.revokeSessions.reversibility}</p>
          </>
        }
        confirmLabel={t(locale).confirm.revokeSessions.confirmLabel}
        busy={busy}
        onConfirm={() => void manage("revokeSessions")}
        onCancel={() => setConfirmingRevoke(false)}
      />

      {message ? (
        <p className={`sw-mng-msg ${message.tone}`}>{message.text}</p>
      ) : null}
    </div>
  );
}
