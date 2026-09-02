---
title: SlimeMold 代码结构审查与后续演进边界
type: codebase-review
date: 2026-09-02
status: actionable-review
authority: implementation-reality
---

# SlimeMold 代码结构审查与后续演进边界

> 本文初版基于 `research/experimental-refactor` 分支 HEAD `40bfe0d`；后续 MVP-2 状态以本文件的进度补充和最新开发日志为准，不是新功能设计稿。
> 目标是判断现有 MVP 是否适合继续承载项目级元 Harness、双向图映射、三态 Graph、Boundary Contract 和交付闭环。
> 本轮修复项目生命周期、插件扫描、manifest 入口和沙箱文件操作等可局部验证的边界缺陷；其余问题先记录为演进边界，避免没有语义契约的“大拆分”。

## 1. 结论先行

当前 Worker recovery MVP 已经具备继续开发的基础；本轮 MVP-2 又完成了执行身份与 attempt replay 的第一条垂直切片，但还不适合直接在现有结构上叠加完整的 Graph Module、Boundary Contract、Context Pack 或 delivery。主要原因不是代码行数，而是以下四个语义边界仍未全部成为代码的一等结构：

1. **事实身份**：`TaskExecutionId`、`AttemptId`、Worker、Evidence 和 Receipt 的基础链已经可重放；`PlanRevision`、Boundary Contract、Runtime Instance 和 Delivery 仍未接入。
2. **命令入口**：画布编辑、编排确认、Worker 启动和项目持久化仍有多条入口，部分路径直接写 Zustand store。
3. **投影边界**：ProjectFile、Zustand、DomainEvent、旧 `runEvents`、Checkpoint、Artifact 和 side-effect journal 并行存在，当前事件流不能独立重建完整 ProjectControl。
4. **能力授权**：文档中的 Boundary Contract、模块 manifest 和 capability 约束还没有成为 Worker lease、宿主调用和验收的机器可验证输入。

因此建议采用：

```text
先定身份与提交边界
    → 再定 Graph Command / Plan Revision
    → 再定 Published Graph Module
    → 再把 Boundary Contract 接入 lease / acceptance
    → 最后统一执行入口和 delivery
```

不建议现在做一次性重写 `App.tsx`、`workflowStore.ts` 或 `executor.ts`，也不建议为了“看起来分层”而建立第二套项目任务系统。

### 1.1 MVP-2 当前实现进度

本轮已完成执行 lineage 的加固切片：

- `src/domain/execution.ts` 提供确定性的 `TaskExecutionId(runId, taskId)` 和 `AttemptId(taskExecutionId, attempt)`，拒绝首尾空白、非法编码和不安全 attempt；所有 host allocator/acceptance/evidence/side-effect/cleanup 入口复用完整 lineage assertion；
- `WorkerTaskLease`、Worker queue 事件、recovery、cleanup proposal/command、side-effect journal、宿主 Evidence/Acceptance 和 Worker read model 携带 execution/attempt 标识；旧快照和旧 `Task` aggregate 事件仍可派生兼容 ID，但显式新 lineage 不再把缺字段记录当 wildcard；
- completion 必须携带当前 attempt fencing token；retry 的队列状态与 replay projection 都清空旧 `currentAttemptId`，旧 Worker 的迟到成功/失败不能覆盖新 attempt；replay 同时校验 aggregateVersion、payload identity、attempt 单调性和终态冲突；
- `DomainProjection.taskExecutions` 按 Run/Task 保存执行投影，`attempts` 按 `AttemptRecord` 保存不可变 attempt 历史；consistency audit 可核验 Evidence、Acceptance 和 side-effect ledger 的实际归属；
- recovery 只处理当前 attempt 的 started/unknown effect，不重置同一 Run 的 receipt/其它任务；cleanup receipt/proposal 校验当前 execution、attempt、worktree 和 receipt key；Worker acceptance 要求 durable Evidence；
- 旧事件流为空时，bootstrap 从旧 `workerRuns` 生成标记为 synthetic 的当前 Worker facts；同一 orchestration 的多个 Worker Run 通过 `stageLogsByRun` 隔离，UI 选择最新 Run；worktree/side-effect/cleanup identity 使用 collision-safe canonical key。

尚未完成的边界仍包括完整 ProjectControl replay、ProjectCommandBus/commit protocol、PlanRevision、Boundary Contract、Host Lease、Artifact acceptance 和 DeliveryReceipt。

## 2. 本轮审查范围与基线

审查了：

