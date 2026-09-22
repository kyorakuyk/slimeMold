# Hierarchical Agent Company and Long-Running Project Plan

> **For Hermes:** 只在用户确认本计划后执行；执行时使用 SlimeMold development workflow、test-driven-development 和 agent-native-knowledge-architecture。当前回合只建立计划，不修改业务代码。

**Goal:** 将 SlimeMold 从一层式 `Master → Worker` 编排推进为面向超长任务与超大规模项目的分层 Agent 组织：由主控负责全局目标和决策，部门/项目主管负责大型功能，小组长负责模块，Worker 负责受限施工，所有进度由结构化摘要、证据、文档和可重放 DAG 生长过程支撑。

**Architecture:** 采用“固定职责层级 + 动态子任务图 + 单调收缩的信息权限”模型。Domain Event、Task、TaskExecution、Attempt、Evidence、Acceptance、Receipt、Decision 和版本化文档是事实源；Summary/ProgressCapsule 是上行读模型；ContextPack 是下行按任务生成的最小上下文；DAG 和 Workflow UI 是事实投影，不是事实源。Agent 角色不直接拥有权限，权限由任务 scope、数据类别、工具 capability、delegation budget 和有效期共同决定。

**Tech Stack:** Tauri 2 + Rust native host、React/TypeScript、Zustand、Vitest、Git worktree、Project Control Event Store、JSONL Evidence/Acceptance/Receipt、结构化 Agent message envelope、后置 Zod runtime validation。

**Decision record:** 跨阶段的产品与架构取舍、替代方案、状态和来源统一记录在 `docs/architecture/SLIMEMOLD_ARCHITECTURE_DECISIONS.md`；本计划只保留当前阶段的实现顺序和待确认项。

---

## 0. Current Baseline and Non-Negotiable Constraints

- 当前实现基线：`phase2/taskgraph-issue-dag-projection`，HEAD `2719b786b44827468e23d6e014df400c4f08bf04`。
- `main` 为 `11948df68bdbbeddf83ff09a1d3c71b9a83bf54a`；Phase 2 尚未 push 或 merge。
- 当前已有：主控会话、Brief/Architecture/TaskGraph、Task Issue materialization、WorkerRun projection、IssueBoard、OrchestratorPanel DAG、DAG revision command、Rust cleanup capability 和基础 recovery。
- 当前缺口：Project Delivery Architect 规划/可行性/部门拆包 Workflow、层级化 Manager/Module Lead、Summary/Index/Evidence query、ContextPack 强制边界、delegation anti-bypass、FeedbackRequest、Evidence/Knowledge Steward、Integration/Release、Security/Risk、Operations/Recovery、动态 child/workflow DAG 生长 replay，以及真实 Tauri 端到端证明。
- `D:/Agents/SMtest` 必须保持不变；真实验收只使用仓库外 disposable fixture。
- `.hermes/`、`.workbuddy/`、`IDEA.md` 和 `src-tauri/icons/**` 的既有 untracked 素材不得用 `git add .` 纳入。
- 不自动 Cleanup，不自动 push/merge，不因 Agent 自报成功、headless exit 0 或单条截图标记 `[verified]`。
- 未取得最终 reviewer `passed=true` 和真实 Tauri read-back 前，控制面保持 `mvp-closed-unverified`。

---

## 1. Recommended Organization Model

### 1.1 Recommended hierarchy

```text
用户 / 项目所有者
        ↓ 目标、预算、最终高影响决策
主控 Agent / CEO
        ↓ 项目组合与全局决策
Project Delivery Architect（项目总设计与承建）
        ↓ 需求、概要设计、可行性、里程碑与部门 Work Package
Program Director / Department Head（部门主管）
        ↓ 大功能、业务能力或成熟功能的交付结果
Module Lead / Tech Lead（小组长）
        ↓ 模块设计、接口、施工计划与 Worker 编排
Worker / IC Engineer（执行 Worker）
        ↓ 一个受限 Task/Attempt 的代码、测试、文档和 Evidence
Specialist Child Agent（测试、调研、文档、安全等专门子任务）
```

