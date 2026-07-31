import { useState } from 'react';
import {
  Boxes,
  Puzzle,
  Users,
  Variable,
  History,
  HelpCircle,
  Settings,
  Keyboard,
  PanelBottom,
  Sun,
  X,
  LayoutTemplate,
  type LucideIcon,
} from 'lucide-react';
import NodePalette from './NodePalette';
import PluginPanel from './PluginPanel';
import AgentPanel from './AgentPanel';
import VariablesPanel from './VariablesPanel';
import RunHistoryPanel from './RunHistoryPanel';
import ExamplesPanel from './ExamplesPanel';
import ShortcutsModal from './ShortcutsModal';

export type SidePanelKey =
  | 'nodes'
  | 'plugins'
  | 'agents'
  | 'variables'
  | 'history'
  | 'examples'
  | 'help';

interface PanelItem {
  key: SidePanelKey;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
}

// 上半部分：点击展开左侧面板内容（示例库改为独立次级窗口，不在此展开）
const PANEL_ITEMS: PanelItem[] = [
  { key: 'nodes', label: '节点库', icon: Boxes, shortcut: '' },
  { key: 'plugins', label: '插件', icon: Puzzle, shortcut: '' },
  { key: 'agents', label: '智能体库', icon: Users, shortcut: '' },
  { key: 'variables', label: '变量', icon: Variable, shortcut: '' },
  { key: 'history', label: '运行历史', icon: History, shortcut: '' },
];

// 下半部分：帮助中心（展开面板）/ 底部面板 / 快捷键查看 / 设置（从下到上）

/** 按面板 key 渲染对应内嵌内容（embedded 模式，去掉各自弹层） */
export function renderSidePanel(key: SidePanelKey) {
  switch (key) {
    case 'nodes':
      return <NodePalette embedded />;
    case 'plugins':
      return <PluginPanel embedded />;
    case 'agents':
      return <AgentPanel embedded />;
    case 'variables':
      return <VariablesPanel embedded />;
    case 'history':
      return <RunHistoryPanel embedded />;
    case 'help':
      return (
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <p className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>
            帮助中心
          </p>
          <button
            className="mt-3 flex w-full items-center gap-2 rounded border border-line px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-accent-soft/30"
            style={{ color: 'var(--sm-ink-soft)' }}
            title="（占位）即将上线"
          >
            <HelpCircle size={15} /> 帮助与支持
          </button>
          <p className="mt-3 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
            更多帮助内容即将上线。
          </p>
        </div>
      );
    default:
      return null;
  }
}

function IconButton({
  label,
  icon: Icon,
  shortcut,
  isActive,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={`${label}${shortcut ? ` (${shortcut})` : ''}`}
      className="group relative flex h-9 w-9 items-center justify-center rounded-md transition-colors"
      style={{
        color: isActive ? 'var(--sm-accent)' : 'var(--sm-ink-faint)',
        background: isActive ? 'color-mix(in srgb, var(--sm-accent) 14%, transparent)' : 'transparent',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = isActive
          ? 'color-mix(in srgb, var(--sm-accent) 14%, transparent)'
          : 'var(--sm-bg)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = isActive
          ? 'color-mix(in srgb, var(--sm-accent) 14%, transparent)'
          : 'transparent';
      }}
    >
      <Icon size={18} />
      <span
        className="pointer-events-none absolute left-11 z-50 flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-xs opacity-0 shadow-lg transition-opacity delay-150 group-hover:opacity-100"
        style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)', color: 'var(--sm-ink)' }}
      >
        {label}
        {shortcut && (
          <kbd className="rounded px-1 text-[10px]" style={{ background: 'var(--sm-bg-deep)', color: 'var(--sm-ink-faint)' }}>
            {shortcut}
          </kbd>
        )}
      </span>
    </button>
  );
}

interface SideRailProps {
  active: SidePanelKey | null;
  onClose: () => void;
  onOpen: (key: SidePanelKey) => void;
  onOpenExamples: () => void;
  examplesActive?: boolean;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  shortcutsOpen: boolean;
  onToggleShortcuts: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
}

