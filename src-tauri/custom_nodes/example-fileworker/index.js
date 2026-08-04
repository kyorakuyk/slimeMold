/**
 * 步骤13 阶段E 样例：自定义「职业」+ 派生「具体节点」。
 *
 * 能力来源说明：
 *  - 真实能力等级由 manifest.json 的 `extends` 字段驱动（"FileWorker" → 其 extends "SandboxWriteNode" → sandbox_write 级）。
 *  - 引擎 applyCapability 在 sandbox_write 级会把 ctx.sandbox.writeFile/readFrom/list 注入为真实实现，
 *    commitAll/commitLanes 仍为拒绝型（落地权只在 CoordinatorNode）。
 *  - 这里用函数式 executors 写法（兼容性最强）。若想用类式写法，可改为：
 *        import { SandboxWriteNode } from 'slime-mold-sdk';
 *        export class FileWorker extends SandboxWriteNode {
 *          typeId = 'custom.textWriter';
 *          async execute({ path, content }, params, ctx) { ... }
 *        }
 *    但注意：loader 用 Blob URL 动态 import，无法共享 sdk 的同一类实例，
 *    因此运行时等级仍以 manifest.extends 声明为准（类式写法主要用于代码可读性与类型提示）。
 */

// 文档性类式示例（被 DEV 校验识别为与 manifest.extends 一致）：导出 FileWorker 职业类。
// 注意：此处的 SandboxWriteNode 是本地占位基类，仅用于结构演示；
// 真实项目应从 'slime-mold-sdk'（或框架注入的 ctx.sdk）import 框架职业类以获得完整类型与 deny 守卫。
class SandboxWriteNode {
  constructor() {
    this.typeId = 'FileWorker';
  }
  async execute() {
    throw new Error('占位基类不应被直接调用');
  }
}
export class FileWorker extends SandboxWriteNode {
  constructor() {
    super();
    this.typeId = 'FileWorker';
  }
}

export default {
  executors: {
    'custom.textWriter': async (inputs, params, ctx) => {
      const path = String(inputs.path ?? '');
      const prefix = params.prefix || '';
      const content = prefix + String(inputs.content ?? '');
      if (!path) throw new Error('文本写入节点缺少 path 输入');
      // sandbox_write 级：ctx.sandbox.writeFile 为真实实现（由 applyCapability 注入）
      await ctx.sandbox.writeFile(path, content);
      ctx.logger.info(`[文本写入] 已写入 ${path}（${content.length} 字符）`);
      return { ok: `已写入 ${path}` };
    },

    'custom.jsonAppender': async (inputs, params, ctx) => {
      const path = String(inputs.path ?? '');
      const content = inputs.content;
      if (!path) throw new Error('JSON 追加节点缺少 path 输入');
      const text = JSON.stringify(content ?? {});
      await ctx.sandbox.writeFile(path, text);
      ctx.logger.info(`[JSON 追加] 已写入 ${path}`);
      return { ok: `已追加 ${path}` };
    },
  },
};
