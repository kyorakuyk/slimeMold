import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { X, Keyboard } from 'lucide-react';
import TopBar from './components/TopBar';
import Inspector from './components/Inspector';
import StatusBar from './components/StatusBar';
import SettingsCenter from './components/SettingsCenter';
import { SideRail, SidePanel, type SidePanelKey } from './components/LeftSidebar';
import ShortcutsModal from './components/ShortcutsModal';
import ExamplesModal from './components/ExamplesModal';
import WorkflowWizard from './components/WorkflowWizard';
import WelcomeModal from './components/WelcomeModal';
import NewProjectModal from './components/NewProjectModal';
import WorkflowEditor from './canvas/WorkflowEditor';
import { NamePrompt } from './components/NamePrompt';
import { registerBuiltins } from './nodes/builtin';
import { scanPluginsDir, scanProgramCustomNodes, scanProjectCustomNodes, unloadProjectCustomNodes } from './plugins/pluginManager';
import { isTauri } from './platform/env';
import { getLastSession } from './io/projectIO';
import { exportWorkflow } from './io/workflowIO';
import { useWorkflowStore } from './store/workflowStore';
import { useViewStore } from './store/viewStore';
import { useWorkflowFileDrop } from './hooks/useWorkflowFileDrop';

registerBuiltins();

