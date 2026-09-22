import type { WorkerRecoveryFactsV1 } from './workerRecoveryFactsTypes';
import {
  comparableWorkerPath,
  compareUtf8,
  sortedStrings,
} from './workerRecoveryFactsRules';

export function normalizeFactsDto(facts: WorkerRecoveryFactsV1): WorkerRecoveryFactsV1 {
  return {
    ...facts,
    run: {
      ...facts.run,
      tasks: facts.run.tasks
        .map((task) => ({
          ...task,
          ...(task.worktreePath === undefined ? {} : { worktreePath: comparableWorkerPath(task.worktreePath) }),
          evidenceIds: sortedStrings(task.evidenceIds),
        }))
        .sort((left, right) => compareUtf8(left.taskId, right.taskId)),
    },
    taskGraph: {
      ...facts.taskGraph,
      tasks: facts.taskGraph.tasks
        .map((task) => ({
          ...task,
          scope: task.scope.map((path) => comparableWorkerPath(path)).sort(compareUtf8),
          dependsOn: sortedStrings(task.dependsOn),
          acceptanceCriteria: [...task.acceptanceCriteria],
        }))
        .sort((left, right) => compareUtf8(left.id, right.id)),
    },
    failedTaskIds: sortedStrings(facts.failedTaskIds),
    recoverableEffects: facts.recoverableEffects
      .map((effect) => {
        let target = effect.target;
        let inputHash = effect.inputHash;
        if (effect.kind === 'worktree-cleanup') {
          target = comparableWorkerPath(target);
        } else {
          const tuple = JSON.parse(inputHash) as unknown[];
          tuple[5] = comparableWorkerPath(String(tuple[5]));
          inputHash = JSON.stringify(tuple);
        }
        return {
          ...effect,
          target,
          inputHash,
          ...(effect.receipt === undefined ? {} : {
            receipt: {
              ...effect.receipt,
              ...(effect.receipt.evidenceIds === undefined ? {} : { evidenceIds: sortedStrings(effect.receipt.evidenceIds) }),
              ...(effect.receipt.files === undefined ? {} : { files: [...effect.receipt.files].map((file) => ({ ...file, path: comparableWorkerPath(file.path) })).sort((left, right) => compareUtf8(left.path, right.path)) }),
            },
          }),
        };
      })
      .sort((left, right) => compareUtf8(left.idempotencyKey, right.idempotencyKey)),
  };
}
