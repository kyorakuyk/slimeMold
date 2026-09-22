# SlimeMold 第一次 MVP：节点重设计与端到端验收实施计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.
>
> 本文件是规划阶段交付物。本轮只盘点和设计，不修改生产代码、不创建验收 fixture、不启动真实 Worker。

**Goal:** 围绕一条真实可验收的垂直切片，把用户目标转换为可编译、可测试、可持久化交付的项目文件，并保证所有测试与验收生成物都落在专有目录中。

**Architecture:** 保留现有 `TaskDefinition → TaskExecution → Attempt → Worktree → Evidence → Acceptance → Cleanup` 控制模型；新增 `ArtifactCandidate → user approval → DeliveryReceipt` 交付链。Agent 只产生结构化的 `FilePatchSet` 候选，宿主负责在隔离 worktree 中实际写入、编译、测试、采集证据和交付。用户不手工填写 lineage ID，当前执行范围由控制面注入并校验。

**Tech Stack:** Tauri 2 / Rust host、React + TypeScript、React Flow、Vitest、Git worktree、JSONL/project persistence。

---

## 1. 当前事实与问题边界

### 已有能力

当前 `src/nodes/dev/index.ts` 已有以下宿主开发节点：

- `dev.worktree.create`
- `dev.worktree.status`
- `dev.worktree.cleanup`
- `dev.code.read`
- `dev.code.patch`
- `dev.shell.run`
- `dev.test.run`
- `dev.git.status`
- `dev.git.diff`
- `dev.evidence.add`
- `dev.accept`

当前 `src/nodes/builtin/worker.ts` 已有：

- `worker.scaffolder`
- `worker.implementer`
- `worker.validator`

当前控制面已经有 Execution/Attempt lineage、worktree、Evidence、Acceptance、cleanup、recovery 和多 Run projection 的大量基础实现。最新质量基线为 TypeScript 测试 101 个测试文件/887 个测试通过、Rust 测试 30 个通过、build 和 i18n 检查通过。

### 当前缺口

1. `worker.implementer` 输出的是代码文本，不是可校验的文件变更候选；模型文本本身不能证明文件已经落盘。
2. `dev.code.patch` 能把变更写入 worktree，但当前节点编排没有把“验收后的成果交付回项目根目录”作为独立、可审计的动作。
3. `Artifact` 仍是按 `(stage, kind)` 覆盖的旧模型，缺少 `ArtifactCandidate`、不可变 content hash、来源 Attempt、Acceptance 和 DeliveryReceipt。
4. 当前 `dev.*` 节点暴露了过多内部字符串参数，例如 `orchestrationId`、`stageId`、`worktreePath`；第一次 MVP 不应要求用户或普通节点手工拼接这些身份。
5. 历史测试曾在仓库根目录创建 `evidence-test-*` 空目录。该批 95 个空目录已清理，但生成物策略必须从测试工具层统一收口，不能依赖每个测试作者自觉清理。
6. 真实 Tauri Worker E2E 尚没有与当前最终代码同一快照的可靠人工验收证据，因此不能把 headless 或 Vitest 结果当作桌面 MVP 已完成。

---

## 2. 不可妥协的设计规则

### 2.1 节点不是事实源

- 用户意图、Decision、Task、Run、Attempt、Evidence、Acceptance、ArtifactCandidate 和 DeliveryReceipt 必须由控制面 command/event/persistence 产生。
- 节点输出是候选数据或宿主执行结果；Agent 最终文本不能直接把 Task 标记为 succeeded。
- UI、React Flow 和 Zustand 只消费 projection；不能从画布节点状态直接写项目事实。

### 2.2 Agent 只产出 PatchSet，不直接写任意路径

- LLM 节点输出结构化 `FilePatchSet`：文件相对路径、expected preimage hash、unified diff、目标 content hash、变更说明。
- Agent 不提供 evidence status、acceptance passed、receiptId、project root 或任意绝对路径。
- 宿主 `apply` 节点只允许对当前登记 worktree 的允许路径应用补丁。
- 文件创建、编译、测试和最终交付必须由宿主执行并产生事实记录。

### 2.3 交付和清理必须分离

