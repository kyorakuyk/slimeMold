import { createNodeDef, type NodeDefinition, type ModuleItem, type TaskItem, type ChatMessage } from '../../types';
import { useWorkflowStore } from '../../store/workflowStore';
import { findRole, resolveRoleSystem } from '../../agents/agentManager';
import { getArtifact, publishArtifactFromNode, type ArtifactKind } from '../../engine/pipeline';
import { buildConstructionWorkflow, buildOpsWorkflow } from '../../engine/builder';
import { extractModulesFromDesign, extractTasksFromPlan } from '../builtinHelpers';

/** architect.design 执行完后，把 design 交付物写入项目级黑板（跨工作流协作）。stage 由节点参数 pipelineStage 决定（默认 'design'）。 */
function publishDesignArtifact(params: Record<string, unknown>, payload: { design: string; modules: ModuleItem[]; summary: string }): void {
  const stage = String(params.pipelineStage ?? '').trim();
  if (!stage) return; // 留空表示不参与跨工作流协作，不发布
  try {
    publishArtifactFromNode({ stage, kind: 'design', payload });
  } catch (e) {
    // 发布失败不应中断节点主流程（artifact 是旁路交付物）
    console.warn('[architect.design] 发布 design artifact 失败：', e);
  }
}

/**
 * 任务派发节点（Dispatcher / TaskSplitter）：
 * 接收一个任务列表（每个元素为 TaskItem：{label, scope?, payload?}），
 * 1:n 扇出到 t1~t4 固定端口 + _rest；下游经「task」语义连线并行施工。
 * 框架层仅做数据扇出与 scope 标注，真正并行由执行引擎的拓扑并行调度完成。
 */
export const nodeDispatch: NodeDefinition = {
  typeId: 'dispatch.split',
  name: '任务派发',
  category: '派发',
  role: 'orchestrator',
  whenToUse: '将任务列表扇出到多条 task 连线并行派发，配合「冲突协调者」做并发冲突检测。',
  description:
    '将任务列表（TaskItem[]）扇出到多条任务连线并行派发。每个输出端口携带一个任务（含 scope 影响域声明）。未分配完的余数走「其余」端口。配合「task」语义连线（橙色）使用。',
  inputs: [
    { id: 'tasks', label: '任务列表', type: 'list' },
    { id: 'rerun', label: '重派信号(控制流)', type: 'any', flow: 'control' },
  ],
  outputs: [
    { id: 'task1', label: '任务1', type: 'any', flow: 'task' },
    { id: 'task2', label: '任务2', type: 'any', flow: 'task' },
    { id: 'task3', label: '任务3', type: 'any', flow: 'task' },
    { id: 'task4', label: '任务4', type: 'any', flow: 'task' },
    { id: 'rest', label: '其余', type: 'list', flow: 'task' },
  ],
  params: [
    {
      key: 'label1',
      label: '任务1 标签(可选)',
      type: 'text',
      default: '',
      placeholder: '覆盖原任务 label',
    },
    { key: 'label2', label: '任务2 标签(可选)', type: 'text', default: '' },
    { key: 'label3', label: '任务3 标签(可选)', type: 'text', default: '' },
    { key: 'label4', label: '任务4 标签(可选)', type: 'text', default: '' },
  ],
  async execute(inputs, params, ctx) {
    const raw = Array.isArray(inputs.tasks) ? inputs.tasks : [];
    const tasks: TaskItem[] = raw.map((t, i) => {
      if (typeof t === 'object' && t !== null && 'payload' in t) {
        return { ...(t as TaskItem), index: i };
      }
      // 允许传入纯字符串/文本，自动包装为 TaskItem
      return { label: typeof t === 'string' ? t : `任务${i + 1}`, payload: t, index: i };
    });
    const labels = [params.label1, params.label2, params.label3, params.label4].map((s) => String(s ?? ''));
    const pick = (i: number, fallback: TaskItem) => {
      const t = { ...fallback };
      if (labels[i]) t.label = labels[i];
      return t;
    };
    const out: Record<string, unknown> = {};
    const portTasks: { handle: string; task?: TaskItem }[] = [
      { handle: 'task1', task: tasks[0] },
      { handle: 'task2', task: tasks[1] },
      { handle: 'task3', task: tasks[2] },
      { handle: 'task4', task: tasks[3] },
    ];
    // 把每个任务端口声明的影响域(scope)写回对应的 task 连线，供下游「冲突协调者」读取
    for (const { handle, task } of portTasks) {
      if (task && ctx.writeOutEdgeScope) {
        ctx.writeOutEdgeScope(handle, Array.isArray(task.scope) ? task.scope : []);
      }
    }
    out.task1 = tasks[0] ? pick(0, tasks[0]) : undefined;
    out.task2 = tasks[1] ? pick(1, tasks[1]) : undefined;
    out.task3 = tasks[2] ? pick(2, tasks[2]) : undefined;
    out.task4 = tasks[3] ? pick(3, tasks[3]) : undefined;
    out.rest = tasks.slice(4);
    return out;
  },
};

