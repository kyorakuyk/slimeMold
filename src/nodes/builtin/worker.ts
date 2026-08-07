import { createNodeDef, type NodeDefinition, type ExecContext, type ChatMessage } from '../../types';
import { useWorkflowStore } from '../../store/workflowStore';
import { findRole, resolveRoleSystem } from '../../agents/agentManager';

/** 取绑定 agentId / 角色系统提示词 / 模型覆写；模拟模式直接回显装配结果 */
async function resolveWorkerCtx(
  params: Record<string, unknown>,
  ctx: ExecContext,
  defaultSystem: string,
  kindLabel: string,
): Promise<{
  agentId: string;
  system: string;
  modelOverride: string;
  simulate: boolean;
}> {
  const agentId = String(params.agentId ?? '');
  const roleId = String(params.roleId ?? '');
  const roles = useWorkflowStore.getState().roles;
  const role = findRole(roles, roleId || undefined);
  const system = resolveRoleSystem(role, String(params.system ?? '')) || defaultSystem;
  const modelOverride = String(params.modelOverride ?? '').trim();
  const simulate = String(params.simulate ?? 'off') === 'on';
  if (!simulate && !agentId)
    throw new Error(`[${kindLabel}] 未绑定智能体，请在右侧面板选择（或开启离线模拟模式）`);
  ctx.logger.info(
    `${kindLabel}${role ? ` 角色=${role.name}` : ''}${modelOverride ? ` 模型=${modelOverride}` : ''}`,
  );
  return { agentId, system, modelOverride, simulate };
}

/** 模拟模式：回显装配结果（不调 LLM），供无模型时验证链路 */
async function simulateWorker(
  ctx: ExecContext,
  kindLabel: string,
  system: string,
  parts: string[],
): Promise<string> {
  const lines = [`【离线模拟 · ${kindLabel}】`, `— 系统提示词 —`, system || '（无）', '', ...parts];
  let acc = '';
  for (const seg of lines) {
    acc += (acc ? '\n' : '') + seg;
    ctx.setPartial('out', acc);
    await new Promise((r) => setTimeout(r, 20));
  }
  ctx.logger.info(`离线模拟完成 ${kindLabel}`);
  return acc;
}

const workerScaffolder: NodeDefinition = {
  typeId: 'worker.scaffolder',
  name: '架构师',
  category: 'worker',
  description:
    '根据上游规格（spec）生成实现计划：文件树骨架 + 分步任务说明。一次 LLM 调用产出结构化 plan。',
  inputs: [
    { id: 'spec', label: '规格', type: 'text' },
    { id: 'context', label: '上下文', type: 'text' },
  ],
  outputs: [{ id: 'plan', label: '实现计划', type: 'text' }],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    { key: 'modelOverride', label: '节点级模型（留空用默认）', type: 'text', default: '' },
    { key: 'system', label: '系统提示词（覆盖默认）', type: 'textarea', default: '' },
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
    if (!spec) throw new Error('架构师缺少规格输入（spec 端口）');
    const context = inputs.context != null ? String(inputs.context) : '';
    const { system, simulate } = await resolveWorkerCtx(
      params,
      ctx,
      '你是资深软件架构师。依据给定规格输出实现计划：文件树骨架与分步任务，条理清晰、可交予实现工执行。',
      '架构师',
    );
    if (simulate) {
      return {
        plan: await simulateWorker(ctx, '架构师', system, [
          `— 规格 —`,
          spec,
          context ? `— 上下文 —\n${context}` : '',
          `— 模拟产出：实现计划 —`,
          '[模拟模式：关闭后此处为模型生成的文件树 + 分步任务]',
        ]),
      };
    }
    const messages: ChatMessage[] = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({
      role: 'user',
      content: `规格：\n${spec}${context ? `\n\n附加上下文：\n${context}` : ''}`,
    });
    const agentId = String(params.agentId ?? '');
    const modelOverride = String(params.modelOverride ?? '').trim();
    let acc = '';
    const plan = await ctx.llm(agentId, messages, (d) => {
      acc += d;
      ctx.setPartial('plan', acc);
    }, modelOverride || undefined);
    return { plan };
  },
};

