/** workflowLifecycleState direct tests. */
import { describe, it, expect } from 'vitest';
import type { WorkflowFile } from '../types/workflow';
import type { ProjectFile } from '../types/projectFile';
import type { FlowEdge, FlowNode } from '../types';
import {
  buildCreateProjectState,
  buildNewProjectState,
  buildOpenProjectState,
} from './workflowLifecycleState';

const mkFlowNode = (id: string, typeId: string): FlowNode =>
  ({ id, type: 'base', position: { x: 0, y: 0 }, data: { typeId, label: id, params: {}, status: 'idle' } }) as unknown as FlowNode;
const mkWf = (name: string): WorkflowFile =>
  ({
    version: 1,
    name,
    savedAt: '',
    nodes: [{ id: 'a', typeId: 'input.text', label: 'A', position: { x: 0, y: 0 }, params: {} }],
    edges: [],
    agents: [],
    roles: [],
  }) as unknown as WorkflowFile;
const mkProject = (): ProjectFile =>
  ({
    version: 1,
    kind: 'project',
    id: 'p1',
    name: '项目',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    activeId: 'wf1',
    workflows: { wf1: mkWf('工作流1') },
  }) as unknown as ProjectFile;

describe('buildOpenProjectState 项目装载状态构建', () => {
  it('基础字段：项目元信息 + 激活工作流还原到画布', () => {
    const st = buildOpenProjectState(mkProject(), '/path/p1', null);
    expect(st.projectName).toBe('项目');
    expect(st.projectId).toBe('p1');
    expect(st.projectPath).toBe('/path/p1');
    expect(st.activeWfId).toBe('wf1');
    expect(st.workflowName).toBe('工作流1');
    // 工作流还原到画布（nodes/edges）
    expect(st.nodes).toHaveLength(1);
    expect(st.edges).toHaveLength(0);
    expect(st.selectedNodeId).toBeNull();
  });

  it('恢复项目级 orchestrations，保留阶段日志和绑定关系', () => {
    const orchestration = {
      id: 'orch-1',
      goal: '完成项目',
      status: 'failed',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      draft: { stages: [], edges: [] },
      stageLogs: [{ stageId: 'plan', status: 'failed', wfId: 'wf1', runId: 7 }],
      stageWfIds: { plan: 'wf1' },
      runIds: [7],
    };
    const project = {
      ...mkProject(),
      orchestrations: [orchestration],
      projectControl: {
        version: 1,
        activeSessionId: null,
        masterAgentId: null,
        sessions: [],
        decisions: [],
        briefs: [],
        architectures: [],
        issues: [],
      },
    } as ProjectFile;
    const st = buildOpenProjectState(project, '/path/p1', null) as unknown as typeof project & {
      orchestrations?: unknown[];
      projectControl?: unknown;
    };
    expect(st.orchestrations).toEqual([orchestration]);
    expect(st.projectControl).toEqual(project.projectControl);
  });

  it('恢复项目级 workerRuns，保留 queued 状态供继续执行', () => {
    const workerRun = {
      version: 1,
      projectId: 'p1',
      runId: 'run-1',
      orchestrationId: 'orch-1',
      taskGraphId: 'graph-1',
      taskGraphVersion: 1,
      status: 'queued',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      tasks: {
        'task-1': {
          taskId: 'task-1',
          status: 'queued',
          attempt: 0,
          evidenceIds: [],
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    const project = { ...mkProject(), workerRuns: [workerRun] } as ProjectFile;
    const st = buildOpenProjectState(project, '/path/p1', null);
    expect(st.workerRuns).toEqual([workerRun]);
  });

  it('workerRuns 损坏时安全降级为空 registry', () => {
    const project = { ...mkProject(), workerRuns: 'damaged' } as unknown as ProjectFile;
    const st = buildOpenProjectState(project, '/path/p1', null);
    expect(st.workerRuns).toEqual([]);
  });

  it('新建项目初始化空的项目控制面快照', () => {
    const st = buildNewProjectState('新项目') as unknown as { projectControl?: unknown };
    expect(st.projectControl).toEqual({
      version: 1,
      activeSessionId: null,
      masterAgentId: null,
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    });
  });

  it('agents 项目级优先，缺省回退工作流级，再回退默认 ollama', () => {
    const p = mkProject();
    p.agents = [{ id: 'proj-agent' } as never];
    const st = buildOpenProjectState(p, '/p', null);
    expect(st.agents).toHaveLength(1);
    expect(st.agents[0].id).toBe('proj-agent');
  });

  it('无可用工作流 → 抛错', () => {
    const p = mkProject();
    p.activeId = 'ghost';
    p.workflows = {};
    expect(() => buildOpenProjectState(p, '/p', null)).toThrow();
  });

  it('损坏的项目控制面快照安全降级为空快照', () => {
    const project = {
      ...mkProject(),
      projectControl: { version: 1, sessions: 'bad', decisions: [], briefs: [] },
    } as unknown as ProjectFile;
    const st = buildOpenProjectState(project, '/p', null);

    expect(st.projectControl).toEqual({
      version: 1,
      activeSessionId: null,
      masterAgentId: null,
      sessions: [],
      decisions: [],
      briefs: [],
      architectures: [],
      issues: [],
    });
  });
});
describe('buildNewProjectState 新建项目状态构建', () => {
  it('生成项目元信息 + 一个空白工作流', () => {
    const st = buildNewProjectState('新项目');
    expect(st.projectName).toBe('新项目');
    expect(st.projectId).toMatch(/^proj-/);
    expect(st.projectPath).toBeNull();
    expect(st.projectDirty).toBe(true); // 尚未落盘
    expect(st.lastSavedSnapshot).toBeNull();
    expect(Object.keys(st.workflows)).toHaveLength(1);
    const wfId = Object.keys(st.workflows)[0];
    expect(st.activeWfId).toBe(wfId);
    expect(st.workflowName).toBe('未命名工作流');
    expect(st.nodes).toHaveLength(0);
    expect(st.edges).toHaveLength(0);
    expect(st.selectedNodeId).toBeNull();
  });

  it('空白工作流带默认 ollama agent 和内置角色', () => {
    const st = buildNewProjectState('x');
    const wf = st.workflows[st.activeWfId];
    expect(wf.agents[0]?.protocol).toBe('ollama');
    expect(st.agents[0]?.protocol).toBe('ollama');
    expect(st.roles.length).toBeGreaterThan(0);
  });
});
describe('buildCreateProjectState 创建项目状态构建', () => {
  it('keeps template graph and project metadata consistent', () => {
    const node = mkFlowNode('node-1', 'input.text');
    const edges: FlowEdge[] = [];
    const st = buildCreateProjectState({
      name: 'Starter Project',
      projectId: 'project-1',
      workflowId: 'workflow-1',
      createdAt: '2026-09-20T00:00:00.000Z',
      projectPath: 'C:/projects/starter',
      template: { name: 'Starter', nodes: [node], edges },
    });

    expect(st.projectName).toBe('Starter Project');
    expect(st.projectId).toBe('project-1');
    expect(st.projectPath).toBe('C:/projects/starter');
    expect(st.projectDirty).toBe(true);
    expect(st.activeWfId).toBe('workflow-1');
    expect(st.workflowName).toBe('Starter');
    expect(st.nodes[0]?.id).toBe('node-1');
    expect(st.nodes[0]?.data.dirty).toBe(true);
    expect(st.roles).not.toBe(st.workflows['workflow-1']?.roles);
    expect(st.roles[0]).not.toBe(st.workflows['workflow-1']?.roles?.[0]);
    expect(st.edges).toEqual(edges);
    expect(st.workerRuns).toEqual([]);
  });
});
