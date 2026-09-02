---
title: 我们共同对 SlimeMold 的全局审视：产品本质、系统风险与未来方向
date: 2026-09-01
status: strategic-review
---

# 我们共同对 SlimeMold 的全局审视：产品本质、系统风险与未来方向

> 这是一份战略和架构审视稿，不是代码使用说明，也不是面试问答稿。
> 它不试图证明当前实现已经正确，而是与用户共同追问：SlimeMold 是否解决了正确的问题；现有架构假设在哪里可能失效；如果继续发展，它应该成为怎样的产品。

## 0. 讨论方法

这份文档有意不采用“面试官提问—候选人回答”的防守式结构。每个议题都按以下顺序审视：

```text
问题本质
→ 当前假设
→ 结构性矛盾
→ 可能失败模式
→ 可选方向
→ 推荐判断
→ 需要验证的事实
```

代码、测试和当前运行结果只作为证据，不作为最终结论。一个功能“已经写出来”，不等于产品选择正确；一个测试“通过”，也不等于长期用户体验已经成立。

本审视稿之上的规范性原则见 [`SLIMEMOLD_PRODUCT_PHILOSOPHY.md`](SLIMEMOLD_PRODUCT_PHILOSOPHY.md)。该文档定义用户、Agent、项目事实和可视化投影之间的权威关系；本文负责将这些原则放入产品定位、系统风险和发展路线中讨论。

---

## 1. SlimeMold 真正应该解决什么问题

### 1.1 产品的核心问题不是“如何让 Agent 更聪明”

SlimeMold 最有价值的问题，不是再做一个能调用模型的聊天框，也不是再做一个拥有更多节点的自动化画布。

真正的问题是：

> 当 Agent 要参与一个持续数小时、数天甚至数周的软件项目时，如何让它在明确的目标、有限的权限、稳定的路线和可验证的结果约束下持续工作？

这意味着产品的基本单位不应该是“一次 LLM 请求”，而应该是：

```text
一个有目标、有边界、有依赖、有版本、有验收标准、可以暂停和恢复的项目任务。
```

### 1.2 产品承诺应该保持克制

不应该承诺：

> 输入一句话，系统无需确认就自动完成任意复杂的软件。

更可信的承诺是：

> 用户用自然语言启动一个项目，系统将目标收敛成可确认的计划，再让 Agent 在可观察、可验收、可恢复的边界内执行。

这个承诺把“智能”从模型回答质量，转移到系统能否稳定组织不确定性。

### 1.3 产品应该形成的闭环

```text
Intent
→ Project Control
→ Plan / Decision
→ Execution
→ Evidence
→ Recovery / Delivery
→ New Project Facts
```

如果某个功能不能让这个闭环更可靠、更清晰或更低成本，就应该谨慎判断它是否值得加入产品。

---

## 2. UI 的全局判断：不是最终版，但方向已经改变

### 2.1 从“空白画布”转向“项目驾驶舱”

传统节点式工具的入口是空画布，用户必须先理解节点、端口、连线和执行顺序。

对于长期软件项目，这个入口顺序是反的。用户真正的认知顺序应该是：

```text
我想做什么？
→ 系统理解了什么？
→ 还有什么需要我决定？
→ 系统准备怎么做？
→ 现在做到哪一步？
→ 如果失败，我下一步怎么办？
```

因此，SlimeMold 应该让项目驾驶舱成为默认入口，把 DAG、Agent、Provider、worktree 和 schema 放到需要时才出现的专业层。

### 2.2 三种界面应该是同一状态的三种投影

```text
简单驾驶舱：目标、决定、下一步、结果
Issue 工作台：变化、风险、待办、阻塞
专业 DAG：执行细节、Worker、Evidence、调试
```

它们不能各自维护一套项目状态。否则用户会遇到最危险的一类问题：简单页面说“已完成”，专业页面却显示“任务还在运行”，或者一个页面的修改在另一个页面消失。

### 2.3 当前 UI 的真实成熟度

当前 UI 已具备以下方向：

- 项目级主控会话；
- Brief、Architecture、TaskGraph 和 Orchestration 的结构化阶段；
- 用户确认门；
- 简单驾驶舱和专业 Orchestrator 视图；
- Worker Run、失败、阻塞、Evidence 和 recovery 的投影。

但它还不是最终产品，原因不是缺少几个视觉细节，而是关键交互闭环还需要证明：

1. 用户是否能在不理解内部术语的情况下完成一次项目执行；
2. 用户是否能在失败后理解原因，而不是被迫打开 JSON 或日志；
3. 用户是否能在重启、断电和额度不足后知道下一步；
4. 简单视图和专业视图是否始终讲述同一个事实；
5. “确认一次后自动执行”是否真的减少了用户负担，而不是把复杂性藏到不可见的异步状态里。

