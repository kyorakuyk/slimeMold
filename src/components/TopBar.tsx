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
  PanelRight,
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
  FileDown,
  FolderPlus,
  FileStack,
  Wrench,
  HelpCircle,
  ChevronDown,
  FileBox,
  Columns2,
  Plus,
  X,
  FastForward,
} from 'lucide-react';
import type { SidePanelKey } from './LeftSidebar';
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
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onOpenPanel: (key: SidePanelKey) => void;
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
  sidebarOpen,
  onToggleSidebar,
  panelOpen,
  onTogglePanel,
  inspectorOpen,
  onToggleInspector,
  onOpenPanel,
  onOpenShortcuts,
}: TopBarProps) {
  const workflowName = useWorkflowStore((s) => s.workflowName);
  const setWorkflowName = useWorkflowStore((s) => s.setWorkflowName);
  const running = useWorkflowStore((s) => s.running);
  const newWorkflow = useWorkflowStore((s) => s.newWorkflow);
  const deleteSelected = useWorkflowStore((s) => s.deleteSelected);
  const clearGraph = useWorkflowStore((s) => s.clearGraph);
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const hasNodes = useWorkflowStore((s) => s.nodes.length > 0);
  const showGrid = useViewStore((s) => s.showGrid);
  const showMinimap = useViewStore((s) => s.showMinimap);
  const toggleGrid = useViewStore((s) => s.toggleGrid);
  const toggleMinimap = useViewStore((s) => s.toggleMinimap);
  const splitView = useViewStore((s) => s.splitView);
  const toggleSplit = useViewStore((s) => s.toggleSplit);
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
        { label: '打开工作流…', icon: <FilePlus2 size={14} />, onClick: newWorkflow },
        { label: '导入工作流…', icon: <FileDown size={14} />, onClick: importWorkflow },
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
        { label: running ? '停止运行' : '运行工作流（全量）', icon: running ? <Square size={14} /> : <Play size={14} />, onClick: running ? stopWorkflow : () => runWorkflow() },
        { label: '增量运行（仅改动 + 下游）', icon: <FastForward size={14} />, onClick: () => runWorkflow({ incremental: true }), disabled: running },
      ],
    },
    {
      label: '工具',
      items: [
        { label: '智能体 / 角色库', icon: <Bot size={14} />, onClick: () => onOpenPanel('agents') },
        { label: '插件管理', icon: <Puzzle size={14} />, onClick: () => onOpenPanel('plugins') },
        { label: '全局变量', icon: <Variable size={14} />, onClick: () => onOpenPanel('variables') },
        { label: '运行历史', icon: <History size={14} />, onClick: () => onOpenPanel('history') },
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
        setOpenSub(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenu(null);
        setOpenSub(null);
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
                  if ('type' in it) return null;
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

        {/* 面板开关（菜单条右上角）：左 / 底 / 右 */}
        <div className="ml-auto flex items-center gap-1">
          <button
            className="flex h-6 w-7 items-center justify-center rounded transition-colors hover:bg-black/10"
            title="显示/隐藏左侧栏"
            onClick={onToggleSidebar}
            style={
              sidebarOpen
                ? { color: 'var(--sm-accent)', background: 'color-mix(in srgb, var(--sm-accent) 14%, transparent)' }
                : { color: 'var(--sm-ink-faint)' }
            }
          >
            <PanelLeft size={14} />
          </button>
          <button
            className="flex h-6 w-7 items-center justify-center rounded transition-colors hover:bg-black/10"
            title="显示/隐藏底部面板"
            onClick={onTogglePanel}
            style={
              panelOpen
                ? { color: 'var(--sm-accent)', background: 'color-mix(in srgb, var(--sm-accent) 14%, transparent)' }
                : { color: 'var(--sm-ink-faint)' }
            }
          >
            <PanelBottom size={14} />
          </button>
          <button
            className="flex h-6 w-7 items-center justify-center rounded transition-colors hover:bg-black/10"
            title="显示/隐藏右侧属性面板"
            onClick={onToggleInspector}
            style={
              inspectorOpen
                ? { color: 'var(--sm-accent)', background: 'color-mix(in srgb, var(--sm-accent) 14%, transparent)' }
                : { color: 'var(--sm-ink-faint)' }
            }
          >
            <PanelRight size={14} />
          </button>
        </div>
      </div>

      {/* 工具条：工作流标签浏览器 */}
      <div className="flex h-11 items-center gap-2 border-t px-3" style={{ borderColor: 'var(--sm-line)' }}>
        {/* 标签条 + 新建加号 */}
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {wfList.map(([id, wf]) => {
            const active = id === activeWfId;
            return (
              <div
                key={id}
                className="group flex h-7 max-w-[180px] shrink-0 items-center gap-1.5 rounded-t-md border-b-2 px-2.5"
                style={{
                  borderColor: active ? 'var(--sm-accent)' : 'transparent',
                  background: active ? 'color-mix(in srgb, var(--sm-accent) 12%, transparent)' : 'transparent',
                  color: active ? 'var(--sm-accent)' : 'var(--sm-ink-soft)',
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = 'var(--sm-bg)';
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = 'transparent';
                }}
              >
                {editingId === id ? (
                  <input
                    autoFocus
                    className="w-24 bg-transparent text-[12.5px] outline-none"
                    defaultValue={wf.name}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v) renameWorkflow(v);
                      setEditingId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setEditingId(null);
                    }}
                  />
                ) : (
                  <button
                    className="flex min-w-0 items-center gap-1.5 truncate text-[12.5px]"
                    onClick={() => switchWorkflow(id)}
                    onDoubleClick={() => {
                      switchWorkflow(id);
                      setEditingId(id);
                    }}
                    title={wf.name}
                  >
                    <FileBox size={12} />
                    <span className="truncate">{wf.name}</span>
                  </button>
                )}
                {wfList.length > 1 && (
                  <button
                    className="shrink-0 rounded p-0.5 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-err"
                    title="关闭工作流"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeWorkflow(id);
                    }}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
          <button
            className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12.5px] text-ink-faint transition-colors hover:bg-black/10 hover:text-ink"
            title="新建工作流"
            onClick={() => newWorkflowInProject()}
          >
            <Plus size={14} />
          </button>
        </div>

        <span className="mx-1 h-4 w-px" style={{ background: 'var(--sm-line)' }} />
        {/* 拆分视图气泡 */}
        <button
          className="sm-btn px-1.5"
          title="拆分视图"
          data-active={splitView}
          onClick={toggleSplit}
          style={splitView ? { color: 'var(--sm-accent)', background: 'color-mix(in srgb, var(--sm-accent) 14%, transparent)' } : undefined}
        >
          <Columns2 size={15} />
        </button>

        {running ? (
          <button className="sm-btn px-1.5 text-err hover:border-err hover:text-err" title="停止运行" onClick={stopWorkflow}>
            <Square size={14} />
          </button>
        ) : (
          <button className="sm-btn sm-btn-primary px-1.5" title="运行工作流" onClick={() => runWorkflow()}>
            <Play size={14} />
          </button>
        )}
      </div>
    </header>
  );
}
