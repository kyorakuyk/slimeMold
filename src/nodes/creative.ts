import type { NodeDefinition, ChatMessage, ContentPart } from '../types';
import { useWorkflowStore } from '../store/workflowStore';
import { findRole, resolveRoleSystem } from '../agents/agentManager';

/**
 * 创作域业务节点：灵感板 / 构思精炼 / 设计师 / 设计评审。
 * 执行逻辑复用 agent.chat 的模式——绑定角色 + 节点级系统提示词 + 离线模拟回显，
 * 让"idea 节点""设计师节点"成为可拖拽、可编排的创意流水线节点。
 */

/** 与 agent.chat 一致的核心 LLM 调用（含离线模拟回显），供创作节点复用 */
async function runCreativeLLM(
  opts: {
    agentId: string;
    roleId: string;
    system: string;
    modelOverride: string;
    simulate: string;
    prompt: string;
    outKey: string;
    ctx: Parameters<NodeDefinition['execute']>[2];
    roleDefaultName?: string; // 用于模拟回显时的默认角色名提示
  },
): Promise<Record<string, unknown>> {
  const { agentId, roleId, system, modelOverride, simulate, prompt, outKey, ctx } = opts;

  const roles = useWorkflowStore.getState().roles;
  const role = findRole(roles, roleId || undefined);
  const resolvedSystem = resolveRoleSystem(role, system);
  const isolated = role?.contextScope === 'isolated';

  // 离线模拟模式：按角色链路回显，不发起真实 LLM 调用
  if (simulate === 'on') {
    const roleTag = role
      ? `${role.icon ? role.icon + ' ' : ''}${role.name}（${isolated ? '隔离上下文' : '共享上下文'}）`
      : `（未绑定角色${opts.roleDefaultName ? `；建议绑定「${opts.roleDefaultName}」` : ''}）`;
    const agent = useWorkflowStore.getState().agents.find((a) => a.id === agentId);
    const modelTag = modelOverride || agent?.model || '—';
    const lines = [
      `【离线模拟 · 角色链路回显】`,
      `角色：${roleTag}`,
      `智能体：${agent ? agent.name : '（未绑定）'}`,
      `模型：${modelTag}`,
      `上下文：${isolated ? 'isolated（独立）' : 'shared（共用全局）'}`,
      ``,
      `— 系统提示词 —`,
      resolvedSystem || '（无）',
      ``,
      `— 用户输入 —`,
      prompt,
      ``,
      `— 模拟回复 —`,
      `[模拟模式未调用真实 LLM。关闭"离线模拟模式"并绑定可用智能体后，此处将替换为模型实际输出。]`,
    ];
    let acc = '';
    for (const seg of lines) {
      acc += (acc ? '\n' : '') + seg;
      ctx.setPartial(outKey, acc);
      await new Promise((r) => setTimeout(r, 15));
    }
    ctx.logger.info(`离线模拟 角色=${role?.name ?? '无'} prompt ${prompt.length} 字`);
    return { [outKey]: acc };
  }

  // 真实调用
  if (!agentId) {
    throw new Error('未绑定智能体，请在右侧面板选择（或开启离线模拟模式）');
  }
  const messages: ChatMessage[] = [];
  if (resolvedSystem) messages.push({ role: 'system' as const, content: resolvedSystem });
  messages.push({ role: 'user' as const, content: prompt });

  ctx.logger.info(
    `创作节点请求${role ? ` 角色=${role.name}` : ''}${modelOverride ? ` 模型=${modelOverride}` : ''} prompt ${prompt.length} 字`,
  );

  let acc = '';
  const text = await ctx.llm(
    agentId,
    messages,
    (delta) => {
      acc += delta;
      ctx.setPartial(outKey, acc);
    },
    modelOverride || undefined,
  );
  return { [outKey]: text };
}