因此，UI 的评价不是“是否好看”，而是：

> 它是否让用户始终知道当前事实、当前风险和下一个可逆动作。

---

## 3. SlimeMold 应该占据什么产品位置

### 3.1 不应该和 Dify、n8n、Coze 竞争所有能力

Dify 的核心优势是 LLM 应用、Agent、RAG 和工作流构建；其 Agent 节点允许模型在工作流中使用工具，并配置迭代次数和记忆窗口。[38]

n8n 更接近企业业务自动化和系统集成平台，强调连接外部服务、代码节点、AI workflow、人工审批和执行观察。[39]

Coze Studio 的官方定位是一站式 Agent 开发工具，覆盖 Prompt、RAG、Plugin、Workflow、调试和部署。[40]

这些产品的共同特点是：

```text
让用户更快构建一个 Agent、一个 AI 应用或一条自动化流程。
```

SlimeMold 不应该把自己的战略目标定义成“做一个功能更少的 Dify”或“做一个集成更少的 n8n”。

### 3.2 SlimeMold 的潜在空位

SlimeMold 可以占据的空位是：

```text
长期软件项目中的 Agent 控制面与执行面。
```

它关注：

- 项目目标是否被澄清；
- 架构和范围是否经过确认；
- 任务依赖是否明确；
- Worker 是否在隔离环境中修改代码；
- 测试和 diff 是否由宿主真实验证；
- 失败是否可以解释和恢复；
- 项目是否可以在重启后继续；
- 结果是否能回到项目事实和后续决策。

### 3.3 用户为什么选择 SlimeMold

不是因为它拥有最多节点，而是因为它解决了另外一类风险：

> Agent 不只是生成内容，而是在真实项目中产生代码、状态和副作用；这些变化需要被组织、验证、暂停、恢复和追责。

用户应该可以根据场景做出诚实选择：

- 做知识库问答和 AI 应用：Dify 或 Coze 可能更合适；
- 做业务系统集成和自动化：n8n 可能更合适；
- 做本地、长期、需要真实代码修改和可恢复执行的软件项目：SlimeMold 才有明确价值。

### 3.4 竞品调研后的定位校正

补充调研显示，Dify、n8n、Coze、LangChain 和 LangGraph 不应被当作同一层面的直接替代品。更有解释力的比较方式不是节点数量，而是两个维度：运行时控制权在平台还是用户，以及任务是一次性确定性自动化还是长期开放式软件项目执行。完整的证据边界、竞品分层和指标建议见 [`docs/reference/AI_AGENT_ORCHESTRATION_LIMITATIONS_RESEARCH.md`](reference/AI_AGENT_ORCHESTRATION_LIMITATIONS_RESEARCH.md)。

由此，SlimeMold 的差异化需要进一步收窄为：

> 不是提供更多 Agent 或更自由的 DAG，而是让 Agent 在真实软件项目中按批准计划工作，并把修改变成可验收、可恢复、可追责的项目事实。

这也意味着，第三方 Runtime 可以作为局部执行能力接入，但不能取代 SlimeMold 的项目事件流、审批、策略、Evidence、Receipt 和交付边界。DAG 是专业执行投影，不是普通用户的默认入口；连接器、模板和 Agent 数量不应成为近期核心竞争指标。

---

## 4. Agent 组织：从“多 Agent 对话”转向“受约束的协作网络”

### 4.1 多 Agent 不等于群聊

让多个 Agent 互相转发完整上下文，通常会带来三个问题：

- Token 成本线性甚至超线性增长；
- 每个 Agent 都重新解释同一份信息；
- 责任边界模糊，最后无法判断谁的结论是事实。

SlimeMold 更适合采用稀疏协作：

```text
主控负责目标和决策
→ 规划层负责拆解
→ Worker 负责局部任务
→ 验收层负责证据
→ 反馈层负责恢复和更新项目事实
```

Agent 之间通过 Task、Artifact、Decision、Evidence 和 Receipt 通信，而不是默认共享全部聊天记录。

### 4.2 通信契约应包含什么

每个任务至少需要明确：

- 输入事实和来源；
- 目标；
- 非目标；
- 影响范围；
- 依赖；
- 可用工具和权限；
- 输出格式；
- 验收标准；
- 失败后的处理方式。

Worker 不应该通过自由文本猜测项目路线，也不应该因为“上一个 Agent 说可以”就获得更高权限。

### 4.3 成本控制的正确顺序

