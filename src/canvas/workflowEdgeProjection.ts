import type { Edge } from '@xyflow/react';
import type { FlowEdge, PortDef } from '../types';

export const PORT_COLOR_VAR: Record<string, string> = {
  text: 'var(--pt-text)',
  number: 'var(--pt-number)',
  boolean: 'var(--pt-boolean)',
  list: 'var(--pt-list)',
  json: 'var(--pt-json)',
  image: 'var(--pt-image)',
  any: 'var(--sm-edge)',
};

export interface EdgeProxyMapping {
  nodeId: string;
  handle: string;
  type: string;
}

export function projectStyledEdges(
  edges: FlowEdge[],
  outsByNode: Record<string, PortDef[]>,
  memberToProxy: ReadonlyMap<string, EdgeProxyMapping>,
): Edge[] {
  return edges.map((edge): Edge => {
    let source = edge.source;
    let sourceHandle = edge.sourceHandle ?? undefined;
    let target = edge.target;
    let targetHandle = edge.targetHandle ?? undefined;

    const sourceProxy = memberToProxy.get(edge.source);
    if (sourceProxy && sourceProxy.type === 'output') {
      source = sourceProxy.nodeId;
      sourceHandle = sourceProxy.handle;
    }
    const targetProxy = memberToProxy.get(edge.target);
    if (targetProxy && targetProxy.type === 'input') {
      target = targetProxy.nodeId;
      targetHandle = targetProxy.handle;
    }

    const outputs = outsByNode[source] ?? [];
    const output = outputs.find((port) => port.id === (sourceHandle ?? outputs[0]?.id));
    const portType = output?.type ?? 'any';
    const colorVar = PORT_COLOR_VAR[portType] ?? 'var(--sm-edge)';
    return {
      ...edge,
      source,
      sourceHandle,
      target,
      targetHandle,
      style: { ...(edge.style ?? {}), ['--edge-color']: colorVar },
    } as Edge;
  });
}