另设一个不等同于 Agent 职位的确定性系统层：

```text
SlimeMold Control Plane / Orchestrator
```

它负责 lease、权限、scope、预算、调度、重试、事件、恢复、冲突和审计，不参与自然语言决策，不应被模拟成“公司里的一个聪明员工”。

### 1.2 Role responsibilities and authority

| 层级 | 推荐名称 | 负责什么 | 可以决定什么 | 不可以做什么 |
|---|---|---|---|---|
| 0 | 用户 / Project Owner | 目标、优先级、最终高影响决定 | 批准范围、架构、执行、发布、清理 | 不应被迫阅读所有 Worker 原始上下文 |
| 1 | Master Agent / CEO | 全局目标、项目组合、跨部门取舍、最终计划建议 | 在已授权范围内批准/升级高影响决策，安排部门预算 | 不直接读取所有源码，不直接替代 Worker 施工 |
| 2 | Project Delivery Architect | 需求分析、概要设计、可行性、风险、里程碑、跨部门接口和 Work Package | 在 CEO 批准意图内形成项目方案、提出 PlanRevision、下发部门级计划 | 不绕过 CEO/用户修改全局目标、预算或最终 Acceptance |
| 3 | Program Director / Department Head | 一项大功能或成熟能力的端到端交付 | 拆分部门 TaskGraph、管理跨模块依赖、整合摘要、向上反馈决策请求 | 不绕过 Module Lead 给 Worker 随意扩大上下文 |
| 4 | Module Lead / Tech Lead | 一个模块的技术合同、接口、Task 分解、Worker 分配和集成审查 | 在已批准范围内调整模块内执行顺序、生成 ContextPack、发起受限子任务 | 不改变全局目标、预算或跨模块契约而不升级 |
| 5 | Worker / IC Engineer | 一个明确 Task/Attempt 的实现、测试、文档、Evidence | 在 ContextPack 范围内写代码、运行允许工具、提出反馈和子任务建议 | 不自行批准结果、不读取全局、不扩大权限、不静默改变计划 |
| 6 | Specialist Agent | 一个证据生产型子任务，如测试循环、调研、文档、安全检查 | 只在 child scope 内产出结果和 Evidence | 不继承父级全部上下文，不把隐藏信息原文带回父级 |
| 横向 | Independent Reviewer / QA | 独立质量判断、风险、Acceptance 建议 | 通过/拒绝验证结果，提出修复 | 不与被审 Worker 共用未隔离的执行权限 |
| 横向 | Evidence / Knowledge Steward | 汇总 Evidence、Decision、Artifact、摘要和索引；发现 stale/dangling 引用 | 生成 Summary/Index 投影，报告档案缺口 | 不修改事实源，不用摘要替代原始证据 |
| 横向 | Integration / Release Manager | 跨部门分支、接口、集成测试、Release Candidate | 提出整合顺序和发布候选 | 不绕过 QA、Security 或用户批准直接 merge/release |
| 横向 | Security / Risk / Red-Team Reviewer | 权限升级、Prompt Injection、凭据、范围和风险审查 | 对危险动作提出阻断或升级 | 不因模型共识自动放行风险 |
| 横向 | Operations / Recovery Manager | 长任务 checkpoint、restart、unknown effect、incident 和恢复 | 提出 retry/skip/inspect/recovery 方案 | 不静默重跑 destructive action，不改变项目目标 |
| 系统 | Control Plane | 状态、租约、权限、预算、重放、恢复和审计 | 允许/拒绝访问与状态迁移 | 不替 Agent 做业务判断，不用 UI 状态作为事实源 |

### 1.3 Cross-functional roles are not extra hierarchy

这些角色是横向保障和项目服务，不应再堆成 CEO 下面的固定管理层：

