"use client";

/**
 * The standalone onboarding flow: create site → connect site → connect a model → confirm.
 *
 * It deliberately does not reuse the console shell — the console is not entered until
 * onboarding completes; users should not face a UI that looks built but has nothing
 * connected. So no sidebar, no tabs, just a four-step rail.
 *
 * The verdict rules live in `lib/console/connection-detection.ts`: success only counts
 * a handshake the server received within this window; this file feeds in the facts and
 * draws the conclusion.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t, type Locale } from "../../lib/i18n";
import { LocaleSwitcher } from "../locale-switcher";
import { ModelSettingsForm, type ModelSettingsView } from "./model-settings";
import type { SiteAgentSummary } from "../../lib/site-knowledge/protocol";
import type { OverviewResponse } from "../../lib/console/route";
import { INSTALL_STACKS, installGuide, type InstallStack } from "../../lib/console/install-guide";
import { conditionsBlocked, installConditions, type InstallCondition } from "../../lib/console/install-conditions";
import type { PolicyVerdict } from "../../lib/console/policy-findings";
import { snippetOrigin, usePublicAddress } from "./public-address-banner";
import type { InstallReadiness } from "../../lib/console/install-readiness";
import { onboardingPrompt } from "../../lib/console/onboarding-prompt";
import {
  detectionState,
  installIdOffer,
  shouldAwaitHandshake,
  type DetectionState,
} from "../../lib/console/connection-detection";

export type OnboardingKind = "first" | "new-site";
/**
 * Where the person is. "model" exists only while no model is connected: the
 * model is installation-wide, so the first site asks for it and later sites
 * (or a fresh install whose .env already has one) go straight to the check.
 */
type Phase = "password" | "create" | "install" | "model" | "preview";

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

async function writeClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Denied or unavailable: fall through to the legacy command.
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, value.length);
    const done = document.execCommand("copy");
    area.remove();
    return done;
  } catch {
    return false;
  }
}

