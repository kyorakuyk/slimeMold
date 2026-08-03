import { memo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Boxes, Copy, RotateCcw, StepForward, Ungroup, Check, AlertTriangle, Loader2, ChevronDown, ChevronRight, ArrowRightLeft, VolumeX, Play, type LucideIcon } from 'lucide-react';
import type { FlowNode, NodeStatus } from '../../types';
import { useRegistryStore } from '../../store/registryStore';
import { useWorkflowStore } from '../../store/workflowStore';
import { useViewStore } from '../../store/viewStore';
import { retryNode, runToNode, runSingleNode } from '../../engine/executor';
import { resolvePorts, SUBGRAPH_REF_TYPE } from '../../engine/subgraph';
import NodeUsageBadge from './NodeUsageBadge';

function StatusDot({ status, error }: { status: NodeStatus; error?: string }) {
  if (status === 'running') return <span className="sm-spinner" />;
  const cls: Record<NodeStatus, string> = {
    idle: 'bg-[#d0d0d0]',
    running: '',
    success: 'bg-ok',
    error: 'bg-err',
    cached: 'bg-accent',
    skipped: 'bg-[#9aa0a6]',
    bypassed: 'bg-[#c9a227]',
    muted: 'bg-[#8a8a8a]',
  };
  const title =
    status === 'cached'
      ? '结果来自缓存（未实际执行）'
      : status === 'skipped'
        ? '因分支条件未命中而跳过（未执行）'
        : status === 'bypassed'
          ? 'bypass：跳过执行，输入已透传到输出'
          : status === 'muted'
            ? 'mute：已静音，不执行'
            : error;
  return (
    <span
      title={title}
      className={`inline-block h-2 w-2 rounded-full transition-colors ${cls[status]}`}
    />
  );
}

/** 标题栏右侧的状态图标：运行=旋转、成功=对勾、错误=三角、其他=圆点 */
function StatusGlyph({ status }: { status: NodeStatus }) {
  if (status === 'running')
    return <Loader2 size={12} className="animate-spin text-white/90" />;
  if (status === 'success')
    return <Check size={12} className="text-white/90" strokeWidth={3} />;
  if (status === 'error')
    return <AlertTriangle size={12} className="text-white/90" />;
  if (status === 'bypassed')
    return <ArrowRightLeft size={12} className="text-white/90" />;
  if (status === 'muted')
    return <VolumeX size={12} className="text-white/90" />;
  return <StatusDot status={status} />;
}

/** 分类 → 标题栏左侧小图标 */
const catIconMap: Record<string, LucideIcon> = {
  输入: Boxes,
  智能体: Boxes,
  文本: Copy,
  工具: Boxes,
  输出: Boxes,
  流程: RotateCcw,
};

