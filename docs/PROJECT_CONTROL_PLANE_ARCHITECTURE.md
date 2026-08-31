---
title: SlimeMold 项目控制面架构：会话、Issue、任务与 DAG
date: 2026-08-31
status: partial-mvp
---

# SlimeMold 项目控制面架构：会话、Issue、任务与 DAG

> 本文记录 2026-08-31 形成的产品方向决策，以及随后完成的最小控制面实现。它不是完整自治能力的声明。
> 当前 SlimeMold 已经具备项目驾驶舱、项目会话、受限主控 question/Brief/architecture 协议、Task Graph、Issue 四栏看板、H3 Orchestrator 草案和 H4 受控开发基础；真实模型验收、完整计划编译、漂移检测和长期运维仍需实现。

## 1. 问题与产品判断

当前产品能够运行预先配置好的工作流，但还不能稳定地让用户只用一句自然语言启动一个完整的软件项目。原因不是缺少更多节点，而是缺少一层把模糊意图收敛为可确认项目计划的控制面：

```text
用户目标
→ 需求澄清
→ 产品与架构决策
→ 任务和依赖拆分
→ 可执行工作流
→ 隔离生产
→ 测试、证据与验收
→ 交付和维护
```

因此，SlimeMold 的初级入口应从“新建一个空工作流”转向“开始一个项目会话”。

“一句话建立项目”的准确产品承诺是：

> 用户用一句话启动项目，主控 Agent 通过有限的高价值问询，把目标收敛成经过用户确认的项目蓝图和执行计划。

这不等同于承诺“一句话立即生成任意复杂且无需确认的完整软件”。对于无法确定的需求、环境、预算或验收条件，系统必须显式展示假设和未决问题。

## 2. 总体决策

### 2.1 增加项目级主控会话

主控 Agent 是用户面对的项目协调入口，拥有项目级会话和项目记忆，但不是一个只输出自然语言的聊天机器人。

主控 Agent 负责：

- 询问目标、约束、非目标、环境、预算和验收标准；
- 维护当前理解、假设、未决问题和用户决策；
- 生成 Product Brief、PRD、Architecture Spec、Task Graph、Risk Register 和 Cost Budget；
- 提出 Agent/模型/阶段分配；
- 将运行失败、架构漂移、Bug 和运维事件转化为 Issue；
- 在每个高影响决策处等待用户确认。

主控 Agent 不应：

- 把聊天回复伪装成已经批准的产品决策；
- 静默修改用户的工作流、架构或代码；
- 无用户批准地把未认领 Issue 移入项目或创建新项目；
- 绕过成本、权限、worktree、测试和证据边界；
- 以模型自报的“已完成”替代宿主真实证据。

### 2.2 三种页面是同一项目状态的投影

三种页面不是三套互相独立的系统，而是不同认知层级的视图：

```text
┌────────────────────────────────────────┐
│ 简易工作台 · Intent / Project          │
│ 我想做什么？项目目前需要我决定什么？     │
└────────────────┬───────────────────────┘
                 │ 生成和修改
                 ▼
┌────────────────────────────────────────┐
│ Issue 工作台 · Planning / Change       │
│ 项目要解决哪些问题？哪些变化进入队列？   │
└────────────────┬───────────────────────┘
                 │ 编译为执行计划
                 ▼
┌────────────────────────────────────────┐
│ DAG 工作台 · Execution / Inspect       │
│ 系统具体如何执行、测试和产生证据？       │
└────────────────┬───────────────────────┘
                 │ 运行结果和新问题
                 └───────────────┐
                                 ▼
                         主控会话 / Issue
```

页面之间通过稳定 ID、版本、来源和关系映射，不通过复制文本保持同步。

### 2.3 空白首页不暴露高级工作台

没有当前项目时，首页的主动作是“开始项目会话”，而不是“进入高级工作台”。高级工作台入口应放在项目上下文中，并且打开当前项目、当前工作流和当前任务，不打开一个无上下文的空白画布。

存在当前项目时，首页应显示：

- 当前项目名称和生命周期状态；
- 主控会话的下一步；
- 未解决的问题和待确认决策；
- 最近 Issue；
- 最近交付物和运行状态；
- 进入 Issue 工作台和专业 DAG 的项目级入口。

## 3. 控制面与执行面

SlimeMold 应分成四个逻辑平面。它们可以由同一个桌面应用承载，但职责和权限必须分开。

