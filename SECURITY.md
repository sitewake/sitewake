# Security reports

SiteWake executes actions in a user's browser and processes page content. Reports involving authentication, cross-site or cross-user access, server-side request forgery, arbitrary code execution, credential exposure or unsafe capability publication are particularly useful.

Do not report exploitable vulnerabilities or credentials in a public issue. If the repository provides GitHub's **Report a vulnerability** option under Security, use that private channel. Otherwise, contact a maintainer through a private contact they have published before sending exploit details. This repository does not currently declare a dedicated security email or response-time commitment.

Include the affected revision, deployment type, minimal reproduction, expected boundary, observed impact, and a suggested fix if available. Use synthetic sites and accounts; remove model keys, session tokens, personal data and production addresses from attachments.

## Known advisories in production dependencies

An advisory against a production dependency is either fixed or written down. [`security/accepted-advisories.json`](security/accepted-advisories.json) holds the ones with no patched release: for each, why no upgrade exists, which code paths can reach it, and the date the decision has to be made again. The release gate reads that file — an unlisted critical or high advisory fails the build, and so does an entry whose review date has passed.

Each entry records an advisory id. `npm audit` reports one advisory once per node of the dependency path it travels, so a single finding six levels deep reads as six findings; the id is what tells them apart.

## Deployment boundary

Keep the management console behind access control when exposed beyond local development. Keep model keys on the server. A user-authorized browser session is not authorization to share that user's private page data with other users or to publish an unverified capability.

Use the supplied configuration examples as templates. Never serve the repository root as a static website: it can contain private environment files and local data. `npm run preview:product` serves only the public product prototype.

The project is in preview. No long-term security maintenance window is declared for older revisions; report against the latest revision you can reproduce on.
