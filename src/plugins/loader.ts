import type {
  CapabilityLevel,
  LoadedPlugin,
  NodeDefinition,
  NodeExecuteFn,
  PluginManifest,
  PluginOccupation,
} from '../types';
import { createNodeDef } from '../types';
import { OCCUPATION_CAPABILITY, capabilityOfClass } from '../nodes/sdk';
import { createSandboxedNodeExecute, sandboxManager } from './sandbox';

/**
 * 插件格式约定（步骤 13 增强后）：
 * - manifest.json：{ id, name, entry, nodes: [{ typeId, name, inputs, outputs, params, extends? }], occupations? }
 * - 入口 JS（ESM）：
 *    ① 简单节点：export default { executors: { [typeId]: async (inputs, params, ctx) => outputs } } （能力封顶 io）
 *    ② 类式节点：export class Xxx extends SandboxWriteNode { typeId='...'; async execute(i,p,c){...} }
 *       —— 配合 manifest 节点 `extends: "SandboxWriteNode"` 声明继承式提权（见步骤 13）。
 * 加载方式：源码 -> Blob URL -> 动态 import()，并向 execute 注入受限 ctx。
 *
 * 信任模型（重要，S5）：
 * - 当前插件在主 WebView 内通过 Blob URL 动态 import() 执行，与宿主共享同一个 JS
 *   运行时与 DOM 权限，**不是进程级沙箱**。因此插件被视作「可信本地代码」——
 *   即用户显式安装（拖入/扫码/manifest 导入）的节点包，类比 ComfyUI 的 custom nodes。
 * - 框架通过 `capability` / 职业父类（ComputeNode/IoNode/SandboxWriteNode/...）做权限边界，
 *   但这是「约定式」约束，越权声明会被忽略；插件若在 execute 内直接调用平台能力仍可越界。
 * - 据此：**仅允许加载来自本机文件系统的插件**（程序级 resourceDir / 项目级 custom_nodes /
 *   manifest 文件导入）。禁止运行时从任意远端 URL 拉取并执行插件源码。
 * - 若未来需要支持「网络下载的第三方插件」，必须升级为进程级隔离（独立 Tauri WebView /
 *   Web Worker / Rust 侧执行 + 显式能力授权），不能在主 WebView 内直接 import()。
 */
export interface ParsedPlugin {
  plugin: LoadedPlugin;
  defs: NodeDefinition[];
}

/** 框架职业类名的集合（manifest extends 只可引用这些或本包 occupations 定义的职业） */
const FRAMEWORK_OCCUPATIONS = new Set(Object.keys(OCCUPATION_CAPABILITY));

export function validateManifest(raw: unknown, source: 'dir' | 'files' | 'custom' = 'dir'): PluginManifest {
  const m = raw as PluginManifest;
  if (!m || typeof m !== 'object') throw new Error('manifest.json 不是有效对象');
  if (!m.id || typeof m.id !== 'string') throw new Error('manifest 缺少 id');
  if (!m.name) throw new Error('manifest 缺少 name');
  if (!m.entry) throw new Error('manifest 缺少 entry');
  if (!Array.isArray(m.nodes) || m.nodes.length === 0) {
    throw new Error('manifest.nodes 必须为非空数组');
  }
  // 自定义职业（occupations）校验：name 唯一、extends 必须指向框架职业
  const occNames = new Set<string>();
  for (const occ of m.occupations ?? []) {
    if (!occ.name || !occ.extends) throw new Error(`职业 ${occ.name ?? '?'} 缺少 name/extends`);
    if (occNames.has(occ.name)) throw new Error(`职业类名重复：${occ.name}`);
    occNames.add(occ.name);
    if (!FRAMEWORK_OCCUPATIONS.has(occ.extends)) {
      throw new Error(`职业 ${occ.name} 继承的 ${occ.extends} 不是框架职业（只可继承 ${[...FRAMEWORK_OCCUPATIONS].join('/')}）`);
    }
  }
  for (const n of m.nodes) {
    if (!n.typeId || !n.name) throw new Error('插件节点缺少 typeId/name');
    if (!Array.isArray(n.inputs) || !Array.isArray(n.outputs)) {
      throw new Error(`节点 ${n.typeId} 的 inputs/outputs 必须为数组`);
    }
    // 阶段 C 硬校验：若声明 extends，必须指向「框架职业」或「本包 occupations 中登记的职业」
    if (n.extends) {
      if (!FRAMEWORK_OCCUPATIONS.has(n.extends) && !occNames.has(n.extends)) {
        throw new Error(
          `节点 ${n.typeId} 的 extends "${n.extends}" 非法：须为框架职业（${[...FRAMEWORK_OCCUPATIONS].join('/')}）或本包 occupations 登记的职业`,
        );
      }
    }
    // 阶段 C：禁止仅靠 minCapability「配置文件后门」越权——extends 继承才是唯一提权入口。
    // 仅对 custom 来源强制（dir/files 正式插件由引擎 applyCapability 裁剪，保留旧宽松行为）。
    if (
      source === 'custom' &&
      !n.extends &&
      n.minCapability &&
      n.minCapability !== 'compute' &&
      n.minCapability !== 'io'
    ) {
      throw new Error(
        `节点 ${n.typeId} 声明越权等级 ${n.minCapability} 但缺少 extends 继承声明（提权须通过继承职业类，而非 minCapability 字段）`,
      );
    }
  }
  return m;
}

