import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import TopBar from './components/TopBar';
import NodePalette from './components/NodePalette';
import Inspector from './components/Inspector';
import StatusBar from './components/StatusBar';
import AgentPanel from './components/AgentPanel';
import PluginPanel from './components/PluginPanel';
import VariablesPanel from './components/VariablesPanel';
import RunHistoryPanel from './components/RunHistoryPanel';
import WorkflowEditor from './canvas/WorkflowEditor';
import { registerBuiltins } from './nodes/builtin';
import { scanPluginsDir } from './plugins/pluginManager';
import { isTauri } from './platform/env';

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
        {showAgents && <AgentPanel onClose={() => setShowAgents(false)} />}
        {showPlugins && <PluginPanel onClose={() => setShowPlugins(false)} />}
        {showVariables && <VariablesPanel onClose={() => setShowVariables(false)} />}
        {showHistory && <RunHistoryPanel onClose={() => setShowHistory(false)} />}
      </div>
    </ReactFlowProvider>
  );
}
