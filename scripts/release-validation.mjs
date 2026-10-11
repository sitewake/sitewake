import { spawnSync } from "node:child_process";

// A deliberately small, repeatable release path for the private validation
// environment. It keeps expensive checks in one place and only deploys after
// every deterministic gate has passed.
const commands = [
  ["npm", ["run", "lint", "--", "--no-cache"]],
  ["npm", ["run", "test:evolution"]],
  ["npm", ["run", "build"]],
  ["npm", ["run", "server:deploy"]],
];

for (const [command, args] of commands) {
  console.log(`\n→ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log("\n✓ Validation release is live. Run `npm run container:smoke` against the target if an external health check is needed.");
