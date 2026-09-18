import { existsSync, readFileSync } from "node:fs";
import vinext from "vinext";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// The hosting config names the D1/R2 bindings for the maintainers' ChatGPT Sites
// project and is not part of the public repository; a checkout without it
// builds with the same binding names.
const hostingConfigPath = new URL("./.openai/hosting.json", import.meta.url);
const hostingConfig: { d1?: string | null; r2?: string | null } = existsSync(hostingConfigPath)
  ? JSON.parse(readFileSync(hostingConfigPath, "utf8"))
  : { d1: "DB", r2: null };
const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

const LOCAL_RUNNER_ENV_KEYS = [
  // Current SITEWAKE_* names. The SITEWAKE_/SITEWAKE_/SITEWAKE_ entries
  // below are deprecated spellings the application still reads as fallbacks;
  // the SITEWAKE_RUNNER_* ones are the separate runner-protocol contract.
  "SITEWAKE_LOCAL_DEV",
  "SITEWAKE_MODEL_API_KEY",
  "SITEWAKE_MODEL_BASE_URL",
  "SITEWAKE_MODEL_NAME",
  "SITEWAKE_MODEL",
  "SITEWAKE_EXECUTION_MODEL",
  "SITEWAKE_SEMANTIC_MODEL",
  "SITEWAKE_TEST_SUITE",
  "SITEWAKE_PUBLIC_ORIGIN",
  "SITEWAKE_PUBLIC_HOSTNAME",
  "SITEWAKE_MAINTENANCE_TOKEN",
  "SITEWAKE_PAGE_AGENT_RUNTIME_V2",
  "SITEWAKE_PAGE_AGENT_EVIDENCE_V2",
  "SITEWAKE_CAPABILITY_EXPERIENCE_OUTBOX",
  "SITEWAKE_RUNNER_ENROLLMENT_TOKEN",
  "SITEWAKE_RUNNER_VISIBILITY",
  "SITEWAKE_RUNNER_LEASE_AUTHORITY",
  "SITEWAKE_LEGACY_RUNNER_PROTOCOL",
  "SITEWAKE_RUNNER_TOKEN",
  "CAPABILITY_V2_CONTROL_PLANE_URL",
  "CAPABILITY_V2_ALLOW_PRIVATE_ORIGIN",
  "CAPABILITY_V2_RUNTIME_LAUNCHER_URL",
  "CAPABILITY_V2_RUNTIME_LAUNCHER_TOKEN",
  "MODEL_API_KEY",
  "MODEL_BASE_URL",
  "MODEL",
  "MODEL_EXECUTION",
  "MODEL_SEMANTIC",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "CAPABILITY_V2_INTEGRATION_MODEL_API_KEY",
  "CAPABILITY_V2_INTEGRATION_MODEL_BASE_URL",
  "CAPABILITY_V2_INTEGRATION_MODEL_NAME",
] as const;

function localRunnerVars() {
  return Object.fromEntries(
    LOCAL_RUNNER_ENV_KEYS.flatMap((key) => {
      const value = process.env[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");
  const isolatedPersistPath = process.env.SITEWAKE_LOCAL_PERSIST_PATH?.trim();

  return {
    ssr: {
      // Container-only persistence drivers must stay as native Node modules.
      // Bundling the AWS SDK changes its runtime feature detection, while the
      // Cloudflare path never imports these branches without DATABASE_URL/S3.
      external: ["pg"],
    },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        // Test suites can point Miniflare at a disposable directory instead of
        // sharing the developer's `.wrangler/state`. This isolates D1, R2 and
        // every other local binding without changing normal local development.
        persistState: isolatedPersistPath ? { path: isolatedPersistPath } : true,
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: {
          ...localBindingConfig,
          // The Cloudflare Vite runtime loads dotenv files as Worker bindings,
          // but does not forward dynamically generated parent-process values.
          // Local development creates the enrollment token in memory, so pass
          // only the Runner control variables to the local Worker explicitly.
          ...(command === "serve" ? { vars: localRunnerVars() } : {}),
        },
      }),
    ],
  };
});
