/**
 * workflowRegistryActions.ts — store-bound workflow registry commands.
 *
 * This module owns registry/canvas action choreography only. Project identity, persistence,
 * ProjectControl runtime and host lifecycle remain in workflowStore and existing controllers.
 */
import type { LogEntry } from '../types/execution';
import type { WorkflowFile } from '../types/workflow';
import i18n from '../i18n';
import {
  buildNewWorkflowInProjectState,
  buildRegisteredWorkflowState,
  buildRemoveWorkflowState,
  buildRenameWorkflowState,
  buildSwitchWorkflowState,
  type NewWorkflowInProjectResult,
  type WorkflowSwitchView,
} from './workflowRegistryState';
import { createWorkflowId } from './workflowId';

export interface WorkflowRegistryActionState extends Omit<WorkflowSwitchView, 'activeWfId'> {
  activeWfId: string;
  projectId: string | null;
  projectPath: string | null;
  selectedNodeId: string | null;
  logs: LogEntry[];
  addLog: (level: LogEntry['level'], message: string) => void;
}

export interface WorkflowRegistryActionDeps {
  getState: () => WorkflowRegistryActionState;
  setState: (patch: Partial<WorkflowRegistryActionState>) => void;
  setDirtySuppressed: (suppressed: boolean) => void;
  cleanupWorkflow: (workflowId: string) => void;
  resolveStandalonePath: (workspaceDir?: string | null) => Promise<string | undefined>;
  now: () => number;
  nowIso: () => string;
  createRegisteredWorkflowId: () => string;
}

export interface WorkflowRegistryActions {
  switchWorkflow: (id: string) => void;
  newWorkflowInProject: (workspaceDir?: string | null) => Promise<NewWorkflowInProjectResult>;
  registerWorkflow: (workflow: WorkflowFile, opts?: { activate?: boolean; name?: string }) => string;
  renameWorkflow: (name: string) => void;
  removeWorkflow: (id: string) => void;
}

export function createWorkflowRegistryActions(
  deps: WorkflowRegistryActionDeps,
): WorkflowRegistryActions {
  const switchWorkflow = (id: string): void => {
    const state = deps.getState();
    if (id === state.activeWfId) return;
    const next = buildSwitchWorkflowState(state, id);
    if (!next) return;
    deps.setDirtySuppressed(true);
    deps.setState(next);
    deps.setDirtySuppressed(false);
  };

  const newWorkflowInProject = async (workspaceDir?: string | null) => {
    const stateBeforePathResolution = deps.getState();
    const projectContextBeforePathResolution = {
      projectId: stateBeforePathResolution.projectId,
      projectPath: stateBeforePathResolution.projectPath,
    };
    const inProject = !!projectContextBeforePathResolution.projectId;
    const standalonePath = inProject
      ? undefined
      : await deps.resolveStandalonePath(workspaceDir);
    const state = deps.getState();
    if (
      !inProject && (
        state.projectId !== projectContextBeforePathResolution.projectId ||
        state.projectPath !== projectContextBeforePathResolution.projectPath
      )
    ) {
      state.addLog('warn', i18n.t('log.workflowRegistry.projectChanged'));
      return { status: 'aborted', reason: 'project-changed' } as const;
    }
    const shouldCapture = !state.activeWfId && (state.nodes.length || state.edges.length);
    const capturedWorkflowId = shouldCapture
      ? createWorkflowId(deps.now(), Object.keys(state.workflows))
      : state.activeWfId;
    const capturedSavedAt = shouldCapture ? deps.nowIso() : '';
    const id = createWorkflowId(deps.now() + 1, [
      ...Object.keys(state.workflows),
      capturedWorkflowId,
    ]);
    const result = buildNewWorkflowInProjectState({
      workflows: state.workflows,
      activeWfId: state.activeWfId,
      current: {
        workflowName: state.workflowName,
        nodes: state.nodes,
        edges: state.edges,
        agents: state.agents,
        roles: state.roles,
        variables: state.variables,
        groups: state.groups,
        defaultAgentId: state.defaultAgentId,
      },
      projectId: state.projectId,
      standalonePath,
      workflowId: id,
      capturedWorkflowId,
      capturedSavedAt,
      savedAt: deps.nowIso(),
    });
    deps.setState({ workflows: result.workflows, ...result.activation });
    return { status: 'created', workflowId: id } as const;
  };

  const registerWorkflow = (
    workflow: WorkflowFile,
    opts?: { activate?: boolean; name?: string },
  ): string => {
    const state = deps.getState();
    const id = deps.createRegisteredWorkflowId();
    const result = buildRegisteredWorkflowState({
      workflow,
      id,
      savedAt: deps.nowIso(),
      projectId: state.projectId,
      workflows: state.workflows,
      activeWfId: state.activeWfId,
      activate: opts?.activate !== false,
      name: opts?.name,
    });
    if (!result.activation) {
      deps.setState({ workflows: result.workflows });
      return id;
    }
    deps.setState({ workflows: result.workflows, ...result.activation });
    return id;
  };

  const renameWorkflow = (name: string): void => {
    const state = deps.getState();
    deps.setState({ workflowName: name });
    const renamed = buildRenameWorkflowState({
      workflows: state.workflows,
      activeWfId: state.activeWfId,
      name,
    });
    if (renamed) {
      deps.setState({ workflows: { ...state.workflows, [state.activeWfId]: renamed } });
    }
  };

  const removeWorkflow = (id: string): void => {
    const state = deps.getState();
    const result = buildRemoveWorkflowState({
      workflows: state.workflows,
      activeWfId: state.activeWfId,
      id,
    });
    if (result.cleanupWorkflowId !== null) deps.cleanupWorkflow(result.cleanupWorkflowId);
    if (result.activation) {
      deps.setState({ workflows: result.workflows, ...result.activation });
    } else {
      deps.setState({ workflows: result.workflows });
    }
  };

  return { switchWorkflow, newWorkflowInProject, registerWorkflow, renameWorkflow, removeWorkflow };
}