成本控制不能只靠事后统计 Token，而应该从协作结构开始：

1. 不传递不必要的完整上下文；
2. 用结构化 Artifact 替代重复解释；
3. 对历史消息和工具循环设 Token/轮次上限；
4. 轻任务使用低成本或本地模型；
5. 复杂任务才升级到高能力模型；
6. 记录每次调用的用量、成功率、延迟和成本；
7. 达到项目预算后进入暂停，而不是继续尝试。

当前已有 AgentRouter、fallback chain、成本估算、成功率评分、Token budget 和工具轮次限制，但项目级硬预算熔断仍是未来需要补齐的能力。

---

## 5. 路由不应该是静态类别表，而应该是能力发现系统

### 5.1 为什么 `ui → Gemini` 不够

真实需求常常不是一个类别。比如“在 Unity 中制作一个可导出的低模角色”同时需要：

```text
3d-modeling
unity
mesh / material / rig
fbx / glb / scene export
Unity 版本和本机工具环境
prototype 或 production 质量等级
```

如果系统只有 `ui → Gemini`，它无法处理任务边界，只能把错误的模型硬套到任务上。

### 5.2 建议的能力路由模型

Agent/Model 应该声明能力，而不仅是名称：

- 擅长领域；
- 支持的引擎和工具；
- 可读写的 Artifact 类型；
- 支持的平台和环境；
- 权限等级；
- 质量、延迟和成本档位；
- 能否调用 Unity、Blender、脚本或图形工具。

Planner 再从用户目标中提取能力需求：

```json
{
  "requiredCapabilities": ["3d-modeling", "unity", "mesh-export"],
  "requiredArtifacts": ["fbx", "unity-scene"],
  "environment": { "engine": "Unity" },
  "qualityTier": "standard"
}
```

路由顺序应当是：

```text
当前 Task 的显式覆盖
→ 满足硬性能力的候选集
→ 项目级能力路由
→ 全局能力路由
→ 成本 / 成功率 / 质量 / 延迟评分
→ fallback chain
```

如果没有满足能力要求的候选，系统应该报告 capability gap，并提议：

- 注册一个新 Agent；
- 配置新的 Provider；
- 安装一个可信工具插件；
- 调整任务目标或验收标准。

不应该把普通 UI Agent 静默当成 3D Agent。

### 5.3 当前与未来的边界

当前已有显式 `agentId`、任意 category、项目 route table、fallback chain 和成本感知评分，可以通过配置扩展边界需求。

但完整的 capability registry、能力验证、工具环境检查和 capability-gap UX 还没有完成。这应当是未来比继续增加静态路由表更重要的方向。

---

## 6. 长期任务的稳定性：不是保证不失败，而是失败可控

### 6.1 长任务最危险的不是模型犯错

更危险的是系统无法判断：

- 当前状态到底是什么；
- 某个副作用是否已经发生；
- 某个结果是否经过验证；
- 当前计划是否已经改变；
- 重启后能否安全继续。

因此，长期稳定性首先是状态和事实问题，其次才是模型能力问题。

### 6.2 应该建立的稳定性不变量

```text
每次状态迁移都有事实记录
每个 Run 都绑定项目和计划版本
每个 Worker 都有独立 lease 和执行环境
每个外部副作用都有 receipt 或 unknown 状态
每个成功结果都有宿主 Evidence
无法证明安全时停止而不是猜测
```

当前 event stream、sequence、checksum、snapshot、宿主锁、Run/Task 状态、worktree、Evidence、receipt 和 recovery 模型已经覆盖了这套不变量的大部分基础。

### 6.3 跑偏控制

路线一致性不应靠模型记住最初 Prompt，而应靠：

```text
Decision
→ Brief
→ Architecture
→ TaskGraph
→ Orchestration
→ Run
```

每一层都带 ID、版本、来源、审批状态、依赖和验收标准。计划发生实质变化时，应产生新 revision 和新 Run，而不是静默修改正在执行的计划。

当前已经有 TaskGraph version 和执行前一致性审计，但完整的：

```text
graphHash + policyHash + pluginHash + inputHash
```

还需要继续补齐，才能更严格地证明长任务没有使用过期路线。

---

## 7. 记忆与巨量项目上下文

### 7.1 记忆不应该替代事实源

项目记忆至少应分为四层：

1. **项目事实**：Decision、Brief、Architecture、TaskGraph、Issue、Run、Evidence；
2. **项目长期记忆**：稳定的约束、偏好、历史原则；
3. **运行经验**：某类任务过去的失败原因和有效做法；
4. **当前上下文**：本次 Task 所需的文件、变量、依赖和输入。

