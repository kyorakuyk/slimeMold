import { useState } from 'react';
import { Coins } from 'lucide-react';
import type { NodeUsageStat } from '../../types';

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

function Row({
  label,
  value,
  tone,
  indent,
}: {
  label: string;
  value: string;
  tone?: 'in' | 'out' | 'hit' | 'muted';
  indent?: boolean;
}) {
  const toneCls =
    tone === 'in'
      ? 'text-[#3b82f6]'
      : tone === 'out'
        ? 'text-[#a855f7]'
        : tone === 'hit'
          ? 'text-ok'
          : 'text-ink-faint';
  return (
    <div className={`flex items-baseline justify-between gap-4 ${indent ? 'pl-2.5' : ''}`}>
      <span className={`truncate text-[10px] ${indent ? 'text-ink-faint' : 'text-ink-soft'}`}>
        {label}
      </span>
      <span className={`shrink-0 font-mono text-[10px] tabular-nums ${toneCls}`}>{value}</span>
    </div>
  );
}

/**
 * 节点底部的 token 用量徽标：常态只占一行，鼠标悬停时弹出该节点单独的用量明细。
 * 与左侧总览面板互不影响——总览看整体，这里看单个节点。
 */
export default function NodeUsageBadge({ usage }: { usage: NodeUsageStat }) {
  const [open, setOpen] = useState(false);

  const cacheHitRate =
    usage.promptTokens > 0
      ? Math.round((usage.cachedPromptTokens / usage.promptTokens) * 100)
      : 0;
  const avgMs = usage.calls > 0 ? Math.round(usage.llmDurationMs / usage.calls) : 0;

  return (
    <div
      className="sm-node-usage"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <span className="sm-node-usage-bar">
        <Coins size={10} className="shrink-0 opacity-70" />
        <span className="font-mono tabular-nums">{fmt(usage.totalTokens)}</span>
        <span className="opacity-60">tokens</span>
        {usage.calls > 1 && <span className="opacity-60">· {usage.calls} 次</span>}
        {usage.failedCalls > 0 && (
          <span className="ml-auto text-err">{usage.failedCalls} 失败</span>
        )}
      </span>

      {open && (
        <div className="sm-node-usage-pop nowheel" onClick={(e) => e.stopPropagation()}>
          <div className="mb-1.5 flex items-baseline justify-between gap-4 border-b border-line pb-1.5">
            <span className="text-[10px] font-semibold text-ink">本节点用量</span>
            <span className="font-mono text-[11px] tabular-nums text-ink">
              {usage.totalTokens.toLocaleString()}
            </span>
          </div>

          <div className="space-y-0.5">
            <Row label="输入" value={usage.promptTokens.toLocaleString()} tone="in" />
            {usage.cachedPromptTokens > 0 && (
              <Row
                label="缓存命中"
                value={usage.cachedPromptTokens.toLocaleString()}
                tone="hit"
                indent
              />
            )}
            {usage.writtenPromptTokens > 0 && (
              <Row
                label="缓存写入"
                value={usage.writtenPromptTokens.toLocaleString()}
                tone="muted"
                indent
              />
            )}
            <Row label="输出" value={usage.completionTokens.toLocaleString()} tone="out" />
            {usage.reasoningTokens > 0 && (
              <Row
                label="思考过程"
                value={usage.reasoningTokens.toLocaleString()}
                tone="muted"
                indent
              />
            )}
            {usage.replyTokens > 0 && usage.reasoningTokens > 0 && (
              <Row label="回复内容" value={usage.replyTokens.toLocaleString()} tone="muted" indent />
            )}
          </div>

          {usage.cachedPromptTokens > 0 && (
            <div className="mt-1.5 border-t border-line pt-1.5">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[10px] text-ink-soft">缓存命中率</span>
                <span className="font-mono text-[10px] tabular-nums text-ok">{cacheHitRate}%</span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-paper-soft">
                <div
                  className="h-full rounded-full bg-ok transition-[width]"
                  style={{ width: `${cacheHitRate}%` }}
                />
              </div>
            </div>
          )}

          <div className="mt-1.5 space-y-0.5 border-t border-line pt-1.5">
            <Row label="调用次数" value={`${usage.calls} 次`} tone="muted" />
            <Row label="平均耗时" value={`${avgMs}ms`} tone="muted" />
            {usage.failedCalls > 0 && (
              <Row label="失败次数" value={`${usage.failedCalls} 次`} tone="muted" />
            )}
          </div>

          {usage.models.length > 0 && (
            <div className="mt-1.5 border-t border-line pt-1.5">
              <div className="mb-0.5 text-[10px] text-ink-soft">模型</div>
              {usage.models.map((m) => (
                <div key={m} className="truncate font-mono text-[10px] text-ink-faint" title={m}>
                  {m}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