const workerImplementer: NodeDefinition = {
  typeId: 'worker.implementer',
  name: '实现工',
  category: 'worker',
  description:
    '依据上游实现计划（plan）编写代码，输出 code。一次 LLM 调用产出。',
  inputs: [
    { id: 'plan', label: '实现计划', type: 'text' },
    { id: 'context', label: '上下文', type: 'text' },
  ],
  outputs: [{ id: 'code', label: '代码', type: 'text' }],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    { key: 'modelOverride', label: '节点级模型（留空用默认）', type: 'text', default: '' },
    { key: 'system', label: '系统提示词（覆盖默认）', type: 'textarea', default: '' },
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
    const plan = String(inputs.plan ?? '');
    if (!plan) throw new Error('实现工缺少实现计划输入（plan 端口）');
    const context = inputs.context != null ? String(inputs.context) : '';
    const { system, simulate } = await resolveWorkerCtx(
      params,
      ctx,
      '你是资深工程师。依据实现计划编写完整、可运行的代码，只输出代码与必要注释。',
      '实现工',
    );
    if (simulate) {
      return {
        code: await simulateWorker(ctx, '实现工', system, [
          `— 实现计划 —`,
          plan,
          context ? `— 上下文 —\n${context}` : '',
          `— 模拟产出：代码 —`,
          '[模拟模式：关闭后此处为模型生成的代码]',
        ]),
      };
    }
    const messages: ChatMessage[] = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({
      role: 'user',
      content: `实现计划：\n${plan}${context ? `\n\n附加上下文：\n${context}` : ''}`,
    });
    const agentId = String(params.agentId ?? '');
    const modelOverride = String(params.modelOverride ?? '').trim();
    let acc = '';
    const code = await ctx.llm(agentId, messages, (d) => {
      acc += d;
      ctx.setPartial('code', acc);
    }, modelOverride || undefined);
    return { code };
  },
};

