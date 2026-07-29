import type {
  LoadedPlugin,
  NodeDefinition,
  NodeExecuteFn,
  PluginManifest,
} from '../types';

/**
 * 插件格式约定：
 * - manifest.json：{ id, name, entry, nodes: [{ typeId, name, inputs, outputs, params }] }
 * - 入口 JS（ESM）：export default { executors: { [typeId]: async (inputs, params, ctx) => outputs } }
 * 加载方式：源码 -> Blob URL -> 动态 import()，并向 execute 注入受限 ctx。
 */
export interface ParsedPlugin {
  plugin: LoadedPlugin;
  defs: NodeDefinition[];
}

export function validateManifest(raw: unknown): PluginManifest {
  const m = raw as PluginManifest;
  if (!m || typeof m !== 'object') throw new Error('manifest.json 不是有效对象');
  if (!m.id || typeof m.id !== 'string') throw new Error('manifest 缺少 id');
  if (!m.name) throw new Error('manifest 缺少 name');
  if (!m.entry) throw new Error('manifest 缺少 entry');
  if (!Array.isArray(m.nodes) || m.nodes.length === 0) {
    throw new Error('manifest.nodes 必须为非空数组');
  }
  for (const n of m.nodes) {
    if (!n.typeId || !n.name) throw new Error('插件节点缺少 typeId/name');
    if (!Array.isArray(n.inputs) || !Array.isArray(n.outputs)) {
      throw new Error(`节点 ${n.typeId} 的 inputs/outputs 必须为数组`);
    }
  }
  return m;
}

export async function loadPluginFromSource(
  manifestText: string,
  entryCode: string,
  source: 'dir' | 'files',
  path?: string,
): Promise<ParsedPlugin> {
  const manifest = validateManifest(JSON.parse(manifestText));

  const url = URL.createObjectURL(
    new Blob([entryCode], { type: 'text/javascript' }),
  );
  let mod: Record<string, unknown>;
  try {
    mod = await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const root = (mod.default ?? mod) as { executors?: Record<string, NodeExecuteFn> };
  const executors = root.executors ?? {};

  const defs: NodeDefinition[] = manifest.nodes.map((meta) => {
    const fn = executors[meta.typeId];
    const execute: NodeExecuteFn = fn
      ? async (inputs, params, ctx) => {
          const result = await fn(inputs, params, ctx);
          if (result === null || typeof result !== 'object') {
            throw new Error(`插件节点 ${meta.typeId} 必须返回对象作为输出`);
          }
          return result as Record<string, unknown>;
        }
      : async () => {
          throw new Error(`插件 ${manifest.id} 未提供 ${meta.typeId} 的 executor`);
        };
    return {
      typeId: meta.typeId,
      name: meta.name,
      category: meta.category ?? `插件·${manifest.name}`,
      description: meta.description,
      inputs: meta.inputs,
      outputs: meta.outputs,
      params: meta.params ?? [],
      execute,
      pluginId: manifest.id,
    };
  });

  return {
    plugin: { manifest, source, path },
    defs,
  };
}
