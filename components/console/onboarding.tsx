"use client";

/**
 * The standalone onboarding flow: create site → connect site → start preview.
 *
 * It deliberately does not reuse the console shell — the console is not entered until
 * onboarding completes; users should not face a UI that looks built but has nothing
 * connected. So no sidebar, no tabs, just a three-step rail.
 *
 * The verdict rules live in `lib/console/connection-detection.ts`: success only counts
 * a handshake the server received within this window; this file feeds in the facts and
 * draws the conclusion.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t, type Locale } from "../../lib/i18n";
import { LocaleSwitcher } from "../locale-switcher";
import type { SiteAgentSummary } from "../../lib/site-knowledge/protocol";
import type { OverviewResponse } from "../../lib/console/route";
import { INSTALL_STACKS, installGuide, type InstallStack } from "../../lib/console/install-guide";
import { onboardingPrompt } from "../../lib/console/onboarding-prompt";
import {
  detectionState,
  shouldAwaitHandshake,
  unownedInstallIds,
  type DetectionState,
} from "../../lib/console/connection-detection";

export type OnboardingKind = "first" | "new-site";
type Step = 0 | 1 | 2;

/** Poll interval during detection. Tighter than the console's usual 15 s because the user is watching. */
const DETECT_POLL_MS = 2_000;

function normalizedUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function originOf(raw: string): string | undefined {
  const normalized = normalizedUrl(raw);
  if (!normalized) return undefined;
  try { return new URL(normalized).origin; } catch { return undefined; }
}

function siteOrigin(site: SiteAgentSummary): string | undefined {
  const source = site.profile.entryUrl || site.connection?.origin || site.connection?.url;
  return source ? originOf(source) : undefined;
}

