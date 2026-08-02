import { useEffect, useState } from 'react';
import {
  X,
  Settings as SettingsIcon,
  Monitor,
  Bot,
  Boxes,
  Cpu,
  Workflow,
  Globe,
  KeyRound,
  Eye,
  EyeOff,
  Trash2,
  Plus,
  CheckCircle2,
  XCircle,
  RefreshCw,
} from 'lucide-react';
import { useViewStore } from '../store/viewStore';
import { useWorkflowStore } from '../store/workflowStore';
import { providerPresets } from '../agents/agentManager';
import {
  listEndpoints,
  loadEndpoint,
  loadEndpointKey,
  removeEndpoint,
  saveEndpoint,
} from '../agents/credentialStore';
import { fetchOpenAIModels } from '../agents/agentManager';
import { isTauri } from '../platform/env';
import type { ApiEndpoint, Protocol } from '../types';
import AgentPanel from './AgentPanel';
import PluginPanel from './PluginPanel';
import type { ThemeMode } from '../store/viewStore';

type SectionId = 'general' | 'agent' | 'model' | 'mcp' | 'flow' | 'apikeys';

const SECTIONS: { id: SectionId; label: string; icon: JSX.Element; desc: string }[] = [
  { id: 'general', label: '通用', icon: <Monitor size={15} />, desc: '画布、LLM 通道、全局代理' },
  { id: 'agent', label: '智能体', icon: <Bot size={15} />, desc: '凭据、预设、默认切换、检测' },
  { id: 'model', label: '模型', icon: <Cpu size={15} />, desc: '供应商预设库与全局默认模型' },
  { id: 'mcp', label: 'MCP', icon: <Boxes size={15} />, desc: '插件 / MCP server 管理' },
  { id: 'flow', label: '对话流', icon: <Workflow size={15} />, desc: '执行引擎：并发、失败策略' },
  { id: 'apikeys', label: 'APIKEYS', icon: <KeyRound size={15} />, desc: '集中管理系统密钥库中的 API Key' },
];

/** 仿 Trae 的设置中心：左侧分区导航 + 右侧内容 */
export default function SettingsCenter({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SectionId>('general');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={onClose}
    >
      <div
        className="flex h-[640px] w-[860px] overflow-hidden rounded-lg border shadow-2xl"
        style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* 左侧导航 */}
        <nav
          className="w-[200px] shrink-0 border-r p-3"
          style={{ borderColor: 'var(--sm-line)', background: 'var(--sm-bg-deep)' }}
        >
          <h2 className="mb-3 flex items-center gap-2 px-1 text-[15px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
            <SettingsIcon size={16} /> 设置
          </h2>
          <div className="space-y-1">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSection(s.id)}
                className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-[13px] transition-colors"
                style={{
                  background: section === s.id ? 'var(--sm-accent-soft)' : 'transparent',
                  color: section === s.id ? 'var(--sm-accent)' : 'var(--sm-ink-faint)',
                }}
                title={s.desc}
              >
                {s.icon}
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* 右侧内容 */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: 'var(--sm-line)' }}>
            <div>
              <span className="text-[14px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
                {SECTIONS.find((s) => s.id === section)?.label}
              </span>
              <span className="ml-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
                {SECTIONS.find((s) => s.id === section)?.desc}
              </span>
            </div>
            <button className="sm-btn px-2 py-0.5" onClick={onClose}>
              <X size={14} /> 关闭
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {section === 'general' && <GeneralSection />}
            {section === 'agent' && <AgentSection />}
            {section === 'model' && <ModelSection />}
            {section === 'mcp' && <McpSection />}
            {section === 'flow' && <FlowSection />}
            {section === 'apikeys' && <ApiKeysSection />}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ---------------- 通用 ---------------- */
