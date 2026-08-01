# 待做任务 / 进度记录（TODO）

> 维护说明：本文件记录项目未完成功能、已知问题、当前进度，便于后续接续开发。

---

## 〇、项目远景（Vision，2026-08-02 由用户口述）

**一句话定位**：一个多 Agent 协同创作工作站，仿照 ComfyUI 的可视化工作流流水线，对多家 AI 模型「各取所长」，并综合**性能**与 **tokens 平均价格**来达成创作的「最优性价比」。

**核心理念**：传统 agent 客户端对多任务协同不友好；用可视化、直观的流水线来派发任务，可冲破这一局限。

**模型分工设想（各取所长，模型名即角色示例）**：
- **Claude Code（cc，模型名）**：整体项目架构、建模、项目管理，以及对具体任务的**分割与派发**（调度层角色）→ 对应节点建议名 **Architect**。
- **Gemini**：视觉方向 / UI 设计。
- **DeepSeek（ds，模型名）**：简单但重复度高、大量消耗 tokens 的任务（如写壳子/定式代码）→ 对应节点建议名 **Scaffolder**。
- **ChatGPT（多模态）**：测试、总结等。

**目标价值**：可视化、直观地派发任务给不同模型，让「性价比最优」成为可编排、可观测的设计目标，而非事后统计。

> 说明：上述为用户的原始远景描述。AI 曾指出若干薄弱点（缺模型路由调度层、多 agent 协同需共享上下文/黑板而非纯数据流、执行引擎缺并发与回退、成本可观测性缺失），相关改进思路见末尾讨论记录，后续可逐步落地。

### 1. 端到端工作流脑洞（2026-08-02 补充，用户原始设想）

> 以下 agent / 模型名称均为**示例**，非定稿。

**入口**：
- 起始节点有两种：①「Idea」文本框节点（一句想法）；②「Project 文档导入」节点（完整项目文档）。两者作为工作流的同一类入口。

**流水线阶段**：
1. **Planner（规划者）**：接收 idea 或 project 文档，产出详细**计划书**。该节点输出与「project 文档入口」归并到同一后续入口。
2. **架构师（建议名 Architect，常用 Claude Code 承担）**：对计划书做**可行性分析**，组织项目架构（语言选型、目录分层、接口与类名的最初规划），交付架构产物。
3. **脚手架工（建议名 Scaffolder，常用 DeepSeek 承担）**：依据架构产物，写出项目"壳子"——抽象类、getter/setter 等定式、重复度高的基础代码。
4. **任务派发（Dispatcher）**：由某一模型/agent（Claude Code、DeepSeek 或任意）**划分任务**，从右侧拉出 **1:n 连线**，将具体任务派发到对应节点，**并行施工**。
5. **协调者（Coordinator）**：辅助 agent，检测并消除两个涉及同一文件 / 同一接口 / 抽象类的任务的**并发冲突**（冲突仲裁）。
6. **书记员（Stenographer）**：辅助 agent，记录所有项目更改、撰写日志文件；额外记录每个环节花费的**时间与 tokens**，写成文档供用户参考，甚至写入 skill 供下次任务**自优化**。
7. **建造者（Builder）**：经 Coordinator 审核后的任务输出到 Builder 执行具体施工。
8. **编译/运行队列**：并发任务以**队列形式**编译、运行。
9. **测试员（Tester）**：确认项目的**完整性与持久性**。
10. **循环任务**：定时/循环任务由一个**条件判断节点**构成循环；拓扑排序时该条件节点视作**断点**，不破坏循环检测。

**关键设计点提炼**：
- 入口归一（Idea / Project 汇入同一下游）。
- 1:n 派发 + 并行施工 + 冲突协调（Coordinator 是并发安全的瓶颈点）。
- 可观测性内建：Stenographer 全程记录成本（时间 + tokens）+ 自优化闭环（写 skill）。
- 循环用"条件断点"语义兼容 DAG 拓扑排序。

