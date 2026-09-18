import { getCapabilityV2Module } from "@/db/capability-center-v2-module-store";
import { CAPABILITY_V2_MODULE_MIME } from "@/lib/capability-center-v2/javascript-runtime";

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

export async function GET(request: Request, context: { params: Promise<{ contentHash: string }> | { contentHash: string } }) {
  const siteId = new URL(request.url).searchParams.get("siteId")?.trim() || "";
  const params = await context.params;
  const contentHash = decodeURIComponent(params.contentHash || "").replace(/\.mjs$/i, "");
  if (!siteId || !/^[a-f0-9]{64}$/.test(contentHash)) return new Response("module_not_found", { status: 404, headers: cors });
  try {
    const stored = await getCapabilityV2Module(siteId, contentHash);
    if (!stored) return new Response("module_not_found", { status: 404, headers: cors });
    return new Response(stored.source, {
      status: 200,
      headers: {
        ...cors,
        "content-type": CAPABILITY_V2_MODULE_MIME,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "x-capability-module-sha256": stored.contentHash,
        etag: `"${stored.contentHash}"`,
      },
    });
  } catch (error) {
    return new Response(error instanceof Error ? error.message : "module_read_failed", { status: 409, headers: cors });
  }
}
