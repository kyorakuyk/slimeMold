# 执行内核六阶段改造验证清单

> 对应：Codex 六阶段规划（A1/A2/A3 运行任务模型 → B AgentRouter → C 可恢复执行 → D 实时接管 → E 自我学习）+ 缓存隔离细粒度化。
> 文档时间：2026-08-08。本地 commit 范围：`f830556` ~ `4dd8dba`（均已 push）。
>
> 分两层验证：
> - **自动化**（可一键跑）：`tsc --noEmit` + `vitest run` + `i18n:check`，所有单测/集成测试即为该模块的验证项。
> - **GUI 手动**（需 `npm run tauri dev`）：每个阶段的端到端行为验证项。

---

## 0. 一键回归基线（每次改动后必跑）

| # | 命令 | 通过标准 |
|---|---|---|
| 0.1 | `npx.cmd tsc --noEmit` | 0 错误 |
| 0.2 | `npx.cmd vitest run` | **307** tests passed（全量，含本清单各模块） |
| 0.3 | `npx.cmd tsx scripts/check-i18n.ts` | 所有语言与 zh-CN 对齐 |

---

## 1. A1 + A3：运行任务模型（RunContext）+ 统一事件流

### 1.1 自动化测试

| 测试文件 | 用例数 | 验证点 |
|---|---|---|
| `src/engine/runContext.test.ts` | 7 | 事件总线 subscribe/emit、便捷构造器 `emitRun`/`emitNode`、`history(wfId, runId)` 过滤、FIFO 缓冲、`clear` 语义、`derivePolicy` 缺省与覆盖 |
| `src/engine/executorEvents.test.ts` | 4 | 正常跑完的事件序列（run.created→started→node.*→run.completed）、失败序列（node.failed→run.failed）、stopWorkflow 发 run.aborted、二次运行缓存命中（node.completed status=cached 且不发 node.started） |

### 1.2 GUI 手动验证

- [ ] 画布右上角 JobBoard 正常出现，进度条随层推进
- [ ] 运行成功后 JobBoard 自动消失；失败/停止时显示对应终态
- [ ] DevTools Console 验证事件流完整：
  ```js
  const { getRunBus } = await import('/src/engine/runEvents.ts');
  getRunBus().history().map(e => e.kind)
  // 应包含 run.created → run.started → node.started → node.completed … → run.completed/failed/aborted
  ```
- [ ] 事件均携带 `wfId + runId + nodeId` 三元组（运行级事件 nodeId 为 null）

---

## 2. A2：JobBoard 消费事件流（不再直接读 store 零散字段）

### 2.1 自动化测试

| 测试文件 | 用例数 | 验证点 |
|---|---|---|
| `src/engine/runBoard.test.ts` | 9 | `applyRunEvent` 归约（run.created 重置、节点状态流转、进度更新、终态停跑、wfId 过滤）、`replayBoardState` 挂载即回放最近一次运行 |

### 2.2 GUI 手动验证

- [ ] 运行含失败节点的工作流 → JobBoard 显示失败节点红色、进度停在失败层
- [ ] 运行结束后 JobBoard 自动消失（`board.running=false`，不残留）
- [ ] 拆分视图左右各跑一个工作流 → 两个 JobBoard 独立显示各自进度（wfId 隔离）
- [ ] 运行中刷新/挂载新画布 → JobBoard 通过 `replayBoardState` 立即同步最近一次运行状态

---

## 3. B：AgentRouter 运行时决策层

### 3.1 自动化测试

| 测试文件 | 用例数 | 验证点 |
|---|---|---|
| `src/agents/agentRouter.test.ts` | 12 | `estimateTier` 分档、显式绑定优先、类别路由、路由表主 agent 缺失走 fallback 链、项目默认兜底、显式缺失逐级兜底（reason 标注）、大小写不敏感、无 agent 抛错、首个可用、候选链生成、RunContext goal 特征并入 |

### 3.2 GUI 手动验证

- [ ] `ai.chat` 节点**不选 agentId** → 运行正常执行（router 兜底到默认 agent），TerminalLog 出现「AgentRouter 已路由到…」
- [ ] 路由表把类别指向**不存在的 agent id** → 自动 fallback 而非「智能体不存在」报错
- [ ] 项目路由表配置 `ui→agentA, fallback=[agentB]`，删除 agentA → worker 自动走 agentB
- [ ] 成本记录（TokenUsagePanel）显示的是**实际路由后**的 agent/模型，而非请求时填写的 id

---

## 4. C：可恢复执行（检查点持久化）

### 4.1 自动化测试

| 测试文件 | 用例数 | 验证点 |
|---|---|---|
| `src/engine/checkpoint.test.ts` | 12 | `buildCheckpoint`（忽略 idle）、`applyCheckpoint` 恢复语义（success/cached 复用不标脏、error 保留+标脏、其余重置）、`isRestorable`（含 skipFailed 终态 success 但含 error 节点）、`fromRunRecord` 兜底、`pickCheckpoint` |
| `src/store/workflowSerialize.test.ts` | 16 | checkpoints 字段随 ProjectFile 序列化（纳入稳定快照/脏检测） |

