# `projectControl` 代码地图

> 以当前源码为准；这是阅读导航，不是新的执行入口或事实源。文件名表中的名称均相对 `src/projectControl/`。

## 职责与边界

`projectControl` 把项目级计划、会话、Issue、TaskGraph 与 Worker 生命周期表达为可审阅的命令、领域事件、投影和恢复/清理决策。Worker 相关模块负责运行状态协调、事件一致性、证据读取、recovery 与 cleanup proposal；Tauri/Dev adapter 执行宿主 I/O，React/App 与 store 负责组装和呈现。当前应用装配点是 `src/app/workerRuntime.ts` 与 `src/App.tsx`。

## 入口与调用者

### Command facade

`src/projectControl/commands.ts` 是命令 re-export 门面；实现按事实类型放在 `commands/`：

| Owner | 主要入口 | 用途 |
| --- | --- | --- |
| `src/projectControl/commands/issues.ts` | `createIssueCommand`、`transitionIssueCommand` | 创建 Issue 与推进 Issue 状态 |
| `src/projectControl/commands/session.ts` | `startProjectSessionCommand`、`linkOrchestrationCommand`、`approveBriefCommand`、`approveArchitectureCommand` | 会话、Orchestration 关联与阶段审批 |
| `src/projectControl/commands/masterTurn.ts` | `applyMasterTurnCommand` | 将 Master turn 结果转成控制面事实 |
| `src/projectControl/commands/projectPlanning.ts` | `proposeProjectPlanCommand`、`approveProjectPlanCommand`、`dispatchDepartmentWorkPackageCommand` | 项目计划及部门 Work Package |
| `src/projectControl/commands/taskGraph.ts` | `generateTaskGraphCommand`、`reviseTaskGraphCommand`、`approveTaskGraphCommand` | TaskGraph 草案、修订与审批 |
| `src/projectControl/commands/shared.ts` | `ProjectControlCommandResult`、`appendFact`（内部 helper） | 共用结果类型与事件累加辅助函数 |

直接调用门面命令的 UI 包括 `src/components/IssueBoard.tsx`、`src/components/OrchestratorPanel.tsx` 和 `src/components/ProjectSessionPanel.tsx`；后者也调用 Worker 入队命令。先由命令返回新的 snapshot/events，再由调用方记录事件并持久化。

### Controller 与装配入口

| 路径 | 创建/调用入口 | 责任 |
| --- | --- | --- |
| `src/projectControl/projectLifecycleController.ts` | `createProjectLifecycleController` | 接入项目切换、加载、恢复后的生命周期工作 |
| `src/projectControl/workerRunRecoveryAuditController.ts` | `createWorkerRunRecoveryAuditController` | 启动/加载时恢复、审计并投影 Worker facts |
| `src/projectControl/workerRecoveryIoController.ts` | `createWorkerRecoveryIoController` | 读取 Worker Evidence，并恢复中断的 side effect |
| `src/projectControl/workerActionController.ts` | `createWorkerActionController` | 校验并提交用户 recovery 决定，必要时派发 retry |
| `src/projectControl/workerCleanupProposalController.ts` | `createWorkerCleanupProposalController` | 为 UI 刷新 ready/blocked/cleaned cleanup proposal |
| `src/projectControl/workerCleanupActionController.ts` | `createWorkerCleanupActionController` | 校验 proposal、审批并执行 cleanup |
| `src/projectControl/workerRunCoordinator.ts` | `createGuiProjectWorkerRunCoordinator`、`createProjectWorkerRunCoordinator` | 组合 worktree allocator、runtime executor、Acceptance 和 transition persistence |
| `src/projectControl/workerRunSessionAdmission.ts` | `admitWorkerRunSession` | Worker host wiring 前验证已保存项目与 GUI session |
| `src/projectControl/workerRunTransitionPersistence.ts` | `createWorkerRunTransitionPersistence` | 把运行 transition、events、Evidence 投影与项目保存接到一起 |
| `src/app/workerRuntime.ts` | `createAppWorkerRuntime` | 注入 store、Tauri、event repository 与 project-operation ports，组合上述 controllers |
| `src/App.tsx` | `createProjectLifecycleController` | 挂接 React 项目生命周期；不是 Worker 事实 owner |

