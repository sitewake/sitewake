import {
  buildBusinessTopologyFromParts,
  type SiteBusinessTopology,
} from "../site-knowledge/business-topology";
import type { SiteAgentOverview } from "../site-knowledge/protocol";
import type { SiteKnowledge } from "../site-knowledge/knowledge-model";
import type { ContentCoverage } from "../site-knowledge/content-index";
import type { SiteAgentDiagnostic } from "../site-knowledge/errors";

export type Tab = "overview" | "agent" | "sessions" | "capabilities" | "model" | "settings" | "connection";
export type ConsoleScope = "site" | "system";
/** Retained for the hidden legacy settings implementation. */
export type SettingsSection = "experience" | "connection";

export type OverviewResponse = SiteAgentOverview & {
  persistence: "memory" | "d1";
  modelConfigured: boolean;
  /** The independent knowledge base the server serves alongside the release. */
  knowledge?: SiteKnowledge;
  /** Site-wide content-index coverage (knowledge-center-manageability). */
  contentCoverage?: ContentCoverage;
  /** Non-blocking dependency/data diagnostics retained by the overview API. */
  diagnostics?: SiteAgentDiagnostic[];
};

/**
 * Tab **identity and order**, no copy.
 *
 * Copy used to live here, but this is a module-level constant evaluated at load time,
 * before `<html lang>` is read, so the locale was always the default. Names and hints
 * are now taken by the renderer from the dictionary by id (`t().shell.tab[id]`); only
 * the id, order and icon the router needs remain.
 */
export const CONSOLE_TABS: Array<{ id: Tab; icon: string }> = [
  { id: "overview", icon: "overview" },
  { id: "agent", icon: "agent" },
  { id: "sessions", icon: "sessions" },
  { id: "capabilities", icon: "capabilities" },
  { id: "model", icon: "knowledge" },
  { id: "settings", icon: "settings" },
];

/**
 * The knowledge-pure site topology the site knowledge view renders: scenes + links only.
 * Derived on demand from the source knowledge (`buildBusinessTopologyFromParts`) — the
 * topology is never stored, so this always recomputes from the knowledge base the server
 * sends, falling back to the release for older payloads / the memory path. Execution
 * (operation) flow edges are kept out of the base and layered back in via `businessFlowEdges`.
 */
export function knowledgeTopology(overview: OverviewResponse): SiteBusinessTopology {
  const source = overview.knowledge
    ? { rootName: overview.knowledge.profile.name, scenes: overview.knowledge.scenes, linkReferences: overview.knowledge.links }
    : { rootName: overview.activeRelease.profile.name, scenes: overview.activeRelease.scenes, linkReferences: overview.activeRelease.linkReferences };
  return buildBusinessTopologyFromParts(source);
}

/**
 * Capabilities worth showing as product assets.
 *
 * Per docs/site-agent-system-design.md the console surfaces Capabilities, not
 * navigation steps: a bare "back" with no outputs is a page movement, not a
 * business capability, and listing it would inflate what the Agent can do.
 */
export function businessCapabilities(overview: OverviewResponse) {
  return overview.activeRelease.capabilities.filter((capability) => {
    const outputCount = Object.keys(capability.outputs.properties || {}).length;
    const isReturnPath = /^(返回|回到|退回|back\b)/i.test(capability.name.trim());
    return (
      capability.kind !== "navigation" &&
      !(isReturnPath && outputCount === 0) &&
      ["available", "improving"].includes(capability.status)
    );
  });
}

/**
 * Onboarding is independent of the console, not a seventh tab: it is neither in `Tab`
 * nor in `CONSOTE_TABS`, and only leaves a tab-independent marker in the URL so step
 * one (no site to select yet) survives a refresh. Step two does not need the marker —
 * "site exists but never handshook" is a server-verifiable fact.
 */
export const ONBOARDING_QUERY_KEY = "connect";

/** Reads console state out of the URL so a view is linkable and reloadable. */
export function consoleRoute() {
  if (typeof window === "undefined")
    return {
      scope: "site" as ConsoleScope,
      siteId: "",
      tab: "overview" as Tab,
      runnerSiteAgentId: "",
      onboarding: false,
    };
  const query = new URLSearchParams(window.location.search);
  const rawView = query.get("view");
  const onboarding = query.get(ONBOARDING_QUERY_KEY) === "1";
  if (rawView === "runners") {
    return {
      scope: "system" as ConsoleScope,
      siteId: "",
      tab: "overview" as Tab,
      runnerSiteAgentId: query.get("siteAgentId") || query.get("site") || "",
      onboarding: false,
    };
  }
  // `runs` and `appearance` are legacy view names kept working so existing
  // bookmarks and links do not 404 into an empty console.
  const requestedTab = rawView === "runs" || rawView === "effects"
    ? "sessions"
    : rawView === "appearance" || (rawView === "settings" && query.get("section") === "experience")
      ? "agent"
      : rawView === "settings" && query.get("section") === "connection"
        ? "connection"
        : (rawView as Tab | null);
  return {
    scope: "site" as ConsoleScope,
    siteId: query.get("site") || "",
    tab: requestedTab === "connection" || CONSOLE_TABS.some((item) => item.id === requestedTab)
      ? requestedTab!
      : ("overview" as Tab),
    runnerSiteAgentId: "",
    onboarding,
  };
}

export function writeConsoleRoute(
  scope: ConsoleScope,
  siteId: string,
  tab: Tab,
  runnerSiteAgentId: string,
  history: "replace" | "push" = "replace",
  options: { onboarding?: boolean } = {},
) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const previousSite = url.searchParams.get("site");
  const commit = () => {
    if (url.href === window.location.href) return;
    if (history === "push") window.history.pushState(window.history.state, "", url);
    else window.history.replaceState(window.history.state, "", url);
  };
  if (scope === "system") {
    url.searchParams.set("scope", "system");
    url.searchParams.set("view", "runners");
    url.searchParams.delete(ONBOARDING_QUERY_KEY);
    url.searchParams.delete("site");
    url.searchParams.delete("intake");
    url.searchParams.delete("capability");
    url.searchParams.delete("section");
    if (runnerSiteAgentId) url.searchParams.set("siteAgentId", runnerSiteAgentId);
    else url.searchParams.delete("siteAgentId");
    url.searchParams.delete("module");
    commit();
    return;
  }
  url.searchParams.delete("scope");
  url.searchParams.delete("siteAgentId");
  if (options.onboarding) url.searchParams.set(ONBOARDING_QUERY_KEY, "1");
  else url.searchParams.delete(ONBOARDING_QUERY_KEY);
  if (siteId && tab !== "settings") url.searchParams.set("site", siteId);
  else url.searchParams.delete("site");
  if (tab === "overview") url.searchParams.delete("view");
  else url.searchParams.set("view", tab);
  if (tab !== "capabilities" || previousSite !== siteId) {
    url.searchParams.delete("intake");
    url.searchParams.delete("capability");
    url.searchParams.delete("module");
  }
  if (tab !== "settings") url.searchParams.delete("section");
  if (tab !== "sessions" || previousSite !== siteId) url.searchParams.delete("run");
  commit();
}
