/**
 * workflowState.ts — compatibility barrel for pure store state transforms.
 *
 * New code should import the fact-owning module directly:
 * workflowRegistryState, workflowLifecycleState, or projectCatalogState.
 * This barrel remains temporarily to preserve existing direct imports.
 */
export {
  cleanupRouteTableForAgent,
  upsertById,
} from './projectCatalogState';
export {
  buildNewWorkflowInProjectState,
  buildRegisteredWorkflowState,
  buildSwitchWorkflowState,
  resolveActiveWorkflowWorkspaceDir,
} from './workflowRegistryState';
export type {
  NewWorkflowInProjectStateInput,
  RegisteredWorkflowActivation,
  RegisteredWorkflowState,
  RegisteredWorkflowStateInput,
  SwitchWorkflowState,
  WorkflowSwitchView,
} from './workflowRegistryState';
export {
  buildCreateProjectState,
  buildNewProjectState,
  buildOpenProjectState,
} from './workflowLifecycleState';
export type {
  CreateProjectState,
  CreateProjectStateInput,
  NewProjectState,
  OpenProjectState,
} from './workflowLifecycleState';
