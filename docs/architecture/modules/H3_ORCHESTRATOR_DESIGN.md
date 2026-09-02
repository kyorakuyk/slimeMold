---
title: H3 Orchestrator —— 总控 Agent 设计方案
type: architecture-design
status: partial-implementation
reviewed_date: 2026-08-11
authority: design-reference
---

# H3 Orchestrator —— 总控 Agent 设计方案

> 状态：**设计稿**（2026-08-11）。用户拍板：H2 收口后启动 H3，**先设计、后最小闭环实现**，
> 不大规模实现。核心原则：Orchestrator **只生成「工作流草案」，绝不静默修改用户工作流**——
> 任何对用户工作流的变更都必须经用户确认。
>
> 代码基线：main @ `e5ccb37`（H2 收口）。

---

## 1. 定位与目标

### 1.1 是什么

Orchestrator 是「站在 executor 外面」的**总控协调层**（TODO 14.2 已定调，`src/engine/pipeline.ts`
注释同款约束）：

- 接收用户**自然语言目标**（goal）；
- 复用现有 AgentRouter（`agentDecision.ts`）把目标**分解为 DAG 草案**（多工作流、含阶段与流向）；
- 草案经**用户确认**后，按序协调多次 `runWorkflow(opts)`（各工作流各自跑，不重写 executor）；
- 工作流之间通过 **Artifact（pipeline 交付物）** 传递有结构结果；
- 全程可观测（复用 `runEvents` 事件流 + 成本账本 + checkpoint）。

### 1.2 非目标（本阶段明确不做）

- **不**静默修改/覆盖用户已有工作流（草案必须确认）。
- **不**重写 executor / topoSort / currentRunId 代次模型（`stopWorkflow` 过期协程语义保持）。
- **不**做「全自主无人值守」（每步仍可暂停、可接管、可拒绝草案）。
- **不**做跨工作流连线（边界节点 `pipeline.handoff`/`receive` 已规避成环，沿用）。

### 1.3 与现有能力的边界

| 现有模块 | H3 如何复用 |
|---|---|
| `runWorkflow(opts)`（executor） | Orchestrator 只**按序调用**，不做内部调度 |
| `agentDecision.decideAgentCall`（AgentRouter） | 草案分解时选「哪个 agent 负责哪个阶段」 |
| `runEvents` / `emitRun`（EventBus） | 编排事件（阶段开始/完成/回流）并入既有事件流 |
| `checkpoint` / `runHistory` | 每阶段独立 checkpoint，可中断续跑 |
| `experienceStore`（成功率） | AgentRouter 评分输入；回流决策参考 |
| `pipeline.ts`（Artifact/advance/rework） | 工作流间交付物传递与回流 |
| `pipeline.handoff` / `receive` 节点 | 跨工作流边界（画布内可见） |

---

## 2. 输入（Input）

### 2.1 用户目标

```ts
interface OrchestratorRequest {
  /** 用户自然语言目标（如「给我的 CLI 工具加一个子命令并补测试」） */
  goal: string;
  /** 约束（可选）：已有工作流/项目资产/偏好 agent 等 */
  constraints?: {
    agentId?: string;          // 指定总控/各阶段 agent（缺省走 AgentRouter）
    maxStages?: number;        // 草案阶段数上限（默认 7）
    budgetTokens?: number;     // 预算约束（成本感知）
    readonly?: boolean;        // true 时只产出草案，不触发执行
  };
  /** 来源（触发上下文） */
  source: 'ui' | 'menu' | 'command';
  projectId?: string;
}
```

### 2.2 输入校验（最小）

- `goal` 非空；长度建议 ≤ 2000 字符（超长截断并提示）。
- `maxStages` 超限拒绝（防草案爆炸）。
- 草案生成是**只读**操作（不落盘、不改 store），确认后才产生副作用。

---

## 3. 状态（State）

