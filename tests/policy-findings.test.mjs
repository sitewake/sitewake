import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/**
 * From "the browser refused this" to "change your policy to exactly this".
 *
 * The inputs here are the shape a real Chromium produces — see
 * tests/csp-request-inventory.test.mjs, which measures that a browser names
 * the governing directive even when `default-src` is what matched. That is why
 * every expectation below derives the directive from the policy text.
 */

async function bundled(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { policyVerdictFromViolations, policyPatch, policyOrigin } = await bundled("../lib/console/policy-findings.ts");

const CONSOLE = "https://console.acme.test";
const violation = (overrides) => ({
  blockedUrl: `${CONSOLE}/sitewake.js`,
  effectiveDirective: "script-src-elem",
  violatedDirective: "script-src-elem",
  disposition: "enforce",
  policy: "default-src 'self'",
  ...overrides,
});

test("a bare default-src is patched by adding the specific directives, never by widening it", () => {
  const verdict = policyVerdictFromViolations({
    consoleOrigin: CONSOLE,
    violations: [
      violation({}),
      violation({ blockedUrl: `${CONSOLE}/api/site-agents/shop/connection`, effectiveDirective: "connect-src", violatedDirective: "connect-src" }),
    ],
  });
  assert.equal(verdict.source, "measured");
  assert.equal(verdict.blocked, true);
  assert.deepEqual(verdict.findings.filter((finding) => finding.blocked).map((finding) => finding.kind), ["script", "api"]);

  assert.equal(verdict.patches.length, 1);
  const [patch] = verdict.patches;
  assert.equal(patch.before, "default-src 'self'");
  // default-src is left exactly as it was; the new directives carry over what
  // it allowed so the site's own resources keep loading.
  //
  // The patch covers every kind this policy refuses, not only the two that
  // were reached: a refused script never runs, so the requests it would have
  // made were never attempted. Patching only what was observed would send a
  // reader round the loop once per directive.
  assert.equal(
    patch.after,
    `default-src 'self'; script-src-elem 'self' ${CONSOLE}; connect-src 'self' ${CONSOLE}; style-src-elem 'self' ${CONSOLE}; img-src 'self' ${CONSOLE}`,
  );
  assert.deepEqual(patch.directives, ["script-src-elem", "connect-src", "style-src-elem", "img-src"]);
  assert.equal(patch.strictDynamic, false);

  // The same change, one directive at a time: what a person is shown instead
  // of a policy that can run to several kilobytes. None of these directives is
  // in the policy, so each is stated in full rather than as an append.
  assert.deepEqual(patch.edits, [
    { directive: "script-src-elem", add: CONSOLE, present: false, sources: ["'self'", CONSOLE] },
    { directive: "connect-src", add: CONSOLE, present: false, sources: ["'self'", CONSOLE] },
    { directive: "style-src-elem", add: CONSOLE, present: false, sources: ["'self'", CONSOLE] },
    { directive: "img-src", add: CONSOLE, present: false, sources: ["'self'", CONSOLE] },
  ]);
});

test("a directive the site already writes is extended, not replaced", () => {
  const patch = policyPatch({
    policy: "default-src 'self'; script-src 'self' https://cdn.acme.test; img-src *",
    kinds: ["script", "api"],
    origin: CONSOLE,
  });
  assert.equal(
    patch.after,
    `default-src 'self'; script-src 'self' https://cdn.acme.test ${CONSOLE}; img-src *; connect-src 'self' ${CONSOLE}`,
  );
  // The existing script-src is kept whole; connect-src is new and inherits
  // from default-src. Stated as edits, that is one append and one new line.
  assert.deepEqual(patch.directives, ["script-src", "connect-src"]);
  assert.deepEqual(patch.edits.map(({ directive, present }) => ({ directive, present })), [
    { directive: "script-src", present: true },
    { directive: "connect-src", present: false },
  ]);
});

test("each enforcing policy gets its own patch, because a browser applies both", () => {
  const verdict = policyVerdictFromViolations({
    consoleOrigin: CONSOLE,
    violations: [
      violation({ policy: "default-src 'self'", source: "header" }),
      violation({ policy: "default-src 'self' https://cdn.acme.test", source: "meta" }),
    ],
  });
  assert.equal(verdict.patches.length, 2);
  assert.deepEqual(verdict.patches.map((patch) => patch.source), ["header", "meta"]);
  assert.match(verdict.patches[1].after, new RegExp(`^default-src 'self' https://cdn\\.acme\\.test; script-src-elem 'self' https://cdn\\.acme\\.test ${CONSOLE}`));
});

test("a report-only refusal is reported and never called a blocker", () => {
  const verdict = policyVerdictFromViolations({
    consoleOrigin: CONSOLE,
    violations: [violation({ disposition: "report" })],
  });
  assert.equal(verdict.blocked, false);
  assert.deepEqual(verdict.patches, []);
  const script = verdict.findings.find((finding) => finding.kind === "script");
  assert.equal(script.blocked, false);
  assert.equal(script.disposition, "report");
});

test("under strict-dynamic the patch is marked, because an allowlisted origin is ignored", () => {
  const verdict = policyVerdictFromViolations({
    consoleOrigin: CONSOLE,
    violations: [
      violation({ policy: `script-src 'strict-dynamic' 'nonce-abc'; default-src 'self'` }),
      violation({
        blockedUrl: `${CONSOLE}/api/x`, effectiveDirective: "connect-src", violatedDirective: "connect-src",
        policy: `script-src 'strict-dynamic' 'nonce-abc'; default-src 'self'`,
      }),
    ],
  });
  const [patch] = verdict.patches;
  assert.equal(patch.strictDynamic, true);
  // connect-src is untouched by strict-dynamic, so that part of the advice
  // still stands — measured in csp-request-inventory.
  assert.match(patch.after, new RegExp(`connect-src 'self' ${CONSOLE}`));
});

test("only what the console serves is reported; the site's own violations are its business", () => {
  const verdict = policyVerdictFromViolations({
    consoleOrigin: CONSOLE,
    violations: [
      violation({ blockedUrl: "https://ads.example/pixel.js" }),
      violation({ blockedUrl: "inline", effectiveDirective: "style-src-elem", violatedDirective: "style-src-elem" }),
    ],
  });
  assert.equal(verdict.blocked, false);
  assert.deepEqual(verdict.patches, []);
});

test("where to change the policy is named only when the response proves it", () => {
  assert.equal(policyOrigin([["x-vercel-id", "hkg1::abc"]]), "vercel");
  assert.equal(policyOrigin([["X-NF-Request-Id", "abc"]]), "netlify");
  assert.equal(policyOrigin([["server", "nginx/1.25.3"]]), "nginx");
  assert.equal(policyOrigin([["cf-ray", "8a1b"]]), "cloudflare");
  // Nothing recognisable: say nothing rather than send someone to the wrong file.
  assert.equal(policyOrigin([["server", "unknown-edge"]]), undefined);
  assert.equal(policyOrigin([]), undefined);
});
