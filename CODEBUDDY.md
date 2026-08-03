# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## 项目简介
SlimeMold 是一个类 ComfyUI 的**节点式 Agent 工作流**可视化编辑与执行工具，基于 **Tauri 2 + React 18 + React Flow (@xyflow/react) + Zustand + TypeScript + Vite**。UI 风格参考 Typora 浅色主题。

## 常用命令
- **安装依赖**：`npm install`
- **浏览器预览（无需 Rust）**：`npm run dev`（默认 http://localhost:1420，`strictPort: true`；HTTP 走 window.fetch，可能受 CORS 限制）
- **桌面端运行（需 Rust 工具链）**：`npm run tauri dev`（先启 Vite 再启 Rust 壳，端口 1420 被占用时会失败）
- **构建前端 + 打包**：`npm run build`（执行 `tsc -b && vite build`）；桌面安装包 `npm run tauri build`
- **类型检查**：`npx tsc --noEmit`（注意 cmd 环境下可能需要 `npx.cmd`；PowerShell 下用 `Set-Location -LiteralPath` 切目录）
- **无头运行工作流**：`npm run headless examples/demo.workflow.json`（执行 `scripts/headless-run.ts`，CI/命令行跑 `.workflow.json`）
- **仅校验 Rust 侧**：`cd src-tauri && cargo check`（不启动 UI，快速查后端类型/语法）
- **查看 Tauri 环境**：`npx tauri info`（Rust 工具链、平台、依赖版本）
- **预览生产构建**：`npm run preview`

> 注：项目**没有测试框架与测试脚本**，不要臆造 `npm test`。`npm run headless` 是唯一的脚本化执行入口。

## 高层架构

### 环境适配层（src/platform/env.ts）
所有环境差异在此收敛。`isTauri` 是**布尔值**（不是函数），通过 `'__TAURI_INTERNALS__' in window` 判断。关键能力：`httpFetch`（Tauri 走 `@tauri-apps/plugin-http` 由 Rust 转发规避 CORS；浏览器退化 `window.fetch`）、`scopedStorage`、`openDirDialog`、`pickProjectFile`、`showSaveDirDialog`、`defaultStandaloneDir`。新增涉及平台能力（对话框/文件/网络）的代码都必须经此层，禁止在阅读层直接 `window.fetch` 或 `__TAURI__` 全局对象。

### 状态管理（src/store/，Zustand）
三个 store 分工明确，彼此通过 `getState()` 直接调用（不互相 import 整个 store 形成环）：
- `workflowStore.ts`：图本体——节点 `FlowNode`、连线 `FlowEdge`、参数、运行状态、`projectDirty`、项目路径；含「运行 / 停止 / 增量执行」触发入口与「自动落盘」逻辑。
- `registryStore.ts`：节点定义注册中心 `defs: Record<typeId, NodeDefinition>` 与已加载插件列表。`getNodeDef(typeId)` 提供大小写不敏感回退。
- `viewStore.ts`：视图态（缩放、选中、面板开关等），与执行解耦。

### 节点定义与渲染（src/nodes/、src/canvas/）
- `NodeDefinition`（`src/types.ts`）是核心抽象：`typeId / inputs / outputs / params / execute(inputs, params, ctx)`。`execute` 返回输出对象；端口有 `PortType`（text/number/list/json/image/any），用 `arePortsCompatible()` 校验连线类型（标量互通、list/json 隔离）。
- 内置节点在 `nodes/builtin.ts`（`builtinDefs`）、`nodes/creative.ts`（`creativeNodes`）；应用启动时由 `registryStore.register(...)` 注册。
- `canvas/` 用 React Flow 渲染节点与连线。节点类型：`base`（`BaseNode`）、`groupProxy`（折叠组的代理节点）；边类型 `kind`（`KindEdge` 按 data/task/control 着色）。连线 `EdgeKind` 分 `data`（值传递）/ `task`（任务派发）/ `control`（控制流，拓扑排序视作断点），`EDGE_KIND_STYLE` 决定颜色线型。
- `WorkflowEditor.tsx` 是主画布（支持拆分视图 `SplitCanvas`），内含拖入、连线环路校验、右键打包子图/编组、右键长按框选、分组折叠等交互。