- `Acceptance passed` 不等于项目根目录已经更新。
- `Delivery` 是独立的高影响 command：用户批准后才允许把已验收的文件变更交付到项目根目录。
- 交付前校验目标基线、路径策略、preimage hash、Acceptance lineage 和项目 generation；交付后 read-back 并计算实际 output hash。
- `Cleanup` 只处理明确的当前 Attempt worktree；不能用 cleanup 代替交付。
- merge、copy、commit、push 以后分别建 command；第一次 MVP 只实现本地项目文件交付，不自动 push。

### 2.4 所有生成物必须有专有根目录

测试和验收不得在当前工作目录直接拼接 `Date.now()` 创建目录。统一使用：

```text
D:/Temp/slimemold-acceptance/<case-id>/
```

或由 `SLIMEMOLD_ACCEPTANCE_ROOT` 显式指定的等价目录。每个 case 的所有 fixture、worktree、runtime 数据、日志和报告都必须在该 case 根目录内。

规则：

- 不允许 `./evidence-test-*`、`./evidence-flush-*` 等仓库根目录临时路径；
- 测试生成路径由一个共享 helper 创建，不能在测试文件中自行拼接；
- 创建后必须在 `try/finally` 中清理；
- 需要保留现场时只能使用明确的 `KEEP_TEST_ARTIFACTS=1`，仍保留在专有根目录；
- 清理后重新枚举并检查 case 根目录；
- 非空目录、符号链接或未知命名的残留一律 fail-closed，不做模糊删除；
- `D:/Agents/SMtest` 永远不作为 fixture、worktree 或测试输出目录。

---

## 3. 第一次 MVP 的节点清单

以下清单区分“用户可见节点”“宿主内部节点”和“控制面 command”。不把所有能力都放入普通节点面板。

### 3.1 控制面入口（不作为自由执行节点）

| 标识 | 名称 | 作用 | 结果 |
|---|---|---|---|
| `control.intent.capture` | 记录项目目标 | 接收目标、约束、非目标和验收愿望 | `IntentSpec`，保存到 ProjectSession |
| `control.plan.draft` | 生成执行计划 | 把目标收敛为 Task、依赖、允许路径、命令 profile、风险和验收规则 | `PlanDraft` / 版本化 Artifact |
| `control.plan.approve` | 确认计划 | 用户审查并确认目标、范围、权限、成本和验收门 | `Decision(active)` + `ApprovedPlan` |
| `control.execution.start` | 启动执行 | 由已批准计划创建 Run、TaskExecution 和 Attempt | `RunStarted` / `TaskStarted` |
| `control.recovery.inspect/retry/skip` | 恢复决策 | 展示 unknown 副作用并等待人工决定 | 只产生可重放 recovery facts，不自动执行 |
| `control.delivery.approve` | 批准交付 | 用户确认 ArtifactCandidate 的目标文件、diff 和风险 | `DeliveryApproval` |
| `control.cleanup.approve` | 批准清理 | 用户确认当前已验收/已交付 Attempt 的 worktree 清理 | cleanup command + Receipt |

这些动作不允许通过 Agent 文本、节点参数或旧 UI Store 直接伪造。

### 3.2 计划与结构节点

| 标识 | 名称 | 角色 | 输入 | 输出 | MVP 说明 |
|---|---|---|---|---|---|
| `project.scaffold` | 生成项目骨架 | compute | `ProjectSpec` | `StructureManifest` + `FilePatchSet` | 第一版固定支持 TypeScript 项目，输出完整目录和可编译文件候选，不直接写盘 |
| `worker.context.pack` | 编译任务上下文 | io | 当前 Task、允许路径、文件引用 | `ContextPack` | 只读取宿主允许范围；不把整个项目或用户目录塞给 Agent |
| `worker.implement.patch` | 生成实现补丁 | worker / io | `TaskSpec` + `ContextPack` + `StructureManifest` | `FilePatchSet` | 替代直接输出 `code` 的 `worker.implementer`；模型只提出 patch，不产生事实 |
| `worker.patch.validate` | 校验补丁 | compute | `FilePatchSet` + `TaskSpec` | `ValidatedPatchSet` / failure | 校验相对路径、patch 格式、preimage、允许路径、禁止 protected path 和文件类型 |

