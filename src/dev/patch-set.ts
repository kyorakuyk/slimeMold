import { hashContent, type DevCapabilityService, type DevContext } from './capabilities';
import {
  decodeFilePatchSet,
  type FilePatchEntry,
  type FilePatchSet,
} from '../domain/model/artifact';

export interface FilePatchSetApplyResult {
  appliedPaths: string[];
  contentHashes: Record<string, string>;
}

type FilePatchHostService = Pick<DevCapabilityService, 'codeRead' | 'codePatch'>
  & Partial<Pick<DevCapabilityService, 'codeMkdir'>>;

export class FilePatchSetApplyError extends Error {
  constructor(
    message: string,
    readonly appliedPaths: string[] = [],
    readonly failedPath?: string,
  ) {
    super(message);
    this.name = 'FilePatchSetApplyError';
  }
}

function isMissingFileError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return true;
  if (typeof error !== 'string' && !(error instanceof Error)) return false;
  const message = typeof error === 'string' ? error : error.message;
  return /(?:ENOENT|not found|no such file|文件不存在|路径不存在)/i.test(message);
}

async function readOptional(
  service: Pick<DevCapabilityService, 'codeRead'>,
  path: string,
  ctx: DevContext,
): Promise<string | null> {
  try {
    return (await service.codeRead(path, ctx)).content;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function normalizedLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').split('\n');
}

function parentDirectories(path: string): string[] {
  const segments = path.split('/');
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'));
}

/**
 * Build the narrow internal diff understood by the existing host codePatch adapter.
 * The empty deletion line consumes the parser's empty-file sentinel for a new file.
 */
export function unifiedDiffForFilePatch(entry: FilePatchEntry): string {
  const oldLines = entry.before === null ? [''] : normalizedLines(entry.before);
  const newLines = normalizedLines(entry.after);
  const oldRange = entry.before === null ? '0,0' : `1,${oldLines.length}`;
  const newRange = `1,${newLines.length}`;
  const body = [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
  const oldHeader = entry.before === null ? '/dev/null' : `a/${entry.path}`;
  return `--- ${oldHeader}\n+++ b/${entry.path}\n@@ -${oldRange} +${newRange} @@\n${body}\n`;
}

/**
 * Apply a structured patch set through the host's existing guarded codePatch API.
 * All preimages are checked before the first write; every successful write is read back.
 */
export async function applyFilePatchSet(
  value: unknown,
  service: FilePatchHostService,
  ctx: DevContext,
): Promise<FilePatchSetApplyResult> {
  const patchSet: FilePatchSet = decodeFilePatchSet(value);

  for (const entry of patchSet.patches) {
    let actual: string | null;
    try {
      actual = await readOptional(service, entry.path, ctx);
    } catch (error) {
      throw new FilePatchSetApplyError(
        `读取补丁前置状态失败：${entry.path}：${error instanceof Error ? error.message : String(error)}`,
        [],
        entry.path,
      );
    }
    if (actual !== entry.before) {
      throw new FilePatchSetApplyError(
        `补丁前置内容已漂移：${entry.path}`,
        [],
        entry.path,
      );
    }
    if (entry.beforeHash) {
      if (actual === null || hashContent(actual) !== entry.beforeHash) {
        throw new FilePatchSetApplyError(
          `补丁前置内容 hash 不匹配：${entry.path}`,
          [],
          entry.path,
        );
      }
    }
  }

  if (service.codeMkdir) {
    const directories = new Set(patchSet.patches.flatMap((entry) => parentDirectories(entry.path)));
    for (const directory of directories) {
      try {
        await service.codeMkdir(directory, ctx);
      } catch (error) {
        throw new FilePatchSetApplyError(
          `宿主创建补丁父目录失败：${directory}：${error instanceof Error ? error.message : String(error)}`,
          [],
          directory,
        );
      }
    }
  }

  const appliedPaths: string[] = [];
  const contentHashes: Record<string, string> = {};
  for (const entry of patchSet.patches) {
    let result;
    try {
      result = await service.codePatch(entry.path, unifiedDiffForFilePatch(entry), ctx);
    } catch (error) {
      throw new FilePatchSetApplyError(
        `宿主应用补丁失败：${entry.path}：${error instanceof Error ? error.message : String(error)}`,
        appliedPaths,
        entry.path,
      );
    }
    if (!result.ok) {
      throw new FilePatchSetApplyError(
        `宿主应用补丁失败：${entry.path}：${result.error ?? '未知错误'}`,
        appliedPaths,
        entry.path,
      );
    }
    if (!result.contentHash) {
      throw new FilePatchSetApplyError(`宿主未返回补丁内容 hash：${entry.path}`, appliedPaths, entry.path);
    }

    let after: string | null;
    try {
      after = await readOptional(service, entry.path, ctx);
    } catch (error) {
      throw new FilePatchSetApplyError(
        `补丁写入后无法读回：${entry.path}：${error instanceof Error ? error.message : String(error)}`,
        appliedPaths,
        entry.path,
      );
    }
    if (after !== entry.after) {
      throw new FilePatchSetApplyError(`补丁写入后内容校验失败：${entry.path}`, appliedPaths, entry.path);
    }
    const readBackHash = hashContent(after);
    if (result.contentHash !== readBackHash) {
      throw new FilePatchSetApplyError(`宿主返回的补丁内容 hash 不匹配：${entry.path}`, appliedPaths, entry.path);
    }
    if (entry.afterHash && readBackHash !== entry.afterHash) {
      throw new FilePatchSetApplyError(`补丁后置内容 hash 不匹配：${entry.path}`, appliedPaths, entry.path);
    }

    appliedPaths.push(entry.path);
    contentHashes[entry.path] = result.contentHash;
  }

  return { appliedPaths, contentHashes };
}
