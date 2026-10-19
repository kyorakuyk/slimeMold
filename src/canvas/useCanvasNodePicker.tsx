import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useReactFlow, type Connection, type FinalConnectionState } from '@xyflow/react';
import { NodePickerModal, type PickPayload } from '../components/NodePickerModal';
import { arePortsCompatible } from '../types/graph';
import { resolvePorts } from '../engine/subgraph';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';

type CanvasNodePickerProps = {
  isSplit: boolean;
  isActive: boolean;
  addNode: ReturnType<typeof useWorkflowStore.getState>['addNode'];
  addSubgraphRef: ReturnType<typeof useWorkflowStore.getState>['addSubgraphRefNode'];
};

export default function useCanvasNodePicker({ isSplit, isActive, addNode, addSubgraphRef }: CanvasNodePickerProps) {
  const { screenToFlowPosition } = useReactFlow();
  const [pickerPos, setPickerPos] = useState<{ x: number; y: number } | null>(null);
  // 从端口拖拽到空白处建节点时，先缓存源端口上下文，待用户在命令面板选好节点后自动连边
  const pendingConn = useRef<{
    fromNodeId: string;
    fromHandleId: string;
    fromType: 'source' | 'target';
    screen: { x: number; y: number };
  } | null>(null);

  useEffect(() => {
    if (!isActive) {
      pendingConn.current = null;
      setPickerPos(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key.toLowerCase() === 'k' || e.code === 'Space')) {
        // 避免在输入框/文本域中误触发
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
        e.preventDefault();
        // 落点取屏幕中心，使新节点出现在当前视图中央
        setPickerPos({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isActive]);

  useEffect(() => {
    if (!pickerPos) return;
    // 弹窗内部已 stopPropagation，外部点击冒泡到此关闭
    const onDocDown = () => setPickerPos(null);
    window.addEventListener('mousedown', onDocDown);
    return () => window.removeEventListener('mousedown', onDocDown);
  }, [pickerPos]);

  const onCanvasDoubleClick = useCallback((event: ReactMouseEvent) => {
    const element = event.target as HTMLElement;
    // 只有双击空白画布（非节点/边/控制条/端口等）才弹出节点选择窗
    if (element.closest('.react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__minimap, .react-flow__panel, .react-flow__handle')) {
      return;
    }
    setPickerPos({ x: event.clientX, y: event.clientY });
  }, []);

  // Consume the pending endpoint once. The pending branch does not special-case `payload.kind`: it passes `payload.id` to addNode and
  // checks ports only if addNode returns an ID; selection then prefers a compatible port before the first-declared fallback.
  // Subgraph-reference creation exists only without a pending connection, and split mode suppresses it (ADR-SM-017、ADR-SM-075).
  const onPickNode = useCallback(
    (payload: PickPayload) => {
      if (!pickerPos) return;
      const position = screenToFlowPosition({ x: pickerPos.x, y: pickerPos.y });
      const pending = pendingConn.current;
      pendingConn.current = null;

      if (pending) {
        // 从端口拖到空白：新建节点后自动连边（ComfyUI 风格）
        const newNodeId = addNode(payload.id, { x: position.x - 112, y: position.y - 20 });
        if (newNodeId) {
          const defs = useRegistryStore.getState().defs;
          const subgraphs = useWorkflowStore.getState().subgraphs;
          const newNode = useWorkflowStore.getState().nodes.find((node) => node.id === newNodeId);
          const newDef = newNode ? resolvePorts(newNode.data.typeId, newNode.data.params, defs, subgraphs) : null;
          const sourceNode = useWorkflowStore.getState().nodes.find((node) => node.id === pending.fromNodeId);
          const sourceDef = sourceNode ? resolvePorts(sourceNode.data.typeId, sourceNode.data.params, defs, subgraphs) : null;
          if (newDef) {
            const fromIsSource = pending.fromType === 'source';
            const sourcePort = fromIsSource
              ? sourceDef?.outputs.find((port) => port.id === pending.fromHandleId)
              : sourceDef?.inputs.find((port) => port.id === pending.fromHandleId);
            let targetHandle: string | undefined;
            if (fromIsSource) {
              // 新节点作为 target：找第一个与源输出类型兼容的输入端口
              targetHandle = newDef.inputs.find(
                (input) => sourcePort && arePortsCompatible(sourcePort.type, input.type),
              )?.id ?? newDef.inputs[0]?.id;
            } else {
              // 新节点作为 source：找第一个与源输入类型兼容的输出端口
              targetHandle = newDef.outputs.find(
                (output) => sourcePort && arePortsCompatible(output.type, sourcePort.type),
              )?.id ?? newDef.outputs[0]?.id;
            }
            if (targetHandle) {
              const connection: Connection = fromIsSource
                ? { source: pending.fromNodeId, sourceHandle: pending.fromHandleId, target: newNodeId, targetHandle }
                : { source: newNodeId, sourceHandle: targetHandle, target: pending.fromNodeId, targetHandle: pending.fromHandleId };
              useWorkflowStore.getState().onConnect(connection);
            }
          }
        }
        setPickerPos(null);
        return;
      }

      if (payload.kind === 'subgraph') {
        if (!isSplit) addSubgraphRef(payload.id, { x: position.x - 112, y: position.y - 20 });
      } else {
        addNode(payload.id, { x: position.x - 112, y: position.y - 20 });
      }
      setPickerPos(null);
    },
    [pickerPos, screenToFlowPosition, addSubgraphRef, addNode, isSplit],
  );

  const closePicker = useCallback(() => {
    pendingConn.current = null;
    setPickerPos(null);
  }, []);

  // 从端口拖拽到空白处松手：缓存源端口上下文，弹出命令面板建节点并自动连边（ComfyUI 风格）
  const onConnectEnd = useCallback(
    (_event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      // 已连到有效目标：onConnect 已建边，无需处理
      if (connectionState.toHandle) return;
      const from = connectionState.fromHandle;
      if (!from) return;
      const event = _event as MouseEvent;
      const screen = 'changedTouches' in _event
        ? { x: (_event as TouchEvent).changedTouches[0].clientX, y: (_event as TouchEvent).changedTouches[0].clientY }
        : { x: event.clientX, y: event.clientY };
      pendingConn.current = {
        fromNodeId: from.nodeId,
        fromHandleId: from.id ?? '',
        fromType: (from.type ?? 'source') as 'source' | 'target',
        screen,
      };
      setPickerPos(screen);
    },
    [],
  );

  return {
    onCanvasDoubleClick,
    onConnectEnd,
    pickerOverlay: pickerPos
      ? <NodePickerModal
          screenPos={pickerPos}
          onSelect={onPickNode}
          onClose={closePicker}
          showSubgraphs={!pendingConn.current}
        />
      : null,
  };
}