### UI 容器（src/components/）
应用外壳为四区布局：`TopBar`（顶部菜单）+ `LeftSidebar`（左侧可展开抽屉）+ `WorkflowEditor`（画布）+ `Inspector`（右侧属性检查器）+ `StatusBar`（底部可停靠面板）。
- `LeftSidebar`：`NodePalette`（按分类节点库，支持搜索/拖放）、`AgentPanel`（智能体/角色/端点配置）、`PluginPanel`（插件扫描/导入）、`SubgraphPanel`（已打包子图复用）。
- `Inspector`：按选中内容动态渲染——普通节点显示参数/输入输出预览，`subgraph.ref` 节点显示子图参数，空白处显示工作流属性。
- `StatusBar`：三个可切换 Tab——`TerminalLog`（运行日志）、`RunHistoryPanel`（历史记录）、`VariablesPanel`（变量）。面板开合/高度由 `viewStore.panelOpen` / `panelH` 管理。
- 各面板宽度/高度可拖拽（节点库/属性 160–480px，底部 120–480px）。

### 执行引擎（src/engine/）
这是「读懂多文件才能理解」的核心：
- `topoSort.ts`：Kahn 分层拓扑排序（`topoLayers` 返回可并行层 `layers` 与成环节点 `cyclic`）；`wouldCreateCycle` 在连线时即时拦截成环，**忽略 control 语义边**以容忍「条件→循环体→回指条件」伪环。
- `executor.ts`：`runWorkflow(opts)` 主入口。按 layer 顺序、同层并发执行；汇集上游输出 `collectInputs`；支持 `incremental`（仅跑脏节点+下游）、`retryFailed`（失败续跑）、`stopAfterNodes`（重跑到此节点）、`skipFailed`（失败不中断）。`NODE_RETRIES`/瞬时错误判定与 LLM 层重试互补。模块级 `currentAbort` 支持 `stopWorkflow()` 中止。
- `subgraph.ts`：`flattenSubgraphs` 展开子图引用节点（`subgraph.ref`），端口动态来自子图 IO。
- `nodeCache.ts`：节点结果缓存（按 `cacheKey` 命中复用，支撑增量执行）。
- `rateLimiter.ts`：`Semaphore` + `withRetry` 并发与重试控制。
- `expr.ts`：参数模板表达式求值（如 `{{input}}` 插值）。

### 子图与分组（src/engine/subgraph.ts、workflowStore）
两种「节点聚合复用」机制，易混淆，需区分：
- **子图（Subgraph）**：把选中节点打包为可复用的 `SubgraphDef`（含端口、内部节点/边、递归支持嵌套）。画布上以类型 `subgraph.ref`（常量 `SUBGRAPH_REF_TYPE = 'subgraph.ref'`）的引用节点出现；运行时 `flattenSubgraphs` 把它展开成内部节点再执行。端口由 `inferPorts` / `resolvePorts` 依内部 IO 节点自动推导。`packSelectionAsSubgraph` / `unpackSubgraphNode` 负责打包与就地解组。
- **分组（NodeGroup，纯视觉）**：`createGroup` 把节点编组（`Ctrl+G`），折叠后成员隐藏、仅显示 `groupProxy` 代理节点。`recomputeProxyPorts` 按端口类型聚合内部端口为外部可见的 `ProxyPort`，连线经 `VirtualEdge` 映射到内部具体端口。分组无执行语义，仅视觉折叠。

### 状态持久化与脏检测（workflowStore 尾部）
- 用 `zustand/persist` 持久化到 `localStorage`（key `slime-mold-workflow`），但**仅序列化 `partialize` 白名单字段**（nodes/edges/agents/roles/workflows/subgraphs/groups/variables 等，见文件末尾 1740 行）。新增状态字段若不加入白名单，刷新后丢失。视图偏好存于 `viewStore`（key `slime-mold-view`）。
- 项目级脏检测**非手动标记**：`subscribe` 监听落盘相关字段（`DIRTY_KEYS`），变化时比对 `lastSavedSnapshot`（`projectSnapshot` 序列化结果）是否一致来置 `projectDirty`。因此所有修改节点/连线/参数的操作**必须走 store 方法**（不可直接 mutate），否则脏标记不生效。

### 智能体与 LLM 通道（src/agents/）
- `agentManager.ts`：管理 `AgentConfig`（协议/Base URL/模型/温度/`roleId`/`proxyUrl`）与 `ApiEndpoint`。工作流文件仅持久化 `credentialKey`，**绝不存明文 key**。
- `credentialStore.ts`：密钥经 `credentialKey` 从系统密钥库取回（桌面端 Rust 侧 `ep::<name>`）。
- `llmChannel.ts`：`getChannel()` 按协议路由到 OpenAI / Anthropic / Ollama 三种 provider（`providers/`）；`streamSSE.ts` 处理流式响应。
- `ApiEndpoint` + `AgentConfig` 两层抽象：Endpoint 管理「网址+密钥」复用单元，Agent 引用它，避免重复填 key。