`project.scaffold` 和 `worker.implement.patch` 可以复用现有 Agent/role 选择，但输出协议必须是结构化 JSON，不能使用 `[object Object]` 或自由文本作为文件树事实。

### 3.3 隔离执行节点

| 标识 | 名称 | 角色 | 输入 | 输出 | 关键边界 |
|---|---|---|---|---|---|
| `host.worktree.allocate` | 分配执行工作区 | coordinator | 当前 `ApprovedPlan` + Attempt context | `WorktreeRef` | 由宿主生成路径、branch、baseRevision；用户不填写路径 |
| `host.patch.apply` | 应用补丁 | sandbox_write | `WorktreeRef` + `ValidatedPatchSet` | `HostMutationResult` | 只写当前 worktree，按 patch 原子应用并 read-back hash |
| `host.verify.compile` | 编译项目 | verifier | `WorktreeRef` + compile profile | `HostCheckResult` | profile 由宿主固定映射，例如 `npm run build`；不接受任意 shell |
| `host.verify.test` | 运行测试 | verifier | `WorktreeRef` + test profile | `HostCheckResult` | profile 由项目契约/fixture 提供，命令仍经 Node/Rust 双重 gate |
| `host.inspect.change` | 检查变更 | verifier | `WorktreeRef` + baseRevision | `ChangeReport` | 合并 status、diff、changed paths 和 path-policy；只读 |
| `host.evidence.collect` | 采集宿主证据 | verifier | 当前 lineage + `HostCheckResult` + `ChangeReport` | `EvidenceBundle` | 自动生成 test/diff/path-policy/artifact 证据，节点不可自填 passed |
| `host.accept` | 确定性验收 | verifier | `AcceptanceContract` + `EvidenceBundle` | `AcceptanceRecord` | Evidence durable 后才能验收；结果绑定当前 Attempt |
| `artifact.prepare` | 准备交付候选 | coordinator/read-only | Accepted Attempt + changed files | `ArtifactCandidate` | 记录 source worktree、file manifest、input/output hash、Acceptance ID |
| `project.delivery.apply` | 交付项目文件 | coordinator | `DeliveryApproval` + `ArtifactCandidate` | `DeliveryReceipt` | 只允许用户批准后的当前候选；目标项目必须匹配 generation/base/preimage；完成后 read-back |
| `host.cleanup.finalize` | 清理 worktree | coordinator | 当前 Delivery/Acceptance + cleanup approval | `CleanupReceipt` / `TaskCleaned` | 不是普通 Agent 工具；失败或 unknown 现场默认保留 |

### 3.4 不纳入第一次 MVP 的节点

以下能力先保留为后续阶段或内部 adapter，不进入第一次验收的可见主路径：

- 任意 `dev.shell.run`；
- 任意 `tool.http`、任意 `tool.writeFile`；
- 自由生成 DAG、Graph Module 和不可信插件节点；
- 自动 commit、merge、push、release；
- 多语言通用 Artifact acceptance；
- 复杂多 Agent council、无限 retry 和自动运维；
- 把 recovery、cleanup、delivery 做成可被模型任意调用的普通节点。

现有 `dev.*` 节点可以作为兼容 adapter，但 MVP 模板优先使用上述窄接口。内部 lineage 通过 execution context 注入，不在画布上暴露十几个字符串 ID 端口。

---

## 4. 第一次 MVP 的固定工作流模板

第一次验收只提供一个锁定模板，避免用户从几十个节点中自行搭建错误流程：

```text
项目目标
  → 计划草案
  → 用户确认
  → TaskExecution / Attempt
  → project.scaffold（需要时）
  → worker.context.pack
  → worker.implement.patch
  → worker.patch.validate
  → host.worktree.allocate
  → host.patch.apply
  → host.verify.compile
  → host.verify.test
  → host.inspect.change
  → host.evidence.collect
  → host.accept
  → 用户查看 diff / Evidence
  → artifact.prepare
  → 用户批准 delivery
  → project.delivery.apply
  → 交付后项目根目录 read-back
  → 用户批准 cleanup
  → host.cleanup.finalize
  → DeliveryReceipt + CleanupReceipt
```

