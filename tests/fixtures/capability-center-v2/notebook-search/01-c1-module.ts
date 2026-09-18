// @ts-nocheck
export const capability = {
  version: 2,
  stages: [
    {
      id: "stage_resolve_target",
      io: {
        reads: { input: ["query"], state: [] },
        writes: { state: ["targets.query"], output: [] },
      },
      navigation: "optional",
      async run({ input, state }) {
        const query = String(input.query || "");
        if (!query.trim()) return { outcome: "NoResult", reason: "query is required" };
        return { outcome: "Continue", state: { targets: { query } } };
      },
    },
    {
      id: "stage_select_target",
      io: {
        reads: { input: ["query"], state: ["targets.query"] },
        writes: { state: ["targets.query"], output: [] },
      },
      navigation: "optional",
      async run({ input, state }) {
        const query = String(input.query || "");
        if (!query.trim() || state.targets?.query !== query) return { outcome: "NoResult", reason: "query is required" };
        return { outcome: "Continue", state: { targets: { query } } };
      },
    },
    {
      id: "stage_1",
      io: {
        reads: { input: ["query"], state: [] },
        writes: { state: ["query"], output: [] },
      },
      navigation: "optional",
      async run({ input, fill }) {
        const query = String(input.query || "");
        const field = document.querySelector("input[name=\"query\"]");
        const form = document.querySelector("form#search-form");
        if (!field || !form) return { outcome: "NoResult", reason: "search form is unavailable" };
        fill(field, query);
        const target = new URL(form.getAttribute("action") || "/search", location.origin);
        target.searchParams.set("controller", "search");
        target.searchParams.set("s", query);
        return { outcome: "Continue", state: { query }, navigation: { url: target.href, target: "_self" } };
      },
    },
    {
      id: "stage_2",
      io: {
        reads: { input: [], state: [] },
        writes: { state: [], output: [] },
      },
      navigation: "optional",
      async run() {
        if (!location.pathname.includes("/search")) return { outcome: "NoResult", reason: "search result page is unavailable" };
        return { outcome: "Continue" };
      },
    },
    {
      id: "stage_verify",
      io: {
        reads: { input: ["query"], state: ["targets.query"] },
        writes: { state: [], output: ["query", "resultUrl", "heading"] },
      },
      navigation: "none",
      async run({ input, state }) {
        const query = String(input.query || "");
        const heading = (document.querySelector("h1")?.textContent || "").replace(/\\s+/g, " ").trim();
        const resultUrl = location.href;
        if (!query.trim() || state.targets?.query !== query || !heading || !heading.toLocaleLowerCase().includes(query.toLocaleLowerCase())) {
          return { outcome: "NoResult", reason: "query is not visible in the final result" };
        }
        return {
          outcome: "Success",
          output: { query, resultUrl, heading },
          evidence: [{ kind: "page", value: { url: resultUrl, heading, query } }],
        };
      },
    },
  ],
};