Orchestrator 本身是**无状态协调器**；编排进度存于项目态（`workflowStore` 新增 `orchestrations` 字段，
随 `.slimemold` 持久化），保证跨会话可恢复。

```ts
interface Orchestration {
  id: string;                     // orch-<ts>
  goal: string;                   // 原始目标
  // 生命周期：draft → awaiting-confirm → ready（确认待执行）→ running（仅 runOrchestration 进入）
  //         → done / failed / cancelled / paused（可恢复回 running）
  // 状态迁移由 ALLOWED_TRANSITIONS 表强制（confirm.ts）：非法跳转（如 awaiting-confirm → running）
  // 会被拒绝。
  status: 'draft' | 'awaiting-confirm' | 'ready' | 'running' | 'paused' | 'done' | 'cancelled' | 'failed';
  createdAt: string;
  updatedAt: string;
  /** DAG 草案（阶段 + 有向边），用户确认前不变更用户工作流 */
  draft: PipelineDraft | null;
  /** 用户确认后生成的 pipeline 定义（绑定各阶段工作流 id） */
  pipelineId?: string;
  /** 当前执行到哪一阶段（可恢复） */
  cursor?: string;                // stageId
  /** 每阶段执行记录（结果/产物/成本） */
  stageLogs: StageLog[];
  /** 关联事件范围（runEvents 重放） */
  runIds: string[];
}

interface PipelineDraft {
  stages: DraftStage[];           // 阶段草案（未绑定 wfId）
  edges: DraftEdge[];             // 有向边 + artifactKind + backflow?
}

/** 目标设计：用户界面可表现为勾选项，落盘时必须是可验证契约。 */
interface BoundaryContract {
  context?: { facts?: string[]; artifacts?: string[]; maxTokens?: number };
  scope?: { paths?: string[]; symbols?: string[]; artifactKinds?: ArtifactKind[] };
  capabilities?: string[];        // 能力、工具、Provider
  actions?: string[];              // read/write/execute/network/delegate 等
  acceptance?: string[];           // 宿主必须执行的检查
  budget?: { tokens?: number; durationMs?: number; calls?: number };
  recovery?: string[];             // inspect/retry/skip/resume/cleanup 等
  delegation?: { allowed: boolean };
  risk?: { level: 'low' | 'medium' | 'high' | 'critical'; reasons: string[] };
}

interface DraftStage {
  id: string;
  label: string;
  role: 'builder' | 'constructor' | 'ops';   // 职能分类（UI 着色）
  goal: string;                  // 该阶段子目标
  /** 建议绑定的工作流：新生成 或 复用已有（按名称/描述匹配） */
  wfRef: { kind: 'new' } | { kind: 'existing'; wfId: string };
  /** AgentRouter 决策结果（选哪个 agent） */
  agentId?: string;
  artifactIn?: ArtifactKind[];   // 需要的上游产物
  artifactOut?: ArtifactKind[];  // 产出的交付物
  boundary?: BoundaryContract;   // 上级派发给本阶段的边界契约
}

interface StageLog {
  stageId: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  wfId?: string;
  runId?: string;
  artifactOut?: Artifact[];
  cost?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}
```

**持久化**：`orchestrations` 进 `workflowStore` `partialize` 白名单（与 `artifacts`/`pipelines` 同机制）。
视图偏好（面板开关等）存 `viewStore`。

---

## 4. 事件（Events）

复用 `runEvents` 的 EventBus，新增编排级事件种类（与运行级事件并存）：

```ts
type OrchestrationEventKind =
  | 'orch.draft.created'      // 草案已生成（待确认）payload: { orchestrationId, stages, edges }
  | 'orch.draft.confirmed'    // 用户确认草案 payload: { orchestrationId, pipelineId }
  | 'orch.stage.started'      // 阶段开始 payload: { orchestrationId, stageId, wfId, runId }
  | 'orch.stage.completed'    // 阶段完成 payload: { orchestrationId, stageId, artifactOut }
  | 'orch.stage.failed'       // 阶段失败 payload: { orchestrationId, stageId, error }
  | 'orch.reflow'             // 回流触发 payload: { orchestrationId, fromStage, toStage, artifactKind }
  | 'orch.completed'          // 全部阶段完成 payload: { orchestrationId }
  | 'orch.cancelled';         // 用户取消
```

