import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/**
 * The three conditions, in the order a reader settles them — and what each one
 * is allowed to claim.
 */

async function bundled(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { installConditions, conditionsBlocked, developmentPair } = await bundled("../lib/console/install-conditions.ts");
const { publicMachineAddresses } = await bundled("../lib/console/public-address-check.ts");

const CONSOLE = "https://console.acme.test";
const clean = { source: "measured", blocked: false, findings: [], patches: [] };

test("an address a visitor cannot use leaves everything below it unjudged", () => {
  const conditions = installConditions({
    siteUrl: "https://shop.example/",
    sdkOrigin: "http://203.0.113.9:3000",
    addressUsable: false,
    readiness: { siteUrl: "https://shop.example/", csp: { source: "header", missing: ["script-src"] } },
    policy: { source: "measured", blocked: true, findings: [], patches: [{ before: "x", after: "y", directives: [], strictDynamic: false }] },
  });
  assert.deepEqual(conditions.map((condition) => [condition.id, condition.state]), [
    ["address", "unmet"],
    ["site-address", "pending"],
    ["policy", "pending"],
  ]);
  // Nothing about the policy leaks out while the address is unsettled, even
  // though a verdict for it exists.
  assert.equal(conditions[2].verdict, undefined);
  assert.equal(conditionsBlocked(conditions), true);
});

test("both ends on this machine is development, and reports nothing at all", () => {
  assert.equal(developmentPair("http://localhost:5173/", "http://localhost:3000"), true);
  assert.equal(developmentPair("https://shop.example/", "http://localhost:3000"), false);
  assert.deepEqual(installConditions({ siteUrl: "http://localhost:5173/", sdkOrigin: "http://localhost:3000", addressUsable: false }), []);
});

test("a settled address lets the site's own two conditions be judged", () => {
  const conditions = installConditions({
    siteUrl: "https://shop.example/",
    sdkOrigin: CONSOLE,
    addressUsable: true,
    readiness: { siteUrl: "https://shop.example/", originMismatch: { registered: "https://shop.example", actual: "https://other.example" } },
    policy: clean,
  });
  assert.deepEqual(conditions.map((condition) => [condition.id, condition.state]), [
    ["address", "met"],
    ["site-address", "unmet"],
    ["policy", "met"],
  ]);
  assert.equal(conditions[1].actual, "https://other.example");
});

test("a site that could not be read is undetermined, not clean", () => {
  const conditions = installConditions({
    siteUrl: "https://shop.example/",
    sdkOrigin: CONSOLE,
    addressUsable: true,
    readiness: { siteUrl: "https://shop.example/", unreachable: { reason: "network", detail: "ENOTFOUND" } },
    policy: { source: "unknown" },
  });
  assert.deepEqual(conditions.map((condition) => [condition.id, condition.state]), [
    ["address", "met"],
    ["site-address", "unknown"],
    ["policy", "unknown"],
  ]);
  // Undetermined is not a blocker: the snippet is still worth installing, and
  // the check runs again afterwards.
  assert.equal(conditionsBlocked(conditions), false);
});

test("an address that looks right but does not answer is caught by the rehearsal", () => {
  // The shape rules pass — https, not local — so nothing else would notice a
  // stale domain or a typo in the installer's default. The rehearsal put the
  // real snippet in the page: it was there, no policy refused anything, and
  // the SDK still never booted. That is the address, not the website.
  const stale = installConditions({
    siteUrl: "https://shop.example/",
    sdkOrigin: "https://console.moved-away.test",
    addressUsable: true,
    policy: clean,
    rehearsal: { ran: true, snippetPresent: true, connected: false },
  });
  assert.equal(stale[0].state, "unmet");
  assert.equal(stale[0].reason, "unreachable");
  assert.deepEqual(stale.slice(1).map((condition) => condition.state), ["pending", "pending"]);

  // The same evidence with a policy that did block proves nothing about the
  // address: the script was refused before it could load from anywhere.
  const blockedByPolicy = installConditions({
    siteUrl: "https://shop.example/",
    sdkOrigin: CONSOLE,
    addressUsable: true,
    policy: { source: "measured", blocked: true, findings: [], patches: [] },
    rehearsal: { ran: true, snippetPresent: true, connected: false },
  });
  assert.equal(blockedByPolicy[0].state, "met");
  assert.equal(blockedByPolicy[2].state, "unmet");

  // And a rehearsal where the SDK did boot says the address is fine.
  const working = installConditions({
    siteUrl: "https://shop.example/",
    sdkOrigin: CONSOLE,
    addressUsable: true,
    policy: clean,
    rehearsal: { ran: true, snippetPresent: true, connected: true },
  });
  assert.equal(working[0].state, "met");
});

test("a container's own addresses are never offered as a DNS target", () => {
  // Measured on the production server: inside the stack every interface
  // address is private, and telling a reader to point their A record at
  // 172.18.0.5 is worse than saying nothing.
  assert.deepEqual(publicMachineAddresses(["172.18.0.5", "10.0.0.4", "192.168.1.8", "127.0.0.1", "169.254.1.1", "fd00::1", "fe80::1"]), []);
  assert.deepEqual(publicMachineAddresses(["203.0.113.58", "172.18.0.5"]), ["203.0.113.58"]);
  assert.deepEqual(publicMachineAddresses(["2001:db8::1", "fd00::2"]), ["2001:db8::1"]);
  assert.deepEqual(publicMachineAddresses([]), []);
});
