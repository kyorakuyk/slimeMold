import { httpFetch } from '../../platform/env';
import type { AgentConfig, ChatMessage } from '../../types';

/** Ollama 本地模型协议 */
export async function chatOllama(
  agent: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<string> {
  const base = agent.baseUrl.replace(/\/+$/, '');
  const res = await httpFetch(`${base}/api/chat`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: agent.model,
      messages,
      stream: false,
      options: { temperature: agent.temperature ?? 0.7 },
    }),
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
  return content;
}
