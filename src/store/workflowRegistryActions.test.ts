import { describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import type { WorkflowFile } from '../types/workflow';
import type { FlowEdge, FlowNode } from '../types';
import { createWorkflowRegistryActions, type WorkflowRegistryActionState } from './workflowRegistryActions';

const node = (id: string): FlowNode => ({
  id,
  type: 'base',
  position: { x: 0, y: 0 },
  data: { typeId: 'input.text', label: id, params: {}, status: 'idle' },
} as unknown as FlowNode);

const workflow = (name: string): WorkflowFile => ({
  version: 1, name, savedAt: '2026-01-01', nodes: [], edges: [], agents: [], roles: [],
});

const harness = (initial: Partial<WorkflowRegistryActionState> = {}) => {
  const addLog = vi.fn();
  const state = {
    workflows: {}, activeWfId: '', workflowName: '', nodes: [], edges: [], agents: [], roles: [],
    variables: {}, groups: [], defaultAgentId: null, projectId: 'p1', projectPath: null,
    selectedNodeId: null, logs: [], addLog,
    ...initial,
  } as WorkflowRegistryActionState;
  const setSuppressed = vi.fn();
  const cleanupWorkflow = vi.fn();
  const resolveStandalonePath = vi.fn(async (path?: string | null) => path ?? 'C:/default');
  const actions = createWorkflowRegistryActions({
    getState: () => state,
    setState: (patch) => Object.assign(state, patch),
    setDirtySuppressed: setSuppressed,
    cleanupWorkflow,
    resolveStandalonePath,
    now: () => 1000,
    nowIso: () => '2026-01-01T00:00:00.000Z',
    createRegisteredWorkflowId: () => 'wf-registered',
  });
  return { state, actions, setSuppressed, resolveStandalonePath, cleanupWorkflow, addLog };
};

describe('workflowRegistryActions', () => {
  it('switches with dirty suppression and preserves the public transition', () => {
    const { state, actions, setSuppressed } = harness({
      activeWfId: 'wf-1', workflowName: 'WF1',
      workflows: {
        'wf-1': { name: 'WF1', nodes: [node('a')], edges: [], agents: [], roles: [] },
        'wf-2': { name: 'WF2', nodes: [node('b')], edges: [], agents: [], roles: [] },
      } as never,
      nodes: [node('a')], edges: [] as FlowEdge[],
    });
    actions.switchWorkflow('wf-2');
    expect(state.activeWfId).toBe('wf-2');
    expect(state.nodes[0]?.id).toBe('b');
    expect(setSuppressed.mock.calls).toEqual([[true], [false]]);
  });

  it('injects project/standalone path and preserves capture clock ordering', async () => {
    const state = harness({
      projectId: null, activeWfId: '', workflowName: '未归属', nodes: [node('a')],
    });
    const now = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    const nowIso = vi.fn()
      .mockReturnValueOnce('capture-time')
      .mockReturnValueOnce('new-time');
    const resolveStandalonePath = vi.fn(async () => 'C:/default');
    const actions = createWorkflowRegistryActions({
      getState: () => state.state,
      setState: (patch) => Object.assign(state.state, patch),
      setDirtySuppressed: state.setSuppressed,
      cleanupWorkflow: vi.fn(),
      resolveStandalonePath,
      now,
      nowIso,
      createRegisteredWorkflowId: () => 'unused',
    });
    const result = await actions.newWorkflowInProject();
    expect(result).toEqual({ status: 'created', workflowId: 'wf-2001' });
    expect(resolveStandalonePath).toHaveBeenCalledOnce();
    expect(state.state.workflows['wf-1000']?.savedAt).toBe('capture-time');
    expect(state.state.activeWfId).toBe('wf-2001');
    expect(state.state.workflows['wf-2001']?.savedAt).toBe('new-time');
  });

  it('keeps concurrent standalone creations in the registry after path resolution', async () => {
    let currentState = {
      workflows: {}, activeWfId: '', workflowName: '未归属', nodes: [], edges: [], agents: [], roles: [],
      variables: {}, groups: [], defaultAgentId: null, projectId: null, projectPath: null,
      selectedNodeId: null, logs: [], addLog: vi.fn(),
    } as WorkflowRegistryActionState;
    const pathResolvers: Array<(path: string | undefined) => void> = [];
    const resolveStandalonePath = vi.fn(() => new Promise<string | undefined>((resolve) => {
      pathResolvers.push(resolve);
    }));
    const actions = createWorkflowRegistryActions({
      getState: () => currentState,
      setState: (patch) => { currentState = { ...currentState, ...patch }; },
      setDirtySuppressed: vi.fn(),
      cleanupWorkflow: vi.fn(),
      resolveStandalonePath,
      now: () => 1000,
      nowIso: () => '2026-01-01T00:00:00.000Z',
      createRegisteredWorkflowId: () => 'wf-registered',
    });

    const first = actions.newWorkflowInProject('C:/workspace');
    const second = actions.newWorkflowInProject('C:/workspace');
    expect(resolveStandalonePath).toHaveBeenCalledTimes(2);
    expect(pathResolvers).toHaveLength(2);

    pathResolvers[0]?.('C:/workspace');
    pathResolvers[1]?.('C:/workspace');
    await Promise.all([first, second]);

    expect(Object.keys(currentState.workflows)).toHaveLength(2);
    expect(new Set(Object.keys(currentState.workflows)).size).toBe(2);
    expect(new Set(Object.values(currentState.workflows).map((item) => item.name)).size).toBe(2);
  });

  it('aborts standalone creation and logs when the project changes during path resolution', async () => {
    const previousLanguage = i18n.language;
    await i18n.changeLanguage('en-US');
    try {
      const oldWorkflows = {
        'old-workflow': { version: 1, name: 'Old project', savedAt: '2026-01-01', nodes: [], edges: [], agents: [], roles: [] },
      } as WorkflowRegistryActionState['workflows'];
      const newWorkflows = {
        'new-workflow': { version: 1, name: 'New project', savedAt: '2026-01-01', nodes: [], edges: [], agents: [], roles: [] },
      } as WorkflowRegistryActionState['workflows'];
      const addLog = vi.fn();
      const oldState = {
        workflows: oldWorkflows, activeWfId: 'old-workflow', workflowName: 'Old project',
        nodes: [], edges: [], agents: [], roles: [], variables: {}, groups: [], defaultAgentId: null,
        projectId: null, projectPath: null, selectedNodeId: null, logs: [], addLog,
      } as WorkflowRegistryActionState;
      let currentState = oldState;
      let resolvePath!: (path: string | undefined) => void;
      const resolveStandalonePath = vi.fn(() => new Promise<string | undefined>((resolve) => {
        resolvePath = resolve;
      }));
      const setState = vi.fn((patch: Partial<WorkflowRegistryActionState>) => {
        currentState = { ...currentState, ...patch };
      });
      const actions = createWorkflowRegistryActions({
        getState: () => currentState,
        setState,
        setDirtySuppressed: vi.fn(),
        cleanupWorkflow: vi.fn(),
        resolveStandalonePath,
        now: () => 1000,
        nowIso: () => '2026-01-01T00:00:00.000Z',
        createRegisteredWorkflowId: () => 'unused',
      });

      const creation = actions.newWorkflowInProject('C:/standalone');
      currentState = {
        ...currentState,
        workflows: newWorkflows,
        activeWfId: 'new-workflow',
        workflowName: 'New project',
        projectId: 'project-2',
        projectPath: 'C:/projects/project-2',
      };
      resolvePath('C:/standalone');
      const result = await creation;

      expect(oldState.workflows).toBe(oldWorkflows);
      expect(currentState.workflows).toBe(newWorkflows);
      expect(setState).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'aborted', reason: 'project-changed' });
      expect(addLog).toHaveBeenCalledOnce();
      expect(addLog).toHaveBeenCalledWith('warn', i18n.t('log.workflowRegistry.projectChanged'));
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });

  it('registers without activation and returns the generated id', () => {
    const { state, actions } = harness({ activeWfId: 'wf-active' });
    const id = actions.registerWorkflow(workflow('Registered'), { activate: false });
    expect(id).toBe('wf-registered');
    expect(state.workflows['wf-registered']?.name).toBe('Registered');
    expect(state.activeWfId).toBe('wf-active');
  });

  it('renames the active workflow through the registry owner', () => {
    const { state, actions } = harness({
      activeWfId: 'wf-1',
      workflows: { 'wf-1': { name: 'Before', nodes: [], edges: [], agents: [], roles: [] } } as never,
    });
    actions.renameWorkflow('After');
    expect(state.workflowName).toBe('After');
    expect(state.workflows['wf-1']?.name).toBe('After');
  });

  it('removes an active workflow through the registry owner and delegates cleanup', () => {
    const { state, actions, cleanupWorkflow } = harness({
      activeWfId: 'wf-1',
      workflows: {
        'wf-1': { name: 'Before', nodes: [], edges: [], agents: [], roles: [] },
        'wf-2': { name: 'After', nodes: [node('b')], edges: [], agents: [], roles: [] },
      } as never,
    });
    actions.removeWorkflow('wf-1');
    expect(cleanupWorkflow).toHaveBeenCalledWith('wf-1');
    expect(state.activeWfId).toBe('wf-2');
    expect(state.workflowName).toBe('After');
  });
});
