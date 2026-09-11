---
title: 我和 SlimeMold：当下项目架构与未来发展方向的共同审视
type: decision-review
date: 2026-09-01
status: historical-review
---

# 我和 SlimeMold：当下项目架构与未来发展方向的共同审视

> 这不是产品宣传稿，而是一次以项目当前代码、真实 smoke 结果和既定产品方向为依据的阶段性复盘。
> 文档保留原始问题、专业化面试问题和回答，目的是同时审视：SlimeMold 现在到底完成了什么，以及它未来应该成为什么。

本文的规范性产品原则见 [`SLIMEMOLD_PRODUCT_PHILOSOPHY.md`](../../principles/SLIMEMOLD_PRODUCT_PHILOSOPHY.md)；本文只记录这些原则在产品、架构和当前实现中的阶段性转译与验证。

## 0. 共同审视的基本立场

SlimeMold 当前处于从“可视化 Agent 工作流编辑器”向“长期软件项目 Agent 工作站”迁移的中间阶段。

因此，本文严格区分三种状态：

- **已实现**：已有代码、测试或真实运行结果支撑；
- **已形成架构约束**：已有类型、接口、状态机或测试，但完整产品路径还没有完全验证；
- **未来方向**：当前仍需要继续实现，不能在面试中说成已经交付。

当前产品的目标链路是：

```text
用户目标
→ 项目主控会话
→ Brief / Architecture / Task Graph
→ 用户确认
→ Worker Run 入队
→ 独立 worktree
→ Codex 或其他 Worker 执行
→ 宿主 acceptance
→ Evidence / receipt
→ 交付、恢复或清理
```

---

## 1. UI 完成度、用户逻辑与模块动线

### 1.1 我的初始提问

> 当前的ui是你的最终版吗？是否符合用户的使用逻辑？用户使用各模块的动线是否流畅？

### 1.2 专业化面试提问

> 当前 UI 是否已经达到最终产品形态？它的信息架构是否符合用户从“提出目标”到“获得结果”的实际使用路径？各模块之间的跳转、状态反馈和异常恢复是否流畅？

### 1.3 回答

目前还不是最终版，更准确地说是**控制面 MVP + 专业工作台雏形**。

当前确定的用户主路径是：

```text
提出目标
→ 项目主控会话
→ 需求、架构和任务计划
→ 用户确认
→ Worker 入队
→ 独立 worktree 执行
→ 宿主测试与 Evidence
→ 交付、恢复或清理
```

UI 对应两种认知层级：

- **简单项目驾驶舱**：面向普通用户，展示当前项目、主控理解、下一步、待确认事项、运行状态和恢复动作；
- **专业编排视图**：面向开发者，查看 Task、Run、Worker、worktree、Evidence、receipt 和 cleanup。

Issue 工作台和 DAG 工作台不是三套独立系统，而是同一个项目状态的不同投影：

```text
Session → Decision / Brief → Issue / Task
→ Orchestration / Workflow → Run / Evidence
```

这条信息架构符合用户逻辑，因为用户首先关心“我要做什么”，随后关心“系统准备怎么做”，最后才关心“具体节点和 Worker 如何执行”。

但我不会声称动线已经完全流畅，当前仍有三个问题：

1. 首次建项目、查看 diff、批准交付/合并的完整用户路径仍需验证；
2. 简单视图与专业视图之间的状态解释还需要进一步统一；
3. 失败、阻塞、额度耗尽和等待用户决策等状态还需要更清晰的下一步指引。

真实隔离 Tauri smoke 已经分别验证成功路径和 failure/recovery 路径：确认计划可以进入 queued Run，Worker 在独立 worktree 中执行，宿主 acceptance 产生 Evidence；失败时 worktree 保留，重启进入 recovery-required，skip 不启动新 attempt，retry 创建新的 attempt、worktree 和副作用 key。

所以当前判断是：

> 信息架构方向已经确定，核心执行与恢复动线已经有真实证据，但 UI 还不是最终版。下一步要验证的是普通用户能否理解 Evidence、恢复动作和交付，而不必阅读内部 JSON 或事件日志。

---

## 2. 与 Dify、n8n、Coze 的差异和选择理由

### 2.1 我的初始提问

> 你当前的产品和dify，n8n，coze的区别是什么？你如何让用户选择你而不是他们？

### 2.2 专业化面试提问

> SlimeMold 与 Dify、n8n、Coze 的核心产品定位差异是什么？目标用户是谁？在已有成熟产品的情况下，SlimeMold 的不可替代价值是什么？

### 2.3 回答

我不会把 SlimeMold 定位成它们的全面替代品，因为四者解决的问题并不完全相同。

| 产品 | 更核心的定位 |
|---|---|
| Dify | LLM 应用、Agent、RAG 和工作流构建 |
| n8n | 企业系统连接、业务自动化、AI workflow 和可编程集成 |
| Coze | 一站式 Agent、App、Workflow、RAG、Plugin 的可视化开发和部署 |
| SlimeMold | 面向软件项目的长期 Agent 执行、代码修改、验收和恢复 |

Dify 的官方 Agent 文档强调：Agent 可以作为工作流步骤使用工具进行多轮推理，并提供最大迭代次数和记忆窗口等控制。[38]

