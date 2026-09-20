/**
 * projectCreationActions.ts — async project creation choreography.
 *
 * Platform path selection, persistence, session storage and warning reporting are capabilities;
 * ProjectFile saving and host lifecycle remain owned by the facade/controllers.
 */
import type { FlowEdge, FlowNode } from '../types';
import {
  buildCreateProjectState,
  type CreateProjectState,
} from './workflowLifecycleState';
import {
  emptyProjectControlRuntimeState,
  type ProjectControlRuntimeState,
} from './projectControlLifecycle';

export interface ProjectCreationOptions {
  name: string;
  templateId?: string;
  location?: string | null;
}

export interface ProjectCreationTemplate {
  name: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface ProjectCreationIdentity {
  workflowId: string;
  projectId: string;
  createdAt: string;
}

export type ProjectCreationStatePatch =
  (Partial<CreateProjectState> & Partial<ProjectControlRuntimeState>);

export interface ProjectCreationActionDeps {
  getProjectId: () => string | null;
  resetProjectControlLifecycle: (projectId?: string | null) => void;
  getTemplate: (templateId?: string) => ProjectCreationTemplate | undefined;
  createProjectIdentity: () => ProjectCreationIdentity;
  resolveSaveRoot: (name: string, location?: string | null) => Promise<string | null>;
  setDirtySuppressed: (suppressed: boolean) => void;
  setState: (patch: ProjectCreationStatePatch) => void;
  saveProject: () => Promise<string>;
  saveLastSession: (value: { path: string; activeId: string }) => void;
  clearLastSession: () => void;
  addLog: (level: 'warn', message: string) => void;
}

export interface ProjectCreationActions {
  createProject: (options: ProjectCreationOptions) => Promise<void>;
}

export function createProjectCreationActions(
  deps: ProjectCreationActionDeps,
): ProjectCreationActions {
  const createProject = async ({ name, templateId, location }: ProjectCreationOptions): Promise<void> => {
    deps.resetProjectControlLifecycle(deps.getProjectId());
    const template = deps.getTemplate(templateId);
    const identity = deps.createProjectIdentity();
    const saveRoot = await deps.resolveSaveRoot(name, location);
    const state = buildCreateProjectState({
      name,
      projectId: identity.projectId,
      workflowId: identity.workflowId,
      createdAt: identity.createdAt,
      projectPath: saveRoot,
      template,
    });

    deps.setDirtySuppressed(true);
    deps.setState({ ...state, ...emptyProjectControlRuntimeState() });
    deps.setDirtySuppressed(false);

    if (saveRoot) {
      try {
        const root = await deps.saveProject();
        deps.saveLastSession({ path: root, activeId: identity.workflowId });
      } catch (error) {
        deps.setState({ projectPath: null, projectDirty: true });
        deps.addLog(
          'warn',
          `项目已创建但落盘失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      deps.clearLastSession();
    }
  };

  return { createProject };
}
