import { describe, expect, it } from 'vitest';
import type { FlowEdge, PortDef } from '../types';
import { projectStyledEdges, type EdgeProxyMapping } from './workflowEdgeProjection';

const port = (id: string, type: PortDef['type']): PortDef => ({ id, label: id, type });

function edge(overrides: Partial<FlowEdge> = {}): FlowEdge {
  return {
    id: 'edge-1',
    source: 'source',
    target: 'target',
    sourceHandle: 'out',
    targetHandle: 'in',
    data: { kind: 'data' },
    ...overrides,
  } as FlowEdge;
}

describe('projectStyledEdges', () => {
  it('adds source-port color while preserving edge data and input immutability', () => {
    const input = edge({ style: { opacity: 0.5 } });
    const result = projectStyledEdges(
      [input],
      { source: [port('out', 'text')] },
      new Map<string, EdgeProxyMapping>(),
    );

    expect(result[0]).toMatchObject({
      id: 'edge-1',
      source: 'source',
      target: 'target',
      sourceHandle: 'out',
      targetHandle: 'in',
      data: { kind: 'data' },
      style: { opacity: 0.5, '--edge-color': 'var(--pt-text)' },
    });
    expect(input).toEqual(edge({ style: { opacity: 0.5 } }));
  });

  it('redirects collapsed output and input members to their proxy handles', () => {
    const mappings = new Map<string, EdgeProxyMapping>([
      ['source', { nodeId: 'grp-source', handle: 'out-proxy', type: 'output' }],
      ['target', { nodeId: 'grp-target', handle: 'in-proxy', type: 'input' }],
    ]);
    const result = projectStyledEdges(
      [edge()],
      { 'grp-source': [port('out-proxy', 'number')] },
      mappings,
    );

    expect(result[0]).toMatchObject({
      source: 'grp-source',
      sourceHandle: 'out-proxy',
      target: 'grp-target',
      targetHandle: 'in-proxy',
      style: { '--edge-color': 'var(--pt-number)' },
    });
  });

  it('uses the fallback color when the source port is missing', () => {
    const result = projectStyledEdges(
      [edge({ sourceHandle: 'missing' })],
      { source: [port('out', 'text')] },
      new Map<string, EdgeProxyMapping>(),
    );

    const style = result[0]?.style as Record<string, unknown> | undefined;
    expect(style?.['--edge-color']).toBe('var(--sm-edge)');
  });
});
