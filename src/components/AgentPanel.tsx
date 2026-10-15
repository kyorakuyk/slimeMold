import { useState, useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import {
  createAgent,
  protocolDefaults,
  fetchOllamaModels,
  fetchModelsByProtocol,
  probeAgent,
  translateProbeMessage,
  findProviderPreset,
  type ProbeMessageSpec,
  type ProbeResult,
  type ProbeStatus,
} from '../agents/agentManager';
import { codexLoginStatus } from '../agents/providers/codex';
import { loadCredential, defaultCredentialKey, listVaults, loadVaultKey } from '../agents/credentialStore';
import { isTauri } from '../platform/env';
import { useViewStore } from '../store/viewStore';
import type { AgentConfig, ApiVault, Protocol } from '../types/agent';
import { useT } from '../i18n/useT';
import RolesTab from './agentPanel/RolesTab';
import AgentEditorForm from './agentPanel/AgentEditorForm';
import AgentCatalogList from './agentPanel/AgentCatalogList';

interface AgentPanelProps {
  onClose?: () => void;
  embedded?: boolean;
  /** 'center'（控制中心，默认）= 左列表 + 右编辑 inline 左右二分；
   *  'sidebar'（侧边栏）= 列表为一级菜单，编辑配置作 absolute 二级抽屉从右滑入覆盖列表 */
  variant?: 'center' | 'sidebar';
}

type ProbeFeedback = Pick<ProbeResult, 'ok' | 'stage' | 'messageSpec' | 'proxied'>;

/** 智能体管理弹层：多协议配置的增删改 + 角色库（角色模板）管理 */
export default function AgentPanel({ onClose, embedded = false, variant = 'center' }: AgentPanelProps) {
  const t = useT('agents');
  const [tab, setTab] = useState<'agents' | 'roles'>('agents');

  const inner = (
      <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center border-b border-line px-3">
        <button
          className={`px-3 py-3 text-[13px] font-medium transition-colors ${
            tab === 'agents'
              ? 'border-b-2 border-accent text-ink'
              : 'text-ink-faint hover:text-ink'
          }`}
          onClick={() => setTab('agents')}
        >
          {t('agent.tab.agents')}
        </button>
        <button
          className={`px-3 py-3 text-[13px] font-medium transition-colors ${
            tab === 'roles'
              ? 'border-b-2 border-accent text-ink'
              : 'text-ink-faint hover:text-ink'
          }`}
          onClick={() => setTab('roles')}
        >
          {t('agent.tab.roles')}
        </button>
      </div>
      {tab === 'agents' ? <AgentsTab variant={variant} /> : <RolesTab />}
    </div>
  );

  // sidebar 模式：不需要外层居中弹层（SidePanel 已提供容器），直接返回 inner
  if (variant === 'sidebar') return inner;
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
              {t('agent.tab.agents')}
            </button>
            <button
              className={`px-3 py-3 text-[13px] font-medium transition-colors ${
                tab === 'roles'
                  ? 'border-b-2 border-accent text-ink'
                  : 'text-ink-faint hover:text-ink'
              }`}
              onClick={() => setTab('roles')}
            >
              {t('agent.tab.roles')}
            </button>
          </div>
          <button
            className="cursor-pointer text-ink-faint hover:text-ink"
            onClick={onClose}
            title={t('agent.close')}
          >
            <X size={16} />
          </button>
        </div>
        {tab === 'agents' ? <AgentsTab variant={variant} /> : <RolesTab />}
      </div>
    </div>
  );
}

