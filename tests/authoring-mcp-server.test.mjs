import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("Codex MCP discovers SiteWake tools and calls the live authoring bridge", async () => {
  const received = [];
  const token = "test-authoring-token";
  const bridge = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ authorization: request.headers.authorization, ...body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data: { url: "https://site.test/results", summary: "results", elements: [] } }));
  });
  await new Promise((resolveListen, reject) => { bridge.once("error", reject); bridge.listen(0, "127.0.0.1", resolveListen); });
  const address = bridge.address();
  assert.ok(address && typeof address !== "string");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("node_modules/tsx/dist/cli.mjs"), resolve("runner/authoring-mcp-server.ts")],
    env: {
      ...process.env,
      SITEWAKE_AUTHORING_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
      SITEWAKE_AUTHORING_BRIDGE_TOKEN: token,
    },
  });
  const client = new Client({ name: "authoring-mcp-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["execute_js", "get_dom", "run_draft", "write_file"]);
    const call = await client.callTool({ name: "get_dom", arguments: { selector: "main" } });
    assert.equal(call.isError, undefined);
    assert.equal(received.length, 1);
    assert.equal(received[0].authorization, `Bearer ${token}`);
    assert.deepEqual(received[0], { authorization: `Bearer ${token}`, tool: "get_dom", input: { selector: "main" } });
  } finally {
    await client.close().catch(() => undefined);
    await new Promise((resolveClose) => bridge.close(() => resolveClose()));
  }
});
