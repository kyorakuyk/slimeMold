import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveInside, runCommand, sanitizeEnv } from './node-run';

describe('sanitizeEnv', () => {
  it('removes credential families while preserving execution essentials', () => {
    const credentialFixture = 'fixture';
    const sanitized = sanitizeEnv({
      PATH: 'safe-path',
      TEMP: 'C:/temp',
      SystemRoot: 'C:/Windows',
      NPM_TOKEN: credentialFixture,
      NODE_AUTH_TOKEN: credentialFixture,
      AZURE_CLIENT_SECRET: credentialFixture,
      GOOGLE_APPLICATION_CREDENTIALS: credentialFixture,
      OPENAI_API_KEY: credentialFixture,
      NPM_CONFIG__AUTH: credentialFixture,
      GITHUB_PAT: credentialFixture,
      DATABASE_URL: credentialFixture,
      SERVICE_DSN: credentialFixture,
      NPM_CONFIG_USERCONFIG: credentialFixture,
      SESSION_COOKIE: credentialFixture,
      BEARER: credentialFixture,
      NODE_ENV: 'test',
      SM_NON_SECRET_MODE: 'worker',
    });

    expect(sanitized).toMatchObject({
      PATH: 'safe-path',
      SystemRoot: 'C:/Windows',
      NODE_ENV: 'test',
      HOME: 'C:/temp/slimemold-worker-home',
      USERPROFILE: 'C:/temp/slimemold-worker-home',
      NPM_CONFIG_USERCONFIG: 'C:/temp/slimemold-worker-home/npmrc',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
    });
    expect(sanitized).not.toHaveProperty('NPM_TOKEN');
    expect(sanitized).not.toHaveProperty('NODE_AUTH_TOKEN');
    expect(sanitized).not.toHaveProperty('AZURE_CLIENT_SECRET');
    expect(sanitized).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
    expect(sanitized).not.toHaveProperty('OPENAI_API_KEY');
    expect(sanitized).not.toHaveProperty('NPM_CONFIG__AUTH');
    expect(sanitized).not.toHaveProperty('GITHUB_PAT');
    expect(sanitized).not.toHaveProperty('DATABASE_URL');
    expect(sanitized).not.toHaveProperty('SERVICE_DSN');
    expect(sanitized.NPM_CONFIG_USERCONFIG).toBe('C:/temp/slimemold-worker-home/npmrc');
    expect(sanitized).not.toHaveProperty('SESSION_COOKIE');
    expect(sanitized).not.toHaveProperty('BEARER');
    expect(sanitized).not.toHaveProperty('SM_NON_SECRET_MODE');
  });

  it('resolves the npm command shim on Windows headless runs', async () => {
    const result = await runCommand('npm', ['--version'], process.cwd(), 30_000);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/\d+\.\d+/);
  });
});

describe('resolveInside', () => {
  it('rejects a broken final symlink instead of treating it as a new file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slimemold-resolve-'));
    try {
      await symlink(join(root, 'missing-target.txt'), join(root, 'broken-link.txt'));
      await expect(resolveInside(root, 'broken-link.txt')).rejects.toThrow(/broken symlink/);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'EPERM' && code !== 'EACCES') throw error;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
