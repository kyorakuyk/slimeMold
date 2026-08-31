import type { AgentConfig, ChatMessage, LLMResponse } from '../types';
import { chatWithAgent } from '../agents/agentManager';
import type {
  ArchitectureInterface,
  ArchitectureModule,
  ArchitectureTask,
  Decision,
  ProjectBrief,
  ProjectSession,
} from './types';

export const MASTER_MAX_QUESTIONS = 3;

export interface MasterQuestion {
  id: string;
  prompt: string;
}

export interface MasterBriefDraft {
  goal: string;
  users: string[];
  scope: string[];
  nonGoals: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  assumptions: string[];
}

export interface MasterArchitectureDraft {
  overview: string;
  modules: ArchitectureModule[];
  interfaces: ArchitectureInterface[];
  tasks: ArchitectureTask[];
  risks: string[];
}

export type MasterResponse =
  | {
      kind: 'question';
      reply: string;
      questions: MasterQuestion[];
    }
  | {
      kind: 'brief';
      reply: string;
      brief: MasterBriefDraft;
    }
  | {
      kind: 'architecture';
      reply: string;
      architecture: MasterArchitectureDraft;
    };

export interface MasterContext {
  session: ProjectSession;
  userMessage: string;
  currentBrief: ProjectBrief | null;
  decisions: Decision[];
}

export interface MasterTurnResult {
  response: MasterResponse;
  rawText: string;
  messages: ChatMessage[];
  usage?: LLMResponse['usage'];
}

export type MasterChat = (
  agent: AgentConfig,
  messages: ChatMessage[],
  signal: AbortSignal,
  onToken?: (text: string) => void,
) => Promise<LLMResponse>;

export interface MasterTurnDeps {
  chat?: MasterChat;
}

const MASTER_SYSTEM_PROMPT = `你是 SlimeMold 的项目主控 Agent，负责把用户的模糊目标逐步收敛为可确认的项目 Brief。

你只能提出问题或 Brief 草案或架构草案，只能做三类事情：
1. 当关键信息不足时，输出 kind=question，并提出最多 3 个会影响范围、架构、成本、权限或验收的问题；
2. 当信息足够时，输出 kind=brief，给出完整的 Brief 草案。
3. 当用户已经确认 Brief 且需要进入架构规划时，输出 kind=architecture，给出模块、接口、施工任务和风险。

你必须只输出合法 JSON，不要输出 Markdown 围栏、解释文字或 JSON 以外的内容。
question 格式：{"kind":"question","reply":"简短说明","questions":[{"id":"稳定的小写 id","prompt":"问题"}]}
brief 格式：{"kind":"brief","reply":"请用户确认 Brief","brief":{"goal":"目标","users":["用户"],"scope":["范围"],"nonGoals":["非目标"],"constraints":["约束"],"acceptanceCriteria":["验收标准"],"assumptions":["假设"]}}
architecture 格式：{"kind":"architecture","reply":"请用户审查架构","architecture":{"overview":"总体架构","modules":[{"id":"稳定 id","name":"模块名","responsibility":"职责","category":"ui|logic|data|infra|docs","scope":["影响路径或符号"],"dependsOn":[]}],"interfaces":[{"id":"稳定 id","name":"接口名","description":"接口职责"}],"tasks":[{"id":"稳定 id","title":"任务名","description":"任务说明","moduleId":"模块 id","scope":["影响路径或符号"],"dependsOn":[],"acceptanceCriteria":["验收标准"],"category":"ui|logic|data|infra|docs"}],"risks":["风险"]}}

安全边界：你不能直接写代码、运行命令、修改 Workflow/DAG、批准自己的建议、归类未认领 Issue、发布或清理文件。所有建议都必须等待用户确认。缺失信息可以写入 assumptions，但要明确标记为假设。`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`主控输出缺少有效的${field}`);
  }
  return value.trim();
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`主控输出的${field}必须是数组`);
  const result = value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`主控输出的${field}[${index}]必须是非空字符串`);
    }
    return item.trim();
  });
  return result;
}

function parseJsonPayload(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    throw new Error('主控输出不是合法 JSON');
  }
}