### 第一版固定示例项目

为了让用户真正看到文件落盘、编译和运行结果，fixture 使用一个最小但完整的 TypeScript 项目：

```text
<case>/project/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   └── index.ts
├── tests/
│   └── index.test.ts
└── .slimemold/
    ├── project.json
    ├── events/
    ├── runs/
    ├── evidence/
    └── receipts/
```

第一条成功任务的预期结果是：

- Worker 在 `project-workers/<attemptId>/` 中修改 `src/index.ts` 或新增受控代码文件；
- `npm run build` 成功；
- `npm run test` 成功；
- 宿主检测到实际 diff 和路径策略通过；
- 用户批准后，变更真实写入 `<case>/project/src/`；
- 交付后的项目重新 read-back，文件 hash 与 DeliveryReceipt 一致；
- cleanup 只删除 `project-workers/<attemptId>/`，不删除已交付项目文件。

---

## 5. 专有目录和持久化布局

### 5.1 验收 case 根目录

```text
D:/Temp/slimemold-acceptance/<case-id>/
├── project/                 # Git fixture / 实际项目根
├── project-workers/         # 当前 project 路径派生出的 Worker worktree 根
│   └── <attempt-id>/
├── runtime/                 # 本次 case 的运行辅助状态，不放仓库根
│   ├── app-state/
│   └── locks/
├── reports/                 # 人工验收摘要、截图索引、机器验证报告
└── manifest.json            # case 身份、基线、保留策略；不含凭据
```

项目自身的 `.slimemold/` 只保存项目事实和运行投影。测试 harness 不能把 Evidence 写到 worktree 内；Evidence 根必须由宿主指定并位于 worktree 外。

### 5.2 测试 helper 统一入口

计划新增：

- `src/dev/test-artifacts.ts`：创建带 namespace/caseId 的专有目录、记录 manifest、提供 `withTestArtifactRoot()` 和清理/保留策略；
- `src/dev/test-artifacts.test.ts`：验证路径不落在 cwd、名称模式、try/finally 清理、KEEP 模式和非空目录 fail-closed；
- `scripts/acceptance/prepare-fixture.ts`：只在专有 case 根目录创建 fixture；
- `scripts/acceptance/run-tauri-case.ts`：启动/记录真实 Tauri case，不把日志写到仓库根；
- `scripts/acceptance/cleanup-case.ts`：只按 case manifest 清理，删除前检查路径、case ID 和非空策略。

所有现有会创建临时文件/目录的测试必须迁移到该 helper；禁止新增裸 `tmpdir() + Date.now()` 或 `./<prefix>-<timestamp>`。

### 5.3 生成的项目文件与运行元数据分离

```text
项目源码/交付文件：project/src、project/tests、project/package.json、project/README.md
项目事实：project/.slimemold/project.json、events、runs
证据与验收：project/.slimemold/evidence、receipts
Worker 隔离区：project-workers/<attemptId>
验收工具输出：<case>/reports、<case>/runtime
```

不把测试日志、临时 patch、截图或失败 dump 散落到 `D:/code/slimeMold` 根目录。

---

## 6. 计划中的代码边界

### 新增或抽离的领域/应用层

- `src/domain/model/lineage.ts`：只放稳定 execution/attempt 引用和 parser；不依赖 React/Tauri。
- `src/domain/model/artifact.ts`：`ArtifactCandidate`、`ArtifactFile`、`ArtifactAcceptance`、content hash 和 delivery lineage。
- `src/application/projectCommandBus.ts`：`applyProjectCommand()`、expected revision、commitId/generation、event batch 和 projection publish。
- `src/application/deliveryService.ts`：candidate → approval → apply → read-back → `DeliveryReceipt`。
- `src/application/executionApplicationService.ts`：Start/Recover/Cleanup/Delivery command 的组合入口。
- `src/adapters/persistence/projectPersistenceCoordinator.ts`：ProjectFile、event stream、Evidence、side-effect journal 的提交顺序和恢复对账。

