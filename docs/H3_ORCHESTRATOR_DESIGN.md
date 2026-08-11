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

---

## 7. 最小闭环（MVP）

用户要求的最小闭环：**目标 → DAG 草案 → 用户确认 → 执行**。

### 7.1 流程

```
用户输入 goal
   ↓
[1] 草案生成（generateDraft）
   - 用 AgentRouter 决策「分几个阶段、每阶段谁负责」（复用 decideAgentCall）
   - 产出 PipelineDraft（阶段/边/agent/产物 in-out）
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
| **H3a 类型 + 纯函数地基** | `src/orchestrator/types.ts`（Orchestration/PipelineDraft/StageLog）+ `generateDraft` 纯函数（模板 + AgentRouter 选 agent）+ `confirmDraft`/`discardDraft`（store 收口） | 单测：generateDraft 不写 store；confirm 才落盘；discard 不碰用户工作流 |
| **H3b 编排执行器** | `src/orchestrator/run.ts`：`runOrchestration` 按拓扑序调 `runWorkflow`，事件/checkpoint/StageLog | 单测（fake runWorkflow）：顺序/失败停/取消/checkpoint 恢复 |
| **H3c 编排面板 UI** | 左栏「编排」入口：目标输入 → 草案预览（DAG+agent）→ 确认/废弃 → 进度展示 | GUI：目标→草案→确认→执行最小闭环 |
| **H3d 阶段模板 + LLM 草案**（可选延后） | `stageForGoal` 模板化 → 后续接入 LLM 生成草案 | — |

> 先做 H3a（纯函数地基，零副作用）→ H3b（执行器）→ H3c（UI 闭环）。H3d 延后。

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
  confirm.ts      # confirmDraft / discardDraft / cancelOrchestration / ALLOWED_TRANSITIONS（store 收口）
  run.ts          # runOrchestration（按拓扑序调 runWorkflow + 事件/checkpoint/StageLog）
  events.ts       # OrchestrationEventKind 扩展 + emitOrch
  *.test.ts       # 各模块单测（fake runWorkflow）
src/store/workflowStore.ts  # 新增 orchestrations 字段（partialize 白名单）
src/engine/runEvents.ts     # OrchestrationEventKind 扩展
```

---

*生成日期：2026-08-11 · 基线 main @ e5ccb37（H2 收口）→ 43bf641（H3a 地基）→ 83be944
（确认门语义修正：confirmDraft 置 ready 而非 running；补 request 校验）→ 本修订
（状态迁移表强制化 ALLOWED_TRANSITIONS；§7.1 确认/执行解耦表述同步）。本文档为设计稿，按实现修正。*
