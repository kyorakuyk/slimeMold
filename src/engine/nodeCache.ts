/**
 * 节点执行结果缓存层（运行时内存态，不持久化）。
 *
 * 设计目标：与 ComfyUI 的子图缓存一致——相同「节点类型 + 参数 + 上游输出」
 * 组合命中缓存时直接复用结果，跳过昂贵的重新执行（尤其是 LLM 调用）。
 *
 * 缓存 key：  `${typeId}|${paramsHash}|${depsHash}`
 *  - paramsHash：节点 params 的稳定序列化哈希
 *  - depsHash：所有上游节点 outputs 的稳定序列化哈希（拓扑序保证上游先就绪）
 *
 * 因为 key 已包含「上游输出」，所以上游任一变化都会使下游 key 改变、自动失效，
 * 无需额外的显式失效逻辑（除非通过 strike 强制清除某节点自身缓存）。
 */

export interface CacheEntry {
  outputs: Record<string, unknown>;
  /** 命中次数（仅用于统计/调试） */
  hits: number;
  at: number;
}

const cache = new Map<string, CacheEntry>();
/** 当前运行内被强制跳过的缓存条目数（用于日志统计，每次运行前清零） */
let skippedThisRun = 0;

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
): string {
  const paramsHash = hash(stableStringify(params));
  const depsHash = hash(stableStringify(upstreamOutputs));
  return `${typeId}|${paramsHash}|${depsHash}`;
}

export function getCached(key: string): Record<string, unknown> | null {
  const entry = cache.get(key);
  if (!entry) return null;
  entry.hits++;
  return entry.outputs;
}

export function setCached(key: string, outputs: Record<string, unknown>): void {
  cache.set(key, { outputs, hits: 0, at: Date.now() });
}

/** 强制清除某节点的缓存（重跑前调用），使其下次执行不被复用 */
export function strike(typeId: string): void {
  for (const k of Array.from(cache.keys())) {
    if (k.startsWith(`${typeId}|`)) cache.delete(k);
  }
}

export function clearCache(): void {
  cache.clear();
}

export function beginRun(): void {
  skippedThisRun = 0;
}

export function countSkip(): void {
  skippedThisRun++;
}

export function skippedCount(): number {
  return skippedThisRun;
}

export function cacheSize(): number {
  return cache.size;
}
