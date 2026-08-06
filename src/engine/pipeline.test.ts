import { describe, it, expect, beforeEach } from 'vitest';
import {
  definePipeline,
  getPipeline,
  bindStageWorkflow,
  publishArtifact,
  getArtifact,
  advance,
  rework,
} from './pipeline';
import { useWorkflowStore } from '../store/workflowStore';
import type { PipelineDef } from './pipeline';

const samplePipeline: PipelineDef = {
  id: 'p1',
  label: '三方流水线',
  stages: [
    { id: 'plan', label: '计划', role: 'builder' },
    { id: 'design', label: '设计', role: 'builder' },
    { id: 'construction', label: '施工', role: 'constructor' },
    { id: 'ops', label: '运维', role: 'ops' },
  ],
  edges: [
    { from: 'plan', to: 'design', artifactKind: 'plan' },
    { from: 'design', to: 'construction', artifactKind: 'design' },
    { from: 'construction', to: 'ops', artifactKind: 'project' },
    { from: 'ops', to: 'design', artifactKind: 'bugreport', backflow: true },
  ],
};

beforeEach(() => {
  // 清空 pipeline/artifact 项目态，保证测试隔离
  useWorkflowStore.getState().setPipelines([]);
  useWorkflowStore.setState({ artifacts: {} });
});

describe('pipeline 定义与查询', () => {
  it('definePipeline 写入后可 getPipeline 取回', () => {
    definePipeline(samplePipeline);
    const got = getPipeline('p1');
    expect(got).toBeDefined();
    expect(got?.stages).toHaveLength(4);
    expect(got?.edges).toHaveLength(4);
  });

  it('重复 definePipeline 同 id 覆盖而非追加', () => {
    definePipeline(samplePipeline);
    definePipeline({ ...samplePipeline, label: '改名' });
    const all = useWorkflowStore.getState().pipelines;
    expect(all).toHaveLength(1);
    expect(getPipeline('p1')?.label).toBe('改名');
  });

  it('bindStageWorkflow 回填 wfId', () => {
    definePipeline(samplePipeline);
    bindStageWorkflow('p1', 'construction', 'wf-construction-1');
    const got = getPipeline('p1');
    expect(got?.stages.find((s) => s.id === 'construction')?.wfId).toBe('wf-construction-1');
  });
});

describe('artifact 黑板', () => {
  it('publishArtifact 写入后 getArtifact 可取回', () => {
    const a = publishArtifact({ stage: 'plan', kind: 'plan', payload: { text: '计划书' }, fromWf: 'wf1', runId: '1' });
    expect(a.version).toBe(1);
    const got = getArtifact('plan', 'plan');
    expect(got?.payload).toEqual({ text: '计划书' });
    expect(got?.fromWf).toBe('wf1');
  });

  it('同一 (stage,kind) 覆盖时 version 自增', () => {
    publishArtifact({ stage: 'plan', kind: 'plan', payload: 1, fromWf: 'wf1', runId: '1' });
    const a2 = publishArtifact({ stage: 'plan', kind: 'plan', payload: 2, fromWf: 'wf1', runId: '2' });
    expect(a2.version).toBe(2);
  });
});

describe('advance 正向传播', () => {
  it('上游 artifact 经正向边写入下游 stage 槽位', () => {
    definePipeline(samplePipeline);
    publishArtifact({ stage: 'plan', kind: 'plan', payload: 'PLAN', fromWf: 'wf1', runId: '1' });
    const targets = advance('p1', 'plan', 'plan');
    expect(targets.map((t) => t.id)).toEqual(['design']);
    // 下游 design 阶段已收到 plan artifact
    expect(getArtifact('design', 'plan')?.payload).toBe('PLAN');
  });

  it('无对应上游 artifact 时 advance 不传播', () => {
    definePipeline(samplePipeline);
    const targets = advance('p1', 'plan', 'plan');
    expect(targets).toHaveLength(0);
    expect(getArtifact('design', 'plan')).toBeUndefined();
  });

  it('backflow 边不被 advance 计入正向传播', () => {
    definePipeline(samplePipeline);
    // ops 产生 bugreport，advance 走正向不应把 bugreport 退回 design
    publishArtifact({ stage: 'ops', kind: 'bugreport', payload: 'BUG', fromWf: 'wfOps', runId: '1' });
    const targets = advance('p1', 'ops', 'bugreport');
    expect(targets).toHaveLength(0);
    expect(getArtifact('design', 'bugreport')).toBeUndefined();
  });
});

describe('rework 回流写回', () => {
  it('rework 把裁决写入目标阶段槽位并返回该阶段', () => {
    definePipeline(samplePipeline);
    const target = rework('p1', 'design', 'bugreport', '重做设计', 'wfOps', '2');
    expect(target?.id).toBe('design');
    expect(getArtifact('design', 'bugreport')?.payload).toBe('重做设计');
  });

  it('rework 目标阶段不存在时返回 undefined', () => {
    definePipeline(samplePipeline);
    const target = rework('p1', 'ghost', 'bugreport', 'x', 'wf', '1');
    expect(target).toBeUndefined();
  });
});
