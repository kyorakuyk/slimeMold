import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { RotateCcw } from 'lucide-react';
import type { FlowNode, NodeStatus } from '../../types';
import { useRegistryStore } from '../../store/registryStore';
import { useWorkflowStore } from '../../store/workflowStore';
import { retryNode } from '../../engine/executor';

function StatusDot({ status, error }: { status: NodeStatus; error?: string }) {
  if (status === 'running') return <span className="sm-spinner" />;
  const cls: Record<NodeStatus, string> = {
    idle: 'bg-[#d0d0d0]',
    running: '',
    success: 'bg-ok',
    error: 'bg-err',
    cached: 'bg-accent',
  };
  const title =
    status === 'cached' ? '结果来自缓存（未重新执行）' : error;
  return (
    <span
      title={title}
      className={`inline-block h-2 w-2 rounded-full transition-colors ${cls[status]}`}
    />
  );
}

function summarize(value: unknown, max = 90): string {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const BaseNode = memo(({ data, selected, id }: NodeProps<FlowNode>) => {
  const def = useRegistryStore((s) => s.defs[data.typeId]);
  const running = useWorkflowStore((s) => s.running);
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

  // 任意节点在执行中/完成后都展示首个输出端口的实时预览（流式输出可见）
  const previewValue =
    data.outputs && Object.keys(data.outputs).length > 0
      ? summarize(Object.values(data.outputs)[0], data.typeId === 'output.preview' ? 140 : 90)
      : null;

  return (
    <div
      className={`sm-node ${selected ? 'selected' : ''}`}
      data-cat={def?.category}
    >
      {/* 分类配色标题栏 */}
      <div className="sm-node-header">
        <span className="sm-node-dot" />
        <span className="sm-node-title">{data.label}</span>
        {def?.pluginId && (
          <span className="shrink-0 rounded bg-white/15 px-1 text-[9px]">插件</span>
        )}
        <span className="sm-node-cat">{def?.category}</span>
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

      {(data.status === 'error' || data.status === 'success' || data.status === 'cached') && (
        <button
          className="flex w-full items-center justify-center gap-1 border-t border-line py-1.5 text-[11px] text-accent transition-colors hover:bg-paper-soft disabled:cursor-not-allowed disabled:text-ink-faint"
          onClick={(e) => {
            e.stopPropagation();
            if (!running) void retryNode(id);
          }}
          disabled={running}
          title="重新执行此节点及其下游（复用上游已有输出，并清除该节点缓存）"
        >
          <RotateCcw size={11} /> 重新执行此节点
        </button>
      )}
    </div>
  );
});

export default BaseNode;