## 子系统表

| 分组 | 文件名（相对 `src/projectControl/`） | 职责 | 主要导出 |
| --- | --- | --- | --- |
| Run 生命周期 | `workerRun.ts` | 从传入 TaskGraph 创建 Run queue projection 与初始事件，已有匹配 Run 时保持幂等。 | `enqueueWorkerRunCommand` |
| Run 生命周期 | `workerRunCoordinator.ts` | 选择 Run、可选执行前一致性校验，并把每个 transition 交给持久化回调。 | `createGuiProjectWorkerRunCoordinator`、`createProjectWorkerRunCoordinator`、`workerWorktreePathFor` |
| Run 生命周期 | `workerRunRuntime.ts` | 从持久化 facts 重建可执行 registry；仅显式选择后运行一个 Run。 | `rehydrateWorkerRunRegistry`、`runActiveWorkerRun`、`installWorkerRunRuntime`、`getRestoredWorkerRunForCleanup` |
| Run 生命周期 | `workerRunSessionAdmission.ts` | 在 Worker host 装配前核对项目/session admission。 | `admitWorkerRunSession` |
| Run 生命周期 | `workerRunHostInfrastructure.ts` | 延迟加载并组装 Worker 运行所需的 host repository/side-effect infrastructure。 | `createWorkerRunHostInfrastructure` |
| Run 生命周期 | `workerHostRepositoryBundle.ts` | 通过模块 loader 创建 Evidence 与 Host repository bundle。 | `createWorkerHostRepositoryBundle`、`createWorkerEvidenceRepositoryBundle` |
| Run 生命周期 | `workerRunRehydration.ts` | 从 durable events 重建、恢复缺失 projection，并对现有 snapshot 做重放核对；不完整 lineage 不补造状态。 | `rehydrateWorkerRunsFromEvents`、`restoreMissingWorkerRunsFromEvents`、`reconcileWorkerRunsFromEvents` |
| Run 生命周期 | `workerRunTransitionPersistence.ts` | 串接 transition event、ProjectFile 和 Evidence/side-effect projection 的持久化。 | `createWorkerRunTransitionPersistence` |
| Run 生命周期 | `workerRunOrchestrationProjection.ts` | 将 Worker Run 状态投影到 Orchestration，并抑制不可信 projection。 | `projectWorkerRunsOntoOrchestrations`、`suppressInvalidWorkerRunProjection`、`selectLatestWorkerRun` |
| Run 生命周期 | `workerRunTransitionProjection.ts` | 以现有 Run/Orchestration projections 和一个已准入 transition 计算 next state；不生成 events。 | `projectWorkerRunTransition` |
| Run 生命周期 | `workerRunView.ts` | 为界面生成 Worker、task、Evidence 与 side-effect 的只读 view。 | `workerRunViewsFor` |
| Run 生命周期 | `workerWorktreeRestore.ts` | 在恢复时向 host 重新注册已有 Worker worktrees。 | `restoreWorkerWorktrees` |
| 一致性与审计 | `workerRunConsistency.ts` | 比较 Run、TaskGraph、Acceptance 与 durable event facts，生成有序 issues/report。 | `auditWorkerRunConsistency` |
| 一致性与审计 | `workerRunConsistencyAction.ts` | 调用一致性审计并在不一致时阻断外部执行。 | `assertWorkerRunConsistency` |
| 一致性与审计 | `workerRunRecoveryAuditController.ts` | 组织加载后的 event replay、facts audit、recovery suppression 和 projection 更新。 | `createWorkerRunRecoveryAuditController` |
| 恢复事实 | `workerRecoveryFactsTypes.ts` | 声明版本化 `worker-recovery-facts-v1` DTO 与 task/effect/project fact 类型。 | `WorkerRecoveryFactsV1`、`WorkerRecoveryFactsInput` |
| 恢复事实 | `workerRecoveryFactsSource.ts` | 从可信项目状态构建规范化 recovery facts。 | `buildWorkerRecoveryFactsV1` |
| 恢复事实 | `workerRecoveryFactsRules.ts` | 提供 DTO、身份、路径、revision 与集合规则的共享校验/规范化原语。 | `assertKeys`、`canonicalPath`、`assertTaskAttemptInvariant` |
| 恢复事实 | `workerRecoveryFactsNormalization.ts` | 规范化已验证的 facts DTO。 | `normalizeFactsDto` |
| 恢复事实 | `workerRecoveryFactsDtoValidation.ts` | 校验直接输入的版本化 recovery facts DTO。 | `validateFactsDto` |
| 恢复事实 | `workerRecoveryFactsCanonicalJson.ts` | 输出稳定顺序的 JSON 表示。 | `canonicalizeJsonValue` |
| 恢复事实 | `workerRecoveryFactsFingerprint.ts` | 对规范化 facts 产生 canonical JSON 与 fingerprint。 | `canonicalizeWorkerRecoveryFactsV1`、`fingerprintWorkerRecoveryFactsV1` |
| 恢复事实 | `workerRecoveryFacts.ts` | 从可信 cleanup receipt 协调已完成清理，并识别未知副作用对应的 Run。 | `reconcileSuccessfulCleanupReceipts`、`cleanupUnknownRunIds` |
| Recovery 决定与命令 | `workerRecoveryCapabilityProjection.ts` | 从 canonical recovery plan 投影当前可点击的 retry/skip actions（不含 inspect）。 | `projectWorkerRecoveryActions` |
| Recovery 决定与命令 | `workerRecoveryDecisionPrecondition.ts` | 比较提交前重新读取的 facts 与已捕获决定，拒绝 stale/drift。 | `assertWorkerRecoveryDecisionPrecondition` |
| Recovery 决定与命令 | `workerRecoveryDecisionPersistence.ts` | 持久化 decision admission/commit 状态并实施锁与 CAS 冲突处理。 | `WorkerRecoveryDecisionPersistence`、`WorkerRecoveryDecisionCasError` |
| Recovery 决定与命令 | `workerRecoverySingleFlight.ts` | 进程内 admission guard 按 projectId/projectPath/runId 阻断重复 active 请求；重复 acquire 返回 null，不是合并或 durable lock。 | `createWorkerRecoverySingleFlight` |
| Recovery 决定与命令 | `workerRecoveryCommand.ts` | 把 recovery plan/decision 转换为 queue state 与领域事件。 | `recoverWorkerRunCommand` |
| Recovery 决定与命令 | `workerRecoveryIoController.ts` | 连接 GUI host、Evidence repository、项目保存与中断 side-effect recovery。 | `createWorkerRecoveryIoController` |
| Recovery 决定与命令 | `workerActionController.ts` | 重新读取当前 Run/TaskGraph，持久化 recovery decision，再按 post-commit 状态分派 retry。 | `createWorkerActionController`、`assertCandidateCanReplay` |
| 清理 | `workerCleanup.ts` | 构建 ready/blocked/cleaned proposal，绑定 state fingerprint，审批并验证 cleanup action。 | `buildWorkerCleanupProposal`、`approveWorkerCleanupProposal`、`cleanupApprovedWorker` |
| 清理 | `workerCleanupProposalController.ts` | 基于当前项目 facts 刷新 UI cleanup proposals。 | `createWorkerCleanupProposalController` |
| 清理 | `workerCleanupActionController.ts` | 对当前可信 Run/Task 与 proposal 做二次校验，再完成 approval/cleanup 调用。 | `createWorkerCleanupActionController` |
| 清理 | `workerCleanupExecution.ts` | 调用 host cleanup 并协调 receipt 结果。 | `executeWorkerCleanupWithReceipt` |
| 清理 | `workerCleanupCommand.ts` | 把已完成 cleanup 变为 Worker task/event 状态迁移。 | `markWorkerTaskCleaned` |
| 清理 | `workerCleanupReceiptTrust.ts` | 检查 receipt 与 Worker task 绑定及 native read-back 证据。 | `cleanupReceiptMatchesWorkerTask`、`cleanupReceiptHasTrustedNativeReadback` |
| 交付与证据 | `workerEvidence.ts` | 读取并合并 Worker Evidence 与 side-effect records。 | `loadWorkerEvidence`、`mergeWorkerEvidence`、`loadWorkerSideEffects`、`mergeWorkerSideEffects` |
| 副作用与证据 | `workerSideEffects.ts` | 构建 recovery plan、执行 decision 纯转换，并提供 Evidence/Acceptance/side-effect recorder/verifier。 | `buildWorkerRunRecoveryPlan`、`applyWorkerRunRecoveryDecision`、`createWorkerSideEffectRecorder` |
| 交付 | `workerDelivery.ts` | 生成 artifact candidate，创建 approval 并输出 delivery receipt。 | `buildArtifactCandidate`、`createArtifactDeliveryApproval`、`deliverArtifactCandidate` |

