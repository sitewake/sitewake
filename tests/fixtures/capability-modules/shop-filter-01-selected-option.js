const capability = {
  version: 2,
  stages: [
    {
      id: "stage_resolve_target",
      io: { "reads": { "input": ["productType"], "state": [] }, "writes": { "state": ["targets.productType"], "output": [] } },
      navigation: "optional",
      async run({ input }) {
        return { outcome: "Continue", state: { "targets": { "productType": input["productType"] } } };
      }
    },
    {
      id: "stage_select_target",
      io: { "reads": { "input": ["productType"], "state": ["targets.productType"] }, "writes": { "state": ["targets.productType"], "output": [] } },
      navigation: "optional",
      async run({ input }) {
        return { outcome: "Continue", state: { "targets": { "productType": input["productType"] } } };
      }
    },
    {
      id: "stage_1",
      io: { "reads": { "input": [], "state": [] }, "writes": { "state": ["targets.__actedOn"], "output": [] } },
      navigation: "optional",
      async run({ input, waitForTarget, waitUntil, settle }) {
        void input;
        const element = await waitForTarget({ strategies: [{ type: "role", role: "link", name: "Shop", match: "exact" }, { type: "text", value: "Shop", match: "exact" }, { type: "css", value: "#root > div > header > div > nav > ul > li:nth-of-type(1) > a" }] });
        const actedOn = (element.innerText || element.textContent || "").replace(/s+/gu, " ").trim().slice(0, 240);
        const hrefBefore = location.href;
        const textBefore = document.body.innerText;
        element.click();
        await waitUntil(() => location.href !== hrefBefore || document.body.innerText !== textBefore);
        await settle();
        return { outcome: "Continue", state: { targets: { __actedOn: actedOn } } };
      }
    },
    {
      id: "stage_2",
      io: { "reads": { "input": ["productType"], "state": [] }, "writes": { "state": ["productType"], "output": [] } },
      navigation: "required",
      async run({ input }) {
        return { outcome: "Continue", navigation: { url: `https://shop.example.test/shop?type=${encodeURIComponent(String(input["productType"]))}`, target: "_self" } };
      }
    },
    {
      id: "stage_3",
      io: { "reads": { "input": ["productType"], "state": [] }, "writes": { "state": ["productType"], "output": [] } },
      navigation: "optional",
      async run({ input, waitForTarget, fill }) {
        const element = await waitForTarget({ strategies: [{ type: "role", role: "combobox", name: "AnyTable lampFloor lampPendantWall light", match: "exact" }, { type: "css", value: "#type" }] });
        fill(element, input["productType"]);
        return { outcome: "Continue" };
      }
    },
    {
      id: "stage_4",
      io: { "reads": { "input": ["productType", "maxPrice"], "state": [] }, "writes": { "state": ["productType"], "output": [] } },
      navigation: "required",
      async run({ input }) {
        return { outcome: "Continue", navigation: { url: `https://shop.example.test/shop?type=${encodeURIComponent(String(input["productType"]))}&maxPrice=${encodeURIComponent(String(input["maxPrice"]))}`, target: "_self" } };
      }
    },
    {
      id: "stage_5",
      io: { "reads": { "input": ["maxPrice"], "state": [] }, "writes": { "state": [], "output": [] } },
      navigation: "optional",
      async run({ input, waitForTarget, fill }) {
        const element = await waitForTarget({ strategies: [{ type: "role", role: "combobox", name: "AnyUp to $100Up to $150Up to $200Up to $300Up to $500", match: "exact" }, { type: "css", value: "#maxPrice" }] });
        const maxPrice = Number(input["maxPrice"]);
        const options = ["Up to $100", "Up to $150", "Up to $200", "Up to $300", "Up to $500"];
        let selectedOption = "Any";
        for (const opt of options) {
          const price = parseInt(opt.replace(/[^0-9]/g, ""), 10);
          if (!isNaN(price) && price <= maxPrice) {
            selectedOption = opt;
          }
        }
        fill(element, selectedOption);
        return { outcome: "Continue" };
      }
    },
    {
      id: "stage_verify",
      io: { "reads": { "input": ["maxPrice", "productType"], "state": ["targets.__actedOn", "targets.productType"] }, "writes": { "state": [], "output": ["maxPriceFilter", "productType", "resultCount", "targetUrl"] } },
      navigation: "none",
      async run({ input, state, waitUntil, settle, identityMatches }) {
        await waitUntil(() => {
          const statusEl2 = document.querySelector("#main > div > div:nth-of-type(2) > section > p");
          return statusEl2 && statusEl2.textContent && statusEl2.textContent.includes("Showing");
        });
        await settle();
        const statusEl = document.querySelector("#main > div > div:nth-of-type(2) > section > p");
        const statusText = statusEl?.textContent || "";
        const countMatch = statusText.match(/Showing (\d+) of/);
        const resultCount = countMatch ? parseInt(countMatch[1], 10) : 0;
        const typeSelect = document.querySelector("#type");
        const typeSelectedOption = typeSelect?.options[typeSelect?.selectedIndex];
        const expectedProductType = input["productType"];
        const actualProductType = typeSelectedOption?.text || "";
        if (!identityMatches(expectedProductType, actualProductType)) {
          return {
            outcome: "BusinessRejection",
            reason: `Product type mismatch: expected "${expectedProductType}", got "${actualProductType}"`,
            evidence: [{ kind: "status", value: { expectedProductType, actualProductType } }]
          };
        }
        const priceSelect = document.querySelector("#maxPrice");
        const priceSelectedOption = priceSelect?.options[priceSelect?.selectedIndex];
        const targetUrl = location.href;
        const evidence = [
          { kind: "status", value: {
            statusText,
            resultCount,
            productType: actualProductType,
            maxPriceFilter: priceSelectedOption?.text || "",
            url: targetUrl
          } }
        ];
        if (resultCount === 0) {
          return { outcome: "NoResult", reason: "No products found matching the filters", evidence };
        }
        return {
          outcome: "Success",
          output: {
            productType: typeSelectedOption?.text || "",
            maxPriceFilter: priceSelectedOption?.text || "",
            resultCount,
            targetUrl
          },
          evidence
        };
      }
    }
  ]
};
export {
  capability
};