- `src/domain/`：DomainEvent、Worker Queue、事件存储、side-effect journal；
- `src/projectControl/`：ProjectControl snapshot、commands、Orchestration、Worker Run、recovery、cleanup；
- `src/engine/` 与 `src/orchestrator/`：旧工作流 executor、RunContext、Pipeline、旧编排执行；
- `src/store/`、`src/App.tsx`、`src/components/`、`src/canvas/`：UI 状态、图编辑和 composition root；
- `src/dev/`、`src/plugins/`、`src-tauri/`：Worker、worktree、host acceptance、插件和宿主边界；
- `docs/principles/SLIMEMOLD_PRODUCT_PHILOSOPHY.md` 及控制面、H2/H3/H4 和 roadmap 文档。

规模信号：

- `src/App.tsx`：约 1,000 行；
- `src/store/workflowStore.ts`：约 2,138 行；
- `src/engine/executor.ts`：约 1,246 行；
- `src/canvas/WorkflowEditor.tsx`：约 1,211 行；
- `src/types.ts`：约 1,173 行；
- `src/components/ProjectSessionPanel.tsx`：约 812 行；
- `src/components/OrchestratorPanel.tsx`：约 814 行。

这些数字本身不是拆分依据，只说明需要优先保护语义边界，而不是继续把新职责加入几个中心文件。

初始结构审查基线验证（MVP-1）：

- `npm run test`：95 个测试文件、776 个测试通过；
- `npm run build`：通过；
- `npm run i18n:check`：991 个 key 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- `git diff --check`：通过。

## 3. 当前真实依赖形态

当前代码大致是下面的结构，而不是文档中的完全分层架构：

```text
React UI / React Flow
  ├─ App.tsx：项目生命周期、Worker 恢复、Evidence、cleanup、插件生命周期、页面组合
  ├─ ProjectSessionPanel：ProjectControl command + Worker Run command + 持久化
  ├─ OrchestratorPanel：旧 Orchestrator command + legacy executor / Worker projection
  └─ WorkflowEditor / SubgraphEditor：React Flow 编辑 + Zustand 直接写入

Zustand workflowStore
  ├─ 工作流定义
  ├─ 画布运行态
  ├─ 项目级 Agent / Artifact / Pipeline / Orchestration
  ├─ ProjectControl snapshot
  ├─ Worker Run registry / recovery / Evidence / side effects
  └─ localStorage persist + project file save facade

执行与控制
  ├─ projectControl commands / persistence / eventBuffer
  ├─ domain Worker Queue / DomainEvent / replay projection
  ├─ engine executor / runEvents / checkpoints
  └─ orchestrator/run.ts（旧路径，仍可直接调用 engine executor）

宿主与扩展
  ├─ dev Session / Worktree / Policy / Acceptance / Evidence
  ├─ Tauri Rust command / event-store lock / path boundary
  └─ pluginManager / registryStore / Web Worker sandbox PoC
```

这个形态可以支撑当前单项目、单次主要执行路径的 MVP，但若直接加入长期并行运行、已发布模块复用或跨 Agent 契约传递，就会出现多个模块同时声称自己拥有事实的情况。

## 4. P0：进入下一条主线前必须解决的语义阻塞

### 4.1 ProjectControl 不是完整事件重放事实源

证据：

- `src/store/workflowSerialize.ts` 与 `src/io/projectIO.ts` 把 ProjectControl、Orchestration、Worker Run、workflows 等多个结构写入项目文件；
- `src/projectControl/persistence.ts` 从 `project.json` 读取 ProjectControl snapshot；
- `src/domain/contracts.ts:81-189` 的 `replayDomainEvents()` 主要归约 Run/Task 稳定字段；
- `src/projectControl/projectControlConsistency.ts` 通过事件摘要核对 snapshot，而不是从事件重建完整 ProjectControl。

当前真实模型是：

```text
project.json snapshot = ProjectControl 恢复入口
      + events.jsonl = Run/Task 审计与部分投影
      + side-effects.json = 副作用恢复依据
      + evidence/*.jsonl = 宿主证据事实
```

这不是错误，但必须明确叫作“snapshot + audit/recovery event stream”，不能把它当成完整 Event Sourcing。否则 Graph Revision、Boundary Contract、Delivery Receipt 的事件会落入一个不能重建它们的投影器。

最小演进：

1. 为 `ProjectControl`、`Plan`、`Execution`、`Delivery` 明确 aggregate/reducer owner；
2. 为每类事件声明 schema version 和 reducer；
3. 保留 snapshot 作为加速恢复，但把 snapshot 的 `lastSequence`、schema version 和 source generation 固化；
4. 增加“从空 snapshot + 全事件流重建”的测试，不要求第一步就迁移全部旧字段。

### 4.2 画布编辑仍绕过语义命令

证据：

- `src/canvas/WorkflowEditor.tsx:236-319` 主画布和 split 画布分别使用 store handler、本地 `applyNodeChanges/applyEdgeChanges` 和直接 `useWorkflowStore.setState()`；
- `src/canvas/SubgraphEditor.tsx` 使用本地 `innerNodes/edges`，保存时调用 `saveSubgraphDef`；
- `src/store/workflowStore.ts:1585-1600` 的 `updateWorkflowGraph()` 直接把图写进 store；
- `src/store/workflowStore.ts` 中 `saveSubgraphDef()` 直接覆盖项目级 subgraph definition。

