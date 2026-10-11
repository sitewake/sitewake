import test from "node:test";
import assert from "node:assert/strict";
import {
  attributePublicAddressFailure,
  localHostname,
  normalizePublicAddress,
  publicAddressVerified,
} from "../lib/console/public-address-check.ts";

/**
 * The address visitors load SiteWake from, and the three places a reader gets
 * stuck on the way to having one. Every message the console shows for this
 * comes out of these functions, so each case a user can land in is a test.
 */

test("an address that cannot serve a public website is refused before anything is fetched", () => {
  // The two shapes no page on the internet can load, whatever else is true.
  assert.deepEqual(normalizePublicAddress("http://203.0.113.9:3000"), { reason: "insecure", detail: "http://203.0.113.9:3000" });
  assert.deepEqual(normalizePublicAddress("https://localhost:3000"), { reason: "local", detail: "localhost" });
  assert.deepEqual(normalizePublicAddress("https://192.168.1.20"), { reason: "local", detail: "192.168.1.20" });
  assert.deepEqual(normalizePublicAddress("https://mac.local"), { reason: "local", detail: "mac.local" });
  assert.deepEqual(normalizePublicAddress(""), { reason: "malformed", detail: "empty" });
  assert.deepEqual(normalizePublicAddress("not an address"), { reason: "malformed", detail: "not an address" });

  // A bare hostname is read as https, which is the only scheme that can work.
  assert.deepEqual(normalizePublicAddress("console.acme.com"), { origin: "https://console.acme.com" });
  assert.deepEqual(normalizePublicAddress("https://console.acme.com/whatever?x=1"), { origin: "https://console.acme.com" });
  assert.deepEqual(normalizePublicAddress("https://console.acme.com:8443"), { origin: "https://console.acme.com:8443" });
});

test("local addresses are recognised the way a browser classifies them", () => {
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.0.1", "169.254.1.1", "box.local"]) {
    assert.equal(localHostname(host), true, host);
  }
  for (const host of ["console.acme.com", "203.0.113.10", "172.32.0.1", "example.internal.com"]) {
    assert.equal(localHostname(host), false, host);
  }
});

test("reaching this control plane from either side is what makes an address verified", () => {
  const installationId = "install-a";
  // The server reached it: done, whatever the browser saw.
  assert.equal(publicAddressVerified({
    serverProbe: { ok: true, installationId },
    browserProbe: { ok: false, error: "TypeError: Failed to fetch" },
    installationId,
  }), true);
  // NAT hairpinning: the server cannot reach its own public name while every
  // visitor can. The browser's attempt is the one that answers the question.
  assert.equal(publicAddressVerified({
    serverProbe: { ok: false, error: "AbortError: timeout" },
    browserProbe: { ok: true, installationId },
    installationId,
  }), true);
  // Reached something, but not this installation.
  assert.equal(publicAddressVerified({
    serverProbe: { ok: true, installationId: "install-b" },
    installationId,
  }), false);
  assert.equal(publicAddressVerified({ serverProbe: { ok: false, error: "ECONNREFUSED" }, installationId }), false);
});

