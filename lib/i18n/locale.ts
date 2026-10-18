/**
 * The locale union and the resolver for authored text — deliberately free of any copy
 * catalog, so the injected widget bundle can import it.
 *
 * `lib/i18n/index.ts` pulls in both console catalogs; anything the widget reaches must
 * not go through it. Keeping these three declarations here is what lets the widget
 * resolve a contract's field labels without shipping the console's dictionary to every
 * visitor of a customer's site.
 */
export type Locale = "zh" | "en";

/**
 * Text the authoring model wrote, carried in both languages and resolved at render.
 *
 * Authored metadata cannot live in a copy catalog: a capability's display name or a
 * contract's field label is written per site, by the model, after this build shipped.
 * The established answer is to store both languages beside each other — see
 * `localizedNames` on the capability model — and pick one when rendering. `zhCN` rather
 * than `zh` is the stored key, matching what the model is asked to emit.
 */
export type LocalizedStrings = { zhCN?: string; en?: string };

/**
 * A missing or blank translation falls back to the plain stored value, so metadata
 * authored before localisation renders exactly as it did.
 */
export function localizedValue(locale: Locale, localized: LocalizedStrings | undefined, fallback = ""): string {
  const picked = locale === "zh" ? localized?.zhCN : localized?.en;
  return picked?.trim() || fallback.trim();
}