n8n 的官方产品定位强调 AI agents、workflow、外部集成、代码能力、人工审批以及执行观察。[39]

Coze Studio 的官方仓库将自身定位为一站式 Agent 开发工具，覆盖 Prompt、RAG、Plugin、Workflow、调试和部署。[40]

SlimeMold 的差异点不是“我也有节点、Agent 和 Workflow”，而是以下几件事。

#### 第一，SlimeMold 的对象是真实软件项目

它管理的不只是一次模型调用，而是：

```text
项目目标
→ 决策
→ 架构
→ 任务依赖
→ 代码修改
→ 测试
→ Evidence
→ 交付 / 恢复
```

#### 第二，Worker 不直接修改主仓库

每个 Task 可以拥有独立 worktree、branch 和 base revision。Worker 的成功不能依赖模型自己说“完成了”，而要由宿主运行测试、diff 和路径策略检查。

#### 第三，项目状态不是聊天记录

Session、Decision、Task、Run、Evidence 都有稳定 ID、版本和来源，可以被审计和恢复。

#### 第四，产品面向长期任务

SlimeMold 关注：

- 项目重开后能否恢复；
- Worker 中途失败后能否安全 retry；
- 副作用是否已经发生；
- 失败任务如何影响依赖任务；
- worktree 是否可以安全清理；
- 计划、代码和证据是否仍然一致。

因此，选择策略不应该是“所有场景都比竞品强”，而应该是明确分工：

> 如果用户要快速做客服机器人、知识库问答应用或 SaaS 自动化，Dify、Coze 或 n8n 可能更合适。SlimeMold 面向的是希望让 Agent 长时间参与真实代码项目，同时又不愿意牺牲本地性、测试验收、审计和恢复能力的开发者或小型团队。

SlimeMold 不应该与竞品正面竞争模板数量和第三方集成数量，而应该在“真实代码项目的安全执行闭环”上建立差异化。

补充竞品调研后，这一定位可以进一步精确为“项目级事实与执行保障层”，而不是另一个通用 Agent Runtime。调研将低代码平台、自动化引擎、LLM 组件和 Agent Runtime 的控制权边界区分开来；SlimeMold 应保留项目事件流、用户审批、策略、隔离 worktree、宿主 acceptance、Evidence/Receipt、恢复和交付的权威边界。详见 [`docs/reference/AI_AGENT_ORCHESTRATION_LIMITATIONS_RESEARCH.md`](../../reference/AI_AGENT_ORCHESTRATION_LIMITATIONS_RESEARCH.md)。

---

## 3. 多 Agent 协作与交流成本

### 3.1 我的初始提问

> 你是如何解决不同agent之间的交流成本的？如何把成本控制在可控范围？

### 3.2 专业化面试提问

> 多 Agent 协作中，如何避免上下文重复传递、无效对话和协调开销？如何在保持协作质量的同时控制 Token、延迟和费用？

### 3.3 回答

核心原则是：

> Agent 之间不默认共享完整聊天记录，而是通过结构化任务和产物进行稀疏通信。

一个 Worker 不需要知道整个项目的所有历史，只需要拿到：

- Task 标题和描述；
- 影响范围；
- 依赖任务；
- 验收标准；
- 相关架构决策；
- 必要的输入 Artifact；
- 当前 worktree 和 base revision。

Worker 输出的也不是一大段新的聊天历史，而是：

- 修改结果；
- 测试结果；
- Evidence；
- acceptance ID；
- 错误或阻塞原因。

这样通信从：

```text
Agent A 的完整上下文
→ Agent B 的完整上下文
→ Agent C 的完整上下文
```

变成：

```text
结构化 Task
→ 结构化 Artifact
→ 结构化 Evidence
```

当前代码已经有几层控制：

1. **ContextScope**：`shared` 共享必要变量，`isolated` 隔离上下文，避免污染其他节点；
2. **AgentRouter**：显式绑定、类别路由、fallback 链、项目默认 Agent，以及成本/成功率/任务档位评分；
3. **AgentHarness**：历史消息裁剪、Token budget、最大工具调用轮次、瞬时错误重试和工具调用可观测；
4. **成本模型**：记录 prompt/completion token、缓存 Token、模型单价，以及本地 Ollama 和订阅模型的特殊计费语义。

当前 `AgentHarness` 默认最大工具调用轮次为 8，默认历史 Token budget 为 12,000；普通 LLM 调用还会通过限流器和重试策略控制并发与瞬时失败。

但当前成本控制还属于：

> 成本估算、路由和观测已经具备，硬预算熔断还没有完全实现。

也就是说，目前可以知道哪个 Agent 更贵、哪次调用消耗更多，但还没有一个完整的项目级预算控制器，在达到硬上限后自动暂停所有任务。

---

## 4. 长期任务稳定性与防止跑偏

### 4.1 我的初始提问

> 你如何保证长期任务的稳定性？如何保证长周期任务不会跑偏？

### 4.2 专业化面试提问

> 对于运行数小时、数天甚至更长时间的任务，如何处理进程重启、部分失败、重复执行、外部副作用和目标漂移？如何避免 Agent 在长链路中逐渐偏离原始计划？

