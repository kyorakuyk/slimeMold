import { Loader2, PlugZap, RefreshCw } from 'lucide-react';
import { ollamaModels, type ProbeResult } from '../../agents/agentManager';
import type { AgentConfig } from '../../types/agent';
import { useT } from '../../i18n/useT';

export interface AgentModelFieldsProps {
  editing: AgentConfig;
  remoteModels: string[];
  loadingModels: boolean;
  modelHint: string;
  probing: boolean;
  probe: ProbeResult | null;
  onPatch: (patch: Partial<AgentConfig>) => void;
  onPullModels: () => void;
  onProbe: () => void;
}

/**
 * 模型区：模型选择/拉取/探测、提示与探测结果、手填模型，随后是温度与高级（代理）折叠区。
 * 从 AgentEditorForm 抽出，JSX 与分支顺序保持原样（temperature、details 仍在模型区之后）。
 */
export default function AgentModelFields({
  editing,
  remoteModels,
  loadingModels,
  modelHint,
  probing,
  probe,
  onPatch,
  onPullModels,
  onProbe,
}: AgentModelFieldsProps) {
  const t = useT('agents');
  const selectedOllamaNoteKey = ollamaModels.find((model) => model.id === editing.model)?.noteKey;

  return (
    <>
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
                  <option key={model.id} value={model.id} title={t(model.noteKey)}>
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
            {selectedOllamaNoteKey && (
              <p className="text-[11px] text-ink-faint">
                {t(selectedOllamaNoteKey)}
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
    </>
  );
}
