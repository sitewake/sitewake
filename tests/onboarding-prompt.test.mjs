import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

async function bundledModule(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, platform: "node", format: "esm", write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

const { onboardingPrompt } = await bundledModule("../lib/console/onboarding-prompt.ts");

const input = {
  siteUrl: "https://shop.example/",
  siteAgentId: "shop.example",
  consoleOrigin: "https://console.sitewake.test",
};

/**
 * The prompt is an instruction pasted into a coding IDE, not copy. Each line maps to a
 * "SHALL" in the spec; dropping one may let the IDE quietly do something the user never
 * agreed to.
 */
const REQUIRED = {
  zh: [
    ["网站地址", /网站地址：https:\/\/shop\.example\//],
    ["接入标识", /接入标识：shop\.example/],
    ["SDK 地址", /https:\/\/console\.sitewake\.test\/sitewake\.js/],
    ["不假设技术栈", /不要假设技术栈/],
    ["在所有页面加载", /所有业务页面加载/],
    ["标识不是密钥", /它不是密钥/],
    ["不索取服务端密钥", /不要创建、请求或写入任何服务端密钥/],
    ["已绑定他站就停止", /已经绑定到另一个 SiteWake 网站.*停止.*不要静默覆盖/s],
    ["不改业务逻辑", /不要改业务逻辑/],
    ["报告改了哪些文件与如何撤销", /修改了哪些文件.*如何撤销/s],
    ["前端不得自行判定成功", /前端不得自行标记接入成功/],
  ],
  en: [
    ["site address", /Site address: https:\/\/shop\.example\//],
    ["identifier", /identifier: shop\.example/],
    ["SDK address", /https:\/\/console\.sitewake\.test\/sitewake\.js/],
    ["no stack assumption", /Do not assume the stack/],
    ["loads on every page", /loads on every page/],
    ["not a secret", /It is not a secret/],
    ["no server-side secret", /do not create, request or write any server-side secret/],
    ["stop on foreign binding", /already bound to a different SiteWake site, stop.*Do not silently overwrite/s],
    ["no business logic change", /Do not change business logic/],
    ["report files and undo", /which files you changed.*how to undo it/s],
    ["front end must not self-certify", /front end must never mark the install as successful/],
  ],
};

for (const locale of ["zh", "en"]) {
  test(`the ${locale} prompt states every constraint the spec requires`, () => {
    const prompt = onboardingPrompt({ locale, ...input });
    for (const [name, pattern] of REQUIRED[locale]) {
      assert.match(prompt, pattern, `提示词缺少「${name}」`);
    }
  });
}

test("the prompt carries the real values, never a placeholder", () => {
  const prompt = onboardingPrompt({ locale: "zh", ...input });
  for (const placeholder of ["site_pub_nimbus", "cdn.sitewake.dev", "example.com/your-site", "{{", "<your"]) {
    assert.ok(!prompt.includes(placeholder), `提示词里不该有占位值 ${placeholder}`);
  }
  // Another site, other values — not hard-coded.
  const other = onboardingPrompt({ locale: "zh", siteUrl: "https://docs.other/", siteAgentId: "docs.other", consoleOrigin: "https://c2.test" });
  assert.ok(other.includes("docs.other"));
  assert.ok(other.includes("https://c2.test/sitewake.js"));
  assert.ok(!other.includes("shop.example"));
});

test("both locales keep the same instruction count so neither drifts", () => {
  const zh = onboardingPrompt({ locale: "zh", ...input });
  const en = onboardingPrompt({ locale: "en", ...input });
  const numbered = (text) => text.split("\n").filter((line) => /^\d+\. /.test(line)).length;
  assert.equal(numbered(zh), numbered(en));
  assert.equal(numbered(zh), 7);
});
