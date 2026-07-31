import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ChevronRight, ChevronDown, Search } from 'lucide-react';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';
import { DND_MIME } from '../canvas/WorkflowEditor';
import { CATEGORY_ORDER } from '../nodes/builtin';
import type { NodeDefinition } from '../types';

/** 左侧节点面板（ComfyUI 风）：搜索 + 分类折叠，支持拖入画布或点击添加 */
export default function NodePalette({ width, embedded = false }: { width?: number; embedded?: boolean }) {
  const defs = useRegistryStore((s) => s.defs);
  const addNode = useWorkflowStore((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const map = new Map<string, NodeDefinition[]>();
    const q = query.trim().toLowerCase();
    for (const def of Object.values(defs)) {
      if (def.missing) continue;
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

  const addToCenter = (typeId: string) => {
    const center = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    addNode(typeId, {
      x: center.x - 112 + Math.random() * 40 - 20,
      y: center.y - 40 + Math.random() * 40 - 20,
    });
  };

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
        {groups.length === 0 && (
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
                      onClick={() => addToCenter(def.typeId)}
                      title={def.description}
                      className="sm-palette-item"
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
      </div>
    </aside>
  );
}
