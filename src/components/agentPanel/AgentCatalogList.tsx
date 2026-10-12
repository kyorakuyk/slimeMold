import { Plus, Pin } from 'lucide-react';
import {
  findProviderPreset,
  protocolDefaults,
  providerPresets,
  type ProbeResult,
} from '../../agents/agentManager';
import type { AgentConfig, ApiVault, Protocol } from '../../types/agent';
import { useT } from '../../i18n/useT';

type AgentFilter = 'all' | 'project' | 'global';

export interface AgentCatalogListProps {
  variant: 'center' | 'sidebar';
  editingId: string | null;
  filter: AgentFilter;
  pool: AgentConfig[];
  filteredPool: AgentConfig[];
  projectSet: Set<string>;
  globalSet: Set<string>;
  defaultAgentId: string | null;
  probeStates: Record<string, ProbeResult>;
  vaults: ApiVault[];
  belongsToGlobal: (id: string | null) => boolean;
  onFilterChange: (filter: AgentFilter) => void;
  onSelectAgent: (id: string) => void;
  onSetDefaultAgent: (id: string | null) => void;
  onToggleGlobal: (id: string) => void;
  onAddPreset: (providerId: string) => void;
  onAddAgent: (protocol: Protocol) => void;
  onImportFromVault: (vaultId: string) => void;
}

export default function AgentCatalogList({
  variant,
  editingId,
  filter,
  pool,
  filteredPool,
  projectSet,
  globalSet,
  defaultAgentId,
  probeStates,
  vaults,
  belongsToGlobal,
  onFilterChange,
  onSelectAgent,
  onSetDefaultAgent,
  onToggleGlobal,
  onAddPreset,
  onAddAgent,
  onImportFromVault,
}: AgentCatalogListProps) {
  const t = useT('agents');

  return (
    <div className={`flex h-full min-h-0 shrink-0 flex-col border-r border-line bg-paper-soft ${variant === 'sidebar' ? 'w-full' : 'w-56'}`}>
      <div className="border-b border-line px-3 py-2.5">
        <h2 className="text-[13px] font-semibold text-ink">{t('agent.title')}</h2>
        <p className="mt-0.5 text-[11px] text-ink-faint">{t('agent.subtitle')}</p>
      </div>
      {/* 列表筛选：全部 / 项目智能体 / 全局智能体（默认全部） */}
      <div className="border-b border-line px-3 py-2">
        <select
          className="sm-input cursor-pointer text-[12px]"
          value={filter}
          onChange={(event) => onFilterChange(event.target.value as AgentFilter)}
          title={t('agent.filter.title')}
        >
          <option value="all">{t('agent.filter.all', { count: pool.length })}</option>
          <option value="project">{t('agent.filter.project', { count: pool.filter((agent) => projectSet.has(agent.id)).length })}</option>
          <option value="global">{t('agent.filter.global', { count: pool.filter((agent) => globalSet.has(agent.id) && !projectSet.has(agent.id)).length })}</option>
        </select>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {filteredPool.map((agent) => {
          const dot = probeStates[agent.id];
          const isWorkerOnly = agent.protocol === 'antigravity';
          const isDefault = !isWorkerOnly && defaultAgentId === agent.id;
          const isGlobal = belongsToGlobal(agent.id);
          const disabled = agent.enabled === false;
          return (
            <li
              key={agent.id}
              onClick={() => onSelectAgent(agent.id)}
              className={`mb-1 cursor-pointer rounded border px-2.5 py-2 transition-colors ${
                agent.id === editingId
                  ? 'border-line bg-paper-soft'
                  : 'border-transparent hover:bg-white'
              } ${disabled ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center justify-between gap-1">
                <p className="truncate text-[13px] text-ink">
                  {agent.name}
                  {disabled && (
                    <span className="ml-1 text-[10px] text-ink-faint">{t('agent.disabledSuffix')}</span>
                  )}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                  {dot && (
                    <span
                      title={
                        dot.ok
                          ? t('agent.list.dotOk')
                          : dot.stage === 'auth'
                            ? t('agent.list.dotAuth')
                            : t('agent.list.dotOther')
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
                    disabled={isWorkerOnly}
                    title={isWorkerOnly ? t('agent.antigravity.workerOnly') : isDefault ? t('agent.list.default') : t('agent.list.setDefault')}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (isWorkerOnly) return;
                      onSetDefaultAgent(isDefault ? null : agent.id);
                    }}
                    className={`text-[12px] leading-none ${
                      isDefault ? 'text-amber-400' : 'text-ink-faint hover:text-amber-400'
                    }`}
                  >
                    {isDefault ? '★' : '☆'}
                  </button>
                  <button
                    type="button"
                    title={isGlobal ? t('agent.pin.global') : t('agent.pin.project')}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleGlobal(agent.id);
                    }}
                    className={`flex h-5 w-5 items-center justify-center rounded transition-colors ${
                      isGlobal
                        ? 'bg-paper-deep text-ink'
                        : 'text-ink-faint hover:bg-paper-soft hover:text-ink'
                    }`}
                  >
                    <Pin size={12} className="rotate-45 opacity-60" />
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-ink-faint">
                {findProviderPreset(agent.providerId)?.name ?? protocolDefaults[agent.protocol].label}
                {' · '}
                {agent.model}
              </p>
            </li>
          );
        })}
        {filteredPool.length === 0 && (
          <li className="px-1 py-2 text-[11px] text-ink-faint">
            {t('agent.list.empty', {
              filter: t(`agent.filter.${filter}`, { count: 0 }),
            })}
          </li>
        )}
      </ul>
      <div className="relative z-10 shrink-0 space-y-1.5 border-t border-line bg-paper-soft p-2">
        <select
          className="sm-input cursor-pointer text-[12px]"
          value=""
          onChange={(event) => onAddPreset(event.target.value)}
        >
          <option value="">{t('agent.list.newByPreset')}</option>
          {providerPresets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
              {preset.id === 'custom' ? t('agent.list.customProxy') : ''}
            </option>
          ))}
        </select>
        <div className="flex gap-1">
          {(Object.keys(protocolDefaults) as Protocol[]).map((protocol) => (
            <button
              key={protocol}
              className="sm-btn flex-1 justify-center px-1 text-[11px]"
              onClick={() => onAddAgent(protocol)}
              title={t('agent.list.addTitle', { label: protocolDefaults[protocol].label })}
            >
              <Plus size={12} /> {protocolDefaults[protocol].label.slice(0, 3)}
            </button>
          ))}
        </div>
        <select
          className="sm-input mt-1"
          value=""
          onChange={(event) => {
            onImportFromVault(event.target.value);
            event.currentTarget.value = '';
          }}
          title={t('agent.list.importTitle')}
        >
          <option value="">{t('agent.list.importOption')}</option>
          {vaults.map((vault) => (
            <option key={vault.id} value={vault.id}>
              {vault.label}（{vault.vendor} · {vault.protocol}）
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
