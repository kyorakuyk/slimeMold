import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { Folder, FolderOpen, Trash2, Crosshair, ChevronRight, ChevronDown, Box } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';

/** 左侧「组」面板：以文件夹形式列出画布上所有分组，展开可查看成员节点 */
export default function GroupsPanel({ embedded = false }: { embedded?: boolean }) {
  const groups = useWorkflowStore((s) => s.groups ?? []);
  const nodes = useWorkflowStore((s) => s.nodes);
  const removeGroup = useWorkflowStore((s) => s.removeGroup);
  const setSelected = useWorkflowStore((s) => s.setSelected);
  const { fitView } = useReactFlow();

  const [open, setOpen] = useState<Record<string, boolean>>({});

  // 建立 nodeId -> { label, typeId } 映射，供文件夹内展示成员
  const nodeMap = useMemo(() => {
    const m = new Map<string, { label: string; typeId: string }>();
    for (const n of nodes) {
      const d = (n.data ?? {}) as { label?: string };
      m.set(n.id, { label: d.label ?? n.id, typeId: n.type as string });
    }
    return m;
  }, [nodes]);

  // 游离节点：不属于任何分组的节点
  const freeNodes = useMemo(() => {
    const grouped = new Set<string>();
    for (const g of groups) for (const id of g.nodeIds) grouped.add(id);
    return nodes
      .filter((n) => !grouped.has(n.id))
      .map((n) => ({ id: n.id, info: nodeMap.get(n.id) }))
      .filter((m) => m.info);
  }, [nodes, groups, nodeMap]);

  const focusGroup = (nodeIds: string[]) => {
    if (nodeIds.length === 0) return;
    window.setTimeout(
      () => fitView({ nodes: nodeIds.map((id) => ({ id })), duration: 350, padding: 0.3 }),
      0,
    );
  };

  const selectMember = (id: string) => {
    setSelected(id);
    focusGroup([id]);
  };

  return (
    <aside
      className="flex h-full min-h-0 flex-col"
      style={embedded ? { background: 'var(--sm-bg-soft)' } : undefined}
    >
      {!embedded && (
        <div className="border-b px-3 py-2.5" style={{ borderColor: 'var(--sm-line)' }}>
          <h2 className="text-[13px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
            组
          </h2>
          <p className="mt-0.5 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
            画布上所有分组的文件夹视图
          </p>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {groups.length === 0 && (
          <p className="px-1 py-3 text-[11px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
            画布上还没有分组。框选若干节点 → 右键 →「编组」即可创建。
          </p>
        )}

        {groups.map((g) => {
          const isOpen = open[g.id];
          const members = g.nodeIds
            .map((id) => ({ id, info: nodeMap.get(id) }))
            .filter((m) => m.info);
          return (
            <section key={g.id} className="mb-1.5">
              {/* 文件夹行 */}
              <div
                className="group/g flex items-center gap-1.5 rounded px-1.5 py-1.5"
                style={{ borderLeft: `3px solid ${g.color}` }}
              >
                <button
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  onClick={() => setOpen((o) => ({ ...o, [g.id]: !o[g.id] }))}
                  title={g.title}
                >
                  {isOpen ? (
                    <ChevronDown size={13} className="shrink-0" style={{ color: 'var(--sm-ink-faint)' }} />
                  ) : (
                    <ChevronRight size={13} className="shrink-0" style={{ color: 'var(--sm-ink-faint)' }} />
                  )}
                  {isOpen ? (
                    <FolderOpen size={15} className="shrink-0" style={{ color: g.color }} />
                  ) : (
                    <Folder size={15} className="shrink-0" style={{ color: g.color }} />
                  )}
                  <span className="truncate text-[13px]" style={{ color: 'var(--sm-ink)' }}>
                    {g.title}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] normal-case" style={{ color: 'var(--sm-ink-faint)' }}>
                    {members.length}
                  </span>
                </button>
                <button
                  className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-[var(--sm-bg)] group-hover/g:opacity-100"
                  style={{ color: 'var(--sm-ink-faint)' }}
                  title="聚焦到该组"
                  onClick={() => focusGroup(g.nodeIds)}
                >
                  <Crosshair size={13} />
                </button>
                <button
                  className="shrink-0 rounded p-1 opacity-0 transition-opacity hover:bg-[var(--sm-bg)] group-hover/g:opacity-100"
                  style={{ color: 'var(--sm-ink-faint)' }}
                  title="删除这个分组（不影响组内节点）"
                  onClick={() => removeGroup(g.id)}
                >
                  <Trash2 size={13} />
                </button>
              </div>

              {/* 成员列表 */}
              {isOpen && (
                <ul className="ml-5 mt-0.5 space-y-0.5 border-l pl-2" style={{ borderColor: 'var(--sm-line)' }}>
                  {members.length === 0 && (
                    <li className="px-1 py-1 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
                      （空组）
                    </li>
                  )}
                  {members.map((m) => (
                    <li key={m.id}>
                      <button
                        className="flex w-full items-center gap-1.5 truncate rounded px-1.5 py-1 text-left hover:bg-[var(--sm-bg)]"
                        onClick={() => selectMember(m.id)}
                        title={`${m.info!.label} · ${m.info!.typeId}`}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: g.color }} />
                        <span className="truncate text-[12px]" style={{ color: 'var(--sm-ink-soft)' }}>
                          {m.info!.label}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}

        {/* 游离节点：每个未分组节点作为与分组同层的一项平铺 */}
        {freeNodes.map((m) => (
          <section key={m.id} className="mb-1.5">
            <button
              className="group/f flex w-full items-center gap-1.5 rounded px-1.5 py-1.5 text-left"
              style={{ borderLeft: '3px solid var(--sm-line)' }}
              onClick={() => selectMember(m.id)}
              title={`${m.info!.label} · ${m.info!.typeId}（未分组）`}
            >
              <Box size={15} className="shrink-0" style={{ color: 'var(--sm-ink-faint)' }} />
              <span className="truncate text-[13px]" style={{ color: 'var(--sm-ink)' }}>
                {m.info!.label}
              </span>
              <span className="ml-auto shrink-0 text-[10px] normal-case" style={{ color: 'var(--sm-ink-faint)' }}>
                1
              </span>
            </button>
          </section>
        ))}
      </div>
    </aside>
  );
}
