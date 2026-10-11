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

**Model verification says 401 or 403** — the service did not accept the key. Check the key, and that it belongs to the service at that base URL.

**Model verification says 404** — the base URL is usually missing or has an extra `/v1`. Enter the URL exactly as the provider documents it, for example `https://api.openai.com/v1`.

**Model verification cannot connect** — check the base URL and the server's network access; the request is sent from the control plane, so a proxy configured only in your shell is not visible to it.

**`./setup` builds the images instead of pulling them** — both paths produce the same stack; building takes a few minutes on a fresh machine, once. Published images are pulled with no account at all. While a release is published privately, `./setup` reaches it with a GitHub credential this machine already has — `GITHUB_TOKEN`/`GH_TOKEN`, a signed-in `gh` CLI, or the one `git clone` itself used — and never asks for one; with none of those it simply builds. To pull from a mirror or your own registry, set `SITEWAKE_IMAGE_REGISTRY` (and `SITEWAKE_IMAGE_TAG`) in `.env`.

**Building from source takes far longer than a few minutes** — the build downloads its packages from npm's registry, and on a machine whose route there crawls that alone can take most of an hour. `./setup` measures the known npm registries first and builds from a mirror when it is clearly faster (it prints the one it chose; every package is still verified against the lockfile's integrity hashes). To force one registry, set `SITEWAKE_NPM_REGISTRY` in `.env`, for example `https://registry.npmmirror.com`, and run `./setup` again.

**`docker compose` cannot pull `minio/minio`** — MinIO no longer publishes to Docker Hub; SiteWake pulls its images from `quay.io`. If your machine can only reach a registry mirror, set `SITEWAKE_MINIO_IMAGE` and `SITEWAKE_MC_IMAGE` in `.env` to the mirror's copies and run `./setup` again.

**The console says the site could not be created, or "this console address is not allowed"** — management actions must come from the address the console is served at. Opening it at `http://localhost:3000` or a LAN IP works as is; behind a proxy or tunnel, the proxy should pass `X-Forwarded-Proto` and `X-Forwarded-Host`, or set `SITEWAKE_PUBLIC_ORIGIN` in `.env` to the address you open (`https://console.example.com`) and restart. If a console password is set, sign in first.

**`npm run dev` answers "Blocked request. This host is not allowed"** — the dev server allows localhost and IP addresses; a hostname must be named. Set `SITEWAKE_PUBLIC_ORIGIN` (or `SITEWAKE_DEV_ALLOWED_HOSTS=my-workspace.example.run`, `all` for any) before `npm run dev`.

**My website is https and the console is plain http** — a browser blocks a plain-http script inside an https page, so the direct snippet cannot work. Step two notices this and switches to the install that does: your site forwards one path to the console (`/_sitewake/*` → `http://your-console:3000/*`) and the SDK loads from your own domain, so nothing is cross-origin — no mixed content, and a Content-Security-Policy needs no entry beyond `'self'`. The browser only ever talks to your own https domain; the forwarding hop happens between servers, in plain http, and page snapshots and run tokens travel it — fine for testing, worth replacing with https for the long run. The console shows the rewrite for Vercel, Next.js, Netlify, nginx and Caddy; the prompt tells your IDE to use whatever this project really has (Apache, Express, Nuxt, Astro and the rest), and to stop rather than improvise if the host only serves files — GitHub Pages, object storage or a platform like Shopify, which the check recognises and says so. If you would rather fix it once for every site, give the console an https address — a TLS reverse proxy or a tunnel in front of port 3000 — and put it in `SITEWAKE_PUBLIC_ORIGIN` in `.env`.

**The console's snippet is installed but the site never connects** — step two checks the site from the server before handing the snippet over and names what it found: an https page with an http console (blocked by the browser), a Content-Security-Policy that does not admit the console (the prompt then tells your IDE which `script-src` / `connect-src` entries to add), or an address that redirects to another origin than the one registered. CORS is never the cause: the control plane answers every origin and the SDK sends no credentials.

**The SDK does not load on my site** — `SITEWAKE_PUBLIC_ORIGIN` must be an address your visitors' browsers can reach, not `localhost` on a server. If your website is served over HTTPS, the origin must be HTTPS as well: put a TLS reverse proxy (Caddy, nginx, Cloudflare Tunnel) in front of port 3000, set that HTTPS origin as `SITEWAKE_PUBLIC_ORIGIN` in `.env` and run `docker compose up -d`.

**`control-plane` stays unhealthy and its log says `password authentication failed for user "sitewake"`** — a data volume from an earlier install is still there, and Postgres keeps the password it was first started with, so the password `./setup` generated this time does not open it. Fresh install: `docker compose down -v` (deletes the old data), then `docker compose up -d`. To keep the old data instead, put the earlier `POSTGRES_PASSWORD` and `MINIO_ROOT_PASSWORD` back into `.env`. `./setup` warns about this when it finds such a volume; `curl -s http://127.0.0.1:3000/api/health` reports it as `"database":"auth_failed"`.

**`npm run dev` and the Playwright browser** — `npm run dev` installs the browser, and on Linux its system libraries, when they are missing (system libraries need root: it uses it when the process has it or when sudo needs no password, and otherwise prints the one command to run).

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

Everything needed to run SiteWake is in this repository: this README installs and uses it, [CONTRIBUTING.md](CONTRIBUTING.md) covers running and changing the code, [SECURITY.md](SECURITY.md) the deployment boundary, [CHANGELOG.md](CHANGELOG.md) what each release changed.

The browser SDK's surface — `SiteWake.open()`, `SiteWake.run()`, `SiteWake.call()`, `SiteWake.teach()`, `SiteWake.cancel()`, `SiteWake.getRelease()` — is documented beside the code that implements it, in [client/user-agent-client.ts](client/user-agent-client.ts).

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
