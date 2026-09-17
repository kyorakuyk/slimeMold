# ChangeSet 与 GitHub 多仓库生态实施计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 将 SlimeMold 的本地 Git/worktree 施工事实扩展为可连接远端 GitHub、多仓库和跨项目交付的 ChangeSet 控制面，同时保持 DomainEvent、Evidence、Acceptance、Receipt 和用户可追溯权的单一事实边界。

**Architecture:** `ChangeSet` 成为连接 Project、Task/Attempt、Repository、Worktree、Commit、Pull Request、CI Evidence、Acceptance 和 Delivery 的一级对象。Git、GitHub 和 CI 都是外部/代码事实观察源，不替代 Control Plane；所有远端写操作都经过 External Operation Ledger 和宿主权限边界。议会只对绑定 immutable snapshot 的证据作决策，不能改写事实或绕过宿主硬门。

**Tech Stack:** TypeScript/React/Tauri/Rust；现有 `Project / TaskGraph / Task / TaskExecution / Attempt / Evidence / Acceptance / Receipt / DomainEvent`；本阶段先使用显式 TypeScript contracts 和 conformance fixtures，不全量引入 Zod。

---

## 必须先建立的版本化架构协议

本计划不是直接为 ChangeSet/GitHub 编写运行时代码；Phase 0 必须先产出一份可审阅、可版本化、可做 conformance test 的架构协议：

- 协议名：`SlimeMold ChangeSet & External Repository Protocol v1`；
- 明确协议范围：`Project / Repository / ChangeSet / ChangeSetComponent / Worktree / Commit / GitObservation / RemoteObservation / ExternalOperation / IntegrationAttempt / Evidence / Acceptance / Receipt / CouncilDecision`；
- 明确每个对象的稳定 ID、版本、scope、状态机、lineage、source、digest、trust level 和权限边界；
- 明确 Local Git、GitHub/远端 provider、Control Plane、Evidence/Acceptance 之间的权威关系；
- 明确 event type、payload、idempotency key、receipt、recovery 和 replay 规则；
- 明确 immutable snapshot、Context Gateway、Council vote、veto、quorum、benchmark version 和 decision provenance；
- 明确 retention、pin、GC、磁盘预算和不可自动删除的事实类型；
- 明确协议版本与对象 schema version 的区别：协议 major 版本不兼容时必须迁移或拒绝，minor 版本允许向后兼容扩展；
- 明确升级矩阵、旧事件/旧 ProjectFile 的 migration、未知字段策略、降级读取策略和 conformance vectors；
- 明确 `v1` 一旦被 runtime 使用，不能通过静默修改文档改变语义，必须产生 `v2` 或显式 migration。

**协议产物（Phase 0）：**

- Create: `docs/architecture/changeset-external-repository-protocol-v1.md`
- Create: `src/projectControl/protocolVersion.ts`
- Create: `src/projectControl/protocolConformance.test.ts`
- Create: `tests/cases/architecture-protocol-v1/` 下的 JSON/YAML conformance fixtures
- Modify: `docs/README.md`，加入协议、版本、迁移和 conformance 入口

**协议门禁：**

- 没有协议版本、兼容矩阵和 conformance fixtures，不开始 GitHub 写操作、不改变 Worker 成功语义；
- 任何 runtime contract 变更必须先更新协议和失败 fixture，再写实现；
- 外部不可信边界优先加入 runtime validation；不因为协议版本化而全量替换现有 TypeScript 类型。

---

## 已确认的设计边界

### 事实分工

```text
Git / GitHub                  代码状态、commit 谱系、branch、PR、CI 的外部观察
Control Plane / DomainEvent   用户意图、需求、审批、任务、权限、预算、决策
Host Evidence                 实际命令、测试、diff、路径策略和宿主观察
Acceptance                    是否满足确定性验收条件
Receipt / Delivery            是否完成外部副作用、merge 或交付
Council                      改变后续决策，不改写已经观察到的事实
```

