# SlimeMold · 类 ComfyUI 节点式 Agent 工作流桌面应用

基于 **Tauri 2 + React 18 + React Flow** 的可视化 Agent 工作流编辑与执行工具，界面风格参考 Typora 默认主题（浅色、留白、柔和边框）。

## 功能

- **节点式编辑器**：拖拽添加节点、端口连线组成 DAG（自动拦截环路）
- **执行引擎**：分层拓扑排序、独立分支并行执行、节点状态可视化（灰/转圈/绿/红）、失败即停开关
- **多协议智能体**：OpenAI 兼容 / Anthropic / Ollama 本地模型，顶栏「智能体」中配置，Agent 节点绑定使用
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