/** 通栏图标条（Activity Bar）：贯穿整个高度，底部面板在其右侧打开，永不被遮盖 */
export function SideRail({
  active,
  onClose,
  onOpen,
  onOpenExamples,
  examplesActive,
  onOpenSettings,
  onToggleTheme,
  shortcutsOpen,
  onToggleShortcuts,
  panelOpen,
  onTogglePanel,
}: SideRailProps) {
  return (
    <nav
      className="flex w-12 shrink-0 flex-col items-center justify-between border-r py-2"
      style={{ borderColor: 'var(--sm-line)', background: 'var(--sm-bg-deep)' }}
    >
      {/* 上半：展开面板类（示例库为独立次级窗口，单独处理） */}
      <div className="flex flex-col items-center gap-1">
        <IconButton
          label="示例库"
          icon={LayoutTemplate}
          isActive={!!examplesActive}
          onClick={onOpenExamples}
        />
        {PANEL_ITEMS.map((it) => (
          <IconButton
            key={it.key}
            label={it.label}
            icon={it.icon}
            shortcut={it.shortcut}
            isActive={active === it.key}
            onClick={() => (active === it.key ? onClose() : onOpen(it.key))}
          />
        ))}
      </div>

      {/* 下半（从下到上）：帮助中心 / 底部面板 / 快捷键查看 / 深浅色 / 设置 */}
      <div className="flex flex-col items-center gap-1">
        <IconButton
          label="帮助中心"
          icon={HelpCircle}
          isActive={active === 'help'}
          onClick={() => (active === 'help' ? onClose() : onOpen('help'))}
        />
        <IconButton
          label="底部面板"
          icon={PanelBottom}
          isActive={panelOpen}
          onClick={onTogglePanel}
        />
        <IconButton
          label="快捷键查看"
          icon={Keyboard}
          isActive={shortcutsOpen}
          onClick={onToggleShortcuts}
        />
        <IconButton label="切换深浅色" icon={Sun} isActive={false} onClick={onToggleTheme} />
        <IconButton label="设置" icon={Settings} isActive={false} onClick={onOpenSettings} />
      </div>
    </nav>
  );
}

interface SidePanelProps {
  active: SidePanelKey | null;
  width: number;
  onResize: (w: number) => void;
  onClose: () => void;
}

/** 展开面板内容（位于图标条右侧的内容区第一行） */
export function SidePanel({ active, width, onResize, onClose }: SidePanelProps) {
  const item = PANEL_ITEMS.find((i) => i.key === active) ?? null;
  if (!item) return null;

  return (
    <div
      className="relative flex h-full min-h-0 flex-col border-r"
      style={{ width, background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
    >
      <div
        className="flex h-9 shrink-0 items-center justify-between border-b px-3"
        style={{ borderColor: 'var(--sm-line)' }}
      >
        <span className="text-[13px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
          {item.label}
        </span>
        <button
          className="cursor-pointer"
          style={{ color: 'var(--sm-ink-faint)' }}
          onClick={onClose}
          title="收起"
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">{renderSidePanel(item.key)}</div>

      {/* 拖拽调节宽度 */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = width;
          const onMove = (ev: MouseEvent) => {
            onResize(Math.min(420, Math.max(200, startW + (ev.clientX - startX))));
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
        className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize"
        style={{ background: 'transparent' }}
        title="拖动调节宽度"
      />
    </div>
  );
}

/** 兼容旧调用：左栏 = 图标条 + 展开面板（保留导出，App 现拆分为 SideRail / SidePanel） */
export default function LeftSidebar(props: SideRailProps & { width: number; onResize: (w: number) => void }) {
  return (
    <div className="flex h-full shrink-0" style={{ background: 'var(--sm-bg-soft)' }}>
      <SideRail {...props} />
      {props.active && (
        <SidePanel active={props.active} width={props.width} onResize={props.onResize} onClose={props.onClose} />
      )}
    </div>
  );
}
