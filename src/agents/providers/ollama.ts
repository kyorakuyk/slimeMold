import { httpFetch } from '../../platform/env';
import type { AgentConfig, ChatMessage, LLMResponse } from '../../types';
import { forEachSSEData } from '../streamSSE';

/** Ollama 本地模型协议（本地模型通常不返回 token 用量，usage 为 undefined） */
export async function chatOllama(
  agent: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onToken?: (text: string) => void,
): Promise<LLMResponse> {
  const base = agent.baseUrl.replace(/\/+$/, '');
  const body = {
    model: agent.model,
    messages,
    stream: !!onToken,
    options: { temperature: agent.temperature ?? 0.7 },
  };

  if (!onToken) {
    const res = await httpFetch(`${base}/api/chat`, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama 请求失败 (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('Ollama 响应缺少 message.content');
    }
    return { text: content, usage: undefined };
  }

  // 流式路径
  const res = await httpFetch(`${base}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama 请求失败 (${res.status}): ${text.slice(0, 300)}`);
  }
  let acc = '';
  await forEachSSEData(res, (obj: any) => {
    const delta = obj?.message?.content;
    if (typeof delta === 'string') {
      acc += delta;
      onToken(delta);
    }
  });
  return { text: acc, usage: undefined };
}