## 一次 Worker Run 的主流程

1. **派发**：`enqueueWorkerRunCommand`（`src/projectControl/workerRun.ts`）基于获批 `ProjectTaskGraph` 创建 Run snapshot 和 events；`src/components/ProjectSessionPanel.tsx` 接线到 store/event buffer。
2. **Admission 与恢复**：`admitWorkerRunSession`（`src/projectControl/workerRunSessionAdmission.ts`）确认保存项目与 GUI session；`rehydrateWorkerRunsFromEvents` / `rehydrateWorkerRunRegistry`（`src/projectControl/workerRunRehydration.ts`、`src/projectControl/workerRunRuntime.ts`）恢复事实但不自动重跑副作用。
3. **执行前核验**：`assertWorkerRunConsistency`（`src/projectControl/workerRunConsistencyAction.ts`）读取 event stream、Acceptance 与当前 ProjectFile facts；Run/TaskGraph drift 会阻止外部工作。
4. **执行与 Acceptance**：`createGuiProjectWorkerRunCoordinator` → `createProjectWorkerRunCoordinator` → `runActiveWorkerRun` → `runWorkerQueue`（`src/projectControl/workerRunCoordinator.ts`、`src/projectControl/workerRunRuntime.ts`、`src/domain/workerQueue.ts`）；GUI coordinator 组装 worktree allocator、Codex/Antigravity executor 与 host `Acceptance`，每个 transition 通过 `createWorkerRunTransitionPersistence` 落盘。
5. **Recovery**：加载审计由 `createWorkerRunRecoveryAuditController` 发起；用户动作由 `createWorkerActionController` 重新核验 facts，经 `recoverWorkerRunCommand` 生成新状态/events，并使用 `WorkerRecoveryDecisionPersistence` 的 admission/CAS 与 post-commit 状态约束 retry dispatch。
6. **Cleanup**：`createWorkerCleanupProposalController` 刷新 proposal；`createWorkerCleanupActionController` 二次核对可信 run、task 与 stage；`executeWorkerCleanupWithReceipt` 调用 host，随后 `markWorkerTaskCleaned` 校验 receipt 与当前 execution/attempt/read-back 后记录完成事实。Recovery/cleanup 都不是 Run 文本或 UI projection 自我声明的成功。

