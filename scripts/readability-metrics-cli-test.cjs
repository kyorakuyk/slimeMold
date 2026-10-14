'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'readability-metrics.cjs');

function uniqueRepoOutputPath() {
  return path.join(root, `.r5-metrics-json-guard-${process.pid}-${Date.now()}.json`);
}

function assertRepoPathRejected(argument, absoluteOutput) {
  assert.equal(fs.existsSync(absoluteOutput), false, 'test output path must start absent');
  try {
    const result = spawnSync(process.execPath, [script, '--json', argument], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.status, 2, result.stderr || result.stdout || String(result.error));
    assert.match(result.stderr, /--json.*(?:outside|inside).*repository|repository.*--json/i);
    assert.equal(fs.existsSync(absoluteOutput), false, 'rejected path must not be created');
  } finally {
    if (fs.existsSync(absoluteOutput)) fs.rmSync(absoluteOutput);
  }
}

test('rejects an absolute --json output path inside the repository without writing it', () => {
  const absoluteOutput = uniqueRepoOutputPath();
  assertRepoPathRejected(absoluteOutput, absoluteOutput);
});

test('rejects a relative --json output path inside the repository without writing it', () => {
  const absoluteOutput = uniqueRepoOutputPath();
  const relativeOutput = path.relative(root, absoluteOutput);
  assertRepoPathRejected(relativeOutput, absoluteOutput);
});