### 2. AI 建议与落地路线（2026-08-02，针对上面的脑洞）

#### 2.1 角色命名优化（更准确）
| 用户原叫法 | 建议名 | 理由 |
|---|---|---|
| Planner | Planner / Orchestrator | 兼"分解+调度"，可细分 |
| cc（Claude Code） | **Architect** | 原意是模型名 Claude Code，常承担架构/选型/分层职责，故建议名 Architect |
| ds（DeepSeek） | **Scaffolder** | 原意是模型名 DeepSeek，常承担写壳子/定式代码等高重复度任务，故建议名 Scaffolder |
| 工作派发节点 | **Dispatcher / TaskSplitter** | 强调"切分+派发" |
| Coordinator | **Conflict Resolver / Merge Coordinator** | 本质是并发冲突仲裁 |
| Stenographer | **Auditor / Bookkeeper** | 记录+成本统计+自优化，不止速记 |
| Builder | **Implementer** | 与 Scaffolder 区分 |
| Tester | **Validator** | 强调"完整性与持久性" |

> 关键一刀：Scaffolder（写壳子）与 Implementer（施工）分离，是设计中最清晰的一层。

#### 2.2 需要补强的设计点
1. **Conflict Resolver 是瓶颈**：它要检测"同一文件/接口/抽象类冲突"，前提是 Dispatcher 派发任务时附带 **scope 声明**（affected files / symbols）；否则无法比对。→ 任务节点需带 `scope` 字段，Resolver 做 scope 交集检测，冲突则排队/合并。
2. **1:n 派发 + 并行施工需显式连線语义**：现有连线是数据流，但派发属控制流。建议区分三类边：
   - `data edge`：值传递（现有）
   - `task edge`：派发任务，带 scope
   - `control edge`：条件/循环断点
3. **循环"条件断点"**：条件节点把图切成多个 **DAG stage**，stage 内是 DAG，stage 间靠条件 gate 串联；"断点"= stage 边界，实现简单且不破坏现有排序。
4. **Auditor 写 skill 自优化**：需先定义**结构化日志 schema**（task_id, agent, model, tokens_in/out, latency, scope, diff_size, status），否则"写 skill"只能灌自然语言、无法量化复用。
5. **入口归一后加 Feasibility Gate**：Architect 可行性分析后应有一个人工/自动确认节点再往下，避免自动跑到 Scaffolder 浪费 tokens 在错误方向。

#### 2.3 落地优先级（契合"少浪费 tokens、增量独立"原则）
1. **节点/连线类型分层**（data / task / control 三类 edge + 端口配色）——地基，不先定后面全乱。
2. **结构化日志 schema + Auditor 节点骨架**——成本可观测性，独立、低风险、立刻有价值。
3. **Dispatcher + scope 声明 + Conflict Resolver**——并发安全核心。
4. **条件断点 / stage 化拓扑排序**——循环语义。
5. **Scaffolder / Implementer / Validator 等具体干活节点**——最后做。

> 下一步候选：先评估现有节点/边类型定义，最小改动地加 2.3-1 的连线分层语义（可直接落到现有 React Flow 画布）。

### 3. 落地进度记录

#### ✅ 步骤 1：节点/连线类型分层（已完成，2026-08-02）
- **`src/types.ts`**：
  - 新增 `EdgeKind = 'data' | 'task' | 'control'` 枚举。
  - 新增 `EDGE_KIND_STYLE` 样式表（data 灰实线 / task 橙虚线 / control 紫点线）+ 中文标签。
  - `PortDef` 新增可选 `flow?: EdgeKind`（声明端口只允许连哪种 kind 的线，向后兼容旧节点）。
  - `FlowEdgeData` 接口：`{ kind?: EdgeKind; scope?: string[] }`（scope 预留给后续 Coordinator 冲突检测）。
  - `FlowEdge = Edge<FlowEdgeData>`；`WorkflowFileEdge` 增加可选 `kind?` 字段。
