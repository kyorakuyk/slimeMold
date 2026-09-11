---
title: Codex 设计评审意见
type: historical-review
status: archived
date: 2026-08-09
authority: none
---

# Codex 设计评审意见

本文整理当前 SlimeMold 架构在动态文件授权、成本感知路由、Checkpoint、事件流持久化和后续工程节奏方面的评审结论。

## 结论摘要

当前项目不应继续以“为了拆分而拆分”为主要目标。自动化基线已经基本稳定，下一阶段应优先完成真实 Tauri/GUI 验收，再根据验收结果决定是否继续拆分 `workflowStore`。

建议优先级如下：

1. P0：完成 GUI/Tauri 六阶段验收。
2. P1：增加节点级或阶段级 Checkpoint。
3. P1：建立成本统计与 Agent 经济参数模型。
4. P2：增加可选的脱敏运行摘要事件日志。
5. P2：对 `workflowStore` 做低风险的内部模块拆分。
6. P3：评估从动态 Capability 注入迁移到 `FsExt::allow_directory()`。

## 1. 动态 fs scope 授权

### 当前方案

当前 Rust 侧通过 `CapabilityBuilder` 动态注入 scoped capability：

```rust
CapabilityBuilder
    .permission_scoped("fs:scope", ...)
    .app.add_capability(...)
```

静态 capability 已提供必要的 fs 命令权限，运行时再根据项目路径追加动态授权。

### 推荐方案

对于“打开项目后授权项目目录”这一场景，更推荐使用 Tauri 官方 fs scope API：

```rust
use tauri_plugin_fs::FsExt;

app.fs_scope()
    .allow_directory(path, true)?;
```

两者职责不同：

```text
Capability：窗口是否拥有某类 fs 命令权限
Fs Scope：这些命令允许访问哪些路径
```

因此，当前已有静态 fs 权限时，只扩展运行时 scope 更直接，也更不容易再次踩到 capability JSON 格式和操作权限配置的坑。

### 迁移时必须保留的安全校验

- 对路径执行 `canonicalize()`，避免符号链接造成路径边界绕过。
- 确认路径存在且确实是目录。
- 拒绝包含 `..` 的路径输入。
- 只授权项目根目录及其子目录，不授权父目录。
- 明确 `recursive = true` 会开放整个项目目录树。
- 检查所有读写命令仍有对应的静态 permission。

### 判断

`FsExt::allow_directory()` 是更轻量、更贴合官方语义的实现，但迁移不是当前功能阻断项。应在真实 Tauri 环境中验证后再替换现有方案。

建议验收路径：

```text
打开默认目录项目
打开 $HOME 外项目
读取 project.json
写入 checkpoint
读取/写入 workflow 文件
关闭后重新打开项目
```

## 2. 成本感知路由

### 当前权重的定位

`cost: 0.35 / success: 0.35 / tierFit: 0.30` 可以作为初始实验值，但不能直接视为“性价比最优”。

### 推荐决策模型

先做硬约束过滤，再做候选评分：

```text
硬约束：能力、工具调用、上下文长度、预算、订阅可用性

候选评分：
score = costUtility
      + successUtility
      + latencyUtility
      + tierFitUtility
      + subscriptionUtility
```

各指标需要先归一化，尤其不能直接把价格原值与成功率相加。

### Agent 经济参数

不建议只增加一个含义模糊的 `cost` 字段。可以给 `AgentConfig` 增加可选经济信息：

```ts
interface AgentEconomics {
  inputPricePerMillion?: number;
  outputPricePerMillion?: number;
  subscription?: 'included' | 'api' | 'unknown';
  fixedCost?: number;
}
```

优先级建议为：

```text
用户明确配置 > 官方/内置价格表 > 运行历史估计 > 未知默认值
```

经验库可以更新实际成本、成功率和延迟，但不应覆盖用户明确配置的价格。

### 验证方式

1. 用运行历史离线回放路由决策。
2. 比较总成本、成功率、平均延迟、fallback 次数和人工接管率。
3. 使用 Pareto 前沿分析，寻找没有同时更便宜且更可靠的候选。
4. 通过小流量 A/B 测试比较固定路由与成本感知路由。

在积累足够样本前，不要自动调整权重，也不要宣称已达到最优。

## 3. Checkpoint 存储策略

### 当前覆盖式存储是否足够

