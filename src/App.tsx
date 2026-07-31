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
  const [showAgents, setShowAgents] = useState(false);
  const [showPlugins, setShowPlugins] = useState(false);
  const [showVariables, setShowVariables] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    // 桌面端启动时自动扫描插件目录
    if (isTauri) scanPluginsDir();
  }, []);

  return (
    <ReactFlowProvider>
      <div className="flex h-screen flex-col bg-paper font-app">
        <TopBar
          onToggleSidebar={() => setSidebarOpen((v) => !v)}
          onOpenAgents={() => setShowAgents(true)}
          onOpenPlugins={() => setShowPlugins(true)}
          onOpenVariables={() => setShowVariables(true)}
          onOpenHistory={() => setShowHistory(true)}
        />
        <main className="flex flex-1 overflow-hidden pb-7 pt-11">
          {sidebarOpen && <NodePalette />}
          <div className="min-w-0 flex-1">
            <WorkflowEditor />
          </div>
          <Inspector />
        </main>
        <StatusBar />
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
