import { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import { useViewStore } from '../store/viewStore';
import { useWorkflowStore } from '../store/workflowStore';
import { providerPresets } from '../agents/agentManager';
import ApiKeysSection from './settings/ApiKeysSection';
import AgentPanel from './AgentPanel';
import PluginPanel from './PluginPanel';
import { RouteTableEditor } from './RouteTableEditor';
import { useT } from '../i18n/useT';
import { SUPPORTED_LANGS, langLabel } from '../i18n';

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

          <div className="min-h-0 flex-1 overflow-hidden p-4">
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
  const { showGrid, showMinimap, toggleGrid, toggleMinimap, interactionMode, setInteractionMode, globalProxyUrl, setGlobalProxyUrl, theme, setTheme, locale, setLocale, selfImprove, setSelfImprove, eventPersistence, setEventPersistence } = useViewStore();
  const llmChannel = useWorkflowStore((s) => s.llmChannel);
  const setLlmChannel = useWorkflowStore((s) => s.setLlmChannel);

  return (
    <div className="h-full space-y-4 overflow-y-auto">
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
        <div className="mt-2 flex items-center justify-between rounded border border-line px-3 py-2.5">
          <span>
            <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.general.language')}</span>
            <span className="block text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>{t('settings.general.languageHint')}</span>
          </span>
          <select
            className="sm-input max-w-[160px]"
            value={locale}
            onChange={(e) => setLocale(e.target.value)}
          >
            {SUPPORTED_LANGS.map((lng) => (
              <option key={lng} value={lng}>
                {langLabel(lng)}
              </option>
            ))}
          </select>
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
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.general.selfImprove')}</h3>
        <ToggleRow
          label={t('settings.general.selfImprove')}
          desc={t('settings.general.selfImproveDesc')}
          checked={selfImprove}
          onChange={() => setSelfImprove(!selfImprove)}
        />
      </div>

      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.general.eventPersistence')}</h3>
        <div className="space-y-1">
          {(['off', 'summary', 'full'] as const).map((m) => (
            <label key={m} className="flex cursor-pointer items-center gap-2 text-[12px] text-ink-soft">
              <input
                type="radio"
                name="event-persistence"
                checked={eventPersistence === m}
                onChange={() => setEventPersistence(m)}
              />
              {t(`settings.general.eventPersistence.${m}`)}
            </label>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-ink-faint">{t('settings.general.eventPersistenceDesc')}</p>
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
  const t = useT('settings');
  const globalAgents = useWorkflowStore((s) => s.globalAgents);
  const globalMasterAgentId = useViewStore((s) => s.globalMasterAgentId);
  const setGlobalMasterAgent = useViewStore((s) => s.setGlobalMasterAgent);
  const globalMasterAgents = globalAgents.filter(
    (agent) => agent.protocol !== 'antigravity' && (agent.enabled !== false || agent.id === globalMasterAgentId),
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
      <section className="shrink-0 rounded border border-line p-3">
        <h3 className="mb-1 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>
          {t('settings.agent.globalMasterTitle')}
        </h3>
        <p className="mb-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          {t('settings.agent.globalMasterDesc')}
        </p>
        <select
          className="sm-input w-full"
          value={globalMasterAgentId ?? ''}
          onChange={(e) => setGlobalMasterAgent(e.target.value || null)}
          aria-label={t('settings.agent.globalMasterTitle')}
        >
          <option value="">{t('settings.agent.globalMasterUnset')}</option>
          {globalMasterAgents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name || agent.id} · {agent.model}
              {agent.enabled === false ? ` · ${t('settings.agent.globalMasterDisabled')}` : ''}
            </option>
          ))}
        </select>
        {globalAgents.length === 0 && (
          <p className="mt-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
            {t('settings.agent.globalMasterNoAgents')}
          </p>
        )}
      </section>
      {/* 全屏撑满，让 AgentPanel 内部 flex/min-h-0 正确建立滚动约束（智能体列表 + 编辑表单各自滚动） */}
      <div className="flex min-h-0 flex-1">
        <AgentPanel embedded />
      </div>
    </div>
  );
}

/* ---------------- 模型 ---------------- */
function ModelSection() {
  const t = useT('settings');
  const agents = useWorkflowStore((s) => s.agents);
  const globalAgents = useWorkflowStore((s) => s.globalAgents);
  const defaultAgentId = useWorkflowStore((s) => s.defaultAgentId);
  const setDefaultAgent = useWorkflowStore((s) => s.setDefaultAgent);
  const agentPool = useMemo(() => {
    const projectIds = new Set(agents.map((agent) => agent.id));
    return [...globalAgents.filter((agent) => agent.protocol !== 'antigravity' && !projectIds.has(agent.id)), ...agents.filter((agent) => agent.protocol !== 'antigravity')];
  }, [agents, globalAgents]);

  return (
    <div className="h-full space-y-4 overflow-y-auto">
      <div className="rounded border border-line p-3">
        <h3 className="mb-2 text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t('settings.model.presetLib')}</h3>
        <p className="mb-2 text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
          {t('settings.model.presetLibDesc')}
        </p>
        <div className="space-y-1.5">
          {providerPresets.map((p) => (
            <div key={p.id} className="rounded border border-line px-3 py-2">
              <span className="text-[13px] font-medium" style={{ color: 'var(--sm-ink)' }}>{t(p.labelKey)}</span>
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
          {agentPool.map((a) => (
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

/* ---------------- 路由表（类别 → 智能体） ---------------- */
function RoutingSection() {
  const t = useT('settings');
  return (
    <div className="h-full space-y-3 overflow-y-auto">
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
    <div className="h-full space-y-4 overflow-y-auto">
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
