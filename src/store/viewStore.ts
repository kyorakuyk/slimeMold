import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode = 'dark' | 'light' | 'system';
export type LocaleCode = string;

import i18n from '../i18n';
import { setSelfImprove } from '../agents/reviewer';

/** 读取系统配色偏好（prefers-color-scheme） */
function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** 把主题模式解析为实际需要套用到 <html> 的实际主题 */
function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

/** 把主题套用到 document，并在 system 模式下监听系统变化（单例） */
function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolveTheme(mode));
  if (typeof window === 'undefined') return;
  if (!applyTheme._mq) {
    applyTheme._mq = window.matchMedia('(prefers-color-scheme: dark)');
    applyTheme._mq.addEventListener('change', () => {
      const cur = useViewStore.getState().theme;
      if (cur === 'system') {
        document.documentElement.setAttribute('data-theme', resolveTheme('system'));
      }
    });
  }
}
// eslint 静态属性挂在函数上
namespace applyTheme {
  export let _mq: MediaQueryList | null = null;
}

interface ViewState {
  showGrid: boolean;
  showMinimap: boolean;
  /** 颜色主题：dark / light / system（跟随系统），持久化，全局跟随 */
  theme: ThemeMode;
  /** 鼠标模式：move=拖动画布 / select=框选节点 / click=点击选中（不拖动、不框选） */
  interactionMode: 'move' | 'select' | 'click';
  /** 全局默认代理（本地代理转发）：留空则各 agent 用自己的 proxyUrl，非空则作为默认出口 */
  globalProxyUrl: string;
  /** 设置全局默认代理出口 */
  setGlobalProxyUrl: (url: string) => void;
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
  /** 当前在右侧 Inspector 中查看的资产 id（null=查看节点信息） */
  inspectAssetId: string | null;
  /** 调试模式：开启后画布节点卡片才显示「重跑子图 / 重跑到此节点」等调试动作 */
  debugMode: boolean;
  toggleGrid: () => void;
  toggleMinimap: () => void;
  setInteractionMode: (mode: 'move' | 'select' | 'click') => void;
  toggleSplit: () => void;
  togglePanel: () => void;
  setPanelH: (h: number) => void;
  toggleInspector: () => void;
  setSplitWfId: (id: string) => void;
  setFocusedSubgraph: (id: string | null) => void;
  setInspectAsset: (id: string | null) => void;
  toggleDebug: () => void;
  setTheme: (t: ThemeMode) => void;
  /** 当前实际生效的主题（system 时按系统偏好解析为 dark/light） */
  effectiveTheme: () => 'dark' | 'light';
  /** 界面语言：zh-CN / en-US，持久化，全局跟随 */
  locale: LocaleCode;
  /** 切换界面语言（同步 i18n.changeLanguage 并持久化） */
  setLocale: (l: LocaleCode) => void;
  /** 自我学习（selfImprove）开关：开启后失败/成功运行会沉淀经验并在同类节点上注入参考 */
  selfImprove: boolean;
  /** 切换自我学习开关（同步 reviewer 模块级标志并持久化） */
  setSelfImprove: (v: boolean) => void;
}

export const useViewStore = create<ViewState>()(
  persist(
    (set, get) => ({
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
      inspectAssetId: null,
      debugMode: false,
      globalProxyUrl: '',
      locale: (typeof navigator !== 'undefined' && navigator.language?.startsWith('en') ? 'en-US' : 'zh-CN'),
      selfImprove: false,
      setSelfImprove: (v) => {
        setSelfImprove(v);
        set({ selfImprove: v });
      },
      setLocale: (l) => {
        i18n.changeLanguage(l);
        set({ locale: l });
      },
      toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
      toggleMinimap: () => set((s) => ({ showMinimap: !s.showMinimap })),
      setInteractionMode: (mode) => set({ interactionMode: mode }),
      toggleSplit: () => set((s) => ({ splitView: !s.splitView })),
      togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
      setPanelH: (h) => set({ panelH: h }),
      toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
      setSplitWfId: (id) => set({ splitWfId: id }),
      setFocusedSubgraph: (id) => set({ focusedSubgraphId: id }),
      setInspectAsset: (id) => set({ inspectAssetId: id }),
      toggleDebug: () => set((s) => ({ debugMode: !s.debugMode })),
      setGlobalProxyUrl: (v: string) => set({ globalProxyUrl: v }),
      setTheme: (t) => {
        applyTheme(t);
        set({ theme: t });
      },
      effectiveTheme: () => resolveTheme(get().theme),
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
        if (state) {
          state.focusedSubgraphId = null;
          // 持久化的主题（可能是 system）重新套用，并注册系统监听
          applyTheme(state.theme);
          // 恢复持久化的自我学习开关到 reviewer 模块级标志
          setSelfImprove(!!state.selfImprove);
        }
      },
    },
  ),
);

// 模块加载即套用初始主题（persist 可能还未 rehydrate，但默认 dark 也会先套上；
// rehydrate 后会再次 applyTheme，system 模式会注册系统监听）
applyTheme(useViewStore.getState().theme);
