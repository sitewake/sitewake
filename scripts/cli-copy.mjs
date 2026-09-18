/**
 * Copy for everything that talks to a person in the terminal: the setup
 * wizard, the model compatibility check and the `npm run dev` preflight.
 *
 * Separate from `lib/i18n` on purpose. That catalog is the console's, typed
 * as `ConsoleCopy`, guarded by the i18n coverage and TDZ tests, and loaded in
 * the browser. Mixing terminal strings into it would make both sets of guards
 * fire on each other's changes. This file must stay dependency-free: the
 * wizard runs right after `git clone`, before `npm install`.
 *
 * English is the default. Chinese is chosen only when the terminal says so.
 * The two catalogs must have the same shape; `tests/cli-copy.test.mjs` fails
 * the moment a key exists on one side only.
 */

export const LOCALES = ["en", "zh"];

const LOCALE_ENV_ORDER = ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"];

/**
 * `--lang zh|en` wins. Otherwise the first non-empty locale variable, in POSIX
 * precedence, decides: a `zh` prefix (any case, `zh_CN.UTF-8`, `zh-Hans`)
 * means Chinese; anything else — unset, `C`, `POSIX`, another language — means
 * English.
 */
export function resolveCliLocale({ argv = process.argv.slice(2), env = process.env } = {}) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let value;
    if (argument === "--lang") value = argv[index + 1] ?? "";
    else if (argument.startsWith("--lang=")) value = argument.slice("--lang=".length);
    else continue;
    const normalized = String(value).trim().toLowerCase();
    if (!LOCALES.includes(normalized)) {
      throw new Error(`--lang must be one of: ${LOCALES.join(", ")} (got "${value}")`);
    }
    return normalized;
  }
  for (const name of LOCALE_ENV_ORDER) {
    const value = String(env[name] ?? "").trim();
    if (!value) continue;
    return /^zh/i.test(value) ? "zh" : "en";
  }
  return "en";
}

/** True when `--lang` (either spelling) is present, i.e. the language was chosen up front. */
export function hasLangFlag(argv) {
  return argv.some((argument) => argument === "--lang" || argument.startsWith("--lang="));
}

/** Strip `--lang` (both spellings) so callers can parse the rest. */
export function withoutLangFlag(argv) {
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--lang") { index += 1; continue; }
    if (argv[index].startsWith("--lang=")) continue;
    rest.push(argv[index]);
  }
  return rest;
}

// Chinese typography: a space separates Latin words from Chinese text, but a
// Chinese provider name joins directly ("智谱的" / "OpenAI 的").
const isCjk = (text) => /[\u4e00-\u9fff]$/.test(text);
const zhPossessive = (name) => (isCjk(name) ? `${name}的 ` : `${name} 的 `);
const zhName = (name) => (isCjk(name) ? name : ` ${name} `);

