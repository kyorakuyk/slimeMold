import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { FlowNode, NodeStatus } from '../../types';
import { useRegistryStore } from '../../store/registryStore';

function StatusDot({ status, error }: { status: NodeStatus; error?: string }) {
  if (status === 'running') return <span className="sm-spinner" />;
  const cls: Record<NodeStatus, string> = {
    idle: 'bg-[#d0d0d0]',
    running: '',
    success: 'bg-ok',
    error: 'bg-err',
  };
  return (
    <span
      title={error}
      className={`inline-block h-2 w-2 rounded-full transition-colors ${cls[status]}`}
    />
  );
}

function summarize(value: unknown, max = 90): string {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const BaseNode = memo(({ data, selected }: NodeProps<FlowNode>) => {
  const def = useRegistryStore((s) => s.defs[data.typeId]);
  const missing = !def || def.missing;
  const inputs = def?.inputs ?? [];
  const outputs = def?.outputs ?? [];
  const rows = Math.max(inputs.length, outputs.length);

  // 参数摘要（最多两条）
  const paramSummary = (def?.params ?? [])
    .slice(0, 2)
    .map((p) => {
      const v = data.params[p.key];
      return v === undefined || v === '' ? null : `${p.label}: ${summarize(v, 26)}`;
    })
    .filter(Boolean) as string[];

  const previewValue =
    data.typeId === 'output.preview' && data.outputs
      ? summarize(data.outputs.value, 140)
      : null;

  return (
    <div
      className={`w-56 rounded-md border bg-white transition-[border-color,box-shadow] ${
        selected
          ? 'border-accent-soft shadow-[0_0_0_2px_rgba(91,141,239,0.15)]'
          : missing
            ? 'border-err/50'
            : 'border-line hover:border-[#cfcfcf]'
      }`}
    >
      {/* 标题栏 */}
      <div className="flex items-center justify-between rounded-t-md border-b border-line bg-paper-soft px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold text-ink">
            {data.label}
          </span>
          {def?.pluginId && (
            <span className="shrink-0 rounded bg-paper-deep px-1 text-[10px] text-ink-faint">
              插件
            </span>
          )}
        </div>
        <StatusDot status={data.status} error={data.error} />
      </div>

      {/* 端口区 */}
      {rows > 0 && (
        <div className="px-0 py-1.5">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="relative flex h-6 items-center justify-between px-3">
              {inputs[i] ? (
                <>
                  <Handle
                    id={inputs[i].id}
                    type="target"
                    position={Position.Left}
                    style={{ left: -5 }}
                  />
                  <span className="text-xs text-ink-soft">{inputs[i].label}</span>
                </>
              ) : (
                <span />
              )}
              {outputs[i] ? (
                <>
                  <span className="text-xs text-ink-soft">{outputs[i].label}</span>
                  <Handle
                    id={outputs[i].id}
                    type="source"
                    position={Position.Right}
                    style={{ right: -5 }}
                  />
                </>
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>
      )}

      {/* 参数摘要 / 预览 / 错误 */}
      {(paramSummary.length > 0 || previewValue || data.error || missing) && (
        <div className="space-y-1 border-t border-line px-3 py-2">
          {missing && (
            <p className="text-[11px] leading-relaxed text-err">
              节点类型缺失：{data.typeId}
            </p>
          )}
          {paramSummary.map((s, i) => (
            <p key={i} className="truncate text-[11px] leading-relaxed text-ink-faint">
              {s}
            </p>
          ))}
          {previewValue !== null && (
            <p className="whitespace-pre-wrap break-all rounded bg-paper-soft px-2 py-1.5 text-[11px] leading-relaxed text-ink-soft">
              {previewValue || '（空）'}
            </p>
          )}
          {data.error && (
            <p className="break-all text-[11px] leading-relaxed text-err">{data.error}</p>
          )}
        </div>
      )}
    </div>
  );
});

export default BaseNode;
