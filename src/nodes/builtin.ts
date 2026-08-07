import type { NodeDefinition } from '../types';
import { useRegistryStore } from '../store/registryStore';
import { creativeNodes } from './creative';
import { toolRegistry } from '../agents/toolRegistry';
import { makeBuiltinTools } from './builtinTools';

import { inputNodes } from './builtin/input';
import { mediaNodes } from './builtin/media';
import { aiNodes } from './builtin/ai';
import { textNodes } from './builtin/text';
import { flowNodes } from './builtin/flow';
import { toolNodes } from './builtin/tool';
import { auditNodes } from './builtin/audit';
import { dispatchNodes } from './builtin/dispatch';
import { coordNodes } from './builtin/coord';
import { workerNodes } from './builtin/worker';

// 原 builtin.ts 的节点定义本体已按 category 物理拆分到 ./builtin/ 子目录，
// 此处仅做聚合（行为等价）。拆分后单测网见 builtinHelpers.test / workflowSerialize.test。
// 注意：节点级纯函数助手（inferFilename/renderTemplate/isTruthy/...）在 builtinHelpers.ts；
// 各类别内部共享的局部助手（publishDesignArtifact/resolveByContent/buildBackflow/resolveWorkerCtx/...）
// 随相关类别走，不在此重复导出。

// Community 友好分类顺序：输入 → 文本 → AI → 流程 → 工具 → 输出（普通用户语义）
export const CATEGORY_ORDER = ['输入', '文本', 'AI', '流程', '工具', '输出', '审计', '派发', '协调', 'worker'] as const;

/** 全部内置节点定义（含 creative 节点）。各子文件已统一经 createNodeDef 包装，此处仅聚合。 */
export const builtinDefs: NodeDefinition[] = [
  ...inputNodes,
  ...mediaNodes,
  ...aiNodes,
  ...textNodes,
  ...flowNodes,
  ...toolNodes,
  ...auditNodes,
  ...dispatchNodes,
  ...coordNodes,
  ...workerNodes,
  ...creativeNodes,
];

export function registerBuiltins(): void {
  useRegistryStore.getState().register(builtinDefs);
  // 内置工具（writeFile/http）下沉为 ToolRegistry 一等公民，供 AgentHarness 按名调用
  // 必须在 builtinDefs 就绪后注册（builtinTools 复用节点 execute）
  // 注意：通过 makeBuiltinTools(builtinDefs) 惰性构造，避免 builtinTools.ts 顶层
  // import builtinDefs 形成循环依赖 → TDZ 崩溃（详见 builtinTools.ts 顶部注释）
  toolRegistry.register(makeBuiltinTools(builtinDefs));
}