GitObservation 可以证明某个 worktree/ref 在某个时刻的代码状态，但不能单独证明任务完成、授权、Acceptance 或 Delivery。

### Worktree / commit

- Worker Attempt 必须产生 commit；禁止 push/merge。
- Worker commit 保留 author；SlimeMold 宿主固定 committer，并写入 Run/Task/Attempt/baseRevision trailers。
- Attempt 内采用 append-only commit 历史；禁止 amend、rebase、reset 改写已有链。
- 交付后 branch、commit 历史和物理 Worktree 默认保留，只有用户明确批准 Cleanup 才清理。
- 目标分支发生变化时，不改写原 Worker branch；重新建立 Integration/Delivery Attempt。

### Council

- 用户可指定 Council；未指定时按领域 benchmark 选择成员。
- 议会成员使用隔离上下文和不同视角；同一模型的多个隔离角色可计为独立视角，但完整累加权重，并显示模型家族相关性风险。
- 需求只能依据已批准、版本化的 Brief/Requirements/Decision 判断背离；需求变化必须形成修订或用户决策。
- Security 只对 secret、系统/环境修改、越权路径、远程破坏性操作等硬风险一票否决；普通风险进入加权投票。
- QA 是正式议会成员，可以投质量票，但不能推翻宿主硬 Acceptance。
- 事实不可改写；议会只能选择调查、重试、跳过、请求复审或其它后续动作。
- 投票首轮独立进行；后续轮次只看到匿名加权结果、理由聚类和证据引用，不看到成员身份及逐票。
- 最多三轮；仍未达成共识则交给用户，用户不处理时解散并重开。
- Council 配置采用 `Global Default → Project Override → Decision Snapshot`；一次议会开始后成员、权重、benchmark 版本和 veto 规则冻结。议会不能修改自己的权限边界。

### Snapshot / Context

- 议会使用 affected-module/dependency-closure barrier，不冻结无关项目任务。
- 所有成员基于同一个 immutable GitObservation，不读取 live mutable worktree。
- 读取经 snapshot-bound Context Gateway，按角色、scope、文件数、字节数和 token 预算限制。
- Security 只能看到脱敏配置视图；原始 secret 留在宿主信任域。
- GitObservation 采用引用 + 内容寻址 artifact；tracked 文本保存 patch，untracked/二进制/特殊文件保存 blob、manifest、mode 和 digest。
- 轻量观察保持实时；完整 GitObservation 只在 TaskStarted、commit observed、Acceptance、Council snapshot、Delivery、Recovery 等里程碑生成。
- 成功交付后的完整快照默认保留，只有用户取消 pin 或明确批准 GC 才回收。

### 初版性能 guardrails（暂定，需 benchmark 调整）

```text
active Worker worktree 默认 8，项目上限 32
轻量 GitObservation 目标 p95 < 500ms（中型仓库）
完整 GitObservation 目标 p95 < 10s（中型仓库）
20% 可用空间：warning
10% 或 10GB：停止新增高副作用 Worker，先释放可再生缓存
5% 或 5GB：停止 worktree allocation 和 snapshot blob 写入
```

Evidence、Acceptance、Receipt、unknown、quarantined 和用户 pin 内容不能被磁盘压力自动删除。

---

## 主要缺口与风险

1. 当前本地 Worktree 模型仍然过于单仓库中心，需要 ChangeSet 支持多 Repository component。
2. GitHub PR、Issue、CheckRun、Review 和 Merge 状态是最终一致的外部观察，不应直接作为内部任务事实。
3. 多仓库 merge 没有原子事务，需要 Integration Saga、MergeOrder、CompensationPolicy 和 `integration-partial` 状态。
4. 远端 push/PR/review/merge/delete branch 等操作需要独立 External Operation Ledger、幂等键、receipt 和 read-back。
5. 当前真实 Tauri Worker E2E 暴露了 Windows/Git worktree 路径长度边界；Worker identity/path 需要 bounded naming 和长度预算。
6. path-policy 与外部 build/test 之间仍有 TOCTOU；需要 process-tree fence 和 oracle 前后的 branch/path revalidation。
7. allocation 后取消可能造成 orphan worktree/branch；需要 durable registration 或 cancellation-safe rollback。
8. succeeded receipt 需要 Acceptance/Evidence 的完整 orchestration/stage/task lineage read-back，而不只要求 evidenceIds 和 acceptanceId。

