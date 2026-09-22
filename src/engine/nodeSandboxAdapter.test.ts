import { describe, expect, it } from 'vitest';
import { createNodeSandbox } from './nodeSandboxAdapter';

describe('node sandbox adapter', () => {
  it('keeps browser sandbox operations in memory while enforcing lane ownership', async () => {
    const sandbox = createNodeSandbox({
      enabled: true,
      isTauri: false,
      nodeId: 'coord',
      wfId: 'workflow-1',
      runId: 1,
      nodeWorkspaceDir: null,
      incomingNodeIds: ['worker-a'],
      getRunResources: () => undefined,
    });

    expect(sandbox?.baseDir).toBeNull();
    expect(sandbox?.inBrowser).toBe(true);
    await expect(sandbox?.writeFile('../unsafe.txt', 'x')).rejects.toThrow();
    await expect(sandbox?.writeFile('result.txt', 'x')).resolves.toBe('[sandbox:coord] result.txt');
    await expect(sandbox?.readFrom('worker-a', 'result.txt')).resolves.toBeNull();
    await expect(sandbox?.list('worker-a')).resolves.toEqual([]);
    await expect(sandbox?.commitAll()).resolves.toEqual([]);
    await expect(sandbox?.commitLanes(['worker-a'])).resolves.toEqual([]);
    await expect(sandbox?.readFrom('worker-b', 'result.txt')).rejects.toThrow();
  });

  it('returns no adapter when sandbox execution is disabled', () => {
    expect(createNodeSandbox({
      enabled: false,
      isTauri: false,
      nodeId: 'node-1',
      wfId: 'workflow-1',
      runId: 1,
      nodeWorkspaceDir: null,
      incomingNodeIds: [],
      getRunResources: () => undefined,
    })).toBeUndefined();
  });
});
