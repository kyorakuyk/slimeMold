import { assertSandboxRelativePath } from './sandboxPath';

export interface SandboxFsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface SandboxFsEntry extends SandboxFsStat {
  name: string;
}

export interface SandboxFsFileHandle {
  write(data: Uint8Array): Promise<number>;
  close(): Promise<void>;
}

/** Minimal filesystem surface used by the node sandbox. */
export interface SandboxFs {
  exists(path: string): Promise<boolean>;
  lstat(path: string): Promise<SandboxFsStat>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readDir(path: string): Promise<SandboxFsEntry[]>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  open(
    path: string,
    options?: { write?: boolean; createNew?: boolean },
  ): Promise<SandboxFsFileHandle>;
}

export interface SandboxFsGuard {
  writeFile(rootRelative: string, fileRelative: string, content: string): Promise<string>;
  readFile(rootRelative: string, fileRelative: string): Promise<string | null>;
  list(rootRelative: string): Promise<string[]>;
  commit(rootRelative: string, destinationRelative?: string): Promise<string[]>;
}

function normalizeBaseDir(baseDir: string): string {
  const normalized = baseDir.replace(/\\/g, '/').trim();
  if (!normalized) throw new Error('沙箱根目录不能为空');
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, '');
}

function joinBase(baseDir: string, relative: string): string {
  return relative ? `${baseDir}/${relative}` : baseDir;
}

function safeRelative(value: string, label: string): string {
  return assertSandboxRelativePath(value, label);
}

function safeOptionalRelative(value: string, label: string): string {
  return value ? safeRelative(value, label) : '';
}

function safeEntryName(value: string): string {
  const name = safeRelative(value, '沙箱目录项');
  if (name.includes('/')) throw new Error(`沙箱目录项不能包含路径分隔符：${value}`);
  return name;
}