export function parseMasterResponse(text: string): MasterResponse {
  const value = parseJsonPayload(text);
  if (!isRecord(value)) throw new Error('主控输出必须是 JSON 对象');

  const reply = requiredText(value.reply, 'reply');
  if (value.kind === 'question') {
    if (!Array.isArray(value.questions)) throw new Error('主控 question 输出缺少 questions 数组');
    if (value.questions.length === 0) throw new Error('主控至少要提出一个问题');
    if (value.questions.length > MASTER_MAX_QUESTIONS) {
      throw new Error(`主控每轮最多 ${MASTER_MAX_QUESTIONS} 个问题`);
    }
    const questions = value.questions.map((item, index) => {
      if (!isRecord(item)) throw new Error(`主控问题 ${index + 1} 格式无效`);
      return {
        id: requiredText(item.id, `问题 ${index + 1} id`),
        prompt: requiredText(item.prompt, `问题 ${index + 1}`),
      };
    });
    const ids = new Set(questions.map((question) => question.id));
    if (ids.size !== questions.length) throw new Error('主控问题 id 不能重复');
    return { kind: 'question', reply, questions };
  }

  if (value.kind === 'brief') {
    if (!isRecord(value.brief)) throw new Error('主控 brief 输出缺少 brief 对象');
    return {
      kind: 'brief',
      reply,
      brief: {
        goal: requiredText(value.brief.goal, 'Brief 目标'),
        users: stringArray(value.brief.users, 'Brief users'),
        scope: stringArray(value.brief.scope, 'Brief scope'),
        nonGoals: stringArray(value.brief.nonGoals, 'Brief nonGoals'),
        constraints: stringArray(value.brief.constraints, 'Brief constraints'),
        acceptanceCriteria: stringArray(value.brief.acceptanceCriteria, 'Brief acceptanceCriteria'),
        assumptions: stringArray(value.brief.assumptions, 'Brief assumptions'),
      },
    };
  }

  if (value.kind === 'architecture') {
    if (!isRecord(value.architecture)) throw new Error('主控 architecture 输出缺少 architecture 对象');
    const architecture = value.architecture;
    const rawModules = architecture.modules;
    if (!Array.isArray(rawModules) || rawModules.length === 0) {
      throw new Error('主控 architecture 至少需要一个模块');
    }
    const modules = rawModules.map((item, index): ArchitectureModule => {
      if (!isRecord(item)) throw new Error(`主控模块 ${index + 1} 格式无效`);
      return {
        id: requiredText(item.id, `模块 ${index + 1} id`),
        name: requiredText(item.name, `模块 ${index + 1} 名称`),
        responsibility: requiredText(item.responsibility, `模块 ${index + 1} 职责`),
        category: requiredText(item.category, `模块 ${index + 1} category`),
        scope: stringArray(item.scope, `模块 ${index + 1} scope`),
        dependsOn: stringArray(item.dependsOn, `模块 ${index + 1} dependsOn`),
      };
    });
    const moduleIds = new Set(modules.map((module) => module.id));
    if (moduleIds.size !== modules.length) throw new Error('主控模块 id 不能重复');

    const rawInterfaces = architecture.interfaces === undefined ? [] : architecture.interfaces;
    if (!Array.isArray(rawInterfaces)) throw new Error('主控 architecture interfaces 必须是数组');
    const interfaces = rawInterfaces.map((item, index): ArchitectureInterface => {
      if (!isRecord(item)) throw new Error(`主控接口 ${index + 1} 格式无效`);
      return {
        id: requiredText(item.id, `接口 ${index + 1} id`),
        name: requiredText(item.name, `接口 ${index + 1} 名称`),
        description: requiredText(item.description, `接口 ${index + 1} 描述`),
      };
    });
    if (new Set(interfaces.map((item) => item.id)).size !== interfaces.length) {
      throw new Error('主控接口 id 不能重复');
    }

    const rawTasks = architecture.tasks === undefined ? [] : architecture.tasks;
    if (!Array.isArray(rawTasks)) throw new Error('主控 architecture tasks 必须是数组');
    const tasks = rawTasks.map((item, index): ArchitectureTask => {
      if (!isRecord(item)) throw new Error(`主控任务 ${index + 1} 格式无效`);
      const moduleId = requiredText(item.moduleId, `任务 ${index + 1} moduleId`);
      if (!moduleIds.has(moduleId)) throw new Error(`主控任务 ${index + 1} 引用了不存在的模块：${moduleId}`);
      return {
        id: requiredText(item.id, `任务 ${index + 1} id`),
        title: requiredText(item.title, `任务 ${index + 1} 标题`),
        description: requiredText(item.description, `任务 ${index + 1} 描述`),
        moduleId,
        scope: stringArray(item.scope, `任务 ${index + 1} scope`),
        dependsOn: stringArray(item.dependsOn, `任务 ${index + 1} dependsOn`),
        acceptanceCriteria: stringArray(item.acceptanceCriteria, `任务 ${index + 1} acceptanceCriteria`),
        category: requiredText(item.category, `任务 ${index + 1} category`),
      };
    });
    if (new Set(tasks.map((item) => item.id)).size !== tasks.length) {
      throw new Error('主控任务 id 不能重复');
    }

    return {
      kind: 'architecture',
      reply,
      architecture: {
        overview: requiredText(architecture.overview, '架构概览'),
        modules,
        interfaces,
        tasks,
        risks: stringArray(architecture.risks, '架构 risks'),
      },
    };
  }

  throw new Error('主控输出 kind 必须是 question、brief 或 architecture');
}

