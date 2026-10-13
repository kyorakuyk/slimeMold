---
title: SlimeMold 代码可读性评估
type: codebase-review
date: 2026-10-13
status: actionable-review
authority: implementation-reality
---

# SlimeMold 代码可读性评估

> 快照：`refactor/monolith-split-2` @ `7f248ae`（2026-10-13 00:15）
>
> 方法：TypeScript 编译器 API 统计（`scripts/readability-metrics.cjs`，可复跑）、jscpd 4.0.5 重复检测、import 依赖图脚本（被引用数已并入度量脚本）；Rust 部分为近似统计（快照 `1724f1b`，此后 Rust 未改动）。指标只是代理，不能替代人读；每条结论都附数字，便于以后看趋势。
>
> 正文是 `7f248ae` 时的评估；此后的变化见文末"进展"。

## 结论

局部好读，全局难读。类型纪律严格、重复很少、绝大多数函数短小；阅读成本集中在两处：少数超大函数，以及最复杂的控制面几乎没有代码内说明。新读者最难的是"从哪里开始读、为什么这样写"。

## 评估表

| 维度 | 现状 | 评价 |
| --- | --- | --- |
| 类型纪律 | `strict`、`noUnusedLocals`、`noUnusedParameters` 开启；6.82 万行生产代码中 47 个 `any`、21 个 `as any`、28 处 `as unknown as`、101 个非空断言、0 个 `@ts-ignore` | 好 |
| 重复代码 | jscpd：重复率 1.28%（75 处、925 行） | 好 |
| 函数粒度 | 4,868 个函数，90% 不超过 32 行；超过 100 行的 123 个，超过 300 行的 18 个 | 大体好，长尾重 |
| 嵌套深度 | 嵌套 ≥4 层的 33 个，最深 6 层（`else if` 不计层） | 好 |
| 依赖结构 | 329 个生产模块、1,343 条内部 import；3 个小循环；33 条底层引用上层，其中 25 条指向 `src/store` | 中 |
| 注释 | 注释行占代码行 8.1%，但分布倒挂：`src/projectControl` 1.0%、`src/domain` 1.8%、`src/components` 2.3%，而 `src/engine` 20.5%、`src/agents` 27.6%；导出声明带 JSDoc 的只有 38.8% | 差 |
| 概念负担 | `src/projectControl` 有 39 个 `worker*` 文件（9,244 行，占该目录 55%），名称高度相近；`src` 内没有模块 README | 差 |
| 工具护栏 | 没有 ESLint、Prettier 配置，也没有 lint 脚本 | 差 |

## 阅读成本集中在哪里

### 1. 超大函数

拆文件不等于拆函数：下面这些函数本身就是阅读瓶颈。

| 函数 | 位置 | 行数 | 圈复杂度 | 说明 |
| --- | --- | --- | --- | --- |
| `auditWorkerRunConsistency` | `src/projectControl/workerRunConsistency.ts:165` | 513 | 170 | 全仓库最复杂的函数 |
| `WorkflowEditorInner` | `src/canvas/WorkflowEditor.tsx:64` | 507 | 17 | 已从 1,104 行拆到 507 行，仍是单函数组件 |
| `recoverWorkerRun` | `src/projectControl/workerActionController.ts:468` | 463 | 39 | 恢复流程主体 |
| `ProjectSessionPanel` | `src/components/ProjectSessionPanel.tsx:82` | 462 | 21 | 已从 753 行拆出视图 |
| `OrchestratorPanel` | `src/components/OrchestratorPanel.tsx:45` | 417 | 8 | 已从 898 行拆出视图 |
| `TopBar` | `src/components/TopBar.tsx:72` | 417 | 16 | 文件拆过，主函数未变 |
| `executeNode` | `src/engine/executor.ts:508` | 398 | 43 | 27 个位置参数，常量也作为参数传入，内部还直接读全局 store |
| `ProjectSessionPanelView` | `src/components/projectSession/ProjectSessionPanelView.tsx:81` | 382 | 64 | 拆分时新产生，复杂度集中到了这里 |
| `runWorkflow` | `src/engine/executor.ts:162` | 345 | 59 | 嵌套 6 层，全仓库最深 |
| `OrchestratorPanelDetailView` | `src/components/OrchestratorPanelDetailView.tsx:69` | 304 | 14 | 拆分时新产生 |
| `AgentEditorForm` | `src/components/agentPanel/AgentEditorForm.tsx:26` | 302 | 54 | 拆分时新产生 |
| `validateFactsDto` | `src/projectControl/workerRecoveryFactsDtoValidation.ts:26` | 164 | 133 | 手写校验，分支密集 |
| `applyTaskLineageProjection` | `src/domain/contracts.ts:347` | 195 | 94 | 领域投影核心 |

