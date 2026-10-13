import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { Connection } from '@xyflow/react';
import { resolvePorts } from '../engine/subgraph';
import { arePortsCompatible, type EdgeKind, type FlowEdge, type FlowNode } from '../types/graph';
import { wouldCreateCycle } from '../engine/topoSort';
import { useWorkflowStore } from '../store/workflowStore';
import { useRegistryStore } from '../store/registryStore';
import type { useT } from '../i18n/useT';

type Translate = ReturnType<typeof useT>;

interface CanvasReconnectInput {
  isSplit: boolean;
  nodes: FlowNode[];
  setSplitEdges: Dispatch<SetStateAction<FlowEdge[]>>;
  t: Translate;
}

/**
 * 重新连线：拖拽已有连线的一端到新端口，更新该连线端点（带环路/类型校验）。
 *
 * 行为与抽取前保持一致：校验失败只记日志并原样返回；主画布写 store 并 pushHistory/markDirty，
 * 分栏只更新本地 splitEdges 副本。
 */
export default function useCanvasReconnect({
  isSplit,
  nodes,
  setSplitEdges,
  t,
}: CanvasReconnectInput): (oldEdge: FlowEdge, conn: Connection) => void {
  return useCallback(
    (oldEdge: FlowEdge, conn: Connection) => {
      const st = useWorkflowStore.getState();
      const newSource = conn.source ?? oldEdge.source;
      const newTarget = conn.target ?? oldEdge.target;
      const newSH = conn.sourceHandle ?? oldEdge.sourceHandle;
      const newTH = conn.targetHandle ?? oldEdge.targetHandle;

      // 环路校验（与 onConnect 一致，忽略 control 语义）
      if (wouldCreateCycle(newSource, newTarget, st.edges.filter((e) => e.id !== oldEdge.id))) {
        st.addLog('error', t('canvas.reconnect.cycleCancelled'));
        return;
      }
      // 端口类型校验
      const srcNode = nodes.find((n) => n.id === newSource);
      const tgtNode = nodes.find((n) => n.id === newTarget);
      const sgs = st.subgraphs;
      const defs = useRegistryStore.getState().defs;
      const srcDef = resolvePorts(srcNode?.data.typeId ?? '', srcNode?.data.params, defs, sgs);
      const tgtDef = resolvePorts(tgtNode?.data.typeId ?? '', tgtNode?.data.params, defs, sgs);
      const srcPort = srcDef.outputs.find((o) => o.id === newSH);
      const tgtPort = tgtDef.inputs.find((i) => i.id === newTH);
      if (!arePortsCompatible(srcPort?.type, tgtPort?.type)) {
        st.addLog('error', t('canvas.reconnect.typeMismatch'));
        return;
      }
      const kind = (srcPort?.flow as EdgeKind | undefined) ?? (oldEdge.data?.kind as EdgeKind) ?? 'data';
      const updated: FlowEdge = {
        ...oldEdge,
        source: newSource,
        target: newTarget,
        sourceHandle: newSH ?? undefined,
        targetHandle: newTH ?? undefined,
        data: { ...(oldEdge.data ?? {}), kind },
      };
      if (isSplit) {
        setSplitEdges((es) => es.map((e) => (e.id === oldEdge.id ? updated : e)));
      } else {
        st.pushHistory();
        useWorkflowStore.setState({ edges: st.edges.map((e) => (e.id === oldEdge.id ? updated : e)) });
        st.markDirty(newSource);
      }
    },
    [isSplit, nodes, setSplitEdges],
  );
}