这与已确认的产品原则不一致：图应该是项目事实的解释和用户意图输入，而不是直接写运行事实。现在位置变化、节点变化、子图变化和运行态仍共享 `FlowNode` / `WorkflowFileInMemory` 结构，未来会导致：

- 修改批准计划时无法区分“布局变化”和“语义变化”；
- 运行中的图可能看起来已改变，但当前 Run 仍执行旧图；
- split editor、普通 editor、Inspector、快捷键各自产生不同的写入路径；
- Graph Module 发布无法定义明确的 revision 边界。

最小演进：

```text
React Flow event
  → GraphIntent
  → GraphCommandDispatcher
  → validate / produce PlanRevision
  → update canonical plan facts
  → re-project to React Flow
```

第一步只需收拢“新增/删除节点、改参数、改语义连线、打包/发布子图”四类操作；移动、缩放、选中、颜色和折叠仍可留在 `LayoutProjection` / view store。

### 4.3 Subgraph 仍是可变 `subgraphId`，不是 Published Graph Module

证据：

- `src/types.ts:752-818` 的 `SubgraphDef` / `NodeGroup` 以项目字典和 `subgraphId` 引用；
- `src/engine/subgraph.ts` 在执行前调用 `flattenSubgraphs()`，按当前定义即时展开；
- `src/types.ts:859-860` 只保存 `subgraphs?: Record<string, SubgraphDef>`，没有发布版本、内容 hash 或不可变 revision；
- `src/types.ts:1112-1117` 的 `DraftStage` 已有来源字段，但没有统一的 Graph Module reference。

因此用户编辑一个子图会改变所有引用和之后的 flatten 结果；已经批准的计划、旧 Run 和未来的交付物无法证明自己使用的是哪一版静态图。

目标边界应是：

```text
DraftGraph
  ──publish──> PublishedGraphModule(moduleId, version, contentHash)
  ──run──────> DynamicRuntimeGraph(runId, revision, lineage)
```

最小演进：

- 父图引用 `moduleId + version`，不能只引用裸 `subgraphId`；
- 编辑已发布模块只产生新 draft，不修改旧版本；
- `flattenSubgraphs()` 的结果必须带 `moduleId → version → graphNodeId → runtimeInstanceId` lineage；
- 视觉 group 不能自动等同于可发布模块，只有显式 pack/publish command 才能创建模块。

### 4.4 BoundaryContract 仍只在文档中存在

证据：

- `docs/architecture/modules/H3_ORCHESTRATOR_DESIGN.md` 已描述 context、scope、capabilities、actions、acceptance、budget、recovery、delegation 和 risk；
- `src/projectControl/types.ts:177-210` 的 `ProjectTask` / `ProjectTaskGraph` 仍主要只有 `scope`、`dependsOn`、`acceptanceCriteria`；
- `src/domain/workerQueue.ts` 的 lease 只携带 Task、Run 和 worktree assignment；
- `src/dev/codexWorkerExecutor.ts` 主要把 `task.scope` 和 acceptance 文本装配进 prompt；
- `src/dev/policy.ts` 的 `SelfDevelopmentPolicy` 是 H4 开发能力策略，不等同于每个子任务的 BoundaryContract。

风险是：UI 的“勾选项”会看起来像安全控制，但实际执行仍只看到字符串 scope 和全局/开发策略，无法验证：

```text
Child Contract ⊆ Parent Contract
Boundary Contract → Risk Evaluation → Required Controls
```

最小演进：

- 先建立纯数据 `BoundaryContract`、规范化函数和 `narrowChildContract(parent, child)`；
- contract 必须带 `contractVersion`、`contractHash`，并绑定 TaskGraph、Task、Worker lease、Evidence 和 recovery；
- 没有能力或边界的字段不能默认“全允许”；未知字段应 fail-closed；
- `Quick / Guided / Controlled` 只作为投影标签，不能成为执行内核分支。

### 4.5 SandboxHandle 不能被当作完整文件系统隔离

独立安全审查确认了当前沙箱句柄的边界不足：

- `src/engine/executor.ts` 原先将插件提供的 `filename`、`otherNodeId` 和 `laneIds` 直接拼接到沙箱路径；
- `src/plugins/sandbox/SandboxManager.ts` 的能力 responder 会把这些参数传给真实 `ExecContext.sandbox`；
- `src/plugins/sandbox/protocol.ts` 的 `sandbox_write` 白名单仍包含 `readFrom/list`，因此普通沙箱节点需要宿主进一步限制可读车道；
- 直接使用 `@tauri-apps/plugin-fs` 的路径写入没有复用 H4 宿主侧的 symlink/O_EXCL 防护。

