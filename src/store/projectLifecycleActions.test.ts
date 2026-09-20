import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig, RoleTemplate } from '../types';
import type { ProjectControlSnapshot } from '../projectControl/types';
import { buildCloseProjectState } from './workflowLifecycleState';
import { createProjectLifecycleActions } from './projectLifecycleActions';

const agent = { id: 'default', name: 'Default' } as unknown as AgentConfig;
const roles = [{ id: 'role', name: 'Role' }] as unknown as RoleTemplate[];
const projectControl = { version: 1 } as unknown as ProjectControlSnapshot;

const closePatch = () => buildCloseProjectState({
  createDefaultAgent: () => agent,
  cloneBuiltinRoles: () => roles,
  createEmptyProjectControl: () => projectControl,
});

describe('buildCloseProjectState', () => {
  it('returns the exact close patch and leaves unrelated project fields out', () => {
    const patch = closePatch();
    expect(patch).toMatchObject({
      projectName: null,
      projectId: null,
      projectCreatedAt: null,
      projectPath: null,
      projectDirty: false,
      lastSavedSnapshot: null,
      workflows: {},
      activeWfId: '',
      workflowName: '',
      nodes: [],
      edges: [],
      agents: [agent],
      roles,
      variables: {},
      projectVariables: {},
      projectAssets: [],
      subgraphs: {},
      groups: [],
      workerRuns: [],
      workerRunRecoveries: [],
      workerRunEvidence: [],
      workerRunSideEffects: [],
      workerCleanupProposals: [],
      projectControl,
      selectedNodeId: null,
      logs: [],
    });
    expect(patch).not.toHaveProperty('defaultAgentId');
    expect(patch).not.toHaveProperty('workspaceDir');
    expect(patch).not.toHaveProperty('runHistory');
    expect(patch).not.toHaveProperty('artifacts');
    expect(patch).not.toHaveProperty('orchestrations');
  });
});

describe('projectLifecycleActions', () => {
  it('preserves close ordering and passes the pre-close project id to reset', () => {
    const events: string[] = [];
    const setState = vi.fn(() => events.push('set'));
    const actions = createProjectLifecycleActions({
      getProjectId: () => 'project-1',
      resetProjectControlLifecycle: (id) => events.push(`reset:${id}`),
      setDirtySuppressed: (value) => events.push(`suppressed:${value}`),
      setState,
      clearLastSession: () => events.push('clear-session'),
      buildCloseState: closePatch,
    });

    actions.closeProject();

    expect(events).toEqual([
      'reset:project-1',
      'suppressed:true',
      'set',
      'suppressed:false',
      'clear-session',
    ]);
    expect(setState).toHaveBeenCalledWith(closePatch());
  });
});
