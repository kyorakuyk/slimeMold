/**
 * AgentHarness —— 统一 agent loop 内核（P0 核心缺口）。
 *
 * 职责：
 *  1. system prompt 拼装（委托 prompts.assembleSystemPrompt）
 *  2. 历史裁剪 / token 预算（trimHistory，按估算 token 数裁剪旧消息）
 *  3. tool_call 多轮循环（模型返回 tool_calls → 执行工具 → 回写 → 再调，直至无 tool_calls 或达 maxRounds）
 *  4. 可观测性（#4）：onThinking / onToolCall / onOutput 三类事件回调
 *  5. 错误边界（#5）：区分瞬时错误（重试）与逻辑错误（不重试）
 *
 * 设计原则：纯 TS、零 React 依赖，节点 / headless / 审查 Agent 共用。
 * 通过 opts.events 把事件推给调用方（节点接 ctx.setPartial + ctx.logger，审查 Agent 接日志）。
 */

import type { AgentConfig, ChatMessage, LLMToolSpec, ToolCall, ContentPart, ExecContext } from '../types';
import { chatWithAgent } from './agentManager';
import { toolRegistry, type ToolContext } from './toolRegistry';
import { assembleSystemPrompt, type SystemPromptParts } from './prompts';
import type { ExperienceSink } from './experienceSink';

/* ----------------------------- 错误边界（#5） ----------------------------- */

export class HarnessError extends Error {
  /** transient=true 表示可重试（网络/限流/超时）；false 为逻辑错误（不重试） */
  transient: boolean;
  constructor(message: string, transient: boolean) {
    super(message);
    this.name = 'HarnessError';
    this.transient = transient;
  }
}

/** 把任意异常分类为瞬时/逻辑错误 */
export function classifyError(e: unknown): HarnessError {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  const transientPatterns = [
    'timeout', 'timed out', 'econnreset', 'etimedout', 'network',
    '429', 'rate limit', 'rate_limit', 'too many requests',
    '500', '502', '503', '504', 'bad gateway', 'service unavailable',
    'aborted', 'execution context was destroyed',
  ];
  const isTransient = transientPatterns.some((p) => msg.includes(p));
  return new HarnessError(e instanceof Error ? e.message : String(e), isTransient);
}

/* ----------------------------- 可观测事件（#4） ----------------------------- */

export interface HarnessEvents {
  /** 模型开始思考（拿到第一轮响应前/时触发） */
  onThinking?: (info: { round: number; model: string }) => void;
  /** 工具调用发生（含入参与执行结果） */
  onToolCall?: (info: {
    round: number;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    error?: string;
  }) => void;
  /** 最终文本输出（流式逐段或整段） */
  onOutput?: (text: string, done: boolean) => void;
  /** 日志（供 StatusBar / 文件日志） */
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** nudge：连续多轮未产生沉淀（无工具调用 / 未达成有效输出）时提示复盘（#6） */
  onNudge?: (info: { rounds: number; reason: string }) => void;
}

/* ----------------------------- loop 配置 ----------------------------- */

export interface HarnessOptions {
  agent: AgentConfig;
  /** 用户/任务消息（不含 system；system 由 systemParts 拼装） */
  userMessages: ChatMessage[];
  /** system prompt 拼装部件 */
  systemParts?: SystemPromptParts;
  /** 显式指定的工具名（不传则用 toolRegistry 全部） */
  toolNames?: string[];
  /** 历史消息（跨轮复用；首次为空） */
  history?: ChatMessage[];
  /** 最大 tool_call 轮次（防失控），默认 8 */
  maxRounds?: number;
  /** token 预算（估算，超出则裁剪 history），默认 12000 */
  tokenBudget?: number;
  /** 重试配置：瞬时错误重试次数与退避基线(ms) */
  retries?: number;
  retryBaseMs?: number;
  /** 模型覆写（仅本次调用） */
  modelOverride?: string;
  /** 事件回调 */
  events?: HarnessEvents;
  /** 中止信号 */
  signal?: AbortSignal;
  /** 工具执行所需的精简上下文（sandbox / workspaceDir 等） */
  toolCtx?: Partial<ToolContext>;
  /** 轨迹采集器（#9）：传入即自动收集本轮 harness 事件，供 RunHistory / reviewer 使用 */
  sink?: ExperienceSink;
  /**
   * 作用域栈（#7）：由外层到内层排列的变量表（如 [项目级, 工作流级, 节点级]）。
   * 内层同名项覆盖外层。若 systemParts.context 未显式给出，则自动把整栈变量
   * 渲染为 system prompt 的「变量上下文」段，使模型可见当前可用变量。
   * 调用方（executor）已把 projectVariables / variables / 节点 extraVars 合并为 ctx.vars，
   * 直接以单层 [ctx.vars] 传入即可；多 agent 协作场景可显式传入多层栈。
   */
  scopeStack?: Record<string, unknown>[];
}

export interface HarnessResult {
  text: string;
  messages: ChatMessage[];
  rounds: number;
  usedTools: string[];
}

/* ----------------------------- 历史裁剪 / token 预算 ----------------------------- */

