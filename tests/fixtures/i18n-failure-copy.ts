// The two catalogs' failure copy, bundled for a test that must read both
// without taking on the console's module graph.
import { en } from "../../lib/i18n/en";
import { zh } from "../../lib/i18n/zh";

export const failureCopy = {
  en: en.capability.v2.failure as Record<string, string>,
  zh: zh.capability.v2.failure as Record<string, string>,
};
