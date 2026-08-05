import { useState, useEffect } from 'react';
import { X, Plus, Trash2, RefreshCw, KeyRound, Check, PlugZap, Loader2 } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import {
  createAgent,
  protocolDefaults,
  ollamaModels,
  fetchOllamaModels,
  fetchOpenAIModels,
  probeAgent,
  providerPresets,
  findProviderPreset,
  type ProbeResult,
} from '../agents/agentManager';
import { saveCredential, removeCredential, loadCredential, defaultCredentialKey, listEndpoints, loadEndpointKey } from '../agents/credentialStore';
import { isTauri } from '../platform/env';
import { useViewStore } from '../store/viewStore';
import type { AgentConfig, ApiEndpoint, Protocol, RoleTemplate } from '../types';

interface AgentPanelProps {
  onClose?: () => void;
  embedded?: boolean;
}

/** 智能体管理弹层：多协议配置的增删改 + 角色库（角色模板）管理 */
export default function AgentPanel({ onClose, embedded = false }: AgentPanelProps) {
  const [tab, setTab] = useState<'agents' | 'roles'>('agents');

  const inner = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center border-b border-line px-3">
        <button
          className={`px-3 py-3 text-[13px] font-medium transition-colors ${
            tab === 'agents'
              ? 'border-b-2 border-accent text-ink'
              : 'text-ink-faint hover:text-ink'
          }`}
          onClick={() => setTab('agents')}
        >
          智能体
        </button>
        <button
          className={`px-3 py-3 text-[13px] font-medium transition-colors ${
            tab === 'roles'
              ? 'border-b-2 border-accent text-ink'
              : 'text-ink-faint hover:text-ink'
          }`}
          onClick={() => setTab('roles')}
        >
          角色库
        </button>
      </div>
      {tab === 'agents' ? <AgentsTab /> : <RolesTab />}
    </div>
  );

  if (embedded) return inner;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/20"
      onClick={onClose}
    >
      <div
        className="flex h-[520px] w-[720px] flex-col overflow-hidden rounded-lg border border-line bg-white"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-3">
          <div className="flex">
            <button
              className={`px-3 py-3 text-[13px] font-medium transition-colors ${
                tab === 'agents'
                  ? 'border-b-2 border-accent text-ink'
                  : 'text-ink-faint hover:text-ink'
              }`}
              onClick={() => setTab('agents')}
            >
              智能体
            </button>
            <button
              className={`px-3 py-3 text-[13px] font-medium transition-colors ${
                tab === 'roles'
                  ? 'border-b-2 border-accent text-ink'
                  : 'text-ink-faint hover:text-ink'
              }`}
              onClick={() => setTab('roles')}
            >
              角色库
            </button>
          </div>
          <button
            className="cursor-pointer text-ink-faint hover:text-ink"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
        {tab === 'agents' ? <AgentsTab /> : <RolesTab />}
      </div>
    </div>
  );
}