第一层必须结构化，不能只写进 memory.md。记忆适合保存经验和原则，不适合保存唯一的业务事实。

### 7.2 当前已经具备的基础

当前已经有：

- `.slimemold/memory.md` 项目级记忆；
- `.slimemold/skills/` 技能沉淀；
- reviewer 轨迹复盘；
- 默认关闭的 self-improve 落盘开关；
- `shared / isolated` 上下文范围；
- Harness 历史裁剪和 Token budget；
- 按节点类型匹配历史经验。

### 7.3 真正需要的 Context Pack

面对大型代码库，Worker 不应该收到完整仓库，而应该收到一个由系统编译出的 Context Pack：

```text
任务目标
→ 相关架构决策
→ 相关 Issue / Task
→ 影响文件和符号
→ 必要文档片段
→ 依赖接口
→ 当前测试和验收规则
→ 允许访问路径
```

Context Pack 需要有硬 Token 预算，并且在超预算时按优先级缩减：

```text
验收标准 > 当前 Task 文件 > 直接依赖接口 > 相关决策 > 历史经验 > 远端背景资料
```

当前 Harness 的历史裁剪不能等价于完整的代码库 Context Pack。文件/符号索引、语义检索、文档分块和引用管理仍是重要的未来工作。

---

## 8. 致命错误、断电和灾难恢复

### 8.1 恢复的第一原则

> 先保留现场，再尝试修复；先导出数据，再尝试重建。

不能因为解析失败就把状态当成空项目，也不能因为 snapshot 损坏就覆盖原始 event stream。

### 8.2 数据保护层级

应当形成以下保护层：

1. append-only event stream；
2. checksum、sequence 和 aggregate version；
3. 临时文件 + 原子 rename；
4. 多版本 snapshot 和 checkpoint；
5. 事件流和 Evidence 的独立归档；
6. project manifest / commit marker；
7. 只读安全模式；
8. 脱敏诊断导出；
9. 在副本或新分支上恢复，不覆盖原现场。

当前已有事件 checksum、sequence、snapshot hash、原子写入、宿主锁、损坏流 `needs-repair` 和 fail-closed 审计。

当前仍缺少完整的 backup rotation、跨文件提交清单、安全模式和一键恢复向导。尤其是 ProjectFile、event stream、Evidence 和 checkpoint 目前不是一个物理事务，断电仍可能造成 projection 与事实源暂时不一致。

### 8.3 断电后的状态策略

```text
queued 且没有 lease
→ 一致性通过后可恢复

running 或 lease 未闭合
→ recovery-required

副作用 started 但没有 receipt
→ unknown，禁止自动重跑

TaskSucceeded 已持久化
→ 保留，不重复执行

cleanup started 但无 receipt
→ inspect，不假设清理成功
```

重启时应读取 event stream、验证 snapshot、replay、检查 lease 和副作用，再决定哪些任务可以进入 executable queue。

“最后一次 UI 显示运行中”不能作为恢复依据。

---

## 9. Fallback 时是否保留已落地进度

答案是：**保留已验证的进度，不信任未经验证的自报进度。**

需要区分：

```text
已通过宿主验收的 Task
已持久化的 Artifact / Checkpoint
有 diff 但未验收的中间状态
只有模型文本的自报结果
可能发生副作用但没有 receipt 的状态
```

已经有 Evidence 和 acceptance ID 的 Task 应保持成功，不因模型不可用而重跑。

未完成 Task 的 fallback 处理应是：

```text
保留旧 attempt
→ 读取实际 diff / 测试 / receipt
→ 判断可验证进度
→ 创建新 attempt
→ 新 Worker 消费已验证产物
```

对于普通只读 LLM 调用，可以沿候选链切换 Agent。对于会修改代码的 Worker，不能让另一个模型无条件接管原 worktree，因为两个模型的假设可能互相污染。

当前 Worker queue 已保留旧 attempt，并让 retry 使用新 attempt、worktree 和副作用 key；但“部分修改自动编译成可消费 checkpoint”还没有完成。

---

## 10. 唯一事实：不是一个模型输出，而是一组有权威边界的事实

如果必须选一个跨层状态事实源，应该是：

> **以 `projectId` 为边界的 durable DomainEvent stream。**

事件通过以下字段连接不同层级：

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

但需要区分三种权威：

### 状态迁移权威

DomainEvent stream 说明发生了什么状态迁移、顺序是什么、由谁触发、基于哪个对象版本。

### 执行验收权威

宿主 Evidence 和 side-effect receipt 说明测试、diff、策略检查和副作用是否真实发生。模型文本不能取代它们。

### 代码状态权威

