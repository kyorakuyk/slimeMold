import { Zap, Cpu, ArrowUpRight } from 'lucide-react';
import { useWorkflowStore } from '../store/workflowStore';
import { useT } from '../i18n/useT';

function num(n: number): string {
  return n.toLocaleString();
}

function Line({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: 'blue' | 'green' | 'red' | 'yellow' | 'purple' | 'cyan';
}) {
  const colorMap: Record<string, { dot: string; text: string }> = {
    blue: { dot: 'bg-blue-500', text: 'text-blue-500' },
    green: { dot: 'bg-emerald-500', text: 'text-emerald-500' },
    red: { dot: 'bg-rose-500', text: 'text-rose-500' },
    yellow: { dot: 'bg-amber-400', text: 'text-amber-400' },
    purple: { dot: 'bg-violet-500', text: 'text-violet-500' },
    cyan: { dot: 'bg-cyan-400', text: 'text-cyan-400' },
  };
  const c = colorMap[color];
  return (
    <div className="flex items-center justify-between py-1 text-xs">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-sm ${c.dot}`} />
        <span className="text-ink-soft">{label}</span>
      </div>
      <span className={`tabular-nums font-medium ${c.text}`}>{num(value)}</span>
    </div>
  );
}

function Section({
  title,
  titleColor,
  icon: Icon,
  children,
}: {
  title: string;
  titleColor: string;
  icon?: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line bg-paper-deep p-3">
      <div className="mb-2 flex items-center gap-2">
        {Icon ? <Icon size={13} className={titleColor} /> : <span className={`h-2.5 w-2.5 rounded-sm ${titleColor.replace('text-', 'bg-')}`} />}
        <span className="text-[13px] font-medium text-ink">{title}</span>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

export default function TokenUsagePanel({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const runHistory = useWorkflowStore((s) => s.runHistory);
  const last = runHistory[0] ?? null;
  const cost = last?.cost;
  const t = useT('panels');

  const body = (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {!cost ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-faint">
          <Cpu size={32} />
          <p className="text-xs">{t('token.empty')}</p>
          <p className="text-center text-[11px]">{t('token.emptyHint')}</p>
        </div>
      ) : (
        <>
          {/* 总计 */}
          <div className="rounded-lg border border-line bg-paper-deep p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-ink-soft">{t('token.detail')}</span>
              <span className="text-[10px] text-ink-faint">{new Date(last.startedAt).toLocaleString()}</span>
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-bold tabular-nums text-ink">{num(cost.totalTokens)}</span>
              <span className="text-xs text-ink-faint">tokens</span>
            </div>
          </div>

          {/* 输入 */}
          <Section title={t('token.input')} titleColor="text-blue-500">
            <Line label={t('token.inputLabel')} value={cost.totalPromptTokens} color="blue" />
            <Line label={t('token.cacheHit')} value={cost.cache.hitTokens} color="green" />
            <Line label={t('token.cacheMiss')} value={cost.cache.missTokens} color="red" />
            <Line label={t('token.cacheWrite')} value={cost.cache.writeTokens} color="yellow" />
          </Section>

          {/* 输出 */}
          <Section title={t('token.output')} titleColor="text-violet-500">
            <Line label={t('token.outputLabel')} value={cost.totalCompletionTokens} color="purple" />
            <Line label={t('token.reasoning')} value={cost.output.reasoningTokens} color="cyan" />
            <Line label={t('token.reply')} value={cost.output.replyTokens} color="purple" />
          </Section>

          {/* 缓存命中率 */}
          <div className="rounded-lg border border-line bg-paper-deep p-3">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Zap size={13} className="text-amber-400" />
                <span className="text-[13px] font-medium text-ink">{t('token.hitRate')}</span>
              </div>
              <span className="text-sm font-semibold tabular-nums text-emerald-500">
                {cost.totalPromptTokens > 0
                  ? `${((cost.cache.hitTokens / cost.totalPromptTokens) * 100).toFixed(1)}%`
                  : '0.0%'}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-line">
              <div
                className="h-full rounded-full bg-emerald-500"
                style={{
                  width:
                    cost.totalPromptTokens > 0
                      ? `${Math.min(100, (cost.cache.hitTokens / cost.totalPromptTokens) * 100)}%`
                      : '0%',
                }}
              />
            </div>
            <div className="mt-2 flex items-center gap-3 text-[10px] text-ink-faint">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-emerald-500" /> {t('token.legendHit')}
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-amber-400" /> {t('token.legendWrite')}
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-rose-500" /> {t('token.legendMiss')}
              </span>
            </div>
          </div>

          {/* 按模型拆解 */}
          {Object.keys(cost.byModel).length > 0 && (
            <div className="rounded-lg border border-line bg-paper-deep p-3">
              <div className="mb-2 flex items-center gap-2">
                <ArrowUpRight size={13} className="text-accent" />
                <span className="text-[13px] font-medium text-ink">{t('token.byModel')}</span>
              </div>
              <div className="space-y-1.5">
                {Object.entries(cost.byModel).map(([model, m]) => (
                  <div key={model} className="flex items-center justify-between text-xs">
                    <span className="truncate text-ink-soft" title={model}>{model}</span>
                    <span className="tabular-nums text-ink-faint">
                      {num(m.promptTokens)} + {num(m.completionTokens)} tok · {m.calls} 次
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  if (embedded) {
    return <div className="flex min-h-0 flex-1 flex-col">{body}</div>;
  }
  return body;
}