- **`src/canvas/KindEdge.tsx`（新）**：自定义边组件，按 `data.kind` 渲染不同颜色/线型 + 中文标签。
- **`src/canvas/WorkflowEditor.tsx`**：注册 `edgeTypes={kind: KindEdge}`，`defaultEdgeOptions.type='kind'`，拆分视图 `onConnect` 也带 kind。
- **`src/store/workflowStore.ts`**：
  - `onConnect` 按 source 端口 `flow` 推断 kind 写入 `edge.data.kind`（缺省 `'data'`）。
  - 序列化（storedEdgeOf / serializeWorkflow ×2 / packSelectionAsSubgraph）与子图展开重建均保留 `kind`。
- **`src/io/workflowIO.ts`**：加载/导出均保留 `kind`，旧文件缺省 `'data'`（向后兼容）。

**验证**：`npx tsc --noEmit` 无新增类型错误（既有错误均在封存的 `SubgraphEditor.tsx` 与 workflowStore 两处 pre-existing 位置，与本次改动无关）。

**待后续步骤**：
- `isValidConnection` 加入 `flow` 一致性校验（source.flow 须等于 target 端口可接受 kind），本轮未强制，保持向后兼容。
- `PortDef.flow` 字段尚未在任何内置节点上声明，等步骤 3（Dispatcher/Resolver）再分配。

#### ✅ 步骤 2：结构化成本日志 schema + Auditor 节点骨架（已完成，2026-08-02）
- **`src/types.ts`**：
  - `TokenUsage`：`{promptTokens?, completionTokens?, totalTokens?}`（对齐 OpenAI/Anthropic）。
  - `LLMResponse`：`{text, usage?}`（统一返回，usage 可选，向后兼容现有 string 契约）。
  - `CostRecord`：节点级成本记录（`nodeId, nodeLabel, agentId, model, usage?, durationMs, at, ok, error?`），供 Coordinator/Stenographer/Auditor 复用。
  - `CostLedger = CostRecord[]`。
  - `ExecContext` 新增 `reportCost(rec)` 与 `costLog: CostRecord[]`（Auditor 读取源）。
  - `RunNodeResult.cost?` 与 `RunRecord.cost?`（含按模型归类的 `byModel` 聚合），支撑「性价比」分析。
- **`src/agents/llmChannel.ts`**：`LLMChannel.chat` 返回 `LLMResponse`（文本 + 可选 usage）。前端通道透传 provider usage；后端通道暂 `usage: undefined`（路线 B 可在 Rust 侧填充）。
- **`src/agents/agentManager.ts`**：`chatWithAgent` 返回 `LLMResponse`；`providers` 类型改为 `Promise<LLMResponse>`。
- **`src/agents/providers/*.ts`**：
  - `openai.ts`：非流式/流式均解析真实 `usage`（prompt/completion/total_tokens）。
  - `anthropic.ts`：解析 `input_tokens`/`output_tokens`。
  - `ollama.ts`：本地模型无 usage，返回 `undefined`。
  - → **OpenAI 系与 Claude 系现已能拿到真实 token 用量，成本立即生效**。
- **`src/engine/executor.ts`**：`ctx.llm` 每次调用后构建 `CostRecord` 推入 `costLog` 与按节点 `costByNode`（含失败记录）；`runWorkflow` 末尾按模型聚合写入 `RunRecord.cost`。
- **`src/engine/headless.ts`**：补齐 `reportCost`/`costLog`（headless 预演不累积成本）。
- **`src/nodes/builtin.ts`**：新增 **`auditor.bookkeeper`（成本审计）** 节点（分类「审计」）：
  - 无输入端口，通过 `ctx.costLog` 读取全链路成本账本；
  - 输出 `report`(JSON) / `totalTokens` / `totalDurationMs`；
  - 参数 `includeRecords` 控制是否输出逐条明细；
  - 放在工作流任意位置均上报全链路成本，多个 Auditor 互不影响。

