import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_STYLES, applyAgentStyle } from "../lib/console/agent-style-presets.ts";
import { defaultAgentConfig, normalizeAgentConfig } from "../lib/site-knowledge/protocol.ts";

test("quick styles preserve identity, copy, suggestions, behavior and position", () => {
  const current = normalizeAgentConfig({ overrides: { displayName: "Custom name", welcomeTitle: "Custom greeting", pinnedSuggestions: ["My question"] }, appearance: { launcherPosition: "bottom-left" }, features: { showNewChat: false } });
  for (const style of AGENT_STYLES) {
    const result = applyAgentStyle(current, style.id);
    assert.deepEqual(result.overrides, current.overrides);
    assert.deepEqual(result.features, current.features);
    assert.equal(result.appearance.launcherPosition, "bottom-left");
    const saved = normalizeAgentConfig(result, current);
    assert.equal(saved.appearance.surface, style.surface);
    assert.equal(saved.appearance.preset, style.preset);
    assert.equal(saved.appearance.palette, style.palette);
    assert.equal(saved.copy.welcomeTitle, current.copy.welcomeTitle);
  }
});

test("old settings default to clean, and an explicit clean style replaces a saved soft style", () => {
  assert.equal(normalizeAgentConfig(defaultAgentConfig()).appearance.surface, "clean");
  const soft = normalizeAgentConfig({ appearance: { surface: "soft" } });
  assert.equal(normalizeAgentConfig({ appearance: { surface: "clean" } }, soft).appearance.surface, "clean");
  assert.equal(normalizeAgentConfig({ appearance: { surface: "unknown" } }, soft).appearance.surface, "soft");
});
