import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Vinext deliberately gives files copied from `public/` a short cache TTL.
// That is normally sensible, but the SiteWake SDK is installed with a stable
// URL. Serving a new control-plane version while a browser still owns an old
// SDK produces mixed runtime protocols. Keep the integration entrypoints
// revalidatable; content-hashed console assets remain immutable.
const file = resolve("node_modules/vinext/dist/server/static-file-cache.js");
const source = await readFile(file, "utf8");
const oldLine = 'const cacheControl = isHashed ? "public, max-age=31536000, immutable" : "public, max-age=3600";';
const newLine = 'const sdkEntrypoint = /^sitewake(?:-adaptive)?\\.js$/.test(relativePath);\n\t\t\tconst cacheControl = sdkEntrypoint ? "no-cache, must-revalidate" : isHashed ? "public, max-age=31536000, immutable" : "public, max-age=3600";';

// An earlier patch may have installed a previous entrypoint pattern; replace it too.
const previousPatch = /const sdkEntrypoint = \/[^\n]*\/\.test\(relativePath\);\n\t\t\tconst cacheControl = sdkEntrypoint \? "no-cache, must-revalidate" : isHashed \? "public, max-age=31536000, immutable" : "public, max-age=3600";/;

if (source.includes(newLine)) {
  console.log("Vinext SDK cache policy already patched.");
} else if (previousPatch.test(source)) {
  await writeFile(file, source.replace(previousPatch, newLine));
  console.log("Updated Vinext SDK entrypoint cache policy.");
} else if (!source.includes(oldLine)) {
  throw new Error("vinext_sdk_cache_patch_target_not_found");
} else {
  await writeFile(file, source.replace(oldLine, newLine));
  console.log("Patched Vinext SDK entrypoint cache policy.");
}