### 节点适配层

- `src/nodes/control/`：目标、计划和用户确认的 projection/command adapter。
- `src/nodes/worker/`：`ContextPack`、`FilePatchSet`、结构化 worker 输出。
- `src/nodes/host/`：worktree、patch、compile/test、change report、Evidence、acceptance、artifact delivery adapter。
- `src/nodes/dev/index.ts`：保留兼容入口，逐步改为转发到 host application service，不继续堆新的安全逻辑。
- `src/nodes/builtin/worker.ts`：将 `worker.implementer` 收敛为 patch candidate adapter，保留旧工作流的兼容输出到迁移完成为止。
- `src/types.ts`：只保留兼容 re-export；新领域对象不继续堆入跨层总线。

### 宿主和安全边界

- `src/dev/workerAcceptance.ts`：复用现有 test/diff/path-policy 三类宿主事实，改为输出 typed `EvidenceBundle`。
- `src/dev/evidence.ts`、`src/dev/session.ts`：继续作为 JSONL/schema adapter，不直接承担 ProjectCommandBus 业务决策。
- `src-tauri/src/lib.rs`：提供 delivery/read-back 所需的受控路径与文件操作；不能退回任意 shell 或 lexical-only path gate。
- `src-tauri/src/codex.rs`：继续负责 timeout、cancel、output drain 和进程树终止；不把登录凭据或用户配置暴露给普通 Worker。

---

## 7. 实施顺序与小阶段提交

### Phase 0：基线和生成物治理

1. 检查当前 HEAD `5cfec7a` 和工作树；保留无关未跟踪设计素材，不做 `git add .`。
2. 新增测试 artifact helper 的 RED 测试：验证不会在 cwd 建目录，异常时仍清理。
3. 迁移现有会产生文件/目录的 Node 测试到 helper。
4. 运行定向测试并建立 checkpoint commit。

### Phase 1：结构化 PatchSet 与项目骨架

1. 设计 `ProjectSpec`、`StructureManifest`、`FilePatchSet` schema。
2. 为 TypeScript fixture 写 RED/GREEN：完整目录、package scripts、tsconfig、src、tests 均可生成。
3. 改造 `worker.implementer` 的新 adapter，模型输出先 decode/validate，再进入 patch 流程。
4. `host.patch.apply` 在 worktree 中实际落盘并 read-back hash。
5. 建立 checkpoint commit。

### Phase 2：编译/测试/证据模板

1. 将 compile/test command profile 固定化，不让节点自由接收任意命令字符串。
2. 组合现有 worktree、test、diff、path-policy 和 Evidence 逻辑。
3. 让 `host.accept` 只消费 durable `EvidenceBundle` 和 typed contract。
4. 增加失败验收回归：测试失败时保留 worktree，不生成可执行 cleanup。
5. 建立 checkpoint commit。

### Phase 3：ArtifactCandidate 与真实交付

1. 新增不可变 `ArtifactCandidate`，绑定 source Attempt、Acceptance、file manifest 和 hashes。
2. 实现 `project.delivery.apply`：用户批准、基线校验、受控写入、read-back、`DeliveryReceipt`。
3. 交付后对项目根目录执行受控 compile/test 或等价的目标验证；禁止把 Worker worktree 结果直接当作项目根目录结果。
4. 增加冲突、过期 approval、preimage drift、路径越权和 read-back 失败回归。
5. 建立 checkpoint commit。

### Phase 4：真实 Tauri fixture 与人工验收

1. 只在 `D:/Temp/slimemold-acceptance/<case-id>/` 创建成功/失败/recovery fixture。
2. 启动 Tauri 时确认 Vite、Rust binary 和真实窗口都就绪；不自动加载 `SMtest` 作为验收项目。
3. 完成成功路径、普通失败路径和中断 recovery/retry 路径。
4. 复查 ProjectFile、event stream、Evidence JSONL、side-effect journal、DeliveryReceipt、CleanupReceipt 和 Git worktree。
5. 建立 checkpoint commit，并在 `docs/DEVELOPMENT_LOG.md` 追加真实验证数字和残余限制。