- **Evidence / Knowledge Steward**：接近 PMO、Configuration Management 和 Project Archivist，负责把事实编译成 `TaskSummary`、`ProgressCapsule`、Evidence index 和 Manager Brief；只能生成投影、发现缺口和标记 stale，不能重写 Event/Evidence/Acceptance。
- **Integration / Release Manager**：接近 Release Manager/System Integrator，负责跨部门输出的接口兼容、分支整合、集成测试和 Release Candidate；Merge/Release 仍是高影响动作，必须经过独立验证和用户/策略确认。
- **Security / Risk / Red-Team Reviewer**：可以阻断越权、凭据泄露、Prompt Injection、scope escalation 和未知副作用，并可直接升级到 Control Plane/用户；不属于普通交付链。
- **Operations / Recovery Manager**：接近 SRE/Incident Commander，负责暂停、恢复、unknown、orphan、checkpoint 和长任务运行稳定性；不能因为恢复方便而自动重试破坏性动作。
- **Resource / Capacity Manager**：不建议做成额外 Agent 层，优先作为 Control Plane 的确定性预算、并发和租约服务。

### 1.4 Project Delivery Architect as a standalone workflow

`Project Delivery Architect` 承接 Master 的批准意图，组合需求分析、概要设计、可行性、风险、里程碑和部门拆包。它内部可以按需实例化以下虚拟岗位，而不必永久启动多个 Agent：

```text
Requirements Analyst
Solution Architect
Feasibility / Risk Analyst
Program Planner
Package Dispatcher
Plan Arbiter / Review Board
```

它可以读取下层的 Summary、Feedback 和受控 Evidence 引用，形成 `ProjectPlan`、`DepartmentWorkPackage` 或 `PlanRevision`；下层不能直接改写上层计划。高风险或模型意见分歧时才触发有预算和轮数上限的多模型 Review Board；模型投票只能形成建议，不能替代事实验证或用户最终决定。

### 1.5 Why this is better than adding more company titles

建议采用“核心交付链 + 横向专家”，而不是固定堆叠很多管理层：

```text
CEO → Project Delivery Architect → Department Head → Module Lead → Worker
```

对小任务可以跳过中间层；对超大任务才允许承建方、Module Lead 创建受限 Specialist Child。层级深度应由 TaskGraph 的规模、风险、依赖和预算决定，而不是每个任务都强制经过完整官僚链。

“部长”更适合实现为 `Program Director / Department Head`：它对一项大功能的交付结果负责，而不是只做消息转发。小组长更接近 `Tech Lead / Module Lead`：它拥有模块技术拆分和 Worker 协调责任，但不拥有全局目标修改权。

---

## 2. Information Flow Model

### 2.1 Upward compression

每层向上只发送当前层需要的结构化摘要：

```text
Specialist Evidence
  → Worker ProgressCapsule
    → Module Lead ModuleSummary
      → Department FeatureSummary
        → CEO GlobalProjectSummary
```

摘要不能只是一段自然语言，应至少包含：

```text
summaryId
sourceVersion
scope
status
confidence
completionBasis
evidenceRefs
acceptanceRefs
decisionRefs
changedFilesSummary
childTaskSummary
blockers
ambiguities
decisionNeeded
cost/time
lastUpdated
staleAt
```

以下字段应由系统从事实投影，而不是由 Agent 自己决定：

- Task/Attempt 状态；
- Evidence/Acceptance 是否存在；
- changed files 数量和范围；
- child task 数量；
- 依赖是否完成；
- 是否存在 unknown、stale、conflict 或 recovery。

Agent 可以生成解释性文字，但必须标记为 derived，并保留来源引用。

### 2.2 Controlled evidence lookup

Manager 默认只接收 Summary，但可以按需查询证据。推荐查询顺序：

1. **Exact reference**：`EvidenceRef`、`AcceptanceRef`、`DecisionRef`、`ArtifactRef`；
2. **Typed index**：按 project/task/run/attempt/status/kind/time/scope 过滤；
3. **Keyword search**：解决未知术语和自然语言表达；
4. **Bounded graph traversal**：沿 `produces`、`supports`、`blocked_by`、`depends_on` 查询上下游；
5. **Semantic/vector search**：只做最后的候选发现，不作为授权或事实判断。

建议提供有界操作，而不是把原始 Event Store 直接交给 Manager：

