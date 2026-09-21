/**
 * 节点组渲染层（方案 B：纯视觉编组）。
 *
 * 用一层绝对定位的 div 覆盖在 React Flow 的 viewport 之上（跟随平移/缩放变换），
 * 按组内成员节点的包围盒画出组框与标题条。组不参与执行，不改变图的拓扑。
 *
 * 交互：
 *  - 拖动标题条 -> 整组节点一起平移
 *  - 双击标题   -> 重命名
 *  - 折叠按钮   -> 收起组内节点（画布上隐藏，只留标题条）
 *  - 配色/解散  -> 标题条右侧按钮
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, useReactFlow } from '@xyflow/react';
import { ChevronDown, ChevronRight, Palette, X } from 'lucide-react';
import type { NodeGroup } from '../types/workflow';
import type { FlowNode } from '../types';
import { useWorkflowStore } from '../store/workflowStore';

/** 组框相对成员包围盒的内边距 */
const PAD = 22;
/** 标题条高度 */
const HEADER_H = 26;
/** 节点估算尺寸（React Flow 未测量时的兜底值） */
const FALLBACK_W = 224;
const FALLBACK_H = 88;

const PALETTE = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#64748b'];

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 计算一组节点的包围盒（画布坐标系） */
function boundsOf(nodes: FlowNode[], measured: Map<string, { w: number; h: number }>): Box | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const m = measured.get(n.id);
    const w = m?.w ?? FALLBACK_W;
    const h = m?.h ?? FALLBACK_H;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  return {
    x: minX - PAD,
    y: minY - PAD - HEADER_H,
    width: maxX - minX + PAD * 2,
    height: maxY - minY + PAD * 2 + HEADER_H,
  };
}