export function createSandboxFsGuard(fs: SandboxFs, baseDir: string): SandboxFsGuard {
  const base = normalizeBaseDir(baseDir);

  const assertDirectory = async (absolutePath: string): Promise<void> => {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymlink) throw new Error(`沙箱拒绝跟随符号链接：${absolutePath}`);
    if (!stat.isDirectory) throw new Error(`沙箱路径不是目录：${absolutePath}`);
  };

  const ensureDirectory = async (relative: string, create: boolean): Promise<boolean> => {
    const safe = safeOptionalRelative(relative, '沙箱目录路径');
    let current = base;
    if (!(await fs.exists(current))) {
      if (!create) return false;
      await fs.mkdir(current, { recursive: true });
    }
    await assertDirectory(current);

    for (const segment of safe ? safe.split('/') : []) {
      current = `${current}/${segment}`;
      if (!(await fs.exists(current))) {
        if (!create) return false;
        try {
          await fs.mkdir(current);
        } catch (error) {
          // Another actor may have created the path between exists and mkdir;
          // re-check it before surfacing the original error.
          if (!(await fs.exists(current))) throw error;
        }
      }
      await assertDirectory(current);
    }
    return true;
  };

  const inspectFile = async (relative: string): Promise<string | null> => {
    const safe = safeRelative(relative, '沙箱文件路径');
    const separator = safe.lastIndexOf('/');
    const parent = separator >= 0 ? safe.slice(0, separator) : '';
    if (!(await ensureDirectory(parent, false))) return null;
    const absolutePath = joinBase(base, safe);
    if (!(await fs.exists(absolutePath))) return null;
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymlink) throw new Error(`沙箱拒绝读取符号链接：${absolutePath}`);
    if (!stat.isFile) throw new Error(`沙箱路径不是文件：${absolutePath}`);
    return absolutePath;
  };

  const writeRelative = async (relative: string, content: string): Promise<string> => {
    const safe = safeRelative(relative, '沙箱文件路径');
    const separator = safe.lastIndexOf('/');
    const parent = separator >= 0 ? safe.slice(0, separator) : '';
    await ensureDirectory(parent, true);
    const absolutePath = joinBase(base, safe);
    if (await fs.exists(absolutePath)) {
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymlink) throw new Error(`沙箱拒绝覆盖符号链接：${absolutePath}`);
      if (!stat.isFile) throw new Error(`沙箱目标不是文件：${absolutePath}`);
      await fs.writeTextFile(absolutePath, content);
      return absolutePath;
    }

    // createNew rejects an existing file, directory, or symlink at the final
    // target instead of following a path that appeared after our lstat check.
    const handle = await fs.open(absolutePath, { write: true, createNew: true });
    try {
      const bytes = new TextEncoder().encode(content);
      let offset = 0;
      while (offset < bytes.length) {
        const written = await handle.write(bytes.slice(offset));
        if (written <= 0) throw new Error(`沙箱文件写入未前进：${absolutePath}`);
        offset += written;
      }
    } finally {
      await handle.close();
    }
    return absolutePath;
  };

  const collectFiles = async (
    rootRelative: string,
    currentRelative: string,
    output: Array<{ relative: string; absolute: string }>,
  ): Promise<void> => {
    const current = currentRelative ? `${rootRelative}/${currentRelative}` : rootRelative;
    if (!(await ensureDirectory(current, false))) return;
    const absoluteCurrent = joinBase(base, safeRelative(current, '沙箱目录路径'));
    const entries = await fs.readDir(absoluteCurrent);
    for (const entry of entries) {
      const name = safeEntryName(entry.name);
      if (entry.isSymlink) {
        throw new Error(`沙箱拒绝提交符号链接：${absoluteCurrent}/${name}`);
      }
      const childRelative = currentRelative ? `${currentRelative}/${name}` : name;
      const childPath = `${rootRelative}/${childRelative}`;
      if (entry.isDirectory) {
        await collectFiles(rootRelative, childRelative, output);
      } else if (entry.isFile) {
        const absolute = await inspectFile(safeRelative(childPath, '沙箱文件路径'));
        if (!absolute) throw new Error(`沙箱文件在检查期间消失：${childPath}`);
        output.push({ relative: childRelative, absolute });
      } else {
        throw new Error(`沙箱拒绝未知目录项：${absoluteCurrent}/${name}`);
      }
    }
  };

  return {
    async writeFile(rootRelative, fileRelative, content) {
      const root = safeRelative(rootRelative, '沙箱根路径');
      const file = safeRelative(fileRelative, '沙箱文件路径');
      return writeRelative(`${root}/${file}`, content);
    },

    async readFile(rootRelative, fileRelative) {
      const root = safeRelative(rootRelative, '沙箱根路径');
      const file = safeRelative(fileRelative, '沙箱文件路径');
      const absolute = await inspectFile(`${root}/${file}`);
      return absolute ? fs.readTextFile(absolute) : null;
    },

    async list(rootRelative) {
      const root = safeRelative(rootRelative, '沙箱根路径');
      if (!(await ensureDirectory(root, false))) return [];
      const absolute = joinBase(base, root);
      const entries = await fs.readDir(absolute);
      return entries.map((entry) => {
        if (entry.isSymlink) throw new Error(`沙箱拒绝列出符号链接：${absolute}/${entry.name}`);
        return safeEntryName(entry.name);
      });
    },

    async commit(rootRelative, destinationRelative = '') {
      const root = safeRelative(rootRelative, '沙箱根路径');
      const destination = safeOptionalRelative(destinationRelative, '沙箱交付路径');
      const files: Array<{ relative: string; absolute: string }> = [];
      await collectFiles(root, '', files);
      const committed: string[] = [];
      for (const file of files) {
        const content = await fs.readTextFile(file.absolute);
        const targetRelative = destination ? `${destination}/${file.relative}` : file.relative;
        committed.push(await writeRelative(targetRelative, content));
      }
      return committed;
    },
  };
}