登记过的 Git worktree、branch、base revision 和实际文件树说明代码到底是什么状态。

因此：

```text
DomainEvent：状态事实
Evidence / Receipt：执行事实
Git revision / worktree：代码事实
ProjectFile / snapshot / Zustand / UI：投影或缓存
Agent 文本：提议、解释或上下文，不是最终事实
```

稳定 ID、版本和 provenance 才是跨 Agent、模块和层级的连接方式，而不是 Agent 名称、自然语言 Prompt 或 UI 标签。

---

## 11. 架构方向与当前结构性债务

### 11.1 目标架构

```text
Presentation
  ↓
Project Control
  ↓
Domain Model / Event Source
  ↓
Execution Runtime
  ↓
Host Adapters / Providers
  ↓
Evidence / Feedback
```

数据流是：

```text
用户目标
→ Session
→ Decision / Brief / Architecture
→ TaskGraph
→ Orchestration
→ Run
→ Worktree / Worker
→ Acceptance
→ Evidence / Receipt
→ Project Facts
→ UI Projection
```

### 11.2 当前做得较好的地方

- `workerQueue` 聚焦 Run/Task 状态和依赖调度；
- `eventStore` 聚焦事件、锁、snapshot 和 replay；
- `agentRouter` 聚焦 Agent 选择和 fallback；
- `agentEconomics` 聚焦成本估算；
- `workerAcceptance` 聚焦宿主验收；
- `workerCleanup` 聚焦清理审批和 receipt；
- 多数领域模块可以脱离 React 单独测试；
- Tauri、文件系统、Codex CLI 和模型协议通过 adapter 隔离。

### 11.3 当前最大的债务

1. `App.tsx` 仍然承担过多 composition root 职责；
2. 新 ProjectControl/event source 与旧 `workflowStore`、旧 executor 仍然部分并行；
3. 事件 payload 有些只保存摘要，无法完全独立重建全部私有对象；
4. 项目文件和事件流还不是一个统一事务；
5. capability registry、Context Pack、quota scheduler 和灾难恢复 UI 尚未完成；
6. 插件目前是可信 WebView 代码，不是进程级强隔离。

因此，当前架构不是“已经完成的最终架构”，而是一个正在从工作流编辑器迁移到项目执行系统的过渡架构。

---

## 12. 未来路线：从功能堆叠转向风险收敛

### 阶段一：证明核心闭环

```text
项目目标
→ 计划确认
→ Worker
→ 宿主 acceptance
→ Evidence
→ cleanup
```

验收标准不是“每个函数有单测”，而是隔离项目中真实走通完整链路，并且重启后状态一致。

### 阶段二：建立可靠性底座

- quota-exhausted / paused / resume 状态；
- 断电和崩溃恢复测试；
- backup rotation；
- manifest / commit marker；
- 安全模式和诊断导出；
- 完整 graph/policy/plugin/input hash。

### 阶段三：建立能力与知识系统

- Agent capability registry；
- capability-gap 交互；
- 文件/符号索引；
- Context Pack 编译器；
- Artifact 引用和文档检索；
- 项目记忆压缩、去重和版本化。

### 阶段四：完成执行源切换

- 明确旧 executor 的退出边界；
- 收敛 workflowStore 与 event source 双写；
- 提高 ProjectControl 事件 payload 的完整度；
- 让 Run、Evidence、Artifact 和 Issue 形成闭环反馈；
- 最后再考虑更高程度的自动化和持续运维。

### 调研后的优先级修正

竞品调研没有改变四层架构方向，但改变了近期排序：应先把“Evidence → 用户审查 → 安全交付”闭合，再建设 Context Pack、能力发现、预算熔断和多实例 lease。只有这些能力稳定后，才适合扩大 Artifact 类型、Provider 数量和外部自动化生态。

近期不应以以下事项作为核心成功指标：

- 更多节点、模板或连接器；
- 更强但不可解释的自治；
- 让 LangGraph 或其他 Runtime 成为项目事实源；
- 用用户评论或模型自报结果替代宿主 Evidence 和真实任务指标。

---

## 13. 最需要持续追问的未知问题

1. 用户是否真的愿意先确认 Brief、架构和任务，而不是直接让 Agent 修改代码？
2. 用户最需要的单位是 Task、Issue、Run，还是一个可以暂停的 Project Transaction？
3. 当一个任务包含代码、设计、3D 资产和外部工具时，能力路由如何避免变成新的静态配置地狱？
4. 事件流和 ProjectFile 同时存在时，用户能否理解二者差异？
5. 当系统进入 recovery 时，普通用户是否知道如何做出正确选择？
6. Codex 订阅额度不可观测时，产品是否应该把它作为核心 Worker，还是只作为一种可替换 Provider？
7. 如果系统必须在安全与自动化之间选择，用户愿意接受多大程度的人工确认？
8. SlimeMold 的核心壁垒究竟是 UI、Agent 编排、项目事实源，还是可靠的代码执行闭环？
9. 这些能力中，哪一项能让用户在第一次使用后就感受到“只有 SlimeMold 能做到”？

