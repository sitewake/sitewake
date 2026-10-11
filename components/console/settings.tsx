"use client";

import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from "react";
import { AGENT_PALETTES, SUGGESTION_MAX_LENGTH, defaultAgentConfig, deriveAgentConfigFromKnowledge, normalizeAgentConfig, type AgentConfig } from "../../lib/site-knowledge/protocol";
import { resolveChromeCopy } from "../../client/user-agent-copy";
import type { OverviewResponse } from "../../lib/console/route";
import { AGENT_STYLES, applyAgentStyle, matchingAgentStyle, agentStyleCopy } from "../../lib/console/agent-style-presets";
import { productCopy } from "../../lib/console/product-copy";
import { withoutUnchangedOverrides } from "../../lib/console/agent-presentation";
import { activeLocale, t } from "../../lib/i18n";
import { ConfirmDialog } from "../ui";

export function AgentExperience({ overview, onSaved }: { overview: OverviewResponse; onSaved(): void }) {
  const automaticConfig = deriveAgentConfigFromKnowledge(overview.activeRelease);
  const initialConfig = normalizeAgentConfig(overview.activeRelease.agentConfig, automaticConfig);
  const draftKey = `sitewake:appearance-draft:${overview.id}`;
  const [agentConfig, setAgentConfig] = useState<AgentConfig>(() => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey) || "null");
      // A draft belongs to the saved configuration it was started from.
      if (draft?.base === JSON.stringify(initialConfig) && draft.config) return draft.config;
    } catch { /* A blocked session store should not prevent editing. */ }
    return initialConfig;
  });
  const [savedConfig, setSavedConfig] = useState(() => JSON.stringify(initialConfig));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [windowOpen, setWindowOpen] = useState(true);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const copy = t().settings.experience;
  const locale = activeLocale();
  const ui = productCopy(locale);
  const styles = agentStyleCopy(locale);
  const selectedStyle = matchingAgentStyle(agentConfig);
  const dirty = JSON.stringify(agentConfig) !== savedConfig;
  const preview = normalizeAgentConfig(agentConfig, automaticConfig);
  // Resolve the widget's own copy the way the widget does, rather than reading `preview.copy`
  // straight. The generated welcome is written in one language (`generatedLocale`); a visitor
  // reading another one gets the widget's built-in catalog instead. Rendering the raw config
  // would put Chinese inside an English console and, worse, show an appearance preview that
  // disagrees with what visitors actually see.
  const chrome = resolveChromeCopy(preview, locale);
  // One source for both what the editor puts in the box and what counts as
  // untouched when it is saved. Computing the automatic value a second time at
  // save is how a value nobody typed became a customisation.
  // Resolved from the knowledge-derived layer, never from the edited config.
  // Both the override and the resolved copy of an edited config are the text
  // someone just typed, so measuring "unchanged" against either compares their
  // new sentence with itself and discards a real edit. This is what a box
  // falls back to when nothing has been written, and what unchanged means.
  const automaticChrome = resolveChromeCopy(automaticConfig, locale);
  const shownAutomatic = {
    displayName: automaticChrome.displayName,
    welcomeTitle: automaticChrome.welcomeTitle,
    welcomeDescription: automaticChrome.welcomeDescription,
    suggestions: automaticChrome.suggestions,
  };
  const currentPalette = agentConfig.appearance?.palette || "blue";
  const currentPreset = agentConfig.appearance?.preset || "orb";
  const siteUrl = overview.profile.entryUrl || overview.connection?.origin;

  useEffect(() => {
    try {
      if (dirty) sessionStorage.setItem(draftKey, JSON.stringify({ base: savedConfig, config: agentConfig }));
      else sessionStorage.removeItem(draftKey);
    } catch { /* Editing remains available when browser storage is full. */ }
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [agentConfig, dirty, draftKey, savedConfig]);

  function patchOverrides(patch: Partial<NonNullable<AgentConfig["overrides"]>>) {
    setMessage("");
    // Preserve the text being typed; trim and normalise only for preview/save.
    setAgentConfig(current => ({ ...current, overrides: { ...current.overrides, ...patch } }));
  }
  function patchAppearance(patch: Partial<NonNullable<AgentConfig["appearance"]>>) {
    setMessage("");
    setAgentConfig(current => {
      const appearance = { ...(current.appearance || defaultAgentConfig().appearance!), ...patch };
      const palette = AGENT_PALETTES[appearance.palette];
      return { ...current, appearance, theme: { ...current.theme, accentColor: palette.accentColor, accentTextColor: palette.accentTextColor, panelBackground: palette.panelBackground, launcherPosition: appearance.launcherPosition } };
    });
  }
  function feature(key: keyof AgentConfig["features"], value: boolean) {
    setMessage(""); setAgentConfig(current => ({ ...current, features: { ...current.features, [key]: value } }));
  }
  async function saveAgentConfig(event?: FormEvent) {
    event?.preventDefault();
    if (!dirty || savingRef.current) return;
    savingRef.current = true; setSaving(true); setMessage(""); setSaveError(false);
    const normalized = normalizeAgentConfig(withoutUnchangedOverrides(agentConfig, shownAutomatic), automaticConfig);
    try {
      const response = await fetch(`/api/site-agents/${encodeURIComponent(overview.id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentConfig: normalized }) });
      if (!response.ok) throw new Error("save_failed");
      setAgentConfig(normalized); setSavedConfig(JSON.stringify(normalized)); setMessage(ui.applied); onSaved();
    } catch { setSaveError(true); setMessage(copy.saveFailed); }
    finally { setSaving(false); savingRef.current = false; }
  }
  function restoreDefaults() {
    setAgentConfig(normalizeAgentConfig({ reset: true }, automaticConfig));
    setMessage(""); setConfirmingReset(false);
  }
  const fields = [
    // The automatic value shown here is the resolved one, so the field and the preview beside
    // it never contradict each other about what an untouched site says to its visitors.
    { key: "displayName" as const, label: copy.displayName, fallback: shownAutomatic.displayName, max: 60 },
    { key: "welcomeTitle" as const, label: copy.welcomeTitle, fallback: shownAutomatic.welcomeTitle, max: 80 },
    { key: "welcomeDescription" as const, label: copy.welcomeDescription, fallback: shownAutomatic.welcomeDescription, max: 180 },
  ];
  const pinnedSuggestions = agentConfig.overrides?.pinnedSuggestions || [];
  // Filled in, not hinted at. A placeholder shows the question a visitor is
  // being offered but leaves nothing to edit: changing one word meant typing
  // the whole sentence again. The boxes carry the current questions, and a set
  // that comes back unchanged is not recorded as a choice.
  //
  // Once a list has been written it is the whole list, empties included. Filling
  // a blank box back in from the site's own questions made a cleared one
  // reappear — and, because a saved list drops its empties and closes up, come
  // back as a duplicate of the question above it. Emptying every box is how you
  // ask for the site's own questions again.
  const suggestions = pinnedSuggestions.length
    ? [0, 1, 2].map((index) => pinnedSuggestions[index] ?? "")
    : [0, 1, 2].map((index) => shownAutomatic.suggestions[index] ?? "");
  return <section className="sw-agent-studio">
    <form className="sw-studio-editor" onSubmit={saveAgentConfig} onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void saveAgentConfig(); }
    }}>
      <div className="sw-studio-intro"><p>{ui.agentIntro}</p><button type="button" className="sw-text-button" onClick={() => setConfirmingReset(true)} disabled={saving}>{ui.restore}</button></div>
      <fieldset disabled={saving}>
        <section className="sw-studio-group sw-quick-setup">
          <header><h2>{styles.title}</h2><p>{styles.hint}</p></header>
          <div className="sw-style-presets" role="group" aria-label={styles.title}>{AGENT_STYLES.map(style => <button type="button" key={style.id} aria-pressed={selectedStyle === style.id} onClick={() => { setAgentConfig(current => applyAgentStyle(current, style.id)); setMessage(styles.applied); setSaveError(false); }}>
            <span className={`sw-style-thumbnail ${style.surface}`} style={{ "--style-accent": AGENT_PALETTES[style.palette].accentColor, "--style-text": AGENT_PALETTES[style.palette].accentTextColor } as CSSProperties} aria-hidden="true"><span className="sw-mini-window"><i /><span /><span /><b /></span><span className={`sw-mini-launcher ${style.preset}`} /></span>
            <strong>{locale === "en" ? style.en : style.zh}<span aria-hidden="true">{selectedStyle === style.id ? "✓" : ""}</span></strong><small>{locale === "en" ? style.hintEn : style.hintZh}</small>
          </button>)}</div>
          {!selectedStyle && <p className="sw-field-hint">{styles.custom}</p>}
        </section>
        <section className="sw-studio-group">
          <header><h2>{ui.identity}</h2><p>{ui.identityHint}</p></header>
          {fields.map(field => <div className="sw-studio-field" key={field.key}>
            <div className="sw-field-label"><label htmlFor={`agent-${field.key}`}>{field.label}</label>{agentConfig.overrides?.[field.key] !== undefined && <button type="button" className="sw-text-button" onClick={() => patchOverrides({ [field.key]: undefined })} aria-label={`${copy.useAutomatic} · ${field.label}`}>{copy.useAutomatic}</button>}</div>
            {field.key === "welcomeDescription" ? <textarea id={`agent-${field.key}`} rows={3} maxLength={field.max} value={agentConfig.overrides?.[field.key] ?? field.fallback} onChange={event => patchOverrides({ [field.key]: event.target.value })} /> : <input id={`agent-${field.key}`} maxLength={field.max} value={agentConfig.overrides?.[field.key] ?? field.fallback} onChange={event => patchOverrides({ [field.key]: event.target.value })} />}
          </div>)}
          <details className="sw-welcome-templates"><summary>{styles.templates}</summary><p>{styles.templateHint}</p><div>{(["concise", "guiding"] as const).map(tone => <button type="button" className="sw-secondary-button" key={tone} onClick={() => patchOverrides({ welcomeTitle: tone === "concise" ? styles.titleConcise : styles.titleGuiding, welcomeDescription: tone === "concise" ? styles.bodyConcise : styles.bodyGuiding })}>{styles[tone]}</button>)}</div></details>
          <p className="sw-field-hint">{ui.defaults}</p>
        </section>
        <section className="sw-studio-group">
          <header><h2>{ui.appearance}</h2><p>{ui.appearanceHint}</p></header>
          <div className="sw-studio-row"><span>{copy.launcherStyle}</span><div className="sw-segment-control" role="group" aria-label={copy.launcherStyle}>
            {([["orb", copy.launcherIcon], ["minimal", copy.launcherText], ...(currentPreset === "dock" ? [["dock", copy.launcherLegacy]] : [])] as Array<[NonNullable<AgentConfig["appearance"]>["preset"], string]>).map(([value, label]) => <button type="button" key={value} aria-pressed={currentPreset === value} onClick={() => patchAppearance({ preset: value })}>{label}</button>)}
          </div></div>
          <div className="sw-studio-row"><span>{styles.surface}</span><div className="sw-segment-control" role="group" aria-label={styles.surface}>{(["clean", "soft", "contrast"] as const).map(value => <button type="button" key={value} aria-pressed={(agentConfig.appearance?.surface || "clean") === value} onClick={() => patchAppearance({ surface: value })}>{styles[value]}</button>)}</div></div>
          <div className="sw-studio-row"><span>{copy.brandColor}</span><div className="sw-studio-colors" role="group" aria-label={copy.brandColor}>{Object.entries(AGENT_PALETTES).map(([id, palette]) => <button type="button" key={id} aria-label={locale === "en" ? id : palette.label} title={locale === "en" ? id : palette.label} aria-pressed={currentPalette === id} onClick={() => patchAppearance({ palette: id as NonNullable<AgentConfig["appearance"]>["palette"] })}><i style={{ background: palette.accentColor }} />{currentPalette === id && <span aria-hidden="true">✓</span>}</button>)}</div></div>
          <div className="sw-studio-row"><span>{copy.launcherPosition}</span><div className="sw-segment-control" role="group" aria-label={copy.launcherPosition}>{(["bottom-left", "bottom-right"] as const).map(position => <button type="button" key={position} aria-pressed={agentConfig.appearance?.launcherPosition === position} onClick={() => patchAppearance({ launcherPosition: position })}>{position === "bottom-left" ? copy.bottomLeft : copy.bottomRight}</button>)}</div></div>
        </section>
        <section className="sw-studio-group">
          <label className="sw-toggle-row"><span><strong>{ui.suggestions}</strong><small>{ui.suggestionsHint}</small></span><input type="checkbox" role="switch" checked={agentConfig.features.showSuggestions} onChange={event => feature("showSuggestions", event.target.checked)} /></label>
          {agentConfig.features.showSuggestions && <details className="sw-question-editor"><summary>{ui.editQuestions}</summary><div className="sw-question-fields">{[0, 1, 2].map(index => <label key={index}><span aria-hidden="true">{index + 1}</span><input aria-label={ui.question(index + 1)} maxLength={SUGGESTION_MAX_LENGTH} value={suggestions[index]} placeholder={ui.questionPlaceholder} onChange={event => { const next = [...suggestions]; next[index] = event.target.value; patchOverrides({ pinnedSuggestions: next }); }} /></label>)}</div></details>}
        </section>
        <details className="sw-studio-group sw-studio-options"><summary>{ui.behavior}</summary>
          <label className="sw-toggle-row"><span><strong>{copy.showNewChat}</strong><small>{ui.newChatHint}</small></span><input type="checkbox" role="switch" checked={agentConfig.features.showNewChat} onChange={event => feature("showNewChat", event.target.checked)} /></label>
          <label className="sw-toggle-row"><span><strong>{copy.showTeachAfterFailure}</strong><small>{ui.teachHint}</small></span><input type="checkbox" role="switch" checked={agentConfig.features.showTeachAfterFailure} onChange={event => feature("showTeachAfterFailure", event.target.checked)} /></label>
        </details>
      </fieldset>
      <footer className="sw-studio-save"><span role="status" className={saveError ? "error" : ""}>{message || (dirty ? ui.draft : ui.applyHint)}</span><div>{dirty && <button type="button" className="sw-secondary-button" disabled={saving} onClick={() => { setAgentConfig(JSON.parse(savedConfig)); setMessage(""); }}>{ui.discard}</button>}<button className="sw-primary-button" type="submit" disabled={!dirty || saving}>{saving ? copy.saving : ui.apply}</button></div></footer>
    </form>
    <aside className="sw-studio-preview">
      <header><h2>{ui.preview}</h2><div className="sw-segment-control" role="group" aria-label={ui.preview}>{(["desktop", "mobile"] as const).map(value => <button type="button" key={value} aria-pressed={device === value} onClick={() => setDevice(value)}>{ui[value]}</button>)}</div></header>
      <div className={`sw-preview-canvas ${device} ${preview.appearance?.launcherPosition}`} style={{ "--agent-accent": preview.theme.accentColor, "--agent-accent-text": preview.theme.accentTextColor } as CSSProperties}>
        <div className="sw-canvas-chrome"><span /><span /><span /><small>{overview.profile.name}</small></div>
        {windowOpen ? <section className={`sw-chat-preview surface-${preview.appearance?.surface || "clean"}`}>
          <header><img src="/brand/sitewake-mark.svg?v=wstar-1" alt="" /><b>{chrome.displayName}</b><button type="button" aria-label={ui.collapse} title={ui.collapse} onClick={() => setWindowOpen(false)}>×</button></header>
          <div className="sw-chat-welcome"><h3>{chrome.welcomeTitle}</h3><p>{chrome.welcomeDescription}</p>{preview.features.showSuggestions && chrome.suggestions.length > 0 && <ul>{chrome.suggestions.slice(0, 3).map((item, index) => <li key={`${index}:${item}`}>{item}<span aria-hidden="true">↗</span></li>)}</ul>}</div>
          <footer><div className="sw-preview-composer"><span>{chrome.composerPlaceholder}</span><i aria-hidden="true">↑</i></div><small>{chrome.poweredByText}</small></footer>
        </section> : <button type="button" className={`sw-preview-launcher ${currentPreset}`} onClick={() => setWindowOpen(true)} aria-label={ui.expand}><img src="/brand/sitewake-mark.svg?v=wstar-1" alt="" />{currentPreset !== "orb" && <span>{chrome.displayName}</span>}</button>}
      </div>
      <div className="sw-preview-mode" role="group" aria-label={ui.preview}><button type="button" aria-pressed={windowOpen} onClick={() => setWindowOpen(true)}>{ui.window}</button><button type="button" aria-pressed={!windowOpen} onClick={() => setWindowOpen(false)}>{ui.launcher}</button></div>
      <p>{ui.previewHint}</p>{siteUrl && <a href={siteUrl} target="_blank" rel="noopener noreferrer">{ui.trySite} <span aria-hidden="true">↗</span></a>}
    </aside>
    <ConfirmDialog open={confirmingReset} title={ui.restore} body={<p>{ui.defaults} {ui.applyHint}</p>} confirmLabel={ui.restore} busy={saving} onConfirm={() => restoreDefaults()} onCancel={() => setConfirmingReset(false)} />
  </section>;
}
