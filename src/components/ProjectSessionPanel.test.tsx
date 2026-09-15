import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectControlSnapshot, ProjectSession } from '../projectControl/types';
import type { MasterTurnResult } from '../projectControl/master';
import { clearProjectEventBuffer, getPendingProjectEvents } from '../projectControl/eventBuffer';
import { clearWorkerRunRuntime, getActiveWorkerRunRuntime } from '../projectControl/workerRunRuntime';

const mocks = vi.hoisted(() => {
  const session: ProjectSession = {
    version: 1 as const,
    id: 'session-1',
    projectId: 'project-1',
    status: 'clarifying' as const,
    messages: [
      {
        id: 'message-1',
        role: 'user' as const,
        content: '做一个个人记账应用',
        createdAt: '2026-08-31T03:00:00.000Z',
      },
    ],
    openQuestions: [],
    decisionIds: [],
    createdAt: '2026-08-31T03:00:00.000Z',
    updatedAt: '2026-08-31T03:00:00.000Z',
  };
  const store = {
    projectName: '记账应用',
    projectPath: 'C:/projects/project-1',
    projectDirty: true,
    agents: [{
      id: 'agent-1',
      name: '本地主控',
      protocol: 'ollama' as const,
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5:3b',
    }],
    globalAgents: [],
    defaultAgentId: 'agent-1',
    agentRouteTable: {},
    orchestrations: [] as unknown[],
    workerRuns: [] as unknown[],
    workerRunRecoveries: [] as unknown[],
    projectControl: {
      version: 1 as const,
      activeSessionId: 'session-1',
      sessions: [session],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    } as ProjectControlSnapshot,
    setProjectControl: vi.fn((snapshot) => {
      store.projectControl = snapshot;
    }),
    setOrchestrations: vi.fn((orchestrations: unknown[]) => {
      store.orchestrations = orchestrations;
    }),
    setWorkerRuns: vi.fn((workerRuns: unknown[]) => {
      store.workerRuns = workerRuns;
    }),
    setWorkerRunRecoveries: vi.fn((recoveries: unknown[]) => {
      store.workerRunRecoveries = recoveries;
    }),
    saveProject: vi.fn(async () => store.projectPath),
    registerWorkflow: vi.fn((_workflow: unknown, options?: { name?: string }) =>
      options?.name?.includes('施工') ? 'wf-construction' : 'wf-acceptance',
    ),
  };
  const viewStore = { globalMasterAgentId: null as string | null };
  return {
    session,
    store,
    viewStore,
    runMasterTurn: vi.fn(async (..._args: unknown[]): Promise<MasterTurnResult> => ({
      response: {
        kind: 'question' as const,
        reply: '我先确认同步范围。',
        questions: [{ id: 'q-sync', prompt: '第一版需要云同步吗？' }],
      },
      rawText: '',
      messages: [],
    })),
  };
});

