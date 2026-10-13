import {
  FilePlus2,
  FolderOpen,
  Save,
  Play,
  Square,
  Bot,
  Puzzle,
  Variable,
  History,
  Trash2,
  Eraser,
  ZoomIn,
  ZoomOut,
  Maximize,
  Grid3x3,
  Keyboard,
  Info,
  FileDown,
  FolderPlus,
  FileStack,
  FileBox,
  X,
  FastForward,
  RotateCcw,
  RefreshCw,
  Zap,
  SkipForward,
  Boxes,
  Wand2,
} from 'lucide-react';
import type { SidePanelKey } from '../LeftSidebar';
import { getRecentProjects, clearRecentProjects } from '../../io/projectIO';
import { exportWorkflow, importWorkflow, copyWorkflowText } from '../../io/workflowIO';
import { runWorkflow, stopWorkflow, resumeRun, rerunWorkflow } from '../../engine/executor';
import type { MenuAction, MenuDef } from './TopBarMenuRow';

type TFn = (key: string, vars?: Record<string, unknown>) => string;

/**
 * 顶栏菜单定义（File/Edit/View/Run/Tools/Help）。
 * 纯数据构造：只依赖调用方传入的文案函数、运行态与回调，不改任何 store。
 */
export interface TopBarMenuDeps {
  t: TFn;
  running: boolean;
  failFast: boolean;
  skipFailed: boolean;
  showGrid: boolean;
  projectName: string | null;
  selectedNodeId: string | null;
  hasNodes: boolean;
  activeWfId: string;
  setFailFast: (v: boolean) => void;
  setSkipFailed: (v: boolean) => void;
  deleteSelected: () => void;
  clearGraph: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  fitView: (opts?: { padding?: number; duration?: number }) => void;
  toggleGrid: () => void;
  newWorkflow: () => void;
  onOpenWizard: () => void;
  onOpenPanel: (key: SidePanelKey) => void;
  onOpenShortcuts: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onSaveProjectAs: () => void;
  onCloseProject: () => void;
  onOpenRecent: (path: string) => void;
}