function selectText(element: HTMLElement | null | undefined) {
  if (!element) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
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
  const promptRef = useRef<HTMLPreElement>(null);
  const codeRef = useRef<HTMLPreElement>(null);

  const [installMethod, setInstallMethod] = useState<"ai" | "manual">("ai");
  const [installStack, setInstallStack] = useState<InstallStack>("html");
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const [copiedCsp, setCopiedCsp] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [troubleshootOpen, setTroubleshootOpen] = useState(false);
  /** The three checks are collapsed while they all pass; a failure opens them. */
  const [conditionsOpen, setConditionsOpen] = useState(false);

  const [overview, setOverview] = useState<OverviewResponse>();
  const [detectWindow, setDetectWindow] = useState<{ startedAt: string; jobId: string } | null>(null);
  const [awaitingHandshake, setAwaitingHandshake] = useState(false);
  const [detectRequestError, setDetectRequestError] = useState("");
  const detectInFlight = useRef(false);
  const [entered, setEntered] = useState(false);
  /** Back on step one to change the address of the site already created (a typo, the wrong site). */
  const [editingUrl, setEditingUrl] = useState(false);
  /**
   * Whether a model is connected, installation-wide. Read once at mount; `undefined`
   * while loading, `null` when the read failed. Only a definite "not configured" adds
   * the model step — a failed read never blocks the flow.
   */
  const [modelStatus, setModelStatus] = useState<Pick<ModelSettingsView, "configured" | "source"> | null>();
  const [modelDone, setModelDone] = useState(false);
  /**
   * Whether this installation has a console password, and whether somebody
   * already chose to go without one. Read once at mount, same shape as the model
   * read above: `undefined` while loading, `null` when the read failed. A failed
   * read must not invent a step, so only a definite "no password, not skipped"
   * adds it.
   */
  const [access, setAccess] = useState<{ configured: boolean; onboardingSkipped: boolean } | null>();
  const [passwordDone, setPasswordDone] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
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
  const modelKnown = modelStatus !== undefined;
  // Once the step has been part of this session it stays in the rail as done.
  const hasModelStep = modelDone || (modelKnown && modelStatus !== null && !modelStatus.configured);
  /**
   * The password step exists only while there is something to do: no password,
   * and nobody has said to go without one. An installation that already has a
   * password never sees it, the same way the model step disappears once a model
   * is connected — the rail carries what is left, not a history of ticks.
   *
   * `passwordDone` keeps it in the rail for the rest of the session after it is
   * set, so the step the user just completed does not vanish under them.
   */
  const accessKnown = access !== undefined;
  const hasPasswordStep = passwordDone
    || (accessKnown && access !== null && !access.configured && !access.onboardingSkipped);
  const phase: Phase = hasPasswordStep && !passwordDone ? "password"
    : !siteId || needsUrl || editingUrl ? "create"
    : !(entered || connected) ? "install"
    : hasModelStep && !modelDone ? "model"
    : "preview";
  const phases: Phase[] = [
    ...(hasPasswordStep ? ["password" as const] : []),
    "create" as const,
    "install" as const,
    ...(hasModelStep ? ["model" as const] : []),
    "preview" as const,
  ];
  const step = phases.indexOf(phase);

  /**
   * Set the first password. The reply carries the session cookie, so nothing
   * here has to log in afterwards — and the password never leaves this function.
   *
   * The length is checked here as well as on the server: the point is to tell
   * the person what is wrong without a round trip, not to be the only guard.
   */
  async function submitPassword() {
    const password = passwordInput;
    if (password.length < 6) { setPasswordError(copy.password.tooShort); return; }
    setPasswordBusy(true);
    setPasswordError("");
    try {
      const response = await fetch("/api/access", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "setPassword", password }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || !body.ok) {
        setPasswordError(body.error === "password_too_short" ? copy.password.tooShort : copy.password.failed);
        return;
      }
      setPasswordInput("");
      setAccess({ configured: true, onboardingSkipped: false });
      setPasswordDone(true);
    } catch {
      setPasswordError(copy.password.failed);
    } finally {
      setPasswordBusy(false);
    }
  }

  /**
   * Go on without a password. Recorded on the server so the question is not
   * asked again from another machine; the console keeps saying it is open.
   */
  async function skipPassword() {
    setPasswordBusy(true);
    setPasswordError("");
    try {
      await fetch("/api/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "skipOnboarding" }),
      }).catch(() => undefined);
    } finally {
      // Move on either way: a failed write means the step is offered again next
      // time, which is the harmless direction, and blocking here would make
      // "skip" the one thing in this flow that can refuse to work.
      setAccess({ configured: false, onboardingSkipped: true });
      setPasswordDone(false);
      setPasswordBusy(false);
    }
  }

  // The snippet carries the address visitors load SiteWake from, which is a
  // setting — never the address this administrator happens to be using, which
  // may be localhost or a LAN IP no visitor can reach.
  const { address: publicAddress } = usePublicAddress();
  const browserOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const origin = snippetOrigin(publicAddress, browserOrigin);
  const siteUrl = boundUrl || normalizedUrl(urlInput) || "";
  const guide = useMemo(
    () => (siteId && origin ? installGuide(origin, siteId, installStack) : undefined),
    [origin, siteId, installStack],
  );
  // What a browser on that site will actually do with this console: the server
  // loads the site once and reads what a page cannot read about another origin
  // (its policy, its redirects, its certificate).
  const [readiness, setReadiness] = useState<InstallReadiness | undefined>(undefined);
  // What a browser did with the install, when one has tried it; and where the
  // site's policy is configured, when the response proved it.
  const [policy, setPolicy] = useState<PolicyVerdict | { source: "unknown" } | undefined>(undefined);
  const [platform, setPlatform] = useState<string | undefined>(undefined);
  // What the last browser run proves about the address itself, which its shape
  // cannot: a configured address that simply does not answer.
  const [rehearsal, setRehearsal] = useState<{ ran: boolean; snippetPresent: boolean; connected: boolean } | undefined>(undefined);
  const [readinessRound, setReadinessRound] = useState(0);
  // Bumped when a rehearsal has produced a measurement; it re-reads readiness
  // without asking for another rehearsal.
  const [measureRound, setMeasureRound] = useState(0);
  const rehearsalFor = useRef("");
  const readinessFor = useRef("");
  useEffect(() => {
    if (!siteId || !siteUrl || phase !== "install") return;
    const site = `${siteId}|${siteUrl}`;
    const key = `${site}|${readinessRound}|${measureRound}`;
    if (readinessFor.current === key) return;
    // Another round on the same site keeps the previous answer on screen until
    // the new one arrives; a different site starts from nothing.
    const sameSite = readinessFor.current.startsWith(`${site}|`);
    readinessFor.current = key;
    if (!sameSite) setReadiness(undefined);
    void (async () => {
      try {
        const response = await fetch(`/api/site-agents/${encodeURIComponent(siteId)}/install-readiness?url=${encodeURIComponent(siteUrl)}`);
        if (!response.ok) return;
        const body = (await response.json()) as {
          readiness?: InstallReadiness;
          policy?: PolicyVerdict | { source: "unknown" };
          platform?: string;
          sdkOrigin?: string;
          rehearsal?: { ran: boolean; snippetPresent: boolean; connected: boolean };
        };
        if (readinessFor.current !== key) return;
        if (body.readiness) setReadiness(body.readiness);
        setPolicy(body.policy);
        setPlatform(body.platform);
        setRehearsal(body.rehearsal);
      } catch {
        // The check is an aid, never a gate: a console that cannot reach the
        // site still hands out the snippet.
      }
    })();
  }, [phase, siteId, siteUrl, readinessRound, measureRound]);
  /**
   * Have a browser try the install on the reader's website before they paste
   * anything. Only when no measurement exists yet and the site is not already
   * connected — a connected site is rendered live, and that render answers the
   * same question about what is refused.
   */
  useEffect(() => {
    if (phase !== "install" || !siteId || !guide?.plain || connected) return;
    if (!policy || policy.source === "measured") return;
    const key = `${siteId}|${siteUrl}|${readinessRound}`;
    if (rehearsalFor.current === key) return;
    rehearsalFor.current = key;
    let cancelled = false;
    void (async () => {
      try {
        const started = await fetch(`/api/site-agents/${encodeURIComponent(siteId)}/preview`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "try-install", installSnippet: guide.plain }),
        });
        if (!started.ok) return;
        const { job } = (await started.json()) as { job?: { id: string } };
        for (let attempt = 0; attempt < 30 && !cancelled; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          const state = await fetch(`/api/site-agents/${encodeURIComponent(siteId)}/preview`, { cache: "no-store" })
            .then((response) => (response.ok ? response.json() : undefined))
            .catch(() => undefined) as { job?: { id: string; status: string } } | undefined;
          if (!state?.job || (job?.id && state.job.id !== job.id)) continue;
          if (state.job.status === "succeeded" || state.job.status === "failed") {
            if (!cancelled) setMeasureRound((round) => round + 1);
            return;
          }
        }
      } catch {
        // A rehearsal that cannot be started leaves the inferred answer in
        // place, which is labelled as inferred.
      }
    })();
    return () => { cancelled = true; };
  }, [phase, siteId, siteUrl, guide, policy, connected, readinessRound]);

  // The three things that decide whether this install can work, in the order
  // a reader settles them. Both ends local is development, and reports none.
  const conditions = useMemo(
    () => (siteUrl && origin
      ? installConditions({
        siteUrl,
        sdkOrigin: origin,
        addressUsable: publicAddress ? publicAddress.usableForPublicSites : true,
        addressUnusable: publicAddress?.unusable,
        readiness,
        policy,
        platform,
        rehearsal,
      })
      : []),
    [siteUrl, origin, publicAddress, readiness, policy, platform, rehearsal],
  );
  const blocked = conditionsBlocked(conditions);
  const prompt = useMemo(
    () => (siteId && origin && siteUrl ? onboardingPrompt({ locale, siteUrl, siteAgentId: siteId, consoleOrigin: origin, conditions }) : ""),
    [locale, origin, siteId, siteUrl, conditions],
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
        : { status: job.status, createdAt: job.createdAt, ...(job.error ? { error: job.error } : {}), ...(job.mode ? { mode: job.mode } : {}) },
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
    if (!siteId || phase !== "install") return;
    void loadOverview().catch(() => undefined);
    const polling = Boolean(detectWindow);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadOverview().catch(() => undefined);
    }, polling ? DETECT_POLL_MS : 15_000);
    return () => clearInterval(timer);
  }, [detectWindow, loadOverview, siteId, phase]);

  // If detection cannot run, fall back to waiting for a handshake: no longer expecting the server to open the page, same window rule.
  useEffect(() => {
    if (verdict && shouldAwaitHandshake(verdict)) setAwaitingHandshake(true);
  }, [verdict]);

  // Handshake arrived → step three, no second click needed.
  useEffect(() => {
    if (verdict?.kind === "connected") setEntered(true);
  }, [verdict]);

  // Whether this console has a password decides whether the flow opens with that
  // step, so it is read up front for the same reason the model status is.
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/access", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("unavailable"))))
      .then((value: { configured?: unknown; onboardingSkipped?: unknown }) => {
        if (controller.signal.aborted) return;
        setAccess(typeof value.configured === "boolean"
          ? { configured: value.configured, onboardingSkipped: value.onboardingSkipped === true }
          : null);
      })
      .catch(() => { if (!controller.signal.aborted) setAccess(null); });
    return () => controller.abort();
  }, []);

  // Whether a model is already in place (from .env or an earlier save) decides the shape of the flow, so read it up front.
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/system/model", { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("unavailable"))))
      .then((value: ModelSettingsView) => {
        if (controller.signal.aborted) return;
        setModelStatus(typeof value.configured === "boolean" ? { configured: value.configured, source: value.source } : null);
      })
      .catch(() => { if (!controller.signal.aborted) setModelStatus(null); });
    return () => controller.abort();
  }, []);

  // Expand troubleshooting when no connection is detected — it is exactly what the user wants now.
  useEffect(() => {
    if (verdict?.kind === "not-detected") setTroubleshootOpen(true);
  }, [verdict]);

  // The async clipboard API exists only in secure contexts; a console reached
  // over plain HTTP by IP (the usual first install on a cloud VM) has none, so
  // the legacy copy command is the second route. When both refuse, the text is
  // selected for the user so that one keystroke finishes the copy.
  // The patched policy is the one thing on this card a reader has to
  // reproduce exactly, so it is copied rather than retyped.
  const policyCopy = {
    copied: copiedCsp,
    onCopy: (value: string) => void copyText(value, setCopiedCsp),
  };

  async function copyText(value: string, mark: (done: boolean) => void, source?: HTMLElement | null) {
    setCopyError("");
    if (await writeClipboard(value)) {
      mark(true);
      return;
    }
    mark(false);
    selectText(source);
    setCopyError(copy.install.copyFailed);
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
    const ownSite = needsUrl || editingUrl ? siteId : "";
    const clash = sites.find((item) => wanted && item.id !== ownSite && siteOrigin(item) === wanted);
    if (clash) { setDuplicate(clash); return; }
    createInFlight.current = true;
    setCreating(true);
    try {
      // With an id this registers the address on an existing site (the backend merges entryUrl /
      // allowedOrigins by id). A changed address also renames the site the way a fresh create would.
      const body = editingUrl
        ? { id: siteId, url: normalized, name: new URL(normalized).hostname.replace(/^www\./, "") }
        : needsUrl ? { id: siteId, url: normalized } : { url: normalized };
      const response = await fetch("/api/site-agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      // Retrying never fixes an origin/session refusal, so say what to do instead.
      if (response.status === 401 || response.status === 403) {
        setCreateError(copy.create.createUnauthorized);
        return;
      }
      if (!response.ok) throw new Error("create_failed");
      const created = (await response.json()) as { siteAgentId: string };
      setEditingUrl(false);
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
    // The reader pressed check because they changed the website: measure it
    // again, so a policy or an address that is now fine stops being reported.
    setReadinessRound((round) => round + 1);
    try {
      const response = await fetch(`/api/site-agents/${encodeURIComponent(siteId)}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error("detect_failed");
      const payload = (await response.json()) as { job: { id: string; createdAt: string } };
      setDetectWindow({ startedAt: payload.job.createdAt, jobId: payload.job.id });
      // The overview is not dropped: this round is decided by its own job id,
      // so nothing stale can answer for it, and keeping what is on screen
      // spares the reader a full panel flash on every check.
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
  const stepNames = phases.map((item) => copy.steps[item]);

  /**
   * What to do about an id on the page that has no site: adopt it silently,
   * ask which one, or say the page has to change. One decision, so the flow
   * never offers a repair the server would refuse.
   */
  const offer = useMemo(() => installIdOffer(verdict, sites, overview), [overview, sites, verdict]);

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
    if (!detectWindow || offer.kind !== "adopt") return;
    const key = `${detectWindow.startedAt}:${offer.installId}`;
    if (adoptAttemptedFor.current === key) return;
    adoptAttemptedFor.current = key;
    void adopt(offer.installId);
  }, [adopt, detectWindow, offer]);

  // Just adopted, remounted under the new id: the page's SDK can handshake now, so detect again.
  useEffect(() => {
    if (!adoptedFrom || phase !== "install" || autoDetectedAfterAdoption.current) return;
    autoDetectedAfterAdoption.current = true;
    void detect();
    // detect is a component-local function whose identity changes per render; run once after mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adoptedFrom, phase]);

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
            // The one way back: from step two, step one is clickable to change a mistyped
            // address on the same site (same id, same snippet). Nothing else in the rail navigates.
            const returnable = state === "done" && phases[index] === "create" && phase === "install";
            const body = (
              <>
                <span className="sw-onboarding-step-mark" aria-hidden="true">{state === "done" ? "✓" : index + 1}</span>
                <span className="sw-onboarding-step-name">{name}</span>
                <span className="sw-visually-hidden">{copy.stepState[state]}</span>
              </>
            );
            return (
              <li key={name} className={`is-${state}${returnable ? " is-returnable" : ""}`} aria-current={state === "current" ? "step" : undefined}>
                {returnable
                  ? <button type="button" className="sw-onboarding-step-return" title={copy.install.changeUrl} onClick={() => { setUrlInput(siteUrl); setUrlError(""); setDuplicate(null); setCreateError(""); setEditingUrl(true); }}>{body}</button>
                  : body}
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

        {phase === "password" && (
          <div className="sw-onboarding-content" data-onboarding-password="set">
            <h1>{copy.password.title}</h1>
            <p className="sw-onboarding-lead">{copy.password.body}</p>
            <section className="sw-onboarding-panel">
              <label className="sw-onboarding-field">
                <span>{copy.steps.password}</span>
                <input
                  type="password"
                  value={passwordInput}
                  onChange={(event) => { setPasswordInput(event.target.value); setPasswordError(""); }}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitPassword(); } }}
                  placeholder={copy.password.placeholder}
                  aria-label={copy.steps.password}
                  aria-invalid={passwordError ? true : undefined}
                  autoComplete="new-password"
                  disabled={passwordBusy}
                />
              </label>
              {passwordError && <p className="sw-onboarding-error" role="alert">{passwordError}</p>}
              <div className="sw-onboarding-actions">
                {/* The flow has its own button family (`.sw-onboarding-panel button`
                    plus `.sw-onboarding-primary`); the console shell's is a
                    different size, weight and hover. Using the shell's here made
                    this step the only one that reacted differently to a pointer. */}
                <button type="button" className="sw-onboarding-primary" disabled={passwordBusy} onClick={() => void submitPassword()}>
                  {copy.password.submit}
                </button>
                <button type="button" disabled={passwordBusy} onClick={() => void skipPassword()}>
                  {copy.password.skip}
                </button>
              </div>
              <p className="sw-onboarding-note">{copy.password.skipHint}</p>
            </section>
          </div>
        )}

        {phase === "create" && (
          <div className="sw-onboarding-content" data-onboarding-create={editingUrl ? "change" : undefined}>
            <p className="sw-onboarding-kicker">{editingUrl ? copy.create.kickerChange : needsUrl ? copy.create.kickerBind : kind === "new-site" ? copy.create.kickerNewSite : copy.create.kicker}</p>
            <h1>{editingUrl ? copy.create.titleChange : needsUrl ? copy.create.titleBind : kind === "new-site" ? copy.create.titleNewSite : copy.create.title}</h1>
            <p className="sw-onboarding-lead">{editingUrl ? copy.create.descriptionChange : needsUrl ? copy.create.descriptionBind(siteId) : kind === "new-site" ? copy.create.descriptionNewSite : copy.create.description}</p>
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
              <div className="sw-onboarding-actions">
                <button type="button" className="sw-onboarding-primary" disabled={creating} onClick={() => void submitCreate()}>
                  {creating ? copy.create.submitting : editingUrl ? copy.create.submitChange : needsUrl ? copy.create.submitBind : copy.create.submit}
                </button>
                {editingUrl && (
                  <button type="button" disabled={creating} onClick={() => { setEditingUrl(false); setUrlError(""); setDuplicate(null); setCreateError(""); }}>
                    {copy.create.cancelChange}
                  </button>
                )}
              </div>
            </section>
          </div>
        )}

        {phase === "install" && (
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
            <p className="sw-onboarding-lead">{installMethod === "ai" ? copy.install.aiDescription(bare(siteUrl)) : copy.install.manualDescription(bare(siteUrl))}</p>

            {conditions.length > 0 && (
              <section
                className={`sw-install-conditions${blocked ? " is-blocked" : " is-ready"}`}
                data-install-conditions
                data-blocked={blocked ? "true" : "false"}
                aria-label={copy.install.conditionsTitle}
              >
                {/* One line when there is nothing to do: three green rows of
                    explanation is noise for a reader who only wants the code. */}
                <header className="sw-conditions-head">
                  <span className="sw-conditions-badge" aria-hidden="true">{blocked ? "!" : "✓"}</span>
                  <strong>
                    {blocked
                      ? copy.install.conditionsBlockedSummary(conditions.filter((condition) => condition.state === "unmet").length, bare(siteUrl))
                      : conditions.some((condition) => condition.state === "pending")
                        ? copy.install.conditionsChecking
                        : copy.install.conditionsReady(bare(siteUrl))}
                  </strong>
                  {!blocked && (
                    <button type="button" className="sw-onboarding-link" aria-expanded={conditionsOpen} onClick={() => setConditionsOpen((open) => !open)}>
                      {conditionsOpen ? copy.install.conditionsHideDetails : copy.install.conditionsShowDetails}
                    </button>
                  )}
                </header>
                {(blocked || conditionsOpen) && (
                  <ul>
                    {conditions.map((condition) => (
                      <li key={condition.id} data-condition={condition.id} data-state={condition.state}>
                        <span className="sw-condition-mark" aria-hidden="true">
                          {condition.state === "met" ? "✓" : condition.state === "unmet" ? "✗" : "·"}
                        </span>
                        <span className="sw-condition-label">{conditionLabel(copy, condition)}</span>
                        <div className="sw-condition-value">{conditionValue(copy, condition, bare(siteUrl), policyCopy)}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

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
                      {blocked ? (
                        <details className="sw-onboarding-folded-code" data-folded-code>
                          <summary>{copy.install.codeFoldedBlocked}</summary>
                          <pre ref={promptRef} className="sw-onboarding-prompt"><code>{prompt}</code></pre>
                        </details>
                      ) : (
                        <pre ref={promptRef} className="sw-onboarding-prompt"><code>{prompt}</code></pre>
                      )}
                      {copiedPrompt && (
                        <p className="sw-onboarding-success"><strong>{copy.install.promptCopied}</strong> {copy.install.promptCopiedHint}</p>
                      )}
                      <button type="button" className={copiedPrompt || blocked ? "" : "sw-onboarding-primary"} disabled={!prompt} onClick={() => void copyText(prompt, setCopiedPrompt, promptRef.current)}>
                        {copiedPrompt ? copy.install.recopyPrompt : copy.install.copyPrompt}
                      </button>
                      {blocked && (
                        <button type="button" className="sw-onboarding-primary" data-recheck disabled={detecting} onClick={() => void detect()}>
                          {copy.install.recheck}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="sw-onboarding-stage is-current">
                    <span className="sw-onboarding-mark" aria-hidden="true" />
                    <div>
                      <strong>{copy.install.aiStepDetect}</strong>
                      <small>{copy.install.aiStepDetectHint(bare(siteUrl))}</small>
                      <button type="button" className={copiedPrompt ? "sw-onboarding-primary" : ""} disabled={detecting} onClick={() => void detect()}>
                        {detecting ? copy.detect.running : copy.detect.action}
                      </button>
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
                        {/* Folded while a condition is unsettled: the code is
                            still there for anyone who wants it, marked for what
                            it is rather than handed over as if it would work. */}
                        {blocked ? (
                          <details className="sw-onboarding-folded-code" data-folded-code>
                            <summary>{copy.install.codeFoldedBlocked}</summary>
                            <pre ref={codeRef} className="sw-onboarding-code"><code>{guide?.plain || ""}</code></pre>
                          </details>
                        ) : (
                          <>
                            <pre ref={codeRef} className="sw-onboarding-code"><code>{guide?.plain || ""}</code></pre>
                            <small>{copy.install.manualStepCodeHint}</small>
                          </>
                        )}
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
                    <button type="button" className={copiedInstall ? "" : "sw-onboarding-primary"} onClick={() => void copyText(guide?.plain || "", setCopiedInstall, codeRef.current)}>
                      {copiedInstall ? copy.install.codeCopied : copy.install.copyCode}
                    </button>
                    <button type="button" className={copiedInstall ? "sw-onboarding-primary" : ""} disabled={detecting} onClick={() => void detect()}>
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
                  {/* A page that does not carry the code is a fact about the
                      page, whatever the addresses are; only a tag that is
                      there and silent is explained by an address a browser
                      refuses. */}
                  <p>{verdict.reason === "script-missing"
                    ? copy.notDetected.scriptMissing
                    : blocked
                      ? copy.notDetected.conditionsUnmet
                      : copy.notDetected.scriptNotConnecting}</p>
                  <button type="button" onClick={() => void detect()}>{copy.detect.retry}</button>
                </div>
              )}
              {adoptedFrom && (
                <p className="sw-onboarding-note sw-onboarding-adopted" role="status">{copy.adopt.adopted(siteId, adoptedFrom)}</p>
              )}
              {verdict?.kind === "not-detected" && verdict.reason === "foreign-install" && offer.kind === "none" && (
                <div className="sw-onboarding-alert" role="alert">
                  <strong>{copy.foreign.title}</strong>
                  <p>{copy.foreign.body((verdict.foreignSiteAgentIds || []).join("、"))}</p>
                  <p>{copy.foreign.hint}</p>
                  <button type="button" onClick={() => void detect()}>{copy.detect.retry}</button>
                </div>
              )}
              {offer.kind === "adopt" && adopting && (
                <p className="sw-onboarding-note" role="status">{copy.adopt.adopting(offer.installId)}</p>
              )}
              {/* Adoption was refused by the server: name both ways out and allow another try. */}
              {offer.kind === "adopt" && !adopting && adoptError && (
                <div className="sw-onboarding-alert" role="alert">
                  <strong>{copy.adopt.unownedTitle}</strong>
                  <p>{copy.adopt.unownedBody(offer.installId, siteId)}</p>
                  <p>{adoptError}</p>
                  <div className="sw-onboarding-actions">
                    <button type="button" className="sw-onboarding-primary" onClick={() => void adopt(offer.installId)}>{copy.adopt.action(offer.installId)}</button>
                    <button type="button" onClick={() => void detect()}>{copy.detect.retry}</button>
                  </div>
                </div>
              )}
              {/* Several unowned identifiers: only the operator knows which one this site is. */}
              {offer.kind === "choose" && !adopting && (
                <div className="sw-onboarding-alert" role="alert">
                  <strong>{copy.adopt.unownedTitle}</strong>
                  <p>{copy.adopt.unownedBody(offer.installIds.join("、"), siteId)}</p>
                  {adoptError && <p>{adoptError}</p>}
                  <div className="sw-onboarding-actions">
                    {offer.installIds.map((installId) => (
                      <button key={installId} type="button" className="sw-onboarding-primary" onClick={() => void adopt(installId)}>{copy.adopt.action(installId)}</button>
                    ))}
                    <button type="button" onClick={() => void detect()}>{copy.detect.retry}</button>
                  </div>
                </div>
              )}
              {/* This site holds data, and adopting would delete it: the page has to change. */}
              {offer.kind === "change-page-id" && (
                <div className="sw-onboarding-alert" role="alert">
                  <strong>{copy.adopt.changeTitle}</strong>
                  <p>{copy.adopt.changeBody(offer.installIds.join("、"), siteId)}</p>
                  <button type="button" onClick={() => void detect()}>{copy.detect.retry}</button>
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
                  {/* Address and policy are conditions now, measured and stated
                      above; repeating them here is what made this panel a list
                      of things that might be wrong. */}
                  <div>
                    <strong>{copy.troubleshoot.conditionsTitle}</strong>
                    <p>{copy.troubleshoot.conditionsBody}</p>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {phase === "model" && (
          <div className="sw-onboarding-content" data-onboarding-model>
            <p className="sw-onboarding-kicker">{copy.model.kicker}</p>
            <h1>{copy.model.title}</h1>
            <p className="sw-onboarding-lead">{copy.model.description}</p>
            <section className="sw-onboarding-panel">
              {/* The same form as Settings › Models. A save completes the step; later sites never see it. */}
              <ModelSettingsForm locale={locale} compact onSaved={() => setModelDone(true)} />
            </section>
          </div>
        )}

        {phase === "preview" && !modelKnown && (
          <div className="sw-onboarding-content"><p className="sw-onboarding-note" role="status">…</p></div>
        )}

        {phase === "preview" && modelKnown && (
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

type InstallCopy = ReturnType<typeof t>["shell"]["onboarding"];

/** Why this address cannot serve a public website — the rule, not a restatement. */
function addressReason(copy: InstallCopy, condition: Extract<InstallCondition, { id: "address" }>) {
  if (condition.reason === "unreachable") return copy.install.addressUnreachable(condition.origin);
  if (condition.reason === "local") return copy.install.addressLocal(condition.origin);
  if (condition.reason === "unset" || !condition.origin) return copy.install.addressUnset;
  return copy.install.addressInsecure(condition.origin);
}

/** The name of one condition: short, because it is a label in a row. */
function conditionLabel(copy: InstallCopy, condition: InstallCondition) {
  if (condition.id === "address") return copy.install.labelAddress;
  if (condition.id === "site-address") return copy.install.labelSiteAddress;
  return copy.install.labelPolicy;
}

type PolicyCopy = { copied: boolean; onCopy: (value: string) => void };

/**
 * What one row says. A condition that is met states its value and nothing
 * else; only a condition a reader has to act on explains itself and names the
 * next step.
 */
function conditionValue(copy: InstallCopy, condition: InstallCondition, site: string, policyCopy: PolicyCopy) {
  if (condition.state === "pending") return <small className="sw-condition-quiet">{copy.install.statePendingShort}</small>;
  if (condition.state === "met") {
    if (condition.id === "address") return <code>{copy.install.addressMetShort(condition.origin)}</code>;
    if (condition.id === "site-address") return <code>{copy.install.siteAddressMetShort(site)}</code>;
    return <small>{condition.verdict?.source === "inferred" ? copy.install.policyInferredShort : copy.install.policyMetShort}</small>;
  }
  return conditionBody(copy, condition, site, policyCopy);
}

/**
 * What this condition says right now. An unmet one always ends with the one
 * thing the reader has to go and do; a pending one says only that, because an
 * upstream condition has to be settled before it can be judged at all.
 */
function conditionBody(copy: InstallCopy, condition: InstallCondition, site: string, policyCopy: PolicyCopy) {
  if (condition.state === "pending") return <small>{copy.install.statePending}</small>;
  if (condition.id === "address") {
    return condition.state === "met"
      ? <small>{copy.install.addressMet(condition.origin)}</small>
      : (<>
        <small>{addressReason(copy, condition)}</small>
        <small className="sw-condition-next">{copy.install.addressNext}</small>
      </>);
  }
  if (condition.id === "site-address") {
    if (condition.state === "unknown") {
      return <small>{condition.unreachable ? copy.install.siteAddressUnknown(site, condition.unreachable.reason) : copy.install.stateUnknown}</small>;
    }
    return condition.state === "met"
      ? <small>{copy.install.siteAddressMet(site)}</small>
      : (<>
        <small>{copy.install.siteAddressUnmet(condition.registered || "", condition.actual || "")}</small>
        <small className="sw-condition-next">{copy.install.siteAddressNext}</small>
      </>);
  }
  const verdict = condition.verdict;
  if (!verdict) return <small>{copy.install.policyUnknown}</small>;
  const blockedKinds = verdict.findings.filter((finding) => finding.blocked);
  return (
    <>
      <small>{verdict.source === "measured" ? copy.install.policyMeasured : copy.install.policyInferred}</small>
      {condition.state === "met" ? <small>{copy.install.policyMet}</small> : (
        <>
          <ul className="sw-condition-blocked">
            {blockedKinds.map((finding) => (
              <li key={finding.kind}>{copy.install.policyBlockedKind(copy.install.policyKind[finding.kind] || finding.kind, finding.directive || "")}</li>
            ))}
          </ul>
          <small className="sw-condition-next">{copy.install.policyPatchLead}</small>
          {verdict.patches.map((patch) => (
            <div className="sw-condition-patch" key={patch.before}>
              {/* One line per directive. A real policy runs to several
                  kilobytes, and printing it whole — twice — hides the two
                  words that actually change. */}
              <ul className="sw-condition-edits" data-policy-edits>
                {(patch.edits || []).map((edit) => (
                  <li key={edit.directive}>
                    <code>{edit.present
                      ? copy.install.policyEditAppend(edit.directive, edit.add)
                      : copy.install.policyEditAdd(edit.directive, edit.sources.join(" "))}</code>
                  </li>
                ))}
              </ul>
              <div className="sw-condition-patch-actions">
                <button type="button" className="sw-condition-copy" data-copy-policy onClick={() => policyCopy.onCopy(patch.after)}>
                  {policyCopy.copied ? copy.install.policyCopied : copy.install.policyCopy}
                </button>
              </div>
              <details className="sw-condition-full" data-full-policy>
                <summary>{copy.install.policyAfter}</summary>
                <pre className="sw-onboarding-code"><code>{patch.after}</code></pre>
              </details>
              {patch.strictDynamic && <small className="sw-condition-next">{copy.install.policyStrictDynamic}</small>}
            </div>
          ))}
          <small className="sw-condition-next">
            {condition.platform ? copy.install.policyPlatform(condition.platform) : copy.install.policyWhere}
          </small>
        </>
      )}
    </>
  );
}
