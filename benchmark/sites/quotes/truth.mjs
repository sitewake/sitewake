// Facts about the Quotes to Scrape mirror: quotes per tag and per author, and
// who said a given line. Writes truth.json next to tasks.json.
//
//   node benchmark/sites/quotes/truth.mjs [--check]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { all, first, textOf } from "../../../scripts/benchmark/html.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.BENCH_ARTIFACTS || join(here, "..", "..", "..", ".artifacts", "benchmark");
const www = join(root, "sites", "quotes", "www");
if (!existsSync(join(www, "index.html"))) { console.error(`quotes mirror missing at ${www}; run npm run benchmark:mirror`); process.exit(2); }
const read = (path) => readFileSync(join(www, path), "utf8");

const quotes = [];
let next = "index.html";
while (next) {
  const html = read(next);
  for (const [, block] of html.matchAll(/<div class="quote"[^>]*>([\s\S]*?)<div class="tags">([\s\S]*?)<\/div>\s*<\/div>/g)) {
    const text = textOf(first(block, /<span class="text"[^>]*>([\s\S]*?)<\/span>/) || "").replace(/^[“"]|[”"]$/g, "");
    const author = first(block, /<small class="author"[^>]*>([^<]+)</);
    const tagBlock = html.slice(html.indexOf(block) + block.length);
    const tags = all(tagBlock.slice(0, tagBlock.indexOf("</div>")), /<a class="tag" href="[^"]*">([^<]+)</).map(([tag]) => tag);
    quotes.push({ text, author, tags });
  }
  const link = first(html, /<li class="next">\s*<a href="([^"]+)"/);
  next = link ? join(dirname(next), link) : undefined;
}
const count = (list, key) => Object.fromEntries(Object.entries(list.reduce((acc, item) => { for (const value of [].concat(item[key])) acc[value] = (acc[value] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]));
const byTag = count(quotes, "tags");
const byAuthor = count(quotes, "author");
const topTags = all(read("index.html"), /<span class="tag-item">\s*<a class="tag"[^>]*>([^<]+)</).map(([tag]) => tag);
const einstein = quotes.filter((quote) => quote.author === "Albert Einstein");
const sunshine = quotes.find((quote) => /A day without sunshine/i.test(quote.text));
const truth = {
  computedAt: new Date().toISOString(),
  total: quotes.length,
  humorCount: byTag.humor || 0,
  tagCounts: { humor: byTag.humor || 0, life: byTag.life || 0, love: byTag.love || 0, inspirational: byTag.inspirational || 0 },
  topTags,
  einstein: { count: einstein.length, fragments: einstein.slice(0, 3).map((quote) => quote.text.split(/[,.;]/)[0].trim()) },
  sunshine: sunshine ? { author: sunshine.author, text: sunshine.text } : undefined,
  authorCount: Object.keys(byAuthor).length,
};
const out = join(here, "truth.json");
const current = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : undefined;
const same = current && JSON.stringify({ ...current, computedAt: 0 }) === JSON.stringify({ ...truth, computedAt: 0 });
if (process.argv.includes("--check")) { console.log(same ? "quotes truth.json is current" : "quotes truth.json is stale; rerun truth.mjs"); process.exit(same ? 0 : 1); }
writeFileSync(out, `${JSON.stringify(truth, null, 2)}\n`);
console.log(`quotes: ${quotes.length} quotes; humor ${truth.humorCount}; einstein ${truth.einstein.count}; top tags ${topTags.slice(0, 4).join(", ")}`);
