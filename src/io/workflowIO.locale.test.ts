import { beforeEach, expect, it, vi } from 'vitest';
import i18n from '../i18n';

const mocks = vi.hoisted(() => ({
  registry: {
    defs: {} as Record<string, unknown>,
    register: vi.fn(),
  },
  workflow: {
    addLog: vi.fn(),
    loadGraph: vi.fn(),
  },
  setState: vi.fn(),
}));

vi.mock('../store/registryStore', () => ({
  useRegistryStore: { getState: () => mocks.registry },
}));
vi.mock('../store/workflowStore', () => ({
  useWorkflowStore: Object.assign(vi.fn(), {
    getState: () => mocks.workflow,
    setState: mocks.setState,
  }),
}));

import { applyWorkflowFile } from './workflowIO';

const workflowText = JSON.stringify({
  version: 1,
  name: 'fixture',
  savedAt: '2026-01-01T00:00:00.000Z',
  nodes: [
    { id: 'n1', typeId: 'custom/foo', label: 'Foo', position: { x: 0, y: 0 }, params: {} },
    { id: 'n2', typeId: 'builtin.bar', label: 'Bar', position: { x: 1, y: 0 }, params: {} },
  ],
  edges: [],
  agents: [],
  roles: [],
  variables: {},
});

beforeEach(() => {
  mocks.registry.defs = {};
  mocks.registry.register.mockClear();
  mocks.workflow.addLog.mockClear();
  mocks.workflow.loadGraph.mockClear();
  mocks.setState.mockClear();
});

it('uses locale-appropriate punctuation in missing node type details', async () => {
  const previousLanguage = i18n.language;
  try {
    await i18n.changeLanguage('en-US');
    applyWorkflowFile(workflowText);
    const englishError = mocks.workflow.addLog.mock.calls.find(([level]) => level === 'error')?.[1];
    expect(englishError).toContain('Missing types: custom/foo, builtin.bar.');

    mocks.workflow.addLog.mockClear();
    await i18n.changeLanguage('zh-CN');
    applyWorkflowFile(workflowText);
    const chineseError = mocks.workflow.addLog.mock.calls.find(([level]) => level === 'error')?.[1];
    expect(chineseError).toContain('缺失类型：custom/foo、builtin.bar');
  } finally {
    await i18n.changeLanguage(previousLanguage);
  }
});
