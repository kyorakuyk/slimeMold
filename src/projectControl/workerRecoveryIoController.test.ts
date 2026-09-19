import { describe, expect, it, vi } from 'vitest';
import { createWorkerRecoveryIoController } from './workerRecoveryIoController';

describe('worker recovery I/O controller', () => {
  it('does not touch host I/O outside Tauri or after cancellation', async () => {
    const reportWarning = vi.fn();
    const controller = createWorkerRecoveryIoController({
      getState: () => ({} as never),
      recordProjectEvents: vi.fn(),
      saveProject: vi.fn(async () => {}),
      reportWarning,
      isTauri: false,
    });

    await controller.recoverInterruptedWorkerEffects('C:/project-1', ['run-1']);
    await controller.loadProjectWorkerEvidence('C:/project-1');

    const abort = new AbortController();
    abort.abort();
    await controller.recoverInterruptedWorkerEffects('C:/project-1', ['run-1'], abort.signal);
    await controller.loadProjectWorkerEvidence('C:/project-1', abort.signal);

    expect(reportWarning).not.toHaveBeenCalled();
  });
});
