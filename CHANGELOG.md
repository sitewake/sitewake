# Changelog

All notable changes to SiteWake are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Each entry corresponds to a git tag
`vX.Y.Z` and a GitHub Release with the same notes.

## 1.0.0 - 2026-10-04

First public release.

### Available

- **One-line install** — a single `<script>` tag puts the agent on any page; no backend integration, no headless browser farm.
- **In-page execution** — the agent operates the visitor's real page, in the visitor's own session, with the visitor's permissions.
- **Session records** — every task ends in one of four outcomes (completed / no result / business rejection / execution fault), with the step-by-step trace visible in the console.
- **Site knowledge** — the server crawls the site the agent is installed on and keeps a page-structure and content index, each fact with its source.
- **Capabilities** — a successfully completed goal is turned into a contract, authored as a program in an isolated browser, replayed independently, and only then published as a reusable capability that runs without a model call.
- **Console** — overview, agent preview, user sessions, capabilities and knowledge for each site, with a four-step onboarding flow for the first site (add the site, install the code, connect a model, confirm).
- **Deployment** — `./setup` asks only the language and brings up the full Compose stack (control plane, PostgreSQL, MinIO, program author, validation and execution workers) from prebuilt images on ghcr.io, building from source only when they cannot be pulled (from whichever known npm registry is measurably fastest from that machine); a compact profile for small machines; a container smoke test. Local development is `npm install && npx playwright install chromium && npm run dev`.
- **Model support** — connected and verified in the console (onboarding step three or Settings → Models); any OpenAI-compatible endpoint that supports forced tool calls; verified request policies for OpenAI, Alibaba Cloud Bailian, Zhipu and Volcengine Ark. Only the control plane holds the key; workers call the model through it.
- **Bilingual** — console and setup wizard in English and Chinese.

### Experimental

- **Cold-path autonomous operation** — the agent acting on a page for a goal it has never seen still needs validation on real sites; expect maintenance.
- **Automatic capability promotion** — self-learning and failure recovery are in place but not yet proven to run unattended on an arbitrary website.