如果目标只是“下次打开时恢复最近一次结果”，按 `wfId` 保留最新 checkpoint 是足够的，优点是简单、稳定、恢复快。

但如果目标是“长任务中途崩溃后续跑”，只在运行收尾时保存仍然不够，因为运行中途崩溃时，最后一次完成状态可能尚未落盘。

### 推荐演进

第一步保留当前 `latest` 快照，同时增加节点级或阶段级保存：

- 节点成功后。
- 并行阶段结束后。
- 人工介入挂起前。
- 长时间 LLM 调用完成后。
- 工作流停止时。

第二步保留最近 3–5 个运行版本：

```text
latest：快速恢复
recent runs：诊断与回滚
```

只有当工作流规模和 checkpoint 体积明显增长时，才引入增量 checkpoint：

```text
snapshot.json
deltas/run-101-node-a.json
deltas/run-101-node-b.json
manifest.json
```

通过“基础快照 + 增量记录”恢复，并定期合并为新快照。

### 判断

当前覆盖式方案可以保留作为第一阶段，但长运行工作流至少应增加节点级或阶段级 checkpoint。现在不建议直接引入复杂增量系统。

## 4. 事件流是否需要持久化

当前分工是合理的：

```text
runEvents：实时 UI、JobBoard、进度展示
runHistory：运行结果与摘要
checkpoint：可恢复状态
experience：结构化经验
```

不建议直接把内存事件总线的全部事件写入磁盘，原因包括：

- token 输出体积大。
- prompt、工具参数和文件内容可能包含敏感数据。
- 高频 progress 事件会造成磁盘写放大。
- 事件 schema 变化会带来兼容成本。

### 推荐方案

增加可选的、脱敏的运行摘要日志：

```text
.slimemold/runs/{runId}/events.jsonl
```

默认只记录：

- `run.created`
- `run.completed`
- `run.failed`
- `run.aborted`
- `node.started`
- `node.completed`
- `node.failed`
- `node.intervene`
- `agent-route`
- `fallback`
- `checkpoint.saved`

默认不记录：

- 每个 token。
- 完整 prompt。
- 完整模型响应。
- 原始工具输出。
- 文件全文。

建议提供：

```ts
eventPersistence: 'off' | 'summary' | 'full'
```

默认使用 `off` 或 `summary`，`full` 仅用于显式调试，并必须进行脱敏和容量限制。

## 5. GUI 验收与 workflowStore 拆分顺序

建议先做 GUI/Tauri 验收，再决定是否继续拆分 `workflowStore`。

### GUI 验收重点

- 动态项目目录授权。
- 最近项目打开。
- 非激活工作流运行。
- checkpoint 实际写入与恢复。
- 人工接管弹窗。
- force/stop 后旧请求消失。
- AgentRouter 类别路由。
- fallback 真实触发。
- JobBoard 事件显示。
- 长任务期间界面响应性。

推荐流程：

```text
GUI/Tauri 验收
→ 修复真实环境问题
→ 为问题补测试
→ 重新评估 workflowStore 拆分
→ 只拆已有清晰边界的部分
```

### 是否拆 workflowStore

可以拆，但应采用“门面保留、内部模块化”，不要立即重写状态协议：

```text
workflowStore.ts
├─ workflowState.ts
├─ workflowActions.ts
├─ workflowPersistence.ts
├─ workflowRuntimeCommands.ts
└─ workflowStore.ts  // 对外保持原 API
```

优先抽离：

- 纯序列化/反序列化。
- 项目打开/保存。
- checkpoint。
- run history。
- 节点布局。
- 纯 reducer。
- selector。

暂时不要直接重写：

- `runWorkflow` 与 store 的互相调用。
- 大段 actions。
- 全局状态初始化。
- 运行中状态更新协议。

### 判断

当前自动化测试已绿，但 GUI 验收文档中的实际桌面验收仍是关键缺口。GUI 验收优先级高于 `workflowStore` 物理拆分。

## 最终建议

当前项目应从“结构重构期”转入“真实环境验收与可靠性收尾期”：

1. 完成 Tauri/GUI 六阶段验收。
2. 记录并修复真实环境中的路径授权、checkpoint、intervention 和 fallback 问题。
3. 增加节点级/阶段级 checkpoint。
4. 建立成本与成功率统计，再启用成本感知路由。
5. 按需增加可选的摘要事件日志。
6. 最后对 `workflowStore` 做低风险内部拆分。

