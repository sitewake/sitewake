<div align="center">

# SiteWake

### The Website-Native AI Agent — One Line of Code, Infinite Capability

**Turn any website into an intelligent agent that understands your users, operates your UI, and teaches itself new skills.**

🌐 **Official Website: [sitewake.ai](https://sitewake.ai)**

🎮 **Live demo: [demo-website.sitewake.ai](https://demo-website.sitewake.ai) · [demo-console.sitewake.ai](https://demo-console.sitewake.ai)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-black.svg)](https://nextjs.org/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED.svg)](compose.yaml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/sitewake/sitewake?style=social)](https://github.com/sitewake/sitewake)

**English** · [中文](README.zh-CN.md)

</div>

<div align="center">
  <img src=".github/assets/demo.gif" alt="SiteWake demo — the agent understands the goal, operates the real page, and completes the task" width="880"/>
  <br/>
  <sub>The agent understands the goal, operates the real page, and completes the task. <a href=".github/assets/demo.mp4">Watch the full-quality video (mp4, 1080p, 30 s)</a>.</sub>
</div>

---

## ✨ One Line. That's It.

```html
<script src="https://your-sitewake-host/sitewake.js"
        data-site-agent="your-site-id"
        data-endpoint="https://your-sitewake-host"
        defer></script>
```

Drop this snippet into any page — plain HTML, React, Next.js, Vue, anything that renders a `<script>` tag — and your website instantly gets an AI agent that:

- 🗣️ **Understands user intent** — users just say what they want, in natural language
- 🖱️ **Operates your real UI** — clicks, fills, navigates on the actual page, in the user's own session
- 🧠 **Learns continuously** — successful tasks become reusable, verified **Capabilities**
- 🚀 **Requires zero backend changes** — no API integration, no MCP server, no headless browser farm

> Open-source preview. In-page execution, session records, site knowledge and capability validation are in place; self-learning and failure recovery still need validation on real sites. Do not expect zero-maintenance on an arbitrary website yet.

---

## 🎯 Why SiteWake?

The agent runs inside your page, in the visitor's own session:

- **Execution** — the visitor's real page, with their real session
- **Login state** — inherited, with nothing to re-authenticate
- **Learning** — a success becomes a verified, reusable Capability
- **Integration** — one `<script>` tag

Every real task makes your site's agent smarter. Page by page, your console lights up with learned knowledge.

---

## 🖥️ The Console

Not a training dashboard — a **living agent** you can watch grow:

- **📊 Overview** — real-time site model: what the agent has learned, which capabilities have formed
- **🤖 Agent** — how the assistant looks and behaves on your pages, previewed exactly as visitors see it
- **📜 User Sessions** — per-task outcomes: completed / no-result / business-rejected / execution-fault, with the step-by-step trace
- **⚡ Capabilities** — only complete, reliably-delivered user goals; navigation clicks never masquerade as business capability
- **🗺️ Knowledge** — the site's page structure and indexed content, each fact with its source

---

## 🚀 Quick Start

Live demo: [demo-website.sitewake.ai](https://demo-website.sitewake.ai) · [demo-console.sitewake.ai](https://demo-console.sitewake.ai)

You need **one** of:

- **Docker** with Compose v2 — to deploy on a server or a NAS.
- **Node.js ≥ 22.13** — to run it on your laptop for development.

And, once the console is open, an API key for an OpenAI-compatible model service (see [Model Requirements](#-model-requirements)) — you connect the model in the console, not before.

### Docker Compose (Recommended)

One command on a server with Docker (Compose v2):

```bash
git clone https://github.com/sitewake/sitewake.git
cd sitewake
./setup
```

`./setup` asks one thing — the language — and does the rest: pulls this release's prebuilt images (about a minute; it builds from source only if it cannot pull), starts the stack, waits until it is healthy and prints the address to open. Open it and the console walks you through connecting your website and your model. On a cloud VM, open TCP 3000 in the security group first, and make sure your user may use Docker (`sudo usermod -aG docker $USER`, then log in again).

Your own domain or HTTPS? Set `SITEWAKE_PUBLIC_ORIGIN` in `.env` (an HTTPS site needs an `https://` address with a TLS reverse proxy in front of port 3000) and run `docker compose up -d`.

Small machine (2 CPU / 2 GB)? Use the compact profile — one browser at a time, a single worker:

```bash
docker compose -f compose.yaml -f compose.compact.yaml up -d --build
```

Prefer to run things yourself? `./setup --no-start` only writes `.env`; then `docker compose up -d --build`. To check a running stack:

```bash
curl -s http://127.0.0.1:3000/api/health
docker compose exec -T control-plane node scripts/container-smoke.mjs
```

### Local Development (Node ≥ 22.13)

```bash
git clone https://github.com/sitewake/sitewake.git
cd sitewake
npm install
npx playwright install chromium   # Linux: npx playwright install --with-deps chromium
npm run dev
```

Then open **<http://localhost:3000>**. `npx playwright install chromium` fetches the browser the runner uses (a few hundred MB, once) — on Linux use `npx playwright install --with-deps chromium` so its system libraries come along. `npm run dev` checks Node, the browser (and its libraries) and free ports before starting, and tells you exactly what to run if something is missing. The model is connected in the console and kept locally across restarts (or set `MODEL_API_KEY`, `MODEL_BASE_URL` and `MODEL` in `.env.local`).

On Windows without WSL, `./setup` is `node scripts/setup.mjs` — needed only for the Docker path.

### After the Console Opens

The console walks you through it: **add your site → install the one-line snippet → connect a model → confirm**. The model step appears only while none is connected (later sites skip it); pick a provider, paste the key, name the model, and it is verified before it is saved — the same form is under **Settings → Models**. A wrong address can be changed from step two.

Once the site is connected, SiteWake reads its knowledge on its own (a few minutes; progress under **Site knowledge**). Open your site, ask the assistant for something read-only first — finding a product, say — then check the session records in the console. A site you no longer want goes away under **Site settings → Data → Delete site**.

Before you expose the console to the internet, set a password at `<your origin>/access`.

---

## 🧠 Model Requirements

You connect the model in the console (onboarding step three, or **Settings → Models**); `MODEL_*` in `.env` / `.env.local` still works as a starting value. Any OpenAI-compatible chat completions endpoint works, with one hard requirement: the model must support **forced tool calls** (`tool_choice` naming a function). A model that chats well can still be unable to operate a page; the console catches this by sending both the routing request and the real page-execution request before it saves your configuration.

Every provider also needs a verified request policy, because several of them require thinking mode to be switched off whenever a tool call is forced. Verified today:

| Provider | Base URL host | Models |
| --- | --- | --- |
| OpenAI | `api.openai.com` | `gpt-*`, `o1`, `o3`, … |
| Alibaba Cloud Bailian | `dashscope.aliyuncs.com`, `*.maas.aliyuncs.com` | `qwen*` |
| Zhipu | `open.bigmodel.cn` | `glm*` |
| Volcengine Ark | `ark.*.volces.com` | `doubao*`, `deepseek*`, `glm*`, `kimi*`, `qwen*` |

For another provider, verification stops with `provider payload policy: …`. Add the provider to [`lib/site-knowledge/provider-payload-policy.ts`](lib/site-knowledge/provider-payload-policy.ts) and verify it with `npm run check:model-compat`.

---

## 🔧 Troubleshooting

**The console says no model is connected** — open **Settings → Models** (or onboarding step three) and connect one; nothing that needs the model runs until then.

**Model verification fails** — a 401 or 403 means the service rejected the key; a 404 usually means the base URL is missing or has an extra `/v1`. Enter it exactly as the provider documents it, for example `https://api.openai.com/v1`.

**The console says the site could not be created, or "this console address is not allowed"** — management actions must come from the address the console is served at. Behind a proxy or tunnel, set `SITEWAKE_PUBLIC_ORIGIN` in `.env` to the address you open, and restart.

**Your site is https and the console is http** — a browser blocks a plain-http script inside an https page. The console's install step detects this and offers the install that works; for a lasting fix, put https in front of port 3000 and set that as `SITEWAKE_PUBLIC_ORIGIN`.

**`control-plane` stays unhealthy with `password authentication failed`** — a data volume from an earlier install kept its original password. `docker compose down -v` starts fresh; to keep the old data, put the earlier `POSTGRES_PASSWORD` and `MINIO_ROOT_PASSWORD` back into `.env`.

`docker compose logs --tail=60 control-plane` says what the stack itself thinks is wrong.

---

## 📚 Documentation

Everything needed to run SiteWake is in this repository: this README installs and uses it, [CONTRIBUTING.md](CONTRIBUTING.md) covers running and changing the code, [SECURITY.md](SECURITY.md) the deployment boundary, [CHANGELOG.md](CHANGELOG.md) what each release changed.

[sitewake.ai](https://sitewake.ai) is the project's home page.

---

## 🤝 Contributing

Contributions are what make open source amazing. Whether it's a bug report, a feature idea, docs improvement, or a pull request — **all are welcome!**

1. Fork the repo
2. Create your branch: `git checkout -b feature/amazing`
3. Run the checks: `npm run lint && npm test`
4. Commit: `git commit -m "feat: something amazing"`
5. Open a Pull Request

See [CONTRIBUTING.md](CONTRIBUTING.md) for the conventions and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

---

## 📄 License

SiteWake is open source under the [MIT License](LICENSE) — use it, change it, ship it, commercially or not. Keep the copyright notice and you're done.

The browser SDK bundles a few MIT-licensed packages, notably [Page Agent](https://github.com/alibaba/page-agent) by Alibaba. Their copyright notices are appended to the built `sitewake.js` / `sitewake-adaptive.js` and listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The authored-capability page contract comes from [OpenCLI](https://github.com/jackwener/OpenCLI) (Apache 2.0), credited in [NOTICE](NOTICE).

---

## ⭐ Star History

If SiteWake helps you, a ⭐ means the world to us!

[![Star History Chart](https://api.star-history.com/svg?repos=sitewake/sitewake&type=Date)](https://star-history.com/#sitewake/sitewake&Date)

---

<div align="center">

**[sitewake.ai](https://sitewake.ai)** · [GitHub](https://github.com/sitewake/sitewake) · [MIT License](LICENSE) © 2026 SiteWake contributors

</div>
