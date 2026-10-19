export const WORKER_RUNTIME_ERROR_MESSAGES = {
  projectNotSaved: '项目必须先保存，Worker 才能创建隔离 worktree',
  projectContextChanged: 'Worker post-commit project context 已切换，拒绝执行旧 recovery dispatch',
  workerStateDrifted: 'Worker post-commit candidate/state 已漂移，拒绝执行旧 recovery dispatch',
} as const;
