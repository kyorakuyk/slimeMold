import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectControlSnapshot, ProjectIssue } from '../projectControl/types';

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
    relatedTaskIds: [],
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
    setProjectControl: vi.fn((snapshot: ProjectControlSnapshot) => {
      store.projectControl = snapshot;
    }),
  };
  return { store, inbox, unassigned };
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
});