### 4.3 回答

工程上我不会说“绝对保证不跑偏”，而是通过一组不变量，让系统在无法确认安全时停止，而不是继续猜测。

#### 1. 事件流是事实记录

Worker Run 和 ProjectControl 的重要状态写入 durable event stream，带有：

- sequence；
- aggregate version；
- event ID；
- checksum；
- append-only 语义；
- 原子写入；
- 宿主级锁。

Snapshot 只是投影和恢复材料，不能静默覆盖事实源。

#### 2. 执行前后都做一致性审计

系统会检查：

- ProjectFile 与 event replay 是否一致；
- Run 是否属于当前项目；
- TaskGraph 是否存在；
- TaskGraph 版本是否匹配；
- lease 是否闭合；
- worktree、branch 和 base revision 是否仍然有效；
- 是否出现孤立或跨项目事件。

审计失败时直接 fail-closed，进入 recovery，不继续调用 Codex。

#### 3. 先持久化 lease，再允许 Worker 执行

执行顺序是：

```text
claim task
→ 创建 worktree
→ 持久化 running lease
→ 记录副作用 started
→ 执行 Worker
→ 宿主 acceptance
→ 写 receipt
→ 写 succeeded / failed
```

如果进程在副作用发生后崩溃，但没有 receipt，系统不会直接重跑，而是把状态标记为 `unknown`，要求用户选择 inspect、retry 或 skip。

#### 4. 依赖任务严格受 Task Graph 控制

- 无依赖任务可以并行；
- 独立任务失败不会阻塞其他分支；
- 依赖失败会进入 blocked；
- 任务图循环会在入队前拒绝；
- retry 创建新 attempt，不复用旧 attempt 的副作用标识。

#### 5. 目标漂移通过版本和审批控制

Brief、Architecture、TaskGraph 和 Orchestration 都有版本和审批状态。已经开始执行的 Run 不应该读取后来被静默修改的计划。

当前限制也必须说清楚：

> 当前已经实现了项目、任务图、版本、事件流和 lease 的一致性检查，但“工作流内容 + 输入 + policy + plugin + 完整计划”的统一内容哈希和事件独立重建还没有完全闭环。

---

## 5. 记忆管理与超大项目上下文

### 5.1 我的初始提问

> 你是如何实行记忆管理的？对于巨量的项目文件和文档，你如何保证workers不会超出上下文限制？

### 5.2 专业化面试提问

> SlimeMold 如何区分短期上下文、项目记忆、运行经验和长期知识？面对大型代码仓库或大量文档，如何进行上下文选择、压缩和预算控制？

### 5.3 回答

当前设计把记忆分成几层。

#### 第一层：项目事实，不放进普通记忆

这些内容由结构化对象保存：

- Decision；
- Brief；
- Architecture；
- TaskGraph；
- Issue；
- Run；
- Evidence。

它们有 ID、版本和来源，不依赖模型记忆。

#### 第二层：项目级长期记忆

审查 Agent 可以从运行轨迹中提炼记忆，落盘到：

```text
.slimemold/memory.md
```

技能类经验会落到：

```text
.slimemold/skills/
```

`selfImprove` 默认关闭，避免 Agent 在没有用户确认的情况下产生额外调用费用或自动修改记忆。

#### 第三层：运行经验

系统可以按节点类型和项目维度匹配历史运行经验，例如某类节点过去的失败原因、优化建议和成功模式，再以精简形式注入当前提示词。

#### 第四层：当前任务上下文

Worker 只应该拿到：

- 当前任务；
- 任务依赖；
- 相关文件；
- 相关决策；
- 验收标准；
- 必要的上游产物。

而不是整个项目的全部聊天记录和所有文档。

当前 `AgentHarness` 已经具备：

- 历史消息 Token 估算；
- 超预算裁剪；
- 最大工具调用轮次；
- 作用域变量；
- 工具上下文隔离。

但这里必须诚实说明不足：

> 当前版本的上下文裁剪主要针对聊天历史和运行上下文，还没有完成成熟的“大型代码库 Context Pack 编译器”。

面对巨量项目文件，最终需要继续补齐：

1. 文件和符号索引；
2. 按 Task scope 的相关文件检索；
3. 文档分块、摘要和引用；
4. 结构化 Artifact 的优先级；
5. 强制 Token budget；
6. 超预算时保留摘要和文件引用，而不是盲目截断；
7. Worker 只能访问与任务相关的路径。

因此，当前能做到的是“避免把全部聊天和变量灌给 Worker”，但还不能声称已经完整解决百万行仓库的上下文管理问题。

---

## 6. 大项目长任务的路线一致性

### 6.1 我的初始提问

> 对于大项目长任务，你如何保证路线的一致性？

### 6.2 专业化面试提问

> 当项目规模扩大、任务持续时间变长、多个 Agent 并行工作时，如何保证各个 Worker 仍然沿着同一条产品和技术路线执行，而不是各自优化、互相冲突？

### 6.3 回答

路线一致性不应该靠每个 Agent 都“记住最初的 Prompt”，而应该靠不可变的计划和版本关系。

当前路线链条是：

