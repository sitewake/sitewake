<div align="center">

<img src="public/brand/sitewake-mark.svg" alt="SiteWake" width="96" height="96"/>

# SiteWake

### The Website-Native AI Agent — One Line of Code, Infinite Capability

**Turn any website into an intelligent agent that understands your users, operates your UI, and teaches itself new skills.**

🌐 **Official Website: [sitewake.ai](https://sitewake.ai)**

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
  <sub>The agent understands the goal, operates the real page, and completes the task. <a href=".github/assets/demo.mp4">Watch the full-quality video (mp4, 30 s)</a>.</sub>
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

Most "web agents" launch a fresh server-side browser for every request — slow, stateless, and blind to your user's context. **SiteWake is UI-native**: the agent lives *inside* your page.

| | Traditional Web Agents | **SiteWake** |
|---|---|---|
| Execution | Headless browser per request | User's real page, real session |
| Login state | Re-authenticated / lost | Inherited naturally |
| Learning | None — same mistakes forever | Success → verified, reusable Capability |
| Integration | API/MCP runtime required | One `<script>` tag |
| Speed | Cold start every time | Published capabilities run deterministically, no LLM call |

### The Self-Evolution Loop

```text
User states a goal
  └─ The agent understands context and picks tools
       ├─ Query site knowledge: products, page types, known paths
       ├─ Call published Capabilities: real return values, like functions
       ├─ Operate the current page: only for genuinely unknown gaps
       └─ Missing parameters: asks in-place, never guesses

Success → AI designs capability contract → AI authors program in isolated browser
        → Independent real replay → Published shared Capability

Failure → Distinguish business rejection from execution fault
        → Fix only real execution gaps
```

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

You need **one** of:

- **Docker** with Compose v2 — to deploy on a server or a NAS.
- **Node.js ≥ 22.13** — to run it on your laptop for development.

And an API key for an OpenAI-compatible model service (see [Model Requirements](#-model-requirements)).

`./setup` is an interactive wizard. It asks where SiteWake will run, asks for your model service, verifies the model with real requests **before** writing anything, generates every secret Docker Compose needs, and prints the next command. It runs straight after cloning — no `npm install` first. If the machine has no Node.js, it runs the same wizard inside a throwaway `node:22-alpine` container.

### Docker Compose (Recommended)

The standard open-source deployment. One command starts the Control Plane, PostgreSQL, MinIO, AI Program Author, and independent Validation/Execution Workers:

```bash
git clone https://github.com/sitewake/sitewake.git
cd sitewake
./setup
docker compose up -d --build
```

`./setup` asks these things and writes `.env`:

1. **Language** — English or 中文.
2. **How SiteWake runs** — choose *As a Docker Compose stack — for deployment*.
3. **Model provider** — pick one of the verified providers (OpenAI, Alibaba Cloud Bailian, Zhipu, Volcengine Ark; the base URL is filled in for you) or enter the base URL of another OpenAI-compatible service.
4. **API key** — from the provider's console; typed without echo, stored in `.env` as `MODEL_API_KEY`, never sent to visitors' browsers.
5. **Model** — the exact model id from your provider's list; it must support tool calls (the wizard names the verified families).
6. **How visitors reach this server** — trying it out on this machine, a domain name (required for HTTPS websites), a public IP, or the local network. The wizard derives the server address your website loads the SDK from, e.g. `https://agent.example.com`.

It then sends both runtime requests to the model and only writes the file if they pass. The database and MinIO passwords and the four runner secrets are generated for you; rerunning `./setup` later keeps them. To change the model afterwards, rerun `./setup` (press Enter to keep the key) or edit `MODEL_BASE_URL`, `MODEL_API_KEY` and `MODEL` in `.env`, then `docker compose up -d`.

Works with **any OpenAI-compatible model service** — no vendor lock-in. The stack listens on port 3000; open the origin you entered.

Small machine (2 CPU / 2 GB)? Use the compact profile — one browser at a time, a single worker:

```bash
docker compose -f compose.yaml -f compose.compact.yaml up -d --build
```

Check that it is healthy:

```bash
curl -s http://127.0.0.1:3000/api/health
docker compose exec -T control-plane node scripts/container-smoke.mjs
```

The health response must contain `"runtime":"container"`. The smoke test checks the database, object storage, runner registration, model configuration and the SDK.

### Local Development (Node ≥ 22.13)

```bash
git clone https://github.com/sitewake/sitewake.git
cd sitewake
./setup
npm install
npx playwright install chromium
npm run dev
```

`./setup` writes `.env.local`. Choose **From source with Node.js — for development** when asked how SiteWake runs. `npx playwright install chromium` downloads the browser the runner uses to crawl sites (a few hundred MB, once). `npm run dev` runs a preflight check first — Node version, browser, model configuration, free ports — and lists everything that is missing in one go.

Then open **<http://localhost:3000>**.

On Windows without WSL, run `node scripts/setup.mjs` instead of `./setup`.

### After the Console Opens

The first thing it shows is a three-step onboarding: **create your site → add the one-line snippet → detect the connection**. Follow it with your own website; the snippet it gives you carries the real site id and SDK address. Once the console reports the connection, SiteWake starts reading your site's knowledge on its own — usually a few minutes; watch the progress under **Site knowledge**, where you can also re-read at any time. Meanwhile, open your site and ask the assistant for something read-only first — finding a product, say — then come back to the console's session records to see what it did. A site you no longer want goes away under **Site settings → Data → Delete site**, together with everything it learned.

Before you expose the console to the internet, set a password at `<your origin>/access`. Until you do, the console is open to anyone who can reach it.

---

## 🧠 Model Requirements

Any OpenAI-compatible chat completions endpoint works, with one hard requirement: the model must support **forced tool calls** (`tool_choice` naming a function). A model that chats well can still be unable to operate a page; `./setup` catches this by sending both the routing request and the real page-execution request before it writes your configuration.

Every provider also needs a verified request policy, because several of them require thinking mode to be switched off whenever a tool call is forced. Verified today:

| Provider | Base URL host | Models |
| --- | --- | --- |
| OpenAI | `api.openai.com` | `gpt-*`, `o1`, `o3`, … |
| Alibaba Cloud Bailian | `dashscope.aliyuncs.com`, `*.maas.aliyuncs.com` | `qwen*` |
| Zhipu | `open.bigmodel.cn` | `glm*` |
| Volcengine Ark | `ark.*.volces.com` | `doubao*`, `deepseek*`, `glm*`, `kimi*`, `qwen*` |

For another provider, `./setup` stops with `provider payload policy: …`. Add the provider to [`lib/site-knowledge/provider-payload-policy.ts`](lib/site-knowledge/provider-payload-policy.ts) and verify it with `npm run check:model-compat`.

---

## 🔧 Troubleshooting

**`./setup` says 401 or 403** — the service did not accept the key. Check the key, and that it belongs to the service at that base URL.

**`./setup` says 404** — the base URL is usually missing or has an extra `/v1`. Enter the URL exactly as the provider documents it, for example `https://api.openai.com/v1`.

**`./setup` cannot connect** — check the base URL and the machine's network access. If `./setup` had to run inside a container (no Node.js on the machine), a proxy configured only in your shell is not visible to it.

**The SDK does not load on my site** — `SITEWAKE_PUBLIC_ORIGIN` must be an address your visitors' browsers can reach, not `localhost` on a server. If your website is served over HTTPS, the origin must be HTTPS as well: put a TLS reverse proxy (Caddy, nginx, Cloudflare Tunnel) in front of port 3000 and rerun `./setup` with that HTTPS origin.

**`npm run dev` says the Playwright browser is not installed** — run `npx playwright install chromium`. Skipping it lets everything start, until the runner first needs to crawl a site.

---

## 🏗️ Architecture

```text
┌────────────────────────── Your website ──────────────────────────┐
│  <script sitewake.js>                                            │
│    └─ User Agent ── DOM driver ── BrowserPort (cross-page)       │
└─────────────────────────────┬────────────────────────────────────┘
                              │ site-agent protocol
┌─────────────────────────────▼────────────────────────────────────┐
│                      Control plane (Next.js)                     │
│   AgentRun store · Site knowledge · Release gate · Console       │
├──────────────────┬──────────────────────┬────────────────────────┤
│  AI program      │  Validation worker   │  Execution worker      │
│  author          │  (independent replay)│  (deterministic runs)  │
├──────────────────┴──────────────────────┴────────────────────────┤
│               PostgreSQL  ·  MinIO  ·  Docker Compose            │
└──────────────────────────────────────────────────────────────────┘
```

---

## 📚 Documentation

Guides, the browser SDK API reference (`SiteWake.run()`, `SiteWake.call()` and friends), the architecture map and deployment notes live on the website: **[sitewake.ai](https://sitewake.ai)**.

In this repository: [CONTRIBUTING.md](CONTRIBUTING.md) for running and changing the code, [SECURITY.md](SECURITY.md) for the deployment boundary, [CHANGELOG.md](CHANGELOG.md) for what each release changed.

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
