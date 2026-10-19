import type { Dispatch, SetStateAction } from 'react';
import type { DomainEvent } from '../../domain/contracts';
import {
  approveArchitectureCommand,
  approveBriefCommand,
  approveTaskGraphCommand,
  generateTaskGraphCommand,
} from '../../projectControl/commands';
import type { MasterResponse } from '../../projectControl/master';
import type { ProjectControlSnapshot, ProjectSession } from '../../projectControl/types';
import { useWorkflowStore } from '../../store/workflowStore';

type UseProjectSessionPlanningActionsOptions = {
  sessionId: string;
  createId: (prefix: string) => string;
  findSession: (snapshot: ProjectControlSnapshot, sessionId: string) => ProjectSession | null;
  persistControlMutation: (
    projectId: string,
    snapshot: ProjectControlSnapshot,
    events: readonly DomainEvent[],
  ) => Promise<void>;
  setError: Dispatch<SetStateAction<string | null>>;
  setLocalResponse: Dispatch<SetStateAction<MasterResponse | null>>;
};

export default function useProjectSessionPlanningActions({
  sessionId,
  createId,
  findSession,
  persistControlMutation,
  setError,
  setLocalResponse,
}: UseProjectSessionPlanningActionsOptions) {
  const handleApproveBrief = async () => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    const briefId = currentSession?.briefId;
    const brief = briefId ? snapshot.briefs.find((item) => item.id === briefId) : undefined;
    if (!currentSession || !brief) return;
    try {
      const now = new Date().toISOString();
      const next = approveBriefCommand({
        snapshot,
        sessionId,
        approvedBy: 'user',
        now,
      });
      await persistControlMutation(currentSession.projectId, next.snapshot, next.events);
      setLocalResponse(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleApproveArchitecture = async () => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    const architectureId = currentSession?.architectureId;
    const architecture = architectureId
      ? snapshot.architectures.find((item) => item.id === architectureId)
      : undefined;
    if (!currentSession || !architecture) return;
    try {
      const now = new Date().toISOString();
      const next = approveArchitectureCommand({
        snapshot,
        sessionId,
        approvedBy: 'user',
        now,
      });
      await persistControlMutation(currentSession.projectId, next.snapshot, next.events);
      setLocalResponse(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleGenerateTaskGraph = async () => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    const architectureId = currentSession?.architectureId;
    const architecture = architectureId
      ? snapshot.architectures.find((item) => item.id === architectureId)
      : undefined;
    if (!currentSession || !architecture || architecture.approval !== 'approved' || currentSession.taskGraphId) return;
    try {
      const now = new Date().toISOString();
      const next = generateTaskGraphCommand({
        snapshot,
        sessionId,
        id: createId('task-graph'),
        now,
      });
      await persistControlMutation(currentSession.projectId, next.snapshot, next.events);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleApproveTaskGraph = async () => {
    const state = useWorkflowStore.getState();
    const snapshot = state.projectControl;
    const currentSession = findSession(snapshot, sessionId);
    const taskGraphId = currentSession?.taskGraphId;
    const graph = taskGraphId
      ? snapshot.taskGraphs?.find((item) => item.id === taskGraphId)
      : undefined;
    if (!currentSession || !graph) return;
    try {
      const now = new Date().toISOString();
      const next = approveTaskGraphCommand({
        snapshot,
        sessionId,
        approvedBy: 'user',
        now,
      });
      await persistControlMutation(currentSession.projectId, next.snapshot, next.events);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return {
    handleApproveBrief,
    handleApproveArchitecture,
    handleGenerateTaskGraph,
    handleApproveTaskGraph,
  };
}
