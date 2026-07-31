/**
 * Headless 工作流执行器（无 UI / 无 zustand store 依赖）。
 *
 * 与路线 B（feature/backend-engine）的关系：本文件是「整图在 JS 侧无界面执行」
 * 的最小可用切片——可作为未来 Rust 执行内核的 JS 参考实现，并复用同一套
 * LLMChannel 抽象（ctx.llm → backend 通道走 Rust chat_completion 命令）。
 *
 * 设计目标：
 *  - 不读取任何前端 store，状态全部在调用方传入的 opts 中（agents/roles/variables）。
 *  - 复用 builtinDefs、topoLayers、nodeCache、evalExpr、getChannel，与编辑器执行引擎一致。
 *  - 支持分支剪枝（setBranches）、结果缓存（nodeCache）、LLM 并发限流与限流重试。
 *  - 进度通过 onNode / onToken 回调外发，便于上层（Tauri 命令 / CLI）回传。
 */

import type {
  AgentConfig,
  RoleTemplate,
  WorkflowEdge,
  WorkflowNode,
  PortType,
} from '../types';
import { arePortsCompatible } from '../types';
import { topoLayers } from './topoSort';
import { nodeCache, cacheKey, getCached, setCached, beginRun, countSkip, skippedCount } from './nodeCache';
import { Semaphore, withRetry } from './rateLimiter';
import { evalExpr } from './expr';
import { builtinDefs } from '../nodes/builtin';
import { getChannel } from '../agents/llmChannel';

export type HeadlessNodeStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'skipped'
  | 'cached';

export interface HeadlessNodeResult {
  nodeId: string;
  typeId: string;
  status: HeadlessNodeStatus;
  outputs: Record<string, unknown> | null;
  error?: string;
  durationMs: number | null;
  startedAt: string | null;
}

export interface RunHeadlessOptions {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  agents: AgentConfig[];
  roles?: RoleTemplate[];
  variables?: Record<string, unknown>;
  /** LLM 通道；默认 backend（密钥不出前端层） */
  channel?: 'backend' | 'frontend';
  maxConcurrency?: number;
  /** 是否做端口类型校验（默认 true） */
  validatePorts?: boolean;
  signal?: AbortSignal;
  onNode?: (r: HeadlessNodeResult) => void;
  onToken?: (nodeId: string, delta: string) => void;
}

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;

