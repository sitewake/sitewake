import type { SiteKnowledge } from "../site-knowledge/knowledge-model";

/**
 * Export of the raw knowledge-base JSON. Moved from the site knowledge page to
 * "settings → data": engineers fetch raw data there, and the knowledge page is left for
 * developers to see what the agent understands.
 */

export function knowledgeExportAvailable(knowledge?: SiteKnowledge): knowledge is SiteKnowledge {
  return Boolean(knowledge && Array.isArray(knowledge.scenes));
}

/** The file must be complete, so it is always serialized whole. */
export function serializeKnowledge(knowledge: SiteKnowledge): string {
  return JSON.stringify(knowledge, null, 2);
}

export function knowledgeFileName(siteAgentId: string, version: number): string {
  return `${siteAgentId}-knowledge-v${version}.json`;
}

/** Triggers a download in the browser; returns false outside one. */
export function downloadKnowledge(siteAgentId: string, knowledge: SiteKnowledge): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof Blob === "undefined") return false;
  const blob = new Blob([serializeKnowledge(knowledge)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = knowledgeFileName(siteAgentId, knowledge.version);
  anchor.click();
  URL.revokeObjectURL(url);
  return true;
}