/** 拆分视图：左右并排显示两个不同的工作流图，右侧边栏显示焦点节点信息 */
function SplitCanvas({
  splitWfId,
  setSplitWfId,
  onNewProject,
}: {
  splitWfId: string;
  setSplitWfId: (id: string) => void;
  onNewProject?: () => void;
}) {
  const workflows = useWorkflowStore((s) => s.workflows);
  const activeWfId = useWorkflowStore((s) => s.activeWfId);
  const ids = Object.keys(workflows);
  // 右侧分栏默认显示「非当前激活」的第一个工作流
  const targetId =
    splitWfId && workflows[splitWfId]
      ? splitWfId
      : ids.find((id) => id !== activeWfId) ?? activeWfId;

  return (
    <div className="flex min-w-0 flex-1">
      {/* 左：当前激活工作流 */}
      <div className="min-w-0 flex-1 border-r" style={{ borderColor: 'var(--sm-line)' }}>
        <div
          className="flex h-7 shrink-0 items-center gap-2 border-b px-3 text-[12px]"
          style={{ borderColor: 'var(--sm-line)', color: 'var(--sm-ink-soft)' }}
        >
          <span className="font-semibold" style={{ color: 'var(--sm-ink)' }}>主工作流</span>
          <span className="truncate" style={{ color: 'var(--sm-ink-faint)' }}>
            {workflows[activeWfId]?.name ?? ''}
          </span>
        </div>
        <div className="h-[calc(100%-1.75rem)]">
          <WorkflowEditor onNewProject={onNewProject} />
        </div>
      </div>

      {/* 右：另一个工作流（可在下拉中切换） */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex h-7 shrink-0 items-center gap-2 border-b px-3"
          style={{ borderColor: 'var(--sm-line)' }}
        >
          <span className="shrink-0 text-[12px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
            拆分视图
          </span>
          <select
            className="max-w-[200px] flex-1 rounded border bg-transparent px-1.5 py-0.5 text-[11.5px] outline-none"
            style={{ borderColor: 'var(--sm-line)', color: 'var(--sm-ink-soft)' }}
            value={targetId}
            onChange={(e) => setSplitWfId(e.target.value)}
            title="选择右侧分栏显示的工作流"
          >
            {ids.map((id) => (
              <option key={id} value={id} className="bg-[var(--sm-bg)]">
                {workflows[id]?.name ?? id}
                {id === activeWfId ? '（主）' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="min-h-0 flex-1">
          {ids.length <= 1 ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-[12.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
              项目中只有一个工作流。新建一个工作流即可在拆分视图中并排查看/编辑不同工作流。
            </div>
          ) : (
            <WorkflowEditor wfId={targetId} onNewProject={onNewProject} />
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activePanel, setActivePanel] = useState<SidePanelKey | null>(null);
  // 右侧边栏（检查器）开关从 viewStore 读取（持久化，记住上次状态）
  const inspectorOpen = useViewStore((s) => s.inspectorOpen);
  const toggleInspector = useViewStore((s) => s.toggleInspector);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const examplesOpen = useWorkflowStore((s) => s.examplesOpen);
  const setExamplesOpen = useWorkflowStore((s) => s.setExamplesOpen);
  const [showSettings, setShowSettings] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const viewTheme = useViewStore((s) => s.theme);
  const setViewTheme = useViewStore((s) => s.setTheme);
  const [prompt, setPrompt] = useState<{ title: string; initial: string; onConfirm: (name: string) => void } | null>(null);
  const splitView = useViewStore((s) => s.splitView);
  const splitWfId = useViewStore((s) => s.splitWfId);
  const setSplitWfId = useViewStore((s) => s.setSplitWfId);
  // 允许从窗口外拖拽 .workflow.json 进入应用直接打开
  const { dragActive, onDragEnter, onDragLeave, onDragOver, onDrop } =
    useWorkflowFileDrop();
  // 底侧边栏开关与高度从 viewStore 读取（持久化，记住上次状态）
  const panelOpen = useViewStore((s) => s.panelOpen);
  const togglePanel = useViewStore((s) => s.togglePanel);
  const panelH = useViewStore((s) => s.panelH);
  const setPanelH = useViewStore((s) => s.setPanelH);

  // 面板尺寸（可拖拽调节）
  const [leftW, setLeftW] = useState(248);
  const [rightW, setRightW] = useState(288);
  const [shortcutsH] = useState(208);

  const openPanel = (key: SidePanelKey) => setActivePanel(key);
  const closePanel = () => setActivePanel(null);

  const toggleTheme = () => {
    // 三态循环：dark -> light -> system -> dark
    const next = viewTheme === 'dark' ? 'light' : viewTheme === 'light' ? 'system' : 'dark';
    setViewTheme(next);
  };

  // setTheme 已在 store 内套用 data-theme（含 system 跟随），此处无需再手动设置

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

  // P3：桌面端启动自动恢复上次项目（含激活工作流），仅当当前尚无已加载项目时
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    (async () => {
      const sess = getLastSession();
      if (!sess) return;
      const st = useWorkflowStore.getState();
      // 已有项目（如持久化恢复）则不抢占
      if (st.projectId) return;
      try {
        const fs = await import('@tauri-apps/plugin-fs');
        const ok = await fs.exists(sess.path);
        if (!ok || cancelled) return;
        const { openProjectByPath } = await import('./io/projectIO');
        const file = await openProjectByPath(sess.path);
        if (!file || cancelled) return;
        // 优先恢复会话里记录的激活工作流
        if (sess.activeId && file.workflows[sess.activeId]) {
          file.activeId = sess.activeId;
        }
        useWorkflowStore.getState().openProject(file, sess.path);
        // 项目恢复成功后：扫描程序级（全局）自定义节点；项目级（仅本项目）由下方 projectId 订阅统一触发
        void scanProgramCustomNodes().catch(() => {});
      } catch {
        /* 恢复失败不阻塞启动 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // P3 项目欢迎页：当前无项目加载时弹出（项目加载后自动隐藏，关闭项目后重新出现）
  const [showWelcome, setShowWelcome] = useState(() => !useWorkflowStore.getState().projectId);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  useEffect(() => {
    return useWorkflowStore.subscribe((s) => {
      // 有项目则进入主界面；无项目（含关闭项目）则回到欢迎页
      setShowWelcome(!s.projectId);
      // 项目切换/关闭：先卸载旧项目级自定义节点（仅本项目生效），再扫描新项目级
      unloadProjectCustomNodes();
      if (s.projectId) void scanProjectCustomNodes().catch(() => {});
    });
  }, []);

  // 全局快捷键（与菜单标注一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const t = e.target as HTMLElement | null;
      const inEditable =
        !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        exportWorkflow();
      } else if (mod && e.key.toLowerCase() === 'z') {
        // 在输入框里不拦截，保留浏览器默认的文本撤销
        if (inEditable) return;
        e.preventDefault();
        if (e.shiftKey) useWorkflowStore.getState().redo();
        else useWorkflowStore.getState().undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        if (inEditable) return;
        e.preventDefault();
        useWorkflowStore.getState().redo();
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        useWorkflowStore.getState().newWorkflowInProject();
      } else if (mod && e.key.toLowerCase() === 'c') {
        if (inEditable) return;
        e.preventDefault();
        useWorkflowStore.getState().copySelection();
      } else if (mod && e.key.toLowerCase() === 'v') {
        if (inEditable) return;
        e.preventDefault();
        useWorkflowStore.getState().pasteClipboard();
      } else if (mod && e.key.toLowerCase() === 'd') {
        if (inEditable) return;
        e.preventDefault();
        e.stopPropagation();
        useWorkflowStore.getState().duplicateSelection();
      } else if (mod && e.key.toLowerCase() === 'a') {
        if (inEditable) return;
        e.preventDefault();
        useWorkflowStore.getState().selectAll();
      } else if (mod && e.key.toLowerCase() === 'b') {
        if (inEditable) return;
        e.preventDefault();
        const st = useWorkflowStore.getState();
        st.nodes.filter((n) => n.selected).forEach((n) => st.toggleNodeBypass(n.id));
      } else if (mod && e.key.toLowerCase() === 'm') {
        if (inEditable) return;
        e.preventDefault();
        const st = useWorkflowStore.getState();
        st.nodes.filter((n) => n.selected).forEach((n) => st.toggleNodeMute(n.id));
      } else if (mod && e.key.toLowerCase() === 'g') {
        // Ctrl+G 把选中节点编为一组；Ctrl+Shift+G 打包成可复用子图
        e.preventDefault();
        const st = useWorkflowStore.getState();
        const ids = st.nodes.filter((n) => n.selected).map((n) => n.id);
        if (ids.length === 0) {
          st.addLog('error', '请先框选若干节点，再按 Ctrl+G');
          return;
        }
        if (e.shiftKey) {
          setPrompt({
            title: '给这个子图起个名字',
            initial: `子图 ${Object.keys(st.subgraphs).length + 1}`,
            onConfirm: (name) => st.packSelectionAsSubgraph(ids, name),
          });
        } else {
          st.createGroup(ids);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <ReactFlowProvider>
      <div
        className="flex h-screen flex-col font-app"
        style={{ background: 'var(--sm-bg)', color: 'var(--sm-ink)' }}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <TopBar
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          panelOpen={panelOpen}
          onTogglePanel={togglePanel}
          inspectorOpen={inspectorOpen}
          onToggleInspector={toggleInspector}
          onOpenPanel={openPanel}
          onOpenShortcuts={() => setShowShortcutsModal(true)}
          onNewProject={() => setNewProjectOpen(true)}
          onOpenWizard={() => setWizardOpen(true)}
        />
        <main className="flex flex-1 overflow-hidden">
          {/* 通栏图标条：贯穿整个高度，底部面板在其右侧打开，永不被遮盖 */}
          {sidebarOpen && (
            <SideRail
              active={activePanel}
              onClose={closePanel}
              onOpen={openPanel}
              onOpenExamples={() => setExamplesOpen(true)}
              examplesActive={examplesOpen}
              onOpenSettings={() => setShowSettings(true)}
              onToggleTheme={toggleTheme}
              shortcutsOpen={shortcutsOpen}
              onToggleShortcuts={() => setShortcutsOpen((v) => !v)}
              panelOpen={panelOpen}
              onTogglePanel={togglePanel}
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
          <div className="flex min-w-0 flex-1">
              {splitView ? (
                <SplitCanvas
                  splitWfId={splitWfId}
                  setSplitWfId={setSplitWfId}
                  onNewProject={() => setNewProjectOpen(true)}
                />
              ) : (
                <div className="min-w-0 flex-1">
                  <WorkflowEditor onNewProject={() => setNewProjectOpen(true)} />
                </div>
              )}
            </div>
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
                <StatusBar open={panelOpen} height={panelH} onToggle={togglePanel} />
              </>
            )}
          </div>
        </main>
        {showShortcutsModal && <ShortcutsModal onClose={() => setShowShortcutsModal(false)} />}
        {showSettings && <SettingsCenter onClose={() => setShowSettings(false)} />}
        {examplesOpen && <ExamplesModal onClose={() => setExamplesOpen(false)} />}
        {wizardOpen && <WorkflowWizard onClose={() => setWizardOpen(false)} />}
        {prompt && (
          <NamePrompt
            title={prompt.title}
            initial={prompt.initial}
            onConfirm={(name) => {
              prompt.onConfirm(name);
              setPrompt(null);
            }}
            onCancel={() => setPrompt(null)}
          />
        )}
        {showWelcome && <WelcomeModal onClose={() => setShowWelcome(false)} onNewProject={() => setNewProjectOpen(true)} />}
        {newProjectOpen && <NewProjectModal onClose={() => setNewProjectOpen(false)} />}
        {dragActive && (
          <div
            className="pointer-events-none fixed inset-0 z-[9999] flex items-center justify-center"
            style={{
              background: 'color-mix(in srgb, var(--sm-bg) 70%, transparent)',
              backdropFilter: 'blur(2px)',
            }}
          >
            <div
              className="rounded-lg border-2 border-dashed px-10 py-8 text-center text-[15px] font-semibold"
              style={{ borderColor: 'var(--sm-accent)', color: 'var(--sm-accent)' }}
            >
              松开以打开工作流文件 (.workflow.json)
            </div>
          </div>
        )}
      </div>
    </ReactFlowProvider>
  );
}