```text
控制面：用户、会话、主控、决策、审批、预算
计划面：Issue、产品资产、架构、任务图、风险
执行面：Pipeline、Orchestration、Workflow DAG、Worker、Worktree
反馈面：Run、Evidence、Artifact、审计、Bug、运维事件
```

主控 Agent 跨越控制面和计划面；Orchestrator 负责把已批准的计划交给执行面；宿主证据和运行结果从反馈面回流到计划面。

## 4. 规范实体与真相来源

| 实体 | 作用 | 是否可作为事实来源 |
|---|---|---|
| `Project` | 项目身份、仓库、生命周期和运行策略 | 是 |
| `ProjectSession` | 用户与主控的会话、问答、摘要和引用 | 是会话来源，不是全部项目事实 |
| `Decision` | 用户批准的目标、约束、架构和发布决策 | 是 |
| `Issue` | 想法、需求、Bug、风险、问题和变化 | 是 |
| `Artifact` | Brief、PRD、架构、任务、报告等版本化产物 | 是 |
| `Task` | 已批准的可执行工作单元、依赖、影响域和验收规则 | 是 |
| `Pipeline` / `Orchestration` | 阶段级交付、调度和恢复状态 | 是运行计划 |
| `Workflow` | 节点级可执行 DAG | 是执行计划，但不是产品需求真相 |
| `Run` | 一次实际运行及其状态 | 是运行事实 |
| `Evidence` | 宿主采集的测试、diff、策略和命令证据 | 是验收事实 |

### 4.1 会话和决策必须分离

用户在会话里说“不要使用 MongoDB”，不能只留在长文本中。主控应把它提炼为待确认决策；用户确认后，才写入项目事实：

```text
会话消息
→ 主控提炼
→ Decision(status: proposed)
→ 用户批准
→ Decision(status: active)
→ Architecture / Task / Workflow 引用该 Decision
```

会话消息保留原始来源和上下文，Decision 保留可检索、可审计的结构化含义。

### 4.2 建议的项目存储边界

当前 `.slimemold/` 已经承载项目元数据、工作流、运行历史和检查点。后续扩展时应避免继续把所有内容塞进单个 `project.json`，可以逐步增加以下逻辑分区：

```text
.slimemold/
├── project.json
├── agents.json
├── sessions/<session-id>.jsonl
├── decisions/<decision-id>.json
├── issues/<issue-id>.json
├── artifacts/<artifact-id>.json
├── task-graphs/<graph-id>.json
├── orchestrations/<orchestration-id>.json
├── workflows/<workflow-id>.json
├── runs/
└── evidence/
```

具体文件布局可以复用现有 `projectIO` 的目录式持久化方式，但必须为新实体保留版本号、来源、项目范围和迁移策略。

## 5. 主控会话生命周期

建议主控会话采用有限状态，而不是无限聊天：

```text
intake
→ clarifying
→ brief-review
→ architecture-review
→ plan-review
→ ready
→ executing
→ blocked / awaiting-user
→ delivered
→ operating
```

每次主控回复都应明确当前状态和下一步：

```text
当前阶段：架构确认
已确定：用户、目标、技术环境
仍需决定：数据存储方式、部署方式
系统建议：SQLite + 本地部署
[采纳建议] [修改方案] [暂不决定]
```

每轮问询应优先询问会改变架构、成本、权限或验收结果的问题；低影响问题可以使用明确假设并允许用户后续修改。应设置最大问询轮次或“先按当前假设生成草案”的出口，避免用户陷入无限澄清。

### 5.1 用户确认门

至少保留以下确认门：

1. 项目目标、用户和范围；
2. PRD、非目标和验收标准；
3. 架构、模块、接口和关键不变量；
4. 任务计划、预算、模型和权限；
5. 开始执行；
6. 合并、发布或破坏性清理；
7. 进入持续运维。

确认是状态迁移，不应只依赖按钮文案。未确认的草案可以修改和废弃，不能直接产生不可逆副作用。

## 6. Issue 工作台

Issue 是项目变化的统一入口。未认领 Issue 可以属于全局收件箱，不应因为尚未归属项目而被丢弃。

### 6.1 四个 UI 面板

| 面板 | 聚合的实际状态 | 说明 |
|---|---|---|
| 收件箱 / 未规划 | `inbox`、`triaging`、`proposed` | 想法、Bug、风险和未归类问题，不自动执行 |
| 待做 | `approved`、`queued` | 已经批准并进入执行队列 |
| 在做 | `in_progress`、`review`、`blocked` | 正在施工、验证、等待或阻塞 |
| 已交付 / 运维中 | `done`、`operating` | 一次性交付，或已经批准进入持续运行 |