这意味着 Web Worker 的线程隔离不能自动等同于路径隔离；在不可信插件场景下，`../`、Windows drive/ADS、任意上游节点 id 或 symlink 都必须被宿主拒绝。

本轮已先加入词法路径、单组件 node/lane id 和宿主声明上游 lane 的校验，但仍未宣称完成完整文件系统隔离。下一步应把 sandbox 文件操作迁移到宿主派生 API，补齐真实 Tauri symlink 与跨平台回归测试。

### 4.6 插件信任域和 manifest 能力仍是显式前提

当前 `src/plugins/loader.ts` 已明确记录：非沙箱插件在主 WebView 通过 Blob `import()` 执行，当前插件被视作用户显式安装的可信本地代码。`PluginManifest` 的 `files/dir` 来源仍可声明较高 `minCapability/extends`，而主窗口同时持有文件、网络、凭据和开发命令相关入口。

这在“可信本地插件”产品假设下是已知边界，不应被描述成第三方插件安全沙箱。若未来 Static Graph Module 支持网络下载或团队共享的不可信模块，必须先建立：

- trust domain、签名/digest 和用户批准状态；
- `approvedMaxCapability`，插件只能请求不能自行扩大；
- 宿主代调用 credential/network/fs，不向插件返还明文凭据；
- 独立进程或受限宿主 RPC，而不是主 WebView 动态 import；
- 每次 RPC 携带 project/run/plugin grant。

## 5. P1：应在接下来一到两个垂直切片内收口的问题

### 5.1 存在两套 Run 身份和两条执行入口

证据：

- `src/engine/runContext.ts:43-63` 的旧 executor 使用 numeric `runId`、`RunResources`、`runEvents` 和 `RunRecord`；
- `src/projectControl/types.ts` / `src/domain/workerQueue.ts` 使用 UUID `WorkerRunQueueState.runId`、attempt、worktree、Evidence 和 side-effect journal；
- `src/orchestrator/run.ts:53-59` 默认依赖直接动态导入 `engine/executor`；
- `src/components/OrchestratorPanel.tsx` 仍可直接触发 `runOrchestration()`；
- `src/components/ProjectSessionPanel.tsx` 的确认路径则创建 Worker Run 并调用 Worker runtime。

`canStartLegacyOrchestration()` 是一个防护闸门，不是统一执行模型。后续应建立：

```ts
interface StartExecutionCommand {
  projectId: string;
  planRevisionId: string;
  boundaryContractHash: string;
  source: 'beginner' | 'professional' | 'api' | 'recovery';
}
```

旧 executor 暂时保留为 `LegacyWorkflowExecutionAdapter`，但新功能不能再直接依赖旧 `runWorkflow()`。

### 5.2 Task replay key：Worker execution lineage 已接入，兼容 task projection 仍会覆盖

证据：

- `src/domain/contracts.ts` 的 `DomainProjection.tasks` 仍以裸 `taskId` 为 key，这是为现有 UI 保留的兼容 projection；
- `DomainProjection.taskExecutions` 现在以 `TaskExecutionId` 为 key，`attempts` 以 `AttemptId` 为 key；新 Worker 事件使用 `TaskExecution` aggregate，并在 payload 中保留 task/run 映射；
- `src/domain/workerQueue.ts` 的旧快照缺少 lineage 字段时，会按 `runId + taskId + attempt` 派生稳定 ID；新 retry 在 claim 时替换 `currentAttemptId`，旧 attempt 不被覆盖。

同一个任务图被重新执行或 retry 时，兼容的 `tasks[taskId]` 仍只代表最后一次 legacy view；需要历史或审计时必须使用 `taskExecutions`/`attempts`。当前 consistency audit 已按 execution 维度比较并报告孤立 execution，但完整 ProjectControl 仍不是从 Worker projection 自动重建。

最小演进：

```text
TaskDefinitionId
  → TaskExecutionId(runId, taskId)
      → AttemptId(runId, taskId, attempt)
          → worktree / Evidence / Acceptance / Receipt
```

当前已经保留旧 `taskId` 作为业务定义 id，并新增 `taskExecutionId` / `attemptId`；reducer、recovery、Evidence/Acceptance 和 cleanup query 已使用新 key，UI 大结构仍待后续 read model 迁移。

### 5.3 Worker retry 已有 AttemptRecord，仍缺计划/契约级 lineage

当前 retry 会创建新 attempt、worktree 和 side-effect key；`DomainProjection.attempts` 已成为可查询的 `AttemptRecord` 投影，保存 attempt 状态、worktree、Evidence、acceptance 和 cleanup receipt。旧 attempt 仍由事件/Evidence/side-effect durable records 提供细节，队列快照只保存当前 task 状态。

