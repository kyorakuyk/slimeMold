import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

function createLocalStorageExecArgv(): string[] {
  const [nodeMajor] = process.versions.node.split('.').map(Number);
  // Let jsdom own per-file Storage; disable only Node 25+'s native default.
  if (nodeMajor < 25) return [];
  return ['--no-experimental-webstorage'];
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
