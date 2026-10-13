import { useCallback, type Dispatch, type SetStateAction, type DragEvent } from 'react';
import { getNodeDef } from '../store/registryStore';
import { SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import type { FlowNode, NodeStatus } from '../types/graph';

/** 画布上拖入节点的 MIME（NodePalette / 子图库共用）。 */
export const DND_MIME = 'application/x-slime-node';

type ScreenToFlowPosition = (position: { x: number; y: number }) => { x: number; y: number };

interface CanvasDropInput {
  isSplit: boolean;
  addNode: (typeId: string, position: { x: number; y: number }) => void;
  addSubgraphRef: (subgraphId: string, position: { x: number; y: number }) => void;
  setSplitNodes: Dispatch<SetStateAction<FlowNode[]>>;
  screenToFlowPosition: ScreenToFlowPosition;
}

/**
 * 画布 drop 处理：普通节点交给 store，子图引用交给 addSubgraphRef，
 * 分栏工作流则把节点加进本地副本（随后由写回 effect 落进 workflows）。
 */
export default function useCanvasDrop({
  isSplit,
  addNode,
  addSubgraphRef,
  setSplitNodes,
  screenToFlowPosition,
}: CanvasDropInput): (e: DragEvent) => void {
  return useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      const typeId = e.dataTransfer.getData(DND_MIME) || e.dataTransfer.getData('text/plain');
      if (!typeId) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // 子图载荷格式：`subgraph.ref:<子图 id>`
      if (typeId.startsWith(`${SUBGRAPH_REF_TYPE}:`)) {
        if (isSplit) return;
        addSubgraphRef(typeId.slice(SUBGRAPH_REF_TYPE.length + 1), {
          x: position.x - 112,
          y: position.y - 20,
        });
        return;
      }
      // 分栏工作流：拖入的节点加入本地副本（随后写回 workflows）
      if (isSplit) {
        const id = `n-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
        const def = getNodeDef(typeId);
        const params: Record<string, unknown> = {};
        for (const p of def?.params ?? []) if (p.default !== undefined) params[p.key] = p.default;
        setSplitNodes((ns) => [
          ...ns,
          {
            id,
            type: 'base',
            position: { x: position.x - 112, y: position.y - 20 },
            data: { typeId, label: def?.name ?? typeId, params, status: 'idle' as NodeStatus, dirty: true },
          },
        ]);
        return;
      }
      addNode(typeId, { x: position.x - 112, y: position.y - 20 });
    },
    [addNode, screenToFlowPosition, isSplit, addSubgraphRef],
  );
}
