import { describe, expect, it, vi } from 'vitest';
import type { AssetMeta } from '../types/project';
import {
  createWorkflowProjectDataCommands,
  type WorkflowProjectDataShape,
} from './workflowProjectDataCommands';

interface TestState extends WorkflowProjectDataShape {}

const asset = (id: string, path: string | null = null): AssetMeta => ({
  id,
  name: `${id}.txt`,
  path,
  kind: 'text',
  content: id,
  createdAt: '2026-09-01T00:00:00.000Z',
  inWorkspace: false,
});

function createHarness() {
  let state: TestState = {
    activeWfId: 'wf-1',
    workflows: {
      'wf-1': {
        name: 'Main workflow',
        nodes: [
          {
            id: 'node-1',
            type: 'base',
            position: { x: 0, y: 0 },
            data: { typeId: 'x', label: 'Node', params: { file: '{{asset:project-1}}' }, status: 'idle' },
          },
        ],
        assets: [],
      },
    },
    projectAssets: [],
    projectVariables: {},
  };
  const addLog = vi.fn();
  const removeFile = vi.fn(async () => {});
  const commands = createWorkflowProjectDataCommands<TestState>({
    getState: () => state,
    setState: (patch) => { state = { ...state, ...patch }; },
    addLog,
    removeFile,
  });
  return { getState: () => state, commands, addLog, removeFile };
}

describe('workflow project data command owner', () => {
  it('updates workflow assets and project variables through explicit state ports', () => {
    const harness = createHarness();
    harness.commands.addAsset(asset('workflow-1'));
    harness.commands.addProjectAsset(asset('project-1'));
    harness.commands.setProjectVariable('answer', 42);

    expect(harness.getState().workflows['wf-1'].assets).toEqual([asset('workflow-1')]);
    expect(harness.getState().projectAssets).toEqual([asset('project-1')]);
    expect(harness.getState().projectVariables).toEqual({ answer: 42 });
  });

  it('returns dependent workflow names before removing a project asset', () => {
    const harness = createHarness();
    harness.commands.addProjectAsset(asset('project-1'));

    expect(harness.commands.removeProjectAsset('project-1')).toEqual(['Main workflow']);
    expect(harness.getState().projectAssets).toEqual([]);
  });

  it('removes persisted files through the injected file port and preserves warning semantics', async () => {
    const harness = createHarness();
    harness.commands.addAsset(asset('workflow-1', '/tmp/workflow-1.txt'));
    harness.commands.removeAsset('workflow-1');
    await vi.waitFor(() => expect(harness.removeFile).toHaveBeenCalledWith('/tmp/workflow-1.txt'));
    expect(harness.addLog).toHaveBeenCalledWith('info', '已删除资产文件：/tmp/workflow-1.txt');
  });
});
