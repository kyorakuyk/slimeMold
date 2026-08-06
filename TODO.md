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
- `PortDef.flow` 一致性校验未强制：control 边当前可连任何端口（语义上可接受，校验留待步骤 1 收尾）。
- 循环的可视化（如循环体高亮）未做。

#### ✅ 步骤 4 收尾：loopGate 迭代循环真正落地（Step 6，已完成，2026-08-02）
- **`src/engine/executor.ts`**：
  - `runWorkflow` 调度主循环外层包「轮次循环」：检测是否存在 `flow.loopGate` 的 `pass`(control) 分支经控制/数据边回指自身上游构成的回环（`hasLoop`）。
  - 每轮跑完所有 stage 后，读 `gateTaken`（经 `setBranches` 回调上报）判断是否有 loopGate 走 `pass` 分支：是 ⇒ 循环体（从 gate.pass 出发绕回 gate 的节点集，见 `collectReachable`）加入下轮 `dirtySet`+`force` 并清缓存（`strike`），同时递增 `ctx.vars[loopVar]`；否 ⇒ 退出轮次循环。
  - 最大轮数 `maxRounds` 取各 loopGate `maxLoops` 参数最小值（默认 20，上限 50，可被 `RunOptions.maxLoopsOverride` 覆盖），防死循环。
  - 新增 `RunOptions.extraVars`/`onGate` 注入执行层，循环变量仅本轮注入、不污染用户全局变量。
  - 新增 `resumeRun()` 失败续跑入口（见 L1）。
- **`src/nodes/builtin.ts`**：`flow.loopGate` 新增参数 `maxLoops`(默认 20)、`loopVar`(默认 'i')；`execute` 把当前循环轮次 `ctx.vars[loopVar]` 计入条件求值，并回传 `__loopIndex`。
- **`src/components/TopBar.tsx`**：运行菜单新增「从断点续跑（失败节点 + 下游）」入口（`RotateCcw` 图标，调用 `resumeRun`）。

**效果**：画「loopGate.pass → 干活节点们 → 回指 loopGate」即构成真循环；每轮干活节点重算，循环变量 `i` 递增供条件表达式（如 `i < 5`）使用，条件为假自动退出。

**验证**：`npx tsc --noEmit` 对 executor/TopBar/builtin 三处无新增错误（既有错误仅在封存 `SubgraphEditor.tsx` 与 workflowStore 两处 pre-existing）。

#### ✅ L1 可靠执行：失败节点续跑（已完成，2026-08-02）
- **`src/engine/executor.ts`**：
  - 新增 `RunOptions.retryFailed`：配合 `incremental` 时，把上一轮 `status==='error'` 的节点及其全部下游（BFS，`addDownstreamToCut`）标记为本次执行集，其余 success/cached 节点复用既有输出不动。
  - 新增 `resumeRun()`：检查无 error 节点时提示无需续跑；否则记日志并 `runWorkflow({ incremental: true, retryFailed: true })`。
- **`src/components/TopBar.tsx`**：运行菜单「从断点续跑」项即触发 `resumeRun`；工作流跑挂后修好问题节点，点一下即可断点续传。

**说明**：这是 L1 可靠执行的第一步——失败后续跑。真正的「单节点自动重试 + failFast=false 时跳过失败继续下游」的自动策略（无需手动点续跑）可后续作为引擎内置策略增强。

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
7. ✅ **Step 6：执行引擎迭代循环** —— loopGate 真正多次跑循环体（2026-08-02 落地，见下方执行状态）。前者是画布级回路（pass 分支绕回 gate 上游），后者是节点内回路（Validator）。

### 4.5 L1 可靠执行：自动执行策略（已完成，2026-08-02）
- **单节点实时重试**：`executeNode` 把 `def.execute` 包进 `withRetry`（节点级 `NODE_RETRIES=2`、退避 1.5s），仅对**瞬时错误**（`isTransient`：timeout/429/5xx/network/socket 等）重试；业务错误（解析/参数/逻辑）不重试，立即失败。与 LLM 网络层 `withRetry`（限流类）互补：LLM 层耗尽后仍偶发瞬时故障可在节点层再退避一次。
- **失败跳过继续（failFast 的反面）**：新增 `RunOptions.skipFailed` + store `skipFailed` 开关（TopBar 运行菜单「失败时继续」）。
  - 关闭「失败即停」(failFast=false) 后再开「失败时继续」：某节点失败不中断整体运行，其下游**不被剪枝**，以空上游输出继续尝试执行（并记录日志「上游有失败节点，按跳过失败继续策略仍尝试执行」）。
  - 失败节点本身 `branchState` 在非 skipFailed 时屏蔽下游、skipFailed 时放行下游。
- **UI/配置**：
  - `workflowStore`：`skipFailed: boolean`（默认 false，已进 persist 白名单）+ `setSkipFailed`。
  - `TopBar` 运行菜单：全量/增量运行入口透传 `skipFailed`；新增「失败即停：开/关」「失败时继续：开/关」两项开关（后者在 failFast 开启时禁用）。
- **失败续跑**（上一轮已落地）：`resumeRun()` 仍以手动断点续传方式补 failFast=true 时的卡死场景。

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

## 五、「项目（Project）」概念完善（2026-08-03 与用户确认，待实施）

> 目标：把当前「一堆平铺工作流 + localStorage」升级为真正的项目概念：
> 磁盘为唯一真相、项目文件夹形态、资产两级、变量两级、成本跟项目走。

### 5.0 现状与已确认的断裂点

`ProjectFile` 类型、`src/io/projectIO.ts`、`newProject/openProject/saveProject`、文件菜单入口**均已存在**，
`.smproj` 为单个 JSON 大文件。但存在以下明确缺陷：

| # | 问题 | 位置 |
|---|---|---|
| 1 | `projectName`/`projectPath` **不在 persist 白名单**，重启后项目身份丢失 | `workflowStore.ts` persist partialize |
| 2 | 打开项目时传的是**项目名而非磁盘路径**，"最近项目"记录的 path 是假的，二次打开必失败 | `TopBar.tsx:138` `openProject(file, file.name)` |
| 3 | `saveProject` 每次重写 `createdAt`，且**始终弹另存对话框**，无"保存到已有路径" | `workflowStore.ts` saveProject |
| 4 | 资产 `assets` 与 `workspaceDir` 均为**工作流级**，项目没有自己的根目录 | `WorkflowFile` |
| 5 | `workflows` 是**无序字典**，无排序/分组字段 | `workflowStore.ts` |
| 6 | `runHistory`/`variables` 在**全局 persist 白名单**里，与「跟项目走」矛盾，切项目会串数据 | persist partialize |
| 7 | Tauri 权限**只有读写文本文件**，缺 `mkdir`/`read-dir`/`remove`/`exists`，建不了项目目录 | `src-tauri/capabilities/default.json` |

### 5.1 已拍板的设计决策

- **存储真相**：**磁盘为唯一真相**。localStorage 降级为「崩溃恢复草稿 + 会话状态」（开了哪些项目、标签分组折叠状态）。dirty 定义即 `内存态 ≠ 磁盘态`。
- **工作流 ≠ 必须属于项目**：新建工作流**不强制依附项目**。**游离工作流（standalone workflow）** 也是一等公民——它可以不属于任何项目，存成一个独立 `.json` 文件。用户**需指定存放位置**，未指定时落到**默认位置**（如 `文档/SlimeMold/未归类/`）。项目内工作流与游离工作流在编辑器里体验一致，区别在于归属与资产/变量的作用域大小。
- **物理形态**：**项目文件夹**（非单文件，仅当工作流归属项目时使用）。项目配置统一收进项目根下的隐藏文件夹 **`.slimemold/`**（与源码/资产并列，避免污染用户自己的工程目录，且便于 `.gitignore` 或随仓库提交）：
  ```
  MyProject/
    .slimemold/
      project.json        # 项目元信息 + 标签分组 + 项目级变量 + 角色 + 子图
      workflows/*.json    # 每个工作流独立文件，便于 git diff
      assets/             # 项目级共享资产
      runs/history.json   # 运行历史 + token 统计
    # 用户自己的产物 / 源码 与 .slimemold 平级
  ```
  游离工作流不建文件夹，直接存 `{用户指定位置|默认位置}/xxx.json`，其运行历史/资产/变量**自带于该工作流文件**（或就近 `xxx.runs.json` 旁挂文件），不共享。
- **资产**：**两级并存**（项目级共享 + 工作流级私有），**支持跨工作流引用**（`assetId` 全局唯一）。删除项目级资产时需检测被哪些工作流引用并提示。游离工作流只有工作流级资产，无项目级共享层。
- **变量**：**两级**（项目级 + 工作流级），工作流级优先覆盖项目级，Inspector 标注来源。游离工作流仅工作流级变量生效。
- **runHistory / token 统计**：**跟项目走**，落 `runs/history.json`，需移出全局 persist。
- **agents（模型/API Key 配置）**：**保持全局**，不进项目文件（避免 Key 泄露；Key 本身已走系统密钥库，见 4.3）。
- **保存**：**手动保存**（Ctrl+S），不做自动保存。需 **dirty 标记**（标题栏 `*` + 关闭前拦截）。
- **切换项目**：有未保存改动时**弹窗提醒**。
- **运行隔离**：Community 版**同一时刻只允许一个工作流在跑**；多工作流/多项目并行运行归入 Professional。
- **恢复上次界面**：**Community 一期就要实装**（记住上次打开的项目与激活工作流）。

### 5.2 旧数据迁移策略（已确认）

**问题**：现有工作流全在 localStorage（`slime-mold-workflow`），磁盘无对应文件。
改为「磁盘唯一真相」后若不处理，用户升级即见空白界面，误以为数据丢失。

**采用方案：静默自动迁移 + 事后可另存**
1. 首次启动检测到旧 localStorage 数据且无项目记录时，自动在默认位置
   （如 `文档/SlimeMold/默认项目/`）创建项目文件夹并写入全部历史工作流；
2. 正常打开该项目，标题栏提示一次「已迁移到 xxx，可另存到其他位置」；
3. **迁移后不立刻删除 localStorage 旧数据**，保留一个版本周期作为保险。

### 5.3 实施步骤（建议顺序）

- [x] **P0 补权限**：`capabilities/default.json` 增加 `fs:allow-mkdir`/`read-dir`/`remove`/`exists`，否则后续全阻塞。
- [x] **P0 修断裂点**：`projectName`/`projectId`/`projectCreatedAt`/`projectPath` 进 persist；`openProject` 传真实磁盘路径（修 `TopBar.tsx:138`，`openProjectFile` 带出 path）；`saveProject` 支持「保存到已有路径（projectPath 已知则直接覆盖，不弹另存为）」且不重写 `createdAt`。`ProjectFile` 新增 `id` 字段。
- [x] **P0 游离工作流入口**：「新建工作流」区分「新建到项目」与「新建游离工作流（指定位置，缺省落默认位置 `文档/SlimeMold/未归类/`）」；存档态记录 `belongsToProject?: string`（项目 id）或 `standalonePath: string`；编辑器据有无归属决定资产/变量作用域与运行历史落点。`WorkflowFile` 已加 `belongsToProject`/`standalonePath`；`serializeCurrent` 保留身份；导入工作流标记 `standalonePath`。
- [x] **P1 项目文件夹 IO**：`projectIO.ts` 从单文件改为目录读写（项目根下的 **`.slimemold/project.json`** + `.slimemold/workflows/*.json` + `.slimemold/runs/history.json`）；`openProjectFile`/`openProjectByPath` 支持目录形态（选根目录或 `.slimemold`）与旧版 `.smproj` 单文件**读**兼容；`projectRootFromPath` 解析项目根。`.slimemold` 为隐藏配置目录，与用户产物平级。`pickProjectFile`/`showSaveDirDialog` 在 `env.ts`。
- [x] **P1 dirty 标记**：`workflowStore` 引入 `projectDirty`/`lastSavedSnapshot`，订阅式派生比对（仅落盘相关字段变化才重算，跳过日志/运行态），`saveProject` 成功后清脏并记录快照，`openProject`/`newProject` 正确初始化；标题栏显示项目名 + `*` 星号；`beforeunload` 拦截未保存关闭。`isProjectDirty()` 供 UI 读。
- [x] **P1 旧数据迁移**：`openProjectByPath` 保留旧版 `.smproj` 单文件读兼容，返回带 `legacy` 标记；打开旧项目时 `addLog` 提示「保存时将自动转换为 .slimemold/ 目录结构」，用户首次保存即完成迁移，旧 `.smproj` 不动（保留一个版本周期）。
- [x] **P2 资产两级**：`ProjectFile` 增加项目级 `assets`；资产面板区分「项目资产 / 本工作流资产」（`scope` 切换 + 导入/删除路由到对应作用域）；executor 合并项目级与工作流级资产（工作流级同名覆盖）；删除项目资产时扫描所有工作流节点 params 做跨工作流 `assetId` 引用检测并提示；`serializeCurrent` 写回时保留当前工作流 `assets`（修复切换/保存丢资产隐患）。
- [x] **P2 变量两级**：项目级 variables 落 `ProjectFile.variables`（project.json 顶层），工作流级 variables 存 `workflows[x].variables`；求值时 `extraVars < 项目级 < 工作流级`（工作流覆盖项目）；`VariablesPanel` 分「项目级/工作流级」两个作用域编辑并标注覆盖关系（`被覆盖`/`覆盖项目`）。
- [x] **P2 成本跟项目**：`runHistory` 落盘到 `.slimemold/runs/history.json`（`ProjectFile.runs.history`）；`saveProject` 注入、`openProject` 读回；`RunHistoryPanel`/`TokenUsagePanel`/`StatusBar` 直接读 store.runHistory，天然按项目归属。全局 persist 仍保留 runHistory 作为无项目态兼容（打开项目后由磁盘主导）。
- [x] **P3 恢复上次界面**：上次打开/保存的项目根路径 + 激活工作流 id 存 `localStorage`（`sm.lastSession`）；桌面端启动时自动 `openProjectByPath` 恢复（含激活工作流，校验路径仍存在、跳过已持久化恢复的项目）；新建项目时清除会话记录；打开/保存/最近项目均更新会话。
- [x] **P3 项目欢迎页**：`WelcomeModal` 首屏（无项目加载时弹出，项目加载后自动隐藏），含「最近项目」列表（路径失效自动移除）、「新建项目」「打开项目…」；归档 `openProjectByPath` / `openProjectFile` / 会话持久化；与 P3 自动恢复互补（有上次会话时直接进画布，否则走欢迎页）。
- [x] **P3 新建项目引导（深做）**：用 `NewProjectModal` 替换原生 `window.prompt`；含项目名输入、起始模板卡片（8 个 starter 模板 + 空白画布，带节点数/分类/描述预览）、桌面端「保存位置」目录选择；`createProject` action 支持从模板载入首个工作流 + 指定 location 时新建即落盘 `.slimemold/` 并写会话；顶栏「新建项目」与欢迎页「新建项目」均走该引导弹窗。
- [x] **P3 空工作流态（关掉所有标签页）**：允许关闭到零工作流（`removeWorkflow` 进入无激活态）；`noWorkflows` 时不再渲染 React Flow 画布（去掉点状网格），改为纯色背景；欢迎页直接内嵌在背景上（非覆盖层）；关闭欢迎页仅隐藏（不再自动新建画布），退回纯色空态并提示「新建工作流 / 查看引导」。

