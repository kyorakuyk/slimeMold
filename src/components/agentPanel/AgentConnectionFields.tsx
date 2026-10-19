import { protocolDefaults } from '../../agents/agentManager';
import type { AgentConfig, Protocol } from '../../types/agent';
import { useT } from '../../i18n/useT';
import { AntigravityCliField, ApiKeyField, CodexAuthField } from './ProviderFields';

export interface AgentConnectionFieldsProps {
  editing: AgentConfig;
  onPatch: (patch: Partial<AgentConfig>) => void;
  onProtocolChange: (protocol: Protocol) => void;
  onKeySaved: (credentialKey: string, value: string) => void;
  onKeyCleared: () => void;
}

/**
 * 连接与凭据字段：协议选择、Base URL（按协议分支）、凭据输入（Codex/Antigravity/Ollama/API Key）。
 * 从 AgentEditorForm 抽出，JSX 与分支顺序保持原样。
 */
export default function AgentConnectionFields({
  editing,
  onPatch,
  onProtocolChange,
  onKeySaved,
  onKeyCleared,
}: AgentConnectionFieldsProps) {
  const t = useT('agents');

  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-ink-soft">{t('agent.field.protocol')}</label>
        <select
          className="sm-input cursor-pointer"
          value={editing.protocol}
          onChange={(e) => onProtocolChange(e.target.value as Protocol)}
        >
          {(Object.keys(protocolDefaults) as Protocol[]).map((protocol) => (
            <option key={protocol} value={protocol}>
              {t(protocolDefaults[protocol].labelKey)}
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
    </>
  );
}
