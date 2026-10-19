import { useState, type Dispatch, type SetStateAction } from 'react';
import type { WorkerRunQueueState } from '../../domain/workerQueue';
import type { WorkerRecoveryAction } from '../../projectControl/workerRecoveryCapabilityProjection';
import type { WorkerRuntime } from '../../projectControl/workerRunCoordinator';
import type { WorkerRunRecovery } from '../../projectControl/workerRunRuntime';
import type { WorkerRunRecoveryDecision } from '../../projectControl/workerSideEffects';

type UseProjectSessionWorkerActionsOptions = {
  currentWorkerRun: WorkerRunQueueState | null;
  currentWorkerRunRecovery: WorkerRunRecovery | null;
  currentWorkerRecoveryActions: readonly WorkerRecoveryAction[];
  onRunWorker?: (runId: string, runtime?: WorkerRuntime) => Promise<void> | void;
  onRecoverWorkerRun?: (
    runId: string,
    decision: Exclude<WorkerRunRecoveryDecision, 'inspect'>,
    reason: string,
    runtime?: WorkerRuntime,
  ) => Promise<void> | void;
  setError: Dispatch<SetStateAction<string | null>>;
};

export default function useProjectSessionWorkerActions({
  currentWorkerRun,
  currentWorkerRunRecovery,
  currentWorkerRecoveryActions,
  onRunWorker,
  onRecoverWorkerRun,
  setError,
}: UseProjectSessionWorkerActionsOptions) {
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [workerStartBusy, setWorkerStartBusy] = useState(false);
  const [workerRuntime, setWorkerRuntime] = useState<WorkerRuntime>('codex');

  const handleWorkerRecovery = (decision: Exclude<WorkerRunRecoveryDecision, 'inspect'>) => {
    if (!onRecoverWorkerRun || !currentWorkerRun || recoveryBusy || !currentWorkerRecoveryActions.includes(decision)) return;
    const runId = currentWorkerRun.runId;
    const reason = `用户在项目驾驶舱选择 ${decision}`;
    setRecoveryBusy(true);
    setError(null);
    void (async () => {
      try {
        await onRecoverWorkerRun(runId, decision, reason, workerRuntime);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setRecoveryBusy(false);
      }
    })();
  };

  const handleStartQueuedWorker = () => {
    if (!onRunWorker || !currentWorkerRun || currentWorkerRun.status !== 'queued' || currentWorkerRunRecovery || workerStartBusy) return;
    setWorkerStartBusy(true);
    setError(null);
    void Promise.resolve(onRunWorker(currentWorkerRun.runId, workerRuntime))
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setWorkerStartBusy(false));
  };

  return {
    recoveryBusy,
    workerStartBusy,
    workerRuntime,
    setWorkerRuntime,
    handleWorkerRecovery,
    handleStartQueuedWorker,
  };
}
