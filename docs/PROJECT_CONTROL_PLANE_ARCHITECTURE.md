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

本架构遵循 [`SLIMEMOLD_PRODUCT_PHILOSOPHY.md`](SLIMEMOLD_PRODUCT_PHILOSOPHY.md) 定义的元 Harness 原则：用户拥有目标和最终决定权，Agent 拥有局部推理和执行权，Project Control 负责上下文、权限、事实、证据、恢复和视图投影之间的边界。

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

专业 DAG 是执行解释、调试、审查和溯源面，不是任务执行的唯一事实源。图上的编辑必须转化为领域命令或新的计划 revision，不能绕过控制面直接修改运行事实。

### 8.4 双向映射与三态图

DAG 与内部实现应形成双向映射，但中间必须经过可验证的语义计划层，而不是让画布状态直接写入运行时：

```text
项目事实 / Decision / Task
        ↓
Plan IR / Semantic Workflow
        ↓
静态图、动态图和用户视图

用户图上操作
        ↓
语义意图 / Domain Command
        ↓
Plan IR 或 Plan Revision
        ↓
事件流与内部状态
        ↓
重新生成各类视图
```

为了同时支持编辑、复用和运行，图需要区分三个生命周期：

```text
Draft Graph
  → 用户或 Agent 编辑、试验、审查
  → publish
Static / Published Graph
  → 按固定版本引用和组合
  → instantiate
Dynamic Runtime Graph
  → 某次 Run 的实际展开、分支、重试和证据投影
```

Static Graph 是带有输入输出、能力、权限、副作用和验收契约的可复用 Graph Module。它可以在父图中作为黑盒节点，但必须保留按权限下钻的溯源入口；“黑盒”表示组合时封装复杂度，不表示隐藏结果和证据。Dynamic Runtime Graph 主要用于观察、调试和溯源，不应被直接当作新的源计划。

运行时展开的节点应保留 `moduleId/moduleVersion`、来源图和节点 ID、运行实例 ID、attempt 以及 Evidence/Receipt 的来源链。图上移动、分组等纯布局变化只更新视图投影；增加节点、修改参数或调整连线则产生计划草案变更或新的计划 revision。

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

### 9.1 图操作的领域语义

图操作不能统一解释为“修改节点”。控制面应按操作是否影响执行语义进行分类：

| 图上操作 | 领域语义 | 结果 |
|---|---|---|
| 移动、缩放、分组、颜色 | 视图投影修改 | 不改变 Task、Run 或执行计划 |
| 增加节点、修改参数、调整连线 | 计划草案或计划变更 | 通过 Domain Command 和版本化计划后才影响执行 |
| 修改 Agent、能力、权限、Artifact 或验收 | Decision / Policy / Acceptance 变更 | 需要影响评估和更高等级确认 |
| 修改已执行或历史图 | 新 Plan Revision / override | 不覆盖旧 Run、旧 Evidence 或旧事实 |

执行中的动态图不允许被静默修改。用户需要改变运行路线时，应暂停受影响范围、生成变更提案，并在确认后创建新的 Run 或 attempt。

### 9.2 上下级任务的 Boundary Contract

Task / Run 的安全边界应由可验证的 Boundary Contract 表达。用户界面可以把它表现为勾选项，但勾选结果必须落成结构化契约，而不是仅存为展示标签。

目标模型（当前仍属于设计契约，不等同于已经存在的 TypeScript API）至少包含：

```text
context       → 可以接收哪些项目事实和上下文
scope         → 可以访问哪些文件、符号和 Artifact
capabilities  → 可以使用哪些能力、工具和 Provider
actions       → 可以读取、写入、执行、联网、委派什么
artifacts     → 可以产生或修改哪些产物类型
acceptance    → 必须由哪些宿主检查证明
budget        → 时间、Token、调用次数和费用边界
recovery      → 失败、未知副作用和重试处理
delegation    → 是否允许继续派发子任务
```

