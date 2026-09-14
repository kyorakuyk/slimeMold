---
title: SlimeMold 产品与架构取舍记录
type: architecture-decision-record
status: active
updated: 2026-09-15
authority: decision-log
---

# SlimeMold 产品与架构取舍记录

> 本文记录 SlimeMold 在产品定位、项目控制面、Agent 协作、执行安全、恢复和验证方面已经形成或正在形成的取舍。
> 它记录“为什么这样选择”，不替代架构契约中的“当前应该如何实现”，也不替代计划中的“下一步做什么”。

## 0. 记录规则

### 0.1 文档职责

```text
产品哲学       → 为什么应该遵守这些上位原则
战略审视       → 产品方向、竞争边界和系统性判断
本记录         → 选择了什么、放弃了什么、承担什么代价
架构契约       → 当前数据模型、状态和权限应该如何实现
实施计划       → 当前阶段准备做什么
开发日志       → 实际发生了什么、如何验证
```

因此，本文件是跨计划、跨阶段的“为什么”记录。计划可以重排，架构契约可以随实现更新，但历史决定不能在没有 `Superseded` 说明的情况下被静默覆盖。

### 0.2 状态含义

| 状态 | 含义 |
|---|---|
| `共同共识` | 产品哲学中已明确为双方共同设计基线，或用户已明确确认方向 |
| `已纳入计划` | 用户确认将其纳入计划，但协议细节或最终实现仍需后续确认 |
| `设计基线` | 已在架构/战略文档中形成的工程判断，可能仍需真实任务验证 |
| `建议待确认` | 助手提出的建议，不能当作用户已经批准的产品决定 |
| `已实现但未完全验证` | 代码或局部垂直切片已经存在，但真实 GUI、跨进程、重启或独立审查尚未完整证明 |
| `已替代` | 旧决定仍保留用于历史追溯，但当前以新的决定为准 |

每条记录都应区分：

```text
用户原始意图
→ 助手独立推导
→ 双方共同确认
→ 代码/验证状态
```

模型输出、开发日志中的“已完成”文字和计划中的“应该”措辞，不能单独把状态升级为 `共同共识` 或 `已验证`。

### 0.3 覆盖范围

本次汇总覆盖当前仓库中可追溯到的产品、架构、Agent 组织、信息边界、执行安全、恢复、交付和开发流程取舍，以及 2026-09-12 讨论中已经写入计划的层级化组织取舍。

视觉图标、个人网站风格和一次性的设计试稿不属于本文件的架构决策范围；它们继续由 `docs/design/`、`docs/product/` 或 `docs/history/` 中的相应资料记录。未纳入本文件不表示那些历史资料被删除或否定。

---

## 1. 产品定位与用户体验

### ADR-SM-001：把 SlimeMold 定位为项目级元 Harness，而不是通用 Agent/工作流平台

- **状态：** `共同共识`
- **决定：** SlimeMold 的核心对象是长期软件项目中的目标、计划、任务、代码、证据、恢复和交付；它不以复制 Dify、n8n、Coze 或 LangGraph 的全部表面能力为目标。
- **放弃的方案：** 以节点数量、连接器数量、Agent 数量或更自由的 DAG 作为主要竞争指标。
- **取舍：** 产品覆盖面和短期“功能丰富度”更窄，但可以把差异集中在真实代码修改、项目事实、权限、验收、恢复和交付可信度上。
- **后果：** 新功能必须说明它如何改善项目事实闭环，而不能只增加一个模型、节点或连接器。
- **来源：** [S1 §0.1、§1]；[S2 §3.1–§3.4、§14]；[S3 §1、§15]。

### ADR-SM-002：产品基本单位是可暂停、可验收的项目任务

- **状态：** `共同共识`
- **决定：** 系统的基本单位不是一次 LLM 请求、一次聊天或一个画布节点，而是一个有目标、边界、依赖、版本、验收标准且可以暂停、恢复和交付的项目任务。
- **放弃的方案：** 以模型调用次数或一次 Agent 对话作为项目进度单位。
- **取舍：** 需要更多状态、持久化和协议设计，但可以表达长任务、部分成功、阻塞、重试和恢复。
- **后果：** `Task`、`TaskExecution`、`Attempt`、`Evidence`、`Acceptance` 和 `Receipt` 的语义不能被简化为一次消息的返回值。
- **来源：** [S1 §2]；[S2 §1.1、§1.3]；[S3 §14.1]。

### ADR-SM-003：选择“受托执行”，不承诺无限自治

- **状态：** `设计基线`
- **决定：** 用户保有项目目标和最终高影响决策；Agent 只拥有局部推理和受限执行权；系统负责上下文、权限、状态、证据和恢复。自然语言目标不能直接产生任意复杂且无需确认的不可逆执行。
- **放弃的方案：** “一句话输入后，系统无需确认就自动完成任何复杂软件”的产品承诺。
- **取舍：** 少一些表面上的自动化顺滑度，多一些确认和状态治理；换取可解释、可暂停、可追责和可恢复。
- **后果：** 高影响目标、架构、预算、权限、代码启动、merge、release、delete 和外部写入必须有明确的 Decision、Approval 或 Policy 边界。
- **来源：** [S1 §0.2–§0.3、§10]；[S2 §1.2、§6]；[S3 §2.1、§5]。

### ADR-SM-004：默认入口采用项目驾驶舱，而不是空白 DAG

- **状态：** `共同共识`
- **决定：** 新用户从“开始项目会话”进入；主控先澄清目标并形成 Brief、Decision 和计划，再进入 Issue/DAG 等专业视图。
- **放弃的方案：** 把空白画布、Provider、节点端口和 Agent 绑定作为所有用户的第一入口。
- **取舍：** 初学者更容易理解项目目标和下一步，但专业用户进入底层执行细节需要额外一次上下文导航。
- **后果：** 高级工作台必须携带当前项目、Workflow、Task 和 Run 上下文，不能打开一个没有项目语境的空白画布。
- **来源：** [S2 §2.1–§2.2]；[S3 §2.3、§8.1]；[S5 §8.1、§14.6]。

### ADR-SM-005：驾驶舱、Issue 工作台和 DAG 是同一状态的不同投影

- **状态：** `共同共识`
- **决定：** 简易驾驶舱、Issue 工作台、专业 DAG、审计和恢复界面都投影同一组项目事实，不各自维护独立任务状态。
- **放弃的方案：** 每个页面拥有自己的状态 store，并通过复制文本或 UI 回调保持同步。
- **取舍：** 需要稳定 ID、版本、来源和投影协议；换取跨页面一致性和可追溯性。
- **后果：** UI、React Flow 和 Zustand 只能消费 projection；页面按钮必须调用领域命令，不能直接写事实状态。
- **来源：** [S1 §7]；[S2 §2.2]；[S3 §2.2、§8.4]；[S5 §8]。

### ADR-SM-006：采用渐进式透明，而不是默认暴露全部内部细节

- **状态：** `设计基线`
- **决定：** 默认展示用户当前需要理解的目标、决定、进度、风险和下一步；每个重要结论都保留向下追溯到 Decision、Task、Run、Evidence 和 Receipt 的入口。
- **放弃的方案：** 要求用户始终阅读完整 DAG、所有 Agent transcript、Token、Provider 和底层 ID。
- **取舍：** 用户认知负担更低，但需要系统提供可靠的按需展开、引用和受控查询。
- **后果：** “隐藏”不等于“删除”；任何重要结论都必须可以通过溯源权访问原始或结构化证据。
- **来源：** [S1 §4.3、§6–§8]；[S3 §8.1–§8.3]；[S5 §8.4]。

### ADR-SM-007：低风险路径自动化，高影响变化进入确认门

- **状态：** `共同共识`
- **决定：** 正常、低风险、可逆的工作可以在一次计划确认后自动选择 Worker、创建 worktree、运行测试和收集 Evidence；高风险、跨模块、预算超限、能力缺失、目标漂移、merge、release、delete 和未知副作用必须暂停并请求确认。
- **放弃的方案：** 每个小动作都重复询问，或所有动作都默认无人值守。
- **取舍：** 在便利性和安全性之间使用风险分级，而不是固定地选择“全自动”或“全人工”。
- **后果：** 确认是状态迁移和授权事实，不只是按钮文案；授权必须绑定当前版本、scope、policy 和执行目标。
- **来源：** [S1 §10]；[S3 §5.1]；[S5 §8.4、§14.1–§14.2]。

### ADR-SM-008：Issue 是统一变化入口，但不建立第二套任务事实源

- **状态：** `已实现但未完全验证`
- **决定：** Issue 负责承载想法、需求、Bug、风险、阻塞和变化；Issue、Task、WorkerRun 和 DAG 通过 canonical TaskGraph/Task lineage 关联。Issue Board 不建立独立的 Worker 状态系统。
- **放弃的方案：** Issue Board、Workflow Editor、Worker Queue 各自维护一套任务对象并靠 UI 互相同步。
- **取舍：** 需要做 materialization、版本关联和 drift audit；换取同一任务在规划、执行、验收和恢复中的一致身份。
- **后果：** 未认领 Issue 使用明确的 `projectId: null`，不能因没有项目而丢失；状态转换走 Command/Event；旧图 revision 不覆盖旧 Issue/Task 历史。
- **来源：** [S3 §4、§6、§9]；[S6 §8–§9]；[S10 §1、§5]；Phase 2 代码与测试记录见 `docs/DEVELOPMENT_LOG.md`。

---

## 2. 事实源、状态和演化

### ADR-SM-009：控制面与执行面分离

