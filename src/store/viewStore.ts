import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ViewState {
  showGrid: boolean;
  showMinimap: boolean;
  toggleGrid: () => void;
  toggleMinimap: () => void;
}

export const useViewStore = create<ViewState>()(
  persist(
    (set) => ({
      showGrid: true,
      showMinimap: true,
      toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
      toggleMinimap: () => set((s) => ({ showMinimap: !s.showMinimap })),
    }),
    { name: 'slime-mold-view' },
  ),
);
