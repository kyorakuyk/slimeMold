import { useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';
import { DND_MIME } from '../canvas/WorkflowEditor';
import type { NodeDefinition } from '../types';

/** 左侧节点面板：分类列出内置与插件节点，支持拖入画布或点击添加 */
export default function NodePalette() {
  const defs = useRegistryStore((s) => s.defs);
  const addNode = useWorkflowStore((s) => s.addNode);
  const { screenToFlowPosition } = useReactFlow();

  const groups = useMemo(() => {
    const map = new Map<string, NodeDefinition[]>();
    for (const def of Object.values(defs)) {
      if (def.missing) continue;
      const list = map.get(def.category) ?? [];
      list.push(def);
      map.set(def.category, list);
    }
    return Array.from(map.entries());
  }, [defs]);

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

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-r border-line bg-paper-soft">
      <div className="border-b border-line px-3 py-2.5">
        <h2 className="text-[13px] font-semibold text-ink">节点库</h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">拖拽到画布，或点击添加</p>
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {groups.map(([category, list]) => (
          <section key={category} className="mb-3">
            <h3 className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
              {category}
            </h3>
            <ul className="space-y-1">
              {list.map((def) => (
                <li
                  key={def.typeId}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData(DND_MIME, def.typeId)}
                  onClick={() => addToCenter(def.typeId)}
                  title={def.description}
                  className="cursor-grab rounded border border-line bg-white px-2.5 py-1.5 transition-colors hover:border-accent-soft active:cursor-grabbing"
                >
                  <p className="text-[13px] text-ink">{def.name}</p>
                  {def.description && (
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-ink-faint">
                      {def.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
