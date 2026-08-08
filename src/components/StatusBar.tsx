import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Terminal, History, Variable, Eraser, Save, Power } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { stopWorkflow } from '../engine/executor';
import { useT } from '../i18n/useT';

type Tab = 'log' | 'history' | 'vars';

/** 底部可停靠面板（VS Code Panel 风）：默认终端/日志流，附带历史与变量选项卡 */
export default function StatusBar({
  open,
  height = 208,
  onToggle,
}: {
  open: boolean;
  height?: number;
  onToggle: () => void;
}) {
  const logs = useWorkflowStore((s) => s.logs);
  const running = useWorkflowStore((s) => s.running);
  const debugRun = useWorkflowStore((s) => s.debugRun);
  const clearLogs = useWorkflowStore((s) => s.clearLogs);
  const nodes = useWorkflowStore((s) => s.nodes);
  const variables = useWorkflowStore((s) => s.variables);
  const runHistory = useWorkflowStore((s) => s.runHistory);
  const lastAutosave = useWorkflowStore((s) => s.lastAutosave);
  const setAutosave = useWorkflowStore((s) => s.setAutosave);
  const [tab, setTab] = useState<Tab>('log');
  const logEndRef = useRef<HTMLDivElement>(null);
  const t = useT();

  const successCount = nodes.filter((n) => n.data.status === 'success').length;
  const errorCount = nodes.filter((n) => n.data.status === 'error').length;

  /** 强制复位：abort + 自增代次 + 清 running/进度/节点状态，让 UI 立刻恢复可启动状态 */
  const handleForceReset = useCallback(() => {
    stopWorkflow(); // abort signal + currentRunId++
    useWorkflowStore.getState().resetStatuses();
  }, []);

  // 画布变更后防抖标记「已自动保存」（persist 已同步落盘，这里只更新 UI 时间戳）
  useEffect(() => {
    const t = setTimeout(() => setAutosave(), 600);
    return () => clearTimeout(t);
  }, [nodes, variables, runHistory, setAutosave]);

  // 日志自动滚动到底
  useEffect(() => {
    if (open && tab === 'log') logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [logs, open, tab]);

  const levelColor: Record<string, string> = {
    error: 'var(--sm-err)',
    info: 'var(--sm-ink-soft)',
    warn: '#e3a008',
  };

  return (
    <footer className="sm-panel shrink-0" style={{ color: 'var(--sm-ink-soft)' }}>
      <div className="sm-panel-tabs">
        <button
          className="sm-panel-tab"
          data-active={tab === 'log'}
          onClick={() => setTab('log')}
        >
          <Terminal size={12} /> {t('tab.terminal')}
        </button>
        <button
          className="sm-panel-tab"
          data-active={tab === 'history'}
          onClick={() => setTab('history')}
        >
          <History size={12} /> {t('tab.history', { count: runHistory.length })}
        </button>
        <button
          className="sm-panel-tab"
          data-active={tab === 'vars'}
          onClick={() => setTab('vars')}
        >
          <Variable size={12} /> {t('tab.variables')}
        </button>

        <div className="flex flex-1 items-center justify-end gap-3 px-3 text-[11px]">
          <span
            className="flex items-center gap-1"
            style={{ color: 'var(--sm-ink-faint)' }}
            title={t('autosave.title')}
          >
            <Save size={12} />
            {lastAutosave
              ? t('autosave.at', { time: new Date(lastAutosave).toLocaleTimeString() })
              : t('autosave.done')}
          </span>
          {running ? (
            <span className="flex items-center gap-1.5" style={{ color: 'var(--sm-accent)' }}>
              <span className="sm-spinner" /> {t('running')}
            </span>
          ) : (
            <span>{t('ready')}</span>
          )}
          <span
            className="flex items-center gap-1 font-mono"
            style={{
              color:
                debugRun.current > debugRun.active && debugRun.active !== 0
                  ? 'var(--sm-err)'
                  : 'var(--sm-ink-faint)',
            }}
            title={
              debugRun.current > debugRun.active && debugRun.active !== 0
                ? t('gen.stale')
                : t('gen.normal')
            }
          >
            runId {debugRun.current}/{debugRun.active}
            {debugRun.current > debugRun.active && debugRun.active !== 0 ? t('gen.staleWarn') : ''}
          </span>
          {debugRun.current > debugRun.active && debugRun.active !== 0 && (
            <button
              className="flex cursor-pointer items-center gap-0.5 rounded px-1.5 text-[10px] transition-colors hover:bg-red-500/15"
              style={{ color: 'var(--sm-err)' }}
              title={t('forceReset.title')}
              onClick={handleForceReset}
            >
              <Power size={11} /> {t('forceReset.label')}
            </button>
          )}
          <span>
            {t('nodes.stat', { total: nodes.length, success: successCount, failed: errorCount })}
          </span>
        </div>
        <button
          className="flex cursor-pointer items-center gap-1 px-3 text-[11px] transition-colors hover:text-ink"
          style={{ color: 'var(--sm-ink-faint)' }}
          title={t('log.clear.title')}
          onClick={clearLogs}
        >
          <Eraser size={12} /> {t('log.clear.label')}
        </button>
        <button
          className="flex cursor-pointer items-center gap-1 border-l px-3 text-[11px] transition-colors hover:text-ink"
          style={{ color: 'var(--sm-ink-faint)', borderColor: 'var(--sm-line)' }}
          onClick={onToggle}
          title={t('panel.toggle')}
        >
          {open ? <ChevronDown size={13} /> : <ChevronDown size={13} style={{ transform: 'rotate(180deg)' }} />}
        </button>
      </div>

      {open && (
        <div className="overflow-y-auto px-3 py-2" style={{ height }}>
          {tab === 'log' && (
            logs.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--sm-ink-faint)' }}>
                {t('log.empty')}
              </p>
            ) : (
              <div>
                {logs.map((l, i) => (
                  <div key={i} className="sm-log-line">
                    <span className="sm-log-time">{l.time}</span>
                    <span
                      className="sm-log-msg"
                      style={{ color: levelColor[l.level] ?? 'var(--sm-ink-soft)' }}
                    >
                      {l.message}
                    </span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            )
          )}
          {tab === 'history' && (
            runHistory.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--sm-ink-faint)' }}>{t('history.empty')}</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {runHistory.map((r) => (
                  <li key={r.id} className="flex gap-3">
                    <span style={{ color: 'var(--sm-ink-faint)' }}>{r.startedAt}</span>
                    <span>{r.note}</span>
                    <span style={{ color: r.status === 'success' ? 'var(--sm-ok)' : 'var(--sm-err)' }}>
                      {r.status === 'success' ? t('history.ok') : t('history.fail')}
                    </span>
                    {r.cost ? (
                      <span style={{ color: 'var(--sm-ink-faint)' }} title={t('history.tokens.title')}>
                        · {r.cost.totalTokens.toLocaleString()} tok
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          )}
          {tab === 'vars' && (
            Object.keys(variables).length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--sm-ink-faint)' }}>
                {t('var.empty')}
              </p>
            ) : (
              <ul className="space-y-1 font-mono text-xs">
                {Object.entries(variables).map(([k, v]) => (
                  <li key={k}>
                    <span style={{ color: 'var(--sm-accent)' }}>{k}</span> ={' '}
                    <span>{typeof v === 'string' ? v : JSON.stringify(v)}</span>
                  </li>
                ))}
              </ul>
            )
          )}
        </div>
      )}
    </footer>
  );
}
