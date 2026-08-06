/**
 * prompts.ts —— AgentHarness 的 Prompt 模板与拼装函数。
 *
 * 本文件先产出「审查用三类 Prompt 模板 + system prompt 拼装模板」，
 * 供用户确认风格后再接入执行逻辑。所有模板均为纯函数，无副作用。
 *
 * 三类审查 Prompt（异步审查 Agent 用，#11 复用）：
 *   - _MEMORY  ：沉淀到 project 级变量 / memory.md 的记忆提炼
 *   - _SKILL   ：沉淀为 subgraph 草稿的技能提炼
 *   - _COMBINED：综合复盘
 */

/* ============================ System Prompt 拼装 ============================ */

export interface SystemPromptParts {
  /** 角色/职业提示词（来自角色库或节点 system 参数） */
  role?: string;
  /** 工具使用说明（由 ToolRegistry.toSpecs 注入） */
  tools?: { name: string; description: string }[];
  /** 上下文/记忆注入（变量作用域、memory.md 摘录） */
  context?: string;
  /** 额外的硬性约束（如"只输出 JSON"、"用中文回答"） */
  constraints?: string[];
}

/**
 * 拼装 system prompt。风格：极简、分节、无冗余客套。
 * 顺序固定：角色 → 上下文 → 工具 → 约束，便于模型稳定遵循。
 */
export function assembleSystemPrompt(p: SystemPromptParts): string {
  const sections: string[] = [];
  if (p.role?.trim()) sections.push(`# 角色\n${p.role.trim()}`);
  if (p.context?.trim()) sections.push(`# 上下文\n${p.context.trim()}`);
  if (p.tools && p.tools.length) {
    const list = p.tools
      .map((t) => `- ${t.name}: ${t.description}`)
      .join('\n');
    sections.push(`# 可用工具\n${list}\n调用工具时严格遵循其参数 schema。`);
  }
  if (p.constraints && p.constraints.length) {
    sections.push(`# 约束\n${p.constraints.map((c) => `- ${c}`).join('\n')}`);
  }
  return sections.join('\n\n');
}

/* ============================ 审查用三类 Prompt ============================ */

export interface ReviewContext {
  /** 任务目标 */
  goal: string;
  /** 本轮 / 近期 harness 轨迹（思考、工具调用、输出摘要） */
  trace: string;
  /** 现有 memory.md 摘录（如有） */
  memory?: string;
  /** 现有技能（subgraph 草稿）列表 */
  skills?: string[];
}

/** _MEMORY：从轨迹中提炼值得长期保留的事实/偏好/教训，写入 memory.md */
export function memoryReviewPrompt(c: ReviewContext): string {
  return [
    '# 记忆提炼任务',
    '你是项目的长期记忆管家。阅读下方任务轨迹，提炼**值得跨会话保留**的内容：',
    '- 用户明确的偏好/约束（如"永远用中文""不提交未测试代码"）',
    '- 项目事实（技术栈、约定、目录结构）',
    '- 失败教训与成功经验',
    '',
    '已存在记忆：',
    c.memory?.trim() || '（无）',
    '',
    '任务目标：', c.goal,
    '',
    '任务轨迹：',
    c.trace,
    '',
    '输出要求：用 `## 提炼` 段包裹，段内仅输出 Markdown 列表，每条以 `- ` 开头，简洁、去重、可执行；不输出解释。',
    '示例：',
    '## 提炼',
    '- 用户偏好：所有回复用中文',
    '- 项目事实：前端用 React + Vite',
  ].join('\n');
}

/** _SKILL：从重复模式提炼可复用 subgraph 草稿 */
export function skillReviewPrompt(c: ReviewContext): string {
  return [
    '# 技能提炼任务',
    '你是工作流架构师。阅读下方轨迹，识别**可复用的任务模式**，提议为 subgraph 草稿。',
    '已有技能：',
    c.skills?.length ? c.skills.join('\n') : '（无）',
    '',
    '任务目标：', c.goal,
    '',
    '任务轨迹：',
    c.trace,
    '',
    '输出要求：仅输出一个 JSON 对象，不要代码块、不要解释。结构：',
    '{"name": "技能名", "summary": "一句话用途", "whenToUse": "适用场景", "body": "该技能的实现要点/节点编排建议"}',
    '无合适模式时仅输出 `{"name": "", "summary": "", "whenToUse": "", "body": ""}`。',
  ].join('\n');
}

/** _COMBINED：综合复盘，同时覆盖记忆与技能 */
export function combinedReviewPrompt(c: ReviewContext): string {
  return [
    '# 综合复盘',
    '你是项目复盘官。综合下方轨迹，同时完成记忆提炼与技能提炼。',
    '任务目标：', c.goal,
    '任务轨迹：', c.trace,
    '',
    '请分两节输出：',
    '## 记忆', c.memory?.trim() ? `(已有：\n${c.memory})` : '（无）',
    '用 `## 提炼` 段包裹记忆列表（每条 `- ` 开头）。',
    '',
    '## 技能', c.skills?.length ? c.skills.join('\n') : '（无）',
    '输出单个技能 JSON 对象（同 _SKILL 结构：name/summary/whenToUse/body），无则空对象。',
  ].join('\n');
}

export type ReviewKind = '_MEMORY' | '_SKILL' | '_COMBINED';

export function buildReviewPrompt(kind: ReviewKind, c: ReviewContext): string {
  switch (kind) {
    case '_MEMORY':
      return memoryReviewPrompt(c);
    case '_SKILL':
      return skillReviewPrompt(c);
    case '_COMBINED':
      return combinedReviewPrompt(c);
  }
}
