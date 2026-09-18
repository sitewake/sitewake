// Deterministic engineering workspace (virtual file system) for the AI CODING
// harness. This module is intentionally pure and dependency-free so the whole
// authoring flow can be wrapped in tests: given the same file operations it
// always produces the same workspace and the same content hash. Any live
// failure with these tests green is therefore attributable to the coding model
// or the browser, never to the flow logic.
//
// The VFS is a writing ergonomic only. The deliverable is always a single
// hashed ES module bundled from the VFS (see ./authoring-bundler). Files never
// touch the runner's Node context and never ship to the terminal browser.

import type { AuthoringWorkspaceFile, AuthoringWorkspaceSnapshot } from "./protocol";
import type { CapabilitySpecDoc } from "./protocol";

export const WORKSPACE_LIMITS = {
  maxFiles: 2,
  maxFileBytes: 64_000,
  maxTotalBytes: 512_000,
  maxPathLength: 200,
} as const;

/** Extensions the AI may create. Keeps the VFS to source, data, notes and DOM snapshots. */
export const ALLOWED_EXTENSIONS = [".ts", ".json"] as const;

/** The single entry the bundler always builds from. */
export const ENTRY_PATH = "capability.ts";
/** Derived-from-spec + AI-authored acceptance cases. */
export const FIXTURES_PATH = "fixtures.json";

export class WorkspacePathError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkspacePathError";
    this.code = code;
  }
}

const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Validate and canonicalise a VFS-relative path. Rejects traversal, absolute
 * paths, backslashes, empty segments, disallowed extensions and over-long
 * paths. Returns the normalised path (no leading slash, forward slashes only).
 */
export function normalizeVfsPath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new WorkspacePathError("path_empty", "path must be a non-empty string");
  }
  if (rawPath.length > WORKSPACE_LIMITS.maxPathLength) {
    throw new WorkspacePathError("path_too_long", `path exceeds ${WORKSPACE_LIMITS.maxPathLength} chars`);
  }
  if (rawPath.includes("\\")) {
    throw new WorkspacePathError("path_backslash", "path must use forward slashes");
  }
  if (rawPath.includes("\0")) {
    throw new WorkspacePathError("path_nul", "path must not contain NUL");
  }
  const trimmed = rawPath.replace(/^\.\//, "").replace(/^\/+/, "");
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new WorkspacePathError("path_traversal", `illegal path segment in "${rawPath}"`);
    }
  }
  const normalized = segments.join("/");
  if (normalized !== ENTRY_PATH && normalized !== FIXTURES_PATH) {
    throw new WorkspacePathError("path_not_allowed", `only ${ENTRY_PATH} and ${FIXTURES_PATH} are allowed`);
  }
  const dot = normalized.lastIndexOf(".");
  const ext = dot === -1 ? "" : normalized.slice(dot);
  if (!ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
    throw new WorkspacePathError("path_extension", `extension "${ext || "(none)"}" is not allowed; use one of ${ALLOWED_EXTENSIONS.join(", ")}`);
  }
  return normalized;
}

export type WorkspaceListing = Array<{ path: string; bytes: number; updatedAt: string }>;

/**
 * A mutable in-session view over the VFS with deterministic, validated
 * operations. All mutating operations throw WorkspacePathError with a stable
 * code on violation so the harness can relay structured failures to the model.
 */
export class AuthoringWorkspace {
  private readonly files = new Map<string, AuthoringWorkspaceFile>();
  private clock: () => string;

  constructor(seed: AuthoringWorkspaceFile[] = [], clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
    for (const file of seed) {
      const path = normalizeVfsPath(file.path);
      this.files.set(path, { path, content: file.content, updatedAt: file.updatedAt });
    }
  }

