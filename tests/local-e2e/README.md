# Local PageAgent E2E

Run the complete Runtime V2 acceptance suite with:

```powershell
npm run test:page-agent:e2e
```

Prerequisite: the local PrestaShop demo must be available at
`http://localhost:18081`. The test intercepts its `localhost:3310` SDK and API
requests, loads the freshly built bundle from this worktree, and uses a
deterministic local model fixture. It does not exercise the older control-plane
image currently listening on port 3310.

The browser case uses a new anonymous context, searches for `cushion`, adds
exactly one `Brown bear cushion`, verifies the business confirmation and the
Runtime V2 evidence envelope, then removes the item. The same command also runs
the durable observation, model-budget, continuation, timeout, and capability
outbox integration suites.
