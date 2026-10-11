import type { SiteAgentReleaseV2, SiteConnection } from "./protocol";

/**
 * A site that holds nothing: the empty shell left by registering an address.
 *
 * Adoption of the id found on the page deletes such a shell, so "empty" has to
 * mean "deleting it loses nothing". It deliberately does not look at the
 * release version: registering a site publishes release 0 and the onboarding
 * wizard's own profile save publishes release 1 before the user ever reaches
 * the install step, so a version test calls every real site non-empty and the
 * whole delete-and-re-add path never opens. What matters is learned content.
 */
export function siteAgentShellIsEmpty(site: {
  connection?: SiteConnection;
  activeRelease: Pick<SiteAgentReleaseV2, "scenes" | "capabilities" | "operations" | "targets">;
}) {
  if (site.connection) return false;
  const release = site.activeRelease;
  return [release.scenes, release.capabilities, release.operations, release.targets]
    .every((items) => !items || items.length === 0);
}