后续 delivery 或人工审计需要直接回答：

- 这次交付来自哪个 attempt？
- 前一个失败 attempt 改了什么？
- 两个 attempt 是否使用相同的 plan revision 和 contract？
- 哪些 Evidence 属于失败现场，哪些属于重试结果？

下一步不是再给 `WorkerQueueTask` 堆字段，而是把 `planRevisionId`、`boundaryContractHash`、host lease 和完整 Runtime Instance 关联到现有 `AttemptRecord`，并建立独立 ProjectControl commit protocol。

### 5.4 Artifact 还不是可验收的交付事实

证据：

- `src/types.ts:1030-1049` 的 `Artifact` 以 `(stage, kind)` 组织，payload 是 `unknown`；
- `Artifact.runId` 仍描述 executor 运行代次，不强制关联 Worker Run / attempt；
- `ProjectArtifacts` 是可覆盖的字典，没有 `revision`、`sourceTaskExecution`、`evidenceIds`、`acceptanceId`、`deliveryReceiptId` 或 immutable content hash。

这会让“Evidence → diff → 用户批准 → Receipt”无法形成严格链路。下一步应先定义 `ArtifactCandidate` 和 `ArtifactAcceptance`，而不是继续扩展 `ArtifactKind`：

```text
ArtifactCandidate
  → host acceptance
  → user delivery decision
  → DeliveryReceipt
  → project fact / issue / session projection
```

### 5.5 Command 结果到持久化的提交协议仍分散在调用者

证据：

- `src/projectControl/commands.ts` 返回 snapshot/event 结果；
- `src/App.tsx` 和 `src/components/ProjectSessionPanel.tsx` 各自组合 `recordProjectEvents()`、`setProjectControl()`、更新 Worker/Orchestration，再调用 `saveProject()`；
- `src/projectControl/eventBuffer.ts` 维护内存 pending buffer；
- `src/domain/eventStore.ts`、project file、Evidence 和 side-effect journal 是多份独立持久化。

这会造成典型的部分成功：snapshot 已更新但事件未 flush，事件已 append 但 projection snapshot 未写，或事件已从内存 buffer drain 后后续持久化失败。当前 MVP 通过恢复审计降低了风险，但未来命令数量增长后会变成系统性问题。

最小演进：增加一个 application service：

```ts
applyProjectCommand({ projectId, command, expectedRevision })
  -> validate
  -> produce facts/events
  -> append event batch idempotently
  -> write projection snapshot with same commit/generation
  -> publish read model update
```

第一步可以仍然落盘多个文件，但必须有 `commitId/generation`、重试语义和明确失败状态。

### 5.6 UI composition root 和 Store 仍承担过多应用服务职责

`App.tsx` 已经是项目生命周期与运行服务容器；`workflowStore.ts` 同时承担画布编辑、项目文件、运行状态、控制面、编排和插件相关状态；`engine/executor.ts` 虽已抽出 `runFinalizer`、`runScheduler`、`nodeExecutionPolicy` 和 `ExecutionRuntime`，但仍有大量 `useWorkflowStore.getState()` 读写。

建议按行为外移，而不是按文件大小切割：

1. `ProjectSessionService`：open/close/switch、宿主 session、插件 session epoch、恢复；
2. `ExecutionApplicationService`：Start/Recover/Cleanup/Delivery command；
3. `GraphCommandDispatcher`：所有语义图编辑入口；
4. `ProjectPersistenceCoordinator`：snapshot/event/evidence/journal 提交；
5. React 组件只订阅 read model 并发出 intent。

`App.tsx` 可以继续作为组合根，但不再保存这些服务的业务状态机。

### 5.7 `types.ts` 已成为跨层类型总线

`src/types.ts` 同时包含 React Flow 类型、工作流文件、运行历史、PluginManifest、Artifact、Pipeline、Orchestration 和 ProjectFile；`src/projectControl/types.ts` 又引用其中的 Artifact/Pipeline 类型，`domain/workerQueue.ts` 反向引用 `projectControl/types.ts`。

后续新增字段时会越来越难判断它属于：

- domain fact；
- application command/result；
- persisted DTO；
- React Flow projection；
- plugin ABI；
- runtime-only state。

渐进拆分目标：

```text
src/domain/model/*          纯领域 id、graph、execution、contract、artifact
src/application/*           command、service、commit protocol
src/adapters/reactflow/*    FlowNode/FlowEdge ↔ domain graph projection
src/adapters/persistence/* project/event/evidence/side-effect adapter
src/plugins/contracts/*     Plugin/Graph Module ABI
src/types.ts                兼容 re-export，逐步收窄而不是继续加新模型
```

领域模块不得依赖 React Flow、Zustand、Tauri；UI 适配层负责转换。