10 月 12 日前后两轮按文件拆分后，超过 300 行的函数从 16 个变为 18 个：复杂度被搬进了新的视图函数（`ProjectSessionPanelView` 复杂度 64），`workflowStore.ts` 的引用方也从 53 个增加到 57 个。以后的拆分应当按函数验收，而不是按文件行数。行数大但复杂度为 1 的"工厂"函数（如 `workflowStore.ts` 的 `persist` 回调 630 行、`createDevNodeDefs` 586 行）主要是动作表和数据表，阅读负担相对小。

### 2. 最复杂的代码几乎没有说明

注释最多的是较早、较简单的 `engine`、`agents`、`types`；最新、最复杂的 `projectControl` 与 `domain` 几乎没有注释。设计理由主要写在 `docs/DEVELOPMENT_LOG.md`（5,500 多行）和 ADR 里，读代码时看不到。注释约 90% 为中文。

### 3. 概念负担

`worker*` 文件名高度相近，例如 `workerRecoveryFacts`、`…FactsSource`、`…FactsRules`、`…FactsNormalization`、`…FactsDtoValidation`、`…FactsFingerprint`、`…FactsCanonicalJson`、`…FactsTypes`。Attempt、Lease、Receipt、Evidence、Acceptance、ContextPack、CAS、fence 等术语的定义分散在 ADR 和产品哲学文档里，没有一页地图告诉读者从哪里进入、子系统如何分组。

### 4. 中心枢纽 `workflowStore.ts`

被 57 个生产模块引用，自身引用 42 个模块，两项都是全仓库最高。`engine`、`nodes`、`plugins`、`io`、`orchestrator`、`agents` 直接引用 store，读这些模块时绕不开它。其他高扇入模块：`useT.ts`、`types/agent.ts`、`projectControl/types.ts`（各 53）、`types/graph.ts` 与 `domain/contracts.ts`（各 51）、`domain/workerQueue.ts`（48）。

### 5. 没有风格护栏

TypeScript strict 覆盖了类型层面；但格式、React hooks 依赖、函数长度和参数个数都没有自动检查，风格一致性依赖写代码的 Agent。仓库里唯一的 `eslint-disable` 注释（`ProjectSessionPanel.tsx`）说明曾有人以为 lint 在运行。

### 6. Rust 宿主（近似统计）

32 个文件、12,611 行（专门的测试文件 5 个）。超过 600 行的文件 5 个；生产函数超过 100 行的 10 个，最长为 `dev_cleanup_worktree`（约 400 行，`authority/worktree.rs`）和 `run_exec`（约 380 行，`codex_process.rs`）；非测试代码中 68 处 `unwrap()`；注释行约 2.3%。

### 7. 语言约定

标识符为英文；注释约 90% 为中文；测试标题中英混用（约四成含中文）；错误信息中英混用。团队内部可读，对外部读者是轻微摩擦。

## 做得好的地方

- 类型严格且逃逸极少，接口意图可以从类型读出。
- 重复率低，没有复制粘贴式膨胀。
- 循环依赖只有 3 个、每个 2–3 个文件。
- 测试充足（232 个测试文件、3.85 万行），近期拆分前都补了特征测试。
- 近期拆分：`commands.ts` 从 1,085 行变为 45 行兼容入口加 6 个文件（最大 378 行），对外导出集合不变；`AgentPanel` 主组件 1,207 → 405 行；`WorkflowEditorInner` 1,104 → 507 行；`OrchestratorPanel` 898 → 417 行；`ProjectSessionPanel` 753 → 462 行。

## 建议（按读者收益排序）

