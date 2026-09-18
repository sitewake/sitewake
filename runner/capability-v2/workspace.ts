import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Credentials belong to the connector process, never to a portable project.
export function redactWorkspace(value: unknown, key = ''): unknown {
  if (/^(?:password|passwd|secret|apiKey|api_key|authorization|cookie|cookies|storageState|accessToken|runnerToken|token)$/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => redactWorkspace(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,redactWorkspace(v,k)]));
  if (typeof value === 'string') return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [redacted]');
  return value;
}
export type WorkspaceExport = { schemaVersion: 'capability-workspace.v1'; files: Array<{path: string; sha256: string; content: string}> };
export class CapabilityWorkspace {
  private paths = new Set<string>();
  private sequence = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(readonly directory: string) {}
  static async create(root = join(tmpdir(), 'sitewake-workspaces')) {
    await mkdir(root, {recursive:true, mode:0o700});
    return new CapabilityWorkspace(await mkdtemp(join(root, 'attempt-')));
  }
  async write(path: string, value: unknown, source = false) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.')) throw new Error('workspace_path_invalid');
    const content = source ? String(value) : JSON.stringify(redactWorkspace(value), null, 2) + '\n';
    const operation = this.tail.then(async () => {
      const target = join(this.directory, path);
      await mkdir(dirname(target), {recursive:true,mode:0o700});
      await writeFile(target + '.pending', content, {mode:0o600});
      await rename(target + '.pending',target);
      this.paths.add(path);
    });
    this.tail = operation;
    await operation;
  }
  async event(kind: string, value: unknown) {
    const id = String(++this.sequence).padStart(5,'0');
    await this.write(`events/${id}.json`, {sequence:this.sequence,at:new Date().toISOString(),kind,value});
    return id;
  }
  async revision(source: string) {
    const hash = createHash('sha256').update(source).digest('hex');
    await this.write(`revisions/${hash}/capability.ts`, source, true);
    await this.write('src/capability.ts', source, true);
    return hash;
  }
  async export(): Promise<WorkspaceExport> {
    await this.tail;
    const files = await Promise.all([...this.paths].sort().map(async path => {
      const content = await readFile(join(this.directory,path),'utf8');
      return {path,sha256:createHash('sha256').update(content).digest('hex'),content};
    }));
    return {schemaVersion:'capability-workspace.v1',files};
  }
}
