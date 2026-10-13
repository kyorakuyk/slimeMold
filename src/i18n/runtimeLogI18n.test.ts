import { describe, expect, it } from 'vitest';
import i18n from './index';

describe('R5 Slice7 runtime log translations', () => {
  it('pluralizes dropped-workflow and group-created counts in both locales', () => {
    expect(i18n.t('log.workflowFileDrop.opened', { count: 1, lng: 'en-US' })).toBe(
      'Opened 1 workflow from dropped files',
    );
    expect(i18n.t('log.workflowFileDrop.opened', { count: 2, lng: 'en-US' })).toBe(
      'Opened 2 workflows from dropped files',
    );
    expect(i18n.t('log.workflowFileDrop.opened', { count: 2, lng: 'zh-CN' })).toBe(
      '已从拖入的文件打开 2 个工作流',
    );
    expect(i18n.t('log.workflowGroup.created', {
      count: 1,
      groupName: 'Group A',
      subgraphName: 'Subgraph A',
      lng: 'en-US',
    })).toBe('Grouped 1 node as “Group A” (subgraph: Subgraph A)');
    expect(i18n.t('log.workflowGroup.created', {
      count: 2,
      groupName: 'Group A',
      subgraphName: 'Subgraph A',
      lng: 'en-US',
    })).toBe('Grouped 2 nodes as “Group A” (subgraph: Subgraph A)');
    expect(i18n.t('log.workflowGroup.created', {
      count: 2,
      groupName: 'Group A',
      subgraphName: 'Subgraph A',
      lng: 'zh-CN',
    })).toBe('已把 2 个节点编为「Group A」（子图：Subgraph A）');
  });

  it('keeps locale-appropriate punctuation and interpolates the original platform error', () => {
    expect(i18n.t('log.platform.projectWriteSkipped', {
      path: 'D:/project',
      message: 'permission denied',
      lng: 'en-US',
    })).toBe('Project file write skipped (directory may be outside filesystem access scope): D:/project — permission denied');
    expect(i18n.t('log.platform.projectWriteSkipped', {
      path: 'D:/project',
      message: 'permission denied',
      lng: 'zh-CN',
    })).toBe('项目文件写入跳过（目录可能不在文件系统权限范围内）：D:/project — permission denied');
  });

  it('preserves finalizer suffix punctuation when composing plural sub-messages', () => {
    const cache = i18n.t('log.runFinalizer.cachedSteps', { count: 2, lng: 'en-US' });
    const skipped = i18n.t('log.runFinalizer.conditionSkippedSteps', { count: 1, lng: 'en-US' });
    expect(i18n.t('log.runFinalizer.completed', {
      elapsed: 4,
      cacheSuffix: cache,
      pruneSuffix: skipped,
      lng: 'en-US',
    })).toBe('Completed ✓ (4s, 2 steps used cached results, 1 step skipped because its condition was false)');

    const cacheZh = i18n.t('log.runFinalizer.cachedSteps', { count: 2, lng: 'zh-CN' });
    const skippedZh = i18n.t('log.runFinalizer.conditionSkippedSteps', { count: 1, lng: 'zh-CN' });
    expect(i18n.t('log.runFinalizer.completed', {
      elapsed: 4,
      cacheSuffix: cacheZh,
      pruneSuffix: skippedZh,
      lng: 'zh-CN',
    })).toBe('全部完成 ✓（用时 4s，2 步用了缓存结果，1 步因条件不成立而跳过）');
  });
});
