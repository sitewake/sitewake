const capability = {
  version: 2,
  stages: [
    {
      id: "stage_resolve_target",
      io: { "reads": { "input": ["productName"], "state": [] }, "writes": { "state": ["targets.productName"], "output": [] } },
      navigation: "optional",
      async run({ input }) {
        return { outcome: "Continue", state: { "targets": { "productName": input["productName"] } } };
      }
    },
    {
      id: "stage_select_target",
      io: { "reads": { "input": ["productName"], "state": ["targets.productName"] }, "writes": { "state": ["targets.productName"], "output": [] } },
      navigation: "optional",
      async run({ input }) {
        return { outcome: "Continue", state: { "targets": { "productName": input["productName"] } } };
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
      io: { "reads": { "input": ["productName", "variantOption"], "state": [] }, "writes": { "state": ["productName", "targets.__actedOn", "variantOption"], "output": [] } },
      navigation: "optional",
      async run({ input, waitForTarget, waitUntil, settle }) {
        void input;
        const element = await waitForTarget({ strategies: [{ type: "role", role: "link", name: "Mira PendantPendant \xB7 2700K \xB7 Dimmable$219", match: "exact" }, { type: "text", value: "Mira PendantPendant \xB7 2700K \xB7 Dimmable$219", match: "exact" }, { type: "css", value: "#main > div > div:nth-of-type(2) > section > div > article:nth-of-type(4) > a" }, { type: "role", role: "link", name: input["productName"], match: "contains" }] });
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
      id: "stage_3",
      io: { "reads": { "input": ["variantOption"], "state": [] }, "writes": { "state": ["targets.__actedOn", "variantOption"], "output": [] } },
      navigation: "optional",
      async run({ input, waitForTarget, waitUntil, settle }) {
        void input;
        const element = await waitForTarget({ strategies: [{ type: "text", value: input["variantOption"], match: "exact" }, { type: "css", value: "#main > div > div > div:nth-of-type(2) > form > fieldset > div > label:nth-of-type(2)" }] });
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
      id: "stage_4",
      io: { "reads": { "input": [], "state": [] }, "writes": { "state": ["targets.__actedOn"], "output": [] } },
      navigation: "optional",
      async run({ input, waitForTarget, waitUntil, settle }) {
        void input;
        const element = await waitForTarget({ strategies: [{ type: "role", role: "button", name: "Add to cart", match: "contains" }, { type: "role", role: "button", name: "Add to cart \u2014 $219", match: "exact" }, { type: "text", value: "Add to cart \u2014 $219", match: "exact" }, { type: "css", value: "#main > div > div > div:nth-of-type(2) > form > button" }] });
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
      id: "stage_verify",
      io: { "reads": { "input": ["productName", "variantOption"], "state": ["targets.__actedOn", "targets.productName"] }, "writes": { "state": [], "output": ["cartItemCount", "selectedVariant", "targetTitle", "targetUrl"] } },
      navigation: "none",
      async run({ input, state, waitUntil, settle, identityMatches }) {
        await waitUntil(() => {
          const bodyText = document.body.innerText;
          return bodyText.includes("Added") && bodyText.includes("to your cart");
        });
        const headingEl = document.querySelector("h1");
        const targetTitle = headingEl ? headingEl.textContent.trim() : input["productName"];
        const targetUrl = location.href;
        const checkedRadio = document.querySelector('input[name="finish"]:checked');
        let selectedVariant = input["variantOption"];
        if (checkedRadio) {
          const labelEl = checkedRadio.closest("label") || document.querySelector(`label[for="${checkedRadio.id}"]`);
          if (labelEl) {
            selectedVariant = labelEl.textContent.trim();
          }
        }
        const cartLink = document.querySelector('a[href*="/cart"]');
        let cartItemCount = 0;
        if (cartLink) {
          const cartName = cartLink.getAttribute("aria-label") || cartLink.textContent;
          const match = cartName.match(/(\d+)/);
          if (match) {
            cartItemCount = parseInt(match[1], 10);
          }
        }
        const actedOn = state.targets?.__actedOn || "";
        const identityOk = identityMatches(actedOn, targetTitle);
        const evidence = [{
          kind: "status",
          value: {
            successSignal: document.body.innerText.includes("Added") && document.body.innerText.includes("to your cart"),
            identityMatched: identityOk,
            cartLinkText: cartLink ? cartLink.textContent : null,
            selectedVariantLabel: selectedVariant
          }
        }];
        return {
          outcome: "Success",
          output: {
            targetTitle,
            targetUrl,
            selectedVariant,
            cartItemCount
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
