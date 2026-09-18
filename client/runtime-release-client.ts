import { isRelease, type SiteAgentReleaseV2 } from '../lib/site-knowledge/protocol';

type Entry = { etag: string; release: SiteAgentReleaseV2 };
/** Revalidate the exact projection, never infer freshness from local version numbers. */
export class RuntimeReleaseClient {
  private entries = new Map<string, Entry>();
  async read(url: string, request: (url: string, init: RequestInit) => Promise<Response>) {
    const cached = this.entries.get(url);
    const response = await request(url, {
      cache: 'no-store',
      ...(cached ? { headers: { 'if-none-match': cached.etag } } : {}),
    });
    if (response.status === 304) {
      if (!cached) throw new Error('runtime_release_cache_missing');
      return { release: cached.release };
    }
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `runtime_release_http_${response.status}`);
    if (!isRelease(payload.release)) throw new Error('runtime_release_invalid');
    const etag = response.headers.get('etag');
    if (etag) {
      this.entries.set(url, { etag, release: payload.release });
      if (this.entries.size > 4) this.entries.delete(this.entries.keys().next().value!);
    } else this.entries.delete(url);
    return { release: payload.release as SiteAgentReleaseV2 };
  }
}

export class AgentStartupError extends Error {
  readonly code: string;
  readonly cause: unknown;
  readonly errorName: string;
  readonly sdkFrame: string;
  readonly diagnosticId = `startup_${crypto.randomUUID()}`;
  constructor(readonly phase: 'readiness' | 'release' | 'create', error: unknown) {
    const raw = error instanceof Error ? error.message : String(error);
    const code = /fetch_timeout|TimeoutError|AbortError/.test(raw) ? 'connection_timeout'
      : /Failed to fetch|Load failed|NetworkError|fetch failed/i.test(raw) ? 'connection_failed'
      : /^[a-z][a-z0-9_:-]{0,100}$/.test(raw) ? raw : 'startup_unexpected_error';
    super(`agent_startup_failed:${phase}:${code}`);
    this.name = 'AgentStartupError'; this.code = code; this.cause = error;
    this.errorName = error instanceof Error ? error.name.replace(/[^a-zA-Z]/g, '').slice(0, 40) : 'Unknown';
    this.sdkFrame = error instanceof Error ? error.stack?.match(/sitewake(?:-adaptive)?\.js:\d+:\d+/)?.[0] || '' : '';
  }
}
