# SlimeMold · 类 ComfyUI 节点式 Agent 工作流桌面应用

基于 **Tauri 2 + React 18 + React Flow** 的可视化 Agent 工作流编辑与执行工具，界面风格参考 Typora 默认主题（浅色、留白、柔和边框）。

## 功能

- **节点式编辑器**：拖拽添加节点、端口连线组成 DAG（自动拦截环路）
- **执行引擎**：分层拓扑排序、独立分支并行执行、节点状态可视化（灰/转圈/绿/红）、失败即停开关
- **多协议智能体**：OpenAI 兼容 / Anthropic / Ollama 本地模型，顶栏「智能体」中配置，Agent 节点绑定使用
- **规划 / 架构 / 派发**：`dispatch.plan`（规划）→ `architect.design`（架构设计）→ `dispatch.split`（派发扇出）三段式编排，下游接 `worker.*` 并行施工、`coord.resolver` 冲突协调，构成完整「规划→架构→派发→施工→协调」Agent 流水线（详见 `USAGE.md` 节点分层对照表，示例见 `examples/test-architect.workflow.json`）
- **调试模式**：顶栏 🐛 按钮开启后，节点卡片提供「重跑子图 / 重跑到此节点」等调试动作
- **导入导出**：工作流保存为 `.workflow.json`（含节点、连线、参数、智能体配置），带版本与缺失类型校验
- **插件系统**：JS 插件包动态加载自定义工具节点，见下文插件开发

## 运行

```bash
npm install

# 方式一：浏览器预览（无需 Rust，网络请求用 window.fetch，可能受 CORS 限制）
npm run dev          # http://localhost:1420

# 方式二：桌面端（需安装 Rust 工具链 https://rustup.rs）
npm run tauri dev
```

> 桌面端下 HTTP 请求经 Tauri plugin-http 由 Rust 侧转发，无 CORS 限制；插件目录扫描、文件对话框仅桌面端可用。

## 测试

