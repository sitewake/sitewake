import { getProgramModule } from "@/db/site-agent-store";

type RouteContext = { params: Promise<{ path: string[] }> | { path: string[] } };

export async function GET(request: Request, context: RouteContext) {
  const { path } = await context.params;
  const contentHash = (path.at(-1) || "").replace(/\.js$/, "");
  const program = await getProgramModule(contentHash);
  if (!program) return new Response("program_not_found", { status: 404 });
  const etag = `\"${program.contentHash}\"`;
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
  return new Response(program.source, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=31536000, immutable",
      etag,
      "x-content-type-options": "nosniff",
    },
  });
}
