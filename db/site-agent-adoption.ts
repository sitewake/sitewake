/**
 * Adopting the site id found on the page.
 *
 * A site id lives in two places: the control-plane database and the
 * `data-site-agent="…"` line on the customer's page. We cannot change the latter. After
 * delete-and-re-add, or when the site was registered with a custom id, the page's id
 * points at a site that no longer exists — the runner sees it, but the handshake can
 * only 404. Here an **empty** site adopts that unowned id: recreate the same
 * registration under the new id, then delete the empty shell.
 *
 * Only ids the runner itself observed at the site's registered address count (the
 * latest successful preview's detectedSiteAgentIds); nothing the client claims does.
 * Only a site with no connection, no knowledge and no crawl job may adopt — deleting it
 * loses nothing. The handshake path is not involved: `/connection` is unauthenticated
 * with a forgeable Origin and must never create or delete sites.
 */
import { SiteAgentDataError } from "../lib/site-knowledge/errors";
import { normalizeDetectedSiteAgentIds } from "../lib/site-knowledge/site-preview-detection";
import {
  createSiteAgent,
  getActiveSiteAgentRelease,
  getSiteAgentOverview,
  listCrawlJobs,
  siteAgentExists,
  updateSiteAgent,
} from "./site-agent-store";
import { deleteSiteAgent } from "./site-agent-deletion";

export type SiteAgentAdoptionResult = {
  /** The site id after adoption — the one on the page. */
  siteAgentId: string;
  /** The deleted empty shell. */
  replacedSiteAgentId: string;
  persistence: "memory" | "d1";
};

function rejected(code: string, status: number) {
  return new SiteAgentDataError(code, code, "site_agent_lookup", { status, retryable: false });
}

/** Definition of an "empty" site: no connection record, initial knowledge version, no crawl job. */
export async function siteAgentIsFresh(siteAgentId: string) {
  const { overview } = await getSiteAgentOverview(siteAgentId);
  if (overview.connection) return false;
  if (overview.activeRelease.version !== 0 || overview.activeRelease.scenes.length > 0) return false;
  const { jobs } = await listCrawlJobs(siteAgentId);
  return jobs.length === 0;
}

export async function adoptInstalledSiteAgentId(currentSiteAgentId: string, requestedSiteAgentId: string): Promise<SiteAgentAdoptionResult> {
  const current = currentSiteAgentId.trim();
  const requested = normalizeDetectedSiteAgentIds([requestedSiteAgentId])[0] || "";
  if (!current || !(await siteAgentExists(current))) throw rejected("site_agent_not_found", 404);
  if (!requested || requested === current) throw rejected("site_agent_install_id_invalid", 400);
  if (await siteAgentExists(requested)) throw rejected("site_agent_id_taken", 409);

  const { overview } = await getSiteAgentOverview(current);
  // Based on the runner's observation: the latest successful preview at the registered address must have seen the id.
  const observed = normalizeDetectedSiteAgentIds(overview.sitePreview?.detectedSiteAgentIds);
  if (!observed.includes(requested)) throw rejected("site_agent_install_id_unobserved", 409);
  if (!(await siteAgentIsFresh(current))) throw rejected("site_agent_not_fresh", 409);

  const profile = overview.activeRelease.profile;
  const { release } = await getActiveSiteAgentRelease(current);
  // Create then delete: a failed create changes nothing; a failed delete leaves a spare empty shell and the caller retries.
  const created = await createSiteAgent({
    id: requested,
    name: profile.name,
    description: profile.description,
    url: profile.entryUrl,
    visibility: profile.visibility,
    profile: profile.allowedOrigins?.length ? { allowedOrigins: profile.allowedOrigins } : undefined,
  });
  if (created.siteAgentId !== requested) throw rejected("site_agent_install_id_invalid", 400);
  if (release.agentConfig) await updateSiteAgent(requested, { agentConfig: release.agentConfig });
  const deleted = await deleteSiteAgent(current);
  return { siteAgentId: requested, replacedSiteAgentId: current, persistence: deleted.persistence };
}
