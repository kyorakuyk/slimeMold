import { useEffect, useState } from 'react';
import { useWorkflowStore } from '../store/workflowStore';
import type { WorkerRuntime } from '../projectControl/workerRunCoordinator';
import WorkspaceHome from './beginner/WorkspaceHome';
import ProjectCockpit from './beginner/ProjectCockpit';
import ProjectSessionPanel from './ProjectSessionPanel';
import IssueBoard from './IssueBoard';
import MasterAgentPage from './MasterAgentPage';

interface BeginnerExperienceProps {
  onOpenAdvanced: () => void;
  onNewProject: () => void;
  onStartProjectSession: (goal: string) => void;
  onRunWorker?: (runId: string, runtime?: 'codex' | 'antigravity') => Promise<void> | void;
  onRecoverWorkerRun?: (runId: string, decision: 'retry' | 'skip', reason: string, runtime?: WorkerRuntime) => Promise<void> | void;
}

type BeginnerPage = 'home' | 'project' | 'session' | 'issues' | 'master-agent';

export default function BeginnerExperience({ onOpenAdvanced, onNewProject, onStartProjectSession, onRunWorker, onRecoverWorkerRun }: BeginnerExperienceProps) {
  const projectId = useWorkflowStore((s) => s.projectId);
  const activeSessionId = useWorkflowStore((s) => s.projectControl?.activeSessionId ?? null);
  const [page, setPage] = useState<BeginnerPage>(() =>
    projectId ? (activeSessionId ? 'session' : 'project') : 'home',
  );

  useEffect(() => {
    setPage(projectId ? (activeSessionId ? 'session' : 'project') : 'home');
  }, [projectId, activeSessionId]);

  if (page === 'session' && projectId && activeSessionId) {
    return (
      <ProjectSessionPanel
        sessionId={activeSessionId}
        onOpenAdvanced={onOpenAdvanced}
        onOpenIssues={() => setPage('issues')}
        onOpenMasterAgent={() => setPage('master-agent')}
        onBackHome={() => setPage('project')}
        onRunWorker={onRunWorker}
        onRecoverWorkerRun={onRecoverWorkerRun}
      />
    );
  }

  if (page === 'master-agent' && projectId) {
    return (
      <MasterAgentPage
        onBack={() => setPage(activeSessionId ? 'session' : 'project')}
        onOpenAdvanced={onOpenAdvanced}
      />
    );
  }

  if (page === 'issues' && projectId) {
    return (
      <IssueBoard
        onOpenAdvanced={onOpenAdvanced}
        onBack={() => setPage(activeSessionId ? 'session' : 'project')}
      />
    );
  }

  if (page === 'project' && projectId) {
    return (
      <ProjectCockpit
        onOpenAdvanced={onOpenAdvanced}
        onOpenIssues={() => setPage('issues')}
        onOpenMasterAgent={() => setPage('master-agent')}
        onBackHome={() => setPage('home')}
      />
    );
  }

  return (
    <WorkspaceHome
      onNewProject={onNewProject}
      onStartProjectSession={onStartProjectSession}
      onProjectOpened={() => setPage(activeSessionId ? 'session' : 'project')}
    />
  );
}
