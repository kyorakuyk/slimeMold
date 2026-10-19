import { useEffect, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { SidePanelKey } from './LeftSidebar';
import type { ProjectFile } from '../types/projectFile';
import TopBarMenuRow, { type MenuDef } from './topBar/TopBarMenuRow';
import { buildTopBarMenus } from './topBar/topBarMenus';
import WorkflowTabStrip from './topBar/WorkflowTabStrip';
import TopBarActionButtons from './topBar/TopBarActionButtons';
import { useTopBarKeyboardShortcuts } from './topBar/useTopBarKeyboardShortcuts';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { useT } from '../i18n/useT';
import { runWorkflow, stopWorkflow, rerunWorkflow } from '../engine/executor';
import { alertDialog, confirmDialog, openDirDialog, isTauri } from '../platform/env';
import { ask } from '@tauri-apps/plugin-dialog';
import { openProjectFile, pushRecentProject, saveLastSession } from '../io/projectIO';

interface TopBarProps {
  replayMode?: boolean;
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
  onOpenSimpleView: () => void;
}

export default function TopBar({
  replayMode = false,
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
  onOpenSimpleView,
}: TopBarProps) {
  const running = useWorkflowStore((s) => s.running);
  const resetStatuses = useWorkflowStore((s) => s.resetStatuses);
  const failFast = useWorkflowStore((s) => s.failFast);
  const canUndo = useWorkflowStore((s) => s.past.length > 0);
  const canRedo = useWorkflowStore((s) => s.future.length > 0);
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
  const t = useT();

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
        addLog('info', t('log.legacyProject'));
      }
    } catch (e) {
      alert(t('dialog.openFailed') + (e as Error).message);
    }
  };

  const handleSaveProject = async () => {
    try {
      const path = await saveProject();
      persistSession(path);
      pushRecentProject({ path, name: projectName ?? path, openedAt: new Date().toISOString() });
    } catch (e) {
      alert(t('dialog.saveFailed') + (e as Error).message);
    }
  };

  const handleSaveProjectAs = async () => {
    if (!isTauri) {
      alert(t('dialog.saveAsNeedTauri'));
      return;
    }
    try {
      const path = await saveProjectAs();
      if (path) {
        persistSession(path);
        pushRecentProject({ path, name: projectName ?? path, openedAt: new Date().toISOString() });
      }
    } catch (e) {
      void alertDialog(t('dialog.saveAsFailed') + (e as Error).message);
    }
  };

  const handleCloseProject = async () => {
    if (projectDirty) {
      const ok = isTauri
        ? await ask(t('dialog.closeConfirm'), {
            title: t('dialog.closeConfirmTitle'),
            kind: 'warning',
          })
        : await confirmDialog(t('dialog.closeConfirm'));
      if (!ok) return;
    }
    closeProject();
  };

  /** 最近项目子菜单：按路径打开（原内联实现搬到这里，行为不变） */
  const handleOpenRecent = async (path: string) => {
    const { openProjectByPath } = await import('../io/projectIO');
    const file = await openProjectByPath(path);
    if (file) {
      openProject(file, path);
      persistSession(path);
      pushRecentProject({ path, name: file.name, openedAt: new Date().toISOString() });
      if ((file as ProjectFile & { legacy?: boolean }).legacy) {
        addLog('info', t('log.legacyProject'));
      }
    }
  };

  /** 新建工作流：项目内直接新建；游离态先让用户指定存放位置（取消则落默认位置） */
  const handleNewWorkflow = async () => {
    if (projectName) {
      newWorkflowInProject();
      return;
    }
    const ws = await openDirDialog();
    newWorkflowInProject(ws); // ws 为 null 时 store 内部记为游离、未指定路径
  };

  const menus: MenuDef[] = buildTopBarMenus({
    t,
    replayMode,
    running,
    failFast,
    skipFailed,
    showGrid,
    projectName,
    selectedNodeId,
    hasNodes,
    activeWfId,
    setFailFast,
    setSkipFailed,
    deleteSelected,
    clearGraph,
    zoomIn,
    zoomOut,
    fitView,
    toggleGrid,
    newWorkflow,
    onOpenWizard,
    onOpenPanel,
    onOpenShortcuts,
    onNewProject,
    onOpenProject: handleOpenProject,
    onSaveProject: handleSaveProject,
    onSaveProjectAs: handleSaveProjectAs,
    onCloseProject: handleCloseProject,
    onOpenRecent: handleOpenRecent,
  });

  const [editingId, setEditingId] = useState<string | null>(null);

  useTopBarKeyboardShortcuts({ zoomIn, zoomOut, fitView }, handleNewProject, replayMode);

  return (
    <header
      className="sm-pro-topbar flex shrink-0 flex-col border-b border-line"
      style={{ background: 'var(--sm-bg-soft)' }}
    >
      <TopBarMenuRow
        menus={menus}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
        panelOpen={panelOpen}
        onTogglePanel={onTogglePanel}
        inspectorOpen={inspectorOpen}
        onToggleInspector={onToggleInspector}
        onOpenSimpleView={onOpenSimpleView}
      />

      {/* 工具条：工作流标签浏览器（右侧动作按钮作为 children 保持同一 DOM 层级） */}
      <WorkflowTabStrip
        replayMode={replayMode}
        projectName={projectName}
        projectDirty={projectDirty}
        wfList={wfList}
        activeWfId={activeWfId}
        editingId={editingId}
        setEditingId={setEditingId}
        onSwitch={switchWorkflow}
        onRename={renameWorkflow}
        onRemove={removeWorkflow}
        onNewWorkflow={handleNewWorkflow}
        t={t}
      >
        <TopBarActionButtons
          t={t}
          replayMode={replayMode}
          splitView={splitView}
          onToggleSplit={toggleSplit}
          onResetStatus={() => {
            stopWorkflow(activeWfId);
            resetStatuses(activeWfId);
          }}
          debugMode={debugMode}
          onToggleDebug={toggleDebug}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={() => useWorkflowStore.getState().undo()}
          onRedo={() => useWorkflowStore.getState().redo()}
          running={running}
          onStop={() => stopWorkflow(activeWfId)}
          onRerunForce={() => rerunWorkflow(activeWfId)}
          onRun={() => runWorkflow({ wfId: activeWfId })}
        />
      </WorkflowTabStrip>
    </header>
  );
}
