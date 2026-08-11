/**
 * H3 Orchestrator 类型（re-export 自 ../types，避免 store ⇄ orchestrator 循环依赖）。
 *
 * 核心原则：Orchestrator 只生成「工作流草案」，绝不静默修改用户工作流——
 * confirmDraft 是唯一允许把草案落成 pipeline 的入口。
 */

export type {
  ArtifactKind,
  DraftEdge,
  DraftStage,
  Orchestration,
  OrchestrationStatus,
  PipelineDraft,
  StageLog,
} from '../types';

/** 编排请求（用户目标） */
export interface OrchestratorRequest {
  /** 用户自然语言目标 */
  goal: string;
  /** 约束（可选） */
  constraints?: {
    agentId?: string;
    maxStages?: number;
    budgetTokens?: number;
    /** true 时只产出草案，不触发执行 */
    readonly?: boolean;
  };
  source: 'ui' | 'menu' | 'command';
  projectId?: string;
}

/** confirmDraft 的显式批准标记 */
export type Confirmation = 'approved';