订阅方：UI（编排面板）、终端日志、成本账本、checkpoint 记录。事件带 `orchestrationId`
与运行三元组定位（`wfId + runId`），与既有 `RunEvent` 格式对齐。

---

## 5. 产物（Artifacts）

工作流间传递沿用 `pipeline.ts` 的 `Artifact` 模型（`kind/payload/fromWf/runId/version/updatedAt`）：

- 阶段完成 → `publishArtifact({ stage, kind, payload, fromWf, runId })`（version 自增）。
- 下游阶段经 `pipeline.receive` 节点取上游产物（画布内可见）。
- 回流 → `rework()` 写回上游阶段 + 触发增量重跑（复用 executor `incremental`）。

**产物可见性**：Artifact 存项目态 `artifacts`，Inspector/编排面板可查看各阶段产物历史
（含 version 演进）。

---

## 6. 核心约束：只生成草案，不静默修改用户工作流

这是 H3 的**安全红线**，落实为代码级强制：

1. **草案生成 = 纯函数**：`generateDraft(goal, constraints)` 返回 `PipelineDraft`，**不写 store、
   不落盘、不注册工作流**；入口校验 goal 非空 / 长度 ≤2000 / maxStages ≤7 / budgetTokens ≥0。
2. **确认门（确认 ≠ 执行）**：`confirmDraft(orchId, approval)` 是唯一允许把草案落盘的入口；
   `approval` 必须显式为 `'approved'`；**只把状态置为 `ready`（确认待执行），绝不进入 `running`**。
   `running` 只能由 H3b `runOrchestration()` 进入——确认后用户仍可编辑草案/绑定工作流，不自动运行。
3. **草案与用户工作流隔离**：
   - `wfRef.kind: 'existing'` 的复用，**只读引用**（不 clone 不修改原工作流）；
   - `wfRef.kind: 'new'` 的生成，落地为**新工作流**（`registerWorkflow(..., {activate:false})`），
     用户可以编辑后再跑；Orchestrator 不会自动运行未经确认的新工作流。
4. **撤销/废弃（状态约束）**：`discardDraft(orchId)` 只允许删除**未开始执行**的编排
   （draft / awaiting-confirm / ready），**不触碰任何用户工作流**；`running`/`paused` 必须
   先 `cancelOrchestration()`（停止当前阶段 → 转 cancelled）再删除；`done`/`failed` 属于
   历史记录，应归档而非「废弃草案」。
5. **取消/暂停**：`cancelOrchestration(orchId)` 是 running/paused → cancelled 的状态收口
   （H3b 的停止钩子先 `stopWorkflow` 停止当前阶段，再落 cancelled）；`pause` 语义由 H3b
   执行器实现（running → paused）。
6. 异常路径：任何阶段失败不自动回流（需用户确认「重试/回流/停止」三选一），
   避免 Orchestrator 自说自话改写用户工程。

### 6.1 灵活的子任务边界契约

H3 不应把任务拆分成固定的“轻量/标准/严格”流程。上级 Agent 派发阶段或子任务时，应根据目标、影响范围和风险，勾选需要传递的上下文、能力、动作、Artifact、验收、预算和恢复选项；勾选项只是 UI 表达，实际必须落成 `BoundaryContract`。

边界契约遵循单向收窄规则：

```text
Child Contract ⊆ Parent Contract
```

下级 Agent 不能因为推理需要而自行扩大路径、工具、网络、委派或副作用权限。若确实需要未授予能力，应产生结构化 `CapabilityRequest`，暂停当前阶段，交回控制面和必要的用户确认。

