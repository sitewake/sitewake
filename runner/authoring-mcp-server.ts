import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const bridgeUrl = String(process.env.SITEWAKE_AUTHORING_BRIDGE_URL || "").replace(/\/$/, "");
const bridgeToken = String(process.env.SITEWAKE_AUTHORING_BRIDGE_TOKEN || "");

if (!bridgeUrl || !bridgeToken) throw new Error("authoring_mcp_bridge_missing");

async function invoke(tool: string, input: Record<string, unknown> = {}) {
  const response = await fetch(`${bridgeUrl}/tool`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bridgeToken}` },
    body: JSON.stringify({ tool, input }),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(payload.error || `authoring_tool_${response.status}`));
  return payload;
}

const result = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  structuredContent: payload && typeof payload === "object" ? payload as Record<string, unknown> : { value: payload },
});

const server = new McpServer({ name: "sitewake-authoring", version: "1.0.0" });

server.registerTool("get_dom", {
  description: "Inspect the real page progressively. Without selector it returns a compact semantic overview; with selector it returns paged raw HTML for that subtree.",
  inputSchema: {
    selector: z.string().optional(),
    snapshotId: z.string().optional(),
    cursor: z.string().optional(),
  },
}, async (input) => result(await invoke("get_dom", input)));

server.registerTool("execute_js", {
  description: "Execute native JavaScript in the current real page while Playwright tracks same-tab navigation and new pages.",
  inputSchema: { source: z.string().min(1), args: z.unknown().optional() },
}, async ({ source, args }) => result(await invoke("execute_js", { source, args })));

server.registerTool("write_file", {
  description: "Write the complete authored capability source. The only accepted path is capability.ts; call this after observing enough page evidence and before run_draft.",
  inputSchema: {
    path: z.literal("capability.ts"),
    content: z.string().min(1),
  },
}, async ({ path, content }) => result(await invoke("write_file", { path, content })));

server.registerTool("run_draft", {
  description: "Bundle capability.ts and execute its exact JS stages from the clean capability start page.",
  inputSchema: { input: z.record(z.string(), z.unknown()).default({}) },
}, async ({ input }) => result(await invoke("run_draft", { input })));

await server.connect(new StdioServerTransport());
