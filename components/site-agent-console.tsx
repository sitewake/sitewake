"use client";

import { LocaleSwitcher } from "./locale-switcher";
import { AccessNotice } from "./console/access-notice";
import { t, type Locale } from "../lib/i18n";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { SiteAgentSummary } from "../lib/site-knowledge/protocol";
import {
  consoleRoute,
  CONSOLE_TABS as tabs,
  writeConsoleRoute,
  type ConsoleScope,
  type OverviewResponse,
  type Tab,
} from "../lib/console/route";
import { CapabilityCenterV2 } from "./capability-center-v1";
import {
  RunnerManagement,
  type RunnerManagementMode,
} from "./runner-management";
import "./console/sidebar.css";
import { useFocusTrap, useArrowNavigation, useDismissOnOutside } from "./ui/behavior";
import { LoadFailure } from "./console/shell-states";
import { OnboardingFlow, type OnboardingKind } from "./console/onboarding";
import { PublicAddressBanner, usePublicAddress } from "./console/public-address-banner";
import { SiteModel } from "./console/site-model";
import { AgentExperience } from "./console/settings";
import { LivingOverview } from "./console/living-overview";
import { WebsiteSettings } from "./console/website-settings";
import { DeleteSiteDialog } from "./console/delete-site-dialog";
import { systemSettingsCopy } from "../lib/console/system-settings-copy";
import { SystemSettings } from "./console/system-settings";
import { SessionHistory } from "./console/session-history";
import { siteAgentClientErrorMessage } from "../lib/site-knowledge/errors";

type SiteAgentResponseError = Error & { code?: string; status?: number };

function ConsoleIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    settings: <><path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z"/><circle cx="12" cy="12" r="3"/></>,
    overview: <><path d="m4 11.5 8-6.5 8 6.5V20H4Z"/><path d="M9.5 20v-5h5v5"/></>,
    agent: <><circle cx="12" cy="8" r="3"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/></>,
    sessions: <><path d="M5 6h14v10H9l-4 3V6Z"/><path d="M8 10h8M8 13h5"/></>,
    capabilities: <><path d="m12 3 8 4-8 4-8-4 8-4Z"/><path d="m4 12 8 4 8-4M4 17l8 4 8-4"/></>,
    knowledge: <><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v17H7.5A3.5 3.5 0 0 0 4 22V5.5Z"/><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H13v17h3.5A3.5 3.5 0 0 1 20 22V5.5Z"/></>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

async function responseError(response: Response, resource: "list" | "overview") {
  const payload = await response.json().catch(() => undefined);
  const error = new Error(siteAgentClientErrorMessage(response.status, payload, resource)) as SiteAgentResponseError;
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  if (typeof body.error === "string") error.code = body.error;
  error.status = response.status;
  return error;
}

function requestFailureMessage(reason: unknown, resource: "list" | "overview") {
  if (reason && typeof reason === "object" && "status" in reason) {
    return String((reason as unknown as Error).message || siteAgentClientErrorMessage(0, undefined, resource));
  }
  if (reason instanceof TypeError) return siteAgentClientErrorMessage(0, undefined, resource);
  return reason instanceof Error ? reason.message : String(reason);
}