```text
get_summary(summaryId)
resolve_reference(ref)
search_evidence(filters, keywords, budget)
traverse_lineage(rootId, relations, maxDepth, budget)
list_blockers(scope)
```

每次查询结果都应带：

```text
matchedRefs
whyMatched
sourceVersion
scope
redactions
truncated
budgetUsed
```

“没有检索到 Evidence”不等于“Evidence 不存在”；结果必须区分 `empty`、`truncated`、`out-of-scope`、`needs-repair` 和 `not-found`。

### 2.3 Downward narrowing

Worker 获得的是任务专属 ContextPack，而不是 Manager 的完整上下文：

```text
CEO context
  ⊃ Department context
    ⊃ Module context
      ⊃ Worker ContextPack
        ⊃ Child ContextPack
```

每个 ContextPack 至少绑定：

```text
taskId
parentTaskId
rootTaskId
projectId
taskGraphId
taskGraphVersion
contextVersion
allowedFiles
allowedDocuments
allowedEvidenceRefs
allowedDataClasses
allowedTools
acceptanceCriteria
relevantDecisions
dependencies
excludedContext
budget
expiresAt
digest
```

ContextPack 是授权边界，不只是提示词模板。任何文件、Evidence、Document、Agent message 或工具调用都必须通过 scope gateway 校验。

---

## 3. Delegation and Anti-Bypass Model

### 3.1 Delegation is a command, not a raw Agent call

禁止提供无约束的：

```text
spawnAgent(name, prompt)
```

统一使用：

```text
DelegationRequest
  → policy validation
  → scope derivation
  → budget reservation
  → child Task creation
  → child lease
  → execution
  → Evidence/summary return
```

DelegationRequest 至少包含：

```text
delegationId
parentTaskId
childTaskId
rootTaskId
requestedRole
purpose
allowedFiles
allowedDataClasses
allowedTools
allowedEvidenceRefs
maxDepth
maxFanout
budget
deadline
expiresAt
expectedOutputs
```

### 3.2 Monotonic scope inheritance

子代理有效权限必须满足：

```text
ChildScope
  = ParentScope
  ∩ PolicyScope
  ∩ ChildTaskScope
  ∩ DataClassScope
```

永远不能发生：

```text
ChildScope = ParentScope ∪ ChildTaskScope
```

因此：

- 子代理不能访问父 Worker 未获授权的文件或 Evidence；
- 子代理不能通过另一个子代理间接取得隐藏内容；
- 子代理不能把“调研”作为理由升级到全局搜索；
- 子代理输出默认只能是 schema 允许的摘要和引用；
- 原始细节不能通过自由文本字段偷偷回传；
- 被拒绝的访问必须记录，但不能泄露被拒绝对象内容。

### 3.3 Recursion controls

每个 root Task 和 delegation chain 都必须有：

```text
maxDepth
maxFanout
maxConcurrentChildren
totalTokenBudget
totalTimeBudget
totalMoneyBudget
allowedRoles
allowedTools
allowedDataClasses
retryBudget
```

还需要：

- `parentTaskId/rootTaskId` 防止孤儿节点；
- delegation graph cycle detection；
- idempotency key 防止重复 child；
- child lease expiry；
- 父 Task 关闭时 child 的终态处理；
- child failed/unknown 时父 Task 不得伪装成成功；
- 超预算后只能等待上层决策，不能自动扩大预算。

### 3.4 Escalation chain

正常反馈路径：

```text
Worker → Module Lead → Department Head → CEO → User
```

但安全、凭据泄露、跨项目访问、未知副作用等紧急事件允许直接升级到 Control Plane/User，并留下 escalation reason。普通业务歧义不能绕过中间层制造管理噪声。

---

## 4. Feedback and Ambiguity Model

Worker 遇到歧义时必须生成 `FeedbackRequest`，并将当前 Task 标记为 `waiting-feedback` 或 `blocked`：

```text
FeedbackRequest {
  feedbackId
  taskId
  parentTaskId
  attemptId
  contextVersion
  ambiguity
  affectedScope
  affectedAcceptance
  options
  recommendation
  blocking
  requestedBy
  sourceRefs
  expiresAt
}
```