### 插件系统（src/plugins/）
- 插件 = 文件夹含 `manifest.json`（声明 `id/name/entry/nodes`） + `index.js`（ESM：`export default { executors: { [typeId]: async (inputs, params, ctx) => outputs } }`）。
- `loader.ts`：`loadPluginFromSource` 把入口源码经 `Blob URL` 动态 `import()`，`execute` 包装为统一 `NodeDefinition` 并注入受限 `ctx`（`logger`/`llm(agentId,messages)`/`storage`/`signal`）。异常被捕获并标记节点失败，不影响主应用。
- 桌面端从 `AppData/com.slimemold.app/plugins/` 扫描；浏览器「从文件导入」同时选 manifest 与 index.js。加载结果经 `registryStore.registerPlugin` 注册，与内置节点同等待遇。

### 序列化与 IO（src/io/）
- `projectIO.ts`/`workflowIO.ts`：工作流存为 `.workflow.json`（含节点、连线、参数、智能体配置，带 `version` 与缺失类型校验）；项目可为目录形态（含 `.slimemold`）或旧版单文件 `.smproj`。导入时校验缺失 `NodeDefinition` 并提示。

### 桌面壳（src-tauri/，Rust）
`src-tauri/src/lib.rs` 注册插件：`tauri_plugin_http / fs / dialog / opener / window_state`，并提供凭据与接入点能力。**凭据体系（重要）**：
- 纯 API Key 存系统密钥库（`keyring` crate，Windows Credential Manager/macOS Keychain/Linux secret-service），前端只存 `credentialKey` 名称、绝不落明文。密钥库内用 `___cred_index___` 特殊条目维护枚举索引（keyring 不支持遍历）。
- **接入点（Endpoint，含 baseUrl+apiKey）存 `AppData/com.slimemold/endpoints.json` 文件**：因 Windows keyring 存在 (service,user) 读写不一致问题，接入点列表改落文件，但其中 apiKey 用 AES-GCM（主密钥存密钥库 `___sm_master_key___`）加密成密文，磁盘无明文。
- Rust 侧**不再实现 LLM HTTP 客户端**（原 chat_completion 已移除），所有 LLM 请求由前端 provider 经 plugin-http 发起（规避 CORS 并带回 token usage）。
`tauri.conf.json` 配置窗口（1280×800，min 960×600）、`beforeDevCommand: npm run dev`、devUrl 1420、frontendDist `../dist`。改窗口尺寸/权限/允许的 http 域名在此文件。

### Headless（scripts/headless-run.ts、src/engine/headless.ts）
命令行跑工作流：`agents` 配置在 headless 场景下可用明文 `apiKey`（与桌面密钥库链路区分），用于无 UI 执行与调试。

## 关键约定与易错点
- `isTauri` 是布尔值，禁止写成 `isTauri()`（曾因此引发运行时 `TypeError`）。
- 所有 HTTP 必须经 `platform/env.ts` 的 `httpFetch`，不可直接 `fetch`。
- 编辑器代码禁止直接 import 整个另一个 store 造成循环依赖；用 `xxxStore.getState()`。
- 工作流/项目文件不持久化明文 API Key，只存 `credentialKey`；接入点整条走 Rust 加密落盘。
- 连线成环拦截忽略 `control` 边；新增控制流节点时注意该语义。
- **执行引擎用双重代次 `currentRunId` / `activeRunId`（executor.ts 顶部）控制停止**：`stopWorkflow()` 递增 `currentRunId` 使旧协程在下一层 `await` 边界发现过期（`myRun !== currentRunId`）后静默退出。新增异步执行逻辑时，必须在关键 `await` 后检查该条件，否则旧协程会复写新运行的状态（曾导致「刷新键失效」Bug）。
- 修改节点/连线/参数必须走 `workflowStore` 的方法（不能直接 mutate），否则 `projectDirty` 自动检测与持久化都不生效；新增需持久化字段要加进 `partialize` 白名单。
- 改动后 Tauri dev 经 HMR 生效；若 UI 异常按 `Ctrl+R` 刷新。残留 `slime-mold` 进程与无用 cmd 窗口需手动清理。

## 开发期日志目录 `.devlog/`
仓库根下的 `.devlog/`（含 `log.md` 只写日志、`arch_index.md` 物理架构索引、`summary.md` 运行摘要、`archive/`）由 `feasibility-exploration` 技能在开发期生成，属**项目内本地产物**：
- **只写不删**：`log.md` 仅可追加，不可修改/删除，作为可审计的开发轨迹。
- `arch_index.md` 记录对象→目录/文件/行号；「被引用处」按需用 ripgrep 现查，不入索引。
- `summary.md` 按 `decision_id` 关联并滚动压缩早期日志段到 `archive/`。
- 全部本地，**禁止上传云端**；不应将其内容视为项目运行时的一部分，也勿在构建/提交时特殊处理（除非用户要求）。