---

## 三、其他潜在待做（未开始）

- [ ] 插件系统（plugin-examples 已有示例）与运行时执行链路联调。
- [ ] 节点执行引擎的流式输出与取消逻辑完善。
- [ ] 移动端/小屏适配。
- [x] 单元测试地基（Vitest，jsdom 环境）已立：覆盖 topoSort / expr / rateLimiter / nodeCache / subgraph / pipeline 共 84 项单测，`npm run test` 可回归（2026-08-07）。`npm run headless examples/headless-demo.json` 已接入 GitHub Actions CI（tsc + 单测 + 纯本地工作流冒烟），并修复了 headless 纯 Node 运行的两处缺陷（i18n 的 import.meta.glob 降级、tsconfig 别名）。

---

#### ✅ 步骤 7：dispatch.plan 规划节点 + 调试模式 + 体验修复（已完成，2026-08-04）
- **`src/nodes/builtin.ts`**：
  - 新增 **`dispatch.plan`（规划/编排）** 节点（分类「派发」，角色 `orchestrator`）：
    - 输入 `goal`，输出 `plan`(计划书) / `tasks`(任务清单 TaskItem[]) / `summary`(摘要)。
    - 参数：`agentId`(绑定规划智能体) / `roleId` / `modelOverride` / `format`(tasks|outline|free) / `simulate`(离线模拟)。
    - 真实模式调 LLM 生成计划并用 ```json``` 围栏解析任务数组；`simulate: on` 时不调 LLM、回显链路（含流式 `setPartial`），便于无 Key 验证。
    - 注册进 `builtinDefs`（位于 `dispatch.split` 前）。
- **`src/store/viewStore.ts`**：
  - 新增 `debugMode: boolean`（默认 false）+ `toggleDebug()`，随视图偏好持久化；临时态 `focusedSubgraphId` 仍不持久化。
- **`src/components/TopBar.tsx`**：
  - 运行按钮左侧新增 **🐛 debug 切换按钮**（lucide `Bug`），激活态高亮（accent + 浅底）；点开后在节点卡片显示调试动作。
- **`src/canvas/nodes/BaseNode.tsx`**：
  - 「重跑子图」(`retryNode`) /「重跑到此节点」(`runToNode`) 动作区改为**仅 `debugMode` 开启时**渲染（响应式 `useViewStore` 订阅）。
- **`src/components/Inspector.tsx`**：
  - 「最近输出」文本框硬编码 `bg-white` 改为 `bg-[var(--sm-bg)]`，跟随窗口深浅主题（边框/文字本就用主题变量）。
- **`src/components/NodePalette.tsx`**（**P0 卡死修复**）：
  - 修复 `NODE_ROLE_META` 误用 `import type` 被编译擦除 → 运行时 `ReferenceError` → ErrorBoundary 无限重建死循环（点开节点库即卡死）。改为独立 `import { NODE_ROLE_META }`。
- **`src/components/TemplateSuggestions.tsx`**（新增）：打开节点库时渲染的模板建议面板，已加 try/catch 防御旧 `runHistory` 数据。
- **文档**：`USAGE.md` 新增 §7「规划节点与调试模式」+ 快捷键表补充；`README.md` 功能列表补充规划/派发与调试模式。
- **示例**：`examples/test-dispatch-plan.workflow.json`（input.text → dispatch.plan → 三个 output.text），headless 已验证 5/5 节点跑通（模拟模式）。

**验证**：`npm run headless` 跑通测试工作流；GUI 实测运行、主题跟随、debug 模式显隐均正常（用户已确认）。

**框架边界（本轮刻意未做）**：
- 真实 LLM 规划输出格式校验仅做 ```json``` 围栏兜底，未做严格 schema 校验。
- `dispatch.plan.tasks` 到 `dispatch.split` 的整条「规划→派发」闭环未做端到端示例（仅单节点验证）。

#### ✅ 步骤 8：Dispatcher 写回 scope + Resolver 建议串行顺序（已完成，2026-08-04）
> 对应 TODO「三、其他潜在待做」与步骤 3 收尾里点名的「Dispatcher 写回 scope」「Resolver 真重排」。

**阶段 A：打通 scope 数据通路（Dispatcher 写回 task 边 scope）**
- **`src/types.ts`**：
  - `ExecContext` 新增 `writeOutEdgeScope?(handle, scope)`：节点执行时把某输出端口的影响域写回对应 task 连线。
  - `WorkflowFileEdge` 新增 `scope?: string[]`（与 `FlowEdgeData.scope` 对应）。
- **`src/engine/executor.ts`**：`ctx` 注入 `writeOutEdgeScope`，按 `source + sourceHandle` 匹配，把 scope 写回该 task 边的 `data.scope`（经 `useWorkflowStore.setEdges`）。
- **`src/store/workflowStore.ts`**：
  - 新增 `setEdges(updater)` action（函数式更新）。
  - 4 处 edge 序列化（`storedEdgeOf` / `serializeCurrent` / `loadGraph` 收纳 / `updateSubgraph` 收纳）补 `scope: e.data?.scope`。
- **`src/nodes/builtin.ts`**：`dispatch.split.execute` 改为带 `ctx`，对每个 task 端口（task1~task4）调 `ctx.writeOutEdgeScope(handle, task.scope ?? [])`，把任务影响域标注到 task 连线上。
- **`src/io/workflowIO.ts`**：导出序列化补 `scope`，导入反序列化读回 `scope` 到边 `data`。
- **验证**：直接调 `nodeDispatch.execute` + 捕获 `ctx.writeOutEdgeScope` 调用，确认 task1→["fileA.ts"]、task2→["fileA.ts"]、task3→["fileB.ts"]、task4→[] 正确按端口写回。headless 因不复用全局 store 无法直接验证写回（预期内）。

**阶段 B-lite：Resolver 建议串行顺序（冲突自动解集的轻量闭环）**
- **`src/nodes/builtin.ts`** `coord.resolver`：
  - 新增输出端口 `serialOrder`（建议串行顺序，list）。
  - 检测到 scope 冲突后，按「争用同一 scope」聚合为串行组，给出建议执行顺序 `order: string[]`（按上游出现先后）；多组不相交的冲突各自成组。
  - `report` 模式从 `serialOrder` 端口输出；`block` 模式报错信息附带「建议串行化顺序」提示。
  - 无冲突时 `serialOrder` 为空。
- **验证**：直接调 `nodeResolver.execute`，report 模式输出 `serialOrder=[{scope:["fileA.ts"],order:["写A","写B"]},{scope:["fileB.ts"],order:["写C","写D"]}]`；block 模式错误信息含串行化建议；无冲突时 `serialOrder=[]`。

**设计说明**：
- B-lite 沿用 resolver 既有约定（scope 从上游**节点输出值**取 `{scope:string[]}`），与阶段 A 的「边写回 scope」是两条并行通道，互不冲突；阶段 A 让 scope 持久化在边上（供未来执行引擎读），B-lite 让 resolver 从上游输出读 scope 做检测+建议。
- B-lite **不改执行引擎**，零风险：只「建议」串行顺序，实际要不要把并行改串行仍由用户/后续 B-full 决定。

**框架边界（留给后续）**：
- `coord.resolver` 从「入边 scope」读取（利用阶段 A 边写回）尚未接：当前仅从上游输出值取 scope。接上后施工节点无需手动在输出塞 scope。
- `isValidConnection` 加 `PortDef.flow` 一致性校验（步骤 1 收尾）仍未做。

#### ✅ 步骤 9：执行引擎按 scope 自动串行化（B-full，已完成，2026-08-04）
> 步骤 8 的 B-lite 只「建议」串行顺序；B-full 让执行引擎**自动**消解冲突。

- **`src/engine/executor.ts`**：
  - stage 调度内新增「scope 分区」：同 stage 内两两比较节点入边（task 边）的 `data.scope`，**相交即冲突**。用**并查集（union-find）**把冲突节点合并为同一「串行簇」，簇内按列表顺序串行执行，不同簇之间 `Promise.all` 并行——最大化并行度同时消解并发争用。
  - 踩坑修正：并查集需**预先把本层所有节点初始化进 parent**（不能边遍历边初始化），否则内层 `find` 未初始化节点返回 `undefined` 导致错误全合并；算法经单测验证（两对独立冲突→两组、三角传递冲突→全串、无 scope→全并行均正确）。
  - `writeOutEdgeScope` 改为**双写**：① 直接 mutate 执行器局部 `edges` 数组（保证本次调度 `scopesOf` 立刻读到写回的 scope，串行化生效）；② 经 `useWorkflowStore.setEdges` 同步全局 store（持久化 + Inspector 展示）。
- **验证**：并查集分区算法用独立脚本断言通过；单元级确认 `dispatch.split` 在 `tasks` 入、`task1~4` 出边的 scope 写回链路（阶段 A 已验证）。**端到端真实串行行为需在桌面端 GUI 跑含冲突 scope 的工作流观察**（headless 走独立 `runWorkflowHeadless` 未接此调度，故不覆盖）。

**框架边界（留给后续）**：
- `runWorkflowHeadless` 未复用 `runWorkflow` 调度内核，B-full / 阶段 A 边写回在 headless 下不生效；若需 CLI 验证需收敛两路。
- `coord.resolver` 从「入边 scope」读取（利用阶段 A 边写回）尚未接。
- `isValidConnection` 加 `PortDef.flow` 一致性校验（步骤 1 收尾）仍未做。

#### ✅ 步骤 10：architect.design 架构节点（已完成，2026-08-04）
> 补齐脑洞「1. 端到端工作流」第 2 阶段 **架构师（Architect）** 节点，使规划→架构→派发→施工→协调五层链路完整。

- **`src/types.ts`**：
  - 新增 `ModuleItem` 接口（`name` / `responsibility?` / `scope?` / `dependsOn?` / `payload?` / `index?`），与 `TaskItem` 平行，专供架构产出。
  - `NodeRole` 类型增加 `'architect'`。
  - `NODE_ROLE_META` 增加 `architect: { label: '架构', color: '#6366f1', hint: '技术设计、模块划分与接口规划' }`。
- **`src/nodes/builtin.ts`**：
  - 新增 **`architect.design`（架构师）** 节点（分类「派发」，角色 `architect`）：
    - 输入 `goal`(text)、`constraints`(text，可选，常接 `dispatch.plan.plan`)。
    - 输出 `design`(text 设计书) / `modules`(list，ModuleItem[]) / `summary`(text)。
    - 参数 `agentId` / `roleId` / `modelOverride` / `format`(modules|diagram|free) / `simulate`(off|on)。
    - 真实模式调 LLM 生成架构并解析 ```json``` 围栏数组；`simulate: on` 离线回显链路（含流式 `setPartial`），便于无 Key 验证。
    - 调 `extractModulesFromDesign(text, fallbackGoal)` 解析模块数组，解析失败降级为单模块。
  - 新增 `extractModulesFromDesign(text, fallbackGoal): ModuleItem[]`，从 ```json``` 围栏提取 `name`/`responsibility`/`scope`/`dependsOn`/`payload`/`index`。
  - `builtinDefs` 在 `dispatch.plan` 后插入 `nodeArchitect`（确保 `modules` 可直接接 `dispatch.split.tasks`）。