这些问题比继续增加节点类型更接近产品成败。

---

## 14. 共同结论

SlimeMold 最值得坚持的方向不是“让更多 Agent 一起工作”，而是：

> 让 Agent 在一个有项目事实、明确路线、受控权限、隔离执行、宿主验收和可恢复状态的系统里工作。

它最终应该像一个**面向长期软件工作的 Agent 项目操作系统**，而不是一个“聊天 + 节点 + 自动化”的功能集合。

竞品调研进一步支持这一判断：SlimeMold 的壁垒不应是“拥有一个 Agent Runtime”，而应是围绕软件项目建立事实、权限、隔离、验收、恢复和交付的完整保障层。调研中的竞品问题可以作为风险假设，但不能替代真实用户任务验证；下一步要验证的是用户是否愿意为这条高信任闭环接受计划确认和恢复操作。

当前实现已经建立了这条路线的骨架，但仍处于过渡阶段。下一步不应优先追求更多模型、更多节点或更强自治，而应优先证明：

```text
用户能理解
系统能暂停
状态能恢复
结果能验证
事实不分裂
路线不漂移
```

只有这些成立，SlimeMold 才有资格从一个实验性工作流工具，成长为值得用户长期托付项目的系统。

---

## 15. 边缘情形问答：从系统边界反推产品语义

这一组问题在提问阶段刻意采用“不了解 SlimeMold 内部实现的外部观察者”视角，只从通用系统设计角度覆盖容易被忽略的边缘场景；回答阶段再回到 SlimeMold 的产品目标、当前架构和已知限制。

这些问题不一定是最核心的产品问题，但它们能检验一个长期 Agent 系统是否拥有稳定的状态语义。

### 15.1 用户在 Worker 执行期间手动修改主仓库

**观察者提问：**

> 当用户与 Worker 同时修改同一个项目时，系统如何区分人工变更、Worker 变更和计划内变更，并避免覆盖用户工作？

**专业化表述：**

> 当用户在 Worker 执行期间修改主仓库时，系统如何处理 base revision 漂移、结果合并和人工变更保护？

**回答：**

Worker 不应该直接操作主仓库，而应该在独立 worktree 中工作。用户对主仓库的手动修改不会立即污染 Worker 的工作环境，但合并前必须重新检查：

```text
Worker 启动时的 baseRevision
Worker worktree 当前 revision
用户主仓库当前 revision
```

如果 base revision 发生漂移，系统应该重新检查影响范围、重新运行测试；存在冲突时进入 review，不能自动覆盖用户修改。

当前 SlimeMold 已经有 worktree、branch、baseRevision、stateSignature 和 cleanup 校验，但“用户实时修改主仓库后如何合并 Worker 结果”的完整交互还没有完成。

原则是：

> 人工修改永远不能被 Worker 的自动流程静默覆盖。

### 15.2 两个任务修改同一文件的不同区域

**观察者提问：**

> 当并行任务涉及同一个文件，但实际修改区域不重叠时，系统应该将其判定为冲突、自动合并，还是交给人工处理？

**专业化表述：**

> 并行任务的冲突判定应达到文件级、行区间级、符号级还是语义级？不同层级如何选择自动合并与人工升级？

**回答：**

不能只用“文件路径相同”判断冲突，也不能只用“行号不同”就认定安全。更合理的判定层级是：

```text
文件级
→ 行区间级
→ 符号级
→ AST / 语义级
→ 测试和行为级
```

当前 Task scope、影响域和 worktree 隔离提供了基础，但 scope 主要还是文件/模块级声明。未来需要补充符号级影响范围、patch 重叠检测、非重叠 diff 自动合并、合并后测试和语义冲突升级。

原则是：

> 路径不重叠可以优先并行；路径相同但区域不重叠可以尝试合并；行为可能重叠时必须升级审查。

### 15.3 Worker 没有修改代码，只产生文档或资产

**观察者提问：**

> 如果一个任务的有效产物不是源代码，而是文档、配置、图片、3D 文件或其他 Artifact，系统如何判断它是否完成？

**专业化表述：**

> 如何建立按 Artifact 类型区分的 acceptance contract，避免“没有代码 diff 就失败”或“有文件 diff 就成功”的误判？