- **状态：** `共同共识`
- **决定：** 用户、会话、Decision、Approval、预算和 Policy 属于控制/计划边界；Scheduler、Executor、Worker、Worktree 和命令属于执行边界；Evidence、Receipt、Issue 和 Recovery 负责反馈。
- **放弃的方案：** 让 UI、Agent 或某个 Runtime 直接同时决定计划、修改状态并执行副作用。
- **取舍：** 多一层 Command、Policy 和 Adapter；换取权限可验证、状态可回放和宿主可阻断。
- **后果：** Agent/Profile/插件只能提出 Provider request 或 Command proposal，不能直接写 Project State、Zustand 或核心 `.slimemold` 文件。
- **来源：** [S1 §1、§3、§7]；[S3 §3]；[S5 §2、§3、§7]。

### ADR-SM-010：采用分层权威，而不是把所有状态归给一个模型输出

- **状态：** `共同共识`
- **决定：** `DomainEvent` 负责状态迁移事实；`Decision/PlanRevision` 负责批准的方向事实；Host `Evidence/Receipt` 负责执行和副作用事实；Git revision/worktree 负责代码事实；ProjectFile/snapshot 是投影和恢复材料；Agent 文本只是提议、解释或候选结果。
- **放弃的方案：** 用最后一次模型回复、UI 状态、内存 store 或单个 snapshot 作为全局真相。
- **取舍：** 需要维护多种事实之间的 provenance 和一致性检查；换取不会因模型自报或页面状态错误而宣布项目完成。
- **后果：** 每条重要结论需要稳定 ID、版本、来源和可追溯的证据链；无法证明的状态必须进入 `unknown`、`needs-repair` 或 recovery。
- **来源：** [S1 §5–§6]；[S2 §10]；[S3 §4、§14.7]；[S5 §2、§14.4–§14.5]。

### ADR-SM-011：会话消息与 Decision 分离

- **状态：** `共同共识`
- **决定：** 用户在会话中表达的内容先是意图、假设或决策提案；经主控提炼、展示影响范围并由用户确认后，才成为结构化 `Decision`。
- **放弃的方案：** 把聊天记录中某一句自然语言直接当作长期有效约束。
- **取舍：** 需要额外的提炼和确认流程；换取决定可检索、可审计、可 supersede，并避免语境误读。
- **后果：** 会话保留原始来源，Decision 保留结构化含义；未确认草案可以修改或废弃，不能直接产生不可逆副作用。
- **来源：** [S1 §5.1]；[S3 §4.1、§5.1]。

### ADR-SM-012：所有派生对象都携带稳定 ID、版本和 provenance

- **状态：** `设计基线`
- **决定：** Session、Decision、Issue、Artifact、Task、TaskGraph、Workflow、Run、Evidence、Acceptance 和 Receipt 都要有稳定身份、来源对象、来源版本、生成者、批准状态、有效性和影响范围。
- **放弃的方案：** 用 Agent 名称、自然语言标题、UI 标签或裸 `taskId` 推断对象关系。
- **取舍：** 数据结构和迁移成本增加；换取跨 Agent、跨页面、跨进程、跨重启和跨 revision 的可审计 lineage。
- **后果：** 查询、重试、恢复、清理和 reviewer verdict 必须绑定 exact identity，不能采用 wildcard 或“看起来相近”的对象。
- **来源：** [S1 §6]；[S3 §9]；[S5 §2、§14.1、§14.5]；[S10 §2–§5]。

### ADR-SM-013：计划变化产生新 revision，不静默修改旧计划

- **状态：** `已实现但未完全验证`
- **决定：** Brief、Architecture、TaskGraph、Orchestration 和执行路线发生实质变化时，生成新的 Decision/PlanRevision/Graph revision；旧 Run、旧 Evidence、已验收 Task 和历史事实保留。
- **放弃的方案：** 原地修改当前计划，或为了让 UI 简洁而删除 superseded 历史。
- **取舍：** 历史和 Issue 数量会增长，投影需要压缩和 superseded 视图；换取路线变化、影响范围和旧结果可追溯。
- **后果：** 新 revision 需要重新确认受影响范围，受影响 Task 暂停或重新规划；没有受影响的已验证产物可以复用。
- **来源：** [S2 §14.4]；[S3 §9.1]；[S10 §5]；Phase 2 revision command/project persistence 测试记录见 `docs/DEVELOPMENT_LOG.md`。

### ADR-SM-014：执行身份使用 TaskExecution/Attempt，而不是只使用 Task ID

- **状态：** `已实现但未完全验证`
- **决定：** 执行身份固定为：

  ```text
  TaskDefinitionId
    → TaskExecutionId(runId, taskId)
      → AttemptId(taskExecutionId, attempt)
  ```

  retry 创建新的 Attempt、worktree 和副作用 key；旧 Attempt 的迟到结果不能覆盖当前 Attempt。
- **放弃的方案：** 用 `taskId` 作为所有运行、Evidence、Acceptance、cleanup 和 retry 的唯一关联。
- **取舍：** 事件、投影和回归测试更复杂；换取重启、并发、迟到回调和多次尝试不会互相污染。
- **后果：** completion 必须携带当前 attempt fencing；`tasks[taskId]` 只能是兼容投影，不能承担历史审计。
- **来源：** [S2 §14.5.1]；[S3 §14.5.1]；[S5 §2、§14.5]；Phase 2 execution lineage 与 cleanup hardening 记录见 `docs/DEVELOPMENT_LOG.md`。

### ADR-SM-015：先采用“事件流 + Snapshot/Projection”，不宣称一步完成完整 Event Sourcing

- **状态：** `设计基线`
- **决定：** Durable DomainEvent stream 是状态迁移事实；snapshot、ProjectFile 和 UI store 是查询/恢复缓存或投影。当前允许多个物理文件，通过版本、checksum、lastSequence、projectionHash、repair 和 replay 降低不一致风险。
- **放弃的方案：** 立即把所有旧状态一次性改造成纯 Event Sourcing，或继续把 snapshot 当作不可质疑的完整事实源。
- **取舍：** 短期仍需处理跨文件事务和 snapshot/event 不一致；换取渐进迁移、旧项目兼容和可回退。
- **后果：** 损坏 snapshot 可以 replay；事件尾部损坏进入 `needs-repair`；不能因解析异常返回一个看似正常的空项目，也不能伪造旧批准历史。
- **来源：** [S3 §4.2、§14.5]；[S4 §4.1、§5]；[S5 §4、§14.4]。

### ADR-SM-016：采用 Facade/Adapter 渐进迁移，而不是一次性重写核心

- **状态：** `设计基线`
- **决定：** 保留 `workflowStore` facade 和旧 executor/插件兼容边界，按 Command/Event、Projection、Adapter 和迁移步骤逐步收敛；新能力不得继续直接依赖旧的隐式写入。
- **放弃的方案：** 一次性重写 `App.tsx`、`workflowStore.ts`、executor 或全部插件，并在迁移中删除旧实现。
- **取舍：** 迁移期会同时存在旧/新路径，边界治理更难；换取用户数据、旧项目和已验证能力可以逐步保留，失败时可回退。
- **后果：** 每个新模块都必须声明事实源、命令入口、投影、恢复和 legacy 边界；最终仍要完成旧执行源 cutover。
- **来源：** [S4 §1、§4、§11.3]；[S5 §1、§7、§12、§14.7]；[S3 §10–§11]。

### ADR-SM-017：区分 Draft、Static/Published 和 Dynamic Runtime Graph

- **状态：** `设计基线`
- **决定：** Draft Graph 用于编辑和试验；Static/Published Graph 是带版本和契约的可复用模块；Dynamic Runtime Graph 是某次 Run 的实际展开、分支、重试和证据投影。
- **放弃的方案：** 用一个既可编辑又代表历史运行、又可直接发布的单一图对象。
- **取舍：** graph lineage 和版本关系更复杂；换取复用、运行观察、历史审计和编辑安全可以同时成立。
- **后果：** 动态图不是新的源计划；已执行图不能被静默修改；图上语义变化要生成 Plan Draft/Revision 或 Domain Command。
- **来源：** [S1 §7.1–§7.2]；[S3 §8.4、§9.1]。

### ADR-SM-018：Acceptance 按 Artifact 类型区分，不把“代码 diff”当成通用完成标准

- **状态：** `设计基线`
- **决定：** 代码、文档、配置、设计资产、3D 资产等使用不同的 acceptance contract；模型文本只能是候选结果，结构化解析、宿主检查、Evidence 和 Receipt 才能推动状态迁移。
- **放弃的方案：** “没有代码 diff 就失败”或“只要有文件 diff 就成功”的统一判断。
- **取舍：** 验收 schema 和宿主检查种类增加；换取非代码任务不会被误判，也不会因一个文件存在就伪装完成。
- **后果：** `Artifact`、`Acceptance` 和 Evidence 必须声明类型、检查方式、来源和结果；通用语言/资产验收属于后续阶段。
- **来源：** [S2 §14.3、§15.3]；[S3 §4、§12]；[S10 §7]。

---

## 3. Agent 组织、通信和知识边界

### ADR-SM-019：从静态类别路由升级为能力发现

- **状态：** `设计基线`
- **决定：** Agent/Model 通过领域、工具、Artifact 类型、平台、环境、权限、质量、延迟和成本声明能力；Planner 从任务中提取 `requiredCapabilities` 和 `requiredArtifacts`，先做硬性过滤，再评分和 fallback。
- **放弃的方案：** `ui → Gemini` 这类静态 category 映射，或没有能力时静默把普通 Agent 当成专业 Agent。
- **取舍：** registry、环境检测和 capability-gap UX 增加系统复杂度；换取复合任务不会被错误路由，能力缺失可以诚实暴露。
- **后果：** 未满足硬性能力时报告 `capability gap`；普通只读请求可以 fallback，代码 Worker 不能让另一个模型无条件接管受污染的 worktree。
- **来源：** [S2 §5]；[S3 §14.2]；[S5 §3.4、§14.3]。

### ADR-SM-020：记忆保存经验，不替代当前项目事实和授权