**协议兼容**：`ModuleItem`（name/responsibility/scope/dependsOn/payload）与 `dispatch.split` 期望的 `TaskItem`（label/payload/scope）字段对齐——`modules` 输出可直接接 `dispatch.split.tasks`，形成 `dispatch.plan → architect.design → dispatch.split` 无缝串联。

**验证**：
- 单元级：直接 import `nodeArchitect` 用模拟 ctx 调 `execute({simulate:'on'})`，断言 `modules` 可被 `dispatch.split` 消费（解析/扇出链路通过）。
- 端到端：`tsc --noEmit -p tsconfig.app.json` 无新增错误。
- 工作流示例：`examples/test-architect.workflow.json`（`input.text → dispatch.plan → architect.design → dispatch.split → 3×worker.scaffolder → coord.resolver / output.text`），`npm run headless` 验证 **10/10 节点 success**（全 simulate 模式，无需 API Key）。
- 文档：`USAGE.md` 新增 §7.3「节点分层对照表」；`README.md` 功能列表补充分层编排说明；本步骤记录。

**框架边界（本轮刻意未做）**：
- 真实 LLM 架构输出仅做 ```json``` 围栏兜底，未做严格 schema 校验。
- `format: diagram` / `free` 两种产出形态在当前 `execute` 仅作参数占位，未展开不同渲染路径（统一走 modules 解析）。

---

#### 🔲 步骤 11：协调者逻辑升级 —— 沙箱式并行 + 合并/仲裁/回流（已达成共识，待实施）

> 来源：2026-08-04 用户与 AI 关于「coord.resolver 工作逻辑」的三轮讨论。
> 核心判断：**当前项目内部没有沙箱运行逻辑**（见下「现状确认」），本步骤要把用户设想的「并行改副本 → 协调者合并 → 冲突仲裁 → 回流上游」落地。

##### 11.0 用户目标模型（最终拍板）
1. **针对同一文件的修改允许并行操作**：多条任务线在各自隔离环境里改同一文件的副本，互不踩踏。
2. **协调者做逻辑冲突检查**：各线跑完后交给 `coord.resolver` 比对。
   - 无逻辑冲突 ⇒ **合并为同一个文件**（汇总各副本的合法改动）。
   - 运行逻辑本身冲突 ⇒ 把**双方观点交给 `council` 节点仲裁**；仲裁结论/冲突原因**回流给上游 `dispatch.split` 或更上游决断**（重派任务 / 改方案）。
3. **scope 方案先按「并存」**：对象自带 scope（现有 `TaskItem.scope`）与连线 scope（`FlowEdgeData.scope`，步骤 8 已写回）同时生效；但**预留好之后剪枝的空间**（见 11.1）。

##### 11.1 scope 并存 + 剪枝预留抽象层（先做，零风险）
- 新增 `collectScopes(entry, edgeScope)` 归一函数：先 `object.scope` 与 `edge.scope` 取并集（并存），输出统一 `string[]`。现在只有 `object.scope`，将来把连线 scope 直接并进来即可。
- `conflicts` / `serialOrder` 输出结构增 `source: 'object' | 'edge' | 'both'` 字段——剪枝阶段（未来）据此后可实施「只信连线 scope」「对象 scope 仅作提示」等策略，不动检测主逻辑。
- **检测主逻辑（两两交集）保持不变**，变的是「scope 从哪来」这一层，把它抽象出来即剪枝接入点。

##### 11.2 方向①（自动串行化）与 ⑤（边级协调）的启用/阻断关系（已澄清，作为设计约束）
| 项 | 启用方式 | 是否阻断 | 与谁耦合 |
|---|---|---|---|
| ① 自动串行化 | 新增 `autoSerialize` 开关（false=只输出建议，true=引擎按 `serialOrder` 强制改串行） | 否（只改顺序） | 与⑤互补：①管「冲突后怎么排」，⑤管「谁算冲突」 |
| ⑤ 边级协调 | 接通 `FlowEdge` → `execute` 的 edge.scope 通路（步骤 8 已写回，待 resolver 读取） | 否（只细化判定粒度） | 依赖 11.1 并存/剪枝抽象层 |
| `mode=block` | 现有 `params.mode` | **是**（throw 阻断下游） | 阻断触发面受①⑤影响——⑤越细，误阻断越少 |

> 一句话：`block` 是唯一真正「阻断」开关；①⑤都不阻断，①决定冲突后如何串行化消解，⑤决定哪些算冲突（更细粒度），二者通过 11.1 抽象层协同，都不影响 `block` 裁决权。

##### 11.3 现状确认：项目内部无沙箱运行逻辑
- 执行引擎（executor.ts:339-392）按 stage 并发跑同层节点（真并行），但**所有节点共享同一 `ctx`**：无 per-branch 私有工作区、无文件副本、无状态快照。`branchState` 只是端口激活/剪枝状态表，非文件/状态隔离。
- 唯一「隔离」是 LLM 上下文隔离（`contextScope==='isolated'`，builtin.ts:176），仅影响 prompt，与运行期文件/状态沙箱无关。
- 当前节点**无真实文件写副作用**（节点输出都是内存对象，经 `ctx.llm` 返回文本；`writeFile`/`fs.write` 命中均在 IO 序列化层，非节点执行副作用）。即「对同一文件并行修改」尚未真实发生，协调者拿到的是文本/对象而非文件版本。

##### 11.4 落地路线（建议分阶段，先逻辑层模拟、再接真沙箱）
- ✅ **阶段 A（低成本，逻辑层模拟）**：已落地。`coord.resolver` 新增 `mergeMode='content'` 模式，接收 `FilePatch`（`{path, before, after, readSnapshot}`），做内容级合并/冲突检查（同 path 行区间不重叠直接拼合；区间重叠或 `readSnapshot.hash` 不一致归入 `needsArbitration`）；无冲突输出 `MergeResult`（建议下游接 Validator，对应 11.6 方案①）。`FilePatch`/`MergeResult` 类型见 types.ts。
- ✅ **阶段 B（council 仲裁节点 + 回流回路）**：已落地。`coord.council` 节点（nodeCouncil）实现：并行层多议员 `ctx.llm` 评估 + 独立合成智能体提炼 single verdict + `consensus` 评级（`unanimous`/`majority`/`split`）+ 部分失败容错（对应 11.7.1 映射）。回流回路仍可经 `control` 边回指 `dispatch.split`（control 边语义已支持，见 builtin.ts loopGate 说明）。
- ✅ **阶段 C（真沙箱，已落地 2026-08-04，2026-08-04 二次增强）**：`RunOptions.sandbox` 开关 + `ExecContext.sandbox`（SandboxHandle）注入。`executeNode` 在 `sandbox:true` 时为每个节点构造隔离目录 `workspaceDir/.sandbox/<nodeId>/`，并行 Worker 写文件互不踩踏；协调者（coord.resolver / coord.council）经 `commitLanes(laneIds)` 把各上游车道沙箱汇总落地主工作区。`tool.writeFile` 检测到 `ctx.sandbox` 即写沙箱副本（标记 `inWorkspace:false`）；浏览器环境退化为内存态。运行菜单新增「沙箱隔离运行」入口；示例 `examples/test-realsandbox.workflow.json`（双 Worker 并行写同一 result.txt → resolver 汇总落盘）可演示。
  - **自动清理（本轮新增）**：`sandboxRootsUsed` 集合登记本次运行真实根，`runWorkflow` 结束（含被中止）经 `cleanupSandbox()` 统一递归删除 `.sandbox/` 残留，避免磁盘堆积；模块级幂等、可重复调用。
  - **FilePatch 打通（本轮新增）**：`tool.writeFile` 在沙箱模式下额外产出 `FilePatch` 端口（`{path, before(写前快照), after, readSnapshot}`），`before` 为空表示新建、非空表示覆盖；协调者 `resolveByContent` 消费该 patch 做内容级合并（阶段 A↔C 打通），`commitLanes` 仍负责落盘。
  - **Git Worktree 强隔离（本轮新增）**：`RunOptions.sandboxMode: 'copy' | 'gitworktree'`；为 `gitworktree` 时经 Rust `run_git` command（std::process::Command 调系统 git）创建 detached worktree（`.slime-wt/<branch>`），所有节点沙箱根指向该 worktree，结束统一 `git worktree remove --force` 清理。仅在 Tauri 桌面端 + 当前 workspaceDir 为 git 仓库时启用，否则自动降级 `copy` 并记日志。TopBar 新增「Git Worktree 强隔离运行」菜单项；`src/platform/git.ts` 封装 `isGitRepo/addWorktree/removeWorktree`。
  - **阶段 D（节点能力分级 Capability，本轮新增 2026-08-04）**：`NodeDefinition.minCapability`（`CapabilityLevel`：`compute | io | sandbox_write | coordinator | system`）。`executor.applyCapability(ctx, def, opts)` 在 ctx 构造后按等级裁剪注入（compute 禁 llm/storage/sandbox；io 禁 sandbox；sandbox_write 剥离 commitAll/commitLanes 且收口 addAsset 为 `inWorkspace:false`；coordinator/system 全权限）。`resolveCapability` 在未显式声明时按 `typeId` 前缀推断默认等级（coord.→coordinator、tool.writeFile/fs.→sandbox_write、agent./ai./llm/http/io./tool./worker./architect./dispatch.plan/flow.map/image.→io、其余→compute）。**插件节点默认 `io` 级**（loader 注入，避免第三方越权拿落地权）。`ctx.storage` 进一步细化到节点实例级 scope（`pluginId:typeId:nodeId`），同插件不同实例存储隔离。

##### 11.5 与现有步骤的衔接点
- `coord.resolver` 现为「检测 + 输出建议」，需升级为「接收 FilePatch / 内容级合并 + 冲突出口接 council」（不破坏现有 `merged/conflicts/serialOrder` 出口，新增合并产物与 council 出口）。
- 步骤 8 阶段 A 已把 task 边 scope 写回，11.1 的并存抽象层直接消费；步骤 9 的并查集自动串行化（`autoSerialize` 一旦实现）与 11.2① 一致。
- `council` 节点分类可归入「协调」；回流控制流复用现有 `control` 边 + `topoStages` stage 边界语义。

**✅ 已落地（2026-08-04）**：A、B 并行实现完成，tsc 通过。`coord.resolver` 支持 FilePatch 内容级合并（mergeMode 参数切换旧 scope 逻辑）；新增 `coord.council` 仲裁节点（并行议员 + 独立合成 + 共识评级 + 容错）。回流回路（control 边 → dispatch.split）链路已就绪，待实际工作流编排时串联。

##### 11.6 对标 oh-my-opencode（Sisyphus）的经验教训与两种方案（2026-08-04 补充）
> 调研对象：oh-my-opencode / 现名 oh-my-openagent（GitHub: code-yeongyu/oh-my-openagent），核心 Sisyphus 多智能体框架。
> 结论：**OMO 没有真沙箱、没有合并/仲裁引擎**，其并行改文件走的是另一条路，对我们有反向启示。

**OMO 的实际做法（与我们不同）**：
- **无沙箱 / 无 per-agent 副本**：所有 agent 直接读写同一真实工作区（同一 git 仓库），无文件系统隔离；仅 skill 级临时 MCP 服务器（上下文干净，非文件隔离）。
- **冲突靠「写入前 CAS 拒绝」而非「事后合并」**：Hash-Anchored Edit Tool（Hashline）——每行读取带内容哈希（`11#VK| function hello()`），agent 用 `LINE#ID` 引用编辑；若文件自读取后被改过、哈希不匹配 ⇒ **编辑被拒绝**（非覆盖）。本质乐观锁 / 行级 CAS。
- **无仲裁节点**：预防优先（Hashline 拒绝陈旧编辑）+ LSP 工作区重命名/引用分析发现符号冲突 + Git 原子提交/rebase 兜底合并；编排器靠串行调度规避混乱，不在汇聚点仲裁。
- **实测教训**：纯文本/行级 diff 易漏「语义冲突」（两人改同一函数不同行，逐行不冲突但逻辑矛盾）→ 靠 **LSP + 编译/测试** 兜底。

**对我们的启示**：我们的「并行改副本 → 协调者合并 → council 仲裁 → 回流上游」范式比 OMO 更超前、更契合节点工作流；但需规避其踩过的语义冲突坑。落地两种方案：

- **方案 ①：合并后必接 Validator/Tester 兜底（推荐，低成本）**
  - FilePatch 文本级合并（11.4-A）只能解「文本不重叠」的浅冲突；真正的逻辑冲突要靠 **Validator / Tester 节点在合并后跑一遍**（编译/运行/单测）才能放心。
  - 复用已有资产：`validator` 自主节点（步骤 5，内部 think→评估→带批评重跑）+ 步骤 4 的 loopGate 循环语义（不合格自动重跑）。
  - 即：协调者 `merged` 产物不直接当终态，而是喂给下游 Validator；Validator 失败 ⇒ 回流 council / dispatch.split 重派（与 11.0-2 回流链路打通）。

