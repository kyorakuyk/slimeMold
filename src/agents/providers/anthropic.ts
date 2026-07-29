import { httpFetch } from '../../platform/env';
import type { AgentConfig, ChatMessage } from '../../types';

/** Anthropic Messages API */
export async function chatAnthropic(
  agent: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<string> {
  const base = agent.baseUrl.replace(/\/+$/, '');
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  const chat = messages.filter((m) => m.role !== 'system');

  const res = await httpFetch(`${base}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': agent.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: 4096,
      temperature: agent.temperature ?? 0.7,
      ...(system ? { system } : {}),
      messages: chat,
    }),
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
  return content;
}