/** 粗略估算一条消息的 token 数（中文按字、英文按词，保守 ×1.3） */
function estimateTokens(m: ChatMessage): number {
  const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const others = text.length - cjk;
  return Math.ceil(cjk + others / 4) ;
}

/** 裁剪历史：保留 system 之外的较新消息，使总 token 不超过 budget */
function trimHistory(history: ChatMessage[], budget: number): ChatMessage[] {
  let total = 0;
  const kept: ChatMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const t = estimateTokens(history[i]);
    if (total + t > budget && kept.length > 0) break;
    kept.unshift(history[i]);
    total += t;
  }
  return kept;
}

/* ----------------------------- 作用域变量上下文（#7） ----------------------------- */

/**
 * 把作用域栈渲染为 system prompt 可用的「变量上下文」文本。
 * 栈由外层到内层排列，内层同名覆盖外层；此处逐层展开供模型读取。
 */
export function renderScopeContext(scopeStack: Record<string, unknown>[]): string {
  if (!scopeStack.length) return '';
  const layers = scopeStack
    .map((scope, i) => {
      const keys = Object.keys(scope);
      if (!keys.length) return '';
      const lines = keys.map((k) => {
        const v = scope[k];
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        return `- ${k} = ${s.length > 200 ? s.slice(0, 200) + '…' : s}`;
      });
      const tag = scopeStack.length > 1 ? `（第 ${i + 1} 层 / 共 ${scopeStack.length} 层）` : '';
      return `### 作用域变量${tag}\n${lines.join('\n')}`;
    })
    .filter(Boolean)
    .join('\n\n');
  if (!layers) return '';
  return [
    '## 当前可用变量（作用域上下文）',
    '以下变量在当前执行作用域中可见，可在回复或工具参数中直接引用（内层覆盖外层同名项）：',
    layers,
    '如需引用变量，使用 {{变量名}} 或纯文本描述其值；不要凭空编造未列出的变量。',
  ].join('\n');
}

/* ----------------------------- 主循环 ----------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runAgentLoop(opts: HarnessOptions): Promise<HarnessResult> {
  const {
    agent,
    userMessages,
    systemParts,
    toolNames,
    maxRounds = 8,
    tokenBudget = 12000,
    retries = 2,
    retryBaseMs = 800,
    modelOverride,
  } = opts;

  let events: HarnessEvents = opts.events ?? {};
  const signal = opts.signal ?? new AbortController().signal;
  const log = (lv: 'info' | 'warn' | 'error', m: string) => events.onLog?.(lv, m);
  // 桥接轨迹采集器：sink 的事件与用户 events 叠加（#9）
  if (opts.sink) {
    const se = opts.sink.events();
    const o = events;
    events = {
      onThinking: (i) => { se.onThinking?.(i); o.onThinking?.(i); },
      onToolCall: (i) => { se.onToolCall?.(i); o.onToolCall?.(i); },
      onOutput: (t, d) => { se.onOutput?.(t, d); o.onOutput?.(t, d); },
      onLog: (l, m) => { se.onLog?.(l, m); o.onLog?.(l, m); },
      onNudge: (i) => { se.onNudge?.(i); o.onNudge?.(i); },
    };
  }

  // 1) 拼装 system
  const tools: LLMToolSpec[] = toolRegistry.toSpecs(toolNames);
  // 若调用方未显式提供 context，则根据作用域栈自动渲染变量上下文（#7）
  const effectiveParts: SystemPromptParts = {
    ...systemParts,
    context:
      systemParts?.context ??
      (opts.scopeStack && opts.scopeStack.length ? renderScopeContext(opts.scopeStack) : undefined),
  };
  const systemText = assembleSystemPrompt({
    ...effectiveParts,
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
  });
  const systemMsg: ChatMessage = { role: 'system', content: systemText };

  // 2) 初始化消息序列：system + 裁剪后的 history + 用户消息
  let history = trimHistory(opts.history ?? [], tokenBudget - estimateTokens(systemMsg));
  const messages: ChatMessage[] = [systemMsg, ...history, ...userMessages];

  const usedTools: string[] = [];
  let rounds = 0;
  let finalText = '';

  while (rounds < maxRounds) {
    if (signal.aborted) throw new HarnessError('aborted', false);
    rounds++;
    events.onThinking?.({ round: rounds, model: modelOverride || agent.model });
    log('info', `Harness 第 ${rounds} 轮 / 模型 ${modelOverride || agent.model}`);

    // 3) 调用 LLM（带重试处理瞬时错误）
    let resp;
    let attempt = 0;
    while (true) {
      try {
        resp = await chatWithAgent(
          modelOverride ? { ...agent, model: modelOverride } : agent,
          messages,
          signal,
          (tok) => events.onOutput?.(tok, false),
          tools.length ? tools : undefined,
        );
        break;
      } catch (e) {
        const err = classifyError(e);
        if (err.transient && attempt < retries) {
          attempt++;
          log('warn', `瞬时错误（${attempt}/${retries}）： ${err.message}，退避重试`);
          await sleep(retryBaseMs * attempt);
          continue;
        }
        throw err; // 逻辑错误或重试耗尽 → 上抛
      }
    }

    finalText = resp.text ?? '';
    if (finalText) events.onOutput?.(finalText, true);
    messages.push({ role: 'assistant', content: finalText });

    // 4) 无工具调用 → loop 结束
    const calls = resp.toolCalls;
    if (!calls || !calls.length) {
      break;
    }

    // 5) 执行每个 tool_call，回写为 tool 消息
    const toolMsgs: ChatMessage[] = [];
    // 先把 assistant 的 tool_calls 片段加入消息序列（OpenAI 要求 assistant 消息携带 tool_calls）
    const assistantToolCalls: ContentPart[] = calls.map((c) => ({
      type: 'tool_call',
      name: c.name,
      args: c.args,
      id: c.id,
    }));
    messages.push({ role: 'assistant', content: assistantToolCalls });

    for (const call of calls) {
      const result = await executeToolCall(call, rounds, opts, events);
      usedTools.push(call.name);
      toolMsgs.push({
        role: 'tool',
        content: JSON.stringify(result.value ?? { error: result.error }),
        tool_call_id: call.id,
      });
    }
    messages.push(...toolMsgs);
  }

  if (rounds >= maxRounds) {
    log('warn', `达到最大轮次 ${maxRounds}，强制结束（可能存在未完成的工具链）`);
  }

  // nudge 计数器（#6）：连续多轮未产生沉淀（无工具调用且最终输出为空）则提示复盘
  const NUDGE_ROUNDS = 4;
  if (rounds >= NUDGE_ROUNDS && usedTools.length === 0 && !finalText.trim()) {
    events.onNudge?.({ rounds, reason: '连续多轮无工具调用且无有效输出，建议复盘/注入上下文' });
  }

  return { text: finalText, messages, rounds, usedTools };
}

/** 执行单个工具调用，捕获逻辑错误并回写（不影响 loop 继续） */
async function executeToolCall(
  call: ToolCall,
  round: number,
  opts: HarnessOptions,
  events: HarnessEvents,
): Promise<{ value?: unknown; error?: string }> {
  const def = toolRegistry.get(call.name);
  if (!def) {
    const error = `工具不存在：${call.name}`;
    events.onToolCall?.({ round, name: call.name, args: call.args, error });
    return { error };
  }
  try {
    const toolCtx: ToolContext = {
      logger: (opts.toolCtx?.logger as any) ?? consoleStub,
      storage: opts.toolCtx?.storage ?? memStorage,
      signal: opts.signal ?? new AbortController().signal,
      sandbox: opts.toolCtx?.sandbox,
      workspaceDir: opts.toolCtx?.workspaceDir,
    };
    const value = await def.execute(call.args ?? {}, toolCtx);
    events.onToolCall?.({ round, name: call.name, args: call.args, result: value });
    return { value };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    events.onToolCall?.({ round, name: call.name, args: call.args, error });
    return { error };
  }
}

