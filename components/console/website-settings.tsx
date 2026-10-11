"use client";

import { useState } from "react";
import type { OverviewResponse } from "../../lib/console/route";
import { installationSnippet } from "../../lib/console/install-guide";
import { snippetOrigin, usePublicAddress } from "./public-address-banner";
import { productCopy } from "../../lib/console/product-copy";
import { relativeTime } from "../../lib/console/copy";
import type { Locale } from "../../lib/i18n";
import { systemSettingsCopy } from "../../lib/console/system-settings-copy";
import { downloadKnowledge, knowledgeExportAvailable } from "../../lib/console/knowledge-export";
import { t } from "../../lib/i18n";

export function WebsiteSettings({ overview, locale, onDeleteSite }: { overview?: OverviewResponse; locale: Locale; onDeleteSite?: (site: { id: string; name: string }) => void }) {
  const ui = productCopy(locale);
  const deleteCopy = t(locale).confirm.deleteSite;
  const [copied, setCopied] = useState("");
  const [copyError, setCopyError] = useState("");
  // The snippet shown here is the same one the install flow hands out: it
  // carries the configured public address, never this administrator's own.
  const { address: publicAddress } = usePublicAddress();
  const origin = snippetOrigin(publicAddress, typeof window === "undefined" ? "" : window.location.origin);
  const code = overview ? installationSnippet(origin, overview.id) : "";
  const address = overview?.profile.entryUrl || overview?.connection?.origin;
  async function copyText(value: string, key: string) {
    try { await navigator.clipboard.writeText(value); setCopied(key); setCopyError(""); }
    catch { setCopyError(ui.copyFailed); }
  }
  return <div className="sw-system-settings">
    <p className="sw-page-description">{systemSettingsCopy(locale).websiteHint}</p>
    <section className="sw-settings-block"><header><h2>{ui.siteInfo}</h2><span>{ui.siteScope}</span></header>
      {overview ? <><dl className="sw-settings-rows">
        <div><dt>{ui.siteName}</dt><dd>{overview.profile.name}</dd></div>
        <div><dt>{ui.siteAddress}</dt><dd>{address ? <a href={address} target="_blank" rel="noopener noreferrer">{address} ↗</a> : "—"}</dd></div>
        <div><dt>{ui.siteId}</dt><dd><code>{overview.id}</code><button type="button" className="sw-text-button" onClick={() => void copyText(overview.id, "id")}>{copied === "id" ? ui.copied : ui.copy}</button></dd></div>
        <div><dt>{ui.lastSeen}</dt><dd>{overview.connection ? <><span className="sw-status-dot" />{relativeTime(overview.connection.lastSeenAt)}</> : ui.noConnection}</dd></div>
      </dl><details className="sw-setting-disclosure"><summary><span>{ui.snippet}<small>{ui.installationHint}</small></span></summary><p>{ui.snippetHint}</p><pre><code>{code}</code></pre><button type="button" className="sw-secondary-button" onClick={() => void copyText(code, "code")}>{copied === "code" ? ui.copied : ui.copy}</button></details></> : <p className="sw-setting-note">{ui.noSite}</p>}
    </section>
    {overview && <section className="sw-settings-block"><header><h2>{ui.data}</h2><span>{ui.siteScope}</span></header>
      {knowledgeExportAvailable(overview.knowledge) ? <><dl className="sw-settings-rows">
        <div><dt>{ui.knowledgeVersion}</dt><dd>v{overview.knowledge.version}</dd></div>
        <div><dt>{ui.knowledgeUpdated}</dt><dd>{relativeTime(overview.knowledge.updatedAt)}</dd></div>
        <div><dt>{ui.knowledgeHash}</dt><dd><code>{overview.knowledge.contentHash.slice(0, 10)}</code></dd></div>
      </dl><div className="sw-settings-action">
        <div><strong>{ui.knowledgeExport}</strong><p className="sw-setting-note">{ui.knowledgeExportHint}</p></div>
        <button type="button" className="sw-secondary-button" onClick={() => { downloadKnowledge(overview.id, overview.knowledge!); }}>{ui.downloadKnowledge}</button>
      </div></>
        : <p className="sw-setting-note">{overview.activeRelease.scenes.length ? ui.knowledgeAbsent : ui.knowledgeNone}</p>}
      {/* 删除网站：只是打开确认对话框（要输入网站名称），真正的请求在对话框里发。 */}
      {onDeleteSite && <div className="sw-settings-action sw-settings-danger">
        <div><strong>{deleteCopy.dangerTitle}</strong><p className="sw-setting-note">{deleteCopy.dangerHint}</p></div>
        <button type="button" className="sw-danger-button" onClick={() => onDeleteSite({ id: overview.id, name: overview.profile.name })}>{deleteCopy.dangerAction}</button>
      </div>}
    </section>}
    {copyError && <p role="alert">{copyError}</p>}
  </div>;
}
