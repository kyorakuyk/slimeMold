import type { DevSession } from '../dev/session';

export interface WorkerRunSessionAdmissionDeps {
  projectId: string;
  projectPath: string;
  signal: AbortSignal;
  saveProject: (guard: {
    projectId: string;
    projectPath: string;
    signal: AbortSignal;
  }) => Promise<unknown>;
  assertOperation: () => void;
  ensureGuiDevSession: (
    projectPath: string,
    signal: AbortSignal,
  ) => Promise<DevSession | null>;
  getDevGuiError: () => string | null | undefined;
  getCurrentProjectId: () => string | null | undefined;
}

/** Preserve the saved-project admission choreography before Worker host wiring. */
export async function admitWorkerRunSession(
  deps: WorkerRunSessionAdmissionDeps,
): Promise<DevSession> {
  await deps.saveProject({
    projectId: deps.projectId,
    projectPath: deps.projectPath,
    signal: deps.signal,
  });
  deps.assertOperation();
  const session = await deps.ensureGuiDevSession(deps.projectPath, deps.signal);
  if (!session) {
    const reason = deps.getDevGuiError();
    throw new Error(`开发宿主不可用，Worker 未启动${reason ? `：${reason}` : ''}`);
  }
  deps.assertOperation();
  if (deps.getCurrentProjectId() !== deps.projectId) {
    throw new Error('项目在 Worker 启动前发生切换');
  }
  return session;
}
