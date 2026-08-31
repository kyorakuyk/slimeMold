import type { AgentConfig, ChatMessage, LLMResponse, LLMToolSpec } from '../../types';
import { isTauri } from '../../platform/env';

interface CodexAuthStatus {
  logged_in: boolean;
  auth_mode: string;
  detail: string;
}

interface CodexExecResult {
  text: string;
  usage?: {
    prompt_tokens?: number;
    cached_prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

async function invokeRaw<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** 只读取 Codex CLI 的登录状态，不读取 auth.json 或任何 token。 */
export async function codexLoginStatus(): Promise<{
  loggedIn: boolean;
  authMode: string;
  detail: string;
}> {
  if (!isTauri) {
    return {
      loggedIn: false,
      authMode: 'unavailable',
      detail: 'Codex 订阅接入需要 SlimeMold 桌面版。',
    };
  }
  const status = await invokeRaw<CodexAuthStatus>('codex_login_status');
  return {
    loggedIn: status.logged_in,
    authMode: status.auth_mode,
    detail: status.detail,
  };
}

/** 启动官方 Codex CLI 的 ChatGPT 登录流程；认证仍由 Codex 自己管理。 */
export async function loginCodex(): Promise<void> {
  if (!isTauri) throw new Error('Codex 订阅登录需要 SlimeMold 桌面版。');
  await invokeRaw<void>('codex_login');
}

/** 调用官方 Codex CLI 登出，不接触认证文件。 */
export async function logoutCodex(): Promise<void> {
  if (!isTauri) return;
  await invokeRaw<void>('codex_logout');
}

function contentToText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

/** 将 SlimeMold 的消息协议转换成 Codex CLI 的单次提示上下文。 */
function serializePrompt(messages: ChatMessage[]): string {
  return messages
    .map((message) => `[${message.role.toUpperCase()}]\n${contentToText(message.content)}`)
    .join('\n\n');
}

/**
 * ChatGPT 计划版 Codex provider。
 *
 * 它通过已登录的官方 Codex CLI 调用，不使用 OpenAI API Key。
 * Codex CLI 是 coding-focused agent，因此暂不桥接 SlimeMold 的工具规格；
 * master Agent 的 question/brief/architecture 协议不需要工具调用。
 */
export async function chatCodex(
  agent: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onToken?: (text: string) => void,
  tools?: LLMToolSpec[],
): Promise<LLMResponse> {
  if (tools?.length) {
    throw new Error('Codex provider 当前不桥接 SlimeMold 工具调用，请为该节点选择 API provider。');
  }
  if (signal.aborted) throw new Error('Codex 请求已取消。');
  const result = await invokeRaw<CodexExecResult>('codex_exec', {
    prompt: serializePrompt(messages),
    model: agent.model?.trim() || null,
  });
  if (signal.aborted) throw new Error('Codex 请求已取消。');
  if (onToken) onToken(result.text);
  return {
    text: result.text,
    usage: result.usage
      ? {
          promptTokens: result.usage.prompt_tokens,
          cachedPromptTokens: result.usage.cached_prompt_tokens,
          completionTokens: result.usage.completion_tokens,
          replyTokens: result.usage.completion_tokens,
          totalTokens: result.usage.total_tokens,
        }
      : undefined,
  };
}

/** 在 Rust 登记的独立 worktree 内调用可写 Codex Worker。 */
export async function codexWorkerExec(
  prompt: string,
  model: string | undefined,
  cwd: string,
): Promise<LLMResponse> {
  if (!isTauri) throw new Error('Codex Worker 需要 SlimeMold 桌面版。');
  if (!prompt.trim()) throw new Error('Codex Worker 请求不能为空。');
  if (!cwd.trim()) throw new Error('Codex Worker worktree 路径不能为空。');
  const result = await invokeRaw<CodexExecResult>('codex_worker_exec', {
    prompt,
    model: model?.trim() || null,
    cwd,
  });
  return {
    text: result.text,
    usage: result.usage
      ? {
          promptTokens: result.usage.prompt_tokens,
          cachedPromptTokens: result.usage.cached_prompt_tokens,
          completionTokens: result.usage.completion_tokens,
          replyTokens: result.usage.completion_tokens,
          totalTokens: result.usage.total_tokens,
        }
      : undefined,
  };
}
