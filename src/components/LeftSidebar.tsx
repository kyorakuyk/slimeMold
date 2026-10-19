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
  Archive,
  FolderTree,
  BarChart3,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import NodePalette from './NodePalette';
import TemplateSuggestions from './TemplateSuggestions';
import PluginPanel from './PluginPanel';
import AgentPanel from './AgentPanel';
import VariablesPanel from './VariablesPanel';
import RunHistoryPanel from './RunHistoryPanel';
import AssetsPanel from './AssetsPanel';
import GroupsPanel from './GroupsPanel';
import TokenUsagePanel from './TokenUsagePanel';
import OrchestratorPanel from './OrchestratorPanel';
import type { WorkerRuntime } from '../projectControl/workerRunCoordinator';
import { useT } from '../i18n/useT';

export type SidePanelKey =
  | 'nodes'
  | 'plugins'
  | 'agents'
  | 'variables'
  | 'history'
  | 'assets'
  | 'tokens'
  | 'groups'
  | 'examples'
  | 'orchestrator'
  | 'help';

interface PanelItem {
  key: SidePanelKey;
  labelKey: string;
  icon: LucideIcon;
  shortcut?: string;
}

// 上半部分：点击展开左侧面板内容（示例库改为独立次级窗口，不在此展开）
const PANEL_ITEMS: PanelItem[] = [
  { key: 'nodes', labelKey: 'sidebar.nodes', icon: Boxes, shortcut: '' },
  { key: 'groups', labelKey: 'sidebar.groups', icon: FolderTree, shortcut: '' },
  { key: 'plugins', labelKey: 'sidebar.plugins', icon: Puzzle, shortcut: '' },
  { key: 'agents', labelKey: 'sidebar.agents', icon: Users, shortcut: '' },
  { key: 'orchestrator', labelKey: 'sidebar.orchestrator', icon: Workflow, shortcut: '' },
  { key: 'assets', labelKey: 'sidebar.assets', icon: Archive, shortcut: '' },
  { key: 'variables', labelKey: 'sidebar.variables', icon: Variable, shortcut: '' },
  { key: 'history', labelKey: 'sidebar.history', icon: History, shortcut: '' },
  { key: 'tokens', labelKey: 'sidebar.tokens', icon: BarChart3, shortcut: '' },
];

// 下半部分：帮助中心（展开面板）/ 底部面板 / 快捷键查看 / 设置（从下到上）

/** 按面板 key 渲染对应内嵌内容（embedded 模式，去掉各自弹层） */
export type WorkerRecoveryHandler = (runId: string, decision: 'retry' | 'skip', reason: string, runtime?: WorkerRuntime) => Promise<void> | void;
export type WorkerCleanupHandler = (runId: string, taskId: string, action: 'approve' | 'cleanup') => Promise<void> | void;

export function renderSidePanel(
  key: SidePanelKey,
  actions: { onRecoverWorkerRun?: WorkerRecoveryHandler; onCleanupWorkerRun?: WorkerCleanupHandler } = {},
) {
  switch (key) {
    case 'nodes':
      return (
        <>
          <NodePalette embedded />
          <div className="px-2 pb-3">
            <TemplateSuggestions />
          </div>
        </>
      );
    case 'plugins':
      return <PluginPanel embedded />;
    case 'agents':
      return <AgentPanel variant="sidebar" />;
    case 'variables':
      return <VariablesPanel embedded />;
    case 'history':
      return <RunHistoryPanel variant="sidebar" />;
    case 'assets':
      return <AssetsPanel embedded />;
    case 'tokens':
      return <TokenUsagePanel embedded />;
    case 'groups':
      return <GroupsPanel embedded />;
    case 'orchestrator':
      return (
        <OrchestratorPanel
          embedded
          onRecoverWorkerRun={actions.onRecoverWorkerRun}
          onCleanupWorkerRun={actions.onCleanupWorkerRun}
        />
      );
    case 'help':
      return <HelpPanel />;
    default:
      return null;
  }
}

