import { describe, expect, it } from 'vitest';
import type { LoadedPlugin, PluginManifest, PluginNodeMeta } from './plugin';

const node: PluginNodeMeta = {
  typeId: 'plugin.example',
  name: 'Example',
  inputs: [],
  outputs: [],
  minCapability: 'io',
};

const manifest: PluginManifest = {
  id: 'plugin.example',
  name: 'Example plugin',
  entry: 'index.js',
  nodes: [node],
};

describe('plugin contract owner', () => {
  it('keeps manifest and loaded-plugin metadata structurally usable', () => {
    const loaded: LoadedPlugin = { manifest, source: 'custom', scope: 'project' };
    expect(loaded.manifest.nodes[0].typeId).toBe('plugin.example');
    expect(loaded.source).toBe('custom');
  });
});
