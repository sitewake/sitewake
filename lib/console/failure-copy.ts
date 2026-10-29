import { t, type Locale } from "../i18n";

/** The worded class, from the console's dictionary; the raw class id only when the dictionary has no word for it. */
export function failureClassLabel(locale: Locale, failureClass: string) {
  const labels = t(locale).capability.v2.screen.failureClasses as Record<string, string>;
  return labels[failureClass] || failureClass;
}

/** "class · stage", the first line of a failure wherever the console shows one. */
export function failureAttributionLabel(locale: Locale, failureClass: string, failureStage?: string) {
  const label = failureClassLabel(locale, failureClass);
  return failureStage ? `${label} · ${failureStage}` : label;
}
