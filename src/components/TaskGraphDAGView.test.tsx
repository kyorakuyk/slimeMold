import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskGraphProjection } from '../projectControl/taskGraphProjection';
import TaskGraphDAGView from './TaskGraphDAGView';

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const projection: TaskGraphProjection = {
  graphId: 'graph-1',
  graphVersion: 2,
  sessionId: 'session-1',
  architectureId: 'architecture-1',
  approval: 'approved',
  runId: 'run-1',
  nodes: [
    {
      taskId: 'task-plan',
      issueId: 'issue-plan',
      title: '生成计划',
      description: '拆分目标',
      taskStatus: 'done',
      issueStatus: 'done',
      executionStatus: 'succeeded',
      projectedStatus: 'done',
      dependsOn: [],
      evidenceIds: ['evidence-plan'],
      consistency: 'consistent',
    },
    {
      taskId: 'task-build',
      issueId: 'issue-build',
      title: '执行实现',
      description: '执行 Worker',
      taskStatus: 'in_progress',
      issueStatus: 'in_progress',
      executionStatus: 'running',
      projectedStatus: 'in_progress',
      dependsOn: ['task-plan'],
      taskExecutionId: 'task-execution:run-1:task-build',
      attemptId: 'task-execution:run-1:task-build:attempt-1',
      evidenceIds: ['evidence-build'],
      acceptanceId: 'acceptance-build',
      consistency: 'consistent',
    },
  ],
  edges: [{ fromTaskId: 'task-plan', toTaskId: 'task-build' }],
};

describe('TaskGraphDAGView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders canonical task nodes and dependency edges without creating local state', async () => {
    await act(async () => {
      root.render(<TaskGraphDAGView projection={projection} />);
    });

    expect(container.querySelector('[data-testid="taskgraph-dag-view"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="taskgraph-node-task-plan"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="taskgraph-node-task-build"]')?.getAttribute('data-task-status')).toBe('in_progress');
    expect(container.querySelector('[data-testid="taskgraph-edge-task-plan-task-build"]')).not.toBeNull();
    expect(container.textContent).toContain('issue-build');
    expect(container.textContent).toContain('acceptance-build');
  });

  it('exposes one selection callback keyed by canonical task lineage', async () => {
    const selected: string[] = [];
    await act(async () => {
      root.render(
        <TaskGraphDAGView
          projection={projection}
          selectedTaskId="task-build"
          onSelectTask={(node) => selected.push(`${node.issueId}:${node.taskId}`)}
        />,
      );
    });

    const node = container.querySelector('[data-testid="taskgraph-node-task-build"]') as HTMLElement;
    expect(node.getAttribute('aria-current')).toBe('true');
    await act(async () => {
      node.click();
    });
    expect(selected).toEqual(['issue-build:task-build']);
  });
});