export async function runWorkflowHeadless(
  opts: RunHeadlessOptions,
): Promise<HeadlessNodeResult[]> {
  const signal = opts.signal ?? new AbortController().signal;
  const channel = getChannel(opts.channel ?? 'backend');
  const variables = opts.variables ?? {};
  const agents = opts.agents;
  const roles = opts.roles ?? [];
  const limiter = new Semaphore(opts.maxConcurrency ?? 3);
  const validate = opts.validatePorts ?? true;

  const defs = new Map(builtinDefs.map((d) => [d.typeId, d]));
  // 允许覆盖：编辑器侧已注册（插件）的节点可一并传入
  // （此处 headless 仅用 builtinDefs；插件节点若需 headless 支持，后续扩展）

  const nodeMap = new Map(opts.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, WorkflowEdge[]>();
  const incoming = new Map<string, WorkflowEdge[]>();
  for (const e of opts.edges) {
    (outgoing.get(e.source) ?? outgoing.set(e.source, []).get(e.source)!).push(e);
    (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e);
  }

  // 分支剪枝：activeBranches[nodeId] = 该节点允许的输出 handle 集合（undefined = 全部）
  const branchState = new Map<string, Set<string> | undefined>();
  const setBranches = (handles: string[]) => {
    branchState.set(currentNodeId!, new Set(handles));
  };
  let currentNodeId: string | null = null;

  const outputs = new Map<string, Record<string, unknown>>();

  const isDownstreamCut = (nodeId: string): boolean => {
    // 若该节点有入边来自被剪枝的 handle，则跳过
    const ins = incoming.get(nodeId) ?? [];
    for (const e of ins) {
      const allow = branchState.get(e.source);
      if (allow && !allow.has(e.sourceHandle ?? '')) return true;
    }
    return false;
  };

  const gatherInputs = (nodeId: string): Record<string, unknown> => {
    const ins = incoming.get(nodeId) ?? [];
    const collected: Record<string, unknown> = {};
    for (const e of ins) {
      const srcOut = outputs.get(e.source);
      if (!srcOut) continue;
      const val = srcOut[e.sourceHandle ?? 'value'];
      if (e.targetHandle) collected[e.targetHandle] = val;
      else collected.value = val;
    }
    return collected;
  };

  const results: HeadlessNodeResult[] = [];

  const emit = (r: HeadlessNodeResult) => {
    results.push(r);
    opts.onNode?.(r);
  };

  // 简易作用域存储（节点间持久化，运行时内存态）
  const scopedStore = {
    m: new Map<string, unknown>(),
    get(k: string) {
      return this.m.get(k);
    },
    set(k: string, v: unknown) {
      this.m.set(k, v);
    },
  };

  const executeOne = async (node: WorkflowNode): Promise<HeadlessNodeResult> => {
    const def = defs.get(node.typeId);
    if (!def) {
      const r: HeadlessNodeResult = {
        nodeId: node.id,
        typeId: node.typeId,
        status: 'error',
        outputs: null,
        error: `未找到节点定义: ${node.typeId}`,
        durationMs: null,
        startedAt: null,
      };
      emit(r);
      return r;
    }

    if (isDownstreamCut(node.id)) {
      const r: HeadlessNodeResult = {
        nodeId: node.id,
        typeId: node.typeId,
        status: 'skipped',
        outputs: null,
        durationMs: null,
        startedAt: null,
      };
      emit(r);
      return r;
    }

    // 端口类型校验（入边）
    if (validate) {
      const ins = incoming.get(node.id) ?? [];
      for (const e of ins) {
        const srcDef = defs.get(nodeMap.get(e.source)?.typeId ?? '');
        const srcPort = srcDef?.outputs.find((p) => p.id === e.sourceHandle);
        const tgtPort = def.inputs.find((p) => p.id === e.targetHandle);
        if (!arePortsCompatible(srcPort?.type as PortType, tgtPort?.type as PortType)) {
          const r: HeadlessNodeResult = {
            nodeId: node.id,
            typeId: node.typeId,
            status: 'error',
            outputs: null,
            error: `端口类型不兼容: ${e.source}.${e.sourceHandle}(${srcPort?.type}) → ${node.id}.${e.targetHandle}(${tgtPort?.type})`,
            durationMs: null,
            startedAt: null,
          };
          emit(r);
          return r;
        }
      }
    }

    const inputs = gatherInputs(node.id);
    const startedAt = new Date().toISOString();
    const t0 = performance.now();

    // 缓存判定（与编辑器执行器一致：key 含上游输出）
    const key = cacheKey(node.typeId, node.params ?? {}, inputs);
    const cached = getCached(key);
    if (cached) {
      outputs.set(node.id, cached);
      countSkip();
      const r: HeadlessNodeResult = {
        nodeId: node.id,
        typeId: node.typeId,
        status: 'cached',
        outputs: cached,
        durationMs: 0,
        startedAt,
      };
      emit(r);
      return r;
    }

    emit({
      nodeId: node.id,
      typeId: node.typeId,
      status: 'running',
      outputs: null,
      durationMs: null,
      startedAt,
    });

    const ctx = {
      signal,
      vars: variables,
      logger: { info: () => {}, error: () => {}, warn: () => {} },
      setPartial: (outputId: string, value: unknown) => {
        const cur = outputs.get(node.id) ?? {};
        cur[outputId] = value;
        outputs.set(node.id, cur);
        opts.onNode?.({
          nodeId: node.id,
          typeId: node.typeId,
          status: 'running',
          outputs: cur,
          durationMs: null,
          startedAt,
        });
      },
      setBranches,
      storage: {
        get: (k: string) => scopedStore.get(k),
        set: (k: string, v: unknown) => scopedStore.set(k, v),
      },
      // 代理调用：把局部 state 包成 ctx.llm
      llm: async (
        agentId: string,
        messages: { role: string; content: string }[],
        onToken?: (t: string) => void,
        modelOverride?: string,
      ): Promise<string> => {
        const agent = agents.find((a) => a.id === agentId);
        if (!agent) throw new Error(`智能体不存在: ${agentId}`);
        const effective = modelOverride ? { ...agent, model: modelOverride } : agent;
        const release = await limiter.acquire();
        try {
          return await withRetry(
            () =>
              channel.chat({
                agent: effective,
                messages,
                signal,
                onToken: (t) => {
                  onToken?.(t);
                  opts.onToken?.(node.id, t);
                },
              }),
            {
              retries: MAX_RETRIES,
              baseDelay: RETRY_BASE_MS,
              signal,
              onRetry: () => {},
            },
          );
        } finally {
          release();
        }
      },
    };

    try {
      currentNodeId = node.id;
      const out = await def.execute(inputs, node.params ?? {}, ctx as any);
      outputs.set(node.id, out);
      setCached(key, out);
      const r: HeadlessNodeResult = {
        nodeId: node.id,
        typeId: node.typeId,
        status: 'success',
        outputs: out,
        durationMs: Math.round(performance.now() - t0),
        startedAt,
      };
      emit(r);
      return r;
    } catch (err) {
      const r: HeadlessNodeResult = {
        nodeId: node.id,
        typeId: node.typeId,
        status: 'error',
        outputs: null,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Math.round(performance.now() - t0),
        startedAt,
      };
      emit(r);
      return r;
    }
  };

  beginRun();
  const { layers, cyclic } = topoLayers(
    opts.nodes.map((n) => n.id),
    opts.edges.map((e) => ({ source: e.source, target: e.target })),
  );
  if (cyclic.length > 0) {
    throw new Error(`存在环路，无法执行: ${cyclic.join(', ')}`);
  }

  for (const layer of layers) {
    if (signal.aborted) throw new Error('已中止');
    await Promise.all(layer.map((id) => executeOne(nodeMap.get(id)!)));
  }

  return results;
}
