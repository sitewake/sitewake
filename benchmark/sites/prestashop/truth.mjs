// Facts about the PrestaShop demo shop, read over HTTP from the running site:
// every category's products with prices, the cheapest of each, and search
// result counts. Writes truth.json next to tasks.json.
//
// The shop answers only its installed domain (prestashop.bench), so from the
// host the requests go to the published port with that Host header.
//
//   node benchmark/sites/prestashop/truth.mjs [--check]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { all, first, money } from "../../../scripts/benchmark/html.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const site = JSON.parse(readFileSync(join(here, "site.json"), "utf8"));
const canonical = new URL(site.internalUrl);
const address = new URL(process.env.BENCH_IN_NETWORK === "1" ? site.internalUrl : site.hostUrl);

function page(path, hops = 0) {
  return new Promise((resolvePage, reject) => {
    const request = http.request({ host: address.hostname, port: address.port || 80, path, method: "GET", headers: { host: canonical.host, accept: "text/html" }, timeout: 30_000 }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && hops < 5) {
          const next = new URL(response.headers.location, `http://${canonical.host}`);
          resolvePage(page(`${next.pathname}${next.search}`, hops + 1));
          return;
        }
        if (response.statusCode !== 200) { reject(new Error(`${path} → ${response.statusCode}`)); return; }
        resolvePage(Buffer.concat(chunks).toString("utf8"));
      });
    });
    request.on("timeout", () => request.destroy(new Error(`${path} timed out`)));
    request.on("error", reject);
    request.end();
  });
}

function miniatures(html) {
  return [...html.matchAll(/<article[^>]*class="[^"]*product-miniature[^"]*"[^>]*>([\s\S]*?)<\/article>/g)].map(([, card]) => ({
    name: first(card, /class="[^"]*product-title[^"]*"[^>]*>\s*<a[^>]*>([^<]+)</) || first(card, /<a[^>]*class="[^"]*product-title[^"]*"[^>]*>([^<]+)</),
    price: money(first(card, /<span[^>]*class="price"[^>]*>([^<]+)</) || ""),
  })).filter((item) => item.name);
}

async function category(path) {
  const products = [];
  for (let number = 1; number <= 5; number += 1) {
    const html = await page(`${path}${path.includes("?") ? "&" : "?"}page=${number}`);
    const found = miniatures(html);
    products.push(...found.filter((item) => !products.some((seen) => seen.name === item.name)));
    if (!/rel="next"/.test(html) || !found.length) break;
  }
  const byPrice = [...products].sort((a, b) => a.price - b.price);
  return { count: products.length, cheapest: byPrice[0], mostExpensive: byPrice.at(-1), names: products.map((item) => item.name) };
}

async function search(term) {
  const html = await page(`/search?controller=search&s=${encodeURIComponent(term)}`);
  const total = first(html, /There (?:are|is) (\d+) products?/);
  return { count: total ? Number(total) : miniatures(html).length, products: miniatures(html) };
}

const home = await page("/");
// The menu's link text is nested markup for the top-level categories, so the
// category is read from its address: /3-clothes is "clothes".
const categoryLinks = all(home, /<li class="category"[^>]*>\s*<a[^>]*href="([^"]*\/\d+-([a-z-]+))"/).map(([href, slug]) => ({ slug, path: new URL(href, `http://${canonical.host}`).pathname }));
const categories = {};
for (const slug of ["clothes", "accessories", "art"]) {
  const link = categoryLinks.find((item) => item.slug === slug);
  if (link) categories[slug] = await category(link.path);
}
const allProducts = [...new Set(Object.values(categories).flatMap((item) => item.names))];
const searches = { mug: await search("mug"), cushion: await search("cushion"), notebook: await search("notebook"), unicorn: await search("unicorn lamp") };
const priceOf = (name) => Object.values(searches).flatMap((item) => item.products).find((item) => item.name === name)?.price;
const pick = (pattern) => allProducts.find((name) => pattern.test(name));
const truth = {
  computedAt: new Date().toISOString(),
  categories,
  search: Object.fromEntries(Object.entries(searches).map(([term, item]) => [term, item.count])),
  products: {
    brownBearCushion: pick(/brown bear cushion/i),
    mountainFoxCushion: pick(/mountain fox cushion/i),
    bestMug: pick(/mug the best is yet to come/i),
    brownBearNotebook: pick(/brown bear notebook/i),
    tshirt: categories.clothes?.names.find((name) => /t-shirt/i.test(name)),
    sweater: categories.clothes?.names.find((name) => /sweater/i.test(name)),
  },
};
truth.products.tshirtPrice = truth.products.tshirt ? (await search(truth.products.tshirt)).products.find((item) => item.name === truth.products.tshirt)?.price : undefined;
truth.products.sweaterPrice = truth.products.sweater ? (await search(truth.products.sweater)).products.find((item) => item.name === truth.products.sweater)?.price : undefined;
truth.products.bestMugPrice = priceOf(truth.products.bestMug);

const out = join(here, "truth.json");
const current = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined;
const same = current && JSON.stringify({ ...current, computedAt: 0 }) === JSON.stringify({ ...truth, computedAt: 0 });
if (process.argv.includes("--check")) { console.log(same ? "prestashop truth.json is current" : "prestashop truth.json is stale; rerun truth.mjs"); process.exit(same ? 0 : 1); }
writeFileSync(out, `${JSON.stringify(truth, null, 2)}\n`);
console.log(`prestashop: ${Object.entries(categories).map(([name, item]) => `${name} ${item.count}`).join(", ")}; mugs ${truth.search.mug}; t-shirt ${truth.products.tshirt} $${truth.products.tshirtPrice}`);
