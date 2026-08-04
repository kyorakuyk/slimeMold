/**
 * SlimeMold 示例插件入口（ESM）。
 *
 * 推荐写法：使用 createNodeDef 工厂声明节点，自动获得缺省字段兜底
 * （category 默认「自定义」、params 默认 []、role 按 typeId 前缀推断），
 * 并在开发期获得端口 id 唯一性校验（控制台 warn，不抛错）。
 *
 * 约定：export default { executors: { [typeId]: async (inputs, params, ctx) => outputs } }
 * 注意：此处 index.js 仅提供 executor 实现；节点元信息（端口/能力）在 manifest.json 声明，
 * loader 内部会调用 createNodeDef 把 manifest + executor 组装成完整 NodeDefinition。
 *
 * 若你希望完全在 JS 侧声明节点（不走 manifest 端口），也可直接：
 *   import { createNodeDef } from 'slime-mold-types'; // 需打包环境支持
 * 但当前插件以 manifest 驱动为主，以下保持与内置风格一致。
 */
export default {
  executors: {
    'example.math-sum.add': async (inputs, params, ctx) => {
      const a = Number(inputs.a ?? 0);
      const b = Number(inputs.b ?? 0);
      const out = a + b;
      ctx.logger.info(`求和：${a} + ${b} = ${out}`);
      return { out };
    },
  },
};
