import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectControlSnapshot, ProjectIssue, ProjectTaskGraph } from '../projectControl/types';
import type { WorkerRunQueueState } from '../domain/workerQueue';

const mocks = vi.hoisted(() => {
  const inbox: ProjectIssue = {
    version: 1,
    id: 'issue-1',
    projectId: 'project-1',
    type: 'feature',
    status: 'approved',
    priority: 'normal',
    title: '增加导出',
    description: '支持导出 CSV',
    tags: ['export'],
    relatedArtifactIds: [],
    relatedTaskIds: ['task-1'],
    createdAt: '2026-08-31T05:00:00.000Z',
    updatedAt: '2026-08-31T05:00:00.000Z',
  };
  const unassigned: ProjectIssue = {
    ...inbox,
    id: 'issue-2',
    projectId: null,
    status: 'inbox',
    title: '未来支持同步',
  };
  const taskGraph: ProjectTaskGraph = {
    version: 1,
    id: 'graph-1',
    sessionId: 'session-1',
    architectureId: 'architecture-1',
    graphVersion: 1,
    approval: 'approved',
    createdAt: '2026-08-31T05:00:00.000Z',
    updatedAt: '2026-08-31T05:00:00.000Z',
    tasks: [{
      version: 1,
      id: 'task-1',
      issueId: 'issue-1',
      architectureId: 'architecture-1',
      title: '增加导出',
      description: '支持导出 CSV',
      moduleId: 'export',
      scope: ['src/export.ts'],
      dependsOn: [],
      acceptanceCriteria: ['导出测试通过'],
      category: 'feature',
      status: 'approved',
      createdAt: '2026-08-31T05:00:00.000Z',
      updatedAt: '2026-08-31T05:00:00.000Z',
    }],
  };
  const workerRun: WorkerRunQueueState = {
    version: 1,
    projectId: 'project-1',
    runId: 'run-1',
    orchestrationId: 'orchestration-1',
    taskGraphId: 'graph-1',
    taskGraphVersion: 1,
    status: 'running',
    createdAt: '2026-08-31T05:01:00.000Z',
    updatedAt: '2026-08-31T05:01:00.000Z',
    tasks: {
      'task-1': {
        taskId: 'task-1',
        taskExecutionId: 'task-execution:run-1:task-1',
        status: 'running',
        attempt: 1,
        currentAttemptId: 'task-execution:run-1:task-1:attempt-1',
        evidenceIds: ['evidence-1'],
        acceptanceId: 'acceptance-1',
        updatedAt: '2026-08-31T05:01:00.000Z',
      },
    },
  };
  const projectControl: ProjectControlSnapshot = {
    version: 1,
    activeSessionId: null,
    sessions: [],
    decisions: [],
    briefs: [],
    architectures: [],
    issues: [inbox, unassigned],
  };
  const store = {
    projectId: 'project-1',
    projectName: '记账应用',
    projectControl,
    workerRuns: [] as WorkerRunQueueState[],
    setProjectControl: vi.fn((snapshot: ProjectControlSnapshot) => {
      store.projectControl = snapshot;
    }),
  };
  return { store, inbox, unassigned, taskGraph, workerRun };
});

vi.mock('../store/workflowStore', () => ({
  useWorkflowStore: Object.assign(
    (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
    { getState: () => mocks.store },
  ),
}));

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

import IssueBoard from './IssueBoard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('IssueBoard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: null,
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [mocks.inbox, mocks.unassigned],
    };
    mocks.store.workerRuns = [];
    mocks.store.setProjectControl.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('groups current-project and unassigned issues into four columns', async () => {
    await act(async () => {
      root.render(<IssueBoard onBack={vi.fn()} onOpenAdvanced={vi.fn()} />);
    });

    expect(container.querySelector('.sm-beginner-issue-board')).not.toBeNull();
    expect(container.querySelectorAll('[data-issue-column]').length).toBe(4);
    expect(container.textContent).toContain('增加导出');
    expect(container.textContent).toContain('未来支持同步');
  });

  it('moves an approved issue into the queued column through the state machine', async () => {
    await act(async () => {
      root.render(<IssueBoard onBack={vi.fn()} onOpenAdvanced={vi.fn()} />);
    });

    await act(async () => {
      (container.querySelector('[data-testid="issue-queue-issue-1"]') as HTMLButtonElement).click();
    });

    const next = mocks.store.setProjectControl.mock.calls.at(-1)?.[0];
    expect(next?.issues.find((issue) => issue.id === 'issue-1')?.status).toBe('queued');
  });

  it('lets a project-owned inbox issue enter the approved queue explicitly', async () => {
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: null,
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [{ ...mocks.inbox, status: 'inbox' }, mocks.unassigned],
    };
    await act(async () => {
      root.render(<IssueBoard onBack={vi.fn()} onOpenAdvanced={vi.fn()} />);
    });

    await act(async () => {
      (container.querySelector('[data-testid="issue-approve-issue-1"]') as HTMLButtonElement).click();
    });

    const next = mocks.store.setProjectControl.mock.calls.at(-1)?.[0];
    expect(next?.issues.find((issue) => issue.id === 'issue-1')?.status).toBe('approved');
  });

  it('shows the same Task execution lineage on its Issue card', async () => {
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: null,
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [mocks.inbox, mocks.unassigned],
      taskGraphs: [mocks.taskGraph],
    };
    mocks.store.workerRuns = [mocks.workerRun];

    await act(async () => {
      root.render(<IssueBoard onBack={vi.fn()} onOpenAdvanced={vi.fn()} />);
    });

    const taskLink = container.querySelector('[data-testid="issue-task-issue-1"]');
    expect(taskLink).not.toBeNull();
    expect(taskLink?.getAttribute('data-task-status')).toBe('in_progress');
    expect(taskLink?.textContent).toContain('task-1');
    expect(taskLink?.textContent).toContain('1');
  });
});
