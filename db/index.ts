let runtimeEnv: { DB?: D1DatabaseLike; ARTIFACTS?: R2BucketLike } = {};
try {
  const cloudflare = await import("cloudflare:workers");
  runtimeEnv = cloudflare.env as unknown as { DB?: D1DatabaseLike; ARTIFACTS?: R2BucketLike };
} catch {
  // Node-based render tests and local builds do not provide the Cloudflare
  // runtime module. Callers receive an explicit unavailable/degraded result.
}

export type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
};

export type D1ResultLike<T = Record<string, unknown>> = {
  success: boolean;
  results?: T[];
  meta?: Record<string, unknown>;
  error?: string;
};

export type D1DatabaseLike = {
  dialect?: "d1" | "postgres" | "memory";
  prepare(sql: string): D1PreparedStatementLike;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatementLike[],
  ): Promise<Array<D1ResultLike<T>>>;
  withSession?(): D1DatabaseLike;
};

export type R2ObjectLike = {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
};

export type R2BucketLike = {
  put(key: string, value: ArrayBuffer | ReadableStream, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
};

export class D1UnavailableError extends Error {
  constructor() {
    super("Cloudflare D1 binding `DB` is unavailable.");
    this.name = "D1UnavailableError";
  }
}

export function getD1Binding(): D1DatabaseLike | null {
  return runtimeEnv.DB || null;
}

export function getArtifactBinding(): R2BucketLike | null {
  return runtimeEnv.ARTIFACTS || null;
}

// The open-source container runtime uses PostgreSQL and S3-compatible object
// storage. Dynamic imports keep those Node-only drivers out of the Cloudflare
// Worker bundle while preserving the same domain repositories.
if (!runtimeEnv.DB && typeof process !== "undefined" && process.env.DATABASE_URL) {
  const { createPostgresD1Adapter } = await import("./postgres-adapter");
  runtimeEnv.DB = createPostgresD1Adapter(process.env.DATABASE_URL);
}

if (!runtimeEnv.ARTIFACTS && typeof process !== "undefined" && process.env.S3_BUCKET) {
  const { createS3ArtifactAdapter } = await import("./s3-artifact-adapter");
  runtimeEnv.ARTIFACTS = createS3ArtifactAdapter();
}
