import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const script = join(root, 'scripts', 'readability-metrics.cjs');

function runMetrics(args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function expectJsonStdout(result: ReturnType<typeof runMetrics>): void {
  expect(result.status, result.stderr || result.stdout || String(result.error)).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveProperty('fileStats');
}

it('prints raw metrics JSON to stdout when --json is used as a flag', () => {
  expectJsonStdout(runMetrics(['--json']));
});

it('does not write a legacy --json path argument and still prints JSON to stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-json-stdout-'));
  const output = join(dir, 'metrics.json');
  const sentinel = 'leave-this-file-unchanged';
  try {
    writeFileSync(output, sentinel);
    const result = runMetrics(['--json', output]);
    expect(existsSync(output)).toBe(true);
    expect(readFileSync(output, 'utf8')).toBe(sentinel);
    expectJsonStdout(result);
    expect(result.stdout.includes('# Readability metrics')).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
