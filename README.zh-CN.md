<div align="center">

<img src="public/brand/sitewake-mark.svg" alt="SiteWake" width="96" height="96"/>

# SiteWake

### 网站原生的 AI Agent —— 一行代码，无限能力

**把任何网站变成一个智能 Agent：理解你的用户、操作你的界面、自己学会新技能。**

🌐 **官网：[sitewake.ai](https://sitewake.ai)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black.svg)](https://nextjs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED.svg)](compose.yaml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/sitewake/sitewake?style=social)](https://github.com/sitewake/sitewake)

[English](README.md) · **中文**

</div>

<div align="center">
  <img src=".github/assets/demo.gif" alt="SiteWake 演示 —— Agent 听懂目标、操作真实页面、完成任务" width="880"/>
  <br/>
  <sub>Agent 听懂目标、操作真实页面、完成任务。<a href=".github/assets/demo.mp4">观看完整画质视频（mp4，30 秒）</a>。</sub>
</div>

---

## ✨ 一行代码，就这么多

```html
<script src="https://your-sitewake-host/sitewake.js"
        data-site-agent="your-site-id"
        data-endpoint="https://your-sitewake-host"
        defer></script>
```

把这段代码放进任何页面 —— 纯 HTML、React、Next.js、Vue，任何能渲染 `<script>` 标签的技术栈都行 —— 你的网站立刻拥有一个 AI Agent，它会：

- 🗣️ **理解用户意图** —— 用户用自然语言说出目标即可
- 🖱️ **操作真实界面** —— 在用户自己的会话里点击、填写、导航真实页面
- 🧠 **持续自我进化** —— 成功经验沉淀为经过独立验证的可复用**能力（Capability）**
- 🚀 **零后端改造** —— 不需要 API 对接、不需要 MCP Server、不需要无头浏览器集群

> 当前为开源预览阶段。页面内执行、会话记录、网站知识和能力验证已经可用；自主学习与失效恢复仍需在真实网站上验证，暂不承诺任意网站装上即零维护。

---

## 🎯 为什么是 SiteWake？

大多数「网页 Agent」每次请求都要在服务端启动一个无头浏览器 —— 慢、无状态、看不到用户的真实上下文。**SiteWake 是 UI 原生的**：Agent 就活在你的页面*里*。

| | 传统网页 Agent | **SiteWake** |
|---|---|---|
| 执行方式 | 每次请求一个无头浏览器 | 用户真实的页面、真实的会话 |
| 登录态 | 重新认证 / 丢失 | 天然继承 |
| 学习 | 没有 —— 同样的错误一犯再犯 | 成功 → 经过验证、可复用的能力 |
| 接入 | 需要 API / MCP Runtime | 一个 `<script>` 标签 |
| 速度 | 每次冷启动 | 已发布能力确定性执行，不调用大模型 |

### 自我进化闭环

```text
用户说出目标
  └─ Agent 理解上下文，选择工具
       ├─ 查询网站知识：商品、页面类型、已知路径
       ├─ 调用已发布能力：像函数一样，有真实返回值
       ├─ 操作当前页面：只用于真正未知的缺口
       └─ 缺参数：就地追问，绝不猜

成功 → AI 设计能力契约 → AI 在独立浏览器里编写程序
     → 独立真实重放 → 发布为全站共享的能力

失败 → 区分业务拒绝与执行故障
     → 只修真正的执行缺口
```

每一次真实任务都让你网站的 Agent 更聪明。一页一页，控制台被学到的知识点亮。

---

## 🖥️ 控制台

不是训练后台，而是一个你能看着它长大的**活的 Agent**：

- **📊 概览** —— 实时的网站模型：Agent 学到了什么、形成了哪些能力
- **🤖 Agent** —— 助手在你页面上的外观与行为，按访客看到的样子预览
- **📜 用户会话** —— 每个任务的结果：已完成 / 无结果 / 业务拒绝 / 执行故障，附逐步操作记录
- **⚡ 能力** —— 只收完整、可靠交付的用户目标；导航点击永远冒充不了业务能力
- **🗺️ 网站知识** —— 网站的页面结构与已收录内容，每条事实都带来源

---

## 🚀 快速开始

二选一：

- **Docker**（含 Compose v2）—— 部署到服务器或 NAS。
- **Node.js ≥ 22.13** —— 在自己的电脑上跑，用于开发。

再加一个 OpenAI 兼容模型服务的 API Key（见[模型要求](#-模型要求)）—— 控制台打开之后再填，不是前置条件。

### 用 Docker Compose 部署（推荐）

在装了 Docker（含 Compose v2）的服务器上，一条命令：

```bash
git clone https://github.com/sitewake/sitewake.git
cd sitewake
./setup
```

`./setup` 只问一件事 —— 语言 —— 其余全自动：拉取本版本的预构建镜像（大约一分钟；拉不到才在本机从源码构建），启动整套服务，等它就绪，打印出要打开的地址。打开它，控制台会引导你接入网站和模型。云主机记得先在安全组放行 TCP 3000，并确保当前用户能用 Docker（`sudo usermod -aG docker $USER`，然后重新登录）。

想用自己的域名或 HTTPS？改 `.env` 里的 `SITEWAKE_PUBLIC_ORIGIN`（HTTPS 网站需要 `https://` 地址，并在 3000 端口前放一个 TLS 反向代理），再 `docker compose up -d`。

小机器（2 核 / 2 GB）用紧凑配置 —— 浏览器一次只开一个、单个 worker：

```bash
docker compose -f compose.yaml -f compose.compact.yaml up -d --build
```

想自己动手？`./setup --no-start` 只写 `.env`，之后 `docker compose up -d --build`。检查运行中的服务：

```bash
curl -s http://127.0.0.1:3000/api/health
docker compose exec -T control-plane node scripts/container-smoke.mjs
```

### 本地开发（Node ≥ 22.13）

```bash
git clone https://github.com/sitewake/sitewake.git
cd sitewake
npm install
npx playwright install chromium   # Linux：npx playwright install --with-deps chromium
npm run dev
```

然后打开 **<http://localhost:3000>**。`npx playwright install chromium` 下载 runner 用的浏览器内核（几百 MB，只需一次）—— Linux 上用 `npx playwright install --with-deps chromium`，把它依赖的系统库一起装上。`npm run dev` 启动前会检查 Node、浏览器（及其系统库）和端口，缺什么会直接告诉你该跑哪条命令。模型在控制台里接入，本地会记住，重启不丢（也可以自己在 `.env.local` 里设置 `MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL`）。

Windows 上没有 WSL 的话，`./setup` 就是 `node scripts/setup.mjs` —— 只有 Docker 部署才用得到。

### 控制台打开之后

控制台会一步步引导：**添加网站 → 接入那一行代码 → 接入模型 → 确认接入**。「接入模型」只在还没有模型时出现（之后再接入网站就没有这一步）：选提供方、贴上密钥、写模型名，保存前会先验证 —— 同一个表单也在**设置 → 模型**里。地址填错了，第二步可以退回去改。

网站连上之后，SiteWake 会自动读取网站知识（几分钟，进度在**网站知识**页）。打开你的网站，先让助手做一件只读的事 —— 比如找一款商品 —— 再回控制台看会话记录。不再需要的网站在**网站设置 → 数据 → 删除网站**里删掉。

把控制台暴露到公网之前，先在 `<你的 Origin>/access` 设置密码。

---

## 🧠 模型要求

模型在控制台里接入（引导第三步，或**设置 → 模型**）；`.env` / `.env.local` 里的 `MODEL_*` 仍然有效，作为初始值。任何 OpenAI 兼容的 chat completions 接口都可以用，只有一条硬性要求：模型必须支持**强制工具调用**（`tool_choice` 指定函数名）。聊天正常的模型仍可能无法操作页面；控制台会在保存配置之前同时发送路由请求和真实的页面执行请求，把这种情况拦下来。

每个提供方还需要一份经过验证的请求策略，因为其中几家要求在强制工具调用时关闭思考模式。目前已验证：

| 提供方 | Base URL 主机 | 模型 |
| --- | --- | --- |
| OpenAI | `api.openai.com` | `gpt-*`、`o1`、`o3`…… |
| 阿里云百炼 | `dashscope.aliyuncs.com`、`*.maas.aliyuncs.com` | `qwen*` |
| 智谱 | `open.bigmodel.cn` | `glm*` |
| 火山方舟 | `ark.*.volces.com` | `doubao*`、`deepseek*`、`glm*`、`kimi*`、`qwen*` |

换成其他提供方时，验证会停在 `provider payload policy: …`。把该提供方加进 [`lib/site-knowledge/provider-payload-policy.ts`](lib/site-knowledge/provider-payload-policy.ts)，再用 `npm run check:model-compat` 验证。

---

## 🔧 常见问题

**控制台说模型未配置** —— 打开**设置 → 模型**（或引导第三步）接入一个；在此之前，需要模型的功能都不会运行。

**模型验证报 401 或 403** —— 服务不接受这个密钥。检查密钥本身，以及它是否属于该 Base URL 对应的服务。

**模型验证报 404** —— 多半是 Base URL 少了或多了 `/v1`。按提供方文档原样填写，例如 `https://api.openai.com/v1`。

**模型验证连不上** —— 检查 Base URL 和服务器的网络；请求是从控制面发出的，只在你 shell 里设置的代理对它不可见。

**`./setup` 在本机构建镜像而不是拉取** —— 两条路得到的是同一套服务，构建在全新机器上几分钟，只有第一次。已公开的镜像不需要任何账号，直接拉取。版本还以私有方式发布时，`./setup` 会用这台机器上已有的 GitHub 凭据去取 —— `GITHUB_TOKEN`/`GH_TOKEN`、登录过的 `gh` CLI，或者 `git clone` 当时用的那一份 —— 全程不会再问你一次；都没有就直接从源码构建。要从加速器或自己的仓库拉取，把 `.env` 里的 `SITEWAKE_IMAGE_REGISTRY`（以及 `SITEWAKE_IMAGE_TAG`）指过去。

**从源码构建远不止几分钟** —— 构建要从 npm 源下载依赖，这台机器到 npm 官方源的线路很慢时，光这一步就可能要大半个小时。`./setup` 会先实测几个已知的 npm 源，哪个明显更快就用哪个构建（会打印选中的源；每个包仍按 lockfile 里的哈希校验）。要固定用某个源，把 `SITEWAKE_NPM_REGISTRY` 写进 `.env`，例如 `https://registry.npmmirror.com`，再运行一次 `./setup`。

**`docker compose` 拉不到 `minio/minio`** —— MinIO 已撤掉免费分发：`minio/minio` 和 `minio/mc` 仓库在 Docker Hub 和 `quay.io` 上都拒绝匿名拉取，`dl.min.io` 返回 `410 Gone`。SiteWake 改用 Pigsty 项目基于同一份 AGPL 源码构建的社区镜像（`pgsty/minio`、`pgsty/mc`）。仓库既然已经不公开，镜像加速器也绕不过去；要用自己的副本，把 `.env` 里的 `SITEWAKE_MINIO_IMAGE` 和 `SITEWAKE_MC_IMAGE` 指过去，再运行一次 `./setup`。

**控制台说「创建网站没有成功」，或提示这个控制台地址没有管理权限** —— 管理操作必须来自打开控制台的那个地址。用 `http://localhost:3000` 或局域网 IP 打开时无需配置；通过代理或隧道打开时，让代理转发 `X-Forwarded-Proto` 与 `X-Forwarded-Host`，或把 `.env` 里的 `SITEWAKE_PUBLIC_ORIGIN` 设成你实际打开的地址（`https://console.example.com`）再重启。设置过控制台密码的，先登录。

**`npm run dev` 提示 "Blocked request. This host is not allowed"** —— 开发服务器默认只允许 localhost 和 IP 地址，域名需要显式声明。启动前设置 `SITEWAKE_PUBLIC_ORIGIN`（或 `SITEWAKE_DEV_ALLOWED_HOSTS=my-workspace.example.run`，`all` 表示任意域名）。

**我的网站是 https，控制台是 http** —— 浏览器会拦掉 https 页面里的 http 脚本，直接引用控制台地址不可能生效。第二步会发现这一点并换成可行的装法：让你的网站转发一条路径（`/_sitewake/*` → `http://你的控制台:3000/*`），SDK 从你自己的域名加载，全程同源 —— 没有混合内容，内容安全策略也只需要 `'self'`。浏览器只访问你自己的 https 域名；转发那一跳在服务器之间、是明文 http，页面快照和运行令牌都走它 —— 内测够用，长期建议换成 https。控制台会给出 Vercel、Next.js、Netlify、nginx、Caddy 的写法；提示词让 IDE 按项目实际用的东西来改（Apache、Express、Nuxt、Astro 等同理），而托管本身不能转发时（GitHub Pages、对象存储、Shopify 这类平台，检测能认出来并直说），不允许用前端手段绕过。如果想一次解决所有站点，就给控制台配一个 https 地址（3000 端口前放 TLS 反代或隧道），写进 `.env` 的 `SITEWAKE_PUBLIC_ORIGIN`。

**代码装上了，网站却始终连不上** —— 第二步在给出代码之前会从服务端访问一次你的网站，并直接说明查到的问题：https 页面配 http 控制台（浏览器会拦）、站点的内容安全策略没放行控制台（提示词里会写明要补的 `script-src` / `connect-src`）、或者这个地址会跳到与登记来源不同的地方。跨域本身从来不是原因：控制台对所有来源放行，SDK 也不带凭据。

**SDK 在我的网站上加载不出来** —— `SITEWAKE_PUBLIC_ORIGIN` 必须是访客浏览器能访问到的地址，服务器上不能填 `localhost`。如果你的网站是 HTTPS，这个 Origin 也必须是 HTTPS：在 3000 端口前面放一个 TLS 反向代理（Caddy、nginx、Cloudflare Tunnel），把那个 HTTPS Origin 写进 `.env` 的 `SITEWAKE_PUBLIC_ORIGIN`，再 `docker compose up -d`。

**`control-plane` 一直 unhealthy，日志里是 `password authentication failed for user "sitewake"`** —— 机器上还留着上一次安装的数据卷，Postgres 只认第一次启动时的密码，这次 `./setup` 新生成的密码打不开它。全新安装：`docker compose down -v`（会删掉旧数据），再 `docker compose up -d`。要保留旧数据：把之前的 `POSTGRES_PASSWORD` 和 `MINIO_ROOT_PASSWORD` 填回 `.env`。`./setup` 发现这种卷时会警告；`curl -s http://127.0.0.1:3000/api/health` 会报 `"database":"auth_failed"`。

**`npm run dev` 与 Playwright 浏览器内核** —— 缺内核（Linux 上还有它依赖的系统库）时，`npm run dev` 会自己装好；系统库需要 root，进程已是 root 或 sudo 免密时直接装，否则会把那一条命令打给你。

---

## 🏗️ 架构

```text
┌────────────────────────── 你的网站 ─────────────────────────────┐
│  <script sitewake.js>                                            │
│    └─ 用户 Agent ── DOM 驱动 ── BrowserPort（跨页）              │
└─────────────────────────────┬────────────────────────────────────┘
                              │ site-agent 协议
┌─────────────────────────────▼────────────────────────────────────┐
│                       控制面（Next.js）                           │
│   AgentRun 存储 · 网站知识 · 发布门禁 · 控制台                    │
├──────────────────┬──────────────────────┬────────────────────────┤
│  AI 程序编写者    │  验证 worker         │  执行 worker           │
│                  │  （独立重放）         │  （确定性执行）         │
├──────────────────┴──────────────────────┴────────────────────────┤
│               PostgreSQL  ·  MinIO  ·  Docker Compose            │
└──────────────────────────────────────────────────────────────────┘
```

---

## 📚 文档

运行 SiteWake 需要的材料都在本仓库：本 README 讲安装与使用，[CONTRIBUTING.md](CONTRIBUTING.md) 讲怎么运行与修改代码，[SECURITY.md](SECURITY.md) 讲部署边界，[CHANGELOG.md](CHANGELOG.md) 记录每个版本的变化。

浏览器 SDK 的接口——`SiteWake.open()`、`SiteWake.run()`、`SiteWake.call()`、`SiteWake.teach()`、`SiteWake.cancel()`、`SiteWake.getRelease()`——写在实现它的代码旁边：[client/user-agent-client.ts](client/user-agent-client.ts)。

[sitewake.ai](https://sitewake.ai) 是项目主页。

---

## 🤝 参与贡献

开源的精彩来自每一份贡献。无论是 bug 报告、功能想法、文档改进还是 pull request —— **都欢迎！**

1. Fork 仓库
2. 建分支：`git checkout -b feature/amazing`
3. 跑检查：`npm run lint && npm test`
4. 提交：`git commit -m "feat: something amazing"`
5. 发起 pull request

约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题的报告方式见 [SECURITY.md](SECURITY.md)。

---

## 📄 开源协议

SiteWake 以 [MIT 协议](LICENSE) 开源——使用、修改、分发、商用都可以，保留版权声明即可。

浏览器 SDK 打包了几个 MIT 协议的依赖，主要是阿里巴巴的 [Page Agent](https://github.com/alibaba/page-agent)。它们的版权声明附在构建出的 `sitewake.js` / `sitewake-adaptive.js` 末尾，并列在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。能力编写用的页面契约来自 [OpenCLI](https://github.com/jackwener/OpenCLI)（Apache 2.0），归属见 [NOTICE](NOTICE)。

---

## ⭐ Star 趋势

如果 SiteWake 帮到了你，一个 ⭐ 对我们意义重大！

[![Star History Chart](https://api.star-history.com/svg?repos=sitewake/sitewake&type=Date)](https://star-history.com/#sitewake/sitewake&Date)

---

<div align="center">

**[sitewake.ai](https://sitewake.ai)** · [GitHub](https://github.com/sitewake/sitewake) · [MIT 协议](LICENSE) © 2026 SiteWake contributors

</div>
