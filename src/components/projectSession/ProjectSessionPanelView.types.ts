import type { FormEventHandler } from 'react';
import type { useT } from '../../i18n/useT';
import type { WorkerRunQueueState } from '../../domain/workerQueue';
import type { MasterResponse } from '../../projectControl/master';
import type {
  ProjectArchitecture,
  ProjectBrief,
  ProjectControlSnapshot,
  ProjectSession,
  ProjectTaskGraph,
} from '../../projectControl/types';
import type { WorkerRecoveryAction } from '../../projectControl/workerRecoveryCapabilityProjection';
import type { WorkerRunRecovery } from '../../projectControl/workerRunRuntime';
import type { WorkerRuntime } from '../../projectControl/workerRunCoordinator';
import type { Orchestration } from '../../types/orchestration';

export type ProjectSessionViewTranslator = ReturnType<typeof useT>;

export type VisibleQuestion = {
  id: string;
  prompt: string;
  status: 'open' | 'answered' | 'deferred';
  answer?: string;
};

export type ProjectSessionPanelViewProps = {
  projectName: string | null;
  projectDirty: boolean;
  projectControl: ProjectControlSnapshot;
  session: ProjectSession;
  sessionStatusLabel: string;
  currentBrief: ProjectBrief | null;
  currentArchitecture: ProjectArchitecture | null;
  currentTaskGraph: ProjectTaskGraph | null;
  currentOrchestration: Orchestration | null;
  currentWorkerRun: WorkerRunQueueState | null;
  currentWorkerRunRecovery: WorkerRunRecovery | null;
  currentWorkerRecoveryActions: readonly WorkerRecoveryAction[];
  workerRunCopy: { title: string; hint: string } | null;
  input: string;
  onInputChange: (value: string) => void;
  busy: boolean;
  error: string | null;
  recoveryBusy: boolean;
  workerStartBusy: boolean;
  workerRuntime: WorkerRuntime;
  onWorkerRuntimeChange: (runtime: WorkerRuntime) => void;
  streamingText: string;
  localResponse: MasterResponse | null;
  visibleQuestions: VisibleQuestion[];
  localReplyVisible: boolean;
  canRunWorker: boolean;
  canRecoverWorkerRun: boolean;
  onBackHome: () => void;
  onOpenAdvanced: () => void;
  onOpenIssues?: () => void;
  onOpenMasterAgent?: () => void;
  onStartQueuedWorker: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onWorkerRecovery: (decision: WorkerRecoveryAction) => void;
  onApproveBrief: () => void;
  onGenerateArchitecture: () => void;
  onApproveArchitecture: () => void;
  onGenerateTaskGraph: () => void;
  onApproveTaskGraph: () => void;
  onCreateOrchestration: () => void;
  onConfirmExecutionPlan: () => void;
};
