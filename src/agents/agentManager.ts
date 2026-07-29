import type { AgentConfig, ChatMessage, Protocol } from '../types';
import { chatOpenAI } from './providers/openai';
import { chatAnthropic } from './providers/anthropic';
import { chatOllama } from './providers/ollama';

const providers: Record<
  Protocol,
  (
    a: AgentConfig,
    m: ChatMessage[],
    s: AbortSignal,
    onToken?: (text: string) => void,
  ) => Promise<string>
> = {
  openai: chatOpenAI,
  anthropic: chatAnthropic,
  ollama: chatOllama,
};

/** 多协议路由：按 agent.protocol 分发到对应 provider。
 * 传入 onToken 回调即启用流式输出（逐 token 回传）。 */
export async function chatWithAgent(
  agent: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onToken?: (text: string) => void,
): Promise<string> {
  const provider = providers[agent.protocol];
  if (!provider) {
    throw new Error(`未知协议: ${agent.protocol}`);
  }
  return provider(agent, messages, signal, onToken);
}

export const protocolDefaults: Record<
  Protocol,
  { baseUrl: string; model: string; label: string }
> = {
  openai: {
    label: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  anthropic: {
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
  },
  ollama: {
    label: 'Ollama 本地',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:7b',
  },
};

export function createAgent(protocol: Protocol): AgentConfig {
  const d = protocolDefaults[protocol];
  return {
    id: crypto.randomUUID(),
    name: `${d.label}智能体`,
    protocol,
    baseUrl: d.baseUrl,
    apiKey: '',
    model: d.model,
    temperature: 0.7,
  };
}
