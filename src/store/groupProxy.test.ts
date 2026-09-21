import { describe, it, expect, beforeEach } from 'vitest';
import type { FlowNode, NodeDefinition, NodeGroup } from '../types';
import { useRegistryStore } from './registryStore';
import { recomputeProxyPorts, defaultParams, GROUP_COLORS } from './groupProxy';

function mkDef(typeId: string, opts: { inputs?: { id: string; type: string }[]; outputs?: { id: string; type: string }[]; params?: { key: string; default?: unknown }[] } = {}): NodeDefinition {
  return {
    typeId,
    label: typeId,
    category: 'tool',
    description: '',
    inputs: opts.inputs ?? [],
    outputs: opts.outputs ?? [],
    params: opts.params ?? [],
    execute: async () => ({}),
  } as unknown as NodeDefinition;
}

function mkNode(id: string, typeId: string): FlowNode {
  return {
    id,
    type: 'base',
    position: { x: 0, y: 0 },
    data: {
      typeId,
      label: id,
      params: {},
      status: 'idle',
      bypass: false,
      mute: false,
    },
  } as FlowNode;
}

function mkGroup(id: string, nodeIds: string[]): NodeGroup {
  return {
    id,
    title: id,
    nodeIds,
    collapsed: true,
    color: '#000',
    proxyPorts: [],
    virtualEdges: [],
    bounds: { x: 0, y: 0, width: 10, height: 10 },
  } as NodeGroup;
}

describe('groupProxy 纯辅助（从 workflowStore 抽离，行为等价）', () => {
  beforeEach(() => {
    useRegistryStore.setState({ defs: {}, plugins: [] });
  });

  describe('GROUP_COLORS', () => {
    it('提供 6 个预设配色且不重复', () => {
      expect(GROUP_COLORS).toHaveLength(6);
      expect(new Set(GROUP_COLORS).size).toBe(6);
    });
  });

  describe('defaultParams', () => {
    it('仅取定义中带 default 的键', () => {
      useRegistryStore.getState().register([
        mkDef('tool.x', {
          params: [
            { key: 'a', default: 1 },
            { key: 'b' }, // 无 default
            { key: 'c', default: 'hello' },
          ],
        }),
      ]);
      expect(defaultParams('tool.x')).toEqual({ a: 1, c: 'hello' });
    });

    it('未知类型返回空对象', () => {
      expect(defaultParams('nope.nope')).toEqual({});
    });
  });

  describe('recomputeProxyPorts', () => {
    it('按端口类型聚合成员节点，同类型合并为单一代理端口', () => {
      // 两输入 image + 一输入 text + 一输出 text
      useRegistryStore.getState().register([
        mkDef('in.a', { inputs: [{ id: 'i1', type: 'image' }] }),
        mkDef('in.b', { inputs: [{ id: 'i2', type: 'image' }] }),
        mkDef('p.c', { inputs: [{ id: 'i3', type: 'text' }], outputs: [{ id: 'o1', type: 'text' }] }),
      ]);
      const group = mkGroup('g1', ['n1', 'n2', 'n3']);
      const nodes = [mkNode('n1', 'in.a'), mkNode('n2', 'in.b'), mkNode('n3', 'p.c')];
      const out = recomputeProxyPorts(group, {} as never, nodes, [], useRegistryStore.getState().defs);

      // 聚合：image 输入(来自 n1+n2) -> 1 个代理输入端口；text 输入(来自 n3) -> 1 个；text 输出 -> 1 个
      const inPorts = out.proxyPorts!.filter((p) => p.kind === 'input');
      const outPorts = out.proxyPorts!.filter((p) => p.kind === 'output');
      expect(inPorts).toHaveLength(2);
      expect(outPorts).toHaveLength(1);

      const imgIn = inPorts.find((p) => p.type === 'image')!;
      expect(imgIn.id).toBe('g1:in:image');
      expect(imgIn.internalTargets).toHaveLength(2); // n1 + n2

      const txtIn = inPorts.find((p) => p.type === 'text')!;
      expect(txtIn.internalTargets).toHaveLength(1); // n3

      const txtOut = outPorts[0];
      expect(txtOut.id).toBe('g1:out:text');
      expect(txtOut.internalTargets).toHaveLength(1);

      // virtualEdges 数量与 proxyPorts 一致
      expect(out.virtualEdges!).toHaveLength(3);
      // 非成员节点被忽略
    });

    it('忽略非成员节点并保持 group 其它字段不变', () => {
      useRegistryStore.getState().register([
        mkDef('in.a', { inputs: [{ id: 'i1', type: 'text' }] }),
      ]);
      const group = mkGroup('g2', ['n1']);
      group.color = '#abc';
      const nodes = [mkNode('n1', 'in.a'), mkNode('nX', 'in.a')]; // nX 不在组内
      const out = recomputeProxyPorts(group, {} as never, nodes, [], useRegistryStore.getState().defs);
      expect(out.proxyPorts!).toHaveLength(1);
      expect(out.proxyPorts![0].internalTargets).toHaveLength(1);
      expect(out.proxyPorts![0].internalTargets[0].nodeId).toBe('n1');
      expect(out.color).toBe('#abc');
    });

    it('未知类型节点被跳过不影响聚合', () => {
      useRegistryStore.getState().register([
        mkDef('in.a', { inputs: [{ id: 'i1', type: 'txt' }] }),
      ]);
      const group = mkGroup('g3', ['n1', 'nUnknown']);
      const nodes = [mkNode('n1', 'in.a'), mkNode('nUnknown', 'ghost.type')];
      const out = recomputeProxyPorts(group, {} as never, nodes, [], useRegistryStore.getState().defs);
      expect(out.proxyPorts).toHaveLength(1);
    });
  });
});
