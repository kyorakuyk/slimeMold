import { useCallback } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  useReactFlow,
} from '@xyflow/react';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
  BoxSelect,
  Hand,
  Map as MapIcon,
  Maximize2,
  Minus,
  MousePointer2,
  Play,
  Plus,
  Square,
} from 'lucide-react';
import { runWorkflow, stopWorkflow } from '../engine/executor';
import { useViewStore } from '../store/viewStore';
import { useWorkflowStore } from '../store/workflowStore';
import { useT } from '../i18n/useT';

// 小地图节点配色（与 CSS 分类变量同语义，深色调更亮以保证可见）
// These keys are persisted node category identifiers, not display labels.
const CAT_COLORS: Record<string, string> = {
  输入: '#51cf66',
  AI: '#9775fa',
  智能体: '#9775fa',
  文本: '#4dabf7',
  工具: '#ffa94d',
  输出: '#f783ac',
  流程: '#3bc9db',
};

type InteractionMode = ReturnType<typeof useViewStore.getState>['interactionMode'];

type CanvasPanelControlsProps = {
  wfId?: string;
  zoomPct: number;
  interactionMode: InteractionMode;
  onInteractionModeChange: (mode: InteractionMode) => void;
};

export default function CanvasPanelControls({
  wfId,
  zoomPct,
  interactionMode,
  onInteractionModeChange,
}: CanvasPanelControlsProps) {
  const t = useT();
  const showGrid = useViewStore((s) => s.showGrid);
  const showMinimap = useViewStore((s) => s.showMinimap);
  const toggleMinimap = useViewStore((s) => s.toggleMinimap);
  const alignSelected = useWorkflowStore((s) => s.alignSelected);
  const distributeSelected = useWorkflowStore((s) => s.distributeSelected);
  const splitRunning = useWorkflowStore((s) => (wfId ? (s.runStates[wfId]?.running ?? false) : false));
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const handleSplitRun = useCallback(() => {
    if (!wfId) return;
    void runWorkflow({ wfId });
  }, [wfId]);
  const handleSplitStop = useCallback(() => {
    if (!wfId) return;
    stopWorkflow(wfId);
  }, [wfId]);

  return (
    <>
      {wfId && (
        <Panel position="top-right" className="!m-2">
          <div
            className="pointer-events-auto flex items-center gap-1.5 rounded-lg border px-1.5 py-1 shadow-sm"
            style={{ background: 'var(--sm-bg)', borderColor: 'var(--sm-line)' }}
          >
            {splitRunning ? (
              <button
                className="flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-err transition hover:bg-[var(--sm-bg-soft)]"
                title={t('canvas.split.stopTitle')}
                onClick={handleSplitStop}
              >
                <Square size={13} /> {t('canvas.split.stop')}
              </button>
            ) : (
              <button
                className="flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium sm-btn-primary transition"
                title={t('canvas.split.runTitle')}
                onClick={handleSplitRun}
              >
                <Play size={13} /> {t('canvas.split.run')}
              </button>
            )}
            <span className="text-[11px]" style={{ color: 'var(--sm-ink-faint)' }}>
              {wfId}
            </span>
          </div>
        </Panel>
      )}
      {showGrid && (
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1.5}
          color="var(--sm-canvas-grid)"
        />
      )}
      {/* 左上：对齐 / 分布工具条（ComfyUI 风格，对选中≥2节点生效） */}
      <Panel position="top-left" className="sm-cv-panel">
        <div className="sm-cv-modes sm-cv-modes-h" title={t('canvas.align.title')}>
          <button className="sm-cv-btn" title={t('canvas.align.left')} onClick={() => alignSelected('left')}><AlignStartVertical size={15} /></button>
          <button className="sm-cv-btn" title={t('canvas.align.hCenter')} onClick={() => alignSelected('hcenter')}><AlignCenterVertical size={15} /></button>
          <button className="sm-cv-btn" title={t('canvas.align.right')} onClick={() => alignSelected('right')}><AlignEndVertical size={15} /></button>
          <span className="sm-cv-sep" />
          <button className="sm-cv-btn" title={t('canvas.align.top')} onClick={() => alignSelected('top')}><AlignStartHorizontal size={15} /></button>
          <button className="sm-cv-btn" title={t('canvas.align.vCenter')} onClick={() => alignSelected('vcenter')}><AlignCenterHorizontal size={15} /></button>
          <button className="sm-cv-btn" title={t('canvas.align.bottom')} onClick={() => alignSelected('bottom')}><AlignEndHorizontal size={15} /></button>
          <span className="sm-cv-sep" />
          <button className="sm-cv-btn" title={t('canvas.align.distributeHorizontal')} onClick={() => distributeSelected('x')}><AlignHorizontalSpaceBetween size={15} /></button>
          <button className="sm-cv-btn" title={t('canvas.align.distributeVertical')} onClick={() => distributeSelected('y')}><AlignVerticalSpaceBetween size={15} /></button>
        </div>
      </Panel>

      {/* 左下：鼠标模式切换 + 小地图开关（ComfyUI 风格） */}
      <Panel position="bottom-left" className="sm-cv-panel">
        <div className="sm-cv-modes">
          <button
            className={`sm-cv-btn ${interactionMode === 'move' ? 'active' : ''}`}
            title={t('canvas.mode.drag')}
            onClick={() => onInteractionModeChange('move')}
          >
            <Hand size={15} />
          </button>
          <button
            className={`sm-cv-btn ${interactionMode === 'select' ? 'active' : ''}`}
            title={t('canvas.mode.boxSelect')}
            onClick={() => onInteractionModeChange('select')}
          >
            <BoxSelect size={15} />
          </button>
          <button
            className={`sm-cv-btn ${interactionMode === 'click' ? 'active' : ''}`}
            title={t('canvas.mode.click')}
            onClick={() => onInteractionModeChange('click')}
          >
            <MousePointer2 size={15} />
          </button>
          <button
            className={`sm-cv-btn ${showMinimap ? 'active' : ''}`}
            title={showMinimap ? t('canvas.minimap.hide') : t('canvas.minimap.show')}
            onClick={toggleMinimap}
          >
            <MapIcon size={15} />
          </button>
        </div>
      </Panel>

      {/* 右下：缩放控制（ComfyUI 风格） */}
      <Panel position="bottom-right" className="sm-cv-panel">
        <div className="sm-cv-zoom">
          <button className="sm-cv-btn" title={t('canvas.zoom.out')} onClick={() => zoomOut({ duration: 150 })}>
            <Minus size={15} />
          </button>
          <button className="sm-cv-zoom-val" title={t('canvas.zoom.fit')} onClick={() => fitView({ duration: 250, padding: 0.2 })}>
            {zoomPct}%
          </button>
          <button className="sm-cv-btn" title={t('canvas.zoom.in')} onClick={() => zoomIn({ duration: 150 })}>
            <Plus size={15} />
          </button>
          <button className="sm-cv-btn" title={t('canvas.zoom.fit')} onClick={() => fitView({ duration: 250, padding: 0.2 })}>
            <Maximize2 size={15} />
          </button>
        </div>
      </Panel>
      {showMinimap && (
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => CAT_COLORS[(node.data?.category as keyof typeof CAT_COLORS)] ?? '#9aa0a6'}
          nodeStrokeColor={(node) => CAT_COLORS[(node.data?.category as keyof typeof CAT_COLORS)] ?? '#9aa0a6'}
          maskColor="rgba(0,0,0,0.45)"
          style={{ marginBottom: 44 }}
        />
      )}
    </>
  );
}
