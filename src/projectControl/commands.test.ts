import { describe, expect, it } from 'vitest';
import {
  applyMasterTurnCommand,
  approveArchitectureCommand,
  approveBriefCommand,
  approveTaskGraphCommand,
  linkOrchestrationCommand,
  generateTaskGraphCommand,
  reviseTaskGraphCommand,
  startProjectSessionCommand,
  transitionIssueCommand,
} from './commands';
import type { ProjectControlSnapshot } from './types';
import { parseProjectControlSnapshot, serializeProjectControlSnapshot } from './persistence';
import { buildTaskGraphProjection, taskIssueId } from './taskGraphProjection';

function architectureSnapshot(approval: 'draft' | 'approved' = 'draft'): ProjectControlSnapshot {
  return {
    version: 1,
    activeSessionId: 'session-1',
    sessions: [{
      version: 1,
      id: 'session-1',
      projectId: 'project-1',
      status: approval === 'draft' ? 'architecture-review' : 'plan-review',
      messages: [],
      openQuestions: [],
      decisionIds: [],
      architectureId: 'architecture-1',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }],
    decisions: [],
    briefs: [],
    architectures: [{
      version: 1,
      id: 'architecture-1',
      sessionId: 'session-1',
      briefId: 'brief-1',
      architectureVersion: 1,
      overview: '分层架构',
      modules: [],
      interfaces: [],
      tasks: [{
        id: 'task-1',
        title: '实现任务',
        description: '实现最小功能',
        moduleId: 'core',
        scope: ['src/core.ts'],
        dependsOn: [],
        acceptanceCriteria: ['测试通过'],
        category: 'logic',
      }],
      risks: [],
      approval,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    }],
    issues: [],
  };
}