### 5.8 插件 Registry 还不是 Graph Module Registry

当前 `src/plugins/pluginManager.ts` 将插件加载结果直接注册到 `src/store/registryStore.ts`；`PluginManifest.version` 是可选字符串，缺少内容 hash、requiredCapabilities、allowedArtifacts、allowedPaths、acceptance/observability contract 和 trust level。

当前 Web Worker sandbox 是线程级隔离 PoC，不是进程级安全域；可信本地插件仍可在主 WebView 路径加载。此事实与现有 H2 文档一致，但不能把它直接当作未来不可信 Graph Module 的权限模型。

进入模块分发前必须先建立：

- `moduleId + version + contentHash`；
- manifest signature/trust state；
- capability negotiation；
- project pin/lock；
- runtime lineage；
- host acceptance 和 module observability contract。

### 5.9 宿主 DevSession 需要项目/会话 epoch 与 lease

现有 H4 底线已经很好：worktree、cwd/path 边界、命令白名单、host Evidence、cleanup approval、receipt 和 Tauri lock 都已存在。但 Tauri DEV_STATE、前端 DevSession、worktree registry 和 responder 仍主要是进程级/当前项目级状态。

项目快速切换或关闭时，异步 teardown、旧 Worker 进程、旧扫描任务和新项目初始化之间必须有明确关联。未来下级 Worker 不能仅凭一个 path 或 agent 名称获得能力。

最小演进：

```text
HostSession(projectId, sessionEpoch)
  → signed/opaque execution lease
      → task/attempt/worktree/capability scope
```

旧 epoch 的调用必须被宿主拒绝；项目切换必须串行完成 teardown，或显式进入“旧进程仍存在、能力已撤销”的 recovery 状态。

### 5.10 Worktree 注册和 Codex 进程仍缺少宿主 lease/supervisor

当前 `run_git` 有严格的 `.slime-wt` 协议，但 Tauri `WorktreeManager` 实际通过 `dev_exec` 执行 Git；`dev_register_worktree()` 主要检查目录存在，没有要求路径来自宿主刚创建的单次 token，也没有把注册动作绑定到 project/run/attempt。未来完整 Worker API 不能让前端凭任意 path 把外部目录登记为可写 worktree。

另外，`src-tauri/src/codex.rs` 的 Worker 路径目前通过 `spawn_blocking + wait_with_output` 等待 CLI，`workspace-write` 依赖 `--approve-for-me` 而非显式传递完整 sandbox 参数；没有持久化 PID、Job Object、取消后的 kill/join 或项目切换撤销 lease。

最小演进：路径和分支由宿主从 project/run/task/attempt 派生；注册使用 host-issued token；Codex 使用 supervisor 保存进程句柄和生命周期状态；retry 前确认旧进程已经退出。

### 5.11 failed、unknown 和 receipt 需要严格区分

`src/projectControl/workerSideEffects.ts` 当前 `complete(record, _result)` 不区分执行结果，只要执行函数返回就生成普通 receipt；而恢复计划主要关注 `started/unknown`。这会把“进程返回但 acceptance 失败、可能留下部分改动”和“已确认成功”压缩到相似的副作用状态。

后续应区分：

```text
returned-success
returned-failed
unknown / needs-user
```

并在 receipt 中保存 exit/status、Evidence、contractHash、state signature 和 attempt。失败或中断造成的部分副作用默认进入 `unknown`，不能自动 retry 或 cleanup。

### 5.12 ProjectControl 写入口和宿主证据账本仍不统一

独立 UI/领域审查还确认了两处容易被忽略的分叉：

- `src/components/IssueBoard.tsx` 和 `src/components/MasterAgentPage.tsx` 可以直接调用 `setProjectControl` 覆盖快照；
- `src/components/ProjectSessionPanel.tsx` 的部分路径则通过 command/event buffer 持久化；
- `src/dev/session.ts` 中的 `resultStore`、`acceptanceStore` 和 cleanup approval 主要是当前进程内 Map，项目重开时 App 加载 Evidence/side-effect journal，但不完整恢复这些实体；
- 当前 consistency audit 已能按 `TaskExecutionId`/`AttemptId` 比较 Worker 状态、Evidence、acceptance、cleanup 和孤立 execution；但仍不能证明所有 Evidence、Acceptance、Receipt 的内容都来自同一份完整的宿主 durable ledger。

因此 `setProjectControl` 应逐步限制为 hydrate/replay 专用；Issue、Master Agent、Orchestration 等写入必须统一产出 DomainEvent。Evidence、Acceptance、Result 和 Receipt 则应进入统一的 durable host ledger，至少以 `projectId/runId/taskId/attempt` 做引用完整性校验。

## 6. 本轮已做的最小修正

### 项目插件扫描不再由普通 store 更新触发

