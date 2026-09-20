import { describe, expect, it, vi } from 'vitest';
import type { ProjectFile } from '../types';
import type { ProjectControlRuntimeState, ProjectControlStoreAdapter } from './projectControlLifecycle';
import { createProjectBootstrapActions } from './projectBootstrapActions';

const runtimeProjection: ProjectControlRuntimeState = {
  workerRunRecoveries: [],
  workerRunEvidence: [],
  workerRunSideEffects: [],
  workerCleanupProposals: [],
};

const file = (workflows: Record<string, unknown>): ProjectFile => ({
  version: 1,
  kind: 'project',
  id: 'project-2',
  name: '项目二',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  activeId: 'wf-2',
  workflows,
} as never);

const harness = () => {
  const state = { projectId: 'project-1', defaultAgentId: null } as Record<string, unknown>;
  const events: string[] = [];
  const adapter: ProjectControlStoreAdapter = {
    resetProjectControlLifecycle: (id) => events.push(`reset:${id ?? 'none'}`),
    activateProjectControlRuntime: () => {
      events.push('activate');
      return runtimeProjection;
    },
  };
  const setState = vi.fn((patch: object) => Object.assign(state, patch));
  const setDirtySuppressed = vi.fn((value: boolean) => events.push(`suppressed:${value}`));
  const finalizeLoaded = vi.fn(() => events.push('finalize-loaded'));
  const actions = createProjectBootstrapActions({
    getProjectId: () => state.projectId as string | null,
    getDefaultAgentId: () => state.defaultAgentId as string | null,
    setState,
    setDirtySuppressed,
    finalizeLoaded,
    projectControlAdapter: adapter,
  });
  return { state, events, actions, setState, finalizeLoaded };
};

describe('projectBootstrapActions', () => {
  it('creates a project through reset, suppression, and pure state patch', () => {
    const { actions, events, setState } = harness();
    actions.newProject('新项目');
    expect(events.slice(0, 3)).toEqual(['reset:project-1', 'suppressed:true', 'suppressed:false']);
    expect(setState).toHaveBeenCalledOnce();
  });

  it('leaves invalid opens untouched and activates valid opens after baseline finalization', () => {
    const invalid = harness();
    expect(invalid.actions.openProject(file({}))).toBe(false);
    expect(invalid.setState).not.toHaveBeenCalled();

    const valid = harness();
    expect(valid.actions.openProject(file({
      'wf-2': { version: 1, name: '工作流二', nodes: [], edges: [], agents: [], roles: [] },
    }))).toBe(true);
    expect(valid.events).toEqual(['suppressed:true', 'finalize-loaded', 'activate']);
    expect(valid.setState).toHaveBeenCalledTimes(2);
    expect(valid.finalizeLoaded).toHaveBeenCalledOnce();
  });
});
