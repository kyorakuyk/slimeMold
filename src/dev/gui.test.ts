import { beforeEach, describe, expect, it } from 'vitest';
import type { NodeDefinition } from '../types';
import { getNodeDef, useRegistryStore } from '../store/registryStore';
import { registerGuiDevDefs } from './gui';

const devDef = {
  typeId: 'dev.worktree.create',
} as NodeDefinition;

describe('GUI DevSession registry bridge', () => {
  beforeEach(() => {
    useRegistryStore.setState({ defs: {} });
  });

  it('registers session defs even when the session already exists', () => {
    expect(getNodeDef(devDef.typeId)).toBeUndefined();

    registerGuiDevDefs([devDef]);

    expect(getNodeDef(devDef.typeId)).toBe(devDef);
  });
});
