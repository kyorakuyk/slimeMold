import { httpFetch } from '../../platform/env';
import type { AgentConfig, ChatMessage, LLMResponse } from '../../types';
import { forEachSSEData } from '../streamSSE';

/** Anthropic Messages API */
export async function chatAnthropic(
  agent: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onToken?: (text: string) => void,
): Promise<LLMResponse> {
  const base = agent.baseUrl.replace(/\/+$/, '');
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((s) => s)
    .join('\n');
  const chat = messages.filter((m) => m.role !== 'system');

  const body = {
    model: agent.model,
    max_tokens: 4096,
    temperature: agent.temperature ?? 0.7,
    ...(system ? { system } : {}),
    messages: chat,
    stream: !!onToken,
  };

  if (!onToken) {
    const res = await httpFetch(`${base}/v1/messages`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': agent.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic 请求失败 (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.content?.[0]?.text;
    if (typeof content !== 'string') {
      throw new Error('Anthropic 响应缺少 content[0].text');
    }
    const u = data?.usage;
    return {
      text: content,
      usage: u
        ? {
            promptTokens: u.input_tokens,
            completionTokens: u.output_tokens,
            totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          }
        : undefined,
    };
  }

  // 流式路径：event 为 content_block_delta 时，delta.text 为增量
  const res = await httpFetch(`${base}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': agent.apiKey,
      'anthropic-version': '2023-06-01',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic 请求失败 (${res.status}): ${text.slice(0, 300)}`);
  }
  let acc = '';
  let usage: LLMResponse['usage'];
  await forEachSSEData(res, (obj: any) => {
    const delta = obj?.delta?.text;
    if (typeof delta === 'string') {
      acc += delta;
      onToken(delta);
    }
    // Anthropic 流式 message_delta 事件携带 usage
    if (obj?.type === 'message_delta' && obj?.usage) {
      usage = {
        promptTokens: obj.usage.input_tokens,
        completionTokens: obj.usage.output_tokens,
        totalTokens: (obj.usage.input_tokens ?? 0) + (obj.usage.output_tokens ?? 0),
      };
    }
  });
  return { text: acc, usage };
}
