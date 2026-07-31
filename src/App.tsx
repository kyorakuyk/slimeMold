import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { X, Keyboard } from 'lucide-react';
import TopBar from './components/TopBar';
import Inspector from './components/Inspector';
import StatusBar from './components/StatusBar';
import SettingsModal from './components/SettingsModal';
import { SideRail, SidePanel, type SidePanelKey } from './components/LeftSidebar';
import ShortcutsModal from './components/ShortcutsModal';
import WorkflowEditor from './canvas/WorkflowEditor';
import { registerBuiltins } from './nodes/builtin';
import { scanPluginsDir } from './plugins/pluginManager';
import { isTauri } from './platform/env';
import { exportWorkflow } from './io/workflowIO';
import { useWorkflowStore } from './store/workflowStore';
import { useViewStore } from './store/viewStore';

registerBuiltins();

/** 拆分视图：在画布右侧并排显示当前工作流的节点概览（辅助视图） */
function SplitViewPanel() {
  const nodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);
  return (
    <div
      className="flex w-[280px] shrink-0 flex-col border-l"
      style={{ borderColor: 'var(--sm-line)', background: 'var(--sm-bg)' }}
    >
      <div
        className="flex h-8 shrink-0 items-center justify-between border-b px-3"
        style={{ borderColor: 'var(--sm-line)' }}
      >
        <span className="text-[12px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
          拆分视图
        </span>
        <span className="text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          {nodes.length} 节点 · {edges.length} 连线
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
        {nodes.length === 0 && (
          <p className="px-1 py-2 text-[12px]" style={{ color: 'var(--sm-ink-faint)' }}>
            画布为空。
          </p>
        )}
        {nodes.map((n) => (
          <div
            key={n.id}
            className="flex items-center gap-2 rounded border px-2 py-1.5 text-[12px]"
            style={{ borderColor: 'var(--sm-line)', color: 'var(--sm-ink-soft)' }}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: 'var(--sm-accent)' }}
            />
            <span className="truncate">{String(n.data?.label ?? n.id)}</span>
            <span className="ml-auto shrink-0 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
              {String(n.data?.category ?? '节点')}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [activePanel, setActivePanel] = useState<SidePanelKey | null>(null);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const splitView = useViewStore((s) => s.splitView);

  // 面板尺寸（可拖拽调节）
  const [leftW, setLeftW] = useState(248);
  const [rightW, setRightW] = useState(288);
  const [panelH, setPanelH] = useState(208);
  const [shortcutsH, setShortcutsH] = useState(208);

  const openPanel = (key: SidePanelKey) => setActivePanel(key);
  const closePanel = () => setActivePanel(null);

  const toggleTheme = () => {
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      return next;
    });
  };

  // 拖拽分隔条
  const startResize = (
    axis: 'x' | 'y',
    side: 'left' | 'right' | 'bottom',
    initial: number,
  ) => (e: React.PointerEvent) => {
    e.preventDefault();
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startSize = initial;

    const onMove = (ev: PointerEvent) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startPos;
      // left/right 分隔条向右拖拽 = 宽度增大；bottom 分隔条向上拖拽 = 高度增大
      const sign = side === 'bottom' ? -1 : 1;
      let next = startSize + sign * delta;
      next = Math.max(160, Math.min(480, next));
      if (side === 'bottom') next = Math.max(120, Math.min(480, next));
      if (side === 'left') setLeftW(next);
      else if (side === 'right') setRightW(next);
      else setPanelH(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  useEffect(() => {
    // 桌面端启动时自动扫描插件目录
    if (isTauri) scanPluginsDir();
  }, []);

  // 全局快捷键（与菜单标注一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        exportWorkflow();
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        useWorkflowStore.getState().newWorkflowInProject();
      } else if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <ReactFlowProvider>
      <div className="flex h-screen flex-col font-app" style={{ background: 'var(--sm-bg)', color: 'var(--sm-ink)' }}>
        <TopBar
          theme={theme}
          onToggleTheme={toggleTheme}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen((v) => !v)}
          inspectorOpen={inspectorOpen}
          onToggleInspector={() => setInspectorOpen((v) => !v)}
          onOpenPanel={openPanel}
          onOpenShortcuts={() => setShowShortcutsModal(true)}
        />
        <main className="flex flex-1 overflow-hidden">
          {/* 通栏图标条：贯穿整个高度，底部面板在其右侧打开，永不被遮盖 */}
          {sidebarOpen && (
            <SideRail
              active={activePanel}
              onClose={closePanel}
              onOpen={openPanel}
              onOpenSettings={() => setShowSettings(true)}
              onToggleTheme={toggleTheme}
              shortcutsOpen={shortcutsOpen}
              onToggleShortcuts={() => setShortcutsOpen((v) => !v)}
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen((v) => !v)}
            />
          )}
          {/* 内容区：展开面板 + 画布 + Inspector + 底部面板（均位于图标条右侧） */}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 overflow-hidden">
              {sidebarOpen && activePanel && (
                <>
                  <SidePanel
                    active={activePanel}
                    width={leftW}
                    onResize={setLeftW}
                    onClose={closePanel}
                  />
                  <div
                    className="w-1 shrink-0 cursor-col-resize hover:bg-accent-soft"
                    style={{ background: 'var(--sm-line)' }}
                    onPointerDown={startResize('x', 'left', leftW)}
                    title="拖动调节展开面板宽度"
                  />
                </>
              )}
          <div className="min-w-0 flex-1">
              <WorkflowEditor />
            </div>
            {splitView && <SplitViewPanel />}
            {inspectorOpen && (
              <>
                <Inspector width={rightW} />
                <div
                  className="w-1 shrink-0 cursor-col-resize hover:bg-accent-soft"
                  style={{ background: 'var(--sm-line)' }}
                  onPointerDown={startResize('x', 'right', rightW)}
                  title="拖动调节属性面板宽度"
                />
              </>
            )}
            </div>
            {/* 底部面板：仅在图标条右侧的内容区出现，不遮盖图标条 */}
            {shortcutsOpen && (
              <>
                <div
                  className="h-1 shrink-0 cursor-row-resize hover:bg-accent-soft"
                  style={{ background: 'var(--sm-line)' }}
                  onPointerDown={startResize('y', 'bottom', shortcutsH)}
                  title="拖动调节快捷键面板高度"
                />
                <div className="sm-panel shrink-0" style={{ color: 'var(--sm-ink-soft)' }}>
                  <div className="sm-panel-tabs">
                    <button className="sm-panel-tab" data-active={true}>
                      <Keyboard size={12} /> 快捷键
                    </button>
                    <div className="flex flex-1 items-center justify-end">
                      <button
                        className="flex cursor-pointer items-center gap-1 border-l px-3 text-[11px] transition-colors hover:text-ink"
                        style={{ color: 'var(--sm-ink-faint)', borderColor: 'var(--sm-line)' }}
                        onClick={() => setShortcutsOpen(false)}
                        title="关闭快捷键面板"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>
                  <ShortcutsModal inline />
                </div>
              </>
            )}
            {panelOpen && (
              <>
                <div
                  className="h-1 shrink-0 cursor-row-resize hover:bg-accent-soft"
                  style={{ background: 'var(--sm-line)' }}
                  onPointerDown={startResize('y', 'bottom', panelH)}
                  title="拖动调节底部面板高度"
                />
                <StatusBar open={panelOpen} height={panelH} onToggle={() => setPanelOpen((v) => !v)} />
              </>
            )}
          </div>
        </main>
        {showShortcutsModal && <ShortcutsModal onClose={() => setShowShortcutsModal(false)} />}
        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      </div>
    </ReactFlowProvider>
  );
}
