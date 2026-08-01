import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ChevronRight, ChevronDown, Search, Boxes, Trash2 } from 'lucide-react';
import { NamePrompt } from './NamePrompt';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';
import { DND_MIME } from '../canvas/WorkflowEditor';
import { CATEGORY_ORDER } from '../nodes/builtin';
import { SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import type { NodeDefinition } from '../types';

/** 左侧节点面板（ComfyUI 风）：搜索 + 分类折叠，支持拖入画布或点击添加 */
export default function NodePalette({ width, embedded = false }: { width?: number; embedded?: boolean }) {
  const defs = useRegistryStore((s) => s.defs);
  const { screenToFlowPosition } = useReactFlow();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const groups = useMemo(() => {
    const map = new Map<string, NodeDefinition[]>();
    const q = query.trim().toLowerCase();
    for (const def of Object.values(defs)) {
      if (def.missing) continue;
      // 子图节点不能凭空添加（必须指定引用哪个子图），统一在下方「我的子图」分区里列出
      if (def.typeId === SUBGRAPH_REF_TYPE) continue;
      if (q && !`${def.name} ${def.description ?? ''} ${def.category}`.toLowerCase().includes(q))
        continue;
      const list = map.get(def.category) ?? [];
      list.push(def);
      map.set(def.category, list);
    }
    // 按 Community 友好分类顺序排列，未列出的分类排到最后
    const ordered = Array.from(map.entries()).sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a[0] as (typeof CATEGORY_ORDER)[number]);
      const ib = CATEGORY_ORDER.indexOf(b[0] as (typeof CATEGORY_ORDER)[number]);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    return ordered;
  }, [defs, query]);

  // 项目内已打包的子图，按名称/描述参与同一个搜索框过滤
  const subgraphs = useWorkflowStore((s) => s.subgraphs);
  const addSubgraphRef = useWorkflowStore((s) => s.addSubgraphRefNode);
  const removeSubgraph = useWorkflowStore((s) => s.removeSubgraph);
  const renameSubgraph = useWorkflowStore((s) => s.renameSubgraph);
  const [sgCollapsed, setSgCollapsed] = useState(false);

  const subgraphList = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(subgraphs)
      .filter((sg) => !q || `${sg.name} ${sg.description ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }, [subgraphs, query]);

  const searchBox = (
    <div className="relative mt-2">
      <Search
        size={13}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
        style={{ color: 'var(--sm-ink-faint)' }}
      />
      <input
        className="sm-palette-search w-full pl-7"
        value={query}
        placeholder="搜索节点…"
        onChange={(e) => setQuery(e.target.value)}
      />
    </div>
  );

  return (
    <aside
      className="flex h-full min-h-0 flex-col"
      style={width ? { width, background: 'var(--sm-bg-soft)', borderColor: 'var(--sm-line)', borderRight: '1px solid var(--sm-line)' } : undefined}
    >
      {!embedded && (
        <div className="border-b px-3 py-2.5" style={{ borderColor: 'var(--sm-line)' }}>
          <h2 className="text-[13px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
            节点库
          </h2>
          {searchBox}
        </div>
      )}
      {embedded && <div className="border-b px-2 py-1.5" style={{ borderColor: 'var(--sm-line)' }}>{searchBox}</div>}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {groups.length === 0 && subgraphList.length === 0 && (
          <p className="px-1 py-3 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
            无匹配节点
          </p>
        )}
        {groups.map(([category, list]) => {
          const isCollapsed = collapsed[category];
          return (
            <section key={category} className="mb-2">
              <button
                className="sm-palette-cat"
                onClick={() =>
                  setCollapsed((c) => ({ ...c, [category]: !c[category] }))
                }
              >
                {isCollapsed ? (
                  <ChevronRight size={13} />
                ) : (
                  <ChevronDown size={13} />
                )}
                {category}
                <span className="ml-auto text-[10px] normal-case">{list.length}</span>
              </button>
              {!isCollapsed && (
                <ul className="mt-1 space-y-1">
                  {list.map((def) => (
                    <li
                      key={def.typeId}
                      draggable
                      onDragStart={(e) => e.dataTransfer.setData(DND_MIME, def.typeId)}
                      title={`${def.description || def.name}\n拖入画布以添加节点`}
                      className="sm-palette-item cursor-grab"
                    >
                      <p className="text-[13px]" style={{ color: 'var(--sm-ink)' }}>
                        {def.name}
                      </p>
                      {def.description && (
                        <p className="mt-0.5 line-clamp-1 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
                          {def.description}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}

        {/* 我的子图：把打包好的节点组合当作一个节点复用 */}
        {subgraphList.length > 0 && (
          <section className="mb-2">
            <button className="sm-palette-cat" onClick={() => setSgCollapsed((v) => !v)}>
              {sgCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              我的子图
              <span className="ml-auto text-[10px] normal-case">{subgraphList.length}</span>
            </button>
            {!sgCollapsed && (
              <ul className="mt-1 space-y-1">
                {subgraphList.map((sg) => (
                  <li
                    key={sg.id}
                    draggable
                    onDragStart={(e) =>
                      e.dataTransfer.setData(DND_MIME, `${SUBGRAPH_REF_TYPE}:${sg.id}`)
                    }
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenaming({ id: sg.id, name: sg.name });
                    }}
                    title={`${sg.nodes.length} 个步骤 · ${sg.inputs.length} 入 / ${sg.outputs.length} 出\n双击可重命名`}
                    className="sm-palette-item group/sg relative"
                  >
                    <p
                      className="flex items-center gap-1.5 pr-5 text-[13px]"
                      style={{ color: 'var(--sm-ink)' }}
                    >
                      <Boxes size={12} style={{ color: 'var(--sm-ink-faint)' }} />
                      <span className="truncate">{sg.name}</span>
                    </p>
                    <p className="mt-0.5 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
                      {sg.nodes.length} 个步骤 · {sg.inputs.length} 入 / {sg.outputs.length} 出
                    </p>
                    <button
                      className="absolute right-1.5 top-1.5 rounded p-1 opacity-0 transition-opacity hover:bg-[var(--sm-bg)] group-hover/sg:opacity-100"
                      style={{ color: 'var(--sm-ink-faint)' }}
                      title="删除这个子图（画布上已放置的引用会失效）"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeSubgraph(sg.id);
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      {renaming && (
        <NamePrompt
          title="重命名子图"
          initial={renaming.name}
          onConfirm={(name) => {
            renameSubgraph(renaming.id, name);
            setRenaming(null);
          }}
          onCancel={() => setRenaming(null)}
        />
      )}
      </div>
    </aside>
  );
}
