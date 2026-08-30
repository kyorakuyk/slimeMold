import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('pickProjectFile', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  it('does not open a second native dialog after the folder chooser is cancelled', async () => {
    const open = vi.fn().mockResolvedValue(null);
    vi.doMock('@tauri-apps/plugin-dialog', () => ({ open }));

    const { pickProjectFile } = await import('./env');

    await expect(pickProjectFile()).resolves.toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        directory: true,
        multiple: false,
      }),
    );
  });
});