test("a failure is attributed to the one step the reader has to go and do", () => {
  const installationId = "install-a";

  // Reached a SiteWake that is not this one: the reverse proxy points somewhere else.
  const other = attributePublicAddressFailure({
    serverProbe: { ok: true, installationId: "install-bbbbbbbb" },
    installationId,
  });
  assert.equal(other.reason, "other-installation");

  // The name does not resolve at all.
  const unresolved = attributePublicAddressFailure({
    serverProbe: { ok: false, error: "Error: getaddrinfo ENOTFOUND console.acme.com" },
    installationId,
    resolved: [],
    expected: ["203.0.113.9"],
  });
  assert.equal(unresolved.reason, "dns");

  // It resolves, but to another machine: both values are carried so the
  // message can show them.
  const elsewhere = attributePublicAddressFailure({
    serverProbe: { ok: false, error: "AbortError: timeout" },
    installationId,
    resolved: ["198.51.100.4"],
    expected: ["203.0.113.9"],
  });
  assert.deepEqual(elsewhere, { reason: "dns", detail: "resolved elsewhere", resolved: ["198.51.100.4"], expected: ["203.0.113.9"] });

  // Right machine, certificate not ready.
  const certificate = attributePublicAddressFailure({
    serverProbe: { ok: false, error: "Error: unable to verify the first certificate" },
    installationId,
    resolved: ["203.0.113.9"],
    expected: ["203.0.113.9"],
  });
  assert.equal(certificate.reason, "tls");

  // Right machine, nothing listening: the cause cannot be narrowed further, so
  // it is reported as unreachable with what was resolved, not guessed at.
  const refused = attributePublicAddressFailure({
    serverProbe: { ok: false, error: "Error: connect ECONNREFUSED 203.0.113.9:443" },
    installationId,
    resolved: ["203.0.113.9"],
    expected: ["203.0.113.9"],
  });
  assert.deepEqual(refused, { reason: "unreachable", detail: "Error: connect ECONNREFUSED 203.0.113.9:443", resolved: ["203.0.113.9"] });

  // Nothing known about this machine's own addresses: a resolvable name that
  // will not answer is not called a DNS problem.
  const noExpectation = attributePublicAddressFailure({
    serverProbe: { ok: false, error: "AbortError: timeout" },
    installationId,
    resolved: ["198.51.100.4"],
    expected: [],
  });
  assert.equal(noExpectation.reason, "unreachable");
});

/**
 * The settings module pulls in the runtime-settings store, so it is bundled
 * like its siblings. A bundle carries its own copy of that store's memory, so
 * `label` gives a case its own instance — which is how "another installation"
 * is modelled here.
 */
async function bundledModule(entry, label = "") {
  const { build } = await import("esbuild");
  const { fileURLToPath } = await import("node:url");
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
  });
  const source = `${result.outputFiles[0].text}\n// ${label}`;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

test("the saved address wins over the installer's default, and takes effect without a restart", async () => {
  const address = await bundledModule("../lib/public-address.ts", "saved-address");
  const previous = process.env.SITEWAKE_PUBLIC_ORIGIN;
  process.env.SITEWAKE_PUBLIC_ORIGIN = "http://203.0.113.9:3000";
  try {
    // A fresh install: what the installer wrote, marked as coming from there.
    await address.loadPublicAddress(null);
    assert.deepEqual(address.getPublicAddress(), { origin: "http://203.0.113.9:3000", source: "env" });

    // Saving replaces it for every reader in the process, with no reload.
    await address.savePublicAddress("https://console.acme.com", null);
    assert.deepEqual(address.getPublicAddress(), { origin: "https://console.acme.com", source: "console" });

    // And it is what the next start reads back, whatever the environment still says.
    await address.loadPublicAddress(null);
    assert.deepEqual(address.getPublicAddress(), { origin: "https://console.acme.com", source: "console" });

    // Nothing configured anywhere is a state of its own, not an error.
    delete process.env.SITEWAKE_PUBLIC_ORIGIN;
    const fresh = await bundledModule("../lib/public-address.ts", "unconfigured");
    await fresh.loadPublicAddress(null);
    assert.deepEqual(fresh.getPublicAddress(), { origin: "", source: "none" });
  } finally {
    if (previous === undefined) delete process.env.SITEWAKE_PUBLIC_ORIGIN;
    else process.env.SITEWAKE_PUBLIC_ORIGIN = previous;
  }
});

test("the installation identifier is stable for this installation and unique between installations", async () => {
  const first = await bundledModule("../lib/public-address.ts", "first-installation");
  const previous = process.env.SITEWAKE_INSTALLATION_ID;
  delete process.env.SITEWAKE_INSTALLATION_ID;
  try {
    const id = await first.ensureInstallationId(null);
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(await first.ensureInstallationId(null), id, "同一进程内稳定");

    // A restart re-reads the stored value rather than minting a new one.
    first.resetInstallationId();
    assert.equal(await first.ensureInstallationId(null), id, "重启后仍是同一个");

    // A separate installation (its own store) gets its own identifier.
    const second = await bundledModule("../lib/public-address.ts", "second-installation");
    assert.notEqual(await second.ensureInstallationId(null), id);
  } finally {
    if (previous === undefined) delete process.env.SITEWAKE_INSTALLATION_ID;
    else process.env.SITEWAKE_INSTALLATION_ID = previous;
  }
});