function HelpPanel() {
  const t = useT('panels');
  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      <p className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>
        {t('sidebar.helpCenter')}
      </p>
      <button
        className="mt-3 flex w-full items-center gap-2 rounded border border-line px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-accent-soft/30"
        style={{ color: 'var(--sm-ink-soft)' }}
        title={t('sidebar.helpPlaceholderTitle')}
      >
        <HelpCircle size={15} /> {t('sidebar.helpSupport')}
      </button>
      <p className="mt-3 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
        {t('sidebar.helpComingSoon')}
      </p>
    </div>
  );
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
      className="sm-pro-rail-button group relative flex h-9 w-9 items-center justify-center rounded-md transition-colors"
      data-active={isActive}
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
        className="sm-pro-tooltip pointer-events-none absolute left-11 z-50 flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-xs opacity-0 shadow-lg transition-opacity delay-150 group-hover:opacity-100"
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
  const t = useT('panels');
  return (
    <nav
      className="sm-pro-rail flex w-12 shrink-0 flex-col items-center justify-between border-r py-2"
      style={{ borderColor: 'var(--sm-line)', background: 'var(--sm-bg-deep)' }}
    >
      {/* 上半：展开面板类（示例库为独立次级窗口，单独处理） */}
      <div className="sm-pro-rail-section flex flex-col items-center gap-1">
        <IconButton
          label={t('sidebar.examples')}
          icon={LayoutTemplate}
          isActive={!!examplesActive}
          onClick={onOpenExamples}
        />
        {PANEL_ITEMS.map((it) => (
          <IconButton
            key={it.key}
            label={t(it.labelKey)}
            icon={it.icon}
            shortcut={it.shortcut}
            isActive={active === it.key}
            onClick={() => (active === it.key ? onClose() : onOpen(it.key))}
          />
        ))}
      </div>

      {/* 下半（从下到上）：帮助中心 / 底部面板 / 快捷键查看 / 深浅色 / 设置 */}
      <div className="sm-pro-rail-section sm-pro-rail-section-bottom flex flex-col items-center gap-1">
        <IconButton
          label={t('sidebar.helpCenter')}
          icon={HelpCircle}
          isActive={active === 'help'}
          onClick={() => (active === 'help' ? onClose() : onOpen('help'))}
        />
        <IconButton
          label={t('sidebar.bottomPanel')}
          icon={PanelBottom}
          isActive={panelOpen}
          onClick={onTogglePanel}
        />
        <IconButton
          label={t('sidebar.shortcuts')}
          icon={Keyboard}
          isActive={shortcutsOpen}
          onClick={onToggleShortcuts}
        />
        <IconButton label={t('sidebar.theme')} icon={Sun} isActive={false} onClick={onToggleTheme} />
        <IconButton label={t('sidebar.settings')} icon={Settings} isActive={false} onClick={onOpenSettings} />
      </div>
    </nav>
  );
}

interface SidePanelProps {
  active: SidePanelKey | null;
  width: number;
  onResize: (w: number) => void;
  onClose: () => void;
  onRecoverWorkerRun?: WorkerRecoveryHandler;
  onCleanupWorkerRun?: WorkerCleanupHandler;
}

/** 展开面板内容（位于图标条右侧的内容区第一行） */
export function SidePanel({
  active,
  width,
  onResize,
  onClose,
  onRecoverWorkerRun,
  onCleanupWorkerRun,
}: SidePanelProps) {
  const t = useT('panels');
  const item = PANEL_ITEMS.find((i) => i.key === active) ?? null;
  if (!item) return null;

  return (
    <div
      className="sm-pro-side-panel relative flex h-full min-h-0 shrink-0 flex-col border-r overflow-visible"
      style={{ width, background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
    >
      <div
        className="sm-pro-side-panel-header flex h-9 shrink-0 items-center justify-between border-b px-3"
        style={{ borderColor: 'var(--sm-line)' }}
      >
        <span className="sm-pro-side-panel-title text-[13px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
          {t(item.labelKey)}
        </span>
        <button
          className="sm-pro-side-panel-close cursor-pointer"
          style={{ color: 'var(--sm-ink-faint)' }}
          onClick={onClose}
          title={t('sidebar.collapse')}
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {renderSidePanel(item.key, { onRecoverWorkerRun, onCleanupWorkerRun })}
      </div>

      {/* 拖拽调节宽度：智能体面板（agents）内部已是「列表 + 编辑配置」两栏固定布局，
          其「编辑配置」次级子菜单不应被左右缩放，故禁用手柄 */}
      {active !== 'agents' && (
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
          title={t('sidebar.resize')}
        />
      )}
    </div>
  );
}

/** 兼容旧调用：左栏 = 图标条 + 展开面板（保留导出，App 现拆分为 SideRail / SidePanel） */
export default function LeftSidebar(props: SideRailProps & { width: number; onResize: (w: number) => void }) {
  return (
    <div className="sm-pro-sidebar flex h-full shrink-0" style={{ background: 'var(--sm-bg-soft)' }}>
      <SideRail {...props} />
      {props.active && (
        <SidePanel active={props.active} width={props.width} onResize={props.onResize} onClose={props.onClose} />
      )}
    </div>
  );
}
