import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const script = join(root, 'scripts', 'readability-metrics.cjs');
const scratchRoot = process.env.SLIMEMOLD_TEST_SCRATCH || tmpdir();

function tempDir(): string {
  return mkdtempSync(join(scratchRoot, 'r7-metrics-json-'));
}

function runMetrics(jsonPath: string) {
  return spawnSync(process.execPath, [script, '--json', jsonPath], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function outputName(): string {
  return `.r7-metrics-json-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

function skipIfLinkUnavailable(skip: () => never, error: unknown, kind: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && ['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(code)) {
    const reason = `${kind} creation unavailable (${code}); ${String(error)}`;
    console.warn(`[r7] skipped symlink boundary case: ${reason}`);
    return skip();
  }
  throw error;
}

it('rejects an ordinary --json path inside the repository before writing', () => {
  const output = join(root, outputName());
  expect(existsSync(output)).toBe(false);
  const result = runMetrics(output);
  expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(2);
  expect(result.stderr).toMatch(/--json.*(?:outside|inside).*repository|repository.*--json/i);
  expect(existsSync(output)).toBe(false);
});

it('rejects a repo-targeting directory junction before writing through the alias', (context) => {
  const dir = tempDir();
  const link = join(dir, 'repo-link');
  const basename = outputName();
  const repoOutput = join(root, basename);
  try {
    try {
      symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      skipIfLinkUnavailable(context.skip, error, process.platform === 'win32' ? 'junction' : 'directory symlink');
    }
    const result = runMetrics(join(link, basename));
    expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(2);
    expect(result.stderr).toMatch(/--json.*(?:outside|inside).*repository|repository.*--json/i);
    expect(existsSync(repoOutput)).toBe(false);
  } finally {
    if (existsSync(repoOutput)) rmSync(repoOutput, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

it('rejects an existing --json file symlink without following it', (context) => {
  const dir = tempDir();
  const target = join(dir, 'sentinel.json');
  const link = join(dir, 'metrics-output.json');
  writeFileSync(target, 'sentinel');
  try {
    try {
      symlinkSync(target, link, 'file');
    } catch (error) {
      skipIfLinkUnavailable(context.skip, error, 'file symlink');
    }
    const result = runMetrics(link);
    expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(2);
    expect(result.stderr).toMatch(/symlink|symbolic link|link/i);
    expect(readFileSync(target, 'utf8')).toBe('sentinel');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('allows a regular --json path outside the repository', () => {
  const dir = tempDir();
  const output = join(dir, 'metrics.json');
  try {
    const result = runMetrics(output);
    expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(0);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toHaveProperty('fileStats');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