1. **代码地图与术语表。** 为 `src/projectControl` 写一页地图：把 `worker*` 文件归成 5–6 个子系统，标出入口函数、一次 Worker 运行的流程，以及 15–20 个术语的定义和所在文件。零风险，导航收益最大。
2. **按函数拆，不按文件拆。** 现在就能做的：`auditWorkerRunConsistency` 按问题族拆成具名检查函数；`executeNode` 收成上下文对象，之后再拆 `runWorkflow`；界面上先处理 `ProjectSessionPanelView`、`WorkflowEditorInner`，再处理 `TopBar`、`AgentEditorForm`、`OrchestratorPanel`。这些文件在 phase2 上没有改动。`recoverWorkerRun`、`validateFactsDto`、`applyTaskLineageProjection` 所在文件在 main 之后被 phase2 改过（分别 12、1、9 次），等 phase2 合入 main 后再处理，避免冲突。验收看函数指标：主组件 ≤300 行，其余每个函数 ≤250 行、圈复杂度 ≤25，且超过阈值的函数总数不得增加。
3. **把"为什么"写回代码旁边。** 给最复杂的 20 个函数各加 2–3 行头注释：目的、不变量、对应 ADR 编号。
4. **加 lint 护栏。** ESLint（typescript-eslint、react-hooks）与 Prettier，对新代码设警告阈值，例如参数 ≤6、圈复杂度 ≤20、函数 ≤150 行。需要新增开发依赖，由用户决定。
5. **逐步切断底层对 store 的直接依赖。** 沿用 `executor-context-port` 拆分的做法，通过端口或上下文传入；新拆出的界面文件也不要再直接引用 store。
6. **约定语言规则**，例如标识符与日志键用英文、注释与面向用户的文案用中文（经 i18n）。

## 复跑与趋势

在仓库根目录运行：

```bash
node scripts/readability-metrics.cjs                 # 总览、目录注释率、最长与最复杂函数、被引用最多的模块
node scripts/readability-metrics.cjs --match auditWorkerRunConsistency
node scripts/readability-metrics.cjs --json <仓库外的目录>/readability.json   # 路径须以 .json 结尾
```

建议跟踪的基线（本快照）：

| 指标 | 基线 |
| --- | --- |
| 超过 300 行的函数 | 18 |
| 圈复杂度超过 50 的函数 | 13 |
| 参数 ≥6 的函数 | 17 |
| `src/projectControl` 注释率 | 1.0% |
| 导出声明 JSDoc 覆盖 | 38.8% |
| 超过 600 行的生产文件 | 12 |
| `workflowStore.ts` 被引用数 | 57 |

指标定义见脚本头注释：行数为函数首个 token 到右花括号的物理行；圈复杂度为 1 加分支、循环、`case`、`catch` 与 `&&`/`||`/`??` 的个数，不含嵌套函数；嵌套深度不把 `else if` 计为一层；注释率为纯注释行除以含代码行；被引用数为 `src/` 下引用该模块的生产模块个数。

## 进展

评估之后的拆分（`7f248ae..75f954b`）落实了一部分建议。用同一脚本复测：

| 指标 | 评估基线（`7f248ae`） | `75f954b` |
| --- | --- | --- |
| 超过 300 行的函数 | 18 | 15 |
| 圈复杂度超过 50 的函数 | 13 | 11 |
| 参数 ≥6 的函数 | 17 | 21 |
| `src/projectControl` 注释率 | 1.0% | 1.0% |
| 导出声明 JSDoc 覆盖 | 38.8% | 38.2% |
| 超过 600 行的生产文件 | 12 | 11 |
| `workflowStore.ts` 被引用数 | 57 | 60 |

- 建议 1：`src/projectControl/README.md` 给出了代码地图和 20 个术语，`codeMap.test.ts` 检查文件清单与路径。
- 建议 2：`auditWorkerRunConsistency` 按问题族拆成具名检查函数（513 行、复杂度 170 → 20 行、复杂度 3）；`executeNode` 的 27 个位置参数收成一个参数对象，函数体仍有 380 行；`ProjectSessionPanel` 降到 189 行，`ProjectSessionPanelView` 降到 118 行。
- "参数 ≥6"上升，是因为拆出的 5 个检查函数各有 6–7 个位置参数。
- 仓库里唯一的 `eslint-disable` 注释随拆分移到了 `src/components/projectSession/useProjectSessionConversation.ts`。
