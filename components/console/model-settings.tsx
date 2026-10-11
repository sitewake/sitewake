"use client";

/**
 * The one model form: provider → key → model, verified with two real requests
 * before it can be saved. Mounted in onboarding step three and in Settings ·
 * Models; both read and write the same endpoints, so what one shows the other
 * shows too. The key never comes back from the server — only a mask.
 */

import { useEffect, useState } from "react";
import type { Locale } from "../../lib/i18n";
import { modelSettingsCopy } from "../../lib/console/model-settings-copy";

export type ModelSettingsView = {
  source: "env" | "console" | "missing";
  configured: boolean;
  baseUrl: string;
  model: string;
  executionModel: string;
  semanticModel: string;
  apiKeyMasked: string;
  providers: ReadonlyArray<{ id: string; baseUrl: string; families: readonly string[] }>;
};

type StageResult = { stage: string; ok: boolean; status: number; detail?: string };
type Verification =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; ok: boolean; hint?: string; message?: string; durationMs: number; results: StageResult[] };

const OTHER = "other";

function providerFor(baseUrl: string, providers: ModelSettingsView["providers"]) {
  const wanted = baseUrl.replace(/\/$/, "");
  return providers.find((provider) => provider.baseUrl.replace(/\/$/, "") === wanted)?.id || OTHER;
}