function summarize(value: unknown, max = 90): string {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 端口类型徽标配色（与连线校验语义一致） */
const portBadgeCls: Record<string, string> = {
  any: 'bg-[#9aa0a6] text-[#9aa0a6]',
  text: 'bg-[#3b82f6] text-[#3b82f6]',
  number: 'bg-[#16a34a] text-[#16a34a]',
  boolean: 'bg-[#d97706] text-[#d97706]',
  list: 'bg-[#a855f7] text-[#a855f7]',
  json: 'bg-[#db2777] text-[#db2777]',
  image: 'bg-[#0891b2] text-[#0891b2]',
};
function PortBadge({ type }: { type?: string }) {
  const t = type ?? 'any';
  return (
    <span
      title={`端口类型：${t}`}
      className={`sm-port-badge ${portBadgeCls[t] ?? portBadgeCls.any}`}
    />
  );
}

const BaseNode = memo(({ data, selected, id }: NodeProps<FlowNode>) => {
  const def = useRegistryStore((s) => s.defs[data.typeId]);
  const running = useWorkflowStore((s) => s.running);
  // 折叠模式（默认）：仅显示标题栏与端口区，不渲染下方文本框（预览/参数/错误），避免撑大节点边界。双击节点切换展开/收起。
  const [expanded, setExpanded] = useState(false);
  const isSubgraph = data.typeId === SUBGRAPH_REF_TYPE;
  // 子图节点的端口由其引用的子图定义动态决定，普通节点取自类型定义
  const subgraph = useWorkflowStore((s) =>
    isSubgraph ? s.subgraphs[String(data.params?.subgraphId ?? '')] : undefined,
  );
  const allDefs = useRegistryStore((s) => s.defs);
  const allSubgraphs = useWorkflowStore((s) => s.subgraphs);
  const unpack = useWorkflowStore((s) => s.unpackSubgraphNode);
  const setFocusedSubgraph = useViewStore((s) => s.setFocusedSubgraph);
  const debugMode = useViewStore((s) => s.debugMode);

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

  const CatIcon = def?.category ? catIconMap[def.category] : undefined;
  return (
    <div
      className={`sm-node ${selected ? 'selected' : ''} ${expanded ? 'is-expanded' : 'is-collapsed'}`}
      data-cat={def?.category}
      data-status={data.status ?? 'idle'}
      data-bypass={data.bypass ? '1' : undefined}
      data-mute={data.mute ? '1' : undefined}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setExpanded((v) => !v);
      }}
      title="双击展开 / 收起下方详情"
    >
      {/* 分类配色标题栏（HUD 风格） */}
      <div className="sm-node-header" title={def?.description}>
        <span className="sm-node-dot" />
        {CatIcon && (
          <span className="sm-node-icon">
            <CatIcon size={11} />
          </span>
        )}
        <span className="sm-node-title">{data.label}</span>
        {def?.pluginId && <span className="sm-node-tag">PLUGIN</span>}
        <span className="sm-node-cat">{def?.category}</span>
        {data.bypass && (
          <span className="sm-node-badge sm-badge-bypass" title="bypass：跳过执行，输入透传输出">
            BYPASS
          </span>
        )}
        {data.mute && (
          <span className="sm-node-badge sm-badge-mute" title="mute：已静音，不执行">
            MUTE
          </span>
        )}
        {data.durationMs != null &&
          (data.status === 'success' ||
            data.status === 'error' ||
            data.status === 'cached') && (
            <span
              className="sm-node-badge"
              title={
                data.status === 'cached'
                  ? '缓存命中（未实际执行）'
                  : `耗时 ${data.durationMs}ms`
              }
            >
              {data.status === 'cached' ? 'CACHED' : `${data.durationMs}ms`}
            </span>
          )}
        <span className="sm-node-collapse-hint" title={expanded ? '双击收起' : '双击展开下方详情'}>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <StatusGlyph status={data.status} />
      </div>

      {/* 端口区 */}
      {rows > 0 && (
        <div className="sm-port-list">
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="sm-port-row">
              <div className="sm-port-side sm-port-in">
                {inputs[i] ? (
                  <>
                    <Handle
                      id={inputs[i].id}
                      type="target"
                      position={Position.Left}
                      className="sm-handle"
                      data-porttype={inputs[i].type ?? 'any'}
                    />
                    <span className="sm-port-label">
                      {inputs[i].label}
                      <PortBadge type={inputs[i].type} />
                    </span>
                  </>
                ) : (
                  <span className="sm-port-empty" />
                )}
              </div>
              <div className="sm-port-side sm-port-out">
                {outputs[i] ? (
                  <>
                    <span className="sm-port-label">
                      {outputs[i].label}
                      <PortBadge type={outputs[i].type} />
                    </span>
                    <Handle
                      id={outputs[i].id}
                      type="source"
                      position={Position.Right}
                      className="sm-handle"
                      data-porttype={outputs[i].type ?? 'any'}
                    />
                  </>
                ) : (
                  <span className="sm-port-empty" />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 参数摘要 / 预览 / 错误（仅在展开态显示，避免折叠时文本框撑大节点边界） */}
      {expanded && (paramSummary.length > 0 || previewValue || data.error || missing || isSubgraph) && (
        <div className="border-t border-line px-3 py-2">
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
              <p className={`sm-node-preview ${isTextOutput ? 'is-text' : ''}`}>
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
          {data.error && <p className="sm-node-error">{data.error}</p>}
        </div>
      )}

      {/* 本节点单独的 token 用量：悬停展开明细（与左侧总览面板并存） */}
      {data.usage && data.usage.calls > 0 && <NodeUsageBadge usage={data.usage} />}

      {expanded && isSubgraph && subgraph && (
        <div className="sm-node-actions">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setFocusedSubgraph(String(data.params?.subgraphId ?? ''));
            }}
            title="进入子图内部进行编辑"
          >
            <Boxes size={11} /> 进入子图
          </button>
          <span className="sm-sep" />
          <button
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

      {expanded && (data.status === 'error' || data.status === 'success' || data.status === 'cached') && debugMode && (
        <div className="sm-node-actions">
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!running) void retryNode(id);
            }}
            disabled={running}
            title="重新执行此节点及其下游（复用上游已有输出，并清除该节点缓存）"
          >
            <RotateCcw size={11} /> 重跑子图
          </button>
          <span className="sm-sep" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!running) void runToNode(id);
            }}
            disabled={running}
            title="只重跑到此节点为止，其下游不再执行（标记 skipped）"
          >
            <StepForward size={11} /> 重跑到此节点
          </button>
          <span className="sm-sep" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!running) void runSingleNode(id);
            }}
            disabled={running}
            title="单独运行此节点（不执行上游/下游，用于孤立调试）"
          >
            <Play size={11} /> 单独运行
          </button>
          <span className="sm-sep" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              useWorkflowStore.getState().toggleNodeBypass(id);
            }}
            className={data.bypass ? 'is-active' : ''}
            title="bypass：跳过执行，同名端口输入透传输出（再次点击取消）"
          >
            <ArrowRightLeft size={11} /> Bypass
          </button>
          <span className="sm-sep" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              useWorkflowStore.getState().toggleNodeMute(id);
            }}
            className={data.mute ? 'is-active' : ''}
            title="mute：完全屏蔽该节点（不执行，输出为空）"
          >
            <VolumeX size={11} /> Mute
          </button>
        </div>
      )}
    </div>
  );
});

export default BaseNode;
