export const FILE_PATCH_SET_SCHEMA_VERSION = 1 as const;
export const PROJECT_SCAFFOLD_SCHEMA_VERSION = 1 as const;

export type FilePatchSource = 'scaffold' | 'worker';
export type ScaffoldFileRole = 'source' | 'test' | 'config' | 'docs';

export interface FilePatchEntry {
  /** Canonical project-relative POSIX path. */
  path: string;
  /** Null means the file is expected not to exist yet. */
  before: string | null;
  /** The complete content expected after applying the candidate. */
  after: string;
  /** Optional host-computed preimage fingerprint. */
  beforeHash?: string;
  /** Optional host-computed postimage fingerprint. */
  afterHash?: string;
}

export interface FilePatchSet {
  schemaVersion: typeof FILE_PATCH_SET_SCHEMA_VERSION;
  source: FilePatchSource;
  summary: string;
  patches: FilePatchEntry[];
}

export interface ProjectSpec {
  schemaVersion: typeof PROJECT_SCAFFOLD_SCHEMA_VERSION;
  name: string;
  runtime: 'node-typescript';
  packageManager: 'npm';
  compileCommand: ['npm', 'run', 'build'];
  testCommand: ['npm', 'run', 'test'];
}

export interface StructureFile {
  path: string;
  role: ScaffoldFileRole;
  required: true;
}

export interface StructureManifest {
  schemaVersion: typeof PROJECT_SCAFFOLD_SCHEMA_VERSION;
  files: StructureFile[];
  compileCommand: ['npm', 'run', 'build'];
  testCommand: ['npm', 'run', 'test'];
}

export interface TypeScriptMvpScaffold {
  projectSpec: ProjectSpec;
  manifest: StructureManifest;
  patchSet: FilePatchSet;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Project-relative paths are deliberately narrower than the host path policy:
 * one canonical POSIX spelling, no drive/UNC/parent segments, and no runtime metadata.
 */
export function assertSafeProjectRelativePath(path: string): void {
  if (
    !path ||
    path.trim() !== path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new Error(`FilePatchSet 路径必须是规范的项目相对路径：${path}`);
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`FilePatchSet 路径不能穿越目录：${path}`);
  }
  if (segments.some((segment) => segment === '.slimemold')) {
    throw new Error(`FilePatchSet 不得修改项目运行元数据：${path}`);
  }
}

function assertOptionalHash(value: unknown, field: string): void {
  if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
    throw new Error(`FilePatchSet.${field} 无效`);
  }
}

/** Decode a model/adapter value into a bounded, canonical patch set. */
export function decodeFilePatchSet(value: unknown): FilePatchSet {
  if (!isRecord(value)) throw new Error('FilePatchSet 必须是对象');
  if (value.schemaVersion !== FILE_PATCH_SET_SCHEMA_VERSION) {
    throw new Error(`FilePatchSet schemaVersion 不支持：${String(value.schemaVersion)}`);
  }
  if (value.source !== 'scaffold' && value.source !== 'worker') {
    throw new Error('FilePatchSet.source 无效');
  }
  if (typeof value.summary !== 'string' || !value.summary.trim()) {
    throw new Error('FilePatchSet.summary 无效');
  }
  if (!Array.isArray(value.patches) || value.patches.length === 0 || value.patches.length > 128) {
    throw new Error('FilePatchSet.patches 数量无效');
  }

  const seen = new Set<string>();
  const patches = value.patches.map((raw, index): FilePatchEntry => {
    if (!isRecord(raw)) throw new Error(`FilePatchSet.patches[${index}] 必须是对象`);
    if (typeof raw.path !== 'string') throw new Error(`FilePatchSet.patches[${index}].path 无效`);
    assertSafeProjectRelativePath(raw.path);
    const key = raw.path.toLowerCase();
    if (seen.has(key)) throw new Error(`FilePatchSet 存在重复路径：${raw.path}`);
    seen.add(key);
    if (raw.before !== null && typeof raw.before !== 'string') {
      throw new Error(`FilePatchSet.patches[${index}].before 无效`);
    }
    if (typeof raw.after !== 'string') throw new Error(`FilePatchSet.patches[${index}].after 无效`);
    assertOptionalHash(raw.beforeHash, `patches[${index}].beforeHash`);
    assertOptionalHash(raw.afterHash, `patches[${index}].afterHash`);
    return {
      path: raw.path,
      before: raw.before,
      after: raw.after,
      ...(raw.beforeHash === undefined ? {} : { beforeHash: raw.beforeHash as string }),
      ...(raw.afterHash === undefined ? {} : { afterHash: raw.afterHash as string }),
    };
  });

  return {
    schemaVersion: FILE_PATCH_SET_SCHEMA_VERSION,
    source: value.source,
    summary: value.summary,
    patches,
  };
}

function projectNameFromInput(projectName: string): string {
  const normalized = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'slimemold-mvp-project';
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Deterministic first-MVP project skeleton. It creates a patch candidate only;
 * host apply/delivery owns every filesystem side effect.
 */
export function createTypeScriptMvpScaffold(projectName = 'slimemold-mvp-project'): TypeScriptMvpScaffold {
  const name = projectNameFromInput(projectName);
  const projectSpec: ProjectSpec = {
    schemaVersion: PROJECT_SCAFFOLD_SCHEMA_VERSION,
    name,
    runtime: 'node-typescript',
    packageManager: 'npm',
    compileCommand: ['npm', 'run', 'build'],
    testCommand: ['npm', 'run', 'test'],
  };
  const files: StructureFile[] = [
    { path: 'package.json', role: 'config', required: true },
    { path: 'tsconfig.json', role: 'config', required: true },
    { path: 'README.md', role: 'docs', required: true },
    { path: 'src/index.ts', role: 'source', required: true },
    { path: 'tests/index.test.ts', role: 'test', required: true },
  ];
  const contents: Record<string, string> = {
    'package.json': jsonFile({
      name,
      private: true,
      type: 'module',
      scripts: {
        build: 'tsc --noEmit',
        test: 'vitest run',
      },
      devDependencies: {
        typescript: '^5.6.3',
        vitest: '^2.1.0',
      },
    }),
    'tsconfig.json': jsonFile({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts', 'tests/**/*.ts'],
    }),
    'README.md': `# ${name}\n\nThis project was generated by the SlimeMold first-MVP scaffold.\n`,
    'src/index.ts': "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
    'tests/index.test.ts': "import { describe, expect, it } from 'vitest';\nimport { greet } from '../src/index';\n\ndescribe('greet', () => {\n  it('returns a deterministic greeting', () => {\n    expect(greet('MVP')).toBe('Hello, MVP!');\n  });\n});\n",
  };
  const manifest: StructureManifest = {
    schemaVersion: PROJECT_SCAFFOLD_SCHEMA_VERSION,
    files,
    compileCommand: [...projectSpec.compileCommand],
    testCommand: [...projectSpec.testCommand],
  };
  const patchSet = decodeFilePatchSet({
    schemaVersion: FILE_PATCH_SET_SCHEMA_VERSION,
    source: 'scaffold',
    summary: `生成 ${name} 的 TypeScript MVP 项目骨架`,
    patches: files.map((file) => ({ path: file.path, before: null, after: contents[file.path] })),
  });
  return { projectSpec, manifest, patchSet };
}
