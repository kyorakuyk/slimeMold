import { useEffect, useState } from 'react';
import {
  X,
  Settings as SettingsIcon,
  Monitor,
  Bot,
  Boxes,
  Cpu,
  Workflow,
  Route,
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
  loadEndpointKey,
  removeEndpoint,
  saveEndpoint,
} from '../agents/credentialStore';
import { fetchOpenAIModels } from '../agents/agentManager';
import { isTauri } from '../platform/env';
import type { ApiEndpoint, Protocol } from '../types';
import AgentPanel from './AgentPanel';
import PluginPanel from './PluginPanel';
import { RouteTableEditor } from './RouteTableEditor';
import { useT } from '../i18n/useT';

type SectionId = 'general' | 'agent' | 'model' | 'mcp' | 'flow' | 'routing' | 'apikeys';

const SECTION_IDS: SectionId[] = ['general', 'agent', 'model', 'mcp', 'flow', 'routing', 'apikeys'];

const SECTION_ICONS: Record<SectionId, JSX.Element> = {
  general: <Monitor size={15} />,
  agent: <Bot size={15} />,
  model: <Cpu size={15} />,
  mcp: <Boxes size={15} />,
  flow: <Workflow size={15} />,
  routing: <Route size={15} />,
  apikeys: <KeyRound size={15} />,
};

/** 仿 Trae 的设置中心：左侧分区导航 + 右侧内容 */
export default function SettingsCenter({ onClose }: { onClose: () => void }) {
  const t = useT('settings');
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
            <SettingsIcon size={16} /> {t('settings.title')}
          </h2>
          <div className="space-y-1">
            {SECTION_IDS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-[13px] transition-colors"
                style={{
                  background: section === id ? 'var(--sm-accent-soft)' : 'transparent',
                  color: section === id ? 'var(--sm-accent)' : 'var(--sm-ink-faint)',
                }}
                title={t(`settings.sec.${id}.desc`)}
              >
                {SECTION_ICONS[id]}
                <span>{t(`settings.sec.${id}.label`)}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* 右侧内容 */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: 'var(--sm-line)' }}>
            <div>
              <span className="text-[14px] font-semibold" style={{ color: 'var(--sm-ink)' }}>
                {t(`settings.sec.${section}.label`)}
              </span>
              <span className="ml-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
                {t(`settings.sec.${section}.desc`)}
              </span>
            </div>
            <button className="sm-btn px-2 py-0.5" onClick={onClose} title={t('settings.close')}>
              <X size={14} /> {t('settings.close')}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {section === 'general' && <GeneralSection />}
            {section === 'agent' && <AgentSection />}
            {section === 'model' && <ModelSection />}
            {section === 'mcp' && <McpSection />}
            {section === 'flow' && <FlowSection />}
            {section === 'routing' && <RoutingSection />}
            {section === 'apikeys' && <ApiKeysSection />}
          </div>
        </section>
      </div>
    </div>
  );
}

