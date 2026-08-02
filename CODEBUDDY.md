# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## 项目简介
SlimeMold 是一个类 ComfyUI 的**节点式 Agent 工作流**可视化编辑与执行工具，基于 **Tauri 2 + React 18 + React Flow (@xyflow/react) + Zustand + TypeScript + Vite**。UI 风格参考 Typora 浅色主题。

## 常用命令
- **安装依赖**：`npm install`
- **浏览器预览（无需 Rust）**：`npm run dev`（默认 http://localhost:1420，HTTP 走 window.fetch，可能受 CORS 限制）
- **桌面端运行（需 Rust 工具链）**：`npm run tauri dev`
- **构建前端 + 打包**：`npm run build`（执行 `tsc -b && vite build`）；桌面安装包 `npm run tauri build`
- **类型检查**：`npx tsc --noEmit`（注意 cmd 环境下可能需要 `npx.cmd`；PowerShell 下用 `Set-Location -LiteralPath` 切目录）
- **无头运行工作流**：`npm run headless`（执行 `scripts/headless-run.ts`，用于在 CI/命令行跑 `.workflow.json`）
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
- `NodeDefinition`（`src/types.ts`）是核心抽象：`typeId / inputs / outputs / params / execute(inputs, params, ctx)`。`execute` 返回输出对象；端口有 `PortType`（text/number/list/json/image/any）用于连线类型校验。
- 内置节点在 `nodes/builtin.ts`（`builtinDefs`）、`nodes/creative.ts`（`creativeNodes`）；应用启动时由 `registryStore.register(...)` 注册。
- `canvas/` 用 React Flow 渲染节点与连线；连线 `EdgeKind` 分 `data`（值传递）/ `task`（任务派发）/ `control`（控制流，拓扑排序视作断点），`EDGE_KIND_STYLE` 决定颜色线型。

### 执行引擎（src/engine/）
这是「读懂多文件才能理解」的核心：
- `topoSort.ts`：Kahn 分层拓扑排序（`topoLayers` 返回可并行层 `layers` 与成环节点 `cyclic`）；`wouldCreateCycle` 在连线时即时拦截成环，**忽略 control 语义边**以容忍「条件→循环体→回指条件」伪环。
- `executor.ts`：`runWorkflow(opts)` 主入口。按 layer 顺序、同层并发执行；汇集上游输出 `collectInputs`；支持 `incremental`（仅跑脏节点+下游）、`retryFailed`（失败续跑）、`stopAfterNodes`（重跑到此节点）、`skipFailed`（失败不中断）。`NODE_RETRIES`/瞬时错误判定与 LLM 层重试互补。模块级 `currentAbort` 支持 `stopWorkflow()` 中止。
- `subgraph.ts`：`flattenSubgraphs` 展开子图引用节点（`subgraph.ref`），端口动态来自子图 IO。
- `nodeCache.ts`：节点结果缓存（按 `cacheKey` 命中复用，支撑增量执行）。
- `rateLimiter.ts`：`Semaphore` + `withRetry` 并发与重试控制。
- `expr.ts`：参数模板表达式求值（如 `{{input}}` 插值）。

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
`src-tauri/src/lib.rs` 注册插件：`tauri_plugin_http / fs / dialog / opener`，并提供密钥库、文件访问等原生能力。`tauri.conf.json` 配置窗口（1280×800）与 `beforeDevCommand: npm run dev`、devUrl 1420、frontendDist `../dist`。改窗口尺寸/权限/允许的 http 域名在此文件。

### Headless（scripts/headless-run.ts、src/engine/headless.ts）
命令行跑工作流：`agents` 配置在 headless 场景下可用明文 `apiKey`（与桌面密钥库链路区分），用于无 UI 执行与调试。

## 关键约定与易错点
- `isTauri` 是布尔值，禁止写成 `isTauri()`（曾因此引发运行时 `TypeError`）。
- 所有 HTTP 必须经 `platform/env.ts` 的 `httpFetch`，不可直接 `fetch`。
- 编辑器代码禁止直接 import 整个另一个 store 造成循环依赖；用 `xxxStore.getState()`。
- 工作流/项目文件不持久化明文 API Key，只存 `credentialKey`。
- 连线成环拦截忽略 `control` 边；新增控制流节点时注意该语义。
- 改动后 Tauri dev 经 HMR 生效；若 UI 异常按 `Ctrl+R` 刷新。残留 `slime-mold` 进程与无用 cmd 窗口需手动清理。

## 开发期日志目录 `.devlog/`
仓库根下的 `.devlog/`（含 `log.md` 只写日志、`arch_index.md` 物理架构索引、`summary.md` 运行摘要、`archive/`）由 `feasibility-exploration` 技能在开发期生成，属**项目内本地产物**：
- **只写不删**：`log.md` 仅可追加，不可修改/删除，作为可审计的开发轨迹。
- `arch_index.md` 记录对象→目录/文件/行号；「被引用处」按需用 ripgrep 现查，不入索引。
- `summary.md` 按 `decision_id` 关联并滚动压缩早期日志段到 `archive/`。
- 全部本地，**禁止上传云端**；不应将其内容视为项目运行时的一部分，也勿在构建/提交时特殊处理（除非用户要求）。