模板只提供常用边界的默认勾选集合，例如“只读分析”“局部代码修改”“文档生成”“外部写入”或“发布”；模板不能规定唯一的任务流程，也不能替代每次任务的影响评估。

系统应从 Boundary Contract 推导最低安全控制：小范围、可逆、无外部副作用的任务可以减少用户确认仪式，但仍保留事实记录、权限约束和宿主验收；跨模块、长时间、多 Worker 或高影响任务自动增加计划版本、lease、Evidence、Receipt 和 recovery。实际执行一旦触及未勾选边界，只能升级或阻塞，不能静默放行。

---

## 7. 最小闭环（MVP）

用户要求的最小闭环：**目标 → DAG 草案 → 用户确认 → 执行**。

### 7.1 流程

```
用户输入 goal
   ↓
[1] 草案生成（generateDraft）
   - 用 AgentRouter 决策「分几个阶段、每阶段谁负责」（复用 decideAgentCall）
   - 产出 PipelineDraft（阶段/边/agent/产物 in-out/boundary）
   - 为每个阶段评估 Boundary Contract 和最低安全控制
   - 纯函数：不落盘、不改用户工作流
   ↓  emit orch.draft.created
[2] UI 展示草案（编排面板：DAG 预览 + 每阶段 agent/产物说明）
   ↓
[3] 用户确认（confirmDraft）
   - 只做：批准校验 + 状态 awaiting-confirm → ready（确认 ≠ 执行）
   - 不在此处生成 pipeline / 绑定工作流——确认后用户仍可编辑草案
   ↓  emit orch.draft.confirmed
[4] 启动执行（H3b runOrchestration，ready → running 的唯一入口）
   - 此时才生成 PipelineDef（绑定各阶段 wfId；新工作流注册但 activate:false）
   - 写入 workflowStore.pipelines / orchestrations
   - 按拓扑序执行各阶段：校验前置产物 → 调 runWorkflow({ wfId, incremental? }) → 收集 Artifact
   - 阶段事件：orch.stage.started / completed / failed
   - 每阶段完成落 checkpoint（可中断续跑）
   ↓
[5] 全部完成 → emit orch.completed；成本/产物汇总到面板
```

### 7.2 执行器骨架（`orch.run`，先最小实现）

```ts
async function runOrchestration(orchId: string): Promise<void> {
  const orch = getOrchestration(orchId);
  if (orch.status !== 'awaiting-confirm' && orch.status !== 'paused') return;
  // 1. 拓扑序执行阶段（复用 pipeline.advance 语义）
  for (const stage of topoOrder(orch.draft.stages, orch.draft.edges)) {
    if (shouldStop(orchId)) break;                 // 用户取消/暂停
    const wfId = stageWfId(orchId, stage.id);      // 确认时绑定
    emitOrch('orch.stage.started', { orchId, stageId: stage.id, wfId });
    try {
      const runId = await runWorkflow({ wfId });    // 复用 executor
      const out = collectStageArtifacts(stage.id);  // handoff 产物
      updateStageLog(orchId, stage.id, { status: 'success', wfId, runId, artifactOut: out });
      persistCheckpoint(orchId);                    // 阶段级 checkpoint
      emitOrch('orch.stage.completed', { orchId, stageId: stage.id, artifactOut: out });
    } catch (e) {
      updateStageLog(orchId, stage.id, { status: 'failed', error: String(e) });
      emitOrch('orch.stage.failed', { orchId, stageId: stage.id, error: String(e) });
      // 不自动回流：等用户三选一（重试/回流/停止）
      break;
    }
  }
}
```

### 7.3 阶段校验（先最小）

- 阶段输入依赖：`advance()` 已保证产物落位，`pipeline.receive` 节点取用；缺产物时阶段
  标 `skipped` 并提示。
- 阶段失败：停在该阶段，状态 `failed`，等用户决策（不自动回流）。

---

## 8. 复用与扩展点

