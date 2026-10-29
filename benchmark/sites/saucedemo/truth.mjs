// Facts about the Swag Labs mirror. The shop is a single-page app whose
// inventory is compiled into its JavaScript bundle; the names and prices are
// read from there. Writes truth.json next to tasks.json.
//
//   node benchmark/sites/saucedemo/truth.mjs [--check]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.BENCH_ARTIFACTS || join(here, "..", "..", "..", ".artifacts", "benchmark");
const www = join(root, "sites", "saucedemo", "www");
if (!existsSync(join(www, "index.html"))) { console.error(`saucedemo mirror missing at ${www}; run npm run benchmark:mirror`); process.exit(2); }

function* jsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsFiles(path);
    else if (entry.name.endsWith(".js")) yield path;
  }
}
const products = new Map();
for (const file of jsFiles(www)) {
  const source = readFileSync(file, "utf8");
  // The bundle writes its strings with backticks or quotes depending on the build.
  for (const match of source.matchAll(/name:\s*[`"']((?:Sauce Labs|Test\.allTheThings\(\))[^`"']+)[`"'][^}]*?price:\s*([\d.]+)/g)) products.set(match[1], Number(match[2]));
}
if (!products.size) { console.error("no inventory found in the mirrored bundle"); process.exit(2); }
const sorted = [...products.entries()].sort((a, b) => a[1] - b[1]).map(([name, price]) => ({ name, price }));
const index = readFileSync(join(www, "index.html"), "utf8");
const truth = {
  computedAt: new Date().toISOString(),
  productCount: sorted.length,
  cheapest: sorted[0],
  mostExpensive: sorted.at(-1),
  products: sorted,
  standardUser: /standard_user/.test(index) || [...jsFiles(www)].some((file) => readFileSync(file, "utf8").includes("standard_user")) ? "standard_user" : undefined,
};
const out = join(here, "truth.json");
const current = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined;
const same = current && JSON.stringify({ ...current, computedAt: 0 }) === JSON.stringify({ ...truth, computedAt: 0 });
if (process.argv.includes("--check")) { console.log(same ? "saucedemo truth.json is current" : "saucedemo truth.json is stale; rerun truth.mjs"); process.exit(same ? 0 : 1); }
writeFileSync(out, `${JSON.stringify(truth, null, 2)}\n`);
console.log(`saucedemo: ${sorted.length} products; cheapest ${truth.cheapest.name} $${truth.cheapest.price}`);
