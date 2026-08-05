import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Boxes } from 'lucide-react';
import { useRegistryStore } from '../store/registryStore';
import { useWorkflowStore } from '../store/workflowStore';
import { SUBGRAPH_REF_TYPE } from '../engine/subgraph';
import { useT } from '../i18n/useT';

export interface PickPayload {
  kind: 'node' | 'subgraph';
  id: string;
}

interface Props {
  screenPos: { x: number; y: number };
  onSelect: (payload: PickPayload) => void;
  onClose: () => void;
}

/** 节点选择窗：仿「示例库」居中弹窗样式，右上角关闭按钮，点遮罩关闭 */
export function NodePickerModal({ onSelect, onClose }: Props) {
  const t = useT('modals');
  const defs = useRegistryStore((s) => s.defs);
  const subgraphs = useWorkflowStore((s) => s.subgraphs);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const nodeItems = Object.values(defs)
      .filter((d) => !d.typeId.startsWith(`${SUBGRAPH_REF_TYPE}:`))
      .map((d) => ({
        key: `n:${d.typeId}`,
        kind: 'node' as const,
        id: d.typeId,
        label: d.name,
        category: d.category,
        desc: d.description,
      }));
    const sgItems = Object.values(subgraphs).map((sg) => ({
      key: `s:${sg.id}`,
      kind: 'subgraph' as const,
      id: sg.id,
      label: sg.name,
      category: t('nodePicker.mySubgraph'),
      desc: t('nodePicker.steps', { count: sg.nodes.length }),
    }));
    const all = [...nodeItems, ...sgItems];
    if (!q) return all;
    return all.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.category.toLowerCase().includes(q) ||
        (it.desc ?? '').toLowerCase().includes(q),
    );
  }, [defs, subgraphs, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    setActive(0);
  }, [query]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const clampedActive = Math.min(active, Math.max(0, items.length - 1));

  const choose = (idx: number) => {
    const it = items[idx];
    if (!it) return;
    onSelect({ kind: it.kind, id: it.id });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(clampedActive);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: 'color-mix(in srgb, #000 45%, transparent)' }}
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[min(80vh,560px)] w-[min(92vw,680px)] flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div
          className="flex h-12 shrink-0 items-center justify-between border-b px-4"
          style={{ borderColor: 'var(--sm-line)' }}
        >
          <div>
            <p className="text-[14px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
              {t('nodePicker.title')}
            </p>
            <p className="text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
              {t('nodePicker.subtitle')}
            </p>
          </div>
          <button
            className="cursor-pointer rounded-md p-1 transition-colors"
            style={{ color: 'var(--sm-ink-faint)' }}
            onClick={onClose}
            title={t('common.close')}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--sm-bg-deep)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <X size={16} />
          </button>
        </div>

        {/* 搜索框 */}
        <div
          className="flex shrink-0 items-center gap-2 border-b px-4 py-2"
          style={{ borderColor: 'var(--sm-line)' }}
        >
          <Search size={14} style={{ color: 'var(--sm-ink-faint)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('nodePicker.searchPlaceholder')}
            className="w-full bg-transparent text-[13px] outline-none"
            style={{ color: 'var(--sm-ink)' }}
          />
        </div>

        {/* 节点网格 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {items.length === 0 ? (
            <p className="px-1 py-6 text-center text-[12px]" style={{ color: 'var(--sm-ink-faint)' }}>
              {t('nodePicker.noMatch')}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {items.map((it, idx) => (
                <button
                  key={it.key}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => choose(idx)}
                  className="flex flex-col rounded-xl border p-2.5 text-left transition-all duration-150"
                  style={{
                    background: idx === clampedActive ? 'var(--sm-bg-deep)' : 'var(--sm-bg-soft)',
                    borderColor: idx === clampedActive ? 'var(--sm-accent)' : 'var(--sm-line)',
                  }}
                >
                  <div className="flex items-center gap-2">
                    {it.kind === 'subgraph' ? (
                      <Boxes size={13} style={{ color: 'var(--sm-ink-faint)' }} />
                    ) : (
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ background: 'var(--sm-cat, #4dabf7)' }}
                      />
                    )}
                    <span
                      className="flex-1 truncate text-[12.5px] font-semibold leading-tight"
                      style={{ color: 'var(--sm-ink)' }}
                    >
                      {it.label}
                    </span>
                  </div>
                  <span className="mt-1.5 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                    {it.category}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