| 需求 | 落地 |
|---|---|
| 草案分解「分几阶段/谁负责」 | 复用 `decideAgentCall`（goal→category→agent）；草案结构由模板 `stageForGoal(goal)` 生成（先硬编码模板，后续接入 LLM 生成） |
| 编排事件 | `runEvents.ts` 扩展 `OrchestrationEventKind`（§4） |
| 阶段级恢复 | 复用 `persistCheckpoint`（每阶段完成落盘）；`orchestrations.cursor` 记录恢复点 |
| 回流 | 复用 `pipeline.rework` + executor `incremental`；用户确认后触发 |
| 草案的 agent 绑定可见可改 | 编排面板（Inspector 风格）在确认前展示每阶段 agent/产物，可改 agentId |
| 成本观测 | 每阶段 `runWorkflow` 后读成本账本，写入 `StageLog.cost` |

---

## 9. 落地顺序（先设计 + 最小闭环，不大规模实现）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **H3a 类型 + 纯函数地基** ✅ | `src/orchestrator/types.ts`（Orchestration/PipelineDraft/StageLog）+ `generateDraft` 纯函数（模板 + AgentRouter 选 agent）+ `confirmDraft`/`discardDraft`/`cancelOrchestration`/`ALLOWED_TRANSITIONS`（store 收口） | 单测：generateDraft 不写 store；confirm 才落盘；discard 状态约束；迁移表强制 |
| **H3b 编排执行器** ⚠️ 骨架完成 | `src/orchestrator/run.ts`：`runOrchestration`（ready→running→拓扑序执行→写 StageLog→首败即 failed→cancel 先 stopWorkflow 再 cancelled）；**每个阶段执行前真实绑定工作流**（existing 验证存在 / new 注册 activate:false，真实 wfId 固化到 `Orchestration.stageWfIds` 供恢复复用）；**空工作流 → 阶段失败（getWorkflow 为必需依赖，绝不运行空图标 success）**；**executor 返回明确结果 `{ status, runId }`——仅 `status==='success'` 才标阶段 success，error/aborted（非法图/节点失败/死循环/被停止）→ 阶段 failed**；**runId 由 executor 直接返回，禁止反查全局 runHistory（并发串号风险）**；readonly 固化在 Orchestration；写 success 前复查 cancelled。**待完成：pipeline 绑定持久化到 PipelineDef、orch.* 事件接入 runEvents、每阶段 checkpoint 落盘** | 单测（fake）：仅 ready/顺序/失败停/cancel/readonly/existing 不存在→失败/空工作流→失败/cancel 后不标 success/stageWfIds 固化复用/**executor 返回 error→阶段 failed**/**executor 返回 aborted→阶段 failed** |
| **H3c 编排面板 UI** ✅ 核心闭环 | 左栏「编排」入口（`OrchestratorPanel`）：目标输入 → 草案预览（DAG+agent+产物）→ **为每阶段绑定/配置工作流**（new=新建空白 / existing=复用已有，`bindStageWorkflow` 修改 wfRef，`prepareStageWorkflows` 提前固化真实 wfId 并可打开编辑）→ 显式确认（confirmDraft→ready）→ 执行（runOrchestration）→ 进度展示（StageLog 状态/runId/error）。**P0 修复（审计）**：① `createDraftOrchestration` 统一「生成草案+建编排」并固化 readonly（UI 不再漏传）；② `bindStageWorkflow` 重新绑定时**清除该阶段旧 stageWfIds**（防执行对象错配：UI 选 B 实际跑 A）；③ 执行按钮前置 `stagesReadyToRun` 检查——所有阶段须绑定非空工作流才可运行 | GUI：目标→草案→绑定→确认→执行→进度 最小闭环（H3b 待补项：orch.* 事件、checkpoint、runIds 结构） |
| **H3d 阶段模板 + LLM 草案**（可选延后） | `stageForGoal` 模板化 → 后续接入 LLM 生成草案 | — |

