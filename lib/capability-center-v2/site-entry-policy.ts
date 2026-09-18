import { getSiteAgentOverview } from "../../db/site-agent-store";
import { CapabilityCenterV2Error } from "../../db/capability-center-v2-store";

export async function assertCapabilityStartUrl(siteId: string, value: unknown) {
  if (typeof value !== "string" || !value.trim()) return;
  const { overview } = await getSiteAgentOverview(siteId);
  const registeredOrigin = overview.connection?.origin || (overview.connection?.url ? new URL(overview.connection.url).origin : undefined);
  if (!registeredOrigin || new URL(value).origin !== new URL(registeredOrigin).origin) throw new CapabilityCenterV2Error("start_url_origin_invalid", "start_url_origin_invalid", 403);
}
