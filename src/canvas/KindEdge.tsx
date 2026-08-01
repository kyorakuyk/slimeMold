import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from '@xyflow/react';
import { EDGE_KIND_STYLE, type FlowEdge } from '../types';

/** 按连线语义（data/task/control）渲染不同颜色与线型的自定义边。 */
function KindEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps<FlowEdge>) {
  const kind = data?.kind ?? 'data';
  const style = EDGE_KIND_STYLE[kind];
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: style.color,
          strokeWidth: kind === 'data' ? 1.5 : 2,
          strokeDasharray: style.dash,
        }}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'none',
            fontSize: 10,
            fontWeight: 600,
            color: style.color,
            background: 'rgba(17,24,39,0.75)',
            borderRadius: 4,
            padding: '0 4px',
          }}
          className="nodrag nopan"
        >
          {style.label}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const KindEdge = memo(KindEdgeImpl);
