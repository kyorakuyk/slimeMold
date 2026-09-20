import type {
  AgentConfig,
  AgentRouteTable,
  CostRecord,
  ExecContext,
  SandboxHandle,
} from '../types';
import type { ExperienceSink } from '../agents/experienceSink';
import type { Semaphore } from './rateLimiter';
import type { EventBus } from './runEvents';
import { emitNode } from './runEvents';
import { decideAgentCall as defaultDecideAgentCall } from '../agents/agentDecision';
import { matchExperience as defaultMatchExperience } from '../agents/experienceStore';
import { runLlmWithFallback as defaultRunLlmWithFallback, type RunLlmCallInput } from './runLlmCall';

type NodeLlmFunction = ExecContext['llm'];
type NodeLlmTools = {
  vars: Record<string, unknown>;
  storage: NonNullable<ExecContext['storage']>;
  sandbox: SandboxHandle | undefined;
};

type NodeLlmState = {
  activeWfId: string;
  workflowName: string;
  workflows: Record<string, { name?: string }>;
  agents: AgentConfig[];
  globalAgents?: AgentConfig[];
  agentRouteTable?: AgentRouteTable;
  defaultAgentId?: string | null;
  projectId?: string | null;
  llmChannel: 'backend' | 'frontend';
};

export interface NodeLlmAdapterOptions {
  node: {
    id: string;
    label: string;
    typeId: string;
    params?: Record<string, unknown>;
  };
  targetWfId: string;
  targetRunId: number;
  myRun: number;
  nodeCtx: { wfId: string; runId: number };
  runBus: EventBus;
  signal: AbortSignal;
  limiter: Semaphore;
  maxRetries: number;
  retryBaseMs: number;
  sink: ExperienceSink | null;
  getState: () => NodeLlmState;
  getTools: () => NodeLlmTools;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  logError: (message: string) => void;
  recordCost: (record: CostRecord) => void;
  decideAgentCall?: typeof defaultDecideAgentCall;
  runLlmWithFallback?: typeof defaultRunLlmWithFallback;
  matchExperience?: typeof defaultMatchExperience;
}

export function createNodeLlmAdapter(options: NodeLlmAdapterOptions): NodeLlmFunction {
  const decideAgentCall = options.decideAgentCall ?? defaultDecideAgentCall;
  const runLlmWithFallback = options.runLlmWithFallback ?? defaultRunLlmWithFallback;
  const matchExperience = options.matchExperience ?? defaultMatchExperience;

  return async (agentId, messages, onToken, modelOverride, toolNames) => {
    const state = options.getState();
    const requestedAgentId = agentId;
    const goal = options.targetWfId === state.activeWfId
      ? state.workflowName
      : (state.workflows[options.targetWfId]?.name ?? '');
    const { decision, routed, mergedAgents, routeLog } = decideAgentCall({
      requestedAgentId,
      typeId: options.node.typeId,
      params: options.node.params,
      agents: state.agents,
      globalAgents: state.globalAgents,
      routeTable: state.agentRouteTable,
      defaultAgentId: state.defaultAgentId,
      goal,
      projectId: state.projectId ?? '',
    });
    if (routed) {
      emitNode(options.runBus, 'node.progress', options.nodeCtx, options.node.id, {
        progressKind: 'agent-route',
        requestedAgentId: requestedAgentId ?? '',
        agentId: decision.agent.id,
        reason: decision.reason,
        chain: decision.chain,
        tier: decision.tier,
        category:
          typeof options.node.params?.category === 'string' && options.node.params.category.trim()
            ? options.node.params.category.trim()
            : undefined,
        topScores: decision.scores?.slice(0, 3).map((candidate) => ({
          agentId: candidate.agent.id,
          model: candidate.agent.model,
          score: Number(candidate.score.toFixed(2)),
          costPer1M: candidate.costPer1M,
        })),
      });
      options.logInfo(`「${options.node.label}」${routeLog}`);
    }

    const byId = (id: string) => mergedAgents.find((candidate) => candidate.id === id);
    const experienceState = options.getState();
    const expHits = matchExperience(experienceState.projectId ?? '', options.node.typeId);
    let effectiveMessages = messages;
    if (expHits.length > 0) {
      emitNode(options.runBus, 'node.progress', options.nodeCtx, options.node.id, {
        progressKind: 'experience',
        typeId: options.node.typeId,
        count: expHits.length,
        insights: expHits.map((experience) => experience.insights[0] ?? experience.summary),
      });
      options.logInfo(
        `「${options.node.label}」命中 ${expHits.length} 条历史经验（${options.node.typeId}），已注入提示词`,
      );
      const expText = expHits.map((experience) => `- ${experience.insights[0] ?? experience.summary}`).join('\n');
      const expBlock = `\n\n【历史经验参考（本项目「${options.node.typeId}」节点往期运行沉淀）】\n${expText}\n请结合上述经验优化本次执行，但不要机械照搬。`;
      if (messages.length > 0 && messages[0]!.role === 'system') {
        effectiveMessages = [
          { ...messages[0], content: `${messages[0].content}\n${expBlock}` },
          ...messages.slice(1),
        ];
      } else {
        effectiveMessages = [{ role: 'system' as const, content: expBlock }, ...messages];
      }
    }

    const tools = options.getTools();
    const finalState = options.getState();
    const input: RunLlmCallInput = {
      chainIds: decision.chain,
      byId,
      messages,
      effectiveMessages,
      onToken,
      modelOverride,
      toolNames,
      signal: options.signal,
      limiter: options.limiter,
      maxRetries: options.maxRetries,
      retryBaseMs: options.retryBaseMs,
      recordCost: options.recordCost,
      node: {
        id: options.node.id,
        label: options.node.label,
        typeId: options.node.typeId,
      },
      sink: options.sink,
      vars: tools.vars,
      toolStorage: tools.storage,
      toolSandbox: tools.sandbox,
      llmChannel: finalState.llmChannel,
      myRun: options.myRun,
      targetRunId: options.targetRunId,
      logger: {
        info: options.logInfo,
        warn: options.logWarn,
        error: options.logError,
      },
    };
    return runLlmWithFallback(input);
  };
}
