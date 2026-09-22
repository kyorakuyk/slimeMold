import { create } from 'zustand';
import type { LoadedPlugin } from '../types/plugin';
import type { NodeDefinition } from '../types/node';

interface RegistryState {
  defs: Record<string, NodeDefinition>;
  plugins: LoadedPlugin[];
  register: (defs: NodeDefinition[]) => void;
  registerPlugin: (plugin: LoadedPlugin, defs: NodeDefinition[]) => void;
  unregisterPlugin: (pluginId: string) => void;
}

export const useRegistryStore = create<RegistryState>((set) => ({
  defs: {},
  plugins: [],

  register: (list) =>
    set((s) => {
      const defs = { ...s.defs };
      for (const d of list) defs[d.typeId] = d;
      return { defs };
    }),

  registerPlugin: (plugin, list) =>
    set((s) => {
      // 同 id 插件重载：先移除旧节点定义
      const defs: Record<string, NodeDefinition> = {};
      for (const [k, v] of Object.entries(s.defs)) {
        if (v.pluginId !== plugin.manifest.id) defs[k] = v;
      }
      for (const d of list) defs[d.typeId] = d;
      const plugins = [
        ...s.plugins.filter((p) => p.manifest.id !== plugin.manifest.id),
        plugin,
      ];
      return { defs, plugins };
    }),

  unregisterPlugin: (pluginId) =>
    set((s) => {
      const defs: Record<string, NodeDefinition> = {};
      for (const [k, v] of Object.entries(s.defs)) {
        if (v.pluginId !== pluginId) defs[k] = v;
      }
      return {
        defs,
        plugins: s.plugins.filter((p) => p.manifest.id !== pluginId),
      };
    }),
}));

export function getNodeDef(typeId: string): NodeDefinition | undefined {
  const defs = useRegistryStore.getState().defs;
  const exact = defs[typeId];
  if (exact) return exact;
  // 大小写不敏感回退：容忍 JSON 里 writefile / WriteFile 等写法
  const lower = typeId.toLowerCase();
  const hit = Object.values(defs).find((d) => d.typeId.toLowerCase() === lower);
  return hit;
}

// 开发期调试钩子：暴露 store 便于 playwright/控制台验收（仅 DEV，不影响生产构建）
if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
  (window as unknown as { __registry?: typeof useRegistryStore }).__registry = useRegistryStore;
}
