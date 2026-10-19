import { AlertCircle, Plus, Target, Workflow } from 'lucide-react';
import type { AgentConfig } from '../types/agent';
import type { Orchestration } from '../types/orchestration';
import { useT } from '../i18n/useT';
import { formatDateTime } from '../i18n/dateTime';
import { statusCls } from './OrchestratorPanelViewConfig';

interface OrchestratorPanelListViewProps {
  goal: string;
  agentId: string;
  readonly: boolean;
  agents: readonly AgentConfig[];
  orchestrations: readonly Orchestration[];
  error: string | null;
  onGoalChange: (value: string) => void;
  onAgentChange: (value: string) => void;
  onReadonlyChange: (value: boolean) => void;
  onGenerate: () => void;
  onSelect: (id: string) => void;
}

export default function OrchestratorPanelListView({
  goal,
  agentId,
  readonly,
  agents,
  orchestrations,
  error,
  onGoalChange,
  onAgentChange,
  onReadonlyChange,
  onGenerate,
  onSelect,
}: OrchestratorPanelListViewProps) {
  const t = useT('panels');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-1.5 border-b border-line px-3 py-2.5">
        <label className="flex items-center gap-1.5 text-[12px] font-medium" style={{ color: 'var(--sm-ink-soft)' }}>
          <Target size={13} /> {t('orchestrator.goalLabel')}
        </label>
        <textarea
          className="h-16 w-full resize-none rounded border border-line bg-transparent px-2 py-1.5 text-[12.5px] outline-none focus:border-accent"
          style={{ color: 'var(--sm-ink)' }}
          placeholder={t('orchestrator.goalPlaceholder')}
          value={goal}
          onChange={(event) => onGoalChange(event.target.value)}
        />
        <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
          <select
            className="max-w-[130px] rounded border border-line bg-transparent px-1.5 py-1 outline-none"
            style={{ color: 'var(--sm-ink-soft)' }}
            value={agentId}
            onChange={(event) => onAgentChange(event.target.value)}
            title={t('orchestrator.agent')}
          >
            <option value="">{t('orchestrator.agentAuto')}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id} className="bg-[var(--sm-bg)]">
                {agent.name}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1" title={t('orchestrator.readonlyHint')}>
            <input
              type="checkbox"
              className="cursor-pointer"
              checked={readonly}
              onChange={(event) => onReadonlyChange(event.target.checked)}
            />
            <span className="text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
              {t('orchestrator.readonly')}
            </span>
          </label>
        </div>
        <button
          className="sm-btn w-full justify-center hover:border-accent hover:text-accent"
          onClick={onGenerate}
          disabled={!goal.trim()}
        >
          <Plus size={13} /> {t('orchestrator.generate')}
        </button>
        {error && (
          <p className="flex items-start gap-1 break-all text-[11px] leading-relaxed text-err">
            <AlertCircle size={13} className="mt-0.5 shrink-0" /> {error}
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {orchestrations.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <Workflow size={22} className="opacity-40" />
            <p className="text-[12.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
              {t('orchestrator.empty')}
            </p>
            <p className="max-w-64 text-[11px] leading-relaxed" style={{ color: 'var(--sm-ink-faint)' }}>
              {t('orchestrator.emptyHint')}
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {orchestrations.map((orchestration) => (
              <li key={orchestration.id}>
                <button
                  className="w-full rounded border border-line px-2.5 py-2 text-left transition-colors hover:border-accent/50"
                  onClick={() => onSelect(orchestration.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[11.5px] font-medium ${statusCls[orchestration.status]}`}>
                      {t(`orchestrator.status.${orchestration.status}`)}
                    </span>
                    <span className="shrink-0 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                      {t('orchestrator.stageCount', { count: orchestration.draft?.stages.length ?? 0 })}
                    </span>
                  </div>
                  <div className="mt-0.5 line-clamp-2 break-all text-[12px]" style={{ color: 'var(--sm-ink)' }}>
                    {orchestration.goal}
                  </div>
                  <div className="mt-0.5 text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
                    {formatDateTime(orchestration.createdAt)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
