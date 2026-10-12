import { Ban, Loader2, PlugZap, Power, RefreshCw, Trash2, X } from 'lucide-react';
import { ollamaModels, protocolDefaults, type ProbeResult } from '../../agents/agentManager';
import type { AgentConfig, Protocol } from '../../types/agent';
import { useT } from '../../i18n/useT';
import { AntigravityCliField, ApiKeyField, CodexAuthField } from './ProviderFields';

export interface AgentEditorFormProps {
  editing?: AgentConfig;
  variant: 'center' | 'sidebar';
  remoteModels: string[];
  loadingModels: boolean;
  modelHint: string;
  probing: boolean;
  probe: ProbeResult | null;
  onPatch: (patch: Partial<AgentConfig>) => void;
  onProtocolChange: (protocol: Protocol) => void;
  onPullModels: () => void;
  onProbe: () => void;
  onKeySaved: (credentialKey: string, value: string) => void;
  onKeyCleared: () => void;
  onClose: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
}

export default function AgentEditorForm({
  editing,
  variant,
  remoteModels,
  loadingModels,
  modelHint,
  probing,
  probe,
  onPatch,
  onProtocolChange,
  onPullModels,
  onProbe,
  onKeySaved,
  onKeyCleared,
  onClose,
  onDelete,
  onToggleEnabled,
}: AgentEditorFormProps) {
  const t = useT('agents');

  return (
    (variant === 'center' || editing) && (
      <div className={
        variant === 'center'
          ? 'flex min-h-0 flex-1 flex-col'
          : 'absolute left-full top-0 z-20 flex h-full w-[360px] flex-col border-l border-line bg-paper-soft shadow-[0_8px_24px_-8px_rgba(0,0,0,0.25)] animate-in slide-in-from-left duration-200'
      }>
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h3 className="text-[13px] font-semibold text-ink">
            {editing ? t('agent.edit.title') : t('agent.edit.none')}
          </h3>
          {variant === 'sidebar' && editing && (
            <button
              type="button"
              className="text-ink-faint hover:text-ink"
              title={t('agent.edit.close')}
              onClick={onClose}
            >
              <X size={14} />
            </button>
          )}
        </div>
        {editing ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-4 py-4">
              <div>
                <label className="mb-1 block text-xs text-ink-soft">{t('agent.field.name')}</label>
                <input
                  className="sm-input"
                  value={editing.name}
                  onChange={(e) => onPatch({ name: e.target.value })}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-ink-soft">{t('agent.field.protocol')}</label>
                <select
                  className="sm-input cursor-pointer"
                  value={editing.protocol}
                  onChange={(e) => onProtocolChange(e.target.value as Protocol)}
                >
                  {(Object.keys(protocolDefaults) as Protocol[]).map((protocol) => (
                    <option key={protocol} value={protocol}>
                      {protocolDefaults[protocol].label}
                    </option>
                  ))}
                </select>
              </div>
              {editing.protocol === 'codex' ? (
                <div>
                  <label className="mb-1 block text-xs text-ink-soft">{t('agent.field.baseUrl')}</label>
                  <div className="rounded border border-line bg-paper-soft px-3 py-2 text-[11px] text-ink-faint">
                    {t('agent.codex.cliEndpoint')}
                  </div>
                </div>
              ) : editing.protocol === 'antigravity' ? (
                <div>
                  <label className="mb-1 block text-xs text-ink-soft">{t('agent.field.baseUrl')}</label>
                  <div className="rounded border border-line bg-paper-soft px-3 py-2 text-[11px] text-ink-faint">
                    {t('agent.antigravity.cliEndpoint')}
                  </div>
                </div>
              ) : (
                <div>
                  <label className="mb-1 block text-xs text-ink-soft">{t('agent.field.baseUrl')}</label>
                  <input
                    className="sm-input"
                    value={editing.baseUrl}
                    onChange={(e) => onPatch({ baseUrl: e.target.value })}
                  />
                </div>
              )}
              {editing.protocol === 'ollama' ? (
                <div className="rounded border border-line bg-paper-soft px-3 py-2.5">
                  <p className="text-[11px] text-ink-faint">
                    {t('agent.ollamaHint')}
                  </p>
                </div>
              ) : editing.protocol === 'codex' ? (
                <CodexAuthField />
              ) : editing.protocol === 'antigravity' ? (
                <AntigravityCliField
                  mode={editing.runtimeMode}
                  profile={editing.runtimeProfile}
                  cliPath={editing.runtimeCliPath}
                  onChange={onPatch}
                />
              ) : (
                <ApiKeyField
                  credentialKey={editing.credentialKey}
                  agentId={editing.id}
                  onSaved={onKeySaved}
                  onCleared={onKeyCleared}
                />
              )}
              <div>
                <label className="mb-1 block text-xs text-ink-soft">
                  {t('agent.field.model')}
                  {editing.protocol === 'antigravity'
                    ? t('agent.field.modelAntigravity')
                    : editing.protocol === 'ollama'
                      ? t('agent.field.modelLocal')
                      : editing.protocol === 'codex'
                        ? t('agent.field.modelCodex')
                        : t('agent.field.modelApi')}
                </label>
                {editing.protocol === 'antigravity' ? (
                  <div className="rounded border border-line bg-paper-soft px-3 py-2.5">
                    <p className="text-[11px] text-ink-faint">{t('agent.antigravity.modelHint')}</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="flex gap-1.5">
                      <select
                        className="sm-input cursor-pointer flex-1"
                        value={
                          ollamaModels.some((model) => model.id === editing.model) ||
                          remoteModels.includes(editing.model)
                            ? editing.model
                            : ''
                        }
                        onChange={(e) => onPatch({ model: e.target.value })}
                      >
                        <option value="">{t('agent.model.select')}</option>
                        {ollamaModels.map((model) => (
                          <option key={model.id} value={model.id} title={model.note}>
                            {model.id}
                          </option>
                        ))}
                        {remoteModels.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                      {editing.protocol !== 'codex' && (
                        <button
                          type="button"
                          className="sm-btn shrink-0 px-2"
                          title={
                            editing.protocol === 'ollama'
                              ? t('agent.model.pullLocal')
                              : t('agent.model.pullApi')
                          }
                          disabled={loadingModels}
                          onClick={onPullModels}
                        >
                          <RefreshCw size={13} className={loadingModels ? 'animate-spin' : ''} />
                        </button>
                      )}
                      <button
                        type="button"
                        className="sm-btn shrink-0 px-2.5"
                        title={editing.protocol === 'codex' ? t('agent.model.probeCodex') : t('agent.model.probe')}
                        disabled={probing || (editing.protocol !== 'codex' && !editing.model)}
                        onClick={onProbe}
                      >
                        {probing ? <Loader2 size={13} className="animate-spin" /> : <PlugZap size={13} />}
                      </button>
                    </div>
                    {ollamaModels.find((model) => model.id === editing.model)?.note && (
                      <p className="text-[11px] text-ink-faint">
                        {ollamaModels.find((model) => model.id === editing.model)?.note}
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
                          <span className="ml-1 rounded bg-white/10 px-1 py-0.5 text-[10px]">{t('agent.probe.proxied')}</span>
                        )}
                      </div>
                    )}
                    {editing.protocol !== 'ollama' && editing.protocol !== 'codex' && remoteModels.length === 0 && !loadingModels && !editing.credentialKey && (
                      <p className="text-[11px] text-ink-faint">
                        {t('agent.model.tipSaveFirst', { url: editing.baseUrl })}
                      </p>
                    )}
                    {editing.protocol !== 'ollama' && editing.protocol !== 'codex' && remoteModels.length === 0 && !loadingModels && editing.credentialKey && !modelHint && (
                      <button
                        type="button"
                        className="text-[11px] text-accent hover:underline"
                        onClick={onPullModels}
                      >
                        {t('agent.model.clickToPull', { url: editing.baseUrl })}
                      </button>
                    )}
                    <input
                      className="sm-input mt-1"
                      value={editing.model}
                      placeholder={
                        editing.protocol === 'ollama'
                          ? t('agent.model.placeholderLocal')
                          : editing.protocol === 'codex'
                            ? t('agent.model.placeholderCodex')
                            : t('agent.model.placeholderApi')
                      }
                      onChange={(e) => onPatch({ model: e.target.value })}
                    />
                  </div>
                )}
              </div>
              <div>
                <label className="mb-1 block text-xs text-ink-soft">
                  {t('agent.field.temperature', { temp: editing.temperature ?? 0.7 })}
                </label>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.1}
                  className="w-full cursor-pointer accent-accent"
                  value={editing.temperature ?? 0.7}
                  onChange={(e) => onPatch({ temperature: Number(e.target.value) })}
                />
              </div>
              {editing.protocol !== 'antigravity' && (
                <details className="rounded border border-line bg-paper-soft px-3 py-2.5">
                  <summary className="cursor-pointer text-[12px] text-ink-soft">
                    {t('agent.advanced.title')}
                  </summary>
                  <p className="mt-2 text-[11px] text-ink-faint">
                    {t('agent.advanced.desc')}
                  </p>
                  <input
                    className="sm-input mt-2"
                    value={editing.proxyUrl ?? ''}
                    placeholder={t('agent.advanced.placeholder')}
                    onChange={(e) => onPatch({ proxyUrl: e.target.value.trim() || undefined })}
                  />
                </details>
              )}
            </div>
            <div className="shrink-0 border-t border-line bg-paper-soft px-4 py-3">
              <div className="flex gap-2">
                <button
                  className={`sm-btn flex-1 justify-center ${editing.enabled === false ? 'text-ok hover:border-ok' : 'text-ink-soft hover:border-line'}`}
                  onClick={onToggleEnabled}
                  title={editing.enabled === false ? t('agent.enableTitle') : t('agent.disableTitle')}
                >
                  {editing.enabled === false ? (
                    <>
                      <Power size={13} className="rotate-180" /> {t('agent.enable')}
                    </>
                  ) : (
                    <>
                      <Ban size={13} /> {t('agent.disable')}
                    </>
                  )}
                </button>
                <button
                  className="sm-btn text-err hover:border-err hover:text-err"
                  onClick={onDelete}
                >
                  <Trash2 size={13} /> {t('agent.delete')}
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-[13px] text-ink-faint">{t('agent.empty')}</p>
          </div>
        )}
      </div>
    )
  );
}
