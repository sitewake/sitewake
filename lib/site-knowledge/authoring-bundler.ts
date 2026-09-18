// Deterministic bundler: virtual workspace (VFS) -> a single Node ES module.
//
// The engineering folder is a writing ergonomic; the deliverable is one hashed
// module the persistent script host dynamic-imports and runs. This module packs the
// VFS into that single ESM and enforces the same safety envelope the store's
// putProgramModule enforces (exports `run`, no eval/Function, size cap, no bare
// imports). esbuild is injected rather than imported so this file stays free of
// runtime deps (Workers-safe) and fully unit-testable.

import type { AuthoringWorkspaceFile } from "./protocol";
import { ENTRY_PATH, normalizeVfsPath } from "./authoring-workspace";

export const MAX_MODULE_BYTES = 120_000;

const SYNTHETIC_ENTRY = "__lc_entry__.ts";

// The published module has one canonical export. The stage functions remain
// ordinary browser JavaScript and are executed by the same Stage Runner in
// authoring, validation and production.
const ENTRY_WRAPPER = `import { capability as __capability } from "./${ENTRY_PATH}";
export const capability = __capability;
`;

export type ModuleValidation = { ok: true } | { ok: false; code: string; message: string };

/**
 * Shared safety envelope for a capability module's *source text*. Kept in lock
 * step with db/site-agent-store.ts putProgramModule so a module that bundles
 * here will also persist there.
 */
export function validateProgramModuleSource(source: string): ModuleValidation {
  const normalized = source.replace(/\r\n/g, "\n").trim();
  const exportsCapability =
    /^export\s+(?:const|let|var)\s+capability\b/m.test(normalized) ||
    /export\s*\{[^}]*\bcapability\b[^}]*\}/.test(normalized) ||
    /\bas\s+capability\b/.test(normalized);
  if (!exportsCapability) return { ok: false, code: "program_module_export_missing", message: "module must export `capability`" };
  if (/\b(?:eval|Function)\s*\(/.test(normalized)) {
    return { ok: false, code: "program_module_unsafe_dynamic_code", message: "eval/Function are not allowed in a capability module" };
  }
  if (normalized.length > MAX_MODULE_BYTES) {
    return { ok: false, code: "program_module_too_large", message: `module exceeds ${MAX_MODULE_BYTES} bytes` };
  }
  return { ok: true };
}

// Minimal structural types for the slice of the esbuild API we use, so we never
// hard-depend on esbuild types in a Workers-facing module.
type EsbuildOnResolveArgs = { path: string; importer: string; kind: string };
type EsbuildOnLoadArgs = { path: string };
type EsbuildResolveResult = { path?: string; namespace?: string; errors?: Array<{ text: string }> };
type EsbuildLoadResult = { contents?: string; loader?: string; errors?: Array<{ text: string }> };
type EsbuildPluginBuild = {
  onResolve(options: { filter: RegExp }, callback: (args: EsbuildOnResolveArgs) => EsbuildResolveResult | undefined): void;
  onLoad(options: { filter: RegExp; namespace?: string }, callback: (args: EsbuildOnLoadArgs) => EsbuildLoadResult | undefined): void;
};
type EsbuildPlugin = { name: string; setup: (build: EsbuildPluginBuild) => void };
export type EsbuildBuild = (options: {
  entryPoints: string[];
  bundle: true;
  write: false;
  format: "esm";
  platform?: "browser" | "node" | "neutral";
  target?: string | string[];
  minifyWhitespace?: boolean;
  minifyIdentifiers?: boolean;
  keepNames?: boolean;
  legalComments?: "none";
  logLevel?: string;
  plugins?: EsbuildPlugin[];
}) => Promise<{ outputFiles?: Array<{ text: string }>; errors?: Array<{ text: string }> }>;

function resolveVfsImport(importer: string, spec: string, fileMap: Map<string, string>): string | undefined {
  const baseDir = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")) : "";
  const stack = baseDir ? baseDir.split("/") : [];
  for (const segment of spec.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  const candidate = stack.join("/");
  for (const attempt of [candidate, `${candidate}.ts`, `${candidate}.json`, `${candidate}/index.ts`]) {
    if (fileMap.has(attempt)) return attempt;
  }
  return undefined;
}

export type BundleResult =
  | { ok: true; source: string }
  | { ok: false; code: string; message: string; diagnostics?: string[] };

/**
 * Bundle the VFS into one browser ESM. Imports may only resolve inside the VFS
 * (bare/npm imports are hard errors, closing the RCE surface). The bundled text
 * is validated against the shared module envelope before being returned.
 */
export async function bundleWorkspace(
  files: AuthoringWorkspaceFile[],
  deps: { build: EsbuildBuild },
): Promise<BundleResult> {
  const fileMap = new Map<string, string>();
  for (const file of files) fileMap.set(normalizeVfsPath(file.path), file.content);
  if (!fileMap.has(ENTRY_PATH)) {
    return { ok: false, code: "entry_missing", message: `workspace has no ${ENTRY_PATH}` };
  }
  fileMap.set(SYNTHETIC_ENTRY, ENTRY_WRAPPER);

  const plugin: EsbuildPlugin = {
    name: "capability-vfs",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: SYNTHETIC_ENTRY, namespace: "vfs" };
        if (args.path.startsWith("./") || args.path.startsWith("../") || args.path.startsWith("/")) {
          const resolved = resolveVfsImport(args.importer, args.path.replace(/^\/+/, ""), fileMap);
          if (!resolved) return { errors: [{ text: `import "${args.path}" from "${args.importer}" was not found in the workspace` }] };
          return { path: resolved, namespace: "vfs" };
        }
        return { errors: [{ text: `bare import "${args.path}" is not allowed; a capability may only import files inside its own workspace` }] };
      });
      build.onLoad({ filter: /.*/, namespace: "vfs" }, (args) => {
        const contents = fileMap.get(args.path);
        if (contents === undefined) return { errors: [{ text: `module "${args.path}" is missing from the workspace` }] };
        return { contents, loader: args.path.endsWith(".json") ? "json" : "ts" };
      });
    },
  };

  let output: { outputFiles?: Array<{ text: string }>; errors?: Array<{ text: string }> };
  try {
    output = await deps.build({
      entryPoints: [SYNTHETIC_ENTRY],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minifyWhitespace: true,
      minifyIdentifiers: false,
      keepNames: true,
      legalComments: "none",
      logLevel: "silent",
      plugins: [plugin],
    });
  } catch (error) {
    const diagnostics = extractEsbuildErrors(error);
    return { ok: false, code: "bundle_failed", message: "esbuild failed to bundle the workspace", diagnostics };
  }
  if (output.errors && output.errors.length > 0) {
    return { ok: false, code: "bundle_failed", message: "esbuild reported errors", diagnostics: output.errors.map((item) => item.text) };
  }
  const source = output.outputFiles?.[0]?.text?.trim();
  if (!source) return { ok: false, code: "empty_output", message: "bundler produced no output" };

  const validation = validateProgramModuleSource(source);
  if (!validation.ok) return { ok: false, code: validation.code, message: validation.message };
  return { ok: true, source };
}

function extractEsbuildErrors(error: unknown): string[] {
  if (error && typeof error === "object" && "errors" in error && Array.isArray((error as { errors: unknown }).errors)) {
    return (error as { errors: Array<{ text?: string }> }).errors.map((item) => item.text ?? String(item));
  }
  return [error instanceof Error ? error.message : String(error)];
}
