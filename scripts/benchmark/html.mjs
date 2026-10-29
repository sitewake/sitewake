// Small HTML helpers for the truth scripts: the practice sites are plain,
// regular markup, read with patterns rather than a DOM.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", pound: "£", euro: "€", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };

export function decode(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match);
}

export function textOf(html) {
  return decode(String(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Every match of a global pattern, as arrays of its capture groups. */
export function all(html, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...String(html).matchAll(new RegExp(pattern.source, flags))].map((match) => match.slice(1).map((group) => (group === undefined ? group : decode(group).trim())));
}

export function first(html, pattern) {
  const match = String(html).match(pattern);
  return match ? decode(match[1]).trim() : undefined;
}

export function money(text) {
  const match = String(text).replace(/,/g, "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : undefined;
}