/** 灵感板：输入主题，发散出 N 条创意点子 */
const ideaBoard: NodeDefinition = {
  typeId: 'idea.board',
  name: '灵感板',
  category: '文本',
  description:
    '给定主题/约束，让绑定的创意角色发散出若干条独立创意点子，输出 list 便于下游筛选或循环。',
  inputs: [{ id: 'topic', label: '主题', type: 'text' }],
  outputs: [{ id: 'ideas', label: '点子', type: 'list' }],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    { key: 'count', label: '发散条数', type: 'number', default: 5 },
    {
      key: 'system',
      label: '系统提示词（覆盖角色）',
      type: 'textarea',
      default:
        '你是一位创意总监。请围绕主题产出多条相互独立、有差异化的创意点子。每条以「1. 」「2. 」编号列出，每条一句话概括核心想法，不要解释。',
      placeholder: '可选；留空则使用所绑定角色的系统提示词',
    },
    {
      key: 'modelOverride',
      label: '节点级模型（留空用智能体默认）',
      type: 'text',
      default: '',
      placeholder: '如 gpt-4o-mini',
    },
    {
      key: 'simulate',
      label: '离线模拟模式',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用）' },
        { value: 'on', label: '开启（离线回显）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const topic = String(inputs.topic ?? '');
    if (!topic) throw new Error('缺少主题（topic 端口未接入数据）');
    const count = Number(params.count ?? 5) || 5;
    const prompt = `主题：${topic}\n\n请产出 ${count} 条创意点子。`;

    // 离线模拟时直接返回占位列表，便于无模型时验证连线
    if (String(params.simulate ?? 'off') === 'on') {
      const demo: string[] = Array.from(
        { length: count },
        (_, i) => `示例点子 ${i + 1}：关于「${topic}」的差异化构思`,
      );
      let acc = demo.join('\n');
      ctx.setPartial('ideas', acc);
      return { ideas: demo };
    }

    const text = (await runCreativeLLM({
      agentId: String(params.agentId ?? ''),
      roleId: String(params.roleId ?? ''),
      system: String(params.system ?? ''),
      modelOverride: String(params.modelOverride ?? ''),
      simulate: 'off',
      prompt,
      outKey: 'ideas',
      ctx,
      roleDefaultName: '创意总监',
    })) as { ideas: string };

    // 将编号文本解析为 list，便于下游按条目迭代
    const list = text.ideas
      .split(/\n+/)
      .map((s) => s.replace(/^\s*\d+[.、)]\s*/, '').trim())
      .filter(Boolean);
    return { ideas: list.length ? list : [text.ideas] };
  },
};

