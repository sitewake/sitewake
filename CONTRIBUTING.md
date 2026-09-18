# Contributing to SiteWake

SiteWake is in preview. Contributions should make a user's task more reliable, make its outcome easier to verify, or make the project easier to run and understand.

## Run locally

Use Node.js 22.13 or later:

```sh
./setup                            # choose "local development"; verifies the model before writing .env.local
npm ci
npx playwright install chromium
npm run dev
```

The console runs at `http://localhost:3000`. The setup wizard (`./setup`, or `npm run setup`) checks chat routing and page execution against your model service before saving anything to `.env.local`; it speaks English unless your terminal's `LANG` is Chinese (`--lang zh|en` overrides). On Windows without WSL, run `node scripts/setup.mjs` instead of `./setup`.

Connect your own website from the console's onboarding flow, start with a read-only task such as finding a product, then inspect its result in the console.

## Make a change

Keep each change focused on one observable behavior. Explain the concrete problem, expected result, and how you checked it. For a product direction change, include an interactive prototype and distinguish implemented behavior from proposed behavior.

Useful checks:

```sh
npm run typecheck:production
npm run build
node --import tsx --test tests/setup-model.test.mjs tests/console-outcomes.test.mjs
npm run test:contracts
npm run test:runtime-security
npm run test:deploy-contract
```

`npm test` runs the broader suite. `npm run test:public` is the release gate — the same suite minus the files listed in `scripts/test-public.mjs`, which are known to fail today and are being fixed separately; a PR must keep it green. Some integration and real-model suites have separate commands in `package.json`. Include failing checks in the PR description; do not describe unrun or mocked checks as real-model validation.

## Names

The product is **SiteWake**, and every identifier a user or operator sees carries that name:

| Kind | Actual value |
| --- | --- |
| SDK file and global object | `/sitewake.js`, `window.SiteWake` |
| Environment variables | `SITEWAKE_PUBLIC_ORIGIN` and the other `SITEWAKE_*` (runner settings included); model provider via `MODEL_*` |
| Server-side runtime config path | `/etc/sitewake/runtime.env` |

There is exactly one spelling of each; `tests/brand-purity.test.mjs` fails the build if an earlier product name comes back.

## Releases and versioning

Maintainers cut releases; contributors do not need to think about version numbers.

- `main` is unreleased work. A release is a commit titled `Release vX.Y.Z` with an annotated tag `vX.Y.Z` and a GitHub Release whose notes come from [CHANGELOG.md](CHANGELOG.md). Tags never move: a fix to a released version ships as the next patch version (`vX.Y.Z+1`), a batch of features as the next minor version.
- Every pull request runs `npm run test:public` on GitHub Actions (the `gate` job); it has to be green before a merge. Pull requests are **squash-merged**, one commit per PR, under your name. Your change ships in the next `Release vX.Y.Z` and is listed in that release's notes.
- Do not change `version` in `package.json`, add a version heading to `CHANGELOG.md`, or create tags in a PR — the maintainer doing the release does that in one place. Describing the user-visible change in the PR is what ends up in the notes.
- Maintainers develop in a private repository and publish each release from it. A merged PR is carried into that repository before the next release; the next `Release vX.Y.Z` commit contains it, so a merge on GitHub is the whole contribution.

## Code and data boundaries

- Agent actions run in the current user's page and permissions. Preserve site and user isolation.
- A successful HTTP request or click is not proof that a business goal completed.
- Keep interface copy in locale catalogs. Distinguish unknown results, empty results, business rejection and execution faults.
- Keep model keys and local environment files out of source and logs. Use synthetic fixtures in tests.
- Do not include runtime recordings, user data, production host credentials or `.env.local` in a contribution.
- Preserve compatibility aliases unless the change includes a migration plan.

## Reports and discussion

For ordinary bugs, include reproduction steps, relevant versions, the observed result and the expected result. Remove keys, cookies and personal data from logs and screenshots. For security issues, follow [SECURITY.md](SECURITY.md).

Be specific, constructive and respectful in reviews. Contributions are distributed under the repository's [MIT license](LICENSE).
