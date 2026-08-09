/**
 * experienceStore.ts — 结构化经验库（阶段 E：自我学习的可观测闭环）。
 *
 * 背景：现有 ExperienceSink（轨迹）+ reviewer（LLM 复盘 → memory.md / skill 草稿）是
 * 「人工审查式」学习，依赖 LLM 且受 selfImprove 开关控制。本模块补齐「结构化经验」通道：
 * - 运行收尾自动沉淀（写）：把本次运行的节点级结果（成功/失败/耗时）归约为一条
 *   ExperienceEntry（零 LLM 费用），入经验库持久化（localStorage，按 projectId 隔离）。
 * - 下次运行决策时消费（读）：按节点 typeId 匹配历史经验，把相关 insights 附到
 *   node.progress 事件与日志，供 UI 展示「本次决策参考了 N 条经验」，也可供未来
 *   AgentRouter / 提示注入使用。
 *
 * 设计原则：纯函数 + 模块级单例（localStorage 持久化），零 store / React 依赖。
 * 经验库是「项目级」的：同项目的不同工作流共享（跨工作流学到的教训适用全项目）。
 */

/** 单条经验：某类节点在项目历史中的运行教训。 */
export interface ExperienceEntry {
  id: string;
  /** 节点类型（typeId），消费时按此匹配 */
  typeId: string;
  /** 工作流 id（来源） */
  wfId: string;
  /** 运行代次（来源） */
  runId: number;
  /** 本次运行结局 */
  outcome: 'success' | 'failure';
  /** 实际调用的智能体 id（供成本感知路由统计成功率；无 LLM 节点时缺省） */
  agentId?: string;
  /** 一句话摘要（展示用） */
  summary: string;
  /** 提炼出的教训/建议（按条） */
  insights: string[];
  /** 墙钟时刻 */
  at: number;
}

const KEY_PREFIX = 'sm.experience.';
const MAX_ENTRIES = 100;

const cache = new Map<string, ExperienceEntry[]>();

function storageKey(projectId: string): string {
  return `${KEY_PREFIX}${projectId}`;
}

/** 读取某项目的经验库（localStorage；首次读入内存缓存）。 */
export function loadExperience(projectId: string): ExperienceEntry[] {
  const cached = cache.get(projectId);
  if (cached) return cached;
  let list: ExperienceEntry[] = [];
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (raw) list = JSON.parse(raw) as ExperienceEntry[];
  } catch {
    list = [];
  }
  cache.set(projectId, list);
  return list;
}

function persist(projectId: string, list: ExperienceEntry[]): void {
  cache.set(projectId, list);
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(list.slice(-MAX_ENTRIES)));
  } catch {
    /* 存储失败（隐私模式/超限）不影响运行 */
  }
}

/** 追加一条经验（按 projectId 隔离；去重同 typeId+runId）。返回是否新增。 */
export function addExperience(projectId: string, entry: ExperienceEntry): boolean {
  const list = loadExperience(projectId);
  if (list.some((e) => e.typeId === entry.typeId && e.runId === entry.runId)) return false;
  persist(projectId, [...list, entry]);
  return true;
}

/** 清空某项目全部经验。 */
export function clearExperience(projectId: string): void {
  cache.delete(projectId);
  try {
    localStorage.removeItem(storageKey(projectId));
  } catch {
    /* ignore */
  }
}

/** 删除单条经验（返回是否找到）。 */
export function removeExperience(projectId: string, id: string): boolean {
  const list = loadExperience(projectId);
  const next = list.filter((e) => e.id !== id);
  if (next.length === list.length) return false;
  persist(projectId, next);
  return true;
}

/**
 * 按 typeId 匹配历史经验，返回最新 N 条（默认 3）。
 * 消费侧：AgentRouter / executor 决策时把匹配经验摘要注入事件与日志。
 */
export function matchExperience(
  projectId: string,
  typeId: string,
  limit = 3,
): ExperienceEntry[] {
  const list = loadExperience(projectId);
  return list
    .filter((e) => e.typeId === typeId)
    .slice(-limit)
    .reverse();
}

/** 测试隔离：清空内存缓存（不动 localStorage，避免污染其它测试数据）。 */
export function resetExperienceCache(): void {
  cache.clear();
}

/* ---------------- 纯函数：从运行结果归约经验 ---------------- */

export interface ExperienceSource {
  projectId: string;
  wfId: string;
  runId: number;
  /** 本次运行终态 */
  status: 'success' | 'error' | 'aborted';
  /** 节点列表（含 status/outputs/error/durationMs） */
  nodes: Array<{
    id: string;
    typeId: string;
    status: string;
    error?: string | null;
    durationMs?: number | null;
    label?: string;
  }>;
  /** 节点实际调用 agent 映射（nodeId → agentId，来自 costLog；供成功率统计） */
  agentByNode?: Record<string, string>;
}

/** 失败教训：从失败的 error 消息提炼简短建议（首行截断）。 */
function lessonFromError(error: string | null | undefined): string {
  const s = (error ?? '').trim().split('\n')[0]?.trim() ?? '';
  return s ? `失败原因：${s.slice(0, 120)}` : '节点执行失败，建议检查参数与上游输入';
}