上级 Agent 派发子任务时，应确定子任务触及的范围、能力、动作、验收和风险，并把对应选项传给下一级。子任务契约只能收窄上级契约：

```text
Child Contract ⊆ Parent Contract
```

下级如果需要未授予的能力，必须产生 Capability Request 并暂停等待控制面决定，不能自行扩大边界。模板只是 Boundary Contract 的默认勾选集合，不应规定唯一的任务流程。

系统应根据契约推导最低控制集合，而不是只依据项目大小或节点数量。小范围、可逆、无外部副作用的任务可以减少用户仪式，但仍保留基础事实、权限和宿主验收；跨模块、长时间、多 Worker 或高影响任务则自动启用更完整的计划版本、lease、Evidence、Receipt 和 recovery。执行中发现边界扩大时只能升级，不能静默降级。

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
- Draft Graph、Static / Published Graph、Dynamic Runtime Graph 的统一来源链和版本化模块模型；
- Task / Run 的 Boundary Contract、上下级契约收窄校验和契约驱动的最低控制集合；
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
- 同时生成或校验 Task / Run 的 Boundary Contract，并根据契约推导最低安全控制；
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
- 根据 Boundary Contract 执行能力、路径、Artifact 和副作用边界；
- 失败升级与人工接管。

### Phase E：DAG 映射

- Task Graph / Pipeline / Workflow 的版本关系；
- Draft Graph → Static / Published Graph → Dynamic Runtime Graph 的来源和版本关系；
- Issue、Task、Stage、Node 的互链；
- 漂移检测；
- 架构变更提案；
- 图上语义编辑到 Domain Command / Plan Revision 的转换；
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
8. 图上编辑可以区分视图变化、计划变化和策略变化，并且可以追溯到领域命令；
9. 子任务 Boundary Contract 只能收窄上级边界，越权请求会暂停而不会静默放行；
10. 持续运维不会在没有持久运行时和用户批准的情况下伪装成已完成能力。

## 13. 非目标

本次方向转变不意味着立即实现：

- 无人值守的自动软件公司；
- 每个任务都创建多个常驻 Agent；
- 任意自然语言直接生成未经确认的自由 DAG；
- 自动 push、自动发布或无限循环重试；
- 完整云端团队协作；
- 用漂亮的角色、徽章和动画替代真实的质量、成本和证据。

## 14. 全局产品与系统审视补充（2026-09-01）

本节补充前述 MVP 设计，记录对边缘场景和长期方向的共同审视。它不是单纯的实现清单；当本节与早期“仍未具备”描述发生冲突时，以当前代码、开发日志和本节标注的阶段边界为准。

### 14.1 产品基本单位：可暂停、可验收的项目任务

SlimeMold 的基本单位不应是一次 LLM 请求，而应是：

```text
有目标、有边界、有依赖、有版本、有验收标准、可以暂停和恢复的项目任务。
```

因此产品闭环应保持为：

```text
Intent
→ Project Control
→ Plan / Decision
→ Execution
→ Evidence
→ Recovery / Delivery
→ New Project Facts
```

UI 的默认认知顺序应是：

```text
我想做什么？
→ 系统理解了什么？
→ 还有什么需要我决定？
→ 系统准备怎么做？
→ 现在做到哪一步？
→ 如果失败，下一步怎么办？
```

简单驾驶舱、Issue 工作台和专业 DAG 应继续作为同一项目状态的不同投影，不能各自维护独立事实。

### 14.2 Agent 路由：从静态 category 映射升级为能力发现

`ui → Gemini` 这类静态映射只能覆盖预设场景，不能表达 Unity 3D 建模、媒体处理或特定工程工具等复合需求。

路由模型应逐步升级为：

```text
能力声明
→ 需求提取
→ 硬性能力过滤
→ 项目 / 全局路由
→ 成本、成功率、质量、延迟评分
→ fallback chain
```

