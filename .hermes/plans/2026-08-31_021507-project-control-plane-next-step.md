# SlimeMold 项目控制面垂直切片实施计划

> **For Hermes:** Use the test-driven-development skill and implement this plan task-by-task with explicit verification gates.

**Goal:** 让用户从一句自然语言目标进入持久化的项目会话，由主控 Agent 通过有限问询生成可审查的项目 Brief 和执行计划，而不要求用户先配置空白 DAG。

**Architecture:** 在现有项目、Pipeline、Orchestration、Workflow 和 H4 宿主证据基础上，增加项目级 Session、Decision、Issue、Artifact 和 Task 关系。会话是用户入口，结构化资产是事实来源，现有 H3 Orchestrator 负责执行已批准的计划，Workflow DAG 继续作为专业执行视图。第一阶段不做自由生成 DAG，不做无人值守运维。

**Tech Stack:** React + TypeScript + Zustand + Tauri/Rust + Vitest + 现有 AgentRouter/AgentHarness + `.slimemold/` 目录式项目存储。

---

## 1. 当前事实与范围

### 已有并经源码/文档确认的能力

- `BeginnerExperience` 已有初级首页和项目驾驶舱，但主路径仍是“新建/打开项目 → 运行已有工作流”。
- `OrchestratorPanel` 已有 H3c MVP：目标输入、模板草案、阶段工作流绑定、确认和执行。
- `src/orchestrator/draft.ts` 当前把目标固定为 `plan → construction → acceptance` 三阶段，并把每个阶段的 `wfRef` 初始化为 `new`。
- `PipelineDef`、`Artifact`、`Orchestration`、运行历史、checkpoint、AgentRouter、成本评分和 H4 worktree/Evidence 已有基础。
- `src/engine/builder.ts` 和 `builder.generate` 已能根据模块生成施工/运维工作流，但 H3 的阶段执行仍要求用户在高级面板中准备和绑定工作流。
- `src/agents/toolRegistry.ts` 已提供工具注册抽象，但项目级主控会话尚未使用它形成完整状态机。

### 已确认的真实缺口

- `ProjectSession`、`Decision`、`Issue`、`Task`、`ProjectBrief` 尚未形成正式的项目级数据模型。
- `src/orchestrator/draft.ts` 仍是模板化生成，不是多轮问询后的动态项目计划。
- `src/engine/runEvents.ts` 仍只有运行级事件，没有 `orch.*` 编排事件。
- H3 文档列出的阶段级 checkpoint 和结构化 `{ wfId, runId }` 仍未收口。
- `workflowStore` 的 `partialize` 包含 `orchestrations`，但 `ProjectFile`、`buildProjectFile` 和 `buildOpenProjectState` 没有形成完整的磁盘项目读写闭环；需要先补回归测试确认并修复，避免重启丢失主控计划。
- H4 GUI 代码已存在，但当前计划文档仍要求 Windows/Tauri GUI 场景和重启恢复继续人工验收；不能只凭 headless 或单元测试宣称生产级自治。
- `TODO.md` 的步骤 11、13、14 标题仍写“待实施”，但对应的沙箱、council、Builder、handoff/receive 和能力分级主体已有代码；旧标题必须校准后才能继续使用。

### 本计划明确不做

- 不立即实现任意自然语言自由生成未校验 DAG。
- 不把初级用户暴露给 Agent 绑定、Token、节点参数或 scope 配置。
- 不在第一阶段创建多个常驻“虚拟部门”进程。
- 不做自动 push、自动发布、无限重试或默认持续运维。
- 不提前物理拆分 `workflowStore` / `executor`，除非新功能证明现有边界成为阻碍。

---

## 2. 优先级判断