> H3a（纯函数地基）✅ → H3b（执行器，Codex P0 修复后收口）✅ → H3c（UI 闭环）✅ → H3d 延后。
> H3b 按 Codex 建议：仅接受 ready、原子迁移 running、拓扑序、StageLog、首败即 failed、
> cancel 先 stopWorkflow 再 cancelled、暂不做自动回流与 LLM 动态改图。
> P0 修复：真实 wfId 绑定（existing 验证/new 注册）、删除绕过确认的 orchestrateGoal 入口、
> readonly 固化到 Orchestration、写 success 前复查 cancelled、executor 返回 RunResult（error/aborted 必失败）。
> H3c：`OrchestratorPanel`（左栏「编排」）+ `bindStageWorkflow`/`prepareStageWorkflows`；
> 审计补充的 executor 提前返回分支（空图/非法图/环路/并发拦截 → aborted）真实生命周期单测已补；
> failed 重试闭环：`runOrchestration` 接受 failed 状态（failed→running），复用已固化 stageWfIds，
> UI 显示「重试」按钮；阶段重入 running 时清除旧 error/finishedAt。
> 待补（H3b 遗留，不阻塞）：orch.* 事件接入 runEvents、每阶段 checkpoint、runIds 改为 { wfId, runId }[]。

---

## 10. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| 草案质量差（模板式阶段划分不贴目标） | 用户反复改草案 | MVP 阶段接受模板草案 + 面板可编辑；H3d 接入 LLM 生成 |
| Orchestrator 自动跑用户工作流 | 意外副作用 | 红线：确认门 + 新工作流 activate:false + 失败不自动回流 |
| 编排状态与项目持久化耦合 | 刷新丢失 | `orchestrations` 进 `partialize` 白名单（同 artifacts） |
| 与现有 runEvents/checkpoint 冲突 | 事件流污染 | 编排事件独立 kind 前缀 `orch.*`，与运行事件并存 |

**回退**：`confirmDraft` 前一切只读；`discardDraft` 一键废弃，不遗留任何用户工作流改动。

---

## 11. 文件落点（规划）

```
src/orchestrator/
  types.ts        # Orchestration / PipelineDraft / DraftStage / StageLog / OrchestratorRequest
  draft.ts        # generateDraft（纯函数，复用 decideAgentCall + 阶段模板）
  confirm.ts      # confirmDraft / discardDraft / cancelOrchestration / bindStageWorkflow /
                  #   ALLOWED_TRANSITIONS / updateOrchestration（store 收口）
  run.ts          # runOrchestration + prepareStageWorkflows + defaultDeps（按拓扑序调 runWorkflow + StageLog）
  events.ts       # OrchestrationEventKind 扩展 + emitOrch（未实现，H3b 遗留）
  *.test.ts       # 各模块单测（fake runWorkflow）
src/components/OrchestratorPanel.tsx  # H3c 编排面板（目标输入/草案预览/阶段绑定/确认/执行/进度）
src/components/LeftSidebar.tsx        # 左栏「编排」入口（SidePanelKey.orchestrator）
src/store/workflowStore.ts  # 新增 orchestrations 字段（partialize 白名单）
src/engine/runEvents.ts     # OrchestrationEventKind 扩展（未实现，H3b 遗留）
```

---

*生成日期：2026-08-11 · 基线演进：e5ccb37（H2 收口）→ 43bf641（H3a 地基）→ 83be944
（确认门语义修正）→ ad9eebb（状态迁移表强制）→ cb668eb（discard 边界 + cancelOrchestration）
→ H3b（runOrchestration，Codex 三轮审计 P0 修复：真实 wfId 绑定 / stageWfIds 固化 / 空图必失败 /
executor 返回 RunResult，error/aborted 必失败）→ 本修订（H3c 编排面板 UI 最小闭环：目标输入 →
草案预览 → 每阶段绑定/配置工作流（bindStageWorkflow + prepareStageWorkflows）→ 显式确认 → 执行 →
StageLog 进度；executor 提前返回分支真实生命周期单测）。本文档为设计稿，按实现修正。*