  list(): WorkspaceListing {
    return [...this.files.values()]
      .map((file) => ({ path: file.path, bytes: byteLength(file.content), updatedAt: file.updatedAt }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  has(path: string): boolean {
    return this.files.has(normalizeVfsPath(path));
  }

  read(path: string): string {
    const normalized = normalizeVfsPath(path);
    const file = this.files.get(normalized);
    if (!file) throw new WorkspacePathError("path_not_found", `file "${normalized}" does not exist`);
    return file.content;
  }

  write(path: string, content: string): AuthoringWorkspaceFile {
    const normalized = normalizeVfsPath(path);
    if (typeof content !== "string") {
      throw new WorkspacePathError("content_type", "content must be a string");
    }
    const incomingBytes = byteLength(content);
    if (incomingBytes > WORKSPACE_LIMITS.maxFileBytes) {
      throw new WorkspacePathError("file_too_large", `file "${normalized}" exceeds ${WORKSPACE_LIMITS.maxFileBytes} bytes`);
    }
    if (!this.files.has(normalized) && this.files.size >= WORKSPACE_LIMITS.maxFiles) {
      throw new WorkspacePathError("too_many_files", `workspace already holds the maximum of ${WORKSPACE_LIMITS.maxFiles} files`);
    }
    let total = incomingBytes;
    for (const [existingPath, file] of this.files) {
      if (existingPath !== normalized) total += byteLength(file.content);
    }
    if (total > WORKSPACE_LIMITS.maxTotalBytes) {
      throw new WorkspacePathError("workspace_too_large", `workspace would exceed ${WORKSPACE_LIMITS.maxTotalBytes} bytes`);
    }
    const record: AuthoringWorkspaceFile = { path: normalized, content, updatedAt: this.clock() };
    this.files.set(normalized, record);
    return record;
  }

  delete(path: string): boolean {
    const normalized = normalizeVfsPath(path);
    if (normalized === ENTRY_PATH) {
      throw new WorkspacePathError("entry_protected", `the entry "${ENTRY_PATH}" cannot be deleted`);
    }
    return this.files.delete(normalized);
  }

  toFiles(): AuthoringWorkspaceFile[] {
    return this.list().map(({ path }) => {
      const file = this.files.get(path)!;
      return { path: file.path, content: file.content, updatedAt: file.updatedAt };
    });
  }

  async snapshot(now: string = this.clock()): Promise<AuthoringWorkspaceSnapshot> {
    const files = this.toFiles();
    const hash = await workspaceHash(files);
    return { hash, files, createdAt: now };
  }
}

/** Deterministic content hash over the canonical (path-sorted) file listing. */
export async function workspaceHash(files: AuthoringWorkspaceFile[]): Promise<string> {
  const canonical = [...files]
    .map((file) => ({ path: normalizeVfsPath(file.path), content: file.content }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => `${file.path}\n${file.content}`)
    .join("\n\u0000\n");
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type ScaffoldSpec = {
  goal: string;
  intent?: string;
  fixtures?: unknown;
  now?: string;
  specDoc?: CapabilitySpecDoc;
  coreFieldIds?: string[];
  sampleInput?: Record<string, unknown>;
};

/**
 * Seed a fresh workspace with the Stage module and its fixtures. The AI edits
 * these two explicit artifacts rather than starting from a blank page.
 */
export function scaffoldWorkspace(spec: ScaffoldSpec): AuthoringWorkspaceFile[] {
  const now = spec.now ?? new Date().toISOString();
  const goalComment = spec.goal.replace(/\*\//g, "*\\/");
  const specFixtures = (spec.specDoc?.scenarios ?? []).map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    input: scenario.sampleInput ?? {},
    expect: {
      outcome: scenario.expectedOutcome ?? "success",
      fields: [],
    },
  }));
  const seededCases = specFixtures.length ? specFixtures : [{
    id: "smoke",
    title: "真实输入试跑",
    input: spec.sampleInput ?? {},
    expect: { outcome: "success" as const, fields: [] as string[] },
  }];
  const entry = `// Capability: ${goalComment}
// Every stage runs inside the target page with access to window/document.
// A stage that triggers navigation must make navigation its final action.
// Return { state } to pass JSON data forward or { output } to finish.
export const capability = {
  version: 1,
  stages: [
    {
      id: "main",
      async run({ input, state }) {
        // TODO: implement with native browser JavaScript.
        return { output: {} };
      },
    },
  ],
};
`;
  const fixtures = JSON.stringify(
    {
      cases: Array.isArray((spec.fixtures as { cases?: unknown[] } | undefined)?.cases)
        ? (spec.fixtures as { cases: unknown[] }).cases
        : seededCases,
    },
    null,
    2,
  );
  return [
    { path: ENTRY_PATH, content: entry, updatedAt: now },
    { path: FIXTURES_PATH, content: fixtures, updatedAt: now },
  ];
}
