import type {
  CapabilityNavigationIntent,
  CapabilityStageIO,
  CapabilityStageManifest,
  CapabilityStageResult,
  JsonObject,
} from "./model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/^\.+|\.+$/gu, "") : "";
}

function normalizePaths(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const paths = value.map(normalizePath).filter(Boolean);
  return [...new Set(paths)].sort();
}

export function normalizeCapabilityStageIO(value: unknown): CapabilityStageIO | undefined {
  if (!isRecord(value)) return undefined;
  const reads = isRecord(value.reads) ? value.reads : undefined;
  const writes = isRecord(value.writes) ? value.writes : undefined;
  const input = normalizePaths(reads?.input);
  const stateReads = normalizePaths(reads?.state);
  const stateWrites = normalizePaths(writes?.state);
  const output = normalizePaths(writes?.output);
  if (!input || !stateReads || !stateWrites || !output) return undefined;
  return {
    reads: { input, state: stateReads },
    writes: { state: stateWrites, output },
  };
}

export function normalizeCapabilityStageNavigation(value: unknown) {
  return value === "none" || value === "optional" || value === "required" ? value : undefined;
}

export function capabilityRootPath(path: string) {
  return path.split(".").filter(Boolean)[0] || "";
}

export function capabilityPathAllowed(path: string, declared: readonly string[]) {
  const normalized = normalizePath(path);
  return declared.some((candidate) => {
    const value = normalizePath(candidate);
    return value === "*" || value === normalized || normalized.startsWith(`${value}.`);
  });
}

function capabilityPathHasDeclaredDescendant(path: string, declared: readonly string[]) {
  const normalized = normalizePath(path);
  return declared.some((candidate) => normalizePath(candidate).startsWith(`${normalized}.`));
}

function resultPaths(value: unknown, prefix: string, output: string[]) {
  if (!isRecord(value)) {
    output.push(prefix);
    return;
  }
  const entries = Object.entries(value);
  // An empty object carries no writes. This is the valid Success payload for
  // Contracts with no declared output properties (and for expected: {}).
  if (!entries.length) return;
  for (const [key, child] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    resultPaths(child, path, output);
  }
}

function assertDeclaredWrites(value: unknown, declared: readonly string[], kind: "state" | "output", stageId: string) {
  if (value === undefined) return;
  const paths: string[] = [];
  resultPaths(value, "", paths);
  for (const path of paths) {
    if (!capabilityPathAllowed(path, declared) && !capabilityPathHasDeclaredDescendant(path, declared)) {
      throw new Error(`capability_stage_${kind}_write_undeclared:${stageId}:${path}`);
    }
  }
}

export function assertCapabilityStageNavigation(
  manifest: CapabilityStageManifest,
  navigation: unknown,
  stageId: string,
) {
  if (navigation === undefined) {
    if (manifest.navigation === "required") throw new Error(`capability_stage_navigation_required:${stageId}`);
    return;
  }
  if (manifest.navigation === "none") throw new Error(`capability_stage_navigation_forbidden:${stageId}`);
  if (!isRecord(navigation) || typeof navigation.url !== "string" || !navigation.url.trim() || navigation.target !== "_self") {
    throw new Error(`capability_stage_navigation_invalid:${stageId}`);
  }
}

export function assertCapabilityStageResultIO(manifest: CapabilityStageManifest, result: CapabilityStageResult, stageId: string) {
  assertDeclaredWrites(result.state, manifest.io.writes.state, "state", stageId);
  assertDeclaredWrites(result.output, manifest.io.writes.output, "output", stageId);
  assertCapabilityStageNavigation(manifest, result.navigation, stageId);
  if (result.navigation && result.outcome !== "Continue") throw new Error(`capability_navigation_terminal_outcome:${stageId}`);
}

export function assertCapabilityNavigationUrl(currentUrl: string, intent: CapabilityNavigationIntent, stageId: string) {
  if (intent.target !== "_self") throw new Error(`capability_stage_navigation_invalid:${stageId}`);
  const destination = new URL(intent.url, currentUrl);
  const current = new URL(currentUrl);
  if (destination.origin !== current.origin) throw new Error(`capability_navigation_origin_invalid:${stageId}`);
  return destination.href;
}

/**
 * Expose only the fields declared by the Stage manifest. Accessing an
 * undeclared input/state path throws instead of silently returning undefined.
 * This is deliberately a small JSON boundary: DOM objects and functions never
 * cross it.
 */
export function capabilityScopedJson<T extends JsonObject>(value: T, declared: readonly string[], kind: "input" | "state", stageId: string): T {
  const wrap = (current: unknown, prefix: string): unknown => {
    if (!isRecord(current) && !Array.isArray(current)) return current;
    if (Array.isArray(current)) return current.map((item, index) => wrap(item, `${prefix}.${index}`));
    return new Proxy(current, {
      get(target, property, receiver) {
        if (typeof property === "symbol") return Reflect.get(target, property, receiver);
        const path = prefix ? `${prefix}.${property}` : property;
        if (!capabilityPathAllowed(path, declared) && !capabilityPathHasDeclaredDescendant(path, declared)) {
          throw new Error(`capability_stage_${kind}_read_undeclared:${stageId}:${path}`);
        }
        return wrap(Reflect.get(target, property, receiver), path);
      },
      has(target, property) {
        if (typeof property === "symbol") return Reflect.has(target, property);
        const path = prefix ? `${prefix}.${property}` : property;
        if (!capabilityPathAllowed(path, declared) && !capabilityPathHasDeclaredDescendant(path, declared)) {
          throw new Error(`capability_stage_${kind}_read_undeclared:${stageId}:${path}`);
        }
        return Reflect.has(target, property);
      },
      ownKeys(target) {
        return Reflect.ownKeys(target).filter((property) => {
          if (typeof property !== "string") return true;
          const path = prefix ? `${prefix}.${property}` : property;
          return capabilityPathAllowed(path, declared) || capabilityPathHasDeclaredDescendant(path, declared);
        });
      },
    }) as unknown;
  };
  return wrap(value, "") as T;
}
