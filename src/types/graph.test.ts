import { describe, expect, it } from 'vitest';
import { arePortsCompatible, EDGE_KIND_STYLE } from './graph';

describe('workflow graph type rules', () => {
  it('keeps scalar ports compatible while preserving structured boundaries', () => {
    expect(arePortsCompatible('text', 'number')).toBe(true);
    expect(arePortsCompatible('any', 'json')).toBe(true);
    expect(arePortsCompatible('list', 'json')).toBe(false);
    expect(arePortsCompatible(undefined, 'image')).toBe(true);
  });

  it('owns the stable edge kind presentation metadata', () => {
    expect(EDGE_KIND_STYLE.data.label).toBe('数据');
    expect(EDGE_KIND_STYLE.task.dash).toBe('6 3');
    expect(EDGE_KIND_STYLE.control.color).toBe('#8b5cf6');
  });
});
