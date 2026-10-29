// Facts about the Books to Scrape mirror, read from the mirrored files:
// every category with its books, prices and ratings, the cheapest and dearest
// of each, and a few named books. Writes truth.json next to tasks.json.
//
//   node benchmark/sites/books/truth.mjs [--check]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { all, first, money } from "../../../scripts/benchmark/html.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.BENCH_ARTIFACTS || join(here, "..", "..", "..", ".artifacts", "benchmark");
const www = join(root, "sites", "books", "www");
if (!existsSync(join(www, "index.html"))) { console.error(`books mirror missing at ${www}; run npm run benchmark:mirror`); process.exit(2); }

const RATINGS = { One: 1, Two: 2, Three: 3, Four: 4, Five: 5 };
const read = (path) => readFileSync(join(www, path), "utf8");

function pods(html) {
  return [...html.matchAll(/<article class="product_pod">([\s\S]*?)<\/article>/g)].map(([, pod]) => ({
    title: first(pod, /<h3><a [^>]*title="([^"]+)"/),
    price: money(first(pod, /<p class="price_color">([^<]+)</) || ""),
    rating: RATINGS[first(pod, /star-rating (\w+)/) || ""] || 0,
    href: first(pod, /<h3><a href="([^"]+)"/),
  }));
}

function listing(path) {
  const books = [];
  let next = path;
  while (next) {
    const html = read(next);
    books.push(...pods(html));
    const link = first(html, /<li class="next"><a href="([^"]+)"/);
    next = link ? join(dirname(next), link) : undefined;
  }
  return books;
}

const home = read("index.html");
const categories = all(home, /<a href="(catalogue\/category\/books\/[^"]+\/index\.html)">\s*([^<]+?)\s*<\/a>/).map(([href, name]) => {
  const books = listing(href);
  const byPrice = [...books].sort((a, b) => a.price - b.price);
  return {
    name, count: books.length,
    cheapest: byPrice[0], mostExpensive: byPrice.at(-1),
    fiveStar: books.filter((book) => book.rating === 5).map((book) => book.title),
  };
});
const byName = Object.fromEntries(categories.map((category) => [category.name.toLowerCase(), category]));
const firstPage = pods(home);
const truth = {
  computedAt: new Date().toISOString(),
  categoryCount: categories.length,
  travel: byName.travel, poetry: byName.poetry, mystery: byName.mystery, classics: byName.classics,
  firstPage: { count: firstPage.length, titles: firstPage.map((book) => book.title) },
  named: Object.fromEntries(firstPage.slice(0, 3).map((book) => [book.title, book.price])),
};

const out = join(here, "truth.json");
const current = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined;
const same = current && JSON.stringify({ ...current, computedAt: 0 }) === JSON.stringify({ ...truth, computedAt: 0 });
if (process.argv.includes("--check")) { console.log(same ? "books truth.json is current" : "books truth.json is stale; rerun truth.mjs"); process.exit(same ? 0 : 1); }
writeFileSync(out, `${JSON.stringify(truth, null, 2)}\n`);
console.log(`books: ${categories.length} categories; travel cheapest ${truth.travel?.cheapest?.title} £${truth.travel?.cheapest?.price}; poetry ${truth.poetry?.count}`);