/**
 * 规划/编排节点（Plan / Orchestrator）：
 * 把一句目标交给绑定的「规划模型」，产出计划书，并自动把计划切成任务清单（TaskItem[]），
 * 供下游「任务派发（dispatch.split）」1:n 扇出到并行施工线。
 */
export const nodePlan: NodeDefinition = {
  typeId: 'dispatch.plan',
  name: '规划/编排',
  category: '派发',
  role: 'orchestrator',
  whenToUse: '把一句话目标交给规划模型，生成计划书并自动切分为任务清单，供下游「任务派发」并行施工。',
  description:
    '接收目标描述，调用绑定的规划模型生成计划书，并把计划自动切分为任务清单（TaskItem[]）。输出 plan（计划书）/ tasks（任务列表，可直接接「任务派发」）/ summary（一句话摘要）。',
  inputs: [{ id: 'goal', label: '目标', type: 'text' }],
  outputs: [
    { id: 'plan', label: '计划书', type: 'text' },
    { id: 'tasks', label: '任务清单', type: 'list' },
    { id: 'summary', label: '摘要', type: 'text' },
  ],
  params: [
    { key: 'agentId', label: '绑定规划智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    {
      key: 'modelOverride',
      label: '节点级模型（留空用智能体默认）',
      type: 'text',
      default: '',
      placeholder: '如 kimi / gpt-4o-mini；规划用性价比模型更省',
    },
    {
      key: 'format',
      label: '计划书格式',
      type: 'select',
      default: 'tasks',
      options: [
        { value: 'tasks', label: '任务清单（含步骤说明）' },
        { value: 'outline', label: '提纲（章节式）' },
        { value: 'free', label: '自由（交给模型）' },
      ],
    },
    {
      key: 'simulate',
      label: '离线模拟模式（不调 LLM，回显链路）',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用）' },
        { value: 'on', label: '开启（离线回显）' },
      ],
    },
  ],
  async execute(inputs, params, ctx) {
    const goal = String(inputs.goal ?? '').trim();
    if (!goal) throw new Error('缺少目标输入（goal 端口未接入数据）');

    const agentId = String(params.agentId ?? '');
    const roleId = String(params.roleId ?? '');
    const roles = useWorkflowStore.getState().roles;
    const role = findRole(roles, roleId || undefined);
    const system = resolveRoleSystem(role, String(params.system ?? '')) ||
      '你是一名严谨的项目规划助手。请把用户目标拆解为清晰、可执行的计划，并输出任务清单。';
    const modelOverride = String(params.modelOverride ?? '').trim();
    const format = String(params.format ?? 'tasks');

    const buildPrompt = (): string => {
      const fmtHint =
        format === 'outline'
          ? '请以章节式提纲（大纲）组织计划，先总述再分节。'
          : format === 'free'
            ? '请自由组织计划书，结构清晰即可。'
            : '请把计划组织成可执行的步骤清单。';
      return `${fmtHint}

目标：
${goal}

请输出计划书，并在最后用如下围栏块给出结构化任务数组（每项：{label, scope?（影响的文件/模块列表）, payload?}），以便下游并行派发：
\`\`\`json
[{"label":"任务描述","scope":["文件/模块"],"payload":"可选附加内容"}]
\`\`\`
若确实无法切分，也请给出至少一项任务。`;
    };

    // —— 离线模拟模式：不调 LLM，按链路回显便于无模型验证 ——
    if (String(params.simulate ?? 'off') === 'on') {
      const agent = useWorkflowStore.getState().agents.find((a) => a.id === agentId);
      const modelTag = modelOverride || agent?.model || '—';
      const plan = `【离线模拟 · 规划链路回显】

— 目标 —
${goal}

— 计划书（模拟） —
1. 明确需求与边界。
2. 拆解为若干独立子任务（每项声明影响域 scope）。
3. 并行施工、冲突协调、质量校验。

— 任务清单（模拟） —
${JSON.stringify(
  [
    { label: '分析目标与约束', scope: ['docs'], payload: goal },
    { label: '设计实现方案', scope: ['src'], payload: goal },
    { label: '编码与自测', scope: ['src'], payload: goal },
  ],
  null,
  2,
)}

（本节点在模拟模式下不调用真实 LLM，以上为链路装配结果。配置可用智能体并关闭模拟后替换为模型实际输出。）`;
      const tasks: TaskItem[] = [
        { label: '分析目标与约束', scope: ['docs'], payload: goal, index: 0 },
        { label: '设计实现方案', scope: ['src'], payload: goal, index: 1 },
        { label: '编码与自测', scope: ['src'], payload: goal, index: 2 },
      ];
      ctx.logger.info(`规划(模拟)完成 智能体=${agent?.name ?? '未绑定'} 模型=${modelTag} 目标 ${goal.length} 字`);
      // 流式回显计划书
      let acc = '';
      for (const seg of plan) {
        acc += seg;
        ctx.setPartial('plan', acc);
        await new Promise((r) => setTimeout(r, 4));
      }
      return { plan, tasks, summary: goal.slice(0, 40) };
    }

    // —— 真实调用 ——
    if (!agentId) throw new Error('未绑定规划智能体，请在右侧面板选择（或开启离线模拟模式）');
    const messages: ChatMessage[] = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: buildPrompt() },
    ];

    ctx.logger.info(
      `规划请求${role ? ` 角色=${role.name}` : ''}${modelOverride ? ` 模型=${modelOverride}` : ''} 目标 ${goal.length} 字`,
    );
    let acc = '';
    const text = await ctx.llm(
      agentId,
      messages,
      (delta) => {
        acc += delta;
        ctx.setPartial('plan', acc);
      },
      modelOverride || undefined,
    );

    // 解析任务清单：优先取围栏内的 json 数组
    const tasks = extractTasksFromPlan(text, goal);
    const firstLine = text.split('\n').find((l) => l.trim().length > 0);
    const summary = (firstLine ? firstLine.replace(/^[#*\s-]+/, '').trim() : goal.slice(0, 40)).slice(0, 60);
    return { plan: text, tasks, summary };
  },
};

/**
 * 架构师节点（Architect / 技术设计者）：
 * 接收「目标 + 可选约束（现有代码/技术栈/边界）」，调用绑定的架构模型产出技术设计。
 */
export const nodeArchitect: NodeDefinition = {
  typeId: 'architect.design',
  name: '架构师',
  category: '派发',
  role: 'architect',
  whenToUse: '把目标（与现有约束）交给架构模型，产出模块划分与技术设计，输出模块清单供下游「任务派发」并行施工。',
  description:
    '接收目标与可选约束，调用绑定的架构模型产出技术设计书与模块清单（ModuleItem[]，含 scope 影响域与 dependsOn 依赖）。输出 design（设计书）/ modules（模块列表，可直接接「任务派发」）/ summary（一句话摘要）。',
  inputs: [
    { id: 'goal', label: '目标', type: 'text' },
    { id: 'constraints', label: '约束(可选)', type: 'text' },
  ],
  outputs: [
    { id: 'design', label: '设计书', type: 'text' },
    { id: 'modules', label: '模块清单', type: 'list' },
    { id: 'summary', label: '摘要', type: 'text' },
  ],
  params: [
    { key: 'agentId', label: '绑定架构智能体', type: 'agent', default: '' },
    { key: 'roleId', label: '角色（可选）', type: 'role', default: '' },
    {
      key: 'modelOverride',
      label: '节点级模型（留空用智能体默认）',
      type: 'text',
      default: '',
      placeholder: '如 claude-opus / gpt-4o；架构用强模型更稳',
    },
    {
      key: 'format',
      label: '设计书格式',
      type: 'select',
      default: 'modules',
      options: [
        { value: 'modules', label: '模块清单（含职责/依赖）' },
        { value: 'diagram', label: '架构图式（分层/组件）' },
        { value: 'free', label: '自由（交给模型）' },
      ],
    },
    {
      key: 'simulate',
      label: '离线模拟模式（不调 LLM，回显链路）',
      type: 'select',
      default: 'off',
      options: [
        { value: 'off', label: '关闭（真实调用）' },
        { value: 'on', label: '开启（离线回显）' },
      ],
    },
    {
      key: 'pipelineStage',
      label: 'Pipeline 阶段标识（跨工作流交付物落盘用）',
      type: 'text',
      default: 'design',
      placeholder: '如 design / plan；留空不发布 Artifact',
      tooltip: '将该节点产出的 design 交付物写入项目级黑板对应阶段，供 Builder/施工方工作流读取。',
    },
  ],
  async execute(inputs, params, ctx) {
    const goal = String(inputs.goal ?? '').trim();
    if (!goal) throw new Error('缺少目标输入（goal 端口未接入数据）');
    const constraints = String(inputs.constraints ?? '').trim();

    const agentId = String(params.agentId ?? '');
    const roleId = String(params.roleId ?? '');
    const roles = useWorkflowStore.getState().roles;
    const role = findRole(roles, roleId || undefined);
    const system =
      resolveRoleSystem(role, String(params.system ?? '')) ||
      '你是一名资深软件架构师。请基于用户目标（与可选约束）给出清晰、可落地的技术设计：模块划分、职责边界、影响域（涉及的文件/接口/抽象类）与依赖关系。';
    const modelOverride = String(params.modelOverride ?? '').trim();
    const format = String(params.format ?? 'modules');

    const buildPrompt = (): string => {
      const fmtHint =
        format === 'diagram'
          ? '请以分层/组件视图组织设计（可用文本图或缩进列表表达层级与依赖）。'
          : format === 'free'
            ? '请自由组织架构设计书，结构清晰即可。'
            : '请将设计组织为清晰的模块清单，每项说明职责与依赖。';
      const constraintHint = constraints
        ? `\n\n— 现有约束 / 上下文 —\n${constraints}\n（请在设计中考量上述约束，避免与之冲突。）`
        : '';
      return `${fmtHint}

— 目标 —
${goal}${constraintHint}

请输出架构设计书，并在最后用如下围栏块给出结构化模块数组（每项：{name, category, responsibility?, scope?（影响的文件/模块列表）, dependsOn?（依赖的其它模块名）, payload?}），以便下游 Builder 经「类别→智能体」路由表绑定 agent 并行施工：
\`\`\`json
[{"name":"模块名","category":"ui|logic|docs|infra|data","responsibility":"职责说明","scope":["文件/模块"],"dependsOn":["其它模块名"],"payload":"可选附加内容"}]
\`\`\`
category 必填，从 ui(前端/界面) / logic(核心逻辑/算法) / docs(文档/说明) / infra(构建/部署/配置) / data(数据/存储/接口契约) 中择一，无法归类可填 data。
若确实无法切分，也请给出至少一个模块。`;
    };

    // —— 离线模拟模式：不调 LLM，按链路回显便于无模型验证 ——
    if (String(params.simulate ?? 'off') === 'on') {
      const agent = useWorkflowStore.getState().agents.find((a) => a.id === agentId);
      const modelTag = modelOverride || agent?.model || '—';
      const design = `【离线模拟 · 架构链路回显】

— 目标 —
${goal}${constraints ? `\n— 约束 —\n${constraints}` : ''}

— 架构设计书（模拟） —
1. 划分核心模块，明确职责边界。
2. 声明每个模块的影响域（scope）与依赖（dependsOn）。
3. 并行施工、冲突协调、质量校验。

— 模块清单（模拟） —
${JSON.stringify(
  [
    { name: 'api', responsibility: '对外接口层', scope: ['src/api'], dependsOn: [], payload: goal },
    { name: 'core', responsibility: '核心业务逻辑', scope: ['src/core'], dependsOn: ['api'], payload: goal },
    { name: 'store', responsibility: '状态与持久化', scope: ['src/store'], dependsOn: ['core'], payload: goal },
  ],
  null,
  2,
)}`;
      const modules: ModuleItem[] = [
        { name: 'api', responsibility: '对外接口层', category: 'ui', scope: ['src/api'], dependsOn: [], payload: goal, index: 0 },
        { name: 'core', responsibility: '核心业务逻辑', category: 'logic', scope: ['src/core'], dependsOn: ['api'], payload: goal, index: 1 },
        { name: 'store', responsibility: '状态与持久化', category: 'data', scope: ['src/store'], dependsOn: ['core'], payload: goal, index: 2 },
      ];
      ctx.logger.info(`架构(模拟)完成 智能体=${agent?.name ?? '未绑定'} 模型=${modelTag} 目标 ${goal.length} 字`);
      let acc = '';
      for (const seg of design) {
        acc += seg;
        ctx.setPartial('design', acc);
        await new Promise((r) => setTimeout(r, 4));
      }
      publishDesignArtifact(params, { design, modules, summary: goal.slice(0, 40) });
      return { design, modules, summary: goal.slice(0, 40) };
    }

    // —— 真实调用 ——
    if (!agentId) throw new Error('未绑定架构智能体，请在右侧面板选择（或开启离线模拟模式）');
    const messages: ChatMessage[] = [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: buildPrompt() },
    ];

    ctx.logger.info(
      `架构请求${role ? ` 角色=${role.name}` : ''}${modelOverride ? ` 模型=${modelOverride}` : ''} 目标 ${goal.length} 字`,
    );
    let acc = '';
    const text = await ctx.llm(
      agentId,
      messages,
      (delta) => {
        acc += delta;
        ctx.setPartial('design', acc);
      },
      modelOverride || undefined,
    );

    const modules = extractModulesFromDesign(text, goal);
    const firstLine = text.split('\n').find((l) => l.trim().length > 0);
    const summary = (firstLine ? firstLine.replace(/^[#*\s-]+/, '').trim() : goal.slice(0, 40)).slice(0, 60);
    const out = { design: text, modules, summary };
    publishDesignArtifact(params, out);
    return out;
  },
};

/* ===================== 步骤 14.F：Builder 生成施工/物业工作流 ===================== */

/**
 * `builder.generate`：读取 architect.design 的 `design` + `modules`，生成「施工方 / 物业」
 * 两张工作流 JSON（复用 builder.ts 模板），并按参数 `autoRegister` 注册进项目（方案 A：
 * 可见可改）。每个 worker 的 agent 绑定由 `module.category` 经项目级 `agentRouteTable` 路由。
 */
export const nodeBuilder: NodeDefinition = {
  typeId: 'builder.generate',
  name: '工作流生成器',
  category: '派发',
  description: '依据架构设计自动生成「施工方 + 物业」两张工作流，并注册进项目。',
  inputs: [
    { id: 'design', label: '设计书', type: 'text' },
    { id: 'modules', label: '模块清单', type: 'list' },
  ],
  outputs: [
    { id: 'constructionWf', label: '施工方工作流', type: 'json' },
    { id: 'opsWf', label: '物业运维工作流', type: 'json' },
  ],
  params: [
    {
      key: 'autoRegister',
      label: '自动注册进项目（标签页可见可改）',
      type: 'select',
      default: 'on',
      options: [
        { value: 'on', label: '开启（生成即注册）' },
        { value: 'off', label: '关闭（仅输出 JSON）' },
      ],
    },
    {
      key: 'constructionName',
      label: '施工方工作流名称',
      type: 'text',
      default: '施工方工作流',
    },
    {
      key: 'opsName',
      label: '物业运维工作流名称',
      type: 'text',
      default: '物业运维工作流',
    },
  ],
  async execute(inputs, params, ctx) {
    const modulesRaw = inputs.modules;
    const modules: ModuleItem[] = Array.isArray(modulesRaw)
      ? modulesRaw.filter((m): m is ModuleItem => !!m && typeof m === 'object')
      : [];
    if (modules.length === 0) {
      // design 可能是唯一输入：尝试从 design 文本无法结构化解析，要求 modules 端口接入
      throw new Error('builder.generate 缺少模块清单（modules 端口需接 architect.design 的 modules）');
    }

    const st = useWorkflowStore.getState();
    const routeTable = st.agentRouteTable ?? {};
    const fallbackAgentId = st.defaultAgentId || (st.agents[0]?.id ?? null);

    const constructionWf = buildConstructionWorkflow({
      modules,
      routeTable,
      fallbackAgentId,
      name: String(params.constructionName || '施工方工作流'),
    });
    const opsWf = buildOpsWorkflow({
      fallbackAgentId,
      name: String(params.opsName || '物业运维工作流'),
    });

    const autoRegister = String(params.autoRegister ?? 'on') === 'on';
    if (autoRegister) {
      try {
        const cId = st.registerWorkflow(constructionWf, { activate: false });
        const oId = st.registerWorkflow(opsWf, { activate: false });
        ctx.logger.info(`Builder 已注册工作流：施工=${cId} 物业=${oId}`);
        // 注册后落盘：项目已保存过（有 projectPath）则增量写盘到 .slimemold/workflows/<id>.json；
        // 否则只留在内存态，提示用户先保存项目（避免 Tauri 下弹出另存为打断自动化）
        if (st.projectPath) {
          try {
            await st.saveProject();
            ctx.logger.info(`Builder 已将生成的工作流落盘到 ${st.projectPath}/.slimemold/workflows/`);
          } catch (e) {
            ctx.logger.warn(`Builder 落盘失败（已保留在内存）：${(e as Error).message}`);
          }
        } else {
          ctx.logger.warn('当前项目尚未保存，生成的工作流仅驻留内存；请先保存项目以落盘到 .slimemold/workflows/');
        }
      } catch (e) {
        ctx.logger.error(`Builder 注册工作流失败：${(e as Error).message}`);
      }
    }

    return { constructionWf, opsWf };
  },
};

/* ===================== 步骤 14.B：跨工作流交付 / 接收 ===================== */

const HANDOFF_KINDS: { value: string; label: string }[] = [
  { value: 'plan', label: '计划书 plan' },
  { value: 'design', label: '设计书 design' },
  { value: 'project', label: '项目交付 project' },
  { value: 'bugreport', label: 'Bug 报告 bugreport' },
  { value: 'constructionWf', label: '施工工作流 constructionWf' },
  { value: 'opsWf', label: '运维工作流 opsWf' },
  { value: 'custom', label: '自定义（填 kind 文本）' },
];

/**
 * `pipeline.handoff`：把本工作流的产物交付到项目级黑板（跨工作流传递）。
 * 参数 `stage` 决定落到哪个阶段槽位；`kind` 决定产物类型。下游工作流经
 * `pipeline.receive` 同 stage+kind 读回。本质复用 pipeline.publishArtifact。
 */
export const nodeHandoff: NodeDefinition = {
  typeId: 'pipeline.handoff',
  name: '交付（跨工作流）',
  category: '派发',
  description: '把产物写入项目级黑板指定阶段，供其他工作流接收。',
  inputs: [{ id: 'payload', label: '交付物', type: 'any' }],
  outputs: [{ id: 'artifact', label: '交付回执', type: 'json' }],
  params: [
    { key: 'stage', label: '目标阶段（黑板槽位）', type: 'text', default: 'construction', placeholder: '如 plan/design/construction/ops' },
    {
      key: 'kind',
      label: '交付物类型',
      type: 'select',
      default: 'project',
      options: HANDOFF_KINDS,
    },
    { key: 'kindCustom', label: '自定义 kind（kind=自定义时生效）', type: 'text', default: '' },
    { key: 'meta', label: '附带元信息（任意文本，如模块 scope 汇总）', type: 'text', default: '', placeholder: '可选，随交付物透传给下游' },
  ],
  async execute(inputs, params, ctx) {
    const stage = String(params.stage ?? '').trim();
    if (!stage) throw new Error('pipeline.handoff 缺少目标阶段（stage 参数）');
    const kindSel = String(params.kind ?? 'project');
    const kind: ArtifactKind = kindSel === 'custom' ? String(params.kindCustom ?? '').trim() || 'custom' : kindSel;
    const payload = inputs.payload;
    if (payload === undefined) throw new Error('pipeline.handoff 缺少交付物（payload 端口）');
    // meta 可选：对象型 payload 时附加 _meta 字段，便于下游 receive 拿到 scope 等上下文（步骤 14 跨工作流透传）
    const meta = String(params.meta ?? '').trim();
    const finalPayload =
      meta && payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...(payload as Record<string, unknown>), _meta: meta }
        : payload;
    const artifact = publishArtifactFromNode({ stage, kind, payload: finalPayload });
    ctx.logger.info(`交付完成 stage=${stage} kind=${kind} version=${artifact.version}`);
    return { artifact };
  },
};

/**
 * `pipeline.receive`：从项目级黑板读取上游工作流交付的产物（同 stage+kind）。
 * 黑板为内存态，读取同步；上游须先 handoff。读不到时按 `onError` 决定报错或返回空。
 */
export const nodeReceive: NodeDefinition = {
  typeId: 'pipeline.receive',
  name: '接收（跨工作流）',
  category: '派发',
  description: '从项目级黑板读取指定阶段的产物。',
  inputs: [],
  outputs: [
    { id: 'payload', label: '交付物', type: 'any' },
    { id: 'artifact', label: '回执', type: 'json' },
  ],
  params: [
    { key: 'stage', label: '来源阶段（黑板槽位）', type: 'text', default: 'construction', placeholder: '如 plan/design/construction/ops' },
    {
      key: 'kind',
      label: '交付物类型',
      type: 'select',
      default: 'project',
      options: HANDOFF_KINDS,
    },
    { key: 'kindCustom', label: '自定义 kind（kind=自定义时生效）', type: 'text', default: '' },
    {
      key: 'onError',
      label: '读不到时',
      type: 'select',
      default: 'error',
      options: [
        { value: 'error', label: '报错（阻断）' },
        { value: 'empty', label: '返回空 payload' },
      ],
    },
  ],
  async execute(_inputs, params, ctx) {
    const stage = String(params.stage ?? '').trim();
    if (!stage) throw new Error('pipeline.receive 缺少来源阶段（stage 参数）');
    const kindSel = String(params.kind ?? 'project');
    const kind: ArtifactKind = kindSel === 'custom' ? String(params.kindCustom ?? '').trim() || 'custom' : kindSel;
    const artifact = getArtifact(stage, kind);
    if (!artifact) {
      if (String(params.onError ?? 'error') === 'empty') {
        return { payload: null, artifact: null };
      }
      throw new Error(`pipeline.receive 读不到交付物（stage=${stage} kind=${kind}）`);
    }
    ctx.logger.info(`接收完成 stage=${stage} kind=${kind} version=${artifact.version}`);
    return { payload: artifact.payload, artifact };
  },
};

export const dispatchNodes: NodeDefinition[] = [
  nodeDispatch,
  nodePlan,
  nodeArchitect,
  nodeBuilder,
  nodeHandoff,
  nodeReceive,
].map(createNodeDef);