- **方案 ②：Hashline 式快照哈希折中（不强制真沙箱，更稳）**
  - 借鉴 OMO：不建文件系统沙箱，但给每条任务线输出带「它读了哪些文件、哪些行、哪个版本快照哈希」的元数据（`FilePatch` 扩展 `{path, before, after, readSnapshot: {lineRange, hash}}`）。
  - 合并时若发现「别人已动了同一处（哈希区间重叠且 after 基于旧版本）」⇒ **不盲目自动合并，而是标记「需人工 / council 仲裁」** 并交 11.4-B 的 council 节点。
  - 比纯 FilePatch 更稳，且无需文件系统隔离即可实现；与 11.1 的 `source` 标记、11.2 的 `block` 阻断可联动（快照冲突直接走 `block` 或 council）。

> 两种方案不互斥：方案 ① 是「合并后的质量闸门」，方案 ② 是「合并前的精准冲突识别」，建议 11.4-A 实现时一并带上 `readSnapshot` 字段（方案②）并把 merged 出口默认接 Validator（方案①）。

##### 11.7 三项目比对结论（2026-08-04 补充：oh-my-opencode / oh-my-opencode-slim / ComfyUI）
> 调研来源：GitHub README（alvinunreal/oh-my-opencode-slim，1.5k+ commits / 7.7k stars）+ 原版 oh-my-openagent 仓库 + ComfyUI 范式。
> 网络状态：**已补全**。`ohmyopencodeslim.com/docs/*` 子页 404（不存在），但经 `github.com/.../blob/master/docs/worktrees.md` 与 `council.md` 抓取成功（raw 亦通，先前超时系偶发）。正文细节见 11.7.1。

| 维度 | 原版 OMO（openagent） | **OMO-slim** | ComfyUI | SlimeMold（我们） |
|---|---|---|---|---|
| 隔离机制 | 无沙箱；Hashline 行级 CAS 拒绝 | **Git Worktrees（`.slim/worktrees/` lanes，共享同一 git db）** | 无 | 暂无；11.4 规划 FilePatch→真沙箱按需 |
| 并行模型 | Team 并行+后台 | **后台任务默认并行**（Tmux/Zellij 可视） | 节点 DAG 并行（非多 agent） | executor 按 stage 真并发（11.3） |
| 冲突时机 | 写入前哈希校验 | 隔离避免 + **集成前 diff 展示 + 显式批准（非自动合并）** | 无 | 协调者事后比对（规划） |
| 仲裁/合并 | 无仲裁；LSP+Git 兜底 | **Council：多模型并行→合成 single verdict** | 无 | 规划 `council` 节点+协调者合并 |
| 成本约束 | — | Council 高成本、**手动触发** | — | 借鉴：council 仅冲突时启用 |

**关键结论：OMO-slim 几乎印证了 11.0 设计**：
1. Worktree = 我们的「并行改副本」：slim 用 `.slim/worktrees/` 隔离车道，对应我们 11.0 各路隔离改副本（它是 git 分支隔离，我们是逻辑层 FilePatch→真沙箱可选）。
2. Orchestrator reconcile = 我们的「协调者合并」：slim 的「派发后台→跟踪→调和结果再继续」正对应 `coord.resolver` 的 `merged` 出口。
3. Council = 我们的「council 节点仲裁」：slim 的「多模型并行→收集竞争判断→Council agent 提炼单一裁决」即我们 11.0「双方观点交 council 仲裁」的现实版。
4. 回流上游：slim 的 Orchestrator 本身是重派决策点，等价于我们「冲突回流 dispatch.split/更上游」。

**对 SlimeMold 的修正建议**：
- OMO-slim 比原版 OMO **更值得对标**：原版靠 Hashline 拒绝（对应 11.6 方案②），slim 靠 worktree+Council 合成（对应 11.0+11.4-B）。两条路我们都要。
- **Council「多模型合成 single verdict」范式**比单纯表决更适合做我们的 council 节点实现参考（而非逐条投票）。
- **重要教训**：slim 的 Council 是高成本路径、默认**不自动调用**——提醒我们 council 节点必须**仅在 resolver 判冲突后触发**，不能每条线都跑（对应 11.4-B 触发条件设计）。

##### 11.7.1 OMO-slim 文档正文细节（2026-08-04 抓取补全）
> 来源：`github.com/alvinunreal/oh-my-opencode-slim/blob/master/docs/worktrees.md`、`/docs/council.md`（经 raw 成功）。

**A. Worktrees / Lanes（worktrees.md）**
- **它是「安全协议」而非 git 教学**：技能本身不解释 worktree 原理，而是提供一套隔离编码安全流程——规划 lanes、分配 agent、校验 diff、集成变更、清理且不丢用户工作。
- **创建**：Orchestrator 在 `.slim/worktrees/<slug>/` 建本地 worktree（共享同一底层 git db，但独立于主 checkout）；登记 `.slim/worktrees.json`（活动 lanes、branches、base refs、purpose、owner、area、status）。
- **门控（确认门槛）**：建/删 worktree、建/删 branch、merge/rebase/cherry-pick/prune 等破坏性命令**全部需显式批准**；拒绝移除 dirty worktree 或未合并分支；**禁止自动执行 `reset --hard`/`clean`/force-push/删分支**。
- **使用**：Specialist（`@fixer`/`@designer`）被限定在指定 lane 内写代码+跑测试；Orchestrator 拥有协调权，Specialist 不应自行跑 lane 管理 git 命令。
- **⚠️ 关键修正**：文档**未描述 worktree 间冲突的自动解决**。每 lane 基于 base 分支独立工作，集成前仅「在 lane 内跑检查 → 展示相对 base 的 diff → 显式批准集成」。即：**omo-slim 没有自动合并算法**，合并靠"隔离避免 + 人工批准 diff"，所有 mutating git 操作须人确认。
  - 这对我们的启示：**自动合并比想象中更难**，slim 选择"不自动合并、只做隔离+门控+人工批准"。我们的 11.0「无冲突则合并为同一文件」若要做成全自动，需比 slim 更激进——应考虑在协调者 `merged` 出口**保留人工/准自动批准闸**（对应 11.6 方案①Validator 兜底），而非盲目自动写回。

**B. Council agent（council.md）**
- **机制**：Council agent 并行跑多个 **councillors（议员）**，再合成为单一答案。价值：跨模型交叉验证、多样视角、部分失败优雅降级、可配成本/速度预设。
- **并行派发**：每个 preset 内的议员注册为动态子代理 `councillor-<name>`（各自独立模型），Orchestrator 经 OpenCode 原生 `task()` 在 depth 1 **并行派发**，每个议员独立 TUI 面板。议员模型在 `council.presets.<preset>.<councillor>.model` 定义，可为单 `provider/model` 字符串或含备用链的数组（Model Fallback Chain，按顺序尝试至响应）。
- **收集**：Council agent **等待所有议员响应或失败**再处理。容错：部分失败→用成功者合成；全部失败→返回错误；零议员→返回错误。
- **合成（两层模型分离，关键）**：
  - **synthesizer 模型**（做最终综合，即 `@council` 背后模型）：**不**在 `council.presets` 内，而经常规 agent 系统设置（`presets.<name>.council.model`）。
  - **councillor 模型**（实际并行扇形展开）：始终来自 `council.presets...model`，与 `agents.councillor` 无关。
- **输出三件套**：① Council Response（合成最终答案）② Per-Councillor Details（各议员独立回复）③ Council Summary（一致性、分歧解决、剩余不确定性 + 共识置信评级 `unanimous` / `majority` / `split`）。
- **对我们的实现映射**：做 `council` 节点时——
  1. 并行层 = 多个并行的「评估子节点/LLM 调用」（对应 councillors），各自独立 agent/model；
  2. 合成层 = council 节点本身（对应 synthesizer），**必须由独立的、不同于并行层的模型/角色承担**；
  3. 输出须带 `consensus: unanimous|majority|split` 评级，供下游（dispatch.split / 用户）判断是否需要重派；
  4. 须支持「部分议员失败→用成功者合成」的容错（对应我们 executor 的 `skipFailed` 语义）。

---

#### 🔲 步骤 12：画布编辑体验统一（删除 / 对齐分布 / 边重连，待实施）

> 来源：2026-08-04 用户指出三项画布交互待做，确认不在现有 TODO 内，故新增本步骤。
> 目标：补齐基础编辑体验，消除「单删 vs 批量删」路径分歧，提供节点对齐分布与边端点重连能力。

##### 12.1 统一 `deleteSelected` 语义
- 现状：`deleteSelected` 在 `src/store/workflowStore.ts` 与 `src/components/TopBar.tsx` 均有出现，疑似**只删单个**；而多选/框选后的批量删除走的是另一条路径（React Flow 的 `onNodesDelete` / `onEdgesDelete` 或键盘 `Backspace`/`Delete` 默认行为），两条路径状态更新可能不一致（脏标记、缓存、连线清理等）。
- 任务：把「删除」收敛为**单一入口** `deleteElements({nodes, edges})`，单删与批量删都调用它，保证：
  - 节点删除时一并清理其相关边（`getConnectedEdges`）；
  - 走 `workflowStore` 方法（不可直接 mutate），保证 `projectDirty` 自动检测与持久化生效；
  - 清理被删节点的执行缓存（`nodeCache`）、变量/子图引用等副作用；
  - `TopBar` 的删除按钮与画布键盘删除调用同一逻辑。
- 验收：选中 1 个 / 选中 N 个删除，行为一致、无残留边、脏标记正确。

##### 12.2 对齐 / 分布工具栏
- 新增画布工具栏按钮组（可置于 `TopBar` 或画布浮层）：
  - **对齐**：左对齐 / 水平居中 / 右对齐 / 顶对齐 / 垂直居中 / 底对齐（基于选中节点 `position` + `width/height` 计算基准）。
  - **分布**：水平等距分布 / 垂直等距分布（按选中节点中心点均匀排布）。
- 实现：工具栏调用 `workflowStore` 的 `updateNodePositions`（走 store 方法，触发脏标记）；仅在选中 ≥2 个节点时启用。
- 验收：多选节点后点击对齐/分布，节点实时重排且可撤销（若 store 支持 undo，则一并接入）。

##### 12.3 边的 reconnect（拖拽换端口）
- 接入 React Flow 的 `onReconnect` + `reconnectEdge`：拖动已有边的一个端点改连到其他兼容端口。
- 需配合：
  - `isValidConnection` 做类型 / `PortDef.flow` 一致性校验（步骤 1 收尾点名的 `isValidConnection` 一致性校验顺带补强）；
  - `wouldCreateCycle` 即时拦截成环（复用 `topoSort.ts` 现有逻辑，reconnect 时也须检查）；
  - 更新 `FlowEdge` 的 `source/target` 与 `sourceHandle/targetHandle`，走 store 方法保证脏标记。
- 验收：拖动边端点可改连、非法连接被拒、成环被拒、脏标记正确。

---

#### 🔲 步骤 13：节点三层抽象（人类-职业-个人）+ 继承式提权后门（已达成共识，待实施）

> 来源：2026-08-04 ~ 08-05 用户与 AI 关于「custom node 提权后门」「ComfyUI 对比」「basemod 类比」的多轮讨论。
> 核心判断：当前 `custom_nodes/` 的安全边界是 loader 在加载期**硬编码封顶 io**（`capFor` 对 `source='custom'` 一律裁剪）。这虽安全，但"提权"只能改源码，门槛=会改 TS/Rust，太硬。
> 用户提出更优雅的模型——**把权限边界对齐到节点的抽象层级**，而非做成配置文件开关。

##### 13.0 用户目标模型（最终拍板）

**节点系统应是分层鲜明的抽象，类比「人类 — 职业 — 个人」：**

1. **第一层 · 人类（所有节点的元抽象）** = 基类 `Node`（或 `BaseNode`）。
   - 定义"什么是节点"：输入、输出、参数、执行、报错、中止。
   - **权限天花板由这一层决定**：框架把多少能力放进基类，决定了继承者能到多高。
2. **第二层 · 职业（分工的抽象）** = `ComputeNode` / `IoNode` / `SandboxWriteNode` / `CoordinatorNode` / `SystemNode` 等"职业类"。
   - 一个职业**不是单个节点，而是一类节点的模板**：预置固定的输入/输出形态、默认行为、共享逻辑。
   - **custom node 不止能造"一个具体节点"，还能定义"一类节点"——即创造出一种新的职业**（如"文件读写工"职业，天生带路径输入+内容输出+落地能力），他人/自己再基于该职业快速派生多个具体节点。
3. **第三层 · 个人（各方法的微调实现）** = 具体节点的 `execute` 或重载 `onInput`/`validate`/`serialize` 等。
   - 只是对职业默认行为的局部替换；其余全部复用职业的预设。

**继承式提权（取代"配置文件后门"）**：
- 写 `executors` 函数的用户 = 只在第一层之下活动（系统给的 `ctx` 是"裸人"），自然只有基础能力，**不需要后门、也不可能越权**。
- 继承"职业类"的用户 = 站在第二层，**自动获得该职业的全部预设能力（含高权限）**——提权是继承的自然结果，不是漏洞。
- **门槛天然成立**：想拿高权限，就得 `import` 并继承对应的"职业父类"。职业父类是框架暴露的、有文档、有命名的公共 API；普通用户写个 `executors` 函数根本够不着。

