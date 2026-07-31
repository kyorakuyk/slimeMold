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
  Grid3x3,
  Map,
  Keyboard,
  Info,
  FilePlus,
  FolderPlus,
  FileStack,
  Wrench,
  HelpCircle,
  ChevronDown,
  FileBox,
} from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { runWorkflow, stopWorkflow } from '../engine/executor';
import { exportWorkflow, importWorkflow } from '../io/workflowIO';
import {
  openProjectFile,
  getRecentProjects,
  clearRecentProjects,
  pushRecentProject,
} from '../io/projectIO';

interface TopBarProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onToggleSidebar: () => void;
  onTogglePanel: () => void;
  onOpenAgents: () => void;
  onOpenPlugins: () => void;
  onOpenVariables: () => void;
  onOpenHistory: () => void;
  onOpenShortcuts: () => void;
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
  items: (MenuAction | 'separator' | { type: 'submenu'; label: string; icon?: React.ReactNode; items: MenuAction[] })[];
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
  onOpenShortcuts,
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
  const showGrid = useViewStore((s) => s.showGrid);
  const showMinimap = useViewStore((s) => s.showMinimap);
  const toggleGrid = useViewStore((s) => s.toggleGrid);
  const toggleMinimap = useViewStore((s) => s.toggleMinimap);
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  // 项目层状态
  const projectName = useWorkflowStore((s) => s.projectName);
  const workflows = useWorkflowStore((s) => s.workflows);
  const activeWfId = useWorkflowStore((s) => s.activeWfId);
  const newProject = useWorkflowStore((s) => s.newProject);
  const openProject = useWorkflowStore((s) => s.openProject);
  const saveProject = useWorkflowStore((s) => s.saveProject);
  const switchWorkflow = useWorkflowStore((s) => s.switchWorkflow);
  const newWorkflowInProject = useWorkflowStore((s) => s.newWorkflowInProject);
  const renameWorkflow = useWorkflowStore((s) => s.renameWorkflow);
  const removeWorkflow = useWorkflowStore((s) => s.removeWorkflow);

  const wfList = Object.entries(workflows);

  const handleNewProject = () => {
    const name = window.prompt('项目名称', '未命名项目')?.trim();
    if (!name) return;
    newProject(name);
  };

  const handleOpenProject = async () => {
    try {
      const file = await openProjectFile();
      if (!file) return;
      // 浏览器退化：path 用项目名；Tauri：需拿真实路径，这里用 file.name 占位
      openProject(file, file.name);
      pushRecentProject({ path: file.name, name: file.name, openedAt: new Date().toISOString() });
    } catch (e) {
      alert('打开项目失败：' + (e as Error).message);
    }
  };

  const handleSaveProject = async () => {
    try {
      const path = await saveProject();
      pushRecentProject({ path, name: projectName ?? path, openedAt: new Date().toISOString() });
    } catch (e) {
      alert('保存项目失败：' + (e as Error).message);
    }
  };

  const menus: MenuDef[] = [
    {
      label: '文件',
      items: [
        { label: '新建项目', icon: <FolderPlus size={14} />, shortcut: 'Ctrl+Shift+N', onClick: handleNewProject },
        { label: '打开项目…', icon: <FolderOpen size={14} />, onClick: handleOpenProject },
        {
          type: 'submenu',
          label: '打开最近项目',
          icon: <FileStack size={14} />,
          items: (() => {
            const recents = getRecentProjects();
            if (recents.length === 0) return [{ label: '（无最近项目）', onClick: () => {} }];
            return [
              ...recents.map((r) => ({
                label: r.name,
                onClick: async () => {
                  const { openProjectByPath } = await import('../io/projectIO');
                  const file = await openProjectByPath(r.path);
                  if (file) openProject(file, r.path);
                },
              })),
              { label: '清除最近记录', danger: true, onClick: clearRecentProjects },
            ] as MenuAction[];
          })(),
        },
        'separator',
        { label: '新建工作流', icon: <FilePlus size={14} />, shortcut: 'Ctrl+N', onClick: newWorkflowInProject },
        { label: '打开工作流…', icon: <FilePlus2 size={14} />, onClick: newWorkflow },
        { label: '保存项目', icon: <Save size={14} />, shortcut: 'Ctrl+S', onClick: handleSaveProject },
        { label: '导出工作流…', icon: <Save size={14} />, onClick: () => exportWorkflow() },
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
        { label: showGrid ? '隐藏网格' : '显示网格', icon: <Grid3x3 size={14} />, onClick: toggleGrid },
        { label: showMinimap ? '隐藏小地图' : '显示小地图', icon: <Map size={14} />, onClick: toggleMinimap },
      ],
    },
    {
      label: '运行',
      items: [
        { label: running ? '停止运行' : '运行工作流', icon: running ? <Square size={14} /> : <Play size={14} />, onClick: running ? stopWorkflow : () => runWorkflow() },
      ],
    },
    {
      label: '工具',
      items: [
        { label: '智能体 / 角色库', icon: <Bot size={14} />, onClick: onOpenAgents },
        { label: '插件管理', icon: <Puzzle size={14} />, onClick: onOpenPlugins },
        { label: '全局变量', icon: <Variable size={14} />, onClick: onOpenVariables },
        { label: '运行历史', icon: <History size={14} />, onClick: onOpenHistory },
      ],
    },
    {
      label: '帮助',
      items: [
        { label: '快捷键速查', icon: <Keyboard size={14} />, onClick: onOpenShortcuts },
        { label: '关于 SlimeMold', icon: <Info size={14} />, onClick: () => alert('SlimeMold — Agent 工作流编辑器\n版本 0.1.0') },
      ],
    },
  ];

  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [wfOpen, setWfOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
        setOpenSub(null);
        setWfOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenu(null);
        setOpenSub(null);
        setWfOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleNewProject();
      } else if (mod && (e.key === '=' || e.key === '+')) {
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
                openMenu === i ? '' : 'text-ink-soft hover:bg-black/10'
              }`}
              style={openMenu === i ? { background: 'var(--sm-accent)', color: '#fff' } : undefined}
              onClick={() => {
                setOpenMenu(openMenu === i ? null : i);
                setOpenSub(null);
              }}
              onMouseEnter={() => openMenu !== null && setOpenMenu(i)}
            >
              {m.label}
            </button>
            {openMenu === i && (
              <div
                className="absolute left-0 top-full z-50 min-w-[210px] rounded-md border py-1 shadow-lg"
                style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
              >
                {m.items.map((it, j) => {
                  if (it === 'separator')
                    return <div key={j} className="my-1 h-px" style={{ background: 'var(--sm-line)' }} />;
                  if ('type' in it && it.type === 'submenu') {
                    return (
                      <div
                        key={j}
                        className="relative"
                        onMouseEnter={() => setOpenSub(j)}
                      >
                        <button
                          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] text-ink-soft hover:bg-black/10"
                          onClick={() => setOpenSub(openSub === j ? null : j)}
                        >
                          <span className="flex w-4 justify-center">{it.icon}</span>
                          <span className="flex-1">{it.label}</span>
                          <span className="text-ink-faint">▸</span>
                        </button>
                        {openSub === j && (
                          <div
                            className="absolute left-full top-0 z-50 min-w-[200px] rounded-md border py-1 shadow-lg"
                            style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)', marginLeft: 2 }}
                          >
                            {it.items.map((sub, k) => (
                              <button
                                key={k}
                                disabled={sub.disabled}
                                className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px] ${
                                  sub.disabled ? 'cursor-not-allowed text-ink-faint opacity-50' : sub.danger ? 'text-err hover:bg-err/10' : 'text-ink-soft hover:bg-black/10'
                                }`}
                                onClick={() => {
                                  if (sub.disabled) return;
                                  sub.onClick();
                                  setOpenMenu(null);
                                  setOpenSub(null);
                                }}
                              >
                                <span className="flex-1">{sub.label}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  }
                  return (
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
                      {it.shortcut && <span className="text-[11px] text-ink-faint">{it.shortcut}</span>}
                    </button>
                  );
                })}
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

        {/* 工作流选择器 */}
        <div className="relative">
          <button
            className="sm-btn max-w-[180px] gap-1.5"
            onClick={() => setWfOpen((v) => !v)}
            title="切换 / 新建工作流"
          >
            <FileBox size={14} />
            <span className="truncate">{workflowName}</span>
            <ChevronDown size={13} />
          </button>
          {wfOpen && (
            <div
              className="absolute left-0 top-full z-50 mt-1 min-w-[220px] rounded-md border py-1 shadow-lg"
              style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
            >
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink-soft hover:bg-black/10"
                onClick={() => {
                  newWorkflowInProject();
                  setWfOpen(false);
                }}
              >
                <FilePlus size={13} /> 新建工作流
              </button>
              <div className="my-1 h-px" style={{ background: 'var(--sm-line)' }} />
              {wfList.length === 0 && (
                <div className="px-3 py-1.5 text-[12px] text-ink-faint">无工作流</div>
              )}
              {wfList.map(([id, wf]) => (
                <div key={id} className="group flex items-center hover:bg-black/10">
                  <button
                    className={`flex flex-1 items-center gap-2 px-3 py-1.5 text-left text-[12.5px] ${
                      id === activeWfId ? 'text-accent' : 'text-ink-soft'
                    }`}
                    onClick={() => {
                      switchWorkflow(id);
                      setWfOpen(false);
                    }}
                  >
                    <FileBox size={13} />
                    <span className="truncate">{wf.name}</span>
                  </button>
                  {wfList.length > 1 && (
                    <button
                      className="px-2 text-ink-faint opacity-0 group-hover:opacity-100 hover:text-err"
                      title="删除工作流"
                      onClick={() => removeWorkflow(id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <span className="mx-1 h-4 w-px bg-line" />

        <button className="sm-btn" onClick={() => importWorkflow()} title="从 JSON 导入">
          <FolderOpen size={14} /> 导入
        </button>
        <button className="sm-btn" onClick={handleSaveProject} title="保存项目 (.smproj)">
          <Save size={14} /> 保存项目
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
        <button className="sm-btn px-1.5" title="切换深色/浅色" onClick={onToggleTheme}>
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