**验证**：`npx tsc --noEmit` 无新增错误（剩余错误均在封存的 `SubgraphEditor.tsx` 与 workflowStore 两处 pre-existing 位置，与本次无关）。

**待后续步骤**：
- 成本 UI 呈现：运行历史行显示总 token / 总耗时 / 按模型拆解（路线 2 的"立刻有价值"收尾，可独立做）。
- Stenographer「写 skill 自优化」闭环：成本 schema 已就绪，下一步可加 skill 导出逻辑（等 Auditor 验证后）。
- 后端通道（Rust）usage 回流：路线 B，前端已能拿到用量，后端为可选增强。

#### ✅ 步骤 2 收尾：成本 UI 呈现（已完成，2026-08-02）
- **`src/components/RunHistoryPanel.tsx`**：
  - 运行概览卡新增「成本」区块：总 Token（in/out 拆分）、LLM 调用次数、模型种类数、Token 耗时。
  - 新增「按模型拆解（性价比）」卡片：列出每个模型的 prompt/completion token 与调用次数。
  - 每个节点卡右上角显示该节点 token 用量（橙色徽标，含失败次数提示）。
- **`src/components/StatusBar.tsx`**：历史 tab 每行追加 `· N tok` 摘要（悬停提示为总 Token 用量）。
- **验证**：`npx tsc --noEmit` 无新增错误；两个组件 lint 干净。

> 说明：成本 UI 直接读 `RunRecord.cost` / `RunNodeResult.cost`（步骤 2 已写入）。运行含 OpenAI/Claude 系节点即可在运行历史看到真实 token 消耗。

#### ✅ 步骤 3：Dispatcher + scope + Conflict Resolver（框架已搭，2026-08-02）
- **`src/types.ts`**：新增 `TaskItem` 任务数据协议（`{label, scope?, payload?, index?}`）。
  - 设计要点：**scope 走数据协议**（任务对象自带 scope 字段），不依赖引擎改动，框架先行落地；真正的「串行化重排」留给后续执行引擎增强。
- **`src/nodes/builtin.ts`**：
  - 新增 **`dispatch.split`（任务派发）** 节点（分类「派发」）：
    - 输入 `tasks`（TaskItem[]），扇出到 `task1~task4` + `rest`；
    - 各任务端口声明 `flow: 'task'`（步骤 1 的橙色 task 线语义）；
    - 支持标签覆盖参数；纯文本输入自动包装为 TaskItem。
  - 新增 **`coord.resolver`（冲突协调者）** 节点（分类「协调」）：
    - 多输入 `in1~in4`；两两检测 scope 交集；
    - 无冲突走 `merged`，有冲突走 `conflicts`；参数 `mode` 支持 `report`（仅报告）/ `block`（阻断下游）；
  - `CATEGORY_ORDER` 增加「派发」「协调」；两节点注册进 `builtinDefs`。
- **`ExecLogger` 仅 info/error**（Resolver 冲突日志用 error）。

**验证**：`npx tsc --noEmit` 无新增错误（builtin.ts 的 warn→error 修正后通过）；剩余错误仅在封存 `SubgraphEditor.tsx` 与 workflowStore 两处 pre-existing 位置。

**框架边界（本轮刻意未做，留给后续）**：
- 执行引擎：**并行的真实写文件/落盘**未实现（当前并行由 executor 拓扑调度保证，但 Resolver 仅检测不重排）。
- `FlowEdgeData.scope`：Dispatcher 写回边 data.scope 未强制（任务 scope 走数据协议，边级 scope 留给步骤 4 条件断点一起接）。
- Builder/Scaffolder/Implementer/Validator 等具体干活节点尚未新增（路线步骤 5）。
- 节点 palette / Inspector 对 scope 的可视化编辑未做（仅数据透传）。

