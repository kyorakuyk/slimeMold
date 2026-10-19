import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type MutableRefObject } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useWorkflowStore } from '../store/workflowStore';

// 直接取 useReactFlow() 的真实返回形状，避免把 facade 合同缩窄成自定义窄类型。
type ReactFlowApi = ReturnType<typeof useReactFlow>;
type ScreenToFlowPosition = ReactFlowApi['screenToFlowPosition'];
type GetNodes = ReactFlowApi['getNodes'];

export interface RightBoxRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface RightBoxSelectionInput {
  screenToFlowPosition: ScreenToFlowPosition;
  getNodes: GetNodes;
  isSplit: boolean;
  wfId?: string;
}

interface RightBoxSelection {
  rightBox: RightBoxRect | null;
  rightStart: MutableRefObject<{ x: number; y: number; moved: boolean } | null>;
  rightMovedRef: MutableRefObject<boolean>;
  suppressSelectionSync: MutableRefObject<boolean>;
  onPaneMouseDownCapture: (e: ReactMouseEvent) => void;
}

/**
 * 右键长按框选：按住右键拖动在画布上画矩形，命中节点高亮；短按则弹右键菜单。
 *
 * 关键行为（历史上修过两次卡死，勿改）：
 * - mousemove 命中集合未变化时跳过整段 store 写入，避免每帧重写整个 nodes 数组；
 * - 右键已松开却未收到 mouseup（拖出窗口、菜单拦截、焦点切换）时自愈清理残留标记；
 * - mouseup 先于 contextmenu，故用 rightMovedRef 落定「是否发生移动」供菜单判断；
 * - 窗口 blur 也强制清理，避免监听器常驻导致持续重渲染。
 */
export default function useRightBoxSelection({
  screenToFlowPosition,
  getNodes,
  isSplit,
  wfId,
}: RightBoxSelectionInput): RightBoxSelection {
  const [rightBox, setRightBox] = useState<RightBoxRect | null>(null);
  const rightStart = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // 右键框选是否发生移动：在 mouseup 时落定，供紧随其后的 contextmenu 判断（避免 mouseup 清 rightStart 导致误弹菜单）
  const rightMovedRef = useRef(false);
  // 右键框选 drag 期间抑制 React Flow 的 onSelectionChange 写入，避免把框选刚设的 selectedIds 清空
  const suppressSelectionSync = useRef(false);
  // 框选上一帧命中集合（join 后的 key），仅当命中真正变化时才写回 store，
  // 避免每帧 mousemove 都重写整个 nodes 数组（曾导致多次交互后卡死）
  const lastHitRef = useRef<string | null>(null);

  const onPaneMouseDownCapture = useCallback((e: ReactMouseEvent) => {
    if (e.button !== 2) return; // 仅右键
    e.preventDefault();
    rightStart.current = { x: e.clientX, y: e.clientY, moved: false };
    suppressSelectionSync.current = true; // 框选期间抑制 React Flow 选区回写，避免清空 selectedIds
    setRightBox({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
  }, []);

  // 供框选 effect 读取的最新值（避免 effect 依赖频繁重建导致监听器叠加）
  const latestRef = useRef({ screenToFlowPosition, getNodes, isSplit, wfId });
  latestRef.current = { screenToFlowPosition, getNodes, isSplit, wfId };

  useEffect(() => {
    const onMove = (ev: MouseEvent) => {
      const rs = rightStart.current;
      if (!rs) return;
      // 自愈：右键已松开却未收到 mouseup（如拖出窗口外松手、菜单拦截、焦点切换），
      // 主动清理，避免 残留的 rightStart 让后续任意 mousemove（含左键拖节点）持续重写 nodes 数组而致卡死。
      if (!(ev.buttons & 2)) {
        rightStart.current = null;
        suppressSelectionSync.current = false;
        rightMovedRef.current = false;
        setRightBox(null);
        lastHitRef.current = null;
        return;
      }
      if (Math.abs(ev.clientX - rs.x) + Math.abs(ev.clientY - rs.y) > 4) {
        rs.moved = true;
      }
      setRightBox((b) => (b ? { ...b, x1: ev.clientX, y1: ev.clientY } : b));
      const { screenToFlowPosition: toFlow, getNodes: readNodes, isSplit: split, wfId: paneWfId } = latestRef.current;
      const sx = Math.min(rs.x, ev.clientX);
      const sy = Math.min(rs.y, ev.clientY);
      const ex = Math.max(rs.x, ev.clientX);
      const ey = Math.max(rs.y, ev.clientY);
      const tl = toFlow({ x: sx, y: sy });
      const br = toFlow({ x: ex, y: ey });
      const hit = readNodes()
        .filter((n) => {
          const w = n.measured?.width ?? 160;
          const h = n.measured?.height ?? 70;
          return n.position.x < br.x && n.position.x + w > tl.x && n.position.y < br.y && n.position.y + h > tl.y;
        })
        .map((n) => n.id);
      // 命中集合未变化则跳过整段 store 写入，避免每帧重写整个 nodes 数组（卡死根因之一）
      const hitKey = hit.join(',');
      if (hitKey === lastHitRef.current) return;
      lastHitRef.current = hitKey;
      // 框选命中后：同步选中态到正确的节点列表（拆分视图写右栏运行态副本，否则写主工作区），
      // 并写入 selectedIds / selectedNodeId / focusWfId，供对齐、分布、Inspector 等消费。
      const st = useWorkflowStore.getState();
      if (split && paneWfId) {
        const wf = st.workflows[paneWfId];
        if (wf) {
          useWorkflowStore.setState({
            workflows: {
              ...st.workflows,
              [paneWfId]: { ...wf, nodes: wf.nodes.map((nd) => ({ ...nd, selected: hit.includes(nd.id) })) },
            },
            selectedIds: hit,
            selectedNodeId: hit[0] ?? null,
            focusWfId: paneWfId,
          });
        }
      } else {
        useWorkflowStore.setState({
          nodes: st.nodes.map((nd) => ({ ...nd, selected: hit.includes(nd.id) })),
          selectedIds: hit,
          selectedNodeId: hit[0] ?? null,
          focusWfId: st.activeWfId,
        });
      }
    };
    const onUp = () => {
      setRightBox(null);
      // mouseup 先于 contextmenu：落定 moved 标记并清理 rightStart，避免残留导致 window mousemove 常驻重渲染（卡死）
      rightMovedRef.current = rightStart.current?.moved ?? false;
      rightStart.current = null;
      suppressSelectionSync.current = false;
      lastHitRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    // 鼠标移出窗口/失焦时（mouseup 可能不触发）强制清理框选标记，避免残留导致常驻重渲染
    const onBlur = () => {
      rightStart.current = null;
      rightMovedRef.current = false;
      suppressSelectionSync.current = false;
      setRightBox(null);
      lastHitRef.current = null;
    };
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return { rightBox, rightStart, rightMovedRef, suppressSelectionSync, onPaneMouseDownCapture };
}