**回答：**

验收不能默认等价于“Git 中出现了代码 diff”。不同任务应声明不同的 Artifact contract：

```text
代码任务 → 编译、测试、diff、路径策略
文档任务 → 文件、格式、结构、引用
配置任务 → schema、环境兼容性、安全策略
设计资产 → 格式、尺寸、预览、引用
3D 任务 → 引擎可打开、资产可导入、导出格式正确
```

当前 acceptance 更偏向软件代码任务。未来需要把 acceptance 从统一的测试/diff 检查扩展为类型化的 Artifact 验收。

### 15.4 用户中途改变项目目标

**观察者提问：**

> 当用户在执行过程中改变产品目标、技术路线或验收标准时，系统应该修改当前任务，还是创建新的计划版本？

**专业化表述：**

> 需求变化如何形成新的 Decision、Plan Revision 和 Run，同时保留旧路线的可审计性？

**回答：**

不能直接修改正在执行的计划，应该形成新的 Decision 或 Plan Revision：

```text
当前计划 revision 1
→ 用户提出新目标
→ 暂停受影响任务
→ 生成 revision 2
→ 用户确认影响范围
→ 创建新的 Orchestration / Run
```

已经验收的任务不应该因为新目标出现就全部重跑。旧 Run 保留，新 Run 使用新路线。

### 15.5 项目不是 Git 仓库

**观察者提问：**

> 当用户打开一个没有 Git 或无法创建 worktree 的项目时，产品应该如何降级，而不破坏安全边界？

**专业化表述：**

> 在缺少 Git worktree 能力时，系统如何提供有限可用性，同时避免将可写 Worker 降级到主目录？

**回答：**

没有 Git 的项目不能直接进入当前的安全 Worker 路径，系统不能偷偷把 Worker 放到主目录执行。可以提供：

```text
只读分析模式
普通不写盘工作流
生成 patch 的手动导出模式
用户批准后的 Git 初始化模式
```

当前 WorktreeManager 的安全原则已经是不回退到主仓库；未来 UI 需要把这个限制解释成用户可理解的能力状态。

### 15.6 两个 SlimeMold 实例同时打开同一个项目

**观察者提问：**

> 当同一个项目被多个应用实例或多个进程同时打开时，如何防止状态覆盖和重复执行？

**专业化表述：**

> 文件级锁和执行级 lease 如何协作，才能同时防止事件损坏、ProjectFile 覆盖和重复启动 Worker？

**回答：**

需要区分两种竞争：

```text
文件写入竞争 → event stream 宿主锁
执行权竞争   → project / run / task execution lease
```

事件锁只能防止事件流写坏，不能单独防止两个实例同时看到 queued Run 后分别启动 Worker。第二个实例应该进入只读或观察模式。

当前已有 Tauri event lock、sequence、event conflict 和单个 Run 并发启动保护，但跨多个应用实例的完整项目级执行 lease 还需要加强。

### 15.7 模型声称成功但输出格式错误

**观察者提问：**

> 当模型返回“成功”文本，但没有提供符合协议的结构化结果时，系统应该相信模型吗？

**专业化表述：**

> 模型文本、结构化解析、宿主验证和状态迁移之间的权威边界是什么？

**回答：**

模型文本只能是候选输出，不是事实：

```text
模型输出
→ schema 解析
→ 结构化校验
→ 宿主验证
→ Evidence
→ 状态迁移
```

解析失败时不能进入 `succeeded`。代码 Worker 还要检查实际 diff、路径、测试、acceptance 和 Evidence。

### 15.8 测试偶发失败，重跑后通过

**观察者提问：**

> 当测试第一次失败、第二次通过时，系统如何区分真正失败、环境问题和 flaky test？

**专业化表述：**

> Acceptance 如何表达 flaky、inconclusive 和 environment-blocked，而不把它们粗暴归类为 failed 或 succeeded？

**回答：**

每次测试都应记录：

- 测试命令；
- 环境信息；
- 每次退出码；
- 重试次数；
- 执行时间；
- 相关 diff。

推荐状态是：

```text
稳定失败 → failed
失败后重试通过 → flaky / inconclusive
外部环境不可用 → environment-blocked
环境稳定且验证通过 → succeeded
```

当前 acceptance 能运行测试并产生 Evidence，但对 flaky 和环境性失败的分类还不够细。

### 15.9 项目包含巨大的二进制或媒体资产

**观察者提问：**

> 当项目包含图片、视频、音频、3D 模型等大量二进制内容时，如何避免把它们全部放入 Agent 上下文？

**专业化表述：**