---

## 实施阶段

### Phase 0：协议与基准冻结（只读设计切片）

**目标：** 不改变现有执行路径，先定义多仓库和外部观察协议。

**拟新增文件：**

- `src/projectControl/changeSet.ts`
- `src/projectControl/changeSet.test.ts`
- `src/projectControl/repository.ts`
- `src/projectControl/repository.test.ts`
- `src/projectControl/gitObservation.ts`
- `src/projectControl/gitObservation.test.ts`
- `src/projectControl/externalObservation.ts`
- `src/projectControl/externalObservation.test.ts`
- `src/projectControl/contracts.ts`（仅在现有 contracts 不适合承载时新增，避免第二套任务系统）

**协议要求：**

- `ChangeSet` 必须引用现有 Task/TaskExecution/Attempt，不建立第二套任务对象。
- `ChangeSetComponent` 绑定 `repositoryId/baseRevision/attemptId`。
- `GitObservation` 区分 declared、observed、accepted、delivered。
- 所有外部引用携带 provider、externalId、observedAt、sourceVersion 和 digest。
- 不允许将 token、密码、Bearer、连接字符串等写入 observation/artifact。
- 任何 observation 都必须能指回 source/ref/commit/diff artifact。

**验证：**

- schema/conformance fixtures：缺字段、错 project、错 repository、dangling ref、版本漂移、重复 observation、digest 不匹配全部 fail-closed。
- 不改 App、Worker queue 或 GitHub API。

**Checkpoint：** `feat: define changeset and repository observation contracts (unverified)`

### Phase 1：本地 GitObservation 只读适配器

**目标：** 将现有 WorktreeManager/Worker lease 的代码状态转成宿主观察，不改变 Worker 成功语义。

**拟修改/新增：**

- `src/dev/worktree.ts`
- `src/dev/workerAllocator.ts`
- `src/domain/workerQueue.ts`
- `src/projectControl/gitObservation.ts`
- `src/projectControl/persistence.ts`
- `src/projectControl/gitObservation.test.ts`
- `src/dev/worktree.test.ts`
- `src/domain/workerQueue.test.ts`

**行为：**

- 采集 `baseRevision/headRevision/mergeBase/branch/changedFiles/diffDigest/branchRevision`。
- Worker identity 与 branch/worktree basename 使用短、稳定、可碰撞检测的标识；完整 AttemptId 保留在 durable metadata。
- 观察与 ProjectFile/Event/Evidence 通过 `observationId` 关联。
- commit 观察是 metadata-first；完整 patch/blob 只在里程碑采集。
- Worktree cleanup 仍需要用户批准，不因 observation 引入自动 Cleanup。

**测试：**

- 长 Windows 路径、长 branch basename、同一 attempt 重放、branch tip 漂移、worktree 缺失、orphan branch、路径冲突。
- 取消发生在 allocation 返回后、TaskStarted flush 前；要求 rollback 或 durable recovery record。

**Checkpoint：** `fix: make local git observations and worktree lifecycle bounded (unverified)`

### Phase 2：Host Acceptance / Receipt provenance gate

**目标：** succeeded receipt 必须绑定完整 Acceptance/Evidence lineage。

**拟修改：**

