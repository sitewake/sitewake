interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

interface ScheduledEvent {
  cron: string;
  scheduledTime: number;
  noRetry(): void;
}
interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
  meta: Record<string, unknown>;
  error?: string;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<Array<D1Result<T>>>;
}

declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
