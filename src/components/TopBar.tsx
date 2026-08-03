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
  RotateCcw,
  RefreshCw,
  Zap,
  SkipForward,
  Wand2,
  Bug,
} from 'lucide-react';
import type { SidePanelKey } from './LeftSidebar';
import type { ProjectFile } from '../types';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { runWorkflow, stopWorkflow, resumeRun, rerunWorkflow } from '../engine/executor';
import { exportWorkflow, importWorkflow, copyWorkflowText } from '../io/workflowIO';
import { openDirDialog, isTauri } from '../platform/env';
import { ask } from '@tauri-apps/plugin-dialog';
import {
  openProjectFile,
  getRecentProjects,
  clearRecentProjects,
  pushRecentProject,
  saveLastSession,
} from '../io/projectIO';

interface TopBarProps {
  theme: 'dark' | 'light' | 'system';
  onToggleTheme: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  panelOpen: boolean;
  onTogglePanel: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onOpenPanel: (key: SidePanelKey) => void;
  onOpenShortcuts: () => void;
  onNewProject: () => void;
  onOpenWizard: () => void;
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
  onNewProject,
  onOpenWizard,
}: TopBarProps) {
  const workflowName = useWorkflowStore((s) => s.workflowName);
  const setWorkflowName = useWorkflowStore((s) => s.setWorkflowName);
  const running = useWorkflowStore((s) => s.running);
  const resetStatuses = useWorkflowStore((s) => s.resetStatuses);
  const failFast = useWorkflowStore((s) => s.failFast);
  const skipFailed = useWorkflowStore((s) => s.skipFailed);
  const setFailFast = useWorkflowStore((s) => s.setFailFast);
  const setSkipFailed = useWorkflowStore((s) => s.setSkipFailed);
  const newWorkflow = useWorkflowStore((s) => s.newWorkflow);
  const deleteSelected = useWorkflowStore((s) => s.deleteSelected);
  const clearGraph = useWorkflowStore((s) => s.clearGraph);
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const hasNodes = useWorkflowStore((s) => s.nodes.length > 0);
  const showGrid = useViewStore((s) => s.showGrid);
  const toggleGrid = useViewStore((s) => s.toggleGrid);
  const splitView = useViewStore((s) => s.splitView);
  const toggleSplit = useViewStore((s) => s.toggleSplit);
  const debugMode = useViewStore((s) => s.debugMode);
  const toggleDebug = useViewStore((s) => s.toggleDebug);
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  // 项目层状态
  const projectName = useWorkflowStore((s) => s.projectName);
  const projectDirty = useWorkflowStore((s) => s.projectDirty);
  const workflows = useWorkflowStore((s) => s.workflows);
  const activeWfId = useWorkflowStore((s) => s.activeWfId);

  // P1：存在未保存项目改动时，关闭/刷新前拦截提示
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (useWorkflowStore.getState().projectDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
  const openProject = useWorkflowStore((s) => s.openProject);
  const saveProject = useWorkflowStore((s) => s.saveProject);
  const addLog = useWorkflowStore((s) => s.addLog);
  const switchWorkflow = useWorkflowStore((s) => s.switchWorkflow);
  const newWorkflowInProject = useWorkflowStore((s) => s.newWorkflowInProject);
  const renameWorkflow = useWorkflowStore((s) => s.renameWorkflow);
  const removeWorkflow = useWorkflowStore((s) => s.removeWorkflow);
  const closeProject = useWorkflowStore((s) => s.closeProject);
  const saveProjectAs = useWorkflowStore((s) => s.saveProjectAs);

  const wfList = Object.entries(workflows);

  const handleNewProject = () => {
    onNewProject();
  };

  // 记录"上次会话"：项目根路径 + 当前激活工作流 id，供下次启动自动恢复
  const persistSession = (path: string) => {
    const s = useWorkflowStore.getState();
    saveLastSession({ path, activeId: s.activeWfId ?? undefined });
  };

  const handleOpenProject = async () => {
    try {
      const file = await openProjectFile();
      if (!file) return;
      // P1：openProjectFile 返回带 path（项目根目录）的项目，直接作为磁盘真相传给 store
      const path = (file as ProjectFile & { path?: string }).path ?? file.name;
      openProject(file, path);
      persistSession(path);
      pushRecentProject({ path, name: file.name, openedAt: new Date().toISOString() });
      if ((file as ProjectFile & { legacy?: boolean }).legacy) {
        addLog('info', '检测到旧版 .smproj 项目，保存时将自动转换为 .slimemold/ 目录结构');
      }
    } catch (e) {
      alert('打开项目失败：' + (e as Error).message);
    }
  };

  const handleSaveProject = async () => {
    try {
      const path = await saveProject();
      persistSession(path);
      pushRecentProject({ path, name: projectName ?? path, openedAt: new Date().toISOString() });
    } catch (e) {
      alert('保存项目失败：' + (e as Error).message);
    }
  };

  const handleSaveProjectAs = async () => {
    if (!isTauri) {
      alert('「将项目另存为」需要桌面端（Tauri）环境');
      return;
    }
    try {
      const path = await saveProjectAs();
      if (path) {
        persistSession(path);
        pushRecentProject({ path, name: projectName ?? path, openedAt: new Date().toISOString() });
      }
    } catch (e) {
      alert('项目另存为失败：' + (e as Error).message);
    }
  };

  const handleCloseProject = async () => {
    if (projectDirty) {
      const ok = isTauri
        ? await ask('当前项目有未保存的改动，关闭后将丢失这些改动。确定关闭项目吗？', {
            title: '关闭项目',
            kind: 'warning',
          })
        : window.confirm('当前项目有未保存的改动，关闭后将丢失这些改动。确定关闭项目吗？');
      if (!ok) return;
    }
    closeProject();
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
                  if (file) {
                    openProject(file, r.path);
                    persistSession(r.path);
                    pushRecentProject({ path: r.path, name: file.name, openedAt: new Date().toISOString() });
                    if ((file as ProjectFile & { legacy?: boolean }).legacy) {
                      addLog('info', '检测到旧版 .smproj 项目，保存时将自动转换为 .slimemold/ 目录结构');
                    }
                  }
                },
              })),
              { label: '清除最近记录', danger: true, onClick: clearRecentProjects },
            ] as MenuAction[];
          })(),
        },
        'separator',
        { label: '打开工作流…', icon: <FilePlus2 size={14} />, onClick: newWorkflow },
        { label: '工作流向导…', icon: <Wand2 size={14} />, onClick: onOpenWizard },
        { label: '导入工作流…', icon: <FileDown size={14} />, onClick: importWorkflow },
        { label: '保存项目', icon: <Save size={14} />, shortcut: 'Ctrl+S', onClick: handleSaveProject },
        { label: '将项目另存为', icon: <FileBox size={14} />, onClick: handleSaveProjectAs, disabled: !projectName },
        { label: '导出工作流…', icon: <Save size={14} />, onClick: () => exportWorkflow() },
        { label: '复制工作流文本', icon: <FileStack size={14} />, onClick: () => copyWorkflowText() },
        'separator',
        { label: '关闭项目', icon: <X size={14} />, danger: true, disabled: !projectName, onClick: handleCloseProject },
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
      ],
    },
    {
      label: '运行',
      items: [
        { label: running ? '停止运行' : '运行工作流（全量）', icon: running ? <Square size={14} /> : <Play size={14} />, onClick: running ? stopWorkflow : () => runWorkflow({ skipFailed: skipFailed }) },
        { label: '增量运行（仅改动 + 下游）', icon: <FastForward size={14} />, onClick: () => runWorkflow({ incremental: true, skipFailed: skipFailed }), disabled: running },
        { label: '从断点续跑（失败节点 + 下游）', icon: <RotateCcw size={14} />, onClick: () => resumeRun(), disabled: running },
        { label: '强制重跑（清空缓存，全量）', icon: <RefreshCw size={14} />, onClick: () => rerunWorkflow(), disabled: running },
        { type: 'divider' as const },
        {
          label: failFast ? '失败即停：开' : '失败即停：关',
          icon: <Zap size={14} />,
          onClick: () => setFailFast(!failFast),
        },
        {
          label: skipFailed ? '失败时继续：开' : '失败时继续：关',
          icon: <SkipForward size={14} />,
          onClick: () => setSkipFailed(!skipFailed),
          disabled: failFast,
        },
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
        {/* 项目名 + 脏标记 */}
        <div className="flex shrink-0 items-center gap-1 pr-2" style={{ borderRight: '1px solid var(--sm-line)' }}>
          <FolderOpen size={13} className="text-ink-faint" />
          <span className="max-w-[160px] truncate text-[12.5px] font-medium" title={projectName ?? '未命名项目'}>
            {projectName ?? '未命名项目'}
          </span>
          {projectDirty && (
            <span className="text-[13px] leading-none text-err" title="有未保存的改动">
              *
            </span>
          )}
        </div>
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
              </div>
            );
          })}
          <button
            className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12.5px] text-ink-faint transition-colors hover:bg-black/10 hover:text-ink"
            title={projectName ? '新建工作流（加入当前项目）' : '新建游离工作流（可指定存放位置，缺省落默认位置）'}
            onClick={async () => {
              if (projectName) {
                // 已在项目内：工作流归属项目，无需指定路径
                newWorkflowInProject();
                return;
              }
              // 游离工作流：让用户指定存放位置；取消则落默认位置
              const ws = await openDirDialog();
              newWorkflowInProject(ws); // ws 为 null 时 store 内部记为游离、未指定路径
            }}
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

        <button
          className="sm-btn px-1.5"
          title="重置工作流工作状态（运行中点击会先停止再重置）"
          onClick={() => {
            stopWorkflow();
            resetStatuses();
          }}
        >
          <RotateCcw size={14} />
        </button>

        <button
          className="sm-btn px-1.5"
          title={debugMode ? '调试模式：开（节点卡片显示重跑子图 / 重跑到此节点）' : '调试模式：关'}
          data-active={debugMode}
          onClick={toggleDebug}
          style={debugMode ? { color: 'var(--sm-accent)', background: 'color-mix(in srgb, var(--sm-accent) 14%, transparent)' } : undefined}
        >
          <Bug size={14} />
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