“Issue”是对象类型，不是唯一的状态。`projectId: null` 表示未认领；项目归属必须是明确关系，标签只用于筛选和分类。

### 6.2 主控对未认领 Issue 的操作

```text
用户记录想法
→ 主控分析类型、影响和可能项目
→ 提出 projectId / 新项目建议、优先级和拆分方案
→ 用户批准
→ 归入已有项目或建立新项目
→ 生成任务或继续澄清
```

主控的分类建议必须能回到来源会话，并显示影响范围和不确定性。

## 7. 管理、施工和运维角色

“管理部门、施工部门、运维部门”应作为运行时职责、权限和上下文隔离策略，而不是永远运行的多个虚拟人格。只有在任务复杂度、风险或并行收益足够时，才引入额外 Agent。

### 7.1 管理层

负责：

- 产品方案和范围；
- 架构、模块和接口；
- 任务分解与依赖；
- 模型、Agent、预算和权限分配；
- 风险登记；
- 施工层的架构升级请求。

### 7.2 施工层

施工经理负责：

- 根据任务图派发工作；
- 检查影响域和依赖；
- 收集 Worker 结果；
- 组织合并和验证；
- 将无法局部解决的冲突升级。

冲突处理优先顺序：

1. 路径、符号、接口和依赖的确定性预检；
2. worktree 或沙箱隔离；
3. 非重叠 diff 自动合并；
4. 独立验证和测试；
5. 只有语义冲突才调用冲突裁决 Agent；
6. 架构、安全、数据模型或受保护路径冲突升级到管理层和用户。

“简单冲突”必须有可测试的判定规则，不能只根据 Agent 自己的描述判断。

### 7.3 运维层

持续运维不是简单地启动一个循环 Agent。它需要持久队列、调度、恢复、幂等、锁、预算、通知、权限、回滚和审计。

第一版可以先支持：

- 配置检查周期；
- 生成运维 Issue；
- 低风险只读诊断；
- 用户批准后产生增量任务。

在持久运行时完成前，不承诺默认后台自动修改或发布生产环境。

## 8. 三种页面的交互契约

### 8.1 简易工作台

无项目时：

```text
一句话目标输入
→ 开始项目会话
→ 主控问询
→ 当前理解 / 未决问题 / Brief
→ 用户确认
```

有项目时：

```text
项目状态
→ 主控下一步
→ 待确认决策
→ 最近 Issue / 交付物 / 运行
→ 继续会话、查看 Issue 或进入专业视图
```

简易工作台不暴露 Provider、Token、节点参数、MCP、DAG 或 Agent 绑定细节。

### 8.2 Issue 工作台

Issue 看板应提供：

- 全局收件箱和项目筛选；
- Issue 类型、状态、优先级、标签和项目归属；
- 来源会话、相关决策、Artifact、Task、Run 和 Evidence；
- 主控的归类建议和用户批准动作；
- 阻塞、失败和需要确认的明确状态。

### 8.3 专业 DAG 工作台

现有 React Flow 工作台作为专业执行与调试界面保留，增加：

- Issue / Task / Stage / Node 的来源关系；
- 当前 Workflow 基于哪个 Task Graph 和 Architecture 版本；
- worktree、diff、测试和 Evidence；
- “打开关联 Issue”和“生成架构变更提案”；
- 执行前的计划漂移检查。

专业用户修改影响接口、数据模型或模块边界时，不应静默写回 PRD，而应生成架构变更提案。

## 9. 版本与映射规则

推荐映射链：

```text
Session Message
  → Issue / Decision
Issue
  → Product Brief / PRD
Architecture Spec
  → Module / Interface
Module
  → Task
Task Graph
  → Pipeline / Orchestration
Task
  → Workflow DAG
Workflow Run
  → Artifact / Evidence
Failure / Drift / Bug
  → Issue
```

每个派生对象应记录：

- 来源对象 ID；
- 来源版本；
- 生成 Agent 和模型；
- 创建时间；
- 用户批准状态；
- 当前有效性；
- 影响范围。

执行前至少检查：

```text
Workflow 是否基于最新 Task Graph？
Task Graph 是否基于最新 Architecture？
Architecture 是否满足已批准的 Issue？
```

