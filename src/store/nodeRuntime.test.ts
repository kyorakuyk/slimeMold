import { describe, it, expect } from 'vitest';
import type { FlowEdge, FlowNode, NodeStatus } from '../types';
import { resetNodeRuntime, resetEdgeRuntime } from './nodeRuntime';

function mkNode(id: string, status: NodeStatus = 'running', extra: Record<string, unknown> = {}): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: {
      typeId: 'input.text',
      label: id,
      params: {},
      status,
      error: 'boom',
      outputs: { x: 1 },
      usage: { tokens: 3 },
      ...extra,
    },
  } as unknown as FlowNode;
}

function mkEdge(id: string, className?: string): FlowEdge {
  return {
    id,
    source: 'a',
    target: 'b',
    sourceHandle: 'out',
    targetHandle: 'in',
    data: { kind: 'data', scope: ['s1'] },
    className,
  } as FlowEdge;
}

describe('nodeRuntime 纯映射（从 workflowStore 抽离，行为等价）', () => {
  describe('resetNodeRuntime', () => {
    it('运行态字段复位为 idle/undefined，其余字段保留', () => {
      const out = resetNodeRuntime([mkNode('n1', 'running')]);
      expect(out[0].data.status).toBe('idle');
      expect(out[0].data.error).toBeUndefined();
      expect(out[0].data.outputs).toBeUndefined();
      expect(out[0].data.usage).toBeUndefined();
      // 非运行态字段不受影响
      expect(out[0].data.typeId).toBe('input.text');
      expect(out[0].data.params).toEqual({});
      expect(out[0].position).toEqual({ x: 0, y: 0 });
    });

    it('增量复位可保留既有 outputs，但仍清除运行错误和用量', () => {
      const out = resetNodeRuntime([mkNode('n1', 'success')], { preserveOutputs: true });
      expect(out[0].data.status).toBe('idle');
      expect(out[0].data.outputs).toEqual({ x: 1 });
      expect(out[0].data.error).toBeUndefined();
      expect(out[0].data.usage).toBeUndefined();
    });

    it('已是 idle 的节点同样被清洗（幂等）', () => {
      const out = resetNodeRuntime([mkNode('n1', 'idle', { error: 'stale', outputs: { y: 2 } })]);
      expect(out[0].data.status).toBe('idle');
      expect(out[0].data.error).toBeUndefined();
      expect(out[0].data.outputs).toBeUndefined();
    });

    it('空列表返回空列表，且不抛错', () => {
      expect(resetNodeRuntime([])).toEqual([]);
    });

    it('不修改原数组（纯函数）', () => {
      const before = mkNode('n1');
      const beforeData = JSON.stringify(before.data);
      resetNodeRuntime([before]);
      expect(JSON.stringify(before.data)).toBe(beforeData);
    });
  });

  describe('resetEdgeRuntime', () => {
    it('去除 sm-edge-running class，保留其它 class', () => {
      const out = resetEdgeRuntime([mkEdge('e1', 'foo sm-edge-running bar')]);
      expect(out[0].className).toBe('foo bar');
    });

    it('无 running class 时原样保留', () => {
      const out = resetEdgeRuntime([mkEdge('e1', 'foo bar')]);
      expect(out[0].className).toBe('foo bar');
    });

    it('className 为 undefined 时不报错，清洗为空串', () => {
      const out = resetEdgeRuntime([mkEdge('e1')]);
      expect(out[0].className).toBe('');
    });

    it('不修改原数组', () => {
      const before = mkEdge('e1', 'a sm-edge-running');
      const beforeCn = before.className;
      resetEdgeRuntime([before]);
      expect(before.className).toBe(beforeCn);
    });
  });
});