此前 `App.tsx` 的无 selector store subscription 每次状态变化都会：

```text
unloadProjectCustomNodes()
→ scanProjectCustomNodes()
```

因此普通画布拖拽、运行进度、日志和恢复状态更新都会触发项目插件卸载/扫描。

本轮修正：

- 新增 `src/plugins/projectPluginLifecycle.ts`：以 `projectId + projectPath` 为身份，合并同一轮变更并提供 epoch 校验；
- 新增 `src/plugins/projectPluginLifecycle.test.ts`：覆盖同项目普通更新、项目打开/切换/关闭、同轮合并和过期 transition；
- `App.tsx` 通过 scheduler 串行化 `teardown → ensure`，只在项目上下文变化时重载项目插件；
- `scanProjectCustomNodes()` 接收 `projectId + projectPath` 上下文，并在 fs import、scope grant、mkdir、readDir、manifest/entry 读取和动态加载前后检查上下文；
- 扫描过程跳过 symlink package，manifest.entry 先经过 `assertPluginRelativePath()`，过期扫描不得继续创建旧目录或把插件注册到新项目 Registry；
- 项目上下文替换前调用 `terminatePluginRuntime()`，终止旧 sandbox worker 和 responder，避免跨项目复用在途插件状态。

### 沙箱路径和车道输入先做 fail-closed

- 新增 `src/engine/sandboxPath.ts` 及单测，拒绝沙箱绝对路径、`..`、Windows drive/UNC、NUL、ADS、末尾点/空格、设备名和含路径分隔符的 node/lane id，并对 `subgraph::node` 做跨平台安全编码；
- 新增 `src/engine/sandboxFs.ts` 及 fake-FS 单测，统一执行 parent `lstat`、symlink 拒绝、`open(createNew)` 新文件、嵌套父目录创建和递归 commit；`executor` 的 `writeFile/readFrom/list/commitLanes` 只能访问宿主声明的直接上游 lane；
- `SandboxManager` 的 pending load 在 `terminateAll()` 时会 reject 并解绑 worker handler；Tauri capability 显式加入 `fs:allow-lstat` 和 `fs:allow-open`；
- 以上是逐次操作级防护，不等同于完整 host-level TOCTOU/no-follow、进程隔离、manifest trust 或宿主 lease；这些仍是启用不可信 Graph Module 前的阻塞门槛。

## 7. 推荐的实现顺序

### Phase A：身份和投影先行（MVP-2 已完成基础切片）

1. `TaskExecutionId(runId, taskId)` 和 `AttemptId(taskExecutionId, attempt)` 已建立；`PlanRevisionId`、`GraphNodeId` 等未接入 Worker；
2. Worker Task、lease、事件、recovery、cleanup 和 side-effect 已增加 `taskExecutionId`/`attemptId`，旧字段保持兼容；
3. `DomainProjection` 已按 execution/attempt 维度保存 `TaskExecutionProjection` 和 `AttemptRecord`；
4. 已覆盖双 Run、同 Task id、retry、restart、序列化 replay、Evidence/Receipt readback 和 orphan audit；
5. Evidence、Acceptance、side-effect 和 cleanup receipt 已能引用基础 execution lineage；Artifact 仍待后续统一。

**本轮完成标准**：相同 Task 定义在两个 Run 中不会互相覆盖，重启和 Worker 事件 replay 得到同一 execution/attempt 结果。完整 ProjectControl replay 仍未完成。

### Phase B：应用命令与持久化提交

1. 增加 `ProjectCommandBus` 或 `ProjectPersistenceCoordinator`；
2. 统一 command 结果的 append/snapshot/publish 顺序；
3. 引入 `commitId`、expected revision 和幂等重试；
4. 把 App/Panel 中重复的 command persistence 迁移到 service；
5. 将失败写入表示为可恢复状态，而不是只记录 console/log。

**完成标准**：任一命令在 append、snapshot、publish 的任一步失败都可重试，且不会重复执行副作用。

### Phase C：Graph Command 与 Plan Revision

1. 建立 `GraphIntent` / `GraphCommand` / `PlanRevision`；
2. React Flow 只产生 intent，不能直接写 ProjectControl 或 Runtime；
3. 分离 `LayoutProjection`、`DraftPlanProjection`、`RuntimeGraphProjection`；
4. split editor、SubgraphEditor、Inspector、快捷键全部接入同一 dispatcher；
5. 当前 Run 固定 `planRevisionId`，执行中编辑只产生新 revision/change proposal。

**完成标准**：用户拖入节点、改参数、改语义连线都能被审计；布局变化不会制造计划 revision。

### Phase D：Published Graph Module