流程：

```text
Worker detects ambiguity
→ freeze risky side effects
→ FeedbackRequest
→ Module Lead resolves local ambiguity or escalates
→ Decision / PlanRevision / TaskGraphRevision
→ invalidate old ContextPack
→ issue new ContextPack
→ Worker resumes
```

规则：

- 没有答案时不得猜测；
- 如果答案只影响模块实现顺序，可由 Module Lead 在授权范围内处理；
- 如果改变 Acceptance、跨模块接口、预算或目标，必须升级；
- 如果改变 TaskGraph，必须生成新 revision；
- FeedbackRequest 本身不是自由聊天，不应触发无限往返。

---

## 5. DAG, Workflow, and Visible Growth

### 5.1 Three related but distinct graphs

```text
Project TaskGraph
  └── 项目目标、Task、Issue、依赖、负责人、Acceptance

Execution WorkflowGraph
  └── 某个 Task 或阶段如何具体执行

Delegation/Child Graph
  └── Worker 如何生成子任务、测试循环和专家 Agent
```

三者通过 lineage 关联，但不互相冒充：

```text
Task
→ WorkflowRevision
→ Attempt
→ ChildTask/Subgraph
→ Evidence
→ Acceptance
```

### 5.2 Event-sourced growth

节点生长不直接 mutate UI，而是产生事件：

```text
TaskCreated
TaskDelegated
ChildTaskCreated
WorkflowRevisionCreated
SubgraphExpanded
WorkerStarted
FeedbackRequested
DecisionResolved
EvidenceCaptured
AcceptanceRecorded
TaskCompleted
TaskBlocked
```

一个节点的可视化生命周期：

```text
planned
→ delegated
→ workflow-created
→ worker-running
→ child-test-loop-created
→ child-evidence-returned
→ parent-integrating
→ acceptance
→ summary-collapsed
```

用户可以查看完整生长事件和数据流；Manager 默认只看到当前节点摘要和 Evidence 引用；Worker 只看到自己的 ContextPack 和允许的 child scope。

### 5.3 Worker-created test loop

Worker 可以建议或创建测试子任务，但必须：

- 绑定父 Task/Attempt；
- 明确 child purpose；
- 继承更窄 scope；
- 有独立 budget；
- 产生独立 Evidence；
- 不允许改变父 Task 的 Acceptance；
- 不允许自行宣告父 Task 完成；
- 由父 Worker 汇总，最终由 Acceptance/Reviewer 确认。

---

## 6. Implementation Phases

### Phase A: Freeze the organizational and security contract

**Objective:** 不写大功能，先确定 CEO、Project Delivery Architect、Department Head、Module Lead、Worker、Specialist 以及横向 Evidence/Knowledge、Integration/Release、Security/Risk、QA 和 Operations/Recovery 角色的责任、决策权、信息范围、摘要字段、ContextPack 字段、delegation scope 和预算模型。

**Likely files:**
- `src/projectControl/types.ts`
- `src/domain/contracts.ts`
- `src/projectControl/commands.ts`
- new `src/projectControl/hierarchy.ts`
- new `src/projectControl/protocol.ts`
- new `src/projectControl/projectPlanning.ts`
- new `src/projectControl/rolePolicy.ts`

**Acceptance:** 能用结构化类型表达角色、Task hierarchy、Summary、ContextPack、DelegationRequest 和 FeedbackRequest；能区分 Agent role 与 runtime capability。

### Phase B: Build the Project Delivery Architect workflow

**Objective:** 将 Master 的批准意图转成需求基线、概要设计、可行性分析、风险、里程碑和 Department Work Package；允许按风险触发受限的多模型 Review Board，但不让模型共识替代用户批准或事实验证。

**Likely files:**
- new `src/projectControl/projectPlanning.ts`
- new `src/projectControl/requirements.ts`
- new `src/projectControl/feasibility.ts`
- new `src/projectControl/workPackages.ts`
- new `src/projectControl/planningReview.ts`
- `src/projectControl/commands.ts`
- `src/projectControl/taskGraph.ts`
- `src/projectControl/types.ts`