function bare(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function OnboardingFlow({
  locale,
  kind,
  siteId,
  sites,
  adoptedFrom,
  onCreated,
  onAdopted,
  onEnterConsole,
  onOpenSite,
  onGoToConsole,
}: {
  locale: Locale;
  kind: OnboardingKind;
  siteId: string;
  sites: SiteAgentSummary[];
  /** This site just adopted the id found on the page; the value is the replaced old id. Announce after mount and re-detect. */
  adoptedFrom?: string;
  onCreated(siteAgentId: string): void;
  /** Adoption succeeded: the flow switches to the new id (the component is keyed by siteId and remounts). */
  onAdopted(siteAgentId: string, replacedSiteAgentId: string): void;
  onEnterConsole(siteAgentId: string): void;
  onOpenSite(siteAgentId: string): void;
  onGoToConsole(siteAgentId: string): void;
}) {
  // Dictionary first: the useMemo/useCallback callbacks below run synchronously during
  // render; declaring `copy` after them hits the temporal dead zone and blanks the page
  // (see tests/i18n-tdz.test.mjs).
  const copy = t(locale).shell.onboarding;

  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState("");
  const [duplicate, setDuplicate] = useState<SiteAgentSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const createInFlight = useRef(false);

  const [installMethod, setInstallMethod] = useState<"ai" | "manual">("ai");
  const [installStack, setInstallStack] = useState<InstallStack>("html");
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const [copiedCsp, setCopiedCsp] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [troubleshootOpen, setTroubleshootOpen] = useState(false);

  const [overview, setOverview] = useState<OverviewResponse>();
  const [detectWindow, setDetectWindow] = useState<{ startedAt: string; jobId: string } | null>(null);
  const [awaitingHandshake, setAwaitingHandshake] = useState(false);
  const [detectRequestError, setDetectRequestError] = useState("");
  const detectInFlight = useRef(false);
  const [entered, setEntered] = useState(false);
  /** Adopt the id on the page: auto-tried once per detection window; failure falls back to an explicit hint. */
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState("");
  const adoptAttemptedFor = useRef("");
  const autoDetectedAfterAdoption = useRef(false);

  const site = sites.find((item) => item.id === siteId);
  /** Any connected site, to give "go to console" a real destination. */
  const connectedSite = sites.find((item) => item.connection);
  const connected = Boolean(overview?.connection || site?.connection);
  /**
   * The server-registered address. A site only touched by id, never handshaken, has
   * none (placeholder record), yet the address determines allowedOrigins and every line
   * of the prompt — without it step two can only show an empty prompt and the handshake
   * gets 403. So the address is attached to this id before connecting.
   */
  const boundUrl = site?.profile.entryUrl || site?.connection?.origin || "";
  const needsUrl = Boolean(siteId && site && !boundUrl && !connected);
  const step: Step = !siteId || needsUrl ? 0 : entered || connected ? 2 : 1;

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const siteUrl = boundUrl || normalizedUrl(urlInput) || "";
  const guide = useMemo(
    () => (siteId && origin ? installGuide(origin, siteId, installStack) : undefined),
    [origin, siteId, installStack],
  );
  const prompt = useMemo(
    () => (siteId && origin && siteUrl ? onboardingPrompt({ locale, siteUrl, siteAgentId: siteId, consoleOrigin: origin }) : ""),
    [locale, origin, siteId, siteUrl],
  );

  /** Detection verdict. None until a detection was started. */
  const verdict: DetectionState | undefined = useMemo(() => {
    if (!detectWindow || !siteId) return undefined;
    const job = overview?.sitePreviewJob;
    return detectionState({
      siteAgentId: siteId,
      windowStartedAt: detectWindow.startedAt,
      lastSeenAt: overview?.connection?.lastSeenAt,
      job: awaitingHandshake || !job || job.id !== detectWindow.jobId
        ? undefined
        : { status: job.status, createdAt: job.createdAt, ...(job.error ? { error: job.error } : {}) },
      preview: overview?.sitePreview,
      now: new Date().toISOString(),
    });
  }, [awaitingHandshake, detectWindow, overview, siteId]);

  const loadOverview = useCallback(async () => {
    if (!siteId) return;
    const response = await fetch(`/api/site-agents/${encodeURIComponent(siteId)}`, { cache: "no-store" });
    if (!response.ok) return;
    const next = (await response.json()) as OverviewResponse;
    if (next.id === siteId) setOverview(next);
  }, [siteId]);

  // Step two keeps reading the overview: tighter while detecting, but always, so the "wait for handshake" path completes on its own.
  useEffect(() => {
    if (!siteId || step !== 1) return;
    void loadOverview().catch(() => undefined);
    const polling = Boolean(detectWindow);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadOverview().catch(() => undefined);
    }, polling ? DETECT_POLL_MS : 15_000);
    return () => clearInterval(timer);
  }, [detectWindow, loadOverview, siteId, step]);

  // If detection cannot run, fall back to waiting for a handshake: no longer expecting the server to open the page, same window rule.
  useEffect(() => {
    if (verdict && shouldAwaitHandshake(verdict)) setAwaitingHandshake(true);
  }, [verdict]);

  // Handshake arrived → step three, no second click needed.
  useEffect(() => {
    if (verdict?.kind === "connected") setEntered(true);
  }, [verdict]);

  // Expand troubleshooting when no connection is detected — it is exactly what the user wants now.
  useEffect(() => {
    if (verdict?.kind === "not-detected") setTroubleshootOpen(true);
  }, [verdict]);

  async function copyText(value: string, mark: (done: boolean) => void) {
    setCopyError("");
    try {
      await navigator.clipboard.writeText(value);
      mark(true);
    } catch {
      mark(false);
      setCopyError(copy.install.copyFailed);
    }
  }

  async function submitCreate() {
    if (createInFlight.current) return;
    setCreateError("");
    setDuplicate(null);
    const normalized = normalizedUrl(urlInput);
    if (!normalized) { setUrlError(copy.create.invalidUrl); return; }
    setUrlError("");
    // Same-origin precheck: the backend silently rewrites an existing site on an id
    // collision, and the flow must never run into that. Filling a placeholder's address
    // is not a collision with itself.
    const wanted = originOf(normalized);
    const clash = sites.find((item) => wanted && item.id !== (needsUrl ? siteId : "") && siteOrigin(item) === wanted);
    if (clash) { setDuplicate(clash); return; }
    createInFlight.current = true;
    setCreating(true);
    try {
      // With an id this registers the address on an existing site (the backend merges entryUrl / allowedOrigins by id).
      const response = await fetch("/api/site-agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(needsUrl ? { id: siteId, url: normalized } : { url: normalized }),
      });
      if (!response.ok) throw new Error("create_failed");
      const created = (await response.json()) as { siteAgentId: string };
      onCreated(created.siteAgentId);
    } catch {
      setCreateError(copy.create.createFailed);
    } finally {
      createInFlight.current = false;
      setCreating(false);
    }
  }

  async function detect() {
    if (!siteId || detectInFlight.current) return;
    detectInFlight.current = true;
    setDetectRequestError("");
    setAwaitingHandshake(false);
    setTroubleshootOpen(false);
    try {
      const response = await fetch(`/api/site-agents/${encodeURIComponent(siteId)}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error("detect_failed");
      const payload = (await response.json()) as { job: { id: string; createdAt: string } };
      setDetectWindow({ startedAt: payload.job.createdAt, jobId: payload.job.id });
      setOverview(undefined);
      void loadOverview().catch(() => undefined);
    } catch {
      setDetectRequestError(copy.unavailable.jobFailed);
      // Failing to dispatch an evidence job must not block the user: fall back to waiting for a handshake, window starting now.
      setDetectWindow({ startedAt: new Date().toISOString(), jobId: "" });
      setAwaitingHandshake(true);
    } finally {
      detectInFlight.current = false;
    }
  }

  const detecting = Boolean(detectWindow) && verdict?.kind === "in-progress" && !awaitingHandshake;
  const stepNames = [copy.steps.create, copy.steps.install, copy.steps.preview];

  /** Foreign ids on the page with no site anymore; exactly one enables auto-adoption. */
  const unowned = useMemo(() => unownedInstallIds(verdict, sites), [verdict, sites]);
  /** Adoption is open only to empty sites: no connection, knowledge still initial. The server still checks its own records. */
  const siteIsFresh = Boolean(overview) && !overview?.connection && overview?.activeRelease.version === 0;

  const adopt = useCallback(async (installId: string) => {
    if (!siteId || adopting) return;
    setAdopting(true);
    setAdoptError("");
    try {
      const response = await fetch(`/api/site-agents/${encodeURIComponent(siteId)}/install-id/adopt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ siteAgentId: installId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { siteAgentId?: string; error?: string };
      if (!response.ok || !payload.siteAgentId) throw new Error(payload.error || "adopt_failed");
      onAdopted(payload.siteAgentId, siteId);
    } catch (error) {
      setAdoptError(copy.adopt.failed(error instanceof Error ? error.message : "adopt_failed"));
      setAdopting(false);
    }
  }, [adopting, copy.adopt, onAdopted, siteId]);

  // The typical delete-and-re-add shape: the page's id points nowhere and this site is still empty — adopt it, no code change needed.
  useEffect(() => {
    if (!detectWindow || unowned.length !== 1 || !siteIsFresh) return;
    const key = `${detectWindow.startedAt}:${unowned[0]}`;
    if (adoptAttemptedFor.current === key) return;
    adoptAttemptedFor.current = key;
    void adopt(unowned[0]);
  }, [adopt, detectWindow, siteIsFresh, unowned]);

  // Just adopted, remounted under the new id: the page's SDK can handshake now, so detect again.
  useEffect(() => {
    if (!adoptedFrom || step !== 1 || autoDetectedAfterAdoption.current) return;
    autoDetectedAfterAdoption.current = true;
    void detect();
    // detect is a component-local function whose identity changes per render; run once after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adoptedFrom, step]);

  return (
    <main className="sw-onboarding" data-onboarding-flow={kind}>
      <aside className="sw-onboarding-rail" aria-label={copy.steps.create}>
        <div className="sw-onboarding-brand">
          <img src="/brand/sitewake-mark.svg?v=wstar-1" alt="" aria-hidden="true" />
          <b>SiteWake</b>
        </div>
        <ol className="sw-onboarding-steps">
          {stepNames.map((name, index) => {
            const state = index < step ? "done" : index === step ? "current" : "upcoming";
            return (
              <li key={name} className={`is-${state}`} aria-current={state === "current" ? "step" : undefined}>
                <span className="sw-onboarding-step-mark" aria-hidden="true">{state === "done" ? "✓" : index + 1}</span>
                <span className="sw-onboarding-step-name">{name}</span>
                <span className="sw-visually-hidden">{copy.stepState[state]}</span>
              </li>
            );
          })}
        </ol>
        <div className="sw-onboarding-rail-footer">
          {/*
            退路。只在已经有连上的网站时出现——一个都没有的时候控制台里什么也没有，
            推导会立刻把人送回流程，那就成了一个点了没反应的按钮。
          */}
          {connectedSite && (
            <button type="button" className="sw-onboarding-exit" onClick={() => onGoToConsole(connectedSite.id)}>
              {copy.goToConsole}
            </button>
          )}
          {/* 语言是控制台级偏好，接入流程也得能换——看不懂当前语言的人正是最需要它的人。 */}
          <LocaleSwitcher locale={locale} variant="rail" />
        </div>
      </aside>

      <section className="sw-onboarding-main">
        <div className="sw-onboarding-environment"><span className="sw-status is-good">{copy.environmentBadge}</span></div>

        {step === 0 && (
          <div className="sw-onboarding-content">
            <p className="sw-onboarding-kicker">{needsUrl ? copy.create.kickerBind : kind === "new-site" ? copy.create.kickerNewSite : copy.create.kicker}</p>
            <h1>{needsUrl ? copy.create.titleBind : kind === "new-site" ? copy.create.titleNewSite : copy.create.title}</h1>
            <p className="sw-onboarding-lead">{needsUrl ? copy.create.descriptionBind(siteId) : kind === "new-site" ? copy.create.descriptionNewSite : copy.create.description}</p>
            <section className="sw-onboarding-panel">
              <label className="sw-onboarding-field">
                <span>{copy.create.urlLabel}</span>
                <input
                  value={urlInput}
                  onChange={(event) => { setUrlInput(event.target.value); setUrlError(""); setDuplicate(null); }}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitCreate(); } }}
                  placeholder="https://example.com"
                  aria-label={copy.create.urlLabel}
                  aria-invalid={urlError ? true : undefined}
                  autoFocus
                />
              </label>
              <div className="sw-onboarding-field-row">
                <small>{copy.create.urlHint}</small>
                {normalizedUrl(urlInput) && (
                  <a className="sw-onboarding-ghost" href={normalizedUrl(urlInput)} target="_blank" rel="noopener noreferrer">
                    {copy.create.openSite} ↗
                  </a>
                )}
              </div>
              {originOf(urlInput) && <p className="sw-onboarding-note">{copy.create.originNote(originOf(urlInput)!)}</p>}
              {urlError && <p className="sw-onboarding-error" role="alert">{urlError}</p>}
              {createError && <p className="sw-onboarding-error" role="alert">{createError}</p>}
              {duplicate && (
                <div className="sw-onboarding-alert" role="alert">
                  <strong>{copy.create.duplicateTitle}</strong>
                  <p>{copy.create.duplicateBody(duplicate.profile.name)}</p>
                  <div className="sw-onboarding-actions">
                    <button type="button" onClick={() => onOpenSite(duplicate.id)}>
                      {duplicate.connection ? copy.create.duplicateOpen : copy.create.duplicateResume}
                    </button>
                  </div>
                </div>
              )}
              <button type="button" className="sw-onboarding-primary" disabled={creating} onClick={() => void submitCreate()}>
                {creating ? copy.create.submitting : needsUrl ? copy.create.submitBind : copy.create.submit}
              </button>
            </section>
          </div>
        )}

        {step === 1 && (
          <div className="sw-onboarding-content">
            {kind === "new-site" && site && (
              <div className="sw-onboarding-context">
                <strong>{copy.install.contextLabel}：{site.profile.name}</strong>
                <span>{bare(siteUrl)}</span>
                <span>{copy.install.contextNewSite}</span>
              </div>
            )}
            <p className="sw-onboarding-kicker">{copy.install.kicker}</p>
            <h1>{installMethod === "ai" ? copy.install.aiTitle : copy.install.manualTitle}</h1>
            <p className="sw-onboarding-lead">{installMethod === "ai" ? copy.install.aiDescription : copy.install.manualDescription}</p>

            <div className="sw-onboarding-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={installMethod === "ai"} className={installMethod === "ai" ? "is-active" : ""} onClick={() => setInstallMethod("ai")}>{copy.install.tabAi}</button>
              <button type="button" role="tab" aria-selected={installMethod === "manual"} className={installMethod === "manual" ? "is-active" : ""} onClick={() => setInstallMethod("manual")}>{copy.install.tabManual}</button>
            </div>

            <section className="sw-onboarding-panel">
              {installMethod === "ai" ? (
                <div className="sw-onboarding-flow-steps">
                  <div className={`sw-onboarding-stage ${copiedPrompt ? "is-done" : "is-current"}`}>
                    <span className="sw-onboarding-mark" aria-hidden="true">{copiedPrompt ? "✓" : ""}</span>
                    <div>
                      <strong>{copy.install.aiStepOpen}</strong>
                      <small>{copy.install.aiStepOpenHint(bare(siteUrl))}</small>
                      <pre className="sw-onboarding-prompt"><code>{prompt}</code></pre>
                      {copiedPrompt && (
                        <p className="sw-onboarding-success"><strong>{copy.install.promptCopied}</strong> {copy.install.promptCopiedHint}</p>
                      )}
                      <button type="button" className={copiedPrompt ? "" : "sw-onboarding-primary"} disabled={!prompt} onClick={() => void copyText(prompt, setCopiedPrompt)}>
                        {copiedPrompt ? copy.install.recopyPrompt : copy.install.copyPrompt}
                      </button>
                    </div>
                  </div>
                  <div className={`sw-onboarding-stage ${copiedPrompt ? "is-current" : "is-waiting"}`}>
                    <span className="sw-onboarding-mark" aria-hidden="true" />
                    <div>
                      <strong>{copy.install.aiStepDetect}</strong>
                      <small>{copy.install.aiStepDetectHint(bare(siteUrl))}</small>
                      <button type="button" className="sw-onboarding-primary" disabled={!copiedPrompt || detecting} onClick={() => void detect()}>
                        {detecting ? copy.detect.running : copy.detect.action}
                      </button>
                      {!copiedPrompt && (
                        <button type="button" className="sw-onboarding-link" onClick={() => void detect()}>{copy.install.alreadyInstalled}</button>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="sw-onboarding-tabs sw-onboarding-stacks" role="tablist">
                    {INSTALL_STACKS.map((stack) => (
                      <button
                        key={stack}
                        type="button"
                        role="tab"
                        aria-selected={installStack === stack}
                        className={installStack === stack ? "is-active" : ""}
                        onClick={() => { setInstallStack(stack); setCopiedInstall(false); }}
                      >
                        {copy.stacks[stack].label}
                      </button>
                    ))}
                  </div>
                  <ol className="sw-onboarding-install-steps">
                    <li>
                      <span className="sw-onboarding-mark" aria-hidden="true" />
                      <div>
                        <strong>{copy.install.manualStepFile}</strong>
                        <small>{copy.stacks[installStack].place}</small>
                      </div>
                    </li>
                    <li>
                      <span className="sw-onboarding-mark" aria-hidden="true" />
                      <div>
                        <strong>{copy.install.manualStepCode}</strong>
                        <pre className="sw-onboarding-code"><code>{guide?.plain || ""}</code></pre>
                        <small>{copy.install.manualStepCodeHint}</small>
                      </div>
                    </li>
                    <li>
                      <span className="sw-onboarding-mark" aria-hidden="true" />
                      <div>
                        <strong>{copy.install.manualStepRun}</strong>
                        <small>{copy.install.manualStepRunHint(bare(siteUrl))}</small>
                      </div>
                    </li>
                  </ol>
                  <div className="sw-onboarding-actions">
                    <button type="button" className={copiedInstall ? "" : "sw-onboarding-primary"} onClick={() => void copyText(guide?.plain || "", setCopiedInstall)}>
                      {copiedInstall ? copy.install.codeCopied : copy.install.copyCode}
                    </button>
                    <button type="button" className={copiedInstall ? "sw-onboarding-primary" : ""} disabled={!copiedInstall || detecting} onClick={() => void detect()}>
                      {detecting ? copy.detect.running : copy.detect.action}
                    </button>
                  </div>
                </>
              )}

              {copyError && <p className="sw-onboarding-error" role="alert">{copyError}</p>}
              {detecting && <p className="sw-onboarding-note" role="status">{copy.detect.runningHint}</p>}

              {verdict?.kind === "not-detected" && verdict.reason !== "foreign-install" && (
                <div className="sw-onboarding-notice" role="status">
                  <strong>{copy.notDetected.title}</strong>
                  <p>{verdict.reason === "script-missing" ? copy.notDetected.scriptMissing : copy.notDetected.scriptNotConnecting}</p>
                  <button type="button" onClick={() => void detect()}>{copy.detect.retry}</button>
                </div>
              )}
              {adoptedFrom && (
                <p className="sw-onboarding-note sw-onboarding-adopted" role="status">{copy.adopt.adopted(siteId, adoptedFrom)}</p>
              )}
              {verdict?.kind === "not-detected" && verdict.reason === "foreign-install" && unowned.length === 0 && (
                <div className="sw-onboarding-alert" role="alert">
                  <strong>{copy.foreign.title}</strong>
                  <p>{copy.foreign.body((verdict.foreignSiteAgentIds || []).join("、"))}</p>
                  <p>{copy.foreign.hint}</p>
                  <button type="button" onClick={() => void detect()}>{copy.detect.retry}</button>
                </div>
              )}
              {verdict?.kind === "not-detected" && verdict.reason === "foreign-install" && unowned.length > 0 && adopting && (
                <p className="sw-onboarding-note" role="status">{copy.adopt.adopting(unowned[0])}</p>
              )}
              {/* 无主标识但没能自动沿用（当前网站不空、多个无主、或接口拒绝）：说清楚两条路。 */}
              {verdict?.kind === "not-detected" && verdict.reason === "foreign-install" && unowned.length > 0 && !adopting && (unowned.length > 1 || !siteIsFresh || adoptError) && (
                <div className="sw-onboarding-alert" role="alert">
                  <strong>{copy.adopt.unownedTitle}</strong>
                  <p>{copy.adopt.unownedBody(unowned.join("、"), siteId)}</p>
                  {adoptError && <p>{adoptError}</p>}
                  <div className="sw-onboarding-actions">
                    {unowned.length === 1 && <button type="button" className="sw-onboarding-primary" onClick={() => void adopt(unowned[0])}>{copy.adopt.action(unowned[0])}</button>}
                    <button type="button" onClick={() => void detect()}>{copy.detect.retry}</button>
                  </div>
                </div>
              )}
              {awaitingHandshake && (
                <div className="sw-onboarding-notice" role="status">
                  <strong>{copy.unavailable.awaitTitle}</strong>
                  <p>
                    {detectRequestError || (verdict?.kind === "unavailable" && verdict.reason === "never-leased"
                      ? copy.unavailable.neverLeased
                      : copy.unavailable.jobFailed)}
                    {" "}
                    {copy.unavailable.privateNetworkHint}
                  </p>
                  <p>{copy.unavailable.awaitBody(bare(siteUrl))}</p>
                  <p className="sw-onboarding-note">{copy.unavailable.awaiting}</p>
                  <div className="sw-onboarding-actions">
                    {siteUrl && <a className="sw-onboarding-ghost" href={siteUrl} target="_blank" rel="noopener noreferrer">{copy.create.openSite} ↗</a>}
                    <button type="button" onClick={() => void detect()}>{copy.detect.retry}</button>
                  </div>
                </div>
              )}

              <button type="button" className="sw-onboarding-link" aria-expanded={troubleshootOpen} onClick={() => setTroubleshootOpen((open) => !open)}>
                {copy.troubleshoot.toggle}
              </button>
              {troubleshootOpen && (
                <div className="sw-onboarding-troubleshoot">
                  <div>
                    <strong>{copy.troubleshoot.scriptTitle}</strong>
                    <p>{copy.troubleshoot.scriptBody}</p>
                  </div>
                  <div>
                    <strong>{copy.troubleshoot.cspTitle}</strong>
                    <p>{copy.troubleshoot.cspBody(origin)}</p>
                    <button type="button" onClick={() => void copyText(`script-src 'self' ${origin}; connect-src 'self' ${origin};`, setCopiedCsp)}>
                      {copiedCsp ? copy.install.codeCopied : copy.troubleshoot.copyCsp}
                    </button>
                  </div>
                  <div>
                    <strong>{copy.troubleshoot.originTitle}</strong>
                    <p>{copy.troubleshoot.originBody(siteUrl ? originOf(siteUrl) || siteUrl : "")}</p>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {step === 2 && (
          <div className="sw-onboarding-content">
            <p className="sw-onboarding-kicker">{copy.ready.kicker}</p>
            <section className="sw-onboarding-panel sw-onboarding-success-panel">
              <span className="sw-onboarding-success-mark" aria-hidden="true">✓</span>
              <h1>{copy.ready.title}</h1>
              <p className="sw-onboarding-lead">{copy.ready.description}</p>
              {/* 首次握手已经替用户排了一次网站知识读取（见 /connection 路由）。这里只告知，不轮询：
                  第三步的职责是确认连上了，进度有专门的页面。 */}
              <p className="sw-onboarding-note sw-onboarding-crawl-started">{copy.ready.crawlStarted}</p>
              {/* 不再挂「已连接」标签：一个大对勾加上「接入成功」已经把这件事说完了。 */}
              <div className="sw-onboarding-success-url">{bare(siteUrl)}</div>
              <div className="sw-onboarding-actions">
                {siteUrl && <a className="sw-onboarding-ghost" href={siteUrl} target="_blank" rel="noopener noreferrer">{copy.ready.openSite} ↗</a>}
                <button type="button" className="sw-onboarding-primary" onClick={() => onEnterConsole(siteId)}>{copy.ready.enterConsole}</button>
              </div>
            </section>
          </div>
        )}
      </section>
    </main>
  );
}
