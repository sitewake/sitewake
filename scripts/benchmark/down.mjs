// Stops the benchmark stack. `--volumes` also drops its databases, the
// PrestaShop install and the console's state; the mirrored sites stay.
import { existsSync } from "node:fs";
import { composeArgs, ENV_FILE, log, parseFlags, run } from "./lib.mjs";

const flags = parseFlags();
if (!existsSync(ENV_FILE)) { log("nothing to stop: no benchmark env at", ENV_FILE); process.exit(0); }
await run("docker", composeArgs("--profile", "driver", "down", "--remove-orphans", ...(flags.volumes ? ["--volumes"] : [])));
log(flags.volumes ? "stack and volumes removed" : "stack stopped (volumes kept; add --volumes to drop them)");