#### ✅ 步骤 4：条件断点 / stage 化拓扑排序（已完成，2026-08-02）
- **`src/engine/topoSort.ts`**：
  - `wouldCreateCycle` 新增 `ignoreControl` 参数（默认 true）：忽略 `control` 语义边，允许「条件节点 → 循环体 → 回指条件节点」这类伪环存在而不误报。
  - 新增 `topoStages(nodeIds, dataEdges, controlEdges)`：把 control 边视作 stage 边界。
    - Pass A：仅 data/task 边做标准 Kahn 分层（同 stage 内并行）。
    - Pass B：每条 control 边 `from→to` 强制 `to` 及其 data/task 下游进入更高 stage（迭代至稳定）。
    - 返回 `stages: string[][]`（每 stage 内可并行）与 `cyclic`（仅纯 data/task 成环的节点）。
- **`src/engine/executor.ts` / `src/engine/headless.ts`**：运行前拆分 data/control 边，改用 `topoStages` 调度（stage 间严格有序，stage 内并行）。原 `layers` 概念升级为 `stages`。
- **`src/nodes/builtin.ts`**：新增 **`flow.loopGate`（循环/条件断点）** 节点（分类「流程」）：
  - 输出 `pass` 端口声明 `flow: 'control'`（紫色 control 线），作为 stage 断点；
  - 条件表达式求值（复用 evalExpr/isTruthy），仅激活 `pass`/`stop` 分支之一（下游剪枝）。
- **`wouldCreateCycle` 调用点**（workflowStore 388 / WorkflowEditor 280）无需改动（默认 ignoreControl=true）。

**验证**：`npx tsc --noEmit` 无新增错误（executor/headless 解构修正后通过）；剩余错误仅在封存 `SubgraphEditor.tsx` 与 workflowStore 两处 pre-existing 位置。

**框架边界（本轮刻意未做）**：
- 执行引擎**迭代循环**未实现：当前每轮运行 loopGate 只做单轮 gate（条件为假则下游剪枝）。真正「多次迭代循环体」需执行引擎支持循环执行（重复调度 stage 直至条件终止），列为后续增强。
- `PortDef.flow` 一致性校验未强制：control 边当前可连任何端口（语义上可接受，校验留待步骤 1 收尾）。
- 循环的可视化（如循环体高亮）未做。

---

## 四、关键架构讨论结论（2026-08-02，用户口述引发的澄清）

> 以下为「agent 是什么」「本地 vs 云端」「API key 安全」三轮讨论的共识，作为后续设计的硬约束。

### 4.1 对「agent」的定义对齐（已与用户确认：采用混合路线）
- **普通节点**（Scaffolder/Implementer 等）= 单次 `ctx.llm()` 调用，宏观编排由用户在画布上画。
- **自主节点**（用户脑洞里真正「聪明」的角色，如 Validator、autonomous.coder）= 节点 `execute` 内部跑 `think → act(工具) → observe` 小循环，封在节点里；对外仍只是一个输入/输出端口，画布无感。
- 结论：**画布管宏观编排（谁依赖谁），节点内部管微观自主**。这既保留「按 token 性价比分配谁干什么」的编排权，又不用把「测试失败→重试」画成一大坨边。
- 当前 `agentManager` 的 agent 实为「命名 model 端点」（一次一问一答，无工具/无记忆），是混合路线里「普通节点」的实现基础；自主节点是增量增强。

### 4.2 本地 vs 云端算力边界（已澄清）
- 有 API key + 自写程序时，**推理算力 100% 在云端 GPU**，本地只做：拼请求、发网络、收结果（CPU + 带宽，几乎不吃显卡）。
- 本地模型（Ollama）才在本地吃算力；云端 API 模式本地零显卡消耗。
- 对 slimeMold 的意义：当前架构天然是「编排在本地（Tauri 桌面程序：DAG/成本账本/节点调度）、推理在云端（ctx.llm 打到 API）」的混合。编排权永远在本地，算力按需从云端买。

