import type { Locale } from "../i18n";

/** Display names for the verified providers; anything else is "another OpenAI-compatible service". */
const providerNamesZh: Record<string, string> = { openai: "OpenAI", bailian: "阿里云百炼", zhipu: "智谱", ark: "火山方舟" };
const providerNamesEn: Record<string, string> = { openai: "OpenAI", bailian: "Alibaba Cloud Bailian", zhipu: "Zhipu", ark: "Volcengine Ark" };

const zh = {
  providerName: (id: string) => providerNamesZh[id] || id,
  provider: "模型服务", providerHint: "已验证的服务可以直接选；其他 OpenAI 兼容服务需要填写地址。", other: "其他 OpenAI 兼容服务",
  baseUrl: "服务地址", baseUrlPlaceholder: "https://…/v1", families: (list: string) => `已验证模型：${list}`,
  apiKey: "API Key", apiKeyPlaceholder: "sk-…", apiKeyKeep: (masked: string) => `留空则沿用已保存的 ${masked}`, apiKeyServerOnly: "只保存在服务端，浏览器只会看到掩码。",
  model: "模型", modelPlaceholder: "例如 gpt-5.6-luna 或 qwen3-max",
  verify: "验证", verifying: "正在验证…", verifyHint: "会向模型服务发两个真实请求：一次对话路由、一次带强制工具调用的页面执行。", verified: "验证通过", verifiedIn: (ms: number) => `验证通过 · ${(ms / 1000).toFixed(1)} 秒`,
  save: "保存", saving: "正在保存…", saved: "已保存，立即生效。", saveFailed: "保存失败，请重试。", changedSinceVerify: "内容有改动，请重新验证后再保存。",
  stage: { "runtime-router": "对话路由", "runtime-page-agent": "页面执行" } as Record<string, string>,
  hint: {
    "401": "401/403 —— 密钥不被服务接受。", "404": "404 —— 多半是服务地址少了或多了 /v1。", network: "连接失败 —— 请检查服务地址与网络。",
    policy: "这个服务还没有经过验证的强制工具调用策略，请换用列表中的服务。", page: "普通聊天可用不代表能操作页面。请检查服务地址、密钥、模型与强制工具调用支持。", retry: "请检查配置并重试；原有配置不会被修改。",
  } as Record<string, string>,
  current: (model: string, masked: string) => `当前：${model} · ${masked}`,
  notConfigured: "还没有接入模型。填好下面三项并验证，保存后立即生效。", loadFailed: "暂时读不到模型配置。", loading: "正在读取模型配置…",
  invalid: { base_url_invalid: "服务地址必须是 http(s) 地址。", model_required: "请填写模型。", api_key_required: "请填写 API Key。" } as Record<string, string>,
  change: "更换模型",
  demoLocked: "演示环境已锁定模型配置，不能修改。",
};
const en: typeof zh = {
  providerName: (id) => providerNamesEn[id] || id,
  provider: "Model service", providerHint: "Pick a verified service, or enter the address of another OpenAI-compatible one.", other: "Another OpenAI-compatible service",
  baseUrl: "Service URL", baseUrlPlaceholder: "https://…/v1", families: (list) => `Verified models: ${list}`,
  apiKey: "API key", apiKeyPlaceholder: "sk-…", apiKeyKeep: (masked) => `Leave blank to keep the saved ${masked}`, apiKeyServerOnly: "Stored on the server only; the browser sees a mask.",
  model: "Model", modelPlaceholder: "e.g. gpt-5.6-luna or qwen3-max",
  verify: "Verify", verifying: "Verifying…", verifyHint: "Sends two real requests to the service: a chat-routing turn and a page-execution turn with a forced tool call.", verified: "Verified", verifiedIn: (ms) => `Verified · ${(ms / 1000).toFixed(1)} s`,
  save: "Save", saving: "Saving…", saved: "Saved. It is in effect now.", saveFailed: "Could not save. Try again.", changedSinceVerify: "Something changed — verify again before saving.",
  stage: { "runtime-router": "Chat routing", "runtime-page-agent": "Page execution" },
  hint: {
    "401": "401/403 — the key was not accepted by the service.", "404": "404 — the service URL is probably missing or has an extra /v1.", network: "Connection failed — check the service URL and your network.",
    policy: "This service has no verified forced tool-call policy yet; pick one from the list.", page: "A model that chats fine may still be unable to operate pages. Check the service URL, key, model name and forced tool-call support.", retry: "Check the configuration and try again; the existing configuration has not been changed.",
  },
  current: (model, masked) => `Current: ${model} · ${masked}`,
  notConfigured: "No model yet. Fill in the three fields, verify, and save — it takes effect at once.", loadFailed: "The model configuration could not be loaded right now.", loading: "Loading the model configuration…",
  invalid: { base_url_invalid: "The service URL must be an http(s) address.", model_required: "Enter a model.", api_key_required: "Enter an API key." },
  demoLocked: "Model settings are locked in this demo.",
  change: "Change model",
};
export function modelSettingsCopy(locale: Locale) { return locale === "en" ? en : zh; }
