# SiteWake Agent Runtime Lab

This is a controlled Chromium laboratory for the SiteWake runtime. It loads
the production-built `public/sitewake.js`, but intercepts two virtual origins:

- `site.agent.test` is a deterministic mini website.
- `control.agent.test` is an in-memory control plane and scripted zero-latency model.

No test talks to a public website or D1. The lab is intentionally focused on
runtime correctness: BrowserPort handoff, context conservation, cancellation,
deterministic capability execution, PageAgent exploration and framework
latency.

The baseline suite covers both paths that can affect a real user:

- known capabilities: direct execution, cross-document handoff, invalid
  Target rejection and refresh/cancel boundaries;
- PageAgent: one- and three-document exploration, destination-page progress,
  no-result completion, invalid clicks and cancellation after a handoff;
- each navigation records immutable task-context snapshots and separate page
  identity snapshots, so a regression points to the exact lost field rather
  than only showing a failed end-to-end test.

Add every new online bad case here first as a deterministic virtual-page
scenario. The scripted model is deliberately separate from the runtime: it
lets a test prove the BrowserPort, state machine and UI behavior without
mistaking model latency or model randomness for a framework issue.

Run all scenarios:

```bash
npm run test:agent
```

Run one scenario with an inspectable browser and Playwright trace:

```bash
npm run test:agent:debug -- --case known-capability-cross-page
```

Run the warm-up and 20-run performance benchmark:

```bash
npm run test:agent:benchmark
```

Failures write screenshots, control-plane timelines, context snapshots and run
state to `.agent-lab/`. That directory is ignored by Git.
