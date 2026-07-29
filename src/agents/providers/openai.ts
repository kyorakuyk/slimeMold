import { httpFetch } from '../../platform/env';
import type { AgentConfig, ChatMessage } from '../../types';

/** OpenAI 兼容协议（OpenAI / DeepSeek / Moonshot / 通义 等） */
export async function chatOpenAI(
  agent: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<string> {
  const base = agent.baseUrl.replace(/\/+$/, '');
  const res = await httpFetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${agent.apiKey}`,
    },
    body: JSON.stringify({
      model: agent.model,
      messages,
      temperature: agent.temperature ?? 0.7,
      stream: false,
    }),
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
