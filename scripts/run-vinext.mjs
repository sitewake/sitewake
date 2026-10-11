import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vinext = resolve(root, "node_modules", "vinext", "dist", "cli.js");
const args = process.argv.slice(2);

if (!args.length) {
  throw new Error("vinext_command_required");
}

const child = spawn(
  process.execPath,
  ["--env-file-if-exists=.env.local", vinext, ...args],
  {
    cwd: root,
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
    },
    stdio: "inherit",
    windowsHide: true,
  },
);

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