| 优先级 | 任务 | 判断 | 处理 |
|---|---|---|---|
| P0 | 文档和旧 TODO 状态校准 | 旧记录与代码严重漂移，会导致重复开发 | 先建立当前权威清单 |
| P0 | Orchestration 项目磁盘持久化 | 主控计划重启可能丢失，是状态安全问题 | 立即修复并补回归测试 |
| P0 | H4 GUI/重启验收 | Agent 修改代码前必须确认宿主证据链可用 | 在扩大自治前完成核心场景 |
| P1 | 结构化输出 schema 和确认门 | 防止模型文本被误当成计划或事实 | 与会话 MVP 一起做 |
| P1 | Project Session + Decision + Brief | 直接解决“简单提示词无法形成完整项目”的产品缺口 | 下一条产品主线 |
| P1 | Brief → Architecture → Task Graph | 让会话不止停留在聊天，而是产生可执行计划 | 复用现有 Orchestrator/Artifact |
| P1 | 自动阶段配方 / Builder 接入 | 消除初级用户手动绑定每个阶段工作流的阻塞 | 垂直切片必须包含 |
| P1 | Issue 工作台 | 承接未认领想法、Bug 和运行反馈 | 在 Session/Brief 后实现 |
| P2 | Task/Stage/Workflow 映射与漂移检测 | 防止多份计划相互背离 | 计划和执行闭环稳定后实现 |
| P2 | Construction Manager 集成 | 将已有 Worker、Resolver、H4 组织成项目施工闭环 | 依赖 Task Graph 和 H4 验收 |
| P3 | 持久运维运行时 | 需要队列、恢复、预算、锁、通知和回滚 | 最后开放 |
| 暂缓 | Rust 整图执行、REST、SSO、插件市场、移动端、物理模块大拆分 | 不直接解决当前产品入口问题 | 不进入本轮 |

---

## 3. Phase 0：建立权威任务基线

### Task 0.1：校准历史任务文档

**Objective:** 将旧 TODO、GAP_ANALYSIS 和 NEXT_PHASE_PLAN 中已经完成、部分完成和仍待做的内容标注清楚。

**Files:**
- Modify: `TODO.md`
- Modify: `GAP_ANALYSIS.md`
- Modify: `docs/NEXT_PHASE_PLAN.md`
- Reference: `README2.0.md`
- Reference: `docs/PROJECT_CONTROL_PLANE_ARCHITECTURE.md`

**步骤：**

1. 将步骤 11、13、14 的“主体已实现”与“仍待补的集成/验证”分开。
2. 将旧的 Anthropic、CSP、capabilities、Pipeline 等过时缺口改为已实现或历史记录。
3. 把 H3 遗留明确列为：`orch.*` 事件、阶段 checkpoint、结构化 run 关联、失败恢复验证。
4. 把新主线明确列为：Session → Brief → Decision → Task Graph → Orchestration。
5. 保留旧设计作为历史，不删除失败路径和安全审计记录。

**验证：**

- 所有“已完成”条目能指向代码、测试或真实运行证据；
- 所有“设计中/未验证”条目不能被表述为已交付；
- 文档之间不再出现互相矛盾的当前状态。

---

## 4. Phase 1：修复编排状态的持久化闭环

### Task 1.1：为 ProjectFile 补齐 Orchestration 关系

**Objective:** 让项目文件模型显式包含项目级编排记录，并在加载项目时恢复。

**Files:**
- Modify: `src/types.ts:840-881`
- Modify: `src/store/workflowState.ts:72-156`
- Test: `src/store/workflowState.test.ts`

**步骤：**

1. 为 `ProjectFile` 增加版本化的 `orchestrations` 字段，保持旧项目字段可选兼容。
2. 在 `OpenProjectState` 中增加 `orchestrations`。
3. 在 `buildOpenProjectState` 中从磁盘文件恢复 `orchestrations ?? []`。
4. 为旧项目缺失该字段的情况添加默认空数组。
5. 添加测试：打开带有编排记录的项目后，编排状态、阶段日志、`stageWfIds` 和 `runIds` 保持不变。

### Task 1.2：把 Orchestration 纳入项目写入和快照

**Objective:** 保存项目时不会遗漏内存中的编排记录，脏检测能够识别计划变化。

**Files:**
- Modify: `src/store/workflowSerialize.ts:157-225`
- Modify: `src/store/workflowStore.ts:1121-1150`
- Test: `src/store/workflowSerialize.test.ts`

**步骤：**

1. 为 `buildProjectFile` 的输入视图增加 `orchestrations`。
2. 将 `s.orchestrations` 写入返回的 `ProjectFile`。
3. 决定并固定持久化布局：优先使用 `.slimemold/orchestrations.json`，结构为 `{ version, orchestrations }`；必要时保留 `ProjectFile.orchestrations` 作为内存/迁移兼容字段。
4. 将编排记录纳入稳定快照，但排除纯运行事件和临时 UI 状态。
5. 测试：编排状态、阶段绑定或失败日志改变时，项目被标记为 dirty；只改变运行日志时不产生错误的内容快照。