```text
Project Session
→ Decision
→ Brief
→ Architecture
→ TaskGraph
→ Orchestration
→ Workflow / Worker Run
```

每一层都有：

- 稳定 ID；
- 版本；
- 来源；
- 审批状态；
- 关联关系；
- 任务依赖；
- 影响范围；
- 验收标准。

对于执行层，Run 至少要绑定：

```text
projectId
taskGraphId
taskGraphVersion
orchestrationId
policy snapshot
base revision
```

Agent 路由也不是任意选择：

- 用户显式绑定优先；
- 类别路由其次；
- fallback 链再次；
- 项目默认和全局默认最后；
- 路由结果带有 reason、candidate chain 和评分明细。

大项目中如果路线发生变化，不应该直接修改正在执行的 TaskGraph，而应该：

```text
旧计划 revision 1
→ 新决策 / 新架构
→ 新 TaskGraph revision 2
→ 新 Orchestration 或新的 Run
```

这样旧 Run 仍然可以审计，新 Run 使用新路线。

当前代码已经具备 TaskGraph version、ProjectFile/event consistency 和执行前审计；但完整的 `graphHash + policyHash + pluginHash + inputHash` 绑定还需要继续完成。这是长期路线一致性最终需要的安全封套。

---

## 7. Codex 订阅额度与额度恢复

### 7.1 我的初始提问

> 当你使用codex订阅服务作为worker节点，那么你如何解决额度超限的问题？项目在额度重置之后的行为是？

### 7.2 专业化面试提问

> 当 Codex Worker 使用 ChatGPT 订阅而非 API 计费时，系统如何识别额度不足、避免无限重试，并在额度恢复后安全继续未完成任务？

### 7.3 回答

首先要明确一个事实：

> SlimeMold 无法假装知道 ChatGPT 订阅还剩多少额度，也不能自行控制额度重置时间。订阅额度是外部 Codex 服务的状态。

当前实现已经做了几件事：

- 通过官方 Codex CLI，而不是自己实现 API；
- 只检查 Codex 登录状态；
- 强制 Worker 在已登记的独立 worktree 中执行；
- 清除父进程中的 API key/access token 环境变量；
- 使用 `workspace-write` 和受控批准模式；
- 捕获 Codex CLI 的退出码、错误信息和 usage；
- Codex Worker 不会因为模型说“完成”就被判定成功。

如果 Codex 因额度耗尽退出，当前系统的安全行为应该是：

```text
Codex failure
→ Worker task failed
→ Run partial / failed
→ 持久化错误
→ 用户进入 recovery
```

如果已经创建了 side-effect lease，但没有 receipt，则会进入 `unknown`，不会自动无限重跑。

当前还没有实现完整的 `quota-exhausted` 状态、精确的 `resumeAt` 和自动延迟调度。因此额度重置之后，当前产品的行为是：

1. 原 Run 保持 failed、partial 或 recovery 状态；
2. 不会因为系统猜测额度已恢复而自动执行；
3. 用户明确选择 retry；
4. retry 创建新的 attempt 和新的 worktree；
5. 原 attempt 保留，便于审计；
6. 已成功任务不会重复执行。

后续更完整的实现应该是：

```text
quota-exhausted
→ paused
→ 等待明确的恢复时间或用户确认
→ 重新打开项目
→ 只恢复未完成任务
→ 新 attempt 执行
```

如果项目允许 fallback，也必须由执行策略明确允许，例如切换到 Ollama 或 API Provider，不能偷偷把 Codex 任务换成另一个模型，因为这可能改变质量、权限和成本语义。

另外，`subscription=true` 被标记为零 Token 成本，只代表会计模型中没有按 Token 价格计算，**不代表无限额度**。

---

## 8. 架构、数据流、耦合度与内聚度

### 8.1 我的初始提问

> 项目的架构如何？数据是怎么流动的？模块间与模块内的耦合度和内聚度如何？代码结构是否清晰？

### 8.2 专业化面试提问

> SlimeMold 当前采用什么分层架构？核心数据如何从用户输入流向 Worker 和 Evidence？模块之间的耦合与内聚情况如何？当前架构债务是什么？

### 8.3 回答

当前架构大致分成六层。

#### 1. Presentation Layer

主要包括：

- `App.tsx`；
- `BeginnerExperience`；
- `ProjectSessionPanel`；
- `IssueBoard`；
- `OrchestratorPanel`；
- `SettingsCenter`；
- `MasterAgentPage`。

这一层负责展示状态和触发用户动作，不应该直接实现 Worker、锁和事件写入逻辑。

#### 2. Project Control Layer

主要包括：

- `projectControl/commands.ts`；
- `state.ts`；
- `session.ts`；
- `taskGraph.ts`；
- `eventBuffer.ts`；
- `projectControlConsistency.ts`；
- `workerRunConsistency.ts`；
- `workerRunRuntime.ts`；
- `workerRunCoordinator.ts`。

这一层负责把用户动作转成领域命令、结构化对象和 DomainEvent。

#### 3. Domain Layer

主要包括：

- `domain/contracts.ts`；
- `domain/eventStore.ts`；
- `domain/workerQueue.ts`；
- `domain/sideEffects.ts`。

