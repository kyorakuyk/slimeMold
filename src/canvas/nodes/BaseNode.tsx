import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Boxes, Copy, RotateCcw, StepForward, Ungroup } from 'lucide-react';
import type { FlowNode, NodeStatus } from '../../types';
import { useRegistryStore } from '../../store/registryStore';
import { useWorkflowStore } from '../../store/workflowStore';
import { useViewStore } from '../../store/viewStore';
import { retryNode, runToNode } from '../../engine/executor';
import { resolvePorts, SUBGRAPH_REF_TYPE } from '../../engine/subgraph';

function StatusDot({ status, error }: { status: NodeStatus; error?: string }) {
  if (status === 'running') return <span className="sm-spinner" />;
  const cls: Record<NodeStatus, string> = {
    idle: 'bg-[#d0d0d0]',
    running: '',
    success: 'bg-ok',
    error: 'bg-err',
    cached: 'bg-accent',
    skipped: 'bg-[#9aa0a6]',
  };
  const title =
    status === 'cached'
      ? '结果来自缓存（未重新执行）'
      : status === 'skipped'
        ? '因分支条件未命中而跳过（未执行）'
        : error;
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

/** 端口类型徽标配色（与连线校验语义一致） */
const portBadgeCls: Record<string, string> = {
  any: 'bg-[#9aa0a6]',
  text: 'bg-[#3b82f6]',
  number: 'bg-[#16a34a]',
  boolean: 'bg-[#d97706]',
  list: 'bg-[#a855f7]',
  json: 'bg-[#db2777]',
  image: 'bg-[#0891b2]',
};
function PortBadge({ type }: { type?: string }) {
  const t = type ?? 'any';
  return (
    <span
      title={`端口类型：${t}`}
      className={`ml-1.5 inline-block h-1.5 w-1.5 rounded-full ${portBadgeCls[t] ?? portBadgeCls.any}`}
    />
  );
}

const BaseNode = memo(({ data, selected, id }: NodeProps<FlowNode>) => {
  const def = useRegistryStore((s) => s.defs[data.typeId]);
  const running = useWorkflowStore((s) => s.running);
  const isSubgraph = data.typeId === SUBGRAPH_REF_TYPE;
  // 子图节点的端口由其引用的子图定义动态决定，普通节点取自类型定义
  const subgraph = useWorkflowStore((s) =>
    isSubgraph ? s.subgraphs[String(data.params?.subgraphId ?? '')] : undefined,
  );
  const allDefs = useRegistryStore((s) => s.defs);
  const allSubgraphs = useWorkflowStore((s) => s.subgraphs);
  const unpack = useWorkflowStore((s) => s.unpackSubgraphNode);
  const setFocusedSubgraph = useViewStore((s) => s.setFocusedSubgraph);

  const missing = isSubgraph ? !subgraph : !def || def.missing;
  const resolved = resolvePorts(data.typeId, data.params, allDefs, allSubgraphs);
  const inputs = resolved.inputs;
  const outputs = resolved.outputs;
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
  const isTextOutput = data.typeId === 'output.text';
  const previewValue =
    data.outputs && Object.keys(data.outputs).length > 0
      ? summarize(
          Object.values(data.outputs)[0],
          isTextOutput ? 2000 : data.typeId === 'output.preview' ? 140 : 90,
        )
      : null;
  // 图片预览节点：直接渲染缩略图
  const previewImage =
    data.typeId === 'image.preview' && data.outputs?.image
      ? String(data.outputs.image)
      : null;

  return (
    <div
      className={`sm-node ${selected ? 'selected' : ''}`}
      data-cat={def?.category}
      data-status={data.status ?? 'idle'}
    >
      {/* 分类配色标题栏 */}
      <div className="sm-node-header" title={def?.description}>
        <span className="sm-node-dot" />
        <span className="sm-node-title">{data.label}</span>
        {def?.pluginId && (
          <span className="shrink-0 rounded bg-white/15 px-1 text-[9px]">插件</span>
        )}
        <span className="sm-node-cat">{def?.category}</span>
        {data.durationMs != null &&
          (data.status === 'success' ||
            data.status === 'error' ||
            data.status === 'cached') && (
            <span
              className="shrink-0 rounded bg-black/10 px-1 text-[9px] tabular-nums text-white/90"
              title={
                data.status === 'cached'
                  ? '缓存命中（未实际执行）'
                  : `耗时 ${data.durationMs}ms`
              }
            >
              {data.status === 'cached' ? '缓存' : `${data.durationMs}ms`}
            </span>
          )}
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
                    data-porttype={inputs[i].type ?? 'any'}
                  />
                  <span className="text-xs text-ink-soft">
                    {inputs[i].label}
                    <PortBadge type={inputs[i].type} />
                  </span>
                </>
              ) : (
                <span />
              )}
              {outputs[i] ? (
                <>
                  <span className="text-xs text-ink-soft">
                    {outputs[i].label}
                    <PortBadge type={outputs[i].type} />
                  </span>
                  <Handle
                    id={outputs[i].id}
                    type="source"
                    position={Position.Right}
                    data-porttype={outputs[i].type ?? 'any'}
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
      {(paramSummary.length > 0 || previewValue || data.error || missing || isSubgraph) && (
        <div className="space-y-1 border-t border-line px-3 py-2">
          {missing && (
            <p className="text-[11px] leading-relaxed text-err">
              {isSubgraph ? '子图定义已丢失，请重新创建或删除该节点' : `节点类型缺失：${data.typeId}`}
            </p>
          )}
          {isSubgraph && subgraph && (
            <p className="flex items-center gap-1 text-[11px] leading-relaxed text-ink-faint">
              <Boxes size={11} />
              内含 {subgraph.nodes.length} 个步骤 · {inputs.length} 入 / {outputs.length} 出
            </p>
          )}
          {paramSummary.map((s, i) => (
            <p key={i} className="truncate text-[11px] leading-relaxed text-ink-faint">
              {s}
            </p>
          ))}
          {previewImage !== null && (
            <img
              src={previewImage}
              alt="preview"
              className="max-h-40 w-full rounded border border-line object-contain"
            />
          )}
          {previewValue !== null && previewImage === null && (
            <div>
              <p
                className={`whitespace-pre-wrap break-all rounded bg-paper-soft px-2 py-1.5 text-[11px] leading-relaxed text-ink-soft ${
                  isTextOutput ? 'max-h-72 overflow-auto' : ''
                }`}
              >
                {previewValue || '（空）'}
              </p>
              {isTextOutput && previewValue && (
                <button
                  className="mt-1 flex w-full items-center justify-center gap-1 rounded py-1 text-[11px] text-accent transition-colors hover:bg-paper-soft"
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigator.clipboard?.writeText(previewValue);
                  }}
                  title="复制文本内容"
                >
                  <Copy size={11} /> 复制文本
                </button>
              )}
            </div>
          )}
          {data.error && (
            <p className="break-all text-[11px] leading-relaxed text-err">{data.error}</p>
          )}
        </div>
      )}

      {isSubgraph && subgraph && (
        <div className="flex border-t border-line">
          <button
            className="flex flex-1 items-center justify-center gap-1 py-1.5 text-[11px] text-accent transition-colors hover:bg-paper-soft disabled:cursor-not-allowed disabled:text-ink-faint"
            onClick={(e) => {
              e.stopPropagation();
              setFocusedSubgraph(String(data.params?.subgraphId ?? ''));
            }}
            title="进入子图内部进行编辑"
          >
            <Boxes size={11} /> 进入子图
          </button>
          <span className="my-1 w-px bg-line" />
          <button
            className="flex flex-1 items-center justify-center gap-1 py-1.5 text-[11px] text-accent transition-colors hover:bg-paper-soft disabled:cursor-not-allowed disabled:text-ink-faint"
            onClick={(e) => {
              e.stopPropagation();
              if (!running) unpack(id);
            }}
            disabled={running}
            title="把子图内部的节点还原到画布上（解组）"
          >
            <Ungroup size={11} /> 展开子图
          </button>
        </div>
      )}

      {(data.status === 'error' || data.status === 'success' || data.status === 'cached') && (
        <div className="flex border-t border-line">
          <button
            className="flex flex-1 items-center justify-center gap-1 py-1.5 text-[11px] text-accent transition-colors hover:bg-paper-soft disabled:cursor-not-allowed disabled:text-ink-faint"
            onClick={(e) => {
              e.stopPropagation();
              if (!running) void retryNode(id);
            }}
            disabled={running}
            title="重新执行此节点及其下游（复用上游已有输出，并清除该节点缓存）"
          >
            <RotateCcw size={11} /> 重跑子图
          </button>
          <span className="my-1 w-px bg-line" />
          <button
            className="flex flex-1 items-center justify-center gap-1 py-1.5 text-[11px] text-accent transition-colors hover:bg-paper-soft disabled:cursor-not-allowed disabled:text-ink-faint"
            onClick={(e) => {
              e.stopPropagation();
              if (!running) void runToNode(id);
            }}
            disabled={running}
            title="只重跑到此节点为止，其下游不再执行（标记 skipped）"
          >
            <StepForward size={11} /> 重跑到此节点
          </button>
        </div>
      )}
    </div>
  );
});

export default BaseNode;
