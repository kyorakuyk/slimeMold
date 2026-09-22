/**
 * workflowRegistryActions.ts — store-bound workflow registry commands.
 *
 * This module owns registry/canvas action choreography only. Project identity, persistence,
 * ProjectControl runtime and host lifecycle remain in workflowStore and existing controllers.
 */
import type { LogEntry } from '../types/execution';
import type { WorkflowFile } from '../types/workflow';
import {
  buildNewWorkflowInProjectState,
  buildRegisteredWorkflowState,
  buildRemoveWorkflowState,
  buildRenameWorkflowState,
  buildSwitchWorkflowState,
  type WorkflowSwitchView,
} from './workflowRegistryState';

export interface WorkflowRegistryActionState extends Omit<WorkflowSwitchView, 'activeWfId'> {
  activeWfId: string;
  projectId: string | null;
  selectedNodeId: string | null;
  logs: LogEntry[];
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
  newWorkflowInProject: (workspaceDir?: string | null) => Promise<void>;
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

  const newWorkflowInProject = async (workspaceDir?: string | null): Promise<void> => {
    const state = deps.getState();
    const inProject = !!state.projectId;
    const standalonePath = inProject
      ? undefined
      : await deps.resolveStandalonePath(workspaceDir);
    const shouldCapture = !state.activeWfId && (state.nodes.length || state.edges.length);
    const capturedWorkflowId = shouldCapture ? `wf-${deps.now()}` : state.activeWfId;
    const capturedSavedAt = shouldCapture ? deps.nowIso() : '';
    const id = `wf-${deps.now() + 1}`;
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
