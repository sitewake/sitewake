import process from "node:process";

const apiKey = String(process.env.MODEL_API_KEY || process.env.OPENAI_API_KEY || "").trim();
const baseUrl = String(process.env.MODEL_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const model = String(process.env.MODEL || process.env.OPENAI_MODEL || "").trim();

if (!apiKey || !model) {
  console.log("Evolution model eval skipped: no configured OpenAI-compatible model.");
  process.exit(0);
}

const endpoint = baseUrl.endsWith("/v1") ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
const response = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model, temperature: 0, response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "Return only JSON. You review whether a web capability contract is safely parameterized." },
      { role: "user", content: JSON.stringify({ goal: "查看第 3 个商品详情", expected: { requiredInput: "rank:number", mustNotDo: "do not make the third item a constant" } }) },
    ],
  }),
});
if (!response.ok) throw new Error(`evolution_model_eval_failed:${response.status}`);
const body = await response.json();
const text = body.choices?.[0]?.message?.content || "{}";
const value = JSON.parse(String(text).replace(/^```json\s*|\s*```$/g, ""));
console.log(JSON.stringify({ status: "passed", model, usage: body.usage || {}, result: value }, null, 2));