export const en = {
  common: {
    yes: "Y",
    no: "n",
    retryPrompt: "Try again? (Y/n)",
    cancelled: "Cancelled. Nothing was written.",
    invalidChoice: (options) => `Please answer with one of: ${options.join(", ")}.`,
    defaultMarker: "(default — Enter keeps it)",
  },

  setup: {
    title: "SiteWake setup",
    prefix: "[setup]",

    // Language (asked before anything else, so both languages appear as-is)
    languageQuestion: "Language / 语言",
    languageOptions: ["English", "中文"],
    languageHint: "Enter keeps the default. / 回车即使用默认项。",
    languageDefaultMarker: "(default / 默认)",

    // How SiteWake runs
    targetQuestion: "How will SiteWake run?",
    targetLocal: "From source with Node.js — for development",
    targetLocalFile: "writes .env.local",
    targetDocker: "As a Docker Compose stack — for deployment",
    targetDockerFile: "writes .env",
    targetInvalid: (value, options) => `--target must be one of: ${options.join(", ")} (got "${value}").`,

    // Model provider
    modelIntro: "Model service. SiteWake needs an OpenAI-compatible chat API that supports forced tool calls.",
    providerQuestion: "Which provider? Verified providers, with the base URL SiteWake will use and the model families that are known to work:",
    providerName: (id) => ({ openai: "OpenAI", bailian: "Alibaba Cloud Bailian", zhipu: "Zhipu", ark: "Volcengine Ark" })[id] ?? id,
    providerOther: "Another OpenAI-compatible service (you enter its base URL)",
    baseUrl: "Base URL of the service — the address you would give an OpenAI SDK, usually ending in /v1",
    apiKeyFor: (provider) => `API key for ${provider} — created in the provider's console. Typed without echo; stored only in the configuration file written here, never sent to visitors' browsers.`,
    apiKeyKeep: (masked) => `current ${masked}, Enter to keep`,
    modelFor: (provider, families) => `Model — the exact model id from ${provider}'s model list. It must support tool calls; verified families: ${families.join(", ")}.`,
    modelOther: "Model — the exact model id as your service names it. It must support forced tool calls.",
    apiKeyMissing: "No API key entered. Please try again.",
    modelMissing: "No model id entered. Please try again.",

    // Public origin (docker)
    originIntro: "Server address — the address visitors' browsers load the SDK from. It goes into the <script> tag on your website, so it must be reachable by your visitors, not just by you.",
    originReachQuestion: "How will visitors reach this server?",
    originReachLocalhost: "Only me, on this machine — trying it out",
    originReachDomain: "Through a domain name pointing at this server — required for HTTPS websites",
    originReachIp: "By its public IP address — works for HTTP websites only",
    originReachLan: "On the local network — visitors are on the same LAN",
    originReachLocalhostValue: "→ http://localhost:3000",
    originReachDomainValue: "→ https://<domain>  (put a TLS reverse proxy such as Caddy or nginx in front of port 3000)",
    originReachIpValue: (ip) => `→ http://${ip || "<public IP>"}:3000`,
    originReachLanValue: (ip) => `→ http://${ip || "<LAN IP>"}:3000`,
    originDomainQuestion: "Domain name (with or without https://)",
    originDomainInvalid: "This choice needs https:// and a domain name. For a plain IP address choose the public-IP option instead.",
    originIpQuestion: "Public IP address or http:// origin",
    originLanQuestion: "LAN address or http:// origin",
    originRules: "Scheme, host and port only, no path.",
    originInvalid: "Enter a full http(s) origin without a path, e.g. https://agent.example.com",
    originTlsReminder: "Put a TLS reverse proxy in front of port 3000 for this address before visitors use it (Caddy, nginx, or the cloudflared service in compose.yaml).",

    // Verification
    verifying: "Verifying chat routing and page tool calls…",
    verified: (ms) => `Verified (${ms} ms)`,
    verifyFailed: (reason) => `Verification failed: ${reason}`,
    verifyHintPage: "A model that chats fine may still be unable to operate pages. Check the service URL, key, model name and forced tool-call support.",
    verifyHintRetry: "Check the configuration and try again; the existing configuration has not been changed.",
    unchanged: "The existing configuration has not been changed.",
    hint401: "401/403 — the key was not accepted by the service.",
    hint404: "404 — the service URL is probably missing or has an extra /v1.",
    hintNetwork: "Connection failed — check the service URL and your network.",

    // Summary
    summary: "Summary",
    written: (file) => `Written to ${file}`,
    modelLine: (model, baseUrl) => `Model: ${model} @ ${baseUrl}`,
    originLine: (origin) => `Server address: ${origin}`,
    privateAllowed: "Private-network capability runs: allowed (CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN=1) because the origin is on a private network.",
    privateDenied: "Private-network capability runs: not allowed (CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN=0). Keep 0 on public deployments.",
    generated: (keys) => `Generated: ${keys.join(", ")}`,
    kept: (keys) => `Kept: ${keys.join(", ")}`,
    removedLegacy: (keys) => `Removed superseded names: ${keys.join(", ")}`,

    // Next steps
    next: "Next",
    nextLocal: ["npm install", "npx playwright install chromium", "npm run dev"],
    nextLocalOpen: "Then open http://localhost:3000",
    nextDocker: "docker compose up -d --build",
    nextDockerOpen: (origin) => `Then open ${origin}`,
    nextDockerSmoke: "Smoke test: docker compose exec -T control-plane node scripts/container-smoke.mjs",
    nextDockerCompact: "Small machine (2 CPU / 2 GB)? Use: docker compose -f compose.yaml -f compose.compact.yaml up -d --build",

    // Non-interactive
    needsTty: "setup needs an interactive terminal.",
    manualIntro: "Without one, write the values yourself:",
    manualLocalHeader: ".env.local (local development):",
    manualDockerHeader: ".env (Docker Compose) — copy .env.container.example to .env and set:",
    manualKey: "MODEL_API_KEY=<your key>",
    manualBaseUrl: (fallback) => `MODEL_BASE_URL=${fallback}`,
    manualModel: "MODEL=<the model id from your provider; it must support forced tool calls>",
    manualOrigin: "SITEWAKE_PUBLIC_ORIGIN=<the address visitors' browsers reach this server at, e.g. https://agent.example.com>",
    manualPrivate: "CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN=1 if that origin is on a private network, otherwise 0",
    manualTokens: (keys) => `${keys.join(", ")}=<independent random 64-character hex values>`,
    manualPasswords: (keys) => `${keys.join(", ")}=<random passwords>`,

    // Errors
    stripTypesMissing: "Run the wizard with ./setup or npm run setup (it needs Node's type stripping to load the provider policy).",
    envValueNewline: "A configuration value cannot contain a line break or NUL character.",
    envValueQuotes: "A configuration value contains an unsupported mix of quotes.",
  },

  check: {
    noValidToolCall: "The model did not return the required valid tool call.",
    emptyOrInvalidChat: "The model returned an empty or invalid chat response.",
    incompleteConfig: "Model configuration is incomplete.",
    baseUrlInvalid: "The model service URL must be an HTTP(S) URL without embedded credentials.",
    policyPrefix: "provider payload policy",
    modelLine: (model) => `Model: ${model}`,
    pass: "pass",
    fail: "FAIL",
    routingOnly1: "Chat routing works but page execution does not — exactly what checking only the routing stage would miss.",
    routingOnly2: "This model cannot go into the runtime: every exploration request would be rejected.",
    verdictPass: "Verdict: both stages work.",
    verdictFail: "Verdict: not compatible. Do not switch to this model.",
    fixtureWritten: (path) => `Fixture written to ${path}`,
  },

  preflight: {
    nodeTooOld: (current, required) => `Node is too old: ${current} installed, ${required} required`,
    nodeTooOldFix: "Upgrade Node and retry (with nvm: nvm install 22 && nvm use 22)",
    chromiumMissing: "Playwright browser is not installed (the Runner needs it to crawl sites and author capabilities)",
    chromiumMissingFix: "npx playwright install chromium",
    codexMissing: "@openai/codex is missing (capability authoring needs it)",
    codexMissingFix: "npm install",
    modelMissing: "No model service configured — the agent cannot run any task",
    modelMissingFix: "npm run setup",
    portBusy: (port, component) => `Port ${port} is already in use — ${component} cannot start`,
    portBusyFix: (port) => `lsof -nP -iTCP:${port} -sTCP:LISTEN   # find the process, then stop it`,
    componentControlPlane: "Console / Control Plane",
    componentLauncher: "Capability Runtime Launcher",
    componentDemoSite: (id, name) => `demo site ${id} (${name})`,
    header: (count) => `Preflight failed: ${count} item(s) need attention:`,
    fixLabel: "Fix:",
    footer: "Resolve the items above, then run npm run dev again.",
    allPassed: "Preflight passed.",
  },
};

