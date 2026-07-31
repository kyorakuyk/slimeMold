import { useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
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
  Trash2,
  Eraser,
  ZoomIn,
  ZoomOut,
  Maximize,
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

interface MenuAction {
  label: string;
  icon?: React.ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}
interface MenuDef {
  label: string;
  items: (MenuAction | 'separator')[];
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
  const deleteSelected = useWorkflowStore((s) => s.deleteSelected);
  const clearGraph = useWorkflowStore((s) => s.clearGraph);
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const hasNodes = useWorkflowStore((s) => s.nodes.length > 0);
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  const menus: MenuDef[] = [
    {
      label: '文件',
      items: [
        { label: '新建工作流', icon: <FilePlus2 size={14} />, shortcut: 'Ctrl+N', onClick: newWorkflow },
        { label: '导入 JSON…', icon: <FolderOpen size={14} />, onClick: () => importWorkflow() },
        { label: '导出 JSON', icon: <Save size={14} />, shortcut: 'Ctrl+S', onClick: () => exportWorkflow() },
      ],
    },
    {
      label: '编辑',
      items: [
        { label: '删除选中节点', icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, disabled: !selectedNodeId, onClick: deleteSelected },
        { label: '清空画布', icon: <Eraser size={14} />, danger: true, disabled: !hasNodes, onClick: clearGraph },
      ],
    },
    {
      label: '视图',
      items: [
        { label: '放大', icon: <ZoomIn size={14} />, shortcut: 'Ctrl+=', onClick: () => zoomIn() },
        { label: '缩小', icon: <ZoomOut size={14} />, shortcut: 'Ctrl+-', onClick: () => zoomOut() },
        { label: '适配窗口', icon: <Maximize size={14} />, shortcut: 'Shift+1', onClick: () => fitView({ padding: 0.2, duration: 200 }) },
        'separator',
        { label: '显示/隐藏节点库', onClick: onToggleSidebar },
        { label: '显示/隐藏底部面板', onClick: onTogglePanel },
        { label: '切换深色/浅色主题', icon: theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />, onClick: onToggleTheme },
      ],
    },
    {
      label: '运行',
      items: [
        { label: running ? '停止运行' : '运行工作流', icon: running ? <Square size={14} /> : <Play size={14} />, onClick: running ? stopWorkflow : () => runWorkflow() },
      ],
    },
  ];

  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openMenu === null) return;
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  // 视图快捷键（与菜单标注一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        zoomIn();
      } else if (mod && e.key === '-') {
        e.preventDefault();
        zoomOut();
      } else if (e.shiftKey && e.key === '1') {
        e.preventDefault();
        fitView({ padding: 0.2, duration: 200 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomIn, zoomOut, fitView]);

  return (
    <header
      className="flex shrink-0 flex-col border-b border-line"
      style={{ background: 'var(--sm-bg-soft)' }}
    >
      {/* 菜单条 */}
      <div ref={menuRef} className="flex h-8 items-center px-2">
        <span className="mr-2 select-none px-2 text-[13px] font-semibold tracking-wide text-ink">
          SlimeMold
        </span>
        {menus.map((m, i) => (
          <div key={m.label} className="relative">
            <button
              className={`rounded px-2.5 py-1 text-[12.5px] transition-colors ${
                openMenu === i ? 'bg-accent-soft text-white' : 'text-ink-soft hover:bg-black/10'
              }`}
              style={openMenu === i ? { background: 'var(--sm-accent)' } : undefined}
              onClick={() => setOpenMenu(openMenu === i ? null : i)}
              onMouseEnter={() => openMenu !== null && setOpenMenu(i)}
            >
              {m.label}
            </button>
            {openMenu === i && (
              <div
                className="absolute left-0 top-full z-50 min-w-[200px] rounded-md border py-1 shadow-lg"
                style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
              >
                {m.items.map((it, j) =>
                  it === 'separator' ? (
                    <div key={j} className="my-1 h-px" style={{ background: 'var(--sm-line)' }} />
                  ) : (
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
                      {it.shortcut && (
                        <span className="text-[11px] text-ink-faint">{it.shortcut}</span>
                      )}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 工具条 */}
      <div className="flex h-11 items-center gap-2 border-t px-3" style={{ borderColor: 'var(--sm-line)' }}>
        <button
          className="sm-btn border-transparent px-1.5"
          title="收起/展开节点面板"
          onClick={onToggleSidebar}
        >
          <PanelLeft size={15} />
        </button>

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
      </div>
    </header>
  );
}
