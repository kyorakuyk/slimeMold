import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyProjectControlSnapshot } from '../projectControl/persistence';
import { createProjectSession } from '../projectControl/state';
import { clearProjectEventBuffer, getPendingProjectEvents, recordProjectEvents } from '../projectControl/eventBuffer';
import { clearWorkerRunRuntime, getActiveWorkerRunRuntime } from '../projectControl/workerRunRuntime';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import { useWorkflowStore } from './workflowStore';

const session = createProjectSession({
  id: 'session-1',
  projectId: 'project-1',
  goal: '旧项目目标',
  now: '2026-08-31T03:00:00.000Z',
});

beforeEach(() => {
  clearProjectEventBuffer();
  clearWorkerRunRuntime();
  useWorkflowStore.setState({
    projectName: '旧项目',
    projectId: 'project-1',
    workerRunRecoveries: [],
    projectControl: {
      version: 1,
      activeSessionId: session.id,
      sessions: [session],
      decisions: [],
      briefs: [],
    },
  } as never);
});

describe('workflowStore project control lifecycle', () => {
  it('normalizes project control snapshots at the store boundary', () => {
    useWorkflowStore.getState().setProjectControl({
      version: 1,
      activeSessionId: 'missing',
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    });

    expect(useWorkflowStore.getState().projectControl.activeSessionId).toBeNull();
  });

  it('clears project control state when closing a project', () => {
    useWorkflowStore.getState().closeProject();

    expect(useWorkflowStore.getState().projectControl).toEqual(
      createEmptyProjectControlSnapshot(),
    );
  });

  it('clears pending domain events when closing the project', () => {
    recordProjectEvents('project-1', [{
      eventId: 'project-created',
      streamId: 'project-1',
      sequence: 1,
      aggregateType: 'Project',
      aggregateId: 'project-1',
      aggregateVersion: 1,
      eventType: 'ProjectCreated',
      schemaVersion: 1,
      payload: {},
      actor: 'user',
      occurredAt: '2026-09-01T00:00:00.000Z',
    }]);

    useWorkflowStore.getState().closeProject();

    expect(getPendingProjectEvents('project-1')).toEqual([]);
  });

  it('stores a worker run registry entry for project persistence', () => {
    const workerRun: WorkerRunQueueState = {
      version: 1,
      projectId: 'project-1',
      runId: 'run-1',
      orchestrationId: 'orch-1',
      taskGraphId: 'graph-1',
      taskGraphVersion: 1,
      status: 'queued',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      tasks: {},
    };
    useWorkflowStore.getState().setWorkerRuns([workerRun]);
    expect(useWorkflowStore.getState().workerRuns).toEqual([workerRun]);
    useWorkflowStore.getState().setWorkerRuns([]);
  });

  it('rehydrates queued worker runs when opening a project', () => {
    const taskGraph = {
      version: 1,
      id: 'graph-1',
      sessionId: 'session-1',
      architectureId: 'architecture-1',
      graphVersion: 1,
      tasks: [{
        version: 1,
        id: 'task-1',
        architectureId: 'architecture-1',
        title: '实现任务',
        description: '完成实现',
        moduleId: 'module-1',
        scope: ['src'],
        dependsOn: [],
        acceptanceCriteria: ['测试通过'],
        category: 'implementation',
        status: 'approved',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
      }],
      approval: 'approved',
      approvedBy: 'user',
      approvedAt: '2026-09-01T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    const workerRun: WorkerRunQueueState = {
      version: 1,
      projectId: 'project-1',
      runId: 'run-1',
      orchestrationId: 'orch-1',
      taskGraphId: 'graph-1',
      taskGraphVersion: 1,
      status: 'queued',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      tasks: {
        'task-1': {
          taskId: 'task-1',
          status: 'queued',
          attempt: 0,
          evidenceIds: [],
          updatedAt: '2026-09-01T00:00:00.000Z',
        },
      },
    };
    const opened = useWorkflowStore.getState().openProject({
      version: 1,
      kind: 'project',
      id: 'project-1',
      name: '项目',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      activeId: 'wf-1',
      workflows: { 'wf-1': { version: 1, name: '工作流', nodes: [], edges: [], agents: [], roles: [] } },
      projectControl: {
        version: 1,
        activeSessionId: null,
        sessions: [],
        decisions: [],
        briefs: [],
        architectures: [],
        issues: [],
        taskGraphs: [taskGraph],
      },
      workerRuns: [workerRun],
    } as never, 'C:/projects/project-1');

    expect(opened).toBe(true);
    expect(getActiveWorkerRunRuntime()?.projectId).toBe('project-1');
    expect(getActiveWorkerRunRuntime()?.queues.get('run-1')?.runnableTaskIds()).toEqual(['task-1']);

    const runningWorkerRun = {
      ...workerRun,
      status: 'running',
      tasks: {
        'task-1': {
          ...workerRun.tasks['task-1'],
          status: 'running',
          attempt: 1,
          worktreeId: 'worktree-1',
          worktreePath: 'C:/projects/project-1-workers/run-1-task-1-a1',
          baseRevision: 'base-1',
        },
      },
    };
    const reopened = useWorkflowStore.getState().openProject({
      version: 1,
      kind: 'project',
      id: 'project-1',
      name: '项目',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      activeId: 'wf-1',
      workflows: { 'wf-1': { version: 1, name: '工作流', nodes: [], edges: [], agents: [], roles: [] } },
      projectControl: {
        version: 1,
        activeSessionId: null,
        sessions: [],
        decisions: [],
        briefs: [],
        architectures: [],
        issues: [],
        taskGraphs: [taskGraph],
      },
      workerRuns: [runningWorkerRun],
    } as never, 'C:/projects/project-1');

    expect(reopened).toBe(true);
    expect(useWorkflowStore.getState().workerRunRecoveries).toEqual([
      expect.objectContaining({ runId: 'run-1', reason: 'unfinished-worker-lease' }),
    ]);
    expect(getActiveWorkerRunRuntime()?.queues.size).toBe(0);
  });
});
