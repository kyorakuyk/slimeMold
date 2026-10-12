import { useCallback, useEffect, useMemo, useState, type MutableRefObject, type MouseEvent as ReactMouseEvent } from 'react';
import { Boxes, Group, Ungroup } from 'lucide-react';
import { NamePrompt } from '../components/NamePrompt';
import { SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import type { FlowNode } from '../types/graph';
import { useWorkflowStore } from '../store/workflowStore';
import { useT } from '../i18n/useT';

type CanvasContextMenuProps = {
  nodes: FlowNode[];
  isSplit: boolean;
  noWorkflows: boolean;
  rightMovedRef: MutableRefObject<boolean>;
};

export default function useCanvasContextMenu({
  nodes,
  isSplit,
  noWorkflows,
  rightMovedRef,
}: CanvasContextMenuProps) {
  const t = useT();
  const packAsSubgraph = useWorkflowStore((state) => state.packSelectionAsSubgraph);
  const createGroup = useWorkflowStore((state) => state.createGroup);
  const unpackSubgraph = useWorkflowStore((state) => state.unpackSubgraphNode);
  const subgraphs = useWorkflowStore((state) => state.subgraphs);
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId?: string } | null>(null);
  // 右键时的选中节点：React Flow 的多选状态记录在 node.selected 上
  const selectedIds = useMemo(() => nodes.filter((node) => node.selected).map((node) => node.id), [nodes]);

  const closeMenu = useCallback(() => setMenu(null), []);
  useEffect(() => {
    if (!menu) return;
    const onDown = () => closeMenu();
    window.addEventListener('click', onDown);
    window.addEventListener('contextmenu', onDown);
    return () => {
      window.removeEventListener('click', onDown);
      window.removeEventListener('contextmenu', onDown);
    };
  }, [menu, closeMenu]);

  /** 右键目标节点未被选中时，把它视为唯一选区 */
  const targetIds = useMemo(() => {
    if (!menu) return [];
    if (menu.nodeId && !selectedIds.includes(menu.nodeId)) return [menu.nodeId];
    return selectedIds;
  }, [menu, selectedIds]);

  const menuRefNode = menu?.nodeId
    ? nodes.find((node) => node.id === menu.nodeId && node.data.typeId === SUBGRAPH_REF_TYPE)
    : undefined;

  const [packPrompt, setPackPrompt] = useState(false);
  const handlePack = () => {
    closeMenu();
    if (targetIds.length === 0) return;
    setPackPrompt(true);
  };
  const handleGroup = () => {
    closeMenu();
    if (targetIds.length === 0) return;
    createGroup(targetIds);
  };

  const onNodeContextMenu = (event: MouseEvent | ReactMouseEvent, node: FlowNode) => {
    // 右键拖动框选（已移动）不弹菜单
    if (rightMovedRef.current) {
      event.preventDefault();
      rightMovedRef.current = false;
      return;
    }
    // 拆分视图右栏不弹节点右键菜单，但需清理标记，避免残留导致下次误判
    if (isSplit) {
      rightMovedRef.current = false;
      return;
    }
    event.preventDefault();
    rightMovedRef.current = false;
    setMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
  };

  const onPaneContextMenu = (event: MouseEvent | ReactMouseEvent) => {
    // 右键拖动框选（已移动）不弹菜单，仅清除标记
    if (rightMovedRef.current) {
      event.preventDefault();
      rightMovedRef.current = false;
      return;
    }
    // 拆分视图右栏不弹画布右键菜单，但需清理标记
    if (isSplit) {
      rightMovedRef.current = false;
      return;
    }
    event.preventDefault();
    rightMovedRef.current = false;
    setMenu({ x: event.clientX, y: event.clientY });
  };

  const onSelectionContextMenu = (event: MouseEvent | ReactMouseEvent) => {
    if (isSplit) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY });
  };

  const overlay = (
    <>
      {menu && !noWorkflows && !isSplit && (
        <div
          className="fixed z-50 min-w-[176px] overflow-hidden rounded-lg border border-line bg-paper py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {menuRefNode ? (
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-paper-soft"
              onClick={() => {
                closeMenu();
                unpackSubgraph(menuRefNode.id);
              }}
            >
              <Ungroup size={13} /> {t('canvas.subgraph.unpack')}
            </button>
          ) : (
            <>
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-paper-soft disabled:cursor-not-allowed disabled:text-ink-faint"
                onClick={handlePack}
                title={t('canvas.subgraph.packTitle')}
                disabled={targetIds.length === 0}
              >
                <Boxes size={13} /> {t('canvas.subgraph.pack')}
                <span className="ml-auto text-[10.5px] text-ink-faint">{t('canvas.selection.count', { count: targetIds.length })}</span>
              </button>
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-paper-soft disabled:cursor-not-allowed disabled:text-ink-faint"
                onClick={handleGroup}
                disabled={targetIds.length === 0}
                title={t('canvas.group.packTitle')}
              >
                <Group size={13} /> {t('canvas.group.pack')}
                <span className="ml-auto text-[10.5px] text-ink-faint">{t('canvas.selection.count', { count: targetIds.length })}</span>
              </button>
            </>
          )}
          {targetIds.length === 0 && !menuRefNode && (
            <p className="px-3 py-1 text-[11px] leading-relaxed text-ink-faint">
              {t('canvas.selection.emptyHint')}
            </p>
          )}
        </div>
      )}
      {packPrompt && (
        <NamePrompt
          title={t('canvas.subgraph.nameTitle')}
          initial={t('canvas.subgraph.newName', { count: Object.keys(subgraphs).length + 1 })}
          onConfirm={(name) => {
            packAsSubgraph(targetIds, name);
            setPackPrompt(false);
          }}
          onCancel={() => setPackPrompt(false)}
        />
      )}
    </>
  );

  return { onNodeContextMenu, onPaneContextMenu, onSelectionContextMenu, overlay };
}
