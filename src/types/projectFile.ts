/**
 * Durable project file contract.
 * Pure schema only; runtime persistence remains in io/store owners.
 */
import type { AgentConfig, RoleTemplate } from './agent';
import type { RunRecord } from './execution';
import type { AssetMeta } from './project';
import type { ProjectArtifacts, Orchestration, PipelineDef } from './orchestration';
import type { SubgraphDef, WorkflowFile } from './workflow';
import type { AgentRouteTable } from './dispatch';
import type { ProjectControlSnapshot } from '../projectControl/types';
import type { WorkerRunQueueState } from '../domain/workerQueue';
import type { RunCheckpoint } from '../engine/checkpoint';

/* ---------- 项目文件（.smproj，含多个工作流） ---------- */
export interface ProjectFile {
  version: 1;
  kind: 'project';
  /** 项目唯一 id（由 createProjectFile 生成），工作流通过 belongsToProject 反向引用 */
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 项目内工作流集合，key 为工作流 id */
  workflows: Record<string, WorkflowFile>;
  /** 当前激活的工作流 id */
  activeId: string;
  /** 角色库（项目级，跨工作流共享），内置角色以 builtin=true 标记 */
  roles?: RoleTemplate[];
  /** 项目级全局变量（工作流级 variables 覆盖同名项） */
  variables?: Record<string, unknown>;
  /** 项目级资产库（跨工作流共享；工作流级 assets 覆盖同名 id 后并入） */
  assets?: AssetMeta[];
  /** 项目级子图库（可复用节点组合），key 为子图 id */
  subgraphs?: Record<string, SubgraphDef>;
  /** 项目级资产/产物库（构建产物、导出物等元数据），供后续步骤/报告引用 */
  artifacts?: ProjectArtifacts;
  /** 旧版单文件 .smproj 兼容标记（由单文件迁移到目录形态后置 true） */
  legacy?: boolean;
  /** 项目级「类别 → agent」路由表（Builder 生成施工方工作流时绑定 agent 用） */
  agentRouteTable?: AgentRouteTable;
  /**
   * 项目级智能体（跨工作流共享，2026-08-10 起从「随单个工作流」提升为项目级）。
   * 持久化到 `.slimemold/agents.json`；加载时优先读此文件，旧版本内联在 workflow 的 agents 作为兼容合并。
   */
  agents?: AgentConfig[];
  /** 项目级默认智能体 id（工作流未指定 agent 时引用） */
  defaultAgentId?: string | null;
  /** 项目级 Pipeline 定义集合（跨工作流三方协作编排的阶段与流向），随 .slimemold 持久化 */
  pipelines?: PipelineDef[];
  /** 项目级编排记录（草案、阶段绑定、运行进度和失败信息），随 .slimemold 持久化 */
  orchestrations?: Orchestration[];
  /** 项目级 Worker Run queue registry（状态可恢复，随 project.json 持久化） */
  workerRuns?: WorkerRunQueueState[];
  /** 项目控制面快照（主控会话、Decision、Issue 和版本化 Brief），随 .slimemold 持久化 */
  projectControl?: ProjectControlSnapshot;
  /** 项目级运行历史（持久化） */
  runs?: { history: RunRecord[] };
  /** 运行检查点（阶段 C 可恢复执行）：按 wfId 覆盖式存储最近一次运行的节点级结果，随项目落盘 */
  checkpoints?: Record<string, RunCheckpoint>;
  /** 检查点多版本历史（阶段 G2）：按 wfId 保留最近 N 条运行快照 */
  checkpointHistory?: Record<string, RunCheckpoint[]>;
}
