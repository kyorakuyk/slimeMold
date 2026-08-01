// 无 UI 工作流运行器：不依赖 zustand store，适合 CLI / API / 测试场景。
// 复用与 executor 相同的执行内核（拓扑分层、缓存、分支剪枝、限流重试）。
import type { ExecContext, FlowEdge, FlowNode } from '../types';
import { topoLayers } from './topoSort';
import { getChannel } from '../agents/llmChannel';
import { scopedStorage } from '../platform/env';
import { Semaphore, withRetry } from './rateLimiter';
import {
  beginRun,
  cacheKey,
  countSkip,
  getCached,
  setCached,
  strike,
} from './nodeCache';
import { builtinDefs } from '../nodes/builtin';

function buildDefs(): Record<string, any> {
  const defs: Record<string, any> = {};
  for (const d of builtinDefs) defs[d.typeId] = d;
  return defs;
}

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 400;
const DEFAULT_CONCURRENCY = 4;

export interface HeadlessNodeResult {
  id: string;
  typeId: string;
  label: string;
  status: 'success' | 'error' | 'skipped' | 'cached';
  error?: string;
  outputs?: Record<string, unknown>;
  durationMs?: number;
}

export interface HeadlessRunOptions {
  channel?: 'frontend' | 'backend';
  concurrency?: number;
  vars?: Record<string, unknown>;
  agents?: { id: string; model: string; baseURL?: string; apiKey?: string; [k: string]: unknown }[];
  onNode?: (r: HeadlessNodeResult) => void;
  onToken?: (nodeId: string, text: string) => void;
  signal?: AbortSignal;
}

const noopLogger = {
  info: (_m: string) => {},
  error: (_m: string) => {},
};

/** 汇集上游输出：edge.targetHandle <- outputs[edge.source][edge.sourceHandle] */
function collectInputs(
  nodeId: string,
  edges: FlowEdge[],
  outputsMap: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const e of edges) {
    if (e.target !== nodeId) continue;
    const upstream = outputsMap.get(e.source);
    if (!upstream) continue;
    inputs[e.targetHandle ?? ''] = upstream[e.sourceHandle ?? ''];
  }
  return inputs;
}

export async function runWorkflowHeadless(
  graph: { nodes: FlowNode[]; edges: FlowEdge[] },
  opts: HeadlessRunOptions = {},
): Promise<{ results: HeadlessNodeResult[]; skipped: number }> {
  const { nodes, edges } = graph;
  const signal = opts.signal ?? new AbortController().signal;
  const agents = opts.agents ?? [];
  const vars = opts.vars ?? {};
  const limiter = new Semaphore(opts.concurrency ?? DEFAULT_CONCURRENCY);
  const channel = getChannel(opts.channel ?? 'backend');

  const outputsMap = new Map<string, Record<string, unknown>>();
  const defs = buildDefs();
  const branchState = new Map<string, Set<string | undefined>>();
  const cutSet = new Set<string>();
  const finalById = new Map<string, HeadlessNodeResult>();

  beginRun();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const { layers, cyclic } = topoLayers(
    nodes.map((n) => n.id),
    edges,
  );
  if (cyclic.length > 0) {
    for (const id of cyclic) {
      const n = nodeById.get(id);
      const r: HeadlessNodeResult = {
        id,
        typeId: n?.data.typeId ?? '?',
        label: n?.data.label ?? id,
        status: 'error',
        error: '检测到环路，无法执行',
      };
      finalById.set(id, r);
      opts.onNode?.(r);
    }
  }

  const collectDownstream = (id: string, acc: Set<string>) => {
    for (const e of edges) {
      if (e.source === id) {
        acc.add(e.target);
        collectDownstream(e.target, acc);
      }
    }
  };

  for (const layer of layers) {
    await Promise.all(
      layer.map(async (id) => {
        const node = nodeById.get(id);
        if (!node) return;
        const def = defs[node.data.typeId];
        const startedAt = Date.now();

        // 分支剪枝：所有入边均来自未激活分支 -> 整条子图跳过
        const incoming = edges.filter((e) => e.target === id);
        if (incoming.length > 0) {
          const allBlocked = incoming.every((e) => {
            const s = branchState.get(e.source);
            return s !== undefined && !s.has(e.sourceHandle ?? undefined);
          });
          if (allBlocked) {
            branchState.set(id, new Set());
            const r: HeadlessNodeResult = {
              id,
              typeId: node.data.typeId,
              label: node.data.label,
              status: 'skipped',
            };
            finalById.set(id, r);
            opts.onNode?.(r);
            collectDownstream(id, cutSet);
            return;
          }
        }

        if (!def || def.missing) {
          const r: HeadlessNodeResult = {
            id,
            typeId: node.data.typeId,
            label: node.data.label,
            status: 'error',
            error: `节点类型 ${node.data.typeId} 缺失（可能来自未加载的插件）`,
          };
          finalById.set(id, r);
          opts.onNode?.(r);
          return;
        }

        // 缓存命中判断
        const upstreamOutputs = collectInputs(id, edges, outputsMap);
        const key = cacheKey(node.data.typeId, node.data.params, upstreamOutputs);
        const cached = getCached(key);
        if (cached) {
          outputsMap.set(id, cached);
          branchState.set(id, new Set(def.outputs.map((o: any) => o.id)));
          countSkip();
          const r: HeadlessNodeResult = {
            id,
            typeId: node.data.typeId,
            label: node.data.label,
            status: 'cached',
            outputs: cached,
            durationMs: 0,
          };
          finalById.set(id, r);
          opts.onNode?.(r);
          return;
        }

        let branchesTaken: string[] | undefined;
        const ctx: ExecContext = {
          signal,
          logger: noopLogger,
          llm: async (agentId, messages, onToken, modelOverride) => {
            const agent =
              agents.find((a) => a.id === agentId) ?? {
                id: agentId || 'default',
                model: modelOverride || 'gpt-4o-mini',
                baseURL: undefined,
                apiKey: undefined,
              };
            const effective = modelOverride ? { ...agent, model: modelOverride } : agent;
            const release = await limiter.acquire();
            try {
              return await withRetry(
                () =>
                  channel.chat({
                    agent: effective as any,
                    messages,
                    signal,
                    onToken,
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
          setPartial: () => {},
          setBranches: (handles) => {
            branchesTaken = handles;
          },
          storage: scopedStorage('core'),
          vars,
          assets: [] as never,
          addAsset: () => {},
        };

        const inputs = collectInputs(id, edges, outputsMap);
        try {
          const result = await def.execute(inputs, node.data.params, ctx);
          outputsMap.set(id, result);
          branchState.set(
            id,
            branchesTaken
              ? new Set(branchesTaken)
              : new Set(def.outputs.map((o: any) => o.id)),
          );
          const r: HeadlessNodeResult = {
            id,
            typeId: node.data.typeId,
            label: node.data.label,
            status: 'success',
            outputs: result,
            durationMs: Date.now() - startedAt,
          };
          finalById.set(id, r);
          opts.onNode?.(r);
        } catch (err) {
          const r: HeadlessNodeResult = {
            id,
            typeId: node.data.typeId,
            label: node.data.label,
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startedAt,
          };
          finalById.set(id, r);
          opts.onNode?.(r);
        }
      }),
    );
  }

  return {
    results: Array.from(finalById.values()),
    skipped: 0,
  };
}