export function SiteAgentConsole({
  initialRunnerMode,
  locale,
}: {
  initialRunnerMode: RunnerManagementMode;
  locale: Locale;
}) {
  const copy = t(locale).shell;
  const systemCopy = systemSettingsCopy(locale);
  const [agents, setAgents] = useState<SiteAgentSummary[]>([]);
  // Keep the server and first client render identical. Query-string state is
  // hydrated after mount; reading window during the useState initializer made
  // every deep-linked console page produce a React hydration mismatch.
  const [selectedId, setSelectedId] = useState("");
  const [overview, setOverview] = useState<OverviewResponse>();
  const [scope, setScope] = useState<ConsoleScope>("site");
  const [tab, setTab] = useState<Tab>("overview");
  const [runnerMode, setRunnerMode] =
    useState<RunnerManagementMode>(initialRunnerMode);
  const [runnerSiteAgentId, setRunnerSiteAgentId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const sidebar = useRef<HTMLElement>(null);
  const closeSidebar = useCallback(() => { setSidebarOpen(false); setSiteMenuOpen(false); }, []);
  useFocusTrap(sidebar, { active: sidebarOpen, onClose: closeSidebar });
  const [siteMenuOpen, setSiteMenuOpen] = useState(false);
  const [siteQuery, setSiteQuery] = useState("");
  const [routeReady, setRouteReady] = useState(false);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  /**
   * Whether the onboarding flow is open. Once mounted it decides when to exit itself —
   * the moment detection succeeds the site has a connection, and if the derivation
   * below decided, step three would be torn down in the same frame it appears.
   */
  const [flow, setFlow] = useState<{ kind: OnboardingKind; siteId: string; adoptedFrom?: string } | null>(null);
  /** The site whose deletion is being confirmed; both entry points share this dialog. */
  const [deletingSite, setDeletingSite] = useState<{ id: string; name: string }>();
  /** The flow marker in the URL. Only step one needs it; step two is derived from "site exists but never handshook". */
  const [onboardingRequested, setOnboardingRequested] = useState(false);
  /** Sites that completed onboarding in this session. Even without a connection record in the stale list, they never return to the flow. */
  const completedSites = useRef<Set<string>>(new Set());
  const overviewRequest = useRef<AbortController | null>(null);
  const siteSwitcher = useRef<HTMLDivElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const closeSiteMenu = useCallback(() => { setSiteMenuOpen(false); setSiteQuery(""); }, []);
  useDismissOnOutside(siteSwitcher, { active: siteMenuOpen, onClose: closeSiteMenu });
  useArrowNavigation(navigation, { orientation: "vertical", active: scope === "site" && Boolean(selectedId) });
  const navigateToTab = useCallback((next: Tab) => {
    writeConsoleRoute("site", selectedId, next, "", "push");
    setScope("site"); setTab(next); setSidebarOpen(false); setSiteMenuOpen(false);
  }, [selectedId]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 821px)");
    const closeOnDesktop = () => { if (desktop.matches) closeSidebar(); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [closeSidebar]);
  useEffect(() => {
    if (!sidebarOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [sidebarOpen]);

  const loadAgents = useCallback(async (fresh = false) => {
    const response = await fetch(
      fresh ? `/api/site-agents?fresh=${Date.now()}` : "/api/site-agents",
      { cache: "no-store" },
    );
    if (!response.ok) throw await responseError(response, "list");
    const payload = (await response.json()) as { agents: SiteAgentSummary[] };
    setAgents(payload.agents);
    setSelectedId((current) =>
      current || payload.agents[0]?.id || "",
    );
    setAgentsLoading(false);
    setListError("");
  }, []);

  const loadOverview = useCallback(async (id: string) => {
    if (!id || id !== selectedId) return;
    overviewRequest.current?.abort();
    const controller = new AbortController();
    overviewRequest.current = controller;
    try {
      const response = await fetch(`/api/site-agents/${encodeURIComponent(id)}`, {
        cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) throw await responseError(response, "overview");
      const next = (await response.json()) as OverviewResponse;
      if (controller.signal.aborted) return;
      if (next.id !== id) throw new Error(copy.overviewMismatch);
      setOverview(next);
      setError("");
    } catch (reason) {
      if (!controller.signal.aborted) setError(requestFailureMessage(reason, "overview"));
    }
  }, [selectedId, copy.overviewMismatch]);

  const reloadOverview = useCallback(() => { void loadOverview(selectedId); }, [loadOverview, selectedId]);

  useEffect(() => {
    const initial = setTimeout(
      () =>
        void loadAgents().catch((reason) => {
          setAgentsLoading(false);
          setListError(requestFailureMessage(reason, "list"));
        }),
      0,
    );
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        void loadAgents().catch(() => undefined);
    }, 30_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [loadAgents]);
  useEffect(() => {
    const onPopState = () => {
      const url = new URL(window.location.href);
      const legacySiteId = url.searchParams.get("view") === "runners"
        ? url.searchParams.get("siteAgentId") || url.searchParams.get("site") || ""
        : "";
      if (legacySiteId) {
        url.searchParams.delete("scope");
        url.searchParams.delete("siteAgentId");
        url.searchParams.set("site", legacySiteId);
        url.searchParams.set("view", "capabilities");
        url.searchParams.set("module", "runners");
        window.history.replaceState(window.history.state, "", url);
        setScope("site");
        setSelectedId(legacySiteId);
        setTab("capabilities");
        setRunnerSiteAgentId("");
        return;
      }
      const route = consoleRoute();
      const hiddenRunnerRoute =
        runnerMode === "hidden" && route.scope === "system";
      closeSiteMenu();
      setError("");
      setScope(hiddenRunnerRoute ? "site" : route.scope);
      setSelectedId(route.siteId);
      setTab(hiddenRunnerRoute ? "overview" : route.tab);
      setOnboardingRequested(route.onboarding);
      setRunnerSiteAgentId(
        hiddenRunnerRoute ? "" : route.runnerSiteAgentId,
      );
    };
    onPopState();
    const ready = setTimeout(() => setRouteReady(true), 0);
    window.addEventListener("popstate", onPopState);
    return () => {
      clearTimeout(ready);
      window.removeEventListener("popstate", onPopState);
    };
  }, [runnerMode, closeSiteMenu]);
  useEffect(() => {
    if (routeReady)
      writeConsoleRoute(
        scope,
        selectedId,
        tab,
        runnerSiteAgentId,
        "replace",
        { onboarding: Boolean(flow && !flow.siteId) },
      );
  }, [
    flow,
    routeReady,
    runnerSiteAgentId,
    scope,
    selectedId,
    tab,
  ]);
  /**
   * When to enter onboarding is derived entirely from server-verifiable facts, so it
   * survives a refresh: no site at all, or the selected site never handshook, means
   * onboarding is not done.
   */
  useEffect(() => {
    if (!routeReady || flow || scope !== "site" || agentsLoading || listError) return;
    if (onboardingRequested) {
      setFlow({ kind: agents.length ? "new-site" : "first", siteId: "" });
      return;
    }
    if (!agents.length) { setFlow({ kind: "first", siteId: "" }); return; }
    const selected = agents.find((agent) => agent.id === selectedId);
    // Skip sites that just completed the flow: the list refreshes every 30 s, and when the
    // user clicks "go to console" the client most likely still holds the stale list
    // without a connection record; deriving from it would bounce them straight back.
    if (selected && !selected.connection && !completedSites.current.has(selected.id)) {
      setFlow({ kind: agents.length > 1 ? "new-site" : "first", siteId: selected.id });
    }
  }, [agents, agentsLoading, flow, listError, onboardingRequested, routeReady, scope, selectedId]);

  const startOnboarding = useCallback(() => {
    setSiteMenuOpen(false);
    setSidebarOpen(false);
    setOnboardingRequested(true);
    setFlow({ kind: agents.length ? "new-site" : "first", siteId: "" });
  }, [agents.length]);
  const onboardingCreated = useCallback((siteAgentId: string) => {
    setOnboardingRequested(false);
    setSelectedId(siteAgentId);
    setFlow((current) => (current ? { ...current, siteId: siteAgentId } : current));
    void loadAgents(true).catch((reason) => setListError(requestFailureMessage(reason, "list")));
  }, [loadAgents]);
  /** The flow adopted the id on the page: old shell deleted, new id created; switch over and remember where we came from. */
  const onboardingAdopted = useCallback((siteAgentId: string, replacedSiteAgentId: string) => {
    setSelectedId(siteAgentId);
    setAgents((current) => current.filter((agent) => agent.id !== replacedSiteAgentId));
    setFlow((current) => (current ? { ...current, siteId: siteAgentId, adoptedFrom: replacedSiteAgentId } : current));
    void loadAgents(true).catch((reason) => setListError(requestFailureMessage(reason, "list")));
  }, [loadAgents]);
  /** Step three's "go to console": this site's connection is confirmed; never send the user back to the flow. */
  const enterConsoleFromFlow = useCallback((siteAgentId: string) => {
    completedSites.current.add(siteAgentId);
    setOnboardingRequested(false);
    setFlow(null);
    setScope("site");
    setSelectedId(siteAgentId);
    setTab("overview");
    void loadAgents(true).catch(() => undefined);
  }, [loadAgents]);
  /**
   * Exit when step one collides with an existing site: switch to it. If it is not
   * connected either, the derivation reopens the flow at its step two — exactly what
   * "continue its onboarding" should look like.
   */
  const openSiteFromFlow = useCallback((siteAgentId: string) => {
    setOnboardingRequested(false);
    setFlow(null);
    setScope("site");
    setSelectedId(siteAgentId);
    setTab("overview");
    void loadAgents(true).catch(() => undefined);
  }, [loadAgents]);
  useEffect(() => {
    if (!selectedId || scope !== "site" || tab === "settings") return;
    const initial = setTimeout(
      () =>
        void loadOverview(selectedId).catch((reason) =>
          setError(requestFailureMessage(reason, "overview")),
        ),
      0,
    );
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        void loadOverview(selectedId).catch(() => undefined);
    }, 15_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
      overviewRequest.current?.abort();
    };
  }, [loadOverview, scope, selectedId, tab]);
  // One fact about this installation, read once: whether a visitor's browser
  // can reach it at all. The banner below says it in a single place.
  const { address: publicAddress } = usePublicAddress();
  const openPublicAddressSettings = useCallback(() => {
    writeConsoleRoute("site", "", "settings", "", "push");
    setTab("settings"); setScope("site");
    const url = new URL(window.location.href);
    url.searchParams.set("section", "runtime");
    window.history.replaceState(window.history.state, "", url);
  }, []);
  const openWebsiteSettings = useCallback((id: string) => {
    writeConsoleRoute("site", id, "connection", "", "push");
    setSelectedId(id); setTab("connection"); setScope("site");
  }, []);
  /**
   * Where to land after a successful delete: remove from the local list first (it only
   * refreshes every 30 s), then force a refresh. If the current site was deleted: switch
   * to the next one's overview — preferring a connected one, otherwise we land in another
   * site's onboarding; if none is left, clear the selection and the existing derivation
   * opens the `first` onboarding because `agents.length === 0`. If another site was
   * deleted: the page stays.
   */
  const onSiteDeleted = useCallback((id: string) => {
    setDeletingSite(undefined);
    completedSites.current.delete(id);
    setAgents((current) => {
      const remaining = current.filter((agent) => agent.id !== id);
      if (selectedId === id) {
        const next = (remaining.find((agent) => agent.connection) || remaining[0])?.id || "";
        setSelectedId(next);
        setOverview(undefined);
        setFlow(null);
        setScope("site");
        setTab("overview");
        writeConsoleRoute("site", next, "overview", "", "replace");
      }
      return remaining;
    });
    void loadAgents(true).catch((reason) => setListError(requestFailureMessage(reason, "list")));
  }, [loadAgents, selectedId]);


  const updateRunnerMode = useCallback((next: RunnerManagementMode) => {
    setRunnerMode(next);
    if (next === "hidden") {
      setScope("site");
      setTab("overview");
    }
  }, []);

  const openRunnerOwner = useCallback(
    (siteAgentId: string, capabilityId?: string) => {
      setScope("site");
      setSelectedId(siteAgentId);
      setTab(capabilityId ? "capabilities" : "overview");
      if (capabilityId) {
        const url = new URL(window.location.href);
        url.searchParams.set("capability", capabilityId);
        window.history.replaceState({}, "", url);
      }
    },
    [],
  );

  // Site creation has one entry: the onboarding flow. The old "address + optional id"
  // dialog dropped people into the console with no SDK on the site yet, facing an empty
  // shell; that path is gone.
  const visibleOverview = overview?.id === selectedId ? overview : undefined;

  const listed = agents.find((item) => item.id === selectedId);
  const current = overview?.id === selectedId ? overview : listed;
  const siteOpenUrl =
    current?.profile.entryUrl ||
    current?.connection?.url ||
    current?.connection?.origin ||
    "";
  const filteredAgents = agents.filter((agent) => {
    const needle = siteQuery.trim().toLocaleLowerCase();
    if (!needle) return true;
    return `${agent.profile.name} ${agent.connection?.origin || ""} ${
      agent.profile.entryUrl || ""
    }`
      .toLocaleLowerCase()
      .includes(needle);
  });
  const globalSettings = scope === "site" && tab === "settings";
  // Onboarding is independent of the console: return here, rendering none of the shell's sidebar or tabs.
  if (flow) {
    return (
      <OnboardingFlow
        key={flow.siteId || "new"}
        locale={locale}
        kind={flow.kind}
        siteId={flow.siteId}
        sites={agents}
        adoptedFrom={flow.adoptedFrom}
        onCreated={onboardingCreated}
        onAdopted={onboardingAdopted}
        onEnterConsole={enterConsoleFromFlow}
        onOpenSite={openSiteFromFlow}
        onGoToConsole={openSiteFromFlow}
      />
    );
  }
  return (
    <main className="sw-shell" data-console-ui="v2" data-build-guard="no-homepage-iframe-v2">
      <a className="sw-skip-link" href="#console-content">{copy.skipToContent}</a>
      {sidebarOpen && <button className="sw-console-backdrop" aria-label={copy.closeNavigation} tabIndex={-1} onClick={closeSidebar} />}
      <aside ref={sidebar} id="console-sidebar" className={`sw-console-sidebar${sidebarOpen ? " is-open" : ""}`} role={sidebarOpen ? "dialog" : undefined} aria-modal={sidebarOpen || undefined} aria-label={copy.railViewsLabel}>
        <div className="sw-console-brand">
          <img src="/brand/sitewake-mark.svg?v=wstar-1" alt="" aria-hidden="true" />
          <b>SiteWake</b>
          <button className="sw-console-menu-close" aria-label={copy.closeNavigation} onClick={closeSidebar}>×</button>
        </div>
        <div className="sw-site-switcher" ref={siteSwitcher} onKeyDown={(event) => {
          if (event.key === "Escape" && siteMenuOpen) {
            event.preventDefault(); closeSiteMenu();
            siteSwitcher.current?.querySelector<HTMLButtonElement>(".sw-site-current")?.focus();
          }
        }}>
          <button
            className="sw-site-current"
            aria-expanded={siteMenuOpen}
            aria-controls="console-site-menu"
            onClick={() => setSiteMenuOpen((open) => !open)}
          >
            <span>
              {(current?.profile.name || copy.newSiteInitial).slice(0, 1).toUpperCase()}
            </span>
            <div>
              <small>{copy.currentSite}</small>
              <b>{current?.profile.name || copy.pickSite}</b>
            </div>
            <i>{siteMenuOpen ? "⌃" : "⌄"}</i>
          </button>
          {siteMenuOpen && (
            <div className="sw-site-menu" id="console-site-menu">
              <label>
                <span aria-hidden="true"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg></span>
                <input
                  value={siteQuery}
                  onChange={(event) => setSiteQuery(event.target.value)}
                  placeholder={copy.searchSites}
                  aria-label={copy.searchSites}
                  autoFocus
                />
              </label>
              <div>
                {filteredAgents.map((agent) => (
                  <button
                    key={agent.id}
                    className={agent.id === selectedId ? "selected" : ""}
                    aria-current={
                      agent.id === selectedId ? "true" : undefined
                    }
                    onClick={() => {
                      const nextTab = scope === "site" ? tab : "overview";
                      writeConsoleRoute("site", agent.id, nextTab, "", "push");
                      setScope("site"); setSelectedId(agent.id); setTab(nextTab);
                      setError(""); closeSiteMenu(); setSidebarOpen(false);
                    }}
                  >
                    <span>{agent.profile.name.slice(0, 1).toUpperCase()}</span>
                    <div>
                      <b>{agent.profile.name}</b>
                      <small>
                        {(
                          agent.connection?.origin ||
                          agent.profile.entryUrl ||
                          copy.waitingConnection
                        )
                          .replace(/^https?:\/\//, "")
                          .replace(/\/$/, "")}
                        {/* 从来没握手过 = 还没接入完。这不是新字段，是既有连接记录的缺席。 */}
                        {!agent.connection && <em className="sw-site-pending">{copy.onboarding.pending.badge}</em>}
                      </small>
                    </div>
                    <i>{agent.id === selectedId ? "✓" : ""}</i>
                  </button>
                ))}
                {!filteredAgents.length && <p>{copy.noMatchingSites}</p>}
              </div>
              {selectedId && <button className="sw-site-add" onClick={() => { closeSiteMenu(); openWebsiteSettings(selectedId); }}>{systemCopy.website} →</button>}
              <button
                className="sw-site-add"
                onClick={startOnboarding}
              >
                {copy.addSite}
              </button>
            </div>
          )}
        </div>
        {selectedId && (
          <nav ref={navigation} className="sw-console-navigation" role="tablist" aria-orientation="vertical" aria-label={copy.railViewsLabel}>
            {tabs.filter(item => item.id !== "settings").map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={tab === item.id}
              tabIndex={tab === item.id || ((tab === "settings" || tab === "connection") && item.id === "overview") ? 0 : -1}
              id={`console-tab-${item.id}`}
              aria-controls="console-content"
              className={tab === item.id ? "active" : ""}
              onClick={() => navigateToTab(item.id)}
            >
              <i><ConsoleIcon name={item.icon} /></i>
              <span>{copy.tab[item.id].label}</span>
            </button>
            ))}
          </nav>
        )}
        <div className="sw-console-sidebar-footer">
        <button type="button" className={`sw-console-settings ${tab === "settings" && scope === "site" ? "active" : ""}`} id="console-tab-settings" aria-current={tab === "settings" && scope === "site" ? "page" : undefined} onClick={() => navigateToTab("settings")}><i><ConsoleIcon name="settings" /></i><span>{copy.tab.settings.label}</span></button>
        <LocaleSwitcher locale={locale} variant="rail" />
        </div>
      </aside>
      <section className="sw-main" inert={sidebarOpen || undefined}>
        <header className="sw-topbar">
          <button type="button" className="sw-console-menu-toggle" aria-label={copy.openNavigation} aria-expanded={sidebarOpen} aria-controls="console-sidebar" onClick={() => setSidebarOpen(true)}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg></button>
          <div className="sw-topbar-title">
            <small>
              {globalSettings ? systemCopy.scope : scope === "system"
                ? copy.runnerManagement
                : current?.connection?.origin ||
                  current?.profile.entryUrl ||
                  "SiteWake"}
            </small>
            <h1>
              {scope === "system"
                ? copy.runnerManagement
                : (tab in copy.tab ? copy.tab[tab as keyof typeof copy.tab].label : copy.overviewFallback)}
            </h1>
          </div>
          {scope === "site" && !globalSettings && current ? (
            <div className="sw-top-actions">
              <span className={current.connection ? "healthy" : "waiting"}>
                <i />
                {current.connection ? copy.agentConnected : copy.agentWaiting}
              </span>
              {siteOpenUrl && (
                <a
                  className="sw-open-site"
                  href={siteOpenUrl}
                  target="_blank" rel="noopener noreferrer"
                >
                  <span>{copy.openSite}</span> ↗
                </a>
              )}
            </div>
          ) : scope === "system" ? (
            <div className="sw-top-actions">
              <button
                className="sw-back-to-site"
                onClick={() => {
                  setScope("site");
                  setTab("overview");
                }}
              >
                {copy.backToSite}
              </button>
            </div>
          ) : null}
        </header>
        <section className="sw-content" id="console-content" tabIndex={-1} role={scope === "site" && selectedId ? "tabpanel" : undefined} aria-labelledby={scope === "site" && selectedId ? `console-tab-${tab}` : undefined}>
          {/* Inside the content, above whatever the tab is showing, and above the
              public-address banner it stacks with: an open console is a fact about
              the whole installation rather than about one page, but it has to line
              up with the other banner instead of floating in its own margin. */}
          <AccessNotice />
          {scope === "system" ? (
            <RunnerManagement
              key={`runner-management:${runnerSiteAgentId || "all"}`}
              mode={runnerMode}
              siteAgentIdFilter={runnerSiteAgentId}
              sites={agents.map((agent) => ({
                id: agent.id,
                name: agent.profile.name,
              }))}
              onModeChange={updateRunnerMode}
              onOpenSite={openRunnerOwner}
              onSiteAgentFilterChange={setRunnerSiteAgentId}
            />
          ) : (
            <>
          <PublicAddressBanner
            locale={locale}
            address={publicAddress}
            sites={agents.flatMap((agent) => (agent.profile.entryUrl ? [agent.profile.entryUrl] : []))}
            onOpenSettings={openPublicAddressSettings}
          />
          {!globalSettings && (error || listError) && <div className="sw-error" role="alert">{error || listError}{selectedId && <button onClick={() => {
            reloadOverview();
            if (listError) void loadAgents(true).catch((reason) => setListError(requestFailureMessage(reason, "list")));
          }}>{copy.retryOverview}</button>}</div>}
          {!globalSettings && visibleOverview?.diagnostics?.map((diagnostic) => (
            <div className="sw-error" key={`${diagnostic.phase}:${diagnostic.code}`}>
              {copy.diagnosticCode(diagnostic.message, diagnostic.code)}
            </div>
          ))}
          {tab === "settings" ? (
            <SystemSettings locale={locale} sites={agents} sitesError={listError} onOpenSite={openWebsiteSettings} onCreateSite={startOnboarding} onDeleteSite={setDeletingSite} />
          ) : !selectedId ? (
            agentsLoading ? (
              <div className="sw-loading">{copy.loadingSites}</div>
            ) : listError ? (
              <LoadFailure
                onRetry={() => {
                  setAgentsLoading(true);
                  void loadAgents(true).catch((reason) => {
                    setAgentsLoading(false);
                    setListError(requestFailureMessage(reason, "list"));
                  });
                }}
              />
            ) : (
              // With no site at all the derivation above already opened onboarding, so this is
              // unreachable. A loading line instead of a blank covers the one frame after the
              // list empties and before the derivation runs.
              <div className="sw-loading" role="status">{copy.loadingSites}</div>
            )
          ) : !visibleOverview ? (
            <div className="sw-loading" role="status">{error ? copy.overviewUnavailable : copy.loadingAgents}</div>
          ) : tab === "connection" ? (
            <WebsiteSettings key={selectedId} overview={visibleOverview} locale={locale} onDeleteSite={setDeletingSite} />
          ) : tab === "overview" ? (
            <LivingOverview key={selectedId} locale={locale} overview={visibleOverview} onTab={navigateToTab} onReload={reloadOverview} />
          ) : tab === "agent" ? (
            <AgentExperience
              key={selectedId}
              overview={visibleOverview}
              onSaved={reloadOverview}
            />
          ) : tab === "sessions" ? (
            <SessionHistory key={selectedId} locale={locale} siteAgentId={visibleOverview.id} />
          ) : tab === "capabilities" ? (
            <CapabilityCenterV2
              key={selectedId}
              overview={visibleOverview}
              runnerMode={runnerMode}
              onRunnerModeChange={updateRunnerMode}
            />
          ) : tab === "model" ? (
            <SiteModel key={selectedId} overview={visibleOverview} onReload={reloadOverview} onTab={navigateToTab} />
          ) : null}
            </>
          )}
        </section>
      </section>
      <DeleteSiteDialog site={deletingSite} onDeleted={onSiteDeleted} onCancel={() => setDeletingSite(undefined)} />
    </main>
  );
}