/**
 * 步骤 13 阶段 B/E：把节点声明的「职业类名」（extends）解析为最终 CapabilityLevel。
 * 解析链：
 *   - 框架职业（SandboxWriteNode 等）→ OCCUPATION_CAPABILITY 直接映射。
 *   - 自定义职业（occupations 中登记）→ 取其 extends 的框架职业等级。
 * 若未声明 extends（纯 executors 函数节点）→ 自定义来源封顶 io，正式插件默认 io。
 */
export function resolveExtendsCapability(
  extendsName: string | undefined,
  occupations: PluginOccupation[],
  source: 'dir' | 'files' | 'custom',
  manifestMin?: CapabilityLevel,
): CapabilityLevel {
  // 纯函数式节点（无 extends）：沿用旧规则——custom 封顶 io，dir/files 尊重 manifestMin 或 io
  if (!extendsName) {
    if (source === 'custom') {
      // 仅尊重更低的 compute 声明；越权声明一律回落 io（兼容旧行为，且杜绝"配置文件后门"）
      return manifestMin && manifestMin !== 'sandbox_write' && manifestMin !== 'coordinator' && manifestMin !== 'system'
        ? manifestMin
        : 'io';
    }
    return manifestMin ?? 'io';
  }
  // 自定义职业 → 递归解析其 extends 的框架职业
  if (!FRAMEWORK_OCCUPATIONS.has(extendsName)) {
    const occ = occupations.find((o) => o.name === extendsName);
    if (!occ) throw new Error(`extends "${extendsName}" 未在 occupations 中登记`);
    const fw = OCCUPATION_CAPABILITY[occ.extends as keyof typeof OCCUPATION_CAPABILITY];
    if (!fw) throw new Error(`职业 ${occ.name} 继承的 ${occ.extends} 无对应能力等级`);
    return fw;
  }
  const lvl = OCCUPATION_CAPABILITY[extendsName as keyof typeof OCCUPATION_CAPABILITY];
  if (!lvl) throw new Error(`extends "${extendsName}" 无对应能力等级`);
  return lvl;
}

export interface LoadPluginOptions {
  path?: string;
  /**
   * 沙箱执行（H2）：为 true 时插件节点 execute 经 Web Worker 执行（能力白名单由
   * 宿主下发并拦截）。缺省 false——保持现有主线程 Blob import 路径（兼容/回退）。
   * 浏览器无 Worker 环境自动回退主线程执行。
   */
  sandbox?: boolean;
}

