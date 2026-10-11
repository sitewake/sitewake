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

export const en = {
  common: {
    invalidChoice: (options) => `Please answer with one of: ${options.join(", ")}.`,
    defaultMarker: "(default — Enter keeps it)",
  },

  setup: {
    title: "SiteWake setup",
    prefix: "[setup]",

    // Language. Asked before a language exists, so this block is English in
    // both catalogs: nothing in another language is printed before the answer.
    languageQuestion: "Language",
    languageOptions: ["English", "Chinese"],
    languageHint: "Enter keeps the default.",
    languageDefaultMarker: "(default)",

    // Server address — not asked; announced with where to change it
    originLine: (origin) => `Console: ${origin}`,
    originPublicNote: (port, lan) => `This is the machine's public address from the cloud's metadata service. Open TCP ${port} in the cloud security group / firewall, or visitors cannot reach it.${lan ? ` Inside the private network use ${lan}.` : ""}`,
    originNote: "Administer SiteWake at this address — any address that reaches this machine will do, a private one included.",
    modeLine: "You are in local trial mode: websites running on this machine or this LAN can be connected.",
    modeNote: "A website on the internet needs an https public address, because browsers refuse an http script inside an https page. Point a domain at this machine and put your own https in front of port 3000, then enter it in the console under Settings, on the public address page — it has the steps.",

    // What was written
    written: (file) => `Written to ${file}`,
    projectLine: (name) => `Compose project: ${name} — its containers and data volumes carry this name, so another install in another directory never collides with it.`,
    existingVolumesWarning: (volumes) => [
      `WARNING: data volumes from an earlier install exist on this machine: ${volumes.join(", ")}.`,
      "Postgres and MinIO keep the passwords they were first started with, so the passwords generated just now will NOT open them and the control plane will fail with \"password authentication failed\".",
      "Fresh install (the old data is not needed): run  docker compose down -v  before  docker compose up -d --build.",
      "Keep the old data: put the earlier POSTGRES_PASSWORD and MINIO_ROOT_PASSWORD back into .env.",
    ],

    // Starting and the post-start report
    starting: "Starting SiteWake with Docker Compose (./setup --no-start writes the configuration only)…",
    reportRunning: "SiteWake is running.",
    reportNotReady: "SiteWake started, but the control plane is not ready yet.",
    reportFailed: "docker compose could not start the stack.",
    reportStoppedOther: (project) => `Stopped the earlier SiteWake install "${project}" that was holding the port; its data volumes were kept.`,
    reportPortBusy: (port, holder) => `Port ${port} is in use by "${holder}", which is not SiteWake. Stop it, or set SITEWAKE_PORT in .env and run ./setup again.`,
    reportRotatedProject: (from, to) => `The data volume of "${from}" was started with a different password, so this install now runs as "${to}" with fresh volumes; the old volumes were kept (docker volume ls).`,
    reportConsole: (origin) => `Open the console:  ${origin}`,
    reportLan: (lan) => `From the private network:  ${lan}`,
    reportSecurityGroup: (port) => `Visitors reach it only if TCP ${port} is open in the cloud security group / firewall.`,
    reportHealth: (status, services) => `Health: ${status} (${services.join(", ")})`,
    reportNextReady: (origin) => [
      "Next: open the console and follow the onboarding to connect your website.",
      `Set a console password at ${origin}/access before exposing it to the internet.`,
      "Later: edit .env and run  docker compose up -d  to change settings; ./setup keeps what it generated.",
    ],
    reportNextNotReady: [
      "See what is wrong:  docker compose ps   and   docker compose logs --tail=60 control-plane",
      "Check again:  curl -s http://127.0.0.1:3000/api/health",
      "The stack keeps retrying in the background; a slow machine can take a few minutes.",
    ],

    // Next steps (--no-start)
    next: "Next",
    nextDocker: "docker compose up -d --build",
    nextDockerOpen: (origin) => `Then open ${origin}`,
    nextDockerSmoke: "Smoke test: docker compose exec -T control-plane node scripts/container-smoke.mjs",
    nextDockerCompact: "Small machine (2 CPU / 2 GB)? Use: docker compose -f compose.yaml -f compose.compact.yaml up -d --build",

    // Errors
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
    installingChromium: "Installing the Playwright browser this machine needs (a few hundred MB, once)…",
    installingChromiumDeps: "Installing the system libraries the browser needs…",
    chromiumDepsMissing: (libraries) => `The Playwright browser cannot start: system libraries are missing (${libraries.slice(0, 4).join(", ")}${libraries.length > 4 ? ", …" : ""})`,
    chromiumDepsMissingFix: "npx playwright install-deps chromium   # needs sudo/apt; or: npx playwright install --with-deps chromium",
    codexMissing: "@openai/codex is missing (capability authoring needs it)",
    codexMissingFix: "npm install",
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
    invalidChoice: (options) => `请输入以下之一：${options.join("、")}。`,
    defaultMarker: "（默认，回车即选）",
  },

  setup: {
    title: "SiteWake 配置向导",
    prefix: "[setup]",

    // 语言一问在选定语言之前出现，因此两份目录里都是英文：作答之前不出现任何中文。
    languageQuestion: "Language",
    languageOptions: ["English", "Chinese"],
    languageHint: "Enter keeps the default.",
    languageDefaultMarker: "(default)",

    originLine: (origin) => `控制台：${origin}`,
    originPublicNote: (port, lan) => `这是从云平台元数据取到的公网地址。请在云安全组 / 防火墙放行 TCP ${port}，否则访客访问不到。${lan ? `内网访问用 ${lan}。` : ""}`,
    originNote: "用这个地址管理 SiteWake —— 能访问到这台机器的地址都行，内网地址也可以。",
    modeLine: "现在是「本地体验模式」：可以接入这台机器和内网里的网站。",
    modeNote: "要接入公网上的网站，需要一个 https 的对外地址 —— 浏览器不允许 https 页面加载 http 脚本。把域名解析到这台机器、在 3000 端口前配好你自己的 https，然后在控制台的「设置」里填写对外地址，那一页写了怎么弄。",

    written: (file) => `已写入 ${file}`,
    projectLine: (name) => `Compose 项目名：${name} —— 容器和数据卷都带这个名字，另一个目录里的安装不会和它撞车。`,
    existingVolumesWarning: (volumes) => [
      `警告：这台机器上有上一次安装留下的数据卷：${volumes.join("、")}。`,
      "Postgres 和 MinIO 只认第一次启动时的密码，刚生成的密码打不开它们，控制面会报 \"password authentication failed\"。",
      "全新安装（旧数据不要了）：先  docker compose down -v  再  docker compose up -d --build。",
      "要保留旧数据：把之前的 POSTGRES_PASSWORD 和 MINIO_ROOT_PASSWORD 填回 .env。",
    ],

    starting: "正在用 Docker Compose 启动 SiteWake（只想写配置不启动：./setup --no-start）……",
    reportRunning: "SiteWake 已经跑起来了。",
    reportNotReady: "SiteWake 已启动，但控制面还没就绪。",
    reportFailed: "docker compose 没能把服务启动起来。",
    reportStoppedOther: (project) => `已停掉占着端口的上一套 SiteWake 安装「${project}」；它的数据卷保留着。`,
    reportPortBusy: (port, holder) => `端口 ${port} 被「${holder}」占用，它不是 SiteWake。请停掉它，或在 .env 里设置 SITEWAKE_PORT 后重新运行 ./setup。`,
    reportRotatedProject: (from, to) => `「${from}」的数据卷是用另一个密码初始化的，本次安装改以「${to}」运行、使用新的数据卷；旧卷原样保留（docker volume ls）。`,
    reportConsole: (origin) => `打开控制台：  ${origin}`,
    reportLan: (lan) => `内网访问：  ${lan}`,
    reportSecurityGroup: (port) => `访客能访问到的前提是云安全组 / 防火墙放行了 TCP ${port}。`,
    reportHealth: (status, services) => `健康状态：${status}（${services.join("，")}）`,
    reportNextReady: (origin) => [
      "下一步：打开控制台，按引导接入你的网站。",
      `暴露到公网之前，先到 ${origin}/access 设置控制台密码。`,
      "以后改配置：改 .env 再 docker compose up -d；重跑 ./setup 会保留已生成的值。",
    ],
    reportNextNotReady: [
      "查看原因：  docker compose ps   和   docker compose logs --tail=60 control-plane",
      "再查一次：  curl -s http://127.0.0.1:3000/api/health",
      "服务会在后台持续重试；机器慢的话可能要几分钟。",
    ],

    next: "下一步",
    nextDocker: "docker compose up -d --build",
    nextDockerOpen: (origin) => `然后打开 ${origin}`,
    nextDockerSmoke: "烟测：docker compose exec -T control-plane node scripts/container-smoke.mjs",
    nextDockerCompact: "小机器（2 核 / 2 GB）？用：docker compose -f compose.yaml -f compose.compact.yaml up -d --build",

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
    installingChromium: "正在安装这台机器需要的 Playwright 浏览器内核（几百 MB，只需一次）…",
    installingChromiumDeps: "正在安装浏览器内核依赖的系统库…",
    chromiumDepsMissing: (libraries) => `Playwright 浏览器内核启动不了：系统缺少共享库（${libraries.slice(0, 4).join("、")}${libraries.length > 4 ? "……" : ""}）`,
    chromiumDepsMissingFix: "npx playwright install-deps chromium   # 需要 sudo/apt；或：npx playwright install --with-deps chromium",
    codexMissing: "缺少 @openai/codex（能力编写需要它）",
    codexMissingFix: "npm install",
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