/** 构思精炼：从多条点子里收敛成一份可执行方案 */
const ideaRefine: NodeDefinition = {
  typeId: 'idea.refine',
  name: '构思精炼',
  category: '文本',
  description: '将多条创意点子（list）筛选、合并、深化，输出一份连贯的可执行概念文案。',
  inputs: [
    { id: 'ideas', label: '点子', type: 'list' },
    { id: 'brief', label: '补充要求', type: 'text' },
  ],
  outputs: [{ id: 'concept', label: '概念', type: 'text' }],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    {
      key: 'system',
      label: '系统提示词（覆盖角色）',
      type: 'textarea',
      default:
        '你是产品策划。请基于给定的多条点子，提炼出一份精炼、可执行的概念方案：先一句话定义核心价值，再列出 3 个关键特性。语言简洁。',
      placeholder: '可选；留空则使用所绑定角色的系统提示词',
    },
    {
      key: 'modelOverride',
      label: '节点级模型（留空用智能体默认）',
      type: 'text',
      default: '',
      placeholder: '如 gpt-4o-mini',
    },
    {
      key: 'simulate',
      label: '离线模拟模式',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用）' },
        { value: 'on', label: '开启（离线回显）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const ideasRaw = inputs.ideas;
    const ideas = Array.isArray(ideasRaw)
      ? ideasRaw.map(String)
      : String(ideasRaw ?? '');
    const brief = String(inputs.brief ?? '');
    const ideaText = Array.isArray(ideas) ? ideas.map((s, i) => `${i + 1}. ${s}`).join('\n') : ideas;
    if (!ideaText.trim()) throw new Error('缺少点子输入（ideas 端口未接入数据）');
    const prompt = `候选点子：\n${ideaText}\n${brief ? `\n补充要求：${brief}` : ''}\n\n请输出精炼概念方案。`;

    return runCreativeLLM({
      agentId: String(params.agentId ?? ''),
      roleId: String(params.roleId ?? ''),
      system: String(params.system ?? ''),
      modelOverride: String(params.modelOverride ?? ''),
      simulate: String(params.simulate ?? 'off'),
      prompt,
      outKey: 'concept',
      ctx,
      roleDefaultName: '产品策划',
    }) as Promise<Record<string, unknown>>;
  },
};

/** 设计师：把概念出成设计稿描述/规范 */
const designerGenerate: NodeDefinition = {
  typeId: 'designer.generate',
  name: '设计师',
  category: 'AI',
  description:
    '绑定"设计师"角色，把概念方案转化为具体设计稿规范（布局、视觉、交互要点），输出可供评审的 spec 文本。',
  inputs: [
    { id: 'concept', label: '概念', type: 'text' },
    { id: 'ref', label: '参考素材', type: 'image' },
  ],
  outputs: [{ id: 'spec', label: '设计稿', type: 'text' }],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    {
      key: 'system',
      label: '系统提示词（覆盖角色）',
      type: 'textarea',
      default:
        '你是一位资深产品设计师。请基于概念方案产出设计稿规范：包含信息架构、关键界面布局、视觉风格（配色/字体/质感）、核心交互流程。结构清晰、可直接交付评审。',
      placeholder: '可选；留空则使用所绑定角色的系统提示词',
    },
    {
      key: 'modelOverride',
      label: '节点级模型（留空用智能体默认）',
      type: 'text',
      default: '',
      placeholder: '如 gpt-4o',
    },
    {
      key: 'simulate',
      label: '离线模拟模式',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用）' },
        { value: 'on', label: '开启（离线回显）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const concept = String(inputs.concept ?? '');
    if (!concept) throw new Error('缺少概念输入（concept 端口未接入数据）');
    const ref = inputs.ref != null ? String(inputs.ref) : '';
    let prompt = `概念方案：\n${concept}\n\n请产出设计稿规范。`;
    const messages: ChatMessage[] = [];
    // 复用 runCreativeLLM 时无法传图片，故 ref 仅在模拟/真实提示里体现
    if (ref) prompt += `\n（附参考素材：${ref.slice(0, 80)}…）`;

    // 离线模拟：带图片链路回显
    if (String(params.simulate ?? 'off') === 'on') {
      const roles = useWorkflowStore.getState().roles;
      const role = findRole(roles, String(params.roleId || '') || undefined);
      const roleTag = role
        ? `${role.icon ? role.icon + ' ' : ''}${role.name}`
        : '（未绑定角色；建议绑定「设计师」）';
      const agent = useWorkflowStore.getState().agents.find((a) => a.id === String(params.agentId ?? ''));
      const lines = [
        `【离线模拟 · 设计师节点】`,
        `角色：${roleTag}`,
        `智能体：${agent ? agent.name : '（未绑定）'}`,
        `参考素材：${ref ? '已接入' : '无'}`,
        ``,
        `— 概念方案 —`,
        concept,
        ``,
        `— 模拟设计稿规范 —`,
        `[模拟模式未调用真实 LLM。关闭离线模拟并绑定可用智能体后，此处替换为模型实际产出的设计稿规范。]`,
      ];
      let acc = '';
      for (const seg of lines) {
        acc += (acc ? '\n' : '') + seg;
        ctx.setPartial('spec', acc);
        await new Promise((r) => setTimeout(r, 15));
      }
      return { spec: acc };
    }

    if (!String(params.agentId ?? '')) {
      throw new Error('未绑定智能体，请在右侧面板选择（或开启离线模拟模式）');
    }
    const resolvedSystem = resolveRoleSystem(
      findRole(useWorkflowStore.getState().roles, String(params.roleId || '') || undefined),
      String(params.system ?? ''),
    );
    const llmMessages: ChatMessage[] = [];
    if (resolvedSystem) llmMessages.push({ role: 'system' as const, content: resolvedSystem });
    if (ref) {
      const parts: ContentPart[] = [{ type: 'text', text: prompt }];
      const isDataUrl = ref.startsWith('data:');
      const mediaType = isDataUrl ? ref.slice(5, ref.indexOf(';')) || 'image/png' : undefined;
      parts.push({ type: 'image', url: ref, mediaType });
      llmMessages.push({ role: 'user' as const, content: parts });
    } else {
      llmMessages.push({ role: 'user' as const, content: prompt });
    }
    let acc = '';
    const text = await ctx.llm(
      String(params.agentId),
      llmMessages,
      (delta) => {
        acc += delta;
        ctx.setPartial('spec', acc);
      },
      String(params.modelOverride || '') || undefined,
    );
    return { spec: text };
  },
};

/** 设计评审：批判性评价设计稿，给出问题与评分 */
const designReview: NodeDefinition = {
  typeId: 'design.review',
  name: '设计评审',
  category: 'AI',
  description: '对设计稿规范做批判性评审，输出评审意见文本与 0-10 评分，便于迭代闭环。',
  inputs: [
    { id: 'spec', label: '设计稿', type: 'text' },
    { id: 'goal', label: '评审目标', type: 'text' },
  ],
  outputs: [
    { id: 'review', label: '评审意见', type: 'text' },
    { id: 'score', label: '评分', type: 'number' },
  ],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    {
      key: 'system',
      label: '系统提示词（覆盖角色）',
      type: 'textarea',
      default:
        '你是一位严格的设计评审专家。请指出设计稿在可用性、一致性、可行性上的问题，并给出 0-10 的评分。先给「评分：X/10」，再列要点。',
      placeholder: '可选；留空则使用所绑定角色的系统提示词',
    },
    {
      key: 'modelOverride',
      label: '节点级模型（留空用智能体默认）',
      type: 'text',
      default: '',
      placeholder: '如 gpt-4o',
    },
    {
      key: 'simulate',
      label: '离线模拟模式',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用）' },
        { value: 'on', label: '开启（离线回显）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const spec = String(inputs.spec ?? '');
    if (!spec) throw new Error('缺少设计稿输入（spec 端口未接入数据）');
    const goal = String(inputs.goal ?? '');
    const prompt = `设计稿：\n${spec}\n${goal ? `\n评审目标：${goal}` : ''}\n\n请输出评审意见与评分。`;

    const res = (await runCreativeLLM({
      agentId: String(params.agentId ?? ''),
      roleId: String(params.roleId ?? ''),
      system: String(params.system ?? ''),
      modelOverride: String(params.modelOverride ?? ''),
      simulate: String(params.simulate ?? 'off'),
      prompt,
      outKey: 'review',
      ctx,
      roleDefaultName: '设计评审专家',
    })) as { review: string };

    // 从评审文本中解析 "评分：X/10" 或 "X/10"
    const m = res.review.match(/评分[:：]?\s*(\d{1,2})(?:\s*\/\s*10)?/);
    const score = m ? Math.max(0, Math.min(10, Number(m[1]))) : NaN;
    return { review: res.review, score: Number.isNaN(score) ? 0 : score };
  },
};

export const creativeNodes: NodeDefinition[] = [
  ideaBoard,
  ideaRefine,
  designerGenerate,
  designReview,
];