describe('startProjectSessionCommand', () => {
  it('creates one project session, one source issue, and ordered domain events', () => {
    const result = startProjectSessionCommand({
      projectId: 'project-1',
      sessionId: 'session-1',
      issueId: 'issue-1',
      projectName: '个人记账应用',
      goal: '做一个个人记账应用，先支持本地版本',
      now: '2026-09-01T00:00:00.000Z',
    });

    expect(result.snapshot).toMatchObject({
      version: 1,
      activeSessionId: 'session-1',
      sessions: [expect.objectContaining({
        id: 'session-1',
        projectId: 'project-1',
        status: 'clarifying',
      })],
      issues: [expect.objectContaining({
        id: 'issue-1',
        projectId: 'project-1',
        type: 'feature',
        status: 'inbox',
        sourceSessionId: 'session-1',
        title: '个人记账应用',
      })],
    });
    expect(result.events.map((event) => event.eventType)).toEqual([
      'ProjectCreated',
      'SessionStarted',
      'IssueCreated',
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(result.events.every((event) => event.actor === 'user' && event.correlationId === 'session-1')).toBe(true);
  });

  it('routes Issue status changes through one command and auditable fact', () => {
    const started = startProjectSessionCommand({
      projectId: 'project-1',
      sessionId: 'session-1',
      issueId: 'issue-1',
      projectName: '项目',
      goal: '目标',
      now: '2026-09-01T00:00:00.000Z',
    });
    const result = transitionIssueCommand({
      snapshot: started.snapshot,
      issueId: 'issue-1',
      status: 'triaging',
      now: '2026-09-01T00:01:00.000Z',
    });

    expect(result.snapshot.issues[0].status).toBe('triaging');
    expect(result.events).toEqual([expect.objectContaining({
      eventType: 'IssueStatusChanged',
      aggregateId: 'issue-1',
      payload: expect.objectContaining({ from: 'inbox', to: 'triaging', issueId: 'issue-1' }),
    })]);
    const unassigned = transitionIssueCommand({
      snapshot: {
        ...started.snapshot,
        issues: started.snapshot.issues.map((issue) => ({ ...issue, projectId: null })),
      },
      projectId: 'project-1',
      issueId: 'issue-1',
      status: 'triaging',
      now: '2026-09-01T00:02:00.000Z',
    });
    expect(unassigned.events[0].streamId).toBe('project-1');
  });
  it('rejects an empty goal before creating any state or event', () => {
    expect(() => startProjectSessionCommand({
      projectId: 'project-1',
      sessionId: 'session-1',
      issueId: 'issue-1',
      projectName: '项目',
      goal: '  ',
      now: '2026-09-01T00:00:00.000Z',
    })).toThrow(/目标/);
  });

  it('is deterministic for the same command identity and timestamp', () => {
    const input = {
      projectId: 'project-1',
      sessionId: 'session-1',
      issueId: 'issue-1',
      projectName: '项目',
      goal: '目标',
      now: '2026-09-01T00:00:00.000Z',
    };
    expect(startProjectSessionCommand(input)).toEqual(startProjectSessionCommand(input));
  });

  it('records user/master messages and the completed turn as ordered private facts', () => {
    const started = startProjectSessionCommand({
      projectId: 'project-1',
      sessionId: 'session-1',
      issueId: 'issue-1',
      projectName: '项目',
      goal: '目标',
      now: '2026-09-01T00:00:00.000Z',
    });
    const result = applyMasterTurnCommand({
      snapshot: started.snapshot,
      sessionId: 'session-1',
      userMessage: '只做本地版本',
      response: {
        kind: 'question',
        reply: '我先确认范围。',
        questions: [{ id: 'q-scope', prompt: '是否需要云同步？' }],
      },
      now: '2026-09-01T00:01:00.000Z',
      createId: (() => {
        let next = 1;
        return (prefix: string) => `${prefix}-2-${next++}`;
      })(),
    });

    expect(result.events.map((event) => event.eventType)).toEqual([
      'SessionMessageRecorded',
      'SessionMessageRecorded',
      'MasterTurnCompleted',
    ]);
    expect(result.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(result.events[0]).toMatchObject({ actor: 'user', sensitivity: 'private' });
    expect(result.events[1]).toMatchObject({ actor: 'master', sensitivity: 'private' });
    expect(result.events[2]).toMatchObject({
      actor: 'master',
      payload: { sessionId: 'session-1', responseKind: 'question', questionIds: ['q-scope'] },
    });
    expect(result.snapshot.sessions[0].messages).toHaveLength(3);
  });

  it('approves a draft brief through one command and advances the session', () => {
    const started = startProjectSessionCommand({
      projectId: 'project-1',
      sessionId: 'session-1',
      issueId: 'issue-1',
      projectName: '项目',
      goal: '目标',
      now: '2026-09-01T00:00:00.000Z',
    });
    let nextId = 0;
    const withBrief = applyMasterTurnCommand({
      snapshot: started.snapshot,
      sessionId: 'session-1',
      response: {
        kind: 'brief',
        reply: '请确认这份 Brief。',
        brief: {
          goal: '目标',
          users: ['用户'],
          scope: ['最小版本'],
          nonGoals: ['云同步'],
          constraints: ['本地优先'],
          acceptanceCriteria: ['可以运行'],
          assumptions: [],
        },
      },
      now: '2026-09-01T00:01:00.000Z',
      createId: (prefix) => prefix === 'brief' ? 'brief-1' : `${prefix}-${++nextId}`,
    });

    const result = approveBriefCommand({
      snapshot: withBrief.snapshot,
      sessionId: 'session-1',
      approvedBy: 'user',
      now: '2026-09-01T00:02:00.000Z',
    });

    expect(result.snapshot.briefs[0]).toMatchObject({ approval: 'approved', approvedBy: 'user' });
    expect(result.snapshot.sessions[0].status).toBe('architecture-review');
    expect(result.events.map((event) => event.eventType)).toEqual([
      'BriefApproved',
      'SessionStatusChanged',
    ]);
    expect(result.events[0]).toMatchObject({
      actor: 'user',
      source: { objectId: 'brief-1', objectVersion: 1 },
    });
  });

  it('approves a draft architecture through one command and advances to plan review', () => {
    const result = approveArchitectureCommand({
      snapshot: architectureSnapshot(),
      sessionId: 'session-1',
      approvedBy: 'user',
      now: '2026-09-01T00:02:00.000Z',
    });

    expect(result.snapshot.architectures[0]).toMatchObject({ approval: 'approved', approvedBy: 'user' });
    expect(result.snapshot.sessions[0].status).toBe('plan-review');
    expect(result.events.map((event) => event.eventType)).toEqual([
      'ArchitectureApproved',
      'SessionStatusChanged',
    ]);
  });

  it('generates a draft task graph from an approved architecture and links it to the session', () => {
    const result = generateTaskGraphCommand({
      snapshot: architectureSnapshot('approved'),
      sessionId: 'session-1',
      id: 'task-graph-1',
      now: '2026-09-01T00:03:00.000Z',
    });

    expect(result.snapshot.taskGraphs?.[0]).toMatchObject({
      id: 'task-graph-1',
      approval: 'draft',
      tasks: [expect.objectContaining({ id: 'task-1', status: 'proposed' })],
    });
    expect(result.snapshot.sessions[0].taskGraphId).toBe('task-graph-1');
    expect(result.snapshot.issues).toEqual([
      expect.objectContaining({
        id: taskIssueId('task-graph-1', 'task-1'),
        projectId: 'project-1',
        status: 'proposed',
        relatedTaskIds: ['task-1'],
      }),
    ]);
    expect(result.events.map((event) => event.eventType)).toEqual([
      'TaskGraphProposed',
      'SessionTaskGraphLinked',
      'IssueCreated',
    ]);
  });

  it('approves a task graph and makes the session ready without starting a run', () => {
    const draft = generateTaskGraphCommand({
      snapshot: architectureSnapshot('approved'),
      sessionId: 'session-1',
      id: 'task-graph-1',
      now: '2026-09-01T00:03:00.000Z',
    });
    const result = approveTaskGraphCommand({
      snapshot: draft.snapshot,
      sessionId: 'session-1',
      approvedBy: 'user',
      now: '2026-09-01T00:04:00.000Z',
    });

    expect(result.snapshot.taskGraphs?.[0]).toMatchObject({ approval: 'approved' });
    expect(result.snapshot.issues).toEqual([
      expect.objectContaining({
        id: taskIssueId('task-graph-1', 'task-1'),
        status: 'approved',
        relatedTaskIds: ['task-1'],
      }),
    ]);
    expect(result.snapshot.sessions[0].status).toBe('ready');
    expect(result.events.map((event) => event.eventType)).toEqual([
      'TaskGraphApproved',
      'SessionStatusChanged',
      'IssueStatusChanged',
    ]);
  });

  it('creates a new TaskGraph revision through a command and supersedes the old graph', () => {
    const draft = generateTaskGraphCommand({
      snapshot: architectureSnapshot('approved'),
      sessionId: 'session-1',
      id: 'task-graph-1',
      now: '2026-09-01T00:03:00.000Z',
    });
    const approved = approveTaskGraphCommand({
      snapshot: draft.snapshot,
      sessionId: 'session-1',
      approvedBy: 'user',
      now: '2026-09-01T00:04:00.000Z',
    });
    const result = reviseTaskGraphCommand({
      snapshot: approved.snapshot,
      sessionId: 'session-1',
      sourceTaskGraphId: 'task-graph-1',
      id: 'task-graph-2',
      now: '2026-09-01T00:05:00.000Z',
      changes: [{ taskId: 'task-1', title: '实现修订任务' }],
    });

    expect(result.snapshot.taskGraphs).toEqual([
      expect.objectContaining({ id: 'task-graph-1', approval: 'superseded', supersededBy: 'task-graph-2' }),
      expect.objectContaining({ id: 'task-graph-2', approval: 'draft', revisionOf: 'task-graph-1', graphVersion: 2 }),
    ]);
    expect(result.snapshot.sessions[0]).toMatchObject({ status: 'plan-review', taskGraphId: 'task-graph-2' });
    expect(result.snapshot.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: taskIssueId('task-graph-2', 'task-1'), title: '实现修订任务' }),
    ]));
    expect(result.events.map((event) => event.eventType)).toEqual([
      'TaskGraphSuperseded',
      'TaskGraphRevisionCreated',
      'SessionTaskGraphLinked',
      'IssueCreated',
    ]);
  });

  it('restores revision history and canonical Issue/DAG projection after persistence round-trip', () => {
    const draft = generateTaskGraphCommand({
      snapshot: architectureSnapshot('approved'),
      sessionId: 'session-1',
      id: 'task-graph-1',
      now: '2026-09-01T00:03:00.000Z',
    });
    const approved = approveTaskGraphCommand({
      snapshot: draft.snapshot,
      sessionId: 'session-1',
      approvedBy: 'user',
      now: '2026-09-01T00:04:00.000Z',
    });
    const revised = reviseTaskGraphCommand({
      snapshot: approved.snapshot,
      sessionId: 'session-1',
      sourceTaskGraphId: 'task-graph-1',
      id: 'task-graph-2',
      now: '2026-09-01T00:05:00.000Z',
      changes: [{ taskId: 'task-1', title: '重启后仍可追溯' }],
    });
    const restored = parseProjectControlSnapshot(serializeProjectControlSnapshot(revised.snapshot));
    const restoredGraph = restored.taskGraphs?.find((graph) => graph.id === 'task-graph-2');
    expect(restored.taskGraphs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task-graph-1', approval: 'superseded' }),
      expect.objectContaining({ id: 'task-graph-2', revisionOf: 'task-graph-1' }),
    ]));
    expect(restoredGraph).toBeDefined();
    const projection = buildTaskGraphProjection({
      graph: restoredGraph!,
      issues: restored.issues,
      execution: { lastSequence: 0, runs: {}, tasks: {}, taskExecutions: {}, attempts: {} },
    });
    expect(projection.graphId).toBe('task-graph-2');
    expect(projection.nodes[0]).toMatchObject({
      taskId: 'task-1',
      issueId: taskIssueId('task-graph-2', 'task-1'),
      title: '重启后仍可追溯',
    });
  });

  it('links an execution orchestration to the session without starting it', () => {
    const result = linkOrchestrationCommand({
      snapshot: architectureSnapshot('approved'),
      sessionId: 'session-1',
      orchestrationId: 'orch-1',
      now: '2026-09-01T00:05:00.000Z',
    });

    expect(result.snapshot.sessions[0]).toMatchObject({
      status: 'ready',
      orchestrationId: 'orch-1',
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      eventType: 'SessionOrchestrationLinked',
      actor: 'runtime',
      payload: { sessionId: 'session-1', orchestrationId: 'orch-1' },
    });
  });
});
