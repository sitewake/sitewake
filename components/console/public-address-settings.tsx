"use client";

import { useCallback, useEffect, useState } from "react";
import type { Locale } from "../../lib/i18n";
import { publicAddressCopy } from "../../lib/console/public-address-copy";

/**
 * The address visitors load SiteWake from.
 *
 * Saving asks the address itself whether this control plane is behind it, and
 * the attempt is made twice: here in the administrator's browser, and on the
 * server. A server reaching its own public hostname often fails on NAT
 * hairpinning while every visitor succeeds, so the browser's attempt is the one
 * that matches the question — and it is sent along as evidence.
 */

export type PublicAddressView = {
  origin: string;
  source: "console" | "env" | "none";
  installationId: string;
  usableForPublicSites: boolean;
  /** Which rule the address falls foul of, when it cannot serve public sites. */
  unusable?: "insecure" | "local" | "malformed" | "unset";
};

type Failure = { reason: string; detail?: string; resolved?: string[]; expected?: string[] };

export function PublicAddressSettings({ locale, onSaved }: { locale: Locale; onSaved?(view: PublicAddressView): void }) {
  const copy = publicAddressCopy(locale);
  const [view, setView] = useState<PublicAddressView>();
  const [value, setValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/system/public-address", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as PublicAddressView;
      setView(body);
      setValue((previous) => previous || (body.source === "console" ? body.origin : ""));
    } catch {
      // The setting is not reachable right now; the section simply stays empty
      // rather than blocking the rest of the settings page.
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** What this browser sees at that address — the evidence the server cannot always gather itself. */
  async function browserProbe(origin: string) {
    try {
      const response = await fetch(`${origin}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
      const body = (await response.json().catch(() => ({}))) as { installationId?: string };
      if (!body.installationId) return { ok: false as const, error: `no installation id (status ${response.status})` };
      return { ok: true as const, installationId: body.installationId };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? `${error.name}: ${error.message}` : "unknown" };
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (checking) return;
    setChecking(true);
    setFailure(undefined);
    setSaved(false);
    try {
      const origin = value.trim().replace(/\/$/, "");
      const probe = /^https?:\/\//i.test(origin) ? await browserProbe(origin) : undefined;
      const response = await fetch("/api/system/public-address", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ origin, browserProbe: probe }),
      });
      const body = (await response.json()) as PublicAddressView & Failure & { error?: string };
      if (!response.ok) {
        setFailure({ reason: body.reason || "save", detail: body.detail, resolved: body.resolved, expected: body.expected });
        return;
      }
      setView(body);
      setSaved(true);
      onSaved?.(body);
    } catch {
      setFailure({ reason: "save" });
    } finally {
      setChecking(false);
    }
  }

  const online = Boolean(view?.usableForPublicSites);
  return (
    <div className="sw-public-address">
      <p className="sw-setting-note">{copy.hint}</p>
      {typeof window !== "undefined" && <p className="sw-setting-note">{copy.manageNote(window.location.origin)}</p>}

      <dl className="sw-settings-rows">
        <div>
          <dt>{copy.currentLabel}</dt>
          <dd>
            {view?.origin ? <code>{view.origin}</code> : "—"}
            <small>
              {" "}
              ({view?.source === "console" ? copy.sourceConsole : view?.source === "env" ? copy.sourceEnv : copy.sourceNone})
            </small>
          </dd>
        </div>
        <div>
          <dt>{online ? copy.modeOnline : copy.modeLocal}</dt>
          <dd>{online ? copy.modeOnlineHint : copy.modeLocalHint}</dd>
        </div>
      </dl>

      <form className="sw-public-address-form" onSubmit={submit}>
        <label htmlFor="sw-public-address-input">{copy.inputLabel}</label>
        <input
          id="sw-public-address-input"
          type="text"
          inputMode="url"
          spellCheck={false}
          placeholder={copy.placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className="sw-primary-button" disabled={checking || !value.trim()}>
          {checking ? copy.checking : copy.submit}
        </button>
      </form>

      {saved && <p className="sw-setting-note" role="status">{copy.saved}</p>}
      {failure && <p className="sw-error" role="alert">{failureText(copy, failure)}</p>}

      {!online && (
        <details className="sw-public-address-guide" open>
          <summary>{copy.guideTitle}</summary>
          <p className="sw-setting-note">{copy.guideLead}</p>
          <pre>{copy.guideSelfHosted(view?.origin ? hostOf(view.origin) : "").join("\n")}</pre>
          <pre>{copy.guideCloud.join("\n")}</pre>
          <p className="sw-setting-note">{copy.guideLater}</p>
        </details>
      )}
    </div>
  );
}

/** The failing step, named. Anything unrecognised falls back to the save message. */
function failureText(copy: ReturnType<typeof publicAddressCopy>, failure: Failure) {
  switch (failure.reason) {
    case "insecure": return copy.failures.insecure(failure.detail || "");
    case "local": return copy.failures.local(failure.detail || "");
    case "malformed": return copy.failures.malformed;
    case "dns": return copy.failures.dns(failure.resolved || [], failure.expected || []);
    case "tls": return copy.failures.tls(failure.detail || "");
    case "unreachable": return copy.failures.unreachable(failure.detail || "");
    case "other-installation": return copy.failures.otherInstallation;
    default: return copy.failures.save;
  }
}

/** The installer's guess is an address on this machine; its host is the IP to point DNS at. */
function hostOf(origin: string) {
  try { return new URL(origin).hostname; } catch { return ""; }
}
