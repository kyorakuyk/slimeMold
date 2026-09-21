import { applyCheckpoint, mergeCheckpointHistory, type RunCheckpoint } from '../engine/checkpoint';
import type { CostRecord } from '../types/agent';
import type { RunRecord } from '../types/execution';
import type { FlowNode } from '../types/graph';
import type { RunProgressShape, RunState } from './workflowStoreTypes';

const EMPTY_PROGRESS: RunProgressShape = {
  active: false,
  layer: 0,
  totalLayers: 0,
  round: 0,
  totalRounds: 0,
};

/**
 * Minimal state shape required by run/checkpoint actions.
 * The facade provides the full WorkflowState, while this module owns only run-state mutation.
 */
export interface WorkflowRunStateShape {
  activeWfId: string;
  runStates: Record<string, RunState>;
  running: boolean;
  runProgress: RunProgressShape;
  costLog: CostRecord[];
  runHistory: RunRecord[];
  checkpoints: Record<string, RunCheckpoint>;
  checkpointHistory: Record<string, RunCheckpoint[]>;
  nodes: FlowNode[];
  workflows: Record<string, { nodes: FlowNode[] }>;
  projectPath: string | null;
}

export interface WorkflowRunStateCommands {
  setRunning: (running: boolean, wfId?: string) => void;
  setRunProgress: (progress: Partial<RunProgressShape>, wfId?: string) => void;
  setCostLog: (log: CostRecord[]) => void;
  resetUsage: () => void;
  pushRunHistory: (record: RunRecord) => void;
  clearRunHistory: () => void;
  setCheckpoint: (checkpoint: RunCheckpoint) => void;
  persistCheckpoint: (checkpoint: RunCheckpoint) => Promise<void>;
  persistCheckpointSnapshot: (checkpoint: RunCheckpoint) => Promise<void>;
  clearCheckpoint: (wfId?: string) => void;
  restoreCheckpoint: (wfId?: string) => boolean;
}

export interface WorkflowRunStateCommandDeps<State extends WorkflowRunStateShape> {
  getState: () => State;
  setState: (patch: Partial<State>) => void;
  updateState: (updater: (state: State) => Partial<State>) => void;
  setDirtySuppressed: (suppressed: boolean) => void;
  saveCheckpointToDisk: (
    projectPath: string | null,
    checkpoints: Record<string, RunCheckpoint>,
    history: Record<string, RunCheckpoint[]>,
  ) => Promise<unknown>;
}

export function createWorkflowRunStateCommands<State extends WorkflowRunStateShape>(
  deps: WorkflowRunStateCommandDeps<State>,
): WorkflowRunStateCommands {
  const { getState, setState, updateState, setDirtySuppressed, saveCheckpointToDisk } = deps;

  return {
    setRunning: (running, wfId) => {
      const id = wfId ?? getState().activeWfId;
      updateState((state) => {
        const runStates = {
          ...state.runStates,
          [id]: { running, progress: state.runStates[id]?.progress ?? EMPTY_PROGRESS },
        };
        const patch = { runStates: runStates as State['runStates'] } as unknown as Partial<State>;
        if (id === state.activeWfId) patch.running = running;
        return patch;
      });
    },

    setRunProgress: (partial, wfId) => {
      const id = wfId ?? getState().activeWfId;
      updateState((state) => {
        const previous = state.runStates[id]?.progress ?? EMPTY_PROGRESS;
        const progress = { ...previous, ...partial };
        const runStates = {
          ...state.runStates,
          [id]: { running: state.runStates[id]?.running ?? false, progress },
        };
        const patch = { runStates: runStates as State['runStates'] } as unknown as Partial<State>;
        if (id === state.activeWfId) patch.runProgress = progress as State['runProgress'];
        return patch;
      });
    },

    setCostLog: (log) => setState({ costLog: log } as Partial<State>),
    resetUsage: () => setState({ costLog: [] } as unknown as Partial<State>),

    pushRunHistory: (record) =>
      updateState((state) => ({ runHistory: [record, ...state.runHistory].slice(0, 30) } as Partial<State>)),
    clearRunHistory: () => setState({ runHistory: [] } as unknown as Partial<State>),

    setCheckpoint: (checkpoint) => {
      setDirtySuppressed(true);
      const state = getState();
      setState({
        checkpoints: { ...state.checkpoints, [checkpoint.wfId]: checkpoint },
        checkpointHistory: {
          ...state.checkpointHistory,
          [checkpoint.wfId]: mergeCheckpointHistory(
            state.checkpointHistory[checkpoint.wfId],
            checkpoint,
          ),
        },
      } as Partial<State>);
      setDirtySuppressed(false);
    },

    persistCheckpoint: async (checkpoint) => {
      const state = getState();
      setDirtySuppressed(true);
      const checkpoints = { ...state.checkpoints, [checkpoint.wfId]: checkpoint };
      const history = {
        ...state.checkpointHistory,
        [checkpoint.wfId]: mergeCheckpointHistory(
          state.checkpointHistory[checkpoint.wfId],
          checkpoint,
        ),
      };
      setState({ checkpoints, checkpointHistory: history } as Partial<State>);
      setDirtySuppressed(false);
      await saveCheckpointToDisk(state.projectPath, checkpoints, history);
    },

    persistCheckpointSnapshot: async (checkpoint) => {
      const state = getState();
      setDirtySuppressed(true);
      const checkpoints = { ...state.checkpoints, [checkpoint.wfId]: checkpoint };
      setState({ checkpoints } as Partial<State>);
      setDirtySuppressed(false);
      await saveCheckpointToDisk(state.projectPath, checkpoints, state.checkpointHistory);
    },

    clearCheckpoint: (wfId) => {
      const id = wfId ?? getState().activeWfId;
      if (!id) return;
      const state = getState();
      const checkpoints = { ...state.checkpoints };
      delete checkpoints[id];
      const checkpointHistory = { ...state.checkpointHistory };
      delete checkpointHistory[id];
      setState({ checkpoints, checkpointHistory } as Partial<State>);
    },

    restoreCheckpoint: (wfId) => {
      const id = wfId ?? getState().activeWfId;
      if (!id) return false;
      const state = getState();
      const checkpoint = state.checkpoints[id];
      if (!checkpoint) return false;
      const nodes = id === state.activeWfId ? state.nodes : (state.workflows[id]?.nodes ?? []);
      const restored = applyCheckpoint(checkpoint, nodes);
      if (id === state.activeWfId) {
        setState({ nodes: restored } as Partial<State>);
      } else {
        setState({
          workflows: { ...state.workflows, [id]: { ...state.workflows[id]!, nodes: restored } },
        } as unknown as Partial<State>);
      }
      return true;
    },
  };
}
