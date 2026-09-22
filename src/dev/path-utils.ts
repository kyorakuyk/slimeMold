/**
 * H4 路径规范化工具（审计修复）：
 * 相交判定 / 精确匹配统一使用 path.resolve（解析 . / ..，返回绝对路径）。
 * headless/CI/Node 下走 node:path（真实文件系统语义）；
 * GUI（Tauri WebView）下 node:path 被 vite shim 掉（resolve 退化为 join），
 * 改用纯前端实现 normalizePathWeb（不依赖 node:path，供 Tauri deps 注入）。
 */
import { resolve } from 'node:path';

/** 规范化绝对路径：resolve 解析 . / .. 后统一 POSIX 分隔符、去尾部 /。 */
export function normalizeAbsolutePath(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  const resolved = isWindowsPath(normalized)
    ? resolveWeb(normalized, '.')
    : resolve(normalized);
  return resolved.replace(/\\/g, '/').replace(/\/+$/, '');
}

function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:\//.test(p) || p.startsWith('//');
}

/** 用于路径相交/冲突判断的稳定 key；Windows 文件系统默认大小写不敏感。 */
export function pathComparisonKey(p: string): string {
  const normalized = normalizeAbsolutePath(p);
  return isWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
}

/** 纯 WebView 路径比较 key；不调用 node:path，供 Tauri 的 resolveWeb 结果使用。 */
export function pathComparisonKeyWeb(p: string): string {
  const normalized = resolveWeb(p, '.').replace(/\/+$/, '');
  return isWindowsPath(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * 纯前端路径解析（GUI/浏览器环境，不依赖 node:path）：
 * - 解析 . / .. 段；
 * - 统一 POSIX 分隔符（Windows 盘符 `C:/...` 保留）；
 * - 相对路径基于当前工作目录（Tauri WebView 无 process.cwd，仅用于 worktree 内相对解析）。
 * 仅用于 Tauri deps 注入（resolveInside/relativePath 的替代实现），安全语义由
 * capabilities 的 assertPathAllowed + worktree 登记校验兜底。
 */
export function resolveWeb(root: string, rel: string): string {
  const norm = (s: string) => s.replace(/\\/g, '/');
  const rootNorm = norm(root);
  const relNorm = norm(rel);
  const isUnc = rootNorm.startsWith('//');
  const parts = (rootNorm + '/' + relNorm).split('/');
  // 绝对路径判定：首段为空（POSIX 以 / 开头）或首段是 Windows 盘符（C:）
  const isDrive = (s: string) => /^[A-Za-z]:$/.test(s);
  const abs = parts[0] === '' || isDrive(parts[0]);
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // Windows 盘符（C:）与根目录不弹
      if (out.length > 0 && out[out.length - 1] !== '..' && !isDrive(out[out.length - 1])) {
        out.pop();
      } else if (!abs) {
        out.push('..');
      }
      continue;
    }
    out.push(seg);
  }
  let joined = out.join('/');
  if (!abs && out.length === 0) joined = '.';
  if (abs) {
    // Windows 盘符段已进 out（如 'C:/repo/...'）；POSIX 补根 /；UNC 保留 //。
    if (isUnc) joined = '//' + joined;
    else if (!isDrive(parts[0])) joined = '/' + joined;
  }
  return joined;
}

/** 计算 abs 相对 root 的规范化相对路径（POSIX 分隔符；GUI 用）。 */
export function relativeWeb(root: string, abs: string): string {
  const r = resolveWeb(root, '.').replace(/\/+$/, '');
  const a = resolveWeb(abs, '.').replace(/\/+$/, '');
  const comparison = (value: string) => isWindowsPath(value) ? value.toLowerCase() : value;
  const comparisonRoot = comparison(r);
  const comparisonAbs = comparison(a);
  if (comparisonAbs === comparisonRoot) return '.';
  if (comparisonAbs.startsWith(comparisonRoot + '/')) return a.slice(r.length + 1);
  // 不共享前缀时逐级回溯
  const rp = r.split('/').filter(Boolean);
  const ap = a.split('/').filter(Boolean);
  let i = 0;
  while (i < rp.length && i < ap.length && comparison(rp[i]) === comparison(ap[i])) i++;
  return [...rp.slice(i).map(() => '..'), ...ap.slice(i)].join('/') || '.';
}

/** A 是否为 B 的祖先（或等价）。两者需先 normalizeAbsolutePath。 */
export function isAncestorOrEqual(a: string, b: string): boolean {
  const ancestor = pathComparisonKey(a);
  const descendant = pathComparisonKey(b);
  return ancestor === descendant || descendant.startsWith(ancestor + '/');
}

/**
 * baseDir 与 worktree 是否相交（任一为另一方的祖先/等价 → true）。
 * 使用 resolve 规范化，防止 `/repo/worktree2/../worktree/evidence` 这类折返绕过。
 */
export function pathsOverlap(baseDir: string, worktreePath: string): boolean {
  return isAncestorOrEqual(baseDir, worktreePath) || isAncestorOrEqual(worktreePath, baseDir);
}
