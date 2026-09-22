/**
 * executionCoordinator.ts — run lifecycle and fencing boundary.
 *
 * This module owns only in-memory execution identity: per-workflow run
 * generations, admission, cancellation, force takeover, and stale completion
 * fencing. Store/UI updates, runtime side effects, and persistence remain in
 * the caller until their own boundaries are extracted.
 */

export interface ExecutionStartOptions {
  /** Whether the control-plane/store projection still reports a live run. */
  running: boolean;
  /** Replace a live run instead of rejecting duplicate admission. */
  force: boolean;
}

export type ExecutionStartResult =
  | {
      status: 'started';
      runId: number;
      signal: AbortSignal;
      abort: () => boolean;
      supersededRunId?: number;
    }
  | {
      status: 'rejected';
      runId: number;
      reason: 'already-running';
    };

export interface ExecutionStopResult {
  abortedRunId: number;
  currentRunId: number;
  activeRunId: number;
}

interface GenerationState {
  currentRunId: number;
  activeRunId: number;
  abortController: AbortController | null;
}

/**
 * In-memory coordinator for one application's active workflow runs.
 *
 * A run is current only when both activeRunId and currentRunId match it. A
 * stop or force takeover advances the current generation, so late async
 * completions cannot write to the new run.
 */
export class ExecutionCoordinator {
  private readonly generations = new Map<string, GenerationState>();

  private stateFor(wfId: string): GenerationState {
    let state = this.generations.get(wfId);
    if (!state) {
      state = { currentRunId: 0, activeRunId: 0, abortController: null };
      this.generations.set(wfId, state);
    }
    return state;
  }

  getCurrentRunId(wfId: string): number {
    return this.stateFor(wfId).currentRunId;
  }

  getActiveRunId(wfId: string): number {
    return this.stateFor(wfId).activeRunId;
  }

  isCurrent(wfId: string, runId: number): boolean {
    const state = this.stateFor(wfId);
    return state.currentRunId === runId && state.activeRunId === runId;
  }

  start(wfId: string, options: ExecutionStartOptions): ExecutionStartResult {
    const state = this.stateFor(wfId);
    const hasLiveGeneration = state.activeRunId === state.currentRunId;
    let supersededRunId: number | undefined;

    if (options.running && hasLiveGeneration) {
      if (!options.force) {
        return {
          status: 'rejected',
          runId: state.currentRunId,
          reason: 'already-running',
        };
      }
      supersededRunId = state.currentRunId;
      state.abortController?.abort();
      state.abortController = null;
    }

    const runId = ++state.currentRunId;
    state.activeRunId = runId;
    const abortController = new AbortController();
    state.abortController = abortController;
    return {
      status: 'started',
      runId,
      signal: abortController.signal,
      abort: () => this.abort(wfId, runId),
      supersededRunId,
    };
  }

  /** Abort the current run without advancing its generation. */
  abort(wfId: string, runId: number): boolean {
    if (!this.isCurrent(wfId, runId)) return false;
    this.stateFor(wfId).abortController?.abort();
    return true;
  }

  stop(wfId: string): ExecutionStopResult {
    const state = this.stateFor(wfId);
    state.currentRunId += 1;
    const abortedRunId = state.currentRunId - 1;
    state.abortController?.abort();
    state.abortController = null;
    state.activeRunId = state.currentRunId;
    return {
      abortedRunId,
      currentRunId: state.currentRunId,
      activeRunId: state.activeRunId,
    };
  }

  /**
   * Release the controller only for the still-current run. A stale run's
   * finally block must not clear a newer run's cancellation handle.
   */
  finish(wfId: string, runId: number): boolean {
    const current = this.isCurrent(wfId, runId);
    if (current) this.stateFor(wfId).abortController = null;
    return current;
  }
}