const workerValidator: NodeDefinition = {
  typeId: 'worker.validator',
  name: '校验工（自主）',
  category: 'worker',
  description:
    '自主节点试点：对代码按标准自我评估，不合格时带批评意见返回重跑修订，最多 maxIter 轮。对外仍是单一输入/输出端口（混合路线：节点内部管微观自主）。',
  inputs: [
    { id: 'code', label: '代码', type: 'text' },
    { id: 'criteria', label: '验收标准', type: 'text' },
  ],
  outputs: [
    { id: 'verdict', label: '结论(pass/fail)', type: 'text' },
    { id: 'report', label: '评审报告', type: 'text' },
    { id: 'iterations', label: '迭代轮数', type: 'text' },
    { id: 'fail', label: '验收失败(控制流)', type: 'any', flow: 'control' },
  ],
  params: [
    { key: 'agentId', label: '绑定智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    { key: 'modelOverride', label: '节点级模型（留空用默认）', type: 'text', default: '' },
    {
      key: 'mode',
      label: '验收模式',
      type: 'select',
      default: 'block',
      options: [
        { value: 'block', label: '单块评审（逐代码块 PASS/FAIL + 修订闭环）' },
        { value: 'project', label: '整项目验收（把输入当完整交付物做集成测试）' },
      ],
    },
    { key: 'maxIter', label: '最大迭代轮数', type: 'number', default: 3 },
    { key: 'system', label: '系统提示词（覆盖默认）', type: 'textarea', default: '' },
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
    const code = String(inputs.code ?? '');
    if (!code) throw new Error('校验工缺少代码输入（code 端口）');
    const criteria = inputs.criteria != null ? String(inputs.criteria) : '交付物应正确、可运行、符合要求。';
    const maxIter = Math.max(1, Number(params.maxIter ?? 3) || 1);
    const mode = String(params.mode ?? 'block');
    const { system, simulate, modelOverride } = await resolveWorkerCtx(
      params,
      ctx,
      '你是严格的代码评审。先给出 PASS/FAIL 判定，再给简洁的改进意见。若 FAIL，指出必须修正的点。',
      '校验工',
    );

    // —— 整项目验收模式（14.D）：把输入当完整交付物做集成测试，单轮判定，不回贴修订代码 ——
    if (mode === 'project') {
      if (simulate) {
        const ok = code.trim().length > 0;
        const sim = await simulateWorker(ctx, '校验工（整项目验收·模拟）', system, [
          `— 整项目交付物 —`,
          code.slice(0, 500),
          `— 验收标准 —`,
          criteria,
          `— 模拟产出：${ok ? '判定 PASS（输入非空）' : '判定 FAIL（输入为空）'} —`,
        ]);
        if (!ok) ctx.setBranches?.(['fail']);
        return { verdict: ok ? 'pass(sim)' : 'fail(sim)', report: sim, iterations: '1' };
      }
      const messages: ChatMessage[] = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({
        role: 'user',
        content:
          `【整项目验收 / 集成测试】你正在验收整个项目交付物，而不是单文件代码块。\n` +
          `验收标准：\n${criteria}\n\n` +
          `项目交付物（可能含多个模块/文件，已合并）：\n${code}\n\n` +
          `请检查模块间接口对接、依赖完整性、能否组装运行。先给 PASS/FAIL 判定，再给验收报告（列出通过项与遗留问题）。`,
      });
      let acc = '';
      const out = await ctx.llm(String(params.agentId ?? ''), messages, (d) => {
        acc += d;
        ctx.setPartial('report', acc);
      }, modelOverride || undefined);
      const verdict = /^\s*PASS\b/i.test(out) || /\bPASS\b/i.test(out.split('\n')[0] ?? '') ? 'pass' : 'fail';
      if (verdict === 'fail') ctx.setBranches?.(['fail']);
      return { verdict, report: out, iterations: '1' };
    }

    // —— 单块评审模式（默认，保持原有逐块 PASS/FAIL + 修订闭环）——
    if (simulate) {
      const sim = await simulateWorker(ctx, '校验工（自主·模拟）', system, [
        `— 代码 —`,
        code.slice(0, 500),
        `— 验收标准 —`,
        criteria,
        `— 模拟产出：判定 PASS（模拟不真正迭代） —`,
      ]);
      return { verdict: 'pass(sim)', report: sim, iterations: '1' };
    }

    const agentId = String(params.agentId ?? '');
    let current = code;
    let lastReport = '';
    let verdict = 'fail';
    for (let i = 1; i <= maxIter; i++) {
      ctx.logger.info(`校验工 第 ${i}/${maxIter} 轮评估`);
      const messages: ChatMessage[] = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({
        role: 'user',
        content:
          `验收标准：\n${criteria}\n\n当前代码（第 ${i} 轮）：\n${current}` +
          (i > 1 ? `\n\n上一轮评审意见：\n${lastReport}\n请重新评估；若仍 FAIL 请直接给出修订后的完整代码。` : ''),
      });
      let acc = '';
      const out = await ctx.llm(agentId, messages, (d) => {
        acc += d;
        ctx.setPartial('report', `第${i}轮:\n${acc}`);
      }, modelOverride || undefined);
      lastReport = out;
      current = extractRevisedCode(out, current);
      if (/^\s*PASS\b/i.test(out) || /\bPASS\b/i.test(out.split('\n')[0] ?? '')) {
        verdict = 'pass';
        break;
      }
      verdict = 'fail';
    }
    return { verdict, report: lastReport, iterations: String(maxIter) };
  },
};

/** 从评审输出中抽取「修订后的完整代码」：优先取 ```lang 代码块，否则回退原文 */
function extractRevisedCode(out: string, fallback: string): string {
  const m = out.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return m ? m[1].trim() : fallback;
}

export const workerNodes: NodeDefinition[] = [
  workerScaffolder,
  workerImplementer,
  workerValidator,
].map(createNodeDef);
