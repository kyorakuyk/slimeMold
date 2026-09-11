import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const TEST_ARTIFACT_ROOT_ENV = 'SLIMEMOLD_TEST_ARTIFACT_ROOT';
const KEEP_TEST_ARTIFACTS_ENV = 'SLIMEMOLD_KEEP_TEST_ARTIFACTS';
const DEFAULT_ROOT_NAME = 'slimemold-test-runs';

export interface TestArtifactRootOptions {
  /** Override the dedicated root; it must not be the repository cwd or a child of it. */
  root?: string;
  /** Preserve the case directory for post-failure inspection. */
  keep?: boolean;
}

function isSameOrDescendant(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertOutsideRepository(root: string): void {
  const cwd = resolve(process.cwd());
  const candidate = resolve(root);
  if (isSameOrDescendant(cwd, candidate)) {
    throw new Error(`测试生成物必须位于专有目录，不能位于仓库 cwd 或其子目录：${candidate}`);
  }
}

function safeNamespace(namespace: string): string {
  const safe = namespace.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'test';
}

function keepArtifacts(options: TestArtifactRootOptions): boolean {
  return options.keep ?? process.env[KEEP_TEST_ARTIFACTS_ENV] === '1';
}

/**
 * Create an isolated per-test directory below a single dedicated root.
 * The default is outside the repository cwd so tests cannot recreate root clutter.
 */
export async function createTestArtifactRoot(
  namespace = 'test',
  options: TestArtifactRootOptions = {},
): Promise<string> {
  const configuredRoot = options.root?.trim() || process.env[TEST_ARTIFACT_ROOT_ENV]?.trim();
  const configured = configuredRoot || join(tmpdir(), DEFAULT_ROOT_NAME);
  assertOutsideRepository(configured);

  await mkdir(configured, { recursive: true });
  const canonicalRoot = await realpath(configured);
  assertOutsideRepository(canonicalRoot);
  return mkdtemp(join(canonicalRoot, `${safeNamespace(namespace)}-`));
}

/**
 * Run a callback inside a dedicated artifact directory and remove it afterwards.
 * Set `keep` or `SLIMEMOLD_KEEP_TEST_ARTIFACTS=1` only when the case needs inspection.
 */
export async function withTestArtifactRoot<T>(
  namespace: string,
  callback: (root: string) => Promise<T> | T,
  options: TestArtifactRootOptions = {},
): Promise<T> {
  const root = await createTestArtifactRoot(namespace, options);
  try {
    return await callback(root);
  } finally {
    if (!keepArtifacts(options)) {
      await rm(root, { recursive: true, force: true });
    }
  }
}