vi.mock('../store/workflowStore', () => ({
  useWorkflowStore: Object.assign(
    (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
    { getState: () => mocks.store },
  ),
}));

vi.mock('../store/viewStore', () => ({
  useViewStore: (selector: (state: typeof mocks.viewStore) => unknown) => selector(mocks.viewStore),
}));

vi.mock('../projectControl/master', async () => {
  const actual = await vi.importActual<typeof import('../projectControl/master')>('../projectControl/master');
  return { ...actual, runMasterTurn: mocks.runMasterTurn };
});

vi.mock('../i18n/useT', () => ({
  useT: () => (key: string) => key,
}));

import ProjectSessionPanel from './ProjectSessionPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ProjectSessionPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    clearProjectEventBuffer();
    clearWorkerRunRuntime();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.runMasterTurn.mockClear();
    mocks.store.setProjectControl.mockClear();
    mocks.store.setOrchestrations.mockClear();
    mocks.store.setWorkerRuns.mockClear();
    mocks.store.setWorkerRunRecoveries.mockClear();
    mocks.store.saveProject.mockClear();
    mocks.store.registerWorkflow.mockClear();
    mocks.store.orchestrations = [];
    mocks.store.workerRuns = [];
    mocks.store.workerRunRecoveries = [];
    mocks.viewStore.globalMasterAgentId = null;
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: 'session-1',
      sessions: [mocks.session],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders the current project session and starts the first master turn', async () => {
    await act(async () => {
      root.render(
        <ProjectSessionPanel
          sessionId="session-1"
          onBackHome={vi.fn()}
          onOpenAdvanced={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(container.querySelector('.sm-beginner-session-main')).not.toBeNull();
    expect(container.textContent).toContain('记账应用');
    expect(mocks.runMasterTurn).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('第一版需要云同步吗？');
  });

  it('submits a user answer and persists the structured master response', async () => {
    await act(async () => {
      root.render(
        <ProjectSessionPanel
          sessionId="session-1"
          onBackHome={vi.fn()}
          onOpenAdvanced={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    const input = container.querySelector('textarea') as HTMLTextAreaElement;
    const setNativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setNativeValue.call(input, '先只做本地版本');
    await act(async () => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      (container.querySelector('[data-testid="beginner-session-submit"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(mocks.runMasterTurn).toHaveBeenCalledTimes(2);
    expect(mocks.runMasterTurn.mock.calls[1][0]).toMatchObject({
      userMessage: '先只做本地版本',
      session: expect.objectContaining({ id: 'session-1' }),
    });
    expect(mocks.store.setProjectControl).toHaveBeenCalled();
    expect(mocks.store.setProjectControl.mock.calls.at(-1)?.[0].sessions[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: '先只做本地版本' }),
        expect.objectContaining({ role: 'assistant', content: '我先确认同步范围。' }),
      ]),
    );
  });

  it('saves structured control facts immediately for a saved project', async () => {
    await act(async () => {
      root.render(
        <ProjectSessionPanel
          sessionId="session-1"
          onBackHome={vi.fn()}
          onOpenAdvanced={vi.fn()}
        />,
      );
      await Promise.resolve();
    });

    expect(mocks.store.saveProject).toHaveBeenCalled();
  });

  it('requires explicit user approval before advancing a draft brief', async () => {
    const brief = {
      version: 1 as const,
      id: 'brief-1',
      sessionId: 'session-1',
      briefVersion: 1,
      goal: '做一个个人记账应用',
      users: ['个人用户'],
      scope: ['记录收入和支出'],
      nonGoals: [],
      constraints: [],
      acceptanceCriteria: ['可以新增一条记录'],
      assumptions: [],
      approval: 'draft' as const,
      createdAt: '2026-08-31T03:01:00.000Z',
      updatedAt: '2026-08-31T03:01:00.000Z',
    };
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: 'session-1',
      sessions: [{
        ...mocks.session,
        status: 'brief-review',
        briefId: 'brief-1',
        messages: [
          ...mocks.session.messages,
          { id: 'message-2', role: 'assistant', content: '请确认 Brief。', createdAt: '2026-08-31T03:01:00.000Z' },
        ],
      }],
      decisions: [],
      briefs: [brief],
      architectures: [],
      issues: [],
    } as ProjectControlSnapshot;

    await act(async () => {
      root.render(
        <ProjectSessionPanel
          sessionId="session-1"
          onBackHome={vi.fn()}
          onOpenAdvanced={vi.fn()}
        />,
      );
    });

    await act(async () => {
      (container.querySelector('.sm-beginner-session-approve') as HTMLButtonElement).click();
    });

    const calls = mocks.store.setProjectControl.mock.calls as unknown as Array<[ProjectControlSnapshot]>;
    const next = calls.at(-1)?.[0];
    expect(next).toBeDefined();
    if (!next) return;
    expect(next.briefs[0]).toMatchObject({ approval: 'approved', approvedBy: 'user' });
    expect(next.sessions[0].status).toBe('architecture-review');
  });

  it('requires explicit user approval before advancing an architecture draft', async () => {
    const architecture = {
      version: 1 as const,
      id: 'architecture-1',
      sessionId: 'session-1',
      briefId: 'brief-1',
      architectureVersion: 1,
      overview: '本地优先的分层应用。',
      modules: [{
        id: 'ledger',
        name: '账本模块',
        responsibility: '管理收支',
        category: 'logic',
        scope: ['src/ledger/**'],
        dependsOn: [],
      }],
      interfaces: [],
      tasks: [],
      risks: [],
      approval: 'draft' as const,
      createdAt: '2026-08-31T03:01:00.000Z',
      updatedAt: '2026-08-31T03:01:00.000Z',
    };
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: 'session-1',
      sessions: [{
        ...mocks.session,
        status: 'architecture-review',
        briefId: 'brief-1',
        architectureId: 'architecture-1',
        messages: [
          ...mocks.session.messages,
          { id: 'message-2', role: 'assistant', content: '架构草案已准备好。', createdAt: '2026-08-31T03:01:00.000Z' },
        ],
      }],
      decisions: [],
      briefs: [],
      architectures: [architecture],
      issues: [],
    } as ProjectControlSnapshot;

    await act(async () => {
      root.render(
        <ProjectSessionPanel
          sessionId="session-1"
          onBackHome={vi.fn()}
          onOpenAdvanced={vi.fn()}
        />,
      );
    });

    await act(async () => {
      (container.querySelector('[data-testid="beginner-session-approve-architecture"]') as HTMLButtonElement).click();
    });

    const calls = mocks.store.setProjectControl.mock.calls as unknown as Array<[ProjectControlSnapshot]>;
    const next = calls.at(-1)?.[0];
    expect(next).toBeDefined();
    if (!next) return;
    expect(next.architectures[0]).toMatchObject({ approval: 'approved', approvedBy: 'user' });
    expect(next.sessions[0].status).toBe('plan-review');
  });

  it('generates a task graph from approved architecture without starting execution', async () => {
    const architecture = {
      version: 1 as const,
      id: 'architecture-1',
      sessionId: 'session-1',
      briefId: 'brief-1',
      architectureVersion: 1,
      overview: '本地优先的分层应用。',
      modules: [{
        id: 'ledger',
        name: '账本模块',
        responsibility: '管理收支',
        category: 'logic',
        scope: ['src/ledger/**'],
        dependsOn: [],
      }],
      interfaces: [],
      tasks: [{
        id: 'ledger-model',
        title: '实现模型',
        description: '实现收支模型',
        moduleId: 'ledger',
        scope: ['src/ledger/model.ts'],
        dependsOn: [],
        acceptanceCriteria: ['模型可用'],
        category: 'logic',
      }],
      risks: [],
      approval: 'approved' as const,
      approvedBy: 'user',
      approvedAt: '2026-08-31T03:02:00.000Z',
      createdAt: '2026-08-31T03:01:00.000Z',
      updatedAt: '2026-08-31T03:02:00.000Z',
    };
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: 'session-1',
      sessions: [{
        ...mocks.session,
        status: 'plan-review',
        briefId: 'brief-1',
        architectureId: 'architecture-1',
        messages: [
          ...mocks.session.messages,
          { id: 'message-2', role: 'assistant', content: '架构已确认。', createdAt: '2026-08-31T03:02:00.000Z' },
        ],
      }],
      decisions: [],
      briefs: [],
      architectures: [architecture],
      issues: [],
    } as ProjectControlSnapshot;

    await act(async () => {
      root.render(
        <ProjectSessionPanel
          sessionId="session-1"
          onBackHome={vi.fn()}
          onOpenAdvanced={vi.fn()}
        />,
      );
    });

    await act(async () => {
      (container.querySelector('[data-testid="beginner-session-generate-task-graph"]') as HTMLButtonElement).click();
    });

    const calls = mocks.store.setProjectControl.mock.calls as unknown as Array<[ProjectControlSnapshot]>;
    const next = calls.at(-1)?.[0];
    expect(next).toBeDefined();
    if (!next) return;
    expect(next.taskGraphs?.[0]).toMatchObject({
      architectureId: 'architecture-1',
      approval: 'draft',
      tasks: [expect.objectContaining({ id: 'ledger-model', status: 'proposed' })],
    });
    expect(next.sessions[0].taskGraphId).toBe(next.taskGraphs?.[0].id);
    expect(next.sessions[0].status).toBe('plan-review');
  });

  it('creates an orchestration draft from an approved task graph without running it', async () => {
    const taskGraph = {
      version: 1 as const,
      id: 'task-graph-1',
      sessionId: 'session-1',
      architectureId: 'architecture-1',
      graphVersion: 1,
      tasks: [{
        version: 1 as const,
        id: 'ledger-model',
        architectureId: 'architecture-1',
        title: '实现模型',
        description: '实现收支模型',
        moduleId: 'ledger',
        scope: ['src/ledger/model.ts'],
        dependsOn: [],
        acceptanceCriteria: ['模型可用'],
        category: 'logic',
        status: 'approved' as const,
        createdAt: '2026-08-31T03:01:00.000Z',
        updatedAt: '2026-08-31T03:02:00.000Z',
      }],
      approval: 'approved' as const,
      approvedBy: 'user',
      approvedAt: '2026-08-31T03:02:00.000Z',
      createdAt: '2026-08-31T03:01:00.000Z',
      updatedAt: '2026-08-31T03:02:00.000Z',
    };
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: 'session-1',
      sessions: [{
        ...mocks.session,
        status: 'ready',
        taskGraphId: 'task-graph-1',
        messages: [
          ...mocks.session.messages,
          { id: 'message-2', role: 'assistant', content: '任务图已确认。', createdAt: '2026-08-31T03:02:00.000Z' },
        ],
      }],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
      taskGraphs: [taskGraph],
    } as ProjectControlSnapshot;

    await act(async () => {
      root.render(
        <ProjectSessionPanel
          sessionId="session-1"
          onBackHome={vi.fn()}
          onOpenAdvanced={vi.fn()}
        />,
      );
    });

    await act(async () => {
      (container.querySelector('[data-testid="beginner-session-generate-orchestration"]') as HTMLButtonElement).click();
    });

    expect(mocks.runMasterTurn).not.toHaveBeenCalled();
    expect(mocks.store.setOrchestrations).toHaveBeenCalledTimes(1);
    const orchestrationCalls = mocks.store.setOrchestrations.mock.calls as unknown as Array<[Array<{ draft?: { stages: unknown[] } }>]>;
    expect(orchestrationCalls[0][0][0].draft?.stages).toHaveLength(2);
    const pendingEvents = getPendingProjectEvents('project-1');
    expect(pendingEvents).toHaveLength(2);
    expect(pendingEvents.some((event) => event.eventType === 'ExecutionDraftCreated' && event.actor === 'runtime')).toBe(true);
    expect(pendingEvents.some((event) => event.eventType === 'SessionOrchestrationLinked')).toBe(true);
    const controlCalls = mocks.store.setProjectControl.mock.calls as unknown as Array<[ProjectControlSnapshot]>;
    const next = controlCalls.at(-1)?.[0];
    expect(next?.sessions[0].orchestrationId).toBeDefined();
  });

  it('confirms an awaiting execution plan and hands the queued Run to the outer runner', async () => {
    const onRunWorker = vi.fn();
    mocks.store.orchestrations = [{
      id: 'orch-1',
      goal: '目标',
      status: 'awaiting-confirm',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      draft: { stages: [], edges: [] },
      stageLogs: [],
      runIds: [],
    }];
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: 'session-1',
      sessions: [{
        ...mocks.session,
        status: 'ready',
        taskGraphId: 'task-graph-1',
        orchestrationId: 'orch-1',
      }],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
      taskGraphs: [{
        version: 1,
        id: 'task-graph-1',
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
      }],
    };

    await act(async () => {
      root.render(
        <ProjectSessionPanel
          sessionId="session-1"
          onBackHome={vi.fn()}
          onOpenAdvanced={vi.fn()}
          onRunWorker={onRunWorker}
        />,
      );
    });

    const confirmButton = container.querySelector('[data-testid="beginner-session-confirm-execution-plan"]') as HTMLButtonElement;
    expect(confirmButton).not.toBeNull();
    await act(async () => {
      confirmButton.click();
    });

    const orchestrationCalls = mocks.store.setOrchestrations.mock.calls as unknown as Array<[Array<{ id: string; status: string }>]>;
    expect(orchestrationCalls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ id: 'orch-1', status: 'ready' }),
    ]);
    const pendingEvents = getPendingProjectEvents('project-1');
    expect(pendingEvents).toHaveLength(3);
    expect(pendingEvents.some((event) => event.eventType === 'ExecutionDraftApproved' && event.actor === 'user')).toBe(true);
    expect(pendingEvents.some((event) => event.eventType === 'RunCreated' && event.actor === 'runtime')).toBe(true);
    expect(pendingEvents.some((event) => event.eventType === 'TaskQueued' && event.actor === 'runtime')).toBe(true);
    expect(mocks.store.setWorkerRuns).toHaveBeenCalledTimes(1);
    expect(mocks.store.workerRuns).toEqual([
      expect.objectContaining({
        orchestrationId: 'orch-1',
        taskGraphId: 'task-graph-1',
        status: 'queued',
      }),
    ]);
    expect(getActiveWorkerRunRuntime()?.queues.size).toBe(1);
    expect(onRunWorker).toHaveBeenCalledWith(expect.stringMatching(/^run-/));
  });

  it('can start a persisted queued Worker Run after the project is reopened', async () => {
    const onRunWorker = vi.fn(async () => {});
    mocks.store.orchestrations = [{
      id: 'orch-1',
      goal: '目标',
      status: 'ready',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      draft: { stages: [], edges: [] },
      stageLogs: [],
      runIds: ['run-queued'],
    }];
    mocks.store.workerRuns = [{
      version: 1,
      projectId: 'project-1',
      runId: 'run-queued',
      orchestrationId: 'orch-1',
      taskGraphId: 'task-graph-1',
      taskGraphVersion: 1,
      status: 'queued',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      tasks: {},
    }];
    mocks.store.workerRunRecoveries = [{
      runId: 'run-queued',
      projectId: 'project-1',
      reason: 'unfinished-worker-lease',
      message: '旧内存 recovery 不应遮蔽 queued Run',
    }];
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: 'session-1',
      sessions: [{ ...mocks.session, status: 'executing', orchestrationId: 'orch-1' }],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
      taskGraphs: [],
    } as ProjectControlSnapshot;

    await act(async () => {
      root.render(
        <ProjectSessionPanel
          sessionId="session-1"
          onBackHome={vi.fn()}
          onOpenAdvanced={vi.fn()}
          onRunWorker={onRunWorker}
        />,
      );
    });

    const startButton = container.querySelector('[data-testid="beginner-session-start-worker"]') as HTMLButtonElement;
    expect(startButton).not.toBeNull();
    await act(async () => {
      startButton.click();
    });
    expect(onRunWorker).toHaveBeenCalledWith('run-queued');
  });

  it('shows a failed Worker Run as the next recovery action', async () => {
    const onRecoverWorkerRun = vi.fn();
    mocks.store.orchestrations = [{
      id: 'orch-1',
      goal: '目标',
      status: 'ready',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      draft: { stages: [], edges: [] },
      stageLogs: [],
      runIds: ['run-1'],
    }];
    mocks.store.workerRuns = [{
      version: 1,
      projectId: 'project-1',
      runId: 'run-1',
      orchestrationId: 'orch-1',
      taskGraphId: 'task-graph-1',
      taskGraphVersion: 1,
      status: 'partial',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:01:00.000Z',
      tasks: {
        'task-1': {
          taskId: 'task-1',
          status: 'failed',
          attempt: 1,
          evidenceIds: [],
          error: '宿主验收失败',
          updatedAt: '2026-09-01T00:01:00.000Z',
        },
      },
    }];
    mocks.store.workerRunRecoveries = [{
      runId: 'run-1',
      projectId: 'project-1',
      reason: 'unfinished-worker-lease',
      message: '检测到未闭合 Worker lease',
    }];
    mocks.store.projectControl = {
      version: 1,
      activeSessionId: 'session-1',
      sessions: [{ ...mocks.session, status: 'executing', orchestrationId: 'orch-1', taskGraphId: 'task-graph-1' }],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
      taskGraphs: [],
    } as ProjectControlSnapshot;

    await act(async () => {
      root.render(
        <ProjectSessionPanel
          sessionId="session-1"
          onBackHome={vi.fn()}
          onOpenAdvanced={vi.fn()}
          onRecoverWorkerRun={onRecoverWorkerRun}
        />,
      );
    });

    expect(container.textContent).toContain('session.workerRun.recovery');
    expect(container.textContent).toContain('session.workerRun.recoveryHint');
    expect(container.querySelector('[data-testid="beginner-session-worker-recovery"]')).not.toBeNull();
    expect(container.textContent).toContain('session.workerRun.recovery.inspect');
    expect(container.textContent).toContain('session.workerRun.recovery.retry');
    expect(container.textContent).toContain('session.workerRun.recovery.skip');
    expect(container.querySelector('[data-testid="beginner-session-worker-retry"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="beginner-session-worker-skip"]')).not.toBeNull();
    await act(async () => {
      (container.querySelector('[data-testid="beginner-session-worker-retry"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(onRecoverWorkerRun).toHaveBeenCalledWith('run-1', 'retry', expect.any(String));
  });
});
