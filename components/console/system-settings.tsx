"use client";

import { useEffect, useState } from "react";
import { t, type Locale } from "../../lib/i18n";
import type { SiteAgentSummary } from "../../lib/site-knowledge/protocol";
import { systemSettingsCopy } from "../../lib/console/system-settings-copy";
import { AccessManagePanel } from "../access-manage-panel";
import { LocaleSwitcher } from "../locale-switcher";
import { EmptyState } from "../ui";

type SystemStatus = {
  environment: "development" | "container" | "cloudflare";
  database: string; artifactsConfigured: boolean; build: string;
  models: Record<"general" | "execution" | "semantic", { configured: boolean; model: string }>;
};
const sections = ["general", "runtime", "access", "sites"] as const;
type Section = typeof sections[number];
function currentSection(): Section {
  const requested = typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("section");
  return sections.includes(requested as Section) ? requested as Section : "general";
}
export function SystemSettings({ locale, sites, sitesError, onOpenSite, onCreateSite, onOpenRunners, onDeleteSite, showRunners }: {
  locale: Locale; sites: SiteAgentSummary[]; sitesError?: string; onOpenSite(id: string): void; onCreateSite(): void; onOpenRunners(): void; onDeleteSite?(site: { id: string; name: string }): void; showRunners: boolean;
}) {
  const ui = systemSettingsCopy(locale);
  const onboarding = t(locale).shell.onboarding;
  const deleteCopy = t(locale).confirm.deleteSite;
  const [section, setSection] = useState<Section>(currentSection);
  const [status, setStatus] = useState<SystemStatus>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(false);
    void fetch("/api/system/status", { cache: "no-store", signal: controller.signal })
      .then(response => response.ok ? response.json() : Promise.reject(new Error("unavailable")))
      .then((value: SystemStatus) => { if (!controller.signal.aborted) setStatus(value); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  useEffect(() => {
    const update = () => setSection(currentSection());
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  function select(value: Section) {
    setSection(value);
    const url = new URL(window.location.href);
    if (value === "general") url.searchParams.delete("section"); else url.searchParams.set("section", value);
    window.history.replaceState(window.history.state, "", url);
  }
  const hint = { general: ui.generalHint, runtime: ui.runtimeHint, access: ui.accessHint, sites: ui.sitesHint }[section];
  return <div className="sw-system-settings sw-global-settings">
    <p className="sw-page-description">{ui.intro}</p>
    <nav className="sw-settings-categories" aria-label={ui.globalNav}>{sections.map(value => <button type="button" key={value} aria-current={section === value ? "page" : undefined} onClick={() => select(value)}>{ui[value]}{value === "sites" && <span>{sites.length}</span>}</button>)}</nav>
    <div className="sw-settings-section-intro"><div><h2>{ui[section]}</h2><p>{hint}</p></div>{(section === "general" || section === "runtime") && <button className="sw-text-button" disabled={loading} onClick={() => setAttempt(value => value + 1)}>{ui.updated} ↻</button>}</div>
    {(section === "general" || section === "runtime") && error && <p className="sw-error" role="alert">{ui.unavailable} <button onClick={() => setAttempt(value => value + 1)}>{ui.retry}</button></p>}
    {(section === "general" || section === "runtime") && loading && !status && <p role="status" className="sw-setting-note">{ui.loading}</p>}
    {section === "general" && <>
      <section className="sw-settings-block"><header><h2>{ui.personal}</h2></header><div className="sw-setting-row"><div><h3>{ui.language}</h3><p>{ui.languageHint}</p></div><LocaleSwitcher locale={locale} variant="card" /></div></section>
      {status && <section className="sw-settings-block"><header><h2>{ui.deployment}</h2></header><dl className="sw-settings-rows">
        <div><dt>{ui.environment}</dt><dd>{ui[status.environment]}</dd></div>
        <div><dt>{ui.database}</dt><dd>{status.database === "memory" ? ui.notPersistent : status.database}</dd></div>
        <div><dt>{ui.files}</dt><dd>{status.artifactsConfigured ? ui.configured : ui.missing}</dd></div>
        <div><dt>{ui.version}</dt><dd>{status.build === "development" ? ui.localBuild : <code>{status.build.slice(0, 12)}</code>}</dd></div>
      </dl></section>}
    </>}
    {section === "runtime" && <>
      {status && <section className="sw-settings-block"><header><h2>{ui.models}</h2><span>{ui.managed}</span></header>{(["general", "execution", "semantic"] as const).map(role => <div className="sw-setting-row sw-model-role" key={role}><div><h3>{ui[`${role}Model`]}</h3><p>{ui[`${role}ModelHint`]}</p></div><div className="sw-model-value"><code>{status.models[role].configured ? status.models[role].model : "—"}</code><small className={status.models[role].configured ? "" : "missing"}>{status.models[role].configured ? ui.configured : ui.missing}</small></div></div>)}<p className="sw-model-footnote">{ui.modelHint}</p></section>}
      {showRunners && <section className="sw-settings-block"><div className="sw-setting-row"><div><h3>{ui.execution}</h3><p>{ui.executionHint}</p></div><button type="button" className="sw-secondary-button" onClick={onOpenRunners}>{ui.manageExecution} →</button></div></section>}
    </>}
    {section === "access" && <section className="sw-settings-block sw-settings-access"><header><h2>{ui.account}</h2></header><AccessManagePanel locale={locale} showLogout /></section>}
    {section === "sites" && <section className="sw-settings-block"><header><h2>{ui.siteCount(sites.length)}</h2><button type="button" className="sw-secondary-button" onClick={onCreateSite}>{ui.addSite}</button></header>{sitesError ? <p className="sw-setting-note" role="alert">{ui.siteUnavailable}</p> : sites.length ? <div className="sw-managed-sites">{sites.map(site => <div className="sw-managed-site" key={site.id}>
      {/* 行主体与「删除」是两个独立的可点区域：删除不切换网站、不打开网站。待接入的网站只能从这里删——点进去会回到接入流程，到不了网站设置。 */}
      <button type="button" className="sw-managed-site-open" onClick={() => onOpenSite(site.id)}><span className="sw-site-initial">{site.profile.name.slice(0,1)}</span><span><strong>{site.profile.name}</strong><small>{site.connection?.origin || site.profile.entryUrl}{/* 没有连接记录 = 接入还没走完，点进去回到流程第二步。 */}{!site.connection && <em className="sw-site-pending">{onboarding.pending.badge}</em>}</small></span><span>{site.connection ? ui.openSite : onboarding.pending.resume} →</span></button>
      {onDeleteSite && <button type="button" className="sw-managed-site-delete" onClick={(event) => { event.stopPropagation(); onDeleteSite({ id: site.id, name: site.profile.name }); }}>{deleteCopy.listAction}</button>}
    </div>)}</div> : <EmptyState title={ui.noSites} text={ui.noSitesHint} />}</section>}
  </div>;
}
