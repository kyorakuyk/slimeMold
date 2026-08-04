/**
 * 自定义节点示例（custom_nodes/example-greeter），纯 JS（ESM）。
 *
 * 放置位置：
 *  - 程序级（全局）：<程序根>/custom_nodes/example-greeter/
 *  - 项目级（仅本项目）：<当前项目>/custom_nodes/example-greeter/
 *
 * 约定：export default { executors: { [typeId]: async (inputs, params, ctx) => outputs } }
 * - 入口必须是纯 JS；TS 语法（如 `as string`、`interface`）会导致 Blob 动态 import 失败。
 * - 自定义节点能力封顶 io：即便 manifest 声明更高等级也会被忽略，引擎 applyCapability 实际裁剪落地权。
 * - 此处仅做纯文本拼接（compute 行为），无需任何高权限。
 */
export default {
  executors: {
    'custom.greeter': async (inputs, params, ctx) => {
      const prefix = params.prefix || '你好，';
      const text = String(inputs.text ?? '');
      const out = `${prefix}${text}`;
      ctx.logger.info(`自定义问候节点输出：${out}`);
      return { out };
    },
  },
};
