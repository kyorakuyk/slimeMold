import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  Circle,
  Cpu,
  KeyRound,
  Loader2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { AgentConfig } from '../types';
import { useWorkflowStore } from '../store/workflowStore';
import { useViewStore } from '../store/viewStore';
import { useT } from '../i18n/useT';

interface MasterAgentPageProps {
  onBack: () => void;
  onOpenAdvanced: () => void;
}

interface AgentCandidate {
  agent: AgentConfig;
  scope: 'project' | 'global';
}

const protocolLabel: Record<AgentConfig['protocol'], string> = {
  openai: 'OpenAI compatible',
  anthropic: 'Anthropic',
  ollama: 'Ollama local',
  codex: 'OpenAI Codex (ChatGPT plan)',
  antigravity: 'Antigravity CLI (interactive)',
};

function mergeCandidates(globalAgents: AgentConfig[], projectAgents: AgentConfig[]): AgentCandidate[] {
  const usableGlobalAgents = globalAgents.filter((agent) => agent.protocol !== 'antigravity');
  const usableProjectAgents = projectAgents.filter((agent) => agent.protocol !== 'antigravity');
  const projectIds = new Set(usableProjectAgents.map((agent) => agent.id));
  return [
    ...usableGlobalAgents
      .filter((agent) => !projectIds.has(agent.id))
      .map((agent) => ({ agent, scope: 'global' as const })),
    ...usableProjectAgents.map((agent) => ({ agent, scope: 'project' as const })),
  ];
}

