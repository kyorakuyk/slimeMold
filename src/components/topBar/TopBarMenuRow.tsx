import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  LayoutDashboard,
  PanelBottom,
  PanelLeft,
  PanelRight,
} from 'lucide-react';
import slimeMoldIcon from '../../assets/slimemold-dense-ic-state.svg';
import { useT } from '../../i18n/useT';

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface MenuDef {
  label: string;
  items: (MenuAction | 'separator' | { type: 'submenu'; label: string; icon?: ReactNode; items: MenuAction[] })[];
}

interface TopBarMenuRowProps {
  menus: MenuDef[];
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onOpenSimpleView: () => void;
  replayMode: boolean;
}

export default function TopBarMenuRow({
  menus,
  sidebarOpen,
  onToggleSidebar,
  panelOpen,
  onTogglePanel,
  inspectorOpen,
  onToggleInspector,
  onOpenSimpleView,
  replayMode,
}: TopBarMenuRowProps) {
  const t = useT();
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
        setOpenSub(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenu(null);
        setOpenSub(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div ref={menuRef} className="sm-pro-menu-row flex h-8 items-center px-2">
      <span className="sm-pro-brand mr-2 select-none px-2 text-[13px] font-semibold tracking-wide text-ink">
        <img className="sm-pro-brand__icon" src={slimeMoldIcon} alt="" aria-hidden="true" />
        <span>SlimeMold</span>
      </span>
      {menus.map((m, i) => (
        <div key={m.label} className="relative">
          <button
            className={`sm-pro-menu-button rounded px-2.5 py-1 text-[12.5px] transition-colors ${
              openMenu === i ? '' : 'text-ink-soft hover:bg-black/10'
            }`}
            data-active={openMenu === i}
            style={openMenu === i ? { background: 'color-mix(in srgb, var(--sm-accent) 14%, transparent)', color: 'var(--sm-accent)' } : undefined}
            onClick={() => {
              setOpenMenu(openMenu === i ? null : i);
              setOpenSub(null);
            }}
            onMouseEnter={() => openMenu !== null && setOpenMenu(i)}
          >
            {m.label}
          </button>
          {openMenu === i && (
            <div
              className="sm-pro-menu absolute left-0 top-full z-50 min-w-[210px] rounded-md border py-1 shadow-lg"
              style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
            >
              {m.items.map((it, j) => {
                if (it === 'separator')
                  return <div key={j} className="my-1 h-px" style={{ background: 'var(--sm-line)' }} />;
                if ('type' in it && it.type === 'submenu') {
                  return (
                    <div
                      key={j}
                      className="relative"
                      onMouseEnter={() => setOpenSub(j)}
                    >
                      <button
                        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-ink-soft hover:bg-black/10"
                        onClick={() => setOpenSub(openSub === j ? null : j)}
                      >
                        <span className="flex w-4 justify-center">{it.icon}</span>
                        <span className="flex-1">{it.label}</span>
                        <span className="text-ink-faint">▸</span>
                      </button>
                      {openSub === j && (
                        <div
                          className="sm-pro-menu absolute left-full top-0 z-50 min-w-[200px] rounded-md border py-1 shadow-lg"
                          style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)', marginLeft: 2 }}
                        >
                          {it.items.map((sub, k) => (
                            <button
                              key={k}
                              disabled={sub.disabled}
                              className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] ${
                                sub.disabled ? 'cursor-not-allowed text-ink-faint opacity-50' : sub.danger ? 'text-err hover:bg-err/10' : 'text-ink-soft hover:bg-black/10'
                              }`}
                              onClick={() => {
                                if (sub.disabled) return;
                                sub.onClick();
                                setOpenMenu(null);
                                setOpenSub(null);
                              }}
                            >
                              <span className="flex-1">{sub.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }
                if ('type' in it) return null;
                return (
                  <button
                    key={j}
                    disabled={it.disabled}
                    className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                      it.disabled
                        ? 'cursor-not-allowed text-ink-faint opacity-50'
                        : it.danger
                          ? 'text-err hover:bg-err/10'
                          : 'text-ink-soft hover:bg-black/10'
                    }`}
                    onClick={() => {
                      if (it.disabled) return;
                      it.onClick();
                      setOpenMenu(null);
                    }}
                  >
                    <span className="flex w-4 justify-center">{it.icon}</span>
                    <span className="flex-1">{it.label}</span>
                    {it.shortcut && <span className="text-[11px] text-ink-faint">{it.shortcut}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}

      <div className="sm-pro-header-actions ml-auto flex items-center gap-1">
        <button
          className="sm-btn h-6 px-2 disabled:cursor-not-allowed disabled:opacity-50"
          title={t('topbar.simpleView')}
          disabled={replayMode}
          onClick={onOpenSimpleView}
        >
          <LayoutDashboard size={14} />
          <span className="hidden xl:inline">{t('topbar.simpleView')}</span>
        </button>
        <button
          className="flex h-6 w-7 items-center justify-center rounded transition-colors hover:bg-black/10"
          title={t('topbar.toggleLeft')}
          onClick={onToggleSidebar}
          style={
            sidebarOpen
              ? { color: 'var(--sm-accent)', background: 'color-mix(in srgb, var(--sm-accent) 14%, transparent)' }
              : { color: 'var(--sm-ink-faint)' }
          }
        >
          <PanelLeft size={14} />
        </button>
        <button
          className="flex h-6 w-7 items-center justify-center rounded transition-colors hover:bg-black/10"
          title={t('topbar.toggleBottom')}
          onClick={onTogglePanel}
          style={
            panelOpen
              ? { color: 'var(--sm-accent)', background: 'color-mix(in srgb, var(--sm-accent) 14%, transparent)' }
              : { color: 'var(--sm-ink-faint)' }
          }
        >
          <PanelBottom size={14} />
        </button>
        <button
          className="flex h-6 w-7 items-center justify-center rounded transition-colors hover:bg-black/10"
          title={t('topbar.toggleInspector')}
          onClick={onToggleInspector}
          style={
            inspectorOpen
              ? { color: 'var(--sm-accent)', background: 'color-mix(in srgb, var(--sm-accent) 14%, transparent)', }
              : { color: 'var(--sm-ink-faint)' }
          }
        >
          <PanelRight size={14} />
        </button>
      </div>
    </div>
  );
}
