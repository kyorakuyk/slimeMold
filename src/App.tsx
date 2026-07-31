import { lazy, Suspense, useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import TopBar from './components/TopBar';
import NodePalette from './components/NodePalette';
import Inspector from './components/Inspector';
import StatusBar from './components/StatusBar';
import WorkflowEditor from './canvas/WorkflowEditor';
import { registerBuiltins } from './nodes/builtin';
import { scanPluginsDir } from './plugins/pluginManager';
import { isTauri } from './platform/env';
import { exportWorkflow, importWorkflow } from './io/workflowIO';
import { useWorkflowStore } from './store/workflowStore';

// 非首屏面板懒加载，减小首屏 JS 解析量（打开对应面板时才拉取 chunk）
const AgentPanel = lazy(() => import('./components/AgentPanel'));
const PluginPanel = lazy(() => import('./components/PluginPanel'));
const VariablesPanel = lazy(() => import('./components/VariablesPanel'));
const RunHistoryPanel = lazy(() => import('./components/RunHistoryPanel'));

registerBuiltins();

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [showAgents, setShowAgents] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [showVariables, setShowVariables] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // 面板尺寸（可拖拽调节）
  const [leftW, setLeftW] = useState(224);
  const [rightW, setRightW] = useState(288);
  const [panelH, setPanelH] = useState(208);

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
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onTogglePanel={() => setPanelOpen((v) => !v)}
          onOpenAgents={() => setShowAgents(true)}
          onOpenPlugins={() => setShowPlugins(true)}
          onOpenVariables={() => setShowVariables(true)}
          onOpenHistory={() => setShowHistory(true)}
          onOpenShortcuts={() => setShowShortcuts(true)}
        />
        <main className="flex flex-1 overflow-hidden">
          {sidebarOpen && (
            <>
              <NodePalette width={leftW} />
              <div
                className="w-1 shrink-0 cursor-col-resize hover:bg-accent-soft"
                style={{ background: 'var(--sm-line)' }}
                onPointerDown={startResize('x', 'left', leftW)}
                title="拖动调节节点库宽度"
              />
            </>
          )}
          <div className="min-w-0 flex-1">
            <WorkflowEditor />
          </div>
          <Inspector width={rightW} />
          <div
            className="w-1 shrink-0 cursor-col-resize hover:bg-accent-soft"
            style={{ background: 'var(--sm-line)' }}
            onPointerDown={startResize('x', 'right', rightW)}
            title="拖动调节属性面板宽度"
          />
        </main>
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
        <Suspense fallback={null}>
          {showAgents && <AgentPanel onClose={() => setShowAgents(false)} />}
          {showPlugins && <PluginPanel onClose={() => setShowPlugins(false)} />}
          {showVariables && <VariablesPanel onClose={() => setShowVariables(false)} />}
          {showHistory && <RunHistoryPanel onClose={() => setShowHistory(false)} />}
        </Suspense>
        {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
      </div>
    </ReactFlowProvider>
  );
}

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Ctrl/Cmd + Shift + N', '新建项目'],
    ['Ctrl/Cmd + N', '新建工作流'],
    ['Ctrl/Cmd + S', '保存项目'],
    ['Ctrl/Cmd + =', '放大视图'],
    ['Ctrl/Cmd + -', '缩小视图'],
    ['Shift + 1', '适配窗口'],
    ['Delete / Backspace', '删除选中节点'],
    ['Esc', '关闭菜单 / 弹窗'],
  ];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onMouseDown={onClose}
    >
      <div
        className="w-[420px] rounded-lg border p-4 shadow-2xl"
        style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
            快捷键速查
          </h2>
          <button className="sm-btn px-2 py-0.5" onClick={onClose}>
            关闭
          </button>
        </div>
        <table className="w-full text-[13px]">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="border-t" style={{ borderColor: 'var(--sm-line)' }}>
                <td className="py-1.5 pr-3 font-mono text-[12px]" style={{ color: 'var(--sm-accent-soft)' }}>
                  {k}
                </td>
                <td className="py-1.5" style={{ color: 'var(--sm-ink-soft)' }}>
                  {v}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