1. 将可复用子图发布成不可变 `moduleId/version/contentHash`；
2. 父图引用明确版本；
3. 运行时展开生成 Dynamic Runtime Graph 和完整 lineage；
4. 默认黑盒、按需透明、始终可追溯；
5. Plugin 作为 Graph Module 的分发/实现包装，不直接成为事实源。

### Phase E：Boundary Contract 与 Host Lease

1. 先实现纯 validator：父契约、子契约、收窄、能力升级、未知字段 fail-closed；
2. 将 `contractHash` 固化到 PlanRevision、Task、lease、Evidence、Recovery；
3. 从契约推导风险和 Required Controls；
4. 把 Context Pack、Capability Registry、quota 和 execution lease 接入同一 command path；
5. 只有宿主签发的 lease 才能激活真实能力。

### Phase F：统一执行与 Delivery

1. 建立唯一 `StartExecutionCommand`；
2. 旧 executor 只作为 adapter，所有入口都创建统一 Execution/Attempt；
3. Worker、workflow runtime、Evidence 和 acceptance 进入同一 lineage；
4. 增加 `ArtifactCandidate → user approval → DeliveryReceipt`；
5. merge/copy/commit/push 各自是显式 command，失败和未知副作用进入 recovery。

## 8. 后续开发的结构守则

### 允许

- 在现有 MVP 上继续做垂直切片，但每条新能力必须声明自己的事实源、命令入口、投影和恢复方式；
- 继续抽离纯函数和 port/adapter，保持行为等价；
- 保留 `workflowStore` 作为暂时 facade，通过 selector 和 application service 渐进迁移；
- 保留旧 executor，但把它包在明确的 legacy adapter 后面。

### 暂停

- 不在 `src/types.ts` 继续直接添加新的 Graph/Boundary/Delivery 大对象；
- 不让 UI 组件直接调用 `recordProjectEvents`、`saveProject`、Worker queue 和 legacy executor 的组合流程；
- 不让 `subgraphId` 继续承担 Published Module 身份；
- 不按“节点数量”决定安全措施；
- 不把 Web Worker 描述成进程安全边界；
- 不在没有 `commitId/revision/lineage` 的情况下增加更多持久化数组；
- 不删除现有 recovery、Evidence、cleanup 和 Tauri path 底线来换取更短的流程。

### 每个新领域对象至少回答

```text
谁创建它？
哪个 command 可以改变它？
它由哪个 event/reducer 产生？
它的版本和稳定 ID 是什么？
它引用哪个 Plan/Task/Run/Attempt？
重启后从哪里恢复？
用户能否从它追溯到 Evidence/Receipt？
```

## 9. 总体判断

SlimeMold 现在最需要的不是再增加一个 Agent、节点或面板，而是把“系统作为元 Harness”的约束落到代码结构：

```text
用户意图
  → 结构化命令
  → 版本化项目事实
  → 受契约约束的执行 lease
  → Worker / Runtime
  → Host Evidence
  → 用户批准的 Delivery Receipt
  → 可重放投影
```

当前 MVP 已经证明了 Worker、worktree、acceptance、Evidence、recovery 和 cleanup 可以形成可靠的局部闭环。下一阶段应保护这条闭环，并把旧工作流、图编辑、插件和项目控制逐步接入同一身份与命令边界，而不是再创建一个并行的“大系统”。

## 10. 审查状态与验证证据

### 10.1 独立审查结果的边界

- 第一轮独立 reviewer 针对修复前的未提交 diff 返回 `passed=false`，指出 sandbox lexical path、项目切换重入、过期插件扫描、pending load Promise 和嵌套交付五类问题；这些问题随后被逐项修正或收紧，并由本地测试验证。
- 第二轮 reviewer 针对修复后的 diff 自行完成 targeted tests 和 build，但在输出最终 JSON 前因等待模型响应超时而中断；没有形成 `passed=true` verdict，因此本轮不能声称获得独立 reviewer approval。
- reviewer 的失败/中断状态不能替代代码事实；最终状态以当前工作树、源码逐段复核和下面列出的实际命令结果为准。

### 10.2 当前验证基线

- `npm run test`：99 个测试文件、806 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；既有 dynamic/static import 与大 chunk warning 仍存在，但没有新增构建失败；
- `npm run i18n:check`：991 个 key 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- `git diff --check`：通过；新增代码敏感赋值和危险调用扫描均为 0。

### 10.3 尚未被验证为完成的边界

以下内容仍是后续 Graph Module/第三方插件开放前的门槛，不因本轮测试通过而自动关闭：

- host-level TOCTOU/no-follow 和宿主权威路径 API；
- 不可信插件的独立进程/受限 WebView 隔离；
- Worktree/Worker 的 execution lease、取消 supervisor 和旧 PID 回收；
- 完整 ProjectControl event replay、commit marker 和快照/事件原子提交；
- 统一 `Execution/Attempt` lineage、Artifact acceptance 和 Delivery Receipt。