- `src/dev/workerAcceptance.ts`
- `src/dev/codexWorkerExecutor.ts`
- `src/projectControl/workerSideEffects.ts`
- `src/dev/session.ts`
- `src/projectControl/workerDelivery.ts`
- `src/projectControl/workerCleanup.ts`
- 对应 `*.test.ts`

**行为：**

- 成功必须有 durable Acceptance read-back。
- Acceptance 必须匹配 run/task/taskExecution/attempt/orchestration/stage/worktree。
- Evidence 必须匹配 host origin、baseRevision、worktree、orchestration/stage 和同一 attempt。
- acceptanceId/evidenceIds 只在对应 durable records 可读回后进入 receipt。
- 旧/跨 stage/跨 orchestration record fail-closed。

**测试：**

- passed verdict 无 acceptanceId；
- acceptanceId 存在但内容错；
- Evidence 来自另一个 stage/orchestration；
- Evidence 落盘后 acceptance 持久化失败；
- cancellation 注入在 Evidence/Acceptance 持久化前后；
- receipt 重放和 recovery read-back。

**Checkpoint：** `fix: bind worker receipt to acceptance provenance (unverified)`

### Phase 3：GitHub read-only adapter

**目标：** 先只观察 GitHub，不执行 push/merge/delete 等外部写操作。

**拟新增：**

- `src/projectControl/remoteRepository.ts`
- `src/projectControl/remoteObservation.ts`
- `src/projectControl/githubProvider.ts`
- `src/projectControl/externalOperation.ts`（先支持 observation/read operations）
- 对应 tests 和 disposable provider fixtures

**覆盖：**

- remote repository metadata/ref；
- PR head/base/number/state；
- check runs/status；
- reviews/required approvals；
- branch protection/policy metadata；
- webhook cursor + polling reconciliation；
- provider failure/rate limit/stale response。

**约束：**

- GitHub Issue/PR 不成为第二任务系统，只保存 external reference。
- GitHub API 返回内容是 untrusted external input。
- credentials 由 host connector 管理，Agent 看不到原始 token。
- 所有 observation 绑定 commit SHA 和 provider observedAt。

**Checkpoint：** `feat: observe remote repository state read-only (unverified)`

### Phase 4：External Operation Ledger 与 GitHub PR 写操作

**目标：** 在 read-only observation 稳定后，逐步增加 push/create PR/request review 等能力。

**拟修改/新增：**

- `src/projectControl/externalOperation.ts`
- `src/projectControl/externalOperation.test.ts`
- `src/projectControl/githubProvider.ts`
- `src/projectControl/githubProvider.test.ts`
- `src/projectControl/receipts.ts`

**顺序：**

1. push branch；
2. create/update PR；
3. request review；
4. observe checks/reviews；
5. merge only after policy + Acceptance + read-back；
6. remote branch deletion only as explicit cleanup operation。

**每个写操作：**

```text
planned → authorized → started → provider observed → receipt
```

API 返回成功但 read-back 不一致时进入 unknown/recovery，不自动重试高影响操作。

**Checkpoint：** 每个外部操作独立提交，禁止把 push、PR、merge 堆在一个 checkpoint。

### Phase 5：多仓库 ChangeSet 与 Integration Saga

**目标：** 支持一个 Project/Task 影响多个 Repository，而不假装拥有跨仓库原子事务。

**拟新增：**

- `src/projectControl/changeSetRuntime.ts`
- `src/projectControl/integrationPlan.ts`
- `src/projectControl/integrationSaga.ts`
- `src/projectControl/integrationSaga.test.ts`
- `src/projectControl/repositoryGraph.ts`
- `src/projectControl/repositoryGraph.test.ts`

**行为：**

- 一个 ChangeSet 可以包含多个 RepositoryComponent。
- 每个 component 有独立 base/head/PR/Acceptance/Delivery receipt。
- merge 顺序、依赖、compatibility check 和 compensation policy 显式记录。
- 任一仓库失败时进入 `integration-partial`，不伪造全局 rollback。
- 目标分支漂移时建立新的 IntegrationAttempt，不改写原 Worker branch。

