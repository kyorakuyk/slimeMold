import { httpFetch } from '../../platform/env';
import type { AgentConfig, ChatMessage, LLMResponse, LLMToolSpec, ContentPart } from '../../types';
import { forEachSSEData } from '../streamSSE';

/**
 * 把内部 ChatMessage[] 序列化为 OpenAI 格式。
 * - role='tool' → { role:'tool', content, tool_call_id }
 * - assistant 含 tool_call 片段 → { role:'assistant', content?, tool_calls:[{id,type:'function',function:{name,arguments}}] }
 * - 普通文本/图文 → 直译
 */
function serializeMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content), tool_call_id: m.tool_call_id };
    }
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const textParts = m.content.filter((p: ContentPart) => p.type === 'text') as Extract<ContentPart, { type: 'text' }>[];
      const calls = m.content.filter((p: ContentPart) => p.type === 'tool_call') as Extract<ContentPart, { type: 'tool_call' }>[];
      const msg: Record<string, unknown> = { role: 'assistant' };
      if (textParts.length) msg.content = textParts.map((p) => p.text).join('');
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id ?? `${c.name}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        }));
      }
      return msg;
    }
    // system / user 以及 assistant 纯文本
    return { role: m.role, content: typeof m.content === 'string' ? m.content : m.content };
  });
}

/** OpenAI 兼容协议（OpenAI / DeepSeek / Moonshot / 通义 等） */
export async function chatOpenAI(
  agent: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onToken?: (text: string) => void,
  tools?: LLMToolSpec[],
): Promise<LLMResponse> {
  const base = agent.baseUrl.replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    model: agent.model,
    messages: serializeMessages(messages),
    temperature: agent.temperature ?? 0.7,
    stream: !!onToken,
  };
  // 工具注入：模型据此返回 tool_calls
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = 'auto';
  }

  // 本地代理转发（参考 cc-switch 路由）：非空时经该代理出口（前端通道依赖 plugin-http 的 proxy 选项）。
  const proxyOpt = agent.proxyUrl?.trim() ? { proxy: agent.proxyUrl.trim() } : {};

  if (!onToken) {
    const res = await httpFetch(`${base}/chat/completions`, {
      method: 'POST',
      signal,
      ...proxyOpt,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${agent.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI 协议请求失败 (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const message = data?.choices?.[0]?.message;
    const content = message?.content;
    if (typeof content !== 'string' && !message?.tool_calls) {
      throw new Error('OpenAI 协议响应缺少 choices[0].message.content 或 tool_calls');
    }
    const toolCalls = parseToolCalls(message?.tool_calls);
    const u = data?.usage;
    const promptTokens = u?.prompt_tokens ?? 0;
    const completionTokens = u?.completion_tokens ?? 0;
    const reasoningTokens = u?.completion_tokens_details?.reasoning_tokens ?? 0;
    return {
      text: content ?? '',
      toolCalls,
      usage: u
        ? {
            promptTokens,
            cachedPromptTokens: u?.prompt_tokens_details?.cached_tokens ?? 0,
            writtenPromptTokens: 0,
            completionTokens,
            reasoningTokens,
            replyTokens: Math.max(0, completionTokens - reasoningTokens),
            totalTokens: u.total_tokens,
          }
        : undefined,
    };
  }

  // 流式路径
  const res = await httpFetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    ...proxyOpt,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${agent.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI 协议请求失败 (${res.status}): ${text.slice(0, 300)}`);
  }
  let acc = '';
  let usage: LLMResponse['usage'];
  // 流式模式下 tool_calls 以增量片段到达，需累积拼接后解析
  let toolCallAcc: { name?: string; id?: string; argsJson: string }[] = [];
  await forEachSSEData(res, (obj: any) => {
    const delta = obj?.choices?.[0]?.delta;
    if (typeof delta?.content === 'string') {
      acc += delta.content;
      onToken(delta.content);
    }
    // 累积 tool_calls 增量
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallAcc[idx]) toolCallAcc[idx] = { argsJson: '' };
        if (tc.id) toolCallAcc[idx].id = tc.id;
        if (tc.function?.name) toolCallAcc[idx].name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') toolCallAcc[idx].argsJson += tc.function.arguments;
      }
    }
    // OpenAI 流式最后一帧携带 usage
    if (obj?.usage) {
      const promptTokens = obj.usage.prompt_tokens ?? 0;
      const completionTokens = obj.usage.completion_tokens ?? 0;
      const reasoningTokens = obj.usage.completion_tokens_details?.reasoning_tokens ?? 0;
      usage = {
        promptTokens,
        cachedPromptTokens: obj.usage.prompt_tokens_details?.cached_tokens ?? 0,
        writtenPromptTokens: 0,
        completionTokens,
        reasoningTokens,
        replyTokens: Math.max(0, completionTokens - reasoningTokens),
        totalTokens: obj.usage.total_tokens,
      };
    }
  });
  const toolCalls = toolCallAcc.length
    ? toolCallAcc.map((t) => ({
        name: t.name ?? '',
        id: t.id,
        args: safeParseArgs(t.argsJson),
      }))
    : undefined;
  return { text: acc, toolCalls, usage };
}

/** 把 OpenAI 非流式 tool_calls 片段解析为统一 ToolCall[] */
function parseToolCalls(raw: any[] | undefined): import('../../types').ToolCall[] | undefined {
  if (!raw || !raw.length) return undefined;
  return raw
    .map((tc) => ({
      name: tc?.function?.name ?? '',
      id: tc?.id,
      args: safeParseArgs(tc?.function?.arguments),
    }))
    .filter((t) => t.name);
}

/** 尽力解析工具参数 JSON；解析失败返回 { _raw } 由下游工具自行报错 */
function safeParseArgs(json: string | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return { _raw: json };
  }
}
