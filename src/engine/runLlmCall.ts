/**
 * runLlmCall.ts — ctx.llm 的调用骨架（executor 拆分，executeNode 可分离部分）。
 *
 * 把 executeNode.ctx.llm 的「fallback 调用循环」抽为纯编排函数 runLlmWithFallback：
 * - 按决策候选链逐级尝试（限流 + 成本记录 + harness/普通调用分发）
 * - 全部失败抛最后一个错误（信号中止立即抛）
 * - 成本记录经注入的 recordCost 回调（调用方绑定 trackCost）
 *
 * 与 AgentRouter 决策（agents/agentDecision.ts）分离：本函数只管「拿到候选后怎么调」，
 * 不涉及「选谁」。事件/日志经注入回调，不直接依赖 store。
 */
import type { AgentConfig, ChatMessage, CostRecord } from '../types/agent';
import type { SandboxHandle } from '../types/node';
import { runAgentLoop } from '../agents/harness';
import { getChannel } from '../agents/llmChannel';
import { withRetry, type Semaphore } from './rateLimiter';
import type { ExperienceSink } from '../agents/experienceSink';

/** runLlmWithFallback 输入。 */
export interface RunLlmCallInput {
  /** 候选 agent 链（决策结果 decision.chain 对应） */
  chainIds: string[];
  /** 候选解析（chain id → agent） */
  byId: (id: string) => AgentConfig | undefined;
  messages: ChatMessage[];
  /** 已注入经验的 effectiveMessages（由调用方构造） */
  effectiveMessages: ChatMessage[];
  onToken?: (text: string) => void;
  modelOverride?: string;
  toolNames?: string[];
  signal: AbortSignal;
  limiter: Semaphore;
  maxRetries: number;
  retryBaseMs: number;
  /** 成本记录回调（绑定 executor 的 trackCost） */
  recordCost: (rec: CostRecord) => void;
  /** 节点上下文（日志/事件） */
  node: { id: string; label: string; typeId: string };
  sink: ExperienceSink | null;
  vars: Record<string, unknown>;
  /** harness 工具上下文（storage/sandbox） */
  toolStorage: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> } | undefined;
  toolSandbox: SandboxHandle | undefined;
  llmChannel: 'backend' | 'frontend';
  /** 运行代次（中止判断） */
  myRun: number;
  targetRunId: number;
  logger: {
    info: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
  };
}

/** 逐级尝试候选 agent；全部失败抛最后一个错误。返回最终文本。 */
export async function runLlmWithFallback(input: RunLlmCallInput): Promise<string> {
  const {
    chainIds,
    byId,
    effectiveMessages,
    onToken,
    modelOverride,
    toolNames,
    signal,
    limiter,
    maxRetries,
    retryBaseMs,
    recordCost,
    node,
    sink,
    vars,
    llmChannel,
    myRun,
    targetRunId,
    logger,
  } = input;

  let lastErr: unknown = null;
  for (const cid of chainIds) {
    const cand = byId(cid);
    if (!cand) continue;
    const effective = modelOverride ? { ...cand, model: modelOverride } : cand;
    const release = await limiter.acquire(signal);
    const callStart = performance.now();
    const rec = (usage: CostRecord['usage'], ok: boolean, errMsg?: string) => {
      recordCost({
        nodeId: node.id,
        nodeLabel: node.label,
        agentId: cand.id,
        model: effective.model,
        usage,
        durationMs: Math.round(performance.now() - callStart),
        at: new Date().toISOString(),
        ok,
        error: errMsg,
      });
    };
    try {
      // 工具多轮：走 AgentHarness（tool_call 循环由 harness 内部驱动）
      if (toolNames && toolNames.length) {
        const sys = effectiveMessages.find((m) => m.role === 'system');
        const userMsgs = effectiveMessages.filter((m) => m.role !== 'system');
        const result = await runAgentLoop({
          agent: effective,
          userMessages: userMsgs,
          systemParts: sys ? { role: sys.content as string } : undefined,
          toolNames,
          scopeStack: [vars],
          signal,
          modelOverride: modelOverride || undefined,
          events: sink
            ? (() => {
                const se = sink.events();
                return {
                  onThinking: se.onThinking,
                  onToolCall: se.onToolCall,
                  onOutput: (text: string, done: boolean) => {
                    se.onOutput?.(text, done);
                    if (!done && onToken) onToken(text);
                  },
                  onLog: (lv: string, m: string) => {
                    const level = lv as 'info' | 'warn' | 'error';
                    se.onLog?.(level, m);
                    logger.info(m);
                  },
                };
              })()
            : {
                onOutput: (text: string, done: boolean) => {
                  if (!done && onToken) onToken(text);
                },
                onLog: (_lv: string, m: string) => logger.info(m),
              },
          toolCtx: { logger, storage: input.toolStorage, sandbox: input.toolSandbox },
        });
        rec(undefined, true);
        release();
        return result.text;
      }
      // 普通调用：channel.chat（限流 + 重试 + 遥测）
      const channel = getChannel(llmChannel);
      const resp = await withRetry(
        () =>
          channel.chat({
            agent: effective,
            messages: effectiveMessages,
            signal,
            onToken,
          }),
        {
          retries: maxRetries,
          baseDelay: retryBaseMs,
          signal,
          onRetry: (_msg, delay, attempt) =>
            logger.info(`「${node.label}」网络有点忙，正在第 ${attempt} 次重试…（稍等约 ${(delay / 1000).toFixed(1)} 秒）`),
        },
      );
      rec(resp.usage, true);
      release();
      return resp.text;
    } catch (err) {
      const em = err instanceof Error ? err.message : String(err);
      rec(undefined, false, em);
      release();
      if (signal.aborted || targetRunId !== myRun) throw err;
      lastErr = err;
      if (cid !== chainIds[chainIds.length - 1]) {
        logger.warn(`「${node.label}」智能体「${cand.name}」调用失败，尝试候选链下一项：${em}`);
      }
    }
  }
  const finalMsg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? '未知错误');
  logger.error(`「${node.label}」所有候选智能体均调用失败：${finalMsg}`);
  throw lastErr ?? new Error(`没有可用智能体候选：${node.typeId}`);
}