- **状态：** `共同共识`
- **决定：** 项目事实、项目长期记忆、运行经验和当前 Task Context 分层；Memory 只能生成候选、经验、偏好或路由提示，不能覆盖当前 Decision、Architecture、TaskGraph、权限或副作用授权。
- **放弃的方案：** 把所有历史对话、全局记忆或 Agent 的推测直接注入每个任务，并允许它们改变执行权限。
- **取舍：** 记忆复用范围变小，需要用户审核和 scope 管理；换取旧项目污染、错误偏好和隐藏权限不会悄悄影响新项目。
- **后果：** 全局提升需要安全白名单或用户确认；当前 Decision 优先于项目记忆，项目偏好不能反向修改全局设置。
- **来源：** [S1 §6、§10]；[S2 §7]；[S3 §14.8]；[S5 §3.5、§9]。

### ADR-SM-021：Agent 之间采用稀疏的结构化协作，不默认群聊和全量 transcript 转发

- **状态：** `共同共识`
- **决定：** Agent 通过 Task、Artifact、Decision Request、Evidence、Receipt、Failure/Blocker 和结构化 message envelope 通信；原始聊天只在必要时按引用或受控范围读取。
- **放弃的方案：** 多 Agent 互相转发完整上下文，让所有 Agent 重新解释同一份历史。
- **取舍：** 少了一些自然语言的即时上下文，多了 schema、引用和协商成本；换取 token 成本、责任归属和信息泄露风险可控。
- **后果：** 每个消息要有发送者、接收者、schema/version、references、preconditions、expected effects、uncertainty、deadline 和 idempotency；私下共识不能自动成为项目决策。
- **来源：** [S1 §5.2–§5.4]；[S2 §4.1–§4.3]；[S10 §2–§4]。

### ADR-SM-022：采用 CEO → 承建方 → 部门 → 模块 → Worker 的核心交付链

- **状态：** `已纳入计划`
- **决定：** 纵向职责链为：

  ```text
  用户 / Project Owner
    → Master Agent / CEO
    → Project Delivery Architect
    → Department Head / Program Director
    → Module Lead / Tech Lead
    → Worker / IC Engineer
    → Specialist Child Agent（按需）
  ```

- **放弃的方案：** 让 CEO 直接向所有 Worker 派发任务，或继续无限增加管理头衔。
- **取舍：** 多一个需求/方案/可行性翻译层，计划阶段成本上升；换取超长项目中需求、架构、里程碑和部门拆包有明确责任边界。
- **后果：** 小任务可以跳层；大任务才启用完整链路；角色名称和最终审批边界仍需进一步确认。
- **来源：** [S10 §1.1–§1.5、§6 Phase A–B]；2026-09-12 用户确认将承建方及横向角色加入计划。

### ADR-SM-023：Project Delivery Architect 是独立规划 Workflow，不是消息转发器

- **状态：** `已纳入计划`
- **决定：** 承建方承接 Master 的批准意图，负责需求分析、概要设计、可行性、风险、开发方向、里程碑、跨部门接口和 Department Work Package；它可以按需组合 Requirements Analyst、Solution Architect、Feasibility/Risk Analyst、Program Planner、Package Dispatcher 和 Plan Arbiter。
- **放弃的方案：** 让 Department Head 直接承担全局需求与架构，或让承建方只负责转发消息。
- **取舍：** 规划 Workflow 增加了时间和协议成本，但可以在施工前暴露歧义、不可行性、依赖和范围风险。
- **后果：** `ProjectPlan`、`RequirementsBaseline`、`SolutionOutline`、`FeasibilityAssessment`、`MilestonePlan`、`DepartmentWorkPackage` 和 `PlanRevision` 必须带版本、来源和审批状态；计划未批准前不得 dispatch 可执行部门任务。
- **来源：** [S10 §1.4、§6 Phase B]；2026-09-12 用户对“承建方”职责的明确说明。

### ADR-SM-024：QA、Security、Integration、Operations 等是横向保障，不继续堆成树层

- **状态：** `已纳入计划`
- **决定：** 除纵向交付链外，加入：

  ```text
  Evidence / Knowledge Steward
  Independent Reviewer / QA
  Integration / Release Manager
  Security / Risk / Red-Team Reviewer
  Operations / Recovery Manager
  Resource / Capacity（优先作为 Control Plane 能力）
  ```

  它们可以是独立 gate、咨询角色、审计角色或按需 Agent，而不是每个项目都常驻的固定管理层。
- **放弃的方案：** 为每种职责再增加一层“总监/副总/经理”，或把所有横向工作都交给 Worker 的直属上级。
- **取舍：** 横向制衡可能增加等待和调度成本，但能补足证据整理、跨部门集成、独立验收、风险阻断和恢复职责。
- **后果：** 同一个 Agent 不应同时产生结果、批准结果并执行高影响发布；Evidence/Knowledge、Resource/Capacity 和基础 Operations 优先由确定性 Control Plane 提供。
- **来源：** [S3 §7]；[S10 §1.2–§1.5、§6 Phase A/C/I、§7]；2026-09-12 用户确认加入计划。

### ADR-SM-025：使用矩阵能力池和按风险跳层，而不是为每个项目复制整家公司

- **状态：** `建议待确认`
- **决定：** 推荐 Department Head 管理可复用的长期能力池；Project Delivery Architect 为当前项目创建 Work Package；Module Lead、Worker 和横向审查角色按任务规模、风险、依赖和预算按需启用。
- **放弃的方案：** 每个项目都固定创建一棵完整的 CEO/部门/小组/Worker 树，或把部门永远运行成多个虚拟人格。
- **取舍：** 矩阵调度和角色归属更难解释；换取 Agent 数量、上下文复制和管理仪式不会随小任务线性膨胀。
- **后果：** 需要定义能力池、项目 Work Package、资源租约和冲突归属；这是当前计划中的推荐方向，不是最终已批准的组织制度。
- **来源：** [S3 §7]；[S10 §1.3、§1.5、§8–§9]。

### ADR-SM-026：Manager 默认读 Summary，必要时通过受控检索读取 Evidence

- **状态：** `共同共识`
- **决定：** 上层管理者默认读取 `TaskSummary`、`ProgressCapsule`、`ManagerBrief` 等结构化摘要；需要时按 `EvidenceRef`、`AcceptanceRef`、`DecisionRef`、typed index、关键词和有界图遍历读取有限证据。语义/向量检索只用于候选发现。
- **放弃的方案：** 上层永远只读摘要，或每次都读取完整 Worker transcript 和全项目上下文。
- **取舍：** 摘要降低 token 和无关干扰，但必须承担 stale、dangling reference、漏检和查询预算的治理成本。
- **后果：** 关键词命中不能单独成为事实或授予权限；查询结果必须带 source/version/scope/budget/truncation provenance；“没检索到”要区分 `empty`、`truncated`、`out-of-scope`、`needs-repair` 和 `not-found`。
- **来源：** [S1 §4、§6]；[S2 §7.3]；[S10 §2.1–§2.2、Phase C–D]；2026-09-12 用户对摘要与证据查询的修正。

### ADR-SM-027：Worker 接收系统编译的最小 ContextPack

- **状态：** `共同共识`
- **决定：** Worker 获取任务目标、非目标、相关 Decision/Architecture/TaskGraph 版本、影响文件/符号、必要接口和文档、验收标准、允许路径、工具和相关经验，而不是整个仓库、全部会话和全部项目记忆。
- **放弃的方案：** 用完整项目 transcript 或普通历史裁剪代替任务级上下文编译。
- **取舍：** ContextPack 编译器、索引和过期处理需要额外基础设施；换取 Worker 专注、token 成本降低和无关信息泄漏减少。
- **后果：** ContextPack 是授权边界而不只是提示词模板；超预算时按 `acceptance > current task > direct dependency > decision > history > remote context` 缩减。
- **来源：** [S1 §4]；[S2 §7.1–§7.3]；[S3 §14.8]；[S10 §2.3、Phase E]。

### ADR-SM-028：子代理权限只能单调收缩，并防止通过子代理洗白权限

- **状态：** `共同共识`
- **决定：** 子代理有效权限满足：

  ```text
  ChildScope = ParentScope ∩ PolicyScope ∩ ChildTaskScope
  ```

  不能通过“让另一个 Agent 去读”扩大原 Worker 的文件、数据类别、工具、预算、角色或执行能力。
- **放弃的方案：** 只在父 Worker 的 Prompt 中写“请注意权限”，或把子代理视为新的可信主体。
- **取舍：** delegation、Context Gateway、child output schema 和审计复杂度上升；换取递归 Agent 不会成为绕过 Need-to-know 和 capability gate 的隐蔽通道。
- **后果：** 每次 delegation 携带 parent/child/root task、delegation ID/depth、allowed files/data/tools/roles、budget、deadline 和 expiry；scope drift、未知字段和超限必须 fail-closed。
- **来源：** [S1 §4.1–§4.2、§10.1]；[S3 §9.2]；[S10 §3.1–§3.3]；2026-09-12 用户对防绕过的明确要求。

### ADR-SM-029：歧义通过 FeedbackRequest 阻塞上报，不让 Worker 猜测施工

- **状态：** `共同共识`
- **决定：** Worker 遇到会影响范围、接口、验收、预算或副作用的含混需求时，进入 `waiting-feedback`，生成结构化 `FeedbackRequest`，由 Module Lead、Department Head、Project Delivery Architect、Master 或用户按影响等级决定。
- **放弃的方案：** 让 Worker 根据自己的推测继续执行，或把歧义埋在自然语言聊天中。
- **取舍：** 任务可能暂时停滞，反馈路由需要额外状态；换取错误方向和不可逆副作用不会被局部模型的猜测放大。
- **后果：** Feedback 要引用 task/context version、受影响 acceptance、Evidence、选项、建议、blocking 和需要的决策层；形成 Decision/PlanRevision 后旧 ContextPack 失效并重新编译。
- **来源：** [S1 §4.3、§5.2]；[S10 §4]；2026-09-12 用户确认的 FeedbackRequest 设计。

### ADR-SM-030：多模型辩论是受控 Review Board，不是自由群聊或多数票真相