**Acceptance:**
- `ProjectPlan`、`RequirementsBaseline`、`FeasibilityAssessment`、`Milestone`、`DepartmentWorkPackage` 和 `PlanRevision` 有稳定 ID、版本、来源和审批状态；
- 承建方可读取下层 Summary/Feedback/Evidence 引用，但不能直接改写下层事实；
- 计划未批准前不能 dispatch 可执行 Department Task；
- 多模型辩论有 max rounds/models/tokens/cost，输出假设、分歧、EvidenceRefs 和未决用户问题；
- 下层反馈只生成影响分析或 PlanRevision，不静默改变全局计划。

### Phase C: Build the evidence-backed Progress Projection

**Objective:** 从现有 TaskGraph/Issue/WorkerRun/Evidence 构建分层 Summary，而不是另建进度事实源；把 Evidence/Knowledge Steward 落成增量 projection/index 服务，并产出 Department、Module、Worker 三种摘要粒度。

**Likely files:**
- new `src/projectControl/progressSummary.ts`
- new `src/projectControl/evidenceIndex.ts`
- new `src/projectControl/summaryAccessPolicy.ts`
- `src/projectControl/taskGraphProjection.ts`
- `src/projectControl/projectControlConsistency.ts`
- `src/components/IssueBoard.tsx`
- `src/components/OrchestratorPanel.tsx`

**Acceptance:** Manager summary 的状态、Evidence、Acceptance、Blocker 和 lineage 全部可回溯；stale/conflict/unknown 可见；summary 不包含默认原始 Worker transcript。

### Phase D: Implement bounded evidence retrieval

**Objective:** 给 Manager 提供 exact ref、typed index、keyword、bounded graph traversal 查询，所有查询有 scope 和 budget。

**Likely files:**
- new `src/projectControl/retrieval.ts`
- new `src/projectControl/queryPolicy.ts`
- `src/domain/eventStore.ts`
- `src/domain/sideEffects.ts`
- tests for exact reference, metadata filter, keyword, traversal, truncation and out-of-scope.

**Acceptance:** Manager 可以从摘要定位目标 Evidence；无关上下文不会自动展开；查询不会产生执行权限；结果带 source/version/budget/truncation provenance。

### Phase E: Enforce ContextPack at Worker boundaries

**Objective:** 让 Worker 的文件、文档、Evidence 和工具访问真正受 ContextPack 约束。

**Likely files:**
- new `src/projectControl/contextPack.ts`
- `src/dev/capabilities.ts`
- `src/dev/worktree.ts`
- `src/dev/session.ts`
- `src-tauri/src/lib.rs`
- `src/projectControl/workerRunRuntime.ts`

**Acceptance:** Worker 只能读写 allowed scope；missing context 只能产生 FeedbackRequest；scope digest/version drift fail-closed；Node/Tauri 双宿主行为一致。

### Phase F: Add controlled hierarchical delegation

**Objective:** 实现 Project Delivery Architect、Department Head、Module Lead、Worker 和 Specialist Child 的受控下发，不允许通过 child 绕过权限。

**Likely files:**
- new `src/projectControl/delegation.ts`
- new `src/projectControl/delegationPolicy.ts`
- `src/domain/workerQueue.ts`
- `src/projectControl/workerRunCoordinator.ts`
- `src/projectControl/workerRecoveryCommand.ts`
- Rust/native capability boundary

**Acceptance:** child scope 只能收缩；depth/fanout/token/time/money budget 生效；delegation graph 不可循环；child 原始输出不会绕过 parent scope；failed/unknown child 会正确阻塞父任务。

### Phase G: Add structured feedback and escalation

**Objective:** 让 Worker 的歧义反馈通过事件、Decision 和 TaskGraph revision 闭环。

**Likely files:**
- new `src/projectControl/feedback.ts`
- `src/projectControl/commands.ts`
- `src/projectControl/taskGraph.ts`
- `src/projectControl/taskGraphProjection.ts`
- `src/components/ProjectSessionPanel.tsx`
- `src/components/OrchestratorPanel.tsx`