这一层尽量保持纯逻辑和可测试，负责：

- 事件追加和 replay；
- Run/Task 状态迁移；
- 依赖调度；
- receipt；
- 幂等；
- 状态校验。

#### 4. Execution Layer

目前有两条并行路径：

- 旧的 `engine/` 和 `orchestrator/` 执行链；
- 新的 Worker 执行链。

新的 Worker 链路是：

```text
WorkerRunRuntime
→ WorkerRunCoordinator
→ WorkerAllocator
→ WorktreeManager
→ CodexWorkerExecutor
→ Host Acceptance
→ Evidence / Receipt
→ ProjectFile + DomainEvent
```

#### 5. Infrastructure Adapter Layer

包括：

- `projectIO`；
- `tauriEventStore`；
- `platform/env`；
- LLM providers；
- `src-tauri/src/codex.rs`；
- `src-tauri/src/event_store.rs`。

这一层把文件系统、Tauri command、锁、Codex CLI 和模型协议隔离开，业务逻辑通过接口使用，而不是直接依赖 Rust 或具体 Provider。

#### 6. Plugin Layer

插件可以扩展节点，但当前插件是在主 WebView 中运行的可信本地代码，并不是强隔离进程。这个边界已经在产品文档中明确。

### 8.4 数据流

完整数据流可以概括为：

```text
用户目标
→ ProjectSession
→ Project Brief / Architecture / Decision
→ TaskGraph
→ Execution Draft
→ 用户确认
→ Worker Run
→ Event Buffer
→ JSONL Event Stream + Project Snapshot
→ Runtime Replay
→ Worktree
→ Codex Worker
→ Host Acceptance
→ Evidence / Receipt
→ Run 状态
→ UI Projection
```

### 8.5 内聚度

目前内聚度较好的部分是：

- `workerQueue`：聚焦 Run/Task 状态和依赖调度；
- `eventStore`：聚焦事件持久化、锁和 replay；
- `agentRouter`：聚焦 Agent 选择；
- `agentEconomics`：聚焦成本估算；
- `workerAcceptance`：聚焦宿主验收；
- `workerCleanup`：聚焦清理审批和 receipt。

这些模块大多可以脱离 React 单独测试，依赖通过接口和依赖注入传入。

### 8.6 当前耦合债务

最大的架构债务有三点：

1. `App.tsx` 仍然是较重的 composition root，负责连接项目生命周期、审计、runtime、coordinator、Evidence 和 cleanup；
2. 新的 ProjectControl/event source 与旧 `workflowStore`、旧 executor 仍然部分并行；
3. 当前事件 payload 有些只保存摘要，所以还不能完全依赖事件流重建所有 ProjectControl 私有对象。

因此，对当前架构的评价是：

> 分层方向已经清晰，领域模块的内聚度和可测试性不错；但执行链路仍处于旧系统向事件驱动 Worker 系统迁移的中间阶段，暂时不能说已经完成最终架构收敛。

---

## 9. 共同形成的产品判断

### 9.1 当前 SlimeMold 已经是什么

它已经不只是一个空白画布式的节点编辑器，而是具备以下能力基础的本地 Agent 工作站：

- 可视化 DAG 工作流编辑与执行；
- 多协议 Agent 配置；
- 项目级主控会话；
- Brief、Architecture、TaskGraph 和 Orchestration；
- 用户确认门；
- Worker Run 持久化；
- 独立 worktree；
- Codex Worker 接线；
- 宿主 acceptance 和 Evidence 模型；
- durable event stream、snapshot、replay 和一致性审计；
- retry/skip/inspect 恢复模型；
- cleanup proposal、approval、receipt 和 `TaskCleaned`。

### 9.2 当前还不能承诺什么

以下能力仍不能包装成已经完成：

- 多任务、多 Provider 和完整交付路径的 Tauri UI E2E；
- 只依靠事件流重建全部 ProjectControl 私有对象；
- 项目级硬预算和 Codex quota-aware 调度；
- 百万行代码仓库的智能 Context Pack；
- 全量 `graphHash + policyHash + pluginHash + inputHash` 的执行封套；
- 旧 executor 到新 Worker event source 的完全切换；
- 插件的进程级强隔离。

### 9.3 下一阶段优先级

按照风险和产品价值，下一阶段应优先完成：

1. Evidence → 用户查看 diff → 用户批准交付/合并 → 交付 receipt → Issue/项目事实更新；
2. 面向普通用户的失败、等待和 recovery UX，明确“已经发生什么”和“下一步可逆动作”；
3. Context Pack 编译器和大型项目的文件/符号检索；
4. capability registry、capability gap 和类型化 Artifact acceptance；
5. quota/rate-limit/暂停恢复状态与项目级 execution lease；
6. Run 的完整输入、策略、插件、Provider/tool schema 和计划 hash；
7. ProjectControl event source 的更完整重建、旧执行链路 cutover 和双写收敛。

最终产品承诺应该保持克制：

> SlimeMold 不承诺“Agent 自动完成一切”，而是承诺让 Agent 在一个经过用户确认、可观察、可验收、可恢复的项目系统中工作。

---

## 10. 当前验证基线

