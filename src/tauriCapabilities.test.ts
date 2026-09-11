import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const capabilityPath = resolve(process.cwd(), 'src-tauri/capabilities/default.json');
const capabilities = JSON.parse(readFileSync(capabilityPath, 'utf8')) as {
  permissions: Array<string | { identifier?: string }>;
};
const permissions = new Set(
  capabilities.permissions.map((permission) =>
    typeof permission === 'string' ? permission : permission.identifier,
  ),
);

describe('desktop window permissions', () => {
  it('allows the custom title bar to control the main window', () => {
    for (const permission of [
      'core:window:allow-minimize',
      'core:window:allow-toggle-maximize',
      'core:window:allow-close',
      'core:window:allow-start-dragging',
    ]) {
      expect(permissions.has(permission)).toBe(true);
    }
  });
});
