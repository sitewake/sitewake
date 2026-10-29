import { withRequestTiming } from "@/lib/http/request-timing";
import { listCapabilities } from "@/db/capability-center-v2-store";
import { scopeMatchesRequest } from "@/lib/capability-center-v2/semantic-analyzer";
import { resolveCapabilityRun } from "@/lib/capability-center-v2/run-resolution";
import type { JsonValue } from "@/lib/capability-center-v2/model";
import { capabilityAgentAuthorized, capabilityJson, capabilityOptions, siteIdFromRequest, errorResponse } from "../../http";

export async function OPTIONS() { return capabilityOptions(); }

async function handlePOST(request: Request) {
  let body: { siteId?: string; queries?: unknown; limit?: number; goal?: string; input?: unknown; currentUrl?: string };
  try { body = await request.json() as typeof body; } catch { return capabilityJson({ error: "invalid_json" }, 400); }
  const siteId = siteIdFromRequest(request, body);
  if (!(await capabilityAgentAuthorized(request, siteId))) return capabilityJson({ error: "unauthorized" }, 401);
  const queries = Array.isArray(body.queries) ? body.queries.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 20) : [];
  if (!siteId || !queries.length) return capabilityJson({ error: "site_id_and_queries_required" }, 400);
  try {
    const { capabilities } = await listCapabilities(siteId, { includeDeleted: false });
    const terms = queries.map((item) => item.toLocaleLowerCase("zh-CN").trim()).filter(Boolean);
    const requestInput = body.input && typeof body.input === "object" && !Array.isArray(body.input) ? body.input as Record<string, JsonValue> : {};
    const items = capabilities.filter((item) => item.status === "Active").flatMap((item) => {
      // Judged on the page it would run on, as the runtime judges it.
      const runPage = resolveCapabilityRun(item.contract, { currentUrl: typeof body.currentUrl === "string" ? body.currentUrl : undefined, input: requestInput });
      const scopeMatch = scopeMatchesRequest(item.contract.scope, { goal: body.goal || queries.join(" "), input: requestInput, currentUrl: runPage.startUrl });
      // Retrieval is not invocation: missing inputs can be bound by the Agent,
      // and page scope can be reached by navigation. Runtime enforces the scope.
      // Return the constraint with the contract rather than hiding the tool.
      // `searchText` is intentionally compact and may contain the canonical
      // site-language terms (for example `cushion`) while a live user goal is
      // expressed through an input alias (for example `垫子`).  Include the
      // public intent/alias vocabulary in the retrieval projection so a
      // capability is found before the runtime model is asked to route it.
      const aliases = item.contract && typeof item.contract === "object"
        ? item.contract.inputAliases && typeof item.contract.inputAliases === "object"
          ? Object.entries(item.contract.inputAliases as Record<string, unknown>).flatMap(([, values]) => values && typeof values === "object" && !Array.isArray(values) ? Object.keys(values as Record<string, unknown>) : [])
          : []
        : [];
      const intent = item.contract && typeof item.contract === "object" && typeof (item.contract as { intent?: unknown }).intent === "string"
        ? String((item.contract as { intent: string }).intent)
        : "";
      const searchableText = `${item.searchText} ${intent} ${aliases.join(" ")}`.toLocaleLowerCase("zh-CN");
      const matchedQueries = terms.filter((term) => [...term].some((character) => searchableText.includes(character)) && [...term].filter((character) => searchableText.includes(character)).length / Math.max(1, [...term].length) >= .35);
      const matchedFragments = searchableText.split(/\s+/).filter((fragment) => terms.some((term) => fragment.includes(term) || term.includes(fragment))).slice(0, 8);
      const characterScore = matchedQueries.length ? Math.min(1, matchedQueries.reduce((sum, term) => sum + [...term].filter((character) => searchableText.includes(character)).length / Math.max(1, [...term].length), 0) / matchedQueries.length) : 0;
      const aliasHits = terms.flatMap((term) => aliases.filter((alias) => term.includes(alias) || alias.includes(term)));
      const aliasScore = aliases.length && aliasHits.length ? Math.min(1, new Set(aliasHits).size / Math.min(2, aliases.length)) : 0;
      // An input alias alone (for example “商品”) is too generic to recall a
      // side-effecting capability. It may boost a candidate only when the
      // query also shares at least one intent character/fragment.
      const score = Math.max(characterScore, matchedQueries.length ? aliasScore : 0);
      return [{ capabilityId: item.id, name: item.name, description: item.description, aliases: item.aliases, contract: item.contract, matchedQueries, matchedFragments, score, status: item.status, scopeMatchReason: scopeMatch.reason }];
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(50, Math.max(1, body.limit || 30)));
    return capabilityJson({ items });
  } catch (error) { return errorResponse(error, "capability_search_failed"); }
}

export const POST = withRequestTiming("capability.catalog", handlePOST);
