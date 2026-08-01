import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'dark' | 'light';

interface ViewState {
  showGrid: boolean;
  showMinimap: boolean;
  /** 颜色主题：dark / light，持久化，全局跟随 */
  theme: 'dark' | 'light';
  /** 鼠标模式：move=拖动画布 / select=框选节点 / click=点击选中（不拖动、不框选） */
  interactionMode: 'move' | 'select' | 'click';
  /** 全局默认代理（本地代理转发）：留空则各 agent 用自己的 proxyUrl，非空则作为默认出口 */
  globalProxyUrl: string;
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
  /** 当前正在编辑的子图作用域 id（双击折叠组进入子图；null=父图） */
  focusedSubgraphId: string | null;
  toggleGrid: () => void;
  toggleMinimap: () => void;
  setInteractionMode: (mode: 'move' | 'select' | 'click') => void;
  toggleSplit: () => void;
  togglePanel: () => void;
  setPanelH: (h: number) => void;
  toggleInspector: () => void;
  setSplitWfId: (id: string) => void;
  setFocusedSubgraph: (id: string | null) => void;
  setTheme: (t: 'dark' | 'light') => void;
}

export const useViewStore = create<ViewState>()(
  persist(
    (set) => ({
      showGrid: true,
      showMinimap: false,
      theme: 'dark',
      interactionMode: 'move',
      splitView: false,
      panelOpen: true,
      panelH: 208,
      inspectorOpen: true,
      splitWfId: '',
      focusedSubgraphId: null,
      globalProxyUrl: '',
      toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
      toggleMinimap: () => set((s) => ({ showMinimap: !s.showMinimap })),
      setInteractionMode: (mode) => set({ interactionMode: mode }),
      toggleSplit: () => set((s) => ({ splitView: !s.splitView })),
      togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
      setPanelH: (h) => set({ panelH: h }),
      toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
      setSplitWfId: (id) => set({ splitWfId: id }),
      setFocusedSubgraph: (id) => set({ focusedSubgraphId: id }),
      setGlobalProxyUrl: (v: string) => set({ globalProxyUrl: v }),
      setTheme: (t) => {
        document.documentElement.setAttribute('data-theme', t);
        set({ theme: t });
      },
    }),
    {
      name: 'slime-mold-view',
      // focusedSubgraphId 是临时 UI 状态（双击进入子图）：
      // 不能持久化，否则异常退出时残留的 sg id 会让子图编辑层在下次启动时
      // 盖住整个画布，表现为「双击进不了子图」。
      partialize: (s) => {
        const { focusedSubgraphId: _omit, ...rest } = s;
        return rest as ViewState;
      },
      onRehydrateStorage: () => (state) => {
        if (state) state.focusedSubgraphId = null;
      },
    },
  ),
);
