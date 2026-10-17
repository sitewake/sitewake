# Changelog

All notable changes to SiteWake are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Each entry corresponds to a git tag
`vX.Y.Z` and a GitHub Release with the same notes.

## 1.0.2 - 2026-10-17

What `./setup` reports about its own result.

### Fixed

- **`./setup` called a working stack "not ready"** — the port check only looked at containers (`docker ps --filter publish`), so a server that is not a container, such as a development server, went unseen. Docker could then still bind the port on one address family while every health probe reached the other server, and the report blamed a slow machine for a stack that had been ready for seconds. The port is now asked what it is before the stack starts and again if the wait ends on a reply that is not SiteWake's, and the report names the other server instead of guessing.
- **The console address could be one this machine cannot reach** — a LAN or public address was printed and `http://localhost:<port>` never was, which left a reader on a laptop with no address to try. Both are printed now.
- **The "check again" hint always said port 3000** — it now carries the port the install actually uses.
- **Capability experience reconciliation failed on a fresh database** — `relation "site_agent_v2_episodes" does not exist`. The reconcile path ensured the V3 schema but joins a V2 table, and the two schemas have separate storage versions and caches, so the table was missing until something else created it. Both are ensured now.

### Changed

- The README links the live demo: [demo-website.sitewake.ai](https://demo-website.sitewake.ai) and [demo-console.sitewake.ai](https://demo-console.sitewake.ai).
- The README is a quarter shorter. Gone: the comparison against "traditional web agents", which rested on a claim about other products that nothing here substantiates; a "Speed" line claiming published capabilities run with no model call, which is not what happens; the self-evolution and architecture diagrams; the browser SDK method list; the header logo; and nine troubleshooting entries. The install path, the model setup and the five failures a first install actually hits are unchanged.

## 1.0.1 - 2026-10-15

Object storage images follow MinIO's withdrawal from free distribution.

### Fixed

- **`./setup` could not bring up the stack on a fresh machine** — MinIO made its `minio/minio` and `minio/mc` repositories non-public on both Docker Hub and quay.io, and withdrew the binaries from `dl.min.io`, so `docker compose pull` ended in `401 UNAUTHORIZED` and the stack never started. Object storage now uses the Pigsty project's community builds of the same AGPL sources (`pgsty/minio`, `pgsty/mc`), pinned to a release. Nothing else about the stack changes: the same `server /data` command, the same `/data` volume, the same health check and the same bucket initialisation. A registry mirror cannot reach a repository that is no longer public, so the troubleshooting entry that recommended one is corrected in both READMEs.

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
