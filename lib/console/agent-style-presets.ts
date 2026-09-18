import { AGENT_PALETTES, defaultAgentConfig, type AgentConfig } from "../site-knowledge/protocol";
import type { Locale } from "../i18n";

export const AGENT_STYLES = [
  { id: "classic", palette: "blue", preset: "orb", surface: "clean", zh: "经典", en: "Classic", hintZh: "清晰、轻巧", hintEn: "Clear and familiar" },
  { id: "quiet", palette: "ink", preset: "minimal", surface: "clean", zh: "极简", en: "Minimal", hintZh: "黑白、克制", hintEn: "Quiet monochrome" },
  { id: "friendly", palette: "mint", preset: "orb", surface: "soft", zh: "柔和", en: "Soft", hintZh: "圆润、亲近", hintEn: "Warm and rounded" },
  { id: "expressive", palette: "violet", preset: "minimal", surface: "contrast", zh: "鲜明", en: "Expressive", hintZh: "突出品牌色", hintEn: "A bolder accent" },
] as const;
export type AgentStyleId = typeof AGENT_STYLES[number]["id"];
export function applyAgentStyle(current: AgentConfig, id: AgentStyleId): AgentConfig {
  const style = AGENT_STYLES.find(item => item.id === id)!;
  const palette = AGENT_PALETTES[style.palette];
  return { ...current,
    appearance: { ...(current.appearance || defaultAgentConfig().appearance!), preset: style.preset, palette: style.palette, surface: style.surface },
    theme: { ...current.theme, accentColor: palette.accentColor, accentTextColor: palette.accentTextColor, panelBackground: palette.panelBackground },
  };
}
export function matchingAgentStyle(config: AgentConfig): AgentStyleId | undefined {
  return AGENT_STYLES.find(style => style.palette === config.appearance?.palette && style.preset === config.appearance?.preset && style.surface === (config.appearance?.surface || "clean"))?.id;
}
const zh = { title: "快速配置", hint: "选一个起点，再按需微调。保留你的文案和入口位置。", custom: "自定义风格", surface: "窗口样式", clean: "简洁", soft: "柔和", contrast: "鲜明", templates: "使用欢迎语模板", concise: "简洁介绍", guiding: "引导提问", templateHint: "只替换欢迎标题和说明，保存后生效。", applied: "风格已预览，保存后应用到网站。", titleConcise: "有什么可以帮你？", bodyConcise: "告诉我你想在这里完成什么。", titleGuiding: "从你想做的事开始", bodyGuiding: "可以直接提问，也可以描述一个目标。我会根据网站提供的信息协助你。" };
const en: typeof zh = { title: "Quick setup", hint: "Choose a starting point, then fine-tune. Your wording and launcher position stay as they are.", custom: "Custom style", surface: "Window style", clean: "Clean", soft: "Soft", contrast: "Bold", templates: "Use a welcome template", concise: "Simple greeting", guiding: "Invite a question", templateHint: "Only replaces the greeting title and description. Save to apply.", applied: "Style previewed. Save to apply it to your site.", titleConcise: "How can I help?", bodyConcise: "Tell me what you would like to do here.", titleGuiding: "Start with what you want to do", bodyGuiding: "Ask a question or describe a goal. I’ll help using the information available on this site." };
export function agentStyleCopy(locale: Locale) { return locale === "en" ? en : zh; }