export function buildTopBarMenus(deps: TopBarMenuDeps): MenuDef[] {
  const {
    t,
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
    onOpenProject,
    onSaveProject,
    onSaveProjectAs,
    onCloseProject,
    onOpenRecent,
  } = deps;

  return [
    {
      label: t('topbar.file'),
      items: [
        { label: t('menu.newProject'), icon: <FolderPlus size={14} />, shortcut: 'Ctrl+Shift+N', onClick: onNewProject },
        { label: t('menu.openProject'), icon: <FolderOpen size={14} />, onClick: onOpenProject },
        {
          type: 'submenu',
          label: t('menu.openRecent'),
          icon: <FileStack size={14} />,
          items: (() => {
            const recents = getRecentProjects();
            if (recents.length === 0) return [{ label: t('menu.noRecent'), onClick: () => {} }];
            return [
              ...recents.map((r) => ({
                label: r.name,
                onClick: () => onOpenRecent(r.path),
              })),
              { label: t('menu.clearRecent'), danger: true, onClick: clearRecentProjects },
            ] as MenuAction[];
          })(),
        },
        'separator',
        { label: t('menu.newWorkflow'), icon: <FilePlus2 size={14} />, onClick: newWorkflow },
        { label: t('menu.workflowWizard'), icon: <Wand2 size={14} />, onClick: onOpenWizard },
        { label: t('menu.importWorkflow'), icon: <FileDown size={14} />, onClick: importWorkflow },
        { label: t('menu.saveProject'), icon: <Save size={14} />, shortcut: 'Ctrl+S', onClick: onSaveProject },
        { label: t('menu.saveProjectAs'), icon: <FileBox size={14} />, onClick: onSaveProjectAs, disabled: !projectName },
        { label: t('menu.exportWorkflow'), icon: <Save size={14} />, onClick: () => exportWorkflow() },
        { label: t('menu.copyWorkflowText'), icon: <FileStack size={14} />, onClick: () => copyWorkflowText() },
        'separator',
        { label: t('menu.closeProject'), icon: <X size={14} />, danger: true, disabled: !projectName, onClick: onCloseProject },
      ],
    },
    {
      label: t('topbar.edit'),
      items: [
        { label: t('menu.deleteSelected'), icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, disabled: !selectedNodeId, onClick: deleteSelected },
        { label: t('menu.clearCanvas'), icon: <Eraser size={14} />, danger: true, disabled: !hasNodes, onClick: clearGraph },
      ],
    },
    {
      label: t('topbar.view'),
      items: [
        { label: t('menu.zoomIn'), icon: <ZoomIn size={14} />, shortcut: 'Ctrl+=', onClick: () => zoomIn() },
        { label: t('menu.zoomOut'), icon: <ZoomOut size={14} />, shortcut: 'Ctrl+-', onClick: () => zoomOut() },
        { label: t('menu.fitView'), icon: <Maximize size={14} />, shortcut: 'Shift+1', onClick: () => fitView({ padding: 0.2, duration: 200 }) },
        'separator',
        { label: showGrid ? t('menu.hideGrid') : t('menu.showGrid'), icon: <Grid3x3 size={14} />, onClick: toggleGrid },
      ],
    },
    {
      label: t('topbar.run'),
      items: [
        { label: running ? t('menu.stopRun') : t('menu.runFull'), icon: running ? <Square size={14} /> : <Play size={14} />, onClick: running ? () => stopWorkflow(activeWfId) : () => runWorkflow({ skipFailed: skipFailed, wfId: activeWfId }) },
        { label: t('menu.runIncremental'), icon: <FastForward size={14} />, onClick: () => runWorkflow({ incremental: true, skipFailed: skipFailed, wfId: activeWfId }), disabled: running },
        { label: t('menu.runSandbox'), icon: <Boxes size={14} />, onClick: () => runWorkflow({ skipFailed: skipFailed, sandbox: true, wfId: activeWfId }), disabled: running },
        { label: t('menu.runGitworktree'), icon: <Boxes size={14} />, onClick: () => runWorkflow({ skipFailed: skipFailed, sandbox: true, sandboxMode: 'gitworktree', wfId: activeWfId }), disabled: running },
        { label: t('menu.resumeRun'), icon: <RotateCcw size={14} />, onClick: () => resumeRun(activeWfId), disabled: running },
        { label: running ? t('menu.rerunForce') : t('menu.rerun'), icon: <RefreshCw size={14} />, onClick: () => rerunWorkflow(activeWfId) },
        'separator',
        {
          label: failFast ? t('menu.failFastOn') : t('menu.failFastOff'),
          icon: <Zap size={14} />,
          onClick: () => setFailFast(!failFast),
        },
        {
          label: skipFailed ? t('menu.skipFailedOn') : t('menu.skipFailedOff'),
          icon: <SkipForward size={14} />,
          onClick: () => setSkipFailed(!skipFailed),
          disabled: failFast,
        },
      ],
    },
    {
      label: t('topbar.tools'),
      items: [
        { label: t('menu.agents'), icon: <Bot size={14} />, onClick: () => onOpenPanel('agents') },
        { label: t('menu.plugins'), icon: <Puzzle size={14} />, onClick: () => onOpenPanel('plugins') },
        { label: t('menu.variables'), icon: <Variable size={14} />, onClick: () => onOpenPanel('variables') },
        { label: t('menu.history'), icon: <History size={14} />, onClick: () => onOpenPanel('history') },
      ],
    },
    {
      label: t('topbar.help'),
      items: [
        { label: t('menu.shortcuts'), icon: <Keyboard size={14} />, onClick: onOpenShortcuts },
        { label: t('menu.about'), icon: <Info size={14} />, onClick: () => alert(t('about.text')) },
      ],
    },
  ];
}