/* ---------------- 通用 ---------------- */
function GeneralSection() {
  const t = useT('settings');
  const { showGrid, showMinimap, toggleGrid, toggleMinimap, interactionMode, setInteractionMode, globalProxyUrl, setGlobalProxyUrl, theme, setTheme } = useViewStore();
  const llmChannel = useWorkflowStore((s) => s.llmChannel);
  const setLlmChannel = useWorkflowStore((s) => s.setLlmChannel);

  return (
    <div className="space-y-4">
      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.general.appearance')}</h3>
        <div className="flex items-center justify-between rounded border border-line px-3 py-2.5">
          <span>
            <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.general.colorTheme')}</span>
            <span className="block text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>{t('settings.general.themeHint')}</span>
          </span>
          <div className="flex gap-2">
            {([{ v: 'dark', key: 'settings.theme.dark' }, { v: 'light', key: 'settings.theme.light' }, { v: 'system', key: 'settings.theme.system' }] as const).map((opt) => (
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
                {t(opt.key)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.general.canvas')}</h3>
        <ToggleRow label={t('settings.general.showGrid')} desc={t('settings.general.showGridDesc')} checked={showGrid} onChange={toggleGrid} />
        <ToggleRow label={t('settings.general.showMinimap')} desc={t('settings.general.showMinimapDesc')} checked={showMinimap} onChange={toggleMinimap} />
        <div className="mt-2 flex items-center justify-between rounded border border-line px-3 py-2.5">
          <span>
            <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.general.mouseMode')}</span>
            <span className="block text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>{t('settings.general.mouseModeDesc')}</span>
          </span>
          <select
            className="sm-input max-w-[140px]"
            value={interactionMode}
            onChange={(e) => setInteractionMode(e.target.value as 'move' | 'select' | 'click')}
          >
            <option value="move">{t('settings.option.move')}</option>
            <option value="select">{t('settings.option.select')}</option>
            <option value="click">{t('settings.option.click')}</option>
          </select>
        </div>
      </div>

      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.general.llmChannel')}</h3>
        <p className="mb-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          {t('settings.general.llmChannelDesc')}
        </p>
        <div className="flex gap-2">
          {([{ v: 'backend', key: 'settings.channel.backend' }, { v: 'frontend', key: 'settings.channel.frontend' }] as const).map((opt) => (
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
              {t(opt.key)}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded border border-line p-3">
        <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>
          <Globe size={14} /> {t('settings.general.proxy')}
        </h3>
        <input
          className="sm-input w-full"
          placeholder={t('settings.general.proxyPlaceholder')}
          value={globalProxyUrl}
          onChange={(e) => setGlobalProxyUrl(e.target.value)}
        />
        <p className="mt-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          {t('settings.general.proxyHint')}
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
  const t = useT('settings');
  const agents = useWorkflowStore((s) => s.agents);
  const defaultAgentId = useWorkflowStore((s) => s.defaultAgentId);
  const setDefaultAgent = useWorkflowStore((s) => s.setDefaultAgent);

  return (
    <div className="space-y-4">
      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.model.presetLib')}</h3>
        <p className="mb-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          {t('settings.model.presetLibDesc')}
        </p>
        <div className="space-y-1.5">
          {providerPresets.map((p) => (
            <div key={p.id} className="rounded border border-line px-3 py-2">
              <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{p.label ?? p.name}</span>
              {p.baseUrl ? (
                <code className="ml-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>{p.baseUrl}</code>
              ) : (
                <span className="ml-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>{t('settings.model.custom')}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.model.defaultModel')}</h3>
        <p className="mb-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          {t('settings.model.defaultModelDesc')}
        </p>
        <select
          className="sm-input w-full"
          value={defaultAgentId ?? ''}
          onChange={(e) => setDefaultAgent(e.target.value || null)}
        >
          <option value="">{t('settings.model.unset')}</option>
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
  const t = useT('settings');
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
    else setMsg({ type: 'err', text: t('settings.apikeys.webOnly') });
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
    if (!n) return setMsg({ type: 'err', text: t('settings.apikeys.nameRequired') });
    if (n === '__ep_store__' || n.startsWith('ep::')) return setMsg({ type: 'err', text: t('settings.apikeys.reservedName') });
    const bu = baseUrl.trim().replace(/\/+$/, '');
    if (!bu) return setMsg({ type: 'err', text: t('settings.apikeys.urlRequired') });
    if (protocol !== 'ollama' && !apiKey.trim()) return setMsg({ type: 'err', text: t('settings.apikeys.keyRequired') });
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
        setMsg({ type: 'ok', text: t('settings.apikeys.savedVerified', { name: n, count: res.count }) });
        await refresh();
      } else {
        // 校验未通过：保留已填内容，便于修改后重试
        setMsg({ type: 'err', text: t('settings.apikeys.saveVerifyFail', { error: res.error ?? t('settings.apikeys.unknownError') }) });
      }
    } catch (e) {
      setChecking(null);
      setMsg({ type: 'err', text: t('settings.apikeys.saveFail', { error: (e as Error).message }) });
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
      setMsg({ type: 'ok', text: t('settings.apikeys.deleted', { name: n }) });
      await refresh();
    } catch (e) {
      setMsg({ type: 'err', text: t('settings.apikeys.deleteFail', { error: (e as Error).message }) });
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
        <h3 className="mb-1 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.apikeys.title')}</h3>
        <p className="mb-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          {t('settings.apikeys.desc')}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <input className="sm-input" placeholder={t('settings.apikeys.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
          <select className="sm-input" value={protocol} onChange={(e) => setProtocol(e.target.value as Protocol)}>
            {PROTOCOLS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <input
            className="sm-input col-span-2"
            placeholder={t('settings.apikeys.urlPlaceholder')}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <input
            className="sm-input col-span-2"
            placeholder={protocol === 'ollama' ? t('settings.apikeys.keyPlaceholderOllama') : t('settings.apikeys.keyPlaceholder')}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
        </div>
        <button type="button" className="sm-btn mt-2 flex items-center gap-1 px-3 py-1.5" onClick={handleAdd}>
          <Plus size={13} /> {t('settings.apikeys.save')}
        </button>
      </div>

      {msg && (
        <p className="text-[12px]" style={{ color: msg.type === 'ok' ? 'var(--sm-ok)' : 'var(--sm-err)' }}>
          {msg.text}
        </p>
      )}

      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>
          {t('settings.apikeys.configured', { count: endpoints.length })}
        </h3>
        {endpoints.length === 0 ? (
          <p className="text-[12px]" style={{ color: 'var(--sm-ink-faint)' }}>
            {t('settings.apikeys.empty')}
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
                      <button type="button" className="text-ink-faint hover:text-accent" title={t('settings.apikeys.recheck')} onClick={() => recheck(ep)} disabled={checking === ep.name}>
                        <RefreshCw size={13} className={checking === ep.name ? 'animate-spin' : ''} />
                      </button>
                      <button type="button" className="text-ink-faint hover:text-accent" title={t('settings.apikeys.reveal')} onClick={() => toggleReveal(ep.name)}>
                        {reveal[ep.name] !== undefined ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                      <button type="button" className="text-ink-faint hover:text-err" title={t('settings.apikeys.delete')} onClick={() => handleDelete(ep.name)}>
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

/* ---------------- 路由表（类别 → 智能体） ---------------- */
function RoutingSection() {
  const t = useT('settings');
  return (
    <div className="space-y-3">
      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.routing.title')}</h3>
        <p className="mb-3 text-[11px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
          {t('settings.routing.desc')}
        </p>
        <RouteTableEditor />
      </div>
    </div>
  );
}

/* ---------------- 对话流 ---------------- */
function FlowSection() {
  const t = useT('settings');
  const failFast = useWorkflowStore((s) => s.failFast);
  const setFailFast = useWorkflowStore((s) => s.setFailFast);
  const maxConcurrency = useWorkflowStore((s) => s.maxConcurrency);
  const setMaxConcurrency = useWorkflowStore((s) => s.setMaxConcurrency);

  return (
    <div className="space-y-4">
      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.flow.title')}</h3>
        <ToggleRow
          label={t('settings.flow.failFast')}
          desc={t('settings.flow.failFastDesc')}
          checked={failFast}
          onChange={() => setFailFast(!failFast)}
        />
        <div className="mt-2 flex items-center justify-between rounded border border-line px-3 py-2.5">
          <span>
            <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.flow.maxConcurrency')}</span>
            <span className="block text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
              {t('settings.flow.maxConcurrencyDesc')}
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
  const t = useT('settings');
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
        title={checked ? t('settings.toggle.on') : t('settings.toggle.off')}
      >
        <span
          className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
          style={{ left: checked ? '18px' : '2px' }}
        />
      </button>
    </label>
  );
}
