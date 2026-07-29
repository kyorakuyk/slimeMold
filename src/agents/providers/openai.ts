import { httpFetch } from '../../platform/env';
import type { AgentConfig, ChatMessage } from '../../types';
import { forEachSSEData } from '../streamSSE';

/** OpenAI 兼容协议（OpenAI / DeepSeek / Moonshot / 通义 等） */
export async function chatOpenAI(
  agent: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onToken?: (text: string) => void,
): Promise<string> {
  const base = agent.baseUrl.replace(/\/+$/, '');
  const body = {
    model: agent.model,
    messages,
    temperature: agent.temperature ?? 0.7,
    stream: !!onToken,
  };

  if (!onToken) {
    const res = await httpFetch(`${base}/chat/completions`, {
      method: 'POST',
      signal,
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
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('OpenAI 协议响应缺少 choices[0].message.content');
    }
    return content;
  }

  // 流式路径
  const res = await httpFetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
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
  await forEachSSEData(res, (obj: any) => {
    const delta = obj?.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') {
      acc += delta;
      onToken(delta);
    }
  });
  return acc;
}