Agent/Model 应声明领域、工具、Artifact 类型、平台环境、权限、质量档位和成本档位。Planner 应将用户目标转换为 `requiredCapabilities`、`requiredArtifacts` 和环境约束。

没有满足硬性能力的候选时，系统应报告 `capability gap`，提出注册 Agent、Provider 或可信插件的建议，而不是静默把不具备能力的模型当作可用模型。

当前已有显式 `agentId`、任意 category、项目 route table、fallback chain 和成本感知评分；capability registry、能力验证和 capability-gap UX 属于下一阶段基础设施。

### 14.3 Task 与 Artifact 必须使用类型化验收

Worker 成功不应统一等价于“有代码 diff”。不同任务应使用不同 acceptance contract：

```text
代码       → 编译、测试、diff、路径策略
文档       → 文件、格式、结构、引用
配置       → schema、环境兼容性、安全策略
设计资产   → 格式、尺寸、预览、引用
3D 资产    → 引擎导入、格式导出、工具验证
```

模型文本只能是候选结果；结构化解析、宿主检查、Evidence 和 receipt 才能推动状态迁移。

### 14.4 计划变化必须产生新 revision

执行中的 Brief、Architecture、TaskGraph 和 Orchestration 不应被静默修改。

```text
旧计划 revision 1
→ 新 Decision / 变更提案
→ 新计划 revision 2
→ 用户确认影响范围
→ 新 Orchestration / Run
```

已经验收的 Task 保留，仍然有效的 Artifact 可以复用，受影响任务暂停或重新规划。旧 Run 不被覆盖，新的路线通过新的版本和关联关系表达。

### 14.5 长任务、断电与致命错误的恢复原则

恢复系统的第一目标是保留现场，而不是强行修复：

```text
先保留原始事实
→ 再验证 snapshot / checkpoint
→ 再决定可恢复状态
→ 最后才允许继续执行
```

状态处理应遵循：

```text
queued 且没有 lease
→ 一致性通过后可恢复

running 或 lease 未闭合
→ recovery-required

side effect started 但没有 receipt
→ unknown，禁止自动重跑

succeeded 且有 Evidence
→ 保留，不重复执行

cleanup started 但无 receipt
→ inspect，不假设清理成功
```

事件流损坏时不能降级为空状态；snapshot 无效时可以 replay；跨文件状态不一致时必须 fail-closed。最终还需要 backup rotation、manifest/commit marker、只读安全模式和诊断导出，解决 ProjectFile、event stream、Evidence、checkpoint 不是一个物理事务的问题。

### 14.6 Fallback 必须保留已验证进度

模型不可用时，已经由宿主验证的 Task、Artifact、Evidence 和 checkpoint 应继续保留。未经验证的模型自报只能作为候选材料。

```text
保留旧 attempt
→ 检查实际 diff / 测试 / receipt
→ 生成新 attempt
→ 新 Worker 消费已验证产物
```

普通只读调用可以沿候选链 fallback；代码 Worker 不应无条件让另一个模型接管可能已被修改的 worktree。当前 Worker queue 已保留旧 attempt 并为 retry 创建新 attempt、worktree 和副作用 key；部分修改自动形成结构化 checkpoint 仍待实现。

### 14.7 事实源与跨进程竞争

跨层状态的主事实源是：

> 以 `projectId` 为边界的 durable DomainEvent stream。

事件通过 `eventId`、`sequence`、`aggregateId`、`aggregateVersion`、`source.objectVersion`、`correlationId` 和 `causationId` 连接对象。

但权威需要分层：

```text
DomainEvent stream       → 状态迁移事实
Host Evidence / Receipt  → 执行与副作用事实
Git revision / worktree  → 代码状态事实
ProjectFile / snapshot   → 投影与缓存
Agent text               → 建议和解释
```

