# SiteWake Evolution Lab

This lab runs the real discovery, canonicalization, capability compiler,
projector and release gate against controlled evidence. It is deliberately
separate from product websites and live models.

- `npm run test:knowledge` runs website-fact and topology contracts.
- `npm run test:capability` runs Intent, parameterization and release contracts.
- `npm run test:evolution` combines this suite with the Chromium Agent Runtime Lab.
- `.evolution-lab/` receives machine-readable reports for every scenario.

When a production issue is found, add a smallest reproducible Scenario here
before changing runtime code. The regression then becomes permanent.
