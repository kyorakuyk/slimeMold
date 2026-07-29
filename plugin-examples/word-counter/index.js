/**
 * SlimeMold 示例插件入口（ESM）。
 * 约定：export default { executors: { [typeId]: async (inputs, params, ctx) => outputs } }
 * ctx 提供 logger / llm(agentId, messages) / storage / signal。
 */
export default {
  executors: {
    'example.word-counter.count': async (inputs, params, ctx) => {
      const text = String(inputs.text ?? '');
      const chars = text.length;
      const lines = text ? text.split(/\r?\n/).length : 0;
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      ctx.logger.info(`统计完成：${chars} 字符 / ${words} 词 / ${lines} 行`);
      const prefix = String(params.prefix ?? '统计结果');
      return {
        report: `${prefix}：共 ${chars} 个字符，${words} 个词，${lines} 行。`,
      };
    },
  },
};
