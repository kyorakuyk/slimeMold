import { Ban, Power, Trash2, X } from 'lucide-react';
import { type ProbeResult } from '../../agents/agentManager';
import type { AgentConfig, Protocol } from '../../types/agent';
import { useT } from '../../i18n/useT';
import AgentConnectionFields from './AgentConnectionFields';
import AgentModelFields from './AgentModelFields';

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
              {/* 连接与凭据字段（AgentConnectionFields） */}
              <AgentConnectionFields
                editing={editing}
                onPatch={onPatch}
                onProtocolChange={onProtocolChange}
                onKeySaved={onKeySaved}
                onKeyCleared={onKeyCleared}
              />
              {/* 模型 / 温度 / 高级（AgentModelFields） */}
              <AgentModelFields
                editing={editing}
                remoteModels={remoteModels}
                loadingModels={loadingModels}
                modelHint={modelHint}
                probing={probing}
                probe={probe}
                onPatch={onPatch}
                onPullModels={onPullModels}
                onProbe={onProbe}
              />
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