### Phase 5：第一次用户验收

用户只需：

1. 选择开发侧提供的 disposable fixture；
2. 输入/确认简单目标；
3. 审查并确认计划；
4. 启动 Worker；
5. 查看编译、测试、diff、Evidence 和 Acceptance；
6. 批准 delivery，确认项目文件已经真实出现；
7. 关闭并重新打开项目，确认文件和历史仍在；
8. 批准 cleanup；
9. 在 failure/recovery 场景按指示选择 Inspect、Retry 或 Skip；
10. 对每条路径反馈“通过/不通过/无法判断”。

用户不需要编辑 event stream、JSONL、AttemptId、side-effect journal 或手动删除 worktree。

---

## 8. 验收标准

### 成功路径

- 目标、计划和用户确认可追溯；
- Worker 只在 `project-workers/<attemptId>` 中写入；
- 生成的代码文件位于完整目录结构中；
- `npm run build` 和 `npm run test` 使用真实宿主结果通过；
- Evidence 至少包含 test、diff、path-policy，并绑定当前 Attempt；
- Acceptance 在 Evidence durable 后产生；
- 用户批准前项目根目录没有交付变更；
- 用户批准后项目根目录出现实际文件，read-back hash 与 DeliveryReceipt 一致；
- 重启后项目文件、Evidence、Acceptance 和 DeliveryReceipt 仍可读；
- cleanup 只删除当前 worktree，不删除交付文件。

### 失败路径

- 宿主测试返回非零时 Task/Run 失败，不伪装成功；
- failed Evidence 保留；
- worktree 保留；
- 不生成可执行 cleanup；
- 不生成成功 DeliveryReceipt；
- 用户可查看失败原因和 diff。

### Recovery / Retry

- 重启后显示 recovery-required，不自动重跑；
- Inspect 不改变状态；
- Retry 创建新的 Attempt、worktree、side-effect key 和 Evidence lineage；
- 旧 Attempt 历史保留，迟到结果不能覆盖新 Attempt；
- Skip 只记录人工收口，不产生新的 Worker 执行；
- unknown side effect 不自动变成成功或 receipt。

### 生成物治理

- 仓库根目录不存在 `evidence-test-*`、`evidence-flush-*` 或同类临时目录；
- 所有 case 生成物均位于专有 case root；
- 测试异常后 helper 仍清理，保留模式也不越出专有根；
- 清理脚本只按 manifest 和精确路径操作；
- `D:/Agents/SMtest` 无任何意外变化；
- 不提交凭据、token、密码或原始敏感日志。

---

## 9. 验证命令与停止条件

每个代码阶段都必须跑定向测试，再跑：

```bash
npm run test
npm run build
npm run i18n:check
git diff --check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

真实 Tauri 阶段还必须有：

- 窗口实际出现的证据；
- fixture 项目路径和 Git baseline；
- Worker worktree 列表；
- compile/test/diff/path-policy Evidence；
- Acceptance、DeliveryReceipt、CleanupReceipt read-back；
- 重启后的项目文件和控制面状态；
- success/failure/recovery 三类结果。

以下任一项未完成，都不能写“第一次 MVP 已完成”：

- 只有 Vitest/headless，没有真实 Tauri 用户路径；
- 只有 worktree 里的代码，没有项目根目录真实交付；
- 只有 Agent 文本，没有宿主 Evidence/Acceptance；
- 只有 cleanup，没有 DeliveryReceipt；
- 生成物仍散落在仓库根目录；
- 失败或 unknown 被伪装成成功；
- 真实 Tauri、OS 级 no-follow/TOCTOU 或不可信脚本沙箱的限制没有明确写出。

---

## 10. 本计划的非目标

第一次 MVP 不解决：

- 完整 Event Sourcing 和所有 ProjectControl 独立重放；
- 通用多语言/二进制 Artifact acceptance；
- 任意第三方插件的 OS 级沙箱；
- 自动 merge/push/release；
- quota、跨实例 supervisor、长期运维和插件市场；
- 旧 `workflowStore`/executor 的一次性大拆。

先证明一条窄而真实的项目生产闭环，再扩大节点种类和自治范围。
