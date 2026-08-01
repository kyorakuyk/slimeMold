import type { AgentConfig, ChatMessage, LLMResponse, Protocol, RoleTemplate } from '../types';
import { chatOpenAI } from './providers/openai';
import { chatAnthropic } from './providers/anthropic';
import { chatOllama } from './providers/ollama';
import { httpFetch } from '../platform/env';

/** 内置角色库：作为 Agent 的"职业"预设，开箱即用。
 * 用户可在角色库面板查看/基于它们创建自定义角色（不修改此处）。 */
export const builtinRoles: RoleTemplate[] = [
  {
    id: 'role.pm',
    name: '产品经理',
    icon: '📋',
    description: '梳理需求、拆解任务、定义验收标准',
    system:
      '你是一名严谨的产品经理。请用清晰的结构梳理需求，拆解为可执行的任务，并明确验收标准。输出简洁、可执行，避免空话。',
    protocol: 'ollama',
    model: 'qwen2.5:3b',
    contextScope: 'shared',
    builtin: true,
  },
  {
    id: 'role.coder',
    name: '开发工程师',
    icon: '💻',
    description: '根据需求编写与解释代码',
    system:
      '你是一名资深开发工程师。请针对给定任务给出正确、可读、遵循最佳实践的代码或技术方案，必要时说明取舍。',
    protocol: 'ollama',
    model: 'qwen2.5:3b',
    contextScope: 'shared',
    builtin: true,
  },
  {
    id: 'role.reviewer',
    name: '代码审查员',
    icon: '🔍',
    description: '审查代码质量、风险与改进建议',
    system:
      '你是一名严格的代码审查员。请指出代码中的缺陷、安全隐患、可维护性问题，并给出具体修改建议，按严重程度分级。',
    protocol: 'ollama',
    model: 'qwen2.5:3b',
    contextScope: 'isolated',
    builtin: true,
  },
  {
    id: 'role.writer',
    name: '技术作家',
    icon: '✍️',
    description: '撰写文档、说明与总结',
    system:
      '你是一名技术作家。请将技术内容转化为准确、条理清晰、面向目标读者的文档或说明，语言专业且易懂。',
    protocol: 'ollama',
    model: 'qwen2.5:3b',
    contextScope: 'shared',
    builtin: true,
  },
];

/** 在角色库中按 id 查找角色模板（含内置 + 工作流自定义） */
export function findRole(
  roles: RoleTemplate[] | undefined,
  roleId: string | undefined,
): RoleTemplate | undefined {
  if (!roleId || !roles) return undefined;
  return roles.find((r) => r.id === roleId);
}

/** 解析节点最终生效的角色系统提示词：
 * 节点级 system 参数优先；否则用绑定角色的 system；都没有则空。
 * （预留：未来可按角色继承链 extendId 向上合并 system） */
export function resolveRoleSystem(
  role: RoleTemplate | undefined,
  nodeSystem: string,
): string {
  const nodeSys = (nodeSystem ?? '').trim();
  if (nodeSys) return nodeSys;
  return role?.system?.trim() ?? '';
}

const providers: Record<
  Protocol,
  (
    a: AgentConfig,
    m: ChatMessage[],
    s: AbortSignal,
    onToken?: (text: string) => void,
  ) => Promise<LLMResponse>
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
): Promise<LLMResponse> {
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
    model: 'qwen2.5:3b',
  },
};

/** 推荐给本地 Ollama 的模型（按显存友好度排序）。
 * 6GB 显存（如 RTX 2060）优先 qwen2.5:3b；7b/8b 也能跑但接近占满显存。 */
export const ollamaModels: { id: string; note: string }[] = [
  { id: 'qwen2.5:3b', note: '~2GB 显存 · 6GB 显卡首选，流畅' },
  { id: 'qwen2.5:7b', note: '~4.5GB 显存 · 质量更好，6GB 偏吃紧' },
  { id: 'llama3.1:8b', note: '~5GB 显存 · 8GB+ 显卡推荐' },
  { id: 'deepseek-r1:7b', note: '~4.5GB 显存 · 推理强，6GB 偏吃紧' },
  { id: 'qwen2.5:0.5b', note: '~0.5GB 显存 · 极轻量' },
];

/** 拉取本地 Ollama 已安装的模型列表（用于 UI 下拉候选）。
 * 失败（如未启动 Ollama）时返回空数组。 */
export async function fetchOllamaModels(baseUrl: string): Promise<string[]> {
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/api/tags';
    const res = await httpFetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name).sort();
  } catch {
    return [];
  }
}

export function createAgent(protocol: Protocol): AgentConfig {
  const d = protocolDefaults[protocol];
  return {
    id: crypto.randomUUID(),
    name: `${d.label}智能体`,
    protocol,
    baseUrl: d.baseUrl,
    model: d.model,
    temperature: 0.7,
  };
}