export const zh = {
  common: {
    yes: "Y",
    no: "n",
    retryPrompt: "重新输入？(Y/n)",
    cancelled: "已取消，未写入任何配置。",
    invalidChoice: (options) => `请输入以下之一：${options.join("、")}。`,
    defaultMarker: "（默认，回车即选）",
  },

  setup: {
    title: "SiteWake 配置向导",
    prefix: "[setup]",

    languageQuestion: "Language / 语言",
    languageOptions: ["English", "中文"],
    languageHint: "Enter keeps the default. / 回车即使用默认项。",
    languageDefaultMarker: "(default / 默认)",

    targetQuestion: "SiteWake 以哪种方式运行？",
    targetLocal: "用 Node.js 从源码运行 —— 开发调试",
    targetLocalFile: "写入 .env.local",
    targetDocker: "用 Docker Compose 运行 —— 正式部署",
    targetDockerFile: "写入 .env",
    targetInvalid: (value, options) => `--target 只能是：${options.join("、")}（收到 "${value}"）。`,

    modelIntro: "模型服务。SiteWake 需要一个 OpenAI 兼容、且支持强制工具调用的对话模型 API。",
    providerQuestion: "用哪家？已验证可用的提供方，及 SiteWake 将使用的 Base URL 与已验证的模型家族：",
    providerName: (id) => ({ openai: "OpenAI", bailian: "阿里云百炼", zhipu: "智谱", ark: "火山方舟" })[id] ?? id,
    providerOther: "其他 OpenAI 兼容服务（手动填写 Base URL）",
    baseUrl: "服务的 Base URL —— 给 OpenAI SDK 用的那个地址，通常以 /v1 结尾",
    apiKeyFor: (provider) => `${zhPossessive(provider)}API Key —— 在提供方控制台创建。输入不回显；只写进本次的配置文件，不会发送到访客的浏览器。`,
    apiKeyKeep: (masked) => `当前 ${masked}，回车保留`,
    modelFor: (provider, families) => `模型 —— 填${zhName(provider)}模型列表里的准确 id。必须支持工具调用；已验证的家族：${families.join("、")}。`,
    modelOther: "模型 —— 填你的服务所用的准确模型 id。必须支持强制工具调用。",
    apiKeyMissing: "未填写 API Key，无法继续。请重新输入。",
    modelMissing: "未填写模型 id，无法继续。请重新输入。",

    originIntro: "服务器地址 —— 访客的浏览器从这个地址加载 SDK。它会写进你网站的 <script> 标签，所以必须是访客能访问到的地址，而不只是你自己能访问到。",
    originReachQuestion: "访客怎么访问到这台服务器？",
    originReachLocalhost: "只有我自己，在这台机器上 —— 先试用",
    originReachDomain: "通过指向这台服务器的域名 —— HTTPS 网站必须选这个",
    originReachIp: "通过公网 IP —— 只有 HTTP 网站能用",
    originReachLan: "在局域网内 —— 访客和服务器在同一个内网",
    originReachLocalhostValue: "→ http://localhost:3000",
    originReachDomainValue: "→ https://<域名>  （在 3000 端口前放一个 TLS 反向代理，如 Caddy 或 nginx）",
    originReachIpValue: (ip) => `→ http://${ip || "<公网 IP>"}:3000`,
    originReachLanValue: (ip) => `→ http://${ip || "<内网 IP>"}:3000`,
    originDomainQuestion: "域名（带不带 https:// 都可以）",
    originDomainInvalid: "这一项需要 https:// 加域名。只有 IP 的话请改选「公网 IP」。",
    originIpQuestion: "公网 IP 或 http:// 开头的 Origin",
    originLanQuestion: "内网地址或 http:// 开头的 Origin",
    originRules: "只要协议、主机和端口，不带路径。",
    originInvalid: "请输入不带路径的完整 http(s) Origin，例如 https://agent.example.com",
    originTlsReminder: "访客使用前，请先在 3000 端口前为这个地址配置 TLS 反向代理（Caddy、nginx，或 compose.yaml 里的 cloudflared 服务）。",

    verifying: "正在验证对话路由与页面工具调用…",
    verified: (ms) => `验证成功（${ms} ms）`,
    verifyFailed: (reason) => `验证失败：${reason}`,
    verifyHintPage: "普通聊天可用不代表能操作页面。请检查服务地址、密钥、模型与强制工具调用支持。",
    verifyHintRetry: "请检查配置并重试；原有配置不会被修改。",
    unchanged: "原有配置未被修改。",
    hint401: "401/403 —— 密钥不被服务接受。",
    hint404: "404 —— 多半是服务地址少了或多了 /v1。",
    hintNetwork: "连接失败 —— 请检查服务地址与网络。",

    summary: "摘要",
    written: (file) => `已写入 ${file}`,
    modelLine: (model, baseUrl) => `模型：${model} @ ${baseUrl}`,
    originLine: (origin) => `服务器地址：${origin}`,
    privateAllowed: "私有网络的能力运行：已放行（CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN=1），因为 Origin 位于私有网段。",
    privateDenied: "私有网络的能力运行：未放行（CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN=0）。公网部署请保持 0。",
    generated: (keys) => `本次生成：${keys.join("、")}`,
    kept: (keys) => `沿用已有：${keys.join("、")}`,
    removedLegacy: (keys) => `已清理被取代的旧变量名：${keys.join("、")}`,

    next: "下一步",
    nextLocal: ["npm install", "npx playwright install chromium", "npm run dev"],
    nextLocalOpen: "然后打开 http://localhost:3000",
    nextDocker: "docker compose up -d --build",
    nextDockerOpen: (origin) => `然后打开 ${origin}`,
    nextDockerSmoke: "烟测：docker compose exec -T control-plane node scripts/container-smoke.mjs",
    nextDockerCompact: "小机器（2 核 / 2 GB）？用：docker compose -f compose.yaml -f compose.compact.yaml up -d --build",

    needsTty: "setup 需要交互式终端。",
    manualIntro: "没有终端时，请手动写入以下值：",
    manualLocalHeader: ".env.local（本地开发）：",
    manualDockerHeader: ".env（Docker Compose）—— 把 .env.container.example 复制为 .env 并设置：",
    manualKey: "MODEL_API_KEY=<你的密钥>",
    manualBaseUrl: (fallback) => `MODEL_BASE_URL=${fallback}`,
    manualModel: "MODEL=<提供方模型列表里的模型 id；必须支持强制工具调用>",
    manualOrigin: "SITEWAKE_PUBLIC_ORIGIN=<访客浏览器访问这台服务器的地址，例如 https://agent.example.com>",
    manualPrivate: "CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN=该 Origin 在私有网段填 1，否则填 0",
    manualTokens: (keys) => `${keys.join("、")}=<各自独立的随机 64 位十六进制值>`,
    manualPasswords: (keys) => `${keys.join("、")}=<随机口令>`,

    stripTypesMissing: "请用 ./setup 或 npm run setup 运行向导（它需要 Node 的类型剥离来加载提供方策略）。",
    envValueNewline: "配置值不能包含换行或空字符。",
    envValueQuotes: "配置值包含不支持的引号组合。",
  },

  check: {
    noValidToolCall: "模型未返回所要求的有效工具调用。",
    emptyOrInvalidChat: "模型返回了空响应或无效的聊天响应。",
    incompleteConfig: "模型配置不完整。",
    baseUrlInvalid: "模型服务地址必须是无内嵌凭据的 HTTP(S) 地址。",
    policyPrefix: "提供方载荷策略",
    modelLine: (model) => `模型：${model}`,
    pass: "通过",
    fail: "不通过",
    routingOnly1: "对话路由可用但页面执行不可用——这正是只验证路由阶段会漏掉的情况。",
    routingOnly2: "这个模型不能投入运行时：探索模式的每一次请求都会被拒。",
    verdictPass: "结论：两个阶段都可用。",
    verdictFail: "结论：不通过，不要切换到这个模型。",
    fixtureWritten: (path) => `fixture 已写入 ${path}`,
  },

  preflight: {
    nodeTooOld: (current, required) => `Node 版本过低：当前 ${current}，需要 ${required}`,
    nodeTooOldFix: "升级 Node 后重试（推荐用 nvm：nvm install 22 && nvm use 22）",
    chromiumMissing: "Playwright 浏览器内核未安装（Runner 抓取网站和编写能力都需要它）",
    chromiumMissingFix: "npx playwright install chromium",
    codexMissing: "缺少 @openai/codex（能力编写需要它）",
    codexMissingFix: "npm install",
    modelMissing: "未配置模型服务，Agent 无法执行任何任务",
    modelMissingFix: "npm run setup",
    portBusy: (port, component) => `端口 ${port} 已被占用 — ${component} 无法启动`,
    portBusyFix: (port) => `lsof -nP -iTCP:${port} -sTCP:LISTEN   # 查出占用进程后关闭它`,
    componentControlPlane: "控制台 / Control Plane",
    componentLauncher: "Capability Runtime Launcher",
    componentDemoSite: (id, name) => `demo 站点 ${id}（${name}）`,
    header: (count) => `启动前检查未通过，共 ${count} 项需要处理：`,
    fixLabel: "修复：",
    footer: "处理完以上各项后重新执行 npm run dev。",
    allPassed: "启动前检查全部通过。",
  },
};

const CATALOGS = { en, zh };

/** The catalog for a locale; unknown values fall back to English. */
export function cli(locale = "en") {
  return CATALOGS[locale] || en;
}
