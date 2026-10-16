'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'readability-metrics.cjs');

const os = require('node:os');

function runMetrics(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function expectJsonStdout(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  assert.ok(JSON.parse(result.stdout).fileStats);
}

test('prints raw metrics JSON to stdout when --json is used without a file target', () => {
  expectJsonStdout(runMetrics('--json'));
});

test('does not write a legacy --json path argument and still prints JSON to stdout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-json-stdout-'));
  const output = path.join(dir, 'metrics.json');
  const sentinel = 'leave-this-file-unchanged';
  try {
    fs.writeFileSync(output, sentinel);
    const result = runMetrics('--json', output);
    assert.equal(fs.readFileSync(output, 'utf8'), sentinel);
    expectJsonStdout(result);
    assert.equal(result.stdout.includes('# Readability metrics'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