### 4.3 API key 安全策略（已澄清，落地见 Step 0.5）
- 铁律：**key 永不明文进工作流文件 / 永不入 git / 永不明文睡在 config**。
- 推荐链路：设置界面输入 → Tauri `plugin-keyring`（走系统密钥库：Windows Credential Manager / macOS Keychain / Linux libsecret）→ 运行时取回内存 → 喂 provider。
- **更优**：让 `src-tauri` Rust 侧做 API 代理，前端只说「用 X 跑这段 messages」，Rust 从密钥库取 key 发请求回传文本，**前端 JS 全程不碰 key**（规避 devtools 泄露 + CORS 逼前端持 key 的问题）。这正是 Tauri 相对纯 Web 的优势。
- 当前隐患：`src/agents/llmChannel.ts` 是**前端直连云端 API + 透传 key**，需改为走 Rust 代理。

### 4.4 落地优先级重排（插入 Step 0.5，位于 Step 4 之后、Step 5 之前）
1. ✅ 步骤 1：边类型分层
2. ✅ 步骤 2：成本 schema + Auditor + UI
3. ✅ 步骤 3：Dispatcher/Resolver 框架
4. ✅ 步骤 4：stage 化拓扑 + loopGate
5. ✅ **Step 0.5：API key 安全（密钥库 + Rust 代理）** —— keyring 落盘（set/get/delete_credential）+ chat_completion 改从密钥库按 credentialKey 取 key + 前端设置面板不再编辑明文 + workflowIO 序列化剥离 apiKey。已落地（cargo check + tsc 通过）。
6. ✅ **Step 5：具体 worker 节点（Scaffolder/Implementer/Validator）** —— 三者均为绑定智能体 + 角色 + 模型覆写 + 离线模拟；Scaffolder/Implementer 为普通节点（单次 ctx.llm），**Validator 为「自主节点」试点**（节点内部 think→评估→不合格带批评重跑，maxIter 轮，对外单一端口）。已落地（tsc 通过）。
7. ⬜ **Step 6（建议新增）：执行引擎迭代循环** —— 让 loopGate 真正多次跑循环体（步骤 4 框架的收尾）；与 Step 5 的 Validator 自主循环互补（前者是画布级回路，后者是节点内回路）

> 理由：Step 0.5 是安全地基，应在任何「真去调云端 API 干活」之前补；Step 6 让 4 的循环语义闭环，与 5 的自主节点互相印证。

### 4.5 前端/后端编排权决策（2026-08-02，用户拍板：按 AI 直觉走）
- **结论：短期走方案 X，长期向方案 Y 演进。**
  - **X（短期）**：节点 `execute` 仍跑在前端 TS，拼好 messages 后调 Tauri 命令 `proxy_llm(agentId, messages)`；Rust 侧只负责「取 key + 转发 API + 回传文本/usage」。前端是大脑，Rust 是哑管道。现有 `builtin.ts` 节点逻辑几乎不动。
  - **Y（长期）**：节点 `execute` 只产出「意图」（如 `{role, input}`），真正拼 prompt、调 API、跑 think-act 内部循环下沉到 Rust；前端只渲染。自主节点（Validator 等）天然在后端跑，能真调工具/读文件且不卡 UI，key 完全不进前端。
- 落地顺序：先以 X 完成 Step 0.5（密钥库 + 前端→Rust 代理转发），不阻断现有代码；自主节点成熟后再把对应节点逻辑沉到 Y。
- 约束：无论 X/Y，**前端 JS 永不持有明文 key**（X 下 key 也只在 Rust 内存 + 系统密钥库）。

---

## 一、子图（Subgraph）与分组（Group）功能 —— 已封存（2026-08-02）

**封存原因**：该功能涉及大量交互细节（代理端口双向连接、键盘事件隔离、父图/子图同步等），反复调试消耗过多时间与 token，且仍未完全稳定。决定暂时封存，先推进其他更核心的工作；相关代码保留在仓库中，不删除，待后续回归。

**当前进度 / 已完成的改动**（基于 2026-08-02 之前的会话）：