##### 13.1 对标 basemod（游戏 mod 框架）的映射（用户原话意向）

- **简单 mod = 一个声明文件**（basemod 的 xml）：只能按约定语法"调用"框架已暴露的原生函数，调不到没暴露的能力 → 天然安全。对应现在的 `manifest.json` 声明 + 简单 `executors`。
- **复杂 mod = 一个项目文件夹**：能写自己的函数实现，也能**继承原生父类、重载原函数方法**来提权。门槛 = "懂框架 SDK 继承结构并主动 import 受限类"。
- 结论：提权不该是"开关"，而是"你愿意写多复杂的代码"。简单声明永远安全；写代码继承原生类就自己承担那段能力。

##### 13.2 当前 custom node 形态与此模型的差距

- 现状：`custom_nodes/<pack>/` 下 `manifest.json`（平铺 nodes 数组，每个 node 自顾自声明端口）+ `index.js`（`export default { executors: { [typeId]: fn } }`）。这等于"每个人单独出生，没有职业"。
- 缺：①节点只能平铺、不能"定义职业"；②`index.js` 只能写 `executors` 函数、不能 `extends` 职业父类；③`capFor` 硬编码封顶 io，继承提权路径未开。

##### 13.3a 职业类暴露方法清单（已与用户确认 · 2026-08-05）

> 对齐现有 `ExecContext`（`src/types.ts:287`）字段与 `applyCapability`（`src/engine/executor.ts:124`）裁剪逻辑。
> 两项已拍板决策：
> - **(1) 职业类用继承链**：高等级 `extends` 低等级，方法自然累积；用户造的新职业可 `extends` 任意框架职业（阶段 E）。
> - **(3) `SystemNode` 必须细分**：不直接暴露任意 shell，只给受限封装（`GitNode` 仅暴露 git 相关命令），避免后门变真后门。

**继承链（方法逐级累积）：**

```
Node (人类 / L0 基座)
 ├─ 始终可用：logger / vars / signal / costLog / reportCost / setPartial / setBranches?
 │
 ├── ComputeNode (compute 职业)        → 无新增（纯计算只读）
 │
 ├── IoNode (io 职业)                  → + llm() / storage.get·set / addAsset() / assets(读) / writeOutEdgeScope?
 │
 ├── SandboxWriteNode (sandbox_write)  → 继承 IoNode + sandbox.writeFile / sandbox.readFrom / sandbox.list
 │                                     （commitAll / commitLanes 在基类里是「拒绝型」默认实现，本层不可落地主工作区）
 │
 ├── CoordinatorNode (coordinator)     → 继承 SandboxWriteNode + sandbox.commitAll / sandbox.commitLanes（真落地权）
 │
 └── SystemNode (system)               → 继承 CoordinatorNode + 受限系统封装（见下，不直接给 shell）
       └── GitNode (细分)              → 仅暴露 runGit(...) 受限 git 命令封装（如 worktree 操作），不暴露任意 command
```

**各层暴露的原生方法（按 ExecContext 字段映射）：**

| 职业类 | 新增暴露方法（ctx 字段） | 备注 |
|---|---|---|
| `Node` L0 | `logger` `vars` `signal` `costLog` `reportCost` `setPartial` `setBranches?` | 人类基座，compute 级实际被 `applyCapability` 裁为 no-op 的部分在此层声明但受限 |
| `ComputeNode` | （无新增） | 纯计算，只读不写 |
| `IoNode` | `llm()` `storage.get/set` `addAsset()` `assets`(只读) `writeOutEdgeScope?` | 协作/IO 级；`writeOutEdgeScope` 放此层（纯 compute 节点无需声明 scope） |
| `SandboxWriteNode` | `sandbox.writeFile()` `sandbox.readFrom()` `sandbox.list()` | `commitAll/commitLanes` 保留为「拒绝型」默认实现，本层不能落地主工作区 |
| `CoordinatorNode` | `sandbox.commitAll()` `sandbox.commitLanes()` | 唯一能把沙箱产物写入主工作区的职业 |
| `SystemNode` | 受限系统封装（非任意 shell） | 见下细分 |
| `GitNode`（SystemNode 细分） | `runGit(args: string[]): Promise<GitResult>` | 仅 git 相关；如 `runGit(['worktree','add',...])`。不暴露 `exec`/任意命令 |

**待定（按建议默认，未异议即采纳）：**
- **(2) `writeOutEdgeScope` 放 IoNode（L1）**：纯 compute 节点无需声明 scope。若用户改主意可全层开放。
- **(4) 跨包继承需显式导出声明**：包内继承自由，跨包继承新职业须在 manifest 显式 `exports` 该职业类，避免依赖混乱。

##### 13.3 落地路线（✅ 全部完成于 2026-08-05）

- [x] **阶段 A（抽象骨架，零风险）**：按 13.3a 继承链定义三层基类 `Node`（人类）/ 各 `职业类`（职业，含 `GitNode` 细分）/ 具体实现（个人）；在 `src/nodes/sdk.ts` 集中导出这些类作为公共 API + `OCCUPATION_CAPABILITY`/`capabilityOfClass` 工具。明确每层暴露的原生方法（见 13.3a 表）。
- [x] **阶段 B（继承式提权）**：`loader.ts` 的 `capFor` 从"硬编码 io"改为 `resolveExtendsCapability`——按 manifest 节点 `extends` 声明的职业类名（沿 occupations → 框架职业）解析 CapabilityLevel；继承 `SandboxWriteNode` 给 sandbox_write，未继承（纯 `executors` 函数）仍 io。普通 `executors` 函数用户完全不受影响。
- [x] **阶段 C（硬校验拦截）**：`validateManifest` 强制——`extends` 只可引用框架职业或本包 `occupations` 登记的职业；仅靠 `minCapability` 声明越权等级但缺 `extends` 会被拒绝加载（杜绝"配置文件后门"）。DEV 下校验 `index.js` 实际导出的同名类其原型链与 manifest 声明一致（warn 不抛错）。
- [x] **阶段 D（透明可审计）**：`PluginPanel.tsx` 对 `minCapability > io` 的节点显示红色「已提权·<等级>」徽标，可卸载收回。`scanProjectCustomNodes` 日志改为「能力由 extends 声明决定」。
- [x] **阶段 E（"造新职业"支持）**：`manifest.occupations` 定义新职业（须 `extends` 框架职业），节点 `extends` 可指向该职业名；`resolveExtendsCapability` 沿「自定义职业 → 其框架职业」解析最终能力。同包内自由派生；跨包继承需显式导出职业类（loader 已支持识别 occupations）。`loader` 同时支持「类式节点」（导出同名类取其 execute）与「函数式 executors」，向后兼容。

**关键实现文件**：
- `src/nodes/sdk.ts`（新增）：三层基类 + `OCCUPATION_CAPABILITY` + `capabilityOfClass`。
- `src/types.ts`：`PluginNodeMeta.extends?` / `PluginOccupation` / `PluginManifest.occupations?` 新增字段。
- `src/plugins/loader.ts`：`validateManifest` 硬校验 + `resolveExtendsCapability` + 类式/函数式 execute 解析。
- `src/components/PluginPanel.tsx`：提权红色徽标。
- `custom_nodes/example-fileworker/`（新增）：定义 `FileWorker` 职业并派生 `custom.textWriter`/`custom.jsonAppender` 两个 sandbox_write 节点，端到端验证阶段 E。
- `custom_nodes/README.md`（新增）：三层抽象 + 三种写法 + 能力对照表。

**验收状态（2026-08-05）**：
- ✅ `tsc --noEmit` 通过；`tauri dev` 成功启动（Rust 编译无错，仅 1 个无关 linker warning）。
- ✅ 逻辑验收脚本 `scripts/verify-customnode.ts`（11/11 通过）确认阶段 B/C/E 解析与硬校验正确。
- ✅ **修复一个真实 bug**：阶段 C「配置文件后门」校验原条件写反（`!n.extends` 置于 extends 分支内恒假）从未生效；修正为 custom 来源下无 extends 却声明越权 `minCapability` 会被拒绝加载。
- ⏳ **GUI 目视验收（待用户）**：应用已在运行（http://localhost:1420）。打开项目后应在「插件管理」面板看到 `example-fileworker` 两个节点带红色「已提权·sandbox_write」徽标；拖入画布 + sandbox 运行模式可真实 `writeFile`（需 Rust 侧 sandbox 句柄就绪，属运行时能力，未在此脚本覆盖）。

##### 13.4 与现有能力分级（11.4-D）的关系

- 11.4-D 的 `CapabilityLevel`（compute/io/sandbox_write/coordinator/system）+ `applyCapability` 裁剪逻辑**保留**，它就是"职业类"背后的能力量化层。
- 本步骤把"用户怎么获得某等级"从"改源码/manifest 字段"升级为"继承对应职业父类"——语义更清晰、门槛更自然、且天然防误用。
- 用户对"单纯放一张 override 名单提权"的方案**未采纳**，明确偏好"继承原生父类重载方法"的 basemod 式模型。

**✅ 共识已记录，待实施**：下一步若开工，建议从 **13.3 阶段 A（抽象骨架）** 起步，先不动提权，把"人类-职业-个人"三层基类与 `createNodeDef`/`loader` 的类式声明适配立起来。

---

## 六、参考项目索引（防遗忘 · 对标对象）

> 本节集中记录本项目（SlimeMold）在设计「多 agent 并行 / 沙箱 / 冲突协调」时可对照的外部项目，避免遗忘与重复调研。
> 详细比对结论见步骤 11（11.6 及后续补充）。

### 6.1 oh-my-opencode（现名 oh-my-openagent）
- 仓库：https://github.com/code-yeongyu/oh-my-openagent （原 https://github.com/code-yeongyu/oh-my-opencode）
- 核心：Sisyphus 多智能体框架（规划/检索/编辑/验证四阶段），Team Mode 并行 + Background Agents。
- **关键结论**：无真沙箱、无合并/仲裁引擎；并行改文件靠 **Hashline 行级 CAS 拒绝陈旧编辑**（写入前哈希校验），靠 LSP + Git 兜底；无 council 节点。
- 教训：纯行级 diff 漏语义冲突 → 需编译/测试兜底。

### 6.2 oh-my-opencode-slim（alvinunreal 精简版）
- 仓库：https://github.com/alvinunreal/oh-my-opencode-slim
- 文档站：https://ohmyopencodeslim.com
- 核心：OpenCode 插件式多智能体套件「Pantheon 七神」（Orchestrator/Explorer/Oracle/Council/Librarian/Designer/Fixer + 可选 Observer），后台任务并行 + Tmux/Zellij 窗格实时可视化。
- **关键结论（已确认）**：
  - **沙箱/隔离**：用 **Git Worktrees**（`.slim/worktrees/` 作为隔离「车道 lanes」）做工作区隔离，并行/高风险编码各占一树，避免主分支直接冲突；非容器级沙箱。
  - **冲突处理**：Orchestrator 在后台任务完成后**调和（reconcile）结果**再继续；争议用 **@Council 多模型并行共识**出单一裁决；Oracle 作最后调试者。
  - **文件补丁**：Fixer 接收计划做实现；具体 patch 合并算法文档未展开，但 worktree 隔离 + Orchestrator 调和构成「隔离避免 + 汇聚仲裁」基础。
  - ⚠️ 文档子页（`ohmyopencodeslim.com/docs/worktrees`、`/docs/council`、`/docs/background-orchestration`）实测 **404 不存在**；README 指引的正确路径为 GitHub `/blob/master/docs/*.md`。正文细节待换 URL 重试。
- 与本项目的对应：其 Council 仲裁、Orchestrator 调和、worktree 车道，分别与我们 11.0 的 `council` 节点、协调者合并、并行改副本思路高度吻合（见 11.7 比对）。

### 6.3 ComfyUI（节点式工作流范式参考）
- 仓库：https://github.com/comfrey-art/comfrey （注：官方为 comfyanonymous/ComfyUI，此处以用户提及为准待核实）
- 参考点：可视化节点 DAG 编排范式（本项目 SlimeMold 即"类 ComfyUI 的节点式 Agent 工作流"，见 CODEBUDDY.md 项目简介）。
- 与本项目的关联：SlimeMold 的画布/连线/端口/子图抽象继承自 ComfyUI 思路；但 ComfyUI 本身**无多 agent 协作、无沙箱、无冲突协调**（纯推理流水线），故在「并行文件编辑 + 冲突仲裁」维度参考价值有限，主要作为**节点交互范式**基准。

---

---

#### 🔲 步骤 14：跨工作流三方协作编排 —— 承建方 / 施工方 / 物业（已达成共识方向，待实施）

> 来源：2026-08-05 用户提出将「需求→计划→实施→测试→验收→运维」进一步解耦为三方职能工作流，并明确三方流转关系。
> 核心判断：**这不是"跨工作流节点通信"，而是"工作流编排成流水线（pipeline）"**——三方是三个工作流职能角色，之间传递的是**有结构的交付物（Artifact）**，且有**强顺序 + 回流（仲裁→设计决断→重派）**语义。
> 因此**不采用**之前讨论的「命名黑板 + `{{@key}}` 松散表达式」方案（会丢失控制流/结构），而采用 **Pipeline Orchestrator + Artifact 模型**。

