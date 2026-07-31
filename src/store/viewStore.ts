import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ViewState {
  showGrid: boolean;
  showMinimap: boolean;
  /** 拆分视图：画布右侧并排显示辅助面板 */
  splitView: boolean;
  toggleGrid: () => void;
  toggleMinimap: () => void;
  toggleSplit: () => void;
}

export const useViewStore = create<ViewState>()(
  persist(
    (set) => ({
      showGrid: true,
      showMinimap: true,
      splitView: false,
      toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
      toggleMinimap: () => set((s) => ({ showMinimap: !s.showMinimap })),
      toggleSplit: () => set((s) => ({ splitView: !s.splitView })),
    }),
    { name: 'slime-mold-view' },
  ),
);