**Acceptance:** ambiguity 会冻结风险动作；局部问题由 Module Lead 处理；范围/接口/预算变化升级；旧 ContextPack 失效；新决策可追溯。

### Phase H: Visualize DAG and Workflow growth

**Objective:** 用户能看到静态 TaskGraph 如何逐步展开成 Workflow、ChildTask、测试循环和 Evidence 回流。

**Likely files:**
- `src/canvas/WorkflowEditor.tsx`
- `src/components/TaskGraphDAGView.tsx`
- `src/components/OrchestratorPanel.tsx`
- new `src/components/TaskGrowthTimeline.tsx`
- new `src/projectControl/graphGrowthProjection.ts`

**Acceptance:** DAG 通过 event replay 还原；Task/Workflow/Child Graph 不混淆；用户可查看完整数据流；Manager 看到摘要；Worker 看不到无关细节；UI 不能直接改事实状态。

### Phase I: Long-running scheduling, recovery and cost control

**Objective:** 支撑超长任务：checkpoint、暂停、恢复、预算、handoff、unknown、Integration/Release 协作和跨层故障。

**Likely files:**
- `src/domain/workerQueue.ts`
- `src/projectControl/workerRunCoordinator.ts`
- `src/projectControl/workerSideEffects.ts`
- `src/projectControl/workerRecoveryCommand.ts`
- `src/domain/sideEffects.ts`
- new `src/projectControl/integrationRelease.ts`
- `src-tauri/src/lib.rs`

**Acceptance:** 重启后层级 Task、scope、delegation lease、summary、feedback、Evidence 和 unknown side effect 一致；不会因重启自动扩大权限或重复 destructive action；Integration/Release 只能基于通过 QA/Security 的 Evidence 生成候选，不能直接绕过批准 merge/release。

### Phase J: Runtime schemas, benchmarks and final review

**Objective:** 协议稳定后引入窄范围 Zod，并用真实 fixture 测量 token、检索和协作收益。

**Likely files:**
- `package.json`
- `src/projectControl/protocol.ts`
- `src/projectControl/contextPack.ts`
- `src/projectControl/delegation.ts`
- `src/projectControl/progressSummary.ts`
- Evidence/Acceptance/Receipt parsers

**Acceptance:** malformed external records 进入 needs-repair/recovery；不全量替换内部 TS 类型；比较无摘要/全量上下文/结构化摘要三种 baseline；取得 exact final HEAD reviewer `passed=true` 后才讨论 push/merge。

---

## 7. Verification and Benchmark Matrix

### Functional

- CEO 可以只通过 GlobalProjectSummary 了解项目整体状态；
- Department Head 可以追踪某项大功能的跨模块依赖；
- Module Lead 可以创建受限 ContextPack 和 child Task；
- Worker 可以专注一个 Task 并生成代码、测试、Evidence；
- Specialist 可以建立测试循环但不能升级 scope；
- Evidence/Knowledge Steward 可以重新生成摘要和索引，并报告 stale/dangling evidence；
- Integration/Release Manager 可以形成 release candidate，但不能绕过 QA/Security/User gate；
- Security/Risk Reviewer 可以阻断危险 scope、凭据、Prompt Injection 和未知副作用；
- Operations/Recovery Manager 可以提出 recovery，但不能静默重跑 destructive action；
- Project Delivery Architect 可以承接批准意图、生成里程碑和 Department Work Package；
- Worker 遇到歧义能阻塞并 feedback；
- 用户能查看完整 DAG growth timeline；
- restart 能恢复同一层级和 lineage。

### Security / boundary

- Manager 默认无 raw Worker transcript；
- Worker 无法读取 ContextPack 外的文件和 Evidence；
- ChildScope 永远是 parent scope 的子集；
- “让另一个 Agent 读取”不能绕过 scope；
- 引用可发现不等于拥有执行权限；
- prompt injection 或文档中的 capability 指令不能自动成为授权；
- query、delegation、denied access、feedback 和 revision 都有审计来源。

### Efficiency

记录并比较：