截至 2026-09-02：

- `npm run test`：95 个测试文件、776 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过。

构建仍有既有的动态/静态 import 和大 chunk warning，无新增构建失败。

真实 Tauri 隔离 smoke 已证明：

- Tauri 窗口可以加载隔离项目；
- “确认执行计划”可以进入 queued Run；
- durable event stream 和 ProjectFile 会记录 Run/Task 状态；
- Worker 可以创建独立 worktree；
- side-effect journal 的第二把宿主锁问题已经被真实 smoke 发现并修复；
- acceptance 失败时 Evidence 保留且 worktree 不被静默清理；
- recovery-required 下 skip 不产生新 attempt，retry 会创建新的 attempt、worktree 和副作用 key。

真实成功路径和 failure/recovery 路径均已完成单任务隔离 fixture 验证；当前仍不把它包装成多任务、多 Provider、通用 Artifact acceptance 或自动交付已经完成。

---

## 11. 超出预设范围的 Agent / 模型路由

### 11.1 我的初始提问

> 对于模型或智能体路由，如果用户需要比我们预设的更边界的需求，例如我们只设立了ui->gemini的映射，而用户的真实需求有制作unity模型，为此需要选择一个擅长3d建模的模型，项目该怎么实现？

### 11.2 专业化面试提问

> 当用户需求超出系统预设的 `category → model` 映射时，例如项目从 UI 开发扩展到 Unity 3D 建模，系统如何发现所需能力、选择合适的 Agent/模型，并允许用户安全地扩展路由能力？

### 11.3 回答

不能把路由设计成一张不断膨胀的静态映射表：

```text
ui → Gemini
logic → Claude
docs → GPT
```

因为真实任务往往不是单一类别，而是多个能力的组合。比如“在 Unity 中制作一个可导出的低模角色”至少包含：

```text
domain: 3d-modeling
engine: unity
artifact: fbx / glb / unity scene
capability: mesh / material / rig / export
environment: Unity version / OS / GPU
quality: prototype / production
```

更合理的路由模型是**能力声明 + 需求约束 + 候选评分**。

#### 1. Agent / Model 声明能力

每个 Agent 不只声明名称和模型，还应该声明：

- 擅长领域：`ui`、`logic`、`3d-modeling`、`unity` 等；
- 可处理的 Artifact 类型：代码、图片、FBX、GLB、Unity Scene 等；
- 支持的工具：Blender、Unity Editor、脚本执行、图像生成等；
- 支持的平台和环境；
- 权限等级；
- 成本、延迟和质量档位；
- 可接受的输入和输出格式。

#### 2. Planner 从用户目标提取能力需求

主控 Agent 先把用户目标转换为结构化 capability requirement，而不是直接拿 `ui` 这个粗粒度类别选模型。

例如：

```json
{
  "requiredCapabilities": ["3d-modeling", "unity", "mesh-export"],
  "requiredArtifacts": ["fbx", "unity-scene"],
  "environment": { "engine": "Unity" },
  "qualityTier": "standard"
}
```

#### 3. 路由优先级

建议的决策顺序是：

```text
用户对当前任务的显式 Agent 覆盖
→ 满足 required capabilities 的候选集
→ 项目级能力路由
→ 全局默认能力路由
→ 成本 / 成功率 / 质量 / 延迟评分
→ fallback chain
```

如果没有候选满足硬性能力要求，系统不应该把一个普通 UI Agent 静默当成 3D Agent 使用，而应该进入：

```text
capability gap
→ 告知用户缺少什么能力
→ 提议安装插件、注册新 Agent 或配置新 Provider
→ 用户确认后更新项目能力目录
```

对于 Unity 任务，用户可以注册一个带有 `unity`、`3d-modeling`、`mesh-export` 能力的 Agent，或者安装一个提供 Unity/Blender 工具的可信插件。路由器以后按能力匹配，而不是要求开发者预先穷举所有类别。

当前代码已经支持：

- 任务级显式 `agentId`；
- 任意字符串 category；
- 项目级 route table；
- fallback chain；
- 成本、历史成功率和任务复杂度评分。

但当前还没有完整的 capability registry、能力声明协议和自动 capability-gap UX。因此，现阶段可以通过新增 category 或显式 Agent 覆盖实现边界需求，但还不能说已经完成了通用能力发现和动态路由。

---

## 12. 致命错误下的数据保全与恢复

### 12.1 我的初始提问

> 当整个应用出现致命且不可恢复的错误，我们应如何尽最大努力保全用户的数据？我们应如何协助用户恢复？

### 12.2 专业化面试提问

> 当应用发生致命崩溃、数据格式损坏或无法自动修复的错误时，系统如何最大限度保全用户数据，并为用户提供安全、可解释、可回滚的恢复路径？

### 12.3 回答

核心原则是：

> 恢复系统不能以“修复成功”为第一目标，而应该以“先保留现场，再尝试修复”为第一目标。

我会把数据保护分成四层。

#### 第一层：原始事实永不静默覆盖

事件流采用 append-only 语义，解析到损坏行时保留：

- 已经成功解析的前缀；
- 损坏行的原文；
- 损坏行之后的 tail；
- 错误原因和行号。