export function resolveMasterAgent(input: {
  agents: AgentConfig[];
  globalAgents?: AgentConfig[];
  requestedAgentId?: string | null;
  globalMasterAgentId?: string | null;
  defaultAgentId?: string | null;
}): AgentConfig {
  const byId = new Map<string, AgentConfig>();
  for (const agent of input.globalAgents ?? []) byId.set(agent.id, agent);
  for (const agent of input.agents) byId.set(agent.id, agent);
  const enabled = (agent: AgentConfig | undefined): agent is AgentConfig => !!agent && agent.enabled !== false;

  const explicit = input.requestedAgentId ? byId.get(input.requestedAgentId) : undefined;
  if (enabled(explicit)) return explicit;
  const globalMaster = input.globalMasterAgentId ? byId.get(input.globalMasterAgentId) : undefined;
  if (enabled(globalMaster)) return globalMaster;
  const defaultAgent = input.defaultAgentId ? byId.get(input.defaultAgentId) : undefined;
  if (enabled(defaultAgent)) return defaultAgent;
  const first = [...byId.values()].find(enabled);
  if (first) return first;
  throw new Error('没有可用的主控 Agent');
}

function contextSummary(context: MasterContext): string {
  const sessionMessages = context.session.messages
    .slice(-20)
    .map((message) => `${message.role}: ${message.content.slice(0, 2000)}`)
    .join('\n');
  const decisions = context.decisions
    .slice(-20)
    .map((decision) => `- ${decision.key}: ${JSON.stringify(decision.value)} [${decision.status}]`)
    .join('\n');
  const brief = context.currentBrief ? JSON.stringify(context.currentBrief) : '暂无 Brief';
  return [
    '## 项目会话上下文',
    `项目 id：${context.session.projectId}`,
    `会话状态：${context.session.status}`,
    `当前 Brief：${brief}`,
    `已有 Decision：${decisions || '暂无'}`,
    `最近会话记录：\n${sessionMessages || '暂无'}`,
  ].join('\n');
}

export function buildMasterMessages(context: MasterContext): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `${MASTER_SYSTEM_PROMPT}\n\n${contextSummary(context)}`,
    },
    ...context.session.messages.slice(-20).map((message) => ({
      role: message.role,
      content: message.content,
    })),
    { role: 'user', content: requiredText(context.userMessage, '用户回答') },
  ];
}

export async function runMasterTurn(
  context: MasterContext & { agent: AgentConfig; signal?: AbortSignal; onToken?: (text: string) => void },
  deps: MasterTurnDeps = {},
): Promise<MasterTurnResult> {
  const messages = buildMasterMessages(context);
  const chat = deps.chat ?? chatWithAgent;
  const response = await chat(
    context.agent,
    messages,
    context.signal ?? new AbortController().signal,
    context.onToken,
  );
  return {
    response: parseMasterResponse(response.text),
    rawText: response.text,
    messages,
    usage: response.usage,
  };
}
