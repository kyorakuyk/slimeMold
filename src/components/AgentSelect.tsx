import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Check, Search, X } from 'lucide-react';
import type { AgentConfig } from '../types';
import { useT } from '../i18n/useT';

/**
 * 通用 Agent 选择器（单选 / 多选可配，带搜索框，自绘下拉面板）。
 * - 单选：触发框显示选中 agent 名，点开搜索+列表。
 * - 多选：触发框显示可移除的 tag（×），点开搜索+勾选列表。
 * 值始终为真实 agent id：单选为 id，多选为逗号分隔 id。
 */
export function AgentSelect({
  agents,
  value,
  onChange,
  placeholder,
  multiple,
}: {
  agents: AgentConfig[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiple?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedIds = useMemo(
    () =>
      multiple
        ? String(value ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : value
          ? [String(value)]
          : [],
    [value, multiple],
  );

  const byId = useMemo(() => {
    const m = new Map<string, AgentConfig>();
    for (const a of agents) m.set(a.id, a);
    return m;
  }, [agents]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name?.toLowerCase().includes(q) ||
        a.model?.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q),
    );
  }, [agents, query]);

  // 点击外部关闭 + Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggleOpen = () => {
    setOpen((o) => {
      const next = !o;
      if (next) {
        setQuery('');
        requestAnimationFrame(() => searchRef.current?.focus());
      }
      return next;
    });
  };

  const pick = (id: string) => {
    if (multiple) {
      const next = selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id];
      onChange(next.join(','));
    } else {
      onChange(id);
      setOpen(false);
    }
  };

  const removeTag = (id: string) => {
    if (multiple) {
      onChange(selectedIds.filter((x) => x !== id).join(','));
    }
  };

  const removeAll = () => {
    if (multiple) onChange('');
  };

  return (
    <div ref={rootRef} className="relative">
      {/* 触发框 */}
      <button
        type="button"
        onClick={toggleOpen}
        className="sm-input flex min-h-[30px] cursor-pointer items-center gap-1 text-left"
        style={{ padding: '4px 8px' }}
      >
        {multiple && selectedIds.length > 0 ? (
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {selectedIds.map((id) => {
              const a = byId.get(id);
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded bg-black/10 px-1.5 py-0.5 text-[11px]"
                  style={{ color: 'var(--sm-ink)' }}
                >
                  <span className="max-w-[120px] truncate">{a?.name ?? id}</span>
                  <button
                    type="button"
                    className="opacity-60 hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeTag(id);
                    }}
                    title="移除"
                  >
                    <X size={11} />
                  </button>
                </span>
              );
            })}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">
            {selectedIds.length > 0
              ? (byId.get(selectedIds[0])?.name ?? selectedIds[0])
              : (placeholder ?? t('param.agent.placeholder'))}
          </span>
        )}
        {multiple && selectedIds.length > 0 && (
          <button
            type="button"
            className="opacity-50 hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              removeAll();
            }}
            title="清空"
          >
            <X size={13} />
          </button>
        )}
        <ChevronDown size={14} className="shrink-0 opacity-50" />
      </button>

      {/* 下拉面板 */}
      {open && (
        <div
          className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-lg border shadow-lg"
          style={{ borderColor: 'var(--sm-line)', background: 'var(--sm-bg)' }}
        >
          <div className="flex items-center gap-1 border-b px-2" style={{ borderColor: 'var(--sm-line)' }}>
            <Search size={13} className="shrink-0 opacity-50" />
            <input
              ref={searchRef}
              className="w-full bg-transparent py-1.5 text-[12px] outline-none"
              style={{ color: 'var(--sm-ink)' }}
              placeholder={t('param.agent.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="max-h-[220px] overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-[12px]" style={{ color: 'var(--sm-ink-faint)' }}>
                {t('param.agent.empty')}
              </p>
            ) : (
              filtered.map((a) => {
                const checked = selectedIds.includes(a.id);
                return (
                  <button
                    key={a.id}
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-black/5"
                    style={{ color: 'var(--sm-ink)' }}
                    onClick={() => pick(a.id)}
                  >
                    <span
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border"
                      style={{ borderColor: 'var(--sm-line)' }}
                    >
                      {checked && <Check size={11} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    <span className="truncate text-[10px] opacity-60">{a.model}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
