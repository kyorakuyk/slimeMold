import { describe, expect, it } from 'vitest';
import {
  createNodeDef,
  NODE_ROLE_META,
  type ExecContext,
  type NodeDefinition,
  type NodeRole,
} from './node';

describe('node runtime contract owner', () => {
  it('keeps node definitions and role metadata usable', () => {
    const role: NodeRole = 'worker';
    const def: NodeDefinition = createNodeDef({
      typeId: 'tool.example',
      name: 'Example',
      inputs: [],
      outputs: [],
      execute: async () => ({ ok: true }),
    });
    const ctx = {} as ExecContext;

    expect(role).toBe('worker');
    expect(def.category).toBe('自定义');
    expect(def.role).toBe('worker');
    expect(NODE_ROLE_META.worker.label).toBe('执行');
    expect(ctx).toBeDefined();
  });
});