function GroupBox({
  group,
  box,
  zoom,
}: {
  group: NodeGroup;
  box: Box;
  zoom: number;
}) {
  const moveGroup = useWorkflowStore((s) => s.moveGroup);
  const updateGroup = useWorkflowStore((s) => s.updateGroup);
  const removeGroup = useWorkflowStore((s) => s.removeGroup);
  const toggleCollapsed = useWorkflowStore((s) => s.toggleGroupCollapsed);
  const selected = useWorkflowStore((s) =>
    s.nodes.some((n) => group.nodeIds.includes(n.id) && n.selected),
  );

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.title);
  const [palette, setPalette] = useState(false);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);

  // 拖动标题条：整组平移。用画布缩放系数换算屏幕位移 -> 画布位移
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (editing) return;
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = { x: e.clientX, y: e.clientY };
      movedRef.current = false;
    },
    [editing],
  );
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      e.stopPropagation();
      movedRef.current = true;
      const dx = (e.clientX - dragRef.current.x) / zoom;
      const dy = (e.clientY - dragRef.current.y) / zoom;
      dragRef.current = { x: e.clientX, y: e.clientY };
      moveGroup(group.id, dx, dy);
    },
    [group.id, moveGroup, zoom],
  );
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  const commitTitle = () => {
    setEditing(false);
    const t = draft.trim();
    if (t && t !== group.title) updateGroup(group.id, { title: t });
    else setDraft(group.title);
  };

  // 折叠态拖拽：用 window 级监听，避免卡片每帧重定位导致 pointer capture 丢失
  const startCollapsedDrag = useCallback(
    (e: React.PointerEvent) => {
      if (editing) return;
      e.stopPropagation();
      dragRef.current = { x: e.clientX, y: e.clientY };
      movedRef.current = false;
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        movedRef.current = true;
        const dx = (ev.clientX - dragRef.current.x) / zoom;
        const dy = (ev.clientY - dragRef.current.y) / zoom;
        dragRef.current = { x: ev.clientX, y: ev.clientY };
        moveGroup(group.id, dx, dy);
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [editing, group.id, moveGroup, zoom],
  );

  // 折叠态：以与普通节点对齐的卡片风格展示（同款圆角外壳 + 组色标题条）
  if (group.collapsed) {
    return (
      <div
        className={`sm-group-collapsed pointer-events-auto absolute ${
          selected ? 'selected' : ''
        }`}
        style={{
          left: box.x,
          top: box.y,
          ['--grp' as string]: group.color,
          width: Math.max(168, box.width),
          cursor: 'move',
        }}
        onPointerDown={startCollapsedDrag}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(group.title);
          setEditing(true);
        }}
        onClick={(e) => {
          e.stopPropagation();
          // 仅在未拖动（无移动）时展开
          if (!movedRef.current) toggleCollapsed(group.id);
        }}
        title="拖动可整组移动，双击重命名"
      >
        <div className="sm-group-header">
          <span className="sm-group-dot" />
          {editing ? (
            <input
              autoFocus
              className="min-w-0 flex-1 rounded bg-white/25 px-1 text-[12px] text-white outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitTitle}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') {
                  setDraft(group.title);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span className="sm-group-title">{group.title}</span>
          )}
          <span className="sm-group-cat">组</span>
          <button
            className="sm-group-expand-btn"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (!group.collapsed) updateGroup(group.id, { bounds: box });
              toggleCollapsed(group.id);
            }}
            title="展开这一组"
          >
            <ChevronRight size={15} />
            <span>展开</span>
          </button>
        </div>
        <div className="sm-group-body">
          <span className="sm-group-count">含 {group.nodeIds.length} 个节点</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="pointer-events-none absolute"
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
    >
      {/* 组框主体 */}
      <div
        className="absolute inset-0 rounded-lg border-2 border-dashed"
        style={{
          borderColor: group.color,
          background: `color-mix(in srgb, ${group.color} 7%, transparent)`,
        }}
      />
      {/* 标题条：可拖动 / 可编辑 */}
      <div
        className="pointer-events-auto absolute left-0 top-0 flex items-center gap-1 rounded-t-lg px-1.5 text-white"
        style={{ height: HEADER_H, width: box.width, background: group.color, cursor: 'move' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(group.title);
          setEditing(true);
        }}
        title="拖动可整组移动，双击可重命名"
      >
        <button
          className="shrink-0 rounded p-0.5 hover:bg-white/20"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            // 折叠前记录当前包围盒，供折叠态占位与展开还原
            if (!group.collapsed) updateGroup(group.id, { bounds: box });
            toggleCollapsed(group.id);
          }}
          title={group.collapsed ? '展开这一组' : '折叠这一组'}
        >
          {group.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>

        {editing ? (
          <input
            autoFocus
            className="min-w-0 flex-1 rounded bg-white/25 px-1 text-[12px] text-white outline-none placeholder:text-white/60"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle();
              if (e.key === 'Escape') {
                setDraft(group.title);
                setEditing(false);
              }
            }}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
            {group.title}
            <span className="ml-1.5 opacity-70">({group.nodeIds.length})</span>
          </span>
        )}

        <div className="relative shrink-0">
          <button
            className="rounded p-0.5 hover:bg-white/20"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setPalette((v) => !v);
            }}
            title="换个颜色"
          >
            <Palette size={13} />
          </button>
          {palette && (
            <div
              className="absolute right-0 top-full z-10 mt-1 flex gap-1 rounded-md border border-line bg-paper p-1.5 shadow-lg"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {PALETTE.map((c) => (
                <button
                  key={c}
                  className="h-4 w-4 rounded-full ring-offset-1 hover:ring-2"
                  style={{ background: c }}
                  onClick={(e) => {
                    e.stopPropagation();
                    updateGroup(group.id, { color: c });
                    setPalette(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <button
          className="shrink-0 rounded p-0.5 hover:bg-white/20"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            removeGroup(group.id);
          }}
          title="解散这一组（节点保留）"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

export default function GroupLayer() {
  const groups = useWorkflowStore((s) => s.groups);
  const nodes = useWorkflowStore((s) => s.nodes);
  const updateGroup = useWorkflowStore((s) => s.updateGroup);
  const { getNodes } = useReactFlow();
  // 订阅 React Flow 的视口变换，让组框跟随画布平移/缩放
  const transform = useStore((s) => s.transform);

  // 节点实测尺寸（React Flow 渲染后写入 measured）
  const measured = new Map<string, { w: number; h: number }>();
  for (const n of getNodes()) {
    const w = n.measured?.width;
    const h = n.measured?.height;
    if (w && h) measured.set(n.id, { w, h });
  }

  // 组内成员被删除时，同步清理组的成员列表（组空了就自动消失）
  const removeGroupRef = useWorkflowStore((s) => s.removeGroup);
  useEffect(() => {
    const alive = new Set(nodes.map((n) => n.id));
    for (const g of groups) {
      const kept = g.nodeIds.filter((id) => alive.has(id));
      if (kept.length === g.nodeIds.length) continue;
      if (kept.length === 0) removeGroupRef(g.id);
      else updateGroup(g.id, { nodeIds: kept });
    }
  }, [nodes, groups, updateGroup, removeGroupRef]);

  if (groups.length === 0) return null;
  const [tx, ty, zoom] = transform;

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-0 h-full w-full overflow-hidden"
      // 组框画在节点下方（z-0），与 React Flow viewport 使用同一套变换
    >
      <div
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${zoom})`,
          transformOrigin: '0 0',
          position: 'absolute',
          inset: 0,
        }}
      >
        {groups
          // 折叠态的组交给 GroupProxyNode（带代理端口、双击进子图），这里不再渲染，避免两套逻辑冲突
          .filter((g) => !g.collapsed)
          .map((g) => {
          const members = nodes.filter((n) => g.nodeIds.includes(n.id));
          const box = g.collapsed
            ? (g.bounds ?? boundsOf(members, measured))
            : boundsOf(members, measured);
          if (!box) return null;
          // 折叠态：只保留标题条高度的一条
          const shown = g.collapsed ? { ...box, height: HEADER_H } : box;
          return <GroupBox key={g.id} group={g} box={shown} zoom={zoom} />;
        })}
      </div>
    </div>
  );
}
