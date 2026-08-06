import type { AgentConfig, ChatMessage, LLMResponse } from '../types';
import { chatWithAgent } from './agentManager';
import { useViewStore } from '../store/viewStore';

/** 解析生效的代理：agent 级 proxyUrl 优先，其次全局代理；均空则直连 */
function resolveProxy(agent: AgentConfig): string {
  const g = useViewStore.getState().globalProxyUrl?.trim() ?? '';
  return (agent.proxyUrl?.trim() || g) || '';
}

/**
 * LLM 通道抽象层。
 *
 * 路线 A（当前 main）已落地：所有 LLM HTTP 调用统一由前端 provider 发起
 * （plugin-http / window.fetch，带回 token usage 统计，规避 CORS），Rust 侧
 * 不再实现 HTTP 客户端（已移除 chat_completion）。密钥仅存于系统密钥库，
 * 前端按 name 引用、不直接持有明文。
 *
 * 路线 B（feature/backend-engine 分支，未来可选）：整 DAG 调度搬进 Rust，此处的
 * LLMChannel 抽象会被 ExecutionBackend 复用（见下方 ExecutionBackend 占位接口）。
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
    const proxy = resolveProxy(req.agent);
    const agent = proxy && !req.agent.proxyUrl?.trim() ? { ...req.agent, proxyUrl: proxy } : req.agent;
    return chatWithAgent(agent, req.messages, req.signal, req.onToken);
  }
}

/**
 * 通道实例。
 *
 * 路线 A（当前 main）下，Rust 侧已不再实现 LLM HTTP 客户端（原 `chat_completion`
 * 命令已移除，见 SECURITY/S8）。因此无论用户选择「后端」还是「前端」通道，实际都由
 * 前端 provider（plugin-http / window.fetch）在 WebView 内发起请求——区别仅在于
 * `mode` 标识与日志/遥测语义（"经 Tauri 通道" vs "WebView 直连"），请求路径一致。
 *
 * 保留两个实例而非单一实现，是为了让 `LLMChannel.mode` 仍能反映用户在设置面板选择的
 * 通道类型，便于运行历史与日志标注；两者共享同一 `chatWithAgent` 实现。
 * 路线 B（feature/backend-engine）启用时，BackendChannel 将由 ExecutionBackend 接管，
 * 真正在 Rust 侧执行，届时此处替换为后端实现即可。
 */
const frontend = new FrontendChannel();
const backend = new FrontendChannel();
(backend as { mode: LLMChannelMode }).mode = 'backend';

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