> 大型二进制 Artifact 应如何通过元数据、预览和工具能力参与推理，而不是直接进入 Prompt？

**回答：**

Worker 通常只需要：

```text
资产路径
→ 类型
→ 尺寸
→ 哈希
→ 版本
→ 预览
→ 使用关系
→ 允许操作
```

只有在确实需要视觉或结构分析时，才调用专门工具生成摘要或预览。当前已有资产和 Artifact 概念，但完整的大型资产 Context Pack 仍需实现。

### 15.10 长期记忆与当前决策冲突

**观察者提问：**

> 当长期记忆、历史经验和当前用户决策不一致时，系统应该相信哪一层？

**专业化表述：**

> 记忆、经验、当前计划和用户批准的 Decision 之间应建立怎样的权威优先级与 supersedes 关系？

**回答：**

建议的优先级是：

```text
当前用户确认的 Decision
> 已批准 Architecture / TaskGraph
> 宿主 Evidence
> 当前 Task 输入
> 项目长期记忆
> 历史运行经验
> Agent 推测
```

记忆需要有来源、适用范围、置信度和 supersedes 关系。当前 memory.md 和经验注入只能作为背景，不能覆盖当前结构化事实。

### 15.11 用户希望保留完成后的 worktree

**观察者提问：**

> 任务完成后，如果用户希望保留 worktree 继续人工修改，系统是否必须清理？

**专业化表述：**

> cleanup 是否应该是可选的生命周期状态，而不是成功任务的强制终点？

**回答：**

不应该强制清理。任务完成后可以有：

```text
cleaned
retained
awaiting-review
archived
cleanup-blocked
```

用户选择保留时，系统记录 branch、revision 和保留原因；以后再次修改后，原 acceptance 和 stateSignature 不能自动沿用，必须重新验证。

当前 cleanup 已经是 proposal → approval → receipt，而不是自动删除；正式的 `retained` 状态仍可继续补强。

### 15.12 模型或 Provider 静默升级

**观察者提问：**

> 当同一个模型名称背后的版本、能力或行为发生变化时，旧计划和旧验收结果还可信吗？

**专业化表述：**

> 长周期执行如何绑定模型、Provider、工具 schema 和策略快照，避免环境漂移破坏可重复性？

**回答：**

不能只记录一个模型字符串，还应该记录：

```text
provider
model id
model/capability version
temperature / 参数
tool schema
system policy
input hash
task graph revision
```

旧 Evidence 只能证明旧环境下的结果。当前已记录 Agent、model、Token usage 和成本，但 Provider build/version 的不可变绑定还需要完成。

### 15.13 找不到满足任务要求的 Agent

**观察者提问：**

> 当系统尚未配置用户需要的能力时，应该自动选择最接近的 Agent，还是明确报告能力缺口？

**专业化表述：**

> 对软性能力和硬性能力，系统应如何区分可接受降级、能力缺口和用户确认？

**回答：**

软性能力可以选择相近候选并提示风险；硬性能力不能静默降级：

```text
capability gap
→ 说明缺少的能力
→ 提议注册 Agent / Provider / Plugin
→ 用户确认后扩展能力目录
```

当前有显式 Agent、category、fallback 和成本评分，但 capability registry 仍是未来方向。

### 15.14 用户连续点击 Retry 或重复打开同一个 Run

**观察者提问：**

> 当用户重复提交同一个操作时，如何避免重复创建 Run、重复副作用和多个冲突的恢复任务？

**专业化表述：**

> 用户命令、Run、attempt 和副作用 key 应如何设计幂等边界？

**回答：**

应该区分三种行为：

```text
重复点击同一操作 → 幂等返回
用户明确 retry   → 新 attempt
输入或计划变化   → 新 Run / 新 revision
```

当前已有 queued Run 幂等、同一 Run 并发保护和新 attempt 机制；UI 仍需要通过 loading、禁用态和清晰反馈减少误操作。

### 15.15 这组边缘问题的共同结论

这些场景最终都指向同一组产品原则：

```text
不确定的结果不能伪装成成功
已确认的事实不能被记忆覆盖
已完成的进度不能因为 fallback 丢失
未确认的副作用不能自动重跑
新路线不能静默修改旧计划
文件锁不能代替执行锁
模型文本不能代替宿主 Evidence
```

一个长期 Agent 系统真正的成熟度，不是它能否在演示中完成一条理想路径，而是它在用户修改、模型切换、测试抖动、断电、重复点击和数据损坏时，是否仍然知道：

```text
什么是真的
什么是不确定的
什么可以继续
什么必须暂停
谁拥有下一步决策权
```