### Task 1.3：补项目 IO 的读写回归

**Objective:** 验证应用重启或重新打开项目后，Orchestration 仍然可查看、重试和取消。

**Files:**
- Modify: `src/io/projectIO.ts:178-396`
- Test: `src/io/projectIO.test.ts`

**步骤：**

1. 保存项目时创建并写入编排存储文件。
2. 读取目录项目时加载编排文件；文件缺失、空文件或旧版本时安全降级为空数组。
3. 损坏 JSON 不得阻塞工作流本体打开，必须留下可见的 warning/日志路径。
4. 测试 round trip：`ProjectFile → save → load → ProjectFile` 保留编排状态和版本。
5. 测试旧 `.smproj` 不带编排字段仍能打开。

**验证命令：**

```bash
npx vitest run src/store/workflowState.test.ts src/store/workflowSerialize.test.ts src/io/projectIO.test.ts
npm run test
npm run build
```

---

## 5. Phase 2：收口 H3/H4 可靠性边界

### Task 2.1：完成 H3 编排事件和阶段恢复模型

**Objective:** 让编排进度可以从事件、checkpoint 和结构化运行引用中解释和恢复。

**Files:**
- Modify: `src/engine/runEvents.ts`
- Modify: `src/orchestrator/run.ts`
- Modify: `src/orchestrator/confirm.ts`
- Modify: `src/types.ts`
- Test: `src/orchestrator/*.test.ts`
- Test: `src/engine/*Events.test.ts`

**步骤：**

1. 增加 `orch.draft.created`、`orch.draft.confirmed`、`orch.stage.started`、`orch.stage.completed`、`orch.stage.failed`、`orch.reflow`、`orch.completed` 和 `orch.cancelled` 事件。
2. 将 `runIds` 收口为带 `wfId` 与 `runId` 的结构化引用，或提供兼容迁移函数。
3. 每个阶段完成后写入阶段 checkpoint。
4. 恢复时跳过已确认完成且证据仍有效的阶段。
5. 测试关闭/重启、失败重试、取消后 late result、已完成阶段不重复运行。

### Task 2.2：完成 H4 GUI 核心人工验收

**Objective:** 在扩大 Agent 自主开发能力前，确认 Tauri 宿主层的命令、worktree、Evidence 和 cleanup 确认链能被用户实际接管。

**Files:**
- Reference: `docs/NEXT_PHASE_PLAN.md`
- Reference: `docs/H4_SELF_DEVELOPMENT_FOUNDATION.md`
- Reference: `src/components/DevSessionPanel.tsx`
- Reference: `src/dev/gui.ts`

**验收场景：**

1. 创建 worktree。
2. 读取文件并应用小型受控补丁。
3. 执行白名单测试并采集宿主证据。
4. 验收失败时保留 worktree。
5. 人工查看 diff 后批准 cleanup，审批被消费。
6. 强制 cleanup 需要 reason，审计落盘失败时拒绝清理。
7. 切换项目后旧 worktree 登记不会泄漏。
8. 应用重启后历史证据可查看，未重新确认的 cleanup 不自动获得权限。

**验证命令：**

```bash
npm run test
npm run build
npm run i18n:check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev
```

GUI 场景必须记录真实观察结果；不能用 Agent 自报或单元测试替代。

---

## 6. Phase 3：主控会话最小垂直切片

### Task 3.1：定义项目控制面实体

**Objective:** 在不继续膨胀 `workflowStore` 的前提下建立 Session、Decision、Brief、Issue 和 Task 的稳定类型与关系。

**Files:**
- Create: `src/projectControl/types.ts`
- Create: `src/projectControl/relations.ts`
- Create: `src/projectControl/state.ts`
- Modify: `src/types.ts`（只补 ProjectFile 兼容引用，避免把全部领域类型继续塞进单文件）
- Test: `src/projectControl/state.test.ts`

**建议实体：**

```text
ProjectSession
  id, projectId, status, messages, summary, openQuestionIds,
  decisionIds, artifactIds, createdAt, updatedAt

Decision
  id, key, value, status, sourceSessionId, approvedBy, version

ProjectBrief
  id, version, goal, users, scope, nonGoals, constraints,
  acceptanceCriteria, assumptions, sourceSessionId, approval

Issue
  id, projectId|null, type, status, title, description,
  tags, sourceSessionId, relatedArtifactIds, proposedProjectId

Task
  id, issueId, module, scope, dependsOn, acceptanceRules,
  stageId, workflowId, status
```

