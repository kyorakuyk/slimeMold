import type { AgentConfig, ChatMessage, LLMResponse, Protocol, RoleTemplate, LLMToolSpec } from '../types';
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
    tools?: LLMToolSpec[],
  ) => Promise<LLMResponse>
> = {
  openai: chatOpenAI,
  anthropic: chatAnthropic,
  ollama: chatOllama,
};

/** 多协议路由：按 agent.protocol 分发到对应 provider。
 * 传入 onToken 回调即启用流式输出（逐 token 回传）。
 * tools 非空时启用 tool_call 能力（AgentHarness 驱动多轮循环）。 */
export async function chatWithAgent(
  agent: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onToken?: (text: string) => void,
  tools?: LLMToolSpec[],
): Promise<LLMResponse> {
  const provider = providers[agent.protocol];
  if (!provider) {
    throw new Error(`未知协议: ${agent.protocol}`);
  }
  return provider(agent, messages, signal, onToken, tools);
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
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5:3b',
  },
};

/** 供应商预设库（参考 cc-switch 的 Presets 思路）：选一个即自动补全 Base URL + 默认模型。
 * 适用于 OpenAI 兼容中转/官方。自定义项仅占位，Base URL 留空让用户手填。 */
export interface ProviderPreset {
  id: string;
  name: string;
  /** 显示名（面板下拉可选，缺省回退 name） */
  label?: string;
  protocol: Protocol;
  baseUrl: string;
  defaultModel: string;
  /** 是否允许用户编辑 Base URL（中转自定义场景为 true） */
  editableBaseUrl: boolean;
}

export const providerPresets: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI 官方',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    editableBaseUrl: false,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    editableBaseUrl: false,
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    editableBaseUrl: false,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter 聚合',
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    editableBaseUrl: false,
  },
  {
    id: 'custom',
    name: '自定义中转',
    protocol: 'openai',
    baseUrl: '',
    defaultModel: '',
    editableBaseUrl: true,
  },
];

export function findProviderPreset(id?: string): ProviderPreset | undefined {
  return providerPresets.find((p) => p.id === id);
}

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

/** 拉取 OpenAI 兼容中转站 / 官方服务的可用模型列表。
 * 走 `${baseUrl}/models`，用 Bearer 密钥鉴权；失败返回空数组。
 * 适用于中转站（one-api / NewAPI / OpenRouter 等）及官方 OpenAI。 */