```text
manager_input_tokens
worker_context_tokens
child_context_tokens
irrelevant_context_ratio
evidence_query_tokens
retrieval_precision / recall
summary_staleness_rate
delegation_count / depth / fanout
feedback_resolution_time
agent_calls
latency
money_cost
```

目标不是“所有请求都更短”，而是减少无关上下文，同时保持 Evidence recall、Acceptance 正确率和审计完整度。

### Required commands after implementation

```bash
npm run test
npm run build
npm run i18n:check
cargo test --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
git diff --check
```

此外必须有：

- disposable Tauri GUI success/failure/restart fixture；
- ProjectFile/event/Evidence/Acceptance/Receipt/Git read-back；
- delegation anti-bypass tests；
- ContextPack out-of-scope tests；
- stale summary and stale ContextPack tests；
- strict JSON independent reviewer against exact final HEAD。

---

## 8. Main Risks and Decisions

1. **层级过深导致官僚化**：默认四层主链，允许小任务跳级；只在规模、风险或依赖足够大时增加层级。
2. **摘要成为新的错误事实源**：摘要必须是 versioned projection，关键字段由事实计算，自由文本必须带引用。
3. **索引误检或漏检**：exact refs 优先，关键词只做候选，图遍历有 depth/budget，semantic search 不授予权限。
4. **子代理权限洗白**：scope 单调收缩、child output schema、查询 gateway、拒绝访问审计和 delegation budget 必须同时存在。
5. **Manager 变成 token 瓶颈**：摘要应增量生成、按版本缓存、引用优先；不要每次重新压缩完整历史。
6. **动态 DAG 变成前端幻觉**：所有成长事件必须 durable；UI 只能重放和投影，不能以画布状态代替事实。
7. **长任务状态爆炸**：必须区分 summary、raw evidence、current context、historical event，不能把全部历史塞进每个 Agent prompt。
8. **Zod 迁移过早**：先稳定协议和失败矩阵，再只覆盖外部不可信边界。
9. **独立审查失效**：Reviewer 不应是 Worker 的下属；最终 verdict 必须针对 exact HEAD，旧 verdict 不得迁移。
10. **横向角色过度 Agent 化**：Evidence/Knowledge、Resource/Capacity、部分 Operations 能力优先做成确定性 Control Plane 服务；只有需要判断的风险、集成和复盘才启动 Agent。
11. **承建方成为消息中转瓶颈**：Project Delivery Architect 必须生成可复用的 Work Package 和版本化计划，不得每个下层消息都重新读取全局历史。
12. **交付和验收职责冲突**：Integration/Release 不能替代 Independent QA/Security；同一 Agent 不得同时产生结果、批准结果并执行高影响发布。

## 9. Open Decisions Before Implementation

在正式开工前需要确认以下产品策略：

1. `Department Head` 是否允许在批准预算内自动创建 Module Lead，还是每次都需要用户确认？建议：低风险、预算内自动；跨模块/预算/权限变化升级。
2. 用户是否希望默认看到全部 DAG growth，还是默认只看到阶段摘要、点击后展开事件？建议：默认摘要，用户可展开完整流。
3. Manager 查询 Evidence 后，是否把查询结果写入其临时 Context，还是只允许单次 ephemeral inspection？建议：默认 ephemeral；需要跨轮保留时生成带引用的 Decision/Review Note。
4. 横向角色是否常驻？建议：Evidence/Knowledge、Resource/Capacity、基础 Operations 作为 Control Plane 服务；QA/Security/Integration 只在风险、交付或审查节点按需启动。
5. 部门是按长期能力池还是按项目临时创建？建议：采用矩阵模型；Department Head 管理可复用能力池，Project Delivery Architect 为当前项目创建临时 Work Package，不复制整家公司。
6. 什么条件触发多模型 Review Board？建议：由风险、跨部门影响、预算、方案分歧和不确定性阈值共同触发，并设置 max rounds/models/tokens/cost。

计划完成后，下一步仍应先做 Phase A 的协议评审和最小 RED 矩阵，不直接开始实现递归 Agent。