##### 14.0 用户目标模型（三方职能 + 流转）

- **承建方（提出需求 → 交付设计）**：
  1. 用户 `input.text` 输入 idea；
  2. `dispatch.plan` 把 idea 提取/补充/完善成可落实的**计划书**（输出 `plan`/`tasks`）；
  3. `architect.design` 对计划书做详尽**设计**（项目架构、预先声明接口、任务拆分几人份、初步冲突预测），输出 `design`/`modules`；
  4. 设计作为交付物交给施工方。
- **施工方（拿起计划 → 生产 → 装配 → 交付）**：
  1. 接收承建方设计，按 `dispatch.split` 做具体任务派发；
  2. 各 `worker.scaffolder`/`worker.implementer` 生产组件；
  3. `coord.resolver` 冲突检验：可合并则装配，强互斥则交 `coord.council` 仲裁；
  4. 仲裁后**把冲突双方陈述回递 `architect.design` 决断**，决断结果作为新交付物重触发施工方（回流）；
  5. 装配完整后交 `worker.validator` 做各模块测试，无 bug 则交付。
- **物业（运维）**：
  1. 接收交付的整项目（ProjectArtifact：代码 + 结构 + 验收报告）；
  2. 进行维护与 bug 收集，bug 报告作为新 Artifact 回流（增量重跑，复用 executor 的 `incremental` 模式）。

> 回流是硬需求：施工期 bug → 回流到 council/design（单工作流内 `flow.loopGate` 闭环即可）；运维期 bug（BugReport）→ 回流施工方触发增量重跑。

##### 14.1 核心抽象：Artifact（交付物，一等公民）

不塞进黑板字符串，复用现有 `TaskItem`/`ModuleItem`/`FilePatch`/`MergeResult` 类型，加统一包装：
```
Artifact = { kind: 'plan'|'design'|'project'|'bugreport'|..., payload: unknown, fromWf: string, runId: string, version: number }
```
存于项目级 store（与 custom_nodes 同 `scope:'project'` 生命周期），需加入 `workflowStore` persist 的 `partialize` 白名单，否则刷新丢失。

##### 14.2 Pipeline Orchestrator（新增，但很薄，不动 executor）

位于 `src/engine/pipeline.ts`，职责：
1. **定义阶段与流向**：`idea → 计划 → 设计 → 施工 → 测试 → 交付 → 运维`。只描述**工作流之间的边**，不碰工作流内部 `topoSort`。
2. **传递 Artifact**：上游工作流跑完，写 `artifacts[stage]`，触发下游工作流（或等用户手动触发）。
3. **处理回流**：仲裁→设计决断→重派、运维 bug→施工方增量重跑。
- **关键设计**：Orchestrator **站在 executor 外面**，协调多次 `runWorkflow(opts)` 调用，**完全不重写 executor**，每个工作流仍各自跑；这样不破坏现有 `topoSort`/`currentRunId` 代次模型（`stopWorkflow` 的过期协程退出逻辑仍有效）。

##### 14.3 边界节点（让跨工作流边界在画布上可见，且不跨工作流连线）

- `pipeline.handoff`：把本工作流某输出打包成 Artifact 交给 Orchestrator（不连跨工作流边）。
- `pipeline.receive`：从 Orchestrator 取上游 Artifact 当输入（不连跨工作流边）。
- 两节点只和 Orchestrator 对话，**规避成环检测问题**（连线均在工作流内部）。

##### 14.4 与现有能力的契合度（好消息：90% 能力已在图内节点上）

| 用户需求 | 现有节点 | 还差 |
|---|---|---|
| idea→计划书 | `input.text` + `dispatch.plan` | 无 |
| 计划→设计 | `architect.design` | 无 |
| 任务派发 | `dispatch.split` | 无 |
| 组件生产 | `worker.scaffolder`/`implementer` | 无 |
| 冲突检验/装配 | `coord.resolver` | 无 |
| 强冲突仲裁 | `coord.council` | 需把裁决回递设计（回流边） |
| 测试 | `worker.validator` | 需"整项目测试"模式（现在是单代码块评审） |
| 交付/运维 | — | **全新**：交付节点 + 物业运维工作流 |
| 跨方传递 | — | **全新**：Pipeline Orchestrator + Artifact store |
| 仲裁→设计决断→重派 | — | 需要 Orchestrator 回流边 |

##### 14.5 落地顺序（建议）

- [x] **14.A（地基，最低风险）**：`src/engine/pipeline.ts` 骨架——`Artifact` 类型、`ProjectArtifacts` 存 workflowStore 项目态（加 `partialize` 白名单）、`definePipeline(stages, edges)` 声明阶段与流向、`advance(upstreamWfId, artifact)` 存产物并触发下游、`rework(stage, artifact)` 处理回流重跑。
- [x] **14.B（边界节点）**：新增 `pipeline.handoff` / `pipeline.receive` 两个节点（`src/nodes/`，接入 `builtinDefs`/分类），与 Orchestrator 对话，不跨工作流连线。（14.7.4）
- [x] **14.C（物业工作流）**：新建运维工作流（接 ProjectArtifact + 收集 bug → `pipeline.handoff` 回吐 BugReport）。（14.7.7）
- [x] **14.D（测试闭环）**：`worker.validator` 扩"整项目测试"模式（`mode: project`，单轮集成验收 + `fail` 控制流端口）；施工期 bug 闭环——Builder 施工流接 `validator.fail → flow.loopGate → split.rerun` 真 control 闭环（不跨工作流）。headless 已验证 project 模式 PASS 路径与 loopGate 多轮回环机制。（14.8）
- [x] **14.E（回流边串联）**：`coord.council` 裁决 → 回递 `architect.design` 决断 → 新 Artifact 重触发施工方；运维 BugReport → 施工方 `incremental` 增量重跑（复用 executor 既有能力）。（14.7.2/14.7.3）

**设计约束（来源 14.0 / 14.2）**：引擎核心零改动；复用现有 `incremental`/`currentRunId`/`coord.*`/`dispatch.*`；Orchestrator 只做"谁先跑、跑完给谁、回流时重跑谁"的协调。

##### 14.6 Builder 节点（承建方自动生成后两条工作流，2026-08-05 用户提出）

> 用户洞察：承建方跑完 `dispatch.plan → architect.design` 后，设计书（`design`/`modules`）里已写明「涉及哪些员工（worker 角色 + 该用哪个 agent/模型）」「任务拆成几人份」「接口与依赖」。
> **既然蓝图已完整，施工方 + 物业两张工作流可由节点在运行时自动生成**，无需人再手动拖节点——类比 AI 之前手写的 `test-realsandbox.workflow.json`，只是把"人拖的节点"变成"代码拼的节点"。

**Builder 节点定位**（`builder.generate`，暂定 typeId，归入「派发/协调」大类）：
- 输入：`design`(text) + `modules`(`ModuleItem[]`) —— 直接接 `architect.design` 输出。
- 输出（打包成单个 Artifact 或双端口）：
  - `constructionWf`：施工方工作流 JSON（`WorkflowFile` 结构，含 `dispatch.split` + 各 `worker.*` + `coord.resolver` + `coord.council` + `worker.validator` 闭环 + 末端 `pipeline.handoff`）。
  - `opsWf`：物业运维工作流 JSON（接 ProjectArtifact + bug 收集 + 回流 `pipeline.handoff`）。

**怎么"造图"（复用现有引擎，不自创格式）**：
- 不走新序列化格式——复用步骤 5 已落地的 `serializeWorkflow` / `packSelectionAsSubgraph`，从 `registryStore.getNodeDef` 注册中心**按 `modules` 结构组装节点 + 连线**后调序列化，产出标准 `.workflow.json`（`WorkflowFile`）。
- 模板化拼装 `buildConstructionWorkflow(modules)`：每个 `ModuleItem` → 一个 `worker.implementer`（`scope` 来自 `module.scope`）；worker 收口到 `dispatch.split` 扇出；全部汇聚 `coord.resolver` → 冲突走 `coord.council`；装配完接 `worker.validator`；末端 `pipeline.handoff` 交付物业。

**与 Orchestrator 的衔接（重要决定）**：
- **采用 A（轻，推荐）**：Builder 把 JSON 直接 `addWorkflow` 注册进当前项目（复用 `workflowStore.addWorkflow`），并交给 Orchestrator 登记为 pipeline 的 `construction`/`ops` 阶段。用户在「工作流标签页」能直接看到这两张自动生成的图，可手动调整再跑——符合步骤 5「磁盘为唯一真相 + 工作流 `.json` 可 git diff」理念。
- **不采用 B（重，全自动）**：Orchestrator 直接拿 JSON 调 `runWorkflow` 跑、不入项目、不可见——黑盒、不可调试。

**对步骤 14 落地顺序的影响（简化手搭）**：
- 原 14.C「手动新建物业工作流」升级为 **14.F Builder 生成**（人画承建方一张图 + Builder 生成后两张图）。
- 落地顺序修订为：14.A（pipeline.ts 地基）→ 14.B（handoff/receive）→ **14.F（Builder 生成后两图）** → 14.D（validator 整项目模式）/ 14.E（回流边串联）不变。

##### 14.7 Builder 生成时"每个 worker 绑哪个 agent/模型"——对标 OMO / OMO-slim（2026-08-05 调研）

> 边界问题：Builder 生成的施工工作流里，每个 worker 该绑哪个 agent（模型）？两种策略——① 设计书里声明 `modules[].agentId`（架构师节点多吐字段）；② Builder 按 `scope` 套默认规则。先查外部项目怎么做，再拍板。

**A. oh-my-openagent（原 OMO，Sisyphus 框架）——按"类别"而非具体模型路由**
- 核心：Sisyphus（主编排）把任务派给子代理时，**不指定具体模型，而是指定任务"类别（category）"**，由 harness 自动映射最优模型。
- 类别→模型示例：`visual-engineering`（前端/UI）→ 视觉模型；`deep`（自主研究+执行）→ Hephaestus 类模型；`quick`（单文件/拼写修正）→ 轻量模型；`ultrabrain`（困难逻辑/架构决策）→ GPT-5.6 Sol xhigh。
- 模型选择在安装时「agent-to-model matching matrix」矩阵匹配，配置可覆写（`~/.config/opencode/oh-my-openagent.jsonc` 覆写 models/temperatures/prompts/permissions），支持 `fallback_models` 回退链。
- **启示**：OMO 的做法是"角色/类别 → 模型"的**解耦映射**，而非写死。对应到我们：`ModuleItem` 应声明 `category`（如 `ui`/`logic`/`docs`/`infra`），Builder 用一张"类别→agentId"路由表绑定，用户可在项目设置覆写。这比"架构师直接写死 agentId"更灵活、更贴 OMO 哲学。

**B. oh-my-opencode-slim（Pantheon 七神）——固定角色 + 预设模型 + 回退链**
- Council：两层模型分离——**synthesizer（@council 合成器）** 走常规 agent 系统设置（`presets.<name>.council.model`），**councillor（并行议员）** 走 `council.presets.<preset>.<councillor>.model`（可为单模型字符串或 Model Fallback Chain 数组，按顺序尝试）。
- 角色提示（role prompt）可给每个 councillor 定向（专注 bug/架构/性能）。
- **启示**：slim 的"角色固定 + 模型可配 + 回退链"范式，对应我们 Builder 生成的 worker 节点——**worker 角色（scaffolder/implementer/validator）固定，但其 `agentId`（模型）走"项目级默认 + 回退链"**，而非每个节点硬编码。也印证 14.6 策略②（默认规则）是主流做法。

**C. 拍板建议（待用户确认）**
- **先 ② 后 ①**：Builder 先用"类别→agentId 路由表 + 项目级默认 + 回退链"（对齐 OMO 的 category 解耦 + slim 的可配模型），用户能在生成后手动改节点绑定的 agent；等 `architect.design` 节点成熟，再让它多吐 `modules[].category` 让生成一步到位。
- 路由表位置：建议放 `workflowStore` 项目态（或 `agentManager` 的 `AgentConfig` 扩展一个 `categoryBindings`），随项目 `.slimemold` 持久化，复用现有 `partialize` 白名单机制。
- **不照搬 OMO 的"安装时矩阵匹配"**：我们是可视化工作流，绑定应在节点属性（Inspector）里可见可改，而非藏在安装 TUI 配置里。

##### 14.7.1 路由表与 ModuleItem.category 已落地（2026-08-05 代码级骨架）

> 来源：用户在 14.7 拍板前要求先把地基落实。以下为已实现（非终态 UI，仅类型 + 项目级存储）。

- **`src/types.ts`**：
  - `ModuleItem` 新增可选字段 `category?: ModuleCategory` 与 `agentId?: string`（架构师节点生成模块时标注；`agentId` 优先级高于 `category` 路由）。
  - 新增 `ModuleCategory` 类型（`ui`/`logic`/`docs`/`infra`/`data` + 预留任意字符串）。
  - 新增 `AgentRouteEntry`（`{ agentId, fallback?: string[] }`，含回退链）与 `AgentRouteTable`（`Record<string, AgentRouteEntry>`）。
