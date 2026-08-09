/**
 * 步骤 14.F：Builder 生成「施工方 / 物业」两张工作流。
 *
 * 设计取舍（按「最顺手实现」反推定义）：
 * - 不操作画布、不查端口，直接拼 `WorkflowFile`（nodes/edges 轻量结构），复用现有
 *   `registerWorkflow` 注册进项目——用户在标签页直接看到生成图、可手改。
 * - 每个 worker 绑哪个 agent：按 `ModuleItem.category` 查 `agentRouteTable`（策略②，
 *   对齐 OMO 的 category 解耦 + slim 的可配模型）。路由表为空时用 `fallbackAgentId` 兜底，
 *   fallback 再缺失则留空（节点用默认 agent）。
 * - 暂不依赖 14.B 的 `pipeline.handoff`/`receive`（尚未实现），末端用 `output.text` 占位交付。
 */

import type { AgentRouteTable, ModuleItem, WorkflowFile, WorkflowFileEdge, WorkflowFileNode } from '../types';

let _seq = 0;
function uid(prefix: string): string {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq}`;
}

/**
 * 按 category 解析「最终可用」agentId（Builder 注入阶段，含 fallback 链）：
 * 1. 类别主 agentId 存在且可用 → 用它；
 * 2. 否则沿该行 fallback[] 依次取第一个存在的；
 * 3. 类别行全失效 → 落全局 fallbackAgentId（若存在）；
 * 4. 都没有 → undefined（不注入，由运行时全局路由兜底）。
 * 类别大小写不敏感匹配。
 */
export function resolveAgentForCategory(
  category: ModuleItem['category'],
  routeTable: AgentRouteTable,
  fallbackAgentId: string | null,
  agents?: { id: string }[],
): string | undefined {
  const exists = (id?: string | null): id is string =>
    !!id && (!agents || agents.some((a) => a.id === id));
  const key = (category ?? 'data').toLowerCase();
  const entry = routeTable[key] ?? routeTable['data'];
  // 1) 类别主 agent
  if (exists(entry?.agentId)) return entry!.agentId;
  // 2) 该行 fallback 链
  for (const f of entry?.fallback ?? []) {
    if (exists(f)) return f;
  }
  // 3) 全局 fallback
  if (exists(fallbackAgentId)) return fallbackAgentId;
  // 4) 无可用
  return undefined;
}

function node(
  typeId: string,
  label: string,
  position: { x: number; y: number },
  params: Record<string, unknown> = {},
): WorkflowFileNode {
  return { id: uid(typeId.replace(/\W/g, '_')), typeId, label, position, params };
}

function edge(
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  kind: 'data' | 'task' | 'control' = 'data',
  scope?: string[],
): WorkflowFileEdge {
  return { id: uid('e'), source, sourceHandle, target, targetHandle, kind, scope };
}

const COL = 320;
const ROW = 160;

/**
 * 生成施工方工作流：
 * input.text → dispatch.split → [worker.implementer × modules] → coord.resolver
 *   → (conflicts) coord.council → (backflow control) resolver
 *   → worker.validator → output.text
 */
export function buildConstructionWorkflow(args: {
  modules: ModuleItem[];
  routeTable: AgentRouteTable;
  fallbackAgentId: string | null;
  /** 用于判断 agent 是否存在的列表（缺失/禁用的 agent 会被 fallback 链跳过） */
  agents?: { id: string }[];
  name?: string;
}): WorkflowFile {
  const { modules, routeTable, fallbackAgentId, agents } = args;
  const wfNodes: WorkflowFileNode[] = [];
  const wfEdges: WorkflowFileEdge[] = [];

  const input = node('input.text', '设计输入', { x: 0, y: 0 });
  const split = node('dispatch.split', '任务派发', { x: COL, y: 0 });
  wfNodes.push(input, split);
  wfEdges.push(edge(input.id, 'text', split.id, 'tasks'));

  const workers: WorkflowFileNode[] = [];
  const SPLIT_TASK_PORTS = ['task1', 'task2', 'task3', 'task4'];
  modules.forEach((m, i) => {
    const agentId = resolveAgentForCategory(m.category, routeTable, fallbackAgentId, agents);
    const w = node(
      'worker.implementer',
      `实现·${m.name}`,
      { x: COL * 2, y: i * ROW },
      {
        task: m.responsibility ?? m.name,
        scope: m.scope ?? [],
        // F4：把模块类别写入 params.category，供运行时 AgentRouter 类别路由与失败 fallback 使用
        ...(m.category ? { category: m.category } : {}),
        ...(agentId ? { agentId } : {}),
      },
    );
    wfNodes.push(w);
    workers.push(w);
    // dispatch.split 输出端口为 task1~task4；超出 4 个的模块并入 rest 端口（list，下游仍可收）
    const splitPort = i < SPLIT_TASK_PORTS.length ? SPLIT_TASK_PORTS[i] : 'rest';
    wfEdges.push(edge(split.id, splitPort, w.id, 'plan', 'task', m.scope));
  });

  const resolver = node('coord.resolver', '冲突协调者', { x: COL * 3, y: 0 });
  wfNodes.push(resolver);
  workers.forEach((w, i) => {
    // coord.resolver 输入端口为 in1~in4（any 类型，可接 worker 的 code 输出）
    const resolverPort = `in${(i % 4) + 1}`;
    wfEdges.push(edge(w.id, 'code', resolver.id, resolverPort, 'data', w.params.scope as string[]));
  });

  const council = node('coord.council', '仲裁委员会', { x: COL * 4, y: ROW });
  wfNodes.push(council);
  wfEdges.push(edge(resolver.id, 'conflicts', council.id, 'dispute', 'control'));
  wfEdges.push(edge(council.id, 'backflow', resolver.id, 'in1', 'control'));

  const validator = node('worker.validator', '校验工', { x: COL * 4, y: -ROW }, { mode: 'project' });
  wfNodes.push(validator);
  wfEdges.push(edge(resolver.id, 'merged', validator.id, 'code', 'data'));

  // 14.D 施工期闭环：validator 验收失败经 flow.loopGate 回指 split 重派，最多 maxLoops 轮仍失败则停止（不交付次品）
  const loopGate = node('flow.loopGate', '施工迭代闸门', { x: COL * 5, y: ROW }, { expression: 'i < 3', maxLoops: 3, loopVar: 'i' });
  wfNodes.push(loopGate);
  wfEdges.push(edge(validator.id, 'fail', loopGate.id, 'cond', 'control'));
  wfEdges.push(edge(loopGate.id, 'pass', split.id, 'rerun', 'control'));

  // 末端用 pipeline.handoff 交付（14.B 接替原 output.text 占位），stage 固定 construction
  const scopeNote = modules
    .flatMap((m) => (Array.isArray(m.scope) ? m.scope : []))
    .filter(Boolean)
    .join(', ');
  const out = node('pipeline.handoff', '交付施工成果', { x: COL * 5, y: -ROW }, { stage: 'construction', kind: 'project', ...(scopeNote ? { meta: `施工模块 scope: ${scopeNote}` } : {}) });
  wfNodes.push(out);
  // validator 验收通过走 data 边直接交付；loopGate 终止分支（多次仍 fail）不交付次品，留空终止
  wfEdges.push(edge(validator.id, 'report', out.id, 'payload', 'data'));

  return {
    version: 1,
    name: args.name ?? '施工方工作流（Builder 生成）',
    savedAt: new Date().toISOString(),
    nodes: wfNodes,
    edges: wfEdges,
    agents: [],
    roles: [],
    variables: {},
    assets: [],
    groups: [],
    belongsToProject: undefined,
    standalonePath: undefined,
  };
}

/**
 * 生成物业运维工作流（轻量，跨工作流接收施工成果）：
 * pipeline.receive（读 stage=construction 的施工交付）→ worker.validator（整项目验收）→ output.text
 */
export function buildOpsWorkflow(args: {
  fallbackAgentId: string | null;
  name?: string;
}): WorkflowFile {
  const recv = node('pipeline.receive', '接收施工成果', { x: 0, y: 0 }, { stage: 'construction', kind: 'project', onError: 'error' });
  const validator = node(
    'worker.validator',
    '物业验收',
    { x: COL, y: 0 },
    { mode: 'project', ...(args.fallbackAgentId ? { agentId: args.fallbackAgentId } : {}) },
  );
  const out = node('output.text', '运维交付', { x: COL * 2, y: 0 });
  return {
    version: 1,
    name: args.name ?? '物业运维工作流（Builder 生成）',
    savedAt: new Date().toISOString(),
    nodes: [recv, validator, out],
    edges: [
      edge(recv.id, 'payload', validator.id, 'code', 'data'),
      edge(validator.id, 'report', out.id, 'text', 'data'),
    ],
    agents: [],
    roles: [],
    variables: {},
    assets: [],
    groups: [],
    belongsToProject: undefined,
    standalonePath: undefined,
  };
}