系统不能因为遇到坏数据就把事件流当成空文件，也不能直接丢弃损坏 suffix。

#### 第二层：写入使用临时文件和原子替换

重要 JSON、事件流、snapshot 和 checkpoint 应采用：

```text
write temporary file
→ flush / close
→ validate format
→ atomic rename
```

替换失败时保留临时文件，让下一次启动或人工恢复继续使用完整副本，而不是退化成可能被截断的直接覆盖写。

#### 第三层：保留多个恢复点

最终产品还需要保留：

- 最近几个有效 Project snapshot；
- 最近几个 Run checkpoint；
- event stream 的只读副本或分段归档；
- 最近一次成功的 project manifest；
- Evidence 和 receipt 的独立副本。

恢复时应该让用户看到可用恢复点、时间、sequence、涉及的 Run 和风险，而不是直接覆盖当前目录。

#### 第四层：安全模式和导出现场

当自动恢复失败时，应用应该进入只读安全模式，允许用户：

1. 导出完整的 `.slimemold` 目录和错误诊断；
2. 导出脱敏后的 event tail、snapshot 和 manifest；
3. 选择某个已验证 snapshot 作为恢复起点；
4. 只重建 projection，不修改原始事实；
5. 将无法判定的 Run 标记为 recovery-required；
6. 在确认后生成一个新的恢复分支或副本。

当前已经具备的保护包括：事件 checksum、sequence、原子事件写入、snapshot hash、宿主锁、损坏流 `needs-repair` 和执行前 fail-closed 审计。

当前仍缺少：

- 完整的多版本 backup/rotation；
- project.json、agents.json、workflow 和 event stream 的统一提交清单；
- 面向用户的只读安全模式；
- 一键诊断导出和交互式恢复向导。

所以当前可以做到“损坏时不静默覆盖、不继续执行”，但还没有完成企业级灾难恢复产品体验。

---

## 13. 电脑断电、重启和外部中断

### 13.1 我的初始提问

> 电脑断电重启问题，当整个工作流因为外部中断，数据保全与恢复的行为逻辑是什么？

### 13.2 专业化面试提问

> 当电脑断电、操作系统重启或应用进程被强制终止时，如何判断工作流中断发生在哪个阶段？哪些状态可以自动恢复，哪些状态必须进入人工核对？

### 13.3 回答

断电恢复不能只看“进程上次是否正常退出”，而要根据最后一个持久化事实和副作用 receipt 判断。

不同中断位置的处理逻辑如下：

| 中断位置 | 重启后的处理 |
|---|---|
| Run 尚未入队 | 不产生执行事实，保留用户未确认的草案 |
| Run 已 queued、没有 lease | 一致性检查通过后可以恢复为可执行队列 |
| worktree 已创建但 running lease 未落盘 | 重新扫描 worktree，登记为孤立资源，不能直接继续执行 |
| running lease 已落盘、Worker 尚未完成 | 进入 unfinished lease / recovery-required |
| side effect 已 started、没有 receipt | 标记为 `unknown`，不能自动 retry |
| Worker 已返回但 acceptance 未完成 | 保留 worktree 和 attempt，重新检查实际 diff 与测试 |
| acceptance 已通过但成功事件尚未完成 | 以事件流和 Evidence 重新核对，不凭 UI 状态判断 |
| TaskSucceeded 已持久化 | 保留成功任务，不重复执行 |
| cleanup started、没有 cleanup receipt | 标记为未知清理状态，必须 inspect |

重启后的标准流程应该是：

```text
启动应用
→ 读取 event stream
→ 校验 checksum / sequence
→ 校验 snapshot hash
→ replay 或加载有效 snapshot
→ 读取 ProjectFile / Run registry
→ 执行 project / run / lease / side-effect consistency audit
→ 安装安全的 executable queue 或 recovery records
→ 只对明确可恢复的 queued task 提供执行入口
```

当前实现已经覆盖了其中的主要安全边界：

- event stream 损坏时保持 `needs-repair`；
- snapshot 不匹配时重新 replay；
- running lease 不会直接恢复为正常可执行状态；
- side-effect 没有 receipt 时进入人工决策；
- retry 使用新 attempt，不复用旧副作用 key；
- 依赖任务按事实状态重新归约为 queued 或 blocked。

当前仍需要继续加强的是跨文件提交一致性。因为 ProjectFile、event stream、Evidence 和 checkpoint 不是一个物理事务，断电可能造成“事实已落盘但 projection 还没更新”或反过来的情况。现有一致性审计可以阻止静默继续，但最终还需要 manifest、commit marker 或更完整的 WAL/双阶段提交协议。

因此，断电后的产品原则是：

> 能证明安全的自动恢复；无法证明安全的人工核对；绝不根据最后一帧 UI 或模型自报状态自动重跑。

---

## 14. Fallback 模型切换时是否保留已落地进度

### 14.1 我的初始提问

> 你认为当一个模型变得不可用，切换到fallback模型的时候，为了保证损失最小化，当前的任务已落地的进度是否应当保留？

### 14.2 专业化面试提问

> 当当前模型不可用并需要切换到 fallback Agent/模型时，系统应如何保留已完成进度、识别未确认的部分，并避免重复执行或覆盖有效结果？