- **`src/store/workflowStore.ts`**：
  - 项目态新增 `agentRouteTable: AgentRouteTable`，经 `setAgentRouteTable(table)` 方法写入（走 store、触发脏标记）。
  - 已接入三处持久化：`partialize` 白名单、`buildProjectFile`（`.slimemold` 落盘）、`DIRTY_KEYS`（写入即标脏）。
- **待补（非本步范围）**：Builder（14.F）据 `modules[].category` 查 `agentRouteTable` 生成带 agent 绑定的 worker 节点；路由表的可视化编辑 UI（Inspector/设置面板）。

##### 14.7.2 architect.design / coord.council 节点逻辑对标改进（2026-08-05）

> 来源：用户要求「边读边改进」——直接对照 OMO/OMO-slim 调研结果改造现有节点，而非另起炉灶。

**architect.design 对齐 OMO 的 category 标注（14.7-A 启示）**：
- 提示词从「仅 name/responsibility/scope/dependsOn」升级为要求模型**必填 `category`**（`ui|logic|docs|infra|data`），说明各取值语义，无法归类降级 `data`。
- `extractModulesFromDesign` 新增 `normalizeCategory()` 规整（小写化、保留任意字符串以支持自定义类别），写入 `ModuleItem.category`。
- 离线模拟 `modules` 补 `category`（ui/logic/data 示例），与设计书口径一致。
- 节点新增参数 `pipelineStage`（默认 `design`）：执行完把 `{design, modules, summary}` 经 `publishArtifactFromNode` 写入项目级黑板（跨工作流交付物），stage 由该参数决定；留空不发布。

**coord.council 对齐 OMO-slim 两层 + 共识评级 / 回流（14.7-B 启示）**：
- 新增 `backflow` 输出端口（`flow: 'control'`）：输出 `CouncilBackflow`（`consensus`/`decision`/`proposal`/`rework`），`rework=true` 当且仅当 `split` 或 `需复议`——经 control 边回流上游 `architect.design` 重派（14.E 串联）。
- 节点新增参数 `pipelineStage`（默认 `design`）：把裁决经 `publishArtifactFromNode` 写入黑板（kind `council`），供下游 Builder/回流读取。
- 新增 `buildBackflow()`（共识→回流裁决映射）与 `publishCouncilArtifact()` 辅助函数（旁路发布失败不中断主流程）。

**pipeline.ts 支撑改动**：
- 新增 `publishArtifactFromNode({stage, kind, payload})`：自动填 `fromWf`（`activeWfId`）+ `runId`（executor `getActiveRunId()` 快照），节点无需直接依赖 store 与 runId 来源。
- `executor.ts` 导出 `getActiveRunId()`，供 Artifact 新鲜度判断。

**验证**：`npx tsc --noEmit` 通过（exitCode 0）；`read_lints` 无错误。

##### 14.7.3 Builder 生成施工/物业工作流（14.F 落地，2026-08-05）

> 按「最顺手实现反推定义」：Builder 直接拼 `WorkflowFile` JSON 而非操作画布；由此反过来给 store 补一个 `registerWorkflow`（把现成 WorkflowFile 注册进项目）。

- **`src/engine/builder.ts`（新建）**：造图模板，不依赖画布/端口查询。
  - `resolveAgentForCategory(category, routeTable, fallbackAgentId)`：按 `ModuleItem.category` 查 `agentRouteTable`（策略②，对齐 OMO category 解耦 + slim 可配模型）；路由表为空/缺类别时降级 `fallbackAgentId`，再缺则留空（节点用默认 agent）。类别大小写不敏感。
  - `buildConstructionWorkflow({modules, routeTable, fallbackAgentId})`：`input.text → dispatch.split → [worker.implementer × modules] → coord.resolver → (conflicts) coord.council → (backflow control) resolver → worker.validator → output.text`；worker 的 `agentId`（来自路由）与 `scope`（来自 `module.scope`）自动填；grid 布局。
  - `buildOpsWorkflow({fallbackAgentId})`：轻量物业图 `input.text → worker.validator → output.text`。
- **`src/store/workflowStore.ts`**：新增 `registerWorkflow(wf, opts?)`——把现成 `WorkflowFile` 注册进 `workflows`（自动 id、保留/继承 `belongsToProject`），`activate` 默认切画布、可设 `false`（不抢占当前运行的承建方画布）。复用已有 `flowNodesFrom`/`flowEdgesFrom` 还原画布态。
- **`src/nodes/builtin.ts`**：新增 `builder.generate`（分类「派发」）：
  - 输入 `design`(text) / `modules`(list)；输出 `constructionWf`(json) / `opsWf`(json)。
  - 调 builder.ts 模板（从 store 取 `agentRouteTable` + `defaultAgentId`/`agents[0]` 作 fallback）。
  - 参数 `autoRegister`(默认 on)：开启则经 `registerWorkflow(..., {activate:false})` 注册两张图进项目，标签页可见可改；注册失败只记日志不中断。
- **待补（后续步骤）**：路由表可视化编辑 UI（Inspector/设置面板）；`agentRouteTable` 默认填充；14.D Orchestrator 编排三张工作流时序。

##### 14.7.4 跨工作流交付 / 接收节点（14.B 落地，2026-08-05）

> 按「最顺手实现」：handoff/receive 不引入新存储，直接复用现有黑板 `publishArtifact`/`getArtifact`（已按 stage+kind 读写），只是语义收敛为"跨工作流交付"。

- **`pipeline.handoff`**（分类「派发」）：输入 `payload`(any)；参数 `stage`(必填黑板槽位) / `kind`(select: plan/design/project/bugreport/constructionWf/opsWf/custom) / `kindCustom`。调 `publishArtifactFromNode` 写黑板，输出 `artifact`(回执，含 version/updatedAt) 便于同图串联。
- **`pipeline.receive`**（分类「派发」）：参数同 handoff + `onError`(error 阻断 / empty 返回空)。调 `getArtifact(stage, kind)` 读黑板，输出 `payload`(any) + `artifact`(json)。
- **Builder 串联**：`buildConstructionWorkflow` 末端 `output.text` 占位升级为 `pipeline.handoff`（`stage:'construction'`，`kind:'project'`，接 validator.report），施工方工作流产出即自带交付语义，下游物业工作流经 `pipeline.receive(stage:'construction')` 读回。

**验证**：`npx tsc --noEmit` 通过（exitCode 0）；`read_lints` 无错误。

##### 14.7.5 路由表可视化编辑 UI（2026-08-05）

> 让蓝图真正跑通的关键缺口：Builder 生成的 worker 靠 `agentRouteTable` 绑 agent，此前路由表为空、无编辑入口。按「最顺手」直接复用 store 的 `agentRouteTable`/`setAgentRouteTable`，新增轻量编辑器。

- **`src/components/RouteTableEditor.tsx`（新建）**：渲染固定 5 个类别行（ui/logic/docs/infra/data），每行 agent 下拉（复用 `agents` 列表，与节点 `type:'agent'` 渲染一致）+ 可选 fallback 链（逗号分隔 agentId）；改动即时写回 `setAgentRouteTable`（走 store 方法，保证脏标记 + 持久化）。顶部「一键填充默认」按钮把所有类别绑 `defaultAgentId`。
- **`Inspector.tsx`**：空白（工作流属性）分支从"请选中节点"占位升级为「工作流属性」视图——显示工作流名/脏标记 + `RouteTableEditor` + 原提示。用户点空白处即可配置 category→agent，Builder 立即受益。

**验证**：`npx tsc --noEmit` 通过（exitCode 0）；`read_lints` 无错误。

---

## 15. tsc 历史债务清理（2026-08-05 立项）

> 背景：项目靠 Vite/esbuild 跑（只转译不查类型），故 `tsc -b` 长期有 114 处错误被忽略，`npm run build` 不过。
> 用户决策（2026-08-05）：① 先把债务清单写入 TODO；② 按"分阶段"方案执行——本次只修 114 处到 0，**编译标准不变**（strict 已开，不再额外紧）；③ `noUnusedLocals/Parameters` 收紧留到**阶段二**单独做；④ `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` **永久不在存量项目上事后开启**；⑤ 不确定处必问，不擅自动。
> 文件兼容策略（第 2 点讨论结论）：**代码向前兼容旧 `.workflow.json`**——补可选字段 + 读盘 `??` 兜底，不重写旧文件、不写迁移脚本（除非用户将来要重构文件格式）。

### 15.0 错误分类总览（114 处 / 21 文件）

| 类别 | 性质 | 数量 | 处理 |
|---|---|---|---|
| A. 真 bug | 漏 import / 调用名错 / 误用字段 / 序列化结构不一致 | ~25 | 必修，最小风险 |
| B. 类型定义落后 | 接口缺字段（补类型即可） | ~45 | 按现有用法补全 |
| C. 类型推断失败 | 写法问题（非逻辑错） | ~44 | 调写法 |
| （其中 30 处隐式 any 已含在 strict 报错内） | | | |

### 15.1 A 类——真 bug（优先修，消除"类型过了但运行其实有坑"）

- [x] **A2** `SettingsCenter.tsx` 调 `loadEndpoint` 改为 `loadEndpointKey`（改名笔误）。
- [x] **A3** `executor.ts` 补 `import type { AssetMeta }`。
- [x] **A4** `pluginManager.ts` 补 `import type { NodeDefinition }`。
- [x] **A5** `builtin.ts` 端口 `type:'control'` 改 `type:'any'`（保留 `flow:'control'`）。
- [x] **A6** `WorkflowFile` 补 `defaultAgentId?: string | null`，读盘 `?? null`。
- [x] **A7** `FlowNode↔WorkflowFileNode` / `FlowEdge↔WorkflowFileEdge` 边界显式映射，补 `defaultAgentId`/`runs`。
- [x] **A1** `App.tsx` 新建项目向导：已完成 `setNewProjectOpen`→`onNewProject` prop 透传（消除作用域 bug）；`NewProjectModal.tsx` 实现完整向导（项目名 + 起始模板卡片 + 模板详情预览含节点清单/连线数/agent 模拟模式提示 + 桌面端保存位置选择 + 创建后 `addLog` 反馈）。2026-08-05 增强：模板详情预览面板、创建成功/失败日志、底部预览文案。

### 15.2 B 类——类型定义落后（按现有用法补全，零行为风险）

- [x] **B1** `ProjectFile` 补 `artifacts`/`runs`/`legacy`（路径修正为 `./engine/pipeline`）。
- [x] **B2** `JobBoard.tsx` `statusMeta`/`counts` 补 `bypassed`/`muted`。
- [x] **B3** `ExecLogger` 补 `warn`（types.ts + executor + headless noopLogger）。
- [x] **B4** `ParamDef.tooltip?` + `ParamType.'boolean'`。
- [x] **B5** `ProviderPreset.label?`（SettingsCenter `p.label ?? p.name`）。
- [x] **B6** `TopBar` 菜单联合补 `'separator'`（原 `'divider'`）。
- [x] **B7** `Companion.tsx` `inputTokens/outputTokens` → `promptTokens/completionTokens`。
- [x] **B8** `credentialStore.ts` `invokeRaw` 补第 2 参。
- [x] **B9** `SubgraphEditor.tsx` 函数补参（`resolvePorts` 第 4 参 `subgraphs`）。
- [x] **B10** `SubgraphEditor.tsx` `WorkflowNodeData` 字段补全 + `NodeTypes` 从 `@xyflow/react` 导入并 cast。
- [x] **B11** `SubgraphEditor.tsx` `NodeChange` 类型守卫（`add` 无 `id`）。
- [x] **B12** 约 30 处隐式 any 显式标注（含 App/BaseNode/GroupProxyNode/SubgraphEditor/WorkflowEditor/AssetsPanel/Inspector 等）。

### 15.3 C 类——类型推断失败（写法问题）

- [x] **C1** `viewStore.ts` `create<ViewState>()(persist(...))` 显式 `StateCreator<ViewState>`；`effectiveTheme` 自引用修复。
- [x] **C2** `WorkflowEditor.tsx` `getState().defs` → `useRegistryStore.getState().defs`。
- [x] **C3** `StatusBar.tsx` `setAutosave` 修正（走 `WorkflowState` 方法）。
- [x] **C4** `NodePalette.tsx` 删冗余 `??`。
- [x] **C5** `executor.ts` 补 `RunOptions.force?`、修正 `SandboxHandle` 返回值。
- [x] **C6** `executor.ts` `consensus === 'split'` 加 `as CouncilVerdict['consensus']`。
- [x] **C7** 多处 `string | null` 兜底（AgentPanel `loadCredential` 返回 `?? undefined`）。

### 15.4 执行顺序（阶段一：修 114 处到 0，编译标准不变）

1. 先 A 类（A2–A7，A1 待范围确认后做）——最小风险、消除隐藏运行坑。
2. 再 B 类（B1–B12 补类型定义）。
3. 最后 C 类（C1–C7）+ 跑到 `tsc -b` 零错误。
4. 验证：`npx tsc -b` 退出码 0；`read_lints` 无错误；`npm run headless` 既有样例仍通过。