**测试：**

- 两仓库成功；
- 一个仓库 merge、另一个失败；
- PR head 漂移；
- CI stale；
- provider outage；
- retry 幂等；
- compensation 不可行时进入人工 recovery。

**Checkpoint：** `feat: add multi-repository changeset integration saga (unverified)`

### Phase 6：Council / Snapshot-bound Context Gateway

**目标：** 将已确认的议会规则和角色视角落地为受限决策层。

**拟新增：**

- `src/projectControl/council.ts`
- `src/projectControl/council.test.ts`
- `src/projectControl/councilConfig.ts`
- `src/projectControl/contextGateway.ts`
- `src/projectControl/contextGateway.test.ts`
- `src/projectControl/decisionRound.ts`
- `src/projectControl/decisionRound.test.ts`

**行为：**

- `Global → Project Override → Decision Snapshot`；决策开始后冻结。
- Context Gateway 只允许绑定同一个 GitObservation/ChangeSet snapshot。
- 角色视角和文件 scope 最小化；Security 配置脱敏。
- Council 只能产生 Decision 和后续动作，不改写 Evidence/Acceptance/Receipt。
- 需求 hard veto、Security hard categories、QA voting、匿名加权轮次、三轮上限全部事件化。
- benchmark version、domain score、weight 和成员配置进入 Decision provenance。

**Checkpoint：** `feat: add snapshot-bound council decisions (unverified)`

### Phase 7：性能、存储和真实 E2E benchmark

**测试根目录：** 专用 disposable case/test 根，不在仓库根散落临时目录。

**基准维度：**

- 1 万、10 万、100 万级 tracked files；
- 8、32、64 个 worktree；
- cold/warm Git cache；
- untracked scan；
- lightweight observation；
- complete patch/blob snapshot；
- GitHub webhook 延迟与轮询补偿；
- disk usage、dedupe ratio、GC candidate scan；
- Windows 长路径和路径冲突。

**验收链：**

```text
Project/Task
→ ChangeSet
→ Worktree/append-only commit
→ LocalGitObservation
→ Remote branch/PR observation
→ CI/review evidence
→ Council decision
→ Integration attempt
→ merge receipt
→ Delivery receipt
→ user-approved cleanup
→ restart/read-back/replay
```

**最终 gate：**

- `npm run test`
- `npm run build`
- `npm run i18n:check`
- `npm run headless -- examples/headless-demo.json`
- Rust tests/fmt
- GitHub provider conformance fixtures
- Tauri GUI disposable E2E
- 当前最终 HEAD 的严格独立 reviewer JSON

---

## 仍需共同确认的问题

1. Council 配置修改的具体授权：主控 Agent 是否能直接修改，还是只能提案给用户。
2. benchmark 评分归一化、过期衰减、领域不匹配时的精确公式。
3. quorum 与缺席成员的精确定义；当前已确定全权重分母、匿名结果、最多三轮，但还需写成公式。
4. 多仓库失败后的 compensation 是否允许自动执行，还是一律进入 recovery。
5. GitHub App/OAuth 的项目级权限和远端 branch protection 映射。
6. Integration Agent 与 Council 的职责边界。
7. 内容寻址 artifact 的加密、导出、备份和跨机器恢复。

## 实施纪律

- 先写协议和 conformance fixtures，再写 adapter；
- 每个行为遵循 RED → GREEN → targeted → full gate；
- 每个垂直切片立即建立小 checkpoint；
- 初期只做 GitHub read-only，不先执行 push/merge；
- 不使用 `git add .`；保留无关未跟踪计划、IDE 文件和设计素材；
- 不保存任何 token、API key、密码、Bearer 值或连接字符串；
- 在最终 Tauri E2E 和当前 HEAD 独立 reviewer 通过前，状态保持 `mvp-closed-unverified`，不 push、不 merge。