export function ModelSettingsForm({ locale, compact, onSaved }: {
  locale: Locale;
  /** Onboarding: no heading, the saved state is the caller's business. */
  compact?: boolean;
  onSaved?(view: ModelSettingsView): void;
}) {
  const copy = modelSettingsCopy(locale);
  const [view, setView] = useState<ModelSettingsView>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [providerId, setProviderId] = useState(OTHER);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [verification, setVerification] = useState<Verification>({ state: "idle" });
  const [fieldError, setFieldError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ tone: "ok" | "error"; text: string }>();

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/system/model", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("unavailable"))))
      .then((value: ModelSettingsView) => {
        if (controller.signal.aborted || !Array.isArray(value.providers)) throw new Error("unavailable");
        setView(value);
        setBaseUrl(value.baseUrl || value.providers[0]?.baseUrl || "");
        setProviderId(providerFor(value.baseUrl || value.providers[0]?.baseUrl || "", value.providers));
        setModel(value.model || "");
      })
      .catch(() => { if (!controller.signal.aborted) setLoadFailed(true); });
    return () => controller.abort();
  }, []);

  // Any edit invalidates the last verification: only a verified configuration is saved.
  function edit<T>(setter: (value: T) => void) {
    return (value: T) => { setter(value); setVerification({ state: "idle" }); setSaveMessage(undefined); setFieldError(""); };
  }
  const setProvider = edit((id: string) => {
    setProviderId(id);
    const provider = view?.providers.find((item) => item.id === id);
    if (provider) setBaseUrl(provider.baseUrl);
  });

  const payload = () => ({
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    model: model.trim(),
    executionModel: view?.executionModel || "",
    semanticModel: view?.semanticModel || "",
  });
  const canVerify = Boolean(view) && Boolean(model.trim()) && (Boolean(apiKey.trim()) || Boolean(view?.apiKeyMasked)) && verification.state !== "running" && !saving;
  const verified = verification.state === "done" && verification.ok;

  async function verify() {
    if (!canVerify) return;
    setVerification({ state: "running" });
    setSaveMessage(undefined);
    setFieldError("");
    try {
      const response = await fetch("/api/system/model/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; hint?: string; message?: string; durationMs?: number; results?: StageResult[] };
      if (response.status === 400 && body.error) { setFieldError(copy.invalid[body.error] || body.error); setVerification({ state: "idle" }); return; }
      if (!response.ok) throw new Error(body.error || "verify_failed");
      setVerification({ state: "done", ok: Boolean(body.ok), hint: body.hint, message: body.message, durationMs: body.durationMs || 0, results: Array.isArray(body.results) ? body.results : [] });
    } catch {
      setVerification({ state: "done", ok: false, hint: "retry", durationMs: 0, results: [] });
    }
  }

  async function save() {
    if (!verified || saving) return;
    setSaving(true);
    setSaveMessage(undefined);
    try {
      const response = await fetch("/api/system/model", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) });
      const body = (await response.json().catch(() => ({}))) as Partial<ModelSettingsView> & { error?: string };
      if (!response.ok) throw new Error(body.error || "save_failed");
      const next: ModelSettingsView = { ...(view as ModelSettingsView), ...body, providers: view?.providers || [] };
      setView(next);
      setApiKey("");
      setVerification({ state: "idle" });
      setSaveMessage({ tone: "ok", text: copy.saved });
      onSaved?.(next);
    } catch {
      setSaveMessage({ tone: "error", text: copy.saveFailed });
    } finally {
      setSaving(false);
    }
  }

  if (loadFailed) return <p className="sw-mng-msg error" role="alert">{copy.loadFailed}</p>;
  if (!view) return <p className="sw-mng-hint" role="status">{copy.loading}</p>;
  const provider = view.providers.find((item) => item.id === providerId);

  return (
    <form className="sw-mng sw-model-form" data-model-form onSubmit={(event) => { event.preventDefault(); void verify(); }}>
      {!compact && view.configured && (
        <div className="sw-mng-status"><b className="on">{copy.current(view.model, view.apiKeyMasked)}</b></div>
      )}
      {!view.configured && <p className="sw-mng-hint sw-model-form-intro">{copy.notConfigured}</p>}

      <label>
        <span className="sw-mng-label">{copy.provider}</span>
        <select className="sw-mng-field" value={providerId} onChange={(event) => setProvider(event.target.value)}>
          {view.providers.map((item) => <option key={item.id} value={item.id}>{copy.providerName(item.id)}</option>)}
          <option value={OTHER}>{copy.other}</option>
        </select>
        <span className="sw-mng-hint">{provider ? copy.families(provider.families.join(", ")) : copy.providerHint}</span>
      </label>

      {providerId === OTHER && (
        <label>
          <span className="sw-mng-label">{copy.baseUrl}</span>
          <input className="sw-mng-field" type="url" inputMode="url" placeholder={copy.baseUrlPlaceholder} value={baseUrl} onChange={(event) => edit(setBaseUrl)(event.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      )}

      <label>
        <span className="sw-mng-label">{copy.apiKey}</span>
        <input className="sw-mng-field" type="password" placeholder={view.apiKeyMasked ? copy.apiKeyKeep(view.apiKeyMasked) : copy.apiKeyPlaceholder} value={apiKey} onChange={(event) => edit(setApiKey)(event.target.value)} autoComplete="off" />
        <span className="sw-mng-hint">{copy.apiKeyServerOnly}</span>
      </label>

      <label>
        <span className="sw-mng-label">{copy.model}</span>
        <input className="sw-mng-field" type="text" placeholder={copy.modelPlaceholder} value={model} onChange={(event) => edit(setModel)(event.target.value)} autoComplete="off" spellCheck={false} />
      </label>

      {fieldError && <p className="sw-mng-msg error" role="alert">{fieldError}</p>}
      {verification.state === "done" && (
        <div className={`sw-mng-msg ${verification.ok ? "ok" : "error"}`} role={verification.ok ? "status" : "alert"} data-verification={verification.ok ? "ok" : "failed"}>
          <p>{verification.ok ? copy.verifiedIn(verification.durationMs) : (verification.hint && copy.hint[verification.hint]) || verification.message || copy.hint.retry}</p>
          {verification.results.length > 0 && (
            <ul className="sw-model-form-stages">
              {verification.results.map((stage) => (
                <li key={stage.stage} className={stage.ok ? "ok" : "failed"}>
                  {stage.ok ? "✓" : "✕"} {copy.stage[stage.stage] || stage.stage}
                  {!stage.ok && <small> · HTTP {stage.status || "—"}{stage.detail ? ` · ${stage.detail}` : ""}</small>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {saveMessage && <p className={`sw-mng-msg ${saveMessage.tone}`} role={saveMessage.tone === "ok" ? "status" : "alert"}>{saveMessage.text}</p>}

      <div className="sw-mng-row">
        <button type="submit" className="sw-mng-ghost" disabled={!canVerify}>{verification.state === "running" ? copy.verifying : copy.verify}</button>
        <button type="button" className="sw-mng-primary" disabled={!verified || saving} onClick={() => void save()}>{saving ? copy.saving : copy.save}</button>
      </div>
      <p className="sw-mng-hint">{verification.state === "idle" && view.configured && !verified && (apiKey || model !== view.model || baseUrl !== view.baseUrl) ? copy.changedSinceVerify : copy.verifyHint}</p>
    </form>
  );
}