### 14.3 回答

应该保留，但必须区分：

```text
已由宿主验证的进度
≠
模型声称已经完成的进度
```

我会按三个粒度处理。

#### 1. 已完成的 Task

已经满足 acceptance、拥有有效 Evidence 和 acceptance ID 的 Task 应保持 `succeeded`，不能因为上游模型不可用就重新执行。

#### 2. 已持久化的 Artifact / Checkpoint

已经写入事实源、通过格式校验并带有版本的 Artifact 或 checkpoint 应保留。Fallback Agent 只需要消费这些已确认产物，不需要从零开始。

#### 3. 当前未完成的 Attempt

当前 attempt 如果只有模型文本，没有宿主验证，就不能被当作可靠进度。需要根据 worktree、diff、测试和 receipt 判断：

- 没有副作用：可以基于同一输入重新尝试；
- 有可验证的局部修改：可以把它作为待审查中间产物；
- 有修改但状态不明确：保留现场，进入 inspect；
- 可能发生外部副作用但没有 receipt：标记 unknown，禁止自动重跑。

对于普通只读 LLM 调用，当前 `runLlmWithFallback` 可以按照候选链尝试其他 Agent，并保留成本和失败记录。对于代码 Worker，不能简单地让 fallback 模型接着同一个可能已经被修改的 worktree 继续写，因为这可能把两个模型的假设混在一起。

更安全的代码 Worker 策略是：

```text
保留旧 attempt
→ 采集 diff / 测试 / Evidence
→ 生成新的 attempt
→ 新 worktree 或经过校验的恢复 worktree
→ 把已验证产物作为输入
→ fallback Worker 继续任务
```

当前 Worker queue 已经会保留旧 attempt，retry 会生成新的 attempt、worktree 和副作用 key，成功的任务也不会重复执行。这能降低损失，但当前还没有把“同一任务的部分可验证修改自动整理成 fallback 的结构化 checkpoint”完全实现。

因此我的结论是：

> 已验证的进度必须保留；未验证的模型输出只能作为候选材料，不能当作事实；fallback 的最小化损失策略应以 checkpoint、diff、test 和 receipt 为依据，而不是以聊天文本为依据。

---

## 15. 连接各层 Agent、模块和层级的唯一事实

### 15.1 我的初始提问

> 你认为链接各层agents、各模块、各层级的唯一事实是什么？

### 15.2 专业化面试提问

> 在跨 Agent、模块以及控制面、计划面、执行面和反馈面协作的系统中，唯一事实源和关联主键是什么？如何避免聊天记录、ProjectFile、UI projection 和模型输出之间出现多个互相冲突的真相？

### 15.3 回答

如果必须选一个跨层的唯一事实源，我的答案是：

> **以 `projectId` 为边界的、带稳定 ID 和版本的 durable DomainEvent stream。**

每个重要事件至少通过以下字段连接不同层级：

```text
streamId / projectId
eventId
sequence
aggregateType
aggregateId
aggregateVersion
source.objectId
source.objectVersion
correlationId
causationId
```

它连接的不是 Agent 的名字，而是稳定的领域对象：

```text
Project
Session
Decision
Brief
Architecture
Issue
TaskGraph
Task
Orchestration
Run
Evidence
Receipt
```

其中需要区分三种权威：

### 1. 状态迁移的权威

是 Project-scoped DomainEvent stream。

它回答：

- 发生过什么状态迁移；
- 谁在什么时候触发；
- 事件顺序是什么；
- 哪个对象版本产生了该事件。

### 2. 执行验收的权威

是宿主生成的 Evidence 和 side-effect receipt。

模型文本只能表达意图或报告，不能取代宿主观测。只有宿主实际运行的测试、diff、路径策略和 receipt 才能证明执行结果。

### 3. 代码状态的权威

是登记过的 Git worktree、branch、base revision 和实际文件树。UI 中的“正在修改”不是代码事实，模型的“已完成”也不是代码事实。

因此，ProjectFile、projection snapshot、Zustand store、UI 状态和聊天记录都属于 projection、缓存或上下文来源：

```text
DomainEvent stream
→ replay
→ ProjectFile / runtime registry / UI projection
```

它们可以帮助用户操作，但不能在发生冲突时悄悄覆盖事件事实。

当前代码已经对 Worker Run 做 event stream ↔ ProjectFile consistency audit，对 ProjectControl 做对象 ID、project scope、版本、审批、关联关系和 sequence audit。当前的限制是：部分 ProjectControl 事件只保存摘要，因此还不能只凭事件流重建所有私有对象内容；后续需要补齐事件 payload、Artifact 引用或独立实体事实。

最终可以用一句话概括：

> 用稳定 ID 连接对象，用 DomainEvent 记录状态迁移，用宿主 Evidence 证明执行结果，用 Git revision 证明代码状态；任何 Agent 的自然语言输出都不是最终事实。

## Sources

[38] https://docs.dify.ai/en/cloud/use-dify/nodes/agent — Dify Agent documentation

[39] https://n8n.io — n8n official product page

[40] https://github.com/coze-dev/coze-studio — Coze Studio official repository
