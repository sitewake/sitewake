/**
 * A stub that cannot fall behind the module it replaces.
 *
 * Several suites bundle a route or a store with esbuild and use `onLoad` to swap
 * a real module for an inline stub — the database, the model configuration, the
 * HTTP helpers. The stub is written once, by hand, listing the exports the test
 * happens to need. Then the real module gains an export, something under test
 * imports it, and esbuild stops with
 *
 *   No matching export in "app/api/site-agents/http.ts" for import "persistenceHeaders"
 *
 * which looks like the product failing to build. `management-api-auth` sat in the
 * skip list for exactly that, with `persistenceHeaders` exported on line 156 of
 * the real file the whole time. Reading that error and concluding "the stub is
 * old, not the product" took a round; across a dozen such suites it is a tax on
 * everyone who ever sees the suite red.
 *
 * So the names come from the real module and the bodies come from the test. An
 * export the test said nothing about becomes a function that throws when called,
 * naming itself. Three outcomes, all better than a build error:
 *
 *   - nothing calls it: the bundle builds and the suite is unaffected
 *   - something calls it: the failure says which export needs a body here
 *   - the test stubs a name that is gone: that is reported too
 *
 * Returning `undefined` instead of throwing was the first shape of this, and it
 * was worse than the problem: a route that used the return value answered 500,
 * and ten passing tests went red with no indication why.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DECLARATION = /^export\s+(?:async\s+function|function|const|let|class)\s+([A-Za-z0-9_$]+)/gm;

/**
 * The names a module exports, as written in its source.
 *
 * Takes a path or a `file:` URL. A URL's `pathname` is percent-encoded, so
 * passing one through as a path breaks the moment a directory name contains a
 * space — which is how this suite failed in a clone under "SiteWake Github"
 * while passing everywhere else.
 */
export function exportedNames(target) {
  const absolutePath = typeof target === "string" && target.startsWith("file:")
    ? fileURLToPath(target)
    : target instanceof URL ? fileURLToPath(target) : target;
  const source = readFileSync(absolutePath, "utf8");
  const names = [...source.matchAll(DECLARATION)].map((match) => match[1]);
  // `export { a, b }` and `export { a as b } from "..."` lists.
  for (const list of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of list[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z0-9_$]+$/.test(name)) names.push(name);
    }
  }
  return [...new Set(names)];
}

/** A body for an export this test never meant to use. */
function unstubbed(name) {
  const message = `${name} is stubbed with no body: this suite replaced its module and now something calls ${name}. Give it a body in the stub.`;
  return `export function ${name}() { if (process.env.SITEWAKE_STUB_TRACE) console.error("stub call:", ${JSON.stringify(name)}); throw new Error(${JSON.stringify(message)}); }`;
}

/**
 * Source for a stub of `absolutePath`.
 *
 * `bodies` maps an export name to the source of its replacement — a whole
 * declaration, so a test can stub a function, a class or a constant. Every other
 * export becomes a function that throws when called.
 *
 * A name in `bodies` that the real module does not export throws, because that
 * is the stub drifting in the other direction: holding an opinion about
 * something that is gone.
 */
export function stubModule(absolutePath, bodies = {}, { preamble = "" } = {}) {
  const names = exportedNames(absolutePath);
  const unknown = Object.keys(bodies).filter((name) => !names.includes(name));
  if (unknown.length) {
    throw new Error(`${absolutePath} no longer exports ${unknown.join(", ")} — the stub is stubbing something that does not exist`);
  }
  // `preamble` is for the shared state and helpers the bodies close over. Losing
  // it is silent: the bodies compile, then fail at call time on an undefined
  // helper, and a route reports that as 500.
  return [preamble, ...names.map((name) => bodies[name] ?? unstubbed(name))].filter(Boolean).join("\n");
}

/** An esbuild plugin that stubs modules by path pattern. */
export function stubPlugin(stubs) {
  return {
    name: "reconciled-module-stubs",
    setup(builder) {
      for (const [filter, { path, bodies }] of stubs) {
        builder.onLoad({ filter }, () => ({ contents: stubModule(path, bodies), loader: "ts" }));
      }
    },
  };
}
