import { describe, expect, it, vi } from 'vitest';
import { createProjectCreationActions } from './projectCreationActions';

const identity = { workflowId: 'wf-1', projectId: 'proj-1', createdAt: '2026-09-01T00:00:00.000Z' };
const template = { name: '模板', nodes: [], edges: [] };

const harness = (overrides: Record<string, unknown> = {}) => {
  const events: string[] = [];
  const setState = vi.fn((patch: object) => events.push(`set:${Object.keys(patch).join(',')}`));
  const deps = {
    getProjectId: () => 'old-project',
    resetProjectControlLifecycle: (id?: string | null) => { events.push(`reset:${id ?? 'none'}`); },
    getTemplate: () => template,
    createProjectIdentity: () => identity,
    resolveSaveRoot: vi.fn(async () => null),
    setDirtySuppressed: (value: boolean) => events.push(`suppressed:${value}`),
    setState,
    saveProject: vi.fn(async () => 'C:/saved'),
    saveLastSession: (value: { path: string; activeId: string }) => events.push(`save-session:${value.path}`),
    clearLastSession: () => events.push('clear-session'),
    addLog: (level: string, message: string) => events.push(`log:${level}:${message}`),
    ...overrides,
  };
  return { events, deps, actions: createProjectCreationActions(deps) };
};

describe('projectCreationActions', () => {
  it('creates an in-memory project without saving when no root is resolved', async () => {
    const { events, actions, deps } = harness();
    await actions.createProject({ name: '新项目' });
    expect(events).toEqual(['reset:old-project', 'suppressed:true', 'set:projectName,projectId,projectCreatedAt,projectPath,projectDirty,lastSavedSnapshot,workflows,activeWfId,workflowName,nodes,edges,agents,roles,variables,projectVariables,projectAssets,workerRuns,projectControl,selectedNodeId,logs,workerRunRecoveries,workerRunEvidence,workerRunSideEffects,workerCleanupProposals', 'suppressed:false', 'clear-session']);
    expect(deps.saveProject).not.toHaveBeenCalled();
  });

  it('saves the created project and records the returned root', async () => {
    const { events, actions, deps } = harness({ resolveSaveRoot: vi.fn(async () => 'C:/requested') });
    await actions.createProject({ name: '新项目', templateId: 'starter' });
    expect(deps.saveProject).toHaveBeenCalledOnce();
    expect(events).toContain('save-session:C:/saved');
    expect(events).not.toContain('clear-session');
  });

  it('keeps the project in memory and logs the original save failure', async () => {
    const { events, actions, deps } = harness({
      resolveSaveRoot: vi.fn(async () => 'C:/requested'),
      saveProject: vi.fn(async () => { throw new Error('disk fail'); }),
    });
    await actions.createProject({ name: '新项目' });
    expect(events).toContain('log:warn:项目已创建但落盘失败：disk fail');
    expect(deps.setState).toHaveBeenCalledTimes(2);
    expect(deps.setState.mock.calls[1]?.[0]).toEqual({ projectPath: null, projectDirty: true });
  });
});
