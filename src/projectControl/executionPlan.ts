import type { ArtifactKind, DraftStage, PipelineDraft } from '../types/orchestration';
import type { ProjectTaskGraph } from './types';

export function buildExecutionDraftFromTaskGraph(input: {
  goal: string;
  taskGraph: ProjectTaskGraph;
  workflowIds?: { construction: string; acceptance: string };
}): PipelineDraft {
  const goal = input.goal.trim();
  if (!goal) throw new Error('执行计划目标不能为空');
  if (input.taskGraph.approval !== 'approved') {
    throw new Error(`任务图尚未批准，不能生成执行编排：${input.taskGraph.approval}`);
  }
  if (input.taskGraph.tasks.length === 0) {
    throw new Error('任务图没有可执行任务');
  }

  const taskIds = input.taskGraph.tasks.map((task) => task.id);
  const taskSummary = input.taskGraph.tasks
    .map((task) => `${task.title}（${task.scope.join('、') || '影响范围待确认'}）`)
    .join('；');
  const construction: DraftStage = {
    id: 'construction',
    label: '施工',
    role: 'constructor',
    goal: `${goal}。执行已批准任务：${taskSummary}`,
    wfRef: input.workflowIds?.construction
      ? { kind: 'existing', wfId: input.workflowIds.construction }
      : { kind: 'new' },
    sourceTaskGraphId: input.taskGraph.id,
    taskIds,
    artifactIn: ['plan'] as ArtifactKind[],
    artifactOut: ['project'] as ArtifactKind[],
  };
  const acceptance: DraftStage = {
    id: 'acceptance',
    label: '验收',
    role: 'ops',
    goal: `${goal}。检查施工结果、测试、diff 和验收标准，收集需要回流的问题。`,
    wfRef: input.workflowIds?.acceptance
      ? { kind: 'existing', wfId: input.workflowIds.acceptance }
      : { kind: 'new' },
    sourceTaskGraphId: input.taskGraph.id,
    taskIds,
    artifactIn: ['project'] as ArtifactKind[],
    artifactOut: ['bugreport'] as ArtifactKind[],
  };
  return {
    stages: [construction, acceptance],
    edges: [{ from: construction.id, to: acceptance.id, artifactKind: 'project' }],
  };
}
