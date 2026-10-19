import { useT } from '../i18n/useT';
import type { WorkerRunView } from '../projectControl/workerRunView';
import { workerStatusCls } from './OrchestratorPanelViewConfig';

interface OrchestratorPanelWorkerRunsViewProps {
  runs: readonly WorkerRunView[];
  canRecover: boolean;
  canCleanup: boolean;
  recoveryBusy: boolean;
  cleanupBusy: boolean;
  onRecover: (runId: string, decision: 'retry' | 'skip') => void;
  onCleanup: (runId: string, taskId: string, action: 'approve' | 'cleanup') => void;
}

export default function OrchestratorPanelWorkerRunsView({
  runs,
  canRecover,
  canCleanup,
  recoveryBusy,
  cleanupBusy,
  onRecover,
  onCleanup,
}: OrchestratorPanelWorkerRunsViewProps) {
  const t = useT('panels');
  if (runs.length === 0) return null;

  return (
    <section className="rounded border border-line px-2.5 py-2" data-testid="orchestrator-worker-runs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] font-medium" style={{ color: 'var(--sm-ink-soft)' }}>
          {t('orchestrator.workerRuns.title')}
        </span>
        <span className="text-[10px]" style={{ color: 'var(--sm-ink-faint)' }}>
          {runs.length}
        </span>
      </div>
      <div className="mt-1.5 space-y-2">
        {runs.map((run) => (
          <div key={run.runId} className="rounded border border-dashed border-line px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className={`text-[10.5px] font-medium ${workerStatusCls[run.status] ?? 'text-ink-faint'}`}>
                {t(`orchestrator.worker.status.${run.status}`)}
              </span>
              <span className="truncate font-mono text-[10px]" style={{ color: 'var(--sm-ink-faint)' }} title={run.runId}>
                {run.runId}
              </span>
            </div>
            {run.recovery && (
              <div className="mt-1 space-y-1">
                <p className="break-all text-[10.5px] text-warn">
                  {t('orchestrator.worker.recovery')}: {run.recovery.message}
                </p>
                {canRecover && run.recoveryActions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {run.recoveryActions.includes('retry') && (
                      <button
                        type="button"
                        data-testid={`orchestrator-worker-retry-${run.runId}`}
                        className="rounded border border-line px-1.5 py-0.5 text-[10px] text-accent disabled:opacity-50"
                        disabled={recoveryBusy}
                        onClick={() => onRecover(run.runId, 'retry')}
                      >
                        {t('orchestrator.worker.recovery.retryAction')}
                      </button>
                    )}
                    {run.recoveryActions.includes('skip') && (
                      <button
                        type="button"
                        data-testid={`orchestrator-worker-skip-${run.runId}`}
                        className="rounded border border-line px-1.5 py-0.5 text-[10px] text-warn disabled:opacity-50"
                        disabled={recoveryBusy}
                        onClick={() => onRecover(run.runId, 'skip')}
                      >
                        {t('orchestrator.worker.recovery.skipAction')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
            <ul className="mt-1 space-y-1">
              {run.tasks.map((task) => (
                <li key={task.taskId} className="rounded bg-paper px-1.5 py-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[10.5px]" style={{ color: 'var(--sm-ink)' }} title={task.taskId}>
                      {task.taskId}
                    </span>
                    <span className={`shrink-0 text-[10px] ${workerStatusCls[task.status] ?? 'text-ink-faint'}`}>
                      {t(`orchestrator.worker.task.${task.status}`)} · a{task.attempt}
                    </span>
                  </div>
                  {task.error && (
                    <p className="mt-0.5 break-all text-[10px] text-err">{task.error}</p>
                  )}
                  {task.worktreePath && (
                    <p className="mt-0.5 truncate font-mono text-[9.5px]" style={{ color: 'var(--sm-ink-faint)' }} title={task.worktreePath}>
                      {t('orchestrator.worker.worktree')}: {task.worktreePath}
                    </p>
                  )}
                  {task.evidenceIds.length > 0 && (
                    <p className="mt-0.5 break-all font-mono text-[9.5px]" style={{ color: 'var(--sm-ink-faint)' }}>
                      {t('orchestrator.worker.evidence')}: {task.evidenceIds.join(', ')}
                    </p>
                  )}
                  {task.evidence.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5 pl-2 text-[9.5px]" data-testid={`orchestrator-worker-evidence-${task.taskId}`}>
                      {task.evidence.map((record) => (
                        <li key={record.id} className="break-all" style={{ color: 'var(--sm-ink-faint)' }}>
                          <span className={record.status === 'passed' ? 'text-ok' : record.status === 'failed' ? 'text-err' : 'text-warn'}>
                            {record.kind} · {record.status}
                          </span>
                          {' · '}{record.summary}
                          {record.command ? ` · ${record.command}` : ''}
                          {record.exitCode !== undefined ? ` · ${t('orchestrator.worker.exitCode')}: ${record.exitCode}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                  {task.sideEffects.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5 pl-2 text-[9.5px]" data-testid={`orchestrator-worker-receipts-${task.taskId}`}>
                      {task.sideEffects.map((effect) => (
                        <li key={effect.idempotencyKey} className="break-all" style={{ color: 'var(--sm-ink-faint)' }}>
                          <span className={effect.status === 'receipt' ? 'text-ok' : effect.status === 'unknown' ? 'text-warn' : 'text-accent'}>
                            {t('orchestrator.worker.receipt')}: {effect.kind} · {effect.status}
                          </span>
                          {effect.receiptId ? ` · ${effect.receiptId}` : ''}
                          {effect.unknownReason ? ` · ${effect.unknownReason}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                  {task.cleanup ? (
                    task.cleanup.status === 'ready' ? (
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[9.5px]" data-testid={`orchestrator-worker-cleanup-${task.taskId}`}>
                        <span className="break-all text-ok">
                          {t('orchestrator.worker.cleanup')}: {task.cleanup.approvalStatus === 'approved' ? t('orchestrator.worker.cleanup.approved') : t('orchestrator.worker.cleanup.ready')} · {task.cleanup.acceptanceId}
                        </span>
                        {canCleanup && (
                          <button
                            type="button"
                            data-testid={`orchestrator-worker-cleanup-action-${task.taskId}`}
                            className="rounded border border-line px-1.5 py-0.5 text-[10px] text-accent disabled:opacity-50"
                            disabled={cleanupBusy}
                            onClick={() => {
                              const proposal = task.cleanup;
                              if (!proposal || proposal.status !== 'ready') return;
                              onCleanup(
                                proposal.runId,
                                task.taskId,
                                proposal.approvalStatus === 'approved' ? 'cleanup' : 'approve',
                              );
                            }}
                          >
                            {task.cleanup.approvalStatus === 'approved'
                              ? t('orchestrator.worker.cleanup.executeAction')
                              : t('orchestrator.worker.cleanup.approveAction')}
                          </button>
                        )}
                      </div>
                    ) : task.cleanup.status === 'cleaned' ? (
                      <p className="mt-0.5 break-all text-[9.5px] text-ok" data-testid={`orchestrator-worker-cleanup-${task.taskId}`}>
                        {t('orchestrator.worker.cleanup')}: {t('orchestrator.worker.cleanup.cleaned')} · {task.cleanup.receiptId}
                      </p>
                    ) : (
                      <p className="mt-0.5 break-all text-[9.5px] text-warn" data-testid={`orchestrator-worker-cleanup-${task.taskId}`}>
                        {t('orchestrator.worker.cleanup')}: {t('orchestrator.worker.cleanup.blocked')}: {task.cleanup.reason}
                      </p>
                    )
                  ) : task.status === 'succeeded' ? (
                    <p className="mt-0.5 break-all text-[9.5px] text-warn" data-testid={`orchestrator-worker-cleanup-${task.taskId}`}>
                      {t('orchestrator.worker.cleanup')}: {t('orchestrator.worker.cleanup.unavailable')}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