export async function fetchOpenAIModels(
  baseUrl: string,
  apiKey?: string,
  proxyUrl?: string,
): Promise<string[]> {
  const candidates = baseUrlListWithV1(baseUrl);
  const proxyOpt = proxyUrl?.trim() ? { proxy: proxyUrl.trim() } : {};
  for (const base of candidates) {
    try {
      const res = await httpFetch(`${base}/models`, {
        method: 'GET',
        ...proxyOpt,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!res.ok) continue; // 尝试下一个候选（如缺 /v1 时补 /v1）
      const data = (await res.json()) as { data?: { id: string }[] };
      const ids = (data.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string');
      if (ids.length > 0) return ids.sort();
    } catch {
      /* 单候选失败，尝试下一个 */
    }
  }
  return [];
}

/**
 * 生成 Base URL 候选列表：优先原样，若未带 /v1 则追加 /v1 作为兜底候选。
 * 解决用户漏填 /v1 导致 DeepSeek/OpenAI 官方拉不到模型的问题。
 */
export function baseUrlListWithV1(baseUrl: string): string[] {
  const base = baseUrl.replace(/\/+$/, '');
  const out = [base];
  const hasVersion = /\/v\d+$/.test(base) || /\/v\d+\/$/.test(base);
  if (!hasVersion) out.push(`${base}/v1`);
  return out;
}

/** 拉取 Anthropic 原生服务的模型列表。
 * Anthropic 不提供公开的 /models 枚举，官方仅支持通过 /v1/models 查询已授权模型，
 * 用 x-api-key 鉴权 + anthropic-version 头。失败返回空数组。 */
export async function fetchAnthropicModels(
  baseUrl: string,
  apiKey?: string,
  proxyUrl?: string,
): Promise<string[]> {
  try {
    const base = baseUrl.replace(/\/+$/, '');
    const proxyOpt = proxyUrl?.trim() ? { proxy: proxyUrl.trim() } : {};
    const res = await httpFetch(`${base}/v1/models`, {
      method: 'GET',
      ...proxyOpt,
      headers: apiKey
        ? {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          }
        : { 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: { id: string }[] };
    const ids = (data.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');
    return ids.sort();
  } catch {
    return [];
  }
}

/** 按协议拉取模型列表：OpenAI 兼容走 /models + Bearer，Anthropic 原生走 /v1/models + x-api-key。 */
export async function fetchModelsByProtocol(
  protocol: Protocol,
  baseUrl: string,
  apiKey?: string,
  proxyUrl?: string,
): Promise<string[]> {
  if (protocol === 'anthropic') {
    return fetchAnthropicModels(baseUrl, apiKey, proxyUrl);
  }
  return fetchOpenAIModels(baseUrl, apiKey, proxyUrl);
}

/** API 可用性探测结果。
 * stage 表示失败发生在哪一环，便于用户区分"网址错"还是"key 错"还是"模型错"。 */
export interface ProbeResult {
  ok: boolean;
  stage: 'url' | 'auth' | 'model' | 'ok';
  message: string;
  /** 本次探测是否经本地代理转发（proxyUrl / 全局代理） */
  proxied?: boolean;
}

/**
 * 探测一个智能体配置是否真正可用：发一个最小请求（max_tokens=1）。
 * - 网络层/URL 失败 → stage='url'
 * - 401/403 → stage='auth'（key 无效或无权限）
 * - 404/400 且提示模型不存在 → stage='model'
 * - 正常返回 → stage='ok'
 */
export async function probeAgent(
  config: { protocol: Protocol; baseUrl: string; model: string },
  apiKey?: string,
  proxyUrl?: string,
): Promise<ProbeResult> {
  const base = (config.baseUrl || '').replace(/\/+$/, '');
  const proxied = !!proxyUrl?.trim();
  // 本地代理转发（参考 cc-switch 路由）：经该代理出口做连通性探测，
  // 代理通 + 目标可达 → 证明整条链路（含代理）可用。
  const proxyOpt = proxied ? { proxy: proxyUrl!.trim() } : {};
  if (!base) {
    return { ok: false, stage: 'url', message: 'Base URL 为空', proxied };
  }
  try {
    if (config.protocol === 'ollama') {
      const res = await httpFetch(`${base}/api/chat`, {
        method: 'POST',
        ...proxyOpt,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
          options: { num_predict: 1 },
        }),
      });
      if (res.ok) return { ok: true, stage: 'ok', message: '连接成功，模型可用', proxied };
      if (res.status === 404) {
        return { ok: false, stage: 'model', message: `模型 "${config.model}" 不存在于该 Ollama 服务`, proxied };
      }
      return { ok: false, stage: 'url', message: `Ollama 返回 ${res.status}`, proxied };
    }

    // Anthropic 原生协议：POST /v1/messages + x-api-key + anthropic-version
    if (config.protocol === 'anthropic') {
      const h: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (apiKey) h['x-api-key'] = apiKey;
      const res = await httpFetch(`${base}/v1/messages`, {
        method: 'POST',
        ...proxyOpt,
        headers: h,
        body: JSON.stringify({
          model: config.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      if (res.ok) {
        return { ok: true, stage: 'ok', message: '连接成功，模型与 Key 均有效', proxied };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, stage: 'auth', message: `鉴权失败（${res.status}），API Key 无效或无权限`, proxied };
      }
      if (res.status === 404) {
        return { ok: false, stage: 'url', message: `地址返回 404，请检查 Anthropic Base URL（应含 /v1 或正确域名）`, proxied };
      }
      let adetail = '';
      try {
        const ae = (await res.json()) as { error?: { message?: string } };
        adetail = ae.error?.message ?? '';
      } catch {
        /* ignore */
      }
      if (/model/i.test(adetail) && /(not|exist|found|invalid)/i.test(adetail)) {
        return { ok: false, stage: 'model', message: `模型 "${config.model}" 不可用：${adetail}`, proxied };
      }
      return {
        ok: false,
        stage: 'url',
        message: `请求失败（${res.status}）${adetail ? '：' + adetail : '，请检查 Base URL 与模型名'}`,
        proxied,
      };
    }

    // OpenAI 兼容（遍历候选：原 base 优先，缺 /v1 时补 /v1 兜底）
    const oaiCandidates = baseUrlListWithV1(base);
    for (const cand of oaiCandidates) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await httpFetch(`${cand}/chat/completions`, {
        method: 'POST',
        ...proxyOpt,
        headers,
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
      });
      if (res.ok) {
        return { ok: true, stage: 'ok', message: '连接成功，模型与 Key 均有效', proxied };
      }
      if (res.status === 401 || res.status === 403) {
        return { ok: false, stage: 'auth', message: `鉴权失败（${res.status}），API Key 无效或无权限`, proxied };
      }
      if (res.status === 404) {
        // 可能是缺 /v1 路径：继续尝试下一个候选；全部失败再返回 url 错误
        continue;
      }
      let odetail = '';
      try {
        const oe = (await res.json()) as { error?: { message?: string } };
        odetail = oe.error?.message ?? '';
      } catch {
        /* ignore */
      }
      if (/model/i.test(odetail) && /(not|exist|found|invalid)/i.test(odetail)) {
        return { ok: false, stage: 'model', message: `模型 "${config.model}" 不可用：${odetail}`, proxied };
      }
      return {
        ok: false,
        stage: 'url',
        message: `请求失败（${res.status}）${odetail ? '：' + odetail : '，请检查 Base URL 与模型名'}`,
        proxied,
      };
    }
    return { ok: false, stage: 'url', message: '地址返回 404，请检查 Base URL（OpenAI 兼容需带 /v1）', proxied };
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    return {
      ok: false,
      stage: 'url',
      message: `无法连接（网络/地址错误）：${msg}`,
      proxied,
    };
  }
}

export function createAgent(protocol: Protocol, presetId?: string): AgentConfig {
  const d = protocolDefaults[protocol];
  const preset = presetId ? findProviderPreset(presetId) : undefined;
  return {
    id: crypto.randomUUID(),
    name: preset ? `${preset.name}智能体` : `${d.label}智能体`,
    protocol: preset ? preset.protocol : protocol,
    baseUrl: preset ? preset.baseUrl : d.baseUrl,
    model: preset ? preset.defaultModel : d.model,
    temperature: 0.7,
    providerId: presetId,
  };
}
