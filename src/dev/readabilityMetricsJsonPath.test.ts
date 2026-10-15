import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

function runMetrics(jsonPath: string, preload?: { path: string; env: NodeJS.ProcessEnv }) {
  return spawnSync(process.execPath, [
    ...(preload ? ['--require', preload.path] : []),
    script,
    '--json',
    jsonPath,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: preload ? { ...process.env, ...preload.env } : process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function outputName(): string {
  return `.r7-metrics-json-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`;
}

function skipIfLinkUnavailable(skip: () => void, error: unknown, kind: string): void {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && ['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL'].includes(code)) {
    const reason = `${kind} creation unavailable (${code}); ${String(error)}`;
    console.warn(`[r7] skipped symlink boundary case: ${reason}`);
    skip();
    return;
  }
  throw error;
}

const symlinkRaceHook = `
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(process.env.R7_RACE_OUTPUT);
const outputDir = path.dirname(output);
const repoAlias = path.resolve(process.env.R7_RACE_REPO_ALIAS);
const backupDir = path.resolve(process.env.R7_RACE_BACKUP);
const marker = path.resolve(process.env.R7_RACE_MARKER);
let swapped = false;
const originalRenameSync = fs.renameSync;
const originalWriteFileSync = fs.writeFileSync;
const isOutput = (file) => typeof file === 'string' && path.resolve(file) === output;
function swapParent() {
  if (swapped) return;
  originalRenameSync(outputDir, backupDir);
  originalRenameSync(repoAlias, outputDir);
  swapped = true;
  originalWriteFileSync(marker, 'race injected');
}
const originalOpenSync = fs.openSync;
fs.openSync = function (file, ...args) {
  if (!swapped && isOutput(file)) swapParent();
  return originalOpenSync.call(this, file, ...args);
};
fs.writeFileSync = function (file, ...args) {
  if (!swapped && isOutput(file)) swapParent();
  return originalWriteFileSync.call(this, file, ...args);
};
`;

function runSymlinkRace(skip: () => void): void {
  const fixture = tempDir();
  const outputDir = join(fixture, 'output');
  const repoAlias = join(fixture, 'repo-alias');
  const backupDir = join(fixture, 'output-backup');
  const marker = join(fixture, 'race-triggered');
  const basename = outputName();
  const output = join(outputDir, basename);
  const repoOutput = join(root, basename);
  const sentinel = 'sentinel';
  try {
    mkdirSync(outputDir);
    expect(existsSync(repoOutput)).toBe(false);
    writeFileSync(repoOutput, sentinel);
    try {
      symlinkSync(root, repoAlias, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      skipIfLinkUnavailable(skip, error, 'race directory junction');
    }
    const hookPath = join(fixture, 'symlink-race.cjs');
    writeFileSync(hookPath, symlinkRaceHook);
    const result = runMetrics(output, {
      path: hookPath,
      env: {
        R7_RACE_OUTPUT: output,
        R7_RACE_REPO_ALIAS: repoAlias,
        R7_RACE_BACKUP: backupDir,
        R7_RACE_MARKER: marker,
      },
    });
    expect(existsSync(marker), result.stderr || result.stdout || String(result.error)).toBe(true);
    expect(readFileSync(repoOutput, 'utf8') === sentinel, 'race wrote into repository sentinel').toBe(true);
    expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(2);
    expect(result.stderr).toMatch(/--json.*(?:outside|inside|repository|changed)|repository.*--json/i);
  } finally {
    if (existsSync(outputDir) && existsSync(backupDir)) renameSync(outputDir, repoAlias);
    if (existsSync(backupDir)) renameSync(backupDir, outputDir);
    rmSync(repoOutput, { force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
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

it('rejects a repository directory-link swap before opening the --json target', (context) => {
  runSymlinkRace(context.skip);
});
