import { useState } from 'react';
import { ChevronUp, ChevronDown, Eraser } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';

/** 底部状态栏：执行状态 + 日志摘要，可展开日志抽屉 */
export default function StatusBar() {
  const logs = useWorkflowStore((s) => s.logs);
  const running = useWorkflowStore((s) => s.running);
  const clearLogs = useWorkflowStore((s) => s.clearLogs);
  const nodes = useWorkflowStore((s) => s.nodes);
  const [open, setOpen] = useState(false);

  const last = logs[logs.length - 1];
  const successCount = nodes.filter((n) => n.data.status === 'success').length;
  const errorCount = nodes.filter((n) => n.data.status === 'error').length;

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-30 border-t border-line bg-white">
      {open && (
        <div className="max-h-48 overflow-y-auto border-b border-line px-3 py-2">
          {logs.length === 0 ? (
            <p className="text-xs text-ink-faint">暂无日志</p>
          ) : (
            <ul className="space-y-1">
              {logs.map((l, i) => (
                <li key={i} className="flex gap-2 text-xs leading-relaxed">
                  <span className="shrink-0 text-ink-faint">{l.time}</span>
                  <span className={l.level === 'error' ? 'text-err' : 'text-ink-soft'}>
                    {l.message}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="flex h-7 items-center gap-3 px-3">
        {running ? (
          <span className="flex items-center gap-1.5 text-xs text-accent">
            <span className="sm-spinner" /> 执行中…
          </span>
        ) : (
          <span className="text-xs text-ink-faint">就绪</span>
        )}
        <span className="text-xs text-ink-faint">
          节点 {nodes.length} · 成功 <span className="text-ok">{successCount}</span> · 失败{' '}
          <span className={errorCount > 0 ? 'text-err' : ''}>{errorCount}</span>
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-faint">
          {last ? (
            <span className={last.level === 'error' ? 'text-err' : ''}>{last.message}</span>
          ) : null}
        </span>
        <button
          className="cursor-pointer text-ink-faint transition-colors hover:text-ink"
          title="清空日志"
          onClick={clearLogs}
        >
          <Eraser size={13} />
        </button>
        <button
          className="flex cursor-pointer items-center gap-1 text-xs text-ink-faint transition-colors hover:text-ink"
          onClick={() => setOpen(!open)}
        >
          日志 ({logs.length}) {open ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
      </div>
    </footer>
  );
}
