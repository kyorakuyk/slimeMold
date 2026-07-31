import {
  FilePlus2,
  FolderOpen,
  Save,
  Play,
  Square,
  Bot,
  Puzzle,
  PanelLeft,
  PanelBottom,
  Variable,
  History,
  Sun,
  Moon,
} from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { runWorkflow, stopWorkflow } from '../engine/executor';
import { exportWorkflow, importWorkflow } from '../io/workflowIO';

interface TopBarProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  onTogglePanel: () => void;
  onOpenAgents: () => void;
  onOpenPlugins: () => void;
  onOpenVariables: () => void;
  onOpenHistory: () => void;
}

export default function TopBar({
  theme,
  onToggleTheme,
  onToggleSidebar,
  onTogglePanel,
  onOpenAgents,
  onOpenPlugins,
  onOpenVariables,
  onOpenHistory,
}: TopBarProps) {
  const workflowName = useWorkflowStore((s) => s.workflowName);
  const setWorkflowName = useWorkflowStore((s) => s.setWorkflowName);
  const running = useWorkflowStore((s) => s.running);
  const failFast = useWorkflowStore((s) => s.failFast);
  const setFailFast = useWorkflowStore((s) => s.setFailFast);
  const maxConcurrency = useWorkflowStore((s) => s.maxConcurrency);
  const setMaxConcurrency = useWorkflowStore((s) => s.setMaxConcurrency);
  const newWorkflow = useWorkflowStore((s) => s.newWorkflow);

  return (
    <header
      className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3"
      style={{ background: 'var(--sm-bg-soft)' }}
    >
      <button
        className="sm-btn border-transparent px-1.5"
        title="收起/展开节点面板"
        onClick={onToggleSidebar}
      >
        <PanelLeft size={15} />
      </button>

      <span className="select-none text-[13px] font-semibold tracking-wide text-ink">
        SlimeMold
      </span>
      <span className="mx-1 h-4 w-px bg-line" />

      <input
        className="w-44 rounded border border-transparent bg-transparent px-2 py-1 text-[13px] text-ink outline-none transition-colors hover:border-line focus:border-accent-soft"
        value={workflowName}
        onChange={(e) => setWorkflowName(e.target.value)}
        placeholder="工作流名称"
      />

      <span className="mx-1 h-4 w-px bg-line" />
      <button className="sm-btn" onClick={newWorkflow} title="新建工作流">
        <FilePlus2 size={14} /> 新建
      </button>
      <button className="sm-btn" onClick={() => importWorkflow()} title="从 JSON 导入">
        <FolderOpen size={14} /> 导入
      </button>
      <button className="sm-btn" onClick={() => exportWorkflow()} title="导出为 JSON">
        <Save size={14} /> 导出
      </button>

      <div className="flex-1" />

      <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-ink-faint">
        <input
          type="checkbox"
          className="accent-accent"
          checked={failFast}
          onChange={(e) => setFailFast(e.target.checked)}
        />
        失败即停
      </label>

      <span className="mx-1 h-4 w-px bg-line" />
      <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-ink-faint">
        并发
        <input
          type="number"
          min={1}
          max={20}
          className="w-12 rounded border border-line bg-transparent px-1 py-0.5 text-center text-xs text-ink outline-none focus:border-accent-soft"
          value={maxConcurrency}
          onChange={(e) => setMaxConcurrency(Number(e.target.value))}
        />
      </label>

      <button className="sm-btn" onClick={onOpenAgents}>
        <Bot size={14} /> 智能体
      </button>
      <button className="sm-btn" onClick={onOpenPlugins}>
        <Puzzle size={14} /> 插件
      </button>
      <button className="sm-btn" onClick={onOpenVariables} title="全局变量">
        <Variable size={14} /> 变量
      </button>
      <button className="sm-btn" onClick={onOpenHistory} title="运行历史">
        <History size={14} /> 历史
      </button>

      <span className="mx-1 h-4 w-px" style={{ background: 'var(--sm-line)' }} />
      <button
        className="sm-btn px-1.5"
        title="切换深色/浅色"
        onClick={onToggleTheme}
      >
        {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
      </button>
      <button className="sm-btn px-1.5" title="显示/隐藏底部面板" onClick={onTogglePanel}>
        <PanelBottom size={15} />
      </button>

      {running ? (
        <button className="sm-btn text-err hover:border-err hover:text-err" onClick={stopWorkflow}>
          <Square size={13} /> 停止
        </button>
      ) : (
        <button className="sm-btn sm-btn-primary" onClick={() => runWorkflow()}>
          <Play size={13} /> 运行
        </button>
      )}
    </header>
  );
}