文件锁只能防止事件流写坏，不能单独防止两个应用实例同时启动同一个 Run。长期方案需要项目级 execution lease，并让第二个实例进入只读或观察模式。

### 14.8 Context Pack 与记忆边界

项目记忆可以保存经验和原则，但不能覆盖当前用户确认的 Decision。建议的优先级是：

```text
当前 Decision
> 已批准 Architecture / TaskGraph
> 宿主 Evidence
> 当前 Task 输入
> 项目记忆
> 历史经验
> Agent 推测
```

Worker 的上下文应由 Context Pack 编译：任务目标、相关决策、影响文件/符号、必要文档、依赖接口、验收规则和允许路径。当前 Harness 的历史裁剪不是完整 Context Pack；文件/符号索引、文档分块、引用和硬预算仍是未来工作。

## 15. 由全局审视与竞品调研共同调整的优先级

竞品调研的结论不是继续补齐 Dify、n8n、Coze 或 LangGraph 的表面能力，而是把 SlimeMold 的控制权边界收敛为项目级事实、执行保障和安全交付。完整分析见 [`docs/reference/AI_AGENT_ORCHESTRATION_LIMITATIONS_RESEARCH.md`](reference/AI_AGENT_ORCHESTRATION_LIMITATIONS_RESEARCH.md)。

下一阶段不应优先增加更多节点或更强自治，而应按以下顺序收敛风险：

1. Evidence → 用户查看 diff → 用户批准交付/合并 → 交付 receipt → Issue/项目事实更新；
2. 面向普通用户的失败、等待和 recovery UX，明确已经发生的副作用与下一步可逆动作；
3. Context Pack 编译器、文件/符号索引和结构化 Artifact 引用；
4. capability registry、capability gap、类型化 Artifact acceptance；
5. quota/rate-limit/暂停恢复状态与项目级 execution lease；
6. 为 Run 绑定完整 graph/policy/plugin/input/provider/tool-schema hash；
7. 完成 ProjectControl event source 与旧 workflowStore/executor 的 cutover，最后再扩大持续运维和外部自动化范围。

最终验收不应只问“代码是否运行”，还应问：

```text
用户能理解
系统能暂停
状态能恢复
结果能验证
事实不分裂
路线不漂移
```

## 16. MVP 垂直切片实测状态（2026-09-02）

当前已经有一条可复现的受控 MVP 垂直切片：

```text
简单驾驶舱确认
→ durable RunQueued / Worker event
→ 独立 worktree + branch
→ Codex Worker
→ 宿主测试、diff、path-policy
→ host Evidence
→ Orchestration 投影为 done
→ 用户批准 cleanup
→ cleanup receipt + TaskCleaned
→ 从 ProjectFile + event stream 重启恢复
```

真实 smoke 使用隔离 Git fixture 完成了上述路径，并验证了三个重要边界：

- Windows 命令 shim（`npm.cmd` 等）由宿主解析，不放宽命令白名单；
- cleanup 以 worktree path 查询、以登记 ID 执行删除，且保留 acceptance、base revision、state signature 和 live registration 二次校验；
- Worker Run 与 Orchestration 共享同一项目投影，专业视图不会在 Worker 已完成后继续显示“待执行”。

失败/恢复边界也已在独立 fixture 中实测：宿主测试失败会产生 failed Evidence、保留 worktree 且不生成可执行 cleanup；重启时未闭合 lease 会进入 recovery-required，用户选择 skip 不启动新 Run，选择 retry 则创建新的 attempt、worktree 和副作用 key。事件流对不同 attempt 使用不同事件 ID，避免从空内存队列恢复时与旧事实冲突。

这仍然只是单任务、当前 Codex provider、受控命令和代码文件 acceptance 的 MVP 证明。通用语言/Artifact acceptance、事件独立重放、quota、execution lease、Context Pack、用户交付和多实例竞争仍属于后续阶段；不应把本节解释成产品已完成发布。