function GeneralSection() {
  const { showGrid, showMinimap, toggleGrid, toggleMinimap, interactionMode, setInteractionMode, globalProxyUrl, setGlobalProxyUrl, theme, setTheme } = useViewStore();
  const llmChannel = useWorkflowStore((s) => s.llmChannel);
  const setLlmChannel = useWorkflowStore((s) => s.setLlmChannel);

  return (
    <div className="space-y-4">
      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>外观</h3>
        <div className="flex items-center justify-between rounded border border-line px-3 py-2.5">
          <span>
            <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>颜色主题</span>
            <span className="block text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>切换后即时生效并持久化保存</span>
          </span>
          <div className="flex gap-2">
            {([{ v: 'dark', t: '暗色' }, { v: 'light', t: '亮色' }, { v: 'system', t: '跟随系统' }] as const).map((opt) => (
              <button
                key={opt.v}
                type="button"
                onClick={() => setTheme(opt.v)}
                className="rounded border px-3 py-1.5 text-[12px] transition-colors"
                style={{
                  borderColor: theme === opt.v ? 'var(--sm-accent)' : 'var(--sm-line)',
                  background: theme === opt.v ? 'var(--sm-accent-soft)' : 'transparent',
                  color: theme === opt.v ? 'var(--sm-accent)' : 'var(--sm-ink-faint)',
                }}
              >
                {opt.t}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>画布</h3>
        <ToggleRow label="显示网格" desc="画布背景网格点阵" checked={showGrid} onChange={toggleGrid} />
        <ToggleRow label="显示小地图" desc="右下角导航小地图" checked={showMinimap} onChange={toggleMinimap} />
        <div className="mt-2 flex items-center justify-between rounded border border-line px-3 py-2.5">
          <span>
            <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>鼠标模式</span>
            <span className="block text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>拖动画布 / 框选 / 点击选中</span>
          </span>
          <select
            className="sm-input max-w-[140px]"
            value={interactionMode}
            onChange={(e) => setInteractionMode(e.target.value as 'move' | 'select' | 'click')}
          >
            <option value="move">拖动</option>
            <option value="select">框选</option>
            <option value="click">点击</option>
          </select>
        </div>
      </div>

      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>LLM 调用通道</h3>
        <p className="mb-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          后端：经 Rust 命令发起，密钥不出渲染层（推荐）；前端：WebView 直接请求
        </p>
        <div className="flex gap-2">
          {([{ v: 'backend', t: '后端（推荐）' }, { v: 'frontend', t: '前端' }] as const).map((opt) => (
            <button
              key={opt.v}
              type="button"
              onClick={() => setLlmChannel(opt.v)}
              className="flex-1 rounded border px-2 py-1.5 text-[12px] transition-colors"
              style={{
                borderColor: llmChannel === opt.v ? 'var(--sm-accent)' : 'var(--sm-line)',
                background: llmChannel === opt.v ? 'var(--sm-accent-soft)' : 'transparent',
                color: llmChannel === opt.v ? 'var(--sm-accent)' : 'var(--sm-ink-faint)',
              }}
            >
              {opt.t}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded border border-line p-3">
        <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>
          <Globe size={14} /> 全局代理（本地代理转发）
        </h3>
        <input
          className="sm-input w-full"
          placeholder="http://127.0.0.1:7890（留空=各智能体用自己的代理或直连）"
          value={globalProxyUrl}
          onChange={(e) => setGlobalProxyUrl(e.target.value)}
        />
        <p className="mt-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          全局默认出口。智能体自身的 proxyUrl 优先于此项；均留空则直连目标 Base URL。
          适配中转 / OpenAI 格式统一出口，backend 与 frontend 通道均已生效。
        </p>
      </div>
    </div>
  );
}

/* ---------------- 智能体（复用 AgentPanel，内联嵌入） ---------------- */
function AgentSection() {
  return <AgentPanel embedded />;
}

/* ---------------- 模型 ---------------- */
function ModelSection() {
  const agents = useWorkflowStore((s) => s.agents);
  const defaultAgentId = useWorkflowStore((s) => s.defaultAgentId);
  const setDefaultAgent = useWorkflowStore((s) => s.setDefaultAgent);

  return (
    <div className="space-y-4">
      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>供应商预设库</h3>
        <p className="mb-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          在「智能体」分区新建智能体时，可按下方预设一键填充 Base URL 与默认模型。
        </p>
        <div className="space-y-1.5">
          {providerPresets.map((p) => (
            <div key={p.id} className="rounded border border-line px-3 py-2">
              <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{p.label}</span>
              {p.baseUrl ? (
                <code className="ml-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>{p.baseUrl}</code>
              ) : (
                <span className="ml-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>自定义（手动填写）</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>全局默认模型 / 智能体</h3>
        <p className="mb-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          设为默认后，新建对话流节点会优先套用该智能体（含其模型与凭据）。
        </p>
        <select
          className="sm-input w-full"
          value={defaultAgentId ?? ''}
          onChange={(e) => setDefaultAgent(e.target.value || null)}
        >
          <option value="">（未设置）</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name || a.id} · {a.model}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/* ---------------- MCP（复用 PluginPanel，内联嵌入） ---------------- */
function McpSection() {
  return <PluginPanel embedded />;
}

/* ---------------- APIKEYS：集中管理系统密钥库中的 API 接入点（网址 + 密钥） ---------------- */
const PROTOCOLS: Protocol[] = ['openai', 'anthropic', 'ollama'];

function ApiKeysSection() {
  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([]);
  const [reveal, setReveal] = useState<Record<string, string>>({});
  // 新增表单
  const [name, setName] = useState('');
  const [protocol, setProtocol] = useState<Protocol>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  // 每项检测状态：name -> { ok, count, error }
  const [checks, setChecks] = useState<Record<string, { ok: boolean; count: number; error?: string }>>({});
  const [checking, setChecking] = useState<string | null>(null);

  const refresh = async () => setEndpoints(await listEndpoints());

  useEffect(() => {
    if (isTauri) refresh();
    else setMsg({ type: 'err', text: '当前为 Web 预览环境，系统密钥库不可用，请使用桌面版。' });
  }, []);

  /** 校验一个接入点：网址可达 + 密钥有效 + 能拉到模型。 */
  const verify = async (ep: ApiEndpoint, key: string | null): Promise<{ ok: boolean; count: number; error?: string }> => {
    if (ep.protocol === 'ollama') {
      // 本地 Ollama 无需密钥，直接视为已配置（模型在智能体界面拉取）
      return { ok: !!ep.baseUrl, count: 0 };
    }
    if (!key) return { ok: false, count: 0, error: '缺少密钥' };
    try {
      const models = await fetchOpenAIModels(ep.baseUrl, key);
      if (models.length === 0) return { ok: false, count: 0, error: '网址可达但拉不到模型，检查 Base URL / Key' };
      return { ok: true, count: models.length };
    } catch (e) {
      return { ok: false, count: 0, error: (e as Error).message };
    }
  };

  const handleAdd = async () => {
    const n = name.trim();
    if (!n) return setMsg({ type: 'err', text: '请填写接入点名称（如 apinebula）。' });
    if (n === '__ep_store__' || n.startsWith('ep::')) return setMsg({ type: 'err', text: '该名称被系统保留。' });
    const bu = baseUrl.trim().replace(/\/+$/, '');
    if (!bu) return setMsg({ type: 'err', text: '请填写 API 网址（Base URL）。' });
    if (protocol !== 'ollama' && !apiKey.trim()) return setMsg({ type: 'err', text: '请填写 API Key。' });
    const ep: ApiEndpoint = { name: n, protocol, baseUrl: bu, credentialKey: n };
    try {
      await saveEndpoint(ep, apiKey.trim());
      // 立即校验
      setChecking(n);
      const res = await verify(ep, protocol === 'ollama' ? null : apiKey.trim());
      setChecking(null);
      setChecks((c) => ({ ...c, [n]: res }));
      if (res.ok) {
        // 仅校验通过才清空输入
        setName('');
        setBaseUrl('');
        setApiKey('');
        setMsg({ type: 'ok', text: `已保存并通过校验：${n}（可用模型 ${res.count} 个）` });
        await refresh();
      } else {
        // 校验未通过：保留已填内容，便于修改后重试
        setMsg({ type: 'err', text: `已保存，但校验未通过：${res.error ?? '未知错误'}（输入已保留，修改后重试）` });
      }
    } catch (e) {
      setChecking(null);
      setMsg({ type: 'err', text: `保存失败：${(e as Error).message}（输入已保留）` });
    }
  };

  const handleDelete = async (n: string) => {
    try {
      await removeEndpoint(n);
      setReveal((r) => {
        const x = { ...r };
        delete x[n];
        return x;
      });
      setChecks((c) => {
        const x = { ...c };
        delete x[n];
        return x;
      });
      setMsg({ type: 'ok', text: `已删除：${n}` });
      await refresh();
    } catch (e) {
      setMsg({ type: 'err', text: `删除失败：${(e as Error).message}` });
    }
  };

  const toggleReveal = async (n: string) => {
    if (reveal[n] !== undefined) {
      setReveal((r) => {
        const x = { ...r };
        delete x[n];
        return x;
      });
      return;
    }
    const v = await loadEndpointKey(n);
    if (v) setReveal((r) => ({ ...r, [n]: v }));
  };

  const recheck = async (ep: ApiEndpoint) => {
    setChecking(ep.name);
    const key = protocol === 'ollama' ? null : await loadEndpointKey(ep.name);
    const res = await verify(ep, key);
    setChecking(null);
    setChecks((c) => ({ ...c, [ep.name]: res }));
  };

  return (
    <div className="space-y-4">
      <div className="rounded border border-line p-3">
        <h3 className="mb-1 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>新增 API 接入点</h3>
        <p className="mb-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          把「API 网址 + 密钥」绑定为一个可复用配置（类似 cc-switch 的 API 路由）。保存后自动校验网址与密钥，
          并拉取可用模型列表。明文仅存系统密钥库，智能体可下拉引用，无需重复填写。
        </p>
        <div className="grid grid-cols-2 gap-2">
          <input className="sm-input" placeholder="名称（如 apinebula）" value={name} onChange={(e) => setName(e.target.value)} />
          <select className="sm-input" value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)}>
            {PROTOCOLS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <input
            className="sm-input col-span-2"
            placeholder="API 网址（Base URL，如 https://apinebula.ai/v1）"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <input
            className="sm-input col-span-2"
            placeholder={protocol === 'ollama' ? 'Ollama 本地无需密钥' : 'API Key（sk-...）'}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
        </div>
        <button type="button" className="sm-btn mt-2 flex items-center gap-1 px-3 py-1.5" onClick={handleAdd}>
          <Plus size={13} /> 保存并校验
        </button>
      </div>

      {msg && (
        <p className="text-[12px]" style={{ color: msg.type === 'ok' ? 'var(--sm-ok)' : 'var(--sm-err)' }}>
          {msg.text}
        </p>
      )}

      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>
          已配置的接入点（{endpoints.length}）
        </h3>
        {endpoints.length === 0 ? (
          <p className="text-[12px]" style={{ color: 'var(--sm-ink-faint)' }}>
            暂无接入点。在上方保存后会显示在这里；「智能体」界面可下拉引用这些接入点快速生成智能体。
          </p>
        ) : (
          <div className="space-y-1.5">
            {endpoints.map((ep) => {
              const chk = checks[ep.name];
              return (
                <div key={ep.name} className="rounded border border-line px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{ep.name}</span>
                      <span className="ml-2 rounded bg-black/5 px-1.5 py-0.5 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                        {ep.protocol}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {chk && (chk.ok ? <CheckCircle2 size={14} className="text-emerald-500" /> : <XCircle size={14} className="text-rose-500" />)}
                      <button type="button" className="text-ink-faint hover:text-accent" title="重新校验" onClick={() => recheck(ep)} disabled={checking === ep.name}>
                        <RefreshCw size={13} className={checking === ep.name ? 'animate-spin' : ''} />
                      </button>
                      <button type="button" className="text-ink-faint hover:text-accent" title="显示 / 隐藏密钥" onClick={() => toggleReveal(ep.name)}>
                        {reveal[ep.name] !== undefined ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                      <button type="button" className="text-ink-faint hover:text-err" title="删除" onClick={() => handleDelete(ep.name)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  <p className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>{ep.baseUrl}</p>
                  {chk?.error && <p className="mt-0.5 text-[11px]" style={{ color: 'var(--sm-err)' }}>{chk.error}</p>}
                  {reveal[ep.name] !== undefined && (
                    <code className="mt-1 block break-all rounded bg-black/10 px-2 py-1 text-[11px]" style={{ color: 'var(--sm-ink)' }}>
                      {reveal[ep.name]}
                    </code>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- 对话流 ---------------- */
function FlowSection() {
  const failFast = useWorkflowStore((s) => s.failFast);
  const setFailFast = useWorkflowStore((s) => s.setFailFast);
  const maxConcurrency = useWorkflowStore((s) => s.maxConcurrency);
  const setMaxConcurrency = useWorkflowStore((s) => s.setMaxConcurrency);

  return (
    <div className="space-y-4">
      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>执行引擎</h3>
        <ToggleRow
          label="快速失败（failFast）"
          desc="任一节点出错立即停止整个对话流"
          checked={failFast}
          onChange={() => setFailFast(!failFast)}
        />
        <div className="mt-2 flex items-center justify-between rounded border border-line px-3 py-2.5">
          <span>
            <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>最大并发数</span>
            <span className="block text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
              同时进行的 LLM 请求上限（1–20）
            </span>
          </span>
          <input
            type="number"
            min={1}
            max={20}
            className="sm-input w-[80px]"
            value={maxConcurrency}
            onChange={(e) => setMaxConcurrency(Number(e.target.value))}
          />
        </div>
      </div>
    </div>
  );
}

/* ---------------- 通用小组件 ---------------- */
function ToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded border border-line px-3 py-2.5">
      <span>
        <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{label}</span>
        <span className="block text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>{desc}</span>
      </span>
      <button
        type="button"
        onClick={onChange}
        className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
        style={{ background: checked ? 'var(--sm-accent)' : 'var(--sm-bg-deep)' }}
        title={checked ? '已开启' : '已关闭'}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
          style={{ left: checked ? '18px' : '2px' }}
        />
      </button>
    </label>
  );
}
