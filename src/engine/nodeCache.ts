/**
 * 节点执行结果缓存层（运行时内存态，不持久化）。
 *
 * 设计目标：与 ComfyUI 的子图缓存一致——相同「节点类型 + 参数 + 上游输出」
 * 组合命中缓存时直接复用结果，跳过昂贵的重新执行（尤其是 LLM 调用）。
 *
 * 缓存 key：  `${scope}|${typeId}|${paramsHash}|${depsHash}`
 *  - scope：可选工作流/运行作用域（跨工作流隔离用，缺省空串保持向后兼容）
 *  - paramsHash：节点 params 的稳定序列化哈希
 *  - depsHash：所有上游节点 outputs 的稳定序列化哈希（拓扑序保证上游先就绪）
 *
 * 因为 key 已包含「上游输出」，所以上游任一变化都会使下游 key 改变、自动失效，
 * 无需额外的显式失效逻辑（除非通过 strike 强制清除某节点自身缓存）。
 *
 * 作用域维度：缓存隔离可逐级细化——调用方经 `composeCacheScope` 组合
 * 「wfId（跨工作流）→ nodeId（跨节点实例）→ workspaceDir（环境指纹）」多维度，
 * 避免不同工作流 / 同一工作流内不同节点实例 / 不同工作区上下文互相复用错误产物。
 * 缺省不传则保持原行为（共享纯计算缓存）。
 */

/** 组合缓存隔离作用域：过滤空段后用 `:` 连接。段顺序即隔离优先级。 */
export function composeCacheScope(...parts: Array<string | null | undefined>): string {
  return parts.filter((p) => p && p.trim()).join(':');
}

export interface CacheEntry {
  outputs: Record<string, unknown>;
  /** 分支节点上次成功运行声明的激活输出 handle；普通节点为空。 */
  branches?: string[];
  /** 命中次数（仅用于统计/调试） */
  hits: number;
  at: number;
}

const cache = new Map<string, CacheEntry>();
/** 当前运行内被强制跳过的缓存条目数（用于日志统计，每次运行前清零） */
let skippedThisRun = 0;
/** 当前运行内缓存命中/未命中/写入次数（每次运行前清零） */
let hitThisRun = 0;
let missThisRun = 0;
let writeThisRun = 0;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** 简单 53-bit 哈希（djb2 变体），碰撞概率极低，仅用于缓存 key 缩短 */
function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  // 转为无符号 36 进制，并补一个长度位降低冲突
  return `${input.length.toString(36)}_${(h >>> 0).toString(36)}`;
}

export function cacheKey(
  typeId: string,
  params: Record<string, unknown>,
  upstreamOutputs: Record<string, unknown>,
  scope = '',
): string {
  const paramsHash = hash(stableStringify(params));
  const depsHash = hash(stableStringify(upstreamOutputs));
  return `${scope}|${typeId}|${paramsHash}|${depsHash}`;
}

export function getCached(key: string): Record<string, unknown> | null {
  const entry = cache.get(key);
  if (!entry) {
    missThisRun++;
    return null;
  }
  entry.hits++;
  hitThisRun++;
  return entry.outputs;
}

export function getCachedBranches(key: string): string[] | undefined {
  const entry = cache.get(key);
  return entry?.branches ? [...entry.branches] : undefined;
}

export function setCached(
  key: string,
  outputs: Record<string, unknown>,
  branches?: readonly string[],
): void {
  cache.set(key, {
    outputs,
    branches: branches ? [...branches] : undefined,
    hits: 0,
    at: Date.now(),
  });
  writeThisRun++;
}

/** 强制清除某节点的缓存（重跑前调用），使其下次执行不被复用。
 * 兼容带 scope 前缀（`scope|typeId|...`）与不带 scope 两种 key 形态。 */
export function strike(typeId: string, scopePrefix?: string): void {
  const typeMarker = `|${typeId}|`;
  for (const k of Array.from(cache.keys())) {
    if (scopePrefix) {
      const inScope = k.startsWith(`${scopePrefix}|`) || k.startsWith(`${scopePrefix}:`);
      if (inScope && k.includes(typeMarker)) cache.delete(k);
      continue;
    }
    if (k === `${typeId}|` || k.startsWith(`${typeId}|`) || k.includes(typeMarker)) cache.delete(k);
  }
}

export function clearCache(): void {
  cache.clear();
}

export function beginRun(): void {
  skippedThisRun = 0;
  hitThisRun = 0;
  missThisRun = 0;
  writeThisRun = 0;
}

export function countSkip(): void {
  skippedThisRun++;
}

export function skippedCount(): number {
  return skippedThisRun;
}

export function cacheStats(): {
  hits: number;
  misses: number;
  writes: number;
  skipped: number;
  size: number;
} {
  return { hits: hitThisRun, misses: missThisRun, writes: writeThisRun, skipped: skippedThisRun, size: cache.size };
}

export function cacheSize(): number {
  return cache.size;
}