export async function loadPluginFromSource(
  manifestText: string,
  entryCode: string,
  source: 'dir' | 'files' | 'custom',
  path?: string,
  options?: LoadPluginOptions,
): Promise<ParsedPlugin> {
  const sandboxEnabled = options?.sandbox ?? false;
  const manifest = validateManifest(JSON.parse(manifestText), source);
  const occupations = manifest.occupations ?? [];

  // P0 修复（Codex 第三轮）：sandbox: true 时禁止主线程 import(entryCode)。
  // 否则恶意插件的顶层代码会在宿主 WebView（DOM/Tauri IPC 权限）先执行一遍，
  // Worker 只隔离后续 execute，不构成「插件加载隔离」。沙箱模式下：
  // - 不读取 executors / 类导出（由 Worker 内自行 import 并验证 executors[typeId] 存在，
  //   缺失时经 RPC load-error / execute:error 报错）；
  // - 类式插件（extends 声明）暂不支持沙箱——顶层类定义同样需在主线程解析原型链，
  //   因此沙箱模式明确拒绝，避免「主线程预执行」漏洞与能力识别偏差；
  // - 节点定义完全由 manifest 构造，execute 直接是 Worker 包装器。
  if (sandboxEnabled) {
    const classNode = manifest.nodes.find((n) => n.extends);
    if (classNode) {
      throw new Error(
        `插件 ${manifest.id} 的节点 ${classNode.typeId} 声明了 extends（类式插件）。` +
          `类式插件暂不支持沙箱模式（H2 PoC 仅支持函数式 executors；类式沙箱后续单独设计）。`,
      );
    }
    const defs = manifest.nodes.map((meta) => {
      const minCapability = resolveExtendsCapability(meta.extends, occupations, source, meta.minCapability);
      return createNodeDef({
        typeId: meta.typeId,
        name: meta.name,
        category: meta.category ?? `自定义·${manifest.name}`,
        description: meta.description,
        inputs: meta.inputs,
        outputs: meta.outputs,
        params: meta.params ?? [],
        pluginId: manifest.id,
        minCapability,
        // 沙箱 execute：纯 Worker 包装器（无主线程预执行）。fallback 在无 Worker 环境
        // 下会报「沙箱需要 Worker」，而不会回退到主线程执行——保持「不预执行」承诺。
        execute: createSandboxedNodeExecute(
          sandboxManager,
          manifest.id,
          entryCode,
          minCapability,
          meta.typeId,
          async () => {
            throw new Error(
              `插件 ${manifest.id} 的节点 ${meta.typeId} 以沙箱模式加载，但当前环境无 Web Worker，无法执行。`,
            );
          },
        ),
      });
    });
    return { plugin: { manifest, source, path }, defs };
  }

  const url = URL.createObjectURL(
    new Blob([entryCode], { type: 'text/javascript' }),
  );
  let mod: Record<string, unknown>;
  try {
    mod = await import(/* @vite-ignore */ url);
  } catch (e) {
    // 入口必须是纯 JS：若源码含 TS 语法（如 `as xxx`、类型注解），
    // 浏览器原生 import() 会报 Unexpected identifier / SyntaxError。
    const msg = e instanceof Error ? e.message : String(e);
    if (/Unexpected|SyntaxError|Unexpected token/.test(msg) && /\bas\b|interface\s|:\s*\w+\s*[=\n;]|:\s*\w+\s*\)/.test(entryCode)) {
      throw new Error(
        `入口 index.js 疑似包含 TypeScript 语法（如 \`as string\`、类型注解），但动态 import 只接受纯 JS。请删除类型标注后重试。原始错误：${msg}`,
      );
    }
    throw e;
  } finally {
    URL.revokeObjectURL(url);
  }

  const root = (mod.default ?? mod) as {
    executors?: Record<string, NodeExecuteFn>;
  } & Record<string, unknown>;
  const executors = root.executors ?? {};

  // 阶段 C 硬校验（DEV）：若节点声明 extends，校验 index.js 确实导出了同名类，且其原型链命中该职业
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    for (const n of manifest.nodes) {
      if (!n.extends) continue;
      const exported = root[n.extends];
      if (typeof exported !== 'function') {
        console.warn(
          `[loader] 节点 ${n.typeId} 声明 extends "${n.extends}"，但 index.js 未导出同名类（${typeof exported}）。代码与声明不一致将导致能力识别偏差。`,
        );
        continue;
      }
      const derived = capabilityOfClass(exported);
      const declared = resolveExtendsCapability(n.extends, occupations, source);
      if (derived && derived !== declared) {
        console.warn(
          `[loader] 节点 ${n.typeId} 的 extends "${n.extends}" 声明等级 ${declared}，但类原型链识别为 ${derived}，二者不一致。以 manifest 声明为准。`,
        );
      }
    }
  }

  const defs = manifest.nodes.map((meta) => {
    const minCapability = resolveExtendsCapability(meta.extends, occupations, source, meta.minCapability);
    // 步骤 13：execute 解析——优先用「类式」导出（index.js 导出同名类，取其 execute 方法），
    // 否则回退旧的「executors[typeId]」函数式写法。两者并存，向后兼容。
    const exportedClass = meta.extends ? (root[meta.extends] as { prototype?: { execute?: unknown } } | undefined) : undefined;
    const classProto = exportedClass?.prototype as { execute?: (i: Record<string, unknown>, p: Record<string, unknown>, c: unknown) => Promise<Record<string, unknown>> } | undefined;
    const classExecute = classProto?.execute?.bind?.(Object.create(classProto));
    const execFn: NodeExecuteFn | undefined =
      classExecute ?? (executors[meta.typeId] as NodeExecuteFn | undefined);

    return createNodeDef({
      typeId: meta.typeId,
      name: meta.name,
      category: meta.category ?? `自定义·${manifest.name}`,
      description: meta.description,
      inputs: meta.inputs,
      outputs: meta.outputs,
      params: meta.params ?? [],
      pluginId: manifest.id,
      // 能力等级由 extends 声明（继承式提权）或旧规则决定；引擎 applyCapability 仍按此等级裁剪注入。
      minCapability,
      execute: execFn
        ? (() => {
            // 主线程执行（fallback / 默认路径）
            const direct: NodeExecuteFn = async (inputs, params, ctx) => {
              const result = await execFn(inputs, params, ctx);
              if (result === null || typeof result !== 'object') {
                throw new Error(`插件节点 ${meta.typeId} 必须返回对象作为输出`);
              }
              return result as Record<string, unknown>;
            };
            return direct;
          })()
        : async () => {
            throw new Error(`插件 ${manifest.id} 未提供 ${meta.typeId} 的 executor（亦无同名职业类 execute）`);
          },
    });
  });

  return {
    plugin: { manifest, source, path },
    defs,
  };
}