**硬约束：**

- `projectId: null` 表示未认领 Issue，不用标签代替项目关系。
- 会话消息是来源，不是项目事实的唯一真相。
- 用户批准的内容必须生成 `Decision` 或版本化 `Artifact`。
- 每个实体带项目范围、版本和来源。
- 状态迁移由纯函数校验，不能由 UI 任意改字符串。

### Task 3.2：建立控制面持久化适配器

**Objective:** 在 `.slimemold/` 中持久化会话、决策、Brief、Issue 和 Task，支持旧项目安全打开。

**Files:**
- Create: `src/projectControl/persistence.ts`
- Modify: `src/io/projectIO.ts`
- Modify: `src/store/workflowStore.ts` 或新增 `src/store/projectControlStore.ts`
- Test: `src/projectControl/persistence.test.ts`
- Test: `src/io/projectIO.test.ts`

**建议布局：**

```text
.slimemold/
├── sessions/<session-id>.jsonl
├── decisions/<decision-id>.json
├── briefs/<brief-id>.json
├── issues/<issue-id>.json
├── tasks/<task-id>.json
└── orchestrations.json
```

先实现 deterministic JSON round trip、版本字段、损坏文件安全失败和项目范围校验；暂不做全文向量索引。

### Task 3.3：实现主控会话状态机

**Objective:** 让主控能够从一句目标开始，提出有限问题并逐步形成 Brief。

**Files:**
- Create: `src/orchestrator/session.ts`
- Create: `src/orchestrator/master.ts`
- Create: `src/orchestrator/schemas.ts`
- Modify: `src/agents/toolRegistry.ts`（只注册只读项目查询和受控提案工具）
- Test: `src/orchestrator/session.test.ts`
- Test: `src/orchestrator/master.test.ts`

**第一版能力：**

1. 接收一句话目标。
2. 读取当前项目已有 Decision、Issue 和 Brief 摘要。
3. 每轮提出 1–3 个高影响问题。
4. 更新当前理解和未决问题。
5. 提议 Decision 和 Brief patch，但不直接批准。
6. 用户选择批准、修改、暂不决定或停止。
7. 达到最低可执行条件后生成 Brief review 卡片。

**第一版禁止：**

- 直接写代码；
- 直接运行 shell；
- 直接修改 Workflow；
- 直接创建项目归属或发布；
- 把自然语言 JSON 围栏解析成功当作 schema 校验成功。

使用 fake LLM 测试问询状态迁移、重复问题去重、拒绝提案、恢复会话和预算耗尽。

### Task 3.4：严格校验 Brief/Architecture/Task 输出

**Objective:** 防止模型输出缺字段、错类型或越权字段时进入项目状态。

**Files:**
- Create: `src/projectControl/schemas.ts`
- Modify: `src/nodes/builtinHelpers.ts` 或抽出可复用 schema validator
- Modify: `src/orchestrator/draft.ts`
- Test: `src/projectControl/schemas.test.ts`
- Test: `src/nodes/builtinHelpers.test.ts`

**步骤：**

1. 为 Brief、Decision、Architecture、Module、Task 和 PipelineDraft 定义 schema。
2. 区分模型草稿、用户批准版本和宿主事实。
3. 未通过 schema 的输出只能进入错误/不确定性区域，不能写入正式项目状态。
4. 对数组数量、ID 唯一性、依赖存在性、未知字段和权限字段做校验。
5. 使用结构化输出失败 fixture 覆盖围栏缺失、字段类型错误、重复 ID、悬空依赖和恶意附加字段。

### Task 3.5：将主控会话接入简易首页

**Objective:** 将初级用户入口从“新建空工作流”切换为“开始项目会话”。

**Files:**
- Create: `src/components/ProjectSessionPanel.tsx`
- Modify: `src/components/BeginnerExperience.tsx`
- Modify: `src/App.tsx`
- Modify: `src/i18n/locales/zh-CN/beginner.xml`
- Modify: `src/i18n/locales/en-US/beginner.xml`
- Test: `src/components/ProjectSessionPanel.test.tsx`
- Test: `src/components/BeginnerExperience.test.tsx`

