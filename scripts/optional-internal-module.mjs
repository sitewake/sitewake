import { fileURLToPath } from "node:url";

/**
 * Loads a module that exists only in the maintainers' repository (under
 * `scripts/internal/`, which `git archive` omits). A public checkout has no such
 * module, and that is the one condition treated as "not available": the
 * ERR_MODULE_NOT_FOUND must be about this module itself. A module that exists
 * but fails to load — including because one of *its* imports is missing —
 * throws as usual, so a real defect never masquerades as an absent feature.
 */
export async function loadOptionalInternalModule(specifier, importer) {
  const url = new URL(specifier, importer);
  try {
    return await import(url.href);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && missingModuleOf(error) === fileURLToPath(url)) return null;
    throw error;
  }
}

// Node reports the missing file as `error.url`; older messages only carry it in
// the text. The importer also appears in the message, so a plain substring
// check would mistake a missing *dependency* of the module for the module.
function missingModuleOf(error) {
  if (typeof error.url === "string") return fileURLToPath(error.url);
  return /Cannot find module '([^']+)'/.exec(String(error.message))?.[1] ?? "";
}
