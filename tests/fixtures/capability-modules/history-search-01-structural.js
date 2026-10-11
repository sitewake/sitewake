export const capability = {
  version: 2,
  stages: [
    { id: "stage_resolve_target", io: {"reads":{"input":["keyword"],"state":[]},"writes":{"state":["targets.keyword"],"output":[]}}, navigation: "optional",
      async run({ input }) {
        return { outcome: "Continue", state: {"targets":{"keyword":input["keyword"]}} };
      } },
    { id: "stage_select_target", io: {"reads":{"input":["keyword"],"state":["targets.keyword"]},"writes":{"state":["targets.keyword"],"output":[]}}, navigation: "optional",
      async run({ input }) {
        return { outcome: "Continue", state: {"targets":{"keyword":input["keyword"]}} };
      } },
    { id: "stage_1", io: {"reads":{"input":["keyword"],"state":[]},"writes":{"state":["keyword"],"output":[]}}, navigation: "optional",
      async run({ input, waitForTarget, fill }) {
        const element = await waitForTarget({strategies:[{type:"role",role:"combobox",name:"搜索历史热搜",match:"exact"},{type:"css",value:"#base-ui-\\\\:R9b9cja\\\\:"}]});
        fill(element, input["keyword"]);
        return { outcome: "Continue" };
      } },
    { id: "stage_2", io: {"reads":{"input":[],"state":[]},"writes":{"state":["targets.__actedOn"],"output":[]}}, navigation: "optional",
      async run({ input, waitForTarget, waitUntil, settle }) {
        void input;
        const element = await waitForTarget({strategies:[{type:"role",role:"button",name:"搜索",match:"exact"},{type:"text",value:"搜索",match:"exact"},{type:"css",value:"body > div:nth-of-type(1) > header > div > div:nth-of-type(1) > form > button"}]});
        const actedOn = (element.innerText || element.textContent || "").replace(/\s+/gu, " ").trim().slice(0, 240);
        const hrefBefore = location.href; const textBefore = document.body.innerText;
        element.click();
        await waitUntil(() => location.href !== hrefBefore || document.body.innerText !== textBefore);
        await settle();
        return { outcome: "Continue", state: { targets: { __actedOn: actedOn } } };
      } },
    { id: "stage_verify", io: {"reads":{"input":["keyword"],"state":["targets.__actedOn","targets.keyword"]},"writes":{"state":[],"output":["keyword","results","totalRecords"]}}, navigation: "none",
      async run({ input, state, waitFor, settle }) {
        const keyword = input["keyword"];
        
        // Wait for the result container to be visible
        const resultContainer = await waitFor('body > div:nth-of-type(1) > main > div > div:nth-of-type(3)');
        if (!resultContainer) {
          throw new Error("Result container not found");
        }
        
        // Wait for results to be populated
        await settle();
        
        // Get all result links
        const links = Array.from(resultContainer.querySelectorAll('a[href^="/topic/"]'));
        
        if (links.length === 0) {
          return { outcome: "NoResult", reason: "No results found" };
        }
        
        // Parse total records from page text
        const bodyText = document.body.innerText;
        const totalMatch = bodyText.match(/找到\s+(\d+)\s*条包含/);
        const totalRecords = totalMatch ? parseInt(totalMatch[1]) : links.length;
        
        // Parse each result from DOM structure
        const results = [];
        for (const link of links) {
          // Find title in H3 > MARK or H3
          const h3 = link.querySelector('h3');
          const mark = h3 ? h3.querySelector('mark') : null;
          const title = mark ? mark.innerText.trim() : (h3 ? h3.innerText.trim() : '');
          
          if (!title) continue;
          
          // Find spans with record count, max heat, last date
          const spans = Array.from(link.querySelectorAll('span'));
          let recordCount = 0;
          let maxHeat = '';
          let lastDate = '';
          
          for (const span of spans) {
            const text = span.innerText.trim();
            const recordMatch = text.match(/上榜记录\s+(\d+)\s*条/);
            const heatMatch = text.match(/最高热度\s+(.+)/);
            const dateMatch = text.match(/最近上榜\s+(.+)/);
            
            if (recordMatch) {
              recordCount = parseInt(recordMatch[1]);
            }
            if (heatMatch) {
              maxHeat = heatMatch[1].trim();
            }
            if (dateMatch) {
              lastDate = dateMatch[1].trim();
            }
          }
          
          if (title && recordCount > 0 && maxHeat && lastDate) {
            results.push({
              title,
              recordCount,
              maxHeat,
              lastDate
            });
          }
        }
        
        if (results.length === 0) {
          return { outcome: "NoResult", reason: "Failed to parse any results" };
        }
        
        return {
          outcome: "Success",
          output: {
            keyword: keyword,
            totalRecords: totalRecords,
            results: results
          },
          evidence: [{
            kind: "status",
            value: {
              url: location.href,
              title: document.title,
              resultCount: results.length,
              totalRecords: totalRecords
            }
          }]
        };
      } }
  ]
};

