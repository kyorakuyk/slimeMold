/**
 * InterventionModal — 实时接管面板（阶段 D）。
 *
 * 监听统一事件总线（runEvents）的 node.intervene 事件，展示待接管请求；
 * 用户在文本框提交结果（resolveIntervention）或取消（rejectIntervention），
 * 放行 executor 中挂起的节点 execute。
 *
 * 数据源：intervention.ts 单例注册表（getPendingInterventions）+ 事件增量刷新。
 */
import { useEffect, useRef, useState } from 'react';
import { X, Check, UserRound } from 'lucide-react';
import { getRunBus } from '../engine/runEvents';
import {
  getPendingInterventions,
  resolveIntervention,
  rejectIntervention,
  type InterveneRequest,
} from '../engine/intervention';
import { useT } from '../i18n/useT';

export default function InterventionModal() {
  const t = useT('panels');
  const [requests, setRequests] = useState<InterveneRequest[]>(() => getPendingInterventions());
  // 每个待接管请求的文本框内容（nodeId → value）
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  useEffect(() => {
    const bus = getRunBus();
    // 挂载即同步 + 事件增量刷新
    setRequests(getPendingInterventions());
    const off = bus.subscribe((e) => {
      if (e.kind === 'node.intervene') {
        setRequests(getPendingInterventions());
      }
    });
    return off;
  }, []);

  if (requests.length === 0) return null;

  const submit = (nodeId: string) => {
    const value = drafts[nodeId] ?? '';
    if (resolveIntervention(nodeId, value)) {
      setRequests(getPendingInterventions());
    }
  };

  const cancel = (nodeId: string) => {
    if (rejectIntervention(nodeId, '人工取消')) {
      setRequests(getPendingInterventions());
    }
  };

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/25"
        onClick={() => {
          // 点遮罩不取消（避免误放行）；仅提示聚焦
        }}
      />
      <div className="relative flex w-[520px] max-w-[92vw] flex-col rounded-xl border border-line bg-white shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <UserRound size={16} className="text-accent" />
          <h2 className="text-sm font-semibold text-ink">{t('intervention.title')}</h2>
          <span className="text-xs text-ink-faint">
            {requests.length > 1 ? t('intervention.count', { count: requests.length }) : ''}
          </span>
        </div>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto px-4 py-3">
          {requests.map((r) => (
            <div key={r.nodeId} className="space-y-2 rounded-lg border border-line bg-paper-soft p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-ink" title={r.nodeId}>
                  {r.label || r.nodeId}
                </span>
                <span className="shrink-0 rounded bg-paper px-1.5 py-0.5 text-[10px] font-mono text-ink-faint">
                  {r.typeId || ''}
                </span>
              </div>
              <p className="text-[12px] leading-relaxed text-ink-soft">{r.message}</p>
              <textarea
                className="sm-input min-h-[96px] w-full resize-y font-mono text-[12px]"
                placeholder={t('intervention.placeholder')}
                value={drafts[r.nodeId] ?? r.defaultResult ?? ''}
                onChange={(e) => {
                  setDrafts((d) => ({ ...d, [r.nodeId]: e.target.value }));
                }}
                autoFocus={requests.length === 1}
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  className="sm-btn text-ink-soft hover:border-err hover:text-err"
                  onClick={() => cancel(r.nodeId)}
                >
                  <X size={14} /> {t('intervention.cancel')}
                </button>
                <button
                  className="sm-btn hover:border-accent hover:text-accent"
                  onClick={() => submit(r.nodeId)}
                >
                  <Check size={14} /> {t('intervention.submit')}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
