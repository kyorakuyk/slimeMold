import i18n from '../i18n';

export interface GlobalShortcutDependencies {
  isReplayMode?: () => boolean;
  exportWorkflow: () => void;
  undo: () => void;
  redo: () => void;
  newWorkflowInProject: () => void;
  copySelection: () => void;
  pasteClipboard: () => void;
  duplicateSelection: () => void;
  selectAll: () => void;
  toggleNodeBypass: (id: string) => void;
  toggleNodeMute: (id: string) => void;
  addLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  getSelectedNodeIds: () => string[];
  getSubgraphCount: () => number;
  createGroup: (nodeIds: string[]) => void;
  packSelectionAsSubgraph: (nodeIds: string[], name: string) => void;
  promptForName: (title: string, initial: string, onConfirm: (name: string) => void) => void;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.isContentEditable
  );
}

const REPLAY_BLOCKED_SHORTCUTS = new Set(['s', 'z', 'y', 'n', 'c', 'v', 'd', 'a', 'b', 'm', 'g']);

export function installGlobalShortcuts(deps: GlobalShortcutDependencies): () => void {
  // 把快捷键映射到注入的 action ports；编辑控件中的选择快捷键不抢占，保存/新建仍是全局键。
  // UI 输入不另建项目事实，状态仍由对应 action owner 更新（ADR-SM-005）。
  const onKey = (event: KeyboardEvent) => {
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (deps.isReplayMode?.() && REPLAY_BLOCKED_SHORTCUTS.has(key)) {
      event.preventDefault();
      return;
    }
    const inEditable = isEditableTarget(event.target);

    if (key === 's') {
      event.preventDefault();
      deps.exportWorkflow();
    } else if (key === 'z') {
      if (inEditable) return;
      event.preventDefault();
      if (event.shiftKey) deps.redo();
      else deps.undo();
    } else if (key === 'y') {
      if (inEditable) return;
      event.preventDefault();
      deps.redo();
    } else if (key === 'n') {
      event.preventDefault();
      deps.newWorkflowInProject();
    } else if (key === 'c') {
      if (inEditable) return;
      event.preventDefault();
      deps.copySelection();
    } else if (key === 'v') {
      if (inEditable) return;
      event.preventDefault();
      deps.pasteClipboard();
    } else if (key === 'd') {
      if (inEditable) return;
      event.preventDefault();
      event.stopPropagation();
      deps.duplicateSelection();
    } else if (key === 'a') {
      if (inEditable) return;
      event.preventDefault();
      deps.selectAll();
    } else if (key === 'b') {
      if (inEditable) return;
      event.preventDefault();
      deps.getSelectedNodeIds().forEach((id) => deps.toggleNodeBypass(id));
    } else if (key === 'm') {
      if (inEditable) return;
      event.preventDefault();
      deps.getSelectedNodeIds().forEach((id) => deps.toggleNodeMute(id));
    } else if (key === 'g') {
      event.preventDefault();
      const ids = deps.getSelectedNodeIds();
      if (ids.length === 0) {
        deps.addLog('error', i18n.t('log.shortcut.selectNodesBeforeGrouping'));
        return;
      }
      if (event.shiftKey) {
        deps.promptForName(
          i18n.t('dialog.subgraphNamePrompt'),
          `子图 ${deps.getSubgraphCount() + 1}`,
          (name) => deps.packSelectionAsSubgraph(ids, name),
        );
      } else {
        deps.createGroup(ids);
      }
    }
  };

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