项目用 [Vitest](https://vitest.dev/) 做单元测试（纯逻辑模块，无需 UI）。

```bash
npm install
npm run test        # 一次性运行全部单测（CI 用）
npm run test:watch  # 监听模式，开发时实时反馈
```

测试覆盖（截至 2026-08-07，共 59 项）：

- `src/engine/topoSort.test.ts` —— 分层拓扑排序、成环检测、`wouldCreateCycle` 的 control 边忽略与回流边语义
- `src/engine/expr.test.ts` —— 参数模板表达式求值（字面量 / 运算 / 变量 / 成员访问 / 内置函数 / 三元 / 错误）
- `src/engine/rateLimiter.test.ts` —— `Semaphore` 并发控制、`sleep`、`withRetry` 重试与中止
- `src/engine/nodeCache.test.ts` —— 节点结果缓存（`cacheKey` 稳定序列化、读写、`strike` 清除、运行统计）

新增纯逻辑改动时，请同步补充对应单测再提交。

## 快速上手

1. 顶栏「智能体」→ 配置协议 / Base URL / API Key / 模型
2. 左侧节点库拖入：`文本输入` → `智能体` → `结果预览`，依次连线
3. 智能体节点在右侧面板绑定已配置的智能体
4. 点击「运行」，在节点与底部日志中查看执行结果
5. 「导出」保存为 JSON，可随时「导入」恢复

> 想快速体验？点顶栏「导入」选择仓库内的 `examples/demo.workflow.json`，即可加载一个最小演示工作流（`文本输入` → `模板拼接` → `智能体` → `结果预览`）。智能体节点默认未绑定 Key，运行时会标红并演示失败传播；在「智能体」面板配置并绑定后便可跑通。

## 插件开发

插件包 = 一个文件夹，包含两个文件（示例见 `plugin-examples/word-counter/`）：

```
my-plugin/
├── manifest.json   # 插件与节点声明（id、entry、nodes: 端口/参数定义）
└── index.js        # ESM 入口：export default { executors: { [typeId]: async (inputs, params, ctx) => outputs } }
```

`ctx` 能力：`logger`（写入应用日志）、`llm(agentId, messages)`（调用已配置智能体）、`storage`（KV 存储）、`signal`（中止信号）。异常会被捕获并标记节点失败，不影响主应用。

加载方式：

- **桌面端**：将插件文件夹放入 `AppData/com.slimemold.app/plugins/`，「插件」面板中点击「扫描插件目录」（应用启动时也会自动扫描）
- **浏览器**：「插件」面板「从文件导入」，同时选中 `manifest.json` 与 `index.js`

### 插件安全与信任模型

- **插件在主 WebView 内运行，并非进程级沙箱**：插件代码（经 Blob URL 动态 `import()`）与宿主共享同一 JS 运行时与 DOM 权限。因此它被视作**可信本地代码**——即由你显式安装（拖入目录 / manifest 文件导入）的节点包，类比 ComfyUI 的 custom nodes。
- **仅加载本机来源**：`loader.ts` 只接受来自本机文件系统的插件（程序级 `resourceDir`、项目级 `custom_nodes`、或手动文件导入）。**请勿从任意远端 URL 复制并执行未知插件源码**，除非你能完全信任其来源。
- **权限边界是约定式的**：框架通过 `capability` / 职业父类（`ComputeNode`/`IoNode`/`SandboxWriteNode`/`CoordinatorNode`/`SystemNode`/`GitNode`）表达权限等级，越权的 manifest 声明会被忽略；但插件在 `execute` 内直接调用平台能力仍可越界。安装来源不可信的插件即等于授予其等同本应用的权限。
- **未来若支持网络插件**：需升级为进程级隔离（独立 Tauri WebView / Web Worker / Rust 侧执行 + 显式能力授权），不能在主 WebView 内直接 `import()` 执行。

## 目录结构

```
src/
├── canvas/         # React Flow 画布与节点渲染
├── engine/         # 拓扑排序 + 执行引擎
├── agents/         # 多协议 LLM 封装与路由
├── plugins/        # 插件加载器与管理器
├── io/             # 工作流序列化与导入导出
├── store/          # Zustand（图状态 / 节点注册中心）
├── components/     # 顶栏、节点库、属性面板、状态栏、弹层
└── platform/       # Tauri / 浏览器环境适配
src-tauri/          # Rust 桌面壳（http/fs/dialog 插件）
plugin-examples/    # 插件示例
```

## Ollama 本地模型接入

SlimeMold 内置 `ollama` 协议，可直连本机 Ollama，无需 API Key，模型完全离线运行。

### 1. 安装并拉取模型

```bash
# 安装 Ollama 后，拉取一个本地模型
ollama pull qwen2.5:3b
```

### 2. 在应用内配置

1. 顶栏「智能体」→ 新建或选中一个协议为 **Ollama** 的智能体
2. Base URL 默认 `http://127.0.0.1:11434`（Ollama 默认端口，一般无需改动）
3. 「模型」字段：
   - 直接点 **推荐模型下拉**，按显存提示选择（见下表）
   - 或点右侧「刷新」按钮，拉取**本机已安装**的模型列表
   - 也可手动输入任意模型名（如 `qwen2.5:3b`）
4. 把该智能体绑定到「智能体」节点即可运行

### 3. 模型选择建议（按显存）

| 模型 | 约显存占用 | 适用显卡 |
| --- | --- | --- |
| `qwen2.5:0.5b` | ~0.5GB | 任意，极轻量 |
| `qwen2.5:3b` | ~2GB | **6GB（如 RTX 2060）首选，流畅** |
| `qwen2.5:7b` | ~4.5GB | 6GB 能吃紧，8GB+ 更稳 |
| `deepseek-r1:7b` | ~4.5GB | 推理强，6GB 偏吃紧 |
| `llama3.1:8b` | ~5GB | 8GB+ 显卡推荐 |

> 默认模型已设为 `qwen2.5:3b`，对 6GB 显存最友好。若想尝试质量更好的 `7b`，在下拉中切换即可，但注意显存接近占满时可能掉速。

### 4. 排错

- **拉取不到本机模型**：确认 Ollama 已启动（`ollama serve`），且 Base URL 端口正确。
- **运行时 404**：模型名拼写需带标签，如 `qwen2.5:3b`，而不是 `qwen2.5`。
- **桌面端请求失败**：确认 `src-tauri/tauri.conf.json` 的 `plugins.http` 允许访问 `http://127.0.0.1` 与 `http://localhost`（默认通常已允许本地地址）。

## 相关文档

- [凭据分层模型](docs/credentials.md)：桌面端密钥库 / headless 环境变量 / 工作流文件 `credentialKey` 的处理边界
- [安全专项](SECURITY.md)：架构安全评审与 P0/P1/P2 修复追踪
- [运行验证清单](docs/RUN_VERIFICATION.md)：协议兼容与功能验证检查项