/**
 * 从一次运行的节点结果归约为经验条目列表（纯函数，可单测）。
 * - 失败节点：各生成一条 failure 经验（含教训）
 * - 成功节点：同 typeId 的聚合为一条 success 经验（含平均耗时）
 * - 全部成功无节点：不产出（无经验可学）
 * 每条经验含 insights（建议列表），供下次同类型节点运行时消费。
 */
export function summarizeExperience(src: ExperienceSource): ExperienceEntry[] {
  const out: ExperienceEntry[] = [];
  const failed = src.nodes.filter((n) => n.status === 'error' || n.status === 'failed');
  const succeeded = src.nodes.filter((n) => n.status === 'success');

  const agentOf = (nodeId: string): string | undefined => src.agentByNode?.[nodeId];

  // 失败节点逐条沉淀
  for (const n of failed) {
    out.push({
      id: `exp-${src.runId}-${n.id}-${Date.now().toString(36)}`,
      typeId: n.typeId,
      wfId: src.wfId,
      runId: src.runId,
      outcome: 'failure',
      agentId: agentOf(n.id),
      summary: `${n.label ?? n.typeId} 在 ${n.typeId} 节点上失败`,
      insights: [lessonFromError(n.error)],
      at: Date.now(),
    });
  }

  // 成功节点按 typeId 聚合
  const byType = new Map<string, Array<{ id: string; durationMs?: number | null }>>();
  for (const n of succeeded) {
    const arr = byType.get(n.typeId) ?? [];
    arr.push(n);
    byType.set(n.typeId, arr);
  }
  for (const [typeId, arr] of byType) {
    const avg = arr.reduce((s, n) => s + (n.durationMs ?? 0), 0) / arr.length;
    out.push({
      id: `exp-${src.runId}-${typeId}-${Date.now().toString(36)}`,
      typeId,
      wfId: src.wfId,
      runId: src.runId,
      outcome: 'success',
      agentId: agentOf(arr[0]!.id),
      summary: `${typeId} 成功执行 ×${arr.length}`,
      insights: [`该类型节点本轮成功，平均耗时 ${avg.toFixed(0)}ms；参数与上游输入可作为后续参考`],
      at: Date.now(),
    });
  }

  return out;
}

/* ---------------- Agent 运行指标统计（与 selfImprove 解耦，始终记录） ----------------
 * 2026-08-09 P2：成功率评分不应依赖 selfImprove 开关。
 * 独立的轻量指标（agentId + ok/fail 计数，不含 prompt/insights 等敏感内容）
 * 在每次运行收尾时无条件写入，供 routerScoring 评分使用。
 */

const METRIC_PREFIX = 'sm.metric.';
const metricCache = new Map<string, Record<string, { ok: number; fail: number }>>();

function metricKey(projectId: string): string {
  return `${METRIC_PREFIX}${projectId}`;
}

function loadMetrics(projectId: string): Record<string, { ok: number; fail: number }> {
  const cached = metricCache.get(projectId);
  if (cached) return cached;
  let m: Record<string, { ok: number; fail: number }> = {};
  try {
    const raw = localStorage.getItem(metricKey(projectId));
    if (raw) m = JSON.parse(raw) as typeof m;
  } catch {
    m = {};
  }
  metricCache.set(projectId, m);
  return m;
}

function persistMetrics(projectId: string, m: Record<string, { ok: number; fail: number }>): void {
  metricCache.set(projectId, m);
  try {
    localStorage.setItem(metricKey(projectId), JSON.stringify(m));
  } catch {
    /* 存储失败不影响运行 */
  }
}

/** 记录一次 Agent 调用结局（成功/失败）。幂等累加，可重复调用。 */
export function recordAgentOutcome(projectId: string, agentId: string, ok: boolean): void {
  if (!agentId || !projectId) return;
  const m = loadMetrics(projectId);
  const s = (m[agentId] ??= { ok: 0, fail: 0 });
  if (ok) s.ok += 1;
  else s.fail += 1;
  persistMetrics(projectId, m);
}

/** 测试隔离：清空指标缓存（不动 localStorage）。 */
export function resetMetricCache(): void {
  metricCache.clear();
}

/**
 * 按 agent 统计历史成功率（success / (success+failure)）。
 * 优先读独立指标（始终记录，不受 selfImprove 影响）；无指标时回退读经验库
 * （兼容旧数据，平滑过渡）。无数据返回空表（调用方缺省 0.5）。
 */
export function successRateByAgent(projectId: string): Record<string, number> {
  const out: Record<string, number> = {};
  const m = loadMetrics(projectId);
  for (const [id, s] of Object.entries(m)) {
    if (s.ok + s.fail === 0) continue;
    out[id] = s.ok / (s.ok + s.fail);
  }
  // 兼容：经验库中尚未迁移到独立指标的旧条目也计入
  const legacy = loadExperience(projectId);
  const legacyStats: Record<string, { ok: number; fail: number }> = {};
  for (const e of legacy) {
    if (!e.agentId) continue;
    const s = (legacyStats[e.agentId] ??= { ok: 0, fail: 0 });
    if (e.outcome === 'success') s.ok += 1;
    else s.fail += 1;
  }
  for (const [id, s] of Object.entries(legacyStats)) {
    if (out[id] !== undefined || s.ok + s.fail === 0) continue;
    out[id] = s.ok / (s.ok + s.fail);
  }
  return out;
}