export default function MasterAgentPage({ onBack, onOpenAdvanced }: MasterAgentPageProps) {
  const t = useT('beginner');
  const projectName = useWorkflowStore((state) => state.projectName);
  const projectControl = useWorkflowStore((state) => state.projectControl);
  const projectAgents = useWorkflowStore((state) => state.agents);
  const globalAgents = useWorkflowStore((state) => state.globalAgents);
  const defaultAgentId = useWorkflowStore((state) => state.defaultAgentId);
  const globalMasterAgentId = useViewStore((state) => state.globalMasterAgentId);

  const candidates = useMemo(
    () => mergeCandidates(globalAgents, projectAgents),
    [globalAgents, projectAgents],
  );
  const currentMasterId = projectControl.masterAgentId ?? '';
  const inheritedMasterId = globalMasterAgentId ?? defaultAgentId ?? '';
  const [selectedId, setSelectedId] = useState(currentMasterId);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSelectedId(currentMasterId);
    setSaved(false);
  }, [currentMasterId]);

  const selectedOverride = candidates.find((candidate) => candidate.agent.id === selectedId)?.agent;
  const inherited = candidates.find((candidate) => candidate.agent.id === inheritedMasterId)?.agent;
  const selected = selectedOverride ?? inherited;
  const selectedIsEnabled = !selected || selected.enabled !== false;
  const changed = selectedId !== currentMasterId;

  const handleSave = () => {
    if (!changed || !selectedIsEnabled) return;
    const state = useWorkflowStore.getState();
    state.setProjectControl({
      ...state.projectControl,
      masterAgentId: selectedId || null,
    });
    setSaved(true);
  };

  return (
    <div className="sm-beginner-shell">
      <main className="sm-beginner-main sm-beginner-master-agent-main">
        <div className="sm-beginner-master-agent-topline">
          <button type="button" className="sm-beginner-back-link" onClick={onBack}>
            <ArrowLeft size={14} /> {t('masterAgent.back')}
          </button>
          <button type="button" className="sm-beginner-text-button" onClick={onOpenAdvanced}>
            {t('masterAgent.openAdvanced')} <ArrowRight size={14} />
          </button>
        </div>

        <section className="sm-beginner-master-agent-heading" aria-labelledby="master-agent-title">
          <div className="sm-beginner-master-agent-heading-icon"><Bot size={23} /></div>
          <div>
            <p className="sm-beginner-eyebrow">{t('masterAgent.eyebrow')}</p>
            <h1 id="master-agent-title">{t('masterAgent.title')}</h1>
            <p>{projectName ? `${projectName} · ${t('masterAgent.subtitle')}` : t('masterAgent.subtitle')}</p>
          </div>
        </section>

        <div className="sm-beginner-master-agent-layout">
          <section className="sm-beginner-master-agent-list-card">
            <div className="sm-beginner-master-agent-card-heading">
              <div>
                <p className="sm-beginner-eyebrow">{t('masterAgent.candidatesEyebrow')}</p>
                <h2>{t('masterAgent.candidates')}</h2>
              </div>
              <span>{candidates.length}</span>
            </div>
            <div className="sm-beginner-master-agent-options" role="radiogroup" aria-label={t('masterAgent.candidates')}>
              <button
                type="button"
                role="radio"
                aria-checked={selectedId === ''}
                className={`sm-beginner-master-agent-option${selectedId === '' ? ' is-selected' : ''}`}
                data-testid="master-agent-option-default"
                onClick={() => { setSelectedId(''); setSaved(false); }}
              >
                <span className="sm-beginner-master-agent-option-icon"><Circle size={17} /></span>
                <span className="sm-beginner-master-agent-option-copy">
                  <strong>{t('masterAgent.followGlobal')}</strong>
                  <small>
                    {globalMasterAgentId
                      ? t('masterAgent.followGlobalSet', { id: globalMasterAgentId })
                      : defaultAgentId
                        ? t('masterAgent.followGlobalFallback', { id: defaultAgentId })
                        : t('masterAgent.followGlobalUnset')}
                  </small>
                </span>
                {selectedId === '' && <Check size={17} className="sm-beginner-master-agent-check" />}
              </button>

              {candidates.map(({ agent, scope }) => {
                const isSelected = selectedId === agent.id;
                const disabled = agent.enabled === false;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    aria-disabled={disabled}
                    disabled={disabled}
                    data-testid={`master-agent-option-${agent.id}`}
                    className={`sm-beginner-master-agent-option${isSelected ? ' is-selected' : ''}${disabled ? ' is-disabled' : ''}`}
                    onClick={() => { setSelectedId(agent.id); setSaved(false); }}
                  >
                    <span className="sm-beginner-master-agent-option-icon"><Cpu size={17} /></span>
                    <span className="sm-beginner-master-agent-option-copy">
                      <strong>{agent.name || agent.id}</strong>
                      <small>{protocolLabel[agent.protocol]} · {agent.model}</small>
                      <small>{scope === 'project' ? t('masterAgent.scopeProject') : t('masterAgent.scopeGlobal')}{disabled ? ` · ${t('masterAgent.disabled')}` : ''}</small>
                    </span>
                    <span className={`sm-beginner-master-agent-status${disabled ? ' is-disabled' : ''}`} title={disabled ? t('masterAgent.disabled') : t('masterAgent.enabled')}>
                      {disabled ? <Circle size={10} /> : <span />}
                    </span>
                    {isSelected && <Check size={17} className="sm-beginner-master-agent-check" />}
                  </button>
                );
              })}
            </div>
            {candidates.length === 0 && (
              <div className="sm-beginner-master-agent-empty">
                <KeyRound size={20} />
                <strong>{t('masterAgent.noAgents')}</strong>
                <span>{t('masterAgent.noAgentsHint')}</span>
              </div>
            )}
          </section>

          <aside className="sm-beginner-master-agent-summary">
            <section className="sm-beginner-master-agent-summary-card">
              <div className="sm-beginner-master-agent-card-heading">
                <div>
                  <p className="sm-beginner-eyebrow">{t('masterAgent.selectedEyebrow')}</p>
                  <h2>{t('masterAgent.selected')}</h2>
                </div>
                <Sparkles size={17} />
              </div>
              {selected ? (
                <div className="sm-beginner-master-agent-selected">
                  <div className="sm-beginner-master-agent-selected-icon"><Bot size={20} /></div>
                  {selectedId === '' ? (
                    <>
                      <strong>{t('masterAgent.followGlobal')}</strong>
                      <span>
                        {globalMasterAgentId
                          ? t('masterAgent.followingGlobal', { id: globalMasterAgentId })
                          : defaultAgentId
                            ? t('masterAgent.followingProjectDefault', { id: defaultAgentId })
                            : t('masterAgent.followGlobalUnset')}
                      </span>
                      <span>{selected.name || selected.id} · {selected.model}</span>
                    </>
                  ) : (
                    <>
                      <strong>{selected.name || selected.id}</strong>
                      <span>{protocolLabel[selected.protocol]}</span>
                      <span>{selected.model}</span>
                    </>
                  )}
                </div>
              ) : (
                <div className="sm-beginner-master-agent-selected is-default">
                  <div className="sm-beginner-master-agent-selected-icon"><Circle size={20} /></div>
                  <strong>{t('masterAgent.followGlobal')}</strong>
                  <span>{t('masterAgent.followGlobalUnset')}</span>
                </div>
              )}
              <button
                type="button"
                data-testid="master-agent-save"
                className="sm-beginner-primary-button sm-beginner-master-agent-save"
                onClick={handleSave}
                disabled={!changed || !selectedIsEnabled}
              >
                {saved ? <Check size={16} /> : <ShieldCheck size={16} />}
                {saved ? t('masterAgent.saved') : t('masterAgent.save')}
              </button>
            </section>

            <section className="sm-beginner-master-agent-note">
              <ShieldCheck size={17} />
              <div>
                <strong>{t('masterAgent.safetyTitle')}</strong>
                <span>{t('masterAgent.safetyBody')}</span>
              </div>
            </section>

            <section className="sm-beginner-master-agent-config-note">
              <Loader2 size={15} />
              <span>{t('masterAgent.configureHint')}</span>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