### 4.2 GUI 手动验证（重点：跨会话断点续传）

- [ ] 跑一个中途会失败的工作流 → 失败后**关闭应用重开** → 打开项目
- [ ] 运行历史面板点「恢复」→ 画布上失败节点变红、成功节点保留结果（status=cached/success）
- [ ] 点「继续运行」→ **只重跑失败节点及其下游**，成功节点直接复用（不重新执行）
- [ ] 磁盘检查：项目根 `.slimemold/runs/checkpoints.json` 存在且含该工作流节点快照
- [ ] 打开含 checkpoints 的项目不误报「未保存」（checkpoints 写入走 suppressDirty，不污染脏标记）

---

## 5. D：实时接管（Human Takeover）

### 5.1 自动化测试

| 测试文件 | 用例数 | 验证点 |
|---|---|---|
| `src/engine/intervention.test.ts` | 6 | requestIntervention 挂起+emit node.intervene、resolve（resolved）/reject（cancelled）放行、不存在 nodeId 返回 false、重复请求取代、cancelInterventionsForRun 按运行清理、reset 隔离 |
| `src/engine/executorIntervene.test.ts` | 2 | executor 全链路：节点调 intervene → 提交结果 → 节点以用户结果 success；stopWorkflow 后待接管请求以 cancelled 放行（不挂死） |

### 5.2 GUI 手动验证

> 当前无内置节点调用 `ctx.intervene`；验证时需临时在任一节点 execute 内加：
> ```ts
> const r = await ctx.intervene?.({ message: '测试接管', defaultResult: '草稿' });
> if (r) ctx.logger.info('接管结果: ' + (r.kind === 'resolved' ? r.result : '已取消'));
> ```

- [ ] 运行 → 弹出「人工接管」模态框（含节点名/类型/message 说明）
- [ ] 文本框预填 `defaultResult`，可修改后「提交结果」→ 节点以提交值完成、运行继续
- [ ] 点「取消」→ 节点收到 cancelled 继续（不阻塞整体）
- [ ] 接管挂起中按「停止」→ 模态框自动消失、运行不卡死（cancelInterventionsForRun 以 cancelled 放行）

---

## 6. E：自我学习（结构化经验库）

### 6.1 自动化测试

| 测试文件 | 用例数 | 验证点 |
|---|---|---|
| `src/agents/experienceStore.test.ts` | 6 | `summarizeExperience` 归约（失败逐条+教训、成功按 typeId 聚合平均耗时、空输入）、addExperience 去重+持久化、matchExperience 按 typeId 最新优先、remove/clear、项目隔离 |

### 6.2 GUI 手动验证

> 前置：selfImprove 开关开启（`reviewer.ts` 的 `setSelfImprove`，默认关——避免意外费用/落盘）。

- [ ] 跑一次含失败节点的工作流 → TerminalLog 出现「自我学习：已沉淀 N 条运行经验」
- [ ] DevTools Console 验证经验落库：
  ```js
  Object.keys(localStorage).filter(k => k.startsWith('sm.experience.')) // 非空
  ```
- [ ] 再次运行同类型节点 → 日志出现「命中 N 条历史经验」
- [ ] 不同项目（projectId 不同）经验互不可见（按 projectId 隔离）

---

## 7. 缓存隔离细粒度化（节点实例 + 环境指纹）

### 7.1 自动化测试

| 测试文件 | 用例数 | 验证点 |
|---|---|---|
| `src/engine/nodeCache.test.ts` | 18 | 原 14 项（key 稳定性/变化、scope 隔离、strike/clear/统计）+ 新增 4 项：`composeCacheScope` 组合、同工作流内不同节点实例不串缓存、workspace 指纹变化使 key 失效、节点实例 set/get 隔离 |

### 7.2 GUI 手动验证

- [ ] 画布放**两个完全相同配置**的节点（如两个同文本 `input.text`）各自接下游 → 两个下游都正常执行，互不串结果
- [ ] 改其中一个节点参数重跑 → **只有对应下游重算**，另一个仍命中缓存（节点实例隔离生效）
- [ ] 切换工作区目录后运行文件读取类节点 → 旧缓存失效、重新执行（环境指纹生效）
- [ ] 同一节点连续两轮运行 → 第二轮仍可命中缓存（增量执行语义未破坏）

---

## 附：快速验收路径（建议顺序）

1. 先跑「0. 一键回归基线」确认全绿
2. 优先 GUI 验收行为变化最明显的两项：
   - **C 断点续传跨会话**（4.2）
   - **D 接管不挂死**（5.2）
3. 再逐项过 B（3.2）/ E（6.2）/ A2（2.2）/ 缓存隔离（7.2）

## 附：已知限制

- D 接管验证需临时给节点加 `ctx.intervene` 调用（无内置节点使用该能力）
- E 经验沉淀需开启 selfImprove 开关（默认关）
- headless 运行器（`headless.ts`）的缓存 scope 仍为共享纯计算（未接 wfId 隔离），如需 CLI 验证细粒度隔离需收敛两路
