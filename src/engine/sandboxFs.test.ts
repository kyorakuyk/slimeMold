import { describe, expect, it } from 'vitest';
import type {
  SandboxFs,
  SandboxFsEntry,
  SandboxFsFileHandle,
  SandboxFsStat,
} from './sandboxFs';
import { createSandboxFsGuard } from './sandboxFs';

type Entry = SandboxFsStat & { content?: string };

class MemoryFs implements SandboxFs {
  private entries = new Map<string, Entry>();

  constructor(root: string) {
    this.entries.set(root, { isFile: false, isDirectory: true, isSymlink: false });
  }

  private normalize(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  }

  private parent(path: string): string {
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
  }

  private ensureParent(path: string): void {
    const parent = this.parent(path);
    const entry = this.entries.get(parent);
    if (!entry?.isDirectory || entry.isSymlink) throw new Error(`missing parent ${parent}`);
  }

  async exists(path: string): Promise<boolean> {
    return this.entries.has(this.normalize(path));
  }

  async lstat(path: string): Promise<SandboxFsStat> {
    const entry = this.entries.get(this.normalize(path));
    if (!entry) throw new Error(`missing ${path}`);
    return entry;
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const normalized = this.normalize(path);
    if (this.entries.has(normalized)) throw new Error(`already exists ${normalized}`);
    if (options.recursive) {
      const parts = normalized.split('/').filter(Boolean);
      let current = normalized.startsWith('/') ? '' : '';
      for (const part of parts) {
        current += `/${part}`;
        if (!this.entries.has(current)) {
          const parent = this.parent(current);
          this.ensureParent(current);
          this.entries.set(current, { isFile: false, isDirectory: true, isSymlink: false });
          if (parent === current) break;
        }
      }
      return;
    }
    this.ensureParent(normalized);
    this.entries.set(normalized, { isFile: false, isDirectory: true, isSymlink: false });
  }

  async readDir(path: string): Promise<SandboxFsEntry[]> {
    const normalized = this.normalize(path);
    const stat = await this.lstat(normalized);
    if (!stat.isDirectory || stat.isSymlink) throw new Error(`not a directory ${normalized}`);
    const prefix = `${normalized}/`;
    const result: SandboxFsEntry[] = [];
    for (const [candidate, entry] of this.entries) {
      if (!candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      if (!rest || rest.includes('/')) continue;
      result.push({ name: rest, ...entry });
    }
    return result;
  }

  async readTextFile(path: string): Promise<string> {
    await this.lstat(path);
    const entry = this.entries.get(this.normalize(path))!;
    if (!entry.isFile || entry.isSymlink) throw new Error(`not a file ${path}`);
    return entry.content ?? '';
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    const normalized = this.normalize(path);
    this.ensureParent(normalized);
    const current = this.entries.get(normalized);
    if (current?.isSymlink || current?.isDirectory) throw new Error(`unsafe target ${normalized}`);
    this.entries.set(normalized, { isFile: true, isDirectory: false, isSymlink: false, content });
  }

  async open(path: string, options: { write?: boolean; createNew?: boolean } = {}): Promise<SandboxFsFileHandle> {
    const normalized = this.normalize(path);
    this.ensureParent(normalized);
    if (options.createNew && this.entries.has(normalized)) throw new Error(`already exists ${normalized}`);
    let data = new Uint8Array();
    return {
      write: async (chunk: Uint8Array) => {
        const next = new Uint8Array(data.length + chunk.length);
        next.set(data);
        next.set(chunk, data.length);
        data = next;
        return chunk.length;
      },
      close: async () => {
        await this.writeTextFile(normalized, new TextDecoder().decode(data));
      },
    };
  }

  symlink(path: string): void {
    const normalized = this.normalize(path);
    this.ensureParent(normalized);
    this.entries.set(normalized, { isFile: false, isDirectory: false, isSymlink: true });
  }
}

describe('sandbox filesystem guard', () => {
  it('creates nested files and recursively commits them', async () => {
    const fs = new MemoryFs('/base');
    const guard = createSandboxFsGuard(fs, '/base');

    await guard.writeFile('.sandbox/id-node', 'deliverables/reports/result.txt', 'ok');

    expect(await guard.readFile('.sandbox/id-node', 'deliverables/reports/result.txt')).toBe('ok');
    await expect(guard.list('.sandbox/id-node/deliverables/reports')).resolves.toEqual(['result.txt']);
    await expect(guard.commit('.sandbox/id-node')).resolves.toEqual(['/base/deliverables/reports/result.txt']);
    expect(await guard.readFile('.sandbox/id-node', 'deliverables/reports/result.txt')).toBe('ok');
  });

  it('rejects a symlink in the sandbox root and during recursive commit', async () => {
    const fs = new MemoryFs('/base');
    const guard = createSandboxFsGuard(fs, '/base');

    await fs.mkdir('/base/.sandbox', { recursive: true });
    fs.symlink('/base/.sandbox/id-node');
    await expect(guard.writeFile('.sandbox/id-node', 'result.txt', 'blocked')).rejects.toThrow(/符号链接/);

    await fs.mkdir('/base/.sandbox/id-safe', { recursive: true });
    fs.symlink('/base/.sandbox/id-safe/outside');
    await expect(guard.commit('.sandbox/id-safe')).rejects.toThrow(/符号链接/);
  });
});
