export interface AcceptanceRecord {
  acceptanceId: string;
  orchestrationId: string;
  stageId: string;
  worktreePath: string;
  passed: boolean;
  failedChecks: string[];
  at: string;
  /** 当前 Worker execution lineage；旧 acceptance 可没有这些字段。 */
  runId?: string;
  taskId?: string;
  taskExecutionId?: string;
  attemptId?: string;
}

export interface AcceptancePersistence {
  append(record: AcceptanceRecord): Promise<void>;
  load(): Promise<AcceptanceRecord[]>;
}

/** 宿主清理审批（一次性 + 绑定版本/状态/验收）。 */
export interface CleanupApproval {
  worktreePath: string;
  worktreeId?: string;
  branch?: string;
  branchRevision?: string;
  branchRevisionRequired?: boolean;
  runId?: string;
  taskId?: string;
  taskExecutionId?: string;
  attemptId?: string;
  attempt?: number;
  baseRevision?: string;
  stateSignature?: string;
  acceptanceId?: string;
  /** 绑定的验收所属任务/阶段（cleanup 校验 acceptance 三元组） */
  orchestrationId?: string;
  stageId?: string;
  taskStatus?: 'succeeded';
  cleanupStatus?: 'active';
  approvedAt: string;
  consumed: boolean;
}
