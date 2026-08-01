import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Terminal, History, Variable, Eraser } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';

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
  const clearLogs = useWorkflowStore((s) => s.clearLogs);
  const nodes = useWorkflowStore((s) => s.nodes);
  const variables = useWorkflowStore((s) => s.variables);
  const runHistory = useWorkflowStore((s) => s.runHistory);
  const [tab, setTab] = useState<Tab>('log');
  const logEndRef = useRef<HTMLDivElement>(null);

  const successCount = nodes.filter((n) => n.data.status === 'success').length;
  const errorCount = nodes.filter((n) => n.data.status === 'error').length;

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
          <Terminal size={12} /> 终端
        </button>
        <button
          className="sm-panel-tab"
          data-active={tab === 'history'}
          onClick={() => setTab('history')}
        >
          <History size={12} /> 历史 ({runHistory.length})
        </button>
        <button
          className="sm-panel-tab"
          data-active={tab === 'vars'}
          onClick={() => setTab('vars')}
        >
          <Variable size={12} /> 变量
        </button>

        <div className="flex flex-1 items-center justify-end gap-3 px-3 text-[11px]">
          {running ? (
            <span className="flex items-center gap-1.5" style={{ color: 'var(--sm-accent)' }}>
              <span className="sm-spinner" /> 执行中…
            </span>
          ) : (
            <span>就绪</span>
          )}
          <span>
            节点 {nodes.length} · 成功{' '}
            <span style={{ color: 'var(--sm-ok)' }}>{successCount}</span> · 失败{' '}
            <span style={{ color: errorCount > 0 ? 'var(--sm-err)' : undefined }}>{errorCount}</span>
          </span>
        </div>
        <button
          className="flex cursor-pointer items-center gap-1 px-3 text-[11px] transition-colors hover:text-ink"
          style={{ color: 'var(--sm-ink-faint)' }}
          title="清空日志"
          onClick={clearLogs}
        >
          <Eraser size={12} /> 清空
        </button>
        <button
          className="flex cursor-pointer items-center gap-1 border-l px-3 text-[11px] transition-colors hover:text-ink"
          style={{ color: 'var(--sm-ink-faint)', borderColor: 'var(--sm-line)' }}
          onClick={onToggle}
          title="折叠/展开面板"
        >
          {open ? <ChevronDown size={13} /> : <ChevronDown size={13} style={{ transform: 'rotate(180deg)' }} />}
        </button>
      </div>

      {open && (
        <div className="overflow-y-auto px-3 py-2" style={{ height }}>
          {tab === 'log' && (
            logs.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--sm-ink-faint)' }}>
                暂无日志，运行工作流后将在此实时显示。
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
              <p className="text-xs" style={{ color: 'var(--sm-ink-faint)' }}>暂无运行历史。</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {runHistory.map((r) => (
                  <li key={r.id} className="flex gap-3">
                    <span style={{ color: 'var(--sm-ink-faint)' }}>{r.startedAt}</span>
                    <span>{r.note}</span>
                    <span style={{ color: r.ok ? 'var(--sm-ok)' : 'var(--sm-err)' }}>
                      {r.ok ? '成功' : '失败'}
                    </span>
                    {r.cost ? (
                      <span style={{ color: 'var(--sm-ink-faint)' }} title="本次运行总 Token 用量">
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
                暂无全局变量，可在「变量」面板中添加。
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
