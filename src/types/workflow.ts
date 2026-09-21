import type { AgentConfig, RoleTemplate } from './agent';
import type { RunRecord } from './execution';
import type { EdgeKind, FlowEdge, FlowNode, PortType } from './graph';
import type { AssetMeta } from './project';

/* ---------- 工作流文件 ---------- */
export interface WorkflowFileNode {
  id: string;
  typeId: string;
  label: string;
  position: { x: number; y: number };
  params: Record<string, unknown>;
  /** 节点旁路开关（对齐运行态 data.bypass，旧文件缺省视为 false） */
  bypass?: boolean;
  /** 节点静音开关（对齐运行态 data.mute，旧文件缺省视为 false） */
  mute?: boolean;
  /** 画布选中态（运行时态，存盘忽略，仅类型兼容） */
  selected?: boolean;
}

export interface WorkflowFileEdge {
  id: string;
  source: string;
  sourceHandle: string | null;
  target: string;
  targetHandle: string | null;
  /** 连线语义（data/task/control），缺省 'data'，向后兼容旧工作流文件 */
  kind?: EdgeKind;
  /** task 连线的派发影响域声明（与 FlowEdgeData.scope 对应），供「冲突协调者」检测并发冲突 */
  scope?: string[];
  /** 画布选中态（运行时态，存盘忽略，仅类型兼容） */
  selected?: boolean;
}

export interface WorkflowFile {
  version: 1;
  name: string;
  savedAt: string;
  nodes: WorkflowFileNode[];
  edges: WorkflowFileEdge[];
  agents: AgentConfig[];
  /** 角色库（随工作流保存/加载），内置角色以 builtin=true 标记 */
  roles?: RoleTemplate[];
  /** 全局变量（随工作流一起保存/加载） */
  variables?: Record<string, unknown>;
  /**
   * 工作区目录（绝对路径）。
   * - null/undefined：未创建工作区，写文件节点产物落到工作流内部目录，随工作流删除销毁。
   * - 字符串：用户指定的文件夹，写文件产物落到此处。
   */
  workspaceDir?: string | null;
  /** 本工作流产出的资产（文件/预览）元数据，用于左侧「资产」面板的预览与导出 */
  assets?: AssetMeta[];
  /** 节点组（纯视觉编组，不参与执行） */
  groups?: NodeGroup[];
  /**
   * 归属声明（游离工作流 vs 项目内工作流）：
   * - 属于某项目时填 `belongsToProject`（项目 id），资产/变量作用域走项目级；
   * - 游离工作流填 `standalonePath`（磁盘绝对路径，单文件存盘位置），仅工作流级作用域。
   * 两者至多其一。缺失即视为游离且尚未存盘（路径未知）。
   */
  belongsToProject?: string;
  standalonePath?: string;
  /** 工作流默认智能体（节点未指定 roleId 时使用；null 表示未设置） */
  defaultAgentId?: string | null;
  /** 人类可读的配置/使用说明（示例文件常见；运行时忽略，仅供阅读与导入后展示） */
  notes?: string;
  /** 运行历史（P2 成本跟项目：落盘到 .slimemold/runs/history.json） */
  runs?: { history: RunRecord[] };
}

/**
 * 内存态工作流：节点/边与画布运行态同构（FlowNode/FlowEdge），
 * 便于所有 store 方法（含非激活工作流）直接读写 data.* 字段。
 * 落盘时由 toDisk() 拍平回 WorkflowFile（剥离 measured/dragging 等瞬态）。
 */
export interface WorkflowFileInMemory extends Omit<WorkflowFile, 'nodes' | 'edges'> {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/* ---------- 子图（可复用节点组合） ---------- */

/** 子图对外暴露的一个端口。
 * 由子图内部某个节点的某个端口「提升」而来：外部连到该端口的数据，
 * 在扁平化展开时会被直接接到 innerNodeId/innerHandle 上。 */
export interface SubgraphPort {
  /** 端口 id（子图引用节点上的 handle id），如 'in_1' */
  id: string;
  /** 端口显示名 */
  label: string;
  type?: PortType;
  /** 内部承接该端口的节点 id */
  innerNodeId: string;
  /** 内部节点上的 handle id */
  innerHandle: string | null;
}

/** 子图定义：一组节点+连线的可复用封装。
 * 存放在项目级 subgraphs 字典中，被 subgraph.ref 节点通过 subgraphId 引用。 */
export interface SubgraphDef {
  id: string;
  name: string;
  description?: string;
  /** 节点库中的分组（用于左侧面板归类） */
  category?: string;
  createdAt: string;
  updatedAt: string;
  nodes: WorkflowFileNode[];
  edges: WorkflowFileEdge[];
  /** 对外输入端口（内部未被连接的输入端口自动提升） */
  inputs: SubgraphPort[];
  /** 对外输出端口（内部未被连接的输出端口自动提升） */
  outputs: SubgraphPort[];
}

/* ---------- 节点组（升级为子图引用） ---------- */

/** 聚合代理端口：按「端口类型」合并子图内部同类端口。
 * - 折叠态分组标签按聚合端口生成虚拟端口（外部多对一、内部一对多）。
 * - 例：子图内部共需 2×img + 1×txt 输入 -> 仅生成 img、txt 两个聚合端口。 */
export interface ProxyPort {
  /** 稳定 id，如 `${groupId}:in:img` / `${groupId}:out:text` */
  id: string;
  kind: 'input' | 'output';
  /** 聚合类型（取内部同类端口的类型，缺省 'any'） */
  type?: PortType;
  /** 显示名，如 'img' / 'txt' */
  label: string;
  /** 内部一对多：该聚合端口分发到的子图内部目标（节点端口）。
   * - input 代理：外部数据广播给这些内部输入端口
   * - output 代理：这些内部输出端口汇聚到该代理端口 */
  internalTargets: Array<{ nodeId: string; portId: string }>;
}

/** 虚拟边：聚合代理端口 -> 多个内部端口的一对多映射（Q10=A）。
 * 渲染时按 targets 展开成多条实际连线；执行时数据广播给所有目标。 */
export interface VirtualEdge {
  id: string;
  /** 子图侧聚合代理端口 id（如 `${groupId}:in:img`） */
  proxyPortId: string;
  kind: 'input' | 'output';
  /** 内部一对多目标（节点端口） */
  targets: Array<{ nodeId: string; portId: string }>;
}

/** 节点组：把若干节点框在一起，可整体拖动 / 折叠 / 配色。
 * 现升级为「子图引用」：折叠时对外呈现聚合代理端口，双击进入子图编辑视图。 */
export interface NodeGroup {
  id: string;
  title: string;
  /** 组内成员节点 id（= 子图内部节点） */
  nodeIds: string[];
  /** 组框颜色（CSS 颜色值） */
  color: string;
  /** 是否折叠（折叠时组内节点隐藏，仅显示聚合代理端口卡片） */
  collapsed: boolean;
  /** 折叠前记录的组框区域，用于折叠态占位与展开还原 */
  bounds?: { x: number; y: number; width: number; height: number };
  /** 关联的子图定义 id（分组即子图，新建分组时自动生成空子图） */
  subgraphId?: string;
  /** 折叠态聚合代理端口（按类型合并，自动推导内部端口类型并集） */
  proxyPorts?: ProxyPort[];
  /** 内部一对多虚拟边（聚合端口 -> 内部端口映射） */
  virtualEdges?: VirtualEdge[];
}