> **阶段一完成记录（2026-08-05）**：
> - commit `a2ccde3` 推送 origin/main：114→0 全部清零。
> - **后续补修（同日）**：发现「方案 Q 局部 cast」在非 active 工作流场景下是**语义错误**（cast 假设 `wf.nodes` 是 FlowNode，实际是 WorkflowFileNode），修正如下：
>   - `types.ts`：`WorkflowFileNode` 加 `bypass?`/`mute?`（对齐 `data.bypass/mute`，旧文件 `??` 兜底，磁盘兼容）。
>   - `workflowStore.ts`：5 处非 active 分支去掉假 cast，改操作拍平字段（`setNodeLabel` 写 `label`；`toggleNodeBypass/Mute` 写 `bypass/mute`；`align/distribute` 的 `apply` 改接受 `WorkflowFileNode[]`，active 分支用局部适配器桥接 `FlowNode[]`）。
>   - 补全跨工作流还原：`flowNodesFrom` 读 `n.bypass/mute`→`data`；`storedNodeOf` 写 `data.bypass/mute`→`WorkflowFileNode`，避免切换工作流时 bypass/mute 状态丢失。
>   - 验证：`tsc -b` EXIT:0、`read_lints` 0、`npm run headless` 3 成功/1（未绑定智能体，预期）无回归。

### 15.5 阶段二（已完成 A：noUnused 收紧；B：方案 P 尝试中）

- [x] **A. `noUnusedLocals`/`noUnusedParameters` 收紧**（2026-08-05，commit `1ac4531`）：清理 53 处未用 import/变量/参数（25 文件），`tsconfig.app.json` 两 flag 由 false 改 true。
- [x] **B. 方案 P 初次尝试**（2026-08-05，分支 `refactor/plan-P-workflows-flownode`）：把 `workflowStore.workflows` 内核改为运行态同构 `FlowNode[]`（类型 `WorkflowFileInMemory`）。
  - **关键约束**：`persist` 直接持久化 `workflows`，React Flow 的 `measured`/`dragging`/`positionAbsolute` 等瞬态字段不能落 localStorage（否则污染 + 拖拽误判脏）。因此磁盘态 `WorkflowFile` 保持拍平，内存态用新类型 `WorkflowFileInMemory`（`nodes: FlowNode[]`），落盘/读盘经统一 `toDisk()`/`fromDisk()`。
  - **改动面**：
    - `types.ts`：新增 `WorkflowFileInMemory`（extends Omit<WorkflowFile,'nodes'|'edges'>，节点/边为 FlowNode/FlowEdge）。
    - `workflowStore.ts`：`workflows: Record<string, WorkflowFileInMemory>`；非 active 的 6 处方法（setNodeLabel/toggleBypass/Mute/align/distribute/updateNodeParams）统一改读 `data.*`（原拍平字段是方案 Q 残留 bug，此处一并根治）；`serializeCurrent` 直接持 FlowNode；`buildProjectFile` 落盘前 `toDisk` 拍平；`registerWorkflow` 入参 `WorkflowFile` 经 `fromDisk`；`openProject`/`switchWorkflow`/`removeWorkflow` 统一 `fromDisk`；persist `partialize` 用 `toDisk` 拍平 + `merge` 恢复时 `fromDisk`；迁移块类型标注更新。
    - `WorkflowEditor.tsx` / `Inspector.tsx`：拆分视图/属性面板直接复用 `splitWf.nodes`（已是 FlowNode），去掉冗余重映射。
    - 顺手修复方案 Q 残留 bug：`updateNodeParams` 非 active 分支原本写拍平 `n.params`，实为语义错误，方案 P 下统一为 `n.data.params`。
  - **验证**：`tsc -b` EXIT:0、`read_lints` 0、`vite build` 出 dist；`npm run headless examples/loop-closure-test.json` 5/5 成功（执行引擎读 FlowNode 链路正常）。
  - **待用户桌面端 GUI 目视验收**：拆分视图双工作流切换、bypass/mute 跨工作流还原、刷新后 localStorage 恢复无瞬态污染。
- [ ] `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` **不开**（存量项目事后开 = 重写一半类型，收益低）。

### 15.6 git / 基线处理（2026-08-05）

- [x] 提交范围 = 步骤14成果 + 文档（CODEBUDDY.md/TODO.md）+ .gitignore 修复；临时产物 `p_backflow.*`/`ts_test.*` 删掉不提交。
- [x] `tauri_dev.log` 误跟踪——`git rm --cached` + 加入 `.gitignore`，本地保留。
- [x] push 到 `origin/main`（commit `8a54ea6` 基线 + `a2ccde3` 步骤15主体）。
- [x] `.gitignore` 补 `tsc_tmp.log`（调试诊断文件不入库）。

##### 14.D Orchestrator（待做，非本轮）

- 全自动编排三张工作流时序：承建方（architect→builder）→ 施工方（handoff）→ 物业（receive）。
- **本轮评估**：手动链路已闭合（architect→builder.generate 注册双图；手动切施工方跑→handoff；切物业跑→receive），故 14.D 作为独立大片延后，不阻塞蓝图可用性。

##### 14.7.6 路由表编辑入口从 Inspector 迁入「设置中心」（2026-08-05）

> 用户提议：路由表是项目级全局配置，放设置比挤在 Inspector 工作流属性更合适。

- `SettingsCenter.tsx`：新增 `routing`「路由表」分区（图标 `Route`，位于对话流与 APIKEYS 之间），内嵌 `RoutingSection` → `RouteTableEditor`；分区顶部加说明（Builder 据类别查表绑 worker、空表回退默认、项目级持久化）。
- `Inspector.tsx`：空白（工作流属性）分支回退为原"请选中节点"占位，`RouteTableEditor` import 移除。`RouteTableEditor.tsx` 组件本身不变（仍为项目级，读写 `agentRouteTable`）。

##### 14.7.8 headless 验证发现并修复两个真 bug（2026-08-05）

> headless 跑 `examples/three-party.workflow.json` 暴露两个 bug（GUI 下未实跑故未暴露）。逐节点隔离定位（goal/plan/architect/council/builder/handoff/receive 单独均 OK，仅 control 回流边组合挂起）。

- **bug1 `topoSort.ts` `topoStages` Pass B 死循环**：control 回流边（如 `council.backflow → architect.goal`）与 data 边（`architect→council`）互相追逐，原 `while(changed)` 永不收敛 → headless 卡死（GUI 用 topoLayers 忽略 control 故不卡）。修复：Pass B 仅抬高「正向」control 边（`if (ts <= fs) continue` 跳过回流边），回流边属断点语义不重排。单测 + 完整图均验证收敛。
- **bug2 `pipeline.ts` `publishArtifact` 笔误**：第 121 行误用未声明变量 `stage`（应为 `args.stage`），导致 `pipeline.handoff` 抛 `stage is not defined` ReferenceError。修复后 handoff/receive/architect/council 的 artifact 发布在 GUI 与 headless 下均正常。
- **headless 运行器配套修复**：`scripts/headless-run.ts` edge 归一化保留 `data.kind`（此前丢弃致 control 边被误判成环 EXIT:2）；`main()` 成功路径补 `process.exit(0)`（simulate 的 setTimeout 句柄致事件循环不空、进程挂起不退出）。

**验证（headless）**：`npx tsx scripts/headless-run.ts examples/three-party.workflow.json` → 6 节点全部 success（goal/plan/architect/builder/handoff/council），0 失败。
**类型**：`npx tsc --noEmit` 通过（exitCode 0）；`read_lints` 无错误。

*最后更新：2026-08-05（步骤14 全链路落地并 headless 验证通过：architect/council 节点对标；Builder 生成双工作流+路由绑定；handoff/receive 跨工作流交付；路由表编辑器（设置中心）；物业 receive 串联；handoff meta 透传；示例+headless 修复（topoStages 死循环 + publishArtifact 笔误））*

##### 14.7.7 蓝图收尾：物业接 receive + handoff 透传 scope + 默认预填 + 示例 + headless 验证（2026-08-05）

- **物业工作流真正串联（14.B 闭环）**：`buildOpsWorkflow` 末端 `input.text` 改为 `pipeline.receive(stage:'construction', kind:'project')`，读取施工方 `handoff` 交付的成果（而非占位输入），实现跨工作流真串联。
- **handoff 透传 meta（scope）**：`pipeline.handoff` 新增可选 `meta` 参数；若 payload 为对象则附加 `_meta` 字段（如"模块 scope 汇总"），下游 `receive` 可读到上下文。Builder 施工图 handoff 预填 `meta` 为所有模块 scope 拼接。
- **默认预填兜底**：`RouteTableEditor.fillDefaults` 从"仅 defaultAgentId"放宽到"defaultAgentId ?? agents[0]"，确保无默认智能体时「一键填充默认」仍可用。
- **示例工作流**：`examples/three-party.workflow.json`——承建方(goal→plan→architect[吐category+design artifact]→builder[生成双工作流并注册]→handoff[design])，council.backflow 经 control 边回流 architect 重派；全节点 simulate 模式，免 API Key 跑通端口。
- **headless 验证修复**：
  - `scripts/headless-run.ts` edge 归一化**保留 `data.kind`**（此前丢弃，致 control 回流边被误判成环，导致 `wouldCreateCycle` 报错 EXIT:2）；修复后 control 边被拓扑忽略，与 GUI 行为一致。
  - `main()` 成功路径补 `process.exit(0)`：simulate 节点的 setTimeout / 运行器内部句柄会让事件循环不空，原成功路径不 exit 会**挂起不退出**（曾致手动阻断）；显式退出解决。

**验证状态**：`tsc --noEmit` 通过；headless 修复待实跑确认（用 `timeout` 限时，避免再次挂起）。

*最后更新：2026-08-05（步骤14 14.A / 14.7.1~14.7.7 全落地：architect/council 节点对标；Builder 生成双工作流+路由绑定；handoff/receive；路由表编辑器（设置中心）；物业 receive 串联；handoff meta 透传；示例+headless 修复）*

---

## 七、安全专项（SECURITY.md，2026-08-07 新增）

> 来源：Codex 外部架构评审（2026-08-07）+ 项目代码核实。完整记录见 **`SECURITY.md`**（本仓库根目录）。
> 信任模型定位：**插件 = 用户显式安装的本地可信代码**，非网络下载的不可信第三方。能力分级（步骤 13）已是 API 层防护，P0 为 Tauri 权限收窄。

### 7.1 已核实的安全缺口（S1–S9，详见 SECURITY.md）
| 编号 | 缺口 | 位置 |
|---|---|---|
| S1 | `csp: null` 未配置 CSP | `src-tauri/tauri.conf.json:24` |
| S2 | capabilities `path: "**"` 偏宽 | `src-tauri/capabilities/default.json:32,38` |
| S3 | HTTP 允许 `http://*` / `https://*` 全放开 | `src-tauri/capabilities/default.json:11-18` |
| S4 | `run_git` 收任意 args + 任意 cwd | `src-tauri/src/lib.rs:226` |
| S5 | 插件 Blob URL + dynamic import 跑主 WebView（非进程级沙箱） | `src/plugins/loader.ts` | ✅ 已声明信任模型 2026-08-07 |
| S6 | 凭据运行期在 WebView JS 内存 | `AgentConfig.apiKey` → provider | ✅ 已文档化分层 2026-08-07 |
| S7 | pipeline 定义为模块级 Map，重启即丢 | `src/engine/pipeline.ts` | ✅ 已持久化 2026-08-07 |
| S8 | 文档漂移：RUN_VERIFICATION.md 曾称 Anthropic 为缺口 | `docs/RUN_VERIFICATION.md` | ✅ 已修复 2026-08-07 |
| S9 | `llmChannel.ts` 的 `BackendChannel` 误导注释 | `src/agents/llmChannel.ts` | ✅ 已清理 2026-08-07 |

### 7.2 待实施（优先级）
- [x] **P0（低成本高收益，优先）**：✅ 全部完成（commit d48401e）：S1 基础 CSP；S2 capabilities 收窄到 `$APPDATA/$HOME/$DOCUMENT/$RESOURCE`+项目目录；S3 HTTP 收敛到具体 provider 域 + 本地 Ollama；S4 `run_git` 校验 cwd + 子命令白名单（拒破坏性命令/危险 flag）。
- [x] **P1（信任模型 + 文档）**：S8 修文档漂移（删 Anthropic 缺口，补已实现事实）✅；S9 清理 `BackendChannel`（合并实现 + 修正注释）✅；S5 信任声明（`loader.ts`+README）✅；S6 凭据分层文档化（`docs/credentials.md`）✅。
- [ ] **P2（长期）**：S7 Pipeline 持久化纳入 `ProjectFile` + schema version；测试体系补 Vitest 单测 + headless CI；executor/builtin/workflowStore 上帝模块渐进拆分。

### 7.3 设计权衡（已记录，不重复做）
- 不重做进程级沙箱（对可信本地代码收益低）；真隔离靠 Git Worktree（`sandboxMode: 'gitworktree'`，已实现）。
- key 进 WebView 内存属本地应用常态；Rust 代理转发（TODO §4.3 方案 Y）为长期演进，不阻塞。

*新增：2026-08-07（基于 Codex 评审，未改代码，仅整理文档）*