**UI 契约：**

- 无项目：目标输入 → 开始项目会话。
- 有项目：显示当前项目、主控下一步、未决问题、已批准决策和交付物。
- 空白首页不直接显示显眼的高级工作台入口。
- 专业入口只在项目上下文中出现，并打开当前项目。
- 会话窗口包含对话流、当前理解卡片、未决问题卡片、Decision/Brief 审批卡片。
- 不显示 Agent 绑定、Token、节点参数和 DAG 细节。

**验证：**

- 新用户不配置节点也能进入会话。
- 刷新/重新打开项目后会话状态和 Brief 不丢。
- `projectId`、会话 ID 和当前项目上下文始终一致。
- 取消、错误和无可用 Agent 时显示真实状态，不伪造完成。

---

## 7. Phase 4：从计划生成执行链

### Task 4.1：Brief → Architecture → Task Graph

**Objective:** 让管理层把用户批准的 Brief 编译为模块、接口、任务、依赖和验收规则。

**Files:**
- Create: `src/projectControl/planCompiler.ts`
- Modify: `src/orchestrator/draft.ts`
- Modify: `src/engine/builder.ts`
- Modify: `src/types.ts`
- Test: `src/projectControl/planCompiler.test.ts`
- Test: `src/engine/builder.test.ts`

**原则：**

- 第一版使用有限的项目类型模板 + LLM 填充，不做任意自由 DAG。
- 每个 Module/Task 必须有 `scope`、依赖和验收规则。
- Architecture 变更和 Task Graph 变更要保留来源版本。
- 用户批准计划后才创建可执行 Orchestration。

### Task 4.2：自动生成阶段工作流配方

**Objective:** 初级用户不再需要在 OrchestratorPanel 中手动为每个阶段绑定空白 Workflow。

**Files:**
- Modify: `src/orchestrator/run.ts`
- Modify: `src/engine/builder.ts`
- Modify: `src/components/OrchestratorPanel.tsx`
- Test: `src/orchestrator/run.test.ts`
- Test: `src/engine/builder.test.ts`

**步骤：**

1. 对已批准的项目计划选择标准阶段配方：规划、架构、施工、验证、交付。
2. Builder 根据 Task Graph 和 category→agent 路由表生成真实工作流。
3. 生成的工作流以 `activate:false` 注册并记录来源 Task Graph 版本。
4. 初级 UI 只显示“系统已生成执行计划”，高级用户仍可打开并编辑。
5. 执行前检查所有阶段已绑定、非空、schema 合法且未发生版本漂移。

### Task 4.3：运行反馈回到控制面

**Objective:** 将运行失败、测试失败、架构冲突和用户反馈转成可追踪的 Issue。

**Files:**
- Create: `src/projectControl/feedback.ts`
- Modify: `src/orchestrator/run.ts`
- Modify: `src/engine/runEvents.ts`
- Modify: `src/components/ProjectSessionPanel.tsx`
- Test: `src/projectControl/feedback.test.ts`

**规则：**

- 每个自动生成的 Issue 记录来源 `runId`、`stageId`、`workflowId` 和 Evidence 引用。
- 失败不自动变成“项目完成”；必须进入 blocked/awaiting-user/failed。
- 低风险重复测试可以按策略重试，高风险架构冲突必须升级。

---

## 8. Phase 5：Issue 工作台

### Task 5.1：实现四栏 Issue 看板

**Objective:** 为全局未认领 Issue 和项目 Issue 提供统一的 Planning/Change 视图。

**Files:**
- Create: `src/components/IssueBoard.tsx`
- Create: `src/components/IssueDetailPanel.tsx`
- Modify: `src/App.tsx` 或新增项目级导航路由
- Modify: locale files
- Test: `src/components/IssueBoard.test.tsx`

**四栏聚合：**

```text
收件箱 / 未规划：inbox、triaging、proposed
待做：approved、queued
在做：in_progress、review、blocked
已交付 / 运维中：done、operating
```

**必须支持：**

- 当前项目筛选和全局收件箱；
- 未认领 `projectId:null`；
- 主控归类建议；
- 用户批准归入旧项目或建立新项目；
- Issue 与 Session、Decision、Artifact、Task、Run、Evidence 的来源链接。

