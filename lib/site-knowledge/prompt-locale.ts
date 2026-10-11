/**
 * Output language of generative prompts.
 *
 * **Prompts themselves are not in the dictionary.** They are working instructions for
 * the model, written in whichever language is most precise, regardless of who views
 * the UI; translating a prompt is usually wrong. What matters is **what language it
 * produces**, because that output becomes text on screen.
 *
 * Three kinds by who reads the output, each handled differently:
 *
 *  A. **Read only by code** (structured JSON, enums, verdict codes) — ignore; the
 *     prompt language is an implementation detail.
 *  B. **Shown immediately to a known person** (widget replies, judge summaries) — append
 *     a language instruction for that person's locale. See replyLanguageInstruction in
 *     client/user-agent-copy.ts.
 *  C. **Stored and read later by people of different languages** (page type names,
 *     business domains, capability names) — the hard part is not knowing the future
 *     reader at generation time: the same name is seen by the operator in the console
 *     and by visitors in the widget. This file serves kind C.
 *
 * The current approach for C is "fix one language at generation and record it on the
 * data" (AgentConfig.generatedLocale, capability localizedNames). Readers fall back to
 * the generic dictionary when languages do not match. So this file does exactly one
 * thing: make the output language a **parameter** instead of hard-coding it in the
 * prompt string.
 */

export type KnowledgeLocale = "zh" | "en";

export const DEFAULT_KNOWLEDGE_LOCALE: KnowledgeLocale = "zh";

/**
 * The word that names the output language inside the prompt.
 *
 * Expressed in Chinese ("英文" rather than "English"): the prompt is written in
 * Chinese throughout, and a foreign word in the instruction only adds room for
 * misreading. This switches **what language the model must produce**, not the
 * prompt's own language.
 */
export function languageName(locale: KnowledgeLocale = DEFAULT_KNOWLEDGE_LOCALE) {
  return locale === "en" ? "英文" : "中文";
}

/**
 * The output-language constraint appended to the prompt.
 *
 * A separate sentence, rather than relying on "English name" inside a long
 * instruction, because the model easily treats a language requirement mid-paragraph
 * as an aside. As a standalone last sentence it lands far more reliably.
 */
export function outputLanguageInstruction(locale: KnowledgeLocale = DEFAULT_KNOWLEDGE_LOCALE) {
  return locale === "en"
    ? "所有面向人阅读的字段（名称、说明、描述）一律用英文输出，即使输入的页面内容是中文。"
    : "所有面向人阅读的字段（名称、说明、描述）一律用中文输出。";
}
