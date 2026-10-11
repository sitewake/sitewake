/**
 * CLI face of the model compatibility check: the probe and the verdict live in
 * `lib/model-check/core.mjs` (shared with the console's verify endpoint); this
 * wrapper only binds the terminal catalog's messages to the chosen locale so
 * `scripts/setup.mjs` and `scripts/check-model-compatibility.mjs` keep their
 * `locale` parameter. Must import only `node:` modules and relative files.
 */
import { cli } from "./cli-copy.mjs";
import { chatCompletionsUrl, probe as probeCore, routingRequest, verifyStages as verifyStagesCore } from "../lib/model-check/core.mjs";

export { chatCompletionsUrl, routingRequest };

export function probe(stage, url, apiKey, payload, timeoutMs, locale = "en") {
  return probeCore(stage, url, apiKey, payload, timeoutMs, cli(locale).check);
}

export function verifyStages({ locale = "en", ...options }) {
  return verifyStagesCore({ ...options, messages: cli(locale).check });
}
