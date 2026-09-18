import { spawnSync } from "node:child_process";

const optional = [
  "MODEL_API_KEY",
  "MODEL_BASE_URL",
  "MODEL",
  "MODEL_EXECUTION",
  "MODEL_SEMANTIC",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_MODEL",
  "SITEWAKE_RUNNER_ENROLLMENT_TOKEN",
  "SITEWAKE_RUNNER_TOKEN",
  "CAPABILITY_V2_DISPATCH_TOKEN",
];
const secrets = {};

for (const name of optional) {
  if (process.env[name]?.trim()) secrets[name] = process.env[name];
}

if (!Object.keys(secrets).length) {
  console.log("No runtime secrets supplied; skipping secret sync.");
  process.exit(0);
}

const result = spawnSync(
  "npx",
  ["wrangler", "secret", "bulk", "--config", "dist/server/wrangler.json"],
  {
    input: JSON.stringify(secrets),
    stdio: ["pipe", "inherit", "inherit"],
    shell: process.platform === "win32",
  },
);

if (result.status !== 0) process.exit(result.status ?? 1);
