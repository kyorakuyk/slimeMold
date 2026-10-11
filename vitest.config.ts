import { defineConfig } from 'vitest/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

function createLocalStorageExecArgv(): string[] {
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  // Node 22.4+ workers need a backing file for their native Web Storage global.
  if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 4)) return [];

  const cacheDir = fileURLToPath(new URL('./node_modules/.cache/slimemold-vitest-localstorage/', import.meta.url));
  mkdirSync(cacheDir, { recursive: true });
  return [
    '--experimental-webstorage',
    `--localstorage-file=${join(cacheDir, `storage-${randomUUID()}.json`)}`,
  ];
}

const localStorageExecArgv = createLocalStorageExecArgv();

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    poolOptions: {
      forks: { execArgv: localStorageExecArgv },
    },
  },
});
