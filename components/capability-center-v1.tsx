"use client";

import { useEffect, useState } from "react";
import { t } from "../lib/i18n";
import type { SiteAgentOverview } from "../lib/site-knowledge/protocol";
import type { RunnerManagementMode } from "./runner-management";
import { CapabilityCenterScreen } from "./capability-center/capability-center-screen";
import { CapabilityCenterV2Screen } from "./capability-center-v2-screen";

type CapabilityCenterProps = {
  overview: SiteAgentOverview;
  runnerMode?: RunnerManagementMode;
  onRunnerModeChange?(mode: RunnerManagementMode): void;
};

type CapabilityCenterVersion = "v1" | "v2";

export function CapabilityCenterV2(props: CapabilityCenterProps) {
  const [version, setVersion] = useState<CapabilityCenterVersion>("v2");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const requested = new URL(window.location.href).searchParams.get("capabilityCenter");
      if (requested === "v1" || requested === "v2") setVersion(requested);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  function switchVersion(next: CapabilityCenterVersion) {
    setVersion(next);
    const url = new URL(window.location.href);
    url.searchParams.set("capabilityCenter", next);
    window.history.replaceState({}, "", url);
  }

  const copy = t().capability.versionSwitch;
  return <section className="capability-center-version" data-capability-center-version={version}>
    <style>{`.capability-center-version-switch{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px;padding:9px 10px 9px 14px;border:1px solid #dbe7e0;border-radius:14px;background:#fff;color:#33443d}.capability-center-version-switch>span{font-size:12px;font-weight:800}.capability-center-version-switch>div{display:flex;gap:4px;padding:3px;border-radius:10px;background:#edf3ef}.capability-center-version-switch button{border:0;border-radius:8px;padding:7px 11px;background:transparent;color:#67756e;font-size:12px;font-weight:800;cursor:pointer}.capability-center-version-switch button.active{background:#fff;color:#087763;box-shadow:0 1px 4px #173c2d1f}`}</style>
    {version === "v1" && <header className="capability-center-version-switch">
      <span>{copy.label}</span>
      <div role="group" aria-label={copy.groupLabel}>
        <button type="button" data-testid="capability-center-v2-toggle" aria-pressed={false} onClick={() => switchVersion("v2")}>{copy.v2}</button>
        <button type="button" data-testid="capability-center-v1-toggle" aria-pressed={true} className="active" onClick={() => switchVersion("v1")}>{copy.v1}</button>
      </div>
    </header>}
    {version === "v2" ? <CapabilityCenterV2Screen overview={props.overview} /> : <CapabilityCenterScreen {...props} />}
  </section>;
}

/** Historical redesign remains available to old callers; V2 uses the isolated implementation above. */
export function CapabilityCenterV1(props: CapabilityCenterProps) {
  return <CapabilityCenterScreen {...props} />;
}