function AgentsTab() {
  const agents = useWorkflowStore((s) => s.agents);
  const upsertAgent = useWorkflowStore((s) => s.upsertAgent);
  const removeAgent = useWorkflowStore((s) => s.removeAgent);
  const defaultAgentId = useWorkflowStore((s) => s.defaultAgentId);
  const setDefaultAgent = useWorkflowStore((s) => s.setDefaultAgent);
  const [editingId, setEditingId] = useState<string | null>(agents[0]?.id ?? null);
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelHint, setModelHint] = useState('');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  /** 各智能体可用性状态（列表小圆点用），key=agentId */
  const [probeStates, setProbeStates] = useState<Record<string, ProbeResult>>({});
  /** 保存成功后暂存的明文 key（仅当前会话内存，不落盘），供随后的检测/拉取直接使用，
   *  避免依赖从密钥库读回导致「已保存却读不到」的困惑。 */
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const editing = agents.find((a) => a.id === editingId);

  /** APIKEYS 分区里已登记的接入点（供「从库导入」下拉）。 */
  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([]);
  useEffect(() => {
    if (isTauri) listEndpoints().then(setEndpoints);
  }, []);
  /** 从 APIKEYS 库选择一个接入点，自动生成一份填好 协议/网址/密钥 的智能体。 */
  const importFromEndpoint = async (name: string) => {
    if (!name) return;
    const ep = endpoints.find((e) => e.name === name);
    if (!ep) return;
    const agent = createAgent(ep.protocol);
    agent.baseUrl = ep.baseUrl;
    agent.credentialKey = ep.credentialKey;
    agent.name = `${ep.name} 智能体`;
    agent.providerId = 'custom';
    upsertAgent(agent);
    setEditingId(agent.id);
    // 取回明文 key 暂存内存，便于立即检测/拉模型
    const key = ep.protocol === 'ollama' ? null : await loadEndpointKey(ep.name);
    if (key) setPendingKey(key);
  };

  /**
   * 恢复后主动回查系统密钥库：密钥库才是密钥的单一事实源。
   * 若某 agent 的 credentialKey 丢失（如 WebView localStorage 被重置），
   * 但密钥库里按协议默认键仍有对应密钥，则回填 credentialKey，
   * 避免 UI 误显示「未保存」而让用户以为密钥没存进后端。
   */
  useEffect(() => {
    if (!isTauri) return;
    let alive = true;
    (async () => {
      for (const a of agents) {
        if (a.protocol === 'ollama') continue;
        const existing = a.credentialKey;
        if (existing) {
          const v = await loadCredential(existing);
          if (v) continue; // 已正确链接，无需处理
        }
        // 尝试按协议默认键回查
        const def = defaultCredentialKey(a.protocol);
        const v = await loadCredential(def);
        if (alive && v && !a.credentialKey) {
          upsertAgent({ ...a, credentialKey: def });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []); // 仅挂载时回查一次

  /** 保存成功回调：写入 credentialKey 同时暂存明文 key */
  const onKeySaved = (ck: string, value: string) => {
    patch({ credentialKey: ck, apiKey: undefined });
    setPendingKey(value);
  };
  const onKeyCleared = () => {
    patch({ credentialKey: undefined });
    setPendingKey(null);
  };

  /** 发一个最小请求探测 API 是否真正可用，并定位失败环节（url/auth/model）。
   *  若配置了代理（智能体 proxyUrl 优先于全局代理），则经代理出口探测，验证整条链路。 */
  const runProbe = async () => {
    if (!editing) return;
    setProbing(true);
    setProbe(null);
    try {
      const key =
        editing.protocol === 'ollama'
          ? undefined
          : pendingKey ?? (await loadCredential(editing.credentialKey ?? defaultCredentialKey(editing.protocol))) ?? undefined;
      if (editing.protocol !== 'ollama' && !key) {
        setProbe({
          ok: false,
          stage: 'auth',
          message: isTauri ? '请先保存 API Key 再检测' : '请使用桌面版保存 Key 后再检测',
        });
        return;
      }
      const proxyUrl: string | undefined = editing.proxyUrl
        ? editing.proxyUrl.trim()
        : useViewStore.getState().globalProxyUrl
          ? useViewStore.getState().globalProxyUrl.trim()
          : undefined;
      const r = await probeAgent(
        { protocol: editing.protocol, baseUrl: editing.baseUrl, model: editing.model },
        key,
        proxyUrl,
      );
      setProbe(r);
      setProbeStates((prev) => ({ ...prev, [editing.id]: r }));
    } finally {
      setProbing(false);
    }
  };

  /** 根据协议拉取可用模型：
   *  - ollama   → 本地 /api/tags（无需 key）
   *  - openai   → 中转站/官方 /models（需已保存的 key）
   *  - anthropic→ 中转站通常也是 OpenAI 格式，复用 /models；纯原生 Anthropic 无 /models 端点 */
  const pullModels = async () => {
    if (!editing) return;
    setLoadingModels(true);
    setModelHint('');
    try {
      let list: string[] = [];
      if (editing.protocol === 'ollama') {
        list = await fetchOllamaModels(editing.baseUrl || 'http://127.0.0.1:11434');
      } else {
        const key = pendingKey ?? (await loadCredential(editing.credentialKey ?? defaultCredentialKey(editing.protocol)));
        if (!key) {
          setModelHint('请先保存 API Key 再拉取模型列表');
          return;
        }
        const proxyUrl: string | undefined = editing.proxyUrl?.trim() || useViewStore.getState().globalProxyUrl?.trim() || undefined;
        list = await fetchOpenAIModels(editing.baseUrl, key, proxyUrl);
        if (list.length === 0) {
          setModelHint(
            editing.protocol === 'anthropic'
              ? '未获取到模型。Anthropic 原生无 /models 端点，中转站请改用「OpenAI 兼容」协议'
              : '未获取到模型，请检查 Base URL 与 Key 是否正确',
          );
        }
      }
      setRemoteModels(list);
    } finally {
      setLoadingModels(false);
    }
  };

  const patch = (p: Partial<AgentConfig>) => {
    if (!editing) return;
    upsertAgent({ ...editing, ...p });
  };

  const changeProtocol = (protocol: Protocol) => {
    if (!editing) return;
    const d = protocolDefaults[protocol];
    upsertAgent({ ...editing, protocol, baseUrl: d.baseUrl, model: d.model });
  };

  const addAgent = (protocol: Protocol) => {
    const agent = createAgent(protocol);
    upsertAgent(agent);
    setEditingId(agent.id);
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* 左列：智能体列表 */}
      <div className="flex w-56 shrink-0 flex-col border-r border-line bg-paper-soft">
        <div className="border-b border-line px-3 py-2.5">
          <h2 className="text-[13px] font-semibold text-ink">智能体</h2>
          <p className="mt-0.5 text-[11px] text-ink-faint">多协议 LLM 配置</p>
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {agents.map((a) => {
            const dot = probeStates[a.id];
            const isDefault = defaultAgentId === a.id;
            return (
              <li
                key={a.id}
                onClick={() => setEditingId(a.id)}
                className={`mb-1 cursor-pointer rounded border px-2.5 py-2 transition-colors ${
                  a.id === editingId
                    ? 'border-accent-soft bg-white'
                    : 'border-transparent hover:bg-white'
                }`}
              >
                <div className="flex items-center justify-between gap-1">
                  <p className="truncate text-[13px] text-ink">{a.name}</p>
                  <div className="flex shrink-0 items-center gap-1">
                    {dot && (
                      <span
                        title={
                          dot.ok
                            ? '连接正常'
                            : dot.stage === 'auth'
                              ? 'Key 异常'
                              : '地址/模型异常'
                        }
                        className={`inline-block h-2 w-2 rounded-full ${
                          dot.ok
                            ? 'bg-emerald-400'
                            : dot.stage === 'auth'
                              ? 'bg-amber-400'
                              : 'bg-rose-400'
                        }`}
                      />
                    )}
                    <button
                      type="button"
                      title={isDefault ? '当前默认智能体' : '设为默认'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDefaultAgent(isDefault ? null : a.id);
                      }}
                      className={`text-[12px] leading-none ${
                        isDefault ? 'text-amber-400' : 'text-ink-faint hover:text-amber-400'
                      }`}
                    >
                      {isDefault ? '★' : '☆'}
                    </button>
                  </div>
                </div>
                <p className="text-[11px] text-ink-faint">
                  {findProviderPreset(a.providerId)?.name ?? protocolDefaults[a.protocol].label}
                  {' · '}
                  {a.model}
                </p>
              </li>
            );
          })}
        </ul>
        <div className="space-y-1.5 border-t border-line p-2">
          <select
            className="sm-input cursor-pointer text-[12px]"
            value=""
            onChange={(e) => {
              const pid = e.target.value;
              if (!pid) return;
              const preset = findProviderPreset(pid);
              const agent = createAgent(preset?.protocol ?? 'openai', pid);
              upsertAgent(agent);
              setEditingId(agent.id);
            }}
          >
            <option value="">+ 按供应商预设新建…</option>
            {providerPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === 'custom' ? '（自定义中转）' : ''}
              </option>
            ))}
          </select>
          <div className="flex gap-1">
            {(Object.keys(protocolDefaults) as Protocol[]).map((p) => (
              <button
                key={p}
                className="sm-btn flex-1 justify-center px-1 text-[11px]"
                onClick={() => addAgent(p)}
                title={`新建${protocolDefaults[p].label}智能体`}
              >
                <Plus size={12} /> {protocolDefaults[p].label.slice(0, 3)}
              </button>
            ))}
          </div>
          <select
            className="sm-input mt-1"
            value=""
            onChange={(e) => {
              importFromEndpoint(e.target.value);
              e.currentTarget.value = '';
            }}
            title="从 APIKEYS 库导入已配置的接入点"
          >
            <option value="">⇩ 从 API 库导入已配置的接入点…</option>
            {endpoints.map((ep) => (
              <option key={ep.name} value={ep.name}>
                {ep.name}（{ep.protocol} · {ep.baseUrl}）
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 右列：编辑表单 */}
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h3 className="text-[13px] font-semibold text-ink">
            {editing ? '编辑配置' : '未选择'}
          </h3>
        </div>
        {editing ? (
          <div className="flex-1 space-y-3.5 overflow-y-auto px-4 py-4">
            <div>
              <label className="mb-1 block text-xs text-ink-soft">名称</label>
              <input
                className="sm-input"
                value={editing.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">协议</label>
              <select
                className="sm-input cursor-pointer"
                value={editing.protocol}
                onChange={(e) => changeProtocol(e.target.value as Protocol)}
              >
                {(Object.keys(protocolDefaults) as Protocol[]).map((p) => (
                  <option key={p} value={p}>
                    {protocolDefaults[p].label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">Base URL</label>
              <input
                className="sm-input"
                value={editing.baseUrl}
                onChange={(e) => patch({ baseUrl: e.target.value })}
              />
            </div>
            {editing.protocol === 'ollama' ? (
              <div className="rounded border border-line bg-paper-soft px-3 py-2.5">
                <p className="text-[11px] text-ink-faint">
                  本地 Ollama 模型无需 API Key，凭据留空即可。
                </p>
              </div>
            ) : (
              <ApiKeyField
                protocol={editing.protocol}
                credentialKey={editing.credentialKey}
                onSaved={onKeySaved}
                onCleared={onKeyCleared}
              />
            )}
            <div>
              <label className="mb-1 block text-xs text-ink-soft">
                模型
                {editing.protocol === 'ollama' ? '（本地 Ollama）' : '（API 可拉取）'}
              </label>
              <div className="space-y-1.5">
                <div className="flex gap-1.5">
                  <select
                    className="sm-input cursor-pointer flex-1"
                    value={
                      ollamaModels.some((m) => m.id === editing.model) ||
                      remoteModels.includes(editing.model)
                        ? editing.model
                        : ''
                    }
                    onChange={(e) => patch({ model: e.target.value })}
                  >
                    <option value="">— 选择模型 —</option>
                    {ollamaModels.map((m) => (
                      <option key={m.id} value={m.id} title={m.note}>
                        {m.id}
                      </option>
                    ))}
                    {remoteModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="sm-btn shrink-0 px-2"
                    title={
                      editing.protocol === 'ollama'
                        ? '拉取本机已安装模型'
                        : '从 API 地址拉取可用模型'
                    }
                    disabled={loadingModels}
                    onClick={pullModels}
                  >
                    <RefreshCw size={13} className={loadingModels ? 'animate-spin' : ''} />
                  </button>
                  <button
                    type="button"
                    className="sm-btn shrink-0 px-2.5"
                    title="发一个最小请求，检测地址 / Key / 模型是否可用"
                    disabled={probing || !editing.model}
                    onClick={runProbe}
                  >
                    {probing ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
                  </button>
                </div>
                {ollamaModels.find((m) => m.id === editing.model)?.note && (
                  <p className="text-[11px] text-ink-faint">
                    {ollamaModels.find((m) => m.id === editing.model)?.note}
                  </p>
                )}
                {modelHint && (
                  <p className="text-[11px] text-ink-faint">{modelHint}</p>
                )}
                {probe && (
                  <div
                    className={
                      'rounded border px-2.5 py-1.5 text-[11px] ' +
                      (probe.ok
                        ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300'
                        : probe.stage === 'auth'
                          ? 'border-amber-400/40 bg-amber-500/10 text-amber-300'
                          : 'border-rose-400/40 bg-rose-500/10 text-rose-300')
                    }
                  >
                    <span className="font-medium">
                      {probe.ok ? '✓ ' : probe.stage === 'auth' ? '🔑 ' : '✗ '}
                    </span>
                    {probe.message}
                    {probe.proxied && (
                      <span className="ml-1 rounded bg-white/10 px-1 py-0.5 text-[10px]">经代理</span>
                    )}
                  </div>
                )}
                {editing.protocol !== 'ollama' && remoteModels.length === 0 && !loadingModels && !editing.credentialKey && (
                  <p className="text-[11px] text-ink-faint">
                    先保存 API Key，再点右侧按钮从「{editing.baseUrl}」拉取可用模型。
                  </p>
                )}
                {editing.protocol !== 'ollama' && remoteModels.length === 0 && !loadingModels && editing.credentialKey && !modelHint && (
                  <button
                    type="button"
                    className="text-[11px] text-accent hover:underline"
                    onClick={pullModels}
                  >
                    点击从「{editing.baseUrl}」拉取可用模型列表
                  </button>
                )}
                <input
                  className="sm-input mt-1"
                  value={editing.model}
                  placeholder={
                    editing.protocol === 'ollama'
                      ? '或直接输入模型名，如 qwen2.5:3b'
                      : '或直接输入模型名，如 deepseek-chat'
                  }
                  onChange={(e) => patch({ model: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">
                温度（{editing.temperature ?? 0.7}）
              </label>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                className="w-full cursor-pointer accent-accent"
                value={editing.temperature ?? 0.7}
                onChange={(e) => patch({ temperature: Number(e.target.value) })}
              />
            </div>
            <details className="rounded border border-line bg-paper-soft px-3 py-2.5">
              <summary className="cursor-pointer text-[12px] text-ink-soft">
                高级：本地代理转发（参考 cc-switch 路由）
              </summary>
              <p className="mt-2 text-[11px] text-ink-faint">
                填入本地代理地址（如 http://127.0.0.1:7890）后，经该代理访问 Base URL，
                适合统一适配中转 / OpenAI 格式。backend 与 frontend 通道均已生效；
                backend 模式需在设置中切换为「经 Rust 后端」。留空则直连。
              </p>
              <input
                className="sm-input mt-2"
                value={editing.proxyUrl ?? ''}
                placeholder="http://127.0.0.1:7890（留空则直连）"
                onChange={(e) => patch({ proxyUrl: e.target.value.trim() || undefined })}
              />
            </details>
            <button
              className="sm-btn text-err hover:border-err hover:text-err"
              onClick={() => {
                removeAgent(editing.id);
                setEditingId(null);
              }}
            >
              <Trash2 size={13} /> 删除此智能体
            </button>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-[13px] text-ink-faint">从左侧选择或新建智能体</p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * API Key 录入组件（Step 0.5）：明文仅在本组件的临时 state 中存在，
 * 点「保存到系统密钥库」后写入 OS 密钥库，并向上回报 credentialKey；
 * 工作流 / agent 配置中只保留 credentialKey，绝不持久化明文。
 */
function ApiKeyField({
  protocol,
  credentialKey,
  onSaved,
  onCleared,
}: {
  protocol: Protocol;
  credentialKey?: string;
  onSaved: (ck: string, value: string) => void;
  onCleared: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<'' | 'ok' | 'err'>('');

  const ck = credentialKey ?? defaultCredentialKey(protocol);

  const handleSave = async () => {
    if (!draft.trim()) return;
    if (!isTauri) {
      setStatus('err');
      return;
    }
    try {
      await saveCredential(ck, draft.trim());
      onSaved(ck, draft.trim());
      setDraft('');
      setStatus('ok');
    } catch {
      setStatus('err');
    }
  };

  const handleClear = async () => {
    try {
      await removeCredential(ck);
    } catch {
      /* 忽略：即便删除失败也清空本地引用 */
    }
    onCleared();
    setStatus('');
  };

  return (
    <div>
      <label className="mb-1 block text-xs text-ink-soft">API Key（存于系统密钥库）</label>
      <div className="flex gap-1.5">
        <input
          type="password"
          className="sm-input flex-1"
          value={draft}
          placeholder={isTauri ? '输入后点击右侧保存' : '仅桌面版支持密钥库'}
          disabled={!isTauri}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSave();
          }}
        />
        <button
          type="button"
          className="sm-btn shrink-0 px-3"
          disabled={!draft.trim()}
          title={isTauri ? '保存到系统密钥库' : '请使用桌面版保存密钥'}
          onClick={handleSave}
        >
          <KeyRound size={13} /> 保存
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <p className="text-[11px] text-ink-faint">
          {credentialKey ? (
            <span className="inline-flex items-center gap-1 text-ok">
              <Check size={11} /> 已保存（凭据键：{ck}）
            </span>
          ) : (
            '尚未保存，运行时将无法取回密钥'
          )}
        </p>
        {credentialKey && (
          <button
            type="button"
            className="text-[11px] text-ink-faint hover:text-err"
            onClick={handleClear}
          >
            清除
          </button>
        )}
      </div>
      {status === 'err' && (
        <p className="mt-1 text-[11px] text-err">保存失败（请使用桌面版，或检查系统密钥库权限）</p>
      )}
    </div>
  );
}

function RolesTab() {
  const roles = useWorkflowStore((s) => s.roles);
  const upsertRole = useWorkflowStore((s) => s.upsertRole);
  const removeRole = useWorkflowStore((s) => s.removeRole);
  const [editingId, setEditingId] = useState<string | null>(
    roles.find((r) => !r.builtin)?.id ?? roles[0]?.id ?? null,
  );
  const editing = roles.find((r) => r.id === editingId);

  const addRole = () => {
    const id = `role.${Date.now().toString(36)}`;
    upsertRole({
      id,
      name: '新角色',
      system: '',
      contextScope: 'shared',
    });
    setEditingId(id);
  };

  const patch = (p: Partial<RoleTemplate>) => {
    if (!editing) return;
    upsertRole({ ...editing, ...p });
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* 左列：角色列表 */}
      <div className="flex w-56 shrink-0 flex-col border-r border-line bg-paper-soft">
        <div className="border-b border-line px-3 py-2.5">
          <h2 className="text-[13px] font-semibold text-ink">角色库</h2>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            为智能体设定"职业"与上下文策略
          </p>
        </div>
        <ul className="flex-1 overflow-y-auto p-2">
          {roles.map((r) => (
            <li
              key={r.id}
              onClick={() => setEditingId(r.id)}
              className={`mb-1 cursor-pointer rounded border px-2.5 py-2 transition-colors ${
                r.id === editingId
                  ? 'border-accent-soft bg-white'
                  : 'border-transparent hover:bg-white'
              }`}
            >
              <p className="truncate text-[13px] text-ink">
                {r.icon ? `${r.icon} ` : ''}
                {r.name}
                {r.builtin ? (
                  <span className="ml-1 text-[10px] text-ink-faint">内置</span>
                ) : null}
              </p>
              <p className="text-[11px] text-ink-faint">
                {r.contextScope === 'isolated' ? '隔离上下文' : '共享上下文'}
                {r.model ? ` · ${r.model}` : ''}
              </p>
            </li>
          ))}
        </ul>
        <div className="border-t border-line p-2">
          <button className="sm-btn w-full justify-center" onClick={addRole}>
            <Plus size={12} /> 新建角色
          </button>
        </div>
      </div>

      {/* 右列：角色编辑 */}
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h3 className="text-[13px] font-semibold text-ink">
            {editing ? (editing.builtin ? '查看内置角色' : '编辑角色') : '未选择'}
          </h3>
        </div>
        {editing ? (
          <div className="flex-1 space-y-3.5 overflow-y-auto px-4 py-4">
            <div>
              <label className="mb-1 block text-xs text-ink-soft">名称</label>
              <input
                className="sm-input"
                value={editing.name}
                disabled={editing.builtin}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="mb-1 block text-xs text-ink-soft">图标（emoji）</label>
                <input
                  className="sm-input"
                  value={editing.icon ?? ''}
                  disabled={editing.builtin}
                  placeholder="🧭"
                  onChange={(e) => patch({ icon: e.target.value })}
                />
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-xs text-ink-soft">默认模型</label>
                <input
                  className="sm-input"
                  value={editing.model ?? ''}
                  disabled={editing.builtin}
                  placeholder="留空则用节点智能体模型"
                  onChange={(e) => patch({ model: e.target.value })}
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">描述</label>
              <input
                className="sm-input"
                value={editing.description ?? ''}
                disabled={editing.builtin}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">上下文隔离</label>
              <select
                className="sm-input cursor-pointer"
                value={editing.contextScope ?? 'shared'}
                disabled={editing.builtin}
                onChange={(e) =>
                  patch({ contextScope: e.target.value as 'shared' | 'isolated' })
                }
              >
                <option value="shared">共享（与其它节点共用全局上下文）</option>
                <option value="isolated">隔离（独立上下文，不污染共享）</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-soft">系统提示词（角色设定）</label>
              <textarea
                className="sm-input min-h-[120px]"
                value={editing.system}
                disabled={editing.builtin}
                placeholder="设定该角色的本职、职责与输出规范…"
                onChange={(e) => patch({ system: e.target.value })}
              />
            </div>
            {!editing.builtin && (
              <button
                className="sm-btn text-err hover:border-err hover:text-err"
                onClick={() => {
                  removeRole(editing.id);
                  setEditingId(roles.find((r) => !r.builtin && r.id !== editing.id)?.id ?? null);
                }}
              >
                <Trash2 size={13} /> 删除此角色
              </button>
            )}
            {editing.builtin && (
              <p className="text-[11px] text-ink-faint">
                内置角色不可编辑/删除。如需自定义，请在左侧「新建角色」并参考其设定。
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-[13px] text-ink-faint">从左侧选择或新建角色</p>
          </div>
        )}
      </div>
    </div>
  );
}
