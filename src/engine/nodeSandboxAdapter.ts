import type { SandboxHandle } from '../types';
import type { RunResources } from './runResources';
import {
  assertAllowedSandboxLane,
  assertSandboxRelativePath,
  encodeSandboxIdentifier,
} from './sandboxPath';
import { createSandboxFsGuard } from './sandboxFs';

export interface NodeSandboxAdapterOptions {
  enabled: boolean;
  isTauri: boolean;
  nodeId: string;
  wfId: string;
  runId: number;
  nodeWorkspaceDir: string | null;
  incomingNodeIds: readonly string[];
  getRunResources: (wfId: string, runId: number) => RunResources | undefined;
}

export function createNodeSandbox(options: NodeSandboxAdapterOptions): SandboxHandle | undefined {
  if (!options.enabled) return undefined;

  const inBrowser = !options.isTauri;
  const rootDir = async (): Promise<string | null> => {
    if (inBrowser) return null;
    const resources = options.getRunResources(options.wfId, options.runId);
    const worktree = resources?.worktree;
    if (worktree) return worktree.path;
    if (options.nodeWorkspaceDir) return options.nodeWorkspaceDir;
    try {
      const { appDataDir } = await import('@tauri-apps/api/path');
      return `${await appDataDir()}/slime-mold/${options.wfId}`;
    } catch {
      return null;
    }
  };

  const rootDirAndTrack = async (): Promise<string | null> => {
    const base = await rootDir();
    if (base) {
      options.getRunResources(options.wfId, options.runId)?.sandboxRoots.add(base);
    }
    return base;
  };

  const allowedSandboxNodeIds = new Set(options.incomingNodeIds);
  const sandboxRoot = (nodeId: string): string =>
    `.sandbox/${encodeSandboxIdentifier(nodeId, '沙箱节点 id')}`;

  return {
    nodeId: options.nodeId,
    baseDir: null,
    inBrowser,
    async writeFile(filename, content) {
      const safeFilename = assertSandboxRelativePath(filename, '沙箱文件路径');
      const base = await rootDirAndTrack();
      if (!base) return `[sandbox:${options.nodeId}] ${safeFilename}`;
      const fs = await import('@tauri-apps/plugin-fs');
      return createSandboxFsGuard(fs, base).writeFile(
        sandboxRoot(options.nodeId),
        safeFilename,
        content,
      );
    },
    async readFrom(otherNodeId, filename) {
      const safeNodeId = assertAllowedSandboxLane(otherNodeId, allowedSandboxNodeIds);
      const safeFilename = assertSandboxRelativePath(filename, '沙箱文件路径');
      const base = await rootDirAndTrack();
      if (!base) return null;
      const fs = await import('@tauri-apps/plugin-fs');
      return createSandboxFsGuard(fs, base).readFile(sandboxRoot(safeNodeId), safeFilename);
    },
    async list(otherNodeId) {
      const safeNodeId = assertAllowedSandboxLane(otherNodeId, allowedSandboxNodeIds);
      const base = await rootDirAndTrack();
      if (!base) return [];
      const fs = await import('@tauri-apps/plugin-fs');
      return createSandboxFsGuard(fs, base).list(sandboxRoot(safeNodeId));
    },
    async commitAll() {
      const base = await rootDirAndTrack();
      if (!base) return [];
      const fs = await import('@tauri-apps/plugin-fs');
      return createSandboxFsGuard(fs, base).commit(sandboxRoot(options.nodeId));
    },
    async commitLanes(laneIds) {
      const safeLaneIds = laneIds.map((laneId) =>
        assertAllowedSandboxLane(laneId, allowedSandboxNodeIds),
      );
      const base = await rootDirAndTrack();
      if (!base) return [];
      const fs = await import('@tauri-apps/plugin-fs');
      const committed: string[] = [];
      const guard = createSandboxFsGuard(fs, base);
      for (const lane of safeLaneIds) {
        committed.push(...(await guard.commit(sandboxRoot(lane))));
      }
      return committed;
    },
  };
}
