import type { AgentConfig, ChatMessage, LLMResponse } from '../types';
import { chatWithAgent } from './agentManager';
import { isTauri } from '../platform/env';

/**
 * LLM 通道抽象层。
 *
 * 项目分两条演进路线：
 *  - 路线 A（当前 main）：调度仍在前端 JS，仅把「每一次 LLM HTTP 调用」的通道可切换
 *    （frontend 直接走 WebView / backend 走 Tauri Rust 命令）。密钥可留在 Rust 侧。
 *  - 路线 B（feature/backend-engine 分支）：整 DAG 调度搬进 Rust，此处的 LLMChannel
 *    抽象会被 ExecutionBackend 复用（见下方 ExecutionBackend 占位接口）。
 *
 * 节点与 executor 永远只依赖 LLMChannel，不直接 import provider，从而两条路线可无感切换。
 */

export type LLMChannelMode = 'frontend' | 'backend';

/** 一次 LLM 调用的统一入参（与 chatWithAgent 对齐，但通道无关） */
export interface LLMRequest {
  agent: AgentConfig;
  messages: ChatMessage[];
  signal: AbortSignal;
  onToken?: (text: string) => void;
}

export interface LLMChannel {
  readonly mode: LLMChannelMode;
  chat(req: LLMRequest): Promise<LLMResponse>;
}

/** 前端通道：WebView 内直接发起请求（plugin-http / window.fetch）。 */
class FrontendChannel implements LLMChannel {
  readonly mode = 'frontend' as const;
  async chat(req: LLMRequest): Promise<LLMResponse> {
    return chatWithAgent(req.agent, req.messages, req.signal, req.onToken);
  }
}

/**
 * 后端通道：请求经 Tauri `chat_completion` 命令在 Rust 侧发起。
 * 流式 token 经 tauri::ipc::Channel 回传，最终在前端逐 token 触发 onToken。
 * 若后端命令不可用（非 Tauri / 未实现），自动降级到前端通道，保证可用性。
 */
class BackendChannel implements LLMChannel {
  readonly mode = 'backend' as const;

  async chat(req: LLMRequest): Promise<LLMResponse> {
    if (!isTauri) {
      // 浏览器预览环境无 Rust 后端，降级
      return chatWithAgent(req.agent, req.messages, req.signal, req.onToken);
    }
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    const acc: string[] = [];
    const channel = new Channel<string>((token) => {
      // 后端回传的每一片 token
      acc.push(token);
      req.onToken?.(token);
    });
    const result = await invoke<string>('chat_completion', {
      args: {
        agent: req.agent,
        messages: req.messages,
        stream: !!req.onToken,
      },
      onTokenChannel: channel,
    });
    // 非流式时后端直接返回完整文本；流式时以回传 token 拼接为准（result 可能为空串）
    const text = result && (!req.onToken || acc.length === 0) ? result : acc.join('');
    // 后端通道暂未回流 usage（路线 B 可在 Rust 侧填充）。前端已能拿到用量。
    return { text, usage: undefined };
  }
}

const frontend = new FrontendChannel();
const backend = new BackendChannel();

export function getChannel(mode: LLMChannelMode): LLMChannel {
  return mode === 'backend' ? backend : frontend;
}

/**
 * 路线 B 的抽象占位（不实现，仅定义契约，供 feature/backend-engine 挂载）。
 * 当整图调度搬入 Rust 时，executor 改为依赖 ExecutionBackend 而非前端 runWorkflow，
 * 但节点侧 LLMChannel 接口保持不变——这是两条路线能无缝共存的关键。
 */
export interface ExecutionBackend {
  /** 后端标识符，用于在运行历史/日志中标明执行位置 */
  readonly id: 'frontend' | 'rust-engine';
  /**
   * 在后端执行整张图。入参为节点/边/参数快照，结果回写前端 store。
   * 预留：用于路线 B 的「后端执行引擎」。
   */
  runGraph(snapshot: unknown, opts: unknown): Promise<void>;
}
