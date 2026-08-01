import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ViewState {
  showGrid: boolean;
  showMinimap: boolean;
  /** 鼠标模式：move=拖动画布 / select=框选节点 / click=点击选中（不拖动、不框选） */
  interactionMode: 'move' | 'select' | 'click';
  /** 拆分视图：画布右侧并排显示辅助面板 */
  splitView: boolean;
  /** 底侧边栏（底部面板）开关状态，持久化以记住上次选择 */
  panelOpen: boolean;
  /** 底侧边栏高度，持久化以记住上次拖拽尺寸 */
  panelH: number;
  /** 右侧边栏（检查器）开关状态，持久化以记住上次选择 */
  inspectorOpen: boolean;
  /** 拆分视图中右侧分栏显示的工作流 id（持久化，记住上次选择） */
  splitWfId: string;
  toggleGrid: () => void;
  toggleMinimap: () => void;
  setInteractionMode: (mode: 'move' | 'select' | 'click') => void;
  toggleSplit: () => void;
  togglePanel: () => void;
  setPanelH: (h: number) => void;
  toggleInspector: () => void;
  setSplitWfId: (id: string) => void;
}

export const useViewStore = create<ViewState>()(
  persist(
    (set) => ({
      showGrid: true,
      showMinimap: false,
      interactionMode: 'move',
      splitView: false,
      panelOpen: true,
      panelH: 208,
      inspectorOpen: true,
      splitWfId: '',
      toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
      toggleMinimap: () => set((s) => ({ showMinimap: !s.showMinimap })),
      setInteractionMode: (mode) => set({ interactionMode: mode }),
      toggleSplit: () => set((s) => ({ splitView: !s.splitView })),
      togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
      setPanelH: (h) => set({ panelH: h }),
      toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
      setSplitWfId: (id) => set({ splitWfId: id }),
    }),
    { name: 'slime-mold-view' },
  ),
);
