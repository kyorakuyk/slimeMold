import { createNodeDef, type NodeDefinition } from '../../types/node';
import { type ExecContext } from '../../types/node';
import { type FilePatch, type MergeResult, type CouncilVerdict } from '../../types';
import { useWorkflowStore } from '../../store/workflowStore';
import { publishArtifactFromNode } from '../../engine/pipeline';

/**
 * 冲突协调者（Conflict Resolver / Merge Coordinator）：
 * 接收来自多条并行任务线的输出（每个输出应携带 scope 影响域声明），
 * 检测任意两个任务是否涉及同一文件/接口/抽象类（scope 交集）。
 * - 有冲突：走 `conflicts` 端口输出冲突清单（供人工/仲裁节点处理）
 * - 无冲突：走 `merged` 端口输出汇总的 scope 与结果
 * 框架层实现交并检测算法；真实「串行化重排」留给后续执行引擎增强。
 */
export const nodeResolver: NodeDefinition = {
  typeId: 'coord.resolver',
  name: '冲突协调者',
  category: '协调',
  description:
    '汇聚多路并行任务的输出，做逻辑冲突检查。支持两种输入：①对象自带 scope（TaskItem.scope）或连线 scope；②FilePatch（{path,before,after,readSnapshot}）内容级补丁。无逻辑冲突时「已合并」端口输出 MergeResult（按 path 汇总的补丁 + 需仲裁清单），建议下游接 Validator 校验后再落盘；有冲突时「冲突」端口输出清单，「建议串行顺序」给出按争用 scope 分组顺序。参数 mode=block 时冲突即阻断下游。',
  inputs: [
    { id: 'in1', label: '任务线1', type: 'any' },
    { id: 'in2', label: '任务线2', type: 'any' },
    { id: 'in3', label: '任务线3', type: 'any' },
    { id: 'in4', label: '任务线4', type: 'any' },
  ],
  outputs: [
    { id: 'merged', label: '已合并', type: 'json' },
    { id: 'conflicts', label: '冲突', type: 'list' },
    { id: 'serialOrder', label: '建议串行顺序', type: 'list' },
  ],
  params: [
    {
      key: 'mode',
      label: '冲突处理方式',
      type: 'select',
      default: 'report',
      options: [
        { value: 'report', label: '仅报告（输出冲突清单，不阻断）' },
        { value: 'block', label: '阻断（有冲突则报错，下游不执行）' },
      ],
    },
    {
      key: 'mergeMode',
      label: '合并策略',
      type: 'select',
      default: 'content',
      options: [
        { value: 'scope', label: '仅按 scope 字符串交集检测（旧逻辑）' },
        { value: 'content', label: '内容级 FilePatch 合并（推荐，带回滚快照识别）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const present = [inputs.in1, inputs.in2, inputs.in3, inputs.in4].filter((v) => v != null);

    // 步骤 11.1：scope 来源并存归一 + source 标记；步骤 11.6 方案②：readSnapshot 陈旧识别
    const collectScopes = (v: any): { scope: string[]; source: 'object' | 'edge' | 'both' | 'none' } => {
      const objScope = Array.isArray(v?.scope) ? (v.scope as string[]) : [];
      const edgeScope = Array.isArray(v?.edgeScope) ? (v.edgeScope as string[]) : [];
      if (objScope.length && edgeScope.length) return { scope: Array.from(new Set([...objScope, ...edgeScope])), source: 'both' };
      if (objScope.length) return { scope: objScope, source: 'object' };
      if (edgeScope.length) return { scope: edgeScope, source: 'edge' };
      return { scope: [], source: 'none' };
    };

    // 是否内容级合并模式：任一输入为 FilePatch / FilePatch[] 即启用
    const toPatches = (v: any): FilePatch[] => {
      if (Array.isArray(v)) return v.filter((p) => p && typeof p.path === 'string') as FilePatch[];
      if (v && typeof v.path === 'string') return [v as FilePatch];
      if (v && Array.isArray(v.patches)) return (v.patches as FilePatch[]).filter((p) => p && typeof p.path === 'string');
      // 允许 input.text 等以 JSON 字符串形式传递补丁（离线演示/外部注入场景）
      if (typeof v === 'string') {
        try {
          const parsed = JSON.parse(v);
          return toPatches(parsed);
        } catch {
          return [];
        }
      }
      return [];
    };
    const allPatches = present.flatMap(toPatches);
    const useContent = params.mergeMode === 'content' && allPatches.length > 0;

    if (useContent) {
      return resolveByContent(allPatches, present, params, ctx);
    }

    // ---- 旧逻辑：纯 scope 交集检测（作为 content 模式的 fallback） ----
    const entries = present.map((v, i) => {
      const { scope, source } = collectScopes(v);
      const vv = v as { label?: unknown; name?: unknown };
      const label =
        (vv.label && typeof vv.label === 'string') ? vv.label
        : (vv.name && typeof vv.name === 'string') ? vv.name
        : `任务线${i + 1}`;
      return { label, scope, source, value: v };
    });

    const conflicts: Array<{ a: string; b: string; overlap: string[] }> = [];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const overlap = entries[i].scope.filter((s) => entries[j].scope.includes(s));
        if (overlap.length > 0) conflicts.push({ a: entries[i].label, b: entries[j].label, overlap });
      }
    }

    const serialOrder: Array<{ scope: string[]; order: string[] }> = [];
    if (conflicts.length > 0) {
      const groups: Array<{ scope: string[]; members: Set<string> }> = [];
      for (const c of conflicts) {
        const hit = groups.find((g) => c.overlap.some((o) => g.scope.includes(o)));
        if (hit) {
          hit.scope = Array.from(new Set([...hit.scope, ...c.overlap]));
          hit.members.add(c.a); hit.members.add(c.b);
        } else {
          groups.push({ scope: [...c.overlap], members: new Set([c.a, c.b]) });
        }
      }
      for (const g of groups) {
        serialOrder.push({ scope: g.scope, order: entries.filter((e) => g.members.has(e.label)).map((e) => e.label) });
      }
    }

    if (conflicts.length > 0) {
      const detail = conflicts.map((c) => `- ${c.a} 与 ${c.b} 争用 ${c.overlap.join(', ')}`).join('\n');
      ctx.logger.error(`检测到 ${conflicts.length} 处任务冲突：${conflicts.map((c) => `${c.a}↔${c.b}`).join(', ')}`);
      if (params.mode === 'block') {
        const advise = serialOrder.length
          ? `\n建议串行化顺序：\n${serialOrder.map((g) => `  争用[${g.scope.join(', ')}]：${g.order.join(' → ')}`).join('\n')}`
          : '';
        throw new Error(`冲突协调者阻断执行：\n${detail}${advise}`);
      }
      return { merged: [], conflicts, serialOrder };
    }
    return { merged: present, conflicts: [], serialOrder: [] };
  },
};

/** 步骤 11.6 方案①②：内容级 FilePatch 合并 + readSnapshot 陈旧识别。 */
async function resolveByContent(patches: FilePatch[], _origins: unknown[], params: Record<string, unknown>, ctx: ExecContext) {
  const byPath = new Map<string, FilePatch[]>();
  for (const p of patches) {
    const arr = byPath.get(p.path) ?? [];
    arr.push(p);
    byPath.set(p.path, arr);
  }

  const merged: FilePatch[] = [];
  const needsArbitration: Array<{ path: string; candidates: FilePatch[] }> = [];
  const sources: Array<'object' | 'edge' | 'both'> = [];

  for (const [path, candidates] of byPath) {
    if (candidates.length === 1) {
      merged.push(candidates[0]);
      const s = candidates[0].readSnapshot?.source;
      if (s) sources.push(s);
      continue;
    }
    // 多候选：检测区间重叠 + 快照陈旧
    const stale = candidates.some((c) => c.readSnapshot?.hash && candidates.some((o) => o !== c && o.readSnapshot?.hash && o.readSnapshot.hash !== c.readSnapshot?.hash));
    const overlapRange = candidates.some((c) => {
      const [cs, ce] = c.readSnapshot?.lineRange ?? [0, Infinity];
      return candidates.some((o) => {
        if (o === c) return false;
        const [os, oe] = o.readSnapshot?.lineRange ?? [0, Infinity];
        return cs <= oe && os <= ce; // 区间相交
      });
    });
    if (stale || overlapRange) {
      needsArbitration.push({ path, candidates });
      ctx.logger.error(`路径 ${path} 存在 ${candidates.length} 份冲突补丁（快照陈旧或行区间重叠），交 council 仲裁`);
    } else {
      // 区间不重叠：按顺序拼接（简单合并，真实语义合并留给 Validator / 下游 LLM）
      merged.push({ path, before: candidates[0].before, after: candidates.map((c) => c.after).join('\n') });
      const s = candidates[0].readSnapshot?.source;
      if (s) sources.push(s);
    }
  }

  const result: MergeResult = { patches: merged, needsArbitration, sources };
  const conflictCount = needsArbitration.length;
  if (conflictCount > 0) {
    ctx.logger.error(`内容级合并检测到 ${conflictCount} 个文件需仲裁：${needsArbitration.map((n) => n.path).join(', ')}`);
    if (params.mode === 'block') {
      throw new Error(`冲突协调者阻断：${conflictCount} 个文件存在逻辑冲突，需 council 仲裁后再继续`);
    }
    return { merged: result, conflicts: needsArbitration, serialOrder: [] };
  }
  // 无冲突：merged 输出 MergeResult（建议下游接 Validator 校验后落盘，对应步骤 11.6 方案①）
  ctx.logger.info(`内容级合并完成：合并 ${merged.length} 个补丁，无逻辑冲突（建议下游接 Validator 校验）`);

  // 步骤 11 阶段 C：真沙箱模式——把各 Worker 车道的沙箱副本汇总落盘到主工作区
  if (ctx.sandbox && ctx.sandboxLanes?.length) {
    const committed = await ctx.sandbox.commitLanes(ctx.sandboxLanes);
    if (committed.length) {
      ctx.logger.info(`沙箱汇总：已将 ${committed.length} 个 Worker 产物提交到主工作区：${committed.join(', ')}`);
    } else {
      ctx.logger.info('沙箱汇总：上游车道无沙箱产物（可能未使用写文件节点）');
    }
  }

  return { merged: result, conflicts: [], serialOrder: [] };
}

/**
 * 仲裁委员会（Council）：
 * 对应 OMO-slim 的 Council agent 范式（步骤 11.7.1）。接收冲突双方/多方观点，
 * - 并行层：用多个「议员」智能体（councillorAgentIds，逗号分隔）各自独立评估（对应 OMO councillors）；
 * - 合成层：用独立的「合成」智能体（synthesizerAgentId，应不同于议员）提炼为单一裁决（对应 OMO synthesizer）；
 * - 共识评级：unanimous / majority / split（对应 OMO Consensus Rating）；
 * - 容错：部分议员失败则用成功者合成（对应 executor 的 skipFailed 语义）。
 * 仅在 coord.resolver 判定冲突后（经其 conflicts 端口）触发，避免每条线都跑（控制成本，对应 11.7 教训）。
 */
export const nodeCouncil: NodeDefinition = {
  typeId: 'coord.council',
  name: '仲裁委员会',
  category: '协调',
  role: 'orchestrator',
  whenToUse: '当 coord.resolver 的「冲突」端口输出后，需要把双方观点交多模型仲裁并产出单一裁决时使用；其输出可经 control 边回流 dispatch.split 或更上游重派。',
  description:
    '多模型并行仲裁节点（对标 OMO-slim Council）。并行层用多个议员智能体独立评估争议，合成层用独立合成智能体提炼单一裁决 verdict，并给出共识评级（unanimous/majority/split）与部分失败标记。仅在冲突时触发。',
  inputs: [
    { id: 'dispute', label: '争议观点', type: 'any' },
    { id: 'context', label: '背景上下文', type: 'any' },
    { id: 'question', label: '仲裁问题', type: 'text' },
  ],
  outputs: [
    { id: 'verdict', label: '裁决', type: 'json' },
    { id: 'councillors', label: '议员意见', type: 'list' },
    { id: 'consensus', label: '共识评级', type: 'text' },
    { id: 'backflow', label: '回流裁决', type: 'json', flow: 'control' },
  ],
  params: [
    {
      key: 'councillorAgentIds',
      label: '议员智能体（多选，并行评估）',
      type: 'agents',
      default: '',
    },
    {
      key: 'synthesizerAgentId',
      label: '合成智能体（应不同于议员）',
      type: 'agent',
      default: '',
    },
    {
      key: 'simulate',
      label: '离线模拟（无模型时回显）',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用 LLM）' },
        { value: 'on', label: '开启（回显角色链路，不调 LLM）' },
      ],
    },
    {
      key: 'pipelineStage',
      label: 'Pipeline 阶段标识（回流裁决落盘用）',
      type: 'text',
      default: 'design',
      placeholder: '如 design；留空不发布回流 Artifact',
      tooltip: '把裁决写入项目级黑板对应阶段，经 backflow 控制流端口回流上游重派。',
    },
  ],
  async execute(inputs, params, ctx) {
    const dispute = inputs.dispute;
    const context = inputs.context != null ? String(inputs.context) : '';
    const question = String(inputs.question ?? '请就上述争议给出裁决：应采用哪一方案，或如何融合？');

    const councillorIds = String(params.councillorAgentIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const synthId = String(params.synthesizerAgentId ?? '').trim();
    const simulate = String(params.simulate ?? 'off') === 'on';

    // 离线模拟且未配置议员时，用占位议员回显（便于无 agent 时验证链路，对应 OMO Council 手动触发范式）
    const effectiveCouncillors = councillorIds.length > 0
      ? councillorIds
      : (simulate ? ['councillor-a', 'councillor-b', 'councillor-c'] : []);
    const effectiveSynth = synthId || (simulate ? 'synthesizer' : '');

    if (effectiveCouncillors.length === 0) throw new Error('仲裁委员会：未配置议员智能体（councillorAgentIds）');
    if (!effectiveSynth) throw new Error('仲裁委员会：未配置合成智能体（synthesizerAgentId）');

    // 严格校验：非模拟模式下，指定的议员/合成 agent 必须存在。
    // 否则 ctx.llm 会对缺失 agent 静默兜底到全局候选（如 Ollama），
    // 造成「议员 agent-cheap 评估失败（Ollama...）」这类误导性日志，掩盖 agent 缺失的真实原因。
    if (!simulate) {
      const storeAgents0 = useWorkflowStore.getState().agents;
      // 兼容「按 id 或 名称」引用：known 同时含 id 与 name（大小写不敏感）
      const known = new Set<string>(
        storeAgents0.flatMap((a) => [a.id, a.name?.trim().toLowerCase()].filter(Boolean) as string[]),
      );
      const missing = [
        ...effectiveCouncillors.filter((id) => !known.has(id.trim().toLowerCase())).map((id) => `议员「${id}」`),
        ...(effectiveSynth && effectiveSynth !== 'synthesizer' && !known.has(effectiveSynth)
          ? [`合成智能体「${effectiveSynth}」`]
          : []),
      ];
      if (missing.length > 0) {
        // 附带 store 实际存在的 agent id 列表，便于诊断「id 拼写错」还是「store 没同步」
        const existing = storeAgents0.map((a) => a.id);
        throw new Error(
          `仲裁委员会：${missing.join('、')} 在智能体列表中不存在。` +
            `\n  · councillorAgentIds 参数 = ${JSON.stringify(effectiveCouncillors)}` +
            `\n  · synthesizerAgentId 参数 = ${JSON.stringify(effectiveSynth)}` +
            `\n  · 当前 store 实际存在的 agent id = ${JSON.stringify(existing)}` +
            `\n  · 请检查：① 节点参数与 Agent 面板里的 agent id 是否一致；② 工作流是否已保存/agents.json 是否已生成；③ 是否切换了项目导致 agent 未带入。`,
        );
      }
    }

    const disputeText = typeof dispute === 'string' ? dispute : JSON.stringify(dispute, null, 2);
    const basePrompt =
      `【仲裁背景】\n${context || '（无）'}\n\n` +
      `【争议观点】\n${disputeText}\n\n` +
      `【仲裁问题】\n${question}\n\n` +
      `请以「观点方 / 核心论据 / 倾向结论」三段式给出你的独立评估。`;

    // —— 并行层：各议员独立评估（对应 OMO councillors 并行扇形展开） ——
    const storeAgents = useWorkflowStore.getState().agents;
    const parallelTasks = effectiveCouncillors.map(async (agentId, i) => {
      const name = storeAgents.find((a) => a.id === agentId)?.name ?? agentId;
      if (simulate) {
        // 离线模拟：不调 LLM，占位回显（验证并行扇形结构）
        await new Promise((r) => setTimeout(r, 30));
        return {
          name,
          reply: `[离线模拟·议员${i + 1}] 针对争议给出独立评估意见（synthesizer 将综合此视角）。`,
          failed: false as boolean,
        };
      }
      try {
        const reply = await ctx.llm(agentId, [{ role: 'user', content: basePrompt }], undefined);
        return { name, reply, failed: false as boolean };
      } catch (e) {
        ctx.logger.error(`议员 ${name} 评估失败：${(e as Error).message}`);
        return { name, reply: '', failed: true as boolean };
      }
    });
    const councillors = await Promise.all(parallelTasks);
    const succeeded = councillors.filter((c) => !c.failed);
    const partialFailure = succeeded.length < councillors.length;

    if (succeeded.length === 0) {
      throw new Error('仲裁委员会：全部议员评估失败，无法合成裁决');
    }

    // —— 合成层：独立模型提炼单一裁决（对应 OMO synthesizer 与并行层分离） ——
    const synthPrompt =
      `你是仲裁主席。以下多位独立评估员对同一起争议给出了意见，请综合提炼为单一裁决。\n\n` +
      `【争议背景】\n${context || '（无）'}\n\n` +
      `【争议观点】\n${disputeText}\n\n` +
      `【各议员独立意见】\n` +
      succeeded.map((c, i) => `议员${i + 1}（${c.name}）：\n${c.reply}`).join('\n\n') +
      `\n\n请给出：①最终裁决 ②采纳了哪些意见/驳回了哪些 ③剩余不确定性。`;

    let verdict: string;
    if (simulate) {
      verdict =
        `[离线模拟·主席裁决] 综合 ${succeeded.length} 位议员意见，形成单一裁决（synthesizer=${effectiveSynth}）。\n` +
        `争议文件需按「保留双方非重叠改动 + 重叠区仲裁」原则合并。`;
    } else {
      verdict = await ctx.llm(effectiveSynth, [{ role: 'user', content: synthPrompt }], undefined);
    }

    // —— 共识评级（对应 OMO Consensus Rating） ——
    let consensus: CouncilVerdict['consensus'] = 'split';
    if (succeeded.length === councillors.length) {
      // 全部成功：粗判一致（真实分歧度可由主席 verdict 文本细化，此处给默认 unanimous）
      consensus = succeeded.length > 1 ? 'unanimous' : 'unanimous';
    } else {
      consensus = 'majority';
    }

    const result: CouncilVerdict = { verdict, councillors, consensus, partialFailure };
    ctx.logger.info(`仲裁完成：共识=${consensus}${partialFailure ? '（部分议员失败，已用成功者合成）' : ''}`);

    const decision = (consensus as CouncilVerdict['consensus']) === 'split' ? '需复议' : '采纳';
    const backflowPayload = buildBackflow({ consensus, decision, proposal: question });
    publishCouncilArtifact(params, result);

    // 声明下游可用分支（verdict 数据 + backflow 控制流端口，供回流上游重派）
    return {
      verdict: result,
      councillors: succeeded.map((c) => ({ name: c.name, reply: c.reply })),
      consensus,
      backflow: backflowPayload,
    };
  },
};

/** coord.council 回流裁决的形状（经 backflow 控制流端口回流上游重派）；参考 OMO 两层 + consensus 评级。 */
interface CouncilBackflow {
  consensus: CouncilVerdict['consensus'];
  decision: '采纳' | '需复议';
  proposal: string;
  rework: boolean; // true 表示建议上游重派（仅当 split/majority 且非采纳）
}

/** 依据共识评级构造回流裁决；对标 OMO「两层 + 共识评级」：unanimous/majority 视为可采纳，split 触发回流重派。 */
function buildBackflow(args: { consensus: CouncilVerdict['consensus']; decision: string; proposal: string }): CouncilBackflow {
  const rework = args.consensus === 'split' || args.decision === '需复议';
  return { consensus: args.consensus, decision: args.decision as '采纳' | '需复议', proposal: args.proposal, rework };
}

/** coord.council 执行完后，把裁决写入项目级黑板（跨工作流协作）。stage 由节点参数 pipelineStage 决定（默认 'design'）。 */
function publishCouncilArtifact(params: Record<string, unknown>, payload: CouncilVerdict): void {
  const stage = String(params.pipelineStage ?? '').trim();
  if (!stage) return;
  try {
    publishArtifactFromNode({ stage, kind: 'council', payload });
  } catch (e) {
    console.warn('[coord.council] 发布 council artifact 失败：', e);
  }
}

export const coordNodes: NodeDefinition[] = [nodeResolver, nodeCouncil].map(createNodeDef);
