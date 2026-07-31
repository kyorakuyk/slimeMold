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
      </div>
    </ReactFlowProvider>
  );
}
