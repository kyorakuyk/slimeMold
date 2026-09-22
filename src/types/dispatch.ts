/**
 * Task/module dispatch and project agent routing contracts.
 * Pure types only; no store, engine, or host dependencies.
 */
/* ---------- 任务派发协议（Dispatcher / Coordinator） ---------- */
/** 一个被派发的任务单元。
 * - label：任务名（供 Coordinator / Auditor 展示）
 * - scope：影响域声明（涉及的文件 / 接口 / 抽象类），供 Conflict Resolver 做并发冲突检测
 * - payload：任务实际内容（文本 / 结构化数据），由下游 Builder 消费
 * 约定：scope 走数据协议（任务对象自带），不依赖引擎改动，便于框架先行落地。 */
export interface TaskItem {
  label: string;
  scope?: string[];
  payload?: unknown;
  /** 上游派发节点赋予的序号，便于追踪 */
  index?: number;
}

/** 架构师产出的模块/组件设计单元。
 * 与 TaskItem 字段兼容（label/scope/payload），因此架构输出可直接喂给「任务派发」节点。
 * - name：模块名
 * - responsibility：职责说明（作为 label 展示）
 * - scope：影响域（涉及的文件/接口/抽象类），供 Conflict Resolver 做并发冲突检测
 * - dependsOn：依赖的其它模块名（用于拓扑排序/施工顺序提示）
 * - payload：模块设计详情（文本/结构化），由下游 Builder 消费 */
export interface ModuleItem {
  name: string;
  responsibility?: string;
  scope?: string[];
  dependsOn?: string[];
  payload?: unknown;
  index?: number;
  /** 步骤 14.7：模块类别（如 ui/logic/docs/infra），供 Builder 经路由表绑定 agent/模型。
   * 架构师节点（architect.design）生成模块时标注；Builder（14.F）据此从路由表查 agentId。 */
  category?: ModuleCategory;
  /** 步骤 14.7：显式指定该模块使用的智能体 id（优先级高于 category 路由）。
   * 为空时 Builder 按 category 走项目级路由表。 */
  agentId?: string;
}

/** 模块类别枚举（步骤 14.7，对标 oh-my-openagent 的 category 解耦路由）。
 * 仅作约定值，路由表键可扩展为任意字符串。 */
export type ModuleCategory =
  | 'ui' //      前端/视觉/界面
  | 'logic' //   核心逻辑/算法/架构
  | 'docs' //    文档/文本/说明
  | 'infra' //   构建/部署/配置/工程化
  | 'data' //    数据/存储/接口契约
  | string; //   预留：自定义类别

/** 步骤 14.7：模块类别 → 智能体 id 的路由表项（单条）。 */
export interface AgentRouteEntry {
  /** 该类别默认绑定的智能体 id（对应 AgentConfig.id）。 */
  agentId: string;
  /** 回退链：主 agent 不可用时依次尝试的 agent id 列表（对标 oh-my-opencode-slim 的 Model Fallback Chain）。 */
  fallback?: string[];
}

/** 步骤 14.7：项目级「类别 → agent」路由表。键为 ModuleCategory（小写），值为路由项。
 * 随项目 .slimemold 持久化，用户可在设置/Inspector 中覆写（对齐 OMO 的「配置可覆写」哲学）。 */
export type AgentRouteTable = Record<string, AgentRouteEntry>;
