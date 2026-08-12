/**
 * H4 路径规范化工具（审计修复）：
 * 相交判定 / 精确匹配统一使用 path.resolve（解析 . / ..，返回绝对路径）。
 * 用静态 import node:path：vite 构建经 alias 指向 shim（浏览器下仅构建不执行），
 * headless/CI/Node 下真实可用——本模块只在 Node 执行层被调用。
 */
import { resolve } from 'node:path';

/** 规范化绝对路径：resolve 解析 . / .. 后统一 POSIX 分隔符、去尾部 /。 */
export function normalizeAbsolutePath(p: string): string {
  return resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** A 是否为 B 的祖先（或等价）。两者需先 normalizeAbsolutePath。 */
export function isAncestorOrEqual(a: string, b: string): boolean {
  return a === b || b.startsWith(a + '/');
}

/**
 * baseDir 与 worktree 是否相交（任一为另一方的祖先/等价 → true）。
 * 使用 resolve 规范化，防止 `/repo/worktree2/../worktree/evidence` 这类折返绕过。
 */
export function pathsOverlap(baseDir: string, worktreePath: string): boolean {
  const b = normalizeAbsolutePath(baseDir);
  const w = normalizeAbsolutePath(worktreePath);
  return isAncestorOrEqual(b, w) || isAncestorOrEqual(w, b);
}
