/**
 * 折叠分组的「代理节点」：在画布上以一个 React Flow 节点呈现，
 * 左右两侧按「端口类型」聚合生成虚拟端口（ProxyHandle），
 * 外部连线多对一连到这些聚合端口；双击进入子图编辑视图。
 */
import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { ChevronRight, Palette, X } from 'lucide-react';
import type { NodeGroup, ProxyPort } from '../../types';
import { useViewStore } from '../../store/viewStore';
import { useWorkflowStore } from '../../store/workflowStore';

export type GroupProxyData = {
  group: NodeGroup;
  /** 折叠态时成员节点的包围盒位置（节点坐标） */
  box: { x: number; y: number; width: number; height: number };
};

const PORT_COLOR: Record<string, string> = {
  exec: '#ffd43b',
  text: '#4dabf7',
  image: '#69db7c',
  img: '#69db7c',
  number: '#ffa94d',
  boolean: '#da77f2',
  bool: '#da77f2',
  audio: '#ff6b6b',
  list: '#4dd4ff',
  json: '#f783ac',
  any: '#9aa0a6',
};

function portColor(p: ProxyPort): string {
  return PORT_COLOR[p.type ?? 'any'] ?? PORT_COLOR.any;
}

function portLabel(p: ProxyPort): string {
  return p.label || p.type || 'any';
}

function GroupProxyNodeImpl({ data, selected }: NodeProps) {
  const { group, box } = data as GroupProxyData;
  const setFocusedSubgraph = useViewStore((s) => s.setFocusedSubgraph);
  const toggleGroupCollapsed = useWorkflowStore((s) => s.toggleGroupCollapsed);
  const removeGroup = useWorkflowStore((s) => s.removeGroup);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.title);

  const inputs = (group.proxyPorts ?? []).filter((p) => p.kind === 'input');
  const outputs = (group.proxyPorts ?? []).filter((p) => p.kind === 'output');

  const commit = () => {
    setEditing(false);
    const t = draft.trim();
    // 改名走 store 在外面处理；这里只回写本地显示
    if (t) (data as GroupProxyData).group = { ...group, title: t };
  };

  return (
    <div
      className={`sm-group-collapsed ${selected ? 'selected' : ''}`}
      style={{ ['--grp' as string]: group.color, width: Math.max(168, box.width) }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (group.subgraphId) setFocusedSubgraph(group.subgraphId);
      }}
      title="双击进入子图编辑"
    >
      {/* 左侧聚合输入端口（端点按类型标注） */}
      {inputs.map((p, i) => (
        <div
          key={p.id}
          className="absolute flex items-center gap-1"
          style={{
            left: -2,
            top: `${((i + 1) / (inputs.length + 1)) * 100}%`,
            transform: 'translateY(-50%)',
          }}
        >
          <Handle
            id={p.id}
            type="target"
            position={Position.Left}
            style={{
              position: 'relative',
              left: 0,
              transform: 'none',
              background: portColor(p),
              width: 11,
              height: 11,
              border: '2px solid #fff',
            }}
          />
          <span
            className="rounded px-1 text-[10px] font-medium leading-none"
            style={{ color: portColor(p) }}
          >
            {portLabel(p)}
          </span>
        </div>
      ))}
      {/* 右侧聚合输出端口（端点按类型标注） */}
      {outputs.map((p, i) => (
        <div
          key={p.id}
          className="absolute flex items-center gap-1"
          style={{
            right: -2,
            top: `${((i + 1) / (outputs.length + 1)) * 100}%`,
            transform: 'translateY(-50%)',
          }}
        >
          <span
            className="rounded px-1 text-[10px] font-medium leading-none"
            style={{ color: portColor(p) }}
          >
            {portLabel(p)}
          </span>
          <Handle
            id={p.id}
            type="source"
            position={Position.Right}
            style={{
              position: 'relative',
              right: 0,
              transform: 'none',
              background: portColor(p),
              width: 11,
              height: 11,
              border: '2px solid #fff',
            }}
          />
        </div>
      ))}

      <div className="sm-group-header">
        <span className="sm-group-dot" />
        {editing ? (
          <input
            autoFocus
            className="min-w-0 flex-1 rounded bg-white/25 px-1 text-[12px] text-white outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setDraft(group.title);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="sm-group-title" onDoubleClick={(e) => e.stopPropagation()}>
            {group.title}
          </span>
        )}
        <span className="sm-group-cat">组</span>
        <button
          className="sm-group-expand-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            removeGroup(group.id);
          }}
          title="解散这一组（节点保留）"
        >
          <X size={14} />
        </button>
        <button
          className="sm-group-expand-btn"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            toggleGroupCollapsed(group.id);
          }}
          title="展开这一组"
        >
          <ChevronRight size={15} />
          <span>展开</span>
        </button>
      </div>
      <div className="sm-group-body">
        <span className="sm-group-count">
          含 {group.nodeIds.length} 个节点 · {inputs.length} 入 / {outputs.length} 出
        </span>
      </div>
    </div>
  );
}

export default memo(GroupProxyNodeImpl);