- **状态：** `已纳入计划`
- **决定：** Project Delivery Architect 只在高风险、高不确定性、跨部门影响、方案冲突、预算/工期超阈值或下层反馈互相矛盾时触发：冻结 EvidencePack → 独立方案 → 批评轮 → reconciliation → 保留少数意见 → 形成 ArchitectureDecision。
- **放弃的方案：** 每个 Task 都启动多个顶级模型，或用“多数模型投票”直接决定事实和项目方向。
- **取舍：** 复杂问题的盲点和方案质量可能改善，但成本、延迟、重复意见和权威误判风险上升。
- **后果：** 必须限制 `maxRounds`、`maxModels`、token/cost/time budget 和 early stop；每个意见带假设、EvidenceRefs、风险、分歧和 confidence；高影响结论仍需用户/CEO 批准。
- **来源：** [S10 §1.4、Phase B、§9 #6]；2026-09-12 用户对顶级模型辩论的设想。

### ADR-SM-031：Planner 与 Worker 分离，模型切换不能抹平执行权限差异

- **状态：** `设计基线`
- **决定：** `MasterPlanner` 负责只读、纯文本/结构化规划；`WorkerExecutor` 负责明确 worktree、写权限、工具、取消、超时、Evidence 和 recovery。规划模型不能因为能提出计划就自动获得文件写权限。
- **放弃的方案：** 一个 Agent/Provider 同时负责目标分析、任意文件修改、验收和发布。
- **取舍：** 需要多 Adapter 和交接协议；换取规划错误不会直接变成执行副作用，Provider fallback 也不会误授权限。
- **后果：** Worker 启动前探测 Provider/CLI 能力；模型输出必须转成受控 Command/ArtifactCandidate，不能直接写事实。
- **来源：** [S5 §3.1、§3.2、§14.3]；[S1 §3、§5.4]。

---

## 4. 权限、执行、交付与恢复

### ADR-SM-032：Worker 使用隔离 worktree，不直接写主仓库

- **状态：** `共同共识`
- **决定：** Worker 在绑定 project/run/task/attempt 的独立 worktree 和 branch 中施工；用户主仓库的人工修改不能被 Worker 自动流程静默覆盖。
- **放弃的方案：** 让多个 Worker 或用户和 Worker 直接共享主工作树。
- **取舍：** 创建、注册、合并和清理成本增加；换取并行隔离、人工变更保护、失败现场保留和更清晰的代码事实。
- **后果：** 合并前要检查 worker base revision、worker revision、用户主仓库 revision；漂移或冲突进入 review，不自动覆盖用户修改。
- **来源：** [S2 §15.1–§15.2]；[S3 §7、§9.2]；[S5 §2.2、§2.3、§14]。

### ADR-SM-033：冲突处理按确定性到语义逐级升级

- **状态：** `设计基线`
- **决定：** 冲突判断和处理顺序为：路径/符号/接口/依赖预检 → worktree/sandbox 隔离 → 非重叠 diff 合并 → 独立测试 → 语义冲突裁决 → 架构/安全/数据模型/受保护路径升级。
- **放弃的方案：** 只按文件路径判定冲突，或只因行号不重叠就自动认为安全。
- **取舍：** 精确影响分析和语义审查成本更高；换取“文件相同但行为冲突”的问题不会被简单 merge 掩盖。
- **后果：** 未来需要符号级影响域、patch 重叠检测、合并后测试和独立 Integration/Release gate。
- **来源：** [S3 §7.2]；[S2 §15.2]；[S10 §7]。

### ADR-SM-034：权限绑定 Task/Policy/Worktree/工具/风险，而不是绑定 Agent 名称

- **状态：** `共同共识`
- **决定：** 权限由 Boundary Contract、ContextPack、Policy、Worktree、工具 capability、数据类别、动作和风险级别共同决定；读、写、执行和外部副作用逐层收缩：

  ```text
  可读范围 ⊇ 可写范围 ⊇ 可执行范围 ⊇ 可产生副作用的范围
  ```

- **放弃的方案：** “这是 Worker/管理员，所以天然可以做所有事”或只依据 UI 勾选标签放行。
- **取舍：** 授权计算和测试复杂度上升；换取 Agent 重命名、模型切换或子代理创建不会隐式扩大权限。
- **后果：** 未知字段、能力缺失、scope drift、超预算和不匹配的 path/branch 必须拒绝，而不是默认允许。
- **来源：** [S1 §4、§10.1]；[S3 §9.2]；[S5 §2、§3]；[S10 §3]。

### ADR-SM-035：批准采用不可变 Grant/Fingerprint，而不是布尔 `approved: true`

- **状态：** `设计基线`
- **决定：** 执行批准绑定 plan/task-graph/architecture 内容 hash 和版本、effective policy、base commit、branch/worktree、Provider/Agent/plugin/capability、预算、actor、过期和撤销状态；高影响动作在执行前重新校验 fingerprint。
- **放弃的方案：** 只存一个批准布尔值，或让执行器根据当前内存对象猜测用户批准了什么。
- **取舍：** 授权对象和失效规则更复杂；换取计划、分支、策略、插件或能力漂移后不会复用旧批准。
- **后果：** 需要 generation fence、CAS、过期/撤销、精确目标和 read-back；`approved` 只能是投影字段，不能独立授予执行权。
- **来源：** [S5 §14.1–§14.2]；[S9 Task 3–Task 7]；[S10 §6 Phase A、§7]。

### ADR-SM-036：全局/项目/Run 偏好与一次性执行授权分离

- **状态：** `设计基线`
- **决定：** 全局设置提供默认值；项目策略可以覆盖全局；Run 可以临时覆盖；每个 Run 固化 effective policy。用户一次明确接受同一 scope 的高风险偏好后可以减少重复打断，但发生目标、branch、worktree、plugin、capability、预算或 policy hash 变化时必须重新确认。
- **放弃的方案：** 把偏好写进 Memory 并让它永久扩大权限，或每个低风险 Run 都重复完整审批。
- **取舍：** 需要策略继承、来源显示、撤销和 fence；换取自动化便利与高风险授权边界同时保留。
- **后果：** 自动 push 只限当前非 protected branch，禁止 force push/release/delete；用户可以撤回 Agent 的 merge delegation，撤回后未领取动作必须失效。
- **来源：** [S5 §0、§7.3、§8.2、§14.2]；[S3 §11、§14.2]。

### ADR-SM-037：副作用采用 intent → started → receipt/unknown，不以进程退出或模型文本代替事实

- **状态：** `共同共识`
- **决定：** 文件写入、测试、外部调用、push、merge、release 和 cleanup 先登记 intent，再登记 started，最后由宿主写入明确 Receipt 或 `unknown`；无法证明结果时停止而不是猜测。
- **放弃的方案：** 只看 Agent 最终回复、进程 exit 0、单条 UI 文案或普通 output 是否存在。
- **取舍：** 每个副作用都有 ledger、idempotency 和 reconcile 成本；换取崩溃、中断、超时和部分成功不会被错误重跑或伪装成功。
- **后果：** `SideEffectUnknown` 进入恢复向导；没有明确幂等和结果证明时禁止自动 retry；Receipt 绑定 target、input/policy hash、lineage 和 host observation。
- **来源：** [S1 §3.4、§6、§9]；[S2 §8]；[S3 §14.5]；[S5 §14.5]。

### ADR-SM-038：独立任务失败后继续无依赖任务，依赖任务阻塞，Run 表达 partial

- **状态：** `共同共识`
- **决定：** Scheduler 允许不依赖失败任务的任务继续；依赖失败的任务进入 `blocked`；Run 在存在部分成功和部分失败时进入 `partial`，不能伪装 `succeeded`。
- **放弃的方案：** 任一任务失败就全局停止，或只要有一个任务完成就把整个 Run 标为成功。
- **取舍：** 调度和用户解释更复杂；换取大项目并行吞吐和失败隔离，避免一个局部问题浪费已可独立完成的工作。
- **后果：** 失败、blocked 和 partial 必须回流 Issue/Recovery；`succeeded` 必须有完整 Evidence 和 Acceptance。
- **来源：** [S5 §0、§7.1、§11]；[S3 §5、§12]。

### ADR-SM-039：Provider fallback 保留已验证进度，不让新模型无条件接管代码现场

- **状态：** `设计基线`
- **决定：** 已通过宿主验收的 Task、Artifact、Evidence 和 checkpoint 保留；未完成代码 Attempt 先读取真实 diff/test/receipt，再创建新 Attempt；普通只读调用可以沿候选链 fallback，代码 Worker 不能无条件切换模型接管原 worktree。
- **放弃的方案：** Provider 不可用时直接把同一 worktree 和未验证状态交给任意新模型。
- **取舍：** 连续性和自动恢复变慢；换取不同模型的假设不会互相污染，已完成进度不会被重做或覆盖。
- **后果：** retry 使用新的 attempt/worktree/side-effect key；部分修改自动编译成可消费 checkpoint 仍需后续实现。
- **来源：** [S2 §9]；[S3 §14.6]；[S5 §14.3]。

### ADR-SM-040：Delivery 与 Cleanup 分离，成功 worktree 默认保留到明确批准

- **状态：** `共同共识`
- **决定：** 交付是验证、用户审查和目标文件落盘；Cleanup 是独立的破坏性动作，必须使用当前 Task/Run/Attempt/Worktree/Branch/Acceptance 的 proposal、approval、CAS 和 Receipt。成功 worktree 未经用户明确批准不清理。
- **放弃的方案：** 交付成功后自动删除 worktree，或用裸 Git 命令替代 cleanup protocol。
- **取舍：** 临时资源可能保留更久，清理流程更繁琐；换取用户可检查现场、失败可恢复、历史证据和错误交付不会被清理动作一并抹掉。
- **后果：** cleanup token/fingerprint 必须一次性、可失效、绑定 generation/path/branch/revision；部分失败、drift、session change 和 unknown 都要拒绝或进入 recovery。
- **来源：** [S7 §2.3、§8]；[S9 Task 5–Task 8]；[S10 §6 Phase I、§7]；用户已确认的 cleanup 约束。

### ADR-SM-041：资源、集成和恢复的确定性部分优先下沉到 Control Plane

- **状态：** `已纳入计划`
- **决定：** scheduler、budget、quota、lease、并发、Evidence index、基础 summary projection、side-effect reconciliation 和 recovery orchestration 优先由确定性 Control Plane 提供；需要判断的架构、风险、集成和复盘才按需启动 Agent。
- **放弃的方案：** 让一个“Operations Agent”凭自然语言决定预算、重试、租约、清理或恢复。
- **取舍：** Control Plane 需要更严格的状态机和边界测试；换取关键安全约束不依赖模型自律，Agent 数量和 token 消耗也更可控。
- **后果：** Operations/Recovery Manager 可以提出方案，但不能静默重跑 destructive action 或改变项目目标；Integration/Release Manager 可以形成候选，但不能替代 QA/Security gate。
- **来源：** [S3 §7.3]；[S5 §7、§12]；[S10 §1.3、§6 Phase C/I]。

### ADR-SM-042：凭据只使用宿主托管的 handle，原文不得进入项目事实或普通日志

- **状态：** `共同共识`
- **决定：** Provider/Auth 由宿主管理；事件、ProjectFile、Workflow、Evidence、Receipt 和可共享日志不得保存 API key、OAuth token、Cookie、完整环境变量、Bearer 值、私钥、密码或连接字符串；发现凭据时统一使用 `[REDACTED]`。
- **放弃的方案：** 为了方便调试把明文 credential 写入 workflow、事件或共享文档。
- **取舍：** 调试和迁移需要额外的安全诊断路径；换取项目档案、Agent 上下文和开发日志不会扩散凭据。
- **后果：** Auth adapter 只能返回受控能力和 credential handle；原始日志在提交或共享前必须脱敏并重新扫描。
- **来源：** [S5 §3.1、§4]；[S11 §1–§4]；[S12 §44–§53]；用户明确的凭据安全要求。

### ADR-SM-043：Node 与 Tauri/Rust 必须执行同一套宿主权限契约

- **状态：** `已实现但未完全验证`
- **决定：** Node capability、Tauri runner 和 Rust command gate 对 path、branch、worktree registration、generation、lease、cleanup、命令白名单和 case-fold/component-boundary 使用同一语义；通用 `dev_exec` 不得成为 registered Worker target 的隐形 mutation 入口。
- **放弃的方案：** 只在 TypeScript 做 proposal/fingerprint 检查，或让 Rust 接受前端传来的任意 path/raw fingerprint。
- **取舍：** 双宿主实现和回归矩阵更复杂；换取前端绕过控制面或 native path 漂移不会打开破坏性写权限。
- **后果：** 正常 cleanup 使用窄权限专用 host command；registration 需要真实 pending lease 和 Git identity；drift、unknown、CAS/remove/session 失败都使旧 capability 失效。
- **来源：** [S4 §4.3、§11.3]；[S9 Task 4–Task 7]；[S10 §6 Phase E/I]；Phase 2 native hardening 记录见 `docs/DEVELOPMENT_LOG.md`。

### ADR-SM-044：测试 fixture、运行日志和 Evidence 必须位于专有根目录且隔离于真实项目

- **状态：** `共同共识`
- **决定：** 真实 Tauri 验收只使用仓库外的 disposable Git fixture；每个 case 的 fixture、worktree、runtime 数据、日志、Evidence、Acceptance、Receipt 和报告都位于专有 case 根目录；禁止修改 `D:/Agents/SMtest`，禁止在仓库根散落临时目录。
- **放弃的方案：** 在真实项目或仓库根直接运行验收，并依赖测试作者逐个清理临时文件。
- **取舍：** fixture 创建和收尾更麻烦；换取项目隔离、失败现场可复查、测试结果不会污染生产项目或 Git 工作树。
- **后果：** cleanup 必须限定精确根目录和名称模式；空目录、符号链接、非空目录和未知生成物都要 fail-closed；历史失败现场不能为方便复跑而擅自删除。
- **来源：** [S7 §2.3–§2.4、§5、§8]；[S9 §Current Context、Task 2–Task 5]；用户明确的项目隔离和验收约束。

### ADR-SM-045：真实 GUI、宿主、磁盘和 Git read-back 高于 headless 或单元测试的单独通过

- **状态：** `共同共识`
- **决定：** Tauri Worker 验收必须分别核对真实窗口/WebView、Rust host、ProjectFile/event stream、Evidence/Acceptance/Receipt、side-effect journal、Git worktree/branch/status 和目标文件；headless exit 0、窗口出现、单条截图或模型自报都不足以宣称成功。
- **放弃的方案：** 用 Vitest、headless 脚本、进程仍在运行或 UI 文案替代完整端到端证据。
- **取舍：** 验收速度降低、环境依赖增加；换取“代码路径通过但桌面真实路径失败”的问题可见。
- **后果：** GUI 成功路径、失败路径、restart/recovery、cleanup 和独立 reviewer 必须在相同或明确标注的 snapshot 上验证；未完成时控制面保持 `mvp-closed-unverified`。
- **来源：** [S2 §6、§12]；[S7 §1、§8–§9]；[S9 §Current Context、Task 3–Task 8]；用户已确认的真实 Tauri 验收规则。

### ADR-SM-046：Reviewer 必须独立、针对 exact snapshot，并 fail-closed

- **状态：** `共同共识`
- **决定：** reviewer verdict 只适用于明确的 HEAD/staged snapshot；`passed=false`、security concern、logic error、strict JSON 缺失、API 失败、interrupted、截断或 snapshot drift 都不能标记 `[verified]`。修改后必须重新审查，旧 verdict 不能迁移。
- **放弃的方案：** 依据 reviewer 的自然语言“看起来完成”、旧 commit verdict 或单元测试绿色标记安全通过。
- **取舍：** reviewer 可能因超时、环境或格式问题导致流程暂停；换取高影响执行不会依赖不可验证的自报 approval。
- **后果：** 可以提交明确标注 `unverified` 的本地 checkpoint，但不能宣称生产级 verified、push 或 merge 已安全完成。
- **来源：** [S4 §11.3]；[S7 §8–§9]；[S9 Task 8]；[S10 §7]；用户明确的 reviewer fail-closed 要求。

---

## 5. 实施顺序、验证和文档治理

### ADR-SM-047：先证明 Evidence → 交付 → 恢复，再扩大自治、节点和生态

- **状态：** `共同共识`
- **决定：** 近期优先级是：真实隔离项目的 Worker/worktree 闭环、宿主验收、Evidence、用户交付、失败/恢复和重启一致性；之后才扩大 ContextPack、能力注册、多 Worker、持续运维、更多 Provider、节点和外部自动化。
- **放弃的方案：** 先做更多漂亮 UI、连接器、模型和自由 DAG，之后再补事实源、权限和恢复。
- **取舍：** 短期可见功能增长较慢；换取核心信任闭环先被真实任务证明，避免在不可靠基础上堆叠自治。
- **后果：** 每个垂直切片都必须声明事实源、命令入口、投影、Evidence、恢复方式和停止条件；`mvp-closed-unverified` 不能被质量门数字替代。
- **来源：** [S2 §12]；[S3 §15–§16]；[S5 §10、§14.7]；[S9 §Immediate Priority]；[S10 §6–§7]。

### ADR-SM-048：Zod 采用窄范围后置迁移，而不是立即替换全部 TypeScript 类型

- **状态：** `建议待确认`
- **决定：** 先稳定 Evidence、Acceptance、Receipt、WorkerQueue/recovery、ProjectFile/TaskGraph/Event、ContextPack、Delegation 和 Feedback 等外部不可信边界，再在这些边界引入 Zod；不要求全量替换内部类型。
- **放弃的方案：** 在协议、失败矩阵和 legacy schema 尚未稳定前全量迁移。
- **取舍：** 早期 runtime validation 覆盖范围较小；换取迁移冲突、包体积、旧数据兼容和重复类型维护风险可控。
- **后果：** malformed external record 进入 `needs-repair/recovery`；每次新增 schema 必须说明收益、边界和迁移风险。
- **来源：** [S5 §6、§10]；[S9 Task 7、§Risks and Tradeoffs]；[S10 Phase J]；用户已确认的 Zod 后置原则。

### ADR-SM-049：开发采用本地 checkpoint 和选择性暂存，不自动 push/merge 或纳入无关素材

- **状态：** `共同共识`
- **决定：** 新一轮代码或架构/文档推进前先检查状态并建立范围明确的本地 checkpoint；只暂存当前工作范围；保留无关未跟踪图标、设计素材、原始日志和敏感文件；未经明确授权不 push、merge 或清理成功 worktree。
- **放弃的方案：** `git add .`、直接在未备份工作树上推进、把无关素材一起提交，或把本地完成自动当成远程交付。
- **取舍：** 提交和收尾步骤更慢；换取用户素材、历史证据和未完成现场不被误删，代码变化始终可回退。
- **后果：** checkpoint 只证明本地快照，不代表 reviewer 通过、远程 push 或生产 merge；计划和验证文档也不能覆盖历史事实。
- **来源：** [S5 §1、§13]；[S9 §Current Context、Task 1、Task 8]；[S10 §0、§6]；用户明确的 checkpoint/push/merge 约定。

### ADR-SM-050：使用分层文档权威，新增本记录作为跨阶段“为什么”索引

- **状态：** `共同共识`
- **决定：** 产品原则、战略判断、架构契约、专题设计、计划、验证和开发历史各司其职；本文件集中记录跨阶段的决定、替代方案、取舍和后果。当前计划保留阶段性 open decisions，但不再承担全部历史决策记录。
- **放弃的方案：** 把产品方向、当前实现、实施顺序和历史验证混在一个不断重写的计划里，或让原始对话成为隐式规范。
- **取舍：** 需要维护文档之间的单向链接和状态同步；换取设计理由不会随着计划改版、代码迁移或历史文档归档而丢失。
- **后果：** 新决定先进入 `Proposed`，用户确认后转为 `共同共识`/`设计基线`；实现完成仍需由源码、测试、宿主 Evidence 或开发日志单独证明。
- **来源：** [S12 §1–§3、§55–§69、§98–§105]；[S1 §0]；本次文档建立决定。

### ADR-SM-051：Git Worktree 是代码状态与谱系的第二事实源，不是任务成功事实源

- **状态：** `共同共识`
- **决定：** Git 的 branch、commit、tree、parent、merge-base、diff、worktree 状态和分叉/合并关系，作为独立于 Control Plane 的代码事实观察源。Control Plane 仍负责任务意图、权限、Decision、Task/Attempt 和生命周期；Host Evidence/Acceptance/Receipt 负责执行、可交付性和外部副作用事实。
- **放弃的方案：** 让 Git branch/commit 存在直接代表 Task 成功、Acceptance 通过、Delivery 批准或 Cleanup 可执行；或把 Git 只当作 Worker 的临时内部目录。
- **取舍：** 需要保存 GitObservation、Control Plane 和 Evidence 之间的 lineage 并处理观察漂移；换取用户可以通过自己的 IDE 看到真实施工分叉、历史修改和合并关系，上层节点也能独立复查代码状态。
- **后果：** `GitObservation` 必须区分 declared、observed、accepted、delivered；任何成功结论必须同时引用相应的 Task/Attempt、Evidence、Acceptance 和 Receipt。GitObservation 只能证明代码状态，不能单独证明任务完成。
- **来源：** [S3 §4、§7、§14]；[S16]。

### ADR-SM-052：以 ChangeSet 作为跨仓库施工和交付的一级对象

- **状态：** `已纳入计划`
- **决定：** `ChangeSet` 连接一个 Task/TaskExecution/Attempt 与一个或多个 `RepositoryComponent`，每个 component 记录 repository、baseRevision、local worktree/branch、head、remote branch/PR、GitObservation、Evidence、Acceptance 和 Delivery 引用。Worktree 是本地施工现场的 materialization，不再承担跨仓库语义；现有 Task/Attempt 仍是任务事实，不建立第二套任务系统。
- **放弃的方案：** 以单个 Worktree 作为所有施工语义的中心，或把 GitHub PR 直接当作 Task；每个仓库、Issue、PR 各自维护一套任务状态。
- **取舍：** 数据模型、跨 component lineage 和集成状态更复杂；换取一个任务可以明确表达前端、后端、基础设施等多仓库变化，并能把本地和远端对象关联起来。
- **后果：** ChangeSet 需要独立状态、scope、digest、acceptancePolicy 和 integrationPolicy；组件局部成功不能自动升级为整个 ChangeSet 成功。
- **来源：** [S3 §4、§9、§14]；[S16]；[S17 Phase 0、Phase 5]。

### ADR-SM-053：Repository Registry 与 Project 采用多对多引用，不复制仓库事实

- **状态：** `已纳入计划`
- **决定：** `Repository` 是带 provider、外部身份、默认分支、ref/branch policy 和权限边界的可复用资源；Project 通过显式引用和 role 使用一个或多个 Repository，同一个 Repository 可以被多个 Project 引用。Project 保存关系、策略和 ChangeSet 引用，不复制完整 Git 历史或远端状态。
- **放弃的方案：** 一个 Project 只能绑定一个仓库，或每个 Project 复制一份仓库/PR/branch 事实。
- **取舍：** 需要处理仓库共享、权限隔离、不同 Project 的 branch policy 和外部 provider 变更；换取 monorepo、polyrepo、共享基础库和跨项目依赖可以使用统一控制面。
- **后果：** Repository identity、Project scope 和 ChangeSet component 必须分别验证；Project 不能因为拥有 Repository 引用就自动获得 push、merge 或删除远端分支权限。
- **来源：** [S16]；[S17 Phase 0、Phase 5]。

### ADR-SM-054：LocalGitObservation 与 RemoteObservation 分离

- **状态：** `已纳入计划`
- **决定：** 本地 Git/worktree 观察与 GitHub 等 provider 的远端观察使用不同类型和不同信任边界：`LocalGitObservation` 记录本地 ref/tree/worktree/diff；`RemoteObservation` 记录 remote ref、PR、check、review、branch protection 和 provider 返回状态。二者通过 repository、commit SHA、ChangeSet component 和 observedAt 关联，但不互相冒充。
- **放弃的方案：** 将 GitHub PR 状态直接写成内部 Delivery 状态，或把本地 Git 命令结果当成远端已经接受的事实。
- **取舍：** 需要处理最终一致、stale、webhook 丢失、轮询补偿、provider API 版本和权限不足；换取远端状态变化不会静默污染本地控制面。
- **后果：** 外部观察必须带 provider、externalId、sourceVersion、observedAt、commit/ref 和 digest；过期或不完整的观察进入 stale/unknown/reconciliation，不能直接通过高影响 gate。
- **来源：** [S16]；[S17 Phase 0、Phase 3]。

### ADR-SM-055：GitHub 是远端协作投影和观察源，不建立第二套控制面

- **状态：** `已纳入计划`
- **决定：** GitHub Issue、Pull Request、Review、CheckRun、branch protection 和远端 branch 作为外部协作对象及其观察结果，通过稳定 external reference 映射到内部 Project/Issue/ChangeSet/Acceptance/Delivery；SlimeMold Control Plane 仍是任务意图、权限、预算、Decision 和生命周期的事实源。
- **放弃的方案：** 让 GitHub Issue、PR board 或 CI 状态与 SlimeMold 各自成为任务系统，再靠标题、评论或自然语言同步。
- **取舍：** 需要维护映射、外部删除/重开/转移/force-push 和 provider drift；换取远端生态可用而不牺牲内部可审计性。
- **后果：** GitHub 评论、Issue 描述、PR 描述、webhook payload 和 CI 输出都是不可信输入；它们必须经过 schema、scope、commit 和权限检查，不能直接改变内部 Task、Acceptance 或授权。
- **来源：** [S3 §4、§6、§9]；[S16]；[S17 Phase 3]。

### ADR-SM-056：远端副作用采用 External Operation Ledger 和 read-back

- **状态：** `已纳入计划`
- **决定：** push branch、create/update PR、request review、rerun check、merge、close PR 和 delete remote branch 等操作，统一登记 `ExternalOperation`，经过 `planned → authorized → started → provider-observed → receipt`；provider API 返回成功不等于操作已完成，必须按预期状态 read-back。
- **放弃的方案：** 仅依赖 SDK/API 的成功返回、Agent 最终文本或 webhook 到达来宣布远端操作成功；或让 Agent 直接持有并使用 GitHub token。
- **取舍：** 需要幂等键、请求 digest、provider receipt、重试和 unknown/recovery 状态；换取网络超时、部分成功、重复请求和 provider 最终一致不会被误判或盲目重跑。
- **后果：** merge read-back 至少要核对 PR merged 状态、merge commit SHA、目标分支 head、源 head、required checks 和 review policy；unknown 时停止高影响 retry，交给 reconciliation/recovery。
- **来源：** ADR-SM-037；[S11]；[S16]；[S17 Phase 4]。

### ADR-SM-057：多仓库交付采用 Integration Saga，不假装存在跨仓库原子事务

- **状态：** `已纳入计划`
- **决定：** 跨多个 Repository 的 ChangeSet 采用显式 `IntegrationPlan`/`IntegrationAttempt`/`MergeOrder`/`CompensationPolicy` 协调；准备、分支/PR、检查、审阅、按序合并和逐仓库 read-back 都是可恢复阶段。任一组件失败时，整体进入 `integration-partial` 或 recovery，而不是伪造全局 rollback。
- **放弃的方案：** 把多个 GitHub merge 当作一个原子事务，或前一个仓库已合并后自动宣称其它仓库也已回滚。
- **取舍：** 用户需要理解部分交付和兼容窗口，恢复、补偿和依赖编排成本更高；换取系统不会隐藏真实的跨仓库部分成功，也不会对已经被其他提交依赖的合并执行不安全回滚。
- **后果：** merge 顺序、依赖、兼容性检查、补偿权限和人工接管条件必须显式记录；目标分支漂移或冲突创建新的 Integration/Delivery Attempt，不改写原 Worker branch。
- **来源：** ADR-SM-033、ADR-SM-037；[S16]；[S17 Phase 5]。

### ADR-SM-058：建立版本化架构协议，禁止静默改变跨边界语义

- **状态：** `已纳入计划`
- **决定：** 在实现 ChangeSet/GitHub 写操作前，建立统一的 `SlimeMold ChangeSet & External Repository Protocol v1`（暂定名称）作为跨阶段协议，覆盖 `Repository`、`ChangeSet`、`ChangeSetComponent`、`Worktree`、`GitObservation`、`RemoteObservation`、`ExternalOperation`、`IntegrationAttempt`、`Evidence`、`Acceptance`、`Receipt` 和 `CouncilDecision` 的身份、版本、状态、lineage、来源、digest、trust level、权限和恢复语义。
- **放弃的方案：** 让各个 TypeScript 类型、事件、GitHub adapter 和 UI 各自增加 `version`，但没有统一协议、兼容矩阵和迁移规则；或用文档的静默编辑改变旧事实的解释。
- **取舍：** 需要维护 protocol version、object schema version、event version、policy version、provider/API/tool version 的多层版本，并为旧事件、旧 ProjectFile 和旧 observation 编写 migration/conformance vectors；换取旧快照可读、可回放、可解释，外部 provider 变化不会悄悄改写历史含义。
- **后果：** major 版本不兼容时必须迁移或拒绝；minor 版本只能做兼容扩展；未知字段、版本漂移、digest 不匹配、dangling reference 和无法迁移的数据必须 fail-closed 或进入 `needs-repair/recovery`。协议一旦被 runtime 使用，任何语义改变都必须产生新版本或显式 migration。
- **状态边界：** 当前只是已纳入计划，协议文档、版本常量、兼容矩阵和 conformance fixtures 尚未实现；它不能被写成当前代码已经支持的能力。
- **来源：** ADR-SM-012、ADR-SM-013、ADR-SM-015；[S16]；[S17 “必须先建立的版本化架构协议”、Phase 0]。

### ADR-SM-059：议会和 Agent 默认使用 snapshot-bound Context Gateway

- **状态：** `共同共识`
- **决定：** Council 成员和执行 Agent 默认通过绑定 `snapshotId/observationId/baseRevision/headRevision/role/scope/budget` 的有界读取接口获取代码和证据；用户自己的 IDE 可以直接读取真实 branch/worktree，但 Agent 不能直接混用 live mutable worktree。
- **放弃的方案：** 议会成员自由读取 live worktree，或只记录最后引用范围而不冻结审阅版本。
- **取舍：** Context Gateway、索引、预算和 ContextRequest 增加系统成本；换取同一轮审阅基于同一版本、读取范围可审计、token/文件范围可控，live 变化会使快照失效而不是污染结论。
- **后果：** 返回内容必须带路径、范围、digest 和 snapshotId；需要扩展范围必须提出受控请求；Security 只能收到脱敏配置视图，原始 secret 永远留在宿主信任域。
- **来源：** ADR-SM-026、ADR-SM-027、ADR-SM-028、ADR-SM-042；[S16]；[S17 Phase 6]。

### ADR-SM-060：GitObservation 采用实时轻量观察与里程碑完整快照的混合策略

- **状态：** `共同共识`
- **决定：** branch HEAD、dirty 状态、文件数量和简要 digest 采用低成本、去抖动的轻量观察；TaskStarted、宿主观察到 Worker commit、Acceptance、Council snapshot、Delivery 和 Recovery 等里程碑生成不可变完整 GitObservation。Council 只使用稳定快照，快照建立后 branch 变化必须使其失效或重新建立。
- **放弃的方案：** 每个 commit 都保存完整 diff/blob，或只在任务结束时观察 Git。
- **取舍：** 实时 UI 仍需接受轻量观察的 stale/延迟，完整快照和内容寻址 artifact 需要异步存储；换取大项目不会因重复复制 diff/blob 失控，同时重要决策节点具备可重建证据。
- **后果：** UI 可以显示 live/stale 状态，但不得把 live metadata 当作审阅快照；artifact 使用 digest 去重，查询按文件、提交、diff 和 token 预算有界执行。
- **来源：** [S16]；[S17 Snapshot/Context、Phase 1、Phase 7]。

### ADR-SM-061：Worker commit 保留 author，宿主固定 committer 并绑定 Attempt trailers

- **状态：** `共同共识`
- **决定：** Worker 可以保留可识别的 author；committer 由 SlimeMold 宿主固定；commit 必须写入 `Run`、`Task`、`Attempt` 和 `baseRevision` trailers。宿主验证父链、内容、分支、baseRevision 和归属关系，不能仅信任 author name、时间或 commit message。
- **放弃的方案：** 让 Worker 同时自由设置 author/committer 并把作者自报当作任务归属，或由宿主完全重建 commit 而丢失 Worker 施工身份。
- **取舍：** Git identity、host key/config 和跨机器复现需要额外治理；换取用户 IDE 仍能看到 Worker 归属，同时 commit 写入主体和任务关联可由宿主审计。
- **后果：** author 不等于授权主体，trailer 不等于 Acceptance；真正的成功仍须由 Host Evidence、Acceptance 和 Receipt 证明。
- **来源：** [S16]。

### ADR-SM-062：交付后保留 branch/worktree，目标漂移创建新 Integration Attempt

- **状态：** `共同共识`
- **决定：** 交付后默认保留 Worker branch、commit 历史和物理 Worktree，只有用户明确批准 Cleanup 才清理。Worker 通过 Acceptance 后，如果目标分支从 `baseRevision=A` 漂移到 `B`，不 rebase 或改写原 Worker branch；停止当前 Delivery，建立新的 Integration/Delivery Attempt，重新计算 merge-base、冲突和测试。
- **放弃的方案：** 自动 rebase、force-update Worker branch、交付成功后立即清理，或把旧 Acceptance 直接套用到新目标分支。
- **取舍：** 磁盘占用、保留策略和用户选择成本增加；换取原始施工证据不被覆盖，目标漂移不会把旧验收误用于新集成目标。
- **后果：** Cleanup 是独立 destructive operation，必须拥有当前 generation、path、branch、revision、Acceptance 和用户批准；分支保留不等于可以自动 merge 或 push。
- **来源：** ADR-SM-040；[S16]。

### ADR-SM-063：远端 Security Agent 只接触脱敏配置，凭据留在宿主信任域

- **状态：** `共同共识`
- **决定：** Security Agent 可以检查字段名、存在性、来源、格式、权限和 digest，但不能读取 API key、token、密码、私钥、Bearer 值、Cookie、连接字符串或其它 secret 原文。GitHub connector 使用宿主托管的 credential handle，原始凭据不进入 Agent Context、DomainEvent、Evidence、Receipt 或共享日志。
- **放弃的方案：** 为了让 Security Agent“完整判断”而把原始 secret 暴露给模型，或让 Agent 直接持有远端 token。
- **取舍：** 某些需要 secret 内容的诊断必须由宿主确定性检查或人工完成，模型的可见信息减少；换取远端生态扩展不会扩大凭据泄露面。
- **后果：** secret 发现、格式检查和权限检查产生脱敏 Evidence；任何日志或 artifact 命中凭据形状都必须写作 `[REDACTED]` 并进入安全处理路径。
- **来源：** ADR-SM-042；[S11]；[S16]。

### ADR-SM-064：Council 成员可配置，批准目标是共识而非单一成员权威

- **状态：** `共同共识`
- **决定：** 用户可以指定默认 Council；未指定时按 benchmark 中架构理解、漏洞发现和开发安全等相关领域选择候选成员。批准不能依赖某一个成员的单独判断；与用户需求相去甚远的行为、越权行为或需要修改系统文件/环境设置的行为属于硬风险候选，可触发一票否决。相同模型只有在上下文不共享、互不知道对方身份且被分配不同视角时，才可作为多个独立审阅角色。
- **放弃的方案：** 固定不可替换的模型名单、单一“强模型”拥有最终批准权，或把同一上下文的多次生成伪装成独立共识。
- **取舍：** benchmark 新鲜度、模型相关性、权重、公平性和 veto 精度需要额外治理；换取议会成员可以适应项目领域，且决策不依赖单点模型失误。
- **后果：** 主控 Agent 和用户可以修改议会成员；议会不能修改自己的权限边界；benchmark 版本、成员、角色、权重和规则必须进入 Decision Snapshot。具体 quorum、权重和 Security veto 分类仍是开放协议问题。
- **来源：** ADR-SM-030；[S16]。

### ADR-SM-065：Council 配置采用 Global → Project → Decision Snapshot 并在决策开始时冻结

- **状态：** `共同共识`
- **决定：** 新任务默认继承 `Global Council Default`，项目可以通过 `Project Council Override` 覆盖，具体议会启动时生成不可变 `Decision-time Council Snapshot`。议会进行中修改成员、benchmark 版本、权重或规则只影响后续议会，不改变历史决策的解释。
- **放弃的方案：** 在同一轮审议中热更成员或权重，或只保存最终票而不保存当时的配置。
- **取舍：** 需要保存配置版本、继承来源、有效时间和 snapshot digest；换取历史决策可复现，后续模型/benchmark 更新不会 retroactively 改变旧结论。
- **后果：** Council 结果必须引用 exact configuration snapshot；配置修改权限、弃权/quorum 和 benchmark 权重的最终公式仍需另行决策。
- **来源：** ADR-SM-013、ADR-SM-030；[S16]。

### ADR-SM-066：Worktree/GitObservation 性能数字先作为 provisional guardrails，不作为永久架构承诺

- **状态：** `已纳入计划`
- **决定：** 初版采用可测量的暂定 guardrails：active Worker worktree 默认 8、项目上限 32；中型仓库轻量观察目标 p95 小于 500ms、完整快照目标 p95 小于 10s；磁盘剩余 20% 报警，10% 或 10GB 停止新增高副作用 Worker，5% 或 5GB 停止 worktree allocation 和 snapshot blob 写入。真实 benchmark 后可以通过新版本化配置/Decision 调整。
- **放弃的方案：** 在没有仓库规模、Windows 冷热缓存和多 worktree 数据的情况下声称固定容量，或磁盘不足时自动删除 Evidence、Acceptance、Receipt、unknown、quarantined 和用户 pin 内容。
- **取舍：** 初始数字可能保守或不适用于所有项目，需要 benchmark 和用户可见的限流；换取“大项目支持”先成为可观察的性能目标，而不是无证据承诺。
- **后果：** 必须 benchmark 1 万/10 万/100 万级文件、8/32/64 worktree、冷/热缓存、untracked scan、完整 snapshot 和 Windows 长路径；guardrail 变更必须保留版本和原因。
- **来源：** [S16]；[S17 Phase 7]。

### ADR-SM-067：先完成协议和 GitHub read-only observation，再逐步开放远端写操作

- **状态：** `已纳入计划`
- **决定：** 生态扩展顺序为：版本化协议与 conformance fixtures → 本地 GitObservation → GitHub read-only adapter → External Operation Ledger → push/PR/review → 多仓库 Integration Saga → merge/release/delete 等高影响操作。没有协议版本、兼容矩阵、read-back 和失败恢复，不改变 Worker 成功语义，也不开放远端高影响写操作。
- **放弃的方案：** 先实现 GitHub push/merge，再补内部事实、协议和恢复；或把 provider API 的成功返回当成系统已经交付。
- **取舍：** 早期可见的生态功能更少，协议和 fixture 工作占比更高；换取外部副作用不会先于本地事实、权限和恢复能力成熟。
- **后果：** 每个外部写操作独立 checkpoint、测试和 receipt；当前总体状态继续保持 `mvp-closed-unverified`，未经明确授权不 push、merge 或清理。
- **来源：** ADR-SM-037、ADR-SM-047、ADR-SM-049；[S16]；[S17]。

### ADR-SM-068：执行引擎采用分阶段纯内核抽取，不进行一次性重写

- **状态：** `已实现但未完全验证`
- **决定：** 执行引擎按“确定性计划编译 → 调度状态机 → Runtime/Host Adapter → 控制面持久化与恢复”的顺序渐进拆分。第一阶段先把图展开、执行集、重试范围、层级冲突簇和循环上限抽为无 store、无 I/O 的 `ExecutionKernel`；现有 `executor` 暂时继续拥有节点副作用、缓存失效、运行事件、状态写回和收尾。
- **放弃的方案：** 立即重写 `executor`/`workflowStore`/`WorkerQueue`，或把执行引擎拆成多个进程/微服务；也不把 WorkerQueue 变成第二套执行引擎。
- **取舍：** 迁移期会保留旧 executor 和新纯计划边界，短期仍存在双轨运行时；换取每一刀都能通过现有行为回归、真实 Tauri 闭环不被重构噪声掩盖，并允许后续把 Worker、Headless 和 Tauri 接到同一套确定性状态语义。
- **后果：** 新的 ChangeSet/GitHub/远端副作用不得直接进入 `ExecutionKernel`；只有在最小真实 Tauri 成功、失败/恢复路径和 lineage 契约稳定后，才继续抽离 Host Adapter、Evidence/Acceptance/Receipt 和 ProjectControl 持久化边界。
- **来源：** [S14] `docs/DEVELOPMENT_LOG.md` §7.108；用户确认开始执行引擎渐进拆分；当前实现为 `src/engine/executionKernel.ts`。

---

## 6. 当前仍未决定或不能过度宣称的事项

以下问题已经被记录为待确认或后续协议工作，不能从本文件中的“决定”条目推断为最终实现：

1. `Project Delivery Architect` 的最终正式名称，是 `Project Delivery Architect`、`Solution Architect`、`Program Architect` 还是中文“项目总设计与承建”；
2. Department Head 与 Project Delivery Architect 的最终批准边界，以及哪些跨部门变更必须回到 CEO/用户；
3. 横向角色哪些常驻为 Control Plane 服务，哪些只在 QA、Security、Integration、Recovery 节点按需启动；
4. Department 能力池、项目 Work Package 和 Agent 租约之间的最终矩阵数据模型；
5. 多模型 Review Board 的具体触发阈值、参与模型、轮数、EvidencePack 冻结方式、arbiter 规则和用户批准边界；
6. Workflow 图节点与 canonical TaskGraph 节点的完整一一映射；
7. 完整 ProjectControl event source、旧 `workflowStore`/executor cutover、跨文件事务和多实例 execution lease；
8. 通用文档、配置、设计资产、3D 资产的完整 Artifact acceptance contract；
9. 真实 Tauri disposable GUI → Worker → Acceptance → Delivery → Cleanup → Restart 的最终快照 reviewer `passed=true`；
10. Zod 的具体包范围、schema version 和 legacy migration 实施方案；
11. `SlimeMold ChangeSet & External Repository Protocol v1` 的正式命名、稳定 schema、事件/对象版本划分、兼容矩阵和旧数据迁移实现；
12. ChangeSet、Repository、RepositoryComponent 与现有 Project/Task/TaskExecution/Attempt 的最终字段和持久化布局；
13. GitHub provider 的认证方式、Project/Repository 权限映射、webhook 与轮询补偿、rate-limit 和 provider version 策略；
14. ExternalOperation 的具体幂等键、unknown recovery、重试上限以及 push/PR/merge/delete 的逐项批准边界；
15. 多仓库 Integration Saga 的 merge order、兼容性检查、compensation 是否允许自动执行，以及 `integration-partial` 的用户恢复流程；
16. Council 的 quorum、弃权、缺席成员、benchmark 权重归一化、同模型角色的相关性上限和 Security veto 精确分类；
17. 主控 Agent 修改 Council 成员或规则是否需要用户批准，以及 Council 三轮未达成共识后的成员替换权限；
18. GitObservation 快照的物理存储、artifact 加密/备份/跨机器恢复、成功/失败/unknown/quarantined 的 GC 和磁盘预算细节；
19. provisional 性能 guardrails 的真实 benchmark 结果，以及它们是否需要按仓库规模、操作系统或 provider 分层。

### 6.1 重新审议触发条件

任一以下变化都应新建或 supersede 对应 ADR，而不是静默编辑历史决定：

- 用户目标、非目标、预算或风险接受度发生变化；
- 事实源、Task/Attempt identity、权限模型或审批边界发生变化；
- 计划 revision 改变跨部门接口或 Acceptance；
- 真实 Tauri、独立 reviewer 或 benchmark 证明当前取舍不成立；
- 新 Provider、插件、Runtime 或外部副作用打破现有 host contract；
- 实际 token、延迟、成本、恢复成功率或审计完整度显示取舍代价超出接受范围。

---

## 7. 来源索引

- **[S1]** `docs/principles/SLIMEMOLD_PRODUCT_PHILOSOPHY.md`：用户原始哲学、助手独立判断和当前共同共识；信息最小权限、通信、事实、视图、失败和用户主权。
- **[S2]** `docs/strategy/SLIMEMOLD_GLOBAL_PRODUCT_SYSTEM_REVIEW.md`：产品定位、Agent 协作成本、能力路由、长期稳定性、记忆、恢复、竞品边界和边缘场景。
- **[S3]** `docs/architecture/PROJECT_CONTROL_PLANE_ARCHITECTURE.md`：项目实体、控制/计划/执行/反馈平面、会话/Decision、Issue、DAG 生命周期、Boundary Contract 和当前路线。
- **[S4]** `docs/architecture/CODEBASE_ARCHITECTURE_REVIEW.md`：当前代码结构债务、事件/快照边界、插件/宿主风险和渐进迁移建议。
- **[S5]** `.hermes/plans/2026-08-31_204616-large-refactor.md`：大重构中的产品决策、宿主不变量、事件、运行时、记忆、扩展、红队追加约束和自动化取舍。
- **[S6]** `.hermes/plans/2026-08-31_021507-project-control-plane-next-step.md`：项目控制面垂直切片、用户确认门、Issue/Task/Workflow 映射和持续运维边界。
- **[S7]** `.hermes/plans/2026-09-04_150831-mvp-node-redesign-and-e2e-acceptance.md`：结构化 PatchSet、宿主验收、Delivery/Cleanup 分离、专有 fixture 根和真实 Tauri MVP 验收。
- **[S8]** `.hermes/plans/2026-09-05_144851-mvp-security-hardening-phase2.md`：session single-flight、side-effect claim、cleanup approval、Node/Rust policy、recovery 和 E2E hardening 计划。
- **[S9]** `.hermes/plans/2026-09-12_144620-phase2-production-closeout.md`：Phase 2 收口、disposable Tauri、restart/recovery、native authority、Zod、reviewer 和 push/merge 边界。
- **[S10]** `.hermes/plans/2026-09-12_151446-hierarchical-agent-company.md`：层级化 Agent 公司架构、摘要/Evidence、ContextPack、delegation、Feedback、DAG growth、承建方和横向角色计划。
- **[S11]** `docs/security/CREDENTIALS_MODEL.md`：凭据来源、托管和禁止进入项目文件/共享上下文的安全约束。
- **[S12]** `docs/README.md`：文档目录职责、权威层级、敏感资料、历史记录和维护规则。
- **[S13]** `docs/history/decision-reviews/SLIMEMOLD_ARCHITECTURE_DIRECTION_REVIEW.md`：历史性的产品/架构共同审视和边缘场景推导。
- **[S14]** `docs/DEVELOPMENT_LOG.md`：已发生的实现和真实验证历史；不能单独证明未记录的设计建议已获批准。
- **[S15]** `2026-09-12 用户讨论`：摘要/Evidence 查询、ContextPack、子代理 anti-bypass、FeedbackRequest、承建方及横向角色确认；本条来源保留在会话历史和 [S10] 计划中。
- **[S16]** `2026-09-14–2026-09-15 用户讨论`：Git worktree 第二事实源、GitObservation、Worktree/commit 生命周期、Council 治理、snapshot-bound Context Gateway、性能 guardrails、ChangeSet、GitHub 远端观察和多仓库集成边界。
- **[S17]** `.hermes/plans/2026-09-14_221205-change-set-github-ecosystem.md`：ChangeSet、Repository、Local/Remote Observation、External Operation Ledger、Integration Saga、版本化架构协议和分阶段实施计划；计划不等于实现验证。

---

## 8. 维护规则

1. 新决定先写成 `建议待确认`，明确提出者和替代方案；用户确认后再提升状态。
2. 已确认决定不得因为实现困难被静默改写；创建新 `ADR-SM-NNN` 或把旧条目标为 `已替代`，并链接新条目。
3. 实现状态变化不改变决定本身：例如“采用隔离 worktree”仍可成立，但当前 GUI 验收可能仍是“未完全验证”。
4. 每条实现性结论都要链接源码、测试、宿主 Evidence、reviewer snapshot 或 `DEVELOPMENT_LOG.md`；计划文字只能证明计划存在。
5. 不在本文写入 API key、token、密码、私钥、Bearer 值、连接字符串或未经脱敏的个人路径；任何凭据统一写作 `[REDACTED]`。
6. 计划文档引用本记录的条目；架构契约引用决定的 ID；开发日志记录实际实现和验证结果，不重复解释全部设计历史。
