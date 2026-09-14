import { describe, it, expect } from 'vitest';
import {
  defaultDevPolicy,
  isPathAllowed,
  isPathProtected,
  assertPathAllowed,
  collectChangedProtectedPaths,
} from './policy';

describe('H4 policy', () => {
  it('defaultDevPolicy：固定 autoPush=false，保护核心路径', () => {
    expect(defaultDevPolicy.autoPush).toBe(false);
    expect(defaultDevPolicy.autoTest).toBe(true);
    expect(defaultDevPolicy.autoCommit).toBe(false);
    expect(defaultDevPolicy.protectedPaths).toContain('src/orchestrator/**');
    expect(defaultDevPolicy.protectedPaths).toContain('package.json');
    expect(defaultDevPolicy.protectedPaths).toContain('package-lock.json');
    expect(defaultDevPolicy.protectedPaths).toContain('tests/**');
  });

  it('isPathAllowed：目录前缀匹配与子路径', () => {
    expect(isPathAllowed(defaultDevPolicy, 'src/components/TopBar.tsx')).toBe(true);
    expect(isPathAllowed(defaultDevPolicy, 'src/components/OrchestratorPanel.tsx')).toBe(true);
    expect(isPathAllowed(defaultDevPolicy, 'docs/H4_SELF_DEVELOPMENT_FOUNDATION.md')).toBe(true);
    expect(isPathAllowed(defaultDevPolicy, 'src/store/workflowStore.ts')).toBe(false);
    expect(isPathAllowed(defaultDevPolicy, 'src/engine/executor.ts')).toBe(false);
    expect(isPathAllowed(defaultDevPolicy, 'README.md')).toBe(false);
  });

  it('isPathProtected：orchestrator 目录整体受保护（** 通配）', () => {
    expect(isPathProtected(defaultDevPolicy, 'src/orchestrator/run.ts')).toBe(true);
    expect(isPathProtected(defaultDevPolicy, 'src/orchestrator/draft.ts')).toBe(true);
    expect(isPathProtected(defaultDevPolicy, 'src/store/workflowStore.ts')).toBe(true);
    expect(isPathProtected(defaultDevPolicy, 'src/components/TopBar.tsx')).toBe(false);
  });

  it('assertPathAllowed：允许通过，受保护/越界抛错', () => {
    expect(() => assertPathAllowed(defaultDevPolicy, 'docs/a.md')).not.toThrow();
    expect(() => assertPathAllowed(defaultDevPolicy, 'src/orchestrator/run.ts')).toThrow(/受保护/);
    expect(() => assertPathAllowed(defaultDevPolicy, 'src/store/workflowStore.ts')).toThrow(/受保护/);
    expect(() => assertPathAllowed(defaultDevPolicy, 'package.json')).toThrow(/受保护/);
  });

  it('collectChangedProtectedPaths：从变更清单筛出受保护文件', () => {
    const changed = ['docs/a.md', 'src/orchestrator/run.ts', 'src/components/x.tsx', 'src/engine/executor.ts'];
    const hit = collectChangedProtectedPaths(defaultDevPolicy, changed);
    expect(hit).toEqual(['src/orchestrator/run.ts', 'src/engine/executor.ts']);
  });
});
