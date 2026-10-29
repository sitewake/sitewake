# Capability benchmark

A fixed set of visitor tasks on websites served inside a local Docker network,
run end to end with the real model: the visitor asks, the answer or the site's
state is checked against facts computed from the site, a successful run's
capability generation is followed to its end, and the published capability is
asked again with another parameter. The output is three rates and a failure
list grouped by cause. It is the measure for every change to the capability
module; it is not part of CI.

## Commands

| Command | What it does |
| --- | --- |
| `npm run benchmark:up` | Env file, mirrored sites, images, the stack, console password, sites registered and crawled. Re-runnable. `-- --doctor` only reports. `-- --build` rebuilds the three images from this working tree. |
| `npm run benchmark:mirror` | Fetches the static practice sites into `.artifacts/benchmark/sites/`. Skipped when the manifest still matches. |
| `npm run benchmark` | Runs the task set (`-- --site <slug>`, `-- --task <id>`, `-- --quick` for the 10-task subset) and writes a report under `.artifacts/benchmark/runs/<id>/`. A run first retires (deletes) the capabilities earlier runs published on its sites, so every first ask is answered by the page agent and leaves a demonstration to generate from, and what this run publishes is what its reuse asks call; `-- --keep-capabilities` keeps them instead. |
| `npm run benchmark:down` | Stops the stack. `-- --volumes` also drops its databases and the PrestaShop install. |

The stack is the production `compose.yaml` + `compose.compact.yaml` with
`compose.benchmark.yaml` on top (project `sitewake-benchmark`, console at
`http://localhost:3100`). Port 3100 and 8101–8103 / 18081 must be free; the
scripts refuse to stop another project. Give Docker at least 5 GB for
containers: a crawl or a capability run renders a real shop in Chromium, and
the worker was killed at the compact 900 MB limit. The benchmark overlay raises
its own workers to 1.5 GB / 1.2 GB; other stacks running alongside eat into
the same budget.

## Sites

Each site is a directory under `benchmark/sites/<slug>/`:

- `site.json` — `id` (the site-agent id), `name`, `kind` (`mirror` or `app`),
  `internalUrl` (the address inside the compose network, which is what the
  console registers and the crawler, the runners and the driver use),
  `hostUrl` (the published port, for a person), `mirror.source`/`mirror.marker`
  for mirrored sites, `ready.marker`/`ready.timeoutMinutes` for apps,
  `crawl.limits`. `"configured": false` keeps a site in the registry without
  running it (the demo lamp shop, until its local copy exists).
- `truth.mjs` — computes the facts the tasks refer to, from the site itself
  (mirrored files, or HTTP for an app), and writes `truth.json`. `--check`
  exits non-zero when `truth.json` is stale.
- `tasks.json` — the tasks.

## Task format

```json
{
  "id": "ps-add-cushion",
  "startUrl": "/en/",
  "goal": "Add the {{products.brownBearCushion}} to my cart",
  "locale": "en-US",
  "kind": "action",
  "generates": true,
  "expect": { "type": "site-state", "probe": { "url": "/en/cart?action=show", "contains": ["{{products.brownBearCushion}}"], "count": { "selector": ".cart-item", "equals": 1 } } },
  "reuse": { "goal": "Add the {{products.mountainFoxCushion}} to my cart", "expect": { "...": "same shape" } }
}
```

- `id` kebab-case, unique across all sites. `startUrl` is a path on the site.
- `kind`: `answer` (the reply is judged) or `action` (the site's state is
  judged; an action task must use `site-state`).
- `expect.type`:
  - `answer-contains` — every string in `facts` appears in the reply
    (case-insensitive, whitespace and punctuation normalised);
  - `answer-matches` — at least one of `patterns` (regular expressions) matches;
  - `site-state` — after the run, `probe.url` is opened in the same browser
    context; `contains` strings must appear in its text, `count.selector` must
    match exactly `count.equals` elements, `value.selector`'s text or
    `value.attribute` must equal `value.equals`.
- `{{path.to.fact}}` anywhere in `goal` or `expect` is replaced from
  `truth.json`; nested templates resolve inside out. A template that does not
  resolve is a validation error.
- `generates: true` means a successful first ask is expected to produce a
  capability; such a task needs `reuse` (the same intent with another
  parameter) which is asked once the capability is published. Whether a run
  actually triggered generation is read from the run record, not from this flag.
- `node scripts/benchmark/tasks.mjs --validate` checks every file and names
  the field that is wrong.

## Task set history

- **v2** — saucedemo retired: its shop sits entirely behind a login the page
  agent will not type credentials for, so its tasks measured that policy.
  Books, quotes and PrestaShop remain; the v2 baseline is runs 1–2 of v1 with
  saucedemo's asks left out (no task changed otherwise).
- **v1** — books, quotes, saucedemo, PrestaShop; the demo shop registered but
  unconfigured.

## Versioning

`benchmark/VERSION` names the task set. Changing a task's goal or expectation,
adding or removing a task, or recomputing a site's `truth.json` with different
values is a new version: bump the number and re-run the baseline before
comparing anything against earlier reports. Adding a site is also a new version.
