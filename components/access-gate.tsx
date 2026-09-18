"use client";

import { useState } from "react";
import { AccessManagePanel } from "./access-manage-panel";
import { LocaleSwitcher } from "./locale-switcher";
import { t, type Locale } from "../lib/i18n";

/**
 * `locale` comes from the layout, which resolved it server-side. This is the
 * first screen an unauthenticated visitor sees, so it is also the first place
 * someone who cannot read the current language needs to be able to change it.
 */
export function AccessGate({ locale }: { locale: Locale }) {
  const copy = t(locale).access.gate;
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showManage, setShowManage] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "login", password }),
      });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (response.ok && data.ok) {
        window.location.reload();
        return;
      }
      setError(data.error === "invalid_password" ? copy.wrongPassword : copy.signInFailed);
    } catch {
      setError(copy.networkError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="sw-auth">
      {/* 作用域样式：globals.css 此刻有未提交改动，这一条规则只服务这张卡，
          放在这里避免与之抢同一个文件。 */}
      <style>{".sw-auth-top{display:flex;align-items:center;justify-content:space-between;gap:14px}"}</style>
      <div className="sw-auth-card">
        <div className="sw-auth-top">
          <div className="sw-auth-brand">
            <img src="/brand/sitewake-mark.svg?v=wstar-1" alt="" aria-hidden="true" />
            <span>SiteWake</span>
          </div>
          <LocaleSwitcher locale={locale} variant="card" />
        </div>
        <h1>{copy.title}</h1>
        <p>{copy.subtitle}</p>

        <form onSubmit={submit} className="sw-auth-form">
          <input
            className="sw-auth-input"
            type="password"
            placeholder={copy.passwordPlaceholder}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoFocus
            autoComplete="current-password"
          />
          <button className="sw-auth-submit" type="submit" disabled={busy}>
            {busy ? copy.submitting : copy.submit}
          </button>
        </form>

        {error ? <p className="sw-auth-error">{error}</p> : null}

        <button className="sw-auth-toggle" onClick={() => setShowManage((value) => !value)}>
          {showManage ? copy.hideManage : copy.showManage}
        </button>

        {showManage ? (
          <div className="sw-auth-manage">
            <AccessManagePanel locale={locale} />
          </div>
        ) : null}
      </div>
    </main>
  );
}