function AgentsTab({ variant = 'center' }: { variant?: 'center' | 'sidebar' }) {
  const t = useT('agents');
  const agents = useWorkflowStore((s) => s.agents);
  const upsertAgent = useWorkflowStore((s) => s.upsertAgent);
  const removeAgent = useWorkflowStore((s) => s.removeAgent);
  const globalAgents = useWorkflowStore((s) => s.globalAgents);
  const upsertGlobalAgent = useWorkflowStore((s) => s.upsertGlobalAgent);
  const removeGlobalAgent = useWorkflowStore((s) => s.removeGlobalAgent);
  const defaultAgentId = useWorkflowStore((s) => s.defaultAgentId);
  const setDefaultAgent = useWorkflowStore((s) => s.setDefaultAgent);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [remoteModels, setRemoteModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelHint, setModelHint] = useState<ProbeMessageSpec | null>(null);
  const [probe, setProbe] = useState<ProbeFeedback | null>(null);
  const [probing, setProbing] = useState(false);
  /** 各智能体可用性状态（列表小圆点用），key=agentId */
  const [probeStates, setProbeStates] = useState<Record<string, ProbeStatus>>({});
  /** 保存成功后暂存的明文 key（仅当前会话内存，不落盘），供随后的检测/拉取直接使用，
   *  避免依赖从密钥库读回导致「已保存却读不到」的困惑。 */
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  /** 列表筛选：all=全部（默认）/ project=仅项目智能体 / global=仅全局智能体 */
  const [filter, setFilter] = useState<'all' | 'project' | 'global'>('all');
  /** 归属查找：项目级优先，全局兜底。 */
  const globalSet = useMemo(() => new Set(globalAgents.map((a) => a.id)), [globalAgents]);
  const projectSet = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);
  const belongsToGlobal = (id: string | null) => !!id && globalSet.has(id) && !projectSet.has(id);

  /** 合并池（同名项目级覆盖全局）：纯全局智能体置顶，项目级在后 */
  const pool = useMemo<AgentConfig[]>(() => {
    const projectIdSet = new Set(agents.map((a) => a.id));
    const globalOnly = globalAgents.filter((g) => !projectIdSet.has(g.id));
    return [...globalOnly, ...agents];
  }, [agents, globalAgents]);

  /** 按筛选过滤后的展示列表 */
  const filteredPool = useMemo(() => {
    if (filter === 'project') return pool.filter((a) => projectSet.has(a.id));
    if (filter === 'global') return pool.filter((a) => globalSet.has(a.id) && !projectSet.has(a.id));
    return pool;
  }, [pool, filter, globalSet, projectSet]);

  const editing = pool.find((a) => a.id === editingId);

  /** APIKEYS 分区里已登记的 Vault（供「从库导入」下拉）。 */
  const [vaults, setVaults] = useState<ApiVault[]>([]);
  useEffect(() => {
    if (isTauri) listVaults().then(setVaults);
  }, []);
  /** 从 Vault 库选择一个，自动生成一份填好 协议/网址/密钥 的智能体。 */
  const importFromVault = async (vaultId: string) => {
    if (!vaultId) return;
    const v = vaults.find((x) => x.id === vaultId);
    if (!v) return;
    const agent = createAgent(v.protocol);
    agent.baseUrl = v.baseUrl;
    agent.credentialKey = v.id;
    agent.name = t('agent.list.importedName', { name: v.label });
    agent.providerId = v.vendor === 'transit' ? 'custom' : v.vendor;
    upsertAgent(agent);
    setEditingId(agent.id);
    // 取回明文 key 暂存内存，便于立即检测/拉模型
    const key = v.protocol === 'ollama' ? null : (await loadVaultKey(v.id))?.apiKey ?? null;
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
        if (a.protocol === 'ollama' || a.protocol === 'codex') continue;
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
   *  若配置了代理（智能体 proxyUrl 优先于全局代理），则经代理出口探测，验证整条链路。
   *  Codex/Ollama/keyed provider 使用各自认证路径；结果只更新 probe UI，不持久化编辑中的 Agent（ADR-SM-073）。 */
  const runProbe = async () => {
    if (!editing) return;
    setProbing(true);
    setProbe(null);
    try {
      if (editing.protocol === 'codex') {
        const status = await codexLoginStatus();
        const result = status.loggedIn && status.authMode === 'chatgpt'
          ? { ok: true, stage: 'ok' as const, messageSpec: { key: 'agent.codex.connected' } }
          : {
              ok: false,
              stage: 'auth' as const,
              messageSpec: { key: status.loggedIn ? 'agent.codex.otherAuth' : 'agent.codex.loginRequired' },
            };
        setProbe(result);
        setProbeStates((prev) => ({ ...prev, [editing.id]: { ok: result.ok, stage: result.stage } }));
        return;
      }
      const key =
        editing.protocol === 'ollama'
          ? undefined
          : pendingKey ?? (await loadCredential(editing.credentialKey ?? defaultCredentialKey(editing.protocol))) ?? undefined;
      if (editing.protocol !== 'ollama' && !key) {
        setProbe({
          ok: false,
          stage: 'auth',
          messageSpec: { key: isTauri ? 'agent.probe.saveKeyFirst' : 'agent.probe.saveKeyFirstWeb' },
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
      setProbe({ ok: r.ok, stage: r.stage, messageSpec: r.messageSpec, proxied: r.proxied });
      setProbeStates((prev) => ({ ...prev, [editing.id]: { ok: r.ok, stage: r.stage } }));
    } finally {
      setProbing(false);
    }
  };

  /** 为编辑器模型选择器读取当前协议的 model catalog，不改写 `editing.model`。
   * Codex 在此只显示登录状态；Ollama 与 keyed API 走不同读取路径，缺 credential 时只给出 UI 提示（ADR-SM-073）。
   */
  const pullModels = async () => {
    if (!editing) return;
    setLoadingModels(true);
    setModelHint(null);
    try {
      let list: string[] = [];
      if (editing.protocol === 'codex') {
        const status = await codexLoginStatus();
        setModelHint({
          key: status.loggedIn && status.authMode === 'chatgpt'
            ? 'agent.model.codexDefault'
            : status.loggedIn
              ? 'agent.codex.otherAuth'
              : 'agent.model.codexLoginFirst',
        });
        return;
      }
      if (editing.protocol === 'ollama') {
        list = await fetchOllamaModels(editing.baseUrl || 'http://127.0.0.1:11434');
      } else {
        const key = pendingKey ?? (await loadCredential(editing.credentialKey ?? defaultCredentialKey(editing.protocol)));
        if (!key) {
          setModelHint({ key: 'agent.model.noKey' });
          return;
        }
        const proxyUrl: string | undefined = editing.proxyUrl?.trim() || useViewStore.getState().globalProxyUrl?.trim() || undefined;
        list = await fetchModelsByProtocol(editing.protocol, editing.baseUrl, key, proxyUrl);
        if (list.length === 0) {
          setModelHint({
            key: editing.protocol === 'anthropic'
              ? 'agent.model.noAnthropicModels'
              : 'agent.model.noModels',
          });
        }
      }
      setRemoteModels(list);
    } catch (e) {
      // 静默吞错是诊断盲区：keyring 读取失败、HTTP 被拦截、URL 解析异常等都会表现为
      // 「点了没反应」。把真实错误暴露到 UI，便于用户定位是 key / 网址 / 权限问题。
      const msg = e instanceof Error ? e.message : String(e);
      setModelHint({ key: 'agent.model.pullFailed', options: { error: msg } });
    } finally {
      setLoadingModels(false);
    }
  };

  const patch = (p: Partial<AgentConfig>) => {
    if (!editing) return;
    if (belongsToGlobal(editing.id)) upsertGlobalAgent({ ...editing, ...p });
    else upsertAgent({ ...editing, ...p });
  };

  const changeProtocol = (protocol: Protocol) => {
    if (!editing) return;
    const d = protocolDefaults[protocol];
    const updated = { ...editing, protocol, baseUrl: d.baseUrl, model: d.model };
    if (belongsToGlobal(editing.id)) upsertGlobalAgent(updated);
    else upsertAgent(updated);
  };

  const addAgent = (protocol: Protocol) => {
    const agent = createAgent(protocol);
    upsertAgent(agent);
    setEditingId(agent.id);
  };

  /** 图钉按钮：切换 agent 作用域（项目级 ↔ 全局通用）。 */
  const toggleGlobal = (id: string) => {
    const a = pool.find((x) => x.id === id);
    if (!a) return;
    if (belongsToGlobal(id)) {
      upsertAgent({ ...a });
      removeGlobalAgent(id);
    } else {
      upsertGlobalAgent({ ...a });
      removeAgent(id);
    }
  };

  const localizedProbe: ProbeResult | null = probe
    ? { ...probe, message: translateProbeMessage(probe.messageSpec, t) }
    : null;

  return (
    <div className={`relative flex h-full w-full min-h-0 flex-1 ${variant === 'sidebar' ? 'overflow-visible' : 'overflow-hidden'}`}>
      <AgentCatalogList
        variant={variant}
        editingId={editingId}
        filter={filter}
        pool={pool}
        filteredPool={filteredPool}
        projectSet={projectSet}
        globalSet={globalSet}
        defaultAgentId={defaultAgentId}
        probeStates={probeStates}
        vaults={vaults}
        belongsToGlobal={belongsToGlobal}
        onFilterChange={setFilter}
        onSelectAgent={(id) => setEditingId(editingId === id ? null : id)}
        onSetDefaultAgent={setDefaultAgent}
        onToggleGlobal={toggleGlobal}
        onAddPreset={(providerId) => {
          if (!providerId) return;
          const preset = findProviderPreset(providerId);
          const agent = createAgent(preset?.protocol ?? 'openai', providerId);
          upsertAgent(agent);
          setEditingId(agent.id);
        }}
        onAddAgent={addAgent}
        onImportFromVault={importFromVault}
      />

      <AgentEditorForm
        editing={editing}
        variant={variant}
        remoteModels={remoteModels}
        loadingModels={loadingModels}
        modelHint={modelHint ? translateProbeMessage(modelHint, t) : ''}
        probing={probing}
        probe={localizedProbe}
        onPatch={patch}
        onProtocolChange={changeProtocol}
        onPullModels={pullModels}
        onProbe={runProbe}
        onKeySaved={onKeySaved}
        onKeyCleared={onKeyCleared}
        onClose={() => setEditingId(null)}
        onDelete={() => {
          if (!editing) return;
          if (belongsToGlobal(editing.id)) removeGlobalAgent(editing.id);
          else removeAgent(editing.id);
          setEditingId(null);
        }}
        onToggleEnabled={() => {
          if (!editing) return;
          patch({ enabled: editing.enabled === false ? true : false });
        }}
      />
    </div>
  );
}