### 1. 代理端口双向连接（已完成）
- `src/canvas/nodes/ProxyPortNode.tsx`：每个代理端口同时渲染 `source` + `target` 两个 Handle（id 形如 `${portId}__out` / `${portId}__in`），配合 `ConnectionMode.Loose`，既可「节点→代理」也可「代理→节点」互连。
- `src/canvas/SubgraphEditor.tsx` 的 `close()` 写回逻辑支持四种连线方向（节点→输入代理、输入代理→节点、输出代理→节点、节点→输出代理），分别提升为子图输入/输出端口。

### 2. 子图内删除键盘事件隔离（已完成）
- `src/canvas/WorkflowEditor.tsx`：当 `focusedSubgraphId` 存在时，父图 `deleteKeyCode` 设为 `null`，避免挂在 `document` 上的 React Flow 删除监听误删父图分组节点（之前表现为“按退格删除连线却退出子图 + 分组消失”）。
- 子图内 `deleteKeyCode={['Backspace','Delete','Enter']}`。

### 3. 父图分组与子图内容同步（已完成）
- `src/store/workflowStore.ts` 新增 `syncGroupProxies(subgraphId)`：子图写回后重算所有引用该子图分组的 `proxyPorts` / `virtualEdges`，使父图代理端口随子图节点增删同步。

### 4. 子图内双击加节点 + 代理端口实时增减（已完成，曾崩溃已修）
- `src/canvas/SubgraphEditor.tsx`：`onDoubleClick` 弹 `NodePickerModal` → `addNodeInSubgraph` 加入内部节点。
- 重构为「内部节点 `innerNodes` 状态 + 代理节点实时派生」：`liveInPorts`/`liveOutPorts` 基于内部节点聚合，`proxyNodes` 用 `useMemo` 派生，避免 state 写回竞态导致渲染崩溃（`Cannot read properties of undefined (reading 'typeId')`）。

### 5. 从节点库拉出的「文本输出」节点（已完成，与本功能无关但同期新增）
- `src/nodes/builtin.ts` 新增 `output.text`（类别“输出”），展示上游文字、可滚动、可复制。
- `src/canvas/nodes/BaseNode.tsx` 对其放宽预览长度并加「复制文本」按钮；子图引用节点新增「进入子图」按钮。

---

## 二、子图/分组功能已知遗留问题（恢复时优先排查）

1. **子图内删除节点后父图实时同步**：`syncGroupProxies` 只在 `close()`（点“完成并返回”）时调用，子图内实时编辑期间父图不更新（设计如此，但需确认是否符合预期）。
2. **键盘隔离的彻底性**：仅通过「父图 `deleteKeyCode=null`」做隔离；若后续需让子图内嵌套更多 ReactFlow 实例，需更通用的隔离方案（如 `useKeyPress` 的 target 限定）。
3. **代理端口的标签匹配**：`close()` 写回时 `inPorts`/`outPorts` 基于 `sg` 定义做标签匹配，若用户大量手动连线导致端口类型与定义不一致，可能存在端口归并歧义。
4. **双击进入子图**：`onNodeDoubleClick` 同时支持 `groupProxy` 与 `subgraphRef`；需确认触控/无双击设备的可发现入口。
5. **回归测试清单**（恢复时逐项验证）：
   - 进入子图 → 双击空白加节点 → 左右代理端口实时出现对应类型端口。
   - 删除内部节点 → 代理端口实时消失。
   - 子图内选中连线按 Backspace → 仅删除子图内连线，父图分组不丢、不退出子图。
   - 点“完成并返回” → 父图分组代理端口随子图内容更新。
   - 从「我的子图」库拖出子图引用 → 双击/「进入子图」可编辑，子图内容正确载入。

---

## 三、其他潜在待做（未开始）

- [ ] 插件系统（plugin-examples 已有示例）与运行时执行链路联调。
- [ ] 节点执行引擎的流式输出与取消逻辑完善。
- [ ] 移动端/小屏适配。
- [ ] 单元测试与端到端测试补齐。

---

*最后更新：2026-08-02*