如果不满足，标记为 drift，要求重新规划或用户确认，而不是继续静默执行。

## 10. 与当前代码的关系

### 已有基础

- `BeginnerExperience`：初级首页和项目驾驶舱的基础；
- `OrchestratorPanel`：目标输入、模板草案、阶段绑定、确认和执行的 H3c MVP；
- `Orchestration`、`PipelineDef`、`Artifact`：阶段级调度与交付物模型；
- `AgentRouter`、角色库和成本评分：模型与职责路由基础；
- `runEvents`、checkpoint、RunHistory：运行可观测和恢复基础；
- H4 的 worktree、受控 Patch、测试、Evidence 和确定性验收基础。

### 已实现的最小切片

- `ProjectSession`、`Decision`、`ProjectBrief`、`ProjectArchitecture`、`ProjectTaskGraph` 和 `ProjectIssue` 的最小类型与状态机；
- 控制面快照随项目保存/打开，旧项目和损坏快照安全降级；
- 主控 Agent 的严格 `question` / `brief` / `architecture` JSON 协议，最多每轮 3 个问题；
- 简易工作台的目标输入、项目会话、Brief/架构/任务图批准门；
- 从批准任务图自动生成施工/验收 Workflow 和 Orchestration 草案，不自动执行；
- 当前项目与未认领 Issue 的四栏看板，以及项目 Issue 的显式批准/排队动作。

### 仍未具备

- Decision 从自然语言回答中的自动提炼、修改和历史 supersede UI；
- Brief → Architecture → Task Graph 的完整多轮规划和严格项目类型模板；
- Issue 的主控 triage、已有项目归类/新项目提案以及 Issue → Task 的正式关联；
- Issue、Task、Stage、Node 之间的完整双向映射和版本漂移检测；
- H3 `orch.*` 事件、阶段 checkpoint 和跨重启的完整编排恢复；
- H4 所有 Windows/Tauri GUI 场景的人工验收与长期证据恢复；
- 可恢复、可审计的长期运维运行时。

## 11. 分阶段落地顺序

### Phase A：项目会话 MVP

- 一句话目标输入；
- 项目级会话；
- 主控问询和当前理解；
- `Decision` 与用户批准；
- Product Brief 版本化；
- 从空白项目进入会话，而不是直接进入空白 DAG。

### Phase B：计划编译

- Brief → PRD / Architecture；
- Architecture → Module / Interface；
- Module → Task Graph；
- 用户确认计划后，复用现有 H3 Orchestrator 创建 Pipeline 和工作流绑定；
- 初级用户不手动配置每个阶段的工作流。

### Phase C：Issue 工作台

- 全局未认领收件箱；
- 项目 Issue；
- 四栏聚合视图；
- 主控分类建议；
- Issue → Task；
- Run / Failure → Issue。

### Phase D：施工闭环

- Construction Manager；
- scope 预检和冲突分级；
- worktree 与 Evidence；
- 阶段测试和确定性验收；
- 失败升级与人工接管。

### Phase E：DAG 映射

- Task Graph / Pipeline / Workflow 的版本关系；
- Issue、Task、Stage、Node 的互链；
- 漂移检测；
- 架构变更提案；
- DAG 运行结果反馈到 Issue。

### Phase F：持续运维

在持久队列、崩溃恢复、预算、锁、通知、权限和回滚完成后，再开放持续运维项目。

## 12. 验收标准

这个方向至少需要证明：

1. 新用户能够从一句话进入项目会话，不需要先理解 DAG；
2. 主控能够把自然语言目标转换为可审查的 Brief、决策和计划；
3. 用户可以在关键节点批准、修改、拒绝或暂停；
4. Issue、任务和 DAG 之间的关系可以追溯；
5. 运行失败能回到 Issue 和主控会话，而不是只留在节点日志里；
6. Agent 的职责隔离带来可测的质量、成本或上下文收益；
7. 所有代码修改、测试、合并、发布和清理仍然经过既有安全与证据边界；
8. 持续运维不会在没有持久运行时和用户批准的情况下伪装成已完成能力。

## 13. 非目标

本次方向转变不意味着立即实现：

- 无人值守的自动软件公司；
- 每个任务都创建多个常驻 Agent；
- 任意自然语言直接生成未经确认的自由 DAG；
- 自动 push、自动发布或无限循环重试；
- 完整云端团队协作；
- 用漂亮的角色、徽章和动画替代真实的质量、成本和证据。