### Task 5.2：Issue → Task → Orchestration

**Objective:** 只有批准后的 Issue 才能进入执行队列。

**Files:**
- Modify: `src/projectControl/planCompiler.ts`
- Modify: `src/orchestrator/session.ts`
- Modify: `src/orchestrator/run.ts`
- Test: `src/projectControl/planCompiler.test.ts`

**验证：**

- 未认领 Issue 不会被自动执行。
- `approved` Issue 才能生成 Task。
- Task 必须有 scope、依赖和验收规则。
- Task 被取消、阻塞或失败时，Issue 状态可解释地变化。

---

## 9. Phase 6：专业 DAG 映射和施工闭环

### Task 6.1：建立 Task Graph / Pipeline / Workflow 映射

**Objective:** 让专业 DAG 成为任务图的执行投影，而不是另一份无来源的计划。

**Files:**
- Modify: `src/types.ts`
- Modify: `src/engine/builder.ts`
- Modify: `src/orchestrator/run.ts`
- Modify: `src/components/WorkflowEditor.tsx`
- Test: `src/engine/builder.test.ts`
- Test: `src/orchestrator/run.test.ts`

**规则：**

- Workflow 记录来源 Task Graph 和 Architecture 版本。
- Stage、Workflow、Node 显示关联 Issue/Task。
- 专业用户修改接口、数据模型或模块边界时生成架构变更提案。
- 执行前做版本漂移检查；漂移时要求重新规划或用户确认。

### Task 6.2：施工经理和冲突升级

**Objective:** 将已有 resolver/council/worktree/H4 能力组织为受控的施工循环。

**Files:**
- Create: `src/orchestrator/constructionManager.ts`
- Modify: `src/engine/builder.ts`
- Modify: `src/orchestrator/run.ts`
- Modify: `src/dev/session.ts`
- Test: `src/orchestrator/constructionManager.test.ts`

**冲突顺序：**

1. 路径、符号、接口和依赖确定性预检；
2. worktree/沙箱隔离；
3. 非重叠 diff 合并；
4. 测试和 Evidence；
5. 语义冲突才调用 council；
6. 架构、数据模型、安全和受保护路径冲突升级到管理层/用户。

不允许施工经理仅依据 Worker 的文字声称自动判定完成。

---

## 10. 持续运维（后置）

只有以下条件全部满足，才实现 `operating` 模式：

- Session、Issue、Task、Orchestration、Evidence 可跨重启恢复；
- 任务队列、锁、幂等和预算存在；
- 运维事件可转 Issue；
- 高风险修改和发布有用户审批；
- 有回滚和失败保留现场策略；
- 至少完成两轮真实 GUI 回归且无 P0/P1 安全问题。

第一版运维只允许：

```text
周期检查 / 只读诊断
→ 生成 Issue
→ 用户批准
→ 增量 Task
→ 受控执行
```

---

## 11. 全局验证清单

### 自动化

```bash
npm run test
npm run build
npm run i18n:check
git diff --check
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

### 控制面必须覆盖

- 空项目启动会话；
- 会话恢复；
- 重复问题不重复询问；
- Decision 提案批准/拒绝/修改；
- Brief 版本化；
- schema 失败不落正式状态；
- 未认领 Issue 不自动执行；
- Issue 批准后生成 Task；
- Task 生成 Orchestration；
- Orchestration 重启后可恢复；
- DAG 版本漂移被拦截；
- Run 失败生成可追踪 Issue。

### 安全与证据

- Agent 不能写主仓库；
- Agent 不能写 EvidenceStore；
- cleanup 不能由节点参数伪造批准；
- 主控不能跳过用户确认门；
- 不把模型自报结果当宿主事实；
- 会话和日志中不写入 API Key、Token 或凭据内容。

---

## 12. 本计划的第一个实际开发目标

不要从 Issue 看板或运维循环开始。第一刀应是：

```text
修复 Orchestration 磁盘持久化
→ 补重启回归测试
→ 完成 H4 GUI 核心验收
→ 实现 ProjectSession / Decision / Brief
→ 做“一句话 → 主控问询 → Brief 确认”的最小闭环
```

当这个闭环真实可用后，再把 Brief 编译成 Architecture、Task Graph 和自动阶段工作流。这样每一步都能被验证，也不会把“Agent 数量增加”误当成产品能力增加。
