import { memo, useState, useContext } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Boxes, Copy, RotateCcw, StepForward, Ungroup, Check, AlertTriangle, Loader2, ChevronDown, ChevronRight, ArrowRightLeft, VolumeX, Play, type LucideIcon } from 'lucide-react';
import type { FlowNode, NodeStatus } from '../../types/graph';
import { useRegistryStore } from '../../store/registryStore';
import { useWorkflowStore } from '../../store/workflowStore';
import { useViewStore } from '../../store/viewStore';
import { retryNode, runToNode, runSingleNode } from '../../engine/executor';
import { CanvasWfIdContext } from '../canvasWfId';
import { resolvePorts, SUBGRAPH_REF_TYPE } from '../../engine/subgraph';
import NodeUsageBadge from './NodeUsageBadge';
import { useT } from '../../i18n/useT';
import { localizeNodeCategory } from '../../i18n/nodeLabels';

function StatusDot({ status, error }: { status: NodeStatus; error?: string }) {
  const t = useT('ui');
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
      ? t('canvas.node.status.cached')
      : status === 'skipped'
        ? t('canvas.node.status.skipped')
        : status === 'bypassed'
          ? t('canvas.node.status.bypassed')
          : status === 'muted'
            ? t('canvas.node.status.muted')
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
  const translate = useT('ui');
  const portType = type ?? 'any';
  return (
    <span
      title={translate('canvas.node.portType', { type: portType })}
      className={`sm-port-badge ${portBadgeCls[portType] ?? portBadgeCls.any}`}
    />
  );
}

/**
 * 将节点数据与当前画布工作流的运行态投影组合成画布单元；拆分视图必须按 `canvasWfId` 读取运行态。
 * 重跑/单节点运行仍受该工作流的 `running` 状态门控（ADR-SM-005）。
 */
const BaseNode = memo(({ data, selected, id }: NodeProps<FlowNode>) => {
  const t = useT('ui');
  const def = useRegistryStore((s) => s.defs[data.typeId]);
  // 方案 A：节点运行类操作需定位到所属工作流（拆分视图右栏）
  const canvasWfId = useContext(CanvasWfIdContext);
  const running = useWorkflowStore((s) =>
    canvasWfId ? (s.runStates[canvasWfId]?.running ?? false) : s.running,
  );
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
  const categoryLabel = def?.category ? localizeNodeCategory(def.category, t) : undefined;

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
      title={t('canvas.node.toggleDetails')}
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
        <span className="sm-node-cat">{categoryLabel}</span>
        {data.bypass && (
          <span className="sm-node-badge sm-badge-bypass" title={t('canvas.node.bypassBadge')}>
            BYPASS
          </span>
        )}
        {data.mute && (
          <span className="sm-node-badge sm-badge-mute" title={t('canvas.node.muteBadge')}>
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
                  ? t('canvas.node.cacheHit')
                  : t('canvas.node.status.duration', { duration: data.durationMs })
              }
            >
              {data.status === 'cached' ? 'CACHED' : `${data.durationMs}ms`}
            </span>
          )}
        <span className="sm-node-collapse-hint" title={expanded ? t('canvas.node.collapse') : t('canvas.node.expand')}>
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
              {isSubgraph ? t('canvas.node.subgraphMissing') : t('canvas.node.typeMissing', { typeId: data.typeId })}
            </p>
          )}
          {isSubgraph && subgraph && (
            <p className="flex items-center gap-1 text-[11px] leading-relaxed text-ink-faint">
              <Boxes size={11} />
              {t('canvas.node.subgraphSummary', { steps: subgraph.nodes.length, inputs: inputs.length, outputs: outputs.length })}
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
                {previewValue || t('canvas.node.emptyPreview')}
              </p>
              {isTextOutput && previewValue && (
                <button
                  className="mt-1 flex w-full items-center justify-center gap-1 rounded py-1 text-[11px] text-accent transition-colors hover:bg-paper-soft"
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigator.clipboard?.writeText(previewValue);
                  }}
                  title={t('canvas.node.copyTitle')}
                >
                  <Copy size={11} /> {t('canvas.node.copyAction')}
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
            title={t('canvas.node.subgraphEditTitle')}
          >
            <Boxes size={11} /> {t('canvas.node.subgraphEditAction')}
          </button>
          <span className="sm-sep" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!running) unpack(id);
            }}
            disabled={running}
            title={t('canvas.node.subgraphUnpackTitle')}
          >
            <Ungroup size={11} /> {t('canvas.node.subgraphUnpackAction')}
          </button>
        </div>
      )}

      {expanded && (data.status === 'error' || data.status === 'success' || data.status === 'cached') && debugMode && (
        <div className="sm-node-actions">
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!running) void retryNode(id, canvasWfId);
            }}
            disabled={running}
            title={t('canvas.node.retryTitle')}
          >
            <RotateCcw size={11} /> {t('canvas.node.retryAction')}
          </button>
          <span className="sm-sep" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!running) void runToNode(id, canvasWfId);
            }}
            disabled={running}
            title={t('canvas.node.runToTitle')}
          >
            <StepForward size={11} /> {t('canvas.node.runToAction')}
          </button>
          <span className="sm-sep" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!running) void runSingleNode(id, canvasWfId);
            }}
            disabled={running}
            title={t('canvas.node.runSingleTitle')}
          >
            <Play size={11} /> {t('canvas.node.runSingleAction')}
          </button>
          <span className="sm-sep" />
          <button
            onClick={(e) => {
              e.stopPropagation();
              useWorkflowStore.getState().toggleNodeBypass(id);
            }}
            className={data.bypass ? 'is-active' : ''}
            title={t('canvas.node.bypassTitle')}
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
            title={t('canvas.node.muteTitle')}
          >
            <VolumeX size={11} /> Mute
          </button>
        </div>
      )}
    </div>
  );
});

export default BaseNode;