/* ----------------------------- 兜底 ctx ----------------------------- */

const consoleStub = {
  info: (...a: any[]) => console.info('[tool]', ...a),
  warn: (...a: any[]) => console.warn('[tool]', ...a),
  error: (...a: any[]) => console.error('[tool]', ...a),
} as any;

const memStorage = {
  async get() {
    return null;
  },
  async set() {},
} as any;

/**
 * 把节点的 NodeContext 适配为 HarnessOptions（供 chat/agent 节点复用）。
 * 节点只需：const res = await runAgentLoop(buildHarnessOptions({ ctx, agent, prompt, toolNames }))
 */
export function buildHarnessOptions(args: {
  ctx: ExecContext;
  agent: AgentConfig;
  /** 用户文本提示词（与 userContent 二选一，userContent 优先用于多模态） */
  prompt?: string;
  /** 多模态用户消息内容（图文混合）；传此字段则覆盖 prompt */
  userContent?: string | ContentPart[];
  systemParts?: SystemPromptParts;
  toolNames?: string[];
  modelOverride?: string;
}): HarnessOptions {
  const { ctx, agent, prompt, userContent, systemParts, toolNames, modelOverride } = args;
  const userMessages: ChatMessage[] = [
    {
      role: 'user',
      content: userContent !== undefined ? userContent : (prompt ?? ''),
    },
  ];
  return {
    agent,
    userMessages,
    systemParts,
    toolNames,
    modelOverride,
    signal: ctx.signal,
    events: {
      onOutput: (text, done) => {
        if (!done) ctx.setPartial('text', (ctx.vars.__acc ?? '') + text);
        else ctx.setPartial('text', text);
      },
      onToolCall: (info) => {
        if (info.error) ctx.logger.error(`工具 ${info.name} 失败：${info.error}`);
        else ctx.logger.info(`工具 ${info.name} 执行完成`);
      },
      onLog: (lv, m) => ctx.logger[lv]?.(m),
    },
    toolCtx: {
      logger: ctx.logger,
      storage: ctx.storage,
      sandbox: ctx.sandbox,
    },
  };
}
