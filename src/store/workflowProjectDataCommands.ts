import type { LogEntry } from '../types/execution';
import type { AssetMeta } from '../types/project';
import type { FlowNode } from '../types/graph';

export interface WorkflowProjectDataShape {
  activeWfId: string;
  workflows: Record<string, { name: string; nodes: FlowNode[]; assets?: AssetMeta[] }>;
  projectAssets: AssetMeta[];
  projectVariables: Record<string, unknown>;
}

export interface WorkflowProjectDataCommands {
  addAsset: (meta: AssetMeta) => void;
  removeAsset: (assetId: string) => void;
  addProjectAsset: (meta: AssetMeta) => void;
  removeProjectAsset: (assetId: string) => string[];
  setProjectVariable: (key: string, value: unknown) => void;
  removeProjectVariable: (key: string) => void;
}

export interface WorkflowProjectDataCommandDeps<State extends WorkflowProjectDataShape> {
  getState: () => State;
  setState: (patch: Partial<State>) => void;
  addLog: (level: LogEntry['level'], message: string) => void;
  removeFile: (path: string) => Promise<void>;
}

export function createWorkflowProjectDataCommands<State extends WorkflowProjectDataShape>(
  deps: WorkflowProjectDataCommandDeps<State>,
): WorkflowProjectDataCommands {
  const { getState, setState, addLog, removeFile } = deps;

  const removePersistedFile = (path: string, scope: '资产' | '项目资产') => {
    void (async () => {
      try {
        await removeFile(path);
        addLog('info', `已删除${scope}文件：${path}`);
      } catch (err) {
        addLog(
          'warn',
          `删除${scope}文件失败（记录已移除）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  };

  return {
    addAsset: (meta) => {
      const state = getState();
      if (!state.activeWfId) return;
      const workflow = state.workflows[state.activeWfId];
      if (!workflow) return;
      const assets = [...(workflow.assets ?? []), meta];
      setState({
        workflows: {
          ...state.workflows,
          [state.activeWfId]: { ...workflow, assets },
        },
      } as unknown as Partial<State>);
    },

    removeAsset: (assetId) => {
      const state = getState();
      if (!state.activeWfId) return;
      const workflow = state.workflows[state.activeWfId];
      if (!workflow?.assets) return;
      const target = workflow.assets.find((asset) => asset.id === assetId);
      setState({
        workflows: {
          ...state.workflows,
          [state.activeWfId]: {
            ...workflow,
            assets: workflow.assets.filter((asset) => asset.id !== assetId),
          },
        },
      } as unknown as Partial<State>);
      if (target?.path) removePersistedFile(target.path, '资产');
    },

    addProjectAsset: (meta) => {
      const state = getState();
      const exists = state.projectAssets.some((asset) => asset.id === meta.id);
      setState({
        projectAssets: exists
          ? state.projectAssets.map((asset) => (asset.id === meta.id ? meta : asset))
          : [...state.projectAssets, meta],
      } as unknown as Partial<State>);
    },

    removeProjectAsset: (assetId) => {
      const state = getState();
      const target = state.projectAssets.find((asset) => asset.id === assetId);
      const refs: string[] = [];
      const idToken = `{{asset:${assetId}}}`;
      for (const id of Object.keys(state.workflows)) {
        const workflow = state.workflows[id];
        const hit = (workflow.nodes ?? []).some((node) =>
          Object.values(node.data.params ?? {}).some((value) => {
            const serialized = typeof value === 'string' ? value : JSON.stringify(value);
            return (serialized as string).includes(idToken)
              || (typeof value === 'object' && value !== null && (value as { assetId?: string }).assetId === assetId);
          }),
        );
        if (hit) refs.push(workflow.name);
      }
      setState({
        projectAssets: state.projectAssets.filter((asset) => asset.id !== assetId),
      } as unknown as Partial<State>);
      if (target?.path) removePersistedFile(target.path, '项目资产');
      return refs;
    },

    setProjectVariable: (key, value) => {
      const state = getState();
      setState({ projectVariables: { ...state.projectVariables, [key]: value } } as unknown as Partial<State>);
    },

    removeProjectVariable: (key) => {
      const state = getState();
      const next = { ...state.projectVariables };
      delete next[key];
      setState({ projectVariables: next } as unknown as Partial<State>);
    },
  };
}
