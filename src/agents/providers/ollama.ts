import { httpFetch } from '../../platform/env';
import type { AgentConfig, ChatMessage, LLMResponse } from '../../types';

/** Ollama 本地模型协议（本地模型通常不返回 token 用量，usage 为 undefined） */
export async function chatOllama(
  agent: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onToken?: (text: string) => void,
): Promise<LLMResponse> {
  // Windows 上 Tauri plugin-http 对 127.0.0.1 的解析/连接不稳定，
  // 统一 fallback 到 localhost（Ollama 默认同时监听两者）
  const base = agent.baseUrl
    .replace(/\/+$/, '')
    .replace(/^http:\/\/127\.0\.0\.1(:\d+)?/i, 'http://localhost$1')
    .replace(/^http:\/\/0\.0\.0\.0(:\d+)?/i, 'http://localhost$1');
  // Ollama 流式响应为 NDJSON（每行一个 JSON 对象），而非 SSE 的 data: 前缀，
  // 且 Tauri plugin-http 在 Windows 上流式 body 偶有不稳定。统一走非流式，
  // 拿到完整回复后再一次性回调，保证功能稳定。
  const body = {
    model: agent.model,
    messages,
    stream: false,
    options: { temperature: agent.temperature ?? 0.7 },
  };

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
  if (onToken) onToken(content);

  // Ollama 非流式会返回 prompt_eval_count / eval_count 作为 token 用量
  const promptTokens = typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : undefined;
  const completionTokens = typeof data.eval_count === 'number' ? data.eval_count : undefined;
  const totalTokens =
    promptTokens != null && completionTokens != null
      ? promptTokens + completionTokens
      : undefined;

  return {
    text: content,
    usage:
      promptTokens == null && completionTokens == null
        ? undefined
        : {
            promptTokens,
            completionTokens,
            totalTokens,
            cachedPromptTokens: 0,
            writtenPromptTokens: 0,
            reasoningTokens: 0,
            replyTokens: completionTokens ?? 0,
          },
  };
}
