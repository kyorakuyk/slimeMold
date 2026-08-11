/**
 * H4 Node 执行层：仅 headless/CI（Node/tsx/vitest）环境可用的真实命令与文件操作。
 *
 * - 静态 import node:child_process（vite 构建经 shim 指向 src/dev/shims/node-child-process.ts，
 *   浏览器运行时调用会抛错）；
 * - fs 操作用动态 import('node:fs/promises')：vite 对 node: 前缀 externalize（浏览器构建成功，
 *   但运行时调用会 reject，由调用方捕获并返回明确错误）。
 */
import { execFile } from 'node:child_process';

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** 执行命令并捕获退出码/stdout/stderr（timeout 用 ms；非零退出码不抛错，返回结构）。 */
export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const start = Date.now();
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        if (!err) {
          resolveResult({ exitCode: 0, stdout: stdout ?? '', stderr: stderr ?? '', durationMs });
          return;
        }
        // execFile 错误可能带 code（数字退出码 / ENOENT 等字符串）
        const code = typeof (err as { code?: unknown }).code === 'number'
          ? ((err as { code: number }).code)
          : 1;
        resolveResult({
          exitCode: code,
          stdout: (stdout ?? '') as string,
          stderr: ((stderr ?? '') as string) || String(err.message ?? err),
          durationMs,
        });
      },
    );
  });
}

/** 读取文本文件（动态 import，仅 Node 环境可用）。 */
export async function readTextFile(absPath: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(absPath, 'utf8');
}

/** 写入文本文件（动态 import，仅 Node 环境可用）。 */
export async function writeTextFile(absPath: string, content: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(absPath, content, 'utf8');
}

/** 解析相对路径到绝对路径（防 ../ 逃逸：结果必须仍以 root 为前缀；仅 Node 环境可用）。 */
export async function resolveInside(root: string, relPath: string): Promise<string> {
  const { resolve } = await import('node:path');
  const abs = resolve(root, relPath);
  const rootNorm = resolve(root);
  if (abs !== rootNorm && !abs.startsWith(rootNorm + '/') && !abs.startsWith(rootNorm + '\\')) {
    throw new Error(`路径逃逸拒绝：${relPath}（root=${rootNorm}）`);
  }
  return abs;
}

/** 计算绝对路径相对于 root 的规范化相对路径（POSIX 分隔符，无 .. 段）。 */
export async function relativePath(root: string, abs: string): Promise<string> {
  const { relative } = await import('node:path');
  return relative(root, abs).replace(/\\/g, '/');
}