## 术语表

| 术语 | 定义与类型位置 |
| --- | --- |
| ProjectTaskGraph | 获批版本化任务图，含 `graphVersion` 与 tasks；类型 `ProjectTaskGraph`，`src/projectControl/types.ts`。 |
| ProjectTask | 图内的计划 task、依赖和状态定义；类型 `ProjectTask`，`src/projectControl/types.ts`。 |
| graphVersion | TaskGraph 的版本字段，用于将 Run 与所依据的任务图版本绑定；`ProjectTaskGraph`，`src/projectControl/types.ts`。 |
| WorkerRunQueueState | 一个 Run 的持久化 queue snapshot；类型 `WorkerRunQueueState`，`src/domain/workerQueue.ts`。 |
| WorkerQueueTask | Run 内按 task id 索引的 task/attempt/worktree 状态；类型 `WorkerQueueTask`，`src/domain/workerQueue.ts`。 |
| TaskExecutionId | 一个 Task 执行谱系的稳定 id，与 run/task 身份绑定；类型别名 `TaskExecutionId`，`src/domain/execution.ts`；相关 ADR-SM-014。 |
| AttemptId | 单次 attempt 的稳定 fencing id；类型别名 `AttemptId`，`src/domain/execution.ts`；相关 ADR-SM-014。 |
| ContextPack | 面向一次受限执行的版本化上下文载荷；类型 `ContextPack`，`src/projectControl/protocol.ts`；相关 ADR-SM-027。 |
| DomainEvent | 项目事实流中的单条带 stream/aggregate/version 的事件；类型 `DomainEvent`，`src/domain/contracts.ts`；相关 ADR-SM-015。 |
| EvidenceRecord | Host 为一次执行记录的 Evidence 状态与来源；类型 `EvidenceRecord`，`src/dev/evidence.ts`。 |
| AcceptanceRecord | Host 对某个 orchestration/stage 的验收记录；类型 `AcceptanceRecord`，`src/dev/sessionContracts.ts`。 |
| SideEffectRecord | 外部副作用的 idempotency、lineage 与 outcome 记录；类型 `SideEffectRecord`，`src/domain/contracts.ts`；相关 ADR-SM-037。 |
| CleanupReceipt | Host cleanup 的目标、outcome 与 read-back 记录；类型 `CleanupReceipt`，`src/domain/contracts.ts`；相关 ADR-SM-040。 |
| WorkerRecoveryFactsV1 | Recovery fingerprint 所用的 versioned、规范化项目事实 DTO；类型 `WorkerRecoveryFactsV1`，`src/projectControl/workerRecoveryFactsTypes.ts`；相关 ADR-SM-084（设计基线，不表示 durable CAS 已闭合）。 |
| WorkerRecoveryDecisionRecord | Durable recovery 请求及 post-commit 状态；类型 `WorkerRecoveryDecisionRecord`，`src/projectControl/workerRecoveryDecisionPersistence.ts`；相关 ADR-SM-084（设计基线，不表示 durable CAS 已闭合）。 |
| WorkerRecoverySingleFlightLease | 进程内 recovery admission 成功后用于释放占用的 lease；类型 `WorkerRecoverySingleFlightLease`，`src/projectControl/workerRecoverySingleFlight.ts`；重复 key 返回 null，非 durable CAS；相关 ADR-SM-084。 |
| WorkerCleanupProposal | ready/blocked/cleaned 三态的清理建议 union；类型 `WorkerCleanupProposal`，`src/projectControl/workerCleanup.ts`；相关 ADR-SM-040。 |
| WorkerRunRehydrationResult | 从 durable events 重建 Run snapshot 与 issue 列表的结果；类型 `WorkerRunRehydrationResult`，`src/projectControl/workerRunRehydration.ts`；相关 ADR-SM-015。 |
| ArtifactDeliveryReceipt | 已批准交付文件的路径/hash 与结果记录；类型 `ArtifactDeliveryReceipt`，`src/projectControl/workerDelivery.ts`；相关 ADR-SM-040。 |
| WorkerRunView | 面向 UI 的 Run/task/Evidence/side-effect 只读视图；类型 `WorkerRunView`，`src/projectControl/workerRunView.ts`。 |

## 三个常见任务从哪读起

- **修 recovery 缺陷**：从 `src/projectControl/workerActionController.ts` 的 UI action 与 `src/projectControl/workerRecoveryIoController.ts` 的 host wiring 追起；再沿 `src/projectControl/workerRecoveryFactsSource.ts`、`src/projectControl/workerRecoveryCommand.ts`、`src/projectControl/workerRecoveryDecisionPersistence.ts` 查事实、迁移与 CAS。相关边界回归可从 `src/projectControl/workerActionController.cas.test.ts` 和 `src/projectControl/workerRecoveryDecisionPersistence.test.ts` 找。
- **增加控制面命令**：从 `src/projectControl/commands.ts` 确认 facade，再选 `src/projectControl/commands/` 下对应 owner；检查 UI caller 如何记录返回的 events，并在对应命令测试中覆盖 snapshot/event 行为。
- **修改任务图结构**：先读 `src/projectControl/types.ts` 的 `ProjectTaskGraph` / `ProjectTask`，再检查 `src/projectControl/commands/taskGraph.ts`、`src/projectControl/taskGraphProjection.ts`、`src/projectControl/workerRun.ts` 对版本、任务依赖与 Worker dispatch 的消费；搜索所有调用者和相关 projection/command tests 后再改。
