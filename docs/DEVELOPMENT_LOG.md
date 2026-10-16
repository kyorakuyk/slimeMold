---
title: SlimeMold 开发记录：从 ComfyUI 式 Agent 工作流到本地优先的多 Agent 工作站
type: development-history
status: active-history
updated: 2026-09-23
tags:
  - SlimeMold
  - Agent
  - Tauri
  - React
  - Rust
  - 工作流
  - 工程复盘
period: 2026-07-29 至 2026-09-18
---

# SlimeMold 开发记录：从 ComfyUI 式 Agent 工作流到本地优先的多 Agent 工作站

> 本文是回顾性整理，依据项目 Git 历史、Codex 对话记录、CodeBuddy 开发日志和项目文档重建时间线。

## 记录范围

当前项目中用户提到的 `doc/log` 实际目录是 `docs/log`。该目录共包含 16 个文件：

- 10 份 Markdown 文件，包括 Codex 对话索引和 9 份对话记录；
- 6 份 CodeBuddy JSON 对话导出。

其中有几份 Codex 对话是同一段历史的重复导出，大量轮次只是“继续执行”或“审计”控制语句。本文按照实际开发动作、Git 提交时间和审计结论合并整理，没有重复罗列这些内容。日志中的 API Key、Token 和个人路径均不在本文中展开。

## 一、最初的想法：做一个可以编排 Agent 的桌面应用

SlimeMold 最初并不是一个完整的产品规划，而是一个比较直接的想法：做一个类似 ComfyUI 的节点式 Agent 工作流工具。

用户可以把不同功能的节点拖到画布上，用连线建立任务流程，再给不同节点绑定不同的智能体。最初确定的方向包括：

- 使用 Tauri + React 开发桌面端；
- 页面风格参考 Typora 默认主题；
- 使用 React Flow 构建节点画布；
- 节点通过 DAG 连接；
- 支持 OpenAI 兼容接口、Anthropic 和 Ollama；
- 支持工作流导入导出；
- 允许用户通过 JS/TS 插件增加自定义节点；
- 第一版直接搭建相对完整的框架，而不是只做一个演示页面。

初版很快搭出了：

- React Flow 工作流画布；
- Kahn 算法拓扑排序；
- 节点执行状态；
- 多协议 LLM Provider；
- JSON 工作流序列化；
- 插件动态加载；
- Tauri Rust 桌面壳；
- 基础节点和示例插件。

这一阶段最大的特点是开发速度很快，问题也很快出现：产品还没有经过验证，功能却已经开始不断增加。

## 二、按日期整理的开发过程

### 2026-07-29：从想法到项目骨架

这一天确定了 Tauri + React 的组合，并完成了第一版项目框架。

Tauri 负责桌面能力，Rust 负责文件、密钥、Git 和系统权限；React 和 TypeScript 负责界面、工作流模型以及大部分 Agent 逻辑。

初版包含六个模块：

1. 项目骨架；
2. 节点编辑器；
3. 工作流执行引擎；
4. 多协议智能体接入；
5. 工作流导入导出；
6. JS/TS 插件系统。

当天还处理了 Git 基础配置：

- 创建并关联远程仓库；
- 将 `token` 和 `.codebuddy` 加入 `.gitignore`；
- 提交 `chore: ignore token and .codebuddy`。

第一次推送没有立即完成，网络操作曾被跳过，后来才通过其他流程完成远程同步。

### 2026-07-30：开始补运行时能力

项目开始加入真正影响执行体验的功能：

- 流式输出；
- 并发限流；
- Tauri 桌面打包；
- 运行中止；
- 单节点重试；
- 子图批处理；
- 变量和表达式；
- 运行历史持久化。

项目开始从“可以画图”转向“可以运行任务”。真正的难点逐渐暴露出来：

- 节点之间如何传递结果；
- 一个节点失败后下游如何处理；
- 运行中止后如何清理状态；
- 多个任务同时运行时如何隔离状态；
- 失败任务能否从中间位置继续。

### 2026-07-31：角色、项目和界面开始变复杂

这一阶段加入了：

- 角色库；
- 节点级模型配置；
- 上下文隔离；
- 离线模拟模式；
- ComfyUI + VS Code 风格的界面调整；
- 顶部菜单和快捷键；
- 多工作流项目；
- `.smproj` 项目文件；
- 网格、小地图和面板状态。

离线模拟模式很有价值。它允许在没有 API Key 的情况下先验证节点链路，避免每次测试都依赖网络和模型服务。

但此时 UI、工作流、项目、Agent、运行时状态和模型配置已经同时增长，领域边界还没有真正建立。

### 2026-08-01：执行引擎快速扩张

这一天集中增加了大量工作流能力：

- 增量执行；
- 节点结果缓存；
- 条件分支；
- 端口类型检查；
- 节点耗时展示；
- `flow.if` 和 `flow.switch`；
- headless 工作流运行器；
- Ollama 本地模型接入；
- 写文件节点；
- 工作区问询；
- 资产面板；
- 图片和多模态处理。

Ollama 默认模型从 `qwen2.5:7b` 调整为 `qwen2.5:3b`，以适配 6GB 显存环境。

这一阶段出现过两个典型问题：

1. 资产面板的 `getSnapshot` 使用不稳定的内联数组选择器，造成无限重新渲染，最终出现白屏；
2. 前端依赖 Vite 的 `import.meta.glob`，但 headless 运行在 Node 环境中，没有这个能力。

后续通过稳定选择器、路径别名和 Node fallback 解决了这些问题。

### 2026-08-02：工作流开始具备“组织结构”

项目加入了：

- 工作流阶段分层；
- `loopGate` 循环控制；
- Dispatcher 和 Resolver；
- Worker 节点；
- API Key 安全存储；
- Rust keyring；
- APIKEYS 集中管理；
- 窗口状态保存；
- 失败续跑；
- 节点实时重试；
- 跳过失败继续；
- 主题和创作域节点。

工作流开始从：

```text
输入 → 模型 → 输出
```

发展成：

```text
需求 → 规划 → 任务拆分 → Worker 执行 → 验证 → 协调
```

这时安全问题也开始成为一等公民。API Key 不再直接写入工作流文件，而是改成通过凭据引用在运行时取回。

### 2026-08-03：项目生命周期和持久化完善

这一天重点解决“项目不能只存在内存里”的问题：

- `.slimemold` 目录结构；
- 项目级 dirty 标记；
- 运行历史落盘；
- 成本统计；
- 项目级和工作流级变量；
- 项目级和工作流级资产；
- 启动自动恢复最近项目；
- 欢迎页；
- 新建项目向导；
- 项目另存为；
- 文件菜单；
- 项目目录选择；
- 执行看板；
- 工作流向导；
- 验证断言节点。

这里踩过几个 Tauri 相关的坑：

- `window.confirm` 在 Tauri 环境下并不总是可用；
- 文件选择应该使用 Tauri 的 dialog 插件；
- 新建项目位置选择失败时，用户看到的只是“点了没有反应”；
- 组件导出缺失会让整个页面卡在加载状态；
- 运行日志不应该跟着源码进入版本控制。

后来通过 ErrorBoundary、Tauri plugin-dialog 和更明确的错误状态，才逐渐能看到真实启动问题。

### 2026-08-04：开始搭建软件工程工作流

这一阶段加入了：

- `dispatch.plan`；
- `dispatch.split`；
- `architect.design`；
- scope 约束；
- B-full 冲突串行化；
- 任务派发；
- 协调节点；
- 撤销和重做；
- 复制粘贴；
- 单节点运行；
- bypass/mute；
- 命令面板；
- 更完整的调试能力。

SlimeMold 不再只是一个节点编辑器，而是开始表达一套软件交付流程：

```text
需求 → 计划 → 架构 → 任务拆分 → 并行施工 → 验证 → 交付
```

### 2026-08-05：开始面对 TypeScript 工程债务

项目继续加入：

- 双层 custom nodes；
- Pipeline；
- Builder；
- Validator；
- 更复杂的工作流生成；
- 跨工作流执行；
- 新建项目向导。

与此同时，TypeScript 开启了更严格的检查：

- `noUnusedLocals`；
- `noUnusedParameters`；
- strict 类型检查。

随后清理了大量历史类型问题。

这一阶段的经验是：复杂项目不能只看功能是否能跑，还要尽早开启编译器的严格检查，否则类型债务会在后期集中爆发。

### 2026-08-06：AgentHarness 和国际化进入主线

这一阶段加入了：

- `AgentHarness`；
- `ToolRegistry`；
- 工具调用；
- 异步审查；
- Agent 轨迹采集；
- 节点声明式重构；
- i18n XML；
- `react-i18next`；
- 多语言目录；
- headless 环境下的 i18n fallback。

同时修复了 `builtin` 和 `builtinTools` 的循环依赖。此前页面刷新后会卡在加载状态，构建不一定立即报错，但运行时会出现问题。

项目从这时开始同时支持：

```text
浏览器预览
Tauri 桌面端
Node/headless 执行
```

这也要求平台差异必须集中封装，不能假设所有代码都运行在 Vite 浏览器环境中。

### 2026-08-07：架构审查、上帝模块和第一次重构

一次完整架构审查指出，项目虽然功能丰富，但已经出现了几个“大模块”：

- `executor.ts` 约 1500 行；
- `builtin.ts` 约 2700 行；
- `workflowStore.ts` 约 2200 行；
- `App.tsx` 承担大量应用级编排。

问题并不只是行数，而是这些文件同时处理了太多职责：

```text
executor
├── 调度
├── 拓扑
├── 缓存
├── 循环
├── 重试
├── 沙箱
├── Git Worktree
├── 成本
├── 日志
├── 历史
└── Zustand 状态回写
```

#### 第一批低风险拆分

先从纯函数和低风险模块入手：

- 将 `builtin.ts` 拆成多个内置节点模块；
- 抽出 `groupProxy`；
- 抽出 `workflowSerialize`；
- 抽出 `nodeLayout`；
- 抽出 `nodeRuntime`；
- 抽出 `executorHelpers`；
- 抽出图算法；
- 抽出执行计划。

同时建立 Vitest 测试基础，覆盖：

- 拓扑排序；
- 成环检测；
- 表达式计算；
- 速率限制；
- 节点缓存；
- 子图；
- Pipeline；
- Executor 核心逻辑。

测试随后接入 GitHub Actions：

```text
TypeScript 检查
↓
Vitest
↓
headless 工作流冒烟
```

#### runWorkflow 的生命周期风险

对 `runWorkflow` 的评估发现，最危险的不是它很长，而是并发和资源生命周期：

- 旧运行可能删除新运行创建的 Worktree；
- 旧运行可能清空新运行的进度状态；
- 旧运行可能覆盖新的 AbortController；
- 节点忽略 Abort 后返回，仍可能写入旧结果；
- Worktree 创建后提前失败，可能没有清理；
- 非当前激活工作流可能错误读取 `activeWfId`；
- 缓存没有充分区分工作流和工作区。

最终采取了保守方案：

- 新增 `RunContext`；
- 资源按 `wfId + runId` 绑定；
- 新增 `runResources.ts`；
- 使用 `try/finally` 统一清理；
- 旧运行返回后再次检查代次；
- 修正非激活工作流读取；
- 为并行工作流和 stale run 增加测试。

这次重构没有继续把所有调度代码拆成十几个文件，而是先解决最危险的生命周期问题。

> 重构应该由产品能力和可靠性驱动，而不是由文件行数驱动。

### 2026-08-08：执行闭环、事件流、Checkpoint 和文件权限

这一天开始收拢 A-E 执行闭环：

- 统一 `RunContext`；
- 统一运行事件；
- JobBoard；
- AgentRouter；
- checkpoint；
- 人工接管；
- Experience Store；
- 缓存隔离；
- 成本统计。

Checkpoint 从“运行结束后保存一次”逐渐变成：

- 节点级快照；
- 阶段级快照；
- 运行中保存；
- 最近多个版本；
- 失败后恢复；
- 继续运行时只重跑必要节点。

事件流也从 UI 临时状态发展为可选的脱敏 JSONL 日志。

#### Tauri fs scope 的坑

项目最初通过 CapabilityBuilder 反复注入动态 `fs:scope`，后来遇到：

- `fs:scope` 需要字符串数组；
- 某些操作权限不接受 scope 字段；
- 重复调用 capability 注入；
- Rust 主线程高 CPU；
- WebView 输入响应变慢甚至冻结。

日志中曾出现 CPU 占用异常升高、页面输入冻结的情况。

最后改成：

- 使用官方 `FsExt::fs_scope().allow_directory()`；
- 对授权目录做去重；
- 避免重复注入；
- 将动态授权集中到项目打开流程。

### 2026-08-09：AgentRouter 暴露了真正的产品复杂度

AgentRouter 是项目从“工作流引擎”走向“多模型调度系统”的开始。

运行时曾经同时出现过：

- OpenAI 兼容接口 401；
- Ollama 没启动；
- 本地模型不存在；
- DeepSeek 凭据没有正确取出；
- fallback 链配置错误；
- plugin-http 的资源错误。

#### plugin-http 的 resource id 错误

当 Ollama 没有启动时，Tauri plugin-http 除了返回网络错误，还可能产生资源 ID 无效的未处理 Promise rejection。

最初这会触发全屏应用错误页。后来做了两层处理：

- 在 `httpFetch` 统一归一化底层网络错误；
- 在全局 rejection 处理中，将资源清理噪声识别为非致命错误。

修复后，应用不再整页崩溃，而是将错误显示为普通节点失败。

#### DeepSeek 模型判断失误

由于本地价格表里没有某个模型名称，曾经一度据此判断远端模型不存在。用户指出该模型是通过服务端模型列表自动拉取的，而且确实是服务方提供的模型。

后续重新梳理后确认：

- 模型列表不能简单依赖本地价格表；
- 远端模型名不能被硬编码白名单随意过滤；
- `/v1` 是否存在需要按 Provider 和官方接口处理；
- 中转站返回的模型名不能直接当作官方模型名；
- 最终必须通过实际 probe 或真实请求验证。

项目后来先尝试自动补 `/v1`，又针对 DeepSeek 官方地址恢复保持原始 Base URL 的处理方式。

#### AgentRouter 审查

第一次完整审查发现：

1. Anthropic 原生接口的模型拉取和探测仍按 OpenAI 协议处理；
2. 多个 Agent 默认共用同一个 `credentialKey`，可能互相覆盖 API Key；
3. category 路由只是候选推荐，不是硬路由；
4. 缺少 API Key、模型、Base URL 和最近探测状态的可用性过滤；
5. 删除 Agent 后，路由表可能残留失效 ID；
6. AgentEconomics 和 `selfImprove` 绑定过紧；
7. Rust 端可能将所有解密后的 Endpoint Key 返回前端。

随后加入了：

- 原生 Anthropic 模型拉取和探测；
- per-agent 或 per-endpoint 凭据；
- Vault 自动分组和迁移；
- Agent 可用性过滤；
- 删除 Agent 时清理路由引用；
- 运行时通过 `credentialKey` 取回密钥；
- 成本感知评分；
- DeepSeek 示例工作流。

> 多模型系统的难点不只是多写几个 Provider，而是凭据、协议、模型、可用性、成本和回退策略之间的组合关系。

### 2026-08-10：Agent 作用域和 UI 交互稳定下来

这一天主要解决 Agent 的作用域和使用体验问题。

#### Agent 的项目级和全局级作用域

最初切换工作流后，刚刚配置好的 Agent 会消失。根因是 Agent 只挂在当前工作流状态中，而不是项目级状态。

后来增加了：

- 项目级 Agent；
- 全局 Agent；
- 项目级 Agent 覆盖同名全局 Agent；
- Agent 作用域筛选；
- 全局 Agent 默认置顶；
- Agent 文件持久化；
- 项目级 custom nodes。

中间还调整了文件布局，最终将 Agent 配置和项目文件放在 `.slimemold` 根目录下，避免只有一个 Agent 文件时额外包一层目录。

#### AgentSelect 和 UUID 显示问题

增加了通用 `AgentSelect`：

- 单选；
- 多选；
- 搜索；
- 自绘下拉菜单；
- 多 Tag；
- 路由表复用；
- Council 节点复用。

禁用 Agent 后出现过一个问题：如果直接把禁用 Agent 从所有候选列表中删除，已经绑定该 Agent 的节点找不到名称，UI 会退化显示 UUID。

最终处理方式是：

- 已绑定的禁用 Agent 继续显示；
- 显示名称和“已禁用”标记；
- 新选择时不可点击；
- 重新启用后恢复使用。

#### 复杂的侧边栏调整

智能体面板经过多轮调整和回退，最终形成了：

- 设置中心保持原来的布局；
- 工作流里的智能体库作为独立侧边栏；
- 编辑配置从智能体库右侧展开；
- 编辑面板作为次级抽屉；
- 抽屉从左向右滑入；
- 列表区域独立滚动；
- 导入按钮固定在底部；
- 全局和项目 Agent 可以筛选；
- 历史面板采用类似侧边栏模式。

#### “手动点运行”的误解

有一次用户说 WorkBuddy 总是需要手动点“运行”。最初误以为这是 SlimeMold 的工作流运行按钮，于是准备给项目增加 F5 快捷键。

后来用户提供截图，才发现他说的是 CodeBuddy IDE 的工具调用确认弹窗，而不是 SlimeMold 的运行按钮。相关项目改动最终全部回退。

> 当用户描述可能对应多个系统时，不要急着改代码。先确认问题属于哪个产品、哪个窗口、哪个运行层。

### 2026-08-11：执行器 H1、workflowStore G5 和插件 Worker PoC

#### H1：收拢 executor

在前面的生命周期修复基础上，开始对 executor 做更有边界的拆分：

- H1a：`runFinalizer`；
- H1b：`runScheduler`；
- H1c：`runLoop`；
- H1d：Agent 决策；
- H1e：节点执行前置策略；
- H1f：LLM fallback 调用；
- H1g：节点结果副作用处理。

拆分后的模块分别负责：

- 运行收尾；
- 分层调度；
- 循环控制；
- Agent 选择；
- 跳过、缓存和失败预判；
- LLM 调用和回退；
- 节点成功、失败、缓存和事件写入。

`executor.ts` 从约 1500 行降到约 1200 行上下。更重要的是模块有了显式输入、副作用回调和针对性测试。

#### G5：workflowStore 门面化

executor 稳定后，开始处理 `workflowStore`：

- 图编辑；
- 连接判定；
- 子图展开；
- Agent 和 RouteTable 状态转换；
- checkpoint 持久化；
- 打开项目；
- 切换工作流；
- 新建项目。

策略仍然是：

```text
纯逻辑先抽出
Zustand 门面保留
高风险 action 暂时不动
```

#### H2：插件 Worker 沙箱

H2 的设计最初把 Web Worker 称为“进程隔离”，审查后修正为：

- Web Worker 是线程级隔离；
- 可以隔离 DOM、JS 堆和 UI 卡死；
- 不能等价于操作系统进程隔离；
- Worker 中仍然可以使用 `fetch`；
- 不能直接承诺网络隔离；
- 真正不可信插件仍需要独立进程或 sidecar。

H2 期间修复了：

- Worker 能力白名单；
- 宿主侧二次能力拦截；
- `executionId` responder 竞态；
- `nodeId` 丢失；
- 主线程提前执行插件代码；
- Worker 崩溃；
- 心跳探针；
- 超时和取消；
- `terminateAll()` 时在途 Promise 和 Timer 泄漏。

最终确定的路线是：

> 可信本地插件 + Worker 隔离 UI、DOM 和 IPC。不承诺网络隔离，也不把它作为不可信第三方插件的完整安全方案。

### 2026-08-12：H3 Orchestrator 和 H4 自举基础设施

#### H3a：确认不等于执行

H3 最初实现了：

```text
目标 → 生成草案 → 用户确认 → 执行编排
```

但第一次实现中，`confirmDraft()` 直接把状态设置成了 `running`。后来改成：

```text
awaiting-confirm
        ↓
ready
        ↓
running
        ↓
completed / failed / cancelled
```

同时约束：

- `confirmDraft()` 只能确认；
- `runOrchestration()` 才能进入 `running`；
- `discardDraft()` 不能删除正在运行的编排；
- 运行中需要走 cancel；
- 不能由 Agent 自己注入 `approved`。

#### H3b：解决“假成功”

H3b 的第一个执行器使用了类似：

```ts
const wfId = `orch-${orchId}-${stageId}`;
```

这个 ID 并没有绑定到真实工作流。结果是编排器调用不存在的工作流，`runWorkflow()` 记录错误后返回，编排器却把正常返回当成成功。

后来修复了：

- 阶段必须绑定真实工作流；
- 新工作流不能是空图；
- 空图必须失败；
- executor 返回明确运行结果；
- `runId` 由 executor 产生；
- 编排器不能从全局历史记录猜 `runId`；
- 只有 `status === success` 才能写阶段成功。

#### H3c：编排面板

H3c 加入了：

- 草案预览；
- 阶段工作流绑定；
- 只读模式；
- 预固化；
- 打开编辑；
- 显式确认；
- 执行；
- 取消；
- StageLog；
- 失败重试；
- 历史删除。

期间又发现两个 P0 问题：

1. UI 的 readonly 没有正确传入领域层；
2. 重新绑定工作流后，旧的 `stageWfIds` 没有清除，界面选择 B，实际可能继续执行 A。

这两个问题最终都补上了。

#### H4：从“Agent 能改代码”到“宿主能证明代码被正确修改”

H4 的目标是让 SlimeMold 在受控条件下参与软件开发：

```text
目标
 ↓
创建 Worktree
 ↓
读取代码
 ↓
生成受控 Patch
 ↓
运行测试
 ↓
采集 Evidence
 ↓
验收
 ↓
用户审查 Diff
 ↓
清理或保留现场
```

第一版 Foundation 包括：

- `SelfDevelopmentPolicy`；
- `code.read`；
- `code.patch`；
- `shell.run`；
- `test.run`；
- `git.status`；
- `git.diff`；
- Worktree；
- Evidence；
- 确定性验收器；
- headless 开发节点。

之后进行了多轮安全审计，重点修复路径、命令、证据和清理边界。

### 2026-08-13：H4 Phase 1 安全收口

8 月 13 日完成了 H4 Phase 1 的宿主接入：

- 受控命令通道；
- DevSession 生命周期；
- GUI 验收面板；
- Worktree 创建和清理；
- Evidence 动态路径；
- Rust 主仓库权限收紧；
- Worktree 命令参数白名单；
- 符号链接防护；
- 命令参数路径守卫；
- Worktree 创建失败显式报错。

后续还增加了 Worktree 和 Worktree2 前缀碰撞测试，并确认 Rust `Path::starts_with` 是组件级判断，而不是字符串前缀判断。

截至日志最后，H4 的 Rust 路径边界 P1 已经收口，相关 Rust 测试通过，正式 GUI 验收被认为具备开始条件。

但需要保持准确：日志显示的是“安全前置条件已经满足，可以开始正式 GUI 验收”，并没有形成完整六阶段 GUI 验收已经完成的证据。

### 2026-08-25：重新审视项目现状和产品定位

一次综合审计记录的基线包括：

- 50 个 Vitest 测试文件；
- 588 个测试通过；
- `npm run build` 通过；
- i18n 检查通过；
- headless 冒烟通过；
- Rust 测试和 `cargo check` 通过；
- Tauri 窗口实际启动；
- 没有发现白屏或 panic。

审计同时指出：

- 项目仍然更像工程预览版；
- H4 宿主边界还需要继续验证；
- 主控 Agent 还没有真正实现动态规划；
- H2 Worker 不是进程级沙箱；
- GUI 端到端验收仍然是重要准入条件。

项目定位开始从“功能很多的 Agent 平台”转向：

> 面向个人与小团队的、本地优先的、多 Agent 任务工作站。

### 2026-08-26：从 AI 公司到 AI 软件工厂，再降级为远期 Idea

最初曾经设想把系统设计成一家公司：

- 管理层；
- 生产层；
- 审计层；
- 售后层；
- 主控 Agent；
- 任务派发；
- 多模型协作；
- Issue 流转。

后来发现，这个设想其实来自自动化游戏：

- 订单；
- 生产线；
- 工位；
- 机器；
- 瓶颈；
- 产能；
- 成本；
- 质检；
- 维护。

这些想法被整理进 `README2.0.md`，形成“AI 软件工厂”的长期叙事。

但经过进一步讨论后，还是将以下方向降级为远期 Idea：

- Steam；
- Workshop；
- 工厂地图；
- 环境中心；
- KPI 连接器；
- 普通用户游戏化入口。

当前路线重新收缩为：

```text
Phase 0：产品收缩
Phase 1：单项目交付闭环
Phase 2：经验和经济性闭环
Phase 3：Issue 与维护
Phase 4：持久运行时
```

### 2026-08-27：回到个人开发和工程作品

最后一个重要前提是：这个项目不一定要成为商业产品，更重要的目标是证明工程能力，帮助求职和面试。

因此项目不需要继续追求：

- 看起来像一个大型商业平台；
- 设计成 Steam 游戏；
- 支持所有自动化场景；
- 让主控 Agent 完全自治。

更适合作为简历项目的定位是：

> 基于 Tauri、React、TypeScript 和 Rust 的本地优先多 Agent 工作流运行时，具备 DAG 调度、并发控制、失败恢复、成本感知路由、Worktree 隔离和受限代码执行能力。

这比“AI 公司”“虚拟员工”“自我进化平台”更容易被面试官验证，也更适合解释代码和测试。

## 三、技术栈整理

| 领域 | 技术 |
|---|---|
| 桌面框架 | Tauri 2、Rust |
| 前端 | React 18、TypeScript 5.6、Vite 5 |
| 工作流画布 | `@xyflow/react` / React Flow |
| 状态管理 | Zustand |
| 样式 | Tailwind CSS、`tailwind-merge` |
| 图标 | Lucide React、React Icons |
| 国际化 | i18next、react-i18next、fast-xml-parser |
| Agent 协议 | OpenAI 兼容接口、Anthropic 原生接口、Ollama |
| Agent 架构 | AgentHarness、ToolRegistry、AgentRouter、AgentEconomics |
| 工作流运行时 | Kahn 拓扑排序、Stage、Scope、loopGate、并发限流、AbortController |
| 持久化 | JSON、`.slimemold` 项目目录、localStorage、JSONL |
| 凭据 | Rust、系统密钥库、AES-GCM、Vault、`credentialKey` |
| 插件 | JS/TS 插件包、Manifest、动态加载、Web Worker PoC |
| 开发执行 | Git Worktree、受控 Patch、命令白名单、Evidence、确定性验收 |
| 测试 | Vitest、jsdom、Rust `cargo test` |
| 工程验证 | `tsc -b`、Vite build、headless runner、i18n check、`cargo check` |
| CI | GitHub Actions |

## 四、主要踩过的坑

### 1. 把“能运行”误认为“架构完成

早期功能增加很快，但许多能力只是接线完成，并没有经历真实运行、失败、恢复和 GUI 验收。

后来开始把项目状态分成：

```text
代码存在
功能接线
单元测试通过
headless 通过
真实桌面验证
正式验收完成
```

这些状态不能混为一谈。

### 2. 按文件行数进行重构

`executor.ts` 和 `workflowStore.ts` 很大，但单纯拆文件并不能自动降低复杂度。

更有效的拆分方式是：

- 先找纯函数；
- 再找独立生命周期；
- 再找不同权限和持久化策略；
- 用 `RunContext` 或显式参数传递状态；
- 每拆一块就补测试。

### 3. 前端限制不能代替宿主安全

前端可以限制按钮和参数，但 WebView 仍可能直接调用 Tauri command。

因此真正的安全边界必须在 Rust 宿主中再次执行：

- 路径规范化；
- Worktree 归属；
- 命令参数；
- 符号链接；
- 主仓库限制；
- EvidenceStore 权限。

### 4. `Path::starts_with` 不等于字符串前缀比较

审计中曾经把 Rust 的 `Path::starts_with()` 误解成字符串比较。实际上它是组件级判断，可以正确区分 `wt` 和 `wt2`。

但这种语义不能只靠口头解释，必须用回归测试固定下来。

### 5. 远端模型不能凭本地表格判断

模型名、价格表、Provider 协议和中转站返回结果不是一回事。

不能因为本地价格表没有某个模型，或者模型名看起来陌生，就直接判断远端模型不存在。更可靠的顺序是：

```text
读取当前 Provider 配置
↓
读取官方文档或真实模型列表
↓
执行 probe
↓
根据实际错误判断
```

### 6. 共享 credentialKey 会导致凭据串号

如果所有 OpenAI Agent 都默认使用同一个 `credentialKey`，不同供应商或不同 Agent 可能覆盖同一份凭据。

更合理的是：

```text
Agent → Endpoint → Credential
```

而不是：

```text
Agent → Protocol → Shared Credential
```

### 7. 把禁用项从列表中完全删除

禁用 Agent 不能简单地从所有候选池中删除。运行时应该禁止使用，但已绑定的 Agent 仍然需要显示名称和禁用状态。

### 8. Web Worker 不能称为进程隔离

Worker 可以改善 UI、DOM 和 JS 堆隔离，但不能自动提供操作系统级隔离、网络隔离和恶意插件防护。

如果未来允许不可信插件，仍然需要独立进程或 sidecar。

### 9. “确认”和“执行”必须分开

用户确认计划，只代表计划被批准，不能代表系统已经开始执行。

因此需要明确的状态机，而不是让 `confirmDraft()` 直接写入 `running`。

### 10. 不能让 Agent 自己证明成功

Agent 可以提供总结、解释和不确定性，但不能自己决定：

- 测试通过；
- Diff 合法；
- Evidence 有效；
- 用户已经确认；
- 可以清理 Worktree。

这些必须由宿主根据真实退出码、Git 状态、路径和验收记录判断。

### 11. Windows 行尾符会制造假修改

曾经出现过 Git 显示 `App.tsx` 被修改，但实际 `git diff` 为空的情况。最终确认是 LF/CRLF 或文件监控造成的状态差异。

看到 Git 的 `M` 时，不能直接等价为语义代码改动。

### 12. 不要把工具环境错误当成项目错误

开发过程中遇到过：

- `.git/index.lock` 无法创建；
- `.git/FETCH_HEAD` 无法写入；
- Windows ACL 拒绝写入 `.git`；
- 审批服务返回 403；
- `npm exec tsc` 解析到了错误的外部包；
- Tauri 端口占用；
- Rust 编译期间文件锁；
- Ollama 没启动；
- API Key 无效。

这些问题必须先分类，再判断是否属于项目代码缺陷。

## 五、这段开发经历带来的经验

### 1. 先做一条纵向闭环，再扩展生态

更稳的顺序应该是：

```text
一个真实任务
↓
一个真实 Agent
↓
一个真实工作流
↓
一个真实结果
↓
一次真实验收
↓
一次失败恢复
```

只要这条链路没有跑稳，继续增加节点和概念，往往只是在扩大问题面积。

### 2. Task 和 Run 比 Graph 更重要

Graph 很直观，也适合展示流程，但最终用户关心的是：

- 任务有没有完成；
- 花了多少钱；
- 为什么失败；
- 能不能继续；
- 改了哪些文件；
- 结果是否可信。

所以 Graph 应该服务于 Task 和 Run，而不是反过来。

### 3. 可靠性来自边界，而不是更强模型

更强的模型不能自动解决：

- 错误状态；
- 凭据串号；
- Worktree 残留；
- 证据伪造；
- 旧任务覆盖新任务；
- GUI 状态和运行状态不一致。

这些问题最终要靠状态机、运行上下文、宿主权限、真实测试、确定性验收和可回滚持久化解决。

### 4. 模型应该提出决策，系统负责提交决策

主控 Agent 可以：

- 生成计划；
- 推荐 Agent；
- 估算成本；
- 提出重试；
- 申请人工确认；
- 生成新的工作流草案。

但不能绕过权限策略、预算、状态机、用户确认和真实执行结果。

主控 Agent 最合理的定位不是“万能上帝”，而是“有全局视野的任务负责人”。

### 5. 测试必须覆盖真实边界

纯函数测试非常有价值，但不能代替：

- Tauri GUI 验收；
- 真实 Worker；
- 真实文件系统；
- 真实 Worktree；
- 真实 API 失败；
- 应用重启；
- 多工作流并发；
- 用户介入和取消。

很多 H2、H3 和 H4 的问题，都是在“代码看起来没问题”之后才被发现的。

### 6. 文档必须和代码一起维护

项目中多次出现：

- 测试数量已经变化，但文档仍写旧数字；
- H1 已经完成，文档还写“未拆分”；
- H2 已经有 UI 开关，设计稿仍写“待完成”；
- 代码已经实现 Anthropic，README 仍说不支持；
- 文档把 Worker 称为进程隔离；
- 设计目标和当前实现混在一起。

文档不是开发结束后才补的附属品，而是系统事实的一部分。

### 7. 个人项目不应该被宏大愿景绑架

“AI 公司”“AI 软件工厂”“Steam 创意工坊”都可以是长期构想，但不能让它们干扰当前版本。

对个人开发者而言，更实际的目标是：

```text
范围可控
代码可读
测试可验证
问题有复盘
边界说得清
```

这比做出一个功能列表很长、但无法解释真实完成度的项目更有价值。

## 六、截至 2026-08-27 的项目状态

### 已经具备

- React + Tauri 桌面应用；
- React Flow 节点式工作流；
- DAG 调度和 Stage 分层；
- 并发控制；
- 循环、分支和缓存；
- AgentHarness；
- 多 Provider；
- AgentRouter；
- 成本统计；
- fallback；
- checkpoint；
- 运行事件；
- Experience Store；
- H1 executor 拆分；
- G5 workflowStore 门面化；
- H2 Worker 沙箱 PoC；
- H3 Orchestrator 草案和阶段执行；
- H4 Worktree、受控 Patch、Evidence 和验收基础；
- headless 自举样例；
- Rust 侧路径和命令安全守卫。

### 仍然不能夸大的部分

- 主控 Agent 还不是完整的动态自主规划系统；
- H3 的草案生成仍然偏模板化；
- H2 是 Worker 线程隔离，不是完整进程隔离；
- H2 默认不提供网络隔离；
- H4 headless 闭环已经基本具备，但正式 GUI 六阶段验收不能仅凭代码测试宣布完成；
- 自我学习目前主要是经验记录和提示词注入，还不是完整的自动改图系统；
- 跨 macOS/Linux 的实机构建和完整 CI 证据仍然不足；
- Steam、Workshop、AI 软件工厂等属于远期构想，不应当被当成当前版本能力。

## 七、2026-08-31：从“运行工作流”转向“用主控完成项目”

这次方向调整来自一个非常具体的产品问题：当前 SlimeMold 已经能够运行预先配置好的工作流，但用户仍然无法只通过一句简单的自然语言，稳定地建立并推进一个完整的软件项目。

这说明产品缺少的不是更多节点，而是一个把模糊目标逐步编译成项目计划的控制面：

```text
用户目标
→ 需求澄清
→ 产品与架构决策
→ Issue 与任务拆分
→ Pipeline / Workflow DAG
→ 隔离生产
→ 测试、证据与验收
→ 交付、维护和下一轮 Issue
```

### 7.1 对当前实现的复核

现有 `BeginnerExperience` 已经提供初级首页和项目驾驶舱，可以打开项目、显示项目状态、调用 `runWorkflow` 并查看运行结果。但它的主路径仍然是“新建/打开项目 → 运行已有工作流”，没有项目级主控会话、需求问询、Decision 或 Issue 管理。

现有 `OrchestratorPanel` 已经实现了 H3c 的最小闭环：目标输入、模板化草案、阶段工作流绑定、确认和执行。它是面向进阶用户的编排控制面，不是普通用户可以自然使用的长期项目会话。`docs/H3_ORCHESTRATOR_DESIGN.md` 也明确把自由生成 DAG 的 H3d 延后了。

当前 `ProjectFile` 已经持久化工作流、Pipeline、Artifact、运行历史和检查点，但还没有正式的项目级 `ProjectSession`、`Decision`、`Issue` 和 `Task` 实体。因此，现阶段无法只靠新增一个聊天组件解决入口问题。

### 7.2 形成的产品决策

本次决定增加一个项目级主控 Agent 与会话窗口，但主控不会被设计成只输出自然语言的聊天机器人：

- 会话负责收集目标、约束、非目标、环境、预算和验收标准；
- 主控负责维护当前理解、假设、未决问题和用户决策；
- 管理层输出 Product Brief、PRD、Architecture、Task Graph、Risk Register 和 Cost Budget；
- 施工层负责把已经批准的任务落实为隔离生产、测试和证据；
- 用户在目标、架构、计划、执行、合并/发布和持续运维处保留确认权；
- 主控不能静默修改工作流、架构或代码，也不能把自报完成当成客观证据。

更准确的产品承诺是“用一句话启动一个项目”，而不是“用一句话立即生成任意复杂且无需确认的软件”。当信息不足时，主控应展示假设并继续问询，或者让用户选择按当前假设生成草案。

### 7.3 三种页面不再作为独立产品

原先的初级工作台、Issue 工作台和 DAG 工作台被重新定义为同一项目状态的三种投影：

```text
简易工作台：我想做什么？现在需要我决定什么？
        ↓
Issue 工作台：项目要解决哪些变化？哪些任务进入队列？
        ↓
DAG 工作台：这些任务具体如何执行、测试和产生证据？
        ↓
运行结果、Bug、风险和运维事件回到 Issue 与主控会话
```

会话消息不再被视为项目事实的唯一来源。用户批准的内容要提炼为 `Decision`，Brief、架构和任务要保存为版本化 `Artifact`，Issue、Task、Stage、Workflow、Run 和 Evidence 之间通过稳定 ID、来源版本和影响范围关联。

### 7.4 首页与 Issue 工作台的变化

没有当前项目时，首页不再把右上角的高级工作台作为明显入口，主动作应是“开始项目会话”。当项目已经恢复或打开时，首页显示当前项目、主控下一步、未决问题、最近 Issue、交付物和运行状态；此时进入专业工作台必须携带当前项目上下文。

Issue 工作台采用四个面板：

1. 收件箱 / 未规划：未认领想法、Bug、风险和问题，不自动执行；
2. 待做：已经批准并进入队列的任务；
3. 在做：施工、验证、阻塞和等待人工确认的任务；
4. 已交付 / 运维中：一次性交付结果和已批准进入持续运行的项目。

未认领 Issue 使用 `projectId: null` 表示，标签只用于分类和筛选。主控可以提出归属旧项目或建立新项目的建议，但必须经用户批准。

### 7.5 多 Agent 组织的边界

管理部门、施工部门和运维部门保留为运行时职责、权限和上下文隔离策略，而不是每个任务都启动一套常驻虚拟公司。引入多个 Agent 的理由应当是可测的成本、质量、上下文或审查收益。

施工经理的权限也必须受限：路径和影响域冲突先由确定性规则检测；非重叠 diff 可以自动合并；接口、数据模型、安全边界、受保护路径和架构冲突必须升级到管理层或用户。独立验证 Agent 只能提供评估，最终验收仍依赖宿主真实测试、diff、策略和 Evidence。

持续运维不能简单等同于“让一个 Agent 一直循环”。它需要持久队列、调度、崩溃恢复、幂等、锁、预算、通知、权限和回滚。在这些能力完成前，运维模式先以生成 Issue、只读诊断和用户批准后的增量任务为主。

### 7.6 这次转变的状态边界

本次方向已经从纯设计推进到一个可测试的最小运行时切片，但仍不能把它描述成完整自治系统：

**本轮已实现并有自动化验证：**

- `ProjectSession`、`Decision`、`ProjectBrief`、`ProjectArchitecture`、`ProjectTaskGraph` 和 `ProjectIssue` 的最小类型与状态机；
- 项目控制面快照的保存/打开、损坏数据降级和项目关闭清理；
- 主控 Agent 的严格 `question` / `brief` / `architecture` JSON 协议与最多三问限制；
- 简易工作台的一句话目标输入、主控会话、Brief/架构/任务图确认门；
- 从已批准任务图自动生成施工/验收 Workflow 和 Orchestration 草案；
- 当前项目与未认领 Issue 的四栏看板、Issue 创建、显式批准和排队动作。

**仍未实现或验证不完整：**

- Decision 从自然语言中的自动提炼、修改和 supersede UI；
- 真实模型下的连续多轮需求澄清和项目类型模板；
- Issue 的主控 triage、项目归属建议、新项目提案和 Issue → Task 正式关联；
- Issue、Task、Stage、Workflow、Run 的双向映射和漂移检测；
- H3 `orch.*` 事件、阶段 checkpoint 和跨重启的完整编排恢复；
- H4 所有 Windows/Tauri GUI 场景的人工验收与长期证据恢复；
- 初级用户从批准计划直接进入受控施工并完成真实交付的端到端流程。

**明确仍属后续阶段：**

- 无人值守的长期运维运行时；
- 自动发布、自动 push 和无限重试；
- 完整云端团队协作和不可信 Agent 的进程级隔离。

### 7.7 下一步顺序

后续不先扩展更多 Agent 节点，而按以下顺序实现：

1. 用真实可用的 Provider 在 Tauri GUI 中验收一句话 → 问询 → Brief → 架构 → 任务图流程；
2. 完成 Decision/Issue 的主控提炼、项目归类建议和用户批准；
3. 把已生成的 Orchestration 草案与 H3 事件、阶段 checkpoint、恢复和失败回流接通；
4. 完成 Task Graph / Pipeline / Workflow DAG 的版本映射和漂移检测；
5. 完成 Construction Manager 的冲突分级、H4 Evidence 和人工接管；
6. 具备持久队列、预算、锁、通知和回滚后，再开放持续运维。

这次方向调整的核心不是给 SlimeMold 增加一个聊天入口，而是确立一个控制面：让会话负责理解意图，让结构化项目资产保存事实，让 Issue 管理变化，让 DAG 执行已批准的计划。

### 7.8 本轮实现验证

本轮新增的控制面和 UI 改动已完成以下真实命令验证：

- `npm run test`：66 个测试文件、646 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 881 个 key 对齐；
- `git diff --check`：无空白错误。

构建仍有既有的动态/静态 import 和大 chunk warning，但没有新增构建失败。测试使用 fake chat 验证协议和状态迁移；真实 Provider 返回质量、真实 Tauri GUI 交互和持续运维仍未由本轮自动化证明。

### 7.9 主控 Agent 选择与快照字段的收尾修复

`masterAgentId` 字段加入控制面快照后，`npm run build` 暴露了两处未使用变量，`npm run test` 暴露了三处快照期望未同步。本轮修复：

- `MasterAgentPage.tsx`：删除未使用的 `Globe2` 导入和 `setProjectControl` hook 选择器（保存动作实际通过 `useWorkflowStore.getState()` 调用，组件内绑定是多余的）；
- `workflowState.test.ts`：在「恢复项目级 orchestrations」「新建项目空快照」「损坏快照降级」三处期望中补齐 `masterAgentId: null`，与 `createEmptyProjectControlSnapshot` / `parseProjectControlSnapshot` 的实际输出保持一致。

验证结果：

- `npm run test`：67 个测试文件、648 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 907 个 key 对齐；
- `git diff --check`：无空白错误。

构建仍只有 7.8 节记录过的既有动态/静态 import 和大 chunk warning，无新增失败。

### 7.10 全局主控设置与项目覆盖边界修正

本轮 GUI 验收发现，原来的主控选择页把两个不同作用域混在了一起：`globalAgents` 是应用级、跨项目复用的 Agent 配置，但 `masterAgentId` 实际保存在项目控制面快照中，是当前项目的主控绑定。与此同时，设置页把随项目保存的 `defaultAgentId` 称为“全局默认”，也会误导用户。

本轮将作用域明确为两层：

- `viewStore.globalMasterAgentId`：新增真正的应用级全局默认主控，持久化在桌面端的应用设置中；
- `projectControl.masterAgentId`：继续保留为项目级覆盖；为空时项目跟随全局主控，再回退到项目默认 Agent；
- `设置 → 智能体`：增加全局默认主控选择器，只允许选择已提升到全局池且启用的 Agent；
- 主控运行时解析顺序统一为：项目覆盖 → 全局主控 → 项目默认 → 第一个可用 Agent；
- 删除全局 Agent 时自动清除指向它的全局主控设置；
- 将“全局默认模型 / 智能体”更正为“项目默认模型 / 智能体”，避免把项目配置误称为全局配置；
- 中英文界面和主控/会话测试同步覆盖继承与覆盖行为。

订阅接入边界也得到确认：当前 `AgentConfig.subscription` 只是成本计算标记，不是订阅登录实现；当前 provider 仅支持 OpenAI 兼容 API、Anthropic API Key 和 Ollama。ChatGPT/Claude 的网页或桌面订阅不能直接当作通用 API Key 使用，后续若接入 Codex/Claude Code 等官方订阅，应使用厂商允许的官方登录/客户端协议，不读取网页 Cookie、不复制内部 token，并将刷新凭据交给宿主加密存储。

验证结果：

- `npm run test`：67 个测试文件、649 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 918 个 key 对齐；
- `git diff --check`：无空白错误。

本机检测到 `codex` CLI，可作为后续研究 OpenAI 官方订阅接入的客户端基础；但 SlimeMold 当前尚未把 Codex 订阅认证或 CLI 结构化调用封装成 provider。

### 7.11 接入 ChatGPT 计划版 Codex provider

用户确认目标是使用 ChatGPT 计划里的 Codex，而不是单独开通 OpenAI API 计费。本轮基于本机已安装的官方 `codex-cli 0.149.0` 完成第一版桌面接入：

- 新增 `codex` 协议和官方 Codex Agent 预设；
- Tauri 新增 `codex_login_status`、`codex_login`、`codex_logout` 和 `codex_exec` 命令；
- 登录由官方 `codex login` 浏览器流程负责，SlimeMold 不读取 `~/.codex/auth.json`，不把 OAuth token 返回 WebView；
- 执行使用 `codex exec --json --ephemeral --sandbox read-only --skip-git-repo-check --ignore-user-config --ignore-rules --output-last-message`，在临时目录运行，避免主控请求改动项目文件；
- Tauri 侧会清除继承的 `CODEX_API_KEY`、`CODEX_ACCESS_TOKEN` 和 `OPENAI_API_KEY`，并强制要求 `codex login status` 的认证模式为 `chatgpt`，避免误走 API Key 计费；
- Agent 设置中显示 Codex 登录状态，支持启动官方登录、刷新状态和退出登录；Codex Agent 的 Base URL 不再显示为可编辑 HTTP 地址，模型留空时使用 Codex CLI 默认模型；
- 暂不桥接 SlimeMold 自己的 tool-call 规格，Codex provider 适合主控等纯文本结构化协议；带工具的节点继续使用 API provider；
- 当前以单次最终响应回传，尚未实现 Codex JSONL 的增量 token 转发和运行中途进程取消，后续再补可恢复进程控制。

实现过程中发现当前版本的 `codex exec` 不接受全局帮助中显示的 `--ask-for-approval` 参数，已根据实际子命令帮助移除，保留 `read-only` 沙箱作为权限边界。

真实 smoke test：清除 API Key 环境变量后，用 ChatGPT 登录态执行固定提示，官方 CLI 返回 `CODEX_SMOKE_OK`，退出码为 0。

最终验证结果：

- `npm run test`：67 个测试文件、650 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 935 个 key 对齐；
- `cargo test -- --test-threads=1`：17 个 Rust 测试通过；
- `rustfmt --edition 2021 --check src/codex.rs`：通过；
- `git diff --check`：无空白错误。

### 7.12 Phase 0b 事件流、迁移基线与副作用恢复边界

本轮沿实验分支继续推进大重构，但没有改写 `workflowStore` 或旧执行器。新增的 Phase 0b 基础设施把事件事实、投影恢复、旧控制面迁移和副作用恢复放到可独立测试的边界中：

- `src/domain/eventStore.ts`：实现 JSONL 事件解析、sequence/aggregateVersion 校验、eventId 幂等、事件 checksum、尾部损坏隔离、snapshot hash 校验、replay，以及整批原子 append；
- `NodeFileEventStoreAdapter`：使用临时文件 + rename 原子替换和独占创建锁，锁超时 fail-closed 并保留陈旧锁现场；
- `src/domain/tauriEventStore.ts`：将项目目录授权、原子文件写入和 Tauri 宿主锁接到统一适配器接口；
- `src-tauri/src/event_store.rs`：新增 Rust 宿主级跨进程事件锁命令，带路径校验、token 校验、sync_all 和显式释放；
- `src/domain/migration.ts`：将旧 `projectControl` 快照转换为带 `synthetic` / `source` 标记的 legacy baseline 事件；旧的 approved 状态只作为导入元数据，不伪造新的用户批准历史，决策原值只保存 hash；
- `src/domain/sideEffects.ts`：增加持久副作用账本、idempotency key 冲突保护、receipt 收口和进程重启后的 `unknown/needs-user` 恢复；
- `src/domain/contracts.ts`：补齐事件来源、敏感级别和 synthetic baseline 元数据字段。

本轮使用严格 TDD 先验证 RED，再实现 GREEN，并覆盖了真实临时文件系统和 Rust 锁测试。验证结果：

- `npm run test`：72 个测试文件、673 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 935 个 key 对齐；
- `cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1`：19 个 Rust 测试通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `rustfmt --edition 2021 --check src-tauri/src/event_store.rs`：通过；
- `git diff --check`：无空白错误。

构建仍有既有的动态/静态 import 和大 chunk warning，无新增构建失败。本轮只建立了 canonical event/storage/migration/recovery 边界，尚未把旧控制面读写、项目驾驶舱或真实 Worker 执行切换到事件流。

### 7.13 Phase 1a 项目入口与执行草案确认门

本轮开始把 Phase 0b 的事件基础设施接入真实项目驾驶舱路径，而不是继续只维护独立领域模块：

- `src/projectControl/commands.ts`：新增项目会话启动、主控回合、Brief/架构/任务图审批、任务图生成和 orchestration 关联 Command；Command 同时返回更新后的 `ProjectControlSnapshot` 与 `DomainEvent[]`；
- `src/projectControl/eventBuffer.ts`：增加按项目隔离的 pending event buffer。事件写入按 eventId 幂等，flush 到已有事件流时重新计算 sequence/aggregateVersion；目标流需要修复或发生并发冲突时保留 pending，不静默丢弃；
- `src/App.tsx`：入口“开始项目”改为调用 `startProjectSessionCommand`，同时记录 Project → Session → Issue 初始事实；
- `src/components/ProjectSessionPanel.tsx`：主控回合、Brief/架构/任务图审批、执行草案生成和会话关联均接入 Command/event buffer；简单工作台新增 `awaiting-confirm → ready` 的“确认执行计划”门，但本轮没有启动 Run，也没有伪造 `RunCreated`；
- `src/store/workflowStore.ts`：Tauri `saveProject` / `saveProjectAs` 在项目文件成功写入后 flush pending domain events；关闭或切换项目时清理对应未提交 buffer；浏览器模式不假装具备磁盘事件持久化；
- 中英文 beginner locale 补齐执行草案审查和确认文案。

本轮继续采用先 RED 后 GREEN 的测试方式，并验证了事件 buffer 在已有持久事件流上的重定位行为。验证结果：

- `npm run test`：74 个测试文件、688 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 938 个 key 对齐；
- `cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1`：19 个 Rust 测试通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `git diff --check`：无空白错误。

构建仍有已有的动态/静态 import 和大 chunk warning。本轮完成的是项目入口到执行草案确认门的第一段真实接线；事件流还没有全面替换旧 `workflowStore`/executor，确认后自动 Worker、独立 worktree、Evidence 和失败恢复仍待下一阶段接入。

### 7.14 Phase 1b Worker 队列、独立 worktree 与 Codex 写入边界

本轮继续把执行层从旧 executor 外围接起来，先完成一个可恢复、可注入、可审计的 Worker tracer bullet：

- `src/domain/workerQueue.ts`：新增 `WorkerTaskQueue`。只允许已批准且非空、无循环依赖的任务图进入队列；无依赖任务并发 claim，依赖任务等待前置成功；独立任务失败不会阻塞其它分支，依赖失败会归约为 `blocked`；队列状态可 snapshot/restore，事件产生 `RunCreated`、`TaskQueued`、`TaskStarted`、`TaskSucceeded/Failed/Blocked` 及运行终态事实；
- `src/dev/workerAllocator.ts`：把现有 `WorktreeManager` 适配为 Worker lease allocator。每次 claim 生成独立 worktree id/branch，路径由宿主显式提供；创建失败不回退主仓库；
- `src/dev/codexWorkerExecutor.ts`：新增 Codex Worker executor。模型输出不能自报成功，必须经过宿主 acceptance，并且必须返回 Evidence ID 才能进入 succeeded；
- `src/agents/providers/codex.ts` / `src-tauri/src/codex.rs`：增加 `codex_worker_exec`。它与只读 master provider 分离，只能在 Rust 登记的 worktree 执行，使用 CLI 的 `--approve-for-me` workspace-write 模式，继续拒绝 API key 环境变量和主仓库 cwd；
- `src-tauri/src/lib.rs`：增加 canonical worktree 守卫及 command 注册；`replayDomainEvents` 增加 `TaskQueued` 归约，保证队列初始状态可重放。

本轮验证包含一次真实 CLI workspace-write smoke。第一次调用未显式传入 `-C`，失败后确认没有把失败记为成功，并清理了误写入的临时标记文件；第二次显式传入隔离临时目录、清除 API key 环境变量后返回 `CODEX_WORKER_SMOKE_OK`，临时目录随后自动清理。

验证结果：

- `npm run test`：78 个测试文件、703 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 938 个 key 对齐；
- `cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1`：21 个 Rust 测试通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `rustfmt --edition 2021 --check src-tauri/src/codex.rs`：通过；
- `git diff --check`：无空白错误。

构建仍有已有的动态/静态 import 和大 chunk warning。当前队列、worktree allocator 和 Codex Worker executor 已可独立测试，但尚未把它们绑定到“确认计划”按钮后的持久 Run registry，也尚未接入真实 acceptance 命令采集、Evidence 落盘和失败恢复 UI。

### 7.15 确认计划后的 queued Run registry 持久化

本轮把上一轮的 Worker queue 从独立能力进一步接到项目状态：

- 新增 `src/projectControl/workerRun.ts` 的 `enqueueWorkerRunCommand`，确认执行计划时创建带 `projectId`、`orchestrationId`、`taskGraphId` 和版本绑定的 queued Run；相同 Run 重试幂等，绑定冲突拒绝；
- `ProjectFile`、`workflowStore` 和 `workflowState` 增加 `workerRuns` registry。确认按钮现在同时完成 orchestration `ready`、Worker Run 入队、`RunCreated/TaskQueued` 事实写入和项目状态更新；
- 项目序列化、dirty 快照、打开/新建/关闭生命周期均覆盖 `workerRuns`；损坏的非数组数据打开时 fail-closed 为空 registry；
- 简单工作台在确认后显示“Worker 已入队，等待执行”，不把 queued 状态伪装成 running，也不自动调用旧 executor；
- 中英文 beginner locale 增加 queued Run 状态提示。

本轮补充了 Command 幂等、项目保存/重开恢复、损坏 registry、确认后入队和用户可见状态测试。验证结果：

- `npm run test`：79 个测试文件、710 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 940 个 key 对齐；
- `cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1`：21 个 Rust 测试通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `git diff --check`：无空白错误。

构建仍有已有的动态/静态 import 和大 chunk warning。当前 queued Run 已进入项目持久状态，但尚未在打开项目后自动恢复成可执行队列对象，也尚未把宿主 acceptance 命令、Evidence 落盘、执行进程崩溃恢复和失败恢复 UI 接到 Run registry。

### 7.16 Phase 1b runtime 恢复、宿主验收与自动 Worker 接线

本轮把上一轮持久化的 queued Run 接成可恢复、可执行但不盲目重跑副作用的 runtime，并将真实宿主验收接到简单工作台：

- `src/projectControl/workerRunRuntime.ts`：项目打开时按 `projectId`、`taskGraphId` 和 `taskGraphVersion` 重建 `WorkerTaskQueue`；缺失任务图、版本漂移、重复 Run、状态损坏和重启后残留 running lease 均进入 recovery-required，不静默恢复，也不自动重放可能已经发生的副作用；派生 recovery record 写入运行态 store，驾驶舱不会把残留 lease 误报为正常施工；
- `src/domain/workerQueue.ts` / `src/projectControl/workerRunRuntime.ts`：增加每个执行 batch 的 `{state, events}` 持久化回调和同一 Run 的并发启动保护；claim 后先持久化 running lease，成功后才调用 Worker executor，完成后再持久化 succeeded/failed/blocked；queue 原有无回调 API 保持事件不被意外清空，连无 runnable 的 blocked 归约 event 也会 flush；lease 同时携带 `orchestrationId`，使 Evidence 能绑定到项目执行上下文；
- `src/projectControl/workerRunCoordinator.ts`：新增项目级 coordinator，将 runtime queue、allocator、executor 和“状态+事件同批持久化”回调连接起来；GUI factory 使用项目根同级的 `<project>-workers` 路径，禁止把 Worker worktree 放回主仓库；
- `src/dev/workerAcceptance.ts`：新增宿主确定性验收。Worker 返回后由宿主在对应 worktree 运行 `npm run test`，采集真实变更、diff 和 allowed/protected path 结果，三条 Evidence 逐条等待落盘并 flush 后才交给 evaluator；模型最终文本不参与成功判定；
- `src/App.tsx` / `src/components/BeginnerExperience.tsx` / `src/components/ProjectSessionPanel.tsx`：确认计划后先保存 queued Run，再在 Tauri 项目中确保 DevSession，调用独立 worktree → Codex workspace-write → host acceptance 链路；每个 transition 持久化最新 `workerRuns` 和 DomainEvent。浏览器环境或未保存项目不会假装启动可写 Worker；
- simple workspace 的下一步卡片现在直接显示 queued/running/succeeded/partial/blocked/failed/cancelled 的真实状态，并把失败/阻塞引导到专业编排入口；中英文 locale 保持一致。

本轮继续采用先 RED 后 GREEN 的测试方式，覆盖 runtime 恢复、版本漂移/lease fail-closed、真实 acceptance 规则、并发启动保护、coordinator transition 以及驾驶舱状态显示。验证结果：

- `npm run test`：82 个测试文件、724 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 956 个 key 对齐；
- `git diff --check`：通过。

构建仍有既有的动态/静态 import 和大 chunk warning，无新增构建失败。本轮完成了“项目重开 → 可执行 queue → 宿主验收 → 状态/事件持久化”的代码闭环；进程在 Codex 执行中途退出时仍需下一轮结合 side-effect receipt 做可恢复 lease 核对，失败/blocked 的可操作恢复动作也仍待补齐。

### 7.17 Worker side-effect receipt 与重启恢复决策门

本轮继续收紧“running lease 可能已经产生副作用”的恢复语义：

- `src/domain/contracts.ts` / `src/domain/sideEffects.ts`：副作用记录可选绑定 `runId`、`taskId`，旧账本仍兼容；绑定不同执行上下文的同一 idempotency key 会冲突；
- `src/projectControl/workerSideEffects.ts`：新增 Worker execution recorder。每次 lease 先写 `planned → started`，executor 返回后由宿主写 receipt；executor 异常时尝试写 `unknown/needs-user`；项目重开可把同一 Run 的残留 started 记录安全归约为 unknown；
- recovery 决策只允许显式 `inspect`、`retry`、`skip`。`retry` 只返回新 attempt 所需状态，保留旧 attempt 和 effect key，不复用可能已经发生的副作用；`skip` 将任务收口为 failed 并让依赖任务进入 blocked；`inspect` 不改状态；
- `src/projectControl/workerRecoveryCommand.ts` / `src/domain/contracts.ts`：将 recovery 决策写成 `WorkerRunRecoveryDecided`、`RunQueued`、`TaskFailed`、`TaskBlocked` 等 DomainEvents，并补齐 `RunQueued` replay；retry 事件只改变可恢复状态，不直接执行；
- `src/domain/workerQueue.ts`：把 side-effect recorder 接在 running lease barrier 与 executor 之间；receipt 完成后才标记任务 succeeded；无 runnable task 时产生的 blocked event 也会 flush；
- `src/App.tsx`：Tauri 项目执行使用 worktree 外部的项目级 side-effect journal；项目重开后自动读取并归约残留 started 记录，但不会自动 retry/skip；用户确认 retry 后才安装新 queue 并启动新 attempt，skip 不启动；
- `ProjectSessionPanel`：简单驾驶舱将 recovery-required 与普通 running 区分，展示检查、创建新 attempt、跳过三种路径，并提供明确的 retry/skip 决策回调；

验证结果：

- `npm run test`：84 个测试文件、733 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 962 个 key 对齐；
- `git diff --check`：通过。

构建仍有既有的动态/静态 import 和大 chunk warning，无新增构建失败。当前恢复决策模型已经能安全地产生新 attempt 状态，但专业视图中的实际 inspect/retry/skip 操作、receipt 结果与 worktree 清理审批的完整 UI 事务仍待接入。

### 7.18 专业编排视图接入 Worker Run recovery 投影

- 新增 `src/projectControl/workerRunView.ts` 与测试：按 `orchestrationId` 从同一 `workerRuns` registry 生成只读 view model，保留 Run/Task 状态、attempt、失败原因、blocked 影响、worktree 路径、Evidence ID 和 recovery record，不复制状态。
- `OrchestratorPanel` 展示 queued/running/succeeded/partial/blocked/failed/cancelled 的真实 Worker 状态，并在 Task 级别列出错误、worktree 与 Evidence。
- `SidePanel` → `OrchestratorPanel` → App 复用同一个 `recoverWorkerRun` handler；专业视图的 retry/skip 与简单项目驾驶舱一致，retry 明确创建新 attempt，不复用旧副作用 key，skip 只收口失败及依赖阻塞。
- 专业视图没有接入旧 `runOrchestration` 作为第二执行路径；旧编排按钮和新 Worker registry 仍保持边界。
- 验证：`npm run test` 通过，85 个测试文件、735 个测试通过；`npm run build` 通过；`npm run i18n:check` 通过，中英文 981 个 key 对齐；`git diff --check` 通过。build 仍只有既有动态/静态 import 与大 chunk warning。

### 7.19 Evidence/receipt projection 与 worktree cleanup proposal

- 新增 `src/projectControl/workerEvidence.ts`：从宿主 Evidence JSONL 与 side-effect journal 加载运行态事实；Evidence 只接受 `capturedBy: 'host'`，损坏 journal fail-closed，两个 projection 均按稳定 ID 去重。
- `workerRunView.ts` 现在按 Run/Task 关联测试、diff、path-policy Evidence 详情，以及 `started/receipt/unknown` side-effect receipt 摘要；UI 不展示原始 stdout/stderr、target 或 input 指纹。
- `WorkerQueueTask`/`TaskSucceeded` event 保留 `acceptanceId` 与 Evidence IDs；cleanup proposal 绑定 `runId/taskId/orchestrationId/stageId/baseRevision/stateSignature/acceptanceId`，只有 succeeded + host acceptance passed 才能进入 ready。
- 新增 `workerCleanup.ts` 的显式 `approveWorkerCleanupProposal` 与二次 `cleanupApprovedWorker` 边界；项目运行结束后仅生成 proposal，专业视图显示 ready/blocked，绝不自动删除或强制清理 worktree。
- 验证：`npm run test` 通过，87 个测试文件、741 个测试通过；`npm run build` 通过；`npm run i18n:check` 通过，中英文 986 个 key 对齐；`git diff --check` 通过。build 仍只有既有动态/静态 import 与大 chunk warning。

### 7.20 重启后 worktree live restore 与 cleanup 安全前置检查

- `WorkerQueueTask` 持久化 worktree branch；`TaskStarted` event 同步记录 branch，避免重启后只凭路径猜测分支。
- `WorktreeManager.restore` 查询宿主 `git worktree list --porcelain`，只恢复 live path + branch 匹配的登记；主仓库、缺失 worktree、ID/path 冲突和旧缺 branch 元数据均拒绝恢复。
- App 项目切换/启动后恢复 WorktreeManager 登记；cleanup proposal 生成前额外检查 worktree 仍被当前宿主登记，未登记时显示 blocked，不计算签名也不批准删除。
- 验证：`npm run test` 通过，87 个测试文件、744 个测试通过；`npm run build` 通过；`npm run i18n:check` 通过，中英文 986 个 key 对齐；`git diff --check` 通过。build 仍只有既有动态/静态 import 与大 chunk warning。
- 尚未自动执行 cleanup：显式 proposal/approve/二次签名 API 已存在，下一轮仍需把批准、实际清理、cleaned 状态和 cleanup receipt 接入宿主事务与 UI。

### 7.21 Worktree cleanup 批准、receipt 与 cleaned 状态闭环

- `WorktreeManager.restore` 从宿主 `git worktree list --porcelain` 恢复 live worktree；`WorkerQueueTask` 保留 branch/baseRevision，已清理任务在重启时跳过 restore。
- `workerCleanup.ts` 生成绑定 acceptance/signature 的 ready proposal；专业编排区提供两步操作：先显式批准，再执行清理。未批准、漂移、缺 acceptance、缺 live registration 或失败任务均不允许删除。
- `workerCleanupExecution.ts` 为 cleanup 写 `started → receipt/unknown` side-effect journal；重复 receipt 幂等返回，unknown 不自动重试。
- `workerCleanupCommand.ts` 将成功清理写入 `cleanupStatus:'cleaned'`、`cleanupReceiptId` 和 `TaskCleaned` DomainEvent；replay/ProjectFile serializer 保留 receipt 绑定。
- 验证：`npm run test` 通过，89 个测试文件、750 个测试通过；`npm run build` 通过；`npm run i18n:check` 通过，中英文 990 个 key 对齐；`git diff --check` 通过。build 仍只有既有动态/静态 import 与大 chunk warning。

### 7.22 Worker 事实源审计与旧 executor 接管边界

- 新增 `src/projectControl/workerRunConsistency.ts`：将 ProjectFile 中的 `workerRuns` 与 durable event stream replay 结果逐 Run/Task 比较，覆盖状态、所属 Run、Evidence ID、acceptance ID、cleanup 状态和 cleanup receipt；事件流缺失、损坏、跨项目混入或存在孤立事实时返回明确问题，不静默选择某一侧。
- 新增 `src/projectControl/eventSourceBootstrap.ts`：已有项目首次打开且事件流为空时，通过既有 migration contract 写入一次 synthetic control baseline，并生成 projection snapshot；非空流不重复迁移，损坏流直接保持 `needs-repair`。
- `src/projectControl/workerRunRuntime.ts`：重开项目时，审计不通过的 Run 不再安装 executable queue，转为 `event-stream-invalid` 或 `event-stream-drift` recovery；已有 recovery UI 因此能显示并阻止继续施工。
- `src/projectControl/workerRunCoordinator.ts`：增加执行前 `assertConsistency` 门，审计失败时在 worktree 分配和 Codex executor 之前 fail-closed；GUI coordinator 保证转发该门。
- `src/App.tsx`：项目启动/切换时读取 `.slimemold/events/events.jsonl` 并安装带审计结果的 runtime；真实 Worker 启动前再次审计，防止项目状态在异步期间发生事实源漂移。
- `src/projectControl/eventBuffer.ts`：pending facts flush 后写入可校验 projection snapshot；重复 flush/首次 snapshot 写入失败后重试时，会先重放已落盘事件修复 snapshot，再清除 pending，避免只清 pending 不留 checkpoint。
- `src/components/ProjectSessionPanel.tsx`：主控回合、Brief、Architecture、TaskGraph、Orchestration 和执行计划确认统一经过持久化 helper；已保存项目在结构化事实更新后立即保存，避免 pending event 只存在内存中。
- `src/components/OrchestratorPanel.tsx` / `src/orchestrator/run.ts`：同一 orchestration 一旦存在 linked Worker Run，旧 executor 的按钮、panel callback 和底层 API 均被阻断，避免旧 executor 与 Worker Run 并行启动。

本轮继续采用先 RED 后 GREEN 的测试方式，覆盖一致状态、状态漂移、缺少 Run 事实、非法事件流、runtime fail-closed 和 coordinator 执行前阻断。验证结果：

- `npm run test`：92 个测试文件、764 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过。

构建仍有既有的动态/静态 import 和大 chunk warning，无新增构建失败。本轮还实际启动了当前工作树的 Tauri dev（Vite ready、Rust 编译完成、`slime-mold.exe` 启动），但 Windows 窗口枚举未暴露该窗口，因此没有把 UI 点击链路冒充为已验证。旧 `workflowStore`/executor 的完整双写迁移、事件重放重建完整 ProjectControl snapshot，以及真实 Tauri UI 端到端执行仍待后续阶段。

### 7.23 ProjectControl 结构事实审计

- 新增 `src/projectControl/projectControlConsistency.ts`：对 Project/Session/Brief/Architecture/TaskGraph/Issue/Decision 的 durable facts 与 ProjectFile 结构投影做 ID、project scope、版本、审批、状态和关联关系校验；事件 payload 只有摘要时只做可验证字段比较，不伪造完整私有对象重建。
- `src/App.tsx`：项目启动/切换时同时执行 Worker Run 与 ProjectControl 审计；已有 Worker Run 且控制面事实漂移时，统一转为 `control-state-drift` recovery，执行前二次审计也会阻断 worktree/Codex。
- normal Command facts 与 synthetic legacy baseline 均有测试覆盖；孤立控制面事件、缺失实体事实、状态漂移和非法 sequence 均 fail-closed。

验证结果：

- `npm run test`：93 个测试文件、768 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过。

构建仍有既有的动态/静态 import 和大 chunk warning，无新增构建失败。当前控制面已经具备“事件源 + ProjectFile snapshot + 启动/执行前审计”的可验证边界，但完整 ProjectControl 从事件独立重建仍不实现，因为当前事件契约只保存摘要；真实 Tauri UI 端到端 Worker 链路仍待窗口可见性与宿主 smoke 条件满足后验证。

### 7.24 Tauri 可见窗口启动 smoke

- 重新启动当前 `research/experimental-refactor` 工作树的 `npm run tauri dev`，Vite 在 `http://localhost:1420/` 就绪，Rust dev profile 编译完成，Windows 原生窗口成功枚举为 `SlimeMold · Agent 工作流`。
- 只读捕获确认项目驾驶舱正常渲染：项目状态、工作流/运行统计、交付物入口和高级工作台入口均可见；本次没有点击执行、保存或 cleanup。
- 启动后的只读文件核对确认上次项目 event stream 有 1 条 synthetic baseline，projection snapshot 已生成；其目录不是 Git worktree，因此没有代码工作树可被误报为修改。
- smoke 结束后已终止本轮启动的 Tauri/Vite 子进程，未留下运行服务。

本轮没有新增代码改动；代码验证沿用 7.23 的 `npm run test`（93 个测试文件、768 个测试）、`npm run build`、`npm run i18n:check`（991 keys）和 `git diff --check` 结果。完整“确认计划 → Worker → acceptance/Evidence → cleanup”仍需在隔离测试项目中执行，避免对用户项目产生副作用。

### 7.25 真实 Tauri Worker smoke 暴露并修复项目内副作用锁适配问题

- 在 `D:/Temp/slimemold-worker-e2e` 创建隔离 Git fixture，包含已批准 Task Graph、待确认 Orchestration 和可运行的 `npm test`；没有修改用户项目或当前仓库中的无关未跟踪资产。
- 通过真实 Tauri WebView 加载隔离项目并点击“确认执行计划”，确认按钮确实进入 queued Run → runtime → Worker 路径；ProjectFile 和 durable event stream 写入了 Run/Task 事实，`WorktreeManager` 也成功创建了独立 worktree 和 Worker branch。
- 首次真实 Worker 执行在 Codex/宿主 acceptance 之前失败，错误为：`事件存储只能使用项目锁：D:/Temp/slimemold-worker-e2e/.slimemold/runs/side-effects.json.lock`。根因是 `src/domain/tauriEventStore.ts` 只允许固定的 event stream lock，而 `SideEffectJournalRepository` 需要项目根目录下第二把 side-effect lock；不是 worktree、queue 或事件 replay 的失败。
- `src/domain/tauriEventStore.ts` 现在对项目内 `.slimemold/**/*.lock` 生成相对路径，并将其传给宿主；`src-tauri/src/event_store.rs` 的 `event_lock_acquire/release` 保留默认 event lock，同时校验并支持项目内 `.lock` 路径，拒绝绝对路径、`..`、项目外和非 `.slimemold` lock。
- 新增 adapter 第二把锁回归测试和 Rust 宿主 secondary-lock 测试。修复后的 targeted 验证：`src/domain/tauriEventStore.test.ts` 3/3 通过；`cargo test --manifest-path src-tauri/Cargo.toml event_store` 3/3 通过。

本轮完整验证结果：

- `npm run test`：93 个测试文件、769 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml event_store`：3 个 Rust 宿主锁测试通过。

构建仍有既有的动态/静态 import 和大 chunk warning，无新增构建失败。当前已证明真实 Tauri UI 能加载隔离项目、确认计划、入队并创建独立 Worker worktree；修复后的 Codex 修改、宿主 acceptance、Evidence 和 cleanup 全链路尚未重跑，因此不能记录为 E2E 成功。当前 `research/experimental-refactor` 修改仍未 commit/push。

### 7.26 从维护型实现说明转向全局产品与系统审视

- 新建 `docs/SLIMEMOLD_GLOBAL_PRODUCT_SYSTEM_REVIEW.md`，将前几轮关于 UI、竞品、Agent 协作、长期任务、记忆、上下文、路线一致性、能力路由、灾难恢复、断电、fallback 和唯一事实源的讨论整理为全局战略审视；文档不再采用面试问答结构，而是按问题本质、当前假设、结构性矛盾、失败模式、候选方向、推荐路线和待验证事实组织。
- 在全局审视稿中追加一组边缘情形问答：用户与 Worker 并行修改主仓库、同一文件非重叠变更、文档/设计/3D Artifact 验收、执行中改变目标、非 Git 项目、多实例并发、模型格式错误、flaky test、大型二进制、记忆冲突、保留 worktree、Provider 静默升级、能力缺口和重复 retry；这些场景统一收敛为“事实分层、状态可暂停、结果可验证、副作用可追踪、未知状态不自动重跑”。
- 更新 `docs/PROJECT_CONTROL_PLANE_ARCHITECTURE.md` 第 14–15 节，补充产品基本单位、能力型 Agent 路由、类型化 Artifact acceptance、计划 revision、断电/致命错误恢复、fallback 进度保留、跨进程 execution lease、Context Pack 和新的风险收敛优先级。
- 本轮形成的架构判断是：SlimeMold 不应继续以“更多节点/更多 Agent/更强自治”为首要目标，而应优先成为面向长期软件任务的 Agent 项目操作系统；`DomainEvent` 是状态迁移事实，宿主 Evidence/receipt 是执行事实，Git revision/worktree 是代码事实，ProjectFile/UI 只是投影；静态 `category → model` 应逐步升级为 capability registry；事件流和 ProjectFile 的跨文件事务、Context Pack、quota-aware 调度、Artifact acceptance 和完整 hash 封套仍是后续工作。
- 这轮文档审视没有把战略建议伪装成已完成能力；真实 Tauri Worker 的 Codex → acceptance → Evidence → cleanup 全链路仍需后续验证，当前代码工作树仍未 commit/push。

本轮完整验证结果：

- `npm run test`：93 个测试文件、769 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml event_store`：3 个 Rust 宿主锁测试通过。

构建仍有既有的动态/静态 import 和大 chunk warning，无新增构建失败。本轮完成的是产品/架构文档沉淀和风险优先级校准，不代表 Context Pack、capability registry、灾难恢复向导、quota 状态或完整 Tauri Worker E2E 已经交付。

### 7.27 真实 Tauri Worker MVP 垂直切片闭环

- 在隔离 Git fixture `D:/Temp/slimemold-worker-e2e` 中通过可见 Tauri WebView 点击“确认执行计划”，真实走通 `queued → running → succeeded`：Worker 使用独立 worktree 和 branch，未修改当前仓库或用户项目。
- Codex Worker 实际创建 `docs/WORKER_E2E_OK.txt`；宿主 `npm run test` 退出码为 0，diff 和默认 `allowedPaths` 均通过，写入 3 条 host Evidence（测试、diff、path-policy），再将 Run/Task 收口为 succeeded。
- 专业编排视图从同一个 Worker registry 展示 Run/Task、Evidence 和 cleanup proposal；两步批准后，宿主重新校验 acceptance、base revision、state signature 和 live registration，写入 cleanup receipt，删除 worktree，并记录 `TaskCleaned`。
- 修复真实 smoke 暴露的三个 MVP 缺口：Windows `dev_exec` 解析 npm/tsx/tsc/vitest 的 `.cmd` shim；cleanup 按 worktree path 查询登记并按真实 ID 删除；Worker Run 状态投影回 Orchestration 的 `runIds/status/stageLogs`，避免专业视图仍显示“待执行”。
- 启动审计从 `project.json + events.jsonl` 重建后，Run 保持 succeeded、Task 保持 cleaned、Orchestration 保持 done，Evidence/receipt 不重复执行，且 UI 没有误报“有未保存改动”。
- 为共享 Rust `DEV_STATE` 测试增加串行保护并消除临时目录 PID 碰撞，默认并行 `cargo test` 不再受测试竞争影响。

本轮最终验证结果：

- `npm run test`：95 个测试文件、773 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 真实 Tauri E2E：确认计划 → Codex Worker → worktree → host acceptance → 3 条 Evidence → Orchestration done → 两步 cleanup receipt → `TaskCleaned` → 重启恢复，通过。

这证明的是单任务、单 fixture、受控命令和当前 Codex provider 的 MVP 垂直切片，不等于通用项目已具备所有语言/Artifact 的 acceptance、完整事件独立重建、quota、execution lease、Context Pack 或自动交付能力；当前修改仍未 commit/push。

### 7.28 acceptance 失败与 recovery retry 的真实 Tauri 验证

- 新建隔离 Git fixture `D:/Temp/slimemold-worker-e2e-failure`，基线 `npm test` 固定返回退出码 1；通过真实 Tauri WebView 确认执行计划后，Codex 仍在独立 worktree 创建目标文件，宿主将 Run 收口为 `partial`、Task 收口为 `failed`，而不是接受模型自报成功。
- 失败验收的 test/diff/path-policy 三条 host Evidence 均落盘并回写到失败 Task 的 `evidenceIds`，专业视图能显示失败命令、退出码 1、Evidence 和副作用状态；失败任务没有可执行 cleanup proposal，worktree 保留供复查。
- 将 fixture 模拟为停在 `TaskStarted` 且 side-effect 为 `unknown/needs-user` 的重启现场后，启动审计显示 recovery-required，明确列出 inspect/retry/skip 原则，不自动重跑。真实选择 skip 只追加 recovery events，attempt 保持 1、没有新的 `TaskStarted/RunStarted`，未知副作用仍保留。
- 真实选择 retry 后创建 attempt 2 和全新 worktree；旧副作用 key 保持 unknown，新 attempt 使用独立 key 并得到 receipt。故意失败的 acceptance 再次收口为 failed，两个 attempt 的 `TaskStarted` eventId 分别包含 `attempt-1`/`attempt-2`，无事件漂移告警。
- 修复了失败 Evidence 在 executor/queue/replay 链路中丢失的问题，以及恢复队列因从空内存 event buffer 重编号而复用旧 eventId 的问题；新增 executor、queue、domain replay 和跨 attempt 回归测试。

本轮最终验证结果：

- `npm run test`：95 个测试文件、776 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 真实 Tauri failure/recovery smoke：失败 acceptance → failed Evidence → recovery-required → skip → 重启 retry → attempt 2 新 worktree/副作用 receipt → 再次 failed，通过。

测试结束后已删除 failure fixture 的临时 worktree，并恢复当前 Tauri 到 `D:/Agents/SMtest`；没有修改用户项目，也没有 commit/push。通用 Artifact acceptance、跨 provider 恢复和完整事件独立重放仍未交付。

### 7.29 将 AI 编排工具调研转化为产品定位与路线约束

- 读取用户提供的 Dify、n8n、Coze、LangChain、LangGraph 局限性调研，并将其整理为 `docs/reference/AI_AGENT_ORCHESTRATION_LIMITATIONS_RESEARCH.md`；报告明确区分原始调研、战略归纳和仍需验证的事实，保留共享调研页作为来源。
- 调研的核心结论不是竞品星级排名，而是不同工具对控制权的分配：平台化产品降低应用组合成本，自动化引擎连接外部系统，代码框架提供组件或 Runtime；复杂 Agent 系统真正的生产难题集中在状态、权限、预算、Evidence、外部副作用、恢复和交付。
- 将 SlimeMold 的定位进一步收窄为“面向真实软件项目的 Agent 控制面与执行保障层”，明确不以更多节点、模板、连接器或更强但不可解释的自治作为近期核心竞争指标。第三方 Runtime 可以作为局部执行能力，但不能取代 SlimeMold 的项目事件流、审批、策略、Evidence、Receipt 和交付边界。
- 将调研结论合并到 `SLIMEMOLD_GLOBAL_PRODUCT_SYSTEM_REVIEW.md`、`SLIMEMOLD_ARCHITECTURE_DIRECTION_REVIEW.md` 和 `PROJECT_CONTROL_PLANE_ARCHITECTURE.md`：下一阶段优先完成 Evidence → 用户查看 diff → 批准交付/合并 → 交付 receipt → 项目事实更新，其次建设普通用户 recovery UX、Context Pack、capability registry、quota/lease 和类型化 Artifact acceptance。
- 明确调研证据边界：GitHub issue、Reddit、G2 和公开文章适合发现痛点，不足以单独证明问题普遍性；云端、自托管、社区版、企业版和不同 Runtime 层次必须拆开验证。后续产品判断应使用真实任务指标，而不是主观星级。

本轮最终验证结果：

- `npm run test`：95 个测试文件、776 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 本轮只新增和修改 Markdown 文档，没有代码行为变更；没有 commit/push。

### 7.30 建立项目级元 Harness 产品哲学文档

- 根据用户对产品哲学的进一步定义，新建 `docs/SLIMEMOLD_PRODUCT_PHILOSOPHY.md`，将 SlimeMold 明确为同时约束用户、Agent、项目事实和可视化投影关系的项目级元 Harness，而不是单纯的 Agent Runtime 或节点编排器。
- 文档固化按需暴露、信息/行动/解释最小权限、用户与 Agent 的通信契约、Agent 间结构化事实交换、Agent 无事实定义权、宿主 acceptance、失败现场保留、渐进式透明和用户溯源权等产品不变量。
- 明确高级 DAG 工作台的定位：它是内部数据流、领域状态和项目事实的执行解释、调试、审查与溯源投影，不是任务执行的唯一事实源；图上编辑必须转化为领域命令或新的计划 revision。
- 将产品文档职责分层：产品哲学解释“为什么”，全局审视讨论战略判断，控制面架构定义实现契约，轻量界面研究稿负责界面转译，`docs/reference/` 保存外部研究，开发日志保存历史变化，避免同一原则在多个文档中各自演化。
- 将哲学文档链接接入 `SLIMEMOLD_GLOBAL_PRODUCT_SYSTEM_REVIEW.md`、`SLIMEMOLD_ARCHITECTURE_DIRECTION_REVIEW.md`、`PROJECT_CONTROL_PLANE_ARCHITECTURE.md` 和 `BEGINNER_UI_DESIGN.md`；本轮不新增代码行为。

本轮最终验证结果：

- `npm run test`：95 个测试文件、776 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 文档目标文件、内部链接、引用账本和 Markdown 空白扫描均通过；没有 commit/push。

### 7.31 分离用户哲学、助手判断与共同共识

- 根据用户要求，在 `docs/SLIMEMOLD_PRODUCT_PHILOSOPHY.md` 增加“来源、归属与共识状态”章节，明确区分用户直接提出的元 Harness、按需暴露、溯源权和视图投影原则，助手独立提出的受托执行、系统证明、失败一等状态和风险自适应确认判断，以及当前双方已经确认的共同设计基线。
- 明确产品哲学正文是三类内容的工程化转译，不把助手的解释冒充用户原话；未来新增原则必须先标注来源，只有双方确认后才进入共同共识。
- 同步保留既有文档的单向引用关系和产品哲学作为规范性入口，未将用户原始表述重复复制到战略、架构和 UI 文档中。

本轮最终验证结果：

- `npm run test`：95 个测试文件、776 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 产品哲学文档来源边界、内部链接和 Markdown 空白扫描通过；没有 commit/push。

### 7.32 双向图映射、静态模块与契约驱动安全分层

- 根据用户对 DAG 与内部实现关系的进一步定义，将图明确为内部数据流和语义计划的双向映射：图上操作先转换为语义意图或 Domain Command，再进入 Plan IR、计划 revision 和事件流，不能直接把画布局部状态写入运行时。
- 将图的生命周期从“静态/动态”细化为 Draft Graph、Static / Published Graph 和 Dynamic Runtime Graph：草案可编辑和试验，静态图作为带版本的可复用 Graph Module，动态图表示某次 Run 的实际展开、分支、重试、Worker 和 Evidence。
- 明确静态图对父图默认封装、对拥有权限的用户可下钻；插件节点是 Graph Module 的安装、分发、manifest 和实现包装，不是另一套事实源。模块引用需要保留版本和运行 lineage，展开后的临时节点不能反向静默修改源定义。
- 在 `PROJECT_CONTROL_PLANE_ARCHITECTURE.md` 和 `H3_ORCHESTRATOR_DESIGN.md` 中加入目标 `BoundaryContract`：用户界面以勾选项表达上下文、scope、capability、action、Artifact、acceptance、budget、recovery 和 delegation，实际执行以结构化契约校验。
- 确立上下级契约只能收窄（`Child Contract ⊆ Parent Contract`），模板只提供默认边界而不规定固定流程；系统依据契约而非节点数量推导最低安全控制，边界扩大时只能升级或阻塞。
- 在 `BEGINNER_UI_DESIGN.md` 和 `PROFESSIONAL_ROADMAP.md` 中补充用户拖拽/修改节点的语义，以及 Draft/Static/Dynamic 图和插件模块的界面与路线约束。小任务减少用户仪式但不移除事实、权限和宿主验收底线。

本轮最终验证结果：

- `npm run test`：95 个测试文件、776 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 本轮只新增和修改 Markdown 文档，没有代码行为变更；没有 commit/push。

### 7.33 以项目级元 Harness 视角审查代码结构并收拢插件生命周期

- 基于 `40bfe0d` 重新审查 `domain`、`projectControl`、旧 `engine/orchestrator`、Zustand store、React Flow、Worker/Tauri 和插件边界；确认 Worker recovery MVP 的局部闭环已经可继续演进，但在直接实现三态 Graph、Boundary Contract、Context Pack 和 delivery 之前，必须先收口执行身份、Graph Command、ProjectControl 提交协议和事件投影边界。
- 新增 `docs/CODEBASE_ARCHITECTURE_REVIEW.md`，记录当前真实依赖形态、P0/P1 结构风险和 Phase A-F 演进顺序：不做一次性重写，先建立 `TaskDefinition → Execution → Attempt → Evidence/Receipt` 身份链，再引入 Graph Command / Plan Revision、Published Graph Module、BoundaryContract/Host Lease 和统一 StartExecution。
- 修复项目插件生命周期缺陷：此前 `App.tsx` 的无 selector store subscription 会在普通画布编辑、运行进度、日志和恢复状态变化时反复卸载/扫描项目节点；现在只在初始项目加载或 project id/path 变化时触发，并将 `projectId + projectPath` 传入扫描上下文，项目切换期间的旧异步扫描不得向新项目 Registry 注册节点。
- 新增 `src/plugins/projectPluginLifecycle.ts` 及单测，覆盖同项目普通更新、项目打开、切换和关闭；项目作用域同时比较 `projectId + projectPath`；

本轮最终验证结果：

- `npm run test`：96 个测试文件、778 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 本轮未 commit/push；项目原有未跟踪的设计、日志和图标素材未纳入改动。

### 7.34 独立安全交叉审查与沙箱输入边界收紧

- 三条独立审查分别复核了领域事实源、UI/图投影和 Tauri/Worker/插件边界；新增结论：在启用不可信 Graph Module 前，必须先解决完整事件 replay、双 Run 模型、BoundaryContract/Host Lease、插件 trust domain、Worker supervisor 以及 failed/unknown/receipt 语义，不能把当前 Web Worker PoC 当作进程级隔离。
- 新增 `src/engine/sandboxPath.ts` 及单测，拒绝沙箱绝对路径、`..`、Windows drive/UNC、NUL、ADS、末尾点/空格、设备名和嵌套 node/lane id；`executor` 的 `writeFile/readFrom/list/commitLanes` 现在只接受安全相对路径，并限制为宿主声明的直接上游车道。
- 项目上下文替换前调用 `terminatePluginRuntime()`，终止旧 sandbox worker 和 responder，避免全局 `pluginId` slot、模块状态和在途执行跨项目复用。该修正不改变非沙箱可信插件路径，也不宣称完成进程级隔离、symlink 防护或宿主 lease。
- `docs/CODEBASE_ARCHITECTURE_REVIEW.md` 补充了插件信任、沙箱路径、Worktree 注册、Codex 进程生命周期和 Receipt 状态机的独立审查结果；后续仍按身份 → 提交协议 → Graph Command → Published Module → BoundaryContract/Lease → 统一执行 → Delivery 顺序推进。

本轮最终验证结果：

- `npm run test`：97 个测试文件、793 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 本轮未 commit/push。

### 7.35 结构审查后的生命周期、扫描与沙箱边界修正

- 独立代码审查指出项目切换存在同步 store 重入、异步 session 交错、过期插件扫描、pending sandbox load Promise 悬挂和嵌套文件交付不完整问题；本轮将 `projectPluginLifecycle` 升级为带 epoch 的 scheduler，App 串行化 `teardown → ensure`，过期上下文不再恢复 Worker 或继续注册项目节点。
- `pluginManager` 在 fs import、项目 scope grant、目录创建、目录读取、manifest/entry 读取和动态加载前后检查上下文，并跳过 symlink package；`manifest.entry` 经过 `src/plugins/pluginPath.ts` 的 `assertPluginRelativePath()` 校验，项目作用域由 `projectId + projectPath` 共同确定。
- 新增 `src/engine/sandboxFs.ts` 及 fake-FS 单测：parent `lstat`、symlink 拒绝、`open(createNew)`、嵌套父目录和递归 commit；`src/engine/sandboxPath.ts` 继续拒绝 traversal、Windows 特殊路径、ADS、设备名和非法文件名，同时编码 `subgraph::node` 逻辑 ID。
- `SandboxManager` 在 load 握手期间被 `terminateAll()` 时会 reject 等待中的 `ready` 并解绑 handler；Tauri capability 显式加入 `fs:allow-lstat` 与 `fs:allow-open`。这仍不是完整 host-level TOCTOU/no-follow 或不可信插件进程隔离，后者保留为 Graph Module 启用前门槛。

本轮最终验证结果：

- `npm run test`：99 个测试文件、806 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 本轮未 commit/push；原有未跟踪的设计、日志和图标素材未纳入改动。

### 7.36 记录独立审查结果边界

- 第一轮独立 reviewer 针对修复前 diff 返回 `passed=false`，指出 sandbox lexical path、项目切换重入、过期插件扫描、pending load Promise 和嵌套交付问题；这些问题已在后续工作树中修正或收紧，不能把第一轮 verdict 当作最终代码 verdict。
- 第二轮 reviewer 针对修复后 diff 已自行运行 targeted tests 和 build，但在返回最终 JSON 前因等待模型响应超时而中断；本轮没有独立 reviewer approval，最终结论只依据实际源码复核和质量门。
- 仍未关闭的门槛包括 host-level TOCTOU/no-follow、第三方插件独立隔离、Worker/Worktree execution lease 与 supervisor、完整 ProjectControl replay/原子提交，以及统一 Execution/Attempt lineage、Artifact acceptance 和 Delivery Receipt。

本轮最终验证结果：

- `npm run test`：99 个测试文件、806 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 本轮未 commit/push。

### 7.37 重划分 docs 目录层级并保留历史资料

- 将当前文档按职责分为 `principles/`、`strategy/`、`architecture/`、`product/`、`plans/`、`verification/`、`security/`、`reference/`、`history/`、`design/` 和 `log/`；`DEVELOPMENT_LOG.md` 继续留在 `docs/` 根目录作为时间线入口。
- 当前规范、战略、架构、专题设计、产品 UI 和路线图文档均移动到对应目录；旧项目分析、早期 Codex 评审、God Module 重构总结、旧验证清单和长篇讨论稿移动到 `history/`，没有删除原文。
- 新增 `docs/README.md` 作为文档地图，明确产品哲学、战略审视、控制面架构、代码结构审查、专题设计、计划、验证和历史资料的权威边界；新增各资料目录 README，避免原始对话、外部研究和视觉探索被误当作产品或架构事实。
- `reference/2.md` 更名并移动到 `reference/archive/AI_ECOSYSTEM_GAPS_NOTES.md`；视觉 HTML 试稿移动到 `design/explorations/`；CodeBuddy JSON 导出移动到 `log/raw/`；凭据说明移动到 `security/CREDENTIALS_MODEL.md`。原始日志仍需脱敏后才适合提交或共享。
- 为现行文档补充相对链接和基础 metadata；历史开发日志中的旧路径保持原样，迁移关系集中记录在 `docs/README.md`。

本轮最终验证结果：

- `npm run test`：99 个测试文件、806 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 本轮未 commit/push。

### 7.38 建立 Execution/Attempt lineage 与 replay projection

- 在 `src/domain/execution.ts` 新增确定性的 `TaskExecutionId(runId, taskId)` 与 `AttemptId(taskExecutionId, attempt)`；对 ID 组成部分做编码，重启和 replay 不依赖随机值。
- `WorkerTaskLease`、WorkerQueue 事件、recovery、cleanup proposal/command、side-effect journal、宿主 Evidence/Acceptance 和 Worker read model 现在携带 execution/attempt lineage；旧 `Task` aggregate 事件与旧快照仍在 reducer/snapshot 边界派生兼容 ID。
- `DomainProjection` 新增 `taskExecutions` 与 `attempts`：同一 `taskId` 在不同 Run 中不再互相覆盖，retry 的 `TaskQueued(nextAttempt)` 只清理 execution 当前结果，真正 claim 时生成新的 `AttemptId`；旧 `AttemptRecord` 的 Evidence、Acceptance、worktree 和 receipt 保留。
- consistency audit 改为按 `(runId, taskId)` 读取 execution，并报告 lineage drift、缺失 attempt 和孤立 execution；projection snapshot 缺少新索引时回退事件 replay，不信任旧 schema 的半完整投影。
- cleanup acceptance 增加 execution/attempt 绑定校验；retry 同时清除旧 acceptance、cleanup receipt 和 worktree branch，避免新 attempt 继承旧 attempt 的当前结果。
- 新增 identity、双 Run、retry replay、snapshot migration、worker lease、Evidence JSONL、cleanup lineage 和 read-model 回归覆盖；未实现 ProjectCommandBus、PlanRevision、Boundary Contract、Host Lease、Artifact acceptance 或 DeliveryReceipt。

本轮最终验证结果：

- `npm run test`：100 个测试文件、818 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 隔离 Tauri E2E：fixture 生成与删除成功，Tauri 子进程启动但当前 GUI 驱动未能枚举其窗口，未将真实 Worker E2E 记为通过；
- 本轮未 commit/push；未跟踪的设计、日志和图标素材未纳入改动。

### 7.39 修复 Execution/Attempt lineage 审查阻塞项

- 针对独立只读审查发现的 stale completion 根因，给 `WorkerTaskQueue.markSucceeded/markFailed` 增加必需的 attempt fencing token；retry 队列状态与 replay projection 都清空旧 `currentAttemptId`，旧 Worker 的迟到完成不能覆盖新 attempt；
- 收紧 `TaskExecutionId`/`AttemptId` 的 canonical parser、完整 lineage assertion、safe integer 和任务图/队列恢复校验；worktree allocator、默认路径、Worker side-effect key 和 cleanup key 使用 collision-safe identity，并拒绝自定义 allocator 复用同一 normalized path；
- recovery plan 区分全量历史与当前 started/unknown effects，只对当前 execution/attempt 执行 retry/skip；带 taskId 但 lineage 不匹配时 fail-closed，不 fallback 重置其它任务；side-effect journal 不再把已声明 lineage 的缺字段记录当 wildcard；
- cleanup proposal/command/execution 校验当前 task execution、attempt、Acceptance、receipt record、receipt key 和 receiptId；Worker acceptance 在宿主 EvidenceStore 没有 durable persistence 时阻断；Worker 返回 failed 时 side-effect receipt 保存 `outcome/error`；
- Evidence/Acceptance 增加 run/task provenance，consistency audit 可核验 Evidence、Acceptance、side-effect ledger 的实际归属；read model 隐藏其它 attempt 的记录；旧事件流为空时从 `workerRuns` 生成 synthetic Worker baseline facts，并以 `TaskAttemptImported(status=unknown)` 保留 queued retry 的已知 attempt 身份；同一 orchestration 的多 Run 用 `stageLogsByRun` 隔离并选择最新 Run；
- replay 现在校验 aggregateVersion、Run/Task aggregate identity、attempt 单调性、终态冲突和连续 `nextAttempt`；本轮新增 stale completion、跨 task recovery、过期 cleanup receipt、伪造 lineage、delimiter collision、旧 Worker migration、多 Run projection 等回归覆盖。

本轮最终验证结果：

- `npm run test`：100 个测试文件、849 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过（保留 Windows 工作树的 LF→CRLF 提示，无 whitespace error）；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- 新增行敏感模式扫描未发现凭据赋值、shell injection 或 eval/exec；
- 仍未实现 ProjectCommandBus/commit protocol、完整 ProjectControl replay、PlanRevision、Boundary Contract、Host Lease、Artifact acceptance 和 DeliveryReceipt；真实 Tauri Worker E2E 仍受当前 GUI 窗口不可观测限制，未宣称通过。

### 7.40 加固宿主边界、恢复凭据隔离与项目切换取消

- 针对第二轮独立审查，统一 TypeScript/Tauri/Rust 的 Windows path comparison key 和 component boundary 检查；Evidence、Worktree、allocator、queue、GUI session 以及 Rust worktree registration 都拒绝大小写变体绕过、前缀碰撞和主仓库外的 worktree 生命周期命令；allocator 在 creator 失败或身份不一致时释放 reservation；
- 将 Node/Rust/Codex command 环境收紧为最小执行 allowlist，并叠加 credential-family suffix 拒绝；Node/Rust Worker 使用临时 HOME/USERPROFILE/APPDATA/LOCALAPPDATA 与隔离 npm 配置/cache，Codex 登录/Worker CLI 仅保留 credential-filtered ChatGPT auth 路径并使用 `--ignore-user-config`/`--ignore-rules`；
- replay 增加 pending next-attempt fence、terminal/reopen 检查、strict identity/safe integer 和 synthetic migration provenance；legacy Worker snapshot 对已明确为终态的任务补出最小 Started 边界，多 attempt 先补 queued fence，不伪造未知结果；foreign project Worker facts 和非 migration 的 TaskAttemptImported 事件拒绝导入；
- recovery plan 统一从真实 effects 推导 recoverable set，忽略篡改的 effectKeys/requiresUser；partial/unscoped/stale/非当前 running attempt 不再参与 retry/skip；cleanup receipt 校验 kind、target、inputHash、outputHash、outcome、recovery、receiptId 和当前 lineage，并将经过完整匹配的旧 key 迁移为 canonical key；
- Acceptance 新增宿主持久化与启动 reload，Evidence JSONL 只忽略明确的 missing-file，权限/损坏读取失败中断审计；consistency audit 对当前 attempt 的 Evidence/Acceptance/side-effect 做精确匹配并报告无 taskId 的记录；
- 项目切换建立 project operation cancellation fencing：旧 operation 不再 restore/register/persist，WorktreeManager 在 create/restore/cleanup 边界检查取消，Codex Worker 通过 operation id、process-tree kill 和 30 分钟 timeout 支持取消，DevSession singleton 不跨项目复用；

本轮最终验证结果：

- `npm run test`：101 个测试文件、880 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有动态/静态 import 与大 chunk warning）；
- `npm run i18n:check`：中英文 991 个 key 对齐；
- `git diff --check`：通过（保留 Windows 工作树的 LF→CRLF 提示，无 whitespace error）；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：28 个 Rust 测试通过；
- 新增行安全扫描：hardcoded secret assignment、shell injection、eval/exec、unsafe deserialization 均为 0；
- 真实 Tauri Worker E2E 仍受当前 GUI 窗口不可观测限制，未宣称通过；OS 级 no-follow/TOCTOU、第三方不可信插件进程隔离和真正的网络/文件系统沙箱仍是后续安全阶段；本轮仅建立本地 checkpoint，不 push。

### 7.41 第三轮审查后的宿主隔离与生命周期收敛

- 针对第三轮 reviewer 的失败项，补齐真实 Git worktree registration：登记路径必须属于当前 `<baseRepo>-workers/<attempt>`，branch 必须是对应 `worker/<attempt>`，并通过 `git worktree list --porcelain` 交叉验证；主仓库 `git diff/status/worktree/branch` 和 worktree 内 `find/grep` 参数改为显式只读白名单，实际 spawn 使用 canonical cwd/路径 operand。
- 修复浏览器 `node:path` shim 的 `.`/`..`/UNC 解析、Windows verbatim path comparison、JSONL 真实换行与并发 append；Evidence/Acceptance/side-effect 持久化入口统一做 schema、lineage、receipt outcome 的 fail-closed decode。
- Worker queue、Acceptance、Codex pending login/child、Worktree restore/create/cleanup、plugin scan 和 ProjectFile save 均加入 cancellation/generation fencing；取消不再伪装成 TaskFailed，transition callback 失败不会丢事件，迟到 completion 不能提升 unknown effect。
- 验证结果：`npm run test` 101 个测试文件、880 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 28 个 Rust 测试通过；`git diff --check` 通过；新增行安全模式扫描为 0。
- 仍未宣称完整不可信代码沙箱：OS 级 no-follow/TOCTOU、第三方插件进程/网络隔离和真实 Tauri Worker E2E 仍待后续安全阶段；本轮不 push。

### 7.42 收紧公开 Git 面、原子副作用 claim 与历史 attempt 审计

- 第四轮独立审查发现 legacy `run_git`、主仓库 Git gate、Node shell rule、`dev_register_worktree` 和 `dev_init_session` 仍有可绕过边界；本轮将 legacy run_git 限制为真实 Git top-level 上的只读 probe，移除 worktree mutation/prune/branch delete，限制 `gitDiff` revision，拒绝 `find -delete`、`grep` 递归和外部文件 option，并为登记/写入增加真实 worktree、canonical path、symlink/hardlink 检查；
- 删除 vault key 解密长度/前缀日志；Node/Rust Worker 命令继续使用 credential-filtered、隔离用户配置环境；Codex login 与 Worker child 的 pending/active cancellation、timeout、输出 drain 和清理路径保持分离；
- side-effect journal 增加持锁 `claim`，Worker execution 和 cleanup 只允许一个进程取得 started claim；receipt 携带 Evidence/Acceptance provenance，已有 receipt 可安全恢复，unknown/迟到 completion 不会伪造成功；ProjectFile 与 checkpoint 写入使用 per-project write lock；
- retry 持久化 `pendingAttempt`，consistency audit 可重算 worker-execution inputHash、忽略经过完整验证的历史 terminal receipt，并继续报告 future/partial/篡改记录；queue 在 receipt 已 durable 后允许 terminal finalize，普通取消仍不 markSucceeded；Evidence/Acceptance schema 和读取失败保持 fail-closed；
- 验证结果：`npm run test` 101 个测试文件、887 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 30 个 Rust 测试通过；`git diff --check` 通过；新增行安全模式扫描为 0。
- 仍未宣称完整不可信代码沙箱：Windows no-follow/TOCTOU 的原子保护、package script 的网络/文件系统隔离、跨进程真实压力测试和 Tauri Worker E2E 仍是后续安全阶段；本轮只在本地 checkpoint，不 push。

### 7.43 完成 retry replay、receipt race 与终态提交收敛

- 最终独立 reviewer 发现 grep `--directories=recurse`/`-d recurse` 可绕过、Tauri missing-file 字符串无法创建新文件、pendingAttempt 可跳号、retry 缺少旧 running Attempt 的 unknown 事实、历史 unknown 被 audit 阻断，以及 receipt 竞争分支缺少完整校验；本轮分别加入全递归 alias deny、统一 missing-file 识别、严格 `attempt + 1`、`TaskAttemptMarkedUnknown` 事件、历史 effect canonical 验证和统一 cleanup/worker receipt validator。
- queue 改用 `Promise.allSettled` 处理并发 lease；receipt 已 durable 后允许 terminal finalize，普通取消仍 fail-closed；App 终态事件只允许安全 terminal batch，并把取消后的旧项目 event/ProjectFile 快照写回捕获的旧路径，不触碰当前项目 store；ProjectIO/JSONL 持久化继续使用项目级写锁和 read-back。
- 验证结果：`npm run test` 101 个测试文件、887 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 30 个 Rust 测试通过；`git diff --check` 通过；新增行安全模式扫描为 0。
- 仍未宣称完整不可信代码沙箱：Windows no-follow/TOCTOU 的原子保护、package script 的网络/文件系统隔离、真实跨进程压力测试和 Tauri Worker E2E 仍需后续安全阶段；本轮不 push。

### 7.44 收口测试生成物目录并开始 MVP 验收基础设施

- 历史 `evidence-test-*` 空目录的根因是旧版 `src/dev/evidence.test.ts` 使用相对 `evidence-test-${Date.now()}` 作为持久化根，测试只删除 JSONL 文件而未删除父目录；本轮已清理仓库根目录遗留目录，并新增 `src/dev/test-artifacts.ts`，统一把测试生成物放入系统临时目录下的 `slimemold-test-runs/<namespace>-<unique>` 专有根。
- 新 helper 拒绝仓库 cwd 及其子目录，使用真实路径校验和唯一目录创建，支持显式保留现场，并在 `withTestArtifactRoot` 的 `finally` 中递归清理；`src/dev/evidence.test.ts` 与 `src/domain/eventStore.test.ts` 已迁移，异常路径不会把临时目录散落回仓库根目录。
- 新增 `src/dev/test-artifacts.test.ts` 覆盖专有根、cwd 拒绝和 callback 失败清理；全量测试后仓库根目录 `evidence-test-*`/`evidence-flush-*` 为 0，`C:/Users/rnfmabj/AppData/Local/Temp/slimemold-test-runs` 为空；未触碰 `D:/Agents/SMtest`。
- 验证结果：`npm run test` 为 102 个测试文件、890 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 30 个 Rust 测试通过；`git diff --check` 通过。
- 本轮只完成测试生成物治理，尚未实现 `FilePatchSet`、ArtifactCandidate、DeliveryReceipt 或真实 Tauri E2E；下一阶段进入结构化项目骨架与 Worker 补丁输出，不把本轮质量门写成真实桌面 MVP 已完成。

### 7.45 建立结构化 FilePatchSet 与第一次 MVP 项目骨架节点

- 新增领域模块 `src/domain/model/artifact.ts`：定义版本化 `FilePatchSet`、`FilePatchEntry`、`ProjectSpec`、`StructureManifest`，对模型/适配器输入执行 schema、重复路径、绝对路径、反斜杠、目录穿越和 `.slimemold` 元数据路径的 fail-closed 校验；新契约不依赖 React Flow、Zustand 或 Tauri。
- 新增确定性的 `project.scaffold` 节点（`src/nodes/mvp/index.ts`）并接入 `builtinDefs`：固定生成带 `package.json`、`tsconfig.json`、`README.md`、`src/index.ts` 和 `tests/index.test.ts` 的 TypeScript MVP 骨架，输出 `ProjectSpec + StructureManifest + FilePatchSet` 候选；节点为 compute 级，只生成候选，不调用 LLM、不写文件。
- 新增领域和节点回归测试，验证完整目录清单、编译/测试命令、可运行源文件、schema round-trip、危险路径拒绝和 builtin 注册；生产写入、worktree apply、ArtifactCandidate、DeliveryReceipt 和真实 Tauri E2E 尚未在本轮实现。
- 验证结果：`npm run test` 为 104 个测试文件、896 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 30 个 Rust 测试通过；`git diff --check` 通过。
- 本轮仍不把“生成补丁候选”写成“项目文件已交付”：下一阶段必须在专用 fixture 的隔离 worktree 中实际 apply、compile、test、Evidence、Acceptance，并经用户批准后交付到项目根目录。

### 7.46 将结构化补丁应用接入 H4，并把编译纳入宿主验收

- 新增 `src/dev/patch-set.ts`：`applyFilePatchSet` 对 `FilePatchSet` 做全量 preimage 预检，随后经现有受控 `codePatch` 逐文件应用，并对每个文件执行 read-back；前置内容漂移、宿主拒绝、缺失 hash 或读回不一致均 fail-closed，错误保留已应用路径，不返回成功结果；目录创建通过同样受守卫的 `codeMkdir`，不在 patch-set 中直写文件系统。
- `src/nodes/dev/index.ts` 新增动态 H4 节点 `dev.patch.apply`，在当前已登记 worktree 中应用结构化补丁并登记 `artifact` 类型宿主结果；Node/Tauri 分别接入同一语义的目录创建能力，新增回归覆盖新文件、结构化多文件补丁、作用域和宿主结果登记。
- `src/dev/workerAcceptance.ts` 新增固定 `compileCommand`，默认先由宿主执行 `npm run build`，再执行 `npm run test`；compile/test/diff/path-policy 共四类真实 Evidence 必须持久化后才进入确定性 Acceptance，模型最终文本不改变结论。
- 收紧 `FilePatchSet` 路径校验：拒绝任意层级 `.slimemold` 元数据目录和控制字符，避免补丁头或运行元数据路径绕过；未实现的 ArtifactCandidate、用户批准 delivery 和 DeliveryReceipt 仍未在本轮完成。
- 验证结果：`npm run test` 为 106 个测试文件、905 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 33 个 Rust 测试通过；`git diff --check` 通过。
- 本轮仍未完成真实 Tauri fixture、项目根目录 delivery、重启后的 DeliveryReceipt read-back 和真实用户端到端验收；下一阶段实现 ArtifactCandidate → 用户批准 → 受控项目文件交付。

### 7.47 增加 ArtifactCandidate、用户批准交付与 DeliveryReceipt

- 新增 `src/projectControl/workerDelivery.ts`：`buildArtifactCandidate` 只接受通过且无失败项的 Host Acceptance、完整有序的已应用 `FilePatchSet` 和完整 execution lineage；第一版只允许交付预期不存在的新文件，候选文件携带 source hash，不允许覆盖已有源文件。
- 新增显式 `createArtifactDeliveryApproval`：目标根必须是绝对路径，approval 必须标记为 `approvedBy: 'user'`，candidate/approval 在 claim 前执行运行时 schema、路径、hash、lineage 校验；工作流节点不能伪造 approval 或直接触发交付。
- `deliverArtifactCandidate` 使用 Node host 的 `wx` 新建写入、source/destination canonical path 与 component-boundary 校验、源文件 hash 校验、目标 read-back 校验；入口还必须匹配宿主查询到的 passed Acceptance，不能只凭 candidate 结构交付；通过现有 `SideEffectJournalRepository` 原子 claim，成功后持久化包含 candidateId、approvalId、文件清单、逐文件 hash、aggregate output hash 的 DeliveryReceipt；目标冲突、源漂移、账本异常或中途失败进入 `unknown/needs-user`，重复调用只读已有 receipt。
- 扩展 `SideEffectReceipt` schema 以保留交付元数据，并拒绝 receipt 文件清单中的目录穿越/绝对路径/反斜杠/运行元数据路径；新增真实临时目录交付集成测试、lineage 伪造测试、坏 candidate claim 前拒绝测试和目标冲突恢复测试。
- 验证结果：`npm run test` 为 107 个测试文件、910 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 33 个 Rust 测试通过；`git diff --check` 通过；测试生成物仍统一在专有系统临时根，仓库根散落目录为 0。
- 当前交付实现已具备可调用的 host API，但尚未接入 `DevSession`/GUI approval 面板、Tauri 安全 copy command、候选/approval 的跨重启加载，目标父目录必须由 fixture 预先存在；真实 Tauri 成功/失败/recovery E2E 仍未完成，不能把本轮 Node 集成测试写成桌面 MVP 验收通过。

### 7.48 修复 Tauri Worktree branch 契约并完成首条真实 GUI 成功切片

- 真实 Tauri 首次运行停在 `dev.worktree.create`：Node `WorktreeManager` 默认生成 `dev-...` 分支，而 Rust `dev_exec`/`dev_register_worktree` 只接受与受控 Worker 目录一一对应的 `worker/<worktree basename>`；headless 直调 Node git 未经过该宿主边界，因此曾出现 headless 成功、GUI 失败的双宿主分叉。
- 新增 `workerBranchForPath` 并让 `dev.worktree.create` 显式传入 `worker/<basename>`；新增 RED→GREEN 回归断言。与此同时，Acceptance 在持久化失败记录后抛出节点错误，避免 `{ passed: false }` 被执行器当作成功；success fixture 的 Evidence→Acceptance 依赖改为 data，并加入允许目录内的 tracked diff，保持 compile/test/diff/Acceptance 证据真实。
- 从 disposable fixture 的初始 Git commit 恢复被误建空 workflow 覆盖的工作流，重新导入并通过真实 Tauri WebView 运行：`runId=1` 的 10 个节点全部 success；Worker worktree 为 `D:/Temp/slimemold-tauri-e2e-20260904-203708-workers/mvp-gui-success-wt`，branch 为 `worker/mvp-gui-success-wt`，实际生成 `src/components/greeting.js`、`tests/greeting.test.js` 并修改 `src/components/baseline.js`；宿主 Acceptance `passed=true`，artifact/compile/test/diff 四条 Evidence 全部 passed，fixture 文件已 read-back。
- 验证结果：`npm run test` 为 108 个测试文件、914 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 33 个 Rust 测试通过；`git diff --check` 通过；定向 branch/Acceptance 回归为 2 个测试文件、28 个测试通过。
- 本轮建立本地 checkpoint `7e4de57 chore: checkpoint tauri e2e runner progress`，未 push；branch 修复已验证但尚待独立 reviewer 针对当前 HEAD 复审后提交。成功 worktree 暂不清理，等待用户批准；DeliveryReceipt、用户批准交付、重启 read-back、failure/unknown/retry/recovery 路径仍未完成，不能把本轮写成完整 MVP 或完整 Tauri E2E 闭环。

### 7.49 对齐 Git Worker basename 的双宿主非法值规则

- 当前 staged 独立 reviewer 发现 `workerBranchForPath` 仍接受 `foo..bar`、`.hidden`、`foo.` 和 `foo.lock`；这些值与 Rust 的 Worker branch/target 守卫及 Git ref 规则不一致，可能让 Node/headless 与 Tauri 得到不同结果。
- 新增 `worker_name_is_valid` 并让 Rust 的 branch 与 target 校验共用同一规则；Node helper 同步拒绝任意 `..`、首尾点和大小写不敏感的 `.lock` 后缀，同时保留字符白名单；新增 POSIX、Windows、混合分隔符、尾斜杠和非法 basename 回归测试。真实 fixture 使用的 `mvp-gui-success-wt` 不受影响，既有 GUI success 证据仍对应同一合法 branch。
- 验证结果：`npm run test` 为 108 个测试文件、915 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 34 个 Rust 测试通过；`git diff --check` 通过；新增 TS/Rust 定向回归均通过。
- 本轮仍未 push；成功 worktree 暂不清理，DeliveryReceipt、用户批准交付、重启 read-back 和 failure/unknown/retry/recovery 仍待后续阶段；最终提交需在当前 staged diff 重新独立审查通过后完成。

### 7.50 修复 Queue Worker identity 与 Tauri rollback lease 的双宿主分叉

- 当前独立 reviewer 发现 GUI queue 使用 `encodeURIComponent(attemptId)` 生成包含 `%3A`/`%25` 的 Worker basename，而 Rust/Git Worker gate 只接受安全 ref 组件，导致正常 queue worktree 在 Tauri add/register 前被拒绝；本轮新增 canonical AttemptId 的无 `%` 十六进制 identity，并让 queue path、branch 和 worktree id 共用同一编码。
- 修复 Tauri worktree add 成功但 registration 失败时的回滚竞态：Rust 仅为成功 add 记录当前 session 的 pending rollback lease，remove/branch delete 只能匹配该 target/branch，成功后按阶段消费；Node rollback 失败不再 `forget` manager 记录，`orphaned` 状态可在用户确认后只重试 branch delete，避免丢失孤儿分支 lineage。
- 新增 queue identity、Rust pending lease scope、登记失败现场保留、orphaned branch retry、大小写 `.LOCK` 和 Windows 路径回归覆盖；未放宽任意合法 Worker target 的 remove/branch gate。
- 验证结果：`npm run test` 为 108 个测试文件、918 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 35 个 Rust 测试通过；`git diff --check` 通过。
- 本轮未重新执行真实 GUI Worker；既有 success fixture/worktree 仍保留，DeliveryReceipt、用户批准交付、重启 read-back 和 failure/unknown/retry/recovery 仍待后续阶段；当前修复需在最终 staged snapshot 获得新的独立 reviewer 通过后提交，未 push。

### 7.51 收紧 pending rollback 顺序、长度边界与 Tauri orphan retry

- 继续针对独立 reviewer 的双宿主审查补强：queue Worker identity 采用 bounded Git-safe 编码，Node/Rust 同步限制单一 basename 长度为 200；pending branch 只有在对应 worktree remove 成功后才可删除，branch 成功后 lease 立即消费，其他合法 target/branch 仍被拒绝。
- 修复 Tauri `dev_register_worktree` 失败后的现场处理：成功 add 产生的 pending lease 专供当前 rollback，create/restore registration 失败时都保留 manager 记录而不是丢失 live/orphan lineage；Tauri `orphaned` cleanup 保持 Rust registration，用户确认后只重试 branch delete，完整成功后才注销登记。
- 新增超长 identity、pending remove→branch→consume、Tauri registration 保留和 orphan branch retry 回归；测试使用 disposable/fake host，不触碰 `D:/Agents/SMtest` 或无关未跟踪素材。
- 验证结果：`npm run test` 为 109 个测试文件、921 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 35 个 Rust 测试通过；`git diff --check` 通过。
- Tauri 开发进程已因 Rust 变更重编译并保持运行，但本轮未重新点击真实 GUI Worker；既有 success worktree 仍保留，DeliveryReceipt、用户批准交付、重启 read-back 和 failure/unknown/retry/recovery 仍待后续阶段，未 push。

### 7.52 收紧 Worktree realpath、session fencing 与 unregister 语义

- 最新独立 reviewer 以 `passed=false` 指出：仅用 lexical parent 校验时，预存 symlink/junction 可把 `git worktree add` 的副作用导向 Worker 根外；本轮在 Rust 实际 spawn 前 canonicalize Worker root 与 parent，拒绝 reparse root、已有 target 和不一致 realpath，同时允许安全缺失 root 由 Git 创建；新增 Windows junction/缺失 root 回归，测试夹具统一放在 `slimemold-test-runs` 并由 RAII 清理。
- 为项目切换与宿主命令增加 session generation 和进程内 operation lease：`dev_exec`、文件读写/建目录、init/clear/register/unregister 共用串行 lease，pending rollback 绑定当前 generation，register/exec 在 I/O 前后复核代次；新增并发 reset fencing 回归。该修复覆盖同一 Tauri 进程内的切换竞态，不把它写成跨进程锁或完整 OS no-follow 保障。
- `dev_unregister_worktree` 现在必须有当前 base repo、合法 `worker/<basename>` 关系、已登记 worktree 且不在 pending rollback 中；未登记、非法或重复注销返回错误并保留 pending 状态，避免任意调用静默破坏宿主登记态。
- 验证结果：`npm run test` 为 109 个测试文件、921 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 39 个 Rust 测试通过；`git diff --check` 通过；新增行敏感模式扫描为 0。
- 本轮只完成宿主边界 hardening，未重新点击真实 GUI Worker；既有 success worktree 仍保留，DeliveryReceipt、用户批准交付、重启 read-back、failure/unknown/retry/recovery 和 OS 级 no-follow/TOCTOU 仍未完成；未 push。

### 7.53 为 GUI/Tauri host command 增加 caller generation fencing

- 针对独立 reviewer 之前指出的 session race，本轮让 `dev_init_session` 返回单调 generation；GUI DevSession、Tauri Git/Deps、Codex Worker、register/unregister/read/write/mkdir/clear 均必须携带同一 token，stale token fail-closed。
- Rust 侧用 session generation + operation lease 串行化 session mutation 与 host command；Codex Worker 在 auth 后及实际 spawn 前再次校验，并在执行期间持有 lease，取消仍走独立 cancel 通道。
- unregister 现在要求当前 generation、合法 Worker target、非 pending、Git worktree 已不再 live 且 Worker branch 已删除；restore/create rollback 失败时保留 manager lineage，orphan retry 只重试 branch。
- Worktree add 在 spawn 前校验 root/parent realpath，拒绝预存 symlink/junction；缺失 root 在安全 parent 下由宿主原子创建，并在 Windows 持有 no-DELETE directory handle 覆盖 Git add。POSIX/跨进程以及 target replacement 的 OS 级 no-follow 压力测试仍是后续边界，不能把本轮测试当作完整安全证明。
- 新增 stale generation、session reuse、Tauri payload、live/cleaned unregister、junction、missing-root、operation lease 与 dedicated Temp RAII 回归；专有测试根无残留。
- 最终质量门：`npm run test` 为 109 个测试文件 / 923 个测试通过，`npm run build` 通过，`npm run i18n:check` 为 991 keys 对齐，Rust `cargo fmt -- --check` 通过、`cargo test` 为 40 个测试通过，`git diff --check` 通过。
- 本轮未 push；真实 GUI success worktree 仍保留，未执行用户批准之外的 Delivery/Cleanup。

### 7.54 修复 unregister 失败后的 cleanup 收敛

- Phase 2 hardening 的第一个垂直切片针对 reviewer 指出的状态分裂：Git worktree/branch 已清理但 Rust `dev_unregister_worktree` 失败时，Node 不再把记录当作不可重试的 `cleaned` 终态；新增 `registration-pending` 状态，保留 manager lineage。
- `manager.cleanup` 在 `registration-pending` 状态下仍要求显式 `confirm` 且未取消，重试只调用 Rust unregister，不重复执行已经完成的 Git 删除；只有 unregister 成功后才回到 `cleaned`。
- 新增 Tauri session RED→GREEN 回归，覆盖首次 unregister 失败、状态保留和第二次成功收敛；不触碰真实 fixture 或用户项目。
- 验证结果：`npm run test` 为 109 个测试文件、924 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 40 个 Rust 测试通过；`git diff --check` 通过；定向 `src/dev/session.tauri.test.ts` 为 2 tests passed。
- 本切片仍未通过新的独立 reviewer；当前 snapshot 只作为本地 unverified checkpoint，未 push；既有 success worktree 未清理。

### 7.55 对齐 Node WorktreeManager 与 Rust Worker target 接受集

- Phase 2 hardening 第二个垂直切片针对 Node/headless 可创建、Tauri 拒绝的路径分叉：显式 `worker/<basename>` 分支现在要求目标规范化后位于 `<base>-workers` sibling root，branch suffix 必须等于 target basename；raw path 中的 `.`/`..` 组件直接 fail-closed。
- 通用 `dev-...` WorktreeManager 语义保持不变；Worker-scoped create/restore 在 Git 调用前拒绝 root 外、折返、branch-basename 不一致的记录，Node fixture 与 Rust target gate 共用同一接受集。
- 更新 dev node/session 测试夹具到直接 Worker sibling root，并新增 create/restore、mixed separator、折返路径回归。
- 验证结果：`npm run test` 为 109 个测试文件、925 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 40 个 Rust 测试通过；`git diff --check` 通过；相关 targeted suite 为 5 个文件、38 个测试通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.56 将 Worker execution start 收敛到原子 claim

- Phase 2 hardening 第三个垂直切片修复 side-effect journal 的残留竞态：`createWorkerSideEffectRecorder.start()` 不再执行 `read → record(planned) → record(started)`，而是统一委托持有 journal lock 的 `repository.claim()`。
- 同一 execution/attempt 并发调用 `start()` 时只允许一个 caller 获得 `started` record；其它 caller 明确拒绝，不会观察到“账本里没有记录”后重复触碰 Worker 外部副作用。已有 `receipt`、`started`、`unknown` 状态继续 fail-closed，必须走恢复/核对路径。
- 新增并发 RED→GREEN 回归，覆盖原子 claim 后 journal 只保留一条 started record；没有改变默认 `claim()` queue 路径或既有 recovery 语义。
- 验证结果：`npm run test` 为 109 个测试文件、926 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 40 个 Rust 测试通过；`git diff --check` 通过；相关 targeted suite 为 3 个文件、41 个测试通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.57 关键 Evidence addAsync 增加 exact read-back

- Phase 2 hardening 第四个垂直切片修复 Evidence durable 边界：`EvidenceCollector.addAsync()` 在 persistence append 成功后重新 `load()`，要求同一 Evidence ID 存在且 JSON 内容完全一致；缺失、内容漂移或 read 失败都会移除内存记录并拒绝继续验收。
- 普通 `add()` 仍保留异步采集语义；Worker acceptance 使用 `addAsync`/`flushAndByScope` 的关键证据不会再把“append 已 resolve”误当作真实落盘。同步更新 acceptance 测试 fake persistence，使其模拟可读回的 durable store；无 persistence 和 append 失败用例仍保持 fail-closed。
- 新增 append 静默丢写的 RED→GREEN 回归；真实 JSONL store 的跨会话 load 测试继续通过。
- 验证结果：`npm run test` 为 109 个测试文件、927 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 40 个 Rust 测试通过；`git diff --check` 通过；相关 targeted suite `src/dev/evidence.test.ts` 为 9 个测试通过，`src/dev/workerAcceptance.test.ts` 为 8 个测试通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.58 取消后的 Worktree rollback 保留 lineage

- Phase 2 hardening 第五个垂直切片修复 add-after-cancel 的恢复缺口：`WorktreeManager.create()` 在 Git `worktree add` 已成功但 signal 随后取消时，先登记完整 `WorktreeInfo`，再执行 rollback；rollback 失败不再返回 `null` 丢失现场。
- rollback 的 remove 失败保留 `created` 状态供后续显式 retry；remove 成功但 branch 删除失败转为 `orphaned`，成功完成两步才清除 manager 记录。普通 cleanup 复用同一收敛 helper；成功取消的既有行为仍不残留记录。
- 新增 cancellation rollback 失败 RED→GREEN 回归，覆盖“已应用但未完全清理”的 Worktree lineage 保留；避免 Tauri 包装层在未注册前误触发 unregister。
- 验证结果：`npm run test` 为 109 个测试文件、928 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 40 个 Rust 测试通过；`git diff --check` 通过；相关 targeted suite 为 5 个文件、46 个测试通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.59 GUI DevSession 初始化改为同项目 single-flight

- Phase 2 hardening 第六个垂直切片收敛 session transition：同一项目的并发 `ensureGuiDevSession` caller 现在共享一个初始化 Promise，只执行一次 `dev_init_session`，并返回同一个 DevSession/host generation；不再让两个 caller 同时创建 Rust session 后再互相清理。
- 不同项目会递增前端 lifecycle generation 使旧初始化失效；旧 host generation 仍通过 stale clear 路径清理。teardown 会清空 in-flight 引用并保留既有 registry/session reset 顺序。
- 新增真实 Tauri bridge mock 下的并发回归，验证单次 host init、同一 session 返回和现有 session/tauri-run 回归。
- 验证结果：`npm run test` 为 109 个测试文件、929 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 40 个 Rust 测试通过；`git diff --check` 通过；相关 targeted suite 为 4 个文件、20 个测试通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.60 orphaned branch retry 增加 tip provenance fencing

- Phase 2 hardening 第七个垂直切片修复同名 branch 重建风险：Worktree remove 成功但 branch delete 失败进入 `orphaned` 时，记录当时 `refs/heads/<branch>` 的 tip revision；后续 branch-only retry 必须先 read-back 同一 tip，revision 不同、不可读或缺少 provenance 都 fail-closed，不调用 `git branch -D`。
- 普通 cleanup 与取消 rollback 共用同一 provenance capture；既有 branch retry 在 tip 未变化时继续通过，worktree 不会被重复 remove。
- 新增 branch 同名重建回归，证明旧 orphan 不会删除新 branch。该切片暂未把 `branchRevision` 扩展进 ProjectControl durable schema；因此重启后没有该 provenance 的旧 orphan 只能拒绝自动 branch retry，等待显式重建/人工核对。
- 验证结果：`npm run test` 为 109 个测试文件、930 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 40 个 Rust 测试通过；`git diff --check` 通过；相关 targeted suite 为 6 个文件、49 个测试通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.61 Evidence restart load 增加 ID conflict reconciliation

- Phase 2 hardening 第八个垂直切片修复重启读取边界：`EvidenceCollector.loadPersisted()` 现在先 decode 全部记录，在临时 ID map 中拒绝同 ID 不同内容，再与当前内存记录做冲突校验，最后一次性合并唯一记录；冲突不会留下半恢复内存状态，完全相同的重复行只保留一条。
- 这样 JSONL 重复/篡改不会通过“逐条 restore”混入 EvidenceCollector；`capturedBy`、lineage 和已有 decode 校验继续生效。
- 新增冲突 duplicate ID RED→GREEN 回归；append/read-back 与跨会话 JSONL 测试继续通过。
- 验证结果：`npm run test` 为 109 个测试文件、931 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 40 个 Rust 测试通过；`git diff --check` 通过；相关 targeted `src/dev/evidence.test.ts` 为 10 个测试通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.62 canonical Worker side-effect hash 绑定 path/branch

- Phase 2 hardening 第九个垂直切片补齐 side-effect claim provenance：canonical Worker execution `inputHash` 现在包含 run、task/version、attempt、base revision、exact worktree path 和 branch；同一 execution/attempt 的 pending record 不能被另一条 path/branch lease 接管。
- legacy idempotency key/hash 仍按旧格式读取，用于显式兼容迁移；新的 canonical claim 与 receipt 校验使用完整 path/branch binding。claim 冲突发生在持锁 journal 更新前，不会把 pending 状态推进成 started。
- 新增 pending claim 被移动 Worker path/branch 接管的 RED→GREEN 回归；并发 claim、receipt、recovery 测试继续通过。
- 验证结果：`npm run test` 为 109 个测试文件、932 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 40 个 Rust 测试通过；`git diff --check` 通过；相关 targeted suite 为 3 个文件、42 个测试通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.63 claim/lock safety 修复与 stale-reviewer findings 复现

- 针对旧 reviewer 报告、并重新在当前代码复现后修复三类问题：`WorkerSideEffectRecorder.start` 改为闭包引用，解构调用不再因 `this` 丢失而抛 TypeError；SideEffectJournal claim 拒绝 canonical/legacy alias 同时存在；仅命中缺少 taskExecution/attempt lineage 的 legacy planned 记录时 fail-closed，不升级为 started。
- Tauri Rust `event_lock_acquire` 移除同进程持锁立即报错的 early return，第二个同路径 caller现在通过已有 create-new + bounded wait逻辑等待首个 holder释放；跨进程锁和5秒超时语义保留。新增线程级 Rust 回归覆盖等待、release和再次释放锁文件。
- 这些修复不把旧 reviewer 的 stale snapshot verdict升级为 approval；它只提供了可复现问题线索，当前累计 reviewer仍需针对最新 HEAD重新返回严格 JSON。
- 验证结果：`npm run test` 为 109 个测试文件、935 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 40 个 Rust 测试通过；`git diff --check` 通过；相关 TS targeted suite 为 2 个文件、21 个测试通过；Rust lock targeted test通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.64 Evidence verification 统一追踪与通用 accept durable gate

- Phase 2 hardening 第十一个垂直切片收敛 Evidence 持久化失败语义：`addAsync` 把 append、load、exact read-back放进同一个 tracked promise；同步/异步 append失败、read-back缺失/重复/漂移都会回滚当前对象并写入 persistErrors，`flush` 会等待完整 verification而不是只等待 append。fire-and-forget `add` 同样捕获同步 append throw。
- Evidence ID 优先使用 `crypto.randomUUID()`，fallback 保留进程内序号+随机尾段；read-back要求目标 ID 恰好一条，避免旧同 ID记录误认本次写入。
- 通用 `dev.accept` 现在和 `createDevWorkerAcceptance` 一样，必须配置宿主 EvidencePersistence；仅内存 Evidence 不能产生通过的 Acceptance。新增同步失败、duplicate read-back、deferred flush 和 no-persistence accept 回归。
- 验证结果：`npm run test` 为 109 个测试文件、940 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 40 个 Rust 测试通过；`git diff --check` 通过；相关 targeted suite `src/dev/evidence.test.ts` 为 14 个测试、`src/nodes/dev/index.test.ts` 为 20 个测试通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.65 registration-pending cleanup convergence 与双宿主 glob parity

- Phase 2 hardening 第十二个垂直切片收敛宿主注销失败后的恢复链：`WorktreeManager.getByPath()` 现在保留 `registration-pending` lineage，`DevSession.confirmAndCleanup()` 在 Git worktree/branch 已删除后跳过签名重算，仅重新校验原 Acceptance/base revision 并执行 `dev_unregister_worktree`；因此 retry 不会把已删除路径当作仍可读的 worktree。
- session wrapper 增加 Rust registration success fencing：初始 `dev_register_worktree` 从未成功时，后续 Git rollback 完成不得误调用 `dev_unregister_worktree`；只有已成功登记的 Worker 才进入 unregister retry。
- Node/Rust command policy 对齐：Rust worktree lexical guard 允许直接 spawn 下的 `*`/`?` find/grep pattern operand，仍拒绝 shell 重定向、拼接、绝对路径、`..` 与危险 find/grep 选项。
- 修复 Rust symlink-write 单测 fixture：测试 helper 建立有效 generation 并在 teardown 时推进 generation；`normal_write_within_worktree_ok` 可独立运行，不依赖其它测试污染全局状态。
- 验证结果：`npm run test` 为 109 个测试文件、942 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 41 个 Rust 测试通过；独立 `normal_write_within_worktree_ok` 通过；相关 TS targeted suite 为 2 个文件、11 个测试通过；`git diff --check` 通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.66 branch provenance CAS cleanup 与 orphan restart lineage

- Phase 2 hardening 第十三个垂直切片修复 Worker branch cleanup 的 TOCTOU：`WorktreeManager` 在删除 worktree 前用 `git rev-parse --verify --end-of-options refs/heads/<branch>^{commit}` 读取完整 tip OID，删除改为 `git update-ref -d refs/heads/<branch> <expected-oid>` 原子 compare-and-delete；不再使用无条件 `git branch -D`。tip读取失败、OID非法、CAS失败或 runner异常均 fail-closed；CAS失败保存删除前的 expected provenance，不采集失败后的新 tip。
- 正常 cleanup 与 orphan retry 共用 branch CAS语义；取消在 provenance read/remove 尚未开始前生效，Git remove 一旦开始则继续 branch CAS收尾；新增 tip读取失败、读取期间取消、CAS命令和无 branch-D 回归。
- Rust/Tauri 主仓库 allowlist 增加严格 worker branch tip read 与 CAS delete，仅允许当前 registered/pending worker branch、完整40/64位 object ID和精确 refs/heads/worker/*；pending lease 在 CAS成功后消费，旧 `branch -D` mutation path移除。真实 Git lifecycle test覆盖 add→tip read→remove→CAS delete→lease consume。
- orphan `WorktreeInfo` 支持 restart restore：通过 branch provenance read-back 恢复 branch-only lineage，不要求 live worktree list；Tauri session restore 不会为已删除 worktree重新 register/unregister。Node/Rust/Dev node测试 fake 同步完整OID/CAS契约。
- 验证结果：`npm run test` 为 109 个测试文件、947 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 41 个 Rust 测试通过；相关 TS targeted suite 为 3 个文件、30 个测试通过；`git diff --check` 通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.67 legacy alias lineage compatibility 与锁文件删除竞态

- Phase 2 hardening 第十四个垂直切片修复 Worker side-effect legacy migration：`legacyPlanned` 现在携带当前 lease 的 `taskExecutionId/attemptId`，因此已有完整 lineage 的 legacy planned record 可以在锁内安全升级为 canonical started；仍缺失 lineage 的旧记录继续 fail-closed，不被隐式执行。
- Rust event lock 增加同进程 reservation：在 `held_locks` mutex 内完成已有持有者检查、`create_new`、锁文件写入和 HeldLock 登记。即使外部修复流程删除仍被首 caller 持有的 lock file，第二同进程 caller 也不能创建新锁并覆盖首记录；必须等待首 caller release。新增删除锁文件期间 waiter 回归。
- 验证结果：`npm run test` 为 109 个测试文件、948 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 42 个 Rust 测试通过；相关 TS targeted suite 为 2 个文件、22 个测试通过；`cargo test event_store::tests` 为 4 个测试通过；`git diff --check` 通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.68 重启 orphan 的用户确认清理路径

- Phase 2 hardening 第十五个垂直切片补齐 orphan restart lineage 的用户路径：`WorktreeManager.getByPath()` 纳入 `orphaned`，`DevSession.confirmAndCleanup()` 对 orphan 与 registration-pending 共用 approval、Acceptance、base revision 校验，跳过已删除 worktree 的 signature 读取，直接执行 branch-only CAS cleanup。
- 新增真实 Tauri session 语义回归：恢复后的 orphan 不会重新 register，也不会因为不存在 worktree 而触发 `assertTracked`/signature 失败；用户确认仍可完成 branch cleanup。
- 验证结果：`npm run test` 为 109 个测试文件、949 个测试通过；`npm run build` 通过（保留既有 dynamic/static import 与大 chunk warning）；`npm run i18n:check` 为 991 个 key 对齐；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 42 个 Rust 测试通过；相关 TS targeted suite 为 3 个文件、31 个测试通过；`git diff --check` 通过。
- 本切片仍未通过新的独立 reviewer；成功 worktree 未清理，未 push。

### 7.69 Worker consistency canonical hash 与 registered path identity fencing

- Phase 2 hardening 第十六个垂直切片修复 side-effect 审计分叉：`workerRunConsistency` 现在按 canonical worker key 校验包含 `path/branch` 的 7 元 inputHash；旧 5 元 hash 只在明确 legacy key 下兼容，canonical key 的未绑定路径记录 fail-closed。
- Rust host gate 不再在每次请求中重新 canonicalize 已登记 `base_repo/worktrees`；这些字符串被视为 registration-time stable identity，只 canonicalize 请求路径，避免登记目录被 junction/reparse 替换后外部路径同时匹配。新增 Windows replacement regression（使用专用 `D:/Temp/slimemold-test-runs` fixture root）。
- 验证结果：`npm run test` 为 109 个测试文件、950 个测试通过；`npm run build` 通过并保留既有 dynamic/static import 与 chunk warning；`npm run i18n:check` 为 991 keys 对齐；`cargo fmt --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml' -- --check` 与 `cargo test --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml'` 通过（43 tests）；`git diff --check` 通过。



### 7.70 Node EventStore path boundary 与 reparse gate

- Phase 2 hardening 第十七个垂直切片修复 Node/headless EventStore adapter 的路径边界：`assertInsideRoot` 现在解析分隔符、`.`/`..`、Windows drive/UNC 和平台大小写规则；读、原子写、跨进程 lock 都在 filesystem 操作前后执行 root realpath、ancestor `lstat` 和 nearest-existing realpath 校验，拒绝 root/ancestor junction 或 symlink 被重定向到外部。
- 新增 lexical parent traversal 与 root reparse replacement 回归；测试生成物继续位于专用临时根。
- 验证结果：`npm run test` 为 109 个测试文件、952 个测试通过；`npm run build` 通过并保留既有 dynamic/static import 与大 chunk warning；`npm run i18n:check` 为 991 keys 对齐；`cargo fmt --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml' -- --check` 与 `cargo test --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml'` 通过（43 tests）；`git diff --check` 通过。

### 7.71 Worker recovery provenance validator 与成功 receipt Evidence gate

- Phase 2 hardening 第十八个垂直切片收紧 Worker recovery：started/unknown effect 必须是当前 `worker-execution` canonical key，包含完整 7 元 inputHash、target、task/attempt lineage 与 assignment path/branch/baseRevision；legacy 5 元 hash 不再直接进入 retry/skip，需显式 migration；cleanup 或伪造 kind 不会被 worker recovery 标记 unknown。
- `applyWorkerRunRecoveryDecision` 重新校验当前 task 的 worktreeId、path、branch、baseRevision 与 effect hash；`complete(succeeded)` 要求非空 host Evidence IDs，失败 receipt仍保留错误语义。
- 验证结果：`npm run test` 为 109 个测试文件、955 个测试通过；`npm run build` 通过并保留既有 dynamic/static import 与大 chunk warning；`npm run i18n:check` 为 991 keys 对齐；`cargo fmt --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml' -- --check` 与 `cargo test --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml'` 通过（43 tests）；`git diff --check` 通过。

### 7.72 SideEffect journal durable write/read-back

- Phase 2 hardening 第十九个垂直切片修复副作用账本的 durable 证明：`record`、canonical/legacy `claim` 和显式 migration 现在统一在锁内写入后 reload，并比较 canonical serialized journal；silent-drop、partial write、needs-repair 或 read-back mismatch 均 fail-closed，不返回成功 claim/receipt。
- 新增 silent-drop adapter 回归；保留 canonical/legacy alias、lineage、receipt 与 recovery validator 约束。
- 验证结果：`npm run test` 为 109 个测试文件、956 个测试通过；`npm run build` 通过并保留既有 dynamic/static import 与大 chunk warning；`npm run i18n:check` 为 991 keys 对齐；`cargo fmt --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml' -- --check` 与 `cargo test --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml'` 通过（43 tests）；`git diff --check` 通过。

### 7.73 GUI orphan/registration-pending retry 与 grep 外部输入选项

- Phase 2 hardening 第二十个垂直切片修复 DevSessionPanel 调用链：`registration-pending/orphaned` worktree 重试复用既有未消费 approval，直接进入宿主 `confirmAndCleanup` 的 unregister/branch-only 路径，不再对已删除 worktree 重新计算 signature。
- Node capability regression 覆盖 grep `--file`、`-f`、`--exclude-from` 的外部输入选项；当前 `/outside` 与 Windows drive-form参数均经过双宿主策略检查。
- 验证结果：targeted component/capability tests 为 3 个文件、23 个测试通过；`npm run test` 为 109 个测试文件、956 个测试通过；`npm run build` 通过并保留既有 dynamic/static import 与大 chunk warning；`npm run i18n:check` 为 991 keys 对齐；`cargo fmt --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml' -- --check` 与 `cargo test --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml'` 通过（43 tests）；`git diff --check` 通过。

### 7.74 SideEffect read-back lock ordering 与 migration safety

- Phase 2 hardening 第二十一个垂直切片修复 journal read-back 的二阶问题：`record/migrate` 现在 await 完整 write+read-back 后才释放锁；expected/persisted journal 必须都是 `ok`；migration replacement 先 decode，legacy/canonical 同 key 直接 conflict；claim 返回 read-back 后的实际 durable entry。
- 新增延迟写入锁顺序、同 key migration 和 durable entry 回归；避免释放锁后仍在写入、删除唯一 receipt、或调用方继续使用未核验对象。
- 验证结果：`npm run test` 为 109 个测试文件、958 个测试通过；`npm run build` 通过并保留既有 dynamic/static import 与大 chunk warning；`npm run i18n:check` 为 991 keys 对齐；`cargo fmt --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml' -- --check` 与 `cargo test --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml'` 通过（43 tests）；`git diff --check` 通过。

### 7.75 destructive cleanup 完成后的 cancellation/approval 收敛

- Phase 2 hardening 第二十二个垂直切片修复 `confirmAndCleanup` 的取消竞态：若 manager 已返回 cleaned，操作事实已发生，session 现在先消费 approval 并返回成功；只有 cleanup 未发生时才将取消返回为 false，避免已删除 worktree 保留可重放 approval。
- 新增 signal 在 destructive cleanup 完成后到达的回归；registration-pending/orphaned retry 仍走 branch-only/unregister-only 专用路径。
- 验证结果：`npm run test` 为 109 个测试文件、959 个测试通过；`npm run build` 通过并保留既有 dynamic/static import 与大 chunk warning；`npm run i18n:check` 为 991 keys 对齐；`cargo fmt --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml' -- --check` 与 `cargo test --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml'` 通过（43 tests）；`git diff --check` 通过。

### 7.76 Node grep 外部文件选项双宿主 denylist

- Phase 2 hardening 第二十三个垂直切片把 grep 外部输入选项从“测试覆盖”落实为 Node policy：拒绝 `--file`、`--file=...`、`-f...`、`--exclude-from`、`--exclude-from=...`，防止 pattern/排除规则从 worktree 外部读取；Rust 原有 unknown-option fail-closed gate保持一致。
- 新增 allowed pattern 的真实 runner-not-called regression，避免此前使用不在 allowedPaths 的 pattern 导致测试被路径守卫提前拒绝而产生假覆盖。
- 验证结果：`npm run test` 为 109 个测试文件、959 个测试通过；`npm run build` 通过并保留既有 dynamic/static import 与大 chunk warning；`npm run i18n:check` 为 991 keys 对齐；`cargo fmt --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml' -- --check` 与 `cargo test --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml'` 通过（43 tests）；`git diff --check` 通过。

### 7.77 Worker provenance/Evidence gate 与 grep 选项边界

- Phase 2 hardening 第二十四个垂直切片修复当前 reviewer 复现的 fail-open：Node grep 拒绝包含 `f` 的 GNU 短选项组合（如 `-if...`、`-Ff...`），并用 allowed pattern + runner-not-called 回归避免路径守卫假通过；Node `capabilities` 与 Evidence 的 missing-file 判断不再把任意 `permission denied ... not found` 文本吞成空文件。
- `workerSideEffects` 统一把 canonical worker-execution validator 接入 `complete`、`markUnknown`、recovery plan 和 interrupted recovery，校验派生 task execution lineage、7 元 assignment hash、started/receipt 状态；recovery 先全量预验证，禁止混合 valid/stale effect 部分变更，并以 `AbortError` 保留取消分类。
- 成功 Worker receipt 现在要求非空、非重复 Evidence ID；没有 host Evidence verifier 直接 fail-closed；新增可复用 verifier 对持久化 Evidence 做唯一 read-back、`capturedBy=host`、`status=passed`、execution/attempt/path/baseRevision provenance 校验。Worker queue 生成/恢复 succeeded 状态同样拒绝空或重复 Evidence。
- 验证结果：`npm run test` 为 109 个测试文件、970 个测试通过；`npm run build` 通过并保留既有 dynamic/static import 与大 chunk warning；`npm run i18n:check` 为 991 keys 对齐；`cargo fmt --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml' -- --check` 与 `cargo test --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml'` 通过（43 tests）；`git diff --check` 通过。

### 7.78 Restart worktree provenance、approval lineage 与 cleanup terminalization

- Phase 2 hardening 第二十五个垂直切片把 Worktree 状态事实写入 WorkerQueueTask：持久化 `worktreeStatus`、`branchRevision`、`cleanupStateSignature`，App restart 按真实 status/branch provenance restore；`registration-pending` 可在无 live worktree 时恢复并等待 unregister retry，orphan proposal 使用持久化 signature/branch-only CAS，不再重新读取已删除 worktree。
- cleanup approval 现在绑定具体 `worktreeId`、branch 以及 run/task/taskExecution/attempt lineage；confirm gate 同时核对当前 WorktreeInfo 与 passed Acceptance 全部 identity，阻断同路径复用旧 approval/Acceptance。
- Evidence projection 对 durable duplicate ID 和 current/incoming 内容冲突 fail-closed，禁止 restart merge last-write-wins；cleanup host gate 已完成 destructive mutation 后即使 cancellation 到达也会先写成功 receipt；App recovery 传递 operation signal。
- 验证结果：`npm run test` 为 109 个测试文件、975 个测试通过；`npm run build` 通过并保留既有 dynamic/static import 与大 chunk warning；`npm run i18n:check` 为 991 keys 对齐；`cargo fmt --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml' -- --check` 与 `cargo test --manifest-path 'D:/code/slimeMold/src-tauri/Cargo.toml'` 通过（43 tests）；`git diff --check` 通过。

### 7.79 Evidence merge、restart cleanup provenance 与真实 GUI 成功验收

- 针对最新 reviewer 复现的 fail-open，`workerEvidence.indexEvidence` 现在对所有 current/incoming/durable 输入先执行 `decodeEvidenceRecord`；直接注入 `capturedBy:'agent'`、损坏 schema 或重复冲突记录均 fail-closed。`WorkerQueue.claimTask` 将 `worktreeStatus:'created'` 写入持久 task state，而不是只写 `TaskStarted` payload；restore decoder 对非法 worktreeStatus、orphan/registration-pending 缺少 branchRevision、cleaned 缺少 cleanup receipt 直接拒绝，旧格式缺少新字段仍可迁移。
- `registration-pending` restore 不再误调用 `dev_register_worktree`；Rust `dev_unregister_worktree` 在 generation、受控 Worker target、非 live worktree、branch 已删除且非 pending rollback 的前提下幂等成功，避免新宿主 generation 已丢登记时 cleanup 永远卡死。orphan/pending cleanup proposal 必须保留 branchRevision，并通过显式 `branchRevisionRequired` 绑定 CAS gate；Worktree cleanup 成功写入 cleaned 状态时保留实际 branchRevision。
- App 项目重开在 Worker restore 和事实审计后重新生成 cleanup proposals；cleanup receipt 已 durable 后，即使 operation signal 取消，也会先终态化 Worker task，保存 ProjectFile 并重新打开 read-back 核对 worktreeStatus、cleanupStatus、cleanupReceiptId、branchRevision 和 cleanupStateSignature，不把已完成 destructive action 返回成未收尾状态。
- 在 disposable fixture `D:/Temp/slimemold-tauri-e2e-20260904-203708` 中重新导入成功 workflow，通过真实 Tauri WebView DOM 运行 `runId=4`；新 Worker worktree `mvp-gui-success-wt-3` 创建成功，结构化 patch、compile、test、diff、path-policy Evidence 和 `Acceptance passed=true` 均已从磁盘 read-back，真实文件位于该成功 worktree。保存三张真实 GUI/WebView 截图：`screenshots/01-worker-success.png`、`screenshots/02-acceptance-passed.png`、`screenshots/03-patch-evidence.png`。

本轮最终验证结果：

- `npm run test`：109 个测试文件、979 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有 dynamic/static import 与大 chunk warning）；
- `npm run i18n:check`：991 keys 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：43 个 Rust 测试通过；
- `git diff --check`：通过。

本轮只建立本地 `unverified` checkpoint，不 push；独立 reviewer 尚未针对当前最终 snapshot 返回 approval。成功 worktree 和截图 fixture 保留，未执行用户批准之外的 Delivery/Cleanup；OS 级 no-follow/TOCTOU、跨进程真实压力验证、不可信 package script 隔离以及完整 DeliveryReceipt 仍未完成。

### 7.80 最小项目交付闭环与真实项目生产档案

- 为 `dev.evidence.add` 增加可选的 Worker `runId/taskId/taskExecutionId/attemptId` lineage；当四项同时存在时先执行 canonical 校验，再写入 Evidence。新增回归证明带 lineage 的 Evidence 能被同 attempt 的 `dev.accept` 读取，避免 Acceptance 通过但 Evidence 无法关联到 Delivery 的断链。
- 在 disposable fixture `D:/Temp/slimemold-tauri-e2e-20260904-203708` 中重新执行真实 Tauri GUI success：最终 `runId=2`、`taskId=accept`、`attemptId=task-execution:2:accept:attempt-1`，Worker worktree 为 `mvp-gui-success-wt-6`，compile/test/diff/path-policy 和 4 条 host Evidence 均通过，Acceptance `acc-mtopto7s-c3a9c07f` 为 `passed=true`。
- 通过现有 `workerDelivery` host API 完成最小真实 Delivery：创建 `ArtifactCandidate`、用户 approval、目标项目写入、逐文件 hash/read-back 和 `DeliveryReceipt`；目标项目为 `mvp-delivery-target-7`，交付 `src/components/greeting.js` 与 `tests/greeting.test.js`。第一版 no-overwrite 边界将 `src/components/baseline.js` 明确记录为 excluded，没有静默覆盖已有文件。
- 目标 fixture 真实生成 worker commit `944a67a` 与 merge commit `f2fc91d`；目标最终工作树 clean，目标项目测试通过。生成最小项目生产档案：`project-manifest-run-2.json`、`plan-run-2.md`、`construction-log-run-2.md`、`evidence-index-run-2.json`、`git-record-run-2.json` 和 `delivery-manifest-run-2.json`，包含计划、施工步骤、Evidence、时间、实际 Git 历史、交付 Receipt 和未计量成本说明。
- 保存最终真实 WebView 截图：`screenshots/04-run2-worker.png` 与 `screenshots/05-run2-acceptance.png`；两张截图与 run 2 的 Worktree/Acceptance lineage 一致。

本轮最终验证结果：

- `npm run test`：109 个测试文件、980 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有 dynamic/static import 与大 chunk warning）；
- `npm run i18n:check`：991 keys 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：43 个 Rust 测试通过；
- `git diff --check`：通过；
- 真实 Tauri fixture：GUI worktree → patch → compile/test/diff → lineage Evidence → Acceptance → ArtifactCandidate → user approval → target read-back → worker commit/merge，通过。

本轮建立本地 `unverified` checkpoint，不 push；Delivery/Cleanup 的完整 GUI 面板、重启 read-back 和 CleanupReceipt 仍未完成。第一版 MVP 当前证明的是一个小型可运行项目的受控生产与交付，不宣称通用覆盖已有文件、完整成本计量、任意 Artifact 类型或无人值守运维。

### 7.81 Restart read-back、用户批准 CleanupReceipt 与最终质量门

- 通过产品自己的“保存项目”入口把最终 run 2 写回 ProjectFile，read-back 确认 `.slimemold/project.json` 的 `updatedAt=2026-09-06T04:21:34.268Z`、run history、Worker path 和 Acceptance lineage 均已持久化；结束旧 Tauri dev 树后重新启动真实 Tauri GUI，新窗口恢复同一 workflow，并从持久化项目加载成功状态。保存 `screenshots/06-run2-restart-acceptance.png`。
- 修复 cleanup proposal 对通用 workflow 的过强假设：`buildWorkerCleanupProposal` 继续绑定 task/run/execution/attempt/worktree/Acceptance identity，但 proposal 的 `stageId` 取已验证 Acceptance 的真实 stage，而不是硬编码为 taskId；WorkerQueue 的常规 `stageId=taskId` 行为不变。新增 stage 不同于 taskId 的 RED→GREEN 回归。
- 生成并 read-back `cleanup-proposal-run-2.json` 后取得用户明确批准；通过真实 `executeWorkerCleanupWithReceipt → confirmAndCleanup → Git CAS` 删除 `mvp-gui-success-wt-6` 及其 branch。CleanupReceipt 为 `cleanup:task-execution:2:accept:attempt-1:receipt`，`outcome=succeeded`，`outputHash=h1suf5fc`；目录不存在、branch ref 不存在，side-effect journal 为 durable receipt。历史尝试 worktree 未擅自删除。
- 目标交付 fixture `mvp-delivery-target-7` 仍保持 `master`、HEAD `f2fc91d`、工作树 clean；重新执行目标项目测试通过。更新 `cleanup-manifest-run-2.json`，将 restart、Delivery、Cleanup 与目标 read-back 绑定在同一 dossier。

本轮最终验证结果：

- `npm run test`：109 个测试文件、981 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有 dynamic/static import 与大 chunk warning）；
- `npm run i18n:check`：991 keys 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：43 个 Rust 测试通过；
- `git diff --check`：通过；
- 真实 Tauri：ProjectFile save → restart read-back → Acceptance 恢复 → 用户批准 Cleanup → CleanupReceipt durable read-back，通过。

本轮建立本地 `unverified` checkpoint，不 push；独立 reviewer 尚未针对本轮最终 snapshot 返回 approval。该 MVP 仍不宣称 OS 级 no-follow/TOCTOU、跨进程压力验证、不可信 package script 隔离和完整 GUI Delivery/Cleanup 面板已全部完成。

### 7.82 Reviewer fail-closed：Acceptance stage 重新绑定 TaskGraph

- 固定 HEAD `4e3111b51ac47a39bed8857b06ce9847c9b51df1` 的独立 reviewer 返回 `passed=false`：仅复制 `Acceptance.stageId` 到 cleanup proposal 会移除原有 `stageId === taskId` 的 fail-closed 约束，并与 `workerRunConsistency` 的既有审计契约冲突。
- 不保留该 fail-open 修复。新增 task-owned `acceptanceStageId`：默认从 `ProjectTask.stageId` 推导，未声明时退回 `taskId`；WorkerQueue 创建/restore 持久化并校验该字段与 TaskGraph 一致，旧 state 缺字段时只从可信 TaskGraph 补齐，显式 stage drift 直接拒绝恢复。
- cleanup proposal、Evidence/Acceptance consistency audit 统一使用同一 expected stage；Acceptance 自己声明的任意 stage 不能扩大清理授权范围。新增 proposal mismatch、consistency override、TaskGraph restore/tamper 回归。
- run 2 的真实 Delivery、restart read-back 和 CleanupReceipt 是此前 disposable execution 的历史事实；本轮只修正控制面 stage contract，不重复执行破坏性 Cleanup，也不把 reviewer 失败的 `4e` 标为 verified。

本轮最终验证结果：

- `npm run test`：109 个测试文件、984 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有 dynamic/static import 与大 chunk warning）；
- `npm run i18n:check`：991 keys 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：43 个 Rust 测试通过；
- `git diff --check`：通过。

本轮建立新的本地 `unverified` checkpoint：`39d53ce3f39a8f86a7a0c3a457cc3f5ace8e7259`，不 push；仍需针对新的最终 HEAD 重新进行独立 reviewer，不能沿用对 `4e` 的失败或任何旧 verdict。

### 7.83 Reviewer integration hardening：Acceptance、restore 与 GUI cleanup gate

- 固定 HEAD `af3a584` 的 reviewer 继续 fail-closed，发现三处集成问题：`workerAcceptance` 仍把 Evidence/Acceptance stage 硬编码为 task id；WorkerQueue restore 未拒绝 tasks map key 与 taskId 漂移；App cleanup proposal 可直接消费 raw ProjectFile WorkerRun，绕过 TaskGraph restore。
- `workerAcceptance` 现在使用 `ProjectTask.stageId ?? taskId` 的 canonical resolver 写入所有 Host Evidence 和 Acceptance；WorkerQueue restore 在 normalize 前校验 key/taskId identity；新增 `getRestoredWorkerRunForCleanup`，App proposal 刷新和 cleanup action 都必须先通过 TaskGraph-validated normalized snapshot，restore recovery 或 state drift 时不产生/不执行 Cleanup。
- 新增显式 stage Acceptance、key/taskId drift、runtime cleanup snapshot suppression 回归；不重新执行历史破坏性 Cleanup，保留此前 Receipt 的 execution provenance。

本轮最终验证结果：

- `npm run test`：109 个测试文件、986 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有 dynamic/static import 与大 chunk warning）；
- `npm run i18n:check`：991 keys 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：43 个 Rust 测试通过；
- `git diff --check`：通过。

本轮最终控制面 checkpoint：`49ed0e41e3a37ceb9d5448fb929cece7656f8076`，仍为本地 `unverified`，不 push；需要针对该最终 HEAD 重新进行独立 reviewer，不能把旧 `af3a584` verdict 迁移到新代码。

### 7.84 Cleanup fingerprint、生命周期与重复 TaskGraph fail-closed

- 固定 HEAD `4f0f221` 的 reviewer 继续发现 Cleanup host gate 边界：App 未绑定完整 approval fingerprint/lifecycle；旧 direct `DevSession`/node cleanup 可以绕过 Worker proposal；TaskGraph duplicate ID 仍 last-write-wins；legacy custom-stage 在 startup audit 前未使用可信 TaskGraph。
- 新增 canonical cleanup fingerprint，绑定 worktree/branch/base/branchRevision/stateSignature、Run/Task/Execution/Attempt、Acceptance/orchestration/stage 以及 `succeeded/active` lifecycle。Approval、receipt execution、Session host gate 和 App action 必须匹配同一 fingerprint；无 fingerprint 的 direct node/panel path 不再能删除 worktree。
- App cleanup 现在要求当前 trusted Task 为 `succeeded` 且未 cleaned；runtime 与 consistency audit 都拒绝重复 TaskGraph ID；consistency audit 使用传入的可信 TaskGraph.stageId 解释 legacy 缺失 `acceptanceStageId`，避免启动时把合法 legacy stage 报为 drift。
- 历史 run 2 CleanupReceipt 不重新执行、不改写 execution source provenance；本轮只修正未来 cleanup 控制面。

本轮最终验证结果：

- `npm run test`：109 个测试文件、987 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有 dynamic/static import 与大 chunk warning）；
- `npm run i18n:check`：991 keys 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：43 个 Rust 测试通过；
- `git diff --check`：通过。

本轮最终控制面 checkpoint：`df69b67bce0e2bcb9e33965f013d63ef74c7aeb2`，继续保持本地 `unverified`，不 push；待该 checkpoint 的 fresh reviewer 返回严格 JSON 后再决定是否可标记 verified。

### 7.85 Branch CAS、Attempt canonical 与启动审计 fail-closed

- 针对固定 HEAD `034d292` reviewer 的剩余问题，live cleanup proposal 现在在宿主侧捕获当前 branch tip，approval fingerprint 与 `branchRevision` CAS 同时覆盖 live/orphan/registration-pending；branch tip 变化会在确认门拒绝。
- Session host gate 现在验证 `taskExecutionId = createTaskExecutionId(runId, taskId)`、`attemptId = createAttemptId(taskExecutionId, attempt)`；App action 同时校验 attempt、orchestration、branchRevision、orphan cleanup signature 与 trusted Task lifecycle。
- `auditLoadedWorkerRunFacts` 遇到事件流/控制面读取异常时，为当前 Worker Runs 写入 `event-stream-invalid` recovery 并清空 cleanup proposals；consistency audit 只接受可信 TaskGraph.stageId，显式 persisted stage drift、缺失 Task 定义和重复 TaskGraph ID 均 fail-closed。

本轮最终验证结果：

- `npm run test`：109 个测试文件、988 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有 dynamic/static import 与大 chunk warning）；
- `npm run i18n:check`：991 keys 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：43 个 Rust 测试通过；
- `git diff --check`：通过。

本轮最终控制面 checkpoint：`70c3a6d7c9cba6817589c98a278387b4089cd21d`，仍为本地 `unverified`，不 push；需要对该最终 HEAD 重新进行独立 reviewer。

### 7.86 Final Cleanup CAS、legacy path removal 与 TaskGraph audit hardening

- 针对固定 HEAD `402d89b` reviewer 的剩余问题，ready Cleanup proposal 现在强制包含 `branchRevisionRequired=true` 和 branch tip；`WorktreeManager.cleanup` 接收批准的 revision，live worktree 在 remove/delete branch 前重新读取并用同一 revision 做 CAS，orphan 只使用 durable revision，registration-pending 不读取已删除 branch。
- Session host gate 要求强制 branch CAS、canonical attempt/lifecycle/fingerprint 和 trusted cleanup binding；`forceCleanup`、headless direct cleanup、旧 DevSessionPanel cleanup 按钮和 legacy `dev.worktree.cleanup` 不再形成第二套破坏性协议。
- consistency audit 在无 TaskGraph 时拒绝显式 persisted stage；有 TaskGraph 时同时校验 id、graphVersion、approved 状态和 task stage。新增 branch mutation、no-graph stage、graph-version 回归测试；历史 run 2 CleanupReceipt 不重新执行、不改写 execution source provenance。

本轮最终验证结果：

- `npm run test`：109 个测试文件、990 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有 dynamic/static import 与大 chunk warning）；
- `npm run i18n:check`：991 keys 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：43 个 Rust 测试通过；
- `git diff --check`：通过。

本轮最终控制面 checkpoint：`b3ca0910dcd29946c5eaa77c3f94cf96166bfe78`，仍为本地 `unverified`，不 push；必须针对该最终提交重新运行独立 reviewer，不能迁移旧 verdict。

### 7.87 Tauri mutation gate、Receipt reconciliation 与 Cleanup recovery

- 针对最终 reviewer 发现的 public `dev_exec` mutation bypass，通用 Tauri `dev_exec` 不再允许已登记 Worker 的 `git worktree remove` 或 `git update-ref -d`；pending rollback 仍仅在短生命周期 lease 内允许。正常 Worker Cleanup 通过专用 `dev_cleanup_worktree` atomic host command，携带 approved branch revision，并由 Rust 侧再次校验受控 Worker path/branch/session。
- startup 加载 side-effect journal 后，成功 CleanupReceipt 会在 ProjectFile/事件事实缺失时执行严格 lineage read-back reconciliation，补写 `TaskCleaned` 与 cleaned state；unknown/needs-user Cleanup 写入 `cleanup-unknown` Worker recovery 并抑制 proposals。
- audit/restore 失败、TaskGraph restore 失败和 stale run refresh 都清除旧 Cleanup proposals；recovery planner 支持 Cleanup unknown 的 inspect/skip 路径，禁止直接 retry 未知破坏性副作用。trusted cleanup binding 改为 session closure + proposal/approval matching，不再暴露可直接写入的 public Set。

本轮最终验证结果：

- `npm run test`：109 个测试文件、990 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过（保留既有 dynamic/static import 与大 chunk warning）；
- `npm run i18n:check`：991 keys 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：43 个 Rust 测试通过；
- `git diff --check`：通过。

本轮最终控制面 checkpoint：`f6b0a14bc08d93ac137ff26055882690d724f3fc`，仍为本地 `unverified`，不 push；必须针对该最终提交重新运行独立 reviewer，不能迁移旧 verdict。

### 7.88 Approval lifecycle、orphan restart registry 与 recovery reconciliation

- 修复 fresh reviewer 发现的正常 Cleanup 顺序回归：refresh 只生成 proposal；显式 approval 成功后才注册 trusted binding；host rejection/drift 会消费 approval 并使旧 fingerprint 失效。
- 将 `acceptanceStore`/`approvedCleanups` 移出公开 DevSession object，提供只读快照接口；Tauri orphan restore 新增 branch-only host registry，不重新注册不存在的 worktree。
- `dev_cleanup_worktree` 先执行 approved branch-revision CAS，再 remove worktree；generic `dev_exec` mutation 仍只保留 pending rollback lease。
- `started` cleanup effect 可在重启时转成 `unknown/needs-user`；cleanup unknown 可 inspect/skip，不可 retry；consistency audit 保留其 input-hash 结构和 recovery。
- 成功 CleanupReceipt reconciliation 的 save/read-back 失败会写 recovery、清空 cleanup proposals；stale/invalid approval 不再复用旧 binding。

验证结果：`npm run test` 为 109 个测试文件、990 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 991 keys 对齐；`cargo test --manifest-path src-tauri/Cargo.toml` 为 43 tests 通过；`cargo fmt --check` 通过；`git diff --check` 通过。Vite 既有动态 import/chunk size warning 未新增失败。

### 7.89 Existing orphan worktree restart compatibility

- branch CAS 已先于 worktree remove；若 CAS 成功但 remove 失败，orphan restore 允许匹配 Git worktree list 的 existing directory，同时继续拒绝不匹配路径；missing directory 仍走 branch-only registry。
- 最终代码 checkpoint：`d9ae7160e2264243583f329782f01fbc53a35564`，继续标记本地 `unverified`，未 push；fresh reviewer 必须针对该 HEAD。

### 7.90 MVP closure：真实交付闭环完成但控制面保持 unverified

- 最终 reviewer 针对 exact HEAD `1ac0ad34b4273bce38dd320ac4cc14e09644178e` 返回 `passed=false`；按 fail-closed 规则不使用 `[verified]`，也不 push。
- 本轮正式收口为 `mvp-closed-unverified`：真实 disposable 项目、Delivery、真实 Git merge、Restart read-back、用户批准 Cleanup、CleanupReceipt 和完整 production dossier 均保留；历史执行来源继续是 `4e3111b51ac47a39bed8857b06ce9847c9b51df1`，最终控制面实现是 `d9ae7160e2264243583f329782f01fbc53a35564`。
- reviewer 剩余问题归入 Phase 2 native host authority，而不是继续局部补 TypeScript gate：Rust-owned TaskGraph/Approval authority、destructive mutation capability、worktree identity race fencing、orphan terminal reconciliation、cleanup-unknown inspect/skip UI、conflict-aware side-effect merge 和持久化失败恢复。
- 同一最终工作树质量门：`npm run test` 为 109 个测试文件、990 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 991 keys 对齐；Rust 43 tests、fmt、diff-check 均通过。

### 7.91 Phase 2 第一条垂直切片：TaskGraph → Issue → execution/DAG projection

- 在独立分支 `phase2/taskgraph-issue-dag-projection` 建立第一条生产化控制面切片：`ProjectTaskGraph` 不再只停留在主控会话侧，生成任务图时同步 materialize 每个 Task 的稳定 Task Issue；批准任务图时把对应 Issue 推进到 `approved`。
- 新增 `src/projectControl/taskGraphProjection.ts`：用 deterministic `issue:task:<taskGraphId>:<taskId>` 关联同一 Task、Issue、依赖边、TaskExecution、Attempt、Evidence 和 Acceptance；执行状态映射为 Issue/DAG 可读状态；缺失 Issue、Task/Issue 关联漂移、Issue 状态漂移和 execution lineage 漂移显式保留为 consistency 状态，不静默修复。
- `generateTaskGraphCommand` 与 `approveTaskGraphCommand` 现在同时返回 ProjectControl snapshot 和可审计 `IssueCreated`/`IssueStatusChanged` facts；materialization 幂等，不重复创建 Task Issue。
- 本轮仍是控制面底座，不宣称完整 UI 双向编辑已完成：下一条切片需要把该 projection 接入 IssueBoard 与 DAG 视图，并让 Worker event projection 回写两者；当前主线仍保留 native host authority 的独立生产验证边界。

验证结果：`npm run test` 为 110 个测试文件、992 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 991 keys 对齐；`cargo test --manifest-path src-tauri/Cargo.toml` 为 43 tests 通过；`cargo fmt --check` 通过；`git diff --check` 通过。Vite 既有动态 import/chunk size warning 未新增失败。

### 7.92 IssueBoard 读通 Task execution lineage

- IssueBoard 现在从 `ProjectTaskGraph`、最新兼容 `WorkerRunQueueState` 和同一组 `taskId` 生成只读 Task projection；Issue 卡片可以显示关联 Task、当前执行列和 Evidence 数量，不再只显示独立 Issue 状态。
- 新增 Worker registry → canonical `DomainProjection` 适配，校验 `taskGraphId` 与 `taskGraphVersion`，再复用同一个 TaskGraph projection；组件不维护第二套执行状态，也不新增执行副作用入口。
- Issue、Task、TaskExecution、Attempt、Evidence 和 Acceptance 现在在 IssueBoard 上有第一条可见的 lineage；DAG 画布的同一 projection 接入仍是下一条切片，当前不宣称双向编辑已完成。

验证结果：`npm run test` 为 110 个测试文件、994 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 993 keys 对齐；`cargo test --manifest-path src-tauri/Cargo.toml` 为 43 tests 通过；`cargo fmt --check` 通过；`git diff --check` 通过。Vite 既有动态 import/chunk size warning 未新增失败。

### 7.93 专业 OrchestratorPanel 接入 TaskGraph DAG projection

- 新增 `TaskGraphDAGView`，只读渲染 canonical TaskGraph projection：Task 节点、依赖边、Issue、TaskExecution/Attempt、Evidence、Acceptance 和一致性状态均来自同一 projection；不开放第二套画布编辑或执行协议。
- OrchestratorPanel 根据当前 orchestration 的 `sourceTaskGraphId`/WorkerRun 选择 graph，校验 `taskGraphId` 与 `taskGraphVersion` 后显示 DAG；版本漂移或 lineage 不一致显示恢复边界，不静默画错状态。
- 现在的可见链路为：主控 TaskGraph → Task Issue → IssueBoard lineage → Orchestrator DAG → WorkerRun/Evidence/Acceptance；DAG 编辑命令、Issue↔DAG 互相定位和 plan revision 写回仍是后续切片。

验证结果：`npm run test` 为 111 个测试文件、995 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 1000 keys 对齐；`cargo test --manifest-path src-tauri/Cargo.toml` 为 43 tests 通过；`cargo fmt --check` 通过；`git diff --check` 通过。Vite 既有动态 import/chunk size warning 未新增失败。

### 7.94 Native cleanup capability 与 Worktree identity hardening

- Rust 的 Worktree registration 现在保存 `generation + canonical path + branch`，Cleanup 不再只按 path 认领对象；当前 Git worktree path/branch 漂移时 fail-closed。
- normal Worktree registration 必须消费当前 host 通过受控 `git worktree add` 产生的 pending lease，重复注册仅允许同一 identity 幂等返回。
- orphan recovery 对 missing path 要求受控 Worker branch 仍存在；existing path 仍必须与 Git worktree branch 精确匹配。
- Cleanup 新增 Rust-owned 一次性 capability：native revalidation + 原生确认对话框签发 token，destructive `dev_cleanup_worktree` 必须携带精确 token，成功后立即消费。
- `DevSession` 的 Acceptance 与 Cleanup approval 对外只返回深拷贝，避免调用方反向修改 durable approval snapshot。
- 验证：`npm run test` 为 `111` 个测试文件、`996` 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 `1000` keys 对齐；Rust `45` tests、Tauri session 定向 `27` tests、`cargo fmt --check` 和 `git diff --check` 通过。

### 7.95 TaskGraph DAG 双向 selection、revision command 与 Issue Command/Event 闭环

- OrchestratorPanel 的 DAG projection 与 IssueBoard 共享 `viewStore.taskGraphSelection`，selection 只保存 `projectId/taskGraphId/taskId/issueId`，不持久化为事实；Issue card 与 DAG node 互相高亮、可定位。
- DAG 选中 Task 后可提交 title/dependsOn 修改；`reviseTaskGraphCommand` 生成新 graph ID 和递增 graphVersion，写入 `revisionOf`，旧 graph 标记 `superseded`，新 Issue 重新 materialize，所有状态变化通过 DomainEvent 记录，禁止直接 mutate 旧 graph。
- revision command 拒绝 unknown dependency、self-loop 和 cycle；ready session 可回到 plan-review，executing session 不可修改任务图。
- IssueBoard 的 queue/approve/triage 改为 `transitionIssueCommand` + `IssueStatusChanged` + project event buffer/save，不再建立第二套 UI snapshot mutation。
- 增加 persistence round-trip regression：重启模拟后旧/new graph history、Task Issue ID、Task/DAG projection 仍可恢复；selection 保持临时状态。
- 验证：`npm run test` 为 `111` 个测试文件、`1004` 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 `1009` keys 对齐；Rust `45` tests、`cargo fmt --check`、`git diff --check` 通过。Vite 既有动态 import/chunk size warning 未新增失败。

### 7.96 Cleanup capability replay invalidation 与 revision-aware consistency audit

- Rust native cleanup capability 在 path/branch drift、CAS 删除失败、worktree remove 部分失败、session read-back drift 和 host probe error 后都会失效；错误 token 不再留下可重放的 destructive binding。无 fingerprint 的未授权调用仍只拒绝、不消耗合法 approval。
- Project control consistency audit 识别 `IssueStatusChanged`、`TaskGraphRevisionCreated`、`TaskGraphSuperseded`，能检查 Issue status drift 和 TaskGraph revision graphVersion/approval，不再把新 command/event 当成 orphan 或缺少 proposal。
- 保留未知 cleanup 的 durable `unknown/needs-user` 和 side-effect lock/claim/replay 约束；未重新执行真实 destructive cleanup。
- 验证：`npm run test` 为 `111` 个测试文件、`1005` 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 `1009` keys 对齐；Rust `45` tests、`cargo fmt --check`、`git diff --check` 通过。Vite 既有动态 import/chunk size warning 未新增失败。

### 7.97 Unassigned Issue transition 的项目事件流修复

- `transitionIssueCommand` 接受显式 project context；Issue 未认领时仍把 `IssueStatusChanged` 写入当前 project stream，避免 IssueBoard 的 event buffer 因 `issue:<id>` stream 与当前项目不一致而 fail。
- IssueBoard queue/approve/triage 的 command/event 路径现在同时覆盖 project-owned 与 unassigned Issue。
- 验证：`npm run test` 为 `111` 个测试文件、`1005` 个测试通过；此前同一最终工作树的 `npm run build`、`npm run i18n:check`、Rust `45` tests、`cargo fmt --check`、`git diff --check` 均通过。

### 7.98 Phase A/B 层级协议与项目规划闭环

- 新增 `src/projectControl/hierarchy.ts` 与 `protocol.ts`：定义 Master/Project Delivery Architect/Department/Module/Worker/Specialist 及横向审查角色；实现 `ChildScope = ParentScope ∩ PolicyScope ∩ ChildTaskScope`，并对文件、数据类别、工具、角色、depth/fan-out、Token、调用次数、费用、时限做最严格求交；结构化 Agent envelope、ContextPack、DelegationRequest 和 FeedbackRequest 具备第一版运行时边界校验。
- 新增 `src/projectControl/projectPlanning.ts` 与 planning types：承建方可生成带需求、方案、可行性、里程碑和部门 charter 引用的 `ProjectPlan` 草案；只有可行且无未决阻塞问题的计划才能批准；未批准计划不能创建 dispatched `DepartmentWorkPackage`；多模型 planning review 冻结 EvidencePack、保留全部 opinion 和少数意见。
- 将 ProjectPlan proposal/approval、Department Work Package dispatch 接入 `src/projectControl/commands.ts` 的 Command/Event；接入 `persistence.ts` 和 `projectControlConsistency.ts`，支持旧快照兼容、规划事实 read-back 和版本 drift 审计。未接入 UI、真实 Agent provider、递归调度或 Tauri Worker 执行，不能据此宣称层级化生产能力已完成。
- 验证结果：`npm run test` 为 `114` 个测试文件、`1026` 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 `1009` keys 对齐；本轮未修改 Rust，未重复运行 Rust 测试；`git diff --check` 通过。Vite 既有动态 import/chunk size warning 未新增失败。

### 7.99 Evidence projection、bounded retrieval 与 Worker feedback gate

- 新增 `progressSummary.ts`、`evidenceIndex.ts` 和 `retrieval.ts`：从 TaskGraph projection 聚合 evidence-backed ManagerBrief/TaskProgressCapsule；Evidence index 只保存结构化 metadata/terms，支持 exact ID、metadata、关键词候选、结果/Token 上限和跨项目拒绝，关键词结果不会单独成为事实或权限。
- 新增 `contextPack.ts` 与 `delegation.ts`：ContextPack 对文件、数据类别、工具和 Agent role 做显式访问判断；delegation graph 检查 project 隔离、幂等 key、fan-out 与 Task parent/child cycle。
- WorkerQueue 新增 `waiting-feedback` 状态和 `TaskFeedbackRequested` replay fact；FeedbackRequest 必须绑定当前 project/task/attempt，Run 在无 running 但存在等待反馈时保持 blocked；已 claim 的副作用在 waiting 前先进入 unknown，禁止生成非法 terminal receipt。
- 当前切片仍未实现 Feedback resolution/PlanRevision 自动重派、完整 Agent provider 调度、UI 投影、真实 Tauri disposable E2E 或独立 reviewer `passed=true`，控制面继续保持 `mvp-closed-unverified`。
- 验证结果：`npm run test` 为 `119` 个测试文件、`1041` 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 `1009` keys 对齐；本轮未修改 Rust，未重复运行 Rust 测试；`git diff --check` 通过。Vite 既有动态 import/chunk size warning 未新增失败。

### 7.100 Bounded Budget、Release Gate 与 DAG expansion

- 新增 `src/projectControl/budget.ts`：以 reserve/settle ledger 控制 token、调用次数、费用和时长；reservation 具备 project/task 归属和幂等重放，超额 settlement 明确返回 `over-budget`，安全整数溢出拒绝。
- 新增 `releaseGate.ts`：QA、Security、Integration receipt 必须项目一致、通过、独立且无 blocking issue；固定 slot kind 校验和高影响用户批准门只生成 `ready/blocked` candidate，不直接执行 release。
- 新增 `taskGraphExpansion.ts`：动态新增任务必须引用 Evidence、绑定 source、通过数量/depth/fan-out/依赖环校验；审批前不改图，审批时重新校验 proposal 与 base graph version，并通过既有 `reviseTaskGraph` 生成新 graph revision。
- 本轮独立 reviewer 曾针对旧 staged snapshot 运行但未在超时前返回；其 verdict 按 interrupted/未验证处理，commit `f136f12` 明确为 `(unverified)`，不得标记 `[verified]` 或宣称生产级 release/DAG 自治。
- 验证结果：`npm run test` 为 `122` 个测试文件、`1055` 个测试通过；`npm run build` 通过；`npm run i18n:check` 为 `1009` keys 对齐；Rust `45` tests 与 `cargo fmt --check` 通过；`git diff --check` 通过。Vite 既有动态 import/chunk size warning 未新增失败。

### 7.101 对抗性审阅 P0 修复与执行层回归收口

- 修复 Worker 成功路径的生产装配：`App.tsx` 现在为 GUI Worker side-effect recorder 注入基于持久化 EvidenceStore 的 host verifier；`workerSideEffects.ts` 新增 durable persistence adapter helper。成功 receipt 仍必须通过 Evidence provenance、lineage、worktree 和 base revision 校验；本轮没有把该修复冒充为真实 Tauri E2E 通过。
- 修复执行层的确定性缺陷：`topoStages` 对 loopGate data 回流停止抬高 gate，并增加 bounded fail-closed guard；`Semaphore` 使用真实 queue entry 清理 AbortSignal，取消的 waiter 不再吞掉后续 permit；增量/retry 状态复位保留既有 outputs；旧 run 的 fail-fast callback 不再通过共享 generation abort 新 run；cache strike 按 workflow/node scope 收敛，branch cache 保存并恢复激活 handles。
- 收紧宿主验收与控制面事实边界：Worker acceptance 在 build/test 前先检查 changed protected/disallowed paths，并将 package/lockfile/Vitest 配置、脚本和测试目录加入默认 protected paths；Issue 创建改走 `createIssueCommand` + `IssueCreated` fact；Brief/Architecture/TaskGraph 的 approval consistency 增加 snapshot-approved 但缺批准事实的反向检查；active workflow workspace 使用统一 resolver。
- 修复可见产品问题：NodePalette 将 `nodepalette` 纳入 i18n fallback namespace；移除 `topbar.run` 重复 key；i18n checker 按 namespace 文件检测真正重复定义，不把不同 namespace 的同名 key 误报为重复。
- 本轮所有新增回归均先验证 RED，再验证 targeted GREEN；未修改 `CODEBUDDY.md`、未修改 `D:/Agents/SMtest`，未 push/merge，状态继续保持 `mvp-closed-unverified`。

验证结果：

- `npm run test`：123 个测试文件、1067 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；仍有既有 dynamic/static import 与大 chunk warning；
- `npm run i18n:check`：中英文 1009 个 key 对齐；
- `npm run headless -- examples/headless-demo.json`：7 个节点，成功 6、跳过 1、失败 0；
- `cargo test --manifest-path src-tauri/Cargo.toml`：45 个 Rust 测试通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `git diff --check`：通过。

真实 Tauri Worker → Evidence/Acceptance → Delivery → Cleanup → Restart/Recovery/read-back 尚未在本轮重跑；独立 reviewer 仍没有针对当前最终工作树返回 `passed=true`，因此不能标记 `[verified]` 或宣称 Phase 2 生产级完成。


### 7.102 前置策略拒绝的失败证据补齐

- 自验收发现：Worker acceptance 的 preflight path-policy 拒绝会阻止宿主 build/test，但原实现直接返回空 `evidenceIds`/`acceptanceId`，使“未执行的原因”无法进入 durable 交付档案。
- 修复 `src/dev/workerAcceptance.ts`：preflight 拒绝现在先写入并 flush 失败 `path-policy` Evidence，再持久化 `passed:false`、`failedChecks:['path-policy']` 的 Acceptance，之后才返回失败；仍不会执行受保护的 build/test oracle。
- 新增回归断言，覆盖“不执行 build/test + Evidence/Acceptance 均有 lineage 且持久化”的组合。

验证结果：

- `npm run test`：123 个测试文件、1067 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；既有 dynamic/static import 与大 chunk warning 保留；
- `npm run i18n:check`：中英文 1009 个 key 对齐；
- `npm run headless -- examples/headless-demo.json`：7 个节点，成功 6、跳过 1、失败 0；
- `cargo test --manifest-path src-tauri/Cargo.toml`：45 个 Rust 测试通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `git diff --check`：通过。

本轮仍未执行真实 Tauri Worker/GUI read-back；当前状态继续为 `mvp-closed-unverified`。

### 7.103 Worker Evidence verifier 三条 Tauri 生产路径收口

- 自验收发现 `runQueuedWorker` 虽已使用持久化 host Evidence verifier，但启动恢复 `recoverInterruptedWorkerEffects` 和手动 retry/skip 恢复路径仍调用无 verifier 的 recorder；这会使恢复阶段遇到 succeeded receipt 时继续 fail-closed，上一轮“全生产路径修复”并不完整。
- 新增 `createPersistedWorkerSideEffectRecorder`，统一从 durable Evidence persistence 构造 host verifier；`App.tsx` 的 queued execution、启动恢复和手动恢复三处均改用该 factory。
- 先将 durable persistence 测试改为要求新 factory 并确认 RED（`createPersistedWorkerSideEffectRecorder is not a function`），再实现 factory、运行 targeted GREEN。

验证结果：

- `npx vitest run src/projectControl/workerSideEffects.test.ts`：22 个测试通过；
- `npm run test`：123 个测试文件、1067 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；既有 dynamic/static import 与大 chunk warning 保留；
- `npm run i18n:check`：中英文 1009 个 key 对齐；
- `npm run headless -- examples/headless-demo.json`：7 个节点，成功 6、跳过 1、失败 0；
- `cargo test --manifest-path src-tauri/Cargo.toml`：45 个 Rust 测试通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `git diff --check`：通过。

GUI 边界：当前分支 Tauri dev 窗口已真实启动，并对仓库外 disposable fixture 做了文件事实 read-back；该 fixture 被识别为旧通用 workflow（`workerRuns=[]`），不是当前 WorkerQueue 执行。自动化打开项目入口在本次 WebView 输入通道中未获得可靠回读，因此没有把旧 workflow 的 Evidence/Acceptance 记录冒充为当前 Worker E2E。真实 Worker → Evidence/Acceptance → Delivery → Cleanup → Restart/Recovery/read-back 仍未通过当前 HEAD 的完整 GUI 闭环，状态继续为 `mvp-closed-unverified`。


### 7.104 真实 Tauri Worker GUI 自验收：worktree 分配 fail-closed

- 通过当前分支真实 Tauri WebView 加载仓库外 disposable Worker fixture，经过轻量工作台的 `确认执行计划` 产品门，确实写入 `RunCreated`、`TaskQueued`、`RunStarted` 和 `TaskStarted`；这不是 headless 或 Agent 自报结果。
- 在独立 clone `D:/Temp/slimemold-worker-acceptance-isolated-20260914-094939` 上，Run `run-3973fc2f-cc49-4e69-a59c-0822dda5e28c` 最终为 `partial`，Task 为 `failed`，canonical error 为 `worktree 分配失败：创建 worktree 失败`；目标 `docs/WORKER_E2E_OK.txt` 不存在，`evidence/host.jsonl` 和 `acceptance/records.jsonl` 均没有记录，Git worktree list 没有登记成功 Worker。
- 同一 identity 在短 disposable clone `D:/Temp/sm-e2e` 上直接执行 `git worktree add` 成功，而长 fixture 的同一次尝试留下 branch 后报 `'$GIT_DIR' too big`；因此本次失败首先暴露了 Windows/Git worktree 路径长度边界，不能冒充 Evidence/Acceptance 成功，也不能据此宣称 Worker 闭环已通过。
- 另建短根 approval-fact fixture `D:/Temp/sm-e2e-accept`；第二次 GUI 确认动作被自动化执行审批拦截，未产生 Run，未把它计入结果。
- 失败 Run、branch 和 disposable probe worktree 均保留；没有清理成功 worktree，没有触碰 `D:/Agents/SMtest`。

本次真实 GUI 验收结论：`FAIL / mvp-closed-unverified`。代码/自动化质量门仍通过，但 Worker → Evidence/Acceptance → Delivery → Cleanup → Restart/Recovery/read-back 的成功闭环尚未通过当前 HEAD；不得标记 `[verified]`、push 或 merge。

### 7.105 旧快照 reviewer 发现的执行层回归补齐

- 独立 reviewer 返回的是旧快照 `e8a8563` 的 fail-closed 结果，不能外推到当前 HEAD；其中 preflight Evidence/Acceptance 意见已由 `0304041` 修复。
- 对仍适用于当前 HEAD 的两处机制缺陷先写 RED 回归：已有 permit 时，已中止的 `Semaphore.acquire` 会错误返回 release；增量 skip 不恢复缓存中的 branch handles。
- 修复 `src/engine/rateLimiter.ts`：先检查 `signal.aborted`，再消费 permit；修复后取消不会拿到许可。
- 修复 `src/engine/nodeExecutionPolicy.ts` 与 `src/engine/executor.ts`：incremental-skip 按当前 cache scope/key 恢复 branch handles，并把空数组保留为全部屏蔽，避免下游错误执行旧分支。

验证结果：

- targeted：`rateLimiter.test.ts`、`nodeExecutionPolicy.test.ts` 共 29 个测试通过；
- `npm run test`：123 个测试文件、1069 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；既有 dynamic/static import 与大 chunk warning 保留；
- `npm run i18n:check`：中英文 1009 个 key 对齐；
- `npm run headless -- examples/headless-demo.json`：7 个节点，成功 6、跳过 1、失败 0；
- `cargo test --manifest-path src-tauri/Cargo.toml`：45 个 Rust 测试通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `git diff --check`：通过。

这些是代码/自动化修复，不改变真实 Tauri Worker GUI 闭环仍未通过的结论；状态继续为 `mvp-closed-unverified`。

### 7.106 对抗性审阅 P0/P1 边界修复

- `66bd610`：Worker acceptance 的 tracked changed-files 现在按 `lease.assignment.baseRevision` 比较，而不是只比较当前 `HEAD`；Worker 先提交 protected 文件不能再通过 preflight 隐藏变更。
- `193cd75`：Issue status command 拒绝把已归属其它项目的 Issue 写入当前项目事实流；未分配 Issue (`projectId:null`) 仍可由当前项目接管。
- `da7a936`：Codex Worker 只有在 host Acceptance 返回非空 `acceptanceId` 且 Evidence 存在时才能返回 `succeeded`。
- `e632111`：loop round cache invalidation 按 `wfId + nodeId` 作用域执行，避免同类型节点跨 workflow/cache scope 被误清除。

本轮明确未宣称已解决的 reviewer 风险：path-policy 与 build/test 之间的 TOCTOU、取消发生在 worktree allocation 后的 orphan rollback，以及 succeeded receipt 对 Acceptance/Evidence 的完整 orchestration/stage provenance read-back。这些仍阻止生产级 `[verified]`。

验证结果：

- targeted：capabilities/workerAcceptance 23 个、commands 14 个、codexWorkerExecutor 7 个、runLoop/nodeCache/executor 42 个测试通过；
- `npm run test`：123 个测试文件、1070 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；既有 dynamic/static import 与大 chunk warning 保留；
- `npm run i18n:check`：中英文 1009 个 key 对齐；
- `npm run headless -- examples/headless-demo.json`：7 个节点，成功 6、跳过 1、失败 0；
- `cargo test --manifest-path src-tauri/Cargo.toml`：45 个 Rust 测试通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `git diff --check`：通过。

真实 Tauri Worker GUI 失败结论不变，当前状态继续为 `mvp-closed-unverified`。


### 7.107 记录 ChangeSet 与远端开发生态决策边界

- 本轮没有修改生产代码，没有修改 `D:/Agents/SMtest`，没有 push/merge，也没有把计划、图标素材、原始日志或 `.workbuddy` 纳入本轮文档提交；控制面状态继续为 `mvp-closed-unverified`。
- 按用户要求暂停实现，补充 `docs/architecture/SLIMEMOLD_ARCHITECTURE_DECISIONS.md`，新增 ADR-SM-051 至 ADR-SM-067。
- 文档记录了 Git worktree 作为代码状态/谱系第二事实源、ChangeSet 一级对象、Repository 多对多引用、Local/Remote Observation 分离、GitHub 外部投影、External Operation Ledger、多仓库 Integration Saga、snapshot-bound Context Gateway、混合 GitObservation 采集、宿主 commit 身份、远端 secret 隔离、Council 治理和 provisional 性能 guardrails。
- 正式记录“版本化架构协议”是后续实现前的协议门禁：当前只纳入计划，尚未声称协议文档、schema、兼容矩阵或 conformance fixtures 已实现。
- 待议事项同步扩展为协议版本/迁移、ChangeSet 持久化、GitHub 权限与同步、外部操作恢复、多仓库补偿、Council quorum/权重/veto、artifact GC 和 benchmark 等问题。

验证结果：

- `git diff --check`：通过。
- 本轮为文档决策整理，未运行 `npm run test`、`npm run build`、`npm run i18n:check`、headless 或 Rust 测试；不能把本轮文档检查写成生产质量门通过。


### 7.108 执行引擎第一刀：抽离纯执行计划编译

- 本轮在新的本地 checkpoint `4093b9f` 之后开始实施执行引擎渐进拆分；保留无关未跟踪计划、图标素材、原始日志和 `.workbuddy`，没有 push/merge，也没有修改 `D:/Agents/SMtest`。
- 新增 `src/engine/executionKernel.ts` 与 `src/engine/executionKernel.test.ts`，把图展开、执行集计算、`retryFailed` 作用域、层内冲突簇、循环最大轮数和运行选项归一收拢为无 store、无 I/O 的纯 `compileExecutionPlan`。
- `src/engine/executor.ts` 现在消费该计划并继续负责副作用、节点执行、缓存失效、运行事件、状态写回和收尾；本轮没有把 Tauri、Worker、Evidence、Acceptance、Receipt 或 ProjectFile 纳入拆分，避免一次性改变生产事实边界。
- 测试先固定了“retryFailed 必须包含失败节点自身及其下游”的契约；迁移时补上失败节点本身的 force 标记，修正原有实现只加入下游、可能漏重跑失败节点的问题。
- 这是执行内核的第一条垂直切片，不代表执行引擎已经完成拆分，也不代表真实 Tauri Worker 闭环已通过；控制面状态继续为 `mvp-closed-unverified`。

验证结果：

- targeted：`executionKernel`、`executorLifecycle`、`runScheduler`、`graphAlgo` 共 4 个测试文件、81 个测试通过；
- `npm run test`：124 个测试文件、1073 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；既有 dynamic/static import 与大 chunk warning 保留；
- `npm run i18n:check`：中英文 1009 个 key 对齐；
- `npm run headless -- examples/headless-demo.json`：7 个节点，成功 6、跳过 1、失败 0；
- `cargo test --manifest-path src-tauri/Cargo.toml`：45 个 Rust 测试通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `git diff --check`：通过。

真实 Tauri Worker GUI 仍未重新验收；本轮只完成执行计划纯逻辑的进程内拆分，不能标记 `[verified]`。


### 7.109 执行引擎第二刀：抽离运行生命周期协调器

- 本轮在本地 checkpoint `cbdaaa9` 之后继续执行渐进拆分；未 push/merge，没有修改 `D:/Agents/SMtest`，保留 `.gitignore` 的非本轮改动以及其它未跟踪计划、素材和 `.workbuddy`。
- 新增 `src/engine/executionCoordinator.ts` 与 `src/engine/executionCoordinator.test.ts`，将 per-workflow 的运行代次、准入、重复运行拦截、force takeover、stop、abort、finish ownership 和 stale completion fencing 从 `executor.ts` 抽出。
- `executor.ts` 不再维护 `runGens`、直接持有该生命周期的 `AbortController` 或通过旧 generation map 取消；节点调度、运行事件、store 写回、节点副作用、资源清理和持久化仍留在原路径，避免扩大本轮范围。
- 协调器将 fail-fast abort 与用户 stop 区分：fail-fast 只中止当前 signal、不推进 generation；stop/force takeover 推进 fence。旧运行的 finish 不能清理新运行的取消句柄。
- 这是第二条进程内垂直切片，不代表 Host Adapter、Evidence/Acceptance/Receipt 或 ProjectControl 持久化已经拆出；真实 Tauri Worker GUI 闭环仍未通过，状态继续为 `mvp-closed-unverified`。

验证结果：

- targeted：`executionCoordinator`、`executorLifecycle`、`executorEvents`、`executorIntervene`、`executor` 共 5 个测试文件、42 个测试通过；
- `npm run test`：125 个测试文件、1078 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；既有 dynamic/static import 与大 chunk warning 保留；
- `npm run i18n:check`：中英文 1009 个 key 对齐；
- `npm run headless -- examples/headless-demo.json`：7 个节点，成功 6、跳过 1、失败 0；
- `cargo test --manifest-path src-tauri/Cargo.toml`：45 个 Rust 测试通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `git diff --check`：通过。

真实 Tauri Worker GUI 仍未重新验收；本轮没有标记 `[verified]`。


### 7.110 真实 Tauri Worker 垂直闭环验证：Worktree 成功但验收与恢复失败

- 本轮验证基线为执行生命周期协调器提交 `9fed909`，随后创建仅包含本轮文档变更边界的空 checkpoint `1e94122`；没有修改生产代码，没有 push/merge，没有修改 `D:/Agents/SMtest`，也没有清理成功的 disposable worktree。
- 第一份短路径 fixture `D:/Temp/sm-tauri` 通过真实 Tauri GUI 的项目选择和执行计划确认入口验证；由于 `.slimemold/acceptance/records.jsonl` 父目录不存在，`dev_init_session` 后的 Acceptance store 初始化失败，错误为 `failed to open file .../.slimemold/acceptance/records.jsonl with os error 3`，UI 显示“开发宿主不可用，Worker 未启动”。重启后其事件流仍有 15 条，但 `workerRuns` 被读回为空，说明该失败路径也暴露了持久化快照覆盖问题。
- 为隔离前置目录缺陷，第二份 fixture `D:/Temp/sm-tauri2` 以 Git 基线 `3be065e` 创建，并预置空的 `.slimemold/acceptance/records.jsonl` 与 `.slimemold/evidence/host.jsonl`。真实 GUI 确认执行计划后，事件流按顺序产生 `ExecutionDraftApproved → RunCreated → TaskQueued → RunStarted → TaskStarted → TaskFailed → RunPartial`。
- 第二次运行真实创建了 Worker worktree：`D:/Temp/sm-tauri2-workers/w-7461736b2d657865637574696f6e3a72756e2d31343131383266342d353539302d343434612d383938372d3466643266343139626665623a7461736b2d6372656174652d776f726b65722d6d61726b65723a617474656d70742d31`，branch 为对应的 `worker/w-...`，基线为 `3be065ee082a5c4c10c1c3f0c11226154485b1f5`；worktree 真实存在，`docs/WORKER_E2E_OK.txt` 真实存在且内容为 `SlimeMold Tauri Worker E2E passed.`。这证明了 `确认计划 → Worker Attempt → Tauri worktree → Worker 文件落盘` 已穿过当前 HEAD。
- Host Acceptance 随后失败在 Rust `dev_exec` 命令白名单：前端 `gitChangedFiles()` 必须调用 `git diff --name-only 3be065ee082a5c4c10c1c3f0c11226154485b1f5`，而 Rust worktree 白名单只覆盖 `git diff --name-only HEAD`，因此返回 `dev_exec: 命令在当前 cwd 不被允许`。本次失败发生在 changed-files 读取之前，host Evidence 为 0 条、Acceptance 为 0 条；Run 为 `partial`，Task 为 `failed`，Orchestration 为 `failed`，没有 Delivery 或 Cleanup。
- 重启第二份 Tauri 应用后，事件流仍保留 19 条，failed worktree、branch 和 marker 均仍在；但 `project.json` 的 `workerRuns` 从 1 变回 0，UI 回到“准备执行/执行编排已生成”，Orchestration 的 `failed` 与 `runIds` 仍保留。这证明当前 Restart/Recovery 不能可靠恢复 WorkerRun 快照，且不能把保留的 Git worktree 单独解释为控制面恢复成功。

验证结果：

- 真实 Tauri GUI：项目打开、计划确认、Worker 启动、worktree 分配和 marker 文件 read-back 均有实际窗口/磁盘/Git 事实；
- Worktree：创建成功，未清理，保留现场供后续修复与复核；
- Host Acceptance：失败，Evidence/Acceptance 均为 0 条；
- Restart/Recovery/read-back：失败，`workerRuns` 丢失但事件流和 worktree 仍保留；
- 本轮未重新运行 `npm run test`、`npm run build`、`npm run i18n:check` 或 Rust 测试，不能把此前自动化质量门结果当作本轮 GUI 验证结果。

本轮真实 Tauri 验收结论：`FAIL / mvp-closed-unverified`。下一步应先修复 Acceptance 的 base revision Git 命令 conformance、缺失 JSONL 父目录的首次启动处理，以及 WorkerRun snapshot 与 DomainEvent 的恢复一致性；在此之前不得继续拆 Runtime/Host Adapter、不得标记 `[verified]`、push 或 merge。


### 7.111 修复 Tauri Acceptance 首次启动与 WorkerRun 事件恢复

- 本轮在修复前 checkpoint `dcf4d16` 之后实施，修复提交为 `0fd4d47`；没有修改 `D:/Agents/SMtest`，没有 push/merge，也没有清理既有 disposable Worker worktree。
- `src/dev/evidence.ts` 与 `src/dev/capabilities.ts` 现在把 Tauri/Windows 的 `os error 3` 识别为缺失文件，仍拒绝 `os error 5` 和权限错误；新增 RED→GREEN 回归覆盖首次缺失 JSONL 文件。
- `src-tauri/src/lib.rs` 的 worktree Git 白名单现在允许与 TypeScript `assertSafeGitRevision` 同约束的 `git diff --name-only <baseRevision>`，拒绝 `..`、`//`、过长和非法字符；新增 Rust 回归覆盖安全 SHA、branch revision、路径逃逸和长度边界。
- 新增 `src/projectControl/workerRunRehydration.ts`，从当前项目边界内的 `RunCreated`、批准且版本匹配的 TaskGraph 以及 Task/Run 生命周期事件重建缺失的 WorkerRun projection；缺图、版本漂移和未知 Task 不自动猜测，保持 fail-closed。
- `App.tsx` 启动 Worker 事实审计前接入该重建：仅当 ProjectFile 的 `workerRuns` 为空且事件流可完整重建时，先保存 projection，再执行一致性审计和恢复 UI；实际状态转换由事件流控制，不新增伪造事件。

验证结果：

- targeted：5 个测试文件、54 个测试通过；
- `npm run test`：126 个测试文件、1079 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；既有 dynamic/static import 与大 chunk warning 保留；
- `npm run i18n:check`：中英文 1009 个 key 对齐；
- `npm run headless -- examples/headless-demo.json`：7 个节点，成功 6、跳过 1、失败 0；
- `cargo test --manifest-path src-tauri/Cargo.toml`：46 个 Rust 测试通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `git diff --check`：通过。

真实 Tauri recovery read-back：修复前遗留的 `D:/Temp/sm-tauri2` 在启动前为 `workerRuns=0`、事件流 19 条、Worktree 保留；修复后真实 Tauri 启动把同一 Run 重建为 `partial`，ProjectFile read-back 为 `workerRuns=1`，UI 显示“Worker 部分失败，需要恢复”，没有启动新 Attempt，既有 Worktree 和 marker 保持不变。该事实证明 Restart/Recovery projection 已修复，但本轮没有再次执行新 Worker，因此 Evidence/Acceptance/Delivery/Cleanup 的成功闭环仍未通过，控制面继续为 `mvp-closed-unverified`。

### 7.112 编排界面深色主题与 Worker 收口信息修复

- 本轮在修复前 checkpoint `53b62da` 之后实施，修复提交为 `afa0271`；未修改 `D:/Agents/SMtest`、disposable fixture 或既有 Worker Worktree，没有 push/merge/cleanup。
- `src/styles/typora.css` 为 `.sm-pro-shell` 增加主题作用域映射，令 legacy `bg-paper`、`text-ink-*`、`border-line`、状态色和专业暗色变量一致；新增 TaskGraph DAG 的标题、节点、lineage、Evidence/Acceptance 字段和边关系布局，避免暗色界面中出现浅色卡片、低对比度文本和字段粘连。
- `OrchestratorPanel` 对成功 Task 在 Cleanup proposal 尚未生成时显示明确状态；Cleanup proposal 宿主准备异常现在转换为可见的 blocked proposal，不再静默消失，仍保持 fail-closed，不允许绕过批准直接清理。
- 中英文 `orchestrator.bindLocked` 改为单一明确的“阶段绑定已锁定 / Stage bindings locked”，避免“执行中/已结束”混合状态文案。

验证结果：

- targeted：3 个相关测试文件、17 个测试通过；
- `npm run test`：126 个测试文件、1080 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；既有 dynamic/static import 与大 chunk warning 保留；
- `npm run i18n:check`：中英文 1010 个 key 对齐；
- `git diff --check`：通过；
- 本轮未重新执行真实 Tauri Worker、Rust 测试或 headless；此前成功 disposable Worker 现场仍保留，当前控制面仍为 `mvp-closed-unverified`。

### 7.113 归并跨工具会话与 AI 审查中的决策取舍

- 本轮在本地 checkpoint `f3d1bce` 之后进行；只修改 `docs/architecture/SLIMEMOLD_ARCHITECTURE_DECISIONS.md` 和本日志，没有修改生产代码、`D:/Agents/SMtest`、disposable fixture 或成功 Worker Worktree，没有 push/merge/cleanup。
- 读取并交叉核对当前 worktree、`docs/DEVELOPMENT_LOG.md`、其它 AI 工具的敏感归档、zcode 架构/UI 审查、`CODEBUDDY.md`，以及 Hermes 中 `查看项目代码`、`处理会话超限问题`、`修复 MasterAgentPage 未使用变量与 workflowState 测试期望` 三个会话和附加会话列表截图。
- 在 ADR 文档中新增来源归并规则和 0.5 会话用途说明，新增 ADR-SM-069 至 ADR-SM-082，覆盖：原始对话不是事实源、跨会话 handoff、主控 Agent 作用域、Tauri/React 与 Rust/TS 边界、Provider/认证分离、可信插件限制、驾驶舱与专业画布、显式执行门、外部 AI 审查分级、真实 GUI 优先、Memory/Skill 晋升、节点与角色边界、Vite/Cargo watcher 隔离，以及初始完整框架愿景被垂直切片策略替代。
- 明确保留未决边界：跨工具 handoff schema、auto-run/F5 最终策略、不可信插件进程沙箱、Provider capability matrix/CLI 可恢复控制、多项目 `masterAgentId` read-back 和 AI 审查资料的长期索引；文档没有把这些写成已实现能力。

验证结果：

- ADR 结构脚本：82 条 ADR，编号 `1–82` 连续且唯一；来源引用 `S1–S24` 无缺失/未知；敏感凭据模式匹配 0；`mvp-closed-unverified` 保留；
- `git diff --check`：通过；
- 本轮未运行 `npm run test`、`npm run build`、`npm run i18n:check`、headless、Rust 测试或真实 Tauri，因为没有修改代码或运行时协议；
- 控制面状态继续为 `mvp-closed-unverified`。

### 7.114 记录 Evidence/ContextPack 倒排索引的后置演进决策

- 本轮在本地 checkpoint `8921d2c` 之后进行；只修改 `docs/architecture/SLIMEMOLD_ARCHITECTURE_DECISIONS.md` 和本日志，没有修改生产代码、`D:/Agents/SMtest`、disposable fixture 或 Worker Worktree，没有 push/merge/cleanup。
- 新增 ADR-SM-083：确认未来可能需要倒排索引，但当前 `src/projectControl/evidenceIndex.ts` 的结构化 metadata/terms + 线性扫描先作为正确性基线；索引必须是按 project/sourceVersion/scope 隔离、可重建的派生投影，不能成为 Evidence、Acceptance、权限或 Task 成功的事实源。
- 记录后续触发条件：先对千级、万级、十万级 Evidence/Artifact 规模测量查询 p50/p95、构建/增量更新时间、内存、召回率、stale/dangling index 和 ContextPack token 成本，再决定内存倒排结构或 SQLite FTS 等实现；中文/多语言 tokenization 仍未决定。

验证结果：

- ADR 结构脚本：83 条 ADR，编号 `1–83` 连续且唯一；来源引用 `S1–S24` 无缺失/未知；敏感凭据模式匹配 0；
- `git diff --check`：通过；
- 本轮未运行 `npm run test`、`npm run build`、`npm run i18n:check`、headless、Rust 测试或真实 Tauri，因为没有修改代码或运行时协议；
- 控制面状态继续为 `mvp-closed-unverified`。

### 7.115 以 2048 机制复现验证独立产品交付档案

- 本轮在本地 checkpoint `1123f67` 之后进行；SlimeMold 主仓库没有新增生产代码，未修改 `D:/Agents/SMtest`，未 push/merge/cleanup。独立产品保存在仓库外的 disposable repo，避免把成品代码混入控制面项目。
- 真实运行 `npm run headless -- examples/2048.workflow.json`：6 个节点，成功 6，失败 0；该工作流使用 offline simulate，证明规划→架构→Builder→handoff 图连通，不证明真实 LLM 提取质量。
- 外部产品以 public Steam `2048` 页面仅作可观察玩法参考，由结构化主控提取稿限定范围，再交给 3 个下游工作包：纯棋盘逻辑、原创 UI/持久化、release/acceptance。没有复制 Steam 商标、素材、截图、音频、源代码或私有实现。
- 独立产品四阶段提交为 `c36485f`、`f3c3312`、`c974382`、`688c343`，最终证据档案提交为 `1c880dd`；档案包括 master extraction、downstream task graph、Acceptance、browser read-back、5 张截图和实验数据。

验证结果：

- 产品 Acceptance：`acc-fourfold-20260915143237462`，通过；7 个核心测试、5 个 Acceptance 子检查、静态 release build 通过；核心测试 294 ms，build 107 ms；
- Playwright Chromium：6 个浏览器检查通过，覆盖初始棋盘、键盘合并、Undo、刷新持久化、2048 胜利层和无可移动结束层；5 张 1440×1032 PNG 截图已 read-back 并视觉检查；
- 引擎实验：1,000 局确定性随机输入，160.25 ms；平均 119.88 步，p95 192 步，平均分 1,110.37，最高观察块 256；token/费用未计量，未写成 0；
- `git diff --check`：SlimeMold 与独立产品均通过；当前 SlimeMold 控制面仍为 `mvp-closed-unverified`，真实 Master Agent 运行和完整 Worker→Delivery→Cleanup→Restart 闭环仍未宣称完成。

### 7.116 补充 Fourfold 启动入口与 SlimeMold 编排 UI 证据

- 本轮在主项目 checkpoint `e54c3f6` 之后进行；没有修改 SlimeMold 生产代码，没有修改 `D:/Agents/SMtest`，没有 push/merge/cleanup。证据通过隔离 Playwright context 读取当前分支 Vite UI，避免触碰用户浏览器和真实项目。
- 节点图证据 `ORCH-001`：从 2048 starter template 读回 `6` 个节点、`7` 条连接，包含目标、规划、架构、仲裁回流、Builder 和 handoff；它证明 UI projection，不证明执行。
- 主控证据 `ORCH-002`/`ORCH-002A`：读回项目级 `Ollama 本地智能体 / qwen2.5:3b` 的显式选择，以及选择前“全局未设置主控”的继承状态；权限边界明确写着主控只能提出结构化方案，不能直接修改/执行/发布；没有把截图解释成 LLM 调用。
- Issue 证据 `ORCH-003`/`ORCH-003A`：读回空看板到创建 1 条 `需求` Issue 的前后状态，Issue 位于 `收件箱 / 未规划`，内容覆盖 2048 合并、随机生成、胜利和结束条件；隔离 context 不证明生产项目 durable persistence。
- Fourfold 直接双击 `index.html` 的启动障碍已复现为 Chrome `file://` module CORS；独立产品新增 `run-fourfold.cmd` 和 server `--open`，修复提交为 `0135117`；最终证据档案提交为 `1a4cf7a`。

验证结果：

- 独立产品最终 Acceptance：`acc-fourfold-20260915144800090`，通过；7 个核心测试、5 个 Acceptance 子检查、静态 build 通过；
- Playwright Chromium：6 个产品浏览器检查通过；5 张产品截图和 5 张 SlimeMold 编排 UI 截图均为有效 PNG 并纳入 Evidence index；
- 编排 UI 证据机器档案：`artifacts/slimemold-orchestration-evidence.json`（位于独立产品档案仓库）；
- 当前控制面继续为 `mvp-closed-unverified`；真实 LLM/Worker/Delivery/Cleanup/Restart 仍未被本轮 UI 截图替代。

### 7.117 Fourfold online Worker 收口与 Manager Delivery Assembly

- 本轮在现有本地 checkpoint 链之后继续执行，没有修改 `D:/Agents/SMtest`，没有 push、merge 或 Cleanup；所有 Worker worktree 保留为审计现场。
- 真实 online Run `run-7db0134c-0f0f-4e5f-b8de-050b8e4789c3` 最终 read-back 为 `partial`：9 succeeded、2 failed、2 blocked。失败为 `task_unit_tests`、`task_integration_tests`，阻塞为 `task_browser_acceptance`、`task_docs`；没有标记 `[verified]`。
- 本轮修复了 task-scoped Host Acceptance、Windows Rust command gate、`.cmd` shim、Node/tsc resolver、event/retry fence、pendingAttempt projection、TaskBlocked replay、并发 event/snapshot flush 等边界；修复后的真实 Evidence 已读到 `node --check` 与 `tsc --noEmit --target es2020` exitCode=0。
- 成功 Worker worktree 未自动合并；为获得一个可运行的独立 disposable 产品，Manager 在 `C:/Users/rnfmabj/Documents/SlimeMold/Fourfold-online-session` 做了明确标注的 Delivery Assembly，提交 `81ca600`，并写入 `artifacts/online-master/manager-delivery-receipt.json`。这不是原始 Worker Run 全绿的替代声明。

验证结果：

- online assembly `npm test`：通过，输出 `tests passed: merge, move, score, spawn, game-over predicate`；
- online assembly `npm run build`：通过，输出 `build check passed: 4 delivery files`；
- local HTTP smoke：`http://127.0.0.1:4173/` 返回 HTTP 200；
- Browser Use backend无法启动 Chromium，即使安装 `agent-browser` Chromium 后仍未形成可验证 localhost DOM read-back，因此 browser acceptance 明确为 blocked；
- 主仓库最新质量门：`npm run build` 通过，`npm run i18n:check` 为 1011 keys 对齐，`npm run test` 为 126 test files / 1097 tests passed，`git diff --check` 通过；
- 当前控制面仍为 `mvp-closed-unverified`；没有声称 Worker全绿、Delivery verified、browser acceptance passed、Cleanup或push。

### 7.118 Fourfold Worker RunSucceeded 与真实 Delivery Acceptance

- 通过 dependency artifact ContextPack 修复和 queued+failed recovery gate 修复，真实 online Run `run-7db0134c-0f0f-4e5f-b8de-050b8e4789c3` 最终 read-back 为 `RunSucceeded`：13 succeeded、0 failed、0 blocked，最终事件 sequence 563；历史失败 attempts仍保留在 `.slimemold/`。
- 成功依赖 Worker 的 Worktree path/branch/revision 进入下游 lease 的只读 ContextPack；下游 Task 不再从空 baseline 盲跑。该修复提交于主仓库 `1ecf5bc`；queued+failed recovery显示修复提交于 `93c2608`。
- integration Worker worktree 增加 `src/main.js` durable session bootstrap facade，真实 `persistence.test.js` 5/5 和 `interaction-flow.test.js` 3/3 通过，并产生 Worker worktree commits `28ffe55`、`41d7442`。
- online Delivery 仓库组装成功 Worker-derived 产品与测试产物，提交 `40fcff6`，随后 provenance README 提交 `ef70320`；包含 `test:integration`、`test:interaction`、`test:browser` scripts 和 durable receipt `artifacts/online-master/manager-delivery-receipt.json`。
- Delivery 真实验证：`npm test`、`npm run build`、integration 5/5、interaction 3/3、HTTP 200、Chrome 152.0.7977.83 CDP browser acceptance 1/1通过；browser acceptance覆盖移动、合并、Undo、刷新/重启持久化、offline和storage fallback。
- Browser Use managed backend仍无法识别 Chromium，但独立 Chrome/CDP已形成真实 DOM/行为 read-back；该 backend限制没有被冒充为产品验收失败。
- 主仓库最终质量门重新通过：`npm run build`、`npm run i18n:check`（1011 keys）、`npm run test`（126 test files / 1097 tests）、`git diff --check`；没有 push、主仓库 merge、Cleanup 或 reviewer `[verified]`。

### 7.119 TaskGraph Worker 内部时序图

- 新增自包含图示：`docs/diagrams/FOURFOLD_TASKGRAPH_WORKER_SEQUENCE.html`，使用 SVG 泳道表达 `ProjectControl → WorkerQueue → Worktree Host → Codex Worker → Host Acceptance → Evidence/Receipt → Delivery`。
- 图中明确标出成功判定边界：Codex 文本不是成功事实，必须经过 changed-file scope、Host validation、Evidence 和 Acceptance；同时标出 dependency artifact ContextPack、Restart/Recovery retry loop 和 `RunSucceeded`。
- 图右侧单独标出普通 Workflow 节点图为另一条路径，避免将 `coord.council` 红色节点、Ollama Agent 配置或节点耗时误读为 TaskGraph Worker 的成功/失败来源。
- 图示依据本轮 durable facts：TaskGraph v1、13 tasks、RunSucceeded sequence 563、Delivery commit `40fcff6`；HTML 无外部依赖、无凭据。

### 7.120 分封/认领图重画与 Antigravity 接入勘探

- 原有 `FOURFOLD_TASKGRAPH_WORKER_SEQUENCE.html` 只表达了调用时序，未充分表达 SlimeMold 的核心设计意图；新增 `docs/diagrams/SLIMEMOLD_TASKGRAPH_DELEGATION_AND_CLAIM.html`，分成“目标控制层级”和“Fourfold 实际 TaskGraph 投影”两层。
- 新图显式表达 Master/CEO → Project Delivery Architect → Department Head → Module Lead → Worker/IC → Specialist 的目标分封链，以及 DelegationRequest、ClaimLease、ContextPack、Worktree/Attempt、ProgressCapsule、Evidence/Acceptance 和 FeedbackRequest 的上下行边界。
- Fourfold 实际 13 Task 以四个解释性 Work Package 展示，明确声明这些分组不是第二套任务系统；canonical source 仍是 `projectControl.taskGraphs[0].tasks`。
- 本机已检测到 `D:/Family/Antigravity IDE`：产品元数据 `ideVersion=2.5.5`，CLI 报告 `1.107.0`；CLI 支持 `chat --mode agent`、workspace path 和 `--add-mcp`，官方文档支持全局 `~/.gemini/config/mcp_config.json` 与 workspace `.agents/mcp_config.json`。
- 接入结论：Antigravity 可以作为 Worker Runtime Adapter 接入，但不能越过 SlimeMold 的 TaskGraph、Worktree、Host Acceptance、Evidence、Receipt 和 Recovery；当前尚未实现 adapter，也未修改用户的 Antigravity MCP 配置。CLI `--list-extensions` 能列出已安装扩展，但随后出现原生 V8 abort，暂不把该命令视为稳定管理接口。

---

1. 从 ComfyUI 到 SlimeMold：为什么我开始做节点式 Agent 工作流
2. 一个 1500 行 executor 的重构：为什么我没有选择直接重写
3. AgentRouter 的凭据、模型和 fallback：多模型系统比想象中复杂
4. Web Worker 不是进程沙箱：插件隔离方案的一次纠偏
5. 让 Agent 修改代码之前：Worktree、Evidence 和确定性验收
6. 一次“假成功”故障复盘：为什么基础设施失败必须 fail-closed
7. Graph Engineering 的边界：什么时候 Graph 会变成负担
8. 一个学生开发者如何把复杂项目整理成可验证的工程作品

发布时建议明确写成：

> 本文是 2026 年的回顾性整理，依据 Git 提交、开发日志和测试记录重建时间线。

不要把事后整理的文章伪装成当时同步发布的开发日记。真实的失败、误判、回退和边界，反而是这段开发经历里最有价值的部分。

### 7.121 Antigravity Worker Runtime Adapter 第一条垂直切片

- 在不修改全局 `~/.gemini/config/mcp_config.json`、不保存凭据、不 push/merge/cleanup 的前提下，实现 `codex | antigravity` Worker Runtime 选择；默认仍为 Codex。
- `ProjectSessionPanel` 对 queued Run 显示 Runtime selector；选中 Antigravity 后，`App → Project Worker Coordinator → registered Worktree` 使用新的 Runtime Adapter，旧的 Codex 路径保持不变。
- 新增 `src-tauri/src/antigravity.rs`：校验 session generation 和登记 Worktree，生成 Attempt-scoped `.agents/slimemold-worker/<operationId>/context.json`，只在 workspace `.agents/mcp_config.json` 没有冲突时写入 `slimemold-worker` server，并等待 MCP `result.json`；没有 Attempt result 不返回成功。
- 新增 `scripts/slimemold-antigravity-mcp.mjs`，暴露 `slimemold_get_task_context`、`slimemold_report_progress`、`slimemold_request_feedback`、`slimemold_submit_attempt_result`。MCP server 只读写当前 Attempt 目录，不能直接写 TaskGraph、Acceptance 或 Receipt。
- Windows `.cmd` 启动只向 `cmd /C` 传固定启动词；真实任务指令写入 ContextPack 文件，避免把任意任务 prompt 拼入 shell command。CLI basename 限制为 `antigravity-ide.cmd`、`antigravity-ide.exe` 或 `antigravity-ide`。
- `completed` 回报仍必须经过 Host Acceptance；`blocked` 回报创建绑定 project/task/attempt 的 `FeedbackRequest`。没有把 Antigravity UI、进程启动或 Agent 自报成功当作 TaskSucceeded。
- 当前只实现 CLI 已确认的 `ask/edit/agent/custom` mode 值，并可传递 workspace `profile`；没有把未经官方契约确认的 model、thinking/reasoning 或 quota 映射成可用能力，也没有把 Antigravity 账户订阅伪装成 Gemini API/Vertex AI Provider。

验证结果：

- `npm run test`：127 test files / 1099 tests passed；
- `npm run build`：通过；
- `npm run i18n:check`：en-US/zh-CN 1015 keys 对齐；
- `cargo check`：通过；`cargo test --lib`：50/50 passed；
- `rustfmt --edition 2021 --check src/antigravity.rs`：通过；完整 `cargo fmt -- --check` 仍被既有 `src-tauri/src/lib.rs` 的 `dev_exec` 与测试格式漂移阻塞，本轮没有重排无关旧代码；
- MCP stdio 实际 read-back：initialize/tools/get_context，以及 progress/feedback/submit result 写回均通过；
- `git diff --check`：通过；当前没有独立 reviewer，因此不标记 `[verified]`。

### 7.122 Antigravity Agent 配置与设置列表布局修复

- 用户反馈 Antigravity 不能像 Codex CLI 一样配置，以及设置页底部的创建/删除操作被列表越界裁切。本轮将 `antigravity` 增加为独立 Agent protocol/runtime，不伪装成 OpenAI API。
- Agent 设置现在可配置：Antigravity mode（ask/edit/agent/custom）、workspace profile 和可选 CLI path；当前 CLI 没有稳定的 model/thinking/reasoning 参数，因此 UI 明确显示由 Antigravity Runtime 控制，不提供虚假的模型下拉。
- 配置的 Antigravity Agent 会被 App 层映射到 TaskGraph Worker Coordinator，启动 Worker 时传递 mode/profile/cliPath；普通 Workflow Engine 使用 Antigravity Agent 会 fail-closed，避免把交互式 CLI 当作普通聊天 API。
- 修复 `AgentPanel` 的双层 flex 约束：左侧 Agent 列表 `min-h-0 + overflow-y-auto`，创建 footer `shrink-0` 固定在列表底端；右侧编辑表单内容滚动，禁用/删除操作栏移出滚动区并固定在底部。

验证结果：

- `npx tsc --noEmit`：通过；
- `npm run build`：通过；
- `npm run i18n:check`：en-US/zh-CN 1026 keys 对齐；
- `npm run test`：127 test files / 1099 tests passed；
- 当前运行中的 Tauri 窗口通过 WebView accessibility read-back 确认设置→智能体页面仍可打开；未输入凭据、未修改全局 Antigravity 配置；
- 本轮没有 push、merge、cleanup，也没有独立 reviewer `[verified]`。

### 7.123 修复 AgentPanel 高度链断裂导致的 footer 裁切

- 复现确认：截图中 Agent 列表的五条记录可见，但“按供应商预设新建…”及编辑区禁用/删除操作不可见；仅给列表添加 `overflow-y-auto` 未建立有效 viewport。
- 根因：`SettingsCenter → AgentSection` 的嵌入容器是 block wrapper，而 `AgentPanel` 的 `inner` 只有 `flex-1`、没有 `h-full`，导致 `AgentsTab` 高度按内容计算，滚动区和 footer 被外层 `overflow-hidden` 裁切。
- 修复：AgentPanel inner 增加 `h-full`；SettingsCenter 的 AgentPanel wrapper 改为 `flex min-h-0 flex-1`，让高度约束沿 `SettingsCenter → AgentSection → AgentPanel → AgentsTab → ul` 连续传递。
- GUI read-back：fresh Tauri build 中左侧“按供应商预设新建…”可见；选中 Ollama Agent 后，右侧“禁用”和“删除此智能体”均位于底部操作栏且可见。当前仅 5 条 Agent，列表内容未超过 viewport，因此没有滚动需求；超过 viewport 时由真实 `ul` 的 `overflow-y-auto` 滚动，footer 位于滚动区外。

验证结果：

- `npx tsc --noEmit`：通过；
- `npm run build`：通过；
- `npm run i18n:check`：en-US/zh-CN 1026 keys 对齐；
- `npm run test`：127 test files / 1099 tests passed；
- `git diff --check`：通过；
- 本轮没有 push、merge、cleanup，也没有独立 reviewer `[verified]`。

### 7.124 当前 HEAD Verified Closure：真实 Tauri Host Acceptance 成功

- 本轮代码基线为 `f2b03db`，修复前一轮独立审查发现的主题文件拖拽遮罩和 NodePalette drag ghost 层级回归；同时修正 NodePalette 角色筛选的 `useMemo` 依赖。
- 在仓库外创建并保留三个 disposable Git fixture。第一份 fixture 的 `runs/history.json` 保留了最早的“worktree 成功→patch preimage 缺失”尝试，随后同路径重复尝试在 `worktree.create` 因路径占用失败；第二份真实 Tauri workflow 暴露 protected `tests/**` 拒绝；没有绕过策略、伪造 Evidence/Acceptance 或删除失败 worktree。
- 第三次 fixture `D:/Temp/slimemold-verified-closure-20260917-142509` 通过真实 `slime-mold.exe` WebView、GUI 项目菜单和 workflow 按钮执行：run 3 为 `success`；真实创建并保留 Worker worktree；结构化 patch 只修改两个 `src/components` 文件；build/test/diff 全部成功；Host Acceptance 为 `passed: true`、`failedChecks: []`、`changedProtectedPaths: []`。
- 四条 host Evidence 和 Acceptance record 已写入 fixture 的 `.slimemold/evidence/host.jsonl`、`.slimemold/acceptance/records.jsonl`；完整路径、Evidence ID、Acceptance ID 和失败尝试记录见 `docs/reports/VERIFIED_CLOSURE_20260917.md`。

验证结果：

- `npx tsc --noEmit`：通过；
- `npm run build`：通过；
- `npm run i18n:check`：1026 keys aligned；
- `npm run test`：127 test files / 1099 tests passed；
- `git diff --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：50 passed / 0 failed；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：未通过，输出仅涉及本轮未修改的既有 `src-tauri/src/lib.rs` 格式漂移；
- 真实 Tauri Host Acceptance：`acc-mu55bxiz-0522b09e`，通过；
- 同一 Tauri WebView 的受控 DOM smoke read-back（原始 JSON 未单独归档，属于未归档的 manual observation）证明 dark/light veil 随 `--sm-bg` 变化、veil 为 `z-index=99999`、NodePalette drag ghost 为 `z-index=10000`；主题已恢复，未释放文件或执行 workflow；
- 本轮不宣称 Antigravity E2E、WorkerQueue Restart/Recovery、Delivery/Cleanup、Browser Use managed backend 或历史 121 个 `(unverified)` commit 已逐笔 verified；没有 push、merge 或 Cleanup。

### 7.125 当前 HEAD Worker Restart/Recovery 与 Skip 决策 read-back

- 本轮在已验证 checkpoint `43fbcb6` 上继续，未修改生产代码；使用新的仓库外 disposable fixture `D:/Temp/sm-tauri2-recovery-v2-154444`，保留失败 fixture、真实 Worker worktree 和 side-effect journal，没有 Cleanup。
- fixture 初始 ProjectFile 的 `workerRuns=0`，但保留 19 条合法 checksum 事件、批准 TaskGraph、失败 Attempt、`worker-execution` receipt 和真实 worktree；另一份 `...-153618` fixture 因路径替换后未重算 checksum，被当前 HEAD fail-closed，未冒充恢复成功。
- 真实 Tauri 进程重启后，当前 ProjectFile read-back 为 `workerRuns=1`；Run=`partial`、Task=`failed`、attempt=`1`、worktree/branch/baseRevision/error lineage 完整；事件仍为 19 条，没有自动创建新 attempt。UI 明确显示“Worker 等待恢复核对”，并禁止自动重跑。
- 通过真实恢复 UI 执行 `skip` 后，事件增至 20 条，新增 `WorkerRunRecoveryDecided`；`decision=skip`、`requiresNewAttempt=false`、`effectKeys=[]`；ProjectFile error 更新为恢复决策，attempt 仍为 1，worktree 仍保留。
- 完整路径、事件 payload、ProjectFile 字段和未验证边界见 `docs/reports/WORKER_RECOVERY_VERIFICATION_20260917.md`。

验证结果：

- 真实 Tauri restart/read-back：通过；
- 真实 recovery UI：通过；
- durable `WorkerRunRecoveryDecided(skip)`：通过；
- ProjectFile / event stream / side-effect / Git worktree read-back：通过；
- 本轮没有修改生产代码，因此未重复运行 npm/Rust 质量门；当前代码质量门与独立 reviewer 结论仍绑定 `43fbcb6`；
- 本轮不宣称 retry 新 attempt、Delivery/Cleanup、Antigravity E2E 或历史 commit 重写；没有 push、merge 或 Cleanup。

### 7.126 当前 HEAD Worker Retry 新 Attempt 与 Host Acceptance 成功

- 本轮在 `79dae6c` 上继续，没有修改生产代码；使用 `D:/Temp/sm-tauri2-recovery-v2-174611` disposable fixture。初始 `workerRuns=0`，事件 19 条，attempt 1 的副作用为 `unknown/needs-user`。
- 真实 Tauri 重启后，轻量工作台显示 recovery gate；通过真实 UI 选择 retry，系统创建 attempt 2、新 worktree、新 branch 和新 idempotency key，没有复用 attempt 1 的未知副作用。
- attempt 2 最终 `Run/Task=succeeded`；真实 marker 文件落盘；Host build/test/diff/path-policy 四条 Evidence 通过；Acceptance `acc-mu5cm748-b24a9dda` 为 `passed=true`、`failedChecks=[]`。
- 事件尾部为 `WorkerRunRecoveryDecided → RunQueued → TaskQueued → RunStarted → TaskStarted → TaskSucceeded → RunSucceeded`；attempt 1 的 unknown receipt 仍保留，成功事实全部绑定 attempt 2。
- 完整 Evidence ID、worktree/branch、attempt lineage 和未验证边界见 `docs/reports/WORKER_RETRY_VERIFICATION_20260917.md`。

验证结果：

- 真实 Tauri recovery UI：通过；
- retry 新 attempt/worktree：通过；
- Host compile/test/diff/path-policy Evidence：4/4 通过；
- Host Acceptance：通过；
- marker 文件与 Git worktree read-back：通过；
- 本轮没有修改生产代码，因此未重复运行 npm/Rust 质量门；没有 push、merge 或 Cleanup；
- 本轮不宣称 Delivery/Cleanup、Antigravity E2E、Browser Use managed backend 或历史 commit 重写。

### 7.127 DeliveryReceipt 与 Restart 后 Cleanup Proposal Read-back

- 本轮从 checkpoint `5b874de` 继续，使用 `D:/Temp/sm-tauri2-recovery-v2-174611`；Delivery 实际执行来源保留为 `ab74d13`，没有修改生产项目，没有 push、merge 或 Cleanup。
- 对 attempt 2 的 accepted marker 生成 `ArtifactCandidate`、用户批准和真实 DeliveryReceipt：destination 为 `D:/Temp/slimemold-delivery-dest-20260917-181500`，receipt=`artifact-delivery:candidate-tauri-worker-attempt-2-20260917:receipt`，file=`docs/WORKER_E2E_OK.txt`，source/content hash=`h16fxepq`，outputHash=`h8tva18`，outcome=`succeeded`。
- destination 文件真实 read-back 成功；同一 candidate/approval 第二次调用返回相同 receipt，side-effect journal status=`ok`，artifact-delivery entry 为 `receipt/skip`。
- 发现并修复三个断链：artifact-delivery 被 Worker consistency audit 误判为 worker-execution；重启后 live Worktree 缺少 Rust restore registry 入口；Rust 主仓库只读 gate 未允许重启后安全的 Worker branch-tip probe。新增 `dev_restore_worktree`、Delivery audit 分支和 branch revision regression。
- 真实 Tauri 重启、产品项目入口和编排详情 read-back 显示：`清理提案: 已通过绑定检查，等待宿主批准 · acc-mu5cm748-b24a9dda`，并显示“批准清理”；proposal 已绑定当前 Run/Task/Execution/Attempt、Worktree、branch revision、state signature、Acceptance 和 stage。
- 本轮没有点击批准清理，没有生成 CleanupReceipt，没有删除 Worktree/branch；因此闭合的是 DeliveryReceipt + Cleanup proposal ready，不是 CleanupReceipt/删除成功。完整记录见 `docs/reports/WORKER_DELIVERY_CLEANUP_VERIFICATION_20260917.md`。

验证结果：

- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 Vite chunk/dynamic-import warning 保留；
- `npm run i18n:check`：1026 keys 对齐；
- `npm run test`：127 test files / 1101 tests passed；
- `git diff --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：51 passed / 0 failed；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：未通过，仍为 `src-tauri/src/lib.rs` 既有格式漂移，本轮没有全文件重排；
- 独立 reviewer 复审发现 DeliveryReceipt 结构校验和 Rust 特殊 allowlist 的 fail-closed 缺口；已增加严格 receipt shape/Acceptance/failedChecks/outputHash/files 校验，并为主仓库特殊分支补充 `args[0] == git` 回归；修复后 targeted 与全量质量门重新通过；
- 没有 push、merge、Cleanup；Antigravity E2E、Browser Use managed backend 和历史 commit 重写仍未验证。

### 7.128 已批准 Worker CleanupReceipt 与 Worktree/Branch 删除闭合

- 延续 `7.127` 的同一 disposable fixture；用户明确批准的范围仅为 attempt 2 的 Worktree `D:/Temp/sm-tauri2-recovery-v2-174611-workers/w-92fbfecb4bff7a8f8aca59dd` 和 branch `worker/w-92fbfecb4bff7a8f8aca59dd`。没有扩展到主仓库、Delivery destination、其他审计 fixture、push、merge 或历史 commit。
- 通过真实 Tauri WebView 进入编排详情，点击“批准清理”后执行“执行清理”；native confirmation dialog 再次显示并核对了精确 path、branch 和 revision，随后确认。该 GUI/native 对话框观察未单独归档，属于 manual observation；最终结论以 durable side-effect、event、ProjectFile、Filesystem/Git 和 Delivery read-back 为准。没有使用裸 `git worktree remove`、`git branch -D` 或手工删除绕过 host authority。
- disposable fixture 的 side-effect journal 新增且仅有一条 `kind=worktree-cleanup` receipt：`cleanup:task-execution:run-141182f4-5590-444a-8987-4fd2f419bfeb:task-create-worker-marker:attempt-2:receipt`；`status=receipt`、`recovery=skip`、`outcome=succeeded`、`outputHash=hxymq3c`，并绑定当前 Run/Task/Execution/Attempt、target 和 inputHash。
- 实际删除 read-back：Worktree 目录不存在；`worker/w-92fbfecb4bff7a8f8aca59dd` branch ref 不存在；主仓库 `git worktree list --porcelain` 不再列出该 Worktree。ProjectFile 为 `worktreeStatus=cleaned`、`cleanupStatus=cleaned` 并保存 receipt ID。
- event stream 共 27 条，末尾为唯一的 `TaskCleaned`（`sequence=27`）；UI 显示“清理提案: 已清理”，没有再次 Cleanup 按钮。清理后的 proposal 会投影为 terminal `cleaned`，执行器对已清理 proposal 直接拒绝重复执行；没有产生第二 receipt 或第二 `TaskCleaned`。
- Delivery destination `D:/Temp/slimemold-delivery-dest-20260917-181500/docs/WORKER_E2E_OK.txt` 仍存在且内容未变；attempt 1 的 `unknown/needs-user` worker-execution side-effect、失败事件和失败 provenance 均保留；attempt 2 的 4 条 Host Evidence 与唯一的 `passed=true` Acceptance 记录保留。完整字段、原始路径和边界见 `docs/reports/WORKER_CLEANUP_VERIFICATION_20260917.md`。

验证结果：

- `npx tsc --noEmit`：通过；
- `npm run build`：通过；本轮仍有多处 dynamic/static import warning，主 bundle `index-CIus0AVq.js` 为 `1,145.37 kB`，保留 Vite 大 chunk warning；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `npm run test`：`127 test files / 1101 tests passed`；包含 Cleanup proposal/receipt 定向测试；
- `git diff --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`51 passed / 0 failed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：未通过，仍报告 `src-tauri/src/lib.rs` 的既有格式漂移；本轮没有全文件重排；
- 当前仍不宣称 Antigravity E2E、Browser Use managed backend 或历史 commit 重写已验证；没有 push 或 merge。

### 7.129 Rust fs_guard 纯路径身份 helper 第一条垂直切片

- 在 checkpoint `f783427` 后开始本轮；保留无关未跟踪 `.workbuddy/memory/2026-09-17.md`，没有修改凭据、`DEV_STATE`、Tauri command 注册、worktree authorization 或 cleanup authority。
- 将 `path_compare_key` 与 `path_is_same_or_child` 从 `src-tauri/src/lib.rs` 移入新 module `src-tauri/src/fs_guard.rs`；`lib.rs` 继续通过 `pub(crate)` helper 使用同一实现，避免复制第二套路径边界规则。
- 先写 `path_compare_key` 的失败测试并实际看到 RED；随后完成 module 实现，新增 trailing separator、Windows verbatim UNC 和 component-boundary 测试。命令参数 lexical guard、canonicalize guard、`dev_strip_verbatim` 和 `DEV_STATE` 仍留在 `lib.rs`，作为后续独立 slice，不在本轮混拆。

验证结果：

- `cargo test --manifest-path src-tauri/Cargo.toml --lib fs_guard::tests`：`3 passed / 0 failed`；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`54 passed / 0 failed`；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `rustfmt --edition 2021 --check src-tauri/src/fs_guard.rs`：通过；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import warning 和 `index-CIus0AVq.js` `1,145.37 kB` 大 chunk warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `npm run test`：`127 test files / 1101 tests passed`；
- `git diff --check`：通过；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：未通过，仍为 `src-tauri/src/lib.rs` 既有格式漂移，本轮没有全文件重排；
- 当前 slice 未涉及 GUI、credentials、endpoint/vault、push、merge 或 Cleanup；下一条 fs_guard slice 需继续保持单一边界并重新建立 reviewer/verified 证据。

### 7.130 跨宿主 native authority hardening 暂停于 unverified checkpoint

- 在 `204105d` unverified checkpoint 后继续收紧 Rust Tauri 与 Node/headless 的命令 grammar、路径 canonicalization、protected path、hardlink、Windows launcher、worktree identity 和 orphan/cleanup 前置校验；新增 Unix `O_NOFOLLOW`、Windows `OPEN_REPARSE_POINT` handle-bound 文件读写，以及 broken symlink、Git pathspec、grep/find/tsx、UNC 和 child-cwd 回归测试。
- 独立 fail-closed reviewer 针对完整有效 snapshot 返回 `passed: false`。真实发现包括：直接 `gitDiff`/generic diff 的 protected 内容边界仍不统一；Node/Rust command AST/grammar 仍有差异；native `allowedPaths` 与 protected policy 尚未由同一 host-owned contract 管理；worktree、cwd、launcher 和父路径仍存在稳定对象身份/跨组件 no-follow 缺口；cleanup capability 尚未绑定完整 Task/Execution/Attempt/Acceptance lineage；orphan branch-only recovery 与跨平台验证仍未闭合。
- 已将当前结果保存为本地 checkpoint `ac7a8bb`（`unverified: checkpoint native authority review findings`），工作树干净；没有 push、merge、历史重写或凭据变更。该 checkpoint 不是 `[verified]`，也不代表生产 native authority 已安全通过。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`63 passed / 0 failed`；
- `npm run test`：`127 test files / 1104 tests passed`；
- Node authority 定向测试：`39 passed / 0 failed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，无新增构建失败；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 独立 reviewer：`passed: false`，因此本轮只能记录为 `unverified`，不能标记 verified。下一步需先确认共享 command AST、host-owned policy、stable identity/no-follow 和完整 cleanup lineage 的架构切片，再开始新的代码修改。

### 7.131 共享 command policy parity 继续收紧于 unverified checkpoint

- 针对 Slice 0 reviewer 发现的 Git pathspec、Windows 路径规范化、grep 空 pattern、tsx 参数和 Node/Rust 分歧，新增 shared negative vectors，并同步收紧 Node 与 Rust parser。
- 当前 vectors 覆盖 Git bracket glob、重复分隔符、Windows trailing dot/space、Unicode 非 ASCII path、grep 空 pattern、find 多 root/action、tsx dot/colon/wildcard script 与 Windows root-relative extra；accepted vectors 同时校验 `intentKind`，不再只比较 boolean。
- 本轮只建立 command grammar/parity contract，没有接管现有 native runtime authority；旧的 cross-host hardening 仍保持 `unverified`，不能据此宣称 native authority 已安全闭合。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`64 passed / 0 failed`；
- `npm run test`：`128 test files / 1109 tests passed`；
- `npx vitest run src/dev/commandPolicy.test.ts`：`5 passed / 0 failed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；等待新的独立 fail-closed reviewer，当前不能标记 verified。

### 7.132 统一 tsx root 与 dot-dot grammar 于 unverified checkpoint

- 根据 reviewer 反馈，Node `tsx` parser 不再对 script root 做大小写折叠，必须精确使用 `scripts/`；Rust 同步拒绝任意包含 `..` 的 script path，消除两宿主 accepted language 漂移。
- shared vectors 新增 `Scripts/check.ts`、`scripts/foo..bar.ts` 和 trailing-space protected path，日志覆盖声明与实际 vectors 对齐。
- 本轮仍只收敛 shared command grammar/parity contract，没有接管现有 native runtime authority；Slice 0 完成与否仍以独立 reviewer 的 fail-closed verdict 为准。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`64 passed / 0 failed`；
- `npm run test`：`128 test files / 1109 tests passed`；
- `npx vitest run src/dev/commandPolicy.test.ts`：`5 passed / 0 failed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；当前仍不能标记 verified。

### 7.133 共享 command grammar 扩展至 generic path、read 与 typecheck 于 unverified checkpoint

- 针对最终 reviewer 发现的 generic embedded `..`、控制字符、Windows device basename、Git invalid ref、find predicate 缺 operand 和 shared corpus 覆盖不足，Node/Rust 两侧同步收紧。
- `find` 现在按 predicate arity 解析：`-name/-path/-maxdepth/-mindepth/-type` 等必须带安全 operand；缺失或未知 predicate fail-closed。
- shared contract 新增 `ls/cat/head/tail` 的 scoped read intent，以及 `tsc --noEmit/-b`、`node --check scripts/...` 的 typecheck intent；`node -e` 和 option injection 保持拒绝。
- launcher/ComSpec、child-cwd、stable filesystem identity 和真实 runtime 接入仍属于后续 host authority slices，本轮不宣称已解决。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`64 passed / 0 failed`；
- `npm run test`：`128 test files / 1109 tests passed`；
- `npx vitest run src/dev/commandPolicy.test.ts`：`5 passed / 0 failed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；等待针对最终 snapshot 的独立 reviewer，当前仍不能标记 verified。

### 7.134 收紧 protected ancestor、tsx extras 与 find expression 于 unverified checkpoint

- 针对 reviewer 发现的 protected root ancestor 绕过，Node/Rust 现在同时拒绝覆盖 protected root 的上级 operand，例如 `src`、`src/plugins`、`src-tauri`；不仅拒绝直接命中 protected root 或其子路径。
- `tsx` extras 收紧为显式 allowlist `--reporter=dot`，拒绝 protected path、控制字符和任意未建模 positional argument；Node/Rust 保持同一语言。
- Git ref 两侧使用同一 ASCII grammar，拒绝 `@{` 等 Git-invalid revision；grep pattern 现在必须非空且无控制字符。
- `find` expression 改为 primary/unary/binary 结构校验：`!/-not` 必须有 operand，`-o/-or/-a/-and` 两侧必须有 expression，root scanner 正确识别 `!`；补充对应 RED vectors。
- 8.3 short-name alias、真实 runtime 接入、launcher/ComSpec、child-cwd 和 stable filesystem identity 仍留在后续 host slice，未被本轮宣称解决。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`64 passed / 0 failed`；
- `npm run test`：`128 test files / 1109 tests passed`；
- `npx vitest run src/dev/commandPolicy.test.ts`：`5 passed / 0 failed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；等待针对最终 snapshot 的独立 reviewer，当前仍不能标记 verified。

### 7.135 收紧 names-only Git、tail legacy option 与 find unary depth 于 unverified checkpoint

- `git diff --name-only` 现在必须使用显式 `--` 分隔符，拒绝无分隔符的 path-looking revision ambiguity；shared vectors 同步更新。
- `find` unary parser 从递归改为最多 128 层的迭代解析，超限直接拒绝；Node/Rust 都增加 129 层回归，避免 RangeError 或 native stack overflow。
- `tail` read intent 拒绝 `+N` legacy offset operand，避免把它解释为 stdin/起始行选项而绕过 scoped file grammar。
- 本轮仍未接入真实 Node/Rust runtime authority；8.3 alias、launcher/ComSpec、child-cwd 和 stable filesystem identity继续留在后续 slice。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`65 passed / 0 failed`；
- `npm run test`：`128 test files / 1109 tests passed`；
- `npx vitest run src/dev/commandPolicy.test.ts`：`5 passed / 0 failed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；等待针对最终 snapshot 的独立 reviewer，当前仍不能标记 verified。

### 7.136 增加 Node/Rust command input budget 与 malformed argv fail-closed 于 unverified checkpoint

- 针对 reviewer 发现的 sparse array、非字符串 token 和无界 argv，Node/Rust 共享并执行同一输入预算：最多 `256` 个 token、单 token 最多 `4096` UTF-8 bytes、总命令最多 `32768` UTF-8 bytes。
- Node 先检查数组密度和 token 类型，再进入 grammar；Rust 在 parser 入口执行同等预算检查；超限、hole、非字符串和超长 operand 均直接拒绝。
- 新增 Node sparse/non-string/oversized 回归，以及 Rust oversized command 回归；这仍是 test contract，不代表 parser 已接入真实 runtime authority。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`66 passed / 0 failed`；
- `npm run test`：`128 test files / 1110 tests passed`；
- `npx vitest run src/dev/commandPolicy.test.ts`：`6 passed / 0 failed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；等待针对最终 snapshot 的独立 reviewer，当前仍不能标记 verified。

### 7.137 收紧 inherited argv 与 malformed Unicode 边界于 unverified checkpoint

- Node command boundary 不再使用 `index in command`，改为 own-property 校验，拒绝通过 `Array.prototype`/自定义 prototype 注入的 inherited token。
- Node 在预算计算前拒绝未配对 UTF-16 surrogate，避免 TextEncoder replacement 与 Rust UTF-8 `String` 语言不一致。
- 新增 exact boundary 回归：4096/4097 token bytes、32768/32769 total bytes，以及 inherited token 和 lone surrogate；Rust 同步校验 token/total budget。
- 本轮仍未接入真实 runtime authority；下一步仍是 shared Git-diff intent 接入 Node capabilities 与 Rust dev_exec。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`66 passed / 0 failed`；
- `npm run test`：`128 test files / 1110 tests passed`；
- `npx vitest run src/dev/commandPolicy.test.ts`：`6 passed / 0 failed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；等待针对最终 snapshot 的独立 reviewer，当前仍不能标记 verified。

### 7.138 使用 trusted snapshot 拒绝 exotic Node argv 于 unverified checkpoint

- Node parser 在 grammar 前读取 own data descriptors，拒绝 inherited getter、own accessor 和 descriptor 读取异常；只把可信 token snapshot 交给后续解析，caller 自带的 `slice/some` shadow 不再影响 intent。
- 新增 inherited getter 不触发、own accessor 拒绝和 shadowed `slice` 仍按可信 token 正确解析的回归。
- 本轮仍未接入真实 runtime authority；8.3 alias、launcher/ComSpec、cwd/identity 和 cleanup/recovery 保持后续 slice。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`66 passed / 0 failed`；
- `npm run test`：`128 test files / 1110 tests passed`；
- `npx vitest run src/dev/commandPolicy.test.ts`：`6 passed / 0 failed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；等待针对最终 snapshot 的独立 reviewer，当前仍不能标记 verified。

### 7.139 采用固定 length trusted snapshot 收紧 Proxy argv 于 unverified checkpoint

- Node snapshot 在 try/catch 内一次捕获并验证 length：必须是 `1..256` 的 safe integer；随后只遍历固定长度的 own data descriptor，并在结束时 recheck live length，拒绝 revoked、throwing-length、fractional-length、growth/shrink Proxy。
- 新增 Proxy 回归：revoked、throwing length、非整数 length、mutable shrink/growth；避免预算绕过、sparse intent 和未捕获异常。
- 本轮仍未接入真实 runtime authority；下一步仍是 shared Git-diff intent 接入 Node capabilities 与 Rust dev_exec。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`66 passed / 0 failed`；
- `npm run test`：`128 test files / 1110 tests passed`；
- `npx vitest run src/dev/commandPolicy.test.ts`：`6 passed / 0 failed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；等待针对最终 snapshot 的独立 reviewer，当前仍不能标记 verified。

### 7.140 补齐 shared protected roots 与日志时间范围于 unverified checkpoint

- shared Node/Rust protected roots 与既有 `defaultDevPolicy` 对齐，新增 `src/store/workflowStore.ts`、`src/engine/executor.ts`，并将 `.git`、`.slimemold` metadata roots 明确列为不可读的 protected roots。
- vectors 覆盖 exact file、ancestor、case-fold alias、metadata root 和 `git/cat/ls/grep/find` 多入口；修复了 `workflowStore.ts` 大小写比较导致的 Windows protected-path 漏洞。
- DEVELOPMENT_LOG front matter 更新为 `updated: 2026-09-18`、period 至 `2026-09-18`。
- 本轮仍未接入真实 runtime authority；Slice 0 reviewer 通过前不标记 verified。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`66 passed / 0 failed`；
- `npm run test`：`128 test files / 1110 tests passed`；
- `npx vitest run src/dev/commandPolicy.test.ts`：`6 passed / 0 failed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；等待针对最终 snapshot 的独立 reviewer，当前仍不能标记 verified。

### 7.141 shared Git-diff intent 接入 Node/Rust runtime 于 unverified checkpoint

- Node `createNodeDevService` 的 `shellRun`、`gitDiff`、`gitChangedFiles` 现在先通过 shared `parseWorkerCommand`，再由 `buildSafeGitDiffArgs` 构造固定 invocation；raw `git diff` 不再绕过 parser。
- Rust 将 `dev_command_policy` 编译进 production host；worktree `git diff` gate 使用 shared intent，`dev_exec` 在 canonicalization 后重写为固定 argv。
- 所有 scoped/name-only Git diff 均强制 `--no-pager`、`--no-ext-diff`、`--no-textconv`，并保留 Node/Rust sanitized environment：不继承 `GIT_EXTERNAL_DIFF`、`GIT_DIFF_OPTS`、`GIT_PAGER`、`GIT_CONFIG_*`、`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE` 等配置驱动入口。
- 旧 unscoped/path-ambiguous Git diff 断言改为显式 `revision -- pathspecs`；H4 fake runner 同步新的 invocation contract。
- 当前仍未处理 main-repo legacy `run_git`、stable filesystem identity、launcher lifecycle、cleanup lineage 与 orphan recovery；本轮不宣称这些边界已完成。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`67 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx vitest run src/dev/commandPolicy.test.ts src/dev/capabilities.test.ts`：`2 files / 22 tests passed`；
- `npx vitest run src/dev/node-run.test.ts src/nodes/dev/index.test.ts`：`4 files / 46 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- disposable Git probe：配置 `diff.external` helper 后执行固定 `--no-pager --no-ext-diff --no-textconv` invocation，marker 未生成，exit 0；
- 本轮未 push、未 merge、未修改凭据或外部系统；Slice 1 当前仍为 unverified。

### 7.142 修复 Tauri hardened Git diff gate 与 WebView hardlink hook 于 unverified checkpoint

- Rust worktree gate 现在接受 Node/Tauri builder 的完整 `git --no-pager diff --no-ext-diff --no-textconv ...` argv，并拒绝缺少或替换固定控制参数的变体；raw `git diff` 仍在 host 内重写为 hardened invocation。
- raw Git diff 在 Rust `dev_exec` 的 path validation/canonicalization 前完成 rewrite，避免 canonicalized absolute pathspec 被再次当作 raw grammar 拒绝。
- `fs_guard` 的 `dev_exec_validate_paths` 与 `canonicalize_dev_exec_args` 同步识别 hardened Git diff，继续对 `--` 后 pathspec 做存在性、symlink/real-path 和 worktree containment 检查。
- Node capability 增加可注入 hardlink checker；headless 默认使用 `node-run` stat 检查，Tauri WebView 不再调用缺失的 `node:fs/promises.stat` shim，最终 hardlink authority 由 Rust `dev_exec` 执行。
- 新增 Tauri exact argv、Rust hardened gate、Rust fs_guard canonicalization 和 WebView hardlink delegation 回归；本轮修复后尚未重新获得独立 reviewer verdict。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`69 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx vitest run src/dev/tauri-run.test.ts src/dev/capabilities.test.ts src/dev/commandPolicy.test.ts`：`3 files / 31 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.143 收紧 Rust hardened Git recursive pathspec 于 unverified checkpoint

- reviewer 发现 direct Tauri `git --no-pager diff --no-ext-diff --no-textconv HEAD -- .` 可绕过 Node path policy；Rust hardened gate 现在在 canonicalization 后按 worktree-relative key 重新检查 Git pathspec。
- 拒绝 worktree root、`.`、dot-segment canonical root、`src`/`src/store` 等 protected ancestor、protected exact/descendant、`.git` 和 `.slimemold`；安全的 `src/components` pathspec 保持可用。
- 新增 Rust recursive protected-path regression，并保留 hardened gate、fs_guard canonicalization、Tauri exact argv 和 Node/Rust 全量回归。
- reviewer 同时指出 check/canonicalize/spawn 之间仍存在 path identity TOCTOU；本轮不伪称 race 已闭合，stable worktree/file identity 是下一条独立 slice。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`70 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx vitest run src/dev/tauri-run.test.ts src/dev/capabilities.test.ts src/dev/commandPolicy.test.ts`：`3 files / 31 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.144 对齐 Rust recursive Git protected matcher 的跨平台 case-fold 于 unverified checkpoint

- 修复 Unix/macOS 下 `git_diff_pathspec_allowed` 未 lower-case relative key 的差异；现在 `workflowStore.ts`、`src/Store`、`.GIT`、`.SLIMEMOLD` 等大小写 alias 与 Windows protected policy 一致拒绝。
- 保留 `src/components` 安全路径放行和 root/ancestor/exact/descendant 递归语义；新增跨平台 alias regression。
- stable check/canonicalize/spawn identity TOCTOU 仍是下一条 stable worktree/file identity slice，不在本轮宣称已解决。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`70 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.145 拒绝 hardened Git pathspec bracket magic 于 unverified checkpoint

- reviewer 发现 Rust hardened pathspec 只拒绝 `*`/`?`，未拒绝 `[`/`]`；Git 可将 `package[.]json`解释为 glob，绕过 literal protected-path 检查。
- hardened pathspec grammar 现在与 shared literal path policy 对齐，拒绝 bracket magic；新增固定 hardened argv 回归，保留安全 path 和 protected ancestor/case-fold 检查。
- stable check/canonicalize/spawn identity TOCTOU 仍保留为下一条独立 identity slice。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`70 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.146 拒绝 hardened Git pathspec colon magic 于 unverified checkpoint

- reviewer 发现 Git pathspec 仍接受 `:(icase)`、`:(top)`、`:/`、`:!`、`:^`、`:(attr:...)` 和 `:(literal)` 等 colon-leading magic。
- hardened pathspec grammar 现在拒绝 colon-leading operand，同时保留合法 Windows drive path（如 `C:/...`）；新增完整 magic variants 回归。
- stable check/canonicalize/spawn identity TOCTOU 仍保留为下一条独立 identity slice。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`70 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.147 为已登记 Worker worktree 绑定 stable directory identity 于 unverified checkpoint

- Rust `RegisteredWorktree` 现在保存 registration-time directory identity：Unix 使用 device/inode，Windows 使用 volume serial/file index，并保留 canonical path。
- `dev_register_worktree`、`dev_restore_worktree` 在登记时绑定 identity；后续 `dev_cwd_kind` 重新读取已登记根目录 identity，检测同路径目录替换后 fail-closed。
- 新增 same-path replacement regression；本轮只闭合“已登记 worktree 根目录 identity”这条 slice，文件 operand handle/no-follow、parent replacement、spawn 前 TOCTOU 和 Node WorktreeManager 对等 identity 仍未完成。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`71 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.148 修复 lexical registration 先于 canonicalization 的 worktree redirect bypass 于 unverified checkpoint

- reviewer 发现 `dev_cwd_kind` 先 canonicalize cwd 后再选择 registration：registered A 被 junction/symlink 重定向到 registered B 时，可能借用 B identity 放行。
- 新增 lexical cwd → registration 选择；只有 lexical path 命中原 registration，且原 worktree identity 仍匹配、canonical target 仍在原 root 内时才允许执行；未命中 registration 的 canonical alias 在存在 registrations 时 fail-closed。
- 新增真实 A→B directory-link regression；非 Unix/Windows 平台 identity 不再使用 `(0,0)` 伪稳定值。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`72 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.149 收紧 base identity 与 restore identity conflict 于 unverified checkpoint

- 为 `base_repo` 绑定 registration-time stable directory identity；base path 被替换、或被重定向到 registered worktree 时，main-repo lexical exception fail-closed。
- `dev_restore_worktree` 遇到同 generation/path/branch 的不同 identity 不再静默接受或形成歧义 registration，直接拒绝 identity conflict。
- 新增 base→registered-worktree redirect regression；文件 operand handle/no-follow、parent replacement after cwd validation、spawn TOCTOU 与 Node 对等 identity仍留在后续 slice。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`73 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.150 强制 base identity invariant 并收紧 register/restore/orphan rebind 于 unverified checkpoint

- `assert_session_generation` 现在要求 `base_repo` 与 `base_identity` 同时存在；partial session state 直接 fail-closed。
- `dev_cwd_kind` 不再允许非 lexical base alias 落入旧 canonical-path fallback；base replacement、重复分隔符/`.` alias 均拒绝。
- `dev_register_worktree`、`dev_restore_worktree`、`dev_register_orphan_worktree` 在初始读取、Git probe 前和最终 state read-back 均重新比较 base identity。
- `stable_directory_identity` 拒绝 Unix `dev/ino` 或 Windows volume/file-index 为零的不可用标识。
- restore 使用 all-duplicate conflict 检查；新增 duplicate identity conflict、base alias regression，并迁移 direct-state tests 到 stable identity invariant。
- 文件 operand handle/no-follow、parent replacement after cwd validation、spawn TOCTOU 与 Node 对等 identity仍留在后续 slice。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`75 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,158.11 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.151 收紧 base rebind、registration identity conflict 与 orphan live-target gate 于 unverified checkpoint

- 新增统一 `assert_base_identity_current`；`assert_session_generation`、`dev_cwd_kind` 和 `dev_base_repo` 在使用主仓库路径前重新绑定 stable identity，registered worktree early-return 不再绕过 base replacement 检查。
- `dev_register_worktree` 在 duplicate registration 中比较 target identity；same path/branch 的 replacement identity 不再 consume lease 或保留旧 binding。
- register/restore/orphan 在 Git probe 后、state commit 前和最终 state read-back 继续比较 base identity；orphan 只接受受控、branch 仍存在且目标目录已消失的 branch-only lineage，live listed/existing target 拒绝。
- 新增 partial base + registered candidate、same-path registration identity conflict、live orphan target 和真实 temp session fixture 回归。
- 文件 operand handle/no-follow、parent replacement after cwd validation、spawn TOCTOU 与 Node 对等 identity仍保留为后续 slice；本轮未宣称 check/use race 已完全消除。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`77 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,158.11 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.152 收紧 target metadata、cleanup capability identity、trusted restore 与 branch-only cleanup 于 unverified checkpoint

- `assert_base_identity_current` 增加 filesystem check 后的 session read-back；Antigravity Worker 纳入 `lock_dev_operation`，避免项目切换与 workspace writes/CLI spawn 并发交错。
- register/restore 在 Git probe 后重新比较 target directory identity；restore 仅接受已有 trusted host registration 提供的 historical identity，跨重启缺少 trusted identity 时 fail-closed，不把当前同路径目录重绑定为历史 worktree。
- `dev_path_allowed` 对已登记 registration 重新绑定 root identity，防止替换后的 worktree继续放行文件操作。
- orphan recovery 使用 `symlink_metadata` 区分目录、regular file、broken symlink 和缺失路径；无论目标目录是否存在都执行 Git listing/branch probe，并拒绝 live listed、branch 已在其他 worktree checkout 或重新出现的 target。
- `worker_target_is_safe_for_existing_operation` 现在要求真实目录，regular file不能进入 cleanup/update-ref 路径。
- cleanup approval要求 registered target identity与原 registration一致；orphan capability只能绑定缺失 target。cleanup binding同时绑定 base identity与target identity；approval dialog后、branch CAS前后、worktree remove前和state read-back均重新验证 identity。
- branch-only orphan cleanup允许缺失目录在branch-tip CAS后完成；registered target若CAS后Git listing消失、Git probe失败或target identity漂移，则保持未知结果并不清除host lineage。
- pending rollback lease保存creation-time target identity；worktree remove/lock/unlock只接受identity仍匹配的当前target。
- generic `dev_exec` 在spawn前再次执行cwd/registration identity gate；`dev_create_dir`、`dev_read_file`、`dev_write_file` 在相对路径解析前重新绑定base identity。
- 新增 partial base真实temp-path、regular-file target、branch-only cleanup identity回归；文件 handle-relative/no-follow、parent replacement 与 spawn check/use race仍是明确 residual，Node 对等 identity尚未实现。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`79 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,158.11 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.153 收紧 strict Git listing、rollback branch CAS、Node identity 与 unregister gate 于 unverified checkpoint

- `git worktree list --porcelain` 现在要求非空、未截断且结构完整的 worktree/HEAD blocks；malformed、unknown field、empty/truncated output统一 fail-closed，不再把 probe异常当作 absence。
- pending rollback lease保存创建时 branch revision；`update-ref -d` rollback gate必须匹配该host-owned revision，不能由调用方用同名branch的新tip替代。
- `dev_unregister_worktree` 对仍有 registered/orphan lineage的路径拒绝裸注销；只有native cleanup已清除lineage后的幂等 read-back可返回成功。
- Node `WorktreeInfo` 在默认 Node runtime保存 creation-time `dev:ino` identity；restore、created cleanup和orphan cleanup重新比较当前对象，替换目录不再复用旧lineage；Tauri路径继续由Rust authority负责。
- Node/Tauri仍保留平台相关 handle-relative/no-follow、parent replacement与最终spawn check/use race为明确 residual；Node custom fake runner和跨重启无trusted identity的恢复仍需后续专门证据。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`79 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.30 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.154 收紧 bound file identity 与 Node headless replacement fencing 于 unverified checkpoint

- Rust `dev_read_file`/existing-target `dev_write_file` 在 preflight capture file identity，并在真实 `O_NOFOLLOW`/reparse-aware bound handle打开后重新比较 device/inode 或 volume/file-index；same-path file replacement被拒绝，旧对象不会写入新路径对象。
- 新增 bound file replacement regression；新增 `StableFileIdentity` platform helper，hardlink检查与bound handle identity检查同时保留。
- Node默认 headless `WorktreeManager`保存 creation-time `dev:ino` identity；create失败时尝试回滚，restore、created cleanup、orphan cleanup和remove后 read-back均拒绝替换对象。
- parent-directory replacement、missing-target create/openat、Windows完整 handle-relative mutation、最终spawn check/use race与Node custom fake runner仍为明确 residual；本轮不宣称所有外部filesystem race已原子消除。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`80 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.30 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.155 引入 Unix handle-relative parent/file open seam 于 unverified checkpoint

- Unix read/write bound path改用逐级 directory-fd `openat`，每层使用 `O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC`，最终文件使用 `O_NOFOLLOW`；parent被替换为symlink时操作失败，不跟随到外部目录。
- Unix missing-target create改用parent-fd `openat(O_CREAT|O_EXCL|O_NOFOLLOW)`；unsupported平台的bound read/write fallback改为显式error，避免未来call-site绕过identity gate。
- Windows仍保留reparse-aware final handle与StableFileIdentity校验；Windows parent-relative完整原子mutation、macOS/Linux native matrix仍需后续平台专项验证。
- Unix `dev_exec` spawn前绑定cwd directory fd，并在子进程中使用 `fchdir`；Unix路径不再在最终spawn阶段重新解析cwd。Windows仍使用pathname `current_dir`，该平台race保持明确 residual。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`80 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.30 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.156 收紧 Unix parent identity、cwd type 与 FIFO acquisition 于 unverified checkpoint

- Unix `openat` traversal在最终文件打开前比较实际parent fd与preflight canonical parent identity；existing read/write和missing create共同使用这一parent binding。
- Unix cwd acquisition强制`O_DIRECTORY`，打开后再次比较cwd directory identity；regular file/FIFO不能成为spawn cwd；regular file bound open增加`O_NONBLOCK`，避免FIFO在host timeout前阻塞。
- `/`作为合法Unix directory cwd不再被错误拒绝；Windows目录identity继续复用`FILE_FLAG_BACKUP_SEMANTICS`路径。
- ordinary-directory replacement、hardlink addition after open、Windows parent-relative atomic mutation、macOS/Linux native matrix仍需后续专项验证；本轮不宣称所有跨平台race已闭合。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`80 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.30 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.157 让授权 cwd/file identity贯穿最终Unix fd acquisition 于 unverified checkpoint

- `dev_cwd_binding`现在在同一授权流程中返回 `DevCwdKind + StableDirectoryIdentity`；spawn前检查ownership未变化，并把这份exact identity传入Unix cwd `openat` final fd compare，不再在最后一步从可能已替换的路径重新生成expected。
- Unix read/write/create在`dev_path_allowed(parent)`之后capture parent identity；bound open同时比较parent fd与final file identity。Windows仍保留final handle identity，并显式拒绝非regular write target。
- existing write target与bound write fd都拒绝FIFO/device等非regular object；hardlink count检查仍保留。新增逻辑不宣称 hardlink addition after open、Windows parent-relative atomic mutation、Linux/macOS native matrix已完全闭合。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`80 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.30 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.158 保持初始cwd identity贯穿最终spawn授权 于 unverified checkpoint

- `dev_exec`初次授权现在直接保留 `dev_cwd_binding` 返回的 `DevCwdKind + initial_cwd_identity`；spawn前必须同时匹配初始kind和initial identity，same-path child directory replacement不会只因kind相同而重新授权。
- Unix cwd fd acquisition继续使用spawn阶段binding返回的exact identity做final fd compare；hardlink addition race、Windows parent-relative mutation和native Linux/macOS证据仍未闭合。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`80 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.30 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.159 抽取 Rust process capture/timeout lifecycle seam 于 unverified checkpoint

- 新增 `src-tauri/src/dev_process.rs`，集中持有 `DevExecResult`、stdout/stderr bounded capture、timeout polling、wait、join和错误收敛。
- `lib.rs`保留 `kill_dev_child_tree` 作为平台相关launcher policy注入点，通过薄wrapper调用 `dev_process::run_with_timeout`；Codex复用的crate-private output helper保留单一实现转发，不复制逻辑。
- 本轮未移动 command policy、cwd/identity、Windows trusted program/ComSpec resolution；Windows `current_dir`→CreateProcess race、native Linux/macOS runtime evidence和hardlink atomicity仍明确为后续残余。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`80 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.30 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.160 收紧 process timeout cleanup、checked output capture 与process-group lifecycle 于 unverified checkpoint

- `dev_process`共享`DEV_OUTPUT_CAP`，`drain_child_output_checked`对Interrupted重试、对其他I/O错误显式返回；不再把读取错误静默当作EOF。
- timeout错误使用实际timeout毫秒；stdout/stderr通过channel bounded receive，超时或pipe descendant不再无界join阻塞host operation lock。
- Unix process启动时建立process group，timeout callback尝试kill整个group后再direct kill；Windows继续使用taskkill tree + direct kill，Job Object级别完整保证仍是Windows residual。
- 新增process模块直测：output cap、Interrupted reader、non-zero exit；本轮仍不宣称Windows current_dir race、native Linux/macOS matrix和hardlink atomicity已闭合。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`83 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.30 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.161 收紧 descendant pipe error、Codex checked capture 与unknown propagation 于 unverified checkpoint

- process output receiver在post-exit pipe descendant/reader failure时先调用同一kill callback再返回；dev_exec不再把capture/timeout错误伪装成普通`DevExecResult{code:-1}`，错误文本明确标记`side effects unknown`。
- Codex stdout/stderr reader改用Result-returning checked capture；正常完成时I/O错误上抛，移除legacy silent EOF helper。
- 保留Unix process-group kill与Windows taskkill/direct-kill策略；Windows Job Object、Windows current_dir race、native Linux/macOS matrix和hardlink atomicity仍未闭合。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`83 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.30 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.162 统一Codex descendant cleanup与bounded checked output lifecycle 于 unverified checkpoint

- Codex Unix child现在建立process group，timeout/cancel/reader error使用group kill + direct kill；reader错误路径统一执行child reap、active registry unregister和临时output文件清理。
- Codex stdout/stderr复用`dev_process`的bounded channel reader/receive，不再使用无界JoinHandle join或silent EOF helper；正常完成的非Interrupted reader错误显式上抛并标记side effects unknown。
- Windows Job Object、Windows current_dir race、native Linux/macOS matrix和hardlink atomicity仍明确为后续残余；本轮不宣称所有native process entry point都已闭合。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`83 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.30 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.163 收紧Codex cancellation atomicity、success descendant cleanup与output-last-message cap 于 unverified checkpoint

- active Codex registry与cancel现在按同一lock顺序处理；cancel在child kill/reap完成前不移除active entry，避免operation id过早复用和stale PID cleanup。
- Codex leader退出后主动清理其process group；`--output-last-message`改为16MiB bounded read，overflow/read failure标记side effects unknown并清理registry/temp file。
- Windows Job Object、Windows current_dir race、native Linux/macOS matrix和hardlink atomicity仍未闭合；本轮不宣称Codex/所有native process lifecycle全部verified。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`83 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.30 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.164 收紧Codex generation lease、output file authority与unknown-effects transport 于 unverified checkpoint

- pending Codex operation改为单一 generation-tagged registry；cancel、begin、register和finish共享状态边界，旧run的finish不能移除新run的同ID lease；新增 stale-generation regression。
- active child unregister改为按 `Arc` exact handle compare-and-remove，不再仅凭operation id删除可能已复用的active entry；output/read finalization完成前保持active lease。
- `--output-last-message`先用 `symlink_metadata`拒绝symlink、directory、FIFO等非regular object，再使用Unix `O_NOFOLLOW|O_NONBLOCK`或Windows reparse-aware open，并限制16MiB读取；unlink失败显式进入unknown-effects路径或记录cleanup uncertainty。
- Node/Tauri `CommandResult`增加可选 `unknownEffects`，Tauri host invoke/cleanup失败不再只表现为普通 `exitCode: -1`。
- Windows Job Object、Windows current_dir race、native Linux/macOS matrix、Unix process-group escape和hardlink atomicity仍未闭合；本轮不宣称process lifecycle已verified。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`84 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.35 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.165 收紧Codex launch authority、session-generation cancellation与stdin/output lifecycle 于 unverified checkpoint

- Codex output改为temp下唯一私有目录中的`create_new` regular file，Unix使用0600权限；cleanup同时处理文件和私有目录，read阶段继续使用no-follow/nonblock和16MiB上限。
- Codex Worker在最终spawn前重新通过Rust `dev_cwd_binding`比较cwd stable identity；本检查降低path replacement窗口，但不宣称Windows `current_dir`到CreateProcess已原子闭合。
- stdin写入改为独立writer并纳入30分钟执行预算，主执行线程不再被阻塞式`write_all`永久卡住；writer无法在收尾窗口结束时返回unknown-effects。
- Codex executable解析拒绝最终symlink并使用canonical regular file；Windows cleanup使用SystemRoot下可信`taskkill.exe`，不再依赖PATH裸命令。
- `codex_worker_cancel`携带session generation，pending/active entry保存并比较generation；前端abort链路已传递同一generation，旧session取消不会触碰新child。
- Windows Job Object、Windows current_dir原子spawn、Unix setsid/pidfd级descendant containment、operation-id调用方唯一性、native Linux/macOS matrix、hardlink atomicity及unknownEffects在所有上层recovery消费者中的完整传播仍未闭合；本轮不宣称Codex launch/process lifecycle已verified。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`84 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.40 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.166 修复Codex finalization lock order、stdin bounded cleanup与spawn failure cleanup 于 unverified checkpoint

- `cleanup_codex_run`现在先按 active-registry→child-handle顺序释放exact handle，再kill/reap；与cancel路径统一锁序，消除并发cleanup/cancel的ABBA deadlock。
- timeout与`try_wait`错误路径等待stdin writer的bounded收尾窗口；writer未结束会保留unknown-effects语义，不再随执行线程无界遗留。
- `Command::spawn`失败现在清理已创建的exclusive output file和私有目录；此前命令未启动也可能留下临时工件。
- Windows Job Object/current_dir原子spawn、Unix setsid/pidfd descendant containment、host-issued worker capability、operation-id调用方唯一性、native Linux/macOS matrix、hardlink atomicity和完整unknownEffects recovery propagation仍未闭合；本轮不宣称process lifecycle已verified。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`84 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.40 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.167 引入host-issued Codex Worker lease与abort-before-begin fencing 于 unverified checkpoint

- 新增 `codex_worker_prepare`：Rust在当前session与已登记worktree校验通过后生成一次性lease token，并绑定session generation与canonical worktree path；`codex_worker_exec`不再接受renderer自造operation id作为active capability。
- 前端Codex Worker先申请host lease，再执行；AbortSignal在lease申请前置为pending abort，lease返回后立即调用generation-matched cancel，避免abort-before-begin丢失。
- prepared、pending、active三阶段均比较session generation；cancel只标记匹配generation，旧session/旧lease不能触碰新child；exec要求token未使用且cwd与prepare绑定路径一致。
- `dev_cwd_binding`最终recheck的错误和identity mismatch路径显式清理output file/directory；host lease不宣称已经完成task/attempt lineage capability或Windows/Unix原子spawn containment。
- Windows Job Object/current_dir原子spawn、Unix setsid/pidfd descendant containment、renderer prompt/task lineage授权、stdin detached writer强制关闭、native Linux/macOS matrix、hardlink atomicity和完整unknownEffects recovery propagation仍未闭合；本轮不宣称Codex process lifecycle已verified。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`84 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.168 收紧prepared lease TTL/identity、cancel consumption与finalization linearization 于 unverified checkpoint

- prepared lease增加5分钟TTL与128条cap；prepare先在host operation lock内校验session/worktree并清理过期entry，避免abandoned prepare造成无界内存增长。
- lease绑定stable directory identity；exec同时比较session、canonical path与identity，same-path replacement/re-registration不会重新授权旧lease。
- prepared cancel现在消费匹配generation的lease；exec在prepared race失败时finish pending，避免prepared/pending registry泄漏。
- pending finish改为与cancel共享锁的线性化点：cancel先写入标记则Worker返回unknown-effects，finish先移除则后到cancel视为已完成，不会在finalization竞态下错误报告成功。
- host-issued lease仍不包含task/attempt lineage或prompt权限约束；Windows Job Object/current_dir原子spawn、Unix descendant containment、stdin强制关闭、native Linux/macOS matrix、hardlink atomicity和完整unknownEffects recovery propagation仍未闭合；本轮不宣称Codex process lifecycle已verified。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`84 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.169 收紧Codex lease expiry fail-closed、session purge与prepared identity传递 于 unverified checkpoint

- exec现在强制检查prepared lease TTL并消费过期token；prepare/clear session切换会清理旧prepared leases，避免旧generation占用新session cap。
- `finish_pending_operation`改为Result返回；pending registry poison不再被解释为“没有取消”，而是直接返回unknown/fail-closed错误；begin后prepared registry获取失败也会清理pending entry。
- prepared stable identity现在沿worker调用链传入`run_exec`最终spawn授权，不再从可变cwd路径重新生成预期identity；read-only provider仍使用正常cwd binding路径。
- host-issued lease仍不包含task/attempt lineage或prompt权限约束；Windows Job Object/current_dir原子spawn、Unix descendant containment、stdin强制关闭、native Linux/macOS matrix、hardlink atomicity和完整unknownEffects recovery propagation仍未闭合；本轮不宣称Codex process lifecycle已verified。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`84 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.170 收紧Codex pending registry poison、missing finalization与pre-spawn cancellation fail-closed 于 unverified checkpoint

- `take_cancelled_operation`现在返回Result，pending registry poison在spawn前直接阻断，不再被解释为false/未取消。
- `finish_pending_operation`对missing或generation mismatch显式返回unknown/fail-closed错误；finalization不再把异常状态当作成功完成。
- 所有begin后prepared registry获取失败路径都先尝试finish pending，再返回错误，避免操作token永久卡在pending。
- host-issued lease仍不包含task/attempt lineage或prompt权限约束；Windows Job Object/current_dir原子spawn、Unix descendant containment、stdin强制关闭、native Linux/macOS matrix、hardlink atomicity和完整unknownEffects recovery propagation仍未闭合；本轮不宣称Codex process lifecycle已verified。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`84 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.171 引入Codex pre-spawn active/pending reservation 于 unverified checkpoint

- active/pending registry现在在Command::spawn前以统一锁序（active→pending）预留；reservation跨越spawn并在child创建后直接插入active，cancel必须等待reservation完成，消除检查取消后到spawn/register之间的窗口。
- 删除旧的spawn后register authority，active registry poison、pending lease丢失或reservation冲突会在child启动前fail-closed；spawn失败由外层pending finalization处理。
- host-issued lease仍不包含task/attempt lineage或prompt权限约束；Windows Job Object/current_dir原子spawn、Unix descendant containment、stdin强制关闭、native Linux/macOS matrix、hardlink atomicity和完整unknownEffects recovery propagation仍未闭合；本轮不宣称Codex process lifecycle已verified。

验证结果：

- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`84 passed / 0 failed`；
- `npm run test`：`128 test files / 1111 tests passed`；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 仍为 unverified。

### 7.172 verified：Codex pre-spawn active/pending reservation

- 最终fail-closed reviewer针对精确HEAD `73aec5081ee9e1ebe46a7e27653efe48c235881a`返回：`passed=true`、`security_concerns=[]`、`logic_errors=[]`。
- verified tag：`checkpoint/native-codex-pre-spawn-reservation-verified`，指向上述reviewed HEAD；该tag创建后未修改代码。
- 本slice验证锁序、spawn前reservation、child注册与cancel竞争边界；reviewer建议后续增加确定性interleaving regression，但不构成当前slice阻塞。
- task/attempt lineage与prompt capability、Windows Job Object/current_dir原子spawn、Unix descendant containment、stdin detached writer强制关闭、native Linux/macOS matrix、hardlink atomicity和完整unknownEffects recovery仍属于未完成残余。

验证结果：

- Rust：`84 passed / 0 failed`；
- Node：`128 test files / 1111 tests passed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有dynamic/static import与大bundle warning保留，最大产物约`1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN对齐；
- `git diff --check`：通过；
- 本轮未push、未merge、未修改凭据或外部系统。

### 7.173 unverified：Codex operation binding 强制 session generation

- `src-tauri/src/codex.rs` 新增唯一 `validate_operation_binding` seam：带 `operation_id` 的执行必须同时带 non-zero `session_generation`；只带其中一个或 generation 为零均 fail-closed。
- 新增 `reserve_codex_operation`，统一 active→pending 锁序，并在 spawn reservation 时比较 `PendingOperation.session_generation`；取消标记、operation 重用和 generation mismatch 都不能进入 child spawn。
- 新增 3 个 Rust 回归：operation binding 完整性、已取消 pending reservation 拒绝、跨 session generation reservation 拒绝；保留原有 stale-generation 与 cancellation 测试。
- task/attempt lineage 与 prompt capability、Windows Job Object/current_dir 原子spawn、Unix descendant containment、stdin detached writer强制关闭、native Linux/macOS matrix、hardlink atomicity和完整unknownEffects recovery仍未闭合；本 checkpoint 不标记 verified。

验证结果：

- Rust：`87 passed / 0 failed`；Codex targeted：`9 passed / 0 failed`；
- Node：`128 test files / 1111 tests passed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统。

### 7.174 verified：Codex operation binding reviewer closure

- fail-closed reviewer审查精确HEAD `5f93dd49769a9d480e69a83f94afe4bac545dcdf`及其相对`3c6914f1e05cd0e01f6f46789b95312df163cdf`的完整diff，返回`passed=true`、`security_concerns=[]`、`logic_errors=[]`。
- verified tag：`checkpoint/native-codex-session-generation-binding-verified`，经read-back确认指向reviewed HEAD；tag创建后未修改代码。
- reviewer确认：partial/zero operation binding被拒绝；active→pending reservation在spawn期间保持；pending session generation被核对；cancel与session reset路径保持fail-closed。
- reviewer非阻塞建议：补充spawn前确定性interleaving测试；将`PendingOperation.generation`继续纳入reservation stale-operation fence；对防御性post-spawn注册失败显式清理child/output。这些不影响本slice verified，但属于下一步加固。

验证结果：

- Rust：`87 passed / 0 failed`；Codex targeted：`9 passed / 0 failed`；
- Node：`128 test files / 1111 tests passed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统。

### 7.175 unverified：Codex spawn reservation interleaving 与 stale generation fence

- `CodexSpawnReservation` 统一持有 active→pending registry guard，并保存 `PendingOperation.generation`、session generation 和 operation id；child 注册必须在同一 reservation 内重新核对三者与 cancellation 标记。
- `run_exec` 将 pending operation generation 传入 reservation；stale pending generation、session generation mismatch、取消中的 operation 都在 spawn 前 fail-closed。
- 新增 `cleanup_unregistered_codex_child`：防御性 child 注册失败会 kill/wait child、释放 handle、join stdout/stderr reader、删除私有 output artifact；cleanup失败显式返回 `side effects unknown`。
- 新增确定性 reservation/cancel interleaving 回归：cancel 线程在 active→pending reservation持锁期间不能越过 child 注册；释放 reservation 后才完成取消并保留 pending finalization。
- task/attempt lineage 与 prompt capability、Windows Job Object/current_dir 原子spawn、Unix descendant containment、stdin detached writer强制关闭、native Linux/macOS matrix、hardlink atomicity和完整unknownEffects recovery仍未闭合；本 checkpoint 不标记 verified。

验证结果：

- Rust：`88 passed / 0 failed`；Codex targeted：`10 passed / 0 failed`；
- Node：`128 test files / 1111 tests passed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- 本轮未 push、未 merge、未修改凭据或外部系统。

### 7.176 unverified：Codex termination fencing 与 cleanup recovery

- `terminate_child_checked` 现在先确认 child 已退出，再请求 Unix process-group/Windows taskkill/direct kill，并以 bounded `try_wait`确认终止；kill、wait、status读取或超时失败均保留 unknown-effects，不再静默丢弃。
- `cleanup_unregistered_codex_child` 在终止未确认时保留 child handle；`CodexSpawnReservation` 将其重新登记到 active registry供后续 cancel/recovery，不再 detach继续运行的 child。
- `cleanup_codex_run`、timeout、try_wait error、stdin/output failure路径统一传播 cleanup failure；成功终止后才 unregister和删除私有 output artifact。
- `CodexExecRequest` value object收敛`run_exec` binding，移除本轮新增的 too-many-arguments clippy告警；新增真实跨平台 child/reader/output-artifact cleanup回归。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`仍失败，但剩余报告只涉及既有`src-tauri/src/fs_guard.rs`、`src-tauri/src/lib.rs`和`src-tauri/src/dev_command_policy.rs`；本轮`codex.rs`相关告警已清零。本 checkpoint 不标记 verified。
- task/attempt lineage 与 prompt capability、Windows Job Object/current_dir原子spawn、Unix descendant containment、stdin detached writer强制关闭、native Linux/macOS matrix、hardlink atomicity和完整unknownEffects recovery仍未闭合。

验证结果：

- Rust：`89 passed / 0 failed`；Codex targeted：`11 passed / 0 failed`；
- Node：`128 test files / 1111 tests passed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：失败；仅报告既有 `fs_guard.rs`、`lib.rs`、`dev_command_policy.rs` lint；
- 本轮未 push、未 merge、未修改凭据或外部系统。

### 7.177 unverified：Codex shared cleanup context 与 cancellation recovery

- 新增 `CodexCleanupContext`，由 active child 持有私有 output path、stdout/stderr reader handles及完成状态；run_exec、cancel、timeout、try_wait error、stdin/output failure和registration failure共享同一 cleanup owner。
- `codex_worker_cancel` 现在只有在 bounded termination、pending cancellation标记、reader join和artifact removal全部确认后才移除 active；termination或cleanup不确定时保留 active child/context供重试恢复。
- cancellation state读取失败不再在 reader join前直接返回；reader handles通过 context 统一消费，已完成 reader不会被重复join；active unregister对registry poison、handle mismatch和非cancellation missing entry fail-closed。
- 新增/更新 interleaving与真实 child/reader/artifact cleanup回归；Codex request value object与lock-order invariant保留。
- clippy仍只被既有 `fs_guard.rs`、`lib.rs`、`dev_command_policy.rs` lint阻塞；本轮`codex.rs`无新增clippy告警。本 checkpoint 不标记 verified。
- task/attempt lineage 与 prompt capability、Windows Job Object/current_dir原子spawn、Unix descendant containment、stdin writer更深层 bounded join、native Linux/macOS matrix、hardlink atomicity和完整unknownEffects recovery仍未闭合。

验证结果：

- Rust：`89 passed / 0 failed`；Codex targeted：`11 passed / 0 failed`；
- Node：`128 test files / 1111 tests passed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：失败；仅报告既有 `fs_guard.rs`、`lib.rs`、`dev_command_policy.rs` lint；
- 本轮未 push、未 merge、未修改凭据或外部系统。

### 7.178 unverified：Codex post-exit ownership 与 recoverable reader cleanup

- 修复 post-exit termination 后重复消费 child handle 的路径；正常成功、非零退出、取消和异常 finalization 现在通过同一 `cleanup_codex_run` 顺序收敛，避免先 take child 再 artifact/unregister 的分叉。
- `CodexCleanupContext` 增加 per-reader joining 状态；reader bounded wait 超时或 channel 断开时保留 `(JoinHandle, Receiver)`，不伪标记 done，后续 recovery 可再次 join。
- cancellation 在 active→pending 锁序下先校验并标记 matching pending generation；pending 缺失或 generation 不匹配直接 fail-closed，不再终止 child 后静默成功。
- `unregister_child` 在 active/pending registry与 expected handle一致、且 handle可锁定后才移除并消费 child；registry poison、mismatch和非cancellation missing均传播 `side effects unknown`。
- 新增 exited-child single-consumption 与 reader-timeout retry 回归测试。本 checkpoint 不标记 verified；仍需 exact HEAD reviewer。
- Windows Job Object/current_dir原子spawn、Unix descendant containment、stdin writer深层 bounded join、native Linux/macOS matrix、hardlink atomicity、task/attempt lineage/prompt capability和完整 structured unknownEffects recovery仍未闭合。

验证结果：

- Rust：`91 passed / 0 failed`；Codex targeted：`13 passed / 0 failed`；
- Node：`128 test files / 1111 tests passed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：失败；最终仅报告既有 `fs_guard.rs`、`lib.rs`、`dev_command_policy.rs` lint，本轮 `codex.rs` 无新增告警；
- 本轮未 push、未 merge、未修改凭据或外部系统。

### 7.179 unverified：Codex recovery owner 与 pending fence retention

- `ActiveChild` 现在绑定 pending-operation generation；`finish_pending_operation`按 active→pending锁序检查同 generation active recovery，cleanup失败时不再删除 pending fence。
- cancellation同时校验 session generation与pending generation；active recovery、pending registry和child handle在同一锁序下收敛，generation漂移、pending丢失和registry异常均 fail-closed。
- termination未确认时不消费 reader或删除 output artifact；reader cleanup失败时也保留 artifact。registration failure即使 child已终止，只要 reader/artifact cleanup失败仍保留完整 recovery context。
- 无 operation id 的只读 `codex_exec`失败路径进入有上限的 host-owned unscoped recovery registry；后续普通 Codex调用先尝试 bounded retry，失败则继续保留并返回 unknown。
- spawn后 stdin初始化、status polling 的 handle lock/handle missing错误改走 shared cleanup，不再用 `?`直接丢弃 child/reader ownership；新增 active pending fence与unscoped recovery owner回归测试。本 checkpoint 不标记 verified。
- Windows Job Object/current_dir原子spawn、Unix descendant containment、stdin writer深层 bounded join、native Linux/macOS matrix、hardlink atomicity、task/attempt lineage/prompt capability和完整 structured unknownEffects recovery仍未闭合。

验证结果：

- Rust：`93 passed / 0 failed`；Codex targeted：`15 passed / 0 failed`；
- Node：`128 test files / 1111 tests passed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：失败；仅报告既有 `fs_guard.rs`、`lib.rs`、`dev_command_policy.rs` lint，本轮 `codex.rs` 无新增告警；
- 本轮未 push、未 merge、未修改凭据或外部系统。

### 7.180 unverified：Codex recovery slot、reader terminal state 与 session quiescence

- unscoped `codex_exec` 在 spawn 前预留有上限的 recovery slot；Reserved/Retrying状态计入 cap，slot满时在创建 child前拒绝，cleanup失败写回同一 slot，成功才释放，避免 cap overflow后丢失 child ownership。
- unscoped recovery retry不再用 `mem::take`移走所有条目；Retained会转为Retrying并继续占用槽位，新的普通 Codex调用不会绕过恢复上限。
- reader返回IO错误或thread panic时记录 terminal error并标记 joined/done；后续cleanup重复报告原始错误，不再伪报 reader未启动。timeout仍保留reader句柄；只有reader terminal或完全成功时才进入artifact cleanup。
- 修复 prepared lease mutex持有期间调用 pending finalization的死锁；`leases.remove`缺失分支先释放prepared锁，再处理pending。
- session init/clear改用 Codex quiescence gate：先处理 unscoped recovery，checked-cancel active child，验证 active/pending已收敛后才清 prepared leases；未取消 pending或cleanup失败会阻止旧session切换，避免旧generation泄漏到新项目。
- 新增 reader terminal error回归测试；本 checkpoint 不标记 verified，仍需 exact HEAD reviewer。本轮仍未闭合 Windows Job Object/current_dir原子spawn、Unix descendant containment、stdin writer深层 bounded join、native Linux/macOS matrix、hardlink atomicity、task/attempt lineage/prompt capability和完整 structured unknownEffects recovery。

验证结果：

- Rust：`94 passed / 0 failed`；Codex targeted：`16 passed / 0 failed`；
- Node：`128 test files / 1111 tests passed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：失败；仅报告既有 `fs_guard.rs`、`lib.rs`、`dev_command_policy.rs` lint，本轮 `codex.rs` 无新增告警；
- 本轮未 push、未 merge、未修改凭据或外部系统。

### 7.181 unverified：Codex execution/session lock boundary 与 terminal reader disconnect

- 普通只读 `codex_exec` 的 retry、auth、program resolve、spawn、cleanup和recovery owner现在都在 `DEV_OPERATION_LOCK` 内；session init/clear不会与 unscoped Codex process或recovery retry并发。
- Worker `prepare → pending begin → prepared lease consume → auth → spawn → cleanup → finish_pending`整体移动到同一 blocking host operation lease；不再在等待 host lock前创建 pending，session quiescence不会错过旧 worker。
- `clear_codex_session_state`只在同一 host lock内执行，未取消 pending、active cleanup failure或unscoped recovery failure都会阻止session切换；pending的最终移除仍由worker finalization负责。
- `RecvTimeoutError::Disconnected`现在join reader thread并记录terminal failure，不再保留已终止的JoinHandle；新增 disconnected-reader回归测试。
- 本 checkpoint 不标记 verified；Windows Job Object/current_dir原子spawn、Unix descendant containment、stdin writer深层 bounded join、native Linux/macOS matrix、hardlink atomicity、task/attempt lineage/prompt capability和完整 structured unknownEffects recovery仍未闭合。

验证结果：

- Rust：`95 passed / 0 failed`；Codex targeted：`17 passed / 0 failed`；
- Node：`128 test files / 1111 tests passed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：失败；仅报告既有 `fs_guard.rs`、`lib.rs`、`dev_command_policy.rs` lint，本轮 `codex.rs` 无新增告警；
- 本轮未 push、未 merge、未修改凭据或外部系统。

### 7.182 unverified：抽出 Codex cleanup/reader/artifact seam

- 新增 `src-tauri/src/codex_cleanup.rs`，承接 `CodexCleanupContext`、reader join/retry、terminal reader error、output artifact创建/读取/删除、stdin writer和cleanup constants。
- `codex.rs`仅通过显式 cleanup seam使用这些能力；本刀不改变 registry、spawn、权限或 session 语义，删除原 facade中的重复实现。
- 现有 Codex lifecycle与真实 child/reader/artifact测试保持通过；本 checkpoint 不标记 verified，下一刀继续抽 registry/lease authority。


验证结果：

- Rust：`95 passed / 0 failed`；Codex targeted：`17 passed / 0 failed`；
- Node：`128 test files / 1111 tests passed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 dynamic/static import 与大 bundle warning 保留，最大产物约 `1,159.81 kB`；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `git diff --check`：通过；
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`：失败；仅报告既有 `fs_guard.rs`、`lib.rs`、`dev_command_policy.rs` lint，本轮 `codex.rs` 无新增告警；
- 本轮未 push、未 merge、未修改凭据或外部系统。

### 7.183 unverified：抽出 Codex registry/lease authority

- 新增 `src-tauri/src/codex_registry.rs`，承接 `ActiveChild`、prepared lease、pending operation、session generation、spawn reservation及registry lock order。
- `codex.rs`保留Tauri command、session/cwd/lease编排和recovery orchestration；不再定义 active/pending/prepared registry状态机。
- 验证：Rust `95 passed / 0 failed`；Codex targeted `17 passed / 0 failed`；Node `128 test files / 1111 tests passed`；`cargo check`、`cargo fmt --check`、`npm run build`、`npm run i18n:check`（1026 keys）、`npx tsc --noEmit`、`git diff --check`通过。
- `cargo clippy --all-targets -- -D warnings`仍失败于既有 `fs_guard.rs`、`lib.rs`、`dev_command_policy.rs` lint；本轮未新增 `codex.rs` lint。build既有最大bundle约`1,159.81 kB` warning保留。
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.184 unverified：抽出 Codex process execution seam

- 新增 `src-tauri/src/codex_process.rs`，承接 `CodexExecRequest`、`CodexExecResult`、Codex usage/event解析、exec参数构造和 `run_exec` process lifecycle。
- `codex.rs`保留Tauri command、session/cwd/lease编排及现有cleanup/recovery orchestration；process执行通过既有registry reservation与cleanup seam，不改变行为语义。
- 验证：Rust `95 passed / 0 failed`；Codex targeted `17 passed / 0 failed`；Node `128 test files / 1111 tests passed`；`cargo check`、`cargo fmt --check`、`npm run build`、`npm run i18n:check`（1026 keys）、`npx tsc --noEmit`、`git diff --check`通过。
- `cargo clippy --all-targets -- -D warnings`仍失败于既有 `fs_guard.rs`、`lib.rs`、`dev_command_policy.rs` lint；本轮未新增 `codex.rs` 或 `codex_process.rs` lint。build既有最大bundle约`1,159.81 kB` warning保留。
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.185 unverified：迁移 lib.rs 内联测试模块

- 将 `src-tauri/src/lib.rs` 第 4442 行之后的 `dev_exec_tests` 与 `dev_write_symlink_tests` 内联测试原文迁移到 `src-tauri/src/dev_exec_tests.rs` 和 `src-tauri/src/dev_write_symlink_tests.rs`，生产实现未改动。
- `lib.rs`仅保留两个 `#[cfg(test)] mod ...;` 声明；测试继续通过 `super::*` 访问同一宿主私有 API，保持测试语义和权限边界不变。
- 验证：Rust `95 passed / 0 failed`；`cargo fmt`、`cargo check`、`git diff --check`通过；迁移后 `lib.rs` 实测 `4447` 行，两个外置测试文件分别为 `1376` 和 `609` 行。
- 本轮未运行前端门（仅移动 Rust 内联测试，不涉及 TypeScript/前端产物）；本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.186 unverified：抽出 fs_guard 的 verbatim path normalizer

- 将纯函数 `dev_strip_verbatim` 从 `src-tauri/src/lib.rs` 迁移到已有 `src-tauri/src/fs_guard.rs`，保留 Windows `\\?\`/UNC 分支和非 Windows 透传语义。
- `lib.rs`通过 crate 内可见 import 保持原调用名；`fs_guard`内部改为直接使用本模块 helper，未移动 `DEV_STATE`、identity rebinding 或文件生命周期逻辑。
- 验证：`fs_guard` `11 passed / 0 failed`；`dev_exec_tests` `26 passed / 0 failed`；`dev_write_symlink_tests` `20 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；`lib.rs`实测 `4432` 行。
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.187 unverified：抽出 fs_guard 的 protected path policy

- 将纯函数 `protected_relative_path`、`protected_path_error` 和 `protected_path_is_execution_only_script` 从 `src-tauri/src/lib.rs` 迁移到 `src-tauri/src/fs_guard.rs`。
- 保留 `dev_path_allowed_with_options` 的 `DEV_STATE`、identity rebind、allow-execution-only 分支和文件权限编排；root 仅保留测试条件下的 `protected_relative_path` re-export。
- 验证：fs_guard `11 passed / 0 failed`；dev_exec `26 passed / 0 failed`；dev_write `20 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；`lib.rs`实测 `4392` 行。
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.188 unverified：抽出 fs_guard 的 Git diff pathspec policy

- 将纯函数 `git_diff_pathspec_allowed` 从 `src-tauri/src/lib.rs` 迁移到 `src-tauri/src/fs_guard.rs`，保留独立的 Git protected-root/ancestor 列表，不与 host file protected policy 合并。
- `lib.rs`生产 `dev_exec` 通过 fs_guard import继续调用；未移动 `has_multiple_hardlinks`、`DEV_STATE`、cwd identity 或文件写入 gate。
- 验证：fs_guard `11 passed / 0 failed`；dev_write `20 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；`lib.rs`实测 `4352` 行。
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.189 unverified：抽出 cleanup lineage predicates

- 新增 `src-tauri/src/cleanup_lineage_policy.rs`，承接 `cleanup_binding_matches` 与 `orphan_target_is_deleted_candidate` 两个纯 predicate。
- `CleanupBinding`、DEV_STATE、token生成/消费、orphan registration、cleanup approval/CAS/read-back仍由 `lib.rs` host authority 持有；新模块不拥有状态或副作用。
- 验证：orphan predicate targeted `1 passed / 0 failed`；cleanup binding targeted `1 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；`lib.rs`实测 `4329` 行。
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.190 unverified：抽出 worktree ref/name lexical policy

- 新增 `src-tauri/src/worktree_policy.rs`，承接 `worker_name_is_valid`、`worker_branch_is_valid`、`is_full_object_id`、`worker_branch_from_tip_arg` 和 `worker_branch_from_ref_arg`。
- `lib.rs`保留 `worker_target_is_valid`、worktree path/canonicalization、pending/registered lease、session、identity 和 CAS authority；新模块仅提供纯输入解析与校验。
- 验证：worker name targeted `1 passed / 0 failed`；worktree lifecycle targeted `1 passed / 0 failed`；scoped branch probe targeted `1 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；`lib.rs`实测 `4301` 行。
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.191 unverified：抽出 Git worktree porcelain parser

- 新增 `src-tauri/src/git_worktree_policy.rs`，承接 `validate_git_worktree_porcelain`；保留 output cap、必需 `worktree/HEAD` 字段、40/64位 object ID、detached/bare/locked/prunable 和 unknown-field fail-closed 语义。
- `lib.rs`保留 `git_worktree_list` 及所有 Git probe、registration、restore、orphan、cleanup、CAS 和 DEV_STATE authority；parser仅依赖 `DEV_OUTPUT_CAP` 与 worktree policy object-id validator。
- 验证：worktree add targeted `1 passed / 0 failed`；unregister targeted `1 passed / 0 failed`；Codex cwd targeted `1 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；`lib.rs`实测 `4259` 行。
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.192 unverified：抽出 SessionAuthority state carrier

- 新增 `src-tauri/src/dev_state.rs`，承接 `DEV_STATE`、`DEV_OPERATION_LOCK`、generation helper、测试 state lock，以及 `DevState`、`RegisteredWorktree`、`PendingWorktree`、`CleanupBinding` carrier types。
- `lib.rs`继续持有所有 session transition、identity rebind、Git/worktree lifecycle、cleanup capability、file/process authority；本刀只改变 carrier 归属和 crate-private visibility，不改变状态转换或 lock order。
- 验证：stale generation targeted `1 passed / 0 failed`；session operation lock targeted `1 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；`lib.rs`实测 `4185` 行。
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.193 unverified：抽出 stable directory identity primitive

- 新增 `src-tauri/src/fs_identity.rs`，承接 `StableDirectoryIdentity` 与 `stable_directory_identity` 的平台探测实现；`lib.rs`通过 crate-private re-export 保持 Codex、registry、测试和 host caller 的现有类型路径。
- 保留 Unix device/inode、Windows volume/file-index、canonical directory 检查和 zero-identifier fail-closed 语义；未移动 StableFileIdentity、bound I/O、DEV_STATE 或 stateful cwd/file gates。
- 验证：stable identity targeted `1 passed / 0 failed`；Codex cwd targeted `1 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；`lib.rs`实测 `4101` 行。
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.194 unverified：建立 SessionStamp snapshot/recheck seam

- `dev_state.rs`新增不可变 `SessionStamp`、state-only snapshot/expected-generation snapshot和stamp recheck API。
- `lib.rs` 的 `assert_base_identity_current` 与 `assert_session_generation` 改为 snapshot → 释放 DEV_STATE → stable identity probe → stamp recheck；调用签名、operation lock归属、Codex/Antigravity caller和错误语义保持不变。
- 未移动 dev_init/dev_clear transition、cwd binding、Codex lease、Antigravity lifecycle 或任何 Git/file mutation；SessionStamp不是 capability，也不替代 `DEV_OPERATION_LOCK`。
- 验证：stale generation targeted `1 passed / 0 failed`；session lock targeted `1 passed / 0 failed`；Codex cwd targeted `1 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；`lib.rs`实测 `4068` 行。
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.195 unverified：收窄 base-repo state accessors

- `dev_state.rs`新增 `snapshot_base_repo` 与 `base_repo_is_initialized` 两个窄 accessor，返回 owned `Option<String>`/bool，不暴露 `MutexGuard` 或通用 state getter。
- `dev_lexical_abs_of`、`dev_abs_of` 和 `dev_cwd_binding` 的低风险 raw `base_repo` 读取改走 accessor；cwd ownership、identity rebind、legacy fallback 与 lifecycle transition保持在 `lib.rs`。
- 验证：cwd prefix targeted `1 passed / 0 failed`；stale generation targeted `1 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；`lib.rs`实测 `4063` 行。
- 本轮未 push、未 merge、未修改凭据或外部系统；本 checkpoint 不标记 verified。

### 7.196 unverified：抽出 credentials/storage authority boundary

- 新增 `src-tauri/src/credentials.rs`，完整承接 OS keyring credential index、AppData `endpoints.json`、endpoint/vault commands、AES-GCM master-key persistence、API-key encrypt/decrypt 与 crate-local base64 helpers。
- `lib.rs` 仅保留模块声明、Tauri command registration、共享 bootstrap；未移动 Git/worktree、DEV_STATE、file authority、process lifecycle 或 credential values。Tauri commands 的参数、返回值和注册顺序保持不变。
- 验证：AES/base64 targeted `2 passed / 0 failed`；credential environment targeted `1 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`通过；`lib.rs`实测 `3633` 行，新 `credentials.rs` `439` 行。
- 全量 Rust 首次受到既有 `event_store` disposable lock fixture 残留影响，清理精确 Temp fixture 后重跑通过；未修改 `event_store` 生产代码。build 仍有既有大 chunk warning（最大约 `1,159.81 kB`）。
- 本轮未 push、未 merge、未修改或保留任何凭据；本 checkpoint 不标记 verified。

### 7.197 verified closure：credentials/storage boundary

- exact reviewed HEAD：`263b232ebb71448c75a63b5433c0e6e94d62cc54`；独立 reviewer 返回 `passed=true`、`security_concerns=[]`、`logic_errors=[]`。
- reviewer 确认 `credentials.rs` 是 semantics-preserving extraction；12 个 Tauri command 名称与注册顺序保持不变，未发现新增安全或逻辑问题。
- verified tag：`checkpoint/lib-credentials-storage-verified`。Reviewer 建议将 crypto round-trip 测试进一步靠近 credentials 模块，并补 Linux/macOS keyring/AppData CI；两项均为非阻塞后续事项。

### 7.198 unverified：抽出 session/cwd authority seam

- 新增 `src-tauri/src/session_authority.rs`，承接 `dev_base_repo`、SessionStamp validation/recheck、generation assertion、relative/canonical path resolution、`DevCwdKind`、cwd binding 和 registered-worktree assertion。
- `DEV_STATE`、`DEV_OPERATION_LOCK`、SessionStamp/carrier storage 继续由 `dev_state.rs` 所有；Git/worktree registration、pending/orphan/cleanup lifecycle 仍留在 `lib.rs`，本轮不改变 lock order、identity probe 顺序或 session transition。
- 保留 crate-private root re-export 供 Codex、Antigravity、dev/file commands 和 test modules 使用；`dev_cwd_kind` 与 `PathBuf` 仅在 cfg(test) 下保留测试兼容 seam。
- 验证：cwd prefix targeted `1 passed / 0 failed`；stale generation targeted `1 passed / 0 failed`；Codex cwd targeted `1 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；`lib.rs`实测 `3417` 行，新 `session_authority.rs` `236` 行。
- 本轮未 push、未 merge、未修改或保留任何凭据；本 checkpoint 不标记 verified。

### 7.199 unverified：抽出 worktree admission/pending lease authority

- 新增 `src-tauri/src/worktree_authority.rs`，承接 worker target/root validation、worktree-add root guard、registered identity predicates、pending rollback lease admission/update、main-repo worktree command gate 与 cleanup token invalidation seam。
- `lib.rs` 继续持有 Git probes、session init/clear、registration/restore/orphan/cleanup/unregister command bodies；本轮只移动其共享生命周期 helper，仍使用同一个 `DEV_STATE`/`DEV_OPERATION_LOCK`，未改变 generation、identity、branch CAS 或 pending lease 语义。
- 保留明确 crate-private root re-export：生产 caller 使用 lifecycle helper，测试 helper 仅在 cfg(test) 暴露；未增加第二套 state carrier 或 lock。
- 验证：worktree lifecycle targeted `1 passed / 0 failed`；pending rollback targeted `1 passed / 0 failed`；identity-conflict targeted `1 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`通过；`lib.rs`实测 `2953` 行，新 `worktree_authority.rs` `503` 行。
- build 保留既有动态/静态 import 与大 chunk warning（最大约 `1,159.81 kB`）；本轮未 push、未 merge、未修改或保留任何凭据；本 checkpoint 不标记 verified。

### 7.200 unverified：抽出 worktree Git/lifecycle authority

- `worktree_authority.rs`继续承接 Git worktree/branch probes、porcelain validation、registration、trusted restore、orphan lineage、native cleanup approval/CAS/removal 与 unregister；`dev_init_session`/`dev_clear_session`仍留在 `lib.rs`，保留Codex session teardown顺序。
- Tauri handler 改为 module-qualified registration；command names、参数、返回值和前端 IPC 字符串保持不变。`cleanup_lineage_policy`直接依赖 `dev_state::CleanupBinding`，测试所需 carrier/policy 仅通过 cfg(test) root seam 暴露。
- 没有新增 state carrier、operation lock 或权限旁路；所有 lifecycle command 继续使用同一 `DEV_OPERATION_LOCK`、SessionStamp/generation、StableDirectoryIdentity、pending lease、cleanup capability 和 branch CAS/read-back顺序。
- 验证：Codex cwd targeted `1 passed / 0 failed`；unregister targeted `1 passed / 0 failed`；cleanup capability targeted `1 passed / 0 failed`；orphan candidate targeted `1 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`通过；`lib.rs`实测 `2030` 行，新 `worktree_authority.rs` `1440` 行。
- build 仍保留既有动态/静态 import 与大 chunk warning（最大约 `1,159.81 kB`）；本轮未 push、未 merge、未修改或保留任何凭据；本 checkpoint 不标记 verified。

### 7.201 unverified：抽出 file authority

- 新增 `src-tauri/src/file_authority.rs`，承接 stateful registered-worktree path gate、hardlink rejection、StableFileIdentity、Windows handle/reparse FFI、Unix openat/no-follow parent/final binding、bound read/write/create helpers及三个 file commands。
- `lib.rs` 保留 dev_exec/process authority、session init/clear、Tauri bootstrap；dev_exec通过crate-private seam继续调用 `dev_exec_path_allowed`、hardlink与Unix bound cwd identity helpers，`fs_identity.rs`通过同一 file authority FFI实现，未复制第二份平台实现。
- file commands 的 Tauri name、参数、返回值和 handler 顺序保持不变；SessionStamp/generation、DEV_OPERATION_LOCK、worktree registration和protected-path policy ownership未改变。
- 验证：file targeted `6 passed / 0 failed`；Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`通过；`lib.rs`实测 `1357` 行，新 `file_authority.rs` `695` 行。
- 当前验证发生在 Windows；Unix/macOS openat/no-follow 原生矩阵、Windows reparse/junction adversarial matrix仍未验证。build保留既有大 chunk warning（最大约 `1,159.81 kB`）；本 checkpoint 不标记 verified。

### 7.202 unverified：src-tauri namespace consolidation

- 将平铺模块按领域收进四个 namespace：`authority/`、`policy/`、`storage/`、`execution/`；root `lib.rs`通过 crate-private aliases 保持现有调用路径和 Tauri command contract。
- 当前目录职责：authority承载 state/session/file/worktree；policy承载 command/fs/worktree/Git/cleanup policy；storage承载 credentials/event store；execution承载 dev_process。Codex/Antigravity和测试模块本轮保持原位置，避免混入生命周期修复。
- 本轮只改变文件路径、`mod.rs`聚合和显式 import/re-export；未改变 state carrier、lock order、命令参数、权限规则、进程行为或外部 IPC 名称。
- 验证：Rust 全量 `95 passed / 0 failed`；`cargo check`、`cargo fmt --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`通过；既有 build 动态/静态 import 与大 chunk warning 保持不变。
- 本轮未 push、未 merge、未修改或保留任何凭据；本 checkpoint 不标记 verified。

### 7.203 verified：namespace consolidation review closure

- exact HEAD `3d14acd1608b831f4a2127688fb16adc83537649` 经独立 fail-closed reviewer 审查通过：`passed=true`、`security_concerns=[]`、`logic_errors=[]`。
- reviewer 确认四个 namespace 聚合、crate-private aliases、两处 nested import 调整没有引入重复实现、模块环、路径敏感断裂或行为变化；Tauri `generate_handler!` 保持 37 个 command，Rust 95 个测试仍可发现。
- reviewer 质量门：`cargo test --locked` 为 `95 passed / 0 failed`；`cargo check --locked`、`cargo fmt -- --check`、`git diff --check`通过；工作树与审查的 exact HEAD 一致。
- 已创建本地 verified tag：`checkpoint/native-src-directory-consolidation-verified`。审查仅覆盖 Windows；Unix/macOS native matrix、GUI/E2E 与既有 worktree lifecycle blocker 仍未验证/未解决。

### 7.204 unverified：orphan branch lineage repair

- `dev_register_orphan_worktree` 现在要求调用方提供合法 `branchRevision`，native 重新读取当前 branch tip，只有与 durable revision 完全一致时才写入 `PendingWorktree.branch_revision`；stale same-name branch tip 直接 fail-closed，不进入 `DEV_STATE`。同一路径的重复 orphan registration 只有 generation、branch、revision 和 removed 状态完全一致时才幂等成功，否则拒绝 duplicate lineage conflict。
- `dev_approve_cleanup` 与 `dev_cleanup_worktree` 对 orphan lineage 不再只接受 caller revision；必须匹配 native orphan 中保存的 revision，缺失或漂移均拒绝。旧的无 revision orphan 记录不能获得 cleanup capability。
- Node Tauri orphan restore 将 `WorktreeInfo.branchRevision` 传入 `dev_register_orphan_worktree`；新增 IPC payload 回归，保持 live restore 与 orphan restore 分支分离。
- 新增真实 Git fixture：`orphan_registration_preserves_native_branch_revision`、`orphan_registration_rejects_branch_revision_drift`；focused Rust `2 passed / 0 failed`，完整 Rust `97 passed / 0 failed`。
- 验证：`cargo check`、`cargo fmt --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`通过；build 最大 chunk 约 `1,159.86 kB`，既有动态/静态 import 与大 chunk warning 保持不变。
- 本 slice 只闭合 orphan branch-revision provenance；restore durable target identity、cleanup partial-CAS recovery、post-remove read-back、pending probe unknown 和 Windows TOCTOU 仍未解决。本轮未 push、未 merge、未保留凭据；等待 exact HEAD reviewer。

### 7.205 unverified：orphan lineage all-record conflict repair

- exact HEAD `97dedb45e252a7303264adea04b9fa3525e1548d` reviewer fail-closed 发现 `find` 只检查同路径第一条 orphan record，后续 generation/branch/revision/removed 冲突可能被忽略；该 verdict 已按 `passed=false` 处理。
- 新增统一 `orphan_records_for_path` 与 exact lineage matcher：registration、approval、cleanup 都扫描同路径全部 orphan records；必须恰好一条且 generation、branch、native revision、removed 全部一致，才允许幂等/继续，否则拒绝 ambiguous duplicate lineage。
- 扩展真实 Git fixture，覆盖第一条 legacy 缺失 revision和后续冲突记录两种顺序；focused orphan Rust `2 passed / 0 failed`。
- 新 snapshot 验证：Rust `97 passed / 0 failed`；`cargo check --locked`、`cargo fmt --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`通过；build 最大 chunk 约 `1,159.86 kB`。
- 本 snapshot 仍为 unverified，待新 exact HEAD reviewer；restore durable target identity、cleanup partial-CAS recovery、post-remove read-back、pending probe unknown 和 Windows TOCTOU 仍未解决。

### 7.206 verified：orphan lineage all-record review closure

- exact HEAD `ff1261d14809467ab1466503d44ae02b1717410a` 经独立 fail-closed reviewer 审查通过：`passed=true`、`security_concerns=[]`、`logic_errors=[]`。
- reviewer 确认 shared matcher 使用 canonical path comparison 扫描全部同路径 orphan records；registration、approval、cleanup 仅接受唯一且 generation/branch/revision/removed 全匹配的记录，ambiguous、legacy 和冲突记录均拒绝；session generation、operation lock、live registration 与 Node branch-revision payload 未回归。
- reviewer 质量门：Rust `97 passed / 0 failed`；`cargo check --locked`、`cargo fmt --all -- --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；build、i18n、TypeScript通过；工作树与 exact HEAD 一致。
- 已创建本地 verified tag：`checkpoint/native-orphan-lineage-all-records-verified`。直接 `dev_approve_cleanup`/`dev_cleanup_worktree` seam tests、exact duplicate idempotence/path-alias tests作为非阻塞后续增强；GUI/E2E、Unix/macOS native matrix及其他 worktree blockers仍未验证/未解决。

### 7.207 unverified：cleanup capability probe invalidation

- 新增 `cleanup_probe_or_invalidate`，统一包裹 capability 已匹配后的 identity/base/read-back probe；任何 `Result<T, String>` error 都先消费 one-shot cleanup token，再返回原错误，避免 capability 在 fallible path 后保持可重试。
- 覆盖 cleanup 的 target identity、pre-CAS identity、post-CAS identity、worktree-remove 前 identity 和最终 base read-back；approval 阶段尚未生成 token 的 probe 保持原有错误路径。
- 新增 `cleanup_probe_error_consumes_capability` regression；Rust 全量 `98 passed / 0 failed`。
- 验证：`cargo check --locked`、`cargo fmt --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`通过；build 最大 chunk 约 `1,159.86 kB`。
- 本 slice 只闭合 capability invalidation，不宣称 durable recovery：branch CAS 后 remove/read-back partial outcome、unknown recovery owner、post-remove strict absence、pending probe unknown、restore ordering 和 Windows TOCTOU 仍未解决；等待 exact HEAD reviewer。

### 7.208 unverified：cleanup identity short-circuit repair

- exact HEAD `031b1dffb80f064d3b01986d92f7454e6a453934` reviewer fail-closed 发现 refactor 后 base identity mismatch 仍继续执行 target probe，改变了原有短路与 phase-specific error precedence；该 verdict 已按 `passed=false` 处理。
- 新增 `cleanup_identity_guard`：先验证 base identity，只有匹配时才执行 target probe；三处 cleanup guard 恢复原有短路顺序和错误语义，同时保留 probe error 的 token invalidation。
- 新增 `cleanup_identity_guard_preserves_base_mismatch_short_circuit` regression，确认 target probe 未被调用、phase-specific error 保持、capability 被消费。
- 新 snapshot 验证：Rust `99 passed / 0 failed`；`cargo check --locked`、`cargo fmt --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`通过；build 最大 chunk 约 `1,159.86 kB`。
- 本 slice 仍只处理 cleanup capability invalidation/guard 语义；durable partial-CAS recovery、post-remove strict absence、pending probe unknown、restore ordering 和 Windows TOCTOU仍未解决，等待新的 exact HEAD reviewer。

### 7.209 verified：cleanup capability invalidation review closure

- exact HEAD `b855766624275aba92ffea64d12c5f6b405fd9b4` 经独立 fail-closed reviewer 审查通过：`passed=true`、`security_concerns=[]`、`logic_errors=[]`。
- reviewer 确认 `cleanup_probe_or_invalidate` 在 capability 后的 fallible probe 中消费 token，`cleanup_identity_guard` 保持 base mismatch 短路、phase-specific error precedence 和三处 cleanup mutation order；无 DEV_STATE 锁内失效死锁或成功路径回归。
- reviewer 质量门：Rust `99 passed / 0 failed`；`cargo check --locked`、`cargo fmt --all -- --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；build、i18n、TypeScript通过；工作树与 exact HEAD 一致。
- 已创建本地 verified tag：`checkpoint/native-cleanup-identity-short-circuit-verified`。本轮 hardening 到此冻结；partial-CAS durable recovery、post-remove strict absence、pending probe unknown、restore ordering、Windows TOCTOU、GUI/E2E 与 Unix/macOS native matrix仍是明确 residual，不在本轮继续扩大。

### 7.210 unverified：storage endpoint/vault structural split

- 将 `storage/credentials.rs` 按事实所有权拆开：`credentials.rs` 只保留 OS keyring 的 generic set/get/delete/list；新增 `storage/endpoint_store.rs` 承接 endpoints.json、Vault、master key、AES-GCM、base64 和相关敏感路径。
- Tauri endpoint/vault command 名称、参数、返回值和 `generate_handler!` 注册顺序保持不变；root `lib.rs` 只改 module-qualified registration，未改变 IPC contract 或存储格式。
- `vault_crypto_roundtrip_tests` 随敏感实现迁移到 `storage::endpoint_store::tests`；`fs_atomic_replace_tests`仍暂留 `lib.rs`，下一结构 slice再按文件持久化边界迁移。
- 验证：Rust `99 passed / 0 failed`；`cargo check --locked`、`cargo fmt --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`通过；build 最大 chunk 约 `1,159.86 kB`。
- 本轮未改变 cleanup hardening、权限、generation、identity 或外部命令行为；等待结构 slice exact HEAD reviewer。

### 7.211 verified：storage endpoint/vault structural review closure

- exact HEAD `02d8a1887e9567025d3d7fcc38991f74c2ba92fe` 经独立 fail-closed reviewer 审查通过：`passed=true`、`security_concerns=[]`、`logic_errors=[]`。
- reviewer 确认 `credentials.rs` 只拥有 generic keyring credential set/get/delete/list；`endpoint_store.rs` 拥有 endpoint/vault AppData、master key、AES-GCM、base64 与 crypto tests；private storage keyring service、command visibility、IPC order、存储格式和行为均未改变。
- reviewer 质量门：Rust `99 passed / 0 failed`；`cargo check --locked`、`cargo fmt --all -- --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；build、i18n、TypeScript通过；工作树与 exact HEAD 一致。
- 已创建本地 verified tag：`checkpoint/storage-endpoint-vault-split-verified`。GUI/E2E、Unix/macOS native matrix仍未验证；下一结构 slice转向 execution/dev_exec。

### 7.212 unverified：execution dev_exec structural split

- 将原 `lib.rs` H4 execution block 迁移到 `src-tauri/src/execution/dev_exec.rs`：`dev_exec` command、cwd/session fence、command admission、environment sanitization、program resolution、timeout bridge、Windows `.cmd/.bat`/ComSpec launcher 与 trusted Windows program checks均由 execution namespace 持有。
- `policy/command.rs` 的 command grammar 与 hardened Git diff helpers未复制；`dev_exec` 继续调用既有 policy authority。`authority/worktree.rs`、`codex.rs`、`codex_process.rs`改为直接依赖 `execution::dev_exec`，root 只保留 Tauri registration、legacy `run_git`/session facade 和 cfg(test) seam re-export。
- `lib.rs` 从约 `1316` 行降至 `511` 行；未改变 Tauri command 名称、参数、注册顺序、session/generation、cwd、环境清理、launcher、timeout 或 mutation hook 语义。
- 验证：Rust `99 passed / 0 failed`；`cargo check --locked`、`cargo fmt --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`通过；build 最大 chunk 约 `1,159.86 kB`。
- 仅完成结构拆分；GUI/E2E、Unix/macOS native matrix、既有 worktree lifecycle residual不在本 slice扩大范围，exact HEAD reviewer尚未完成。

### 7.213 verified：execution dev_exec structural review closure

- exact HEAD `1c09425d6d9384785bdebf661dc73d99b1bf544c` 经独立 fail-closed reviewer 审查通过：`passed=true`、`security_concerns=[]`、`logic_errors=[]`。
- reviewer 确认 `execution/dev_exec.rs` 是 H4 execution authority 的生产唯一 owner；`policy/command.rs` 未复制或改写；root 仅保留 bootstrap、registration、legacy `run_git`/session facade 和 cfg(test) seam re-export。
- reviewer 确认 37 个 Tauri command 的名称、参数、注册顺序和 `dev_exec` IPC contract不变；无 lock、mutation order、session/cwd fence、环境清理、launcher 或 timeout 回归。
- reviewer 质量门：Rust `99 passed / 0 failed`；`cargo check --locked`、`cargo fmt --all -- --check`、`git diff --check`通过；Node `128 test files / 1111 tests`；build、i18n、TypeScript通过；工作树与 exact HEAD 一致。
- 已创建本地 verified tag：`checkpoint/execution-dev-exec-split-verified`。GUI/E2E、Unix/macOS native matrix以及既有 worktree lifecycle residual仍未验证；下一刀继续处理剩余 root facade，不扩大 hardening范围。

### 7.214 unverified：Worker successful terminal requires Acceptance

- 确认当前 exact HEAD 的逻辑 blocker：`WorkerTaskQueue.markSucceeded` 只要求非空 Evidence，允许 `acceptanceId` 缺失；`normalizeQueueTask` 对恢复的 `succeeded` task 也未要求 Acceptance，因此可把无验收的 Worker 结果投影为 succeeded/RunSucceeded/Orchestration done。
- 新增运行时与恢复回归：成功 terminal 缺 Acceptance 必须拒绝；持久化 `succeeded` 状态缺 Acceptance 必须拒绝。同步修正 queue、coordinator、runtime 测试 fixtures，使所有合法成功结果显式携带 Acceptance；失败/feedback 结果契约未改变。
- RED：新增 `rejects successful task completion without Acceptance id` 初次运行失败（当前实现未抛错）；GREEN：`workerQueue.test.ts` `32/32`，相关 Worker/coordinator/runtime/side-effect/cleanup 测试 `82/82`。
- 完整验证：Node `128 test files / 1113 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`、`git diff --check`通过；build 最大 chunk 约 `1,159.92 kB`，保留既有 dynamic/static import 和 chunk warning。
- 本 slice 只闭合 Acceptance terminal invariant；旧 executor admission、Worker enqueue ProjectControl admission、跨 attempt Evidence/Acceptance provenance、全局 runtime project fencing 和 stale ProjectFile save 仍未处理，exact HEAD reviewer 尚未完成。

### 7.215 unverified：close Acceptance provenance bypasses across recovery and projections

- 针对上一轮 reviewer fail-closed 指出的绕过补齐同一 `workerSuccess` invariant：运行时 queue、持久化 queue restore、event rehydration、domain replay、legacy snapshot migration、WorkerRun→Orchestration projection、consistency audit 和 side-effect receipt 均要求成功 terminal 同时拥有非空 Evidence 与 Acceptance。
- 缺失 provenance 的 `TaskSucceeded` event 不再进入恢复 projection；缺失 provenance 的 `RunSucceeded` 不再升级 run/orchestration terminal success；legacy migration 直接拒绝生成 synthetic success facts；receipt verifier 在 Evidence verifier 前拒绝缺失 Acceptance。
- 新增/更新跨路径 regression，focused `113/113`；完整 Node `128 test files / 1118 tests`；`npm run build`、`npm run i18n:check`、`npx tsc --noEmit`、`git diff --check`通过；build 最大 chunk 约 `1,161.31 kB`，保留既有 warning。
- 本 slice 未处理旧 executor admission、Worker enqueue ProjectControl admission、跨 attempt 更深层 provenance 规则、Worker runtime project fencing、stale ProjectFile save，以及 native/GUI residual；新 exact HEAD reviewer 尚未完成。

### 7.216 unverified：close second-round Worker success invariant bypasses

- `8ee0ae0` 的 exact HEAD reviewer 仍 fail-closed，确认 success invariant 还有十条旁路：混合类型 Evidence 被过滤、空 `RunSucceeded`、孤立 `TaskCleaned`、persisted Run/task status mismatch、空/不完整 TaskGraph coverage、重复 Evidence 被 Map 覆盖、成功 worker receipt 缺 provenance、migration success event 顺序、已 done orchestration 被 invalid run 保留，以及 raw TaskGraph projection 和 invalid rehydration state。
- 在 checkpoint `64793e5` 后逐条写入 RED：focused 首轮 `9` 个失败均对应 reviewer finding；修复 `contracts.ts` 原始 Evidence 校验和 terminal replay guard，queue restore status gate，migration task-facts-before-RunSucceeded 顺序，rehydration run quarantine，orchestration/taskGraph projection coverage/provenance guard，consistency duplicate Evidence/receipt audit。
- GREEN：focused `126/126`；完整 Node `128 test files / 1128 tests`；`npm run build`通过；`npm run i18n:check` 基准 `1026` keys、`en-US 1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。Build 最大 chunk 约 `1,162.91 kB`，保留既有 dynamic/static import 与 chunk warning。
- 当前代码尚未重新提交或 exact review；本节只能标记 `unverified`。旧 executor admission、Worker enqueue ProjectControl admission、跨 attempt 更深层 provenance、runtime/persistence fencing、native command-policy/worktree residual 和 GUI/E2E 仍未处理。

### 7.217 unverified：close recovery and durable receipt provenance bypasses

- `48d1665` 的 exact reviewer 继续 fail-closed，新增确认两条高风险旁路：rehydration 的 direct state assembly 可接受孤立 `TaskCleaned` 并报告 restored，side-effect receipt 只检查 Evidence/Acceptance id 非空而不验证 durable record 与当前 Run/Task/Execution/Attempt binding；同时指出 stage log 会过滤缺失 Task。
- 在 checkpoint `a194a94` 后补 RED→GREEN：rehydration 每个 Run 先通过 domain reducer 做局部事件生命周期预验证并 quarantine 非法状态；`TaskCleaned` 统一要求前置有效 success provenance 和 cleanup receipt；side-effect recorder 新增 Acceptance verifier，持久化 verifier 校验唯一 passed record、lineage 和 worktree；consistency audit 对成功 worker receipt 交叉核对 Evidence/Acceptance durable records；orchestration stage log 对缺失 Task 显式 pending。
- GREEN：focused `131/131`；完整 Node `128 test files / 1133 tests`；`npm run build`通过；`npm run i18n:check` 基准 `1026` keys、`en-US 1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。Build 最大 chunk 约 `1,165.40 kB`，保留既有 dynamic/static import 与 chunk warning。
- 当前修复尚未重新提交或 exact review，仍只能标记 `unverified`。旧 executor admission、Worker enqueue ProjectControl admission、跨 attempt 更深层 provenance、runtime/persistence fencing、native command-policy/worktree residual 和 GUI/E2E 仍未处理。

- 当前修复尚未重新提交或 exact review，仍只能标记 `unverified`。旧 executor admission、Worker enqueue ProjectControl admission、跨 attempt 更深层 provenance、runtime/persistence fencing、native command-policy/worktree residual 和 GUI/E2E 仍未处理。

### 7.218 unverified：close event-write, scope-binding, production-wiring, and audit-projection bypasses

- `7c1f307` 的 exact reviewer继续 fail-closed，确认四类旁路：EventStreamRepository/eventBuffer写入前只做 sequence/aggregate检查，孤立 `TaskCleaned` 可落盘；非 `TaskCleaned` payload 可伪装 `cleanupStatus: cleaned`；Evidence/Acceptance verifier 未绑定 orchestration/stage；App 三处 production `createPersistedWorkerSideEffectRecorder` 未传 Acceptance verifier；rehydration缺少最终 queue restore validation；consistency失败后 App 仍可能把 raw succeeded state投影为 done。
- 在 checkpoint `ce8bf72` 后修复：最终 durable append/appendBatch（以及 eventBuffer flush）统一 replay lifecycle validator，保留 in-memory queue 的 structural append；cleanupStatus仅允许由 TaskCleaned写入；SideEffectRecord持久化 orchestration/stage binding，Evidence/Acceptance verifier校验scope，App启动/恢复/retry三条真实路径均接入 durable Acceptance verifier；rehydration最终复用 restoreWorkerRunQueue；audit失败时 suppression projection 清除 done/success stage外观。
- 新增跨边界 regression，focused `145/145`；完整 Node `128 test files / 1137 tests`；`npm run build`通过；`npm run i18n:check` 基准 `1026` keys、`en-US 1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。Build最大 chunk约 `1,168.20 kB`，保留既有 dynamic/static import 与 chunk warning。
- 当前修复尚未重新提交或 exact review，仍只能标记 `unverified`。旧 executor admission、Worker enqueue ProjectControl admission、跨 attempt 更深层 provenance、runtime/persistence fencing、native command-policy/worktree residual 和 GUI/E2E 仍未处理。

### 7.219 unverified：close legacy cleanup lineage, restore-state, and original-event-position bypasses

- `ba6b003` 的 exact reviewer继续 fail-closed，确认 legacy aggregateType=Task 无 lineage 时仍可伪装 cleanupStatus，TaskCleaned 可跨 runId复用 taskId；restore queue 接受未知 Run/Task status与缺 assignment 的 created/orphaned/registration-pending worktree；rehydration 重写 aggregateVersion，且 audit zero-run/exception路径仍可能保留 done/success projection。
- 在 checkpoint `8c9f24a` 后修复：replay全局拒绝无 run/task lineage 的 TaskCleaned与非TaskCleaned cleanupStatus，并要求legacy cleanup匹配原run；WorkerQueue维持跨 drain eventHistory/sequence/aggregateVersion，restore validator拒绝未知状态和不完整 assignment；rehydration先验证原始 project event stream、run-local只压缩sequence且最终restore queue；App audit zero-run及exception统一调用 suppression projection；idempotent existing-event append也先验证既有stream lifecycle。
- GREEN：focused `146/146`；完整 Node `128 test files / 1138 tests`；`npm run build`通过；`npm run i18n:check` 基准 `1026` keys、`en-US 1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。Build最大 chunk约 `1,169.58 kB`，保留既有 dynamic/static import 与 chunk warning。
- 当前修复尚未重新提交或 exact review，仍只能标记 `unverified`。旧 executor admission、Worker enqueue ProjectControl admission、跨 attempt 更深层 provenance、runtime/persistence fencing、native command-policy/worktree residual 和 GUI/E2E 仍未处理。

### 7.220 unverified：route audit and reconciliation through restore validation

- `439b38f` 的 exact reviewer继续 fail-closed，确认 consistency audit未调用 `restoreWorkerRunQueue`，App仍可投影 malformed non-empty snapshots；未知 `worktreeStatus` 在 replay/rehydration中被静默丢弃；reconcile结果可在后续 audit前写入 ProjectFile；zero Worker runs但已有 orchestration/stage success时 suppression仍有空洞。
- 在 checkpoint `6d5fd65` 后修复：replay对未知 `worktreeStatus` fail-closed；audit在提供 TaskGraph时对每个 run执行统一 restore validation；reconcile支持 TaskGraph-backed final restore并在 issues存在时禁止保存；App对 zero-run worker projection和 audit failure统一清除 done/success外观。
- GREEN：本轮 focused `8 files / 148 tests`；完整 Node `128 test files / 1140 tests`；`npm run build`通过，最大 chunk约 `1,170.75 kB`；`npm run i18n:check` 基准 `1026` keys、`en-US 1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。保留既有 dynamic/static import 与 chunk warning。
- 当前修复尚未重新提交或 exact review，仍只能标记 `unverified`。旧 executor admission、Worker enqueue ProjectControl admission、跨 attempt 更深层 provenance、runtime/persistence fencing、native command-policy/worktree residual 和 GUI/E2E 仍未处理。

### 7.221 unverified：extract ProjectControl/Worker lifecycle adapter from workflowStore

- 按用户确定的基础建设优先级，暂停继续扩展当前 Worker blocker；从 `workflowStore.ts` 抽出无 React 的 `projectControlLifecycle.ts`，集中负责 ProjectControl snapshot normalization、Worker runtime install/clear 和 runtime-only recovery/evidence/receipt/proposal projection 的初始状态。
- 保留 `workflowStore` facade、Zustand state shape、公开 action 名称、ProjectFile 序列化、事件 buffer 和现有组件调用合同；`openProject`、`newProject`、`createProject`、`closeProject` 与 persist merge 改为通过 adapter 接入，未改变执行/IPC语义。
- 新增 adapter 直接测试，并保留 store project-control regression。GREEN：focused `2 files / 10 tests`；完整 Node `129 test files / 1145 tests`；`npm run build`通过，最大 chunk约 `1,170.87 kB`；`npm run i18n:check` 基准 `1026` keys、`en-US 1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。保留既有 dynamic/static import 与 chunk warning。
- 这是第一条纯结构 bounded slice，尚未进行 exact HEAD reviewer；当前只能标记 `unverified`。下一刀继续处理 workflowStore 中更完整的 ProjectControl/Worker lifecycle facade，再进入 `App.tsx` 生命周期拆分；真实 Tauri E2E 与历史 unverified 收口后置。

### 7.222 unverified：extract App project lifecycle controller

- 第二条 bounded slice 将 `App.tsx` 中项目身份切换、plugin/DevSession epoch、Worker recovery/evidence/audit scheduling 和 cleanup refresh 的 lifecycle effect 抽到 `src/projectControl/projectLifecycleController.ts`；Worker业务函数通过依赖注入，controller不复制 Worker authority。
- `App.tsx` 保留 root UI、公开 handler、store facade 与 `ProjectOperation` guard，只保留 controller wiring；旧 subscribe/epoch/cancellation/teardown 顺序保持不变。新增 controller direct tests，覆盖 initial observe/dispose 与 project transition boundary。
- GREEN：focused `3 files / 12 tests`；完整 Node `130 test files / 1147 tests`；`npm run build`通过，最大 chunk约 `1,171.27 kB`；`npm run i18n:check` 基准 `1026` keys、`en-US 1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。保留既有 dynamic/static import 与 chunk warning。
- 这是行为保持的结构切片，尚未进行 exact HEAD reviewer；当前只能标记 `unverified`。下一步继续收口 WorkerRecovery/receipt handler 或 executor adapter，再进行真实 Tauri E2E；历史 unverified 仍后置。

### 7.223 unverified：close duplicate ProjectControl event-buffer cleanup owner

- 旧 `2c566bb` reviewer因 exact HEAD 已漂移不能审批，但其代码 finding在当前链路仍成立：`workflowStore.newProject/openProject` 直接清理 event buffer，adapter同时拥有部分 lifecycle cleanup，导致事实所有权重复。
- 修复为：`resetProjectControlLifecycle(previousProjectId)` 统一处理新项目切换；新增 `activateProjectControlRuntime` 统一处理 open-project 的 pending event buffer 清理与 Worker runtime install；store 删除 direct `clearProjectEventBuffer` lifecycle callers，并增加 activation cleanup regression。
- GREEN：focused `3 files / 13 tests`；完整 Node `130 test files / 1148 tests`；`npm run build`通过，最大 chunk约 `1,171.30 kB`；`npm run i18n:check` 基准 `1026` keys、`en-US 1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。保留既有 dynamic/static import 与 chunk warning。
- 这是对前两条结构切片的 ownership repair，尚未进行 exact HEAD reviewer；当前仍只能标记 `unverified`。真实 Tauri E2E 与历史 unverified 收口继续后置。

### 7.224 unverified：restore App lifecycle warning observability

- `9b001e8` exact reviewer确认 controller extraction 把原 App 中的三类 warning log 静默吞掉：Worker recovery scheduling、Evidence scheduling、项目生命周期 transition failure。该问题属于结构切片引入的行为回归，不扩大 Worker authority。
- 新增 `reportWarning` 注入边界，恢复原有中文 warning 文案和 abort 条件；新增 rejection regression，确保 recovery/evidence 调度失败仍可观察，项目切换失败仍由 controller报告。
- GREEN：focused `1 file / 3 tests`；完整 Node `130 test files / 1149 tests`；`npm run build`通过，最大 chunk约 `1,171.66 kB`；`npm run i18n:check` 基准 `1026` keys、`en-US 1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。保留既有 dynamic/static import 与 chunk warning。
- 这是对 App lifecycle 结构切片的行为修复，尚未进行新的 exact HEAD reviewer；当前仍只能标记 `unverified`。真实 Tauri E2E 与历史 unverified 收口继续后置。

### 7.225 verified：App lifecycle foundation slice review closure

- exact HEAD `96e81c7` 的独立 reviewer通过：`security_concerns=[]`、`logic_errors=[]`、`suggestions=[]`；确认 warning propagation、abort suppression、ProjectOperation、centralized lifecycle/event-buffer ownership 和 scheduler guards均保持行为一致。
- 同一代码快照质量门：Node `130 test files / 1149 tests`；`npm run build`通过；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。仅保留既有 dynamic/static import 与 large-chunk warnings。
- 已创建本地 verified tag：`checkpoint/frontend-lifecycle-warning-observability-verified`。该 tag只证明本条前端 lifecycle foundation slice及其自动化质量门，不代表真实 GUI/E2E、Worker blocker、native hardening或历史 unverified已关闭。

### 7.226 unverified：extract Worker recovery facts from App

- 第三条前端基础切片将 App 顶层的纯 Worker recovery facts（成功 CleanupReceipt reconciliation、unknown/needs-user cleanup Run detection）抽到 `src/projectControl/workerRecoveryFacts.ts`；Tauri I/O、store mutation 和 UI handler仍留在 App，避免跨 authority 混切。
- App 删除重复实现并改为导入 recovery facts；新增 direct tests，验证无可信 receipt时不改变 Worker state、unknown/needs-user effect只产生对应 Run recovery集合。
- GREEN：focused `4 files / 16 tests`；完整 Node `131 test files / 1151 tests`；`npm run build`通过，最大 chunk约 `1,171.66 kB`；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。保留既有 dynamic/static import 与 chunk warning。
- 这是新的纯结构 bounded slice，尚未进行 exact HEAD reviewer；当前仍只能标记 `unverified`。下一步继续抽 WorkerRecovery/receipt controller 的 I/O wiring，再进行真实 Tauri E2E；历史 unverified继续后置。

### 7.227 verified：Worker recovery facts slice review closure

- exact HEAD `fd74927` 的独立 reviewer通过：`security_concerns=[]`、`logic_errors=[]`；确认抽出函数与原 App 实现语义等价，App调用方已切换到唯一 owner，I/O/store/UI边界未移动，底层 cleanup receipt lineage/attempt/hash校验保持有效。
- 同一代码快照质量门：Node `131 test files / 1151 tests`；focused `24 tests`；`npm run build`通过；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。仅保留既有 dynamic/static import 与 large-chunk warnings。
- 已创建本地 verified tag：`checkpoint/frontend-worker-recovery-facts-verified`。该 tag只证明 recovery facts结构切片，不代表 Worker blocker、真实 GUI/E2E、native hardening或历史 unverified已关闭。Reviewer建议的额外 valid/cross-attempt direct fixture为非阻塞建议。

### 7.228 unverified：extract Worker recovery I/O controller from App

- 第四条前端基础切片将 App 中 `recoverInterruptedWorkerEffects` 与 `loadProjectWorkerEvidence` 的 Tauri evidence/journal I/O、Acceptance verifier wiring、receipt reconciliation、unknown cleanup recovery projection 抽到 `src/projectControl/workerRecoveryIoController.ts`。
- controller通过显式 state/save/event/report callbacks接入，`recoverWorkerRun`、cleanup UI action、runQueuedWorker及其直接 side-effect路径保持在 App；非 Tauri/Abort路径保持 no-op。App删除原两段重复 I/O实现。
- GREEN：focused `3 files / 6 tests`；完整 Node `132 test files / 1152 tests`；`npm run build`通过，最大 chunk约 `1,172.01 kB`；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。保留既有 dynamic/static import 与 chunk warning。
- 这是新的 bounded slice，尚未进行 exact HEAD reviewer；当前仍只能标记 `unverified`。下一步继续收口剩余 Worker recovery用户动作或进入 executor adapter；真实 Tauri E2E与历史 unverified继续后置。

### 7.229 verified：Worker recovery I/O controller review closure

- exact HEAD `4edcf83` 的独立 reviewer通过：`security_concerns=[]`、`logic_errors=[]`；确认 Tauri dynamic imports、Acceptance verifier、journal/evidence merge、receipt reconciliation、unknown recovery projection、save/abort/project guards均保持一致，`runQueuedWorker`、`recoverWorkerRun`、cleanup handler未被改变。
- 同一代码快照质量门：Node `132 test files / 1152 tests`；`npm run build`通过；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。仅保留既有 dynamic/static import 与 large-chunk warnings。
- 已创建本地 verified tag：`checkpoint/frontend-worker-recovery-io-controller-verified`。该 tag只证明 recovery I/O结构切片，不代表真实 GUI/E2E、Worker blocker、native hardening或历史 unverified已关闭。

### 7.230 unverified：extract Worker recovery action controller from App

- 第五条前端基础切片将 App 中用户触发的 `recoverWorkerRun` action抽到 `src/projectControl/workerActionController.ts`；controller负责 durable journal recovery、RecoveryCommand、runtime reinstall、ProjectFile save和 retry callback。
- cleanup destructive action、runQueuedWorker、Tauri cleanup receipt执行仍留在 App；controller保留非桌面环境、未保存项目和缺失 durable Run 的 fail-closed guards。新增 direct guards测试。
- GREEN：focused `3 files / 6 tests`；完整 Node `133 test files / 1154 tests`；`npm run build`通过，最大 chunk约 `1,172.46 kB`；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。保留既有 dynamic/static import 与 chunk warning。
- 这是新的 bounded slice，尚未进行 exact HEAD reviewer；当前仍只能标记 `unverified`。下一步继续处理 cleanup action边界或进入 executor adapter；真实 Tauri E2E与历史 unverified继续后置。

### 7.231 verified：Worker recovery action controller review closure

- exact HEAD `5f894dc` 的独立 reviewer通过：`security_concerns=[]`、`logic_errors=[]`；确认 journal/Acceptance/RecoveryCommand顺序、ProjectOperation与项目身份 guard、runtime reinstall、state projection、cleanup proposal suppression、save/retry callback均保持一致，cleanup/runQueued/direct receipt路径未改变。
- 同一代码快照质量门：Node `133 test files / 1154 tests`；`npm run build`通过；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。仅保留既有 dynamic/static import 与 large-chunk warnings。
- 已创建本地 verified tag：`checkpoint/frontend-worker-action-controller-verified`。该 tag只证明 recovery action结构切片，不代表 cleanup action、真实 GUI/E2E、Worker blocker、native hardening或历史 unverified已关闭。

### 7.232 unverified：extract Worker cleanup action controller from App

- 第六条前端基础切片将 App 中破坏性 `cleanupWorkerRun` action抽到 `src/projectControl/workerCleanupActionController.ts`；controller保留 TaskGraph restore、proposal fingerprint字段校验、branch CAS、显式 approve、durable side-effect receipt、unknown recovery、TaskCleaned event、ProjectFile save/read-back和 proposal refresh顺序。
- App仅保留 controller wiring与公开 handler facade；`workerCleanup.ts` proposal authority、`workerCleanupExecution.ts` host receipt authority、`workerCleanupCommand.ts` lifecycle event authority未复制。新增 controller direct guard测试，覆盖非 Tauri、未保存项目、缺失/非 ready proposal。
- GREEN：focused cleanup/controller `4 files / 25 tests`；完整 Node `134 test files / 1157 tests`；`npm run build`通过，最大 chunk约 `1,172.69 kB`；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。保留既有 dynamic/static import 与 large-chunk warnings。
- 这是新的 bounded slice，尚未进行 exact HEAD reviewer；当前仍只能标记 `unverified`。真实 Tauri E2E、executor adapter和历史 unverified收口继续后置。

### 7.233 verified：Worker cleanup action controller review closure

- exact HEAD `5b8efe4` 的独立 reviewer通过：`security_concerns=[]`、`logic_errors=[]`；确认 cleanup action为单一 owner，TaskGraph restore/proposal lineage、branch CAS、approval、receipt、unknown recovery、TaskCleaned projection、save/read-back与proposal refresh均保持一致，App仅保留 facade wiring。
- 同一代码快照质量门：Node `134 test files / 1157 tests`；`npm run build`通过；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。真实 Tauri GUI/native/executor/history仍不在本切片证据范围内。
- 已创建本地 verified tag：`checkpoint/frontend-worker-cleanup-action-controller-verified`。该 tag只证明 cleanup action结构切片，不代表真实 E2E、Worker residual、native hardening或历史 unverified已关闭。

### 7.234 unverified：extract executor NodeSandboxAdapter

- 第七条前端基础切片将 `executor.ts` 中节点 sandbox handle创建抽到 `src/engine/nodeSandboxAdapter.ts`；adapter唯一负责 sandbox root选择、run resource登记、browser fallback、lane allowlist、relative path校验和 Tauri fs guard调用。
- `executor.ts` 保留运行 facade、`executeNode`调度、ExecContext、LLM routing、状态/事件/成本/重试语义；旧 sandbox实现已删除，无第二套 owner。新增 direct adapter tests覆盖 disabled、browser in-memory、relative path和 lane拒绝。
- GREEN：focused `6 files / 54 tests`；完整 Node `135 test files / 1159 tests`；`npm run build`通过，最大 chunk约 `1,172.89 kB`；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。保留既有 dynamic/static import 与 large-chunk warnings。
- 这是新的 bounded slice，尚未进行 exact HEAD reviewer；当前仍只能标记 `unverified`。真实 Tauri E2E、executor context/adapter后续切片和历史 unverified收口继续后置。

### 7.235 verified：executor NodeSandboxAdapter review closure

- exact HEAD `5d03e17` 的独立 reviewer通过：`security_concerns=[]`、`logic_errors=[]`；确认 sandbox root优先级、run resource登记、编码路径、lane allowlist、relative path、动态 Tauri fs、browser fallback及全部 sandbox操作保持一致，`executeNode` 的 ExecContext/LLM/status/event/cost/retry路径未改变。
- 同一代码快照质量门：Node `135 test files / 1159 tests`；`npm run build`通过；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。仅保留既有 dynamic/static import 与 large-chunk warnings。
- 已创建本地 verified tag：`checkpoint/frontend-executor-sandbox-adapter-verified`。该 tag只证明 sandbox结构切片，不代表 executor context、真实 Tauri GUI/native、Worker residual或历史 unverified已关闭。

### 7.236 unverified：extract executor NodeLlmAdapter

- 第八条前端基础切片将 `executeNode` 内 LLM adapter抽到 `src/engine/nodeLlmAdapter.ts`；adapter负责 AgentRouter决策、route telemetry、项目经验注入、fallback调用和工具/成本/logger透传。
- `executor.ts` 保留 `ExecContext` facade、节点状态/事件/干预、资产/变量/边 scope、重试和执行时序；adapter默认复用已有 `decideAgentCall`、`runLlmWithFallback`、`matchExperience`，未新增路由或执行策略。新增 direct test覆盖路由事件、经验注入和 sandbox/storage工具透传。
- GREEN：focused `8 files / 83 tests`；完整 Node `136 test files / 1160 tests`；`npm run build`通过，最大 chunk约 `1,173.70 kB`；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。保留既有 dynamic/static import 与 large-chunk warnings。
- 这是新的 bounded slice，尚未进行 exact HEAD reviewer；当前仍只能标记 `unverified`。真实 Tauri E2E、executor剩余 context切片和历史 unverified收口继续后置。

### 7.237 unverified：repair executor LLM capability fencing

- `9dc7441` exact reviewer fail-closed：发现 adapter通过静态 `getTools` closure把 raw sandbox传入 `runLlmWithFallback`，绕过 `applyCapability` 对 io 节点的 sandbox deny与 sandbox_write 的 commit fencing；同时与旧 closure 的调用时读取语义不一致。
- 修复：`executeNode` 先声明 mutable `ExecContext`，LLM adapter在调用时从最终 `ctx.vars/ctx.storage/ctx.sandbox`读取；`applyCapability` 后的裁剪结果因此成为唯一工具边界。新增真实 executor integration RED→GREEN，io 节点在 `sandbox:true` 下观察到 `toolSandbox === undefined`。
- GREEN：capability/executor focused `6 files / 40 tests`；完整 Node `137 test files / 1161 tests`；`npm run build`通过，最大 chunk约 `1,173.73 kB`；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。旧 reviewer verdict不适用于修复后的 HEAD，新的 exact review待进行；真实 Tauri E2E及其他 residual仍未关闭。

### 7.238 verified：executor LLM capability fencing review closure

- exact HEAD `c6e3636` 的独立 reviewer通过：`security_concerns=[]`、`logic_errors=[]`；确认 adapter在调用时读取 mutable `ctx.vars/ctx.storage/ctx.sandbox`，`applyCapability` 后 io sandbox deny、sandbox_write commit fencing与 coordinator权限均保留，无 TDZ、初始化顺序、重复 owner或 stale import问题。
- 同一代码快照质量门：Node `137 test files / 1161 tests`；`npm run build`通过；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。仅保留既有 dynamic/static import 与 large-chunk warnings。
- 已创建本地 verified tag：`checkpoint/frontend-executor-llm-capability-repair-verified`。该 tag只证明 LLM capability fencing repair，不代表 executor剩余 context、真实 Tauri GUI/native、Worker residual或历史 unverified已关闭。

### 7.239 unverified：extract executor NodeContextAdapter

- 第九条前端基础切片将 `executeNode` 中 assets合并、partial output、branch callback、edge scope双写和 intervention lifecycle抽到 `src/engine/nodeContextAdapter.ts`。
- adapter通过显式 runtime/store/edge/generation依赖保留原行为：项目资产与工作流资产按 id 覆盖、setPartial动态读取节点输出、loopGate branches继续回写 gateTaken、edge scope同时更新局部 edges和 runtime store、过期 run拒绝 intervention并抑制 checkpoint。
- `executor.ts` 保留 LLM/storage/vars/sandbox、capability裁剪、节点执行/重试/结果处理与运行时序；旧 callback实现已删除，无第二套 owner。新增 direct context tests及完整 executor lifecycle regression。
- GREEN：focused `7 files / 42 tests`；完整 Node `138 test files / 1163 tests`；`npm run build`通过，最大 chunk约 `1,174.41 kB`；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。保留既有 dynamic/static import 与 large-chunk warnings。
- 这是新的 bounded slice，尚未进行 exact HEAD reviewer；当前仍只能标记 `unverified`。executor结构拆分、真实 Tauri E2E与历史 unverified收口继续后置。

### 7.240 verified：executor NodeContextAdapter review closure

- exact HEAD `f398274` 的独立 reviewer通过：`security_concerns=[]`、`logic_errors=[]`；确认资产合并/id覆盖、动态 partial/owner映射、branches/onGate、sandbox lanes、edge双写、过期 intervention cancel、checkpoint-before-request、owner identity、capability fencing与 executor lifecycle均保持一致，无重复 callback、stale import、循环、TDZ或 loop regression。
- 同一代码快照质量门：Node `138 test files / 1163 tests`；`npm run build`通过；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。仅保留既有 dynamic/static import 与 large-chunk warnings。
- 已创建本地 verified tag：`checkpoint/frontend-executor-context-adapter-verified`。该 tag只证明 context结构切片，不代表 workflowStore/WorkflowEditor剩余结构债务、真实 Tauri GUI/native、Worker residual或历史 unverified已关闭。

### 7.241 unverified：real Tauri E2E acceptance evidence

- 在真实 `npm run tauri dev` GUI中使用 disposable fixture `D:/Temp/slimemold-tauri-e2e-20260920T005525Z`，通过 File→Open Project 加载成功场景；GUI显示 `Tauri E2E Disposable`、`Offline Worker smoke`，运行后两个节点成功（约 `7ms/194ms`），最近输出包含 evidence marker。
- GUI File→Save Project后，fixture `project.json`真实落盘 `run_1789866123349`、`status=success`、2节点输出；关闭项目再从最近项目重新打开，运行历史面板真实显示 success、2节点、0.2s，详情输出恢复。
- 第二个 clean disposable fixture `D:/Temp/slimemold-tauri-e2e-20260920T005525Z-failure-clean` 关闭离线模拟且无 agent；GUI真实显示 `runHistory.status.error`、红色 Worker 节点与 `2/2`拓扑完成。保存后 ProjectFile包含 error run、节点级 success/error、明确错误文本；checkpoint JSON包含同一 error run，事件流保留 baseline。
- 真实验收发现 concrete-risk：成功和失败场景保存后 GUI项目名旁的 `*` 未清除，尽管 ProjectFile已写入；该问题进入 7.242 修复。离线模拟场景未覆盖真实 WorkerQueue/Evidence/Acceptance/Receipt/Git-worktree副作用，不能将本轮称为完整 Worker E2E verified；两个 fixture按约定保留，不自动 cleanup。

### 7.242 unverified：repair dirty marker after ProjectFile save

- 根因：`saveProject`以 raw `JSON.stringify(file)`写入 `lastSavedSnapshot`，dirty checker比较 stable `projectSnapshot`，导致保存后永远偏离并保留 `*`。
- 修复：保存成功后先清除 `projectDirty`，再以当前 state 的 stable `projectSnapshot(get())`建立基准；新增 store regression覆盖 `projectDirty=false`、`isProjectDirty()=false`与快照一致。
- GREEN：dirty/store focused `3 files / 48 tests`；完整 Node `138 test files / 1164 tests`；`npm run build`通过，最大 chunk约 `1,174.41 kB`；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。新的 exact HEAD review与修复后 Tauri GUI recheck待进行。
- 修复后真实 Tauri recheck：同一 clean failure fixture运行后通过 File→Save Project，fresh GUI中项目名旁 `*` 消失；`project.json` read-back包含 error history，Tauri dev进程与端口已停止。修复代码仍等待 exact HEAD reviewer，两个 disposable fixture保留未自动 cleanup。

### 7.243 unverified：close Save As dirty snapshot bypass

- exact reviewer 对 `fc24b1c` fail-closed：发现 `saveProjectAs` 仍用 raw `JSON.stringify(file)`写 `lastSavedSnapshot`，普通 Save 修复不能覆盖另存为入口。
- 修复：Save As 与普通 Save统一使用保存后的 `projectSnapshot(get())` stable baseline；新增隔离 Tauri mock regression覆盖 Save As 的 `projectDirty=false`、`isProjectDirty()=false`与快照一致。
- GREEN：Save/Save As focused `4 files / 49 tests`；完整 Node `139 test files / 1165 tests`；`npm run build`通过，最大 chunk约 `1,174.40 kB`；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit`、`git diff --check`通过。新的 exact HEAD review待进行。

### 7.244 verified：Save and Save As dirty baseline review closure

- exact HEAD `f06a457` reviewer通过：`security_concerns=[]`、`logic_errors=[]`；确认普通 Save与 Save As均使用 stable `projectSnapshot(get())`，project identity/path/event flush/guard/saveLastSession语义未变，无 raw snapshot旁路。
- 同一代码快照质量门：focused `4 files / 49 tests`；完整 Node `139 test files / 1165 tests`；build、i18n `1026/1026`、tsc、diff check全部通过。
- 已创建本地 verified tag：`checkpoint/tauri-save-as-dirty-marker-repair-verified`。该 tag只证明 dirty baseline repair，不代表完整 WorkerQueue/Evidence/Acceptance/Receipt/Git-worktree E2E、native hardening或历史 unverified已关闭。

### 7.245 evidence：historical unverified triage dossier

- 基于当前 exact HEAD `4c5f0ccefad9981eb82734af1958d16e3c2f5e9c`、`DEVELOPMENT_LOG.md` 7.196–7.240、checkpoint tags、当前 source 与三路只读 triage，新增 `docs/HISTORICAL_UNVERIFIED_TRIAGE.md`。档案将历史项分为 `superseded`、`evidence-missing`、`concrete-risk`、`environment-blocked`，明确历史 tag不等于当前全树 approval。
- 档案记录当前仍开放的 native concrete risks：worktree fresh-session identity、partial-CAS、post-remove read-back、pending probe recovery、Windows TOCTOU、protected metadata、find parity、launcher parity、legacy `run_git`；并记录 Worker admission/provenance/runtime fencing与完整 WorkerQueue Tauri E2E仍未收口。
- 真实 Tauri E2E边界同时写入档案：disposable success/failure fixture 的 GUI、ProjectFile、event/checkpoint、close/reopen history 和 dirty-marker repair证据已 read-back；离线模拟未覆盖真实 WorkerQueue/Evidence/Acceptance/Receipt/Git-worktree mutation，因此不标记完整 E2E verified。
- 本轮为 docs-only；实际检查：`git diff --check`通过。未因档案变更重跑 Node/build/i18n/tsc，历史质量门数字保持原文不变。

### 7.246 unverified：protect native `.git` and `.slimemold` file roots

- Read-only triage确认 `src-tauri/src/policy/fs_guard.rs` 的 direct file authority protected list遗漏 `.git`/`.slimemold`，而 `git_diff_pathspec_allowed` 与 Node policy已有独立保护，存在 native direct read/write policy旁路。
- 先写 RED：`host_protected_path_policy_covers_default_sensitive_roots` 对 `.git`、`.git/config`、`.slimemold`、`.slimemold/events/events.jsonl` 失败；修复只在 `protected_relative_path` 增加 exact/descendant component-boundary，不改 find grammar、legacy `run_git`或 execution launcher。
- 验证：targeted native `2/2`；Rust `cargo fmt --check`、`cargo check`、全量 `cargo test` `99/99`；Node `npm test` `139 files / 1165 tests`、build通过（最大 chunk `1,174.40 kB`）、i18n `1026/1026`、tsc、diff check通过。当前只能标记 `unverified`，等待 exact native reviewer。

### 7.247 unverified：repair Windows metadata aliases at native file authority

- `ad0f516` exact reviewer fail-closed：literal `.git`/`.slimemold`已保护，但 Windows trailing-dot/space 与 ADS alias（如 `.git.`、`.slimemold `、`.git:stream`）仍可绕过 direct `dev_write_file`/`dev_create_dir`。
- 先写 public mutation RED：新增 Windows-only `direct_file_authority_rejects_windows_metadata_aliases`，确认上述 alias 在 write 与 mkdir均被拒绝；修复在 native `protected_relative_path` 增加 Windows component canonicalization：去除 trailing dot/space，并按 `:` 前 owner识别 ADS，保留 `.gitignore`/`.slimemoldish`兄弟名不误伤。
- 验证：alias targeted `2/2`；Rust `cargo fmt --check`、`cargo check`、全量 `cargo test` `100/100`；Node `npm test` `139 files / 1165 tests`、build通过（最大 chunk `1,174.40 kB`）、i18n `1026/1026`、tsc、diff check通过。当前仍 `unverified`，等待 exact native reviewer。

### 7.248 verified：native protected metadata alias review closure

- exact HEAD `7c30dec` reviewer通过：`security_concerns=[]`、`logic_errors=[]`；真实 mutation probes拒绝 `.git`/`.slimemold` exact、descendant及 Windows trailing-dot/space/ADS aliases，保留 `.gitignore`/`.slimemoldish`；无 grammar或 legacy `run_git`旁路变更。
- 同一快照质量门：Windows targeted `1/1`；Rust fmt/check、全量 lib `100/100`；Node `139 files / 1165 tests`；build、i18n `1026/1026`、tsc、diff check通过。Linux/macOS sysroot/pkg-config/C toolchain缺失，作为 environment-blocked residual记录，不升级为跨平台 verified。
- 已创建本地 verified tag：`checkpoint/native-protected-metadata-alias-repair-verified`。该 tag只证明 direct file protected metadata slice，不代表完整 native hardening、Worker、GUI/E2E或历史 unverified已关闭。

### 7.249 unverified：unify native runtime `find` grammar with structured policy

- Read-only triage与 RED确认 `src-tauri/src/execution/dev_exec.rs` 的 direct `find` gate只检查 lexical option/root，`find src/components -name` 会被接受，而 Node/structured Rust parser应 fail-closed。
- 修复将 runtime `find`分支委托给已有 `dev_command_policy::command_intent_kind(args) == Some("find")`，删除重复 `find_option_is_safe` grammar；新增 missing operand、missing maxdepth和trailing operator回归，保留合法 `-P/-name/glob`路径。
- 验证：find targeted `1/1`、shared policy vectors `1/1`；Rust `cargo fmt --check`、`cargo check`、全量 `cargo test` `100/100`；Node `npm test` `139 files / 1165 tests`、build通过（最大 chunk `1,174.40 kB`）、i18n `1026/1026`、tsc、diff check通过。当前仍 `unverified`，等待 exact native reviewer。

### 7.250 verified：native find policy parity review closure

- exact HEAD `7eb98ac` reviewer通过：`security_concerns=[]`、`logic_errors=[]`；runtime `find`统一走结构化 `command_intent_kind`，合法 `-P/-name/glob`保持可用，missing operand/trailing operator/external-file/mutation/protected-root/path cases fail-closed，无 legacy `run_git`旁路变更。
- 同一快照质量门：find/shared-vector targeted `2/2`；Rust fmt/check、全量 lib `100/100`；Node `139 files / 1165 tests`；build、i18n `1026/1026`、tsc、diff check通过。该 closure只覆盖 native find admission，Unix/macOS、spawn/path identity、GUI/E2E、Worker和历史 debt仍独立开放。
- 已创建本地 verified tag：`checkpoint/native-find-policy-parity-verified`。

### 7.251 unverified：harden legacy `run_git` diff invocation

- Read-only triage确认 legacy `run_git`仍是独立 raw Git read-only surface；其 `diff`路径未显式关闭 pager、external diff和textconv，可能受 repository-local Git config影响。
- 先写 RED：新增 `legacy_git_diff_uses_hardened_invocation`，要求 `diff HEAD`转换为 `--no-pager diff --no-ext-diff --no-textconv HEAD`；`run_git`实际使用共享 builder，其他 read-only probes保持 allowlist与 cwd/top-level guard。
- 验证：legacy targeted `2/2`；Rust `cargo fmt --check`、`cargo check`、全量 `cargo test` `101/101`；Node `npm test` `139 files / 1165 tests`、build通过（最大 chunk `1,174.40 kB`）、i18n `1026/1026`、tsc、diff check通过。当前仍 `unverified`，等待 exact native reviewer。

### 7.252 verified：legacy `run_git` invocation review closure

- exact HEAD `44ae249` reviewer通过：`security_concerns=[]`、`logic_errors=[]`；legacy builder受既有 read-only allowlist约束，`run_git`实际使用 hardened argv，diff/name-only/stat语法保持有效，并显式关闭 pager/external diff/textconv；cwd/top-level/error/launcher/Worker路径无变更。
- 同一快照质量门：legacy targeted `2/2`；Rust fmt/check、全量 lib `101/101`；Node `139 files / 1165 tests`；build、i18n `1026/1026`、tsc、diff check通过。Reviewer建议后续补 name-only/stat direct assertions与 hostile-config integration test，作为非阻塞 follow-up。
- 已创建本地 verified tag：`checkpoint/native-legacy-run-git-policy-verified`。该 closure只覆盖 legacy read-only Git invocation，不代表完整 native hardening、Unix/macOS、GUI/E2E、Worker或历史 debt关闭。

### 7.253 unverified：strict cleanup post-remove read-back

- Read-only triage确认 cleanup 成功后只重查 base identity，随后直接清理 registrations/orphan state；target目录或 Git worktree listing 未做严格 absence read-back。
- 先写 RED：真实临时 Git repo测试要求 target存在时 read-back false，target删除且 Git listing无 target时 true；新增 `cleanup_target_absence_is_confirmed`，并在 `dev_cleanup_worktree` 消费 capability前同时检查 filesystem `symlink_metadata` absence 与 `git worktree list` absence，失败保持 unknown并拒绝清理完成。
- 验证：cleanup read-back targeted `1/1`；Rust `cargo fmt --check`、`cargo check`、全量 `cargo test` `102/102`；Node `npm test` `139 files / 1165 tests`、build通过（最大 chunk `1,174.40 kB`）、i18n `1026/1026`、tsc、diff check通过。当前仍 `unverified`，等待 exact native reviewer。

### 7.254 unverified：strengthen cleanup read-back regression with real worktree listing

- `33d262c` reviewer fail-closed指出初始 regression只创建普通目录并直接调用 helper，未证明“目录已消失但 Git administrative worktree entry仍在”时返回 false，也未覆盖真实 worktree fixture。
- 修复测试 fixture：临时 Git repo提交初始 commit，执行 `git worktree add --detach`，删除 target目录但保留 Git listing断言 read-back false，再执行 `git worktree prune`断言 true；production cleanup顺序不变，仍在 registry/orphan projection前执行 strict read-back。
- 验证：真实 worktree read-back targeted `1/1`；Rust `cargo fmt --check`、`cargo check`、全量 `cargo test` `102/102`；Node `npm test` `139 files / 1165 tests`、build通过（最大 chunk `1,174.40 kB`）、i18n `1026/1026`、tsc、diff check通过。当前仍 `unverified`，等待新 exact native reviewer。

### 7.255 verified：cleanup post-remove read-back review closure

- exact HEAD `d994a49` reviewer通过：`security_concerns=[]`、`logic_errors=[]`；真实 Git fixture覆盖 target存在 false、target目录删除但 Git listing残留 false、prune后 absence true；production cleanup在 registry/orphan projection前执行 strict read-back。
- 同一快照质量门：targeted `1/1`；Rust fmt/check、全量 lib `102/102`；Node `139 files / 1165 tests`；build、i18n `1026/1026`、tsc、diff check通过。后续可将 fixture setup迁移到 `TempDirs`/sanitized Git resolver，但不影响本 bounded closure。
- 已创建本地 verified tag：`checkpoint/native-cleanup-post-remove-readback-verified`。该 closure只覆盖 cleanup absence read-back，不代表 partial-CAS、pending probe、Windows TOCTOU、Unix/macOS、GUI/E2E、Worker或历史 debt关闭。

### 7.256 evidence：partial-CAS recovery design gate

- 只读研究确认 concrete-risk：`dev_cleanup_worktree` 在 branch CAS成功后 remove/probe失败时没有 durable native phase；Node/Worker 侧只有 generic `unknown/needs-user` 与旧 branchRevision，restart/orphan restore要求 branch仍存在，无法可靠收敛。
- 证据路径：`src-tauri/src/authority/worktree.rs` CAS/remove顺序、`authority/state.rs`无partial phase、`src/dev/worktree.ts` orphan/restore分支、`src/dev/tauri-run.ts` generic unknown映射；现有 cleanup side-effect owner能抑制 proposal但不能记录“branch已删除”的native事实。
- 当前分类：`concrete-risk`。推荐下一次架构切片保持 CAS顺序，引入 host-owned durable `branch-cas-succeeded/worktree-remove-pending` phase与不重复CAS的 inspect/finalize path；重排 CAS/remove需另行评审。未获角色/字段/authority确认前不编码；本轮为 evidence-only，未重跑代码质量门。

### 7.257 evidence：reconcile triage dossier with verified native closures

- 将 `HISTORICAL_UNVERIFIED_TRIAGE.md` 基线更新到 current HEAD `0f13dd1` 与 entries `7.196–7.256`；移除已通过 exact review 的 protected metadata alias、find parity、legacy `run_git`、cleanup post-remove read-back作为“仍开放风险”，保留其跨平台/环境证据边界。
- 当前 concrete native residual收敛为 fresh-session restore identity、partial-CAS、pending probe unknown、Windows pathname TOCTOU、launcher parity与Unix/macOS matrix；Worker terminal/admission/provenance/runtime fencing、完整 WorkerQueue Tauri E2E和workflowStore/WorkflowEditor结构债务仍未收口。
- 本轮为 docs-only；实际检查：`git diff --check`通过，未重跑代码质量门。partial-CAS设计仍等待角色/字段/authority确认。

### 7.258 decision：confirm Terraform-level partial-CAS baseline, defer implementation

- 用户确认 partial-CAS采用本地 Terraform 级工具范围：项目目录内 durable cleanup state、四 phase matrix（`cas-pending` → `cas-succeeded` → `remove-pending` → `finalized`）、显式 native inspect/finalize、禁止重复 branch CAS、重启 native rebind与 identity/Git read-back。
- 用户明确调整执行顺序：先完成前端巨石拆分，再实现 partial-CAS；本轮不修改 native production code。前端剩余结构债务仍是下一阶段主线。
- 本轮为 docs-only；实际检查待提交前运行 `git diff --check`。

### 7.259 unverified：extract workflowStore project save queue owner

- 新增 `src/store/projectSaveQueue.ts`，收口原 workflowStore 内联 `projectSaveTails`：同项目 key 串行、不同项目 key并行、失败后队列继续；Save/Save As公开 store action合同和持久化顺序不变。
- 新增 direct regression：queue success/failure ordering；workflowStore现有 save、Save As、serialize suite继续通过。
- 验证：focused `4 files / 28 tests`；完整 Node `140 test files / 1167 tests`；build通过（最大 chunk `1,174.50 kB`）；i18n `1026/1026`；tsc、diff check通过。当前只能标记 `unverified`，等待 exact frontend reviewer。

### 7.260 verified：exact review closes workflowStore project save queue slice

- 独立 reviewer 对 exact HEAD `694414e79a79058df253e146691d87b9996c1e78` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认同 key 串行、跨 key 并行、失败后续队列释放、identity-checked tail cleanup，以及 workflowStore Save 返回值、guard 和 finalization行为未改变。
- reviewer独立复核 focused `9/9`、全量 `140 files / 1167 tests`、build、i18n `1026/1026`、TypeScript 和 diff check；非阻塞建议记录为后续回归：第三个同 key pending task 的 tail cleanup race、Save guard abort/project-switch rejection。
- 创建 verified tag：`checkpoint/frontend-workflow-save-queue-verified`；原 `checkpoint/frontend-workflow-save-queue-unverified` 保留为历史回退锚点。partial-CAS仍未编码，下一阶段继续 workflowStore bounded split。

### 7.261 unverified：extract workflow Save As controller

- 新增 `src/store/projectSaveAsController.ts`，收口 Save As 的 Tauri gate、目录选择、ProjectFile 写入、pending event flush、失败 warning 和保存完成 callback；`workflowStore.ts` 保留 facade、stable `projectSnapshot`、dirty state 与 `saveLastSession`。
- 新增 controller direct regressions：browser gate、取消选择、成功 flush/回调、持久化失败；既有 Save As dirty-marker regression继续通过。显式用 `WorkflowState` 类型打断 module-level controller 与 Zustand store 的推断回环，避免全仓 selector退化为 `any`。
- 验证：focused `4 files / 11 tests`；完整 Node `141 test files / 1171 tests`；build通过（最大 chunk `1,175.00 kB`）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact frontend reviewer。

### 7.262 verified：exact review closes workflow Save As controller slice

- 独立 reviewer 对 exact HEAD `8110dcb0f6c9bab36d4aaf2be81f9e8a1083147a` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 source comparison、Save As facade wiring、browser/cancel/success/error边界及动态 I/O wiring无新增逻辑或安全问题。
- reviewer独立复核 focused `4 files / 11 tests`、全量 `141 files / 1171 tests`、build、i18n `1026/1026`、tsc、diff check 和 security scan；非阻塞建议记录为后续回归：pending-event flush rejection、Save/Save As共享 guard或queue。
- 创建 verified tag：`checkpoint/frontend-workflow-save-as-controller-verified`；原 `checkpoint/frontend-workflow-save-as-controller-unverified` 保留为历史回退锚点。partial-CAS仍未编码，下一阶段继续 workflowStore persistence bounded split。

### 7.263 unverified：extract project configuration autosave owner

- 新增 `src/store/projectConfigAutosave.ts`，收口 agents、roles、defaultAgentId、agentRouteTable 四类配置变化监听、projectPath gate、1s debounce、最新 state save 和静默失败；提供 dispose 清理 subscriber/timer。
- `workflowStore.ts` 保留 `suppressDirty` 生命周期 gate和 store facade，仅通过 `installProjectConfigAutosave` 接入；没有改变自动保存触发字段、延迟或失败策略。
- 新增 direct regressions：配置变更合并为一次保存、无项目/抑制状态不调度；验证 focused `5 files / 15 tests`，完整 Node `142 test files / 1173 tests`，build通过（最大 chunk `1,175.12 kB`），i18n `1026/1026`，tsc、diff check通过。当前标记 `unverified`，等待 exact frontend reviewer。

### 7.264 verified：exact review closes project configuration autosave slice

- 独立 reviewer 对 exact HEAD `2b542c7db56c9bb87b53734af4e52bdcda72f2fc` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认四个 trigger key、suppression/projectPath gate、1000ms debounce、latest-state save、rejection swallowing 与 timer cleanup行为保持不变。
- reviewer独立复核 focused `5 files / 15 tests`、全量 `142 files / 1173 tests`、build、i18n `1026/1026`、tsc、diff check 和 static scan；非阻塞建议记录为后续回归：逐一覆盖四个 trigger key、unrelated field、rejection swallowing、latest-state capture 和 disposer cancellation/idempotence。
- 创建 verified tag：`checkpoint/frontend-project-config-autosave-verified`；原 `checkpoint/frontend-project-config-autosave-unverified` 保留为历史回退锚点。partial-CAS仍未编码，下一阶段继续 workflowStore dirty/persistence bounded split。

### 7.265 unverified：extract project dirty runtime owner

- 新增 `src/store/projectDirtyController.ts`，收口项目 dirty subscriber、stable snapshot比较、suppression flag、`finalizeLoaded` baseline重建与dispose；`workflowStore.ts` 的 checkpoint、new/open/close/switch action改为调用 controller，不再持有裸 `suppressDirty` 或旧 subscriber实现。
- `projectConfigAutosave`继续通过 dirty controller读取 suppression状态；`DIRTY_KEYS`、`projectSnapshot`和 store API合同未改变。显式 `ProjectDirtyController` 类型注解避免 module-level controller 与 Zustand initializer 形成推断回环。
- 验证：focused `6 files / 17 tests`；完整 Node `143 test files / 1175 tests`；build通过（最大 chunk `1,175.52 kB`）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact frontend reviewer。

### 7.266 verified：exact review closes project dirty runtime slice

- 独立 reviewer 对 exact HEAD `f6f85a2539e34253dc1f9a6a21704a4df0c8ea99` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 dirty subscriber、DIRTY_KEYS比较、no-snapshot/stable mismatch行为、suppression覆盖和 open/finalize顺序无改变，未发现 Zustand cycle 或 duplicate owner。
- reviewer独立复核 focused `6 files / 17 tests`、全量 `143 files / 1175 tests`、build、i18n `1026/1026`、tsc、diff check；非阻塞建议记录为后续回归：no-snapshot/stable-mismatch、unrelated DIRTY_KEYS、dispose idempotence、throwing state update，以及 scoped suppression helper。
- 创建 verified tag：`checkpoint/frontend-project-dirty-runtime-verified`；原 `checkpoint/frontend-project-dirty-runtime-unverified` 保留为历史回退锚点。partial-CAS仍未编码，下一阶段继续 workflowStore persistence bounded split。

### 7.267 unverified：share ProjectFile and pending-event persistence owner

- 新增 `src/store/projectFilePersistence.ts`，收口“ProjectFile save返回 root → 按 project id检查 pending events → 使用返回 root flush”的共享顺序；普通 Save 与 Save As 均接入，原有 guard checkpoints、SaveAs错误日志、stable snapshot、queue合同保留。
- 新增 direct regressions：返回 root绑定 flush、无 pending跳过、save/flush异常原样传播；并修正 Save As adapter 的 optional target path 类型，使 `tsc -b` project-reference检查不退化。
- 验证：focused `5 files / 16 tests`；完整 Node `144 test files / 1178 tests`；build通过（最大 chunk `1,175.86 kB`）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact frontend reviewer。

### 7.268 verified：exact review closes shared ProjectFile persistence slice

- 独立 reviewer 对 exact HEAD `fa7b47ad41fbb82105ca0a056b982283673937b5` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`、`suggestions=[]`；确认 save → returned root → pending count → flush顺序、异常传播、Save/Save As接入、guard/non-Tauri行为和 dynamic adapter wiring均保持正确，无 duplicate legacy sequence、race或安全问题。
- reviewer独立复核 focused `5 files / 16 tests`、全量 `144 files / 1178 tests`、build、i18n `1026/1026`、TypeScript、diff check 和 static scans；无工作树修改。
- 创建 verified tag：`checkpoint/frontend-project-file-persistence-verified`；原 `checkpoint/frontend-project-file-persistence-unverified` 保留为历史回退锚点。partial-CAS仍未编码，下一阶段继续 workflowStore persistence bounded split。

### 7.269 unverified：extract createProject pure state builder

- 在既有 `src/store/workflowState.ts` 增加 `buildCreateProjectState`，收口模板 graph → WorkflowFileInMemory、canvas dirty nodes、项目 metadata、默认 agents/roles、project variables/assets、empty Worker registry 与 ProjectControl snapshot；`workflowStore.createProject` 保留 Tauri path resolution、suppression、save/session、失败恢复和日志。
- 新增 workflowState direct regression：template/project metadata、两份 node dirty projection、edges和初始 worker state一致；原 store facade/API合同不变。
- 验证：focused `5 files / 36 tests`；完整 Node `144 test files / 1179 tests`；build通过（最大 chunk `1,176.15 kB`）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact frontend reviewer。

### 7.270 unverified：repair createProject role projection aliasing

- exact reviewer 对 `7e189dba90d5e5c154037ba63652d5aeb64423c0` 发现 logic blocker：`buildCreateProjectState` 将 top-level `roles` 与 workflow `roles` 共享数组/元素引用，偏离父实现的独立 projection。
- 先以 RED regression 固化 array/object identity，再让 builder分别 map builtin roles；保留其它 createProject state、facade和副作用合同不变。
- 验证：focused `3 files / 31 tests`；完整 Node `144 test files / 1179 tests`；build通过（最大 chunk `1,176.17 kB`）；i18n `1026/1026`；tsc、diff check通过。当前 repair HEAD仍标记 `unverified`，等待新的 exact reviewer。

### 7.271 verified：exact review closes createProject role projection repair

- 独立 reviewer 对 exact HEAD `3ac48f581d45f4f8eebd282fb68df6fb2b334dbc` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 role arrays/objects已独立，且 createProject graph、node dirty projection、metadata、defaults、state fields和facade integration保持正确。
- reviewer独立复核 focused/full tests、build、i18n、tsc、diff check、runtime identity checks 和 static scans；建议保留的 workflow node dirty assertion已与 role identity assertions同时存在。
- 创建 verified tag：`checkpoint/frontend-create-project-role-alias-repair-verified`；原 `checkpoint/frontend-create-project-role-alias-repair-unverified` 保留为历史回退锚点。createProject builder现已 verified，partial-CAS仍未编码。

### 7.272 unverified：extract WorkflowEditor styled-edge projection

- 新增 `src/canvas/workflowEdgeProjection.ts`，收口纯 styled-edge transformation：source-port color、collapsed-group source/target proxy handle重定向、missing-port fallback和style合并；无 React/store副作用。
- `WorkflowEditor.tsx` 保留 `portSig`、`outsByNode` memo、group mapping构建和React Flow消费，仅委托纯 projection；新增 direct regression覆盖普通边、proxy边、fallback和输入不可变。
- 验证：focused `5 files / 69 tests`；完整 Node `145 test files / 1182 tests`；build通过（最大 chunk `1,176.18 kB`）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact frontend reviewer。

### 7.273 verified：exact review closes WorkflowEditor styled-edge projection slice

- 独立 reviewer 对 exact HEAD `be689df0011b08eb0db4fd1886d683d405e6d904` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 source-port coloring、collapsed-group proxy rewrites、style merge、immutability和 WorkflowEditor memo ownership保持正确。
- reviewer独立复核 focused/full tests `145 files / 1182 tests`、build、i18n `1026/1026`、TypeScript 和 diff checks；非阻塞建议记录为后续 coverage扩展：全部 port-color mappings、null/undefined source handles、task/control edge-data preservation。
- 创建 verified tag：`checkpoint/frontend-styled-edge-projection-verified`；原 `checkpoint/frontend-styled-edge-projection-unverified` 保留为历史回退锚点。partial-CAS仍未编码。

### 7.274 unverified：extract registerWorkflow state builder

- 在 `src/store/workflowState.ts` 增加 `buildRegisteredWorkflowState`，收口 WorkflowFile normalization、project/standalone identity、fallback agents/roles/variables/assets/groups以及 activate canvas projection；`workflowStore.registerWorkflow` 保留 ID生成、Zustand set和返回合同。
- 新增 direct regressions：activate=false仅注册、activate=true复用 normalized state生成 dirty canvas activation；未改变 ProjectSessionPanel/Builder caller合同。
- 验证：focused `4 files / 46 tests`；完整 Node `145 test files / 1184 tests`；build通过（最大 chunk `1,176.50 kB`）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact frontend reviewer。

### 7.275 verified：exact review closes registerWorkflow state slice

- 独立 reviewer 对 exact HEAD `8868b04d633c9ef816c301452e8e8a4b9ab80936` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 normalization、project/standalone identity、activation projection、public return/set合同无行为变化，未发现 duplicate owner、aliasing、mutation、runtime cycle或安全问题。
- reviewer独立复核 focused/full `145 files / 1184 tests`、build、i18n `1026/1026`、TypeScript、diff check和static scans；非阻塞建议记录为后续 parity coverage：non-empty fallback、cross-project/standalone combinations、defaultAgent/edge/log preservation、input non-mutation。
- 创建 verified tag：`checkpoint/frontend-workflow-registry-state-verified`；原 `checkpoint/frontend-workflow-registry-state-unverified` 保留为历史回退锚点。partial-CAS仍未编码。

### 7.276 unverified：extract newWorkflowInProject state builder

- 在 `src/store/workflowState.ts` 增加 `buildNewWorkflowInProjectState`，收口游离画布 capture、空白 workflow registry entry、project/standalone identity 和 activation projection；`workflowStore.newWorkflowInProject` 保留默认目录异步解析、时间/ID生成和 Zustand facade。
- 新增 direct 与 facade regressions：unbound canvas capture、project activation、standalone workspace identity、`assets: []` 初始化；对照父实现保留 dirty 行为与 captured workflow metadata。
- 验证：focused `2 files / 29 tests`；完整 Node `146 test files / 1187 tests`；build通过（最大 chunk `1,177.02 kB`）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact frontend reviewer。

### 7.277 unverified：repair newWorkflow capture timestamp parity

- exact reviewer 对 `37ef92827afe487fe2157664086c3b6fe190172d` fail-closed：指出 capture workflow ID/date 与新 workflow ID/savedAt 的 `Date.now()`/`Date`采样顺序被重排，builder间接依赖时间；该 verdict 不创建 verified tag。
- 以 repair checkpoint `ce8d5beb1548fc98aa8c018dae576ed78592b146` 为起点：`workflowStore` 重新按父实现顺序负责 capture ID/date 与新 ID/date；`serializeCurrent` 接受注入 savedAt；`buildNewWorkflowInProjectState` 不再取时钟；补 fake-clock、captured timestamp、asset preservation 和 source non-mutation regressions。
- 验证：focused `2 files / 31 tests`；完整 Node `146 test files / 1189 tests`；build通过（最大 chunk `1,177.17 kB`）；i18n `1026/1026`；tsc、diff check通过。当前 repair 标记 `unverified`，等待新的 exact frontend reviewer。

### 7.278 verified：exact review closes newWorkflow registry/timestamp slice

- 独立 reviewer 对 exact HEAD `8fefba355bc6c2479c44cd33de6a927c18525fcb` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 workflow identity、unbound capture、assets、activation、standalone/project path、dirty behavior、async facade和输入 aliasing保持父实现合同。
- reviewer特别复核 capture 顺序为 `Date.now()` capture ID → capture `savedAt` → 新 workflow ID → 新 workflow `savedAt`；确认 builder不再取时钟。独立复核 focused `31/31`、full `146 files / 1189 tests`、build、i18n、TypeScript和diff check通过。
- 创建 verified tag：`checkpoint/frontend-new-workflow-registry-verified`；`37ef928` 的失败 verdict和 `checkpoint/frontend-new-workflow-registry-unverified` 保留为历史回退锚点。partial-CAS仍未编码。

### 7.279 unverified：收口 workflow state module topology

- 按事实所有权新增 `src/store/workflowRegistryState.ts`（workflow switch/register/new、workspace resolution）、`src/store/workflowLifecycleState.ts`（open/create/new project builders）和 `src/store/projectCatalogState.ts`（catalog collection transforms）；`src/store/workflowState.ts` 降为兼容 re-export barrel，不再承载混合实现。
- `workflowStore.ts` 改为直接依赖 owner module；`executor.ts`、`nodes/builtin/dispatch.ts` 直接从 registry owner 读取 workspace resolution；现有 Zustand action、ProjectFile、ProjectControl、persistence和global-agent contracts未改变。
- 将原 mixed state tests 按 catalog/registry/lifecycle 物理归属拆为 direct test files，并保留 barrel re-export contract；本轮没有引入 graph command、global-agent AppData 或生命周期副作用抽取。
- 验证：focused `4 files / 29 tests`；完整 Node `149 test files / 1190 tests`；build通过（最大 chunk `1,177.17 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact frontend structure reviewer。

### 7.280 unverified：repair duplicated lifecycle type owner

- exact reviewer 对 `f3cc2bf6c732b836ab7a5b216b8cab5b4ccf61a0` fail-closed：发现 `CreateProjectStateInput` 同时存在于 `workflowRegistryState.ts` 和 `workflowLifecycleState.ts`，违反事实 ownership；该 verdict 不创建 verified tag。
- 以 repair checkpoint `f1615375b5444c1b70ac96297be90c355c32d658` 为起点，从 registry module 删除重复 lifecycle input type，保留 lifecycle module 为唯一 owner；未改变 runtime implementation或兼容 barrel合同。
- 验证：focused `4 files / 29 tests`；完整 Node `149 test files / 1190 tests`；build通过（最大 chunk `1,177.17 kB`）；i18n `1026/1026`；tsc、diff check通过。当前 repair 标记 `unverified`，等待新的 exact structure reviewer。

### 7.281 unverified：align state owner comments

- 根据 reviewer 非阻塞建议，更新 `workflowStore.ts` 中 catalog、lifecycle、registry builder 的注释，使文案分别指向 `projectCatalogState`、`workflowLifecycleState` 和 `workflowRegistryState`；不改变生产逻辑、导出或调用合同。
- 验证：完整 Node `149 test files / 1190 tests`；build通过（最大 chunk `1,177.17 kB`）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact structure reviewer。

### 7.282 verified：exact review closes workflow state module topology

- 独立 reviewer 对 exact HEAD `066cc8be7dde6207ac66c59a66ae7330209f5c4d` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 owner definitions唯一、reverse imports不存在、compatibility barrel exports保持、调用方编译通过、注释与实际 ownership一致。
- reviewer独立复核 full `149 test files / 1190 tests`、build、i18n `1026/1026`、tsc和diff check；post-`14226f7` source diff仅为 owner comment alignment。
- 创建 verified tag：`checkpoint/frontend-state-module-topology-verified`；`f3cc2bf` 的 duplicate lifecycle type failure、`14226f7` repair和相关 unverified tags保留为历史回退锚点。partial-CAS仍未编码。

### 7.283 unverified：extract project catalog mutation transforms

- 在 `src/store/projectCatalogState.ts` 增加 project-scope Agent/Role mutation transforms：`buildUpsertAgentState`、`buildRemoveAgentState`、`buildSetDefaultAgentState`、`buildUpsertRoleState`、`buildRemoveRoleState`；保留 route/default 清理、builtin role rejection和caller-owned identity，副作用仍由 facade负责。
- `workflowStore.ts` 的 project `upsertAgent/removeAgent/setDefaultAgent/upsertRole/removeRole` 改为调用 catalog owner；global-agent AppData 的 `setGlobalAgents/upsertGlobalAgent/removeGlobalAgent` 保持原有 facade persistence/viewStore 行为，未混入 project catalog。
- 新增 direct catalog regressions与 store facade regressions，覆盖 ID/order、default/route cleanup、builtin log、custom role removal和 source immutability。
- 验证：focused `2 files / 18 tests`；完整 Node `150 test files / 1200 tests`；build通过（最大 chunk `1,177.40 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact frontend catalog reviewer。

### 7.284 verified：exact review closes project catalog mutation slice

- 独立 reviewer 对 exact HEAD `08b8512c681a97400b83566dd8e433fac77d9c62` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 project/global scope separation、route/default cleanup、builtin-role refusal、source identity、facade set/dirty/autosave/log合同和模块可读性保持正确。
- reviewer独立复核 focused `18/18`、full `150 files / 1200 tests`、build、i18n `1026/1026`、TypeScript、diff check和static scan；非阻塞建议记录为后续 coverage backlog：projectPath/fake-timer dirty/autosave、global persistence/master cleanup、nested route identity和builder JSDoc。
- 创建 verified tag：`checkpoint/frontend-project-catalog-mutation-verified`；`checkpoint/frontend-project-catalog-mutation-unverified` 保留为历史回退锚点。partial-CAS仍未编码。

### 7.285 unverified：extract graph history/clipboard command facade

- 新增 `src/store/workflowGraphCommands.ts`，收口 `pushHistory/undo/redo/clearHistory/copySelection/pasteClipboard/duplicateSelection` 的 store-bound 编排；通过 `GraphCommandState`、`GraphCommandDeps` 注入 get/set/addLog，不反向依赖 workflowStore/useViewStore。
- `workflowGraph.ts` 继续作为纯 graph kernel；`selectAll`、React Flow selection policy、group/subgraph/split-view行为保留在 facade或原 owner；现有 public Zustand action names不变。
- 新增 graph command direct tests，覆盖 history round-trip、clipboard internal-edge filtering/log和paste remap/offset/selection；不在本 slice混入跨 workflow history、stale clipboard或selection双表示等既有行为问题。
- 验证：focused `6 files / 50 tests`；完整 Node `151 test files / 1203 tests`；build通过（最大 chunk `1,177.37 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact frontend graph reviewer。

### 7.286 unverified：add graph command Zustand assembly regression

- 根据 graph reviewer 非阻塞建议新增 `src/store/workflowStore.graphCommands.test.ts`，验证 command owner spread真实进入 Zustand facade，并确认 inline `selectAll`边界仍由 facade提供；不改变 production graph command implementation。
- 验证：focused `3 files / 21 tests`；完整 Node `152 test files / 1204 tests`；build通过（最大 chunk `1,177.37 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。当前 assembly repair 标记 `unverified`，等待新的 exact frontend graph reviewer。

### 7.287 verified：exact review closes graph command facade slice

- 独立 reviewer 对 exact HEAD `38c0094ee5c755eb1c45940a17c024c621f8d7fb` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 test-only follow-up未改变 production graph command owner，Zustand spread command与inline `selectAll`边界正确。
- reviewer独立复核 focused `21/21`、full `152 files / 1204 tests`、build、i18n `1026/1026`、TypeScript和diff check；既有 Vite dynamic/static import与大 chunk warnings保持非阻塞。
- 创建 verified tag：`checkpoint/frontend-graph-command-facade-verified`；`checkpoint/frontend-graph-command-facade-unverified` 保留为历史回退锚点。partial-CAS仍未编码。

### 7.288 unverified：extract workflow registry rename/remove mutations

- 在 `src/store/workflowRegistryState.ts` 增加 `buildRenameWorkflowState` 与 `buildRemoveWorkflowState`，收口 active workflow rename、inactive/active/final removal、fallback activation、empty registry patch和 workspace cleanup intent；不触碰 Tauri cleanup副作用。
- `workflowStore.ts` 保留 public action、两次 rename set 顺序、remove cleanup 的 fire-and-forget/swallowed-error合同；仅将 registry/activation计算委托给 pure owner。close/open/create/new/switch等 ProjectControl/host orchestration不在本 slice。
- 新增 direct registry mutation tests与 facade tests，覆盖 active rename、inactive/active/final removal、first remaining activation和 public store contract。
- 验证：focused `4 files / 26 tests`；完整 Node `153 test files / 1212 tests`；build通过（最大 chunk `1,177.78 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact frontend registry reviewer。

### 7.289 unverified：repair workflow registry mutation parity

- exact reviewer 对 `98e108e60cbadddd63e2a4f5ce6f805dc106de7d` fail-closed：发现 final removal错误清除 defaultAgentId、empty active-id rename guard缺失、空字符串 cleanup intent被 facade truthy gate吞掉；该 verdict 不创建 verified tag。
- 以 repair checkpoint `2591a2e860d0ad3822303655975dd752bd8c6871` 为起点：恢复 parent truthy active-id guard；final activation不再输出 defaultAgentId；cleanup intent改为 `string | null` 并由 facade使用 `!== null`，保留空字符串 workflow id cleanup；新增 parity regressions。
- 验证：focused `2 files / 18 tests`；完整 Node `153 test files / 1213 tests`；build通过（最大 chunk `1,177.80 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。当前 repair 标记 `unverified`，等待新的 exact frontend registry reviewer。

### 7.290 verified：exact review closes workflow registry mutation parity

- 独立 reviewer 对 exact HEAD `bfd5ff07d8251378b22621568b6a0b2a5ea5e6b3` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 three parity blockers均已修复且没有新 regression。
- reviewer独立复核 focused `18/18`、full `153 files / 1213 tests`、build、i18n `1026/1026`、TypeScript、diff check和security scan。
- 创建 verified tag：`checkpoint/frontend-workflow-registry-mutation-verified`；`checkpoint/frontend-workflow-registry-mutation-unverified` 和 parity repair unverified tag保留为历史回退锚点。partial-CAS仍未编码。

### 7.291 unverified：extract workflow registry action facade

- 将 `switchWorkflow`、`newWorkflowInProject`、`registerWorkflow` 的 store-bound 编排抽到 `src/store/workflowRegistryActions.ts`；保留 `workflowRegistryState.ts` 的纯 builder 作为事实 owner，`workflowStore.ts` 只负责 Zustand facade 与 capability wiring。
- 注入 StatePort、dirty suppression、standalone path、clock/ISO time 与 registered-id factory；未移动 project identity、ProjectFile persistence、ProjectControl/runtime、host lifecycle 或 global-agent persistence。现有 public action signatures 与 capture-before-create 时间顺序保持不变。
- 新增 `workflowRegistryActions.test.ts` direct tests，覆盖 switch suppression、standalone path/capture clock ordering、register `activate:false`；保留原 facade/new-workflow/ProjectControl regressions。
- 验证：focused `6 files / 47 tests`；完整 Node `154 test files / 1216 tests`；build通过（最大 chunk `1,178.10 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact frontend registry action reviewer。

### 7.292 verified：exact review closes workflow registry action facade

- 独立 reviewer 对 exact HEAD `d4a1c1edb32fe92a4ba75f5dcf9e360a60c38de4` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 facade wiring、switch suppression、standalone path、clock ordering、builder normalization/aliasing、activation和依赖 ownership保持。
- reviewer独立复核 focused `20/20`、full `154 files / 1216 tests`、build、i18n `1026/1026`、TypeScript和diff check；仅保留既有 build warnings及非阻塞 coverage suggestion。
- 创建 verified tag：`checkpoint/frontend-workflow-registry-actions-verified`；`checkpoint/frontend-workflow-registry-actions-unverified` 保留为历史回退锚点。partial-CAS仍未编码。

### 7.293 unverified：extract close project lifecycle action

- 将 `closeProject` 的纯状态 patch抽到 `workflowLifecycleState.buildCloseProjectState`，将 reset/suppression/set/session 顺序抽到 `projectLifecycleActions.ts`；`workflowStore.ts` 只负责注入 `resetProjectControlLifecycle`、dirty controller、`clearLastSession` 和默认 agent/role/ProjectControl factories。
- 严格保留 parent 合同：先以旧 `projectId` reset ProjectControl，再 suppression；只清理 close 原本清理的字段，不触碰 `defaultAgentId`、`workspaceDir`、`runHistory`、`artifacts`、`orchestrations` 等未归属字段；释放 suppression 后才 clear last session。未移动 ProjectLifecycleController、plugin/GUI session 或 Worker host orchestration。
- 新增 `projectLifecycleActions.test.ts` direct tests，覆盖精确 close patch、untouched fields和 reset → suppression → set → release → session 顺序；现有 `workflowStore.projectControl.test.ts` 保留 facade/ProjectControl regressions。
- 验证：focused `5 files / 18 tests`；完整 Node `155 test files / 1218 tests`；build通过（最大 chunk `1,178.55 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact close lifecycle reviewer。

### 7.294 verified：exact review closes close project lifecycle action

- 独立 reviewer 对 exact HEAD `8528934baacef1dac1d0d4f0fc00a2e71c878520` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 close signature、reset-before-suppression、exact patch、untouched fields、factory identity/aliasing、failure propagation和 single lifecycle ownership保持。
- reviewer独立复核 focused `26/26`、full `155 files / 1218 tests`、build、i18n `1026/1026`、TypeScript和diff check。
- 创建 verified tag：`checkpoint/frontend-close-project-action-verified`；`checkpoint/frontend-close-project-action-unverified` 保留为历史回退锚点。partial-CAS仍未编码。

### 7.295 unverified：extract ProjectControl lifecycle adapter port

- 在 `src/store/projectControlLifecycle.ts` 增加 `createProjectControlStoreAdapter`，将 reset/activation 的 event-buffer 与 Worker runtime capability 注入；现有 `resetProjectControlLifecycle`、`installProjectControlRuntime`、`activateProjectControlRuntime` 保留为兼容 wrapper，未移动 Worker runtime、event store、ProjectFile persistence或 host lifecycle事实。
- adapter只负责同步 reset/activate与 runtime-only projection：reset保留有 project id 才清理对应 event buffer、随后清理 active runtime；activate先清理目标项目 buffer，再安装 runtime，返回 recoveries并重新生成空 evidence/side-effects/cleanup-proposals数组。未接入 saveProject、App.tsx、ProjectLifecycleController或 workflowStore 全量 StatePort。
- 扩展 `projectControlLifecycle.test.ts` direct DI tests，覆盖 injected call order、project-id scope、installer forwarding和 runtime projection；既有 facade/Worker lifecycle tests保持不变。
- 验证：focused `3 files / 15 tests`；完整 Node `155 test files / 1219 tests`；build通过（最大 chunk `1,178.88 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact ProjectControl lifecycle adapter reviewer。

### 7.296 verified：exact review closes ProjectControl lifecycle adapter port

- 独立 reviewer 对 exact HEAD `2ecc1f7482b80c53e8a2a9f4f0008fa2b7c74787` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 reset、activation、install、runtime projection、错误传播、兼容 wrapper和 ownership boundaries保持。
- reviewer独立复核 focused `3 files / 15 tests`、full `155 files / 1219 tests`、build、i18n `1026/1026`、TypeScript、diff check、static scan和 behavioral probes。
- 创建 verified tag：`checkpoint/frontend-project-control-adapter-verified`；`checkpoint/frontend-project-control-adapter-unverified` 保留为历史回退锚点。createProject 旧 project-id buffer residual仍未修复，partial-CAS仍未编码。

### 7.297 unverified：wire ProjectControl adapter into workflowStore

- 由 `workflowStore` composition root 构造 `createProjectControlStoreAdapter`，将 `clearProjectEventBuffer`、`clearWorkerRunRuntime`、`installWorkerRunRuntime` 注入；`newProject`、`openProject` 和已验证的 `closeProject` action改用该实例，保留 public facade/API与既有时序。
- `createProject` 仍暂留兼容 `resetProjectControlLifecycle()` wrapper，未在本结构 slice 中修复其旧 project-id event-buffer residual；未移动 saveProject、event flush、ProjectFile persistence、App host lifecycle或 Worker reconciliation。
- 验证：focused `4 files / 18 tests`；完整 Node `155 test files / 1219 tests`；build通过（最大 chunk `1,179.00 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact ProjectControl adapter wiring reviewer。

### 7.298 verified：exact review closes ProjectControl adapter wiring

- 独立 reviewer 对 exact HEAD `b1ab5ec0f6afe8e6406f59f6ede6767e0d1e7b5a` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 adapter composition、reset/activation、close ordering、dirty suppression/finalizeLoaded、runtime projection、event-buffer scope和 public API parity保持。
- reviewer独立复核 full `155 files / 1219 tests`、build、i18n `1026/1026`、TypeScript、diff check、exact HEAD和 clean tree；facade direct regression suggestion非阻塞。
- 创建 verified tag：`checkpoint/frontend-project-control-adapter-wiring-verified`；`checkpoint/frontend-project-control-adapter-wiring-unverified` 保留为历史回退锚点。createProject 旧 project-id buffer residual仍未修复，partial-CAS仍未编码。

### 7.299 unverified：repair createProject previous-project reset scope

- 新增 facade RED regression：seed旧 project pending event与 active Worker runtime，调用无保存路径的 `createProject`，验证旧 event buffer与 runtime必须清空；原实现因无参数调用 `resetProjectControlLifecycle()` 而失败。
- 修复 `workflowStore.createProject`：先捕获 `previousProjectId`，再通过已接线 `projectControlAdapter.resetProjectControlLifecycle(previousProjectId)`；未改变模板/path/save-failure/session persistence合同，未移动 ProjectFile/event flush或 host lifecycle。
- 验证：focused `3 files / 16 tests`；完整 Node `155 test files / 1220 tests`；build通过（最大 chunk `1,178.90 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact createProject reset reviewer。

### 7.300 verified：exact review closes createProject previous-project reset repair

- 独立 reviewer 对 exact HEAD `3e598defcfc2aba4be38486c27e47cf7bb4dbf0d` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认旧 project event buffer/runtime scope、new project state、createProject path/template/save-failure/session/API合同和未移动的 event flush/host lifecycle保持。
- reviewer独立复核 focused `16/16`、single-worker full `155 files / 1220 tests`、build、i18n `1026/1026`、TypeScript、diff check、exact HEAD和 clean tree；parallel full Vitest出现的两个无关 timeout flake经隔离重跑通过。
- 创建 verified tag：`checkpoint/frontend-create-project-reset-repair-verified`；`checkpoint/frontend-create-project-reset-repair-unverified` 保留为历史回退锚点。后续可补 unrelated project event buffer 保留断言，partial-CAS仍未编码。

### 7.301 unverified：extract project bootstrap actions

- 将同步 `newProject`、`openProject` 的 store-bound 编排抽到 `src/store/projectBootstrapActions.ts`；纯 state builders仍由 `workflowLifecycleState.ts`拥有，ProjectControl reset/activation使用已注入 adapter，dirty suppression/finalizeLoaded由 facade capability提供。
- `createProject` 的异步 path/default-directory/save/failure/session合同继续留在 `workflowStore.ts`，未与 bootstrap action 混抽；open invalid file保持 no-op/false，valid open保持 set → finalizeLoaded → runtime activation顺序。
- 新增 `projectBootstrapActions.test.ts` direct tests，覆盖 new reset/suppression、invalid open no-op、valid open activation/finalization；保留现有 workflowStore ProjectControl/open/new regressions。
- 验证：focused `5 files / 21 tests`；完整 Node `156 test files / 1222 tests`；build通过（最大 chunk `1,179.13 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact project bootstrap reviewer。

### 7.302 verified：exact review closes project bootstrap actions

- 独立 reviewer 对 exact HEAD `42602046cfa5ce715ba22fba045d145f53fcf7a9` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 new/open sequencing、state construction、runtime projection、dependency injection、public APIs和 ownership boundaries保持，createProject仍保持 inline。
- reviewer独立复核 focused `21/21`、full `156 files / 1222 tests`、build、i18n `1026/1026`、TypeScript、diff check、exact HEAD和 clean tree；direct bootstrap coverage suggestion非阻塞。
- 创建 verified tag：`checkpoint/frontend-project-bootstrap-actions-verified`；`checkpoint/frontend-project-bootstrap-actions-unverified` 保留为历史回退锚点。partial-CAS仍未编码。

### 7.303 unverified：extract project creation actions

- 将异步 `createProject` 编排抽到 `src/store/projectCreationActions.ts`；注入 template lookup、identity、save-root resolution、dirty/state、saveProject、last-session和warning capabilities，复用 `buildCreateProjectState` 与 runtime empty projection。
- 保留 createProject 合同：旧 project reset先行；identity/template/path顺序不变；无 root清理 session；save成功使用返回 root写 last session；save失败保留内存项目、`projectPath=null`、`projectDirty=true`并保留原 warning 文案。未移动 saveProject、ProjectFile persistence、event flush或 host lifecycle。
- 新增 `projectCreationActions.test.ts` direct tests，覆盖内存创建、保存成功和保存失败 fallback；facade ProjectControl/createProject regressions保留。
- 验证：focused `5 files / 17 tests`；完整 Node `157 test files / 1225 tests`；build通过（最大 chunk `1,179.60 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact project creation reviewer。

### 7.304 verified：exact review closes project creation actions

- 独立 reviewer 对 exact HEAD `73712d6eb2af9cdc62563dc0760924a6a3a345d8` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 async sequencing、state construction、path/session/save-failure合同、injected wiring、public API和 persistence authority boundaries保持。
- reviewer独立复核 focused `17/17`、full `157 files / 1225 tests`、build、i18n `1026/1026`、TypeScript、diff check、exact HEAD和 clean tree；template/build ordering与Tauri default-root coverage suggestion非阻塞。
- 创建 verified tag：`checkpoint/frontend-project-creation-actions-verified`；`checkpoint/frontend-project-creation-actions-unverified` 保留为历史回退锚点。partial-CAS仍未编码。

### 7.305 unverified：extract App ProjectOperation guard

- 将 App 内 inline `projectOperationRef`、`getProjectOperation`、`assertProjectOperation` 与 clear逻辑抽到 `src/projectControl/projectOperation.ts`；保留 `ProjectOperation` shape、AbortError name/message、projectId/projectPath drift fence和 abort-on-replacement语义。
- App仍是 composition root：用 stable guard ref注入 live Zustand state，继续把 get/assert/clear ports传给现有 `ProjectLifecycleController`、Worker action/cleanup与 queued execution；未移动 lifecycle controller、GUI/plugin、Worker recovery/audit、Evidence/Receipt、cleanup或 terminal finalization authority。
- 新增 `projectOperation.test.ts` direct tests，覆盖 same identity reuse、id/path replacement abort、cancel/drift fail-closed、clear/idempotence；保留现有 lifecycle/Worker/component caller regressions。
- 验证：focused `7 files / 25 tests`；完整 Node `158 test files / 1229 tests`；build通过（最大 chunk `1,179.80 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。当前标记 `unverified`，等待 exact App ProjectOperation reviewer。

### 7.306 verified：exact review closes App ProjectOperation guard

- 独立 reviewer 对 exact HEAD `abb4f09787677d864f41ec402a0b759ced7c8e6a` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 guard behavior、live Zustand lookup、React-instance stability、caller signatures和 operation timing保持。
- reviewer独立复核 focused `25/25`、full `158 files / 1229 tests`、build、i18n `1026/1026`、TypeScript、diff check、security scan、exact HEAD和 clean tree；ProjectOperation type后续集中化建议非阻塞。
- 创建 verified tag：`checkpoint/frontend-app-project-operation-verified`；`checkpoint/frontend-app-project-operation-unverified` 保留为历史回退锚点。App其余 Worker/GUI/recovery/cleanup authority仍未拆分，partial-CAS仍未编码。

### 7.307 verified：extract App cleanup proposal controller

- 将 App 内 `refreshWorkerCleanupProposals` 抽到 `src/projectControl/workerCleanupProposalController.ts`；保留 canonical `getRestoredWorkerRunForCleanup`、`buildWorkerCleanupProposalSafely`、Acceptance/side-effect/worktree/branch-revision校验事实，只移动 application orchestration。
- controller通过窄 state port读写 workerRuns、recoveries、sideEffects、proposal projection和warning；App用 stable ref构造并继续把同一 callback传给 ProjectLifecycleController、Worker cleanup action和 queued worker。未移动 restoreWorktrees、audit、cleanup execution、receipt、TaskCleaned或 Worker runtime authority。
- 新增 direct tests，覆盖 missing/recovery suppression、TaskGraph restore failure warning、abort before host work和 projection boundary；现有 cleanup/lifecycle/Worker/UI regressions保持。
- 独立 reviewer 对 pinned exact HEAD `2cd2659ce32644322ebcfff243f9b326496b6e58`（相对 `e8f60f9`）返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 canonical restore、Acceptance、side-effect、host signature/tracking、branch revision、abort、stale-project和 per-run projection保持，且 controller 无 React/Zustand/App imports，stable callback wiring保持。建议增加 valid restored task 的 host-read abort、stale projectId suppression和 other-run preservation regression，非阻塞，列入后续增强。
- 验证：target gate focused `5 files / 20 tests`；完整 Node `159 test files / 1232 tests`；build通过（最大 chunk `1,179.96 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。reviewer新鲜全量复核另见一个与本切片无关的既有 Windows-path assertion failure，不改变 exact target verdict。创建 verified tag：`checkpoint/frontend-app-cleanup-proposal-verified`；原 `checkpoint/frontend-app-project-operation-unverified` 保留为历史回退锚点。

### 7.308 verified：extract queued Worker consistency admission seam

- 将 `runQueuedWorker` 内 pre-execution `assertConsistency` callback 抽到 `src/projectControl/workerRunConsistencyAction.ts`；注入 EventStream read、ProjectOperation assertion、current state、Acceptance list以及 canonical Worker/ProjectControl audit functions。
- 保留精确 admission合同：assert → read event stream → assert；needs-repair使用原错误；读取 live state后再次 assert；Worker facts或 ProjectControl facts不一致时使用原错误；不移动 audit实现、EventStream、runtime、persistence、transition或terminal finalization authority。
- 新增 direct tests，覆盖 assert/read/audit输入、needs-repair、Worker audit failure和 ProjectControl audit failure；App 仍是 composition root。
- 独立 reviewer 对 exact HEAD `3d23f88dd1c5f9f854ae286c1a964da879f0de14` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 assert/read/assert/live-state/assert 时序、exact errors、canonical audit inputs、App composition-root边界和 clean tree保持。顺序敏感断言建议非阻塞，作为后续增强记录。
- 验证：focused `6 files / 23 tests`；完整 Node `160 test files / 1234 tests`；build通过（最大 chunk `1,180.29 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。创建 verified tag：`checkpoint/frontend-queued-worker-consistency-verified`；对应 `checkpoint/frontend-queued-worker-consistency-unverified` 保留为历史回退锚点。

### 7.309 verified：extract queued Worker transition persistence seam

- 将 `runQueuedWorker` 的 `persistTransition` application choreography 抽到 `src/projectControl/workerRunTransitionPersistence.ts`；App 继续作为 composition root，注入当前 project identity、ProjectOperation fence、before-save snapshot、live Zustand state ports、EventBuffer、EventStream、ProjectFile serializer/raw saver、Evidence/side-effect merge与Orchestration projection。
- 保留两条原始路径：普通 transition 读取最新 live state后写入 WorkerRun/Orchestration/Evidence/SideEffect projection并执行 guarded `saveProject`；receipt 后取消只接受 safe finalization event allowlist，使用 EventBuffer flush与 before-save raw ProjectFile save，不触碰 live store mutation或普通 guarded save。
- 新增 direct tests，覆盖正常 transition、receipt-after-cancellation、unsafe cancelled events走 operation guard、side-effect读取失败不静默保存；未移动 WorkerQueue、coordinator、runtime、event replay、Evidence/Receipt事实、cleanup或终态事实 owner。
- 独立 reviewer 对 exact HEAD `45caabc74e84f15482aa1079ef1dd26c73ba7dc2`（相对 `a3e6f9fe00e068be98fd8ccc1e91529f43dc7990`）返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 normal transition fences/fresh-state ordering、safe terminal cancellation allowlist/raw finalization、error propagation、App wiring和 type-only injected ownership boundaries保持。
- 验证：focused `8 files / 63 tests`；完整 Node `161 test files / 1238 tests`；build通过（最大 chunk `1,181.01 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。创建 verified tag：`checkpoint/frontend-queued-worker-transition-persistence-verified`；对应 `checkpoint/frontend-queued-worker-transition-persistence-unverified` 保留为历史回退锚点。

### 7.310 verified：extract queued Worker transition projection helper

- 将 transition persistence 中的 `nextWorkerRuns` 替换和 canonical `projectWorkerRunsOntoOrchestrations` 组合抽到 `src/projectControl/workerRunTransitionProjection.ts`；该模块仅接收 current WorkerRun、current Orchestration和 transition，返回新数组，不执行 Zustand setter、operation guard、EventBuffer、Tauri、session、Evidence/SideEffect I/O或保存。
- 保留精确 map 语义：只替换同 `runId`，缺失 run 不追加，未匹配 run 保留原引用；Orchestration 仍委托既有 canonical projection owner。persistence controller 仅调用 helper，setter 顺序和所有异步边界保持。
- 新增 direct tests，覆盖 matching replacement、missing run no-append、caller-owned array不变性与真实 Orchestration projection；现有 persistence/coordinator/orchestration regressions保持。
- 独立 reviewer 对 exact HEAD `668878d235750a78a5b650f02e68c331a04a9029` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 replace-only mapping、identity/nonmutation、canonical projection delegation、persistence fences、setter order、cancellation finalization与 App/coordinator contracts保持。首个 projection 测试的 `not.toBe` 断言较弱，作为后续非阻塞测试增强记录。
- 验证：focused `4 files / 20 tests`；完整 Node `162 test files / 1241 tests`；build通过（最大 chunk `1,181.17 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。创建 verified tag：`checkpoint/frontend-queued-worker-transition-projection-verified`；对应 `checkpoint/frontend-queued-worker-transition-projection-unverified` 保留为历史回退锚点。

### 7.311 verified：extract queued Worker host infrastructure wiring

- 将 `runQueuedWorker` 的 Tauri EventStream/Evidence/SideEffect/Acceptance/recorder construction 抽到 `src/projectControl/workerRunHostInfrastructure.ts`；App 仍拥有 saved-project admission、GUI session、ProjectOperation、runtime/agent选择、coordinator、transition persistence和cleanup refresh。
- 保留原始 wiring 合同：四个 dynamic imports 并行；创建两个独立 `createTauriEventStoreAdapter(projectPath)` 实例；Evidence 路径为 `${projectPath}/.slimemold/evidence`、`${projectPath}-workers`、`host`；Acceptance verifier通过 `session.listAcceptances()` live closure；recorder使用 `undefined` clock；recorder构造后执行 operation assert，再构造 EventStreamRepository；错误不吞掉、不回退空 repository。
- adapter只返回 `eventRepository`、`sideEffects`和 `loadSideEffects` bridge，不拥有 GUI session、runtime、coordinator、ProjectFile或cleanup事实；新增 direct tests 覆盖 construction order、路径、双 adapter、live Acceptance closure、construction failure和 assert fence。
- 独立 reviewer 对 exact HEAD `fc9446838383b4891edffc48aa35cb9774bfd206` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 dynamic imports、双 adapter、Evidence paths、live Acceptance loading、undefined clock、assert fence、private side-effect repository binding和 App ownership/sequencing保持。
- 验证：focused `10 files / 73 tests`；完整 Node `163 test files / 1244 tests`；build通过（最大 chunk `1,181.87 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。创建 verified tag：`checkpoint/frontend-queued-worker-host-infrastructure-verified`；对应 `checkpoint/frontend-queued-worker-host-infrastructure-unverified` 保留为历史回退锚点。

### 7.312 verified：extract queued Worker session admission seam

- 将 `runQueuedWorker` 的 saved queued ProjectFile initial save、GUI session admission、host-unavailable error和 current-project identity fence抽到 `src/projectControl/workerRunSessionAdmission.ts`；保留 `ensureGuiDevSession`、ProjectOperation和 Zustand事实 owner在原模块。
- 保留精确顺序：saveProject(projectId/projectPath/signal) → assertOperation → ensureGuiDevSession(projectPath/signal) → null时读取 `getDevGuiError` 并抛出原中文文案 → assertOperation → 读取 current projectId并拒绝切换。初始 save/session/errors均不 catch、不回退；session admission后 App 再捕获 current store供 host infrastructure/coordinator使用。
- 新增 direct tests，覆盖成功顺序、exact unavailable-host error、stale project rejection和 initial save failure；App 的 host infrastructure、runtime、coordinator、transition persistence、cleanup wiring保持。
- 独立 reviewer 对 exact HEAD `9d958e2e0d44bd19ba5b4882ad8fd1f82d6ab65d` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 admission choreography、fail-closed propagation、identity fencing、Worker wiring/signatures和 canonical ownership boundaries保持。
- 验证：focused `12 files / 80 tests`；完整 Node `164 test files / 1248 tests`；build通过（最大 chunk `1,182.19 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。创建 verified tag：`checkpoint/frontend-queued-worker-session-admission-verified`；对应 `checkpoint/frontend-queued-worker-session-admission-unverified` 保留为历史回退锚点。

### 7.313 verified：extract Worker recovery audit controller

- 将 App `auditLoadedWorkerRunFacts` 的事件 baseline、retry snapshot reconcile、缺失 WorkerRun rehydrate、Worker/ProjectControl consistency audit、runtime/recovery projection、orchestration suppression、cleanup proposal suppression和 warning/error projection抽到 `src/projectControl/workerRunRecoveryAuditController.ts`；ProjectLifecycleController public callback signature保持不变。
- controller通过窄 state/setter/save/event-repository ports注入，继续调用 canonical `ensureProjectControlEventBaseline`、reconcile/rehydrate、Worker/ProjectControl audit、runtime install与 orchestration projection；不移动 GUI worktree restore、passive recovery I/O、interactive retry/skip、queued coordinator、cleanup proposal generation或 UI queue admission。
- 保留原有顺序与失败语义：baseline → reconcile/save → rehydrate/save → audit → runtime recovery projection → valid/suppressed orchestration projection；needs-repair和 audit failure清空 cleanup proposals并保留原 warning，repository failure转为 event-stream-invalid recovery，不吞掉 warning。
- 新增 direct tests，覆盖 healthy audit、retry reconcile save、needs-repair suppression和 repository failure recovery；recovery/lifecycle/UI caller regressions保持。已知 cleanup-unknown recovery merge、重复 Evidence load、restore-worktree ordering、ProjectOperation around audit await和 recovery UI policy仍是 residual，未混入本结构切片。
- 独立 reviewer 对 exact HEAD `07a39ea947c6f7d69a3c851f4d33585b9029d5dd` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 audited sequencing、failure semantics、live-state ports、canonical audit/projection calls、lifecycle callback wiring和 authority boundaries保持。所有 abort/state fence 与 exact setter order 的更细回归建议非阻塞，列入后续增强。
- 验证：recovery-focused `7 files / 27 tests`；完整 Node `165 test files / 1252 tests`；build通过（最大 chunk `1,183.43 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。创建 verified tag：`checkpoint/frontend-worker-recovery-audit-controller-verified`；对应 `checkpoint/frontend-worker-recovery-audit-controller-unverified` 保留为历史回退锚点。

### 7.314 verified：extract shared Worker recovery host-repository bundle

- 新增 `src/projectControl/workerHostRepositoryBundle.ts`，集中三条真实 caller 共用的 host repository construction：Tauri EventStore adapter、Evidence persistence、SideEffectJournalRepository、live Acceptance verifier和 persisted Worker recorder；返回 `loadEvidence`/`loadSideEffects` bridge，active path另提供 EventStreamRepository factory。
- 保留两个构造层以避免改变生命周期：full bundle供 queued active run和 interactive recovery；evidence-only bundle供 passive `loadProjectWorkerEvidence`，不额外创建 Acceptance verifier或 recorder。active/interactive 的 dynamic module load先于 session admission，recorder构造与 operation assert顺序保持；passive evidence path保留 Evidence→journal→read 顺序。
- 迁移 `workerRunHostInfrastructure`、`workerRecoveryIoController`和 `workerActionController`；不移动 ensureGuiDevSession、ProjectOperation、RecoveryCommand、event buffer、runtime install、ProjectFile save、retry/skip policy或 cleanup-unknown policy。现有 active/passive/interactive public signatures保持。
- 新增 bundle direct tests，覆盖 full/evidence-only construction、exact paths、live Acceptance bridge、双 EventStore adapter、recorder exclusion和 construction failure；caller recovery/lifecycle/UI regressions保持。
- 独立 reviewer 对 exact HEAD `34284be6a9c936d5ec1b10d9dec61f3fb73c2b7b` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 full/evidence-only bundle、三 caller construction order、paths、live Acceptance bridge、adapter separation、fencing和 recovery contracts保持。
- 验证：recovery-focused `9 files / 55 tests`；完整 Node `166 test files / 1255 tests`；build通过（最大 chunk `1,183.25 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。创建 verified tag：`checkpoint/frontend-shared-worker-recovery-repository-verified`；对应 `checkpoint/frontend-shared-worker-recovery-repository-unverified` 保留为历史回退锚点。

### 7.315 verified：harden interactive Worker recovery decision precondition

- 新增 `src/projectControl/workerRecoveryDecisionPrecondition.ts`，在 interactive `recoverWorkerRun` 完成 journal recovery 后、调用 `recoverWorkerRunCommand` 前重新读取 live state，拒绝 projectId/projectPath drift、目标 WorkerRun 丢失或 same-project WorkerRun/TaskGraph 内容变化。
- 通过稳定 JSON 对 captured run/TaskGraph 与 fresh state 做 fail-closed 比较；决策应用、event schema、RecoveryCommand、runtime、save、retry/skip事实 owner不变。后续 projection/runtime/save统一使用 precondition通过时的 fresh state，而不是异步前捕获的旧数组。
- 新增 direct RED→GREEN tests，覆盖 unchanged healthy、same-project run mutation、TaskGraph revision/content drift和 project identity drift；duplicate panel decision/single-flight mutex、decision CAS和 UI allowedDecisions仍是后续独立 slice。
- 独立 reviewer 对 exact HEAD `4a5fe8d33cb6525c0134b96b027a3624b68e78b0` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 precondition、captured command inputs、fresh-state projection ordering、canonical recovery/event ownership和 forbidden-import boundaries保持。controller-level drift/command-blocking回归建议非阻塞，列入后续增强。
- 验证：focused `6 files / 26 tests`；完整 Node `167 test files / 1259 tests`；build通过（最大 chunk `1,184.19 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。创建 verified tag：`checkpoint/frontend-worker-recovery-decision-precondition-verified`；对应 `checkpoint/frontend-worker-recovery-decision-precondition-unverified` 保留为历史回退锚点。

### 7.316 verified：add stable interactive Worker recovery single-flight

- 新增 `src/projectControl/workerRecoverySingleFlight.ts`，以 projectId、projectPath、runId 为 key 的 process-local lease guard；第二个同 key interactive recovery 在 host/session/journal work 前 fail-fast，different run/project 可并发。
- `workerActionController` 通过 `finally` release lease，保留首个调用的原 error/AbortError/save/retry语义；App 使用 stable `useRef` 注入 guard，避免 controller 每次 render 重建导致 mutex丢失。old lease 使用 token identity release，不能清除 newer lease。
- 不改变 WorkerRunRecovery/RecoveryCommand/event schema、durable CAS、UI allowedDecisions、passive startup recovery或 retry runtime selection；这些 residual 保留后续独立切片。
- 新增 direct guard tests和 action-level concurrency regression，覆盖 same-key reject、different-key concurrency、release-after-failure和 stable re-entry。
- 独立 reviewer 对 exact HEAD `e798a6a9e7d4681806f4ec56275eaf0c0376c52e` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 key scope、token-safe release、controller admission/finally release、stable App guard lifetime和 existing recovery order保持。跨 controller/process duplicate decisions、durable CAS和 UI allowedDecisions作为明确 residual。
- 验证：focused `2 files / 6 tests`；完整 Node `168 test files / 1263 tests`；build通过（最大 chunk `1,184.68 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。创建 verified tag：`checkpoint/frontend-worker-recovery-single-flight-verified`；对应 `checkpoint/frontend-worker-recovery-single-flight-unverified` 保留为历史回退锚点。

### 7.317 verified：project canonical Worker recovery decisions into UI

- 新增 `src/projectControl/workerRecoveryCapabilityProjection.ts`，基于 canonical `buildWorkerRunRecoveryPlan` 将 runtime recovery 投影为可点击的 `retry/skip`；只接受 `failed-tasks`、`unfinished-worker-lease`、`cleanup-unknown`，缺少或版本漂移的 TaskGraph、非 actionable recovery reason、lineage/plan 校验失败均 fail-closed 返回空集合。
- 不把 `allowedDecisions` 写入 WorkerRunQueueState、ProjectFile、DomainEvent 或 side-effect journal；RecoveryCommand/action controller 仍是最终 authority，`inspect` 继续仅作展示，不新增 inspect action。
- `workerRunView` 为 Professional view 增加 runtime-only `recoveryActions`；OrchestratorPanel 和 ProjectSessionPanel 只渲染 canonical projection允许的按钮，保留 existing callback signatures、single-flight、precondition和后端 revalidation。
- 新增 pure projector、professional view和Beginner UI回归：普通 failed-task显示 retry/skip；缺失 TaskGraph 不渲染 recovery actions；malformed side-effect、stale graph和 audit/event recovery reasons均不生成可点击决策。
- 独立 reviewer 对 exact HEAD `8e55fc0cc6267c43b0378890d2ccfcaaf52bbd0e` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 canonical plan delegation、graph/recovery identity、fail-closed capability、Beginner/Professional projection parity和 action authority保持。OrchestratorPanel direct cleanup-unknown/missing-graph regression及更完整 reason matrix列为后续增强。
- 验证：focused `3 files / 20 tests`；完整 Node `169 test files / 1269 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。创建 verified tag：`checkpoint/frontend-worker-recovery-capability-projection-verified`；对应 `checkpoint/frontend-worker-recovery-capability-projection-unverified` 保留为历史回退锚点。

### 7.318 verified：preserve transient Worker runtime through interactive retry

- 将 `WorkerRuntime` 类型收口到 `src/projectControl/workerRunCoordinator.ts`，扩展 recovery callback 的可选 runtime 参数。
- `ProjectSessionPanel` 在 mounted session 的 recovery retry 中透传当前 transient runtime；`workerActionController` 仅在 `retry` 时将 runtime 转发到 `runQueuedWorker`，`skip` 不启动 Worker；Professional/Orchestrator 无 runtime picker，继续使用 App 的 codex 默认。
- 不持久化 runtime，不改 WorkerRunQueueState、ProjectFile、DomainEvent、side-effect journal、attempt/effect key 或 restart/reopen 合同；跨重启 runtime provenance 保留为后续独立 schema slice。
- 新增回归：queued session 选择 antigravity 后进入 recovery，retry callback 仍收到 antigravity；既有 normal queued start 和 skip contract保持。
- 独立 reviewer 对 exact HEAD `7a2a6b0896ec86512371ed14d0cf46f9120f328a` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`；确认 transient selection→callback→retry forwarding、codex fallback、Antigravity coordinator selection和无 durable schema漂移。
- 验证：focused `2 files / 15 tests`；完整 Node `169 test files / 1270 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。创建 verified tag：`checkpoint/frontend-worker-recovery-runtime-propagation-verified`；对应 `checkpoint/frontend-worker-recovery-runtime-propagation-unverified` 保留为历史回退锚点。

### 7.319 design gate：freeze Worker recovery durable decision CAS contract before implementation

- 只读 audit 确认当前没有 canonical recovery facts fingerprint、durable decision owner或跨 ProjectFile/event stream/side-effect journal 的 commit protocol；`workerRecoveryDecisionPrecondition` 和 `workerRecoverySingleFlight` 仍分别只是内存 drift guard 与 process-local lease。
- 新增 `docs/architecture/WORKER_RECOVERY_DECISION_CAS_DESIGN.md`，冻结 proposed v1 的 FactsFingerprint/DecisionIdentity 两层边界、canonical normalization/hash vectors、durable owner、commit/read-back、same-decision idempotence、conflict、legacy/unbound migration 和 Gate A–D 实施顺序。
- 新增 ADR-SM-084 并更新 `docs/README.md` 导航；明确不把 event-stream sequence CAS、ProjectFile save queue、UI recoveryActions、transient WorkerRuntime 或 native cleanup partial-CAS 宣称为 recovery decision CAS。
- 本轮仅修改架构文档，没有写入 fingerprint/schema、没有接入 controller、没有改变 Worker/ProjectFile/Event/SideEffect 行为；durable CAS 仍未实现、未完成跨进程/restart read-back。
- 验证：docs link/read-back、`git diff --check`通过；未重跑 Node/build/i18n/tsc，因为本轮没有生产代码改动。

### 7.320 unverified：implement pure Worker recovery facts fingerprint Gate A

- 新增 `src/projectControl/workerRecoveryFactsFingerprint.ts`，定义 versioned `worker-recovery-facts-v1` DTO，规范化 current WorkerRun/TaskGraph/task attempt/worktree provenance 与 current recoverable started/unknown effects；排除 transient runtime、wall-clock metadata、UI capability和 durable writes。
- canonicalizer 对 object key、task/effect ordering、evidence references、Windows path representation和 optional fields做纯内存规范化；exported canonicalizer 同时校验 versioned DTO 的 required/allowed keys、snapshot lineage/provenance、status/number/reference、pendingAttempt/cleanup/receipt invariants，并在 canonicalize 前统一排序归一化；最后补齐 direct scalar 类型、空 assignment/cleanup receipt、ghost dependency、failedTask derivation与 path-case normalization；fingerprint 输出 `worker-recovery-facts-v1:sha256:<hex>`，仅使用 Web Crypto SHA-256，不接 ProjectFile、eventBuffer、side-effect journal、controller或native host。
- 新增 direct contract tests：多 task/effect insertion order稳定、attempt/effect identity变化改变 fingerprint、时间 metadata不改变结果、cross-task/legacy/malformed provenance、invalid state/version/number、assignment/receipt/path/ref/reference fail-closed。
- 本轮不改变任何 WorkerRun/ProjectFile/DomainEvent/SideEffect schema，不接 durable CAS；Gate A 通过不等于 recovery decision CAS 闭合。
- 验证：focused `1 file / 4 tests`；完整 Node `170 test files / 1274 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。当前修复 snapshot仍标记 `unverified`，等待下一次 exact Gate A re-review。

### 7.321 unverified：close direct recovery facts status and failed-task invariants

- 第十次 exact review 对 `66c8c8a55b41460734bea78402d5e33262a7299f` fail-closed：review 请求中的 parent hash 不存在，实际 parent 为 `ccbb3f926b4455544ff0500e9302896980ed65af`；同时确认 direct DTO 允许 `running`、`waiting-feedback`、`succeeded` 的 `attempt: 0` 且缺少当前 lineage，并允许 `failedTaskIds` 与 failed/running task 集合不一致。
- 新增 direct DTO RED 回归：三类 status 的 zero-attempt/no-lineage payload，以及 ghost/mismatched `failedTaskIds`；先观察到 4 个失败，再实现修复。
- 抽出共享 `assertTaskAttemptInvariant`，使 source builder 与 direct DTO validator 对 `running`、`waiting-feedback`、`succeeded`、`failed` 统一要求 `attempt >= 1`；direct DTO validator 现在从 task status 派生 expected failed/running IDs，并与 canonical sorted `failedTaskIds` 做逐项等价比较。
- 本轮未接 durable CAS、ProjectFile、eventBuffer、side-effect journal、controller或native host；当前 snapshot仍为 `unverified`，第十次 reviewer verdict因 parent 参数错误与上述逻辑缺陷不能继承。
- 验证：focused `1 file / 8 tests`；完整 Node `170 test files / 1278 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings；测试保留既有 GUI probe stderr）；i18n `1026/1026`；tsc、diff check通过。

### 7.322 verified closure：direct recovery facts status and failed-task invariants

- 第十一次 exact reviewer 针对 exact HEAD `d6807ede987e45ad90b7c2a947b9ad2cde16ffea`、parent `183a7cae68171908c15b82d2815f40cc737c395a` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`、`working_tree_clean=true`；确认 target 与 clean worktree一致，status/attempt/current lineage、failed-task 派生集合、membership、provenance、canonicalization、unknown-key rejection和纯 import boundary均通过。
- 创建 verified tag：`checkpoint/frontend-worker-recovery-facts-status-invariants-verified`，指向上述 exact code commit；该 tag 只闭合本轮纯 Gate A invariant slice。
- reviewer 明确 durable recovery decision CAS仍在本 slice之外，未接 ProjectFile、eventBuffer、side-effect journal、controller或native host；不得把本 tag解释为 durable CAS或真实 Worker recovery E2E完成。
- 验证：focused `1 file / 8 tests`；完整 Node `170 test files / 1278 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。

### 7.323 unverified：extract Worker recovery facts DTO type owner

- 从 `workerRecoveryFactsFingerprint.ts` 抽出 `src/projectControl/workerRecoveryFactsTypes.ts`，集中拥有 `worker-recovery-facts-v1` schema、DTO、source input及嵌套 receipt 类型；原文件仅保留兼容 import/re-export，不再重复定义类型。
- 本轮只移动类型与模块依赖，不改变 validator、normalizer、canonical JSON、hash、WorkerRun/TaskGraph/SideEffect schema、ProjectFile或durable CAS；未把类型拆分误报为 fingerprint 巨石已完全解决，后续仍需按 validation/source builder/normalization/serializer边界继续评估。
- 验证：focused `1 file / 8 tests`；完整 Node `170 test files / 1278 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。当前结构切片仍标记 `unverified`，等待 exact review。

### 7.324 verified closure：Worker recovery facts DTO type owner

- exact reviewer 针对 `7567b6a93be738a1c302299fafb9219f655c4931`、parent `fccd342cc9ad66df68cea0cdd674b60613373795` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`、`working_tree_clean=true`；确认 DTO/schema block 已完整迁移、schema 唯一定义、facade value/type re-export兼容，fingerprint builder/validator/normalizer/canonicalizer/hash未发生语义变化，且无反向循环或 durable CAS scope creep。
- 创建 verified tag：`checkpoint/frontend-worker-recovery-facts-types-verified`，指向上述 exact code commit；该 tag只证明 DTO type ownership结构切片，不证明 recovery facts 巨石已完全拆完或 durable CAS已实现。
- 验证：focused `1 file / 8 tests`；完整 Node `170 test files / 1278 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。

### 7.325 unverified：extract Worker recovery facts shared rules owner

- 从 `workerRecoveryFactsFingerprint.ts` 抽出 `src/projectControl/workerRecoveryFactsRules.ts`，集中拥有 required text/string/safe integer、UTF-8 canonical ordering、path/ref/timestamp/revision normalization、sorted/unique references和 shared task attempt invariant。
- source `taskFact` 与 direct `validateFactsDto` 现在导入同一 `assertTaskAttemptInvariant`；canonical path/ref/order等规则不再在 fingerprint facade 内重复定义。未移动 source builder、DTO validator、DTO normalization、canonical JSON或SHA-256行为。
- 本轮保持纯内存边界，不接 ProjectFile、eventBuffer、side-effect journal、controller、native host或durable CAS；当前 fingerprint facade仍有后续 source/DTO validation与normalization拆分工作。
- 验证：focused `1 file / 8 tests`；完整 Node `170 test files / 1278 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。当前结构切片标记 `unverified`，等待 exact review。

### 7.326 verified closure：Worker recovery facts shared rules owner

- exact reviewer 针对 `115929998e60d05f85efd690b4954f1ec2a7e017`、parent `fae69771f055e82fd22cffe3e0391d049a3842cb` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`、`working_tree_clean=true`；确认 diff 仅包含纯 shared-rules extraction、facade imports和 append-only log，所有 moved helper唯一归属 `workerRecoveryFactsRules.ts`，taskFact与validateFactsDto共享同一 attempt invariant，原函数体和 fingerprint logic未改变，且依赖无环、公共 facade与 durable CAS scope保持不变。
- 创建 verified tag：`checkpoint/frontend-worker-recovery-facts-rules-verified`，指向上述 exact code commit；该 tag只闭合共享规则 owner结构切片，不证明 source/DTO validator、normalizer、canonical serializer或durable CAS已全部闭合。
- 验证：focused `1 file / 8 tests`；完整 Node `170 test files / 1278 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。

### 7.327 unverified：extract Worker recovery facts normalization owner

- 从 `workerRecoveryFactsFingerprint.ts` 抽出 `src/projectControl/workerRecoveryFactsNormalization.ts`，集中拥有 DTO 内 task/worktree/graph/effect/receipt 的 path representation、UTF-8 ordering、reference sorting和 canonical transform；原 facade 仅调用 `normalizeFactsDto`。
- 本轮只移动纯 DTO normalization，不改变 source builder、direct DTO validator、canonical JSON、SHA-256、WorkerRun/TaskGraph/SideEffect schema、ProjectFile或durable CAS；依赖方向为 normalization → types/rules，未引入 host/store/runtime。
- 验证：focused `1 file / 8 tests`；完整 Node `170 test files / 1278 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。当前结构切片标记 `unverified`，等待 exact review。

### 7.328 verified closure：Worker recovery facts normalization owner

- exact reviewer 针对 `f81e0abdbc5734de72a67331bd31d3eb21d158af`、parent `0ad8f23b3a63f72102d99c96c4d1111425a30723` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`、`working_tree_clean=true`；确认 `normalizeFactsDto` body及全部 path/order/inputHash/receipt-file transform未改变，新模块仅依赖 types/rules、无循环或 host/store/runtime依赖，fingerprint facade、validation、builder和 durable CAS scope不变。
- 创建 verified tag：`checkpoint/frontend-worker-recovery-facts-normalization-verified`，指向上述 exact code commit；该 tag只闭合 normalization owner结构切片，不证明 source/DTO validator、canonical serializer或durable CAS已全部闭合。
- 验证：focused `1 file / 8 tests`；完整 Node `170 test files / 1278 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。

### 7.329 unverified：extract Worker recovery canonical JSON owner

- 从 `workerRecoveryFactsFingerprint.ts` 抽出 `src/projectControl/workerRecoveryFactsCanonicalJson.ts`，集中拥有 deterministic JSON value serialization、undefined/array rejection、safe-integer number encoding和UTF-8 object-key ordering；facade 保留 `canonicalizeWorkerRecoveryFactsV1` public API，仅委托 serializer。
- 本轮未改变 DTO validator、normalization、source builder、SHA-256 output、WorkerRun/TaskGraph/SideEffect schema、ProjectFile或durable CAS；新模块只依赖 `workerRecoveryFactsRules.ts`，保持纯内存、无 host/store/runtime依赖。
- 验证：focused `1 file / 8 tests`；完整 Node `170 test files / 1278 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。当前结构切片标记 `unverified`，等待 exact review。

### 7.330 verified closure：Worker recovery facts canonical JSON owner

- exact reviewer 针对 `9305aa4c8658282bd3d0bbcee0b06682a5d28514`、parent `6dddd3d48f7cad1a0827fdf30f1ac4a95a14cbb1` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`、`working_tree_clean=true`；确认 canonical serializer 行为不变、唯一 owner、rules-only dependency、public facade兼容，且 validator、normalization、builder、hash和 durable CAS scope均未改变。
- 创建 verified tag：`checkpoint/frontend-worker-recovery-facts-canonical-json-verified`，指向上述 exact code commit；该 tag只闭合 canonical JSON owner结构切片，不证明 source/DTO validator或 durable CAS已完成。
- 验证：focused `1 file / 8 tests`；完整 Node `170 test files / 1278 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。

### 7.331 unverified：extract Worker recovery direct DTO validator owner

- 从 `workerRecoveryFactsFingerprint.ts` 抽出 `src/projectControl/workerRecoveryFactsDtoValidation.ts`，集中拥有 direct DTO 的 allowed-key、scalar、status/attempt、lineage、assignment/worktree、TaskGraph membership/dependency、failedTaskIds derivation和 recoverable-effect provenance validation。
- `assertObject`/`assertKeys` 提升到 shared rules owner，source receipt validation与direct DTO validation共享同一 unknown-key/object guard；fingerprint facade 仅保留 source builder、public canonicalize/hash facade，并继续兼容 `canonicalizeWorkerRecoveryFactsV1`。
- 本轮未改变 source builder、normalization、canonical JSON、SHA-256 output、WorkerRun/TaskGraph/SideEffect schema、ProjectFile或durable CAS；新 DTO validator 仅依赖 domain execution、types和rules，保持纯内存边界。
- 验证：focused `1 file / 8 tests`；完整 Node `170 test files / 1278 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。当前结构切片标记 `unverified`，等待 exact review。

### 7.332 unverified：repair DTO validator diagnostic parity and shared receipt guard

- 第十一次 exact review 对 `06612355e46b3a1c2b4687d88aa6775319864458` fail-closed：确认 direct validator 与 parent 存在两个结构切片回归——`facts.run.taskGraphVersion` 的 safeInteger diagnostic field 被改成 `facts taskGraphVersion`，source `receiptFact` 仍使用 inline object guard，未复用 shared `assertObject`，且 array-shaped receipt 会落入后续 undefined.trim 错误。
- 新增两个 RED 回归：direct owner diagnostic field parity、带 `outcome` 属性的 array-shaped source receipt必须得到 `receipt 必须是对象`；先观察到两项失败，再修复。
- 修复 DTO validator diagnostic 为 `facts.run taskGraphVersion`；`receiptFact` 改为 `const receiptObject = assertObject(receipt, 'receipt')` 后再执行 allowed-key 校验，消除重复 guard并统一 array/null/object边界。
- 本轮仍未接 durable CAS、ProjectFile、eventBuffer、side-effect journal、controller或native host；等待针对新 repair snapshot的 exact re-review。
- 验证：focused `1 file / 10 tests`；完整 Node `170 test files / 1280 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。

### 7.333 verified closure：Worker recovery direct DTO validator repair

- exact reviewer 针对 `35a2b01d68d883640fecc979ec16ecc562a0a810`、parent `5f8d04ed69c79dcf8665a5f2004f3183ae46db15` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`、`working_tree_clean=true`；确认两条 RED vector均命中修复路径，direct DTO validation、source/builder、normalization、canonicalization、hash、public facade、纯 import boundary和 durable-CAS scope均保持兼容。
- 创建 verified tag：`checkpoint/frontend-worker-recovery-facts-dto-validator-repair-verified`，指向上述 exact code commit；该 tag只闭合本轮 diagnostic/receipt guard repair，不证明 source builder已独立拆出或 durable CAS已实现。
- 验证：focused `1 file / 10 tests`；完整 Node `170 test files / 1280 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。

### 7.334 unverified：extract Worker recovery source builder owner

- 从 `workerRecoveryFactsFingerprint.ts` 抽出 `src/projectControl/workerRecoveryFactsSource.ts`，集中拥有 taskFact、projectTaskFact、receiptFact、side-effect envelope/effectFact与 `buildWorkerRecoveryFactsV1`；fingerprint facade 现在仅保留 schema/type兼容导出、build兼容导出、canonicalize facade与SHA-256 hash。
- source owner 继续使用 shared rules、execution lineage、types和object guards；未改变 source facts DTO、TaskGraph/WorkerRun/SideEffect schema、normalization、canonical JSON、direct DTO validator、ProjectFile或durable CAS行为。
- 本轮结构结果：source builder `409` 行，fingerprint facade `37` 行；依赖方向为 source → domain/types/rules，facade → source/validator/normalization/canonical JSON，未引入 host/store/runtime副作用。
- 验证：focused `1 file / 10 tests`；完整 Node `170 test files / 1280 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。当前结构切片标记 `unverified`，等待 exact review。

### 7.335 verified closure：Worker recovery facts source builder owner

- exact reviewer 针对 `58c7d2eec1b002568f6167d62bdf07b60a1dbed0`、parent `ca3c61552f75d783d8d61f0ca5e75d4ef0bfd4bc` 返回严格 JSON：`passed=true`、`security_concerns=[]`、`logic_errors=[]`、`working_tree_clean=true`；确认 source builder body除尾部空白外与 parent 语义一致，shared object guards、lineage/provenance、normalization、dependency checks、failed-task derivation、DTO output、exports和error behavior均兼容，且无循环、host/store/runtime依赖或 durable-CAS scope creep。
- 创建 verified tag：`checkpoint/frontend-worker-recovery-facts-source-builder-verified`，指向上述 exact code commit；该 tag闭合 source builder owner结构切片，连同此前 types/rules/normalization/canonical JSON/DTO validation slices使该 fingerprint facade不再是事实巨石；durable CAS仍未实现。
- 验证：focused `1 file / 10 tests`；完整 Node `170 test files / 1280 tests`；build通过（最大 chunk `1,185.75 kB`，保留既有 dynamic/static import 与大 chunk warnings）；i18n `1026/1026`；tsc、diff check通过。

### 7.336 unverified：real Tauri GUI smoke and Worker E2E boundary read-back

- 在当前 exact source checkpoint `212ad1db2e0064f7947df493d7489959782037f1` 启动真实 `npx tauri dev`；实测 Vite `http://localhost:1420/` ready、Rust dev profile完成编译、真实 `SlimeMold · Agent 工作流`窗口可由 Windows UIA 枚举；不是把 CLI 进程存活当作 GUI 证据。
- 在 disposable fixture `D:/Temp/slimemold-tauri-e2e-20260920T005525Z-failure-clean` 的真实 WebView 中，先 read-back 未绑定智能体的 failure fixture，再通过当前 GUI combo 选择 `开启（离线回显）`，点击真实运行按钮；fixture `.slimemold/runs/checkpoints.json` read-back 为 `wf-failure/runId=3/status=success`，Worker node output包含离线模拟 plan，`durationMs=212`；ProjectFile 的 `runs.history`保留此前 unbound error runs。
- 交叉 read-back 显示这次成功属于通用 Workflow checkpoint：`.slimemold/project.json` 的 `workerRuns=[]`，`events/events.jsonl` 只有 ProjectControl baseline，fixture内没有 WorkerQueue `TaskStarted/TaskSucceeded/Failed`、Evidence、Acceptance、Receipt或CleanupReceipt。因此本轮证明了真实 Tauri/WebView generic workflow与离线模拟持久 checkpoint，不证明 WorkerQueue/provider/worktree/recovery E2E，也不证明 durable CAS。
- 本轮未删除 disposable fixture、worktree 或历史现场；停止已核对属于当前项目的 Tauri/Vite/Rust/WebView 进程并确认 `localhost:1420` 端口释放。

### 7.337 unverified：real Tauri Worker recovery retry E2E and persisted worktree reset repair

- 在真实 `npm run tauri dev` 的 `slime-mold.exe` 窗口中打开 `D:/Temp/slimemold-worker-e2e-failure`，重新加载后 GUI 明确显示 `WorkerRun=partial` 的 recovery capability，并提供 `确认重试新 attempt` 与 `确认跳过任务`；本轮通过 GUI 选择 retry，不把 headless projection 当作 GUI 证据。
- GUI retry 首次暴露了一个真实恢复缺陷：旧 task 已持久化 `worktreeStatus=created`/`branchRevision`，恢复命令只清除了 worktree id/path/branch/baseRevision，导致新 attempt 入队后宿主报“缺少完整 worktree assignment”。修复 `applyWorkerRunRecoveryDecision` 在 retry 时同时清除 `worktreeStatus` 与 `branchRevision`，并新增 persisted-created-task 回归测试；先观察到 focused test RED，再修复为 GREEN。
- 为使 disposable fixture 的 imported `approval=approved` 与事件事实一致，先备份 `.slimemold` 到 `D:/Temp/slimemold-worker-e2e-failure-before-approval-fix`，再通过事件存储追加 `BriefApproved` 与 `TaskGraphApproved`；未清理原始现场。
- 修复后的同一 GUI retry 真实落盘 `WorkerRunRecoveryDecided(decision=retry)`、`RunQueued(nextAttempt=2)`、`TaskAttemptMarkedUnknown`；随后从 GUI 启动 Worker，落盘 attempt 2 的 `RunStarted`/`TaskStarted`，创建独立 worktree `D:/Temp/slimemold-worker-e2e-failure-workers/w-b9106efb232f38bf0b1aa0a9`，并在该 worktree 生成真实 `docs/WORKER_E2E_FAIL.txt`。
- 宿主验收按 fixture 设计失败：`host.jsonl` 有 compile/tests/diff 三条 failed Evidence 与一条 path-policy passed Evidence，`acceptance/records.jsonl` 为 `passed=false`、`failedChecks=[compile,tests,diff]`，最终 Run 为 `partial`，没有 `RunSucceeded`；`runs/side-effects.json` 同时保留 attempt 1 的 `unknown/needs-user`（`worker-run-restarted`）与 attempt 2 的 failed receipt；这证明失败结果、Evidence、Acceptance、side-effect receipt 和 worktree provenance 被持久化，不证明成功交付。
- GUI 截图和 read-back 证据保存在 `D:/Temp/slimemold-worker-e2e-failure/.slimemold/evidence/gui/` 与同目录持久化文件中；保留 failure worktree，未自动 cleanup。原始 fixture 在修复前的备份仍保留。
- 验证：focused `1 file / 6 tests`；完整 Node `170 test files / 1281 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,185.80 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`git diff --check` 通过。当前代码与本轮 E2E 证据标记 `unverified`，剩余风险是宿主 fixture 的验收故意失败以及尚未执行 skip 分支。

### 7.338 unverified：frontend monolith ownership slices

- 在保持 `types.ts` 兼容导出的前提下，将 React Flow graph contracts（`FlowNode`/`FlowEdge`、port/edge kinds、`WorkflowNodeData`、parameter contracts及连接兼容规则）迁移到 `src/types/graph.ts`；新增 direct owner tests，并将 canvas、subgraph、workflow IO、group proxy、dev nodes和 workflow graph/store 的关键调用改为直接依赖 graph owner。
- 将 `WorkflowState`、`RunState`、`RunProgressShape`、`ProjectSaveGuard` 从 `workflowStore.ts` 移到 `src/store/workflowStoreTypes.ts`；`engine/runtime.ts` 直接导入 state-contract owner，store facade继续提供兼容行为。
- 将 App 中 Worker runtime composition（recovery IO、evidence read-back、worktree restore、run coordinator、transition persistence、recovery/cleanup actions）迁移到 `src/app/workerRuntime.ts`；`App.tsx` 只保留 React 生命周期、operation guard、UI事件和生命周期 controller 接线。`workerWorktreeRestore.ts` 同时成为独立的 worktree restore adapter，并有 direct tests。
- 将 `workflowStore.ts` 的 subgraph mutations 与 group/proxy mutations 分别迁移到 `workflowSubgraphCommands.ts` 和 `workflowGroupCommands.ts`；两个 command owner 通过显式 `getState/setState/pushHistory/addLog` ports 接入 store，group owner 通过显式 focused-subgraph ports 接入 view state，未把 React hook带入 command modules。
- 结构边界仍是增量拆分：`src/types.ts` 保留为兼容 facade，`workflowStore.ts` 仍拥有项目保存/registry/运行态等后续边界，`App.tsx` 仍拥有 UI shell与全局生命周期；本轮未改变 ProjectFile、DomainEvent、WorkerQueue、Evidence/Acceptance/Receipt schema或执行语义。
- 相关本地 checkpoint：`f2932c9` / `checkpoint/frontend-app-worker-restore-adapter-unverified`、`021c7e9` / `checkpoint/workflow-store-state-contract-split-unverified`、`38af19f` / `checkpoint/frontend-graph-types-split-unverified`、`9438254` / `checkpoint/app-worker-runtime-split-unverified`、`f2612dc` / `checkpoint/workflow-subgraph-command-split-unverified`、`54b5fc6` / `checkpoint/workflow-group-command-split-unverified`；均为本地 unverified 回退锚点，未 push。
- 验证：direct/frontend focused slices全部通过；完整 Node `175 test files / 1291 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,187.02 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。当前结构切片标记 `unverified`，尚未做 exact reviewer closure；下一阶段仍需继续收口 `workflowStore` 的 project/persistence/runtime boundaries，并拆分 `types.ts` 的 remaining agent/project/execution contracts。

### 7.339 unverified：extract agent-facing type contracts owner

- 从 `src/types.ts` 抽出 agent/provider/API/Vault、Role、message/tool wire、LLM response/spec 和 cost telemetry contracts 到 `src/types/agent.ts`；保留 `src/types.ts` 的 type-only compatibility re-export，未复制实现或改变公共类型名称。
- `src/agents/*`、provider adapters、Agent/Settings/Master UI 和 Companion 已改为直接依赖 `src/types/agent.ts`；其余非 agent 类型继续通过旧 facade，保持本轮迁移边界有限。
- 新增 `src/types/agent.test.ts`，覆盖 AgentConfig、RoleTemplate、ChatMessage、LLMResponse 和 CostRecord 的 owner contract；类型迁移未改变 ProjectFile、WorkerQueue、DomainEvent、Evidence/Acceptance/Receipt 或运行时行为。
- 结构结果：`src/types.ts` 由 `1075` 行降至 `907` 行，新增 owner `src/types/agent.ts` 为 `198` 行；当前切片仍标记 `unverified`，尚未执行 exact reviewer closure。
- 相关本地 checkpoint：`2751c2a` / `checkpoint/types-agent-contract-split-start`、`3afe5fd` / `checkpoint/types-agent-contract-split-unverified`；均为本地回退锚点，未 push。
- 验证：focused `6 test files / 68 tests`；完整 Node `176 test files / 1292 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,187.02 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.340 unverified：extract orchestration type contracts owner

- 从 `src/types.ts` 抽出 Artifact、Pipeline、Draft、StageLog、Orchestration 等项目级编排契约到 `src/types/orchestration.ts`；保留 `src/types.ts` type-only compatibility re-export，未改变公共名称或持久化结构。
- `engine/pipeline.ts`、`orchestrator/*`、Orchestrator UI、ProjectControl orchestration projection/transition callers 已开始直接依赖 `src/types/orchestration.ts`；`ModuleItem` 等非 orchestration 类型仍保留从 facade 导入，保持切片边界清晰。
- 新增 `src/types/orchestration.test.ts`，覆盖 PipelineDef、Artifact 和 Orchestration contract；本轮未改变 executor、ProjectFile、WorkerQueue、DomainEvent、Evidence/Acceptance/Receipt 运行时行为。
- 结构结果：`src/types.ts` 由 `907` 行降至 `767` 行，新增 owner `src/types/orchestration.ts` 为 `164` 行；当前切片保持 `unverified`，未进行 exact reviewer closure。
- 相关本地 checkpoint：`77ff937` / `checkpoint/types-orchestration-contract-split-start`、`ce9ec8f` / `checkpoint/types-orchestration-contract-split-unverified`；均为本地回退锚点，未 push。
- 验证：focused `5 test files / 60 tests`；完整 Node `177 test files / 1293 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,187.02 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.341 unverified：extract project save controller boundary

- 从 `src/store/workflowStore.ts` 抽出 `src/store/projectSaveController.ts`，由新 owner 负责项目保存队列接入、ProjectFile 写入、pending domain event flush、SaveGuard 检查、`projectDirty` 清除和稳定 `lastSavedSnapshot` 基线更新；保持原有保存 key、错误文本、保存路径和 guard 时序。
- `workflowStore.ts` 保留 facade composition 与 Worker event-stream rehydration 的 `prepareForSave` 注入；控制器不导入 `useWorkflowStore`、`useViewStore` 或 workflow facade，不复制 Worker recovery 事实。
- 新增 direct owner tests，覆盖成功保存、abort fail-closed、项目在 preparation 期间切换时拒绝写入；现有 `workflowStore.projectControl.test.ts`、Save As、dirty/autosave、queue 和 persistence tests 继续作为 facade/邻接边界回归。
- 结构结果：`src/store/workflowStore.ts` 由 `1253` 行降至 `1224` 行，新增 `src/store/projectSaveController.ts` 为 `90` 行；本轮未改变 ProjectFile、DomainEvent、WorkerQueue、Evidence/Acceptance/Receipt schema 或执行语义。
- 相关本地 checkpoint：`57f7939` / `checkpoint/workflow-persistence-boundary-split-start`、`ecae7bb` / `checkpoint/workflow-project-save-controller-split-unverified`；均为本地回退锚点，未 push。
- 验证：focused `9 test files / 28 tests`；完整 Node `178 test files / 1296 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,187.66 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.342 unverified：extract save preparation adapter boundary

- 从 `src/store/workflowStore.ts` 抽出 `src/store/projectSavePreparation.ts`，由新 owner 负责保存前的 Tauri event-stream read、`needs-repair` fail-closed、缺失 WorkerRun projection rehydration，以及 linked orchestration projection 更新。
- `workflowStore.ts` 只保留 `createProjectSavePreparation` 的 composition wiring；`workflowStore` 不再直接持有 `restoreMissingWorkerRunsFromEvents` 或 `projectWorkerRunsOntoOrchestrations` 的保存前控制流。新 adapter 不依赖 `useWorkflowStore` 或 `useViewStore`，读盘入口通过可注入 `readEventStream` 保持 direct tests 可运行。
- 新增 direct tests，覆盖 browser skip、已有 WorkerRun projection skip、缺失 projection 恢复与编排投影、event stream needs-repair 阻断；同时复跑现有 Worker rehydration 与 facade save tests。
- 结构结果：`src/store/workflowStore.ts` 由 `1224` 行降至 `1194` 行，新增 `src/store/projectSavePreparation.ts` 为 `83` 行；本轮未改变 ProjectFile、DomainEvent、WorkerQueue、Evidence/Acceptance/Receipt schema 或执行语义。
- 相关本地 checkpoint：`28c01e2` / `checkpoint/workflow-save-preparation-split-start`、`5c158c6` / `checkpoint/workflow-save-preparation-split-unverified`；均为本地回退锚点，未 push。
- 验证：focused `5 test files / 19 tests`；完整 Node `179 test files / 1300 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,187.87 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.343 unverified：repair save side-effect fencing and workflow-store type compatibility

- 修复 `projectSaveController` 的 stale-I/O window：`projectFilePersistence` 新增可选 `beforeWrite/beforeFlush` hooks，普通 Save 的 Tauri adapters 在 dynamic import 完成、真实写入/flush 开始前重新执行 `ProjectSaveGuard`；项目切换或 abort 不再只在副作用之后才被发现。
- 在 `src/store/workflowStore.ts` 恢复 `ProjectSaveGuard`、`RunProgressShape`、`RunState`、`WorkflowState` 的历史 type-only facade exports，并新增 compatibility test；未复制类型实现。
- 新增 guard regression，模拟 adapter await 期间项目切换，确认实际写入不会发生；保留 ProjectFile persistence 原有无 callback 时的调用形状，避免无关测试/调用方变化。
- 相关本地 checkpoint：`7a5bb46` / `checkpoint/workflow-save-guard-compat-repair-start`、`4109bee` / `checkpoint/workflow-save-guard-compat-repair-unverified`；均为本地回退锚点，未 push。
- 验证：focused `5 test files / 16 tests`；完整 Node `180 test files / 1302 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.12 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.344 unverified：migrate production callers to direct type owners

- 将 Agent/API/LLM/Cost contracts 的生产与测试调用方从兼容 `src/types.ts` 迁移到 `src/types/agent.ts`；将 Artifact/Pipeline/Orchestration/Draft contracts 的调用方迁移到 `src/types/orchestration.ts`。
- 涉及 engine、IO、nodes、orchestrator、plugins、ProjectControl、store 及对应 direct tests；当前静态扫描确认 moved Agent 与 orchestration symbols 从 compatibility `types` path 的残留计数均为 `0`。
- `src/types.ts` 仍保留兼容 re-export，但本轮不再有新/现有内部调用方依赖它承载这两类已迁移事实；未改变运行时、ProjectFile、DomainEvent、WorkerQueue 或 Evidence/Acceptance/Receipt 结构。
- 相关本地 checkpoint：`086c7d7` / `checkpoint/direct-type-owner-import-migration-start`、`54f7ca5` / `checkpoint/direct-type-owner-import-migration-unverified`；均为本地回退锚点，未 push。
- 验证：owner-focused `18 test files / 182 tests`；supplementary sandbox/type-owner `5 test files / 87 tests`；完整 Node `180 test files / 1302 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.12 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.345 unverified：inject registry definitions into workflow command owners

- 为 `workflowSubgraphCommands` 与 `workflowGroupCommands` 增加显式 `getNodeDefinitions` port；子图打包/端口推断、group proxy recompute 不再直接读取 `useRegistryStore` singleton。
- `recomputeProxyPorts` 改为接收明确的 node definition table；`defaultParams` 保留为单独的 registry adapter。`updateGroup` 的 patch 类型收窄为 `Partial<Omit<NodeGroup, 'id'>>`，与 `WorkflowState` facade contract 对齐，禁止通过 command owner 修改 group id。
- 更新 workflow facade wiring、direct command tests 和 group proxy tests；本轮未改变图编辑、子图、分组或持久化运行语义。
- 相关本地 checkpoint：`2dbd778` / `checkpoint/workflow-command-registry-port-split-start`、`b92b795` / `checkpoint/workflow-command-registry-port-split-unverified`；均为本地回退锚点，未 push。
- 验证：focused `6 test files / 29 tests`；完整 Node `180 test files / 1302 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.28 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.346 unverified：stabilize App Worker runtime lifetime

- `App.tsx` 改用 mount-scoped `useRef` 保存 `createAppWorkerRuntime` 结果，避免每次 React render 重新组合 Worker recovery/action/cleanup controllers；Project lifecycle effect 现在消费稳定的 runtime ports。
- 保留 store、operation guard、recovery single-flight 和 controller wiring，不改变 Worker/recovery/cleanup 行为；本轮只收口对象生命周期和 composition 可读性。
- 相关本地 checkpoint：`333b4ac` / `checkpoint/app-runtime-lifetime-seam-start`、`6992e95` / `checkpoint/app-runtime-lifetime-seam-unverified`；均为本地回退锚点，未 push。
- 验证：focused `5 test files / 26 tests`；完整 Node `180 test files / 1302 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.33 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.347 unverified：share save preparation with Save As

- `projectSaveAsController` 新增可选 `prepareForSave` port；Save As 在目录选择完成后、构建 ProjectFile 前复用 Worker event-stream preparation，避免 Save 与 Save As 的恢复前置条件分叉。
- preparation 失败时 Save As fail-closed，记录既有 warning 文案，不构建或写入项目；prepared state 用于后续 ProjectFile 和 active workflow metadata。
- 更新 Save As direct tests、workflowStore Save As integration test 和 shared preparation wiring；未改变普通 Save、ProjectFile schema 或 event semantics。
- 相关本地 checkpoint：`cf09ab8` / `checkpoint/shared-save-preparation-wiring-start`、`5798c14` / `checkpoint/shared-save-preparation-wiring-unverified`；均为本地回退锚点，未 push。
- 验证：focused `4 test files / 17 tests`；完整 Node `180 test files / 1303 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.51 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.348 unverified：extract execution type contracts

- 将 `RunNodeResult`、`RunRecord`、`LogEntry` 从高扇出的 `src/types.ts` 迁移到 `src/types/execution.ts`，该 owner 只依赖 graph status 与 agent cost contracts。
- `src/types.ts` 保留兼容 re-export；engine checkpoint/finalizer/runtime、BeginnerExperience、workflow serialization、store contract 与相关测试改为直接依赖 execution owner。
- 移除旧 barrel 中的重复实现，未改变运行历史、日志、checkpoint、ProjectFile schema 或执行语义。
- 相关本地 checkpoint：`a765171` / `checkpoint/types-execution-contract-split-start`、`19023bc` / `checkpoint/types-execution-contract-split-unverified`；均为本地回退锚点，未 push。
- 验证：focused `5 test files / 43 tests`；完整 Node `181 test files / 1304 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.51 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.349 unverified：extract capability type contract

- 将 `CapabilityLevel` 从 `src/types.ts` 迁移到 `src/types/capability.ts`，为节点权限分级与插件 sandbox RPC 提供独立 owner。
- `engine/executorHelpers`、`nodes/sdk`、plugin loader、sandbox manager/protocol 改为直接依赖 capability owner；`src/types.ts` 保留兼容 re-export，未改变 capability whitelist、节点权限裁剪或插件执行语义。
- 新增 capability contract test；本轮只移动类型事实与 import 边界，没有放宽任何能力等级或宿主拦截规则。
- 相关本地 checkpoint：`5e59bef` / `checkpoint/types-capability-contract-split-unverified`；另保留 `4ea1dcc` / `checkpoint/types-plugin-contract-split-start` 作为插件边界探索锚点；均为本地回退锚点，未 push。
- 验证：focused `6 test files / 47 tests`；完整 Node `182 test files / 1305 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.51 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.350 unverified：extract plugin type contracts

- 将 `PluginOccupation`、`PluginNodeMeta`、`PluginManifest`、`LoadedPlugin` 从 `src/types.ts` 迁移到 `src/types/plugin.ts`，并让 plugin loader 与 registry store 直接依赖该 owner。
- `src/types/plugin.ts` 只依赖 capability 与 graph contracts；`src/types.ts` 保留兼容 re-export，避免继续扩大通用 barrel 的内部扇出。
- 新增 plugin contract test；未改变 manifest 字段、plugin source/scope 取值、loader 校验、registry 生命周期或 sandbox 执行语义。
- 相关本地 checkpoint：`1bf0d99` / `checkpoint/types-plugin-contract-owner-split-start`、`6b8ee89` / `checkpoint/types-plugin-contract-split-unverified`；均为本地回退锚点，未 push。
- 验证：focused `6 test files / 38 tests`；完整 Node `183 test files / 1306 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.51 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.351 unverified：extract workflow run state commands

- 将 `setRunning`、`setRunProgress`、成本日志、运行历史、checkpoint memory/persistence/snapshot/clear/restore actions 从 `workflowStore.ts` 抽到 `src/store/workflowRunStateCommands.ts`。
- 新 owner 只通过显式 `getState`、`setState`、`updateState`、dirty suppression 与 checkpoint persistence ports 工作；facade 仅负责 composition，保留 active workflow 兼容字段同步和 checkpoint 落盘语义。
- 新增 command owner focused tests；`workflowStore.ts` 删除约 96 行 inline run/checkpoint implementation，未改变 Worker executor、恢复、ProjectFile 或运行历史行为。
- 相关本地 checkpoint：`f6a870d` / `checkpoint/workflow-run-state-command-split-start`、`812019c` / `checkpoint/workflow-run-state-command-split-unverified`；均为本地回退锚点，未 push。
- 验证：focused `6 test files / 37 tests`；完整 Node `184 test files / 1308 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.63 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.352 unverified：extract project metadata contracts

- 将 `AssetMeta` 与 `RecentProject` 从 `src/types.ts` 迁移到 `src/types/project.ts`；`io/projectIO.ts` 保留 `RecentProject` type-only re-export，避免旧 UI/import 路径破坏。
- AssetsPanel、engine context/runtime、内置 media/tool nodes、workflow lifecycle/serialization/store contracts 与测试改为直接依赖 project owner；通用 barrel 只保留兼容 re-export，AssetMeta/RecentProject direct root imports 残留为 `0`。
- 新增 project metadata contract test；未改变 ProjectFile/WorkflowFile 字段、资产 scope、最近项目持久化或运行时行为。
- 相关本地 checkpoint：`b1dcb6a` / `checkpoint/types-project-asset-contract-split-start`、`37d9b3b` / `checkpoint/types-project-asset-contract-split-unverified`；均为本地回退锚点，未 push。
- 验证：focused `7 test files / 50 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.63 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npx tsc --noEmit` 通过；`git diff --check` 通过。后续 project-data command slice 在包含本轮代码的最终工作树上完成全量质量门，见 7.353。

### 7.353 unverified：extract workflow project data commands

- 将 workflow/project asset 与 project variable actions 从 `workflowStore.ts` 抽到 `src/store/workflowProjectDataCommands.ts`：`addAsset`、`removeAsset`、`addProjectAsset`、`removeProjectAsset`、`setProjectVariable`、`removeProjectVariable`。
- 新 owner 只依赖显式 state ports、日志 port 和 `removeFile` port；Tauri file deletion 保留在 facade composition 的动态 port 中，保留原有删除顺序、日志文案、依赖 workflow 名称返回值和失败可观察性。
- 新增 direct command tests，覆盖状态变更、project asset dependency discovery 和注入的文件删除 port；`workflowStore.ts` 删除约 103 行 inline project-data implementation，未改变 ProjectFile schema 或资产/变量语义。
- 相关本地 checkpoint：`8135885` / `checkpoint/workflow-project-data-commands-start`、`daa2112` / `checkpoint/workflow-project-data-commands-unverified`；均为本地回退锚点，未 push。
- 验证：focused `7 test files / 29 tests`；完整 Node `186 test files / 1312 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.61 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.354 unverified：extract workflow registry lifecycle commands

- 将 `renameWorkflow` 与 `removeWorkflow` 从 `workflowStore.ts` 接入已有 `workflowRegistryActions.ts` owner，复用 `buildRenameWorkflowState` / `buildRemoveWorkflowState`。
- 清理 AppData workflow 的动态 I/O 改为显式 `cleanupWorkflow` port；registry owner 负责状态/激活编排，facade 负责宿主清理 wiring，保留原有 cleanup 顺序、激活结果和兼容 action 签名。
- 新增 registry owner direct tests，保留原有 switch/new/register 覆盖；`workflowStore.ts` 删除重复 lifecycle implementation，未改变工作流重命名、删除、激活或持久化语义。
- 相关本地 checkpoint：`52ba7a4` / `checkpoint/workflow-registry-lifecycle-command-split-start`、`018fb9c` / `checkpoint/workflow-registry-lifecycle-command-split-unverified`；均为本地回退锚点，未 push。
- 验证：focused `3 test files / 16 tests`；完整 Node `186 test files / 1314 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.70 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.355 unverified：complete direct project and execution owner imports

- 根据 exact-snapshot review 发现的 residual，`BeginnerExperience.tsx` 改为直接从 `src/types/project.ts` 导入 `RecentProject`，不再依赖 `io/projectIO` compatibility seam。
- `workflowLifecycleState.ts` 的 `AssetMeta` 与 `RunRecord` inline compatibility imports 改为直接依赖 `types/project.ts` 与 `types/execution.ts`；当前 direct owner residual scan 为 `0`。
- 未改变 `io/projectIO` 的兼容 re-export、ProjectFile/WorkflowFile schema、运行历史、资产或 lifecycle 行为；这是 topology repair，不是历史 target 的 retroactive verification。
- 相关本地 checkpoint：`8f4f6f4` / `checkpoint/direct-owner-residual-repair-start`、`2035f96` / `checkpoint/direct-owner-residual-repair-unverified`；均为本地回退锚点，未 push。
- 验证：focused `7 test files / 54 tests`；完整 Node `186 test files / 1314 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.70 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.356 exact review closure：verified code anchors

- `checkpoint/direct-owner-residual-repair-unverified` 的 exact target `2035f966adff091c94ff10d9fa58cb5df2b8e255`、parent `8f4f6f4e0f713ac7089f43a0dcf48b3e241230d2` 已完成 object-level review：`passed=true`、`security_concerns=[]`、`logic_errors=[]`、无 credential literals；对应 code tag：`checkpoint/direct-owner-residual-repair-verified`。
- `checkpoint/workflow-registry-lifecycle-command-split-unverified` 的 exact target `018fb9c1e77a33e71965215dcdcaafb153783787`、parent `52ba7a4a2872ebe87606405684fd376ea81aa6e6` 已完成 object-level review：`passed=true`、`security_concerns=[]`、`logic_errors=[]`、无 credential literals；对应 code tag：`checkpoint/workflow-registry-lifecycle-command-split-verified`。
- 两个 verified tag 均指向 reviewer 实际审查的 code commit；本节之后的文档 commit 不继承或改变 verified code HEAD。历史 project metadata target `37d9b3b` 与 execution target `19023bc` 的 fail-closed 结果仍保持 `unverified`，不能被本轮修复追溯升级。
- 这些 reviewer 只提供 exact Git object topology/logic evidence，未运行测试；对应 code commit 的质量门已分别在同一代码快照上完成：完整 Node `186 test files / 1314 tests`；`npm run build` 通过（最大 chunk `1,188.70 kB`）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.357 frontend structure health review：current topology baseline

- 审查锚点：`0d82932c748474d5216bbf713059a1eaa9eec6ad` / `checkpoint/frontend-structure-health-review-start`；本轮只做结构分析和文档记录，未改变生产代码。
- 规模实测：`src` 共 `459` 个 TypeScript/TSX 文件、`1,735` 条可解析的相对 import edge；目录代码行主要集中在 `projectControl` `23,429`、`components` `13,049`、`engine` `11,108`、`store` `8,472`、`domain` `7,585`。
- 主要巨石：`AgentPanel.tsx` `1207` 行、`WorkflowEditor.tsx` `1182` 行、`domain/workerQueue.ts` `1158` 行、`projectControl/commands.ts` `1076` 行、`engine/executor.ts` `1036` 行、`workflowStore.ts` `994` 行、`OrchestratorPanel.tsx` `993` 行；其中 `workflowStore.ts`、`AgentPanel.tsx`、`WorkflowEditor.tsx`、`OrchestratorPanel.tsx` 没有同名直接 test file。
- Fan-in 风险：`src/types.ts` 有 `158` 个静态 fan-in，`workflowStore.ts` `66` 个，`domain/workerQueue.ts` `76` 个；当前精确 root-barrel import 仍有 production `135` 条、test `70` 条，但其中大量是尚未迁移的 Node/ProjectControl/Workflow contracts，不能把所有 root import 都误判为 bug。
- 高风险拓扑：存在 `types.ts ↔ engine/checkpoint.ts` 的 type-only cycle（`ProjectFile.checkpoints` inline imports checkpoint，而 checkpoint 又从 root barrel 读取类型）；executor 相关模块形成约 7 节点 SCC（executor、runContext、runScheduler、runFinalizer、nodeLlmAdapter、agentDecision、agentRouter），另有 cleanup/session/dev 与 experience/harness 小型 SCC。前者应优先通过窄 runtime/context ports 解耦，而不是继续向 facade 添加 action。
- `WorkflowState` 仍是 `317` 行、约 `165` 个 field/action-like 成员的跨域合同，同时覆盖 canvas graph、run/checkpoint、agent/role catalog、project save、workflow registry、ProjectControl、Worker Evidence/Receipt、pipeline/orchestration、history/clipboard；`workflowStore.ts` 虽已抽出多个 command owner，仍是高扇出 composition + inline graph/catalog/config setter 的混合 facade。
- `App.tsx` 已稳定 Worker runtime 生命周期，但仍同时承担 UI shell、项目 session command、插件/全局 Agent 启动扫描、上次项目恢复与 Tauri fs/invoke、ProjectLifecycle controller 接线、全局快捷键、面板 resize 和 JSX layout；它现在更像“应用 composition root + startup coordinator + shell”，下一步应先拆 startup/recovery bootstrap 与 keyboard/resize adapters，不要再把 JSX 和宿主恢复一起移动。
- 可维护性盲区：`App.tsx`、`WorkflowEditor.tsx`、`AgentPanel.tsx`、`OrchestratorPanel.tsx` 缺少同名 direct tests；现有测试更多覆盖下层纯函数、store actions 和 ProjectSession/Beginner paths，不能据此宣称这些大型 UI 的 interaction/React Flow/Tauri behavior 已验证。
- 优先级建议：① 先把 `types.ts` 剩余 contracts 分成 `node/execution`、`workflow/project`、`projectControl` 三个 owner，并保留兼容 re-export；② 再拆 `WorkflowState` 的 worker/project-control projection setters，保持 facade action signatures；③ 将 executor SCC 中的 `runContext`/LLM/finalizer 依赖改成窄 port；④ 最后拆 App startup coordinator 和补大型 UI 的 direct interaction harness。按事实 owner 拆，不以继续降低单文件行数作为完成标准。
- 基线限制：本轮是结构健康度审查，不是 GUI/Tauri E2E、运行时 cycle proof 或安全审计；历史 `unverified`/verified code tags 的语义保持不变。代码未变化，基线质量门仍为完整 Node `186/1314`、build 通过、i18n `1026/1026`、tsc 通过、diff check 通过。

### 7.358 unverified：extract node runtime type contracts

- 将 `ExecContext`、`InterventionRequest`、`InterventionResult`、`SandboxHandle`、`NodeExecuteFn`、`NodeRole`、`NODE_ROLE_META`、`NodeDefinition`、`NodeDefInput` 与 `createNodeDef` 从 `src/types.ts` 迁移到 `src/types/node.ts`，为 engine/nodes/plugins 建立独立 node/runtime owner。
- `src/types.ts` 保留完整 compatibility re-export；engine、nodes、plugins、agents、相关 store/io/component 调用方和测试改为直接依赖 `src/types/node.ts`。本轮 root node-contract residual scan 为 `0`。
- 新增 `src/types/node.test.ts`，覆盖 node definition 默认值、role 推断元数据和 `ExecContext` contract 可用性；只移动类型事实和 import 边界，未改变节点执行、能力裁剪、sandbox、intervention、插件加载或 workflow graph 行为。
- `src/types.ts` 从 `614` 行降至 `396` 行；新增 node owner `160` 行、direct contract test `28` 行。相关本地 checkpoint：`f43e860` / `checkpoint/types-node-runtime-contract-split-start`、`03978cc` / `checkpoint/types-node-runtime-contract-split-unverified`；均为本地回退锚点，未 push。
- 验证：focused `11 test files / 134 tests` 通过；完整 `npm run test` 最终 `187 test files / 1315 tests` 通过。首次全量运行仅 `topoSort.test.ts` 的子进程出现一次环境型 `spawnSync D:\Hermes\node\node.exe ETIMEDOUT`，独立重跑 `17/17` 后再次全量运行通过；不将首次超时误记为代码回归。
- `npm run build` 通过（`tsc -b` 通过，最大 chunk `1,188.70 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.359 unverified：normalize node runtime type imports after exact review

- 对 `03978cc` 的 3 个 exact-snapshot review 中，2 个通过；1 个 fail-closed 发现部分迁移后的 `NodeRole`、`ExecContext`、`NodeDefinition`、intervention contracts 仍使用 value-form imports。当前编译会擦除这些 type imports，但该写法在 import-preserving 转译器下不稳，作为真实 topology/compatibility 缺陷修复。
- 在 `NodePalette`、engine tests、node context adapter test、builtin node、store tests 中统一把纯类型 imports 改为 `import type`；保留 `createNodeDef` 与 `NODE_ROLE_META` 的 runtime imports。最终 `types/node` 扫描确认 `TYPE_ONLY_VALUE_IMPORTS=0`，未改变运行时实现或公开 compatibility re-export。
- reviewer 结论：语义 preservation review `passed=true`；compatibility/topology review `passed=true`；初始 owner review 因 value-form type imports `passed=false`，无 security concerns、无 credential additions。原 target `03978cc` 不升级为 verified；修复后新 code anchor 仍需重新 exact review。
- 相关本地 checkpoint：`9794fa8` / `checkpoint/types-node-runtime-import-normalization-start`、`c729808` / `checkpoint/types-node-runtime-import-normalization-unverified`；均为本地回退锚点，未 push。
- 验证：focused `11 test files / 134 tests`；完整 `npm run test` 为 `187 test files / 1315 tests`；`npm run build` 通过（最大 chunk `1,188.70 kB`，既有 dynamic/static import 与大 chunk warnings 保持）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。

### 7.360 exact review closure：verified node import normalization

- 修复后的 exact target `c729808d3c1521cb130bfeb05df1c81d5c9c85af`、parent `9794fa8858a8d436e3abd9aad6f39109a8ef78f8` 已由 3 个独立 read-only object reviewer 审查，全部 `passed=true`；`security_concerns=[]`、`logic_errors=[]`，无 credential additions，确认 12 个 import-only changes 只规范 type imports，runtime imports 与 owner/re-export topology 保持不变。
- verified tag `checkpoint/types-node-runtime-import-normalization-verified` 已回读并指向 `c729808d3c1521cb130bfeb05df1c81d5c9c85af`。当前分支后续 docs closure commit 不继承为 verified code HEAD；reviewer 未运行测试，质量门仍以同一 code target 的真实验证记录为依据。

### 7.361 unverified：extract workflow file and graph contracts

- 将 `WorkflowFileNode`、`WorkflowFileEdge`、`WorkflowFile`、`WorkflowFileInMemory`、`SubgraphPort`、`SubgraphDef`、`ProxyPort`、`VirtualEdge`、`NodeGroup` 从 `src/types.ts` 迁移到 `src/types/workflow.ts`，形成 workflow persistence/graph contract owner；`ProjectFile` 暂留 root，仅直接引用 workflow owner 类型。
- `src/types.ts` 保留 9 个 workflow contracts 的 compatibility re-export；agents、canvas、engine、io、store 生产代码及相关测试改为直接依赖 `src/types/workflow.ts`，包括 `import('../types').X` inline references；root named/inline residual scan 为 `0`，owner reverse import 为 `false`，每个 moved symbol 只有 1 个 owner definition。
- 新增 `src/types/workflow.test.ts`，覆盖 WorkflowFile、WorkflowFileInMemory、SubgraphDef 和 NodeGroup 的组合 contract。初始纯 type import 会被 Vitest 擦除，补充 side-effect module-resolution assertion 后观察到预期 RED，再创建 owner 变为 GREEN；未改变序列化字段、子图/分组语义或 ProjectFile schema。
- `src/types.ts` 当前约 `239` 行，workflow owner `161` 行；相关本地 checkpoint：`ef942aa` / `checkpoint/types-workflow-file-contract-split-start`、`6d7be9a` / `checkpoint/types-workflow-file-contract-split-unverified`；均为本地回退锚点，未 push。
- 验证：focused `16 test files / 118 tests`；完整 `npm run test` 为 `188 test files / 1316 tests`；`npm run build` 通过（最大 chunk `1,188.70 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`git diff --check` 通过。exact review 尚未完成，当前保持 `unverified`。

### 7.362 exact review closure：verified workflow file contracts

- exact target `6d7be9a1182f9f2ee4fd64e6fd9bedf5086cfdaf`、parent `ef942aa414714f8e0fba2ca4676fb74937fda3d3` 已由 3 个独立 read-only object reviewer 审查，全部 `passed=true`；`security_concerns=[]`、`logic_errors=[]`，无 credential additions。
- reviewer 确认 9 个 workflow/subgraph/group contracts 各只有一个 owner，root named/inline residual 为 `0`，无 reverse owner import、malformed import 或 duplicate declaration；WorkflowFile 与 ProjectFile schema 保持不变。reviewer 未运行测试，质量门来自同一 code target。
- verified tag `checkpoint/types-workflow-file-contract-split-verified` 已回读并指向 `6d7be9a1182f9f2ee4fd64e6fd9bedf5086cfdaf`；当前分支后续 docs closure commit 不继承为 verified code HEAD。

### 7.363 unverified：complete module topology closure slices

- 连续完成剩余 type-owner 与 facade topology slices：新增 `src/types/projectFile.ts`、`src/types/dispatch.ts`、`src/types/conflict.ts`；`src/types.ts` 保留 compatibility re-export，`ProjectFile` schema 与 checkpoint/worker queue type boundary 未改变。
- `workflowStore.ts` 的 Worker/ProjectControl projection setters 与 Agent/Role/global-agent catalog actions 分别迁移到 `workflowProjectionCommands.ts`、`workflowCatalogCommands.ts`；随后将 `WorkflowCatalogState`、`WorkflowProjectionState` 提升为独立 field owners，`WorkflowState` 通过 interface inheritance 保留完整 action/state surface。`workflowStore.ts` 当前为 `904` 行，`WorkflowState` contract 为 `333` 行。
- executor 只为共享 run contract 的反向 type edge 新增 `engine/runTypes.ts`，`runContext.ts → executor.ts` 依赖消失；App 的 project startup restore、global shortcuts、panel resize 分别迁移到 `src/app/projectStartup.ts`、`globalShortcuts.ts`、`panelResize.ts`，React shell 只保留 composition ports。
- 将 32 个 production caller 的 graph imports 直接归属 `src/types/graph.ts`；静态扫描确认 production `src/types.ts` importer 为 `0`，非 graph inline contracts 已保持在其真实 owners。
- 将 `HarnessEvents` 提升到 `agents/harnessTypes.ts`，将 `AcceptanceRecord`、`AcceptancePersistence`、`CleanupApproval` 提升到 `dev/sessionContracts.ts`；`experienceSink` 与 `workerCleanup` 不再反向依赖 harness/session implementation。注释剥离后的 production graph 实测 `286` 个文件、`1274` 条 relative edges、`0` 个 multi-node SCC。
- 相关 code targets 与本地 unverified anchors：`085317c` / `checkpoint/types-project-file-control-contracts-unverified`、`a08d89f` / `checkpoint/workflow-projection-command-split-unverified`、`493c9b7` / `checkpoint/executor-context-port-split-unverified`、`4b0d4d5` / `checkpoint/app-startup-bootstrap-split-unverified`、`63828f0` / `checkpoint/app-global-shortcuts-split-unverified`、`32e1272` / `checkpoint/app-panel-resize-split-unverified`、`a77d970` / `checkpoint/workflow-catalog-command-split-unverified`、`8ea96a6` / `checkpoint/types-graph-direct-owner-normalization-unverified`、`2eabc74` / `checkpoint/shared-runtime-contract-cycle-split-unverified`、`ae5b88f` / `checkpoint/workflow-state-projection-contract-split-unverified`；均为本地回退锚点，未 push。
- 分阶段真实验证：project/control `191 test files / 1319 tests`；projection `192/1321`；run contract `193/1322`；startup `194/1324`；shortcuts `195/1326`；resize `196/1327`；catalog/graph `197/1329`；shared contracts `199/1331`；最终 state-owner target `201 test files / 1333 tests`。最终 target 的 `npm run build` 通过，最大 chunk `1,190.18 kB`，保留既有 dynamic/static import 与大 chunk warnings；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 与 `git diff --check` 通过。
- 当前所有上述新 anchors 保持 `unverified`，exact reviewer closure 尚未追加；reviewer 不运行测试，不能用本段质量门替代 object-level review。未改变 Worker/recovery、ProjectFile、DomainEvent、Evidence/Acceptance/Receipt、Tauri 或 workflow persistence schema；未新增或保留 credential values。

### 7.364 exact review closure：verified WorkflowState projection owners

- exact target `ae5b88fb2c081054630d8bc450a7530c88544020`、parent `b665bb1fbe515cdaa0a8a7298631ecb7db51b38a` 已由 read-only object reviewer 审查并返回 `passed=true`；`security_concerns=[]`、`logic_errors=[]`、`suggestions=[]`、`working_tree_clean=true`。
- reviewer 确认 catalog/projection fields 各自只有一个 owner，`WorkflowState` 保持合并后的公开 shape，route cleanup 使用预期的 catalog/projection command-state intersection，owner modules 无 reverse facade import，diff 无 runtime behavior change。
- verified tag `checkpoint/workflow-state-projection-contract-split-verified` 已创建并回读，指向 exact code target `ae5b88f`；后续 docs-only commit 不继承为 verified code HEAD。reviewer 未运行测试。
- 同一 code target 的真实质量门：完整 `201 test files / 1333 tests`；`npm run build` 通过，最大 chunk `1,190.18 kB`；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 与 `git diff --check` 通过。

### 7.365 exact review closure：module topology verified anchors

- clean fixed-object review 已闭合并创建 verified tags：
  - `checkpoint/types-project-file-control-contracts-verified` → `085317c`；
  - `checkpoint/workflow-projection-command-split-verified` → `a08d89f`；
  - `checkpoint/workflow-state-projection-contract-split-verified` → `ae5b88f`；
  - `checkpoint/executor-context-port-compat-test-verified` → `acf7751`；
  - `checkpoint/app-startup-bootstrap-split-verified` → `4b0d4d5`；
  - `checkpoint/app-global-shortcuts-split-verified` → `63828f0`；
  - `checkpoint/workflow-catalog-command-split-verified` → `a77d970`；
  - `checkpoint/shared-runtime-contract-cycle-split-verified` → `2eabc74`；
  - `checkpoint/direct-agent-owner-residual-repair-verified` → `9638006`；
  - `checkpoint/app-panel-resize-final-verified` → `9e1fae6`。
- 每个 verified tag 均指向 reviewer 实际审查的 code object；后续 docs-only commits 不继承为 verified code HEAD。reviewers 只执行 Git object review，不运行测试；测试/build/i18n/tsc/diff evidence 来自对应 code target 或其明确记录。
- `checkpoint/types-graph-direct-owner-normalization-unverified` → `8ea96a6` 保持 unverified：exact review 发现当时 `openai.ts` 仍有 `import('../../types').ToolCall` residual。该 residual 已由 `9638006` 单独修复并 verified，但原 graph normalization target 不追溯升级。
- panel resize 的后续 repair anchors `fbdccc7`、`2b20e26`、`955c642`、`5f5b5f0`、`9e1fae6` 中，只有最终 clean exact-approved target `9e1fae6` 被 verified；此前 target 的 dirty/logic fail-closed verdict 保持原状。
- 最终已验证的拓扑事实：production direct importers of `src/types.ts` 为 `0`；注释剥离后的 production relative graph 实测为 `288` files / `1289` edges / `0` multi-node SCC；`workflowStore.ts` `904` 行，`WorkflowState` contract `333` 行，catalog/projection fields 各有独立 owner；App startup/shortcut/resize、executor run contract、shared runtime contracts均通过窄 ports或shared owner收口。
- 最终代码质量门（最终 panel target）：完整 `201 test files / 1339 tests`；`npm run build` 通过，最大 chunk `1,191.19 kB`，保留既有 dynamic/static import 与大 chunk warnings；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit` 与 `git diff --check` 通过。未改变 Worker/recovery、ProjectFile、DomainEvent、Evidence/Acceptance/Receipt、Tauri 或 workflow persistence schema；未保留 credential values。

### 7.366 exact review closure：AgentPanel direct harness

- 新增 `src/components/AgentPanel.test.tsx`，覆盖三条最小 vertical paths：真实 Zustand catalog action 的 Agent 字段编辑与 DOM read-back；deferred Ollama model pull 的 loading、base URL 参数、失败提示与 loading cleanup；embedded/sidebar 根节点、modal overlay 边界与编辑 drawer 结构。
- 测试 fixture 使用真实 `useWorkflowStore`，通过 `closeProject` 的 dirty suppression/lifecycle cleanup、完整安全 state replacement、`projectDirty` 二次 baseline reset、`slime-mold-workflow`/`sm.lastSession` 清理和 fake-timer teardown 隔离测试；不调用真实网络、Tauri、Codex OAuth 或 credential store，不保存 credential values。
- exact target `5a9e6363d0ebe620d51d8459184211518a99af84`、parent `9e99a4dff183c083ffe293fa681e5c15412d10a7` 已由 3 个独立 read-only object reviewers 审查，全部 `passed=true`；`security_concerns=[]`、`logic_errors=[]`、`working_tree_clean=true`。reviewers 未运行测试，质量门来自同一 code target。
- verified tag `checkpoint/agent-panel-direct-harness-verified` 已创建并回读，明确指向 `5a9e636`；后续 docs-only closure commit 不继承为 verified code HEAD。此前 `dd653bb`、`bc778f9`、`9e99a4d` 等 repair anchors 保持原 unverified 状态，不追溯升级。
- 同一 code target 的真实质量门：focused `3 tests passed`；完整 `202 test files / 1342 tests`；`npm run build` 通过，最大 chunk `1,191.19 kB`，保留既有 dynamic/static import 与大 chunk warnings；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit` 与 `git diff --check` 通过。
- 本轮只建立 direct-test evidence，没有声称 `AgentPanel` 已完成模块拆分；下一刀仍按已确认顺序进入纯 agent pool/scope projection owner，再处理 credential/protocol leaf 与 list/editor panes。

### 7.367 partial-fail：formal Tauri Worker E2E acceptance and restart boundary

- 在仓库外 disposable fixture `D:/Temp/sm-tauri-acceptance-20260922-v2` 与独立 Worker 根 `D:/Temp/sm-tauri-acceptance-20260922-v2-workers` 通过真实 Tauri GUI 完成 WorkerQueue 验收；同一 `runId/taskId/taskExecutionId` 产生 4 个 `TaskFailed`/`Acceptance.passed=false` retry attempt，attempt-5 产生 `TaskSucceeded`、`RunSucceeded`、4 条 passed Host Evidence、`Acceptance.passed=true` 和真实 `docs/WORKER_E2E_OK.txt` read-back。
- ProjectFile、47 行 events JSONL、20 行 host Evidence、5 行 Acceptance JSONL、Git worktree list/status 与 fresh GUI capture 已逐层核对；成功 worktree 和 4 个历史失败 worktree 均保留。v2 早期 clean baseline 曾因 GUI 操作和模板 events 复制被消耗，报告明确将前 12 行 setup facts 排除在 Worker runtime chain 外。
- 真实关闭、Tauri 重启和再次 GUI 打开确认 ProjectFile/UI success projection 可恢复；但 fresh GUI 底部日志记录 `Worker worktree 未能从 git 恢复登记：task-create-worker-marker`。native `dev_restore_worktree` 当前要求新 host generation 已有 trusted target registration，restart live worktree recovery 因此 fail-closed；不能把 ProjectFile/UI 恢复写成完整 Worker recovery。
- 因 restart host registration 未闭合，本轮没有生成 cleanup proposal、没有用户批准、没有 `CleanupReceipt`/`TaskCleaned`，没有删除任何 worktree；durable recovery decision CAS 仍处于 design gate。完整报告：`docs/verification/TAURI_WORKER_E2E_REPORT_20260922.md`。
- Windows/host 修复已固化为本地 checkpoint `e84492635cee9d2b6e332c0939d396b95e188427`，tag 为 `checkpoint/tauri-worker-e2e-evidence-repair-20260922`，未 push/merge。修复包含 `.cmd` 空格路径 launcher regression、WebView 无 Node `process` 时的 Windows detection、host diff 错误保留。
- 验证：focused Vitest `2 files / 29 tests`；完整 `npm run test -- --reporter=dot` 为 `202 test files / 1344 tests`；`cargo fmt --manifest-path src-tauri/Cargo.toml --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml dev_exec -- --nocapture` 为 `33 passed / 0 failed / 70 filtered`；`npm run build`、`npm run i18n:check`（`1026/1026`）、`npx tsc --noEmit`、`git diff --check` 均通过。构建保留既有 dynamic/static import 与大 chunk warnings；本轮完整 formal acceptance 仍为 partial-fail，exact reviewer 尚未闭合。

### 7.368 fix：修复 Ubuntu CI 暴露的跨平台 Worker 路径规范化

- PR #1 的 GitHub CI run `35771226554` 在 Ubuntu 上真实失败：`202` 个测试文件中 `198` 个通过、`5` 个失败、`1339/1344` 个测试通过。失败集中在 `evidencePathFor`、`WorktreeManager`、`DevSession` restore 和结构化 patch parent directory；不是把红灯归类为环境噪声。
- 根因是 Node `path.resolve` 在 POSIX runner 上会把 `C:/...`、`D:/...` 当作相对路径，导致 Windows 路径被拼到 runner checkout 目录；同时 `pathComparisonKey` 在 Windows 主机上未把 native 反斜杠转换为统一分隔符，破坏 worktree scope/overlap 比较。
- `src/dev/path-utils.ts` 现在对 Windows drive/UNC 路径使用纯前端 `resolveWeb`，对 native resolve 结果统一转换 `/`；新增 `src/dev/path-utils.test.ts` 覆盖 Windows absolute path、大小写不敏感比较和 overlap。`src/nodes/dev/index.test.ts` 的 fake host 注入 `mkdir`，避免测试尝试向 `/repo-workers` 写入真实目录。
- 验证：focused Vitest `5 files / 70 tests`；完整 `npm run test -- --reporter=dot` 为 `203 test files / 1346 tests`；`npm run build` 通过；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 与 `git diff --check` 通过；`cargo fmt --manifest-path src-tauri/Cargo.toml --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml dev_exec -- --nocapture` 为 `33 passed / 0 failed / 70 filtered`。
- 本轮只修复 CI 暴露的路径与测试隔离问题，不改变 formal Tauri Worker E2E 结论；restart live worktree recovery、Cleanup/`CleanupReceipt`/`TaskCleaned` 和 durable recovery CAS 仍未闭合，不能写成 formal acceptance passed。

### 7.369 unverified：Worker restart identity、Cleanup receipt/read-back 与 durable recovery decision admission

- restart recovery 现在由 native host 产生并返回 durable target identity，贯穿 `WorktreeInfo`、Worker assignment、ProjectFile/rehydration projection、recovery facts/fingerprint，以及 Tauri register/restore；新增 Rust 回归覆盖 host registry reset 后使用 durable identity 恢复 live worktree。该切片仍未经过真实 Tauri GUI restart read-back。
- Cleanup approval/fingerprint 绑定 target identity，host confirm gate 在路径被替换或 identity 漂移时 fail-closed；Cleanup `TaskCleaned` event id 改为由 task execution/attempt lineage 确定性生成，成功路径在保存后重新读取 event stream 与 ProjectFile，核对 `TaskCleaned` payload、CleanupReceipt 引用和最终 task projection。已有 side-effect journal 继续负责 `CleanupReceipt` 的 claim、read-back、unknown 和幂等重放。
- 新增 `WorkerRecoveryDecisionPersistence` owner，使用项目内 durable lock 和 atomic JSON read-back 保存 admitted/committed decision；覆盖 stale facts fingerprint、同一 request identity 的 replay/resume、同一 facts/action 的第二 request conflict、action/facts 改变 conflict、malformed journal needs-repair，以及 controller admission → projection/save → durable commit → retry 顺序。reason 保留为审计 metadata，不进入默认 semantic request identity。
- 新增 recovery controller CAS integration test、decision persistence tests、target identity cleanup regression 和确定性 `TaskCleaned` decision-id test；没有把 ProjectFile/UI projection、process-local single-flight 或 targeted tests写成正式 Worker E2E 通过。
- 验证：focused recovery/Cleanup/CAS `9 test files / 54 tests`；完整 `npm run test` 为 `205 test files / 1357 tests`；`npm run build` 通过（`tsc -b` 通过，最大 chunk `1,229.10 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 `104 passed / 0 failed`；`git diff --check` 与 `git diff --cached --check` 通过。首次 build 发现并修复新增的 unused helper `sameCandidate`，修复后 build 通过。
- 当前边界：真实 Tauri GUI restart/cleanup read-back、双 controller/跨进程竞争、crash matrix、正式 Host Evidence/Acceptance 仍未执行；exact reviewer 因修复 build error 后 snapshot 失效，新的 exact review 尚未完成；本轮保持 `unverified / partial-fail / not closed`，未 push。

### 7.370 unverified：修复 durable recovery replay、projection repair 与 candidate fail-closed validation

- exact staged review 对前一版 snapshot fail-closed，指出三类真实边界：controller 在 durable admission 前重新根据已变化的 run facts 计算 fingerprint，导致同一 request replay 被误判 conflict；committed decision 未验证 candidate projection 是否存在，可能把缺失 projection 或 retry dispatch failure 当成 no-op；candidate 只做浅层字段检查，malformed state/event/lineage 可被 journal 接受。
- 修复后 controller 先读取 durable request record，再以持久化 candidate 作为 replay/resume 来源；committed candidate 缺失时恢复 projection，已完成 retry dispatch 的 exact replay 不重复启动 Worker；retry 的 post-commit 状态持久化为 `pending`/`failed`/`completed`，dispatch failure 可在同一 request replay 中重试。ProjectFile 保存返回后重新 read-back candidate state，发现漂移则以 `needs-repair` fail-closed，不提交 committed 状态。
- `WorkerRecoveryDecisionPersistence` 现在校验 candidate 的 project/run/task graph/version/status/timestamps、task key 与 execution/attempt lineage、worktree/cleanup 字段、event stream/aggregate/source/decision identity、event sequence/aggregate version 连续性，以及 admitted/committed/post-commit 状态组合；不可信 journal 解析失败时保持 `needs-repair`。
- 新增/扩展 controller CAS 回归：同一 request 在 state projection 变化后 replay、committed projection 缺失后的 repair、retry dispatch failure 后 replay retry、保存期间 candidate drift；新增 persistence 回归：committed candidate 缺失、post-commit durable read-back、非法 run state journal rejection。
- 验证：focused recovery/CAS `11 test files / 114 tests`；完整 `npm run test` 为 `205 test files / 1360 tests`；`npm run build` 通过（最大 chunk `1,238.19 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 `104 passed / 0 failed`；`git diff --check` 通过。
- 当前边界：真实 Tauri GUI restart/cleanup read-back、双 controller/跨进程竞争、crash matrix、正式 Host Evidence/Acceptance 仍未执行；本轮修复尚未完成新的 exact staged-snapshot review，保持 `unverified / partial-fail / not closed`，未 push。

### 7.371 unverified：补强跨投影 recovery lock 与 CleanupReceipt host read-back

- 在 7.370 的 candidate/replay 修复之上，`WorkerRecoveryDecisionPersistence.withDecisionLock` 现在可由 controller 包住 admission、ProjectFile/event projection save、candidate read-back 与 durable commit；同一 project-local lock 仍不是跨文件原子事务，不能替代 Gate D 的 crash/cross-process 证据。
- retry post-commit 增加 `dispatching` 状态和受限状态迁移：只有 `pending → dispatching → completed/failed`，失败后才允许 `failed → pending`；未知或重复状态不自动重新触发 Worker，避免 dispatch 已产生副作用但 completed marker 未落盘时无条件重复执行。
- `CleanupReceipt` 现在是显式的 receipt contract，绑定 worktree path/id、target identity、branch、branch revision、base revision、host verification time 和 `finalStatus=absent`。Cleanup host gate 成功后必须调用 host-owned read-back；若 worktree 仍存在或状态不是 absent，则写入 `unknown/needs-user`，不产生成功 receipt。
- `markWorkerTaskCleaned` 同时校验 CleanupReceipt 与当前 Task 的 execution/attempt、worktree、target identity、branch/revision/base revision 和 state signature；`TaskCleaned` 只能在 receipt/read-back 证据一致时写入。
- 新增 retained-worktree read-back RED→GREEN 回归、CleanupReceipt parser rejection 回归，并更新 legacy cleanup receipt migration fixture；focused recovery/Cleanup/CAS/side-effect `10 test files / 76 tests`，完整 `npm run test` 为 `205 test files / 1365 tests`。
- 最终质量门：`npm run build` 通过（`2098 modules transformed`，最大 JS chunk `1,248.36 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit` 通过；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 `104 passed / 0 failed`；`git diff --check` 通过。
- 当前边界仍未改变：正式 Tauri GUI restart/cleanup read-back、真实 Host Evidence/Acceptance、双 controller/跨进程竞争、crash matrix、Node/Rust decision-contract parity vectors 和新的 exact-HEAD reviewer 尚未完成；本轮保持 `unverified / partial-fail / not closed`，未 push。

### 7.372 unverified：修复 exact review 暴露的 recovery transition 与 native CleanupReceipt 边界

- exact-HEAD reviewer 针对 `40f7952d50e53d32effa96cf559476a88adad14e` fail-closed，指出 recovery event read-back 未忽略 event-buffer rebasing 的 `aggregateVersion`、durable candidate task set 未绑定当前可信 TaskGraph、recovery event 未经过完整 domain reducer replay，以及 legacy cleanup receipt startup reconciliation 只查 canonical key；同时指出 native cleanup read-back 结果在 Node boundary 被丢弃。
- controller 现在在 durable admission/replay 前要求 candidate task IDs 与当前 TaskGraph 完整等价、task definition version一致，并通过 `restoreWorkerRunQueue`；保存后对真实 event stream执行 `replayDomainEvents`。Project event semantic comparison 同时忽略由持久化层重写的 `sequence` 与 `aggregateVersion`，但保留其余 event identity/payload 比较。
- recovery persistence 增加 `WorkerRunRecoveryDecided.payload.decision` 与 action 一致性、mutating decision 必须以 recovery event 开始，以及 retry/skip event-type fencing；新增 pre-existing aggregate history、trusted TaskGraph drift 和 mismatched decision payload 回归。
- native `dev_cleanup_worktree` 现在返回 camelCase `DevCleanupReadback`；Tauri Git runner、WorktreeManager 与 Cleanup action boundary 保留并核对 path/branch/branchRevision/targetIdentity/finalStatus，成功 CleanupReceipt 只有在 native facts 与 proposal 一致时才可落盘。Node/headless fallback 仍使用既有 host read-back测试路径。
- startup cleanup reconciliation 同时处理 canonical 与 legacy cleanup key；带完整 CleanupReceipt 的 legacy 成功记录按 canonical lineage 投影为 `TaskCleaned`，缺少新 cleanup facts 的旧成功 receipt 不自动清理，改标记为 `cleanup-unknown`/人工修复边界。
- 真实 Tauri GUI restart/cleanup read-back、双 controller/跨进程竞争、crash matrix、formal Host Evidence/Acceptance 和新的 exact-HEAD review 仍未完成；本轮不升级 formal 结论，保持 `unverified / partial-fail / not closed`。
- 验证：focused recovery/Cleanup/native suite `3 files / 24 tests`；完整 `npm run test` 为 `205 test files / 1372 tests`；`npm run build` 通过（`2098 modules transformed`，最大 JS chunk `1,251.53 kB`，既有 dynamic/static import 与大 chunk warnings 保持）；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit` 通过；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 `104 passed / 0 failed`；`git diff --check` 通过。

### 7.373 unverified：收紧 Cleanup/native ordering、receipt provenance 与 recovery post-commit fence

- `matchesCompletedCleanupReceipt` 与 recovery facts source 现在必须保留并验证完整 nested `CleanupReceipt.cleanup`，包括 native `hostReadback`、authority、path、branch、branch revision、target identity、final status 和 receipt lineage；已有成功 receipt 若缺少 native read-back 不再被当作可重放成功。nested cleanup facts 进入 durable recovery fingerprint，canonical/legacy collision 继续 fail-closed。
- recovery candidate replay comparison 扩展到 reducer 相关的 evidence、acceptance、feedback、cleanup receipt、error，以及 current attempt 的 worktree id/path/branch/base revision/target identity/provenance；可信 `RunCreated` 必须同时匹配 `Run` aggregate、aggregate id、payload run id 和 approved TaskGraph provenance。
- durable recovery event validation 增加 `TaskQueued.nextAttempt`/`recoveryDecisionId`、unknown attempt lineage、failed attempt/error、blocked reason/dependency payload 的必填语义，避免 malformed candidate 在 admission 前进入 journal；post-commit dispatch 在 decision lock 释放后重新校验 project id/path、TaskGraph 和完整 candidate projection，same-project state mutation 也会进入 `needs-repair`，不再直接启动 Worker。
- native `dev_cleanup_worktree` 调整为先 remove worktree、确认 target/listing absent，再按 expected branch revision 执行 branch CAS；remove 失败时 branch 保持可修复。branch CAS 失败且 target 已安全消失时，native state 尝试保留带当前 branch revision 的 branch-only orphan lineage，禁止伪造成功 read-back/receipt。
- 新增 Rust cleanup mutation-order regressions；扩展 recovery decision/CleanupReceipt/candidate/post-commit focused coverage。未把这些 seam tests、headless quality gates 或历史 GUI 结果写成正式 Worker E2E 通过。
- 相关起始锚点：`023797c` / `checkpoint/worker-recovery-second-review-repair-start-20260923`；本轮尚未形成新的 exact-reviewed checkpoint，未 push。
- 验证：focused recovery/Cleanup/native suite `5 test files / 46 tests`；完整 `npm run test -- --reporter=dot` 为 `205 test files / 1378 tests`；`npm run build` 通过（`2098 modules transformed`，最大 JS chunk `1,265.79 kB`，既有 dynamic/static import 与大 chunk warnings 保持）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 `106 passed / 0 failed`；`git diff --check` 通过。
- 当前边界：真实 Tauri GUI restart/live worktree registration 与 CleanupReceipt/TaskCleaned/native deletion-or-retention read-back、双 controller/跨进程竞争、ProjectFile/event/journal crash matrix、产品可达的 `dispatching` manual-repair flow 和新的 exact-HEAD reviewer 仍未完成；正式状态保持 `unverified / partial-fail / not closed`。

### 7.374 unverified：补齐 native stable identity admission 与 restart rebind regression

- 第三轮 repair 起点为 `6b8ab02` / `checkpoint/worker-recovery-third-review-repair-start-20260923`。本轮继续收紧 recovery event/candidate/projection 语义校验、post-commit Worker dispatch fence、nested CleanupReceipt fingerprint/native read-back、native branch-only orphan 的跨进程锁与 base identity 检查，并修复 `workerRuntime` 对 `projectControl.taskGraphs` 和 queue state 的实际 assembly wiring。
- 根因回归已被最小化为 Tauri `DevSession.manager.create`：native `dev_register_worktree` 若没有返回稳定 target identity，旧路径仍会把 Git worktree 当作可用 Worker lease 返回；该 lease 无法在 host restart 后建立可信 live registration。现在 Tauri create 对缺少 identity fail-closed，先 best-effort 清除 native registration，再复用既有 Git rollback；只有带 stable identity 的 lease 才能进入 WorkerQueue/ProjectFile。
- RED→GREEN 证据：临时移除 admission guard 后，`fails closed when native worktree registration omits the stable target identity` 明确失败为“promise resolved … instead of rejecting”；恢复 guard 后该测试通过。同时新增 restart regression，验证 host generation 从 `1` 到 `2` 后仍用 durable `targetIdentity` 调用 `dev_restore_worktree`，并保留 `created` worktree projection。当前 Tauri session focused 为 `12/12`，其中 identity omission 与 restart rebind 均通过。
- 本轮没有把 mock invoke、headless recovery、历史 GUI 日志或 UI success projection 写成正式 restart acceptance；真实 Tauri GUI 关闭/重启/重新打开、native read-back、跨进程竞争与 crash matrix 仍需单独证据。
- 验证：recovery/CAS/Cleanup focused `6 test files / 57 tests`；完整 Node `205 test files / 1385 tests`；`npm run build` 通过（`2098 modules transformed`，最大 JS chunk `1,272.30 kB`，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 `106 passed / 0 failed`，Rust doc-tests `0`；`git diff --check` 通过。
- 当前边界：第三轮修改尚未形成新的 exact-HEAD independent review，真实 Tauri GUI restart/live registration 与 CleanupReceipt/TaskCleaned/native deletion-or-retention read-back 仍未闭合；正式状态保持 `unverified / partial-fail / not closed`，未 push。

### 7.375 unverified：修复第四轮 exact review 的 recovery admission、provenance、cleanup identity 与 allocation fence

- exact review 针对 `d0ff68e413e20a8a542f97990bae9d252b676812`、parent `6b8ab024b5adce8f70880dbc4b8ec69930a5dea2`、clean tree 返回 `passed=false`。blocking findings 为：candidate reducer replay 发生在 journal admission 之后；`TaskBlocked.blockedBy=[]` 可进入 durable candidate；`RunCreated` provenance 要求与 `approvePlanAndEnqueueRun` 产出的 payload 不一致；post-lock fence 仍可能在 worktree allocation 后才拒绝；identity-less native CleanupReceipt 可因 path/branch/revision 相等而被信任。
- recovery admission 现在把 controller 的 event-stream replay/projection validation 注入 durable persistence 的 pre-write hook；只有 candidate 通过 trusted TaskGraph、reducer replay 或已落盘 event projection read-back 后才写 admitted journal。ProjectFile/event/save 后发生漂移时，staged decision 会写入 durable `repairReason`/`repairObservedAt` marker，后续 admission/commit/post-commit 自动 fail-closed，不把部分写入伪装成 committed。
- `TaskBlocked` 至少需要一个 blocker；controller 进一步要求 blocker 属于当前可信 TaskGraph 的真实 dependency。`findTrustedRunCreatedEvent` 现在验证 source object 与 TaskGraph id/version 一致；`approvePlanAndEnqueueRun` 补齐 canonical taskIds、correlationId 和 source provenance，修复真实生产 helper 与 recovery admission contract 的不一致。
- Worker allocation 增加 allocation 前/后的 dispatch fence；若 allocation 后 state/project fence 失效，allocator 通过 host cleanup release 已创建 worktree，再将该 claim 记录为可回放失败，避免 stale dispatch 留下无登记 orphan。Cleanup execution、TaskCleaned projection 与 startup reconciliation 对 identity-less receipt 统一降级为 unknown/manual-repair，不能仅凭 path/branch/revision 提升为成功。
- 新增 persistence semantic pre-write、repair marker、empty blocker、RunCreated provenance、allocation rollback、identity-less cleanup receipt regressions；未把这些 focused tests 或 headless quality gates写成正式 GUI E2E 通过。
- 验证：focused recovery/Cleanup/domain suite `6 test files / 106 tests`；完整 Node `205 test files / 1390 tests`；`npm run build` 通过（`2098 modules transformed`，最大 JS chunk `1,275.36 kB`，既有 dynamic/static import 与大 chunk warnings 保持）；`npm run i18n:check` `1026/1026`；`npx tsc --noEmit` 通过；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；`cargo test --manifest-path src-tauri/Cargo.toml` 为 `106 passed / 0 failed`，Rust doc-tests `0`；`git diff --check` 通过。
- 当前边界：本轮修复尚未形成新的 exact-HEAD independent review；真实 Tauri GUI restart/live registration、CleanupReceipt/TaskCleaned/native deletion-or-retention read-back、双 controller/跨进程竞争与 ProjectFile/event/journal crash matrix 仍未完成。正式状态保持 `unverified / partial-fail / not closed`。

### 7.376 unverified：收窄 recovery replay projection 到 reducer-owned fields

- 为遵守最小充分 lineage，`workerActionController` 的 durable candidate/replay 比较仅保留 reducer projection 实际拥有的字段；移除对 task projection 中不存在的 `worktreeId/path`、branch/status/revision、cleanup signature 等字段比较，不扩张 reducer schema，也不把 native authority 字段复制进每层 lineage。
- 验证：focused recovery/CAS/domain suites 已通过；完整 Vitest 为 `205 test files`、`1396 passed / 1 failed`，唯一失败为 `src/dev/worktree.test.ts` 的真实 `createNodeGitRunner` 检查，Node runner 返回 `拒绝执行未绑定的 Windows 程序：git`；失败原因尚未进一步定位，不按环境噪声豁免。`npm run build` 通过（保留既有动态/静态 import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 与 `git diff --check` 通过；`cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` 通过；Rust `cargo test` 为 `106 passed / 0 failed`。
- 本轮不将 headless 质量门写成真实恢复验收：GUI restart/cleanup read-back、跨进程竞争、crash matrix 和 exact-HEAD independent review 尚未闭合，正式状态继续保持 `unverified / partial-fail / not closed`；未 push。

### 7.377 unverified：将 ambiguous recovery dispatch 保持在 repair fence

- Worker recovery dispatch 失败后不再把 durable `postCommitStatus` 改写为 `failed`；保持 `dispatching` 表示外部副作用结果未知，`recoverWorkerRun` 与 retry continuation 在未修复前返回 `needs-repair`，避免把可能已启动的 Worker 盲目重发。现有回归覆盖状态保留与拒绝自动重试；operator repair 仍只在测试模型中模拟，尚无产品可达的 inspect/repair 流程。
- `workerActionController.cas.test.ts` 的 strict TypeScript 错误修复为显式构造 `RunCreated` payload（其基础 DomainEvent payload 类型为 `unknown`），并删除转为直接检查 journal 后不再使用的 `durableInput` fixture。
- 验证：focused dispatch/CAS 测试通过；`npm run build` 通过；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 通过；Rust `cargo fmt --check` 通过，`cargo test` 为 `106 passed / 0 failed`，doc-tests `0`；`git diff --check` 通过（仅有 CRLF 转换提示）。完整 Vitest 在配置 `NODE_OPTIONS=--localstorage-file=...` 后为 `205 test files`、`1400 passed / 1 failed`；唯一失败为 `src/dev/node-run.test.ts` 的 Windows npm shim 检查，`runCommand('npm')` 返回 `-1`。read-back 显示当前 PATH 的 `D:\Hermes\...` 经 `realpath` 指向 `D:\Family\Hermes\...`，被 `trustedWindowsPath` 的非 canonical path 检查拒绝；该边界尚未修改，不能把失败豁免为环境噪声。默认 Vitest 环境另有 localStorage setup failures。
- 本轮没有真实 Tauri GUI restart/cleanup、跨进程竞争或 crash matrix 证据，也没有针对最终 exact HEAD 的 independent review；`dispatching` 的产品可达人工修复路径仍未闭合。正式状态保持 `unverified / partial-fail / not closed`；未 push/merge。

### 7.378 unverified：CleanupReceipt identity binding 与 recovery projection 收敛

- Cleanup proposal 现在只有在 receipt 与当前 Run/Task/TaskExecution/Attempt、worktree path/id、base revision、stable target identity 及 native `finalStatus=absent` read-back 全部一致时，才可投影为 `cleaned`；identity-less receipt 保持 blocked。相同的 native identity/read-back verifier 已复用于 recovery reconciliation。
- Worker recovery audit 不再用空的 runtime recovery projection 覆盖 `cleanup-unknown`；identity-less 或缺少匹配 receipt 的 cleaned snapshot 会进入 recovery，强制 consistency failure、清除 cleanup proposal 并 suppress success projection。pre-execution consistency gate 也拒绝无 durable cleanup receipt 的 cleaned snapshot。
- Legacy project migration 不再仅凭旧 snapshot 的 `cleanupStatus/cleanupReceiptId` 合成 `TaskCleaned`；新增 bootstrap regression 验证 legacy baseline 不伪造 cleanup 事实。
- 验证：Cleanup/recovery/bootstrap/migration focused suite 为 `9 files / 55 tests passed`；`npm run build` 与 `npx tsc --noEmit` 通过，构建保留既有 dynamic/static import 与大 chunk warnings；`git diff --check` 通过。
- 当前仅为 bounded cleanup slice 的 targeted evidence；完整 `npm run test`、`npm run i18n:check`、Rust gates、allocation/reducer 审查与最终 exact-HEAD independent review 尚未完成。真实 Tauri GUI restart/cleanup、跨进程竞争和 crash matrix 仍未闭合，正式状态保持 `unverified / not accepted`，未 push。

### 7.379 unverified：修复 Windows PATH 目录联接下的程序绑定并补跑全量质量门

- `src/dev/node-run.ts` 曾因 `realpath(candidate)` 与 PATH 中的拼写路径不相同，拒绝通过 Windows 父目录 junction 暴露的有效 `.cmd` 程序；本机 `D:\Hermes\...` PATH 项解析到 `D:\Family\Hermes\...`，导致 `runCommand('npm')` 返回未绑定程序。现在仍拒绝可执行文件自身为 symlink，但对检查过的文件执行 canonical `realpath`。`src/dev/node-run.test.ts` 在失败时同时输出 stderr；`src/dev/worktree.test.ts` 的真实 Git runner 回归保留并通过。
- 验证：Node `v22.23.2`（仓库 CI pin）全量 `npm run test -- --reporter=dot` 为 `208 test files / 1415 tests passed`；Node `v26.7.0` 下 `node-run` 与 `worktree` focused 为 `2 files / 26 tests passed`；`npm run build` 通过（`2102 modules transformed`，保留既有动态/静态 import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`git diff --check` 通过。
- 非 CI 的 Node `v26.7.0` 全量运行曾有 `25 test files failed / 183 passed`、`11 tests failed / 1275 passed`，其中包括该 npm shim 问题及 localStorage 环境失败；这不替代 Node 22 全量结果，也未把环境失败豁免为通过。
- 以上仅闭合本轮 Node 命令绑定与质量门；真实 Tauri GUI restart/cleanup 与 ProjectFile、事件、Evidence/Acceptance、Receipt、Git worktree 的交叉 read-back 尚待执行，正式状态保持 `unverified / not accepted`。

### 7.380 unverified：修复 Rust 宿主拒绝 Windows PATH 父目录 junction 下的 Git

- 7.379 只修复了 Node runner；Rust `trusted_windows_program` 仍要求 canonical path 与 PATH 拼写完全一致。本机 PATH 的 Git 经父目录 junction 指向 `D:\Family\Hermes\...\git.exe`，触发 untrusted-program fallback；9 个 Rust worktree/read-back tests 因启动占位程序而以 Windows OS error 2 失败。新增 Windows 回归先 RED，实际观察到解析结果为 `C:\Windows\System32\__slimemold_untrusted_program__.exe`，而 PATH 候选 canonical 后是 Git 可执行文件。
- 修复保持拒绝可执行文件自身的 symlink，但接受父目录 junction 并启动已检查文件的 canonical target；新增独立 `execution/dev_exec_windows_tests.rs` 回归核对 PATH-selected Git canonical identity 并实际运行 `git --version`。既有 `cleanup_readback_requires_absent_target_and_unlisted_worktree` 定向测试也从 OS error 2 恢复通过。
- 验证：Windows Git resolver focused `1/1`，既有 cleanup read-back focused `1/1`；完整 Rust `107 passed / 0 failed`，`cargo check --locked`、`cargo fmt --check` 通过；Node Windows Git focused `2 files / 26 tests`；配置 `NODE_OPTIONS=--localstorage-file=...` 的完整 Vitest `209 files / 1419 tests passed`；`npm run build`（`2102 modules transformed`）通过并保留既有大 chunk warning；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit`、`git diff --check` 通过。Vitest 输出的 `[H4] dev_init_session` 错误来自 `src/dev/gui.test.ts` 主动模拟失败的测试，不是失败用例。
- 对现有 7.375 的 read-back 显示标题及条目格式正常，没有逐行多余的前置 `|`；本轮未改写历史条目。Allocation exact audit（基线 `a2f834a`）未发现 P0，但记录了 post-claim transition persistence 失败可能遗留分配 lease、执行器不会启动的 P2 一致性缺口；Cleanup audit 认为 identity-less receipt 的常规 reconcile/执行路径 fail-closed，但 stale/empty recovery projection 可暂时显示 ready，且 standalone event replay 仍依赖后续 audit；Reducer audit 确认 TaskBlocked active-attempt/lineage guard 无缺口，同时发现 rehydration 未校验 `blockedBy` 是否属于 approved TaskGraph、以及 quarantine 与已开始 `appendBatch` 的并发窗口。以上未在本轮修改。
- 当前仅表示 Windows Git host binding 与同快照质量门闭合；最终 exact-HEAD reviewer 和真实 Tauri GUI restart/cleanup 及磁盘/host read-back 尚待完成，formal 状态保持 `unverified / not accepted`。计划的本地锚点为 `checkpoint/rust-windows-git-junction-unverified-20261007`；未 push。

### 7.381 reviewed：Windows Git junction 修复的 exact-HEAD 独立复核

- 独立只读 reviewer 核对 target `59bd5cb4ddf8207b8a191603ab88dfa0b0f23427`、parent `a2f834a7026b0785fa1c08287fd7799747958e53`、branch `phase2/worker-recovery-cleanup-cas` 和 clean tree；返回 `passed=true`，`security_concerns=[]`、`logic_errors=[]`。Reviewer 没有重跑测试；7.380 所列质量门是在同一 target 上实际运行的。
- Reviewer 的非阻塞建议：为回归补充显式 parent-junction fixture 与 executable-leaf-symlink fixture，使其不依赖 CI 机器 PATH 的实际布局。本机 RED/GREEN 已证明当前 junction 路径上的原问题与修复；该建议作为后续测试增强保留，本轮不扩范围。
- `checkpoint/rust-windows-git-junction-verified-20261007` 与原 `...-unverified-20261007` 均指向该 exact reviewed code commit。这里的 `verified` 只表示 Windows Git binding 这一窄代码切片；Worker recovery audit residual、真实 GUI restart/cleanup 和用户批准清理尚未闭合，因此产品层 formal acceptance 仍为 `unverified / not accepted`。未 push、未 merge、未清理任何 worktree。

### 7.382 unverified：真实 Tauri GUI 重启 read-back 与清理提案阻塞

- 2026-10-07 从 `phase2/worker-recovery-cleanup-cas` 的 docs-only HEAD `6b614bda074f8f0756b412619e0b8ac71e7d9749` 启动 `npm run tauri dev`；Vite `v5.4.21`、Rust dev build、`slime-mold.exe` 窗口和 fixture host grant 均有实际输出。GUI/AX capture 已归档；结束本轮后 wrapper、Tauri、Vite、WebView PID 均消失，端口 1420 无 listener。该 source HEAD 的 parent 为已独立复核的代码 commit `59bd5cb4ddf8207b8a191603ab88dfa0b0f23427`；verified code tag 仍指向该代码 commit。
- 重新打开 2026-09-22 disposable fixture 后，ProjectFile read-back 为 run `run-eec6094e-1e64-48f9-8505-ad0a9c2ffc5a`、task `task-create-worker-marker`、attempt 5 成功；`worktreeStatus=created`、`cleanupStatus=null`。47 events、20 Host Evidence、5 Acceptance（1 passed / 4 failed）、5 个 `worker-execution` side effects；`TaskCleaned=0`、cleanup side effect=0。没有重新执行 Worker task，也未调用 cleanup。
- GUI 明确显示“清理提案尚未生成，宿主状态需要复查”。由于没有有效 proposal 且没有用户批准，cleanup acceptance 阻塞；未生成 CleanupReceipt/TaskCleaned，未删除 worktree。`git worktree list` 与目录 read-back 确认五个历史 Worker worktrees 全部保留，均在 `a02f6c0b8c84d09703c42f483594aa42be339570`，文件内容及状态见 `docs/verification/TAURI_WORKER_GUI_RESTART_RECHECK_20261007.md` 和 `D:/Temp/sm-tauri-worker-restart-recheck-20261007/restart-readback.json`。截图与 accessibility tree 的路径、SHA-256 同见报告。
- 当前 checkout 的 7.375 小节 read-back 为 10 行、0 行以多余 `|` 开头；未改写该历史节。`src-tauri/Cargo.toml` 虽显示 `M`，但 worktree/index/HEAD blob 均为 `121bc638b507c3a84468f6ac589cf16b173f7dc4`，本轮未改动或暂存。
- 本轮没有代码改动；Node/Rust 全量质量门沿用 7.380 对代码 commit `59bd5cb4ddf8207b8a191603ab88dfa0b0f23427` 的记录，未重跑测试。独立 exact-HEAD review 见 7.381。正式状态仍为 `unverified / not accepted`；不 push、不 merge，不清理 worktree。

### 7.383 unverified：恢复当前 attempt 的 blocked cleanup proposal 并定位签名阻塞

- `src/projectControl/workerCleanup.ts` 现在在可解析时为 blocked cleanup proposal 附带当前 `taskExecutionId/attemptId`；lineage 解析失败仍保留 blocked proposal 的原因，不让异常中断提案构造。`src/projectControl/workerRunView.test.ts` 验证仅投影与当前 attempt 匹配的 proposal；`workerCleanup.test.ts` 覆盖宿主签名读取失败时仍保留 lineage。
- 真实 Tauri GUI fresh capture 显示 fixture run `run-0903c30c-3cb3-44e2-93c5-a42ccfe37e08`、task `task-create-worker-marker`、Worker worktree 及 4 条 Evidence；此前被 UI 投影成“尚未生成”的提案现可见为“暂不可清理”，原因是 `无法计算 worktree diff 签名：dev_exec: 参数路径不存在：D:/Temp/sm-tauri-worker-current-code-20261007-workers/w-8ac1f2f850215994576c3746/src/components`。这证明 lineage/projection 修复已到达真实 UI，但 proposal 仍 blocked。
- 根因已由代码链与 fixture 目录共同确认：`defaultDevPolicy.allowedPaths` 包含 `src/components`、`src/nodes`、`tests`、`docs`、`scripts`；`gitDiff` 将非 protected allowed roots 作为 Git pathspec 交给 Tauri；当前 disposable Worker worktree 有 `docs`，但没有 `src/components` 和 `src/nodes`；Rust `dev_exec_validate_paths` 与 `canonicalize_dev_exec_args` 对 diff path operand 均要求路径存在，因此在 Git 执行前 fail-closed。该签名路径阻塞尚未修复。
- 本次 GUI 中 DevSession 已成功承载 Worker run，未重现历史 `dev_init_session` 初始化失败；这不证明历史 H4 的 Git probe 根因已修复。全量测试日志中的 `[H4]` 来自 `src/dev/gui.test.ts` 有意模拟初始化失败的测试。
- 验证：设置独立 `NODE_OPTIONS=--localstorage-file=...` 后，`npm run test -- --reporter=dot` 为 `209 files / 1422 tests passed`；`npm run build` 通过（2102 modules transformed，保留既有 dynamic/static import 与大 chunk warnings）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 与 `git diff --check` 通过。当前仅证明 blocked proposal lineage/projection 代码切片和质量门，不证明 GUI cleanup 或 durable receipt。
- 未批准或调用 cleanup；没有 CleanupReceipt、`TaskCleaned` 或 worktree 删除 read-back。正式验收仍为 `unverified / not accepted`；五个历史 Worker worktrees 保留，未 push、未 merge。

### 7.384 unverified：规范化 Windows verbatim cleanup read-back 路径

- `dev_cleanup_worktree` 将 native canonical path 写入 `DevCleanupReadback.worktreePath`；Worker cleanup receipt gate 再以 `pathComparisonKey` 将该字段与 proposal path 比较。`src/dev/path-utils.ts` 现在在 WebView 纯路径解析前识别并去除 Windows verbatim drive/UNC 前缀；`src/dev/path-utils.test.ts` 覆盖 drive 与 UNC 路径在 Node/WebView 两条 key 路径上的别名等价。
- 真实 Tauri 窗口的 H4 面板成功渲染 DevSession，并读到 1 条 PASS Acceptance；同屏状态为 EvidenceStore 未绑定、Worktree 0。当前窗口未显示原 `src/components` 缺失 pathspec 错误，而显示 cleanup native identity/read-back 审计失败；由于当前无可执行 proposal、journal 为 `unknown/needs-user`，本次观察不能证明新的 cleanup 流程已经越过签名 gate。
- fixture durable read-back：run `run-0903c30c-3cb3-44e2-93c5-a42ccfe37e08` 的 Task `task-create-worker-marker` / attempt 1 仍为 succeeded，4 个 Evidence ID 与 Acceptance `acc-muxh4muk-97071bce` 保持绑定；cleanup side effect 是 `unknown/needs-user`，无 receipt、无 `TaskCleaned`。目标 worktree 目录及 branch ref 当前都不存在；删除来源无法由现有 durable facts 归因，因此不得重试清理或将其标记为成功。
- 验证：隔离 localStorage 的完整 Vitest 为 `209 files / 1424 tests passed`；`npm run build` 通过（2102 modules transformed，既有 dynamic/static import 与大 chunk warnings 保持）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit`、`git diff --check` 通过。
- 当前 H4 GUI 可用仅是本次窗口观察，不证明历史 Git top-level probe 根因已修复；cleanup 仍为 `unknown/needs-user`，没有用户批准后的有效 proposal、CleanupReceipt 或 `TaskCleaned`。正式验收保持 `unverified / not accepted`；本轮未执行 cleanup、未 push、未 merge。

### 7.385 unverified：增加 native verbatim path cleanup receipt 回归测试

- 新增 `src/projectControl/workerCleanupExecution.pathReadback.test.ts`，把 native `\\?\C:\...` canonical path 与普通 proposal path 的对照放进 receipt execution 路径；拆出后 `workerCleanupExecution.test.ts` 为 378 行，新测试文件 98 行。
- TDD 证据：临时绕过 verbatim-prefix normalization 时，新回归测试失败（`result.cleaned` 实际为 `false`）；恢复 normalization 后通过。定向执行 2 个测试文件共 12 tests passed。
- 验证：最终全量 Vitest 为 `210 files / 1425 tests passed`；`npm run build` 通过（2102 modules transformed，既有 dynamic/static import 与大 chunk warnings 保持）；`npm run i18n:check` 为 `1026/1026`；`npx tsc --noEmit` 与 `git diff --check` 通过。首次 build 在新测试 fixture 的可选 `targetIdentity` 类型处报错，收窄 fixture 返回类型后最终质量门通过。
- 本切片没有重新启动 Tauri，也没有读取 native 返回的实际 verbatim path；该 regression 证明 TS receipt gate 能接受别名，不证明 fixture 历史 unknown cleanup 的根因或结果。fixture cleanup side effect 仍是 `unknown/needs-user`，没有可读回的 CleanupReceipt / `TaskCleaned`；本轮未触碰或清理任何 worktree，正式 GUI 验收仍为 `unverified / not accepted`，未 push、未 merge。

### 7.386 unverified：真实 Tauri 重启后 read-back 仍处于 cleanup unknown

- 关闭旧 dev session 后确认 `localhost:1420` 释放，再从当前 checkout 启动 `npm run tauri dev`：Vite ready、Rust dev profile 完成、`target/debug/slime-mold.exe` 启动，并枚举到新的 SlimeMold 窗口。重启后打开 H4 面板，DevSession 视图正常渲染且没有 init-failure 文案；`EvidenceStore 未绑定` 与 Worktree 0 同时出现，符合 EvidenceCollector 仅在 worktree 创建/登记后懒绑定 persistence 的实现，不代表 H4 初始化失败。该观察只证明当前这次初始化可用，历史 Git top-level probe 根因仍未复现/确认。
- 新鲜 fixture read-back：该 run/task 关联 7 条事件（RunCreated、TaskQueued、RunStarted、TaskStarted、TaskSucceeded、RunSucceeded 及 IssueCreated），`TaskCleaned=0`；Acceptance `acc-muxh4muk-97071bce` 为 PASS；Worker execution side effect 有 succeeded receipt。cleanup side effect 仍为 `unknown/needs-user` 且没有 receipt；ProjectFile task 仍投影 `worktreeStatus=created`，但目标 worktree 目录与 branch ref 都不存在，`git worktree list` 仅有 fixture base。现存事实不能归因删除来源，不能改写成成功 cleanup。
- 当前 H4 面板没有 cleanup proposal，故本次重启未产生新签名计算/cleanup 运行；原 `src/components` Git diff pathspec blocker 是否已在真实 proposal 路径解除，仍无 fresh GUI 证据。没有创建新 Worker attempt，也未调用 cleanup；不自动恢复/删除目标，不将 `unknown` 改成 `skip`。
- 手动 GUI 截图、90 元素 AX 树与 read-back manifest 已归档在 `D:/Temp/slimemold-worker-evidence-20261007-run-0903c30c/gui-restart-readback-20261007/`；manifest 的 `supports`/`doesNotProve` 明确区分 UI 观察与 durable 事实。截图 SHA-256：`778742e557056dc4974046d8dc043148977fee9a37a705fb39f31fa6838e395d`；AX 树 SHA-256：`1c3969ed8f97249c54eb6817e2355bff1d549d125f4079734c97d5e79cf40aa2`。截图未显示 cleanup warning 或 H4 init-failure 文案；不代表历史根因已修复。该档案不构成用户批准或 cleanup acceptance；正式状态保持 `unverified / not accepted`，未 push、未 merge。

### 7.387 verified code slice：Windows cleanup read-back path alias

- 独立 exact-snapshot reviewer 审查 target `26053716908dab930405539b30ce6dd4d3e3c57b`、immediate parent `d0c8586d13e05ffb0db350160d8340e4066946db`，并核验累计切片基线 `d17ad35ac5c4505959dd549cae123757ed883a0b` 为祖先；工作树当时位于干净的 docs-only descendant `cf14727a866e8354f8fe594ec2570aabbcb062d7`。严格 JSON verdict：`passed=true`，`security_concerns=[]`、`logic_errors=[]`；reviewer 未修改工作树。
- 审查绑定的质量门：定向 2 个测试文件 12 tests passed；绕过 normalization 时回归 RED（`result.cleaned=false`）；全量 Vitest `210 files / 1425 tests passed`；build 通过（2102 modules transformed，既有 import/chunk warnings）；i18n `1026/1026`；`npx tsc --noEmit` 与 `git diff --check` 通过。
- reviewer 的非阻塞建议：补测 verbatim path 作为 Tauri root 时 `resolveWeb` 的路径解析/containment；考虑穿过 native `DevCleanupReadback` boundary 的集成测试（含 verbatim UNC）。当前回归使用 native read-back stub，但确实运行生产 TypeScript receipt comparison gate。
- 本地 verified tag `checkpoint/cleanup-readback-regression-verified-20261007` 精确指向上述 target；该 verdict 仅覆盖 Windows path-alias normalization 与 TS receipt read-back gate，不覆盖 native pathspec 实现、真实 GUI cleanup 或历史 H4 根因。当前 fixture 仍是 `unknown/needs-user`，无 CleanupReceipt / `TaskCleaned`；完整 GUI cleanup 验收与 H4 历史根因均继续标记 `unverified / not accepted`。未 push、未 merge。

### 7.388 unverified：重启后 DevTools 只读复查未复现 H4 错误

- 2026-10-07 对当前同一 Tauri 窗口执行获授权的一次只读 DevTools 检查：控制台显示 1 条可见错误，为 `http://localhost:1420/favicon.ico` 404；未显示 `[H4] dev_init_session` 初始化失败。检查后关闭 DevTools，并 fresh-capture 确认 SlimeMold PID `31172` / window `2494302` 仍在，H4 面板仍显示、Acceptance PASS、Worktree 0、无 cleanup proposal；界面仍标记“无宿主持久化”。DevTools 截图已归档至 `D:/Temp/slimemold-worker-evidence-20261007-run-0903c30c/gui-restart-readback-20261007/devtools-console-post-restart-20261007.png`，SHA-256 `3a4c8645f006acf17aee1cfc0eb1dbb56115ff508eb26eb7a953eeea4270b0f0`；read-back manifest 已追加观察与动作范围。
- “无宿主持久化”标签在 `src/components/DevSessionPanel.tsx:80-84` 由 `snap.hasPersistence` 决定；`src/dev/evidence.ts:355-363` 说明 EvidenceCollector persistence 在 GUI 动态 worktree 建立后惰性绑定。因此此标签只证明当前 EvidenceStore 尚未绑定，不单独证明 `dev_init_session` 失败或成功。对 `src` 的定向搜索未发现 `window/globalThis` store debug export；本次未执行 console expression、Tauri 命令、保存或清理，故没有直接读取 React store 内存状态。
- 当前重启未复现历史 H4 失败，不能据此宣称根因已知或永久修复。fixture cleanup 仍为 `unknown/needs-user`，无 CleanupReceipt / `TaskCleaned`，且无 proposal；没有新建 Worker attempt、没有触发 cleanup，正式 GUI cleanup 验收继续为 `unverified / not accepted`。未 push、未 merge。

### 7.389 unverified：新 attempt 授权被 cleanup-unknown 一致性门安全阻断

- 2026-10-07 用户明确允许在同一 disposable fixture 创建一次新 Worker attempt，但 cleanup 仍需单独明确批准。随后检查 advanced Project Control 视图并归档 `D:/Temp/slimemold-worker-evidence-20261007-run-0903c30c/gui-restart-readback-20261007/projectcontrol-warnings-20261007.png`（SHA-256 `c9828aa1bbda48b6db6f0185d2e817e1241f74058b37597011716067c1255024`）；界面显示 `Cleanup receipt 缺少可信 native identity read-back` 与 `Worker worktree 未能从 git 恢复登记` 两条 warning。
- durable read-back：原 Worker execution side effect 为 `receipt/succeeded`；worktree-cleanup side effect 为 `unknown/needs-user` 且无 cleanup receipt；run+task 精确匹配 4 个事件（`RunCreated`, `TaskQueued`, `TaskStarted`, `TaskSucceeded`），`TaskCleaned=0`；目标目录与 branch ref 均不存在。新 attempt 未创建，cleanup 未执行。
- 该停止由现有安全门要求：`cleanupUnknownRunIds` 将 unknown/needs-user 的 worktree cleanup 纳入阻塞集（`src/projectControl/workerRecoveryFacts.ts:109-127`）；`assertWorkerRunConsistency` 对非空阻塞集抛出 identity-read-back 错误（`src/projectControl/workerRunConsistencyAction.ts:65-70`）；Coordinator 在调用 `runActiveWorkerRun` 前先 await 一致性检查（`src/projectControl/workerRunCoordinator.ts:127-148`，由 `src/app/workerRuntime.ts:199-209` 提供）。恢复实现明确禁止对含 cleanup effect 的 recovery 直接 retry（`src/projectControl/workerSideEffects.ts:768-770`）。因此即便用户已授权一次新 attempt，当前事实不满足执行前置条件；没有绕过/清除 unknown，也未调用 recovery skip/cleanup。
- H4 本轮仍未复现历史 Git top-level probe failure，根因未知。cleanup 仍为 `unknown/needs-user`、GUI cleanup acceptance `unverified / not accepted`。需先另行明确如何处置该旧 cleanup-unknown（保留并停止，或讨论一个只读身份核对/正式 reconciliation 路径）；在其解除前不启动新 attempt。未 push、未 merge。

### 7.390 unverified：当前 native cleanup read-back 不能单独只读调用

- 源码核验未发现独立的只读 native cleanup identity probe：`src/dev/tauri-run.ts:74-88` 先调用 `dev_approve_cleanup`，再调用 `dev_cleanup_worktree`；Rust handler 在 `src-tauri/src/authority/worktree.rs:1507` 执行 worktree/branch cleanup mutations，之后才于 `1546-1555` 做 target/worktree-list read-back 并返回 `DevCleanupReadback`。因此该命令不是可安全用于本次旧 orphan 核对的只读接口。
- 目标路径虽在本机不存在，但没有有效 cleanup proposal/native capability；本轮未调用 `dev_cleanup_worktree`，未触发删除、receipt/event 写入或状态重置。旧 side effect 继续保持 `unknown/needs-user`，新 Worker attempt 继续被 pre-dispatch consistency gate 阻止。
- 要在同一 fixture 继续，需先讨论并明确批准如何给旧 unknown 建立可信、非破坏性的核对/reconciliation 路径；不能把现有删除命令当作探测器，也不能因目标目录已不存在而合成 CleanupReceipt 或 `TaskCleaned`。未 push、未 merge。

### 7.391 unverified：补全 TaskGraph 事件快照并提供独立回放

- `generateTaskGraphCommand`、`reviseTaskGraphCommand`、`approveTaskGraphCommand` 现在分别在 `TaskGraphProposed`、`TaskGraphSuperseded`、`TaskGraphRevisionCreated`、`TaskGraphApproved` 中追加完整 `ProjectTaskGraph` 快照；原 payload 字段保留，`schemaVersion` 仍为 1。没有改写现存 `events.jsonl`。
- 新增纯函数 `replayTaskGraphsFromEvents`，按序应用完整快照、按 `eventId` 去重、稳定保留图首次出现顺序；缺少完整结构的旧事件只登记 `legacyGraphIds`，不从 `taskIds` 猜图，之后的完整快照可恢复该图。按计划未改 `replayDomainEvents`。
- `projectControlConsistency.ts` 的现有检查比较 aggregate、图版本和批准事实，不对事件 payload 做字段白名单校验，因此没有必要改该文件。相关实现和决策记录在本轮报告 `.hermes/reports/2026-10-11-living-graph-batch1.md`。
- 验证：定向 3 个测试文件 `24 passed`；全量 `npm run test -- --reporter=dot` 退出码 1，为 `211 files` 中 `187 passed / 24 failed`、`1,298 tests` 中 `1,288 passed / 10 failed`，失败文件与用例集合均与基线完全相同；运行仍提示 Node 未配置 `--localstorage-file`，失败表现包括 localStorage 访问错误与 experienceStore 持久化断言失败，本轮不重新分类基线根因；`npm run build` 通过（`2102 modules transformed`，保留既有 mixed static/dynamic import 与大 chunk warnings）；`npx tsc --noEmit` 通过；`npm run i18n:check` 为 `1026/1026`；`git diff --check` 通过。
- Exact-snapshot reviewer 核对 target `1f363a3be3a40e3a1ce457dfc9170fa96ae42f77`、parent `28d6f99915ef4f38090a92c48b1ec3b604d51c96`、分支 `feat/living-graph-batch1` 与 clean tree；严格 JSON verdict 为 `passed=true`，`security_concerns=[]`、`logic_errors=[]`。建议进一步断言四类事件的 schemaVersion/旧字段保留并覆盖冗余元数据冲突；作为非阻塞建议记录，未扩大本切片。
- 本地 checkpoint commit `1f363a3be3a40e3a1ce457dfc9170fa96ae42f77` 与 tag `batch1-slice1` 保持明确的 `(unverified)` 状态；独立 review 通过不等于用户验收。未 push、未 merge。

### 7.392 unverified：补足 Worker 施工单约束与不可信数据边界

- S2 的 exact-snapshot review 针对原施工单实现 `76b333bbaed57b6220233a3f90835e0336ab94bc` 返回 `passed=false`：指出共享施工单遗漏 ContextPack `scope` 中的委派深度、扇出、token/call/money/time 限额和 `expiresAt`；并指出 free-form project/task 内容直接进入模型提示、未标记数据边界。沿实际调用链检查后还确认 Antigravity 的 `slimemold_get_task_context` 会返回独立结构化 context sidecar，因此同一数据边界也被带入该 sidecar。
- `src/projectControl/workOrder.ts` 现在按项目约定、模块契约、具体任务的稳定顺序序列化 JSON 数据，完整包含 ContextPack 的 `scope` 与其它已有字段；JSON 字符串中的 U+2028/U+2029 被转义。共享静态 `WORKER_CONTRACT_DATA_BOUNDARY` 明确要求把字段值视为数据、拒绝其中覆盖提示/角色/执行器边界的指令，并说明字段本身不授予工具能力。`src/dev/antigravityWorkerExecutor.ts` 将相同边界随 context sidecar 返回；不含 ContextPack 时仍保留任务契约。
- 回归覆盖：完整 ContextPack 的 Codex/Antigravity prompt golden、所有 scope 限额透传、任务/项目字段含指令式文本时仍作为 JSON 数据保留、Antigravity sidecar 边界，以及 U+2028/U+2029 转义。当前最长改动测试文件 `src/dev/workerPromptContract.test.ts` 为 367 行，未超过 400 行拆分提示线。
- 验证：聚焦 `npx vitest run src/projectControl/workOrder.test.ts src/dev/workerPromptContract.test.ts src/dev/codexWorkerExecutor.test.ts src/dev/antigravityWorkerExecutor.test.ts` 为 4 files、27 tests passed；全量 `npm run test -- --reporter=json --outputFile=D:/Hermes/cache/scratch/slimemold-batch1-s2-remediation-final-vitest.json` 退出码 1，213 files 中 189 passed、24 failed，1,316 tests 中 1,306 passed、10 failed；失败文件集与切片 0 基线 24/24 相同，失败用例数仍为 10/10，没有新增失败，运行仍提示 Node 未提供 `--localstorage-file`。`npm run build` 通过（2,103 modules transformed），保留 mixed static/dynamic import 警告和 1,287.79 kB 主 bundle 的既有 >500 kB 警告；`npm run i18n:check` 为 1,026/1,026；`npx tsc --noEmit`、`git diff --check` 均通过；281 条新增行静态扫描未发现 secret/shell/eval/unsafe-deserialization 模式。
- 决策与剩余边界：为完整保留已批准 ContextPack 的约束，不再只渲染文件/工具/数据类别/角色 allowlist，而是透传整个 `scope` 对象。JSON framing 与说明属于模型提示层的风险缓解，不构成抗 prompt-injection 的安全证明；scope 数值本身也不能授予宿主能力，实际可用工具仍由执行器提供。未运行真实模型、Worker 或 Tauri GUI。
- 修复 checkpoint 为 `c1f23704e4cb961a48388e601219c945f01d767e`（parent `76b333bbaed57b6220233a3f90835e0336ab94bc`），本地 tag `batch1-slice2-review-fix-unverified` 指向该提交。针对原提交的 review blocker 已在代码/测试中修复；新快照 exact review 待执行，故本节仍为 unverified，不代表用户验收。未 push、未 merge。

### 7.393 unverified：封装 Antigravity sidecar 不可信数据并完成 S2 精确复审

- 对 `c1f23704e4cb961a48388e601219c945f01d767e` 的第二次复审仍为 `passed=false`：发现 Antigravity MCP 的 `slimemold_get_task_context` 会把 `task`、`contextPack`、`dependencyArtifacts` 原始对象和 `dataBoundary` 并列返回，边界文本不能证明这些对象已按数据封装。按切片最多两轮返工执行本轮修复；没有调用模型或扩大宿主权限。
- `src/projectControl/workOrder.ts` 导出统一 `serializeWorkerContractData`，供稳定施工单和 Antigravity sidecar 共用 JSON framing 与 U+2028/U+2029 转义。`src/dev/antigravityWorkerExecutor.ts` 现在把 task、ContextPack、dependency artifacts 放在单一 `context.untrustedData` JSON 字符串中；sidecar 顶层仅含静态 `dataBoundary`、该字符串及宿主运行时 `attempt`/`attemptId`。回归 `src/dev/antigravityContextBoundary.test.ts` 用恶意自由文本、新行及 Unicode 行分隔符，穿过真实 executor 组装和 `slimemold-antigravity-mcp.mjs` 的 `tools/call`，核验 `structuredContent` 与文本响应都原样保留此封装。
- 验证：聚焦 `npx vitest run src/projectControl/workOrder.test.ts src/dev/workerPromptContract.test.ts src/dev/antigravityContextBoundary.test.ts src/dev/codexWorkerExecutor.test.ts src/dev/antigravityWorkerExecutor.test.ts` 为 5 files、28 tests passed。最终全量 Vitest JSON 运行退出码 1：214 files 中 190 passed、24 failed；1,317 tests 中 1,307 passed、10 failed。24 个失败文件及 10 个具体失败断言均与上一轮 remediation 完全一致；该上一轮失败文件集合也与开工基线一致，未新增/消失失败；Node 仍提示未提供 `--localstorage-file`。`npm run build` 通过（2,103 modules；保留 mixed static/dynamic import warnings 与 1,287.89 kB 主 bundle >500 kB warning）；`npm run i18n:check` 通过（1,026/1,026）；`npx tsc --noEmit`、`git diff --check` 通过；232 条新增行静态扫描无 suspicious secret/eval/shell/unsafe-deserialization matches。单文件最长 `src/dev/workerPromptContract.test.ts` 为 385 行，未超过 400 行拆分提示线。
- Exact-snapshot review：target `51879d5c4409cf0858d5d71ac24046a06ca1919e`、parent `b8e58285e4d977f0847076027e2d92fd4d69df0b`、branch `feat/living-graph-batch1`、tag `batch1-slice2-sidecar-boundary-repair-unverified` 与 clean tree 均匹配；`passed=true`，`security_concerns=[]`、`logic_errors=[]`。reviewer 建议补充 unusual task ID 经 `attemptId`/`operationId` 的测试；本轮未扩展该范围。当前生成的 task identity 由 `src/domain/execution.ts` 的 `encodeURIComponent` 编码，Antigravity operation ID 另做字符归一化；仍未为 unusual ID 增加专门回归。
- 剩余边界：数据封装与提示语降低结构性混淆风险，但不构成模型遵循提示的保证，也不是宿主授权控制；真实模型、Tauri GUI 和真实 Worker 均未运行。代码 checkpoint `51879d5c4409cf0858d5d71ac24046a06ca1919e` 与 tag 均保留 `(unverified)`：计划要求所有产出 unverified，reviewer 通过不等于用户正式验收。未 push、未 merge。

### 7.394 unverified：B0 影子分诊与生长检查（切片 3）

- 新增纯函数 `src/projectControl/triage.ts` 与 `src/projectControl/growthPolicy.ts`。分诊规则版本为 1，阈值集中为 `L0_MAX_FILES=2`、`L2_MIN_MODULES=3`、`L2_MIN_TASKS=6`；先判 L0（单模块且去重 scope 文件数不超过上限），再判 L2（模块数达标，或有跨模块依赖且任务数达标），其余为 L1。理由用中文记录命中条件与数值。生长检查按任务顺序记录无验收标准、共享文件且不存在直接/间接依赖、L0 多任务过度拆分三类违规；依赖遍历用 visited 集合，循环输入可终止。
- `generateTaskGraphCommand` 将 `{ level, reasons, rulesVersion, violations }` 作为 `TaskGraphProposed.payload.triage` 影子事实记录。该路径不阻止提案、不改写 TaskGraph、不授予执行权；命令测试核验含违规图仍以 draft 状态进入 plan-review。按本切片范围，`TaskGraphRevisionCreated` 暂不附分诊记录。
- RED→GREEN：分别为 L0/L1/L2、跨模块任务数门槛、验收缺失、独立重叠、传递依赖以及四任务 helloworld 过度生长夹具添加回归；命令集成测试先确认缺少 triage/violations，再接入记录字段。聚焦 `npx vitest run src/projectControl/triage.test.ts src/projectControl/growthPolicy.test.ts src/projectControl/commands.test.ts src/projectControl/taskGraphEventReplay.test.ts --reporter=dot` 为 4 files、28 tests passed。
- 验证：最终全量 `npm run test -- --reporter=json` 退出码 1：216 files 中 192 passed、24 failed；1,328 tests 中 1,318 passed、10 failed。24 个失败文件与 10 个失败断言身份均与上一轮及开工基线相同；Node 环境继续提示未提供 `--localstorage-file`。`npm run build` 通过（含 `tsc -b`；主 bundle 1,289.54 kB，保留 >500 kB chunk warning）；`npm run i18n:check` 通过（1,026/1,026）。复核发现根 `tsconfig.json` 是仅 references 的 solution config，故 `npx tsc --noEmit` 虽退出 0 但不加载应用源文件；有效的 `npx tsc -p tsconfig.app.json --noEmit` 退出 0（514 个 src 文件），build 的 `tsc -b` 也已在最终通过构建中运行。`git diff --check` 通过。
- Exact-snapshot review：target `5d2e122d90fbbfa96c04969041c22539873446b5`、parent `b29c31cdca581b6886b7e3420bcf2cc9d0aef837`、branch `feat/living-graph-batch1`、tag `batch1-slice3-shadow-triage-unverified` 与 clean tree 匹配；`passed=true`，security/logic/scope findings 均为空。reviewer 非阻塞建议：补两模块及 5-task 跨模块依赖的 L1 负边界，以及单模块恰好 2 文件的 L0 单测；并在后续考虑修订任务图是否也需要分诊。本切片按批准范围将它们记录为 deferred。
- 剩余边界：B0 只为新建 TaskGraph 提供影子记录，不接真实模型，不驱动 planning/hierarchy/execution，也未做 UI 统计或 GUI 验收。阈值按夜间任务给定的 2/3/6，本轮生效；未来是否调整由用户决定。reviewer 通过不等于用户验收；本代码和标签仍为 `(unverified)`，未 push、未 merge。

### 7.395 unverified：Phase 0 i18n 校验与 UI 文案迁移（切片 4）

- 将占位符校验抽为纯函数 `src/i18n/placeholderCheck.ts` 并接入 `scripts/check-i18n.ts`。除拒绝单花括号外，也按 `namespace + key` 对比 zh-CN/en-US 的双花括号变量集合，避免不同 XML namespace 的同名 key 相互覆盖；测试覆盖单/双花括号、变量集合不一致/一致及重复 key 跨 namespace。
- 所有 locale XML 中单花括号 i18next 插值已改为 `{{...}}`。逐项对照调用变量；`settings.general.eventPersistenceDesc` 的 `{workflow}/{run}` 是不带插值参数的字面路径示意，因此改为 `<workflow>/<run>`（XML 中用 `&lt;` 编码），保留可见路径而不让 i18next 吞掉变量。runtime read-back 在两种语言均显示完整路径。
- 按计划将七个文件中的非注释 UI 文案迁入原有 namespace：`WorkflowEditor.tsx`、`LeftSidebar.tsx`、`App.tsx`、`OrchestratorPanel.tsx`、`Inspector.tsx`、`TopBar.tsx`、`StatusBar.tsx`。静态中文扫描用 TypeScript AST 排除注释，并对静态 `t()`/sidebar labelKey 验证 locale 资源存在。显式例外及原因：WorkflowEditor 节点类别键是已保存工作流数据标识；App 中 `。！？` 是目标切句正则；OrchestratorPanel 恢复理由是持久化审计 provenance；Inspector 两条提示只写开发者控制台。代码旁保留说明；未改计划排除的 workflow 默认名、BeginnerExperience 统计卡、Worker/恢复/清理/native 代码。
- RED→GREEN：占位符 helper 未存在时测试失败；新增检查后 `i18n:check` 首先报告既有单花括号，再逐项修复。中文字面量测试促使注释剥离兼容 JSX 注释与空 catch block。新增 source→locale key 测试发现 Inspector 调用了不存在的 `asset.localLabel`（zh/en 均失败），改用已有 `param.asset.localLabel` 后测试通过。
- 额外 read-back：独立 XML 解析得到每种语言 1,113 个 namespace-key 资源，单花括号数量 0、同 namespace/key 的 zh/en 插值集合不匹配 0；`i18n:check` 报 1,112 个全局 key 对齐（跨文件有同名 key）；i18next runtime 代表性 namespace 查找 zh-CN/en-US 各 8/8。
- 验证：focused `npx vitest run src/i18n/placeholderCheck.test.ts src/i18n/uiChineseLiterals.test.ts --reporter=dot` 为 2 files、7 tests passed；`npx tsc -p tsconfig.app.json --noEmit` exit 0；`npm run build` exit 0，含 `tsc -b`、2,105 modules，主 bundle 1,303.34 kB（gzip 380.94 kB），仍有 mixed static/dynamic import 与 >500 kB chunk warnings；`npm run i18n:check` exit 0；`git diff --check` passed。
- 全量 `npm run test -- --reporter=json` exit 1：218 files（194 passed、24 failed），1,335 tests（1,325 passed、10 failed）。与 S3/开工基线的 24 个失败文件、10 个失败断言身份逐项一致，没有新增或消失项；Node 仍提示缺少 `--localstorage-file`，不修、不跳过、不降低这些基线失败。JSON 对比保存在仓库外 `D:/Hermes/cache/scratch/slimemold-batch1-s3-triage-vitest-2.json` 与 `D:/Hermes/cache/scratch/slimemold-batch1-s4-i18n-final2-vitest.json`。
- 新代码检查点：占位符/locale commit `ed87d4ec7dbba5985ec9dc0a51aa5ddeb86f83b6`，namespace 隔离修复 `12619c058280c3bf1a51c6596af441d322aa80d1`，UI 迁移 `ca50e97e2f5d9cc65c28f066bd191b31f8f05509`。Exact review 核对 target `ca50e97e2f5d9cc65c28f066bd191b31f8f05509`、parent `12619c058280c3bf1a51c6596af441d322aa80d1`、branch `feat/living-graph-batch1`、tag `batch1-slice4-i18n-unverified` 与 clean tree；`passed=true`，security/logic/scope findings 均为空。reviewer 提醒全量测试的基线失败仍需单独追踪；review 不等于用户验收。
- 结构残余：S4 开始前 `WorkflowEditor.tsx` 1,182 行、`OrchestratorPanel.tsx` 993、`TopBar.tsx` 686、`App.tsx` 485、`Inspector.tsx` 413；结束后依次 1,185、997、686、489、415。此次保持为窄 i18n 行为切片，没有把大规模组件拆分混进来；超 400/600 行的既存模块需另立有界结构切片。所有提交/tag 仍为 `(unverified)`，未 push、未 merge；未做 GUI/视觉验收，等待用户正式验收。

### 7.396 unverified：B1 试读纯规则与影子事件（切片 5，加时）

- 新增 `src/projectControl/workOrderPreflight.ts`：原样保留计划里的中文 B1 prompt 核心；`workOrderDigest` 使用 UTF-8 FNV-1a 64-bit，注释明确仅作确定性摘要、不是安全哈希；`parsePreflightResponse` 接受 JSON 数组，只有 quote 是施工单原文的逐字子串且字段合法的条目保留。JSON/顶层格式无效返回 `unknown`；无有效猜测点返回 `clear`；有 `blocking` 返回 `ambiguous`；只有 `minor` 时记录猜测点但判为 `clear`（不阻断）。`isPreflightCurrent` 比较摘要以使改动后的旧试读过期。
- `recordWorkOrderPreflightCommand` 放在 `workOrderPreflightCommands.ts`，核对当前 TaskGraph id/version、task 成员和 session，按 B0 规则拒绝 L0 直通图；其余返回 TaskGraph aggregate 上 `WorkOrderPreflightCompleted` 的私有影子事件，不改 snapshot/图/approval。cost 使用 `{status:'not-metered'}` 或带 `amountUsd` 的实测值，不伪造 `$0`。没有调用 `agentRouter`、真实模型或 Worker。
- 定义 `WorkOrderPreflightCompleted` / `WorkOrderPreflightWaived` payload/event 类型，并加入 ProjectControl 一致性 recognized whitelist。waiver payload 可引用 Decision，但这次 shadow slice 没有 UI 或 waiver command；不会自行生成豁免事件，也不接 approval gate。
- RED→GREEN：纯规则测试覆盖原文子串过滤、三种 verdict、FNV 摘要稳定/变化、旧记录失效；命令测试覆盖 TaskGraph/version/task 边界、L0 拒绝、L1 直通记录、`unknown` 记录及不改 approval；ProjectControl consistency 测试覆盖 completed/waived 事件识别。聚焦 4 files/33 tests passed。
- 验证：`npx tsc -p tsconfig.app.json --noEmit` exit 0；`npm run build` exit 0（含 `tsc -b`、2,106 modules，主 bundle 1,303.41 kB / gzip 380.97 kB；既有 mixed static/dynamic import 与 >500 kB chunk warnings）；`npm run i18n:check` 1,112 keys 对齐；`git diff --check` passed。静态 added-line scan 506 lines，secret assignment、eval/exec、shell execution 均 0。
- 全量 `npm run test -- --reporter=json` exit 1：220 files（196 passed、24 failed），1,345 tests（1,335 passed、10 failed）。与 S4 的失败文件及失败断言集合完全一致，无新增失败；Node `localStorage` 缺少 `--localstorage-file` 的环境提示仍在。S4/S5 JSON 对比文件：`D:/Hermes/cache/scratch/slimemold-batch1-s4-i18n-final2-vitest.json`、`D:/Hermes/cache/scratch/slimemold-batch1-s5-preflight-final-vitest.json`。
- Exact-snapshot review：target `52f2cfa48b6e5e6c8827c5b3dfa88bbdad0a53b6`、parent `164e4adf456bb18ba1b66eb2e1eacb90fe85be9e`、branch `feat/living-graph-batch1`、tag `batch1-slice5-l0-eligibility-unverified` 与 clean tree 相符；`passed=true`，security/logic/scope findings 为空。非阻塞建议：将 L1+ 正向条件显式断言；当前成功命令夹具为单模块三文件，按 L0_MAX_FILES=2 已属于 L1 且成功，后续可增加直接级别断言。reviewer 也提示不要把基线全量失败混作本切片失败。
- 加时边界：此 slice 是 shadow recorder / parser，并未接入生产调度或任何模型调用；L0 由命令边界拒绝，L1/L2 的成功记录仅由 fixture 验证。WAIVED 事件类型已被识别，但实际 user Decision→waiver command/UI 仍未实现，留待后续集成 slice。所有代码与 tags 保持 `(unverified)`，用户正式验收未进行；未 push、未 merge。

### 7.397 unverified：B3 EAC 中间 CPI 溢出修复与精确复审（切片 6，加时）

- S6 原始实现 `7cf5c3512493797fdaf86a7de2135caedd5cc2f7` 增加纯函数 `costModel.ts` 与测试，按 `(attemptCost + reviewCost) / passRate` 估算验收成本，以 host acceptance 输入计算 EV，再计算 CPI/EAC；不包含厂商价格或路由、`agentEconomics`、评分、预算存储、调度接入。用户验收与数据源接入不在本切片。
- 第一次 exact review 对 `7cf5c3512493797fdaf86a7de2135caedd5cc2f7` 返回 `passed=false`：指出有限的 `earnedValue=Number.MAX_VALUE` 与正的 `actualCost=Number.MIN_VALUE` 可使中间 CPI 溢出为 Infinity，EAC 随后返回 `{status:'ok', value:0}`，产生伪造数值。security 与 slice-scope findings 为空。该失败 verdict 未沿用至修复后快照。
- 按 TDD 添加 overflow regression，以极端有限输入断言 `{status:'insufficient-data'}`；先见 RED：返回 `status:'ok', value:0`。随后在 EAC 计算处对中间 `cpiValue` 加 `Number.isFinite` 与正值检查，非有限或非正 CPI 不产出数字；测试 GREEN。costModel 单测 8/8，结合 S5 preflight 的聚焦命令 3 files/18 tests passed。
- 修复代码提交 `5b474c8e5b47445e9d13f0a525d526b7f5381951`，parent `7cf5c3512493797fdaf86a7de2135caedd5cc2f7`，tag `batch1-slice6-eac-overflow-fix-unverified` 指向该代码提交。修复新增 10 行；added-line 扫描 secret assignment、eval/exec、shell execution 各 0；`git diff --check` passed。
- 修复快照质量门：`npx tsc -p tsconfig.app.json --noEmit` exit 0；`npm run i18n:check` 1,112 keys 对齐；`npm run build` exit 0（2,106 modules，主 JS 1,303.41 kB / gzip 380.97 kB；仍有既有 mixed static/dynamic import 与 >500 kB chunk warnings）。全量 Vitest exit 1：221 files（197 passed、24 failed），1,353 tests（1,343 passed、10 failed）；failed file 与 assertion 身份和 S5 baseline 完全相同，无新增失败。Node 仍缺 `--localstorage-file`；比较文件 `D:/Hermes/cache/scratch/slimemold-batch1-s5-preflight-final-vitest.json` 与 `D:/Hermes/cache/scratch/slimemold-batch1-s6-eac-fix-vitest.json`。
- 修复后 exact review 核对 target `5b474c8e5b47445e9d13f0a525d526b7f5381951`、parent `7cf5c3512493797fdaf86a7de2135caedd5cc2f7`、branch `feat/living-graph-batch1`、tag 与 clean tree 一致，`passed=true`，security/logic/scope findings 均为空；reviewer 未重跑测试，依赖上述同快照 quality-gate evidence。S6 仍只是 caller 提供 acceptance/budget 数值的纯函数，不认证宿主验收或真实花费。所有提交/tag 按计划仍标 `(unverified)`；独立 review 通过不等于用户正式验收；未 push、未 merge。

### 7.398 unverified：恢复可读施工单文本与结构化 Antigravity sidecar（第一批修复 1）

- 起点为 `5770627ea66680373baff594747fbcded72aec85` / `batch1-review-fixes-start-unverified`。`renderTaskContract(lease)` 继续作为 Codex 与 Antigravity 共用的唯一 renderer，改回项目约定 → 模块契约 → 本任务的分段中文文本；多行自由文本逐行引用，空行写 `>`，列表项逐条成行，ContextPack 元数据/内容及 scope 预算与过期时间均保留。Antigravity sidecar 恢复 `task`、`attempt`、`attemptId`、`contextPack`、`dependencyArtifacts` 结构化字段并携带同一 `dataBoundary`，删除 `untrustedData`/`runtime`。
- 首个代码提交 `dbe286e3b6bbace10abae2ace739032453106fdc`（tag `batch1-fix1-unverified`）后，精确 reviewer 指出多项任务依赖应逐项输出。新增回归先 RED（原输出为 `task-a、task-b` 单行），后实现多依赖逐项 bullet；单个依赖仍按计划样例内联。补充提交 `d8dc6e29b18d508880e0e209dfab80d6b34a1d73`，tags `batch1-fix1-list-repair-unverified` 与 `batch1-fix1-reviewed-unverified` 均指向该快照。
- 最终 exact-snapshot reviewer 核对 target `d8dc6e29b18d508880e0e209dfab80d6b34a1d73`、parent `dbe286e3b6bbace10abae2ace739032453106fdc`、branch `feat/living-graph-batch1`、tag 和 clean tree；严格 JSON `passed=true`，security/logic/scope findings 均为空。中间两项格式意见（goal 应用 bullet、dataBoundary 只能含一个句号）不符合计划明确的 blockquote 规则与逐字样例；最终 reviewer 确认 dataBoundary 常量与原文逐字一致。曾有非阻塞建议为连续空行补单独测试，未扩展本切片。
- 验证：聚焦 `npx vitest run src/projectControl/workOrder.test.ts src/dev/antigravityContextBoundary.test.ts src/dev/workerPromptContract.test.ts --reporter=dot` 为 `3 files / 22 tests passed`；最终全量 Vitest exit 1，为 `221 files`（197 passed、24 failed）、`1,356 tests`（1,346 passed、10 failed），10 个失败断言身份与开工基线完全一致，无新增失败。`npm run build` exit 0（2,106 modules，主 bundle 1,304.65 kB / gzip 381.43 kB，保留既有 mixed static/dynamic import 与 >500 kB warnings）；`npx tsc -p tsconfig.app.json --noEmit` exit 0；`npm run i18n:check` 1,112 keys 对齐；`git diff --check` 通过。最终累计 diff 的 518 条新增行扫描中，secret-assignment/eval-exec/shell-execution matches 均为 0。
- 未调用真实模型 API、未启动真实 Worker、未做 Tauri GUI 验收；所有 commit/tag 保持 `(unverified)`，独立 review 不等于用户验收。详细 prompt 前后对比与阶段报告保存在忽略文件 `.hermes/reports/2026-10-11-batch1-review-fixes.md`；未 push、未 merge。

### 7.399 unverified：收紧 B1 试读 fail-closed 并记录 droppedCount（第一批修复 2）

- `PREFLIGHT_PROMPT` 现在要求只输出 JSON 数组，并明确 `severity` 的 `blocking`/`minor` 判定和可选 `options` 字符串数组；`docs/plans/LIVING_GRAPH_AND_SELF_TUNING_PLAN.md` 的 B1 示例与源码 prompt 经脚本比较逐字相同（各 259 字符）。
- `parsePreflightResponse` 仅解包完整 JSON Markdown fence；fence 外文本不做修补。assessment 加 `droppedCount`：JSON/顶层结构无效返回 `unknown/0`；空数组返回 `clear/0`；非空数组无有效项返回 `unknown` 并计入全部丢弃项；有有效项时按有效 severity 判断，保留有效猜测并记录无效项数。完成事件 payload 将该计数持久化。
- RED→GREEN 覆盖所有项缺 severity、quote 不属于原文、有效 blocking + 无效项、合法 fenced JSON、fence 外 prose、空数组、提示词字段，以及事件 payload 的非零 droppedCount。聚焦试读/命令/ProjectControl consistency 为 `3 files / 21 tests passed`。
- 验证：完整 Vitest exit 1，为 `221 files`（197 passed、24 failed）、`1,360 tests`（1,350 passed、10 failed）；10 个失败断言身份与 Fix 1 和开工基线完全一致，无新增失败。`npm run build` exit 0（2,106 modules，主 bundle 1,304.65 kB / gzip 381.43 kB，保留既有 mixed static/dynamic import 与 >500 kB warnings）；`npx tsc -p tsconfig.app.json --noEmit` exit 0；`npm run i18n:check` 1,112 keys 对齐；`git diff --check` 通过。102 条新增行扫描 secret-assignment/eval-exec/shell-execution 均 0。
- Exact review 核对 target `95def9ac18f95ea722fb87cfde63684ecd13c39f`、parent `7688611b720773cad350bc277f00818611ec40fb`、branch、tag 和 clean tree；`passed=true`，security/logic/scope findings 均为空。非阻塞建议：为 `options` 非字符串成员补独立拒绝测试；当前 parser 已按 schema 拒绝，留作后续。没有调用模型或 Worker；所有产出仍为 `(unverified)`，未 push、未 merge。

### 7.400 unverified：scope 未声明任务不再误入 L0（第一批修复 3）

- `triageTaskGraph` 现在要求至少一个任务且每个任务的 `scope` 非空才可进入 L0；未声明任务数写入 reason，并继续按原 L2/L1 规则分类。空任务图单独判为 L1，reason 为 `任务图没有任务`。`TRIAGE_RULES_VERSION` 升为 2，`TaskGraphProposed.payload.triage.rulesVersion` 的命令测试同步断言 2。
- RED→GREEN：三任务 scope 全空回归先失败为 L0 后变为 L1，并包含 `有 3 个任务未声明 scope，不能判为 L0`；空图测试先得到通用 L1 reason，随后通过专用 reason；`recordWorkOrderPreflightCommand` 的空 scope 单模块命令测试先因 L0 被拒绝，修复后记录 shadow 试读事件。单任务空 scope 及既有 helloworld L0/增长违规结果均保留测试覆盖。
- 聚焦 `npx vitest run src/projectControl/triage.test.ts src/projectControl/growthPolicy.test.ts src/projectControl/commands.test.ts src/projectControl/workOrderPreflightCommands.test.ts --reporter=dot` 为 `4 files / 35 tests passed`。
- 验证：完整 Vitest exit 1，为 `221 files`（197 passed、24 failed）、`1,364 tests`（1,354 passed、10 failed）；与 Fix 2/开工基线的 10 个失败断言身份完全一致，无新增失败。`npm run build` exit 0（2,106 modules，主 bundle 1,304.84 kB / gzip 381.52 kB，既有 mixed static/dynamic import 与 >500 kB warnings）；`npx tsc -p tsconfig.app.json --noEmit` exit 0；`npm run i18n:check` 1,112 keys 对齐；`git diff --check` 通过。65 条新增行的 secret-assignment/eval-exec/shell-execution 扫描均为 0。
- Exact review 核对 target `e2ab112c2f335facf860ee98cd640fcc097ad597`、parent `cd39184a5882355ea04deaf283a2f09d52b71014`、branch `feat/living-graph-batch1`、tag 与 clean tree；严格 JSON `passed=true`，security/logic/scope findings 为空。非阻塞建议：补测 scope 未声明但符合 L2 阈值的图仍为 L2 且保留 scope reason；本轮不扩展。未调用模型、Worker 或 GUI；代码与 tags 保持 `(unverified)`，未 push、未 merge。

### 7.401 unverified：ContextPack 尝试身份移出共享施工单（第一批修复 4）

- `renderTaskContract` 移除了含 ContextPack identity 的 attempt-varying 行；新增 `renderContextPackRuntimeInfo`，只在存在 ContextPack 时生成 `ContextPack: contextPackId=… contextVersion=… sourceVersion=… attemptId=…`，并沿用 `singleLine` 防止标识符换行。Codex 与 Antigravity 均在 `Attempt:` 后插入该行；Antigravity 结构化 sidecar 未改。
- RED→GREEN：施工单测试覆盖内部 identity 不出现在 shared contract、同一任务跨不同 attempt/attemptId/taskExecutionId/contextPackId 的输出逐字相同；双 provider prompt 测试覆盖 runtime line 的位置、缺 ContextPack 时省略及 ContextPack 标识符换行压平。最初 targeted RED 为 `2 files / 4 failed`；实现后更新 Codex/Antigravity 两个完整 prompt snapshots；再新增 multiline `contextPackId` 回归先失败、实现 `singleLine` 后通过。最终 focused `5 files / 34 tests passed`。
- Exact review 核对 target `1be58a18f92dddea02502131129abe72ed0da710`、parent `1be02c01bf273015117b4a32b9a3245febca8089`、branch `feat/living-graph-batch1`、clean tree 与 tag；严格 JSON `passed=true`，`security_concerns=[]`、`logic_errors=[]`。非阻塞建议：multiline identifier 回归也覆盖 `attemptId`；实现对 `contextPackId` 与 `attemptId` 均使用 `singleLine`，本轮未扩大范围。
- 最终质量门：`npm run test` exit 1，`221 files`（197 passed、24 failed），`1,367 tests`（1,357 passed、10 failed）；10 个失败身份与切片 0 基线完全一致，无新增失败。`npm run build` exit 0（2,106 modules，主 bundle 1,304.82 kB / gzip 381.51 kB；保留既有 mixed static/dynamic import 与 >500 kB warnings）；`npx tsc -p tsconfig.app.json --noEmit` exit 0；`npm run i18n:check` 1,112 keys 对齐；`git diff --check` 通过。84 条新增行扫描 secret-assignment、eval/exec、shell-execution 均为 0。
- 提交 `1be58a18f92dddea02502131129abe72ed0da710`（parent `1be02c01bf273015117b4a32b9a3245febca8089`）；`batch1-fix4-unverified`、`batch1-fix4-reviewed-unverified`、`checkpoint/fix4-unverified-20261012` 均指向该代码快照。按计划仅删除核验过的 `.hermes/review-tmp/`（唯一普通文件 `fixes.patch`）；未调用真实模型 API、未启动 Worker、未做 GUI 验收、未 push/merge。代码与 tags 仍为 `unverified`。

### 7.402 unverified：为 Vitest worker 初始化 file-backed Web Storage

- 根因：本机 Node `v26.7.0` 将 Vitest fork worker 的 `localStorage` 留为 `undefined`，因为没有提供 `--localstorage-file`。原始 `npm run test` 因此有 20 个文件在收集时触发 `Cannot read properties of undefined (reading 'setItem')`，并有 10 个断言失败；所有失败都由同一 Storage 初始化缺失触发。
- 20 个收集失败文件：`src/components/AgentPanel.test.tsx`；`src/engine/executor.test.ts`、`executorCapability.test.ts`、`executorEvents.test.ts`、`executorIntervene.test.ts`、`executorLifecycle.test.ts`、`nodeLlmAdapter.test.ts`、`pipeline.test.ts`、`runFinalizer.test.ts`；`src/orchestrator/draft.test.ts`、`run.test.ts`；`src/projectControl/projectLifecycleController.test.ts`；`src/store/viewStore.test.ts`、`workflowStore.graphCommands.test.ts`、`workflowStore.newWorkflow.test.ts`、`workflowStore.projectCatalog.test.ts`、`workflowStore.projectControl.test.ts`、`workflowStore.saveAs.test.ts`、`workflowStore.workflowRegistryMutation.test.ts`；`src/nodes/mvp/index.test.ts`。
- 另外 10 个失败断言：`IssueBoard.test.tsx` 的 5 个用例在 `localStorage.setItem` 失败；`agents/experienceStore.test.ts` 的持久化重载用例得到空数组而非 1 项；`io/projectIO.test.ts` 的 3 个 recent-history 用例在 `localStorage.clear` 失败；`platform/env.test.ts` 的取消 folder chooser 用例同样在 `localStorage.clear` 失败。配置提供 file-backed Storage 后，上述集合均完整收集并通过；未改测试、断言、产品代码，也没有 platform-specific skip。
- 修复仅改 `vitest.config.ts`：Node `>=22.4` 时创建每次运行唯一的 ignored `node_modules/.cache/slimemold-vitest-localstorage/` 文件，并向 Vitest forks 传入 `--experimental-webstorage` 与 `--localstorage-file`；较旧 Node 继续使用 jsdom，不传不支持的参数。无新增依赖。
- GREEN 验证：原失败用例聚焦 `5 files / 19 tests passed`；Windows Node `v26.7.0` 的普通 `npm run test` 为 `221 files / 1,497 tests passed`，没有 `localStorage is not available` warning；Windows Node `v22.23.3` 全量 Vitest 同为 `221 / 1,497 passed`；WSL Ubuntu Linux Node `v24.21.0` 的普通 `npm run test` 也为 `221 / 1,497 passed`。Node 22/24 输出仍有 Node 自身的 experimental Web Storage warning。尝试从 WSL npm registry 获取 Node 22 Linux 包时遇到 `ETIMEDOUT`，故本轮未直接运行 Linux Node 22；不把该网络超时归因于产品或测试代码。WSL 首次从 `/mnt/d` 跑测试超过工具时间上限，随后在 Linux ext4 scratch fixture 重跑通过。
- 其余质量门（Windows Node 26）：`npm run build` exit 0（2,106 modules，main bundle 1,304.82 kB / gzip 381.51 kB，保留既有 mixed static/dynamic import 与 >500 kB warnings）；`npx tsc -p tsconfig.app.json --noEmit` exit 0；`npm run i18n:check` 1,112 keys 对齐；`git diff --check` 通过。Exact review target `0a66c2ff7eb3464e782a838aff43b7abddeb3608` / parent `1e7bda45c6b2470d84a49cb3c86f12249a50fc56` 返回 `passed=true`、security/logic findings 为空。提交与 tag 保持 `(unverified)`，无 push/merge。

### 7.403 unverified：第一批整体验证与 GUI 证据边界

- 第一批 exact target 为 `31dc5794a76ef72601c2b00a76ea161b23759c05`（parent `0a66c2ff7eb3464e782a838aff43b7abddeb3608`），base/merge-base `0aedbbf7e7e097f738b0980958dd9ef04069a29b`；完整差异 48 paths。普通 `npm run test` 为 `221 files / 1,497 tests passed`，缺失 `localStorage` warning 为 0；`npm run build` exit 0（2,106 modules，main bundle 1,304.82 kB / gzip 381.51 kB；既有 mixed import / >500 kB warnings）；app tsc exit 0；i18n 1,112 keys；`git diff --check` 通过。
- 独立 exact reviewer 对完整 `0aedbbf..31dc579` 返回严格 JSON `passed=true`、`security_concerns=[]`、`logic_errors=[]`，确认 target/parent/base/tag/clean tree；未运行测试、未改文件。两份前序 review 因 brief 未附全量 field-specific 规格而不采纳；本条只记录带完整逐字上下文的最终 review。非阻塞建议：有限正数 underflow 的 cost-model 回归；shadow L0 晋级 production 前纳入副作用/可逆性/风险事实并补 unscoped-L2 测试；本轮未扩大范围。
- 浏览器隔离预览通过 DOM read-back 观察 advanced/Orchestrator 区域的 en/zh 切换与状态数字；仅保存的截图带欢迎遮罩，关闭后的截图工具 stale/timeout，不能作为无遮罩最终视觉证据。一次轻量入口导航误创建 ProjectSession，挂载 effect 自动调用 `runMasterTurn`/`chatWithAgent`；页面报 `Failed to fetch`，无成功响应，Performance origin 只显示 localhost，但不能据此证明没有出站尝试。没有重试，也没有 Worker 运行。
- 真实 Tauri 启动不白屏，Vite/Rust/窗口均就绪，但应用自动恢复 `D:/Temp/sm-tauri-worker-current-code-20261007` 的 `Tauri Worker disposable verification` 项目，屏幕显示旧失败 Worker 记录与 cleanup identity/worktree restore warnings；启动时宿主自动执行 `grant_project_access`。只读打开了 Orchestrator/Settings，没有 Run、Generate draft、Cleanup、Save 或手动更改项目文件；没有做磁盘前后 read-back，因此不能断言应用启动生命周期没有自动写入。语言切换未完成，计划的真实 Tauri 双语 GUI 门未通过。截图见 `.hermes/reports/assets/slice3-tauri-startup-20261012.png`、`slice3-tauri-orchestrator-readback-20261012.png`、`slice3-tauri-settings-readback-20261012.png`；browser screenshot 为 `slice3-browser-advanced-en-overlay-20261012.png`。
- 仅创建 `checkpoint/living-graph-batch1-unverified-20261012` 指向 `31dc579`；没有 `checkpoint/living-graph-batch1-verified-20261012`，因为 GUI 双语门缺失。Linux Node 22 直接验证仍受 npm registry `ETIMEDOUT` 限制；Windows Node 22 与 Linux Node 24 的全量测试结果来自代码相同的 `0a66c2f`（`31dc579` 为 docs-only descendant），不把 Node 24 冒充 Node 22。

### 7.404 unverified：归档第一批历史标签分类

- 在 `docs/HISTORICAL_UNVERIFIED_TRIAGE.md` 末尾追加 `Living graph batch1（2026-10-11/12）`，逐组登记 40 个 `batch1-*` 与 10 个当轮 checkpoint 标签（共 50 refs / 34 unique targets），包括 docs-only `checkpoint/batch1-triage-unverified-20261012`。旧 refs 未移动或删除。
- 分类区分被后续 bounded repair 替代的 S2/Fix1、B0/B1、S4 placeholder、初始 S6 cost-model 与各 start anchors；仍在当前实现中的 S4/S6/Fix3/Fix4/test-environment snapshots 标为 evidence-missing/environment-blocked，因为最终 GUI 门未闭合。无任何 verified successor；唯一当前批次终态标签仍是 `checkpoint/living-graph-batch1-unverified-20261012` -> `31dc579`。
- Exact reviewer 的两条建议保持 non-blocking；没有据此分类为 concrete-risk。Tauri 自动恢复的外部 fixture 警告及浏览器 ProjectSession 自动 Master 请求尝试分别保留为范围外观察/夜间报告边界偏差，不把它们归因或改写成第一批修复证据。
- 本条为 docs-only 历史分诊记录；不改变代码、branch 或历史 tag。`git diff --check` 通过；脚本核对 50 个目标 tag 均被分类，所有产出保持 `(unverified)`。

### 7.405 unverified：按命令族拆分 ProjectControl commands facade（切片 5）

- `src/projectControl/commands.ts` 在切片基线 `1e2030983bbb606315e9d9a2f5b421f29c0b3855` 为 1,085 行，混合 session/approval、master turn、Issue、project planning 与 TaskGraph 命令。按真实职责将实现移入 `src/projectControl/commands/`：`shared.ts`（28 行）、`issues.ts`（103 行）、`projectPlanning.ts`（162 行）、`session.ts`（317 行）、`masterTurn.ts`（110 行）、`taskGraph.ts`（378 行）；原路径 `commands.ts` 缩为 46 行兼容 re-export facade。`commands.test.ts` 的共享 architecture fixture 移到 `commands.testFixtures.ts`（65 行）；测试文件为 497 行。所有触及文件小于 600 行，最大 owner 为 378 行。
- 保留 issue、planning、session/master-turn、task-graph 命令既有函数体与调用路径；新增 owner 直测分别覆盖 session 初始化事件、master-turn 完成 facts，以及 task-graph proposal 投影和缺失 session 拒绝。独立 reviewer 对原始 28-symbol public export set 做了对照，确认兼容 facade 仍导出相同公共符号；没有删测、skip 或放宽 assertion。Reviewer 另建议为 session/master-turn owner tests 增加 fail-closed cases，作为非阻塞 residual 记录。
- 最终代码 target `edea067da4231bbbabbdc4e81e5bfa6bc8efaa6a`（parent `0401a768af4ed2433c62a5c9171993b6aaa1f378`，slice base `1e2030983bbb606315e9d9a2f5b421f29c0b3855`）。`npm run test`：226 files / 1,503 tests passed；`npm run build`：`tsc -b` 与 Vite 通过、2,112 modules；`npx tsc -p tsconfig.app.json --noEmit` 通过；`npm run i18n:check`：1,112 keys 对齐；`git diff --check` 通过。Build 保留既有 mixed static/dynamic import 和 >500 kB chunk warnings。
- Independent exact review 使用 immutable Git objects，返回严格 JSON：target/clean-tree 匹配，`passed=true`、`security_concerns=[]`、`logic_errors=[]`。非阻塞建议是在 session 与 master-turn owner tests 中增加直接 fail-closed assertions；此建议没有扩大本切片。`checkpoint/split-commands-unverified-20261012` 指向 target `edea067`；根据夜间任务边界，未创建 verified tag，全部产出保持 `(unverified)`。

### 7.406 unverified：按目录职责拆分 AgentPanel（切片 6）

- 切片基线 `083a717a77d4ff19ed86b6758992e948996ec5e8` 的 `src/components/AgentPanel.tsx` 为 1,207 行。按职责拆出 `RolesTab.tsx`（173 行）、`ProviderFields.tsx`（247 行）、`AgentEditorForm.tsx`（327 行）与 `AgentCatalogList.tsx`（211 行）；根组件保留 405 行，测试文件 345 行，所有触及文件低于 500 行。保留原 `AgentPanel` 默认导出、props 与 import 路径。
- 新增/扩展的组件行为测试覆盖角色编辑写入真实 catalog action、浏览器 API-key 字段禁用、编辑表单经 owner callback 写回，以及 catalog 默认 Agent 选择回调；未删测、未跳过或放宽断言。`npx vitest run src/components/AgentPanel.test.tsx` 通过。
- 最终代码 target `b9977aae28e285f4e2edcc099b6896360c3aa74e`（parent `f8f328bc17ec780ee297aa10e092f7a65a41adbc`，slice base `083a717a77d4ff19ed86b6758992e948996ec5e8`）。`npm run test`：226 files / 1,507 tests passed；`npm run build` 通过；`npx tsc -p tsconfig.app.json --noEmit` 通过；`npm run i18n:check`：1,112 keys 对齐；`git diff --check` 通过。Build 保留既有 mixed static/dynamic import 与 >500 kB chunk warnings。新增行 secret-assignment、shell-execution、dynamic-eval 扫描均为 0。
- Exact reviewer 只读 immutable Git objects，target/parent 匹配且工作树 clean；严格 JSON `passed=true`、`security_concerns=[]`、`logic_errors=[]`。建议在标 verified 前完成计划要求的浏览器截图；该建议现已通过下述同代码 HEAD read-back 闭合。
- 浏览器预览在未改变的 code HEAD `b9977aae28e285f4e2edcc099b6896360c3aa74e` 上，通过本地 Vite `http://127.0.0.1:1420` 打开 Settings → Agents；为到达面板，只在隔离浏览器上下文中创建了无磁盘路径的空白项目，然后选中默认 Ollama Agent 显示编辑表单。截图 `.hermes/reports/assets/slice6-agentpanel-preview-20261012.png`（900×566）可读回设置导航、Agent 列表与编辑表单。仅作浏览器视觉预览，不代表真实 Tauri/native 验收；没有触发运行、Worker、模型探测或模型拉取。
- `checkpoint/split-agentpanel-unverified-20261012` 指向代码 target `b9977aa`。虽然测试、build、类型检查、独立 review 与浏览器预览均通过，本夜间任务要求产出保持 `(unverified)`，因此没有创建 verified tag。

### 7.407 unverified：WorkflowEditor 拆分前特征测试（切片 7）

- 切片基线为 `d27b702f45c3460939c105fffa737b5796e27b97`，`src/canvas/WorkflowEditor.tsx` 为 1,185 行；先前没有该组件的直接行为测试。新增 `src/canvas/WorkflowEditor.test.tsx`，覆盖空画布新建项目 owner callback、选择 starter template 后通过真实 store 写入工作流图，以及主画布复用 App provider / split 画布隔离 provider 与 run dispatch。
- 在未拆分的现有组件上，`npx vitest run src/canvas/WorkflowEditor.test.tsx --reporter=dot`：1 file / 3 tests passed；这组 characterization tests 先于生产代码移动通过，后续拆分必须继续保持通过。测试的 `runWorkflow` 使用 mock，不启动真实执行或 Worker；store fixture 设置 `projectPath: null`，不写项目文件。
- 本提交范围仅为特征测试与本条验证记录；生产代码尚未移动，完整质量门留到 Slice 7 最终实现快照。

### 7.408 unverified：补充 WorkflowEditor 分栏图同步特征（切片 7）

- 在独立分栏工作流测试中加入非空节点图 fixture，断言首次挂载后目标工作流仍保留原节点，并通过 React Flow `onNodesChange` callback 移动节点后读回同一 `wfId` 的写回位置。测试使用真实 `ReactFlowProvider` / Zustand store，ReactFlow 渲染器本身由测试 mock，不启动模型或 Worker。
- 未拆分的现有组件基线下，`npx vitest run src/canvas/WorkflowEditor.test.tsx --reporter=dot`：1 file / 4 tests passed；其中主画布共享 provider、分栏 provider 隔离、starter template 实际 store 变更和首帧保留/编辑写回均有直接覆盖。`npm run build`（`tsc -b` 与 Vite，2,116 modules）、`npx tsc -p tsconfig.app.json --noEmit` 与 `git diff --check` 均通过；build 仍有既有 mixed static/dynamic import 与 >500 kB chunk warnings。生产代码尚未修改，完整质量门仍留到最终实现快照。

### 7.409 unverified：分栏目标切换特征与基线质量门（切片 7）

- 增加相同节点结构指纹、不同工作流标签时切换 `wfId` 的特征测试；未拆分的现有组件在目标切换后正确显示新工作流。focused 测试：1 file / 5 tests passed；测试仅使用内存项目与 mock 执行器。
- 当前未拆分基线完整验证：`npm run test -- --reporter=dot` 为 227 files / 1,512 tests passed；`npm run build`（`tsc -b` + Vite，2,116 modules）、`npx tsc -p tsconfig.app.json --noEmit`、`npm run i18n:check`（1,112 keys）与 `git diff --check` 均通过。保留既有 mixed static/dynamic import、>500 kB chunk warnings；测试中 GUI 初始化失败 stderr 属于既有受测错误路径，测试通过。
- 只读拓扑盘点提示 split `onReconnect` 的 cycle check 读取 active `st.edges`，其分栏 scope 语义未覆盖；本结构切片不修复、不重定义该行为，作为后续独立核验项记录。生产代码尚未拆分，浏览器预览、Tauri/native 验收与 exact review 均未完成；保持 unverified。

### 7.410 unverified：OrchestratorPanel 拆分前特征测试（切片 8）

- 新增 `src/components/OrchestratorPanel.test.tsx`，覆盖目标输入经真实 `createDraftOrchestration` 写入 `awaiting-confirm` store、mock executor rejection 后清理 busy 并显示错误，以及 modal / `embedded` 容器切换。测试保留真实 Zustand 与编排确认逻辑；只 mock `runOrchestration`，项目 `projectPath: null`，不触发 Worker、模型 API 或 Tauri。
- 未拆分基线 focused 测试 `npx vitest run src/components/OrchestratorPanel.test.tsx --reporter=dot`：1 file / 3 tests passed；全量 `npm run test -- --reporter=dot`：228 files / 1,515 tests passed。`npm run build`（`tsc -b` + Vite，2,116 modules）、`npx tsc -p tsconfig.app.json --noEmit`、`npm run i18n:check`（1,112 keys）和 `git diff --check` 均通过。保留既有 mixed static/dynamic import、>500 kB chunk warnings；全量测试中既有 GUI 初始化失败路径仍写 stderr，但对应测试通过。
- 本次仅为特征测试与基线验证，`OrchestratorPanel.tsx` 生产代码尚未移动；UI 预览/exact review 留到生产拆分最终快照，产出保持 unverified。

### 7.411 unverified：OrchestratorPanel 生产拆分时间盒止损（切片 8）

- 在未改变 controller 行为的尝试中，曾将 WorkerRun evidence/recovery/cleanup 显示拆到 `WorkerRunsView` 并抽取共享状态样式/props contract；中间快照下 `npx vitest run src/components/OrchestratorPanel.test.tsx --reporter=dot` 为 1 file / 3 tests passed，`npm run build`（`tsc -b` + Vite，2,118 modules）通过并保留既有 import/chunk warnings。
- 60 分钟预算到期时，尚未完成将主面板降到 ≤600 行，也未完成全量质量门、浏览器预览或 exact review。按止损边界，撤回未提交的 `OrchestratorPanel.tsx` 修改并移除新建但未接入/未提交的 owner 文件；没有生产代码 commit。当前权威快照仍为测试 commit `2a165a1f69f93cea8648c1041c03764a0f248012`，生产组件保持 997 行，Slice 8 仅完成特征测试与未拆分基线门，状态为部分/unverified。

### 7.412 unverified：ProjectSessionPanel 拆分提前止损（切片 9，45 分钟上限内约 31.5 分钟）

- 在 start checkpoint `2f71acc31eb3e726eb79adff64dd50f979ec4a78` 上完成只读盘点：生产调用来自 `BeginnerExperience.tsx`；现有直接测试 12 项覆盖首轮 Master turn、保存/事件、Brief/Architecture/TaskGraph/Orchestration、queued Worker runtime 与部分 recovery。store/save、Master turn、runtime dispatch 和 recovery eligibility 均留在现有 controller owner 是最低风险边界；视图抽取不得把这些副作用移入展示层。
- 曾短暂创建 header/conversation/sidebar/contracts 展示模块并提前移动 `sessionStatusKey` helper，旧 JSX 尚未替换时 focused 测试 1 file / 12 tests 全部因 `ReferenceError: sessionStatusKey is not defined` 失败。该快照是不完整的编辑中状态；随后撤回 `ProjectSessionPanel.tsx` 改动并删除所有新文件，没有留下生产代码修改。
- 撤回后在精确 start HEAD 重跑 `npx vitest run src/components/ProjectSessionPanel.test.tsx --reporter=dot`：1 file / 12 tests passed；当前组件仍为 867 行，worktree clean。约 31.5 分钟后，剩余 13.5 分钟不足以同时达到视图 owner 接线、≤600 行、全量门禁与 exact review，因此在 45 分钟上限内提前止损；没有源代码 commit、截图、全量 post-split 门禁或 reviewer verdict，状态为部分/unverified。

### 7.413 unverified：BeginnerExperience 按页面职责拆分（切片 10）

- 保持 `BeginnerExperience.tsx` 为稳定默认导出和路由协调器；新建 `beginner/WorkspaceHome.tsx` 承接 home/recent-project 状态及既有 `projectIO` 调用，新建 `beginner/ProjectCockpit.tsx` 承接 cockpit selectors、run/stop、workflow switching 与私有展示叶子，新建 `beginner/BeginnerHeader.tsx` 唯一承接两页共享导航头和日期格式化。App props、页面状态 effect、子页回调、store/IO/executor API 均保持原有调用路径/顺序；不触发模型、Worker、Tauri 或网络操作。与 start HEAD 的 `WorkspaceHome`、`ProjectCockpit`/私有叶子、`SimpleHeader` 和 `formatDate` 函数体逐段文本比对均完全一致。拆分后行数：facade 81、BeginnerHeader 61、WorkspaceHome 258、ProjectCockpit 373。
- 拆分前/后 focused `npx vitest run src/components/BeginnerExperience.test.tsx --reporter=dot` 均为 1 file / 2 tests passed。`npm run build`（`tsc -b` + Vite，2,119 modules）通过；`npx tsc -p tsconfig.app.json --noEmit` 和 `npx tsc --noEmit` 通过；`npm run i18n:check` 1,112 keys 对齐；`git diff --check` 通过。保留已有 mixed static/dynamic import 与 >500 kB chunk warnings（main bundle 1,305.82 kB / gzip 382.16 kB）。
- 一次完整 `npm run test -- --reporter=dot` 为 227/228 files、1,514/1,515 tests，唯一失败为未修改的 `WorkflowEditor.test.tsx`（target-switch characterization）；同文件单独复跑也失败一次。随后同一未改代码快照完整重跑为 228/228 files、1,515/1,515 tests passed，包含该测试；未改 Slice 7 代码或测试，原因未确定，故如实保留为间歇性全量门风险。
- 浏览器预览打开默认 beginner home，无 Tauri/native 验收；截图 read-back 存在 `.hermes/reports/assets/slice10-beginner-preview-20261012.png`。code checkpoint保持unverified；review disposition见7.414。

### 7.414 unverified：BeginnerExperience exact-snapshot review disposition（切片 10）

- 独立只读 reviewer 针对 target `33b7b14185c34303670b7fe40c597cae5baca7b2` / parent `ee49a7842de76189f8fdb9669c477feac52ad272` 返回严格 JSON：`passed=true`、`working_tree_clean=true`、`security_concerns=[]`、`logic_errors=[]`；复核确认 facade 路由/props/callback、Home projectIO 顺序、Cockpit selectors/run/stop、shared header 与移出实现保持语义一致，无 reverse import 或重复 owner。
- Reviewer 的一条非阻塞建议是追查 `WorkflowEditor` target-switch 测试的间歇性失败。最终全量重跑通过，但首轮 full 和 standalone run 曾失败，原因仍未知；此风险不在 Slice10 内修复。评审/质量门不等于用户验收；根据夜间任务要求，代码 commit 与 tags 仍保持 unverified，浏览器预览不作 Tauri/native 证据。

### 7.415 unverified：SettingsCenter 拆分前 characterization baseline（切片 11）

- 新增 `src/components/SettingsCenter.test.tsx`，不改生产文件：覆盖 modal 内外/ESC close、切换 Flow 后真实 `workflowStore.failFast` 更新，以及模拟 API-key vault recheck 的 deferred fetch rejection（spinner 进入/清除并展示错误）。credential/model/Tauri 边界全部 mock，无真实密钥、IPC 或网络调用。
- 拆分前 focused `npx vitest run src/components/SettingsCenter.test.tsx --reporter=dot` 为 1 file / 3 tests passed；全量 `npm run test -- --reporter=dot` 为 229 files / 1,518 tests passed。SettingsCenter production split 尚未开始，测试和 baseline 保持 unverified。

### 7.416 unverified：SettingsCenter API keys owner extraction（切片 11）

- 将 `ApiKeysSection` 与其 `PROTOCOLS`/`VENDOR_COLOR` 常量搬到 `src/components/settings/ApiKeysSection.tsx`；原 `SettingsCenter` 保留模态与其他设置区，通过原组件名/default export 接入新 owner。拆出的 JSX、状态和副作用均按 start HEAD 原文搬移，仅新增 default export；与原函数区间做逐字对比，函数体/常量一致。旧组件 741→460 行，新 owner 279 行，characterization test 192 行，均低于 600 行。
- Slice11 characterization test 在移动前 focused 1 file / 3 tests 通过；移动后同一 focused test 仍为 1 file / 3 tests passed。移动后 `npm run test -- --reporter=dot` exit 0；当前恢复的工具摘要未保留本次全量的计数行，故不以拆分前基线替代本次数字。`npm run build`、`npx tsc -p tsconfig.app.json --noEmit`、`npx tsc --noEmit`、`npm run i18n:check`（1,112 keys）和 `git diff --check` 均通过。
- Browser 预览导航到隔离浏览器的 advanced shell；capture 调用返回 `Page.captureScreenshot timed out after 60s waiting for the daemon`，未取得 SettingsCenter 截图，故计划要求的 preview gate 未完成。未新建项目、未触发真实 Tauri/credential/network/model/Worker 操作；Vite 进程已终止且 1420/1421 端口空闲。此 Slice 仍为 unverified，GUI evidence 与 exact review 尚缺。
- 时间盒边界偏差：本切片从 13:20:00 开始，45 分钟截止为 14:05:00；生产代码 commit `d1b074a479fddb7222fd49552a1999c0a6b75a8a` 的 Git 时间为 14:08:50（超出 3 分 50 秒）。已保留该 unverified commit/tag 作为事实记录；没有改写历史，未继续派发 exact review，也不将该切片升级为 verified。

### 7.417 unverified：TopBar menu row 与快捷键职责抽取（切片 12）

- 从 `TopBar.tsx` 抽出 presentation-only `TopBarMenuRow`（菜单行与本地菜单/子菜单状态）及 `useTopBarKeyboardShortcuts`（window key listener lifecycle）；Project/Workflow/store/executor/host handlers 留在原 facade。行数：TopBar 686→488、MenuRow 221、shortcut hook 31、直接 characterization test 183，均低于 UI 500/文件 600 行目标。保留 TopBar default export/props。
- 拆分前 focused characterization 为 1 file / 3 tests，full baseline 为 230 files / 1,521 tests passed；快捷键 tracer 后 focused 为 1 file / 4 tests passed。拆分后 `npm run build`（2,122 modules）、app/project tsc、i18n 1,112 keys、diff-check 通过。Full Vitest 两次未过：一次为既有 `WorkflowEditor.test.tsx` target-switch（1/1,522 failed）；第二次同一失败并另有 `nodeLlmAdapter.test.ts` collection `disk I/O error`（1 failed test/1 failed suite）。未删改相关断言，故 full gate 未闭合。
- Browser advanced preview 的 DOM 可达；欢迎遮罩关闭后 `Page.captureScreenshot` 再次发生 60s Browser Use daemon timeout，无截图文件。未启动 Tauri、未触发项目/Workflow/Worker/model 操作。Slice12 45 分钟截止 14:59:29 前保持 unverified；本轮不宣称 GUI evidence 或 exact review 通过。
- 时间盒边界偏差：Slice12 从 14:14:29 起算，14:59:29 截止；生产代码 commit `303214af67ca75b43fde1b7aa210d8994ea0644f` 的 Git 时间为 15:01:21（超时 1 分 52 秒）。保留该 unverified commit/tag 作为审计记录，未改写历史；截图、full Vitest 与 exact review gates 均不声称通过。

### 7.418 unverified：夜间任务真实 Tauri closeout read-back

- 在 closeout checkpoint `2f5d3b9f46b68ee69090705483edca99fcc547d8` 上启动 `npm run tauri dev`：Vite 287 ms ready，Rust dev build 0.98 s，出现 `target/debug/slime-mold.exe`。CUA 窗口枚举和真实截图确认 SlimeMold 窗口可见，TopBar 与 SettingsCenter（General tab）可打开；截图保存在忽略目录 `.hermes/reports/assets/tauri-closeout-topbar-readback-20261012.png`、`tauri-closeout-settings-readback-20261012.png`。未打开 API Keys、未点击 Run/Save/Cleanup，未触发 Worker。
- 启动自动恢复 `D:/Temp/sm-tauri-worker-current-code-20261007` 并记录 `grant_project_access ok`；这属于观察到的 startup side effect，不能声称本次 GUI readback 零副作用。UI 保留既有 Worker cleanup native-identity/read-back 与 Git worktree registration 警告；没有修改或清理该 fixture/worktree。关闭本轮启动的 Tauri/Vite 后确认 1420/1421 端口释放。
- closeout 最后一次 `npm run test -- --reporter=dot` 仍 exit 1：230 files 中 229 passed/1 failed；1,522 tests 中 1,521 passed/1 failed。失败为 `src/platform/env.test.ts` 的 `localStorage.clear()` `disk I/O error`。此前两次同代码快照 full run分别记录未修改 `WorkflowEditor` target-switch 失败，以及该失败加 `nodeLlmAdapter.test.ts` collection disk I/O error。不得据此宣称 full Vitest 通过。代码快照既有 build（2,122 modules）、app/project tsc、i18n 1,112 keys、diff-check 通过；TopBar focused 4/4。
- final targeted readback：`npx vitest run src/platform/env.test.ts --reporter=dot` 1/1 passed；`npx vitest run src/canvas/WorkflowEditor.test.tsx --reporter=dot` 4/5 passed，target-switch case 再次失败（期望 Workflow B、实际 Workflow A）。localStorage disk I/O 在单文件运行时未复现；其全量失败原因仍未知。未修改这两个 scope 外的测试/产品代码。
- Slice11/12 GUI 与 exact-review 缺口、full-suite 不稳定、既有恢复告警均未满足计划的最终 acceptance；closeout 仅完成 Tauri read-back/报告，整轮保持 unverified，不自动升级任何 tag。

### 7.419 unverified：WorkflowEditor target-switch 同步修复（结构拆分仍待续）

- 新一轮 Slice7 结构拆分侦察于 15:27:34 启动。75 分钟预算内还需覆盖 1,185→≤600 行的职责拆分、同快照全量质量门、浏览器预览和 exact review；事实盘点阶段发现回归并完成最小 RED 后，判断剩余预算不足以闭合全部验收，因此在生产拆分前停止，未对 WorkflowEditor 作结构移动。
- 原 target-switch characterization 测试曾通过/失败不定，最小诊断发现两次同步 `newWorkflowInProject` 可能生成同一 ID：`workflowRegistryActions.ts:66` 使用 `wf-${deps.now() + 1}`，本次实测两次均为 `wf-1791790577794`。测试现改为使用确定性的两个 workflow fixture，隔离该 ID 生成问题；本轮没有改 registry/store 行为。
- 使用确定性不同 ID 后，same-fingerprint regression 稳定复现：从 A 切到 B 时，`splitSigRef` 只记录图指纹、不含 wfId；目标 reset effect 在 loader effect 之后执行，loader 因相同指纹提前返回，而 ref 清除不会触发重渲染，故画布继续显示 A。修复仅把既有目标切换 reset effect 移到 loader effect 前；保留组件 props、provider、store action 和不同指纹载入/写回合同。新增不同指纹切换 read-back，断言画布与 store 均仍为 B。
- focused `WorkflowEditor.test.tsx` 为 1 file / 6 tests passed；两个 target-switch regression 连续 10 次均为 2/2 passed。完整 `npm run test -- --reporter=dot` 为 230 files / 1,523 tests passed。`npm run build`（2,122 modules）、app/project TypeScript checks、i18n（1,112 keys）、`git diff --check` 均通过；build 保留既有 mixed static/dynamic import 与 >500 kB chunk warnings。
- 提交时该 behavior-fix snapshot 尚无 exact reviewer，未做新的浏览器/Tauri preview；所有提交/tag 保持 unverified。`WorkflowEditor.tsx` 仍为 1,185 行，结构拆分与 GUI preview 仍需单独 fresh 75 分钟预算；`newWorkflowInProject` 同毫秒 ID collision 只作为独立 store 风险记录，未在本轮修复。

### 7.420 unverified：WorkflowEditor target-switch exact review disposition

- 独立 reviewer 以 immutable Git objects 审查 target `3399c539dadb76c18e52f4539a913353d789f77d`、parent `46ca18762fe1a2379c077980a81aceb96971421f` 及三个 scope paths；返回严格 JSON：`working_tree_clean=true`、`passed=true`、`security_concerns=[]`、`logic_errors=[]`、`suggestions=[]`。Reviewer 未运行测试、未改文件或 refs。
- reviewer 返回后 read-back：分支仍为 `refactor/monolith-split-2`，HEAD 仍为 target、父提交关系与 reflog 未变、工作树干净；`checkpoint/fix-workfloweditor-target-switch-unverified-20261012` 与新 tag `checkpoint/fix-workfloweditor-target-switch-reviewed-unverified-20261012` 均指向同一 code target。
- review 仅闭合该 behavior-fix 的 exact-code review；未做 browser/Tauri preview，未完成 1,185 行 `WorkflowEditor` 结构拆分，整轮仍按计划保持 unverified，不创建 verified tag。

### 7.421 unverified：WorkflowEditor 第二次结构拆分窗口止损

- fresh Slice7 window 从 16:19:03 至 17:34:03（75 分钟）执行，start checkpoint/tag 为 `c6e793f36d6f4efec47849b137df5928acf93afd` / `checkpoint/split-workfloweditor-resume2-start-20261012`。基于只读 owner map，临时抽取 `CanvasWelcomeSurface`、`CanvasPanelControls`、`useCanvasGraphProjection`、`useCanvasNodePicker`、`useCanvasContextMenu`；临时测得父组件 572 行，5 个新模块分别 174/196/125/144/170 行，低于文件行数上限。
- focused `WorkflowEditor.test.tsx` 与 `workflowEdgeProjection.test.ts` 在中间快照为 2 files / 9 tests passed。第一次 `npm run build` 因父组件残留未使用 `CAT_COLORS` 失败；移除后第二次 build 报 `WorkflowEditor.tsx` 的 context-menu handler 参数类型不兼容（`ReactMouseEvent` 与 `MouseEvent | React.MouseEvent`）。在 17:34:03 截止后追加了一次类型修正，但没有再次构建验证；不把该中间代码树描述为通过。
- 未跑全量 Vitest、同快照 browser preview 或 exact reviewer。结构变更未提交；随后将 `WorkflowEditor.tsx` 精确恢复到 start target，并删除本轮新建的五个未跟踪模块。read-back：HEAD 仍为 `c6e793f36d6f4efec47849b137df5928acf93afd`、分支仍为 `refactor/monolith-split-2`、工作树干净；未运行 `git clean`，未改动任何既有 tag/worktree。结构拆分仍未完成，后续须另开 fresh bounded window。

### 7.422 unverified：OrchestratorPanel Slice8 resume 可行性止损

- Slice8 resume checkpoint `6635d60259a2895efa1dab91e8333c7079c744bb` 于 17:47:43 创建，原计划60分钟硬截止18:47:43。两份独立只读审计均锁定该 immutable target；未 checkout、编辑、运行测试或移动 refs。
- 生产 caller 为 `App.tsx → LeftSidebar/SidePanel → OrchestratorPanel(embedded)`。store reads/writes、所有命令与异步 handlers、跨 list/detail 保留的 local state、error/busy/finally、TaskGraph selection/revision/save 顺序、Recovery/Cleanup callback gates 必须留在 facade；新 views 只接收受控 props，不读 store、不调用 controller。候选边界为 list/form、stage+TaskGraph preview/revision、WorkerRun/evidence/recovery/cleanup；不能只抽约155行 WorkerRun JSX。估计三块整体可使 facade 达约570–590行，但需实做验证。
- 当前 panel direct tests 为3项：真实 draft store mutation、executor rejection 后 busy/error、modal/embedded container。缺失 binding/preparation/confirmation/cancel/removal、panel recovery/cleanup callback routing、TaskGraph selection 和 revision-save ordering 的直接覆盖。邻近 helper/controller tests 不替代这些 UI wiring tests。
- 18:05:57 时该60分钟窗口还余41分46秒；只读审计评估安全完成抽取、补必要特征测试、focused/full quality gates、same-snapshot browser preview 与 exact review需75–95分钟。无法在计划预算内满足全部验收，因此未开始生产修改，未运行测试，也没有截图或review verdict。停止时 HEAD 仍为 start target、生产文件未变；本节仅记录 partial/unverified。若之后重开 Slice8，需先由用户明确决定维持60分钟且继续标 partial，或批准独立75–95分钟窗口；不能自行扩大本切片预算。

### 7.423 unverified：ProjectSessionPanel 受控视图拆分

- fresh Slice9 window 从18:13:55至18:58:55（45分钟）；start target/tag 为 `1724f1bf05c9668c7edfc27696e157db9fc38cec` / `checkpoint/split-projectsession-resume2-start-20261012`。在未改动前运行 focused baseline：`ProjectSessionPanel.test.tsx` 1 file / 12 tests passed；pre-split full `npm run test -- --reporter=dot` 为230 files / 1,523 tests passed。
- 将原 `ProjectSessionPanel.tsx` 的受控UI JSX与纯列表展示组件抽到 `src/components/projectSession/ProjectSessionPanelView.tsx`。store selectors、Master turn、event recording/save 顺序、brief/architecture/task-graph commands、Worker queue/runtime安装与dispatch、recovery eligibility/handlers、全部busy/error/finally以及原 public props 留在facade；`sessionStatusKey`仍由facade计算为`sessionStatusLabel`传给view，避免helper未接线。父文件 867→543 行，新view 486行（均≤600；后续若扩大应继续按 conversation/sidebar 与 controller boundaries 准备细分）。
- post-split focused为1 file / 12 tests passed；post-split full为230 files / 1,523 tests passed；`npm run build`（`tsc -b` + Vite，2,123 modules）、app/project `tsc --noEmit`、i18n（1,112 keys）和 `git diff --check` 均通过。构建保留既有 mixed static/dynamic import 与 >500 kB chunk warnings。
- browser visual-only preview捕获至 `.hermes/reports/assets/slice9-projectsession-preview-20261012.png`，使用该view的静态 props harness；未挂载ProjectSessionPanel controller、未调用Master、未运行Worker，截图只证明此view的渲染外观。临时 harness文件已移除，Vite已停止，1420端口关闭。
- code target `9bfa3531f6a37baefb7d2d9861cb0d4b46c1f46f`、parent `1724f1bf05c9668c7edfc27696e157db9fc38cec`。Exact immutable review严格JSON返回 `working_tree_clean=true`、`passed=true`、security/logic findings为空；suggestions指出view只有`import type`引用Worker runtime类型（当前无runtime dependency，未按建议扩大本slice）以及静态截图不证明controller/Worker/native acceptance。Reviewer未运行tests/build；以上质量门由本轮命令单独实测。`checkpoint/split-projectsession-panel-unverified-20261012` 与 `checkpoint/split-projectsession-panel-reviewed-unverified-20261012` 均指向code target。计划要求产出保持unverified，未升级验收状态。

### 7.424 unverified：SettingsCenter API Keys 预览与 exact review 收口

- Slice11 resume checkpoint `b7293016edff6ff162ba743142075686b3544204` 于18:51:57创建，预算45分钟、硬截止19:36:57。核对 `SettingsCenter.tsx`、`settings/ApiKeysSection.tsx`、`SettingsCenter.test.tsx` 在当前 HEAD 与 code target `d1b074a479fddb7222fd49552a1999c0a6b75a8a` 完全一致；target parent 为 `2f6e5072463dad40c6843d8d053af6c82432ca7e`，未改生产代码。
- 隔离的静态 SettingsCenter preview只挂载General/APIKEYS UI；在非Tauri浏览器中APIKeys仅显示web-only说明和空列表，未调用vault、未保存/验证/删除凭据、未触发网络/模型或Worker。Browser Use 的 `Page.captureScreenshot` 于本窗口再次在60秒后daemon timeout；没有重试同一路径，改用已安装Chrome headless CLI完成一次视觉捕获，保存 `.hermes/reports/assets/slice11-settingscenter-preview-20261012.png`。回读显示APIKEYS内容区、空接入点和web-only提示，没有敏感凭据；静态preview左导航高亮仍显示General，因此该图仅作局部视觉证据，不声称导航交互或Tauri验收。临时preview harness已删除；Vite进程经命令行核验属于本checkout后停止，1420端口无listener，工作树干净。
- 当前 SettingsCenter focused re-run：1 file / 3 tests passed；i18n 1,112 keys、diff-check passed。此前同一 Settings 文件快照的 full/build/app+project tsc 门曾 exit 0，但 full 数字未保留；本轮后续 descendant（Settings文件与 `d1b074a` 相同）full为230 files / 1,523 tests，build 2,123 modules、app/project tsc、i18n 1,112、diff-check通过。不要把后续 descendant 结果改写成历史 target 的精确测试计数。
- Exact immutable reviewer对target/parent返回 strict JSON：`working_tree_clean=true`、`passed=true`、security/logic lists为空；建议一个非阻塞后续：`loadVaultKey` 拒绝时 recheck loading indicator 可能不清理。未把该既有行为扩展进本结构收尾；reviewer未运行测试。`checkpoint/split-settingscenter-unverified-20261012` 与 `checkpoint/split-settingscenter-reviewed-unverified-20261012` 均指向 `d1b074a...`。Slice保持unverified，无真实Tauri/native验收。

### 7.425 unverified：TopBar preview 与 exact review 收口

- Slice12 resume checkpoint `21433f0113f81035fce5850f2c1801e9f8451fbb` 于19:19:58创建，预算45分钟、硬截止20:04:58。TopBar相关4个文件与 code target `303214af67ca75b43fde1b7aa210d8994ea0644f` 完全一致，target parent `cf709ba3467e197f033cb2714bb7bc4fb25d303f`；本窗口没有生产代码修改。
- 独立headless Chrome静态props预览捕获并回读 `.hermes/reports/assets/slice12-topbar-preview-20261012.png`：可见菜单行、打开的File菜单和工具栏；未打开项目、点击执行、运行Worker或触发model API。临时preview harness已删除，Vite进程经路径核验后停止，1420端口关闭。
- 当前 focused `TopBar.test.tsx`：1 file / 4 tests passed；当前 `git diff --check` 通过。之后代码未改动TopBar；最近 descendant full suite为230 files / 1,523 tests passed，build为2,123 modules、app/project tsc、i18n 1,112 keys及diff-check通过。Reviewer未运行tests/build。
- Exact immutable review对target/parent返回 strict JSON：`head`匹配、`working_tree_clean=true`、`passed=true`、security/logic lists为空。两个非阻塞suggestions：继承的keyboard effect依赖未包含 `handleNewProject`，prop在flow actions稳定时替换可能调用旧callback；以及为zoom/fit-view快捷键补 preventDefault tests。该结构slice未改变旧快捷键逻辑，不在本轮扩大修复。`checkpoint/split-topbar-unverified-20261012` 与 `checkpoint/split-topbar-reviewed-unverified-20261012` 均指向 `303214a...`；仍无Tauri/native验收，保持unverified。

### 7.426 unverified：night-run 最终状态对账

- Closeout resume checkpoint `23d6c614965b06513eb79bd50976f3ab754da956` 于19:42:00创建。当前代码源未在本轮再次修改；最终 `npm run test -- --reporter=dot`：230 files / 1,523 tests passed；`npm run build`：`tsc -b`及Vite成功、2,123 modules；app/project `tsc --noEmit`、i18n（1,112 keys）、`git diff --check`均通过。保留既有mixed static/dynamic import与>500 kB chunk warnings，以及有对应断言通过的GUI测试stderr，不计为新增失败。
- 回读当前分支 `refactor/monolith-split-2`、HEAD `23d6c614965b06513eb79bd50976f3ab754da956`，工作树干净；S9、S11、S12 preview assets存在；1420端口没有listener。没有再次启动Tauri、访问项目/Worker数据、清理worktree、push、merge或rebase。此前Tauri closeout的Startup grant side effect与既有Worker fixture记录保留；旧Tauri截图不是当前代码snapshot的native验收。
- Reviewer/代码状态对账：S9 `9bfa353...`、S11 `d1b074a...`、S12 `303214a...` 的reviewed-unverified refs分别指向对应code targets；S9/S11/S12均有非阻塞suggestions，见各自编号小节。Slice7 WorkflowEditor生产结构拆分仍未完成；Slice8 OrchestratorPanel生产拆分未开始，必须由用户决定是否另批75–95分钟（原cap为60分钟）；Slice3双语GUI门与整体真实Tauri/native验收仍未闭合。测试/构建通过不升级这些状态；全轮不标verified，也不宣称最终acceptance完成。

### 7.427 unverified：WorkflowEditor Slice7 resume3 结构拆分

- Fresh Slice7 checkpoint/tag `a484dc84e5a8e36728cb010a8aac96b661f1fdf4` / `checkpoint/split-workfloweditor-resume3-start-20261012` 于19:55:57创建，硬截止21:10:57。开始前重新确认 `WorkflowEditor.tsx` 与已审计的 resume2 source 相同，characterization baseline `WorkflowEditor.test.tsx` + `workflowEdgeProjection.test.ts` 为2 files / 9 tests passed。生产代码仅按五个 UI/projection owner 机械移动：`CanvasWelcomeSurface.tsx` 174行、`CanvasPanelControls.tsx` 196行、`useCanvasGraphProjection.ts` 125行、`useCanvasNodePicker.tsx` 144行、`useCanvasContextMenu.tsx` 169行；facade从1,185降为570行（满足本slice ≤600硬上限；仍高于偏好的≤500，>400行后续需准备继续拆分）。
- `src/i18n/uiChineseLiterals.test.ts` 的allowlist未删减或放宽：六个 persisted node-category literal exceptions 随其 owner 从WorkflowEditor移至CanvasPanelControls；同时把新增canvas UI owner加入同一静态汉字/翻译扫描范围。第一次post-move full run因此发现旧路径allowlist stale（230 files中1 failure）；更新owner路径并扩展扫描后，focused locale test 3/3通过，最终full 230 files / 1,523 tests全部通过。
- 最终质量门：WorkflowEditor + edge projection focused 2 files / 9 tests passed；locale-literal focused 1 file / 3 tests passed；`npm run test -- --reporter=dot` 230 files / 1,523 tests passed；`npm run build`（2,128 modules，`tsc -b`与Vite成功）；app/project `npx tsc --noEmit`通过；`npm run i18n:check` 1,112 keys通过；`git diff --check`通过。保留既有mixed static/dynamic import与>500kB chunk warnings及有断言通过的GUI测试stderr，不描述为新增失败。
- Same-snapshot静态Chrome预览截图已read-back：`.hermes/reports/assets/slice7-workfloweditor-welcome-preview-20261012.png`显示欢迎卡/模板；`.hermes/reports/assets/slice7-workfloweditor-canvas-preview-20261012.png`显示画布和抽出的controls。Canvas截图另可见Companion摘要窗；没有点击项目/运行/Worker/model，未打开真实项目。页面使用隔离Chrome profile及临时store fixture；两个preview harness文件已移除。Vite残留子进程经命令行确认来自本仓库后停止，21:04复查1420无listener。未运行Tauri，故截图不代表native验收。
- Exact immutable review target `2ff7b527637b1c3aa5ffe6f6039819723807df11` / parent `a484dc84e5a8e36728cb010a8aac96b661f1fdf4` 返回严格JSON：`working_tree_clean=true`、`passed=true`、security/logic/suggestions均为空；reviewer未运行测试。`checkpoint/split-workfloweditor-ui-unverified-20261012`与`checkpoint/split-workfloweditor-reviewed-unverified-20261012`均指向代码target。Slice仍unverified；未完成Tauri/native验收，Slice8仍需用户决定是否批准75–95分钟窗口。

### 7.428 unverified：OrchestratorPanel Slice8 resume3 拆分与 exact-review 阻断

- 用户于21:47:39明确批准独立95分钟窗口；start commit/tag 为 `96be03f63a0ddecf751fd916321aa4a9fa772e02` / `checkpoint/split-orchestrator-resume3-start-20261012`，硬截止23:22:39。重新核对当前源文件与先前只读审计 target `6635d60259a2895efa1dab91e8333c7079c744bb` 相同；原组件997行，focused baseline 1 file / 3 tests通过。
- 增加两个panel characterization：确认 draft 仅转为 ready、不调用executor；mock cleanup approval callback精确路由并验证single-flight与settle后busy复位。pre-refactor focused 1 file / 5 tests通过，测试提交 `1305f305604a61753e080ec9d30e63fb562c552b` / tag `checkpoint/split-orchestrator-characterization-unverified-20261012`。
- 受控UI拆分不移动store、state、异步handler、确认/执行/recovery/cleanup权限、project identity、busy/error/finally或TaskGraph revision/event/save顺序。最终 `OrchestratorPanel.tsx` 461行；`OrchestratorPanelDetailView.tsx` 372行、`OrchestratorPanelListView.tsx` 130行、`OrchestratorPanelTaskGraphSection.tsx` 85行、`OrchestratorPanelWorkerRunsView.tsx` 182行、`OrchestratorPanelViewConfig.ts` 43行。UI汉字/locale静态扫描覆盖新增owner，未删除/放宽例外。代码target `7639f72b17c06b87337fb8412f4b24fb93835c03`，immediate parent `bf9c6bb38278d5d5386525bca6ac57bca867c3ab`；`checkpoint/split-orchestrator-detail-owners-unverified-20261012` 指向target。
- 最终质量门：`OrchestratorPanel.test.tsx` + `uiChineseLiterals.test.ts` + `TaskGraphDAGView.test.tsx` 3 files / 10 tests通过；`npm run test -- --reporter=dot` 230 files / 1,525 tests通过；`npm run build`（2,133 modules，tsc-b + Vite通过）；app/project TypeScript检查通过；`npm run i18n:check` 1,112 keys通过；`git diff --check`通过。第一次中间build因DetailView unused `projectId` TS6133失败，删除该多余view prop后以上最终门重跑通过。保留既有dynamic/static import、>500kB bundle warnings与断言通过的GUI测试stderr。
- Same-snapshot静态Chrome预览 `.hermes/reports/assets/slice8-orchestrator-list-preview-20261012.png`、`slice8-orchestrator-detail-preview-20261012.png` 已回读；detail截图可见阶段、TaskGraph、WorkerRun/cleanup fixture，没有明显空白或裁切。Browser Use截图daemon超时，改用headless Chrome截图成功；临时 `orchestrator-panel-preview.html` 和 `src/orchestratorPanelPreview.tsx` 已移除。fixture明确为NOT-REAL；未打开真实项目、未运行Worker/model/API、未点击cleanup，也未启动Tauri。Vite已按命令行确认属于本仓库后停止，1420端口复核无listener。
- 代码提交时间22:43:17，早于23:22:39硬截止；production code之后未再修改。Exact reviewer在23:25:52（硬截止后）派发，严格JSON针对target `7639f72...` / parent `bf9c6bb...`，按start baseline审查累计slice diff；返回 `working_tree_clean=true`、`passed=false`、`security_concerns=[]`，1项logic finding：`OrchestratorPanelDetailView.tsx` 与 `OrchestratorPanelTaskGraphSection.tsx` 对 `../store/viewStore` 的 `TaskGraphSelection` type-only import仍违反本slice约定的“views无store import”。建议将类型移到view-neutral契约模块，或在store外定义presentation契约。Reviewer确认其他authority、callback、status、TaskGraph save/event顺序与modal/embedded行为保持；未运行tests/build。该finding使本代码target不通过review，不能升级任何状态。
- 硬截止后只做截图/临时服务收尾、精确评审与本日志/报告closeout；没有在过期窗口里修复production。当前代码和所有tags保持unverified；修正view type ownership并重新review需用户另批fresh bounded window。整体night-run仍未完成，Slice3 bilingual GUI/Tauri/native验收仍缺。

### 7.429 unverified：Slice8 TaskGraphSelection type ownership 精确评审收口

- Reviewer finding后的原20分钟修复窗口由用户明确批准，start target/tag 为 `cadb1cabac55c130152284c2793043db3a6fc6a1` / `checkpoint/split-orchestrator-type-owner-repair-start-20261012`，截止00:16:52。先加 `OrchestratorPanelViewBoundary.test.ts`，首次因 fixture 路径构造不对而报 ENOENT；修正测试路径后，针对原两处 `store/viewStore` type-only import 的4项用例中2项按预期RED。
- 将唯一 `TaskGraphSelection` 声明移至 `src/types/taskGraphSelection.ts`；`src/store/viewStore.ts` 改为从中type-import并保留 `export type` 兼容导出；DetailView与TaskGraphSection只从中立类型模块导入。4项视图依赖边界测试、viewStore旧导入兼容测试、OrchestratorPanel与TaskGraphDAGView focused tests共4 files / 15 tests通过。没有运行真实项目/Worker/model/API/cleanup/Tauri。
- 最终门：full `npm run test -- --reporter=dot` 231 files / 1,529 tests通过；`npm run build`（2,133 modules，tsc-b + Vite通过，保留既有dynamic/static import与>500kB chunk warnings）；app/project tsc通过；`npm run i18n:check` 1,112 keys通过；`git diff --check`通过。
- 修复code target `96005a971a161cc9d50124076413de06d87b21f0` / parent `cadb1cabac55c130152284c2793043db3a6fc6a1`，累计对比slice start `96be03f63a0ddecf751fd916321aa4a9fa772e02` 的独立immutable review返回严格JSON：HEAD匹配、worktree clean、`passed=true`、security/logic/suggestions均为空；reviewer确认中立类型唯一、viewStore兼容导出保留、四个view无viewStore import，且原callback/status/TaskGraph顺序保留。Reviewer未运行质量门。`checkpoint/split-orchestrator-view-type-unverified-20261013`指向code target；产出仍为unverified，review通过不是用户验收，也不补足Tauri/native验证。
- 最终工作树保持clean；Slice8 browser preview仅为headless静态夹具，列表/详情截图已有回读。Slice3 bilingual GUI与整体当前版本Tauri/native验收仍未完成；全夜间目标未完成/未验收，所有产出unverified。

### 7.430 unverified：merged-run Slice0 基线

- 按 `.hermes/plans/2026-10-13_003500-merged-run.md` 开工；计划要求的基线为 `7f248ae705b8f5a44cb3d9b0c3551288eec7cbad`，起始工作树干净。为本轮可回退性创建空 checkpoint `20ba26271d4bdd4da1bfe0bc2daaea563667345c`，源代码内容与计划基线相同；创建 `checkpoint/merged-run-plan-start-20261013` 与 `checkpoint/merged-run-slice0-start-20261013`。
- `npm run test -- --reporter=dot`：231 test files / 1,529 tests通过；保留 `src/dev/gui.test.ts` 预期 `[H4]` 错误日志，未见 localStorage unavailable 警告。`npm run build`：tsc-b + Vite通过、2,133 modules；保留dynamic/static import与>500kB chunk warnings。`npx tsc -p tsconfig.app.json --noEmit`通过；`npm run i18n:check` en-US/zh-CN对齐、1,112 keys；`git diff --check`通过。
- 初始可读性metrics：生产333 files / 68,202 lines；测试扫描232 files / 38,543 lines；生产文件>400/600/1,000行39/12/4；4,868函数中>100/300行123/18；复杂度>20/>50为103/13；深度≥4为33，参数≥6为17；`src/projectControl` 79 files / 16,732 lines / 注释率1.0%。完整指标及计划聚焦函数的行数/复杂度记录于 `.hermes/reports/2026-10-13-merged-run.md`。
- 本Slice未修改源文件；本地Node `v26.7.0`。`git ls-files` 未发现跟踪的AGENTS.md、CLAUDE.md或.cursorrules。起始报告确认被取代的计划仅标注“已被取代”；当前计划没有单独待决定事项，后续任何用户授权门将写入报告并跳过受阻操作。运行产出保持unverified。

### 7.431 partial/unverified：merged-run Slice1 test hygiene

- 按 `.hermes/plans/2026-10-13_003500-merged-run.md` 修正Vitest fork worker的Web Storage配置：Node <25不给额外参数；Node ≥25只传 `--no-experimental-webstorage`，不再创建共享的 `--localstorage-file`。新增 `src/platform/vitestStorage.test.ts` 检查 `globalThis.localStorage === window.localStorage` 且对象属于jsdom `Storage`。`src/engine/topoSort.test.ts` 子进程timeout 2,000→10,000ms、case timeout 15,000ms，断言保持原样。RED在原配置下如期因Storage实例类型失败；GREEN后storage/env/projectIO 3 files / 5 tests通过，storage+topoSort 2 files / 18 tests在Windows Node26与Node22.23.2通过。
- Windows Node `v26.7.0` 与 `v22.23.2` 各连续3次全量测试，逐次均为232 files / 1,530 tests passed，输出中均未出现 `localStorage is not available` warning。`node --no-experimental-webstorage -e "console.log(typeof localStorage)"` 输出 `undefined` 且无警告。最终 `npm run build`（tsc-b + Vite，2,133 modules）、app tsc、i18n（1,112 keys）、`git diff --check`通过；保留既有mixed dynamic/static import与>500kB chunk warnings。
- WSL Ubuntu Node `v24.21.0`：在主worktree复用Windows `node_modules` 时，Vitest启动前报缺少 `@rollup/rollup-linux-x64-gnu`；随后把精确target `cd4be6d4fc0f83f9fc4c278dada76fe7048179e5` 用 `git archive` 解到 `D:/Hermes/cache/scratch/merged-run-test-hygiene-node24-020456`，从锁文件执行scratch-only `npm ci`（276 packages；Node/npm提示esbuild install scripts未批准），再跑Vitest时terminal在420秒超时，无汇总行、无测试结果；02:14复查未见残留Node进程。没有改主worktree的package.json/lock/node_modules；Node24 gate仍未通过/未证实。
- Exact immutable reviewer审查target `cd4be6d4fc0f83f9fc4c278dada76fe7048179e5` / parent `0ac830fc2313a177d40018df5101d48abb9235b5`，严格JSON：head/parent与clean tree匹配、`passed=true`、security/logic为空；一条non-blocking suggestion提醒后续遵守测试单独提交的traceability步骤。该RED测试先于实现编写并运行，但没有按计划独立提交test-only commit；未改写历史。`checkpoint/test-hygiene-unverified-20261013` 与 `checkpoint/test-hygiene-reviewed-unverified-20261013` 指向code target；由于WSL Node24没有成功结果，不创建verified tag。具体证据与未决项见 `.hermes/reports/2026-10-13-merged-run.md`。

### 7.432 partial：merged-run Slice2 verified backfill

- 对照上一轮night-run报告、第一批修复报告、DEVELOPMENT_LOG、immutable target与现存tag逐一核对；未重跑历史质量门或review。按计划第8条，以同一精确target的质量门、strict JSON reviewer及（UI切片）同target GUI read-back作判据。
- 在未改动的历史target上补建annotated verified tag：`checkpoint/split-commands-verified-20261012` → `edea067da4231bbbabbdc4e81e5bfa6bc8efaa6a`（226 files / 1,503 tests，build 2,112 modules、app tsc、i18n 1,112、diff-check通过；exact reviewer passed=true、security/logic空；非UI）；`checkpoint/split-agentpanel-verified-20261012` → `b9977aae28e285f4e2edcc099b6896360c3aa74e`（226 files / 1,507 tests，build 2,119 modules、dual tsc、i18n/diff通过；exact reviewer passed=true；同target Settings→Agents Vite截图已回读）；额外确认 `BeginnerExperience` 也满足：`checkpoint/split-beginnerexperience-verified-20261012` → `33b7b14185c34303670b7fe40c597cae5baca7b2`（最终228 files / 1,515 tests、build 2,119 modules、dual tsc/i18n/diff通过；strict reviewer passed=true、security/logic空；同target的实际Vite `/` beginner-home页面DOM和截图已回读）。BeginnerExperience 曾出现一次未修改WorkflowEditor用例full/standalone失败，随后同一target full重跑全绿；此间歇风险与review suggestion保留在报告，未改写历史。三枚verified tags均与各自原unverified tag指向同一代码提交；verified仅代表计划门，不代表native验收。
- 不补Fix4 `1be58a1`：其full Vitest exit 1（1,367项中10失败，虽报告称与baseline相同），未满足“质量门全过”。不补test-env `0a66c2f`：immutable source仍使用跨fork共享 `--localstorage-file`，而当前Slice1明确识别其为缺陷；将其打verified会与新接受标准冲突，暂留用户决定。第一批target `31dc579` 的Tauri双语GUI缺失转Slice3；WorkflowEditor静态component preview不作为Vite GUI；Orchestrator修复后没有同target GUI图；ProjectSession计划明确不做GUI；Settings静态图导航错位；TopBar只有静态组件preview——均不补verified，理由逐项列于`.hermes/reports/2026-10-13-merged-run.md`。
- 旧报告另有待用户决定的 `workflowRegistryActions.ts:66` 同步调用重复workflow ID风险；本轮不改变生产行为。Slice2不因这两项等待而停止后续切片，整体run仍在进行。

### 7.433 partial/unverified：merged-run Slice3 batch1 GUI

- 在仓库外建立并保留 `D:/code/slimeMold-verify-batch1`，精确HEAD为 `31dc5794a76ef72601c2b00a76ea161b23759c05`；依赖清单/锁文件与主worktree相同，`npm ls --depth=0` exit 0；复用主worktree `src-tauri/target`。Tauri配置使用独立identifier `com.slimemold.verify`，Vite在1420 ready，Rust dev build 26.47s后实际窗口启动；CDP 9222指向该WebView。新 `%APPDATA%\com.slimemold.verify` 目录原先不存在，启动创建了插件目录；目录按计划保留。
- 全新Browser上下文与Tauri state均读回 `projectId=null`、`projectPath=null`、`activeSessionId=null`、nodes/runHistory均为0。未点击“开始项目会话”、未新建项目、未运行workflow或Orchestrator draft，也未启动Worker/调用模型；Generate draft因Goal为空保持disabled。项目less首页没有正常的advanced入口，本次只在隔离view preference中设置`workspaceMode=advanced`来读回目标面板，正常产品导航未验收。
- Browser Vite DOM与真实Tauri WebView均在Settings locale selector触发change event完成`zh-CN → en-US → zh-CN`。英文状态栏读回`runId 0/0`、`Nodes 0 · OK 0 · Failed 0`；中文读回`runId 0/0`、`节点 0 · 成功 0 · 失败 0`。TopBar、rail、Orchestrator、Inspector与空WorkflowEditor的UI labels按locale变化。Tauri截图保存在`.hermes/reports/assets/`：`batch1-tauri-settings-english-20261013.png`、`batch1-tauri-english-workspace-20261013.png`、`batch1-tauri-english-orchestrator-20261013.png`、`batch1-tauri-chinese-orchestrator-20261013.png`；Browser中文Orchestrator截图为`batch1-browser-chinese-orchestrator-20261013.png`。Browser Use英文截图的CDP capture两次超时60s，但页面DOM read-back成功；不据此判产品失败。
- 英文Tauri DOM除工作流数据名外，还显示`src/plugins/pluginManager.ts:43`中文插件启动日志两条及`StatusBar.tsx`调用`toLocaleTimeString()`产生的“上午”时间；这些可见运行内容不在计划明确列出的数据标识白名单中。加上advanced view需隔离状态注入且Slice用时1:54:02（计划≤1.5小时），本Slice保留`checkpoint/living-graph-batch1-unverified-20261012`、不创建verified tag，也不更新`docs/HISTORICAL_UNVERIFIED_TRIAGE.md`。计划要求的npm测试/build/tsc/i18n质量门本Slice未重跑；沿用报告中该精确代码target此前221 files / 1,497 tests及build、tsc、i18n、diff-check和strict reviewer证据，不声称为本轮新验证。
- Tauri进程结束后1420/9222端口关闭；worktree恢复clean并保留。启动期间`src-tauri/Cargo.toml`仅出现行尾状态变化，已还原到target。详见`.hermes/reports/2026-10-13-merged-run.md`；是否将英文状态区中的动态日志/本地化时间视为范围外，留作待确认边界。

### 7.434 partial/skipped：merged-run Slice4 readability-import 超时回退

- Slice起点为empty checkpoint `2e3b2ce5eb9ee75ca949bd0de4e6a0ea5f6190aa` / `checkpoint/readability-import-start-20261013`。将 `.hermes/plans/2026-10-12-readability/CODE_READABILITY_REVIEW.md` 与 `readability-metrics.cjs` 临时复制到计划目标；`cmp`确认两份副本与源文件相同，SHA-256分别为`24e0b4b0381cd2d11a4d7c55e4d607396c1b91071efab8489a217fda839e06c2`与`37ed74cc59c3ae61b8599910e7b34230ecf987d259ea8a9f3acc6d5c4368addd`。`docs/README.md`试加代码可读性评估链接；脚本输出 `auditWorkerRunConsistency` 为513行、复杂度170、深度5、参数1。
- 临时文件存在时的实测门：Vitest 232 files / 1,530 tests；build 2,133 modules；`npx tsc -p tsconfig.app.json --noEmit` exit 0；i18n 1,112 keys；`git diff --check`通过。Build仅有已知dynamic/static import与>500kB chunk warnings。
- 从start checkpoint到止损为15:19，超过计划15分钟19秒；按时间盒规则撤回两份新副本并恢复README原文，未commit、未派独立review、未创建最终tag。复核后主worktree clean；上述质量门是临时工作内容的实测，不构成完成或verified状态。本轮继续Slice5；详见`.hermes/reports/2026-10-13-merged-run.md`。

### 7.435 partial/unverified：merged-run Slice5 projectControl 代码地图

- 按计划先独立提交 `src/projectControl/codeMap.test.ts` 的RED测试：`3f87dab72f2896723c2a1a5d99356fc1b4281e58`；README缺失时2项断言按预期失败。代码地图与 `docs/README.md` 导航提交 `218f09e4e39e9a592db35b064726d17ffb1f6645`，标签 `checkpoint/readability-code-map-unverified-20261013`。地图为125行、20条术语，检查结果39/39非测试Worker文件恰列一次、67/67 `src/` 路径存在、导航链接有效；无生产代码变更。
- 第一轮exact review发现三项角色描述不准确：`workerRunTransitionProjection` 不生成events，recovery capability仅允许retry/skip，single-flight重复active key返回null且是process-local。另有ADR引用遗漏。修订后提交 `7b5f7d129db87cf65eed11697457d47203f2cc8e`；补录ADR-SM-014/-015/-027/-037/-040/-084，并把ADR-SM-084标为设计基线；对三项职责描述按源码更正。
- 修订snapshot质量门：focused codeMap 2/2；Vitest 233 files / 1,532 tests；`npm run build` 2,133 modules；`npx tsc -p tsconfig.app.json --noEmit`与`npx tsc --noEmit`通过；`npm run i18n:check` 1,112 keys；`git diff --check`通过。保留既有dynamic/static import与>500kB chunk warnings。
- 第二轮exact review仍返回`passed=false`：security concerns为空，但指出 `ProjectTaskGraph`/`ProjectTask`/`graphVersion`需ADR-SM-012/-013，`WorkerRunQueueState`需ADR-SM-015，`AcceptanceRecord`需ADR-SM-018。只读核对确认这些架构决策存在且范围相关。达到计划的两轮review上限；约65.85分钟时剩余时间不足以完成新修订、全量门和另一次exact review，因此未继续扩展、未打verified tag，保留unverified并转Slice6。完整target、两轮verdict及缺口见`.hermes/reports/2026-10-13-merged-run.md`。

### 7.436 verified：merged-run Slice6 auditWorkerRunConsistency 行为不变拆分

- 开工checkpoint/tag：`02ffdeaf7cf9a777621a2f0edbe97f82bd1eafce` / `checkpoint/readability-run-consistency-start-20261013`。先针对旧实现提交完整报告金样：`6bb6dc56b323e44d25fbf69248d94e85fe86754c` / `checkpoint/readability-run-consistency-golden-unverified-20261013`；旧实现上3个相邻测试文件31/31通过。金样覆盖`ok`、3项有序issue code/message及非空Run/TaskExecution/Attempt projection；实现commit未改测试或snapshot。
- 行为不变拆分提交 `7198e11860965b6e19ca7b0d453a44fa3afd389e`（parent `6bb6dc56b323e44d25fbf69248d94e85fe86754c`）：保留公开audit签名/exports、issue顺序与原文案、replay失败early return、projection及receipt/side-effect lineage checks；按event、Run/Task、side-effect、orphan问题族拆出checks与types/utils模块。README同步列出45/45非测试`worker*.ts`文件；130行、20术语、67个`src/`路径全部存在；补入ADR-SM-012/-013/-015/-018。Slice5原target仍保持partial/unverified，不因本次后续文档更新追溯晋级。
- 函数指标：`auditWorkerRunConsistency` 513行/CX170/深度5/1参数 → 20/CX3/深度1/1参数；命名check最大56行/CX22；`isVerifiedHistoricalEffect` 48/CX39 → 14/CX7。触及production文件中>250行函数1→0、CX>25函数2→0；最长新production文件379行。全仓参数≥6函数数17→22，记录为本Slice范围外的可读性残余；Slice6规定的函数行数/复杂度门通过。
- 第一次完整`npm run build`在`tsc -b`阶段报告新拆分的stage/replayedTask类型错误及unused参数；将stage比较参数标为可选、在task guard后使用非空replayedTask类型并删除未用内部参数。修订后focused 4 files / 33 tests、build及后续全套质量门通过，没有更改错误信息或运行行为。
- `npm run test -- --reporter=dot`：233 files / 1,533 tests passed；`npm run build`：2,138 modules transformed，保留既有dynamic/static import与>500kB chunk warnings；`npx tsc -p tsconfig.app.json --noEmit`通过；`npx tsc --noEmit`通过；`npm run i18n:check`：1,112 keys对齐；`git diff --check`通过。全量测试里`src/dev/gui.test.ts`继续打印其预期H4错误stderr，不是失败。
- Slice4因15分钟止损没有把metrics脚本复制进`scripts/`，故Slice6使用计划源`.hermes/plans/2026-10-12-readability/readability-metrics.cjs`。一次误把`--json`输出路径指定为tracked `.ts`源文件，导致metrics JSON覆盖源文件并触发Vitest解析失败；从当时干净HEAD恢复后，Git对象hash与工作树hash均为`29cc1475da77f0aa8215d51e178b37d178a3df16`，该临时内容未提交。之后`--json`仅写到Hermes scratch。新增6个worker模块后`codeMap.test.ts`先因README缺6行而失败；补齐表与ADR后，codeMap 2/2通过。
- 独立exact-object reviewer审查target `7198e11860965b6e19ca7b0d453a44fa3afd389e` / parent `6bb6dc56b323e44d25fbf69248d94e85fe86754c`，返回严格JSON `passed=true`、security/logic/suggestions均空，确认golden与snapshot未变且工作树clean。`checkpoint/readability-run-consistency-unverified-20261013`与`checkpoint/readability-run-consistency-verified-20261013`均指向target。纯代码Slice，无Tauri/GUI验收要求。详见`.hermes/reports/2026-10-13-merged-run.md`。

### 7.437 verified：merged-run Slice7 executeNode参数分组

- 开工checkpoint/tag：`9894deafc22f634405effc95dab3cc099d0afe15` / `checkpoint/readability-execute-node-start-20261013`。测试-only characterization commit `99d1a41d54188ef7993769954b95c40b514acb9a` / `checkpoint/readability-execute-node-golden-unverified-20261013`；在旧实现上focused lifecycle 14/14与5个executor测试文件40/40通过，覆盖上游inputs、node params、合并project/workflow vars、signal状态与节点成功。
- 实现target `a8c294e36217ff70e9f24a0a22a1eaab9b1609ee`（parent `99d1a41d54188ef7993769954b95c40b514acb9a`）将27个位置参数改为单个`ExecuteNodeArgs`对象，分组为graph/control/retry/costs/variables/sandbox/runtime。保留loop变量spread、gate callback、状态map/set引用、成本账本、默认值、沙箱选项、运行时与ID/signal；`executeNode`正文内的直接`useWorkflowStore.getState()`读取未改。Metrics：398行/CX43/depth3/27参数→380/CX43/depth3/1；`executor.ts`文件970→978物理行，仍>600，属于本切片之外的文件拓扑残余；该文件中>250行函数与CX>25函数均仍为2，无增加；全仓参数≥6函数22→21。
- 质量门：focused 5 files/40 tests；`npm run test -- --reporter=dot` 233 files / 1,534 tests；`npm run build` 2,138 modules；app与plain `tsc --noEmit`通过；`npm run i18n:check` 1,112 keys；`git diff --check`通过。Build保留既有dynamic/static import与>500kB chunk warnings；全量测试的`src/dev/gui.test.ts` `[H4]` stderr是预期输出。
- 独立exact-object reviewer针对target `a8c294e36217ff70e9f24a0a22a1eaab9b1609ee` / parent `99d1a41d54188ef7993769954b95c40b514acb9a`返回严格JSON `passed=true`，security/logic/suggestions均空，确认工作树clean、仅改`src/engine/executor.ts`、直接store读取与函数正文未变。`checkpoint/readability-execute-node-unverified-20261013`和`checkpoint/readability-execute-node-verified-20261013`同指target。计划此Slice无GUI要求；详见`.hermes/reports/2026-10-13-merged-run.md`。

### 7.438 verified：merged-run Slice8 ProjectSessionPanel拆分

- 开工checkpoint/tag：`85a755a815b315964d9d255748b629da3d96a203` / `checkpoint/readability-project-session-start-20261013`。只读盘点6.58分钟，在15分钟限制内完成，并先记录于`.hermes/reports/2026-10-13-merged-run.md`。计划的382/462行是组件函数metrics；开工时物理文件为486/543行。初始组件测试1 file/12 tests通过。
- Test-only characterization commit `43bb1648a40b0658a2ca98eb4934c6008e07ce47` / `checkpoint/readability-project-session-characterization-unverified-20261013`，在旧实现冻结首次Master prompt、自动prompt不写成用户消息、assistant回复/已有Brief时的触发guards；focused 1 file/14 tests通过。随后按关注点分别提交conversation、Worker、planning、orchestration hooks；最终view target `6bee5653ad4b204606b4807daa5c47ade6a7623f`（parent `6eaf73487f19e9da0979ea47642f137a67fb5c9f`）将条件区块拆为显式props子组件。首次turn effect仍要求session、未置ref、无assistant message、无briefId；先置ref再发原文`请开始需求澄清，先提出最关键的问题。`并传`false`；依赖仍为`[sessionId, session?.id]`。view静态class、test ID和i18n key调用计数与原文件一致。
- Metrics：`ProjectSessionPanel` 462/CX21→189/CX19；`ProjectSessionPanelView` 382/CX64→118/CX1。新增hooks最长145行/CX19；拆分view子函数最长107行/CX17；全部新函数≤250行/CX25。
- 验证结果：focused组件测试1 file/14 tests通过；`npm run test` 233 files/1,536 tests通过；`npm run build` 2,146 modules；`npx tsc --noEmit`通过；`npm run i18n:check` 1,112 keys对齐；`git diff --check`通过。Build输出既有dynamic/static import和>500kB chunk warnings；`src/dev/gui.test.ts`输出的H4 stderr为预期测试日志。
- 独立exact-object reviewer针对完整Slice8范围返回严格JSON，target/parent与对象一致、worktree clean、`passed=true`，security/logic/suggestions均空。`checkpoint/readability-project-session-views-unverified-20261013`与`checkpoint/readability-project-session-verified-20261013`均指向code target。按计划未做GUI回读（需要新建会话），此项明确为GUI证据缺失；本切片的组件测试、质量门及exact review已通过。详见`.hermes/reports/2026-10-13-merged-run.md`。

### 7.439 partial：merged-run Slice9 WorkflowEditorInner

- 开工checkpoint/tag：`855bacefc16606767a3605ea9e3977d6e98c05ff` / `checkpoint/readability-workflow-editor-start-20261013`。只读盘点确认`useSplitWorkflowGraph`尚不存在；`WorkflowEditorInner`为507行/CX17。Slice4曾按15分钟上限回退，仓库未生成`scripts/readability-metrics.cjs`；本轮使用计划源`.hermes/plans/2026-10-12-readability/readability-metrics.cjs`，`--json`输出写入Hermes scratch并确认源码blob未变。
- 先提交test-only characterization `afdc2d8614e3939c7697e604fe0b04939d54ecab` / parent `855bacefc16606767a3605ea9e3977d6e98c05ff` / `checkpoint/readability-workflow-editor-characterization-unverified-20261013`：扩展split graph加载用例，断言ReactFlow显示的node/data是独立副本、`dirty:true`仅出现在副本且原store record不变。旧实现focused 1 file/6 tests通过。
- 曾在未提交工作树试抽`useSplitWorkflowGraph`：focused 1 file/6 tests、全量233 files/1,536 tests、build 2,147 modules、app `tsc -p tsconfig.app.json --noEmit`、i18n 1,112 keys、diff-check通过；metrics显示hook 62行/CX1，但主函数仍459行/CX17，未达≤300目标，且尚未拆展示view、没有browser截图或exact review。当时75分钟窗口还剩32分08秒；按UI拆分skill的完整验收预算规则，剩余时间不足以可信完成剩余切分、browser readback和exact review，遂撤回仅本切片未提交的生产改动与新文件，回到test-only HEAD；没有把临时提取提交或标verified。
- 撤回后精确HEAD `afdc2d8614e3939c7697e604fe0b04939d54ecab` 上的质量门：`npm run test` 233 files / 1,536 tests；`npm run build` 2,146 modules；`npx tsc -p tsconfig.app.json --noEmit`通过；`npm run i18n:check` 1,112 keys；`git diff --check`及`git show --check HEAD`通过。Build保留既有dynamic/static import与>500kB chunk warnings；全量测试`src/dev/gui.test.ts`的H4 stderr为预期输出。
- Slice9保持partial/unverified：生产`WorkflowEditorInner`最终仍507行/CX17；只保留通过全量质量门的test-only characterization。未做browser/GUI、未派exact reviewer、未打implementation verified tag；`onReconnect`仍有split mode以`st.edges`检查cycle后写split-local edges的未验证行为，未在结构切片修复。因Slice9未完成，Slice10–12的前置条件不成立；Slice13全分支验证仍必做。详见`.hermes/reports/2026-10-13-merged-run.md`。

### 7.440 partial/unverified：merged-run Slice13 分支整体验收

- 冻结代码对象为`43b4577de26aa7a45b3be134ce427aaaedabdfbb`（parent `ad660a862cc67acd38698361fb6d69cbf4d4434d`），start tag为`checkpoint/monolith-split-2-final-start-20261013`；`1e2030983bbb606315e9d9a2f5b421f29c0b3855`是其祖先。Node `v26.7.0`。start commit `2026-10-13 09:53:22 +08:00`至`11:37:13 +08:00`的证据/status read-back时长为1:43:51，满足至少1小时要求。
- 最终同快照门：`npm run test -- --reporter=dot` 233 test files / 1,536 tests；`npm run build` 2,146 modules；`npx tsc -p tsconfig.app.json --noEmit`、`npx tsc --noEmit`通过；`npm run i18n:check` 1,112 keys；`git diff --check`通过。Build保留dynamic/static import与>500kB chunk warnings；`src/dev/gui.test.ts`输出的H4 stderr是预期测试日志。
- Metrics使用计划源`.hermes/plans/2026-10-12-readability/readability-metrics.cjs`，baseline来自归档`.hermes/plans/2026-10-12-readability/CODE_READABILITY_REVIEW.md`（`docs/architecture/CODE_READABILITY_REVIEW.md`因Slice4回退不存在）。生产文件/行333/68,202→348/69,087；测试文件/行232/38,543→234/38,708；函数总数4,868→4,905，>100行123→126、>300行18→15；复杂度>20为103→100、>50为13→11；嵌套≥4为33→32、参数≥6为17→21；>400/>600/>1,000行生产文件39/12/4→36/11/4；JSDoc 38.8%→38.2%。`workflowStore` baseline57；当前AST扫描59个非测试生产importer、含owner为60，与reviewer报告60相符；宽泛词面搜索63不作为import fan-in。
- fresh Browser context和真实Tauri（identifier `com.slimemold.verify.final20261013`）读回advanced workflow editor、Settings→Agents、设置中心General/Agents/Models/MCP/Conversation Flow/Routing/APIKEYS、Orchestration、TopBar五个菜单和beginner页。`sm.lastSession`不存在、recent projects 0、runId 0/0、nodes/succeeded/failed 0、Companion 0；没有创建项目或ProjectSession、运行workflow、启动Worker或调用模型API。APIKEYS结构显示配置0；没有读取secret values。English locale UI读回后恢复zh-CN，但`documentElement.lang`仍zh-CN，auto-save footer仍显示本地“上午”时间。
- Browser Settings→Agents截图调用超时，但DOM读回成功且Tauri Agents截图已保存；Browser Resource Timing中status≥400为空，不等价于完整console采集。Tauri CDP捕获唯一console error：`http://localhost:1420/favicon.ico` HTTP 404；runtime exception/warning均0。该错误违反计划的“console无报错”，不自行豁免；因此Slice13和整体状态保持partial/unverified，不创建final unverified/verified tags。Reviewer独立exact review范围`1e2030983bbb606315e9d9a2f5b421f29c0b3855..43b4577de26aa7a45b3be134ce427aaaedabdfbb`严格JSON `passed=true`、head/parent/clean tree匹配、security/logic arrays空；suggestions三项为favicon验收门、TopBar `handleNewProject`依赖建议（与基线实现相同，另行考虑）及metrics趋势；reviewer没有运行质量门。
- `.hermes/reports/assets/slice13-readback-manifest-20261013.json`列24张截图与12份Tauri readback JSON，逐项size/SHA-256回读通过；manifest SHA-256 `1126ee835e70fdb680d176d615d4b5dca70d37d2b3bc9657ed03f947d1872803`。Tauri结束后1420/9222 free；isolated AppData和`D:/code/slimeMold-verify-batch1`保留。按计划收尾核实`.hermes/review-tmp/`恰有3个普通`.patch`文件后仅删除该目录，确认目录不存在；未运行`git clean`。
- 完整报告更新于`.hermes/reports/2026-10-13-merged-run.md`（该路径由`.gitignore:92`忽略，本轮保留为本地任务报告，不强制加入提交）。本日志为review之后的docs-only closeout；exact reviewer verdict仍严格绑定code HEAD `43b4577…`，不迁移为verified。未push；未创建final tag。

### 7.441 partial/unverified：closeout-run-r4 Slice0 基线

- 开工branch `refactor/monolith-split-2`；基线code `75f954b282578080e23c4fc747be7d57d8a58b84`，工作树干净。先建空checkpoint `a756e91fb5cedb0a7b71231fa521a01b42ffb11d` / `checkpoint/closeout-run-slice0-start-20261013-r4`；其代码内容与75f954b相同。Node `v26.7.0`、npm `11.19.0`。Slice0起止`13:04:50–13:11:16 +08:00`，6:26，满足20分钟上限。
- 质量门：`npm run test -- --reporter=dot` 233 files / 1,536 tests；`npm run build` 2,146 modules；`npx tsc -p tsconfig.app.json --noEmit`通过；`npm run i18n:check` 1,112 keys；`git diff --check`通过。测试中的`src/dev/gui.test.ts` `[H4]` stderr是预期日志；build保留dynamic/static import与>500kB chunk warnings。
- Metrics脚本`.hermes/plans/2026-10-12-readability/readability-metrics.cjs`已运行，JSON写入scratch `D:/Hermes/cache/scratch/r4-slice0-metrics.json`，SHA-256 `2d82867d127b31120aa1e1bc91a8aac286f2f0ee70221a62ed074afae8c1a726`。生产文件/行348/69,087；测试文件/行234/38,708；函数4,905、>100行126、>300行15；复杂度>20为100、>50为11；嵌套≥4为32、参数≥6为21；>400/>600/>1,000行生产文件36/11/4；JSDoc 38.2%；`src/projectControl` 85/17,060/1.0%；`workflowStore.ts` fan-in 60。全部与75f954b评估进展列一致。
- Slice0仅做基线，无源码改动、无独立review或GUI回读，故状态unverified。报告`.hermes/reports/2026-10-13-closeout-r4.md`被`.gitignore:92`忽略，作为本地任务档案保留、不强制跟踪。按计划在此日志提交后创建Slice0 unverified tag；不push。详见该报告。

### 7.442 partial/unverified：closeout-run-r4 Slice1a 界面语言外壳

- 缺陷来源：上一轮整体验收中，英文界面仍出现中文（状态栏自动保存时间「上午」）与错误的时间/日期格式；`<html lang>` 与 `document.title` 不随语言切换；开发服务器请求 `/favicon.ico` 404。
- favicon：把 `src-tauri/icons/icon.ico`（只读）复制为 `public/favicon.ico`（30,596 字节，源文件仅读），`index.html` 增加 `<link rel="icon" href="/favicon.ico" />`。实测开发服务器 `GET /favicon.ico` → 200 `image/x-icon` 30,596 字节；`npm run build` 产物含 `dist/favicon.ico`（30,596 字节）。验证后已结束该开发服务器并确认 1420 端口释放。
- 页面语言与标题：`src/i18n/index.ts` 新增 `syncDocumentMetadata`，监听 i18next `languageChanged` 与 `initialized`，并立即同步一次，统一设置 `document.documentElement.lang` 与 `document.title`；标题用新 key `app.title`（zh-CN `SlimeMold · Agent 工作流`、en-US `SlimeMold · Agent Workflows`），覆盖 `src/main.tsx:12` 与 `src/store/viewStore.ts:165` 两处 `changeLanguage`。
- 时间格式：新增 `src/i18n/dateTime.ts`（`formatDateTime` / `formatTime`，使用当前 `i18n.language`），替换 `StatusBar`（自动保存时间）、`ArtifactsPanel`、`OrchestratorPanelDetailView`（开始/结束）、`OrchestratorPanelListView`、`RunHistoryPanel`（列表、详情、节点 tooltip）、`TokenUsagePanel`、`Inspector`（资产创建时间）、`beginner/BeginnerHeader`（`toLocaleString(undefined, …)`）中未传语言的 `Date` 调用；数字的 `toLocaleString()` 未改。
- `src/store/workflowStore.ts` 按本轮边界只改第 626 行一处：日志 `time` 使用 `useViewStore.getState().locale`。
- 测试（test-only RED 先单独提交 `d3fa2dfba0b9af0e9b7ec30e99e49882a67dcbee`，tag `checkpoint/ui-locale-shell-tests-red-unverified-20261013-r4`）：新增 `src/components/StatusBar.test.tsx`（断言 `toLocaleTimeString('en-US')` 与渲染文本）、`src/components/beginner/BeginnerHeader.test.tsx`（断言 `toLocaleString('en-US', options)`）、`src/store/workflowStore.locale.test.ts`（日志时间跟随 view locale），并在 `src/i18n/index.test.ts` 增加 `documentElement.lang`/`document.title` 双语切换断言。四个文件在改前分别因 `undefined`/空参数/`stale-language` 失败，改后通过。
- 验证结果（code snapshot `802901c11be828f6ad6aabe00ea359fdca5dc675`）：`npm run test` 236 files / 1,540 tests 全部通过（基线 233/1,536）；`npm run build` 通过（保留既有 dynamic/static import 混用与 >500kB chunk warnings）；`npx tsc -p tsconfig.app.json --noEmit` 无输出；`npm run i18n:check` 基准 1,113 keys、en-US 对齐（基线 1,112）；`git diff --check` 无空白错误（仅 Git 的 LF→CRLF 提示）。
- 本地提交 `802901c11be828f6ad6aabe00ea359fdca5dc675`，tag `checkpoint/ui-locale-shell-unverified-20261013-r4`。按计划切片 1a 不做 GUI 回读、也不打 verified，界面验收统一在切片 5 进行；本切片尚无独立 reviewer verdict。未 push。详见 `.hermes/reports/2026-10-13-closeout-r4.md`。

### 7.443 partial/unverified：closeout-run-r4 Slice1b 英文模式中文残留

- 缺陷来源：上一轮英文界面在运行历史面板与插件管理日志中仍显示中文（恢复检查点提示、`次`、`开始：`、`模型：…；含失败 … 次`、插件/自定义节点日志）。
- `src/components/RunHistoryPanel.tsx`：两处恢复检查点提示改为 `runHistory.log.checkpointRestored` / `runHistory.log.noCheckpoint`；调用次数改为 `runHistory.calls`（`{{count}}`）；节点 tooltip 改为 `runHistory.node.startedAt`（`{{time}}`）与 `runHistory.node.cost`（`{{models}}` / `{{failed}}`）。
- `src/plugins/pluginManager.ts`：19 条日志（含 `范围=全局/本项目` 两个范围标签，共 21 个 key）改为通过 `src/i18n/index.ts` 默认导出的 `i18n.t(...)`，插值用 `{{name}}` / `{{count}}` / `{{message}}` / `{{path}}` / `{{scope}}`；中英文 key 都写入 `locales/*/ui.xml`。该模块不是 React 组件，不能用 `useT`，故显式导入默认导出并在注释中写明原因。
- 测试（test-only RED 先单独提交 `4146cc4c8132a0050d6d810c5000f3bca5efc45f`，tag `checkpoint/ui-locale-literals-tests-red-unverified-20261013-r4`）：`src/i18n/uiChineseLiterals.test.ts` 的 `TARGET_FILES`/`NAMESPACE_CANDIDATES` 增加这两个文件，并让 key 收集器同时识别 `i18n.t('...')` 成员调用；新增 `src/plugins/pluginManager.locale.test.ts`，在 zh-CN/en-US 下分别断言一条带参数的 info（`插件已卸载：plugin-x` / `Plugin unloaded: plugin-x`）与一条带原因的 error（`导入失败：manifest.entry 无效（…）` / `Import failed: invalid manifest.entry (…)`）。改前按预期失败（中文文案 + 汉字扫描列表），改后通过。
- 验证结果（code snapshot `adced7998f3e0fac0b1e142d41e30c95abd76730`）：`npm run test` 237 files / 1,542 tests 全部通过（切片 1a 后为 236/1,540）；`npm run build` 通过（保留既有 warnings）；`npx tsc -p tsconfig.app.json --noEmit` 无输出；`npm run i18n:check` 基准 1,139 keys、en-US 对齐（切片 1a 后为 1,113）；`git diff --check` 无空白错误。
- 按计划列出本切片不处理的其余中文日志调用：对 `src/**`（排除测试与禁区文件）做 AST 扫描，`addLog`/`log` 的 message 参数本身为含汉字字面量的调用共 **63 处、16 个文件**（`executor.ts` 18、`runFinalizer.ts` 9、`workflowIO.ts` 6、`workflowSubgraphCommands.ts` 5 等），明细见报告；留给加时切片 2。
- 本地提交 `adced7998f3e0fac0b1e142d41e30c95abd76730`，tag `checkpoint/ui-locale-literals-unverified-20261013-r4`。按计划不做 GUI 回读、不打 verified；无独立 reviewer verdict。未 push。

### 7.444 partial/unverified：closeout-run-r4 Slice2 重复 workflow ID

- 缺陷来源：工作流 ID 用 `wf-<毫秒时间戳>` 生成，同一毫秒内连续新建会重复；实测同一固定时钟下连续两次 `newWorkflowInProject`，第二次直接复用当前激活工作流 ID，把刚创建的工作流覆盖掉（工作流数量停在 2，名称重复为「工作流 2」）。
- 新增 `src/store/workflowId.ts`：`createWorkflowId(now, taken)` 保留 `wf-<时间戳>` 形态，与传入的既有/已发出 ID 冲突时追加递增后缀 `-2`、`-3`…。
- 替换计划列出的 5 处：`workflowRegistryActions.ts` 的 `capturedWorkflowId`（`wf-${deps.now()}`）与新建 ID（`wf-${deps.now() + 1}`，taken 含当前 workflows 与本次捕获 ID）、`workflowLifecycleState.ts` 的 `buildNewProjectState`、`workflowRegistryState.ts` 的 `buildSwitchWorkflowState` 游离态兜底 ID、`workflowSerialize.ts` 非 stable 分支的兜底 ID（stable 分支 `wf-${current.name}` 未动）。已有 ID 形态与时钟顺序保持不变。
- 测试：新增 `src/store/workflowIdUniqueness.test.ts`（test-only RED 先单独提交 `18eaac37217e2e1f54966aef8af7542cf8bcbc29`，tag `checkpoint/workflow-id-unique-tests-red-unverified-20261013-r4`）。改前因 `expected [ 'wf-1000', 'wf-1001' ] to have a length of 3 but got 2` 失败；改后两个用例通过。既有特征测试 `src/store/workflowStore.newWorkflow.test.ts` 未改且仍通过（仍断言 `wf-1000` / `wf-2001` 的时钟顺序）。
- 验证结果（code snapshot `f34c824182168dcb0d6e3eafc4c94d57eda28c2b`）：`npm run test` 238 files / 1,544 tests 全部通过（切片 1b 后为 237/1,542）；`npm run build` 通过；`npx tsc -p tsconfig.app.json --noEmit` 无输出；`npm run i18n:check` 1,139 keys 对齐；`git diff --check` 无空白错误。
- 本切片未处理的同类问题（计划未授权，已记入报告）：`buildNewProjectState` 的 `proj-${Date.now()}` 与 `buildProjectFile` 的项目 ID 仍有同毫秒重复风险。
- 本地提交 `f34c824182168dcb0d6e3eafc4c94d57eda28c2b`，tag `checkpoint/workflow-id-unique-unverified-20261013-r4`；无独立 reviewer verdict。未 push。

### 7.445 partial/unverified：closeout-run-r4 Slice3 补放可读性评估与度量脚本

- 上一轮因时间盒过紧撤回的两份文件按计划补回：`.hermes/plans/2026-10-12-readability/CODE_READABILITY_REVIEW.md` → `docs/architecture/CODE_READABILITY_REVIEW.md`（10,987 字节，SHA-256 `41ebc4853e3e7567…`）、`.hermes/plans/2026-10-12-readability/readability-metrics.cjs` → `scripts/readability-metrics.cjs`（12,831 字节，SHA-256 `ff2bec61d23d7ec2…`）；逐字节比对与源文件一致。
- `docs/README.md` 阅读顺序在第 6 条「代码结构审查」之后插入新的第 7 条「代码可读性评估」，原第 7–14 条顺延为第 8–15 条。
- 在仓库根目录运行 `node scripts/readability-metrics.cjs`，exit 0，输出含 `## Highest import fan-in` 一节（`src/store/workflowStore.ts` 60、`src/domain/contracts.ts` 58、`src/projectControl/types.ts` 58）。注意：该脚本在后台作业 + 输出重定向下会以 `stdin is not a tty` 失败（exit 1），必须在前台运行。
- 验证结果（code snapshot `021a42797914cab6d36a3e01aeae40dc3e598dc4`）：`npm run test` 238 files / 1,544 tests 全部通过；`npm run build` 通过；`npx tsc -p tsconfig.app.json --noEmit` 无输出；`npm run i18n:check` 1,139 keys 对齐；`git diff --check` 无空白错误。
- 本地提交 `021a42797914cab6d36a3e01aeae40dc3e598dc4`，tag `checkpoint/readability-import-unverified-20261013-r4`（文档/脚本切片，无行为改动、无独立 reviewer verdict）。未 push。

### 7.446 回填与更正：closeout-run-r4 Slice4 verified 账目

- 按计划补打 `checkpoint/test-hygiene-verified-20261013` → `cd4be6d4fc0f83f9fc4c278dada76fe7048179e5`（parent `0ac830fc2313a177d40018df5101d48abb9235b5`），与既有 `checkpoint/test-hygiene-unverified-20261013` 成对指向同一 commit；这是本轮边界第 2 条不加 `-r4` 的唯一例外。创建前确认该 tag 名不存在，未覆盖任何已有 tag。
- 该 verified 的三项证据来自上一轮已经产生的真实记录：Windows Node 26.7.0 与 Node 22.23.2 各 3 次全量 232 files / 1,530 tests 通过，build/app tsc/i18n 1,112/`git diff --check` 通过；exact reviewer 只读 Git 对象，返回严格 JSON `passed=true`、`security_concerns=[]`、`logic_errors=[]`；非界面改动，按边界第 8 条不需要 GUI 回读。WSL Node 24 在 scratch 安装后 420 秒超时无汇总，上一份任务书列为可选项，不构成缺口，也不写成通过。
- `docs/HISTORICAL_UNVERIFIED_TRIAGE.md` 新增「Phase2 拆分与收口回填（2026-10-12/13）」一节：记录本次 verified 回填；把 `0a66c2ff7eb3464e782a838aff43b7abddeb3608` 记为被 `cd4be6d` 取代、`1be58a18f92dddea02502131129abe72ed0da710`（fix4）保持 evidence-missing；并写明 `checkpoint/readability-project-session-verified-20261013` 的更正——tag 保留不删不移，但没有同快照 GUI 回读，不满足本轮边界第 8 条的 verified 条件，最终以切片 5 的分支整体验证为准。
- 本切片不改代码，只提交文档；无独立 reviewer verdict。未 push。

### 7.447 partial/unverified：closeout-run-r4 Slice5 分支整体验证（GUI 门未通过）

- 验证对象 `43093da1c1d10fbafff25c6c88946abb22ad93be`（范围 `1e20309..43093da`，108 文件 / +10,719 / −6,028）。质量门全过：`npm run test` 238 files / 1,544 tests；`npm run build`；`npx tsc -p tsconfig.app.json --noEmit` 与 `npx tsc --noEmit` 均无输出；`npm run i18n:check` 1,139 keys 对齐；`git diff --check` 无空白错误；`node scripts/readability-metrics.cjs` exit 0 且含 `Highest import fan-in`。
- 度量与评估文档「进展」表的 `75f954b` 列逐项比对全部不变：>300 行函数 15、复杂度 >50 为 11、参数 ≥6 为 21、`src/projectControl` 注释率 1.0%、导出 JSDoc 38.2%、>600 行生产文件 11、`workflowStore.ts` fan-in 60。生产文件 348→350（新增 `src/i18n/dateTime.ts`、`src/store/workflowId.ts`）、生产行 69,087→69,185；测试文件 234→239、测试行 38,708→39,031。metrics JSON 写入仓库外 scratch。
- 浏览器回读（全新上下文，CDP 在 `Page.navigate` 前开启 `Log`/`Runtime`）：29 步、`Log` error 与 `Runtime.exceptionThrown` 均 0；`<html lang>`/`document.title` 随语言切换（`zh-CN`→`en-US`、`SlimeMold · Agent 工作流`→`SlimeMold · Agent Workflows`），切换走产品自身的设置中心 `<select>`。全新配置首页是轻量工作台、产品没有进入 advanced 的可见入口，按计划在加载前写入 `workspaceMode=advanced`（已在报告注明）。
- 真实 Tauri 回读（全新 identifier `com.slimemold.verify.r4` + `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`）：Vite/Rust/真实窗口均就绪；`Network.responseReceived` 记录 `http://localhost:1420/favicon.ico` → **200 `image/x-icon`**，`Log` 与 `Runtime.exceptionThrown` **0 条**（上一轮此处为 favicon 404）。切英文后 `<html lang>`=`en-US`、标题 `SlimeMold · Agent Workflows`，状态栏自动保存时间显示 `2:40:03 PM`（不再是「上午」），运行日志面板无 `pluginManager` 中文启动日志。未新建 ProjectSession、未打开项目、未运行 workflow、未调用模型；`%APPDATA%\com.slimemold.verify.r4` 下只有 `plugins/`。回读后已结束应用与 Vite，端口 1420 与 9222 均释放，无残留 `slime-mold.exe`。
- **未通过 GUI 门：** 英文模式仍出现未登记的中文字面量标签——`src/agents/agentManager.ts:125,130,135,140,145` 的协议标签（含 `Ollama 本地`、`OpenAI Codex（ChatGPT 订阅）`、`Antigravity CLI（交互式）`）、`:168,176,184,192,200` 的模型预设名（`OpenAI 官方`、`DeepSeek 官方`、`硅基流动 SiliconFlow`、`OpenRouter 聚合`、`自定义中转`）、`src/components/RouteTableEditor.tsx:65,87` 的 `○ 未绑定` 与 `回退链`。这些文件不在切片 1b 点名清单，也不在 `uiChineseLiterals.test.ts` 的扫描范围/白名单，本轮边界未授权扩大修复范围，故只定位未修。
- 按任务书切片 5 第 4 条「任何一项不满足：不打 tag，写清缺口，继续后面的切片」，**未创建** `checkpoint/monolith-split-2-final-*`。独立 reviewer 已按计划派发（只读 Git 对象审查 `1e20309..43093da`，要求严格 JSON），verdict 尚未返回；返回后需重新 read-back HEAD/status/reflog 并核对 `reviewed_head`。
- 证据：`.hermes/reports/assets/` 下 92 张截图与 `r4-slice5-readback-manifest.json`（112 个证据文件的存在性、字节数与 SHA-256），scratch 里保存浏览器与 Tauri 的 CDP 报告 JSON/LOG。详见报告 `.hermes/reports/2026-10-13-closeout-r4.md`。未 push。

### 7.448 unverified：closeout-run-r4 Slice6 一致性检查参数对象化

- 目标函数改动前（行/复杂度/嵌套/参数）：`workerReceiptSuccessProvenanceMatches` 38/6/2/**7**、`workerReceiptEvidenceMatches` 25/2/0/**7**、`workerReceiptAcceptanceMatches` 21/3/0/**6**、`checkWorkerTask` 51/9/1/**6**、`checkAcceptanceStage` 38/11/1/**6**。
- 做法：新增两个文件内参数对象类型 `WorkerReceiptProvenanceContext` 与 `WorkerTaskCheckContext`；五个函数统一变成「参数对象 + 1–2 个位置参数」，函数体与判定顺序、短路、日志、store 写入均按原样搬运。`src/store/workflowStore.ts` 与其他禁区文件未触碰。
- 改动后：五个函数参数均为 **3**，行数 20/22/19/49/36；被触及文件中 >250 行或复杂度 >25 的函数数量没有增加（两个文件的最大复杂度仍是原有的 22）。
- 测试：上一轮冻结的金样 `src/projectControl/workerRunConsistency.test.ts.snap`（提交 `6bb6dc5`）与 `workerRunConsistencyAction.test.ts` 未改动且通过（23 + 3 tests）；已核对 `git diff --stat` 确认测试与快照文件不在本次 diff 内。纯结构改动，按 TDD 约定使用改前通过的既有特征测试作为基线，不制造人为 RED。
- 验证结果（code snapshot `81d22c69bbda64584ecddb76a9486a323eeb77d7`）：`npm run test` 238 files / 1,544 tests；`npm run build` 通过；`npx tsc -p tsconfig.app.json --noEmit` 无输出；`npm run i18n:check` 1,139 keys；`git diff --check` 无空白错误。
- 本地提交 `81d22c69bbda64584ecddb76a9486a323eeb77d7`，tag `checkpoint/readability-check-params-unverified-20261013-r4`；非界面改动，不需要 GUI 回读。独立 reviewer 已派发审查 `8e05743..81d22c6`（要求严格 JSON + `behavior_preserving`），verdict 未返回，故本切片暂保持 unverified。未 push。

### 7.449 unverified：closeout-run-r4 Slice7 WorkflowEditor 拆分

- 改动前：`WorkflowEditorInner`（`src/canvas/WorkflowEditor.tsx:64`）507 行 / 复杂度 17；同文件还有 `<callback of useEffect>` 86 行与 `onMove` 60 行的框选监听。
- 按上一轮盘点的顺序拆出 5 个模块：`src/canvas/useSplitWorkflowGraph.ts`（拆分视图本地图 + 「载入 effect ↔ 写回 effect」内容指纹同步）、`src/canvas/useRightBoxSelection.ts`（右键框选状态/refs/监听与自愈清理）、`src/canvas/useCanvasReconnect.ts`（既有 `onReconnect` 行为整体搬运，含环路与端口类型校验、主画布写 store / 分栏写本地副本分支）、`src/canvas/useCanvasDrop.ts`（drop 三分支；`DND_MIME` 移到此处并从 `WorkflowEditor.tsx` re-export，保持既有导入路径）、`src/canvas/connectValidation.ts`（纯函数 `canConnectEdges`）。
- `useReactFlow()` 上移到组件顶部以便 hook 复用；`suppressSelectionSync` / `rightStart` / `rightMovedRef` 仍由组件持有（hook 返回同一批 ref），`onPaneClick` 的清理与 `onSelectionChange` 的判断未改。依赖数组与实现体按原样搬运，未改动 `useWorkflowStore.getState()` 直读。
- 改动后：`WorkflowEditorInner` **265 行**（目标 ≤300 ✓）/ 复杂度 17；新函数最大为 `useRightBoxSelection` 117 行、复杂度 1（≤250 / ≤25 ✓）；被触及文件里 >250 行或复杂度 >25 的函数数量没有增加（`WorkflowEditor.tsx` 仍为 1 个）。
- 测试：`src/canvas/WorkflowEditor.test.tsx`（上一轮的特征测试，6 tests：空画布新建、模板载入、主画布复用 App Provider / 分栏隔离 Provider、分栏挂载与写回、同指纹换目标、不同目标不被覆盖）未改动且通过；纯结构改动不制造人为 RED。
- 验证结果（code snapshot `39f54f45c7ac57ccee92728dff2b9a25738eb52e`）：`npm run test` 238 files / 1,544 tests；`npm run build` 通过；`npx tsc -p tsconfig.app.json --noEmit` 无输出；`npm run i18n:check` 1,139 keys；`git diff --check` 无空白错误。
- 浏览器 GUI 回读（全新上下文，CDP 从页面加载前记录 `Log`/`Runtime`）：空画布欢迎页 → 新建项目弹窗 → 编辑器；新建第二个工作流后进入拆分视图（`.react-flow` 实例数 1→2，左栏 pane 宽 1070→535）；在画布上按住右键拖动，截到半透明蓝色框选矩形。全程 `Log` error 与 `Runtime.exceptionThrown` **0 条**。截图 `r4-slice7-welcome.png`、`r4-slice7-new-project-modal.png`、`r4-slice7-editor.png`、`r4-slice7-editor-second-workflow.png`、`r4-slice7-split-view.png`、`r4-slice7-right-box-selecting.png`、`r4-slice7-right-box-released.png`（存 `.hermes/reports/assets/`，被 git 忽略）。
- 本地提交 `39f54f45c7ac57ccee92728dff2b9a25738eb52e`，tag `checkpoint/readability-workflow-editor-unverified-20261013-r4`。这是界面改动，需要有同一快照的独立 reviewer verdict 才满足 verified 条件；reviewer 已派发审查 `31b5785..39f54f4`，verdict 未返回，故暂保持 unverified。未 push。

### 7.450 unverified：closeout-run-r4 Slice8 executeNode 阶段化拆分

- 目标函数改动前（行/复杂度/嵌套/参数）：`executeNode`（`src/engine/executor.ts:534`）**380 / 43 / 3 / 1**（取自切片 0 基线 `r4-slice0-metrics.json`）。
- 新增模块 `src/engine/executorNodePhases.ts`，把函数体按阶段拆开：`applyNodeDecision`（决策副作用，8 个终态分支按原顺序搬运，终态返回 `false`、`execute` 返回 `true`）、`createNodeSandboxAndLlm` + `buildNodeExecutionContext`（沙箱、节点 storage/vars、LLM 与上下文适配器、`ExecContext` 组装、`applyCapability`）、`runNodeWithRetry`（代次守卫 → running/事件/日志 → `withRetry(def.execute)` → `handleNodeSuccess`/`handleNodeFailure`）、`resolveNodePolicy`（`resolveNodeExecutionMode` + `composeCacheScope` + `decideNodeExecution`）、`createTrackCost`（成本记账回调）。`ExecuteNodeArgs` 一并迁到新模块并从 `executor.ts` 原路径 re-export。
- 两个需要说明的等价处理：(1) LLM 适配器的 `getTools` 原先是同作用域闭包捕获 `ctx`，拆开后改为迟绑定 holder（`ctxHolder.current`），并在未就绪时抛显式错误——拆分前该情形抛的是 TDZ `ReferenceError`，两者都是执行期异常、走同一条节点失败路径；(2) `collectInputs(...)` 由调用方在进入 `runNodeWithRetry` 前求值（该函数是纯函数，只读 `edges`/`outputsMap`）。其余判定顺序、短路、store 直读、事件与日志文案、重试常量（`NODE_RETRIES`/`NODE_RETRY_BASE_MS`）、代次守卫比较（`myRun !==` / `targetRunId !==`）均按原样搬运。
- 改动后：`executeNode` **72 / 7 / 1 / 1**（主函数 ≤100 ✓）；新函数 `applyNodeDecision` 98/CX18、`runNodeWithRetry` 120/CX12、`createNodeSandboxAndLlm` 69/CX6、`buildNodeExecutionContext` 63/CX3、`resolveNodePolicy` 57/CX3、`createTrackCost` 32/CX1（辅助函数 ≤120 行、复杂度 ≤20 ✓）。`src/engine/executor.ts` 由 735 行降到 630 行。
- 测试：`src/engine/*.test.ts`（含上一轮为 `executeNode` 补的特征测试）35 files / 338 tests 全绿；未改动任何测试或断言；未触碰函数内对 `useWorkflowStore.getState()` 的直读。
- 验证结果（code snapshot `8f60b801757d9c2c3f9e9c19e72472103bd1436c`）：`npm run test` 238 files / 1,544 tests；`npm run build` 通过；`npx tsc -p tsconfig.app.json --noEmit` 无输出；`npm run i18n:check` 1,139 keys；`git diff --check` 无空白错误。
- 本地提交 `8f60b801757d9c2c3f9e9c19e72472103bd1436c`，tag `checkpoint/readability-execute-node-body-unverified-20261013-r4`。非界面改动，不需要 GUI 回读；独立 reviewer 已派发审查 `8e05743..8f60b80`，verdict 未返回，故暂保持 unverified。未 push。

### 7.451 unverified：closeout-run-r4 Slice9 runWorkflow 阶段化拆分

- 目标函数改动前（行/复杂度/嵌套/参数）：`runWorkflow`（`src/engine/executor.ts:156`）**337 / 59 / 6 / 1**（取自切片 0 基线 `r4-slice0-metrics.json`）。
- 新增模块 `src/engine/runWorkflowPhases.ts`，按阶段拆开：`admitWorkflowRun`（写运行态检查 + 并发准入 + superseded 残留清理 + `syncDebugRun` + 运行资源登记）、`setupRunSandbox`（Git Worktree 强隔离探测与降级日志）、`prepareExecutionPlan`（空图校验 + `compileExecutionPlan` + 子图展开日志 + 死循环校验与 abort 结果）、`applyCacheInvalidation`（全量清脏标记 / 增量保留 / force strike / `forceRerun` 清空缓存）、`startRunSession`（`setRunning`/`resetStatuses`/`RunContext`/`run.created`/事件日志 attach/`resetUsage`/`beginRun`/限流器/`ExperienceSink`/开始运行日志）、`createRunExecutionState`（输出预填、分支状态、失败集、裁剪集、`nodeById`、计时、成本账本、循环门与循环变量）、`runLoopRounds`（`prepareLoopRound` → 逐 stage `runStage` → `shouldContinueLoop` 回环判定与轮次日志）、`finalizeWorkflowRun`（收口到既有 `runFinalizer.finalizeRun`）、`finishRunCleanup`（finally 段的代次复位、资源清理、介入取消、事件日志 detach）。
- 需要说明的接线改动（均为等价搬运）：`executeNode`、`executionCoordinator`、`syncDebugRun`、`scheduleRunCheckpoint` 以参数注入阶段函数（保持同一实例/同一闭包语义，避免模块循环依赖）；`startRunSession` 原本在 `try` 顶部声明、`run.created` 后赋值的 `detachEventLog` 改为由会话对象返回再赋给外层变量；`admission` 在阶段函数里收窄为「准入通过」分支（`Extract<…, { signal: AbortSignal }>`），被拒绝分支仍在 `admitWorkflowRun` 内直接返回 abort 结果。
- 顺带按 600 行上限收口：`executeNode` 阶段文件超过 600 行（630），把 `createTrackCost` 与前置决策解析拆到新模块 `src/engine/executorNodePolicy.ts`（131 行），`executorNodePhases.ts` 降到 508 行。`src/engine/executor.ts` 由 630 行降到 **376 行**（退出「生产文件 >600 行」名单）。
- 改动后：`runWorkflow` **88 / 10 / 2 / 1**（主函数 ≤100 行、嵌套 ≤3 ✓）；新函数 `runLoopRounds` 113/CX11/嵌套3、`startRunSession` 53、`prepareExecutionPlan` 49、`createRunExecutionState` 44、`admitWorkflowRun` 30、`finalizeWorkflowRun` 30、`setupRunSandbox` 27（辅助函数均 ≤120 行）。未改动 `useWorkflowStore.getState()` 的直读位置与判定顺序。
- 测试：`src/engine/*.test.ts`（含 `executorLifecycle`/`executorEvents`/`executorIntervene`/`executorCapability` 等）35 files / 338 tests 全绿；未改动任何测试或断言。
- 验证结果（code snapshot `cbc6f4a5d0717b2ea1cd1430e33bcfbfdb70abf7`）：`npm run test` 238 files / 1,544 tests；`npm run build` 通过；`npx tsc -p tsconfig.app.json --noEmit` 无输出；`npm run i18n:check` 1,139 keys；`git diff --check` 无空白错误。
- 本地提交 `cbc6f4a5d0717b2ea1cd1430e33bcfbfdb70abf7`，tag `checkpoint/readability-run-workflow-unverified-20261013-r4`。非界面改动，不需要 GUI 回读；未 push。

### 7.452 unverified：closeout-run-r4 加时切片——TopBar 拆分（界面改动）

- 目标函数改动前（行/复杂度/嵌套/参数）：`TopBar`（`src/components/TopBar.tsx`）**417 / 16 / 0 / 1**（计划加时切片清单里的口径；R4 Slice0 基线同值）。
- 拆出三个 props 驱动的模块：`src/components/topBar/topBarMenus.tsx`（`buildTopBarMenus`，文件/编辑/视图/运行/工具/帮助六组菜单的定义与图标，123 行/CX8）、`src/components/topBar/WorkflowTabStrip.tsx`（项目面包屑 + 工作流标签浏览器 + 新建按钮，保留 `children` 插槽以维持与原 DOM 相同的层级）、`src/components/topBar/TopBarActionButtons.tsx`（拆分视图/复位/调试/撤销重做/运行-停止，69 行/CX5）。
- 等价搬运说明：「打开最近项目」子菜单原本内联在菜单数组里做 `openProjectByPath → openProject → persistSession → pushRecentProject → addLog`，现由 `buildTopBarMenus` 回调 `onOpenRecent(path)`，实现在 `TopBar.handleOpenRecent`（同一顺序、同一 store 调用）；标签条的新建按钮逻辑抽到 `TopBar.handleNewWorkflow`（项目内直接新建；游离态先 `openDirDialog()` 再 `newWorkflowInProject(ws)`）。class 名、title 文案、disabled 条件、`data-active` 与内联 style 均按原样保留。
- 改动后：`TopBar` **241 / 1 / 0 / 1**（界面组件低于计划给 WorkflowEditorInner 的 ≤300 口径）。上一轮已补的快捷键回归测试（`src/components/TopBar.test.tsx`，4 tests，含 `routes the new-project keyboard shortcut through its container callback`）未改动且通过，满足计划「拆 TopBar 前先补快捷键回归测试」的前置要求。
- 浏览器 GUI 回读（全新 profile + 加载前注入 `workspaceMode=advanced`，CDP 从页面加载前记录 `Log`/`Runtime`）：欢迎页 → 新建项目 → 创建项目 → 编辑器。顶栏为品牌 + 六个菜单按钮（文件/编辑/视图/运行工作流/工具/帮助）；文件菜单展开后 11 个条目与快捷键标注齐全（含红色 danger 的「关闭项目」）；运行菜单可展开；工具条含项目面包屑、工作流标签、拆分视图/复位/调试/撤销/重做/运行按钮，撤销与重做的 disabled 状态与 store 一致。全程 `Log` error 与 `Runtime.exceptionThrown` **0 条**。截图 `r4-addon-topbar-01-shell.png`、`r4-addon-topbar-02-file-menu.png`、`r4-addon-topbar-03-run-menu.png`、`r4-addon-topbar-04-split-view.png`（`.hermes/reports/assets/`，被 git 忽略），证据 JSON `D:/Hermes/cache/scratch/r4-addon-topbar-tour.json`。
- 验证结果（code snapshot `20790a4`）：`npm run test` 238 files / 1,544 tests；`npm run build` 通过；`npx tsc -p tsconfig.app.json --noEmit` 无输出；`npm run i18n:check` 1,139 keys；`git diff --check` 无空白错误。
- 本地提交 `20790a4`，tag `checkpoint/readability-topbar-unverified-20261013-r4`。界面改动但尚无同快照独立 reviewer verdict，故保持 unverified。未 push。

### 7.453 unverified：closeout-run-r4 加时切片——AgentEditorForm 拆分（界面改动）

- 目标函数改动前（行/复杂度/嵌套/参数）：`AgentEditorForm`（`src/components/agentPanel/AgentEditorForm.tsx`）**302 / 54 / 0 / 1**（计划加时切片清单里的口径；该函数是本轮复杂度最高的界面函数）。
- 拆出两个 props 驱动的字段组：`AgentConnectionFields`（协议下拉、按协议分支的 Base URL、按协议分支的凭据区 `CodexAuthField`/`AntigravityCliField`/`ApiKeyField`/Ollama 提示，92 行）、`AgentModelFields`（模型标签与下拉、拉取/探测按钮、Ollama note、`modelHint`、探测结果卡片、两条提示分支、手填模型输入，以及紧随其后的温度滑块与高级代理折叠区，191 行）。两者各自 `useT('agents')`，不再由父组件透传文案函数。
- 改动后：`AgentEditorForm` **109 / 11 / 0 / 1**（复杂度过 50 的界面函数清零）；子组件各自的判定分支与 JSX 属性按原样搬运，DOM 顺序未变（名称 → 协议 → Base URL → 凭据 → 模型 → 温度 → 高级）。
- 测试：`src/components/AgentPanel.test.tsx`（7 tests）未改动且通过；全量 `npm run test` 238 files / 1,544 tests 通过。
- 浏览器 GUI 回读（全新 profile + 加载前注入 `workspaceMode=advanced`，CDP 从页面加载前记录 `Log`/`Runtime`）：欢迎页 → 新建项目 → 创建项目 → 左侧「智能体库」→ 点选「Ollama 本地智能体」→「编辑」。表单实测到协议下拉（5 个选项，当前 `ollama`）、模型下拉（6 个选项，当前 `qwen2.5:3b`）、温度滑块 1 个、高级折叠区 1 个，标签为「名称 / 协议 / Base URL / 模型（本地 Ollama）/ 温度（0.7）」。全程 `Log` error 与 `Runtime.exceptionThrown` **0 条**。截图 `r4-addon-agentform-01-library.png`、`r4-addon-agentform-02-editor.png`、`r4-addon-agentform-03-protocol-switched.png`，证据 JSON `D:/Hermes/cache/scratch/r4-addon-agentform-tour.json`。
- 验证结果（code snapshot `d2ea241`）：`npm run test` 238 files / 1,544 tests；`npm run build` 通过；`npx tsc -p tsconfig.app.json --noEmit` 无输出；`npm run i18n:check` 1,139 keys；`git diff --check` 无空白错误。
- 本地提交 `d2ea241`，tag `checkpoint/readability-agent-editor-form-unverified-20261013-r4`。界面改动但尚无同快照独立 reviewer verdict，故保持 unverified。未 push。

### 7.454 unverified：closeout-run-r4 加时切片——编排面板拆分（界面改动，部分完成）

- 目标函数改动前（行/复杂度/嵌套/参数）：`OrchestratorPanelDetailView` **304 / 14 / 0 / 1**（内含 `<callback of selected.draft?.stages.map>` **124 / 22 / 0 / 2**）、`OrchestratorPanel` **417 / 8 / 1 / 1**（内含 `<callback of useMemo>` 37 / 10、`onReviseTaskGraph` 56 / 18）。
- 已完成：阶段卡片抽成 `src/components/OrchestratorStageCard.tsx`（序号/角色/智能体、阶段日志状态、目标、产物方向、绑定下拉、已固化工作流与打开按钮、日志详情；`roleLabel`/`logStatusCls`/`formatTime` 由其自取），DAG 投影抽成 `src/components/orchestratorPanelTaskGraph.ts` 的 `computeOrchestratorTaskGraph`（原 `useMemo` 回调原样搬运，依赖数组粒度仍是 `projectControl.issues`/`projectControl.taskGraphs`）。卡片仍从 `useT('panels')` 取文案，绑定回调的 `parentId` 由调用方传入，DOM 与分支顺序未变。
- 改动后：`OrchestratorPanelDetailView` **202 / 14 / 0 / 1**（124 行/CX22 的内联回调消失）；`OrchestratorPanel` **386 / 8 / 1 / 1**。
- **未完成部分（如实记录）**：`OrchestratorPanel` 仍高于计划给组件类函数的 300 行口径。剩余体量不是单一热点，而是 143–374 行之间约 230 行的十多个小处理器（最大 `onReviseTaskGraph` 56 行/CX18，其后 `onRun` 35 行）。按 45 分钟时间盒我停在“抽卡片 + 抽投影”这一步，没有在盒子末尾做需要改动整批闭包的动作层重构（`useOrchestratorPanelActions`）；该项已记入报告“重构中未修的问题”，供下一轮或用户裁决。
- 测试：`src/components/OrchestratorPanel.test.tsx`（5 tests，覆盖真实 worker-run 恢复/清理流程）未改动且通过；全量 `npm run test` 238 files / 1,544 tests 通过。（`OrchestratorPanelDetailView.test.tsx` 不存在，故未运行。）
- 浏览器 GUI 回读（全新 profile + 加载前注入 `workspaceMode=advanced`，CDP 从页面加载前记录 `Log`/`Runtime`）：新建项目 → 打开左侧「编排」面板 → 输入目标并点「生成草案」→ 生成 3 阶段草案（日志「编排草案已生成 … 共 3 个阶段」）→ 点选草案进入详情。详情渲染出状态「待确认」、返回按钮、目标文本与带序号的阶段卡片（① 规划 / ② 实施，含角色、智能体名、状态徽标、目标、`→ plan` / `→ plan → project` 产物方向、绑定下拉与页脚「固化工作流 / 确认草案 / 删除」），证明抽出的阶段卡片与面板接线正常。全程 `Log` error 与 `Runtime.exceptionThrown` **0 条**。截图 `r4-addon-orch-01-list.png`、`r4-addon-orch-02-draft.png`、`r4-addon-orch-03-detail.png`，证据 JSON `D:/Hermes/cache/scratch/r4-addon-orch-tour.json`。
- 验证结果（code snapshot `9d8ffac`）：`npm run test` 238 files / 1,544 tests；`npm run build` 通过；`npx tsc -p tsconfig.app.json --noEmit` 无输出；`npm run i18n:check` 1,139 keys；`git diff --check` 无空白错误。
- 本地提交 `9d8ffac`，tag `checkpoint/readability-orchestrator-panel-unverified-20261013-r4`。界面改动但尚无同快照独立 reviewer verdict，故保持 unverified。未 push。

### 7.455 unverified：closeout-run-r4 加时切片——运行日志 i18n（引擎运行环，部分完成）

- 范围与口径：按切片 1b 的 AST 扫描（`D:/Hermes/cache/scratch/r4-cn-log-ast.cjs`）把「运行时中文日志」移进 i18n；跳过计划边界第 4、5 条的禁区文件（`workerRunRecoveryAuditController.ts`、`workerCleanupProposalController.ts` 等恢复/清理文件）。
- 本轮完成：引擎运行环的三条文件，共 18 处日志——`src/engine/executor.ts`（停跑日志、无失败节点、断点续跑）、`src/engine/runWorkflowPhases.ts`（并发拦截、强制重启、Worktree 四种降级、空图、子图展开、死循环、清空缓存、开始运行与模式、轮次开始/结束）、`src/engine/executorNodePhases.ts`（AI 处理中、节点重试）。`ui.xml` 新增 `log.*` 31 个 key（zh-CN/en-US 同步），`i18n:check` 从 1,139 → **1,170** key。
- 有意保留中文（不进 i18n，按项目既有例外政策登记理由）：**会持久化的字符串**——`RunResult.error`（并发拦截/空图/死循环）、节点状态里的错误文案（上游失败已跳过、类型缺失、死循环节点）、`节点不存在`（现收成常量 `ERR_NODE_MISSING`，此前同一字面量在 3 处重复）；以及开发者控制台诊断（`scheduleRunCheckpoint` 落盘失败告警）与运行环内部不变量错误（`getTools` 在 ctx 组装前被调用）。理由统一为「本地化会改变已存溯源」或「仅开发者控制台可见」，与既有 `OrchestratorPanel` 持久化审计原因、`Inspector` 诊断的例外同类。
- 覆盖测试：把三个文件加入 `src/i18n/uiChineseLiterals.test.ts` 的 `TARGET_FILES` 与 `NAMESPACE_CANDIDATES`（命名空间 `ui`），并为上述保留字符串补 11 条带理由的 `EXCEPTIONS`；该测试（3 tests）现在同时校验「无未登记汉字」与「`i18n.t('log.*')` 的 key 在两种语言里都存在」。
- 未完成部分（如实记录）：扫描显示仍余 **45 处 / 15 个文件**，其中 5 处在禁区文件内（不动），可继续处理的还有 **40 处 / 13 个文件**：`runFinalizer.ts` 9、`io/workflowIO.ts` 6、`store/workflowSubgraphCommands.ts` 5、`platform/env.ts` 4、`agents/harness.ts` 3、`store/projectSaveAsController.ts` 3、`hooks/useWorkflowFileDrop.ts` 2、`store/workflowGroupCommands.ts` 2、`store/workflowProjectDataCommands.ts` 2、`app/globalShortcuts.ts` 1、`components/PluginPanel.tsx` 1、`store/projectCreationActions.ts` 1、`store/workflowGraphCommands.ts` 1。本轮按 1 小时时间盒停在引擎运行环这一批。
- 验证结果（code snapshot `1b8d541`）：`npm run test` 238 files / 1,544 tests；`npm run build` 通过；`npx tsc -p tsconfig.app.json --noEmit` 与 `npx tsc --noEmit` 均无输出；`npm run i18n:check` 1,170 keys 对齐；`git diff --check` 无空白错误。
- 本地提交 `1b8d541`，tag `checkpoint/runtime-log-i18n-unverified-20261013-r4`。非界面改动，不需要 GUI 回读；未 push。

### 7.456 unverified：closeout-run-r4 Slice5 exact review 延迟回执

- 用户在收尾后收到 Slice5 独立 reviewer 的异步回执；review 范围精确为 `1e2030983bbb606315e9d9a2f5b421f29c0b3855..43093da1c1d10fbafff25c6c88946abb22ad93be`，JSON 报告 `passed=true`、`reviewed_head=43093da1c1d10fbafff25c6c88946abb22ad93be`、`working_tree_clean=true`，**无 high/medium security concern 或 logic error**。只读对象评审覆盖 108 files（+10,719/−6,028）；没有重跑测试、构建、metrics 或 GUI，故只完成 Slice5 的独立代码评审项，不改变 GUI 门失败与 Slice5 partial/unverified 结论。
- Reviewer 留下的四项 low 观察均记录在 ignored 本地报告 `.hermes/reports/2026-10-13-closeout-r4.md` 的「Slice5 独立评审」段：① 其读取的 `43093da` 本地 report 仍旧（当前报告后来已更新至本轮结束状态）；② 63→45 的 AST 日志扫描只统计直接字面量参数，遗漏经状态对象传递的 fallback（如 `workflowCatalogCommands.ts:68` ← `projectCatalogState.ts:112`）；③ metrics `--json` 只校验 `.json` 后缀、不阻止覆盖仓库内 JSON；④ `workflowStore.ts` 时间戳使用 view-store locale，而其他格式化使用 `i18n.language`，现有切换路径同步但未来存在双 source 风险。均为低风险/报告口径问题；不在本次补记切片授权范围内，未改代码。
- 工作区核对：异步结果到达时主分支仍是 `refactor/monolith-split-2`、HEAD=`fcca2a087d52eb93b473cc726f490fbd93848dae`、tracked 工作区干净；用户通知的 Vite `ready` 端口此时已无 listener，本轮未重启或终止用户进程。
- 本次仅创建回执起点空提交 `4e92acfd05ffcf972df1de0346880558068bdbe8` 与 tag `checkpoint/r4-slice5-review-receipt-start-20261013`，更新本地 ignored 报告与本开发日志；没有新代码改动、没有 verified tag、未 push。Slice5 仍 unverified，因为英文 Tauri GUI 门失败；Slice6/7/8 的三份独立评审仍未返回。

### 7.457 unverified：closeout-run-r4 Slice6 parameter-object exact review 回执与快照路径更正

- Slice6 reviewer 的只读 JSON 回执范围为 `8e05743cfc3fc489a0bc661f8558c163f376fba5..81d22c69bbda64584ecddb76a9486a323eeb77d7`，`passed=true`、`behavior_preserving=true`，security/logic findings 均为空。对象级对照确认 5 个函数只改参数传递、函数体与副作用/布尔短路顺序未变；冻结测试与 snapshot blobs 在 target 上未改。
- **fail-closed 状态**：reviewer 回报 `working_tree_clean=false`。其说明开始时 HEAD=`81d22c6` 且 clean，但review结束前出现并发 HEAD 前进到 `31b5785` 与 5 个未跟踪 `src/canvas/*.ts` 文件；reviewer 只读不可变 Git 对象，并核对两个被审 worker 文件在 `81d22c6`/`31b5785` blob 相同、没有 tracked 修改。由于最终 worktree cleanliness 不满足严格验收要求，记录为固定对象上的正向代码审查意见，**不升级 slice tag、不标 verified**；该 review 未运行 tsc、Vitest、build 或 lint。review 的可维护性建议（readonly context fields、上下文对象有重叠字段、unused `taskId` 等）按计划范围作为非阻塞建议，不改代码。
- 快照路径更正：7.448 写的 `src/projectControl/workerRunConsistency.test.snap` 是错误路径；`git ls-tree -r 6bb6dc5` 确认实际金样为 `src/projectControl/__snapshots__/workerRunConsistency.test.ts.snap`。本轮仅补充更正说明，不改写历史条目，也不改 snapshot。
- 收尾状态核对：主分支 `refactor/monolith-split-2` 当前 worktree clean；本次 review receipt 起点 `f25ee235d98a9c9195503c251c5ef6e9f99bb8f3` / tag `checkpoint/r4-slice6-review-receipt-start-20261013`。既有 slice6 code tag `checkpoint/readability-check-params-unverified-20261013-r4` 继续指向 `81d22c6` 并保持 unverified；未 push。

### 7.458 verified：Slice6 clean exact re-review；Slice7 dirty verdict fail-closed

- Slice6 第二次只读评审固定范围为 `8e05743cfc3fc489a0bc661f8558c163f376fba5..81d22c69bbda64584ecddb76a9486a323eeb77d7`，JSON 精确返回 target、`working_tree_clean=true`、`passed=true`、`behavior_preserving=true`，`security_concerns`、`logic_errors`、`behavior_differences` 均为空。reviewer 在 clean 且 HEAD 稳定的 worktree 中通过 Git 对象读取了完整 diff、前后代码、调用点与冻结测试/snapshot；没有运行 tests/build/typecheck。
- gates 不把 reviewer 的声明替代为执行结果：同一 target 的全量测试 238 files / 1,544 tests、build、app tsc、i18n 1,139 keys、diff-check，以及上一轮冻结 golden 23+3 tests，已有 7.448 的同快照实测记录；此次没有重跑。另确认 `git diff 81d22c6..HEAD` 在两个被审生产文件为空。
- 首次 Slice6 review 因其结束时 `working_tree_clean=false` 已 fail-closed 丢弃；第二次 clean re-review 补齐独立评审门。创建并 read-back `checkpoint/readability-check-params-verified-20261013-r4`，目标精确为 `81d22c69bbda64584ecddb76a9486a323eeb77d7`。原 `checkpoint/readability-check-params-unverified-20261013-r4` 与起点 tags 均保留；该 verified 标记只对 Slice6 代码快照有效，不迁移到后续 HEAD、不代表 R4 整体已 verified。
- Slice7 reviewer 对 `31b5785951dfecb3d141032cc576c097c5a75865..39f54f45c7ac57ccee92728dff2b9a25738eb52e` 返回 `passed=true` / `behavior_preserving=true`，无 security/logic findings；但回执报告 `working_tree_clean=false`：开始时 clean/HEAD=`39f54f4`，结束前并发前进至 `e7af606` 且出现未跟踪 `src/engine/executorNodePhases.ts`。reviewer 指出它只读不可变 Git 对象且被审 6 个路径在后续 HEAD 中无 diff；仍依 fail-closed 规则不采用该 verdict、不升级 tag，需 clean worktree 下对相同 immutable range 重审。
- 本次审查记录阶段起点 checkpoint `a4fb73c02fd8e6585cf62264b4892f6176c4801e` / tag `checkpoint/r4-slice6-clean-review-record-start-20261013`；没有代码改动、未 push。R4 整体仍受 Slice5 英文 Tauri GUI 中文标签门阻塞。

### 7.459 verified：Slice7 clean exact review；收尾 metrics 更正

- Slice7 clean re-review 的精确范围为 `31b5785951dfecb3d141032cc576c097c5a75865..39f54f45c7ac57ccee92728dff2b9a25738eb52e`。JSON 返回 target 匹配、`working_tree_clean=true`、`passed=true`、`behavior_preserving=true`，security/logic findings 均为空；reviewer 只读核对 6 个 scoped paths 与未变的 `WorkflowEditor.test.tsx` blob，没有运行 tests/build/tsc/GUI。第一次 review 因并发 HEAD/worktree 变动已 fail-closed 丢弃。
- 同一 target 的全量 gates 与 Browser 回读已记在 7.449：238 files / 1,544 tests、build、app tsc、i18n 1,139、diff-check；浏览器回读 14 events / 0 console errors，截图覆盖编辑器、拆分视图及右键框选。按计划 Slice7 为 Browser 验收，不要求重复真实 Tauri。创建并 read-back `checkpoint/readability-workflow-editor-verified-20261013-r4` → `39f54f45c7ac57ccee92728dff2b9a25738eb52e`；保留旧 unverified/start tags。该 verified tag 只标记 Slice7 target，不迁移到之后 HEAD，也不表示整轮 verified。
- Slice9 metrics 后台作业 `r4-slice9-metrics.txt` 失败：`stdin is not a tty`，`METRICS_RC=1`。按已验证限制前台重跑 `node scripts/readability-metrics.cjs --json D:/Hermes/cache/scratch/r4-final-metrics-rerun-20261013.json` 成功；JSON 为 2,178,137 bytes、SHA-256 `343edf871414b34f3c0c6f9782a968f53965d72e99b164598247766d4a129649`。旧 `r4-final-metrics.json`（SHA-256 `11446efc3cd335f9ad88038aeb975c7373bbce7c46ac3b69e822810a2d450214`）与重跑 JSON 除 `generatedAt` 外全部数据完全相同；当前 `HEAD=85f8c8a` 相对 `fcca2a0` 的 `src/`、`scripts/` 无差异。
- 实测最终度量为生产 365 files / 70,367 lines、测试 239 / 39,092、生产函数 4,947；>300 行函数 9、复杂度 >50 为 9、>20 为 98、参数 ≥6 为 16、嵌套 ≥4 为 32、生产文件 >600 行为 10，escape-hatch 与报告一致。忽略的收尾报告原表误记为 366/70,433、238/39,026、4,948，已按同源 JSON 与前台重跑结果更正。
- `r4-addon-orch-gate.log` 补充验证：238 files / 1,544 tests、build、app tsc、i18n 1,139、diff-check 的内部 RC 均为 0；该日志未记录 Git SHA，不单独绑定 Orchestrator target。此次只改本地 ignored 报告与本开发日志，无代码改动、未 push；Slice5 英文 Tauri 中文标签门仍未解决，Slice8 正确范围 review 尚待回执。

### 7.460 verified：Slice8 executeNode 输入汇集顺序修复与 clean exact review

- 原始 Slice8 exact review `e7af606070dd82ecf3bd2a8fc534fb142365270b..8f60b801757d9c2c3f9e9c19e72472103bd1436c` 返回 `passed=false`、`behavior_preserving=false`：`collectInputs` 曾在 `runNodeWithRetry` 代次守卫及 node-start/status/log 前被调用，stale generation 时仍可能访问 accessor/proxy upstream record。另一份 `8e05743..8f60b80` reviewer 范围跨切片且 worktree dirty，按 fail-closed 丢弃；其结论不作为验收。
- 一次修复后 review 请求的目标 hash 误写为 `e66d89d13469cd189ff719544694fb375e02f14d`（`fb` 字符顺序），该 Git object 不存在，reviewer 正确地 fail-closed；主分支实际 target 为 `e66d89d13469cd189ff719544694bf375e02f14d`（`bf`），随后按精确 target 重派并获得下述 clean verdict。此 hash 错误没有改变任何 ref 或工作树。
- 按 TDD 新增 `src/engine/executorNodePhases.test.ts`，测试 lifecycle 回调后才读取输入、stale generation 不读取输入、输入 reader throw 仍在 node failure try/catch 外。RED test-only commit `a58383458171b1bdac56bc6cf89a17f6859939f4` 上 focused suite 3 tests 中 2 项按预期失败、1 项 stale guard 通过。代码 commit `e66d89d13469cd189ff719544694bf375e02f14d` 将 `NodeRunInput.inputs` 改为 lazy `getInputs`；`executor.ts` 传入 `() => collectInputs(...)`，phase 在 generation guard、running status、`node.started`、agent log 后且 timing/try 前调用，恢复 `e7af606` 原有顺序与异常边界。
- 修复后 focused engine suite 4 files / 40 tests 全绿；全量 `npm run test -- --reporter=dot` 为 239 files / 1,547 tests；`npm run build` 通过（2,163 modules；保留既有 dynamic/static import 与 >500kB chunk warnings）；app/root tsc、i18n 1,170 keys、`git diff --check` 均 exit 0。未放宽/删除断言。
- clean exact re-review 范围 `a58383458171b1bdac56bc6cf89a17f6859939f4..e66d89d13469cd189ff719544694bf375e02f14d` 返回 target 精确匹配、`working_tree_clean=true`、`passed=true`、`behavior_preserving=true`，security/logic findings 为空；reviewer 只读比较 parent、修复目标与 pre-Slice8 baseline，没有重跑 gates。修复后的 metrics JSON `D:/Hermes/cache/scratch/r4-final-metrics-after-s8-order-repair-20261013.json`：2,182,958 bytes，SHA-256 `96cd0522329197f4ad8b6305120422cd945869a47e59563d8e05c9a4d5cf4d98`；生产 365 files / 70,369 lines，测试 240 / 39,218，生产函数 4,948；其余阈值指标与上一列相同。
- 创建并 read-back `checkpoint/readability-execute-node-body-verified-20261013-r4` → `e66d89d13469cd189ff719544694bf375e02f14d`。保留原 Slice8 `8f60b80` unverified tag、RED tag、修复阶段 unverified tag 及起点 tags，不迁移或删除历史 ref。修复起点 `0cb38e0`；clean-review receipt 起点 `9777b0d`。本次无新 Tauri/GUI 主张、未 push；R4 整体仍受 Slice5 英文 Tauri 中文标签门阻塞，Slice9 exact review 与最终 closeout 尚待完成。

### 7.461 verified：Slice9 runWorkflow lifecycle 修复与 clean exact review

- Slice9 原始阶段化 exact review `d84cff1ad5a876a05f27a210e67ab9aa0a314110..cbc6f4a5d0717b2ea1cd1430e33bcfbfdb70abf7` 返回 `passed=false` / `behavior_preserving=false`，无 security concern：非沙箱路径无谓 `await setupRunSandbox`，使 admission 后、`startRunSession` 置 running 前出现 yield，stop 可被旧协程覆盖、重复启动也可通过；另在事件日志 attach 后、初始化返回前抛错时，outer finally 仍持 no-op detach。
- test-only RED commit `5ae675f5f108de11011a3d4a19280b6393b9712a`（tag `checkpoint/r4-slice9-lifecycle-order-red-unverified-20261013`）新增 `src/engine/executorLifecycleRegression.test.ts` 两项集成回归：非沙箱立即 stop/duplicate admission；event log 已 attach 后注入 `resetUsage` throw 并检查 `EventLogWriter.close`。修复前两项均按预期失败：立即 running state 为 `undefined`、close 调用次数为 0。
- 修复 commit `3700d0c0321baf40ed6936c93c0a0c9a02550414`：`executor.ts` 仅在 `opts.sandbox` 为真时 await sandbox setup，保留非沙箱从 admission 到 session startup 的同步区间；`startRunSession` 在 attach 成功后立即调用 `onEventLogAttached(detach)`，由 executor 将 handle 交给 outer finally，正常返回时仍保留原 session return 值。
- 修复后 focused lifecycle tests 2 files / 16 tests 通过；engine suite 37 files / 343 tests 通过；全量 tests 240 files / 1,549 tests 通过。Build 2,163 modules、app/root tsc、i18n 1,170 keys、`git show --check --oneline HEAD` 均 exit 0。Build 保留 dynamic/static import warnings 与 >500kB chunk warning；未改写测试断言。
- 当前 repair exact review `8a31eb530bdcc31733ef96449a5f06a07625f314..3700d0c0321baf40ed6936c93c0a0c9a02550414` 返回 target 精确匹配、`working_tree_clean=true`、`passed=true`、`behavior_preserving=true`，无 security/logic findings。Reviewer 确认 sandbox-enabled setup 仍 await、detach handoff 不改变事件顺序；`behavior_differences` 记录的是预期 no-sandbox timing 修复与 exception cleanup 恢复。Reviewer 未重跑 gates。
- 同代码内容 metrics JSON `D:/Hermes/cache/scratch/r4-s9-lifecycle-repair-metrics-20261013.json`：2,185,245 bytes，SHA-256 `a13645e60e51e4fee4e005962b1babdac63340639d051e8f0e9ef414726b2ea9`；生产 365 files / 70,376 lines / 4,949 functions，测试 241 files / 39,324 lines；>300 行函数 9、CX>50 为 9、CX>20 为 98、参数≥6 为 16、嵌套≥4 为 32，其余 production hatches/fan-in 未变。
- 创建并 read-back `checkpoint/readability-run-workflow-verified-20261013-r4` → `3700d0c0321baf40ed6936c93c0a0c9a02550414`。保留原 Slice9 `cbc6f4a` unverified tag、repair-unverified tag 与所有 start/RED tags。Receipt 起点为 `c1aba6835e8fa0c415a55e82bdc18182021206f7`。Slice9 为非 UI 切片，不主张新增 Tauri 回读；未 push。R4 整体仍 partial/unverified：Slice5 英文 Tauri 中文标签需用户决定，且加时 UI/i18n 尚未全部完成/独立评审；不打 final tag。

### 7.462 R5 Slice0：干净基线与开工质量门

- 按计划 `.hermes/plans/2026-10-13_233500-r5-long-run.md` 在 `refactor/monolith-split-2` / `4c315b9ebee5b3fe2bf549e2168919dbf6bdbec3` 开始；实际开工 `2026-10-13 23:29:36 +0800`，deadline `2026-10-14 15:29:36 +0800`。开工前 worktree clean；start tag `checkpoint/r5-prep-start-20261014-r5` 直接指向当前 HEAD，没有空提交。Tag message 写入的 `23:28` 与 Git tagger timestamp 相差约 1 分半；tag 不移动/删除，报告以实际 tagger timestamp 为准。
- 同一 baseline 上 `npm run test -- --reporter=dot`：240 files / 1,549 tests passed；`npm run build`：2,163 modules transformed；app/root `tsc --noEmit`、`npm run i18n:check`（1,170 keys，en-US 对齐）、`git diff --check` 均 exit 0。Build 保留 dynamic/static import 混用及 >500kB chunk warnings。完整 gate log 保存在 `D:/Hermes/cache/scratch/r5-s0-quality-20261013.log`；六项 RC 均为 0。初次汇总脚本因正则未允许 `I18N` 中的数字而误数为 5 项，修正后直接读 log 确认六项全 0；不是质量门失败。
- 前台 `node.exe scripts/readability-metrics.cjs` exit 0。基线：生产 365 files / 70,376 lines，测试 241 / 39,324；函数 4,949（>100 行 131、>300 行 9）；CX>20 为 98、CX>50 为 9、depth≥4 为 32、params≥6 为 16；`workflowStore.ts` fan-in 65、`useT.ts` 59；生产 escape hatches `47/21/28/101/0/1/1`。完整度量与 Slice9 函数候选见本地报告 `.hermes/reports/2026-10-14-r5.md`。
- Slice0 无代码改动、无 GUI/Worker/model 调用；尚未有 exact review 或 R5 verified tag。R5 的 verified 祖先规则比 R4 收紧：R4 `e66d89d`、`3700d0c` tags保留作历史但不作为本轮有效 verified 祖先；R5 only Slice5/12 可按完整条件申请 verified。未 push。

### 7.463 R5 Slice1：更正 R4 两个过度 verified 账目

- 按 R5 计划与用户已确认的审计边界，新增 `docs/HISTORICAL_UNVERIFIED_TRIAGE.md` 的 R4 ledger correction。保留所有历史 refs，不删除、不移动、不重命名 tag；仅更正证据分类。
- `checkpoint/readability-execute-node-body-verified-20261013-r4` → `e66d89d13469cd189ff719544694bf375e02f14d` 重新分类为 **evidence-missing / R5 无效 verified ancestor**：review `a583834..e66d89d` 仅覆盖 Slice8 测试/修复 delta，未审完整 ancestry 中的 Slice9 原阶段化代码与四个未评审 R4 add-ons。按计划做了可选隔离复核：scratch 中从 `e66d89d` `git archive`，另从 `5ae675f` 取回归测试 blob `25b76f812d98ed62a45fa12334df22730ac86435`；focused test 2/2 按预期失败（立即 running 为 `undefined`；注入会话初始化失败后 `EventLogWriter.close` 调用 0 次）。该命令 exit 1 是针对旧快照的预期 RED，不是当前分支质量门失败。
- `checkpoint/readability-run-workflow-verified-20261013-r4` → `3700d0c0321baf40ed6936c93c0a0c9a02550414` 重新分类为 **evidence-missing / R5 无效 verified ancestor**：原 Slice9 exact range `d84cff1..cbc6f4a` 为 `passed=false`，两项缺陷后续由 R5 修复；`8a31eb5..3700d0c` 的 pass 只审 repair delta，并未覆盖最近有效 ancestor 后的全部代码与四个 R4 add-ons。
- R4 Slice6 `81d22c69bbda64584ecddb76a9486a323eeb77d7` 与 Slice7 `39f54f45c7ac57ccee92728dff2b9a25738eb52e` 按本计划保留为各自精确快照的有效 verified tags；其中 `39f54f4` 是 R5 最近的有效 verified ancestor。R5 仅允许 Slice5/12 在满足完整 review-coverage、同快照门和 GUI 条件后申请 verified。
- Slice1 仅改分类文档与开发日志，无生产代码改动、无 tag 移动。`git diff --check` 通过；start tag `checkpoint/ledger-r4-correction-start-20261014-r5` 指向 `97102584682955c389a70588403e4d23528f8421`；隔离 probe 保留于 `D:/Hermes/cache/scratch/r5-e66-lifecycle-probe-20261013`。未 push。

### 7.464 R5 Slice1 补记：更正 R4 lifecycle 与度量说明

- 保留 7.459/7.461 的历史原文，在 triage 与 R5 报告追加更正：`node scripts/readability-metrics.cjs --match runNodeWithRetry` 在 R5 baseline 实测 `src/engine/executorNodePhases.ts:388` 为 127 行，不是旧记录中的 120 行；R5 Slice4 再决定能否按计划压至 ≤120。
- 经 `git show 39f54f4:src/engine/executor.ts` 核实，R4 最近有效基线仅在 `opts.sandboxMode === 'gitworktree' && isTauri && runWorkspaceDir` 下进入实际 Worktree setup/await；R4 修复 target `3700d0c` 改为 `if (opts.sandbox) await setupRunSandbox(...)`，会在 copy sandbox 路径也让出执行权。故“基线也会在 copy sandbox 路径 await”的先前判断不成立；R4 修复解决 no-sandbox yield，但该 verified target 仍需 R5 Slice3 用即时 stop/duplicate-start RED 回归验证并收口。
- 补正 7.463 的措辞：原 Slice9 review 的 no-sandbox yield 与 event-log detach 两项由 R4 repair commit `3700d0c` 修复；R5 Slice3 尚待验证/修复的是 `if (opts.sandbox)` 扩大后 copy-sandbox 路径仍发生的 yield，不把它说成上述两项之一或已修复。
- 此 addendum 仅更正账目与源码事实，不触碰生产代码或既有 R4 历史段落；当前 Slice2 start tag 仍固定在 `b163d0df5c2afa03f346fa5fdf29309638560c71`。`git diff --check` 通过；本补记由 `checkpoint/ledger-r4-correction-followup-unverified-20261014-r5` 标记为 docs-only unverified；未 push。

### 7.465 R5 Slice2：英文模式标签与展示/持久化分离

- `src/agents/agentManager.ts` 为协议与 provider preset 增加 display-only locale keys，Ollama 建议增加 `noteKey`，probe 的可见诊断改为 i18n；AgentConfig 创建默认名、provider/model IDs、`ProviderPreset.name` 与 Ollama 原始 `note` 不变，UI 只翻译展示值。`RunResult.error` 保持原中文 durable 值，dev-session 可见 `addLog` 使用 `log.devSessionNeedsProject` / `log.devSessionNotReady`。
- RouteTable 未绑定/回退链标签、TokenUsage 调用次数单复数、RunHistory 状态标点与 cycle 日志 separator 移入 locale；`plugin.log.browserNoDirScan` 按界面实际名称显示 `Import from file`。计划点名的九个未使用 key（`checkpointPersistFailed`、`nodeMissing`、`duplicateStartError`、`emptyGraphShort`、`cycleNodeError`、`cycleError`、`nodeSkippedUpstream`、`nodeTypeMissing`、`ctxNotReady`）从中英文资源删除，搜索未见源码引用。`uiChineseLiterals` 与 Orchestrator view-boundary 检查覆盖面已扩展。`节点不存在` 经 `void retryNode` 形成未处理 rejection/fatal overlay 的既有行为仅记录、不修。
- 全新 Browser context 以 English/advanced 模式回读 Settings → Models、Routing 与 Tokens；未创建 ProjectSession、未调用模型、未启动 Worker。English 视图中仅保留计划允许的工作区数据值 `未命名工作流` 与 `Ollama 本地智能体`。Token 面板为空，因此实际单复数由单测覆盖。Browser preload hooks 的 console/error/unhandled-rejection 计数为 0；此结果不代表真实 Tauri 验收。截图 `.hermes/reports/assets/r5-s2-{models,routing,tokens}-en.png` 均 1280×900、hash 互异，完整 SHA-256 和回读边界见 ignored 本地报告 `.hermes/reports/2026-10-14-r5.md`。
- 验证结果（code snapshot `c9c9243236694f419c879c6580045aa8a70b3a0c`）：`npm run test -- --reporter=dot` 244 files / 1,572 tests；`npm run build` 成功、2,163 modules（保留既有 dynamic/static import 与 >500kB chunk warnings）；`npx tsc -p tsconfig.app.json --noEmit` 和 `npx tsc --noEmit` 均 exit 0；`npm run i18n:check` 1,202 keys 对齐；`git diff --check` 通过。独立 exact review 对该快照返回 `working_tree_clean=true`、`passed=true`，security/logic findings 均空；建议增加 Settings Models/Routing en-US mounted component assertions，作为非阻塞后续项记录，未扩展本切片。
- 本切片 code tag `checkpoint/ui-locale-catalog-labels-unverified-20261014-r5` 指向上述 target；按 R5 计划 Slice2 仍为 unverified，无 Tauri GUI 验收或 verified tag。未 push。

### 7.466 R5 Slice2 补记：报告收尾超过时间盒

- Slice2 hard cutoff 为 `2026-10-14 01:43:10 +0800`；经 Git read-back，docs-only closure commit/tagger timestamp 为 `2026-10-14 01:48:13 +0800`，超过 5 分 03 秒。质量门、Browser 回读与 exact review 已完成；超时部分仅用于更新本地报告与开发日志，没有超时后的生产代码改动。
- Slice2 保持 unverified，code tag 仍指向 reviewer 精确审查的 `c9c9243236694f419c879c6580045aa8a70b3a0c`；不迁移 verdict 至 docs-only HEAD，不创建 verified tag。后续 Slice3 start tag 固定指向 `2f6ae37d9a527bf8b9d26142dff1e4bfe1240c7e`，报告收尾时间偏差已如实登记。

### 7.467 R5 Slice3：copy sandbox 启动同步修复

- 根因为 `runWorkflow` 在所有 `opts.sandbox` 路径都无条件 `await setupRunSandbox`；copy 模式没有 Worktree I/O，但该 await 仍在 admission 后、`startRunSession` 前让出执行权。RED test-only commit `d3af20c02e599cc3aede1c0feb99e4125a143a38` 增加 copy 模式即时 `running`、duplicate admission 与 immediate stop 回归；focused test 按预期因 `runningImmediately` 是 `undefined` 而失败。
- `src/engine/executor.ts` 现在仅在 `opts.sandbox && opts.sandboxMode === 'gitworktree' && isTauri && wf.workspaceDir` 时 await sandbox setup；其余路径保持 admission→`startRunSession` 同步。`runNodeWithRetry` 中其余同轮程序化 stop 微任务让步按计划记录、不改。本切片没有启动真实 Worker、调用模型 API 或做 Tauri GUI 验收。
- focused lifecycle suite：2 files / 17 tests passed。全量验证（code snapshot `b6111efa1dcca38eee710637486b2c5e6d6bf794`）：`npm run test -- --reporter=dot` 244 files / 1,573 tests；`npm run build` 通过、2,163 modules（保留既有 mixed dynamic/static import 与 >500kB chunk warnings）；app/root `tsc --noEmit` 均 exit 0；`npm run i18n:check` 1,202 keys 对齐；`git diff --check` 通过。
- Exact review parent `d3af20c02e599cc3aede1c0feb99e4125a143a38` → target `b6111efa1dcca38eee710637486b2c5e6d6bf794` 返回 `working_tree_clean=true`、`passed=true`，security/logic findings 与 suggestions 均为空；reviewer 未重跑 gates。Code tag `checkpoint/run-start-sandbox-sync-unverified-20261014-r5` 指向 target；Slice3 依计划仍 unverified，未 push。

### 7.468 R5 Slice4：executor、workflow ID 与画布交互特征测试

- 在 `executorLifecycleRegression.test.ts` 增加 executor 集成特征测试：上游 `A.out` getter 的读取顺序必须是 `node.started:B → read A.out → execute B`。测试强制执行 B，隔离缓存 preflight 对 inputs 的读取；getter 为 non-enumerable，避免 store 持久化序列化旁路触发。Exact reviewer 确认恢复 eager input collection 会使顺序断言失败；未注入旧实现实跑 RED，不声称旧快照实测失败。
- workflow ID 的同毫秒新建/画布捕获不覆盖回归已存在；新增 `createWorkflowId` 冲突后缀直接单测。`WorkflowEditor.test.tsx` 现在覆盖三个 window listener 每类只注册一次且 cleanup 使用同一 handler、右键框选时抑制 `onSelectionChange`；`useCanvasReconnect.contract.test.tsx` 覆盖主画布 `pushHistory → edges → markDirty` 顺序和分屏按主 store `st.edges` 环检测。`workerRunConsistency.test.ts` 原有未来 attempt Evidence/Acceptance 与 graphVersion drift 三种负断言已分别锁定对应 issue code；本轮不重复添加、不修改生产或 Worker 文件。
- `runNodeWithRetry` 指标仍是 127 行 / complexity 12 / depth 2 / params 1。未为削减 7 行抽取微型 helper：retry、lifecycle fencing 与 success/failure 处理属同一职责，机械拆分会增加间接层；符合计划“若不值得拆就写明理由”。
- Slice4 start tagger time 为 `2026-10-14 02:13:26 +0800`，1.25 小时截止 `03:28:26 +0800`；最终 code target `f231392ce6c366567094ed1def40c73d7befcb19`（parent `2b8dc9c28427fb4564b875d168da96a30f857fa7`），在时间盒内。unverified tag `checkpoint/engine-store-test-gaps-unverified-20261014-r5` 指向该 code target。
- 验证结果：focused 6 files / 43 tests passed；全量 `npm run test -- --reporter=dot` 245 files / 1,579 tests passed；`npm run build` 通过、2,163 modules；app/root TypeScript `--noEmit` 均 exit 0；`npm run i18n:check` 1,202 keys 对齐；`git diff --check` 通过。Build 有既有 mixed dynamic/static import 与 >500kB chunk warnings。验证环境 Node `v26.7.0`，未覆盖计划提及的 Node 22。
- Exact reviewer 对 Slice4 start `79219309f3f5224843f5b9c10ceefbd067b11526` → target `f231392ce6c366567094ed1def40c73d7befcb19` 返回严格 JSON pass，`security_concerns=[]`、`logic_errors=[]`；reviewer 未重跑质量门。返回后 `2026-10-14 02:56:56 +0800` read-back 确认分支、HEAD、tag target、clean status 与 reflog。无 Browser/Tauri GUI、真实 Worker 或模型 API 验收；Slice4 仍 unverified，Slice5 独立承担 GUI/Tauri 门。

### 7.469 R5 Slice5：整体验证部分通过，保持 unverified

- Slice5 从 `ba9ff1327d504975947aa9c294d5a2cd4c65907c` 开始，2 小时 cutoff 为 `2026-10-14 05:00:54 +0800`。cutoff 后只做 exact-review read-back、证据整理与文档收尾；没有生产代码改动或新增 GUI 操作。`05:04:06` 首次收尾核验时已超时 3:12；本切片按计划记为 partial/unverified，不创建 final tag pair。
- 同一代码快照 `ba9ff1327d504975947aa9c294d5a2cd4c65907c` 的质量门：全量 `npm run test -- --reporter=dot` 245 files / 1,579 tests passed；`npm run build` 2,163 modules；app/root `tsc --noEmit` 均 exit 0；`npm run i18n:check` 1,202 keys 对齐；`git diff --check` exit 0。Build 保留既有 mixed dynamic/static import 与 >500kB chunk warnings。第一次门控包装误用 `npm.exe`，在版本检查处因 PATH 无该命令退出、尚未运行测试；改用可用的 `npm` 后整套 gates 全部通过。环境 Node `v26.7.0` / npm `11.19.0`，非 CI Node 22。
- `node.exe scripts/readability-metrics.cjs` 与仓库外 JSON 输出均 exit 0；JSON 为 `D:/Hermes/cache/scratch/r5-s5-final-metrics.json`。当前生产 365 files / 70,419 lines，测试 246 files / 39,969 lines，4,949 函数；>300 行 9、CX>50 为 9、params≥6 为 16、`src/projectControl` 注释率 1.0%、导出 JSDoc 38.4%、>600 行生产文件 10、`workflowStore.ts` fan-in 65。对照 `CODE_READABILITY_REVIEW.md` 的 `75f954b` 进展列：15→9、11→9、21→16、1.0%→1.0%、38.2%→38.4%、11→10、60→65；fan-in 在 R5 起点 `4c315b9` 已为65，本轮没有增加。
- 独立 exact reviewer 对完整范围 `1e2030983bbb606315e9d9a2f5b421f29c0b3855..ba9ff1327d504975947aa9c294d5a2cd4c65907c` 返回严格 JSON：`head=ba9ff1327d504975947aa9c294d5a2cd4c65907c`、`working_tree_clean=true`、`passed=false`、`security_concerns=[]`，target parent=`f231392ce6c366567094ed1def40c73d7befcb19`。Reviewer 未跑 tests/build；返回后重读确认 branch `refactor/monolith-split-2`、HEAD、parent、reflog 与工作树均未变化。两项 logic findings：`ApiKeysSection.tsx` 英文设置仍渲染未列入 literal-test target/白名单的中文 vendor-preview 与迁移/校验文案；`CanvasWelcomeSurface.tsx` 直接显示 `STARTER_TEMPLATES` 的中文应用名称/描述。建议项（`workflowStore.ts` fan-in 与 metrics JSON 仓库内路径防护）未在本切片处理。
- 真实 Tauri 使用新 identifier `com.slimemold.verify.r5`；36 张计划页面截图（中英文各18页，1279×800）SHA-256 全部唯一；CDP `Log.entryAdded(error)`、`Runtime.exceptionThrown` 和页内 console/runtime/unhandled hooks 均为空。所有回读 `projectId/projectPath=null`；未创建 ProjectSession、未启动 Worker、未调用模型 API。hash 索引为 ignored `.hermes/reports/assets/r5-s5-tauri-readback-manifest.json`。
- Browser 英文计划页有回读；Browser 中文仅 Agents、Models、MCP 与新手页留下有效截图，General/Flow/Routing/APIKEYS、Orchestrator、Run history、Tokens、顶栏菜单等未完成。新上下文的 CDP WebSocket 多次关闭，错语言/遮挡截图已移入 `assets/failed/`，不计入证据；因此 Browser 双语全矩阵与其 CDP Log/Runtime 门未通过。Tauri 通过不能替代 Browser 缺口。
- Slice5 结论：质量门、metrics、Tauri 双语门通过；Browser 中文矩阵不完整，exact review 明确失败，故不创建 `checkpoint/monolith-split-2-final-{unverified,verified}-20261014-r5`。两项中文 UI findings 未修、未豁免；后续按原计划继续 Slice6–12。报告与 Tauri screenshot manifest 保持本地 ignored；未 push、merge 或改写 refs。

### 7.470 R5 Slice6：OrchestratorPanel action extraction

- Slice6 start tagger `2026-10-14 05:24:03 +0800`，1.5 小时 cutoff `06:54:03 +0800`；code commit `a8a4284d4885e31eb4294a4de9a2077c50bf5883` 于 `06:05:15` 完成，review 返回后 `06:13:22` read-back，未超时。start `checkpoint/orchestrator-panel-actions-start-20261014-r5` → `13195edc497021e5052996766bb072534f2f7c5e`；pre-change characterization commit `a806dded80737b31e74db9b7d61cca48a5abb9d8`；unverified code tag `checkpoint/orchestrator-panel-actions-unverified-20261014-r5` → code target。
- TDD characterization：在旧 `OrchestratorPanel` 上新增非运行 draft 删除集成测试，确认移除编排记录不会删除其绑定的用户 workflow；focused 6/6 pass 后单独提交 test-only baseline，implementation 后同一测试保持 green。
- 结构拆分：将 panel store/view state、衍生投影和 action handlers 移至 `src/components/useOrchestratorPanelActions.ts`；`OrchestratorPanel.tsx` 作为 composition/view root 降至 123 行，公开 callback props、modal/embedded 分支和 persisted recovery reason 保持。`uiChineseLiterals.test.ts` 同时覆盖新 hook，并把持久化 reason 例外移至新 owner。
- 验证结果：focused 3 files / 14 tests passed；全量 `npm run test -- --reporter=dot` 245 files / 1,580 tests passed；`npm run build` 通过、2,164 modules；app/root `tsc --noEmit` 均 exit 0；`npm run i18n:check` 1,202 keys 对齐；`git diff --check` 通过。Build 保留既有 dynamic/static import 与 >500kB chunk warnings。metrics：旧组件 386 行 / CX 8；新组件 123 行 / CX 3；hook 361 行 / CX 7 / 1 parameter；`workflowStore.ts` fan-in 65→65，不增加。
- Browser `en-US` advanced Orchestrator panel read-back 有效：空草案列表与 goal form 可见；store 中无 `projectId/projectPath`、0 ProjectSessions、0 WorkerRuns、0 orchestrations、1 个默认 workflow、0 model/token calls；页内 window-error/unhandled hooks 为空。截图 `r5-s6-browser-en-orchestrator.png`（1258×566，SHA-256 `445c762245abb9400231e6d2b6a00b5e45cadccb5c3852f8cbce2a8e96fdf38e`），机器可读 manifest 为 ignored `r5-s6-browser-readback-manifest.json`。无 action 执行、未创建项目/session、未启动 Worker 或模型；该 Browser 观察不代表 Tauri 或 CDP Log/Runtime stream 验收。
- Exact reviewer 对完整 Slice6 范围 `13195edc497021e5052996766bb072534f2f7c5e..a8a4284d4885e31eb4294a4de9a2077c50bf5883`（immediate parent `a806dded80737b31e74db9b7d61cca48a5abb9d8`）返回 pass，`working_tree_clean=true`、`security_concerns=[]`、`logic_errors=[]`。reviewer 未改文件；review 返回后核对 branch、HEAD、parent、reflog 与 clean status 匹配。非阻塞建议增加 stale-state run preflight、cancellation cleanup、rejected recovery、terminal delete confirmation、TaskGraph revision event/save/selection 的 direct hook regressions；列为后续 backlog，不扩本切片。
- Slice6 质量门、Browser 门与 exact review 均通过；仍按计划保持 unverified，不打 verified tag。未 push、merge，未做 Tauri、真实 Worker 或模型 API 验收。

### 7.471 R5 Slice7：runtime log i18n（partial / unverified）

- Slice7 start tagger `2026-10-14 06:18:12 +0800`，timebox cutoff `07:48:12 +0800`。TDD commits `581f1f94dd778d98b9dcf55da52801aa07513df2`、`7e6b941ce638bf1d7a5172e72d44f6f0a54296ba` 分别冻结 literal/locale 回归和 AgentHarness 显示投影 RED；implementation `653b8fd0d6db1f70a95837dc5252ae507b79898d`，parent `7e6b941ce638bf1d7a5172e72d44f6f0a54296ba`。Start tag `checkpoint/runtime-log-i18n-2-start-20261014-r5` → `02b10e9`；unverified code tag `checkpoint/runtime-log-i18n-2-unverified-20261014-r5` → `653b8fd`。
- 从上轮 AST baseline 的 40 处 / 13 个非禁区文件迁移运行日志及同文件相关可见导入错误/对话框文案；新增 literal targets 和 en-US/zh-CN 对齐资源。after-scan 为 8 raw hits / 3 files，其中5个在计划禁区、另3个是 AgentHarness 原样轨迹日志字段。Harness 的 terminal `ctx.logger` 投影按 locale 翻译，`ExperienceSink` 仍接收 runAgentLoop 原始消息。保留项目/工作流/子图/组别名、未归类目录名、agent scope prompt、trajectory payload、NodeDefinition 执行错误及 `projectCatalogState.ts` 纯状态拒绝文本；catalog command 的用户可见日志做本地化。
- 同快照 gates：focused 13 files / 36 tests；全量 `npm run test -- --reporter=dot` 247 files / 1,585 tests；`npm run build` 2,164 modules；`npx tsc -p tsconfig.app.json --noEmit`、node tsconfig 均 exit 0；`npm run i18n:check` 1,279 keys 对齐；`git diff --check` 通过。Build 有既有 mixed dynamic/static import 与 >500kB chunk warnings。没有单独保存 gate log，实际终端结果在本 session output。
- Exact reviewer 对完整对象范围 `02b10e9eb8e6f7faad6cfff757368e3711912e7b..653b8fd0d6db1f70a95837dc5252ae507b79898d`（target parent `7e6b941ce638bf1d7a5172e72d44f6f0a54296ba`）返回 `passed=false`、`working_tree_clean=true`、`security_concerns=[]`。评审实际范围为三提交（两个测试提交 + implementation）；派审说明误写“四提交”，但 pinned base/target 和审查范围正确。reviewer 未运行 gates 或修改文件。
- 三项 unresolved logic findings：英文 workflow-import log 固定写 nodes/edges，单数显示 `1 nodes / 1 edges`；subgraph-packed 只按 node count 复数化，单数 input/output 显示 `1 inputs / 1 outputs`；missing-node log 按 missing total 复数化而未按 customCount 复数化，可能显示 `1 may be custom nodes`。非阻塞建议：增加 ExperienceSink 与 localized display fan-out 的集成断言。
- Review 于 `07:41:02 +0800` 返回，距 cutoff 不足7分钟；不足以对三个结果分别 RED/GREEN、重跑完整质量门并再次 exact review。依照时间盒不仓促改代码，记录为 partial/unverified，保留 unverified tag，不打 verified tag；无 Browser/Tauri、真实 Worker 或模型调用。docs-only closeout 在 `07:49:18 +0800` 完成，较 Slice7 cutoff 超 1:06；cutoff 后无代码、测试或 ref 改动。

### 7.472 R5 Slice7 closeout timestamp correction

- 7.471 将 docs-only closeout 时间记为 `07:49:18 +0800`，该时间是提交前的时钟读数。Git reflog 证明 closeout commit `fa5c15c5190af039eaef43801b0e1dd96bae3f96` 实际创建于 `2026-10-14 07:51:23 +0800`，较 Slice7 cutoff `07:48:12 +0800` 超 3:11；本节更正旧记载，不改写历史条目。截止后没有 Slice7 代码或测试改动。Slice8 start tag `checkpoint/workflow-create-race-start-20261014-r5` 于 `07:54:57 +0800` 创建并指向 `fa5c15c`。

### 7.473 R5 Slice8：workflow creation race（unverified）

- Slice8 start tag `checkpoint/workflow-create-race-start-20261014-r5` 指向 `fa5c15c5190af039eaef43801b0e1dd96bae3f96`，tagger `07:54:57 +0800`，cutoff `08:39:57 +0800`。切片重核确认 `newWorkflowInProject` 在 standalone path await 前捕获 store state，而并发回调会从旧 registry 生成同一 ID；现有 sequential workflow tests 未覆盖并发。
- TDD 回归先以 mutating `Object.assign` fixture 试跑时错误地 green；改为 immutable state replacement 以模拟 Zustand 快照语义后，预期 RED：`expected ['wf-1001'] to have a length of 2 but got 1`。test-only commit `e7a48f3dbf9ef519c8087cbdd0eb0b5d0ac13227`。实现 commit `02866455501836c7847404b1ded63b7f3fd193aa` 在 path await 后重新读取 `deps.getState()`，ID、capture 与 activation 都基于当前 state；unverified tag `checkpoint/workflow-create-race-unverified-20261014-r5` 指向该 target。
- Same-target gates：focused 3 files / 12 tests；全量 `npm run test -- --reporter=dot` 247 files / 1,586 tests；`npm run build` 2,164 modules；app/node 两个 tsconfig `tsc --noEmit` 通过；`npm run i18n:check` 1,279 keys；`git diff --check` 通过。真实输出日志 `D:/Hermes/cache/scratch/r5-s8-final-gates-20261014.log`。Build 仍有既有 mixed dynamic/static import 与 >500kB chunk warnings。
- Exact reviewer 审查完整范围 `fa5c15c5190af039eaef43801b0e1dd96bae3f96..02866455501836c7847404b1ded63b7f3fd193aa`（target parent `e7a48f3dbf9ef519c8087cbdd0eb0b5d0ac13227`，包含 docs-only correction、test 与 implementation），严格 JSON `passed=true`、`working_tree_clean=true`、security/logic/suggestions 均空；reviewer 未运行 gates 或改文件。回读确认 branch、HEAD、parent、tag 与 clean status 一致。
- Slice8 在 timebox 内完成 gates 与 review；按 R5 计划只允许 Slice5/12 在条件满足时建立 verified tag，因此本切片保留 unverified。未进行 Browser/Tauri、Worker 或模型 API 验收。

### 7.474 R5 Slice9 function 1：`finalizeRun` behavior-preserving split（unverified）

- Fresh metrics baseline commit `0f335829b699ccf714d9af8c58853a5b599c754d`：`finalizeRun` 252 行、CX49、depth4、params1。Baseline JSON `D:/Hermes/cache/scratch/r5-s9-finalizeRun-before-20261014.json`；after JSON `D:/Hermes/cache/scratch/r5-s9-finalizeRun-after-extract-20261014.json`。
- Slice9 function1 start tag `checkpoint/readability-tail-finalizeRun-start-20261014-r5` → `0f33582`，tagger `08:19:18 +0800`，cutoff `09:19:18 +0800`。旧实现的5个直接测试先通过；新增 latest node-state 与 cost aggregation characterization 后同样在旧实现上通过，test-only commit `6306647be51c27d3df6b2b75a4a9f815936aa554`。
- Implementation target `cce142682da1971707d23eb3d0529ed608742edc`，parent `6306647be51c27d3df6b2b75a4a9f815936aa554`；unverified tag `checkpoint/readability-tail-finalizeRun-unverified-20261014-r5` 指向 target。`finalizeRun` 252/49/4/1 → 88/11/2/1；helpers：`reconstructLatestRunNodes` 23/3/0/2、`logFinalizerStatus` 15/6/1/1、`deriveFinalizerStatus` 3/3/0/2、`recordAgentOutcomeMetrics` 17/6/4/1、`updateFinalizerExperience` 75/15/3/1、`summarizeFinalizerCosts` 39/10/2/1、`buildFinalizerRunRecord` 51/2/0/1（lines/CX/depth/params）。文件 metrics 为 `runFinalizer.ts` 336 行、`runFinalizerRecords.ts` 121 行；触及文件中 >250 行或 CX>25 的 function 数量 1→0。
- 同快照 gates：focused 3 files / 24 tests；全量 247 files / 1,587 tests；build 2,165 modules；app/root/node 三项 tsc 通过；i18n 1,279 keys；`git diff --check` 通过。真实输出 `D:/Hermes/cache/scratch/r5-s9-finalizeRun-gates-20261014.log`。Build 有既有 mixed dynamic/static import 与 >500kB chunk warnings。
- Exact reviewer 覆盖 `0f33582..cce1426` 完整范围（含 characterization commit），`passed=true`、working tree clean、security/logic errors 为空。非阻塞建议：直接测试 history → awaited checkpoint → terminal event 顺序，以及 selfImprove 关闭时 agent metrics 仍执行；暂记 backlog，不扩大切片。Review 未修改文件或重跑 gates。
- Function1 在1小时盒内完成并保持 unverified；它不是 UI 函数，无 GUI/Tauri 验收。Slice9 还需根据最新 metrics 选择两个函数。

### 7.475 R5 Slice9 function 2：`parseWorkerCommand` behavior-preserving split（unverified）

- Fresh metrics baseline at HEAD `09cc594c3e627e98b6cd5dc9fd6173b3e97ae943`：`parseWorkerCommand` 113 行、CX46、depth4、params1。Selection JSON `D:/Hermes/cache/scratch/r5-s9-next-metrics-20261014-0845.json`；function baseline JSON `D:/Hermes/cache/scratch/r5-s9-parseWorkerCommand-before-20261014.json`。
- Function2 start tag `checkpoint/readability-tail-parseWorkerCommand-start-20261014-r5` → `09cc594`，tagger `08:49:21 +0800`，cutoff `09:49:21 +0800`。先运行原有 direct tests，再添加 `ls`、`tsc --noEmit`、`tail +10` 精确结果 characterization；均在旧实现通过。Test-only commit `aba504964ec91ccbcdccf81f7dc931ec261b82b1`。
- Implementation target `fd5fefad3b87064318e7c54d5a89a6bd67a9a9b8`，parent `aba504964ec91ccbcdccf81f7dc931ec261b82b1`；unverified tag `checkpoint/readability-tail-parseWorkerCommand-unverified-20261014-r5` 指向 target。只按原有优先级抽取 `parseReadCommand`、`parseGitDiffCommand`、`parseTsxCommand`、`parseFindCommand`、`parseGrepCommand`；不改变语法、accepted intent/error、错误文字、输入边界或 Node/Rust/native policy。`parseWorkerCommand` 113/46/4/1 → 19/8/1/1；helpers 分别为 9/4/1/1、17/12/2/1、13/5/1/1、22/10/1/1、38/13/3/1（lines/CX/depth/params）。metrics file 337 行、最大参数数2、触及文件中 >250 行或 CX>25 的函数由1降为0。After JSON `D:/Hermes/cache/scratch/r5-s9-parseWorkerCommand-after-20261014.json`。
- 同快照验证：focused `commandPolicy.test.ts` + `capabilities.test.ts` 2 files / 24 tests；全量 `npm run test -- --reporter=dot` 247 files / 1,588 tests；build 2,165 modules；app/root/node 三项 tsc 通过；i18n 1,279 keys；`git diff --check` 通过。日志 `D:/Hermes/cache/scratch/r5-s9-parseWorkerCommand-gates-20261014.log`。Build 存在既有 mixed dynamic/static import 与 >500kB chunk warnings。
- Exact reviewer 检查完整 `09cc594..fd5fefa` 范围（含 characterization commit），返回严格 JSON `passed=true`、working tree clean、security/logic/suggestions 均为空；确认 dispatch order、validation/error precedence 未变化且无 native file 修改。Reviewer 未跑 gates/改文件。Function2 在 timebox 内完成，保持 unverified；无 UI/Tauri、真实 Worker 或模型调用。Slice9 仍需按最新 metrics 选择第3个函数。

### 7.476 R5 Slice9 function 3：`tokenize` behavior-preserving split（unverified）

- Fresh metrics at HEAD `e4f8df88e68cbcc6fb51864ae93148b36184a316`: `tokenize` 104 行、CX42、depth4、params1。Before JSON `D:/Hermes/cache/scratch/r5-s9-tokenize-before-20261014.json`；选取列表 `D:/Hermes/cache/scratch/r5-s9-function3-selection-20261014.json`。
- Function3 start tag `checkpoint/readability-tail-tokenize-start-20261014-r5` → `e4f8df8`，tagger `09:07:53 +0800`，cutoff `10:07:53 +0800`。先添加 whitespace/numeric、string escape、unterminated string、`===`/`!==` 与 unknown-character error 的 characterization；旧实现 `expr.test.ts` 25 项通过。Test-only commit `9390d570d7de52f3bed5bebe5eafe80325da0748`。
- Implementation target `34fefb28d407cc29517d9cb53856cba2d93e3a5d`，parent `9390d570d7de52f3bed5bebe5eafe80325da0748`；unverified tag `checkpoint/readability-tail-tokenize-unverified-20261014-r5` 指向 target。`tokenize` 104/42/4/1 → 44/15/2/1；helpers `scanNumberToken` 5/4/1/2、`scanStringToken` 16/8/2/2、`scanIdentifierToken` 5/3/1/2、`scanOperatorToken` 15/10/1/2、`scanPunctuationToken` 13/9/1/1（lines/CX/depth/params）。`expr.ts` 364 metrics 行；触及文件中 >250 行或 CX>25 的函数数 1→0；after JSON `D:/Hermes/cache/scratch/r5-s9-tokenize-after-20261014.json`。
- Characterization保留原行为：`1..2` 被扫描为一个 numeric token，求值为 `NaN`；缺少闭合引号的字符串仍被接受；`===`/`!==` 映射为两字符比较符但消费3个字符。这些行为未修。无 GUI/Tauri、native file、模型或真实 Worker 操作。
- 同快照 gates：focused `expr.test.ts` 1 file / 25 tests；全量 247 files / 1,593 tests；build 2,165 modules；app/root/node 三项 tsc 通过；i18n 1,279 keys；`git diff --check` 通过。日志 `D:/Hermes/cache/scratch/r5-s9-tokenize-gates-20261014.log`。Build 有既有 mixed dynamic/static import 与 >500kB chunk warnings；全量测试包含一个既有 mocked GUI stderr diagnostic，但全部测试通过。
- 首轮 exact reviewer `passed=false` 的原始 JSON 及误读内容详见 R5 报告“被弃用的评审结论”。Immutable target blob 中三个 `String.raw` raw template 均以 U+0022 quotation mark（codepoint34）开始，而非 U+005C reverse solidus（92）；worktree 与 target blob 相同。针对同一 immutable range 的 corrected-context review 返回 `passed=true`、clean、security/logic 空；确认首轮 finding 是 JSON/diff escaped rendering 误读。Reviewer 的非阻塞建议是补 CR/LF whitespace 与 trailing-backslash characterization，暂记 backlog，不在实现后追加测试。Function3 在时限内完成，按计划仍保持 unverified。

### 7.477 R5 Slice10：为20个复杂函数补目的/不变量/ADR头注释（unverified）

- Start tag `checkpoint/readability-why-comments-start-20261014-r5` 指向 `6db0f231d710eb43bef241d81f1cffaf6194857c`；tagger `09:39:41 +0800`，90分钟 cutoff `11:09:41 +0800`。从 fresh metrics 排除禁区与 recovery/cleanup-sensitive 文件后，选20个复杂度最高的 eligible 函数；`src/App.tsx` 与 Worker/cleanup相关候选不改。完整函数与baseline metrics见 `.hermes/reports/2026-10-14-r5.md`。
- 仅改19个源文件内的注释，覆盖20个目标函数，未改运行代码、测试或状态/权限逻辑；`git diff --ignore-space-at-eol --unified=0` 内容检查无非注释行。三次本地注释提交：`49e7aeba85eb8ecdd6eca1d2326188eaea132e73`、`b5498b308d5f8652850c5a47cb9620df8bf774b9`、final `3b0091b4efb8e1a4081547916f1faaceaa4cda94`。中间两个评论版均因过度概括被独立 review 否决；据源码修订了 harness tokenBudget、AssetsPanel/BaseNode ADR引用、nodeCouncil 的保留字例外、Inspector activeWfId 资产范围，以及dispatch发布、patch-set partial write、host responder等表述；原始 strict JSON 与逐次修订详见 R5 报告。旧失败目标的 unverified tags 保留不移动，最终 tag `checkpoint/readability-why-comments-unverified-20261014-r5-3` 指向 final target。
- Final exact review 覆盖完整 `6db0f231d710eb43bef241d81f1cffaf6194857c..3b0091b4efb8e1a4081547916f1faaceaa4cda94` 三提交范围，返回 `passed=true`、clean、`security_concerns=[]`、`logic_errors=[]`；确认19文件diff为注释-only、20目标覆盖、无禁区路径且ADR引用有效。两条非阻塞 wording suggestions（Ctrl+S export/new；区分 maxRounds 与 transient retries）未在通过后再扩展，记录 backlog。按计划只有Slice5/12能标verified，因此Slice10仍unverified；无需GUI/Tauri读回。
- 同一最终工作树质量门：`npm run test -- --reporter=dot` 247 files / 1,593 tests；`npm run build` 2,165 modules；app/root/node tsc、`npm run i18n:check`（1,279 keys）、`git diff --check` 均通过。Metrics 无 complexity 变化；嵌套注释使outer function LOC变化记录见报告。Build保留既有dynamic/static import与>500kB chunk warnings；测试含mocked GUI stderr diagnostic但全部通过。日志 `D:/Hermes/cache/scratch/r5-s10-repair2-gates-20261014.log`；metrics `D:/Hermes/cache/scratch/r5-s10-repair2-metrics-20261014.json`。

### 7.478 R5 Slice11：readability metrics JSON 路径保护（unverified）

- Start tag `checkpoint/metrics-json-guard-start-20261014-r5` → `c5cb3c0668a162d5fdb33e8aaeef5e9df51bc247`，tagger `11:00:40 +0800`，30分钟 cutoff `11:30:40 +0800`。盘点 `scripts/readability-metrics.cjs` 发现 `--json` 原先只检查 `.json` 后缀，最终直接写入用户提供的路径；Git Bash 背景/重定向运行限制也未写在脚本头部。
- 先新增 `scripts/readability-metrics-cli-test.cjs`，通过 `node.exe --test` 子进程覆盖绝对与相对仓库内输出路径，断言 exit2、错误信息与不落盘。旧脚本两项均以 exit0 写出 JSON，RED 测试失败；`finally` 只删除本测试唯一命名的输出探针，随后 readback 确认仓库无残留。Test-only commit `97672a0e51585bc0de76a680c782a2e3e5a6b4ee`，RED tag `checkpoint/metrics-json-guard-red-unverified-20261014-r5` 指向该 commit。
- Implementation target `82bc624e3ed7cd29e115c4968e3fba5bb6ed69fa`：保留 `.json` 后缀校验，增加 `path.resolve(root, jsonOut)` + `path.relative(root, resolved)` component-boundary 检查，仓库内目标在计算指标/写文件前以 exit2 拒绝；usage 与头注释指明 Git Bash 下使用 `node.exe`。不新增依赖、不修改其它路径；unverified tag `checkpoint/metrics-json-guard-unverified-20261014-r5` 指向 target。
- GREEN/readback：Node 内置 CLI tests 2/2 passed；手动正向运行使用 `node.exe scripts/readability-metrics.cjs --top 5 --json D:/Hermes/cache/scratch/r5-s11-safe-json-20261014.json` 成功，JSON readback含 `generatedAt/fileStats/fnStats/hatches/fanIn`、9,253 `fnStats`；stdout在 `D:/Hermes/cache/scratch/r5-s11-safe-json-run-20261014.txt`。最终全门：247 files / 1,593 tests；build 2,165 modules；app/root/node tsc；i18n 1,279 keys；diff-check 均通过。Build保留既有dynamic/static import与>500kB chunk warnings；Vitest有预期mocked GUI stderr但全过。日志 `D:/Hermes/cache/scratch/r5-s11-final-gates-20261014.log`。
- Exact review覆盖 `c5cb3c0668a162d5fdb33e8aaeef5e9df51bc247..82bc624e3ed7cd29e115c4968e3fba5bb6ed69fa` 两提交（含RED测试），返回 `passed=true`、clean、security/logic空；确认无新增依赖或禁区改动。Reviewer建议增补 traversal/cross-drive regression；如策略需阻止外部 symlink/junction 指向仓库，也需要真实 filesystem destination 校验。当前target仅提供词法路径 containment；上述测试/realpath扩展未在Slice11扩大，记为non-blocking backlog。按计划保持unverified；无模型、Worker或GUI动作。

### 7.479 R5 Addtime batch 1：下一批20个复杂函数的注释-only说明（unverified）

- Start tag `checkpoint/readability-why-comments-addtime-start-20261014-r5` → `752dd2ccc471a85369ab64bd5494b716f682975d`，tagger `11:18:19 +0800`，90分钟 cutoff `12:48:19 +0800`。Fresh metrics `D:/Hermes/cache/scratch/r5-addtime-comments-metrics-20261014.json` 生成于 `2026-10-14T03:18:21.553Z` UTC；按复杂度排序并排除已处理函数、禁区、恢复/cleanup/Worker文件及无对应ADR的候选，选出20个函数，完整列表见R5本地报告。
- 仅增加/修订20个函数头注释，说明目的、不变量和canonical ADR；不改运行逻辑、测试/assertions或受保护路径。初始代码提交 `62adfdccf65abc8a8861eb96bb6b4acfa9b84ecf`；review pass=true但建议细化 `MasterAgentPage` 的UI/runtime resolver范围、`parseMasterResponse` 的ID唯一性范围和 `applyWorkflowFile` 的validation范围。仅按建议修订3处注释，最终代码target `5cebc3b0350a4a85f9aa555bc8b7e149e3b6b34c`；完整两提交范围 `752dd2ccc471a85369ab64bd5494b716f682975d..5cebc3b0350a4a85f9aa555bc8b7e149e3b6b34c` 的独立 exact review `passed=true`、clean、security/logic/suggestions均空。初始 unverified tag `checkpoint/readability-why-comments-addtime-unverified-20261014-r5` 和最终tag `checkpoint/readability-why-comments-addtime-unverified-20261014-r5-2` 分别固定在各自目标，均按政策保持unverified。
- 质量门（最终源码内容）：247 files / 1,593 tests；build 2,165 modules；app/root/node `tsc --noEmit`；i18n 1,279 keys；`git diff --check`均通过。CRLF/LF规范化的AST leaf-token比较确认20个首批文件与3处修订均未改变代码token；fresh metrics前后20个目标函数LOC与complexity完全不变。Build保留既有mixed dynamic/static import与>500kB chunk warnings；Vitest有预期mocked GUI stderr diagnostic但全过。日志 `D:/Hermes/cache/scratch/r5-addtime-comments-reviewfix-gates-20261014.log`；baseline/final metrics `D:/Hermes/cache/scratch/r5-addtime-comments-metrics-20261014.json` / `D:/Hermes/cache/scratch/r5-addtime-comments-reviewfix-after-metrics-20261014.json`。无GUI/Tauri、真实Worker或模型调用。

### 7.480 R5 Addtime batch 2：下一批20个复杂函数的注释-only说明（unverified）

- Start tag `checkpoint/readability-why-comments-addtime-start-20261014-r5-2` → `d3ccd01cb07bc98e9e4f4593d1de9beaba9cd4cc`，tagger `12:25:01 +0800`，90分钟 cutoff `13:55:01 +0800`。以该快照fresh metrics排序，排除已注释目标、受保护/恢复/cleanup/Worker路径和无直接ADR依据候选，选20个函数/19个源文件；完整列表见R5本地报告。
- 三个代码提交：`03fa741d3789c6c765c0c1c1b8566e52925d9aeb` 加入注释；`aeaedb1760386ba27174a703a34740180ae269e4` 收窄registry fallback/activation与run-finalizer experience范围；`d5d4e951d81a9dee4bd37d2f49e47e9d7d86875b` 收窄pending node-picker分支。两次中间exact review均 `passed=false`，分别指出上述三处边界过度表述，以及pending payload包含subgraph时注释声称总会新建节点；逐条仅改注释。最终完整范围 `d3ccd01cb07bc98e9e4f4593d1de9beaba9cd4cc..d5d4e951d81a9dee4bd37d2f49e47e9d7d86875b` 共3提交，最终exact review `passed=true`、clean、security/logic空；建议将pipeline.handoff可选磁盘副作用的Acceptance/Receipt跟踪作为未来工作。三个unverified tag分别固定于各自代码目标，均保留且未升级。
- 最终快照全门：247 files / 1,593 tests；build 2,165 modules；app/root/node `tsc --noEmit`；i18n 1,279 keys；`git diff --check`均通过。归一CRLF/LF后的AST leaf-token比较19/19文件通过；fresh metrics确认20个目标函数LOC/complexity前后均不变。Build保留既有mixed dynamic/static import及>500kB chunk warnings；Git报告5个编辑文件将由LF转回CRLF，diff-check仍通过。日志 `D:/Hermes/cache/scratch/r5-addtime2-comments-reviewfix2-gates-20261014.log`；baseline/final metrics `D:/Hermes/cache/scratch/r5-addtime2-comments-metrics-20261014.json` / `D:/Hermes/cache/scratch/r5-addtime2-comments-reviewfix2-metrics-20261014.json`。无GUI/Tauri、真实Worker或模型调用。
- 未修残余：`NodePickerModal`允许subgraph payload；pending-connection分支将其ID交给`addNode`（按node definition查找并在无定义时返回null），而reference创建只在无pending分支发生。因此挂起连线时选择subgraph不会创建reference/edge；本批只准确注释现状、不改变行为。后续需决定是pending时隐藏subgraph选项，还是实现subgraph reference自动连线。另保留pipeline.handoff可选文件写入的Receipt集成建议。

### 7.481 R6 开工准备：英文模式收尾与整体验证基线

- 依据 `.hermes/plans/2026-10-14_r6-final-gate.md` 开工。起始 branch `refactor/monolith-split-2`、HEAD `b34479934918ae2f91eff4f9ab7224b74150ad4b`，工作树 clean；start tag `checkpoint/r6-prep-start-20261014-r6` 指向该 HEAD，tagger `2026-10-14 16:30:17 +0800`。7小时 hard deadline 为 `2026-10-14 23:30:17 +0800`。Slice0 在时间盒内完成，无源码改动。
- 基线质量门：247 test files / 1,593 tests；build 2,165 modules；app/root `tsc --noEmit`；i18n en-US/zh-CN 共1,279 keys；`git diff --check` 均通过。Build 保留既有 mixed dynamic/static import 与 >500kB chunk warnings；`src/dev/gui.test.ts` 的预期 mocked `[H4] dev_init_session` stderr diagnostic 不影响测试结果。无 GUI/Tauri、真实 Worker 或模型 API 验收。
- 度量 JSON 写到仓库外 `D:/Hermes/cache/scratch/r6-prep-metrics-20261014.json`，生成时间 `2026-10-14T08:31:16.354Z` UTC：615 files（367 production / 248 test）、9,253 functions；`src/store/workflowStore.ts` fan-in 65。门日志 `D:/Hermes/cache/scratch/r6-prep-gates-20261014.log`。
- 用户对 Slice3 已明确决定：待连接端口打开节点选择器时隐藏 subgraph 选项；普通打开保持现状。R6 计划仅允许 Slice4 在全部验收满足后打 verified tag；Slices1–3 为缺陷修复并保持各自计划状态。

### 7.482 R6 Slice1：英文模式收尾部分完成，exact review 阻塞

- Slice1 start tag `checkpoint/ui-locale-apikeys-templates-start-20261014-r6` → `fe7794392267185e2779a3092a9f81fde9b080e3`，tagger `16:35:19 +0800`；90分钟 cutoff `18:05:19 +0800`。Test-only commit `784c9c914fdfd6ab6ddf06481b0e98b12e0596c7`，代码目标 `1ffb8abdf386efe1141cea4baabec6d3beabb24f`；目标有 unverified tag `checkpoint/ui-locale-apikeys-templates-unverified-20261014-r6`。实现 API key 页面反馈及 starter template 显示 i18n，并扩展 Node/Group/Subgraph 等工作流编辑器 copy；模板 `name`、`desc`、`build()`、节点参数/提示词原值不变。
- 目标 `1ffb8ab` 同快照质量门通过：251 test files / 1,607 tests；build 2,166 modules；app/root `tsc --noEmit`；i18n 1,393 keys；`git diff --check`。日志 `D:/Hermes/cache/scratch/r6-slice1-final-gates-20261014.log`。Build 保留既有 mixed dynamic/static import 和 >500kB warnings。
- 本地扫描 `116` files、`71` TARGET_FILES entries，发现 `16` 个未覆盖文件（7 tests / 9 source，按 AST `literalNodes` 计数；明细见 R6 报告及 `D:/Hermes/cache/scratch/r6-slice1-han-scan.json`）。Exact reviewer 对 `fe779439..1ffb8ab` 两提交 immutable range 返回 `passed=false`、`security_concerns=[]`；logic finding 是 `ApiKeysSection` 把 migration/validation 的翻译结果保存为字符串，挂载时从 zh-CN 切到 en-US 后 `msg` 与 `checks[id].error` 仍显示中文。Reviewer 同时独立列出 Han-run 扫描候选（11 source / 7 test），并发现本地扫描未列出的 `GroupsPanel.tsx` 和 `useProjectSessionWorkerActions.ts`；计数口径与本地 AST scanner 不同，覆盖差异未调和。Browser/Tauri bilingual evidence 属 Slice4，未声称完成。
- cutoff 后回归提交 `7b4b086963cf83bd4f505f4e380ea3ebc1621100`（tag `checkpoint/ui-locale-apikeys-feedback-switch-red-unverified-20261014-r6`，tagger `18:06:26 +0800`）增加已观测 RED 的 zh-CN→en-US feedback 测试。`18:13:44` focused rerun 为 1/2 passed、1 failed，失败内容正是 migration feedback 留在中文；生产修复未提交，未提交尝试已在 `18:07:48` 仅对 `ApiKeysSection.tsx` 恢复。当前 HEAD 保留失败的回归测试，因此不能称当前 HEAD 的全量 gates 通过；没有删除、跳过或放宽断言。
- Slice1 标记 partial/unverified。无 verified tag、Browser/Tauri 验收、真实 API/Worker 或 ProjectSession。由于当前 HEAD 有明确的 focused test failure，后续 Slice2–4 暂停；需要用户决定是否授权新的限时 Slice1 repair 以修复反馈 locale-switch 并核对扫描覆盖差异。R6 总截止仍是 `2026-10-14 23:30:17 +0800`。未 push、merge 或改写历史。

### 7.483 R6 Slice1 授权修复：反馈与可见错误文案（unverified）

- 用户授权的 repair start tag `checkpoint/ui-locale-apikeys-feedback-repair-start-20261014-r6` 指向 `6d16385bc96115ed236f37d7496fd064f2ebc317`，tagger `18:26:32 +0800`，代码修改截止 `19:56:32 +0800`。最终代码 target `87443fc7f6d62e0ff94e121f02da2ec8dd7493c1`，commit/tagger `19:48:41 +0800`；保留 unverified tag `checkpoint/ui-locale-apikeys-feedback-repair-runtime-errors-unverified-20261014-r6`。
- API Keys 静态反馈和逐 key 校验错误现在存储翻译 key/state，并在 render 时使用当前语言；新增 GroupsPanel 未分组标题、DevSessionPanel、TemplateSuggestions、新手任务 scope 的中英展示文案。Worker runtime 的三条原始 guard error payload 保持不变，通过 `ProjectSessionConversationSection` 只翻译已知错误的显示投影，其他错误原样透传；模板/项目字段、提示词和 durable error payload 没有按 UI locale 改写。
- RED→GREEN 回归覆盖 API locale 切换、扫描模板字符串及 Worker error 显示；focused 4 files / 10 tests 通过。Han scanner 现在检查 interpolated template literal chunks；最终扫描 118 files、80 targets、12 个未覆盖文件（7 tests / 5 source，按 AST `literalNodes`）。未覆盖项及其测试 fixture、diagnostic、workflow/prompt/project-data 分类见 `.hermes/reports/2026-10-14-r6.md`。
- 先前 exact review 否决均保留为历史记录：`fe779439..1ffb8ab` 指出 ApiKeys stale feedback；`fe779439..6252d2f` 指出三处可见文案；`fe779439..fc712da` 指出 Worker guard error 显示。最终增量 `fc712da..87443fc`（2 commits）immutable exact review `passed=true`，target/parent/tag 与 clean worktree 核对一致，`security_concerns=[]`、`logic_errors=[]`；非阻塞建议是补测未知/动态错误透传，当前实现默认保持原文。
- 最终同源码树质量门：`npm run test -- --reporter=dot` 为 252 test files / 1,610 tests 全通过；`npm run build` 通过、2,167 modules；`npx tsc -p tsconfig.app.json --noEmit` 与 `npx tsc --noEmit` 通过；`npm run i18n:check` en-US/zh-CN 对齐 1,414 keys；`git diff --check` 通过。Build 保留既有 mixed dynamic/static import 与 >500kB chunk warnings。全量门日志 `D:/Hermes/cache/scratch/r6-slice1-runtime-error-final-gates-20261014.log`。
- Slice1 repair 以 gates/review 通过但 unverified 收尾；尚无 Browser 或真实 Tauri 双语验收、真实 Worker/模型调用或 R6 final tag。下一步恢复计划顺序，先评估 Slice2 的 45 分钟时间盒；R6 hard deadline `2026-10-14 23:30:17 +0800`。

### 7.484 R6 Slice2：runtime log 英文 count 文案修正（unverified）

- Start tag `checkpoint/log-plural-fixes-start-20261014-r6` 指向 `bed640257fd7d48a8482edad34e49e81f120d6f9`，tagger `20:06:25 +0800`，45分钟 cutoff `20:51:25 +0800`。Test-only RED `40c6f2644638cbe0298199f42c67f40521996cee`；测试在 `1 node / 1 edge` 导入日志上观察到旧输出 “1 nodes / 1 edges”。代码 target `3885aac648b883f2d17ce2ea8bd87a7e9f5d3eb5`，commit/tagger `20:17:36 +0800`，unverified tag `checkpoint/log-plural-fixes-unverified-20261014-r6` 指向该代码目标。
- 修复仅改 en-US locale wording：导入节点/边数量改用 neutral count labels，子图日志独立显示 input/output count，missing-node-types 保留 `count` 的 one/other 分支并将 `customCount` 改成无数一致规则的 count label。Test 在同一份 runtime-log fixture 中验证 imported 1/1、packed nodes 1 与2且输入/输出互异、missing 2/custom 1；运行时代码未改，zh-CN locale 原值保持不动。
- Same-target gates：focused `runtimeLogI18n.test.ts` 1 file / 4 tests；full `npm run test -- --reporter=dot` 252 files / 1,611 tests；`npm run build` 2,167 modules；app/root tsc；`npm run i18n:check` 1,414 keys；`git diff --check` 均通过。日志 `D:/Hermes/cache/scratch/r6-slice2-plural-fixes-gates-20261014.log`。Build 保留既有 mixed dynamic/static import 与 >500kB chunk warnings。
- Exact review 覆盖完整 `bed6402..3885aac` 两提交、immediate parent `40c6f26`，严格 JSON `passed=true`、working tree clean、`security_concerns=[]`、`logic_errors=[]`、suggestions 空；核实三项R5 Slice7复数问题都已解决且无runtime逻辑或中文资源变化。无Browser/Tauri/Worker/模型验收；本切片保持unverified。

### 7.485 R6 Slice3：pending NodePicker 隐藏子图选项（unverified）

- Start tag `checkpoint/nodepicker-pending-subgraph-start-20261014-r6` → `6b5fad5cd1bb4a67249d9e43c30e1eb83a37241d`，tagger `20:30:47 +0800`，45分钟 cutoff `21:15:47 +0800`。Test-only RED commit `4e0949551031894240ade66edfd6eebde9a8e88a`；pending 模式下 subgraph 候选仍显示的断言按预期失败，普通 picker 候选保持显示。代码 target `09adf1184dd0fd8195dd4b6fb6ab3e3485ee0a77`，commit/tagger `20:39:57 +0800`，unverified tag `checkpoint/nodepicker-pending-subgraph-unverified-20261014-r6` 指向该目标。
- `NodePickerModal` 新增默认开启的 `showSubgraphs` 展示开关；主画布 `useCanvasNodePicker` 仅在 pending connection 时关闭该项。用户关闭/取消 picker 时同时清除 pending endpoint，避免旧连接状态影响后续普通打开；`SubgraphEditor` 未传该 prop，保持原子图编辑器 picker 行为。节点选择与连线逻辑未改。
- Same-target gates：focused NodePickerModal + WorkflowEditor 2 files / 10 tests；full `npm run test -- --reporter=dot` 253 files / 1,613 tests；`npm run build` 2,167 modules；app/root tsc；i18n 1,414 keys；`git diff --check` 均通过。日志 `D:/Hermes/cache/scratch/r6-slice3-pending-picker-gates-20261014.log`；既有 mixed dynamic/static import 和 >500kB chunk warnings 保留。
- Exact review 完整范围 `6b5fad5..09adf11`（2 commits；parent `4e09495`）通过，clean、`security_concerns=[]`、`logic_errors=[]`。非阻塞建议：补 hook-level 测试直接覆盖 pending-open wiring 及取消后再 ordinary-open；本次 modal visibility regression 已验证关键可见行为，建议记录后不扩大该时间盒。没有 Browser/Tauri/Worker/模型验收；切片按计划保持 unverified，后续优先 Slice4 完整验收。

### 7.486 R6 Slice4：全量门通过，完整范围 review / Tauri console 未通过（unverified）

- Slice4 start tag `checkpoint/monolith-split-2-final-start-20261014-r6` → `f741960b873645d14de049d3cc76f83eb90e0f49`，tagger `21:00:07 +0800`。最终同代码快照全量 gates：253 test files / 1,613 tests；build 2,167 modules；app/root TypeScript；i18n 1,414 keys；`git diff --check` 均通过。保留既有 Vite mixed dynamic/static import 与 >500kB chunk warnings。日志：`D:/Hermes/cache/scratch/r6-slice4-{test,build,app-tsc,root-tsc,i18n,diff-check}-20261014.log`。
- 同快照 readability metrics：369 production files、254 test files、4,971 production functions；>300 LOC function 9（基线18），complexity >50 function 9（基线13）。JSON/log：`D:/Hermes/cache/scratch/r6-slice4-metrics-20261014.{json,log}`。
- Immutable exact review 完整范围 base `1e2030983bbb606315e9d9a2f5b421f29c0b3855` → target `f741960b873645d14de049d3cc76f83eb90e0f49`，parent `09adf1184dd0fd8195dd4b6fb6ab3e3485ee0a77`，233 commits；branch `refactor/monolith-split-2`，review 核验工作树 clean；strict JSON `passed=false`。
- Blocking security concern：`scripts/readability-metrics.cjs:37-48` 的 `--json` 输出目录保护只检查 lexical `path.resolve/path.relative`；外部 symlink/junction 指入仓库时可以绕过边界，后续文件写入会跟随链接。
- Blocking logic error：`src/store/workflowRegistryActions.ts:58-95` 在 await `resolveStandalonePath` 前快照 `inProject`，await 后读取新的 store state；若 await 期间打开 Tauri 项目，可能把新 workflow 写进该项目，却附带 standalone workspaceDir。需在新修复范围中增加 project-context race regression 并采用一致上下文/fail-closed 处理。
- Reviewer 非阻塞建议另列：英文 NodePicker 仍显示 built-in 中文 category；`workflowIO` 英文 missing-node-types 日志仍使用中文分隔符 `、`；AgentPanel probe/model-hint 翻译字符串存本地 state，切换 locale 可能残留旧语言。本轮不将 suggestions 误写成已修复。
- Browser 与真实 Tauri CDP 各保存37个页面截图/DOM记录；Browser error-level console events、page errors、exceptions 均为0。Tauri 的同一条 `[H4] dev_init_session` Git top-level probe error（exit128，cwd `D:/code/slimeMold/src-tauri`，`fatal: not a git repository`）同时出现在1条 `Runtime.consoleAPICalled` error event 与注入 page-error array；无 exception，严格 console 门失败。Tauri disposable 项目在 scratch 显示 forbidden-path 持久化告警，项目文件未能从 scratch read-back，故磁盘落盘验收未通过。
- 页面覆盖仍有缺口：本次英文/中文 New Project 弹窗模板卡片已截图，但没有实际打开 `CanvasWelcomeSurface`；该组件的双语欢迎页模板卡片不能以 New Project 弹窗截图替代。总证据 manifest `D:/Hermes/cache/scratch/r6-slice4-evidence-20261014/manifest.json`，167项逐项哈希匹配，manifest SHA-256 `8b7d2aadfc8e3122bb74bab72d1d1c59e1adce36c4c981450845ded815bb125f`。
- 依计划，Slice4 任一门不满足不得创建 final unverified/verified tag pair；当前不打 R6 final tags，Slice0–3 与 Slice4 均维持各自 unverified 状态。R6计划的单次修复循环限定于“仅发现英文模式中文残留”，本次另有 security/logic blockers；新的代码修复时间盒需用户明确决定。未 push、清理 worktree、启动 ProjectSession/Worker/模型或改动用户项目。

### 7.487 R7 Slice0：跨夜修复基线（unverified）

- 按 `.hermes/plans/2026-10-15_r7-overnight.md` 开工；branch `refactor/monolith-split-2`、HEAD `350d1aa270e519a98e3dc82ba819602633daeec1`、工作树 clean。prep start tag `checkpoint/r7-prep-start-20261015-r7` 指向该 HEAD，tagger `2026-10-14 23:57:59 +0800`；Slice0 15分钟 cutoff `2026-10-15 00:12:59 +0800`，R7 7小时硬停止 `2026-10-15 06:57:59 +0800`。
- 同快照质量门：253 test files / 1,613 tests；build 2,167 modules；app/root TypeScript；i18n en-US/zh-CN 对齐1,414 keys；`git diff --check` 均通过。build 保留既有 Vite mixed dynamic/static import 与 >500kB chunk warnings；测试含预期 mocked `[H4] dev_init_session` diagnostic。日志 `D:/Hermes/cache/scratch/r7-prep-{test,build,app-tsc,root-tsc,i18n,diff-check}-20261015.log`。
- Metrics：369 production files、254 test files、4,971 production functions；>300 LOC function 9、complexity >50 function 9；R6 baseline 对应18和13。metrics 文件 `D:/Hermes/cache/scratch/r7-prep-metrics-20261015.{json,log}`。Slice0 无源码改动；R6 的 security/logic blockers 已作为后续 R7 切片进入计划。

### 7.488 R7 Slice1：metrics JSON 真实路径检查（partial / unverified）

- Slice start tag `checkpoint/metrics-json-realpath-start-20261015-r7` 指向 `b09dc3bdb88b5149e7df69742b89fcfb4264ff2f`，tagger `2026-10-15 00:07:17 +0800`；30分钟 cutoff `00:37:17 +0800`。目标 `6f83af5cc2893769454157d2cd2f668ddae84edc`，parent `43ecd1a496ba8db066e52a20c6d4e0551790d9f7`，本切片范围3 commits。
- `scripts/readability-metrics.cjs` 现在以 repository root 和 `--json` target 的真实路径做边界比较，检查最深已存在祖先并拼回缺失后缀，拒绝已有 symlink 输出目标。新增 `src/dev/readabilityMetricsJsonPath.test.ts` 子进程回归；RED 确认仓库内 junction 旁路，GREEN 后该路径被拒绝。普通仓库内路径拒绝、仓库外 regular output 接受。Windows 文件 symlink 创建因 `EPERM` 显式跳过并记录，目标 symlink 分支未获得运行态覆盖。
- 最终同快照 gates：254 test files；1,616 tests passed / 1 skipped（总1,617）；build 2,167 modules；app/root TypeScript、i18n 1,414 keys、`git diff --check`、Node syntax check、CLI tests 2/2、metrics JSON 写入均通过。保留既有 Vite mixed dynamic/static import 与 >500kB chunk warnings。首次 build/app-tsc 发现 test helper 类型错误；修正后同一目标快照全套门通过。日志 `D:/Hermes/cache/scratch/r7-slice1-closed-*-20261015.log`。
- Metrics：369 production files、255 test files、4,971 production functions；>300 LOC 9、complexity >50 9；数据 `D:/Hermes/cache/scratch/r7-slice1-closed-metrics-20261015.json`。剩余时间不足以完成独立 exact review 与 closeout，未派 reviewer；没有 verified tag，Slice1 保持 partial/unverified。完整状态见 `.hermes/reports/2026-10-15-r7.md`。

### 7.489 R7 Slice2：workflow create 项目切换 fence（partial / unverified）

- Slice start tag `checkpoint/workflow-create-project-guard-start-20261015-r7` 指向 `e4eec9bbf85ff5655c4f40e3f3c1dc18d61cffac`，tagger `2026-10-15 00:40:22 +0800`；45分钟 cutoff `2026-10-15 01:25:22 +0800`。实现 target `72d25f97c2b9d021724744fe330383daa019872a`；最终 incremental review parent `171f47681698bbc8a2fe5dd2b09ff1cb5d7f52dd`，范围 `eb925155b523c13debdcace15faa79bc034eb12c..72d25f97c2b9d021724744fe330383daa019872a` 共2 commits。
- `newWorkflowInProject` 在 standalone path await 前保存 `projectId/projectPath`；变化时只打 i18n warning 并返回 `{status:'aborted', reason:'project-changed'}`，不写 workflow registry；成功返回 created 结果。后来把 result union 暴露到 `WorkflowState` 类型，并新增 type-contract test。
- Slice2 RED 回归在 await 期间切换项目。首轮 exact review `e4eec9b..eb92515` passed=true、security/logic 空；建议的 store result-type 暴露已在后续两 commit 中补齐。增量 reviewer `eb92515..72d25f9` passed=false，唯一 logic finding 为旧/新 workflow “unchanged”断言比较共享对象引用；当前 `.toEqual` 仍比较同一引用，不能检测 in-place mutation。应在 await 前保存独立深快照，再做内容比较。
- 同最终源快照质量门：focused registry tests 7/7；全量 255 test files / 1,618 passed / 1 skipped（1,619 total）；build 2,167 modules；app/root TypeScript、i18n 1,415 keys、`git diff --check` 均通过。保留既有 Vite mixed dynamic/static import 与 >500kB chunk warnings。日志 `D:/Hermes/cache/scratch/r7-slice2-public-result-{test,build,app-tsc,root-tsc,i18n,diff-check}-20261015.log`。
- cutoff 前剩余约1分钟，不足以完成 test RED→GREEN、同快照全量 gates、增量 exact re-review 与 closeout；未启动修复。tag `checkpoint/workflow-create-project-guard-unverified-20261015-r7-2` 仍为 unverified，Slice2 partial/unverified；现有 passed=false 不迁移为通过。后续修复只可在有足够时间的明确修复窗口内或 R7 Slice5 已授权的阻塞修复循环中进行，不要复用当前无效断言。完整 review JSON/结论见 `.hermes/reports/2026-10-15-r7.md`。

### 7.490 R7 Slice3：本地化建议与 Han scanner 收口（partial / unverified）

- Slice start tag `checkpoint/r6-locale-suggestions-start-20261015-r7` 指向 `5fb2270d817547fa1f89a2f77a557f9b8676c8b1`，tagger `2026-10-15 01:28:31 +0800`；45分钟 cutoff `2026-10-15 02:13:31 +0800`。code target `35779cf2dd19d78ba7c7b030e8cda6b8079dbcb4`，parent `a7ad477ee3ee1af6804171bbd21954ea7e841ab6`，5 commits；partial tag `checkpoint/r6-locale-suggestions-partial-20261015-r7` 固定该 target，未标 verified。
- `NodePickerModal` 改用现有 `localizeNodeCategory` 仅显示/搜索内建类别，不改变 catalog category；`uiChineseLiterals.test.ts` 将该组件加入 `TARGET_FILES` 和 `NAMESPACE_CANDIDATES`。`workflowIO` 缺失节点类型摘要现在从 locale 资源取分隔符，英文逗号、中文顿号；新增集成回归执行真实导入/错误日志路径。AgentPanel mounted locale-switch stale probe/model-hint 本轮未修复。
- 同一当前代码树的 focused gates：3 test files / 8 tests passed；`npm run i18n:check`：en-US、zh-CN 对齐 1,416 keys；`git diff --check` 通过。日志 `D:/Hermes/cache/scratch/r7-slice3-focused-green-20261015.log`、`r7-slice3-i18n-20261015.log`、`r7-slice3-diff-check-20261015.log`。未运行全量 test/build/app-root TypeScript；未派 exact reviewer，因此 Slice3 partial/unverified，无 verified tag。
- 按 R6 本地 AST `literalNodes` scanner 的原始9个生产文件逐项复核：workerRuntime 3、AssetsPanel 2、DevSessionPanel 11、TemplateSuggestions 1、WindowTitleBar 7、WorkflowWizard 9、ProjectSessionArtifactsSidebar 1、useProjectSessionConversation 2、useProjectSessionOrchestrationActions 4。4个文件在 R6 后续已本地化并加入 `TARGET_FILES`；AssetsPanel/WindowTitleBar 为不进入 UI 的 console diagnostics；WorkflowWizard 为稳定默认 workflow/prompt 数据；conversation 为 Master-facing prompt；orchestration actions 为项目工作流名称/goal 默认值，均保持原值。逐文件判定见 `.hermes/reports/2026-10-15-r7.md`。
- 截止前剩余时间不足以完成 AgentPanel 状态 RED→GREEN、同快照全量质量门、exact review 和 closeout；没有提交半截测试或实现。Slice3 维持 partial/unverified。无真实模型 API、Worker、ProjectSession 或 Tauri GUI 副作用。

### 7.491 R7 Slice4：预期非 Git 项目的 H4 诊断级别（完成 / unverified）

- Slice start tag `checkpoint/dev-init-session-console-start-20261015-r7` 指向 `382fd537a6872dbabc082e67395bed5eb00b35c2`，tagger `2026-10-15 02:13:19 +0800`；60分钟 cutoff `03:13:19 +0800`。初始 target `1f795f697ca02bf6ad7fae185668f399195adb54`。首轮 review 后建立 follow-up start tag `checkpoint/dev-init-session-console-copy-start-20261015-r7`，固定于 `1f795f6`，tagger `02:41:49 +0800`。最终 code target `55bed9db3fc6afc926da47f2f5ce833347d7378b`，parent `b62a15aacd60692cafd0fd184c77fe65d2479e9e`，follow-up范围2 commits；状态标签 `checkpoint/dev-init-session-console-copy-unverified-20261015-r7`。
- R6 的错误来自 `dev_init_session(baseRepo)` 在普通非 Git 项目执行 Git top-level probe。R6 页面对 scratch 下 `.slimemold` 的读写日志和 scratch 的只读 Git probe 支持“普通非 Git fixture”的解释；Rust error context 的 `cwd` 是进程 CWD，不等同于 `git -C` 的 baseRepo。因当时没有保存调用参数，根因结论保留为有证据支持的推断，而非精确参数 read-back。
- `src/dev/gui.ts` 仅将同时含 Rust probe 前缀与 Git fatal `not a git repository` 的情况降为 `console.warn`/`unavailable`；开发 Worker 仍被拒绝。其他 host/Acceptance 初始化异常维持 error 日志与 error 状态。`DevSessionPanel` 对预期非 Git 项目显示中性双语提示，真实异常维持红色错误提示；通用 initialization copy 不再声称所有错误均由 `dev_init_session` 失败引起。`src-tauri/` 未修改。
- RED 测试 commits `f040cd5`（非 Git warning vs error）、`04ab1c5`（面板状态显示）及 follow-up `b62a15a`（两语言通用错误 copy）；实现 commits `1f795f6`、`55bed9d`。focused GUI/panel 回归在最终 copy target 上通过9项。
- 首轮 immutable exact review `382fd537..1f795f6`，3 commits，`passed=false`：Acceptance/DevSession initialization error 的 UI 文案错误地说 `dev_init_session` 失败。增量 review `1f795f6..55bed9d`，2 commits，`passed=true`、security/logic/suggestions 空，确认文案 finding 已修复；reviewer 未运行测试。
- 最终同快照质量门：257 test files / 1,625 passed / 1 skipped（1,626 total）；build 2,167 modules；app/root TypeScript、i18n 1,417 keys、`git diff --check` 均通过。保留 Vite mixed dynamic/static import 与 >500kB chunk warnings；全量测试日志另有一条来自既有 generic-error mock test 的预期 `console.error`。日志 `D:/Hermes/cache/scratch/r7-slice4-copy-{test,build,app-tsc,root-tsc,i18n,diff-check}-20261015.log`。
- Slice4 保持 unverified：修复后未重新启动真实 Tauri，不能宣称 runtime console error 门通过。Slice5 需用 fresh identifier 复验，并在可行时读取实际 `baseRepo`，不要从 Rust process `cwd` 推断它。Reviewer 的 Acceptance-store failure bridge test 与 classifier near-miss coverage 建议记为非阻塞 residual。

### 7.492 R7 Slice5：分支整体验证（partial / unverified）

- 代码目标 `12c4d864e78b6456ecbf1ebceeae791cd9c7297e`，完整范围 base `1e2030983bbb606315e9d9a2f5b421f29c0b3855` → target（257 commits），parent `55bed9db3fc6afc926da47f2f5ce833347d7378b`。06:46:05–06:46:46 +0800 同目标最终质量门：257 test files / 1,625 passed / 1 skipped（1,626 total）；build 2,167 modules；app/root TypeScript、i18n 1,417 keys、`git diff --check` 通过。唯一 skipped 是 Windows file-symlink 用例创建时 `EPERM`；保留 Vite mixed dynamic/static import 与 >500kB chunk warnings。
- Metrics：369 production files、258 test files、4,972 production functions；>300 LOC 9、complexity >50 9。对照 R6 基线369/254/4,971/9/9。日志：`D:/Hermes/cache/scratch/r7-slice5-closeout-20261015-{test,build,app-tsc,root-tsc,i18n,metrics,diff-check}.log`；metrics JSON `D:/Hermes/cache/scratch/r7-slice5-closeout-20261015-metrics.json`。
- fresh Browser/Tauri 双语 canonical 回读分别40/42页；CanvasWelcomeSurface 的 Browser 截图未实际显示目标，已归档到 failed；Tauri 中英文截图与 DOM 均确认模板卡片可见，符合计划对该页“任一侧稳定到达”的条款。CDP Browser 8项、Tauri 6项事件，严格 error/exception 数均为0；Tauri 另有1条预期非 Git `console.warn`。scratch project path 出现 `forbidden path` UI 日志；项目持久化未作为验收，不读取真实项目文件。Tauri `baseRepo` 参数未直接截获，不能用 process `cwd` 代替。
- 独立完整范围 review 首轮严格 JSON `passed=true`，无 security/logic findings；随后纠正上下文复审确认 Slice2 既有阻塞仍未修：`oldState.workflows` 与 `oldWorkflows`、`currentState.workflows` 与 `newWorkflows` 共享引用，测试 `toEqual` 自比无法发现原地修改。代码 cutoff `2026-10-15 05:57:02 +0800` 已过，未在截止后改码；因此 Slice5 为 partial/unverified，不创建最终 tag pair、不修改 historical triage。完整 verdict JSON 保存在本轮报告 `.hermes/reports/2026-10-15-r7.md`。
- 文档收尾由用户在原 global hard stop 之后明确续令，于 `2026-10-15 08:23 +0800` 继续；未延长或重置代码改动时间盒。

### 7.493 R7 Slice2 共享引用回归复修（修复通过 / R7 overall partial）

- 用户批准一次额外45分钟 Slice5 修复窗口：start tag `checkpoint/r7-slice2-shared-reference-test-repair-start-20261015-r7` 固定 `188217028b1c57fceebde7f898b270c3fc8d6628`，tagger `2026-10-15 08:36:29 +0800`；代码 cutoff `09:21:29 +0800`。修复 commit `3da19882e51a08a5606c1c871e833b7057537ec8`，parent `188217028b1c57fceebde7f898b270c3fc8d6628`；仅修改 `src/store/workflowRegistryActions.test.ts`，生产实现未改。创建时的 unverified tag `checkpoint/r7-slice2-shared-reference-test-repair-unverified-20261015-r7` 固定该目标。
- 回归在 await 前分别对旧/新 workflow map 做 JSON 深快照；await 后与快照 `toEqual` 比较，并保留 identity 与 `setState` 未调用断言。临时注入新项目 workflow 的原地 mutation 时，快照断言精确失败；mutant 移除后整个 `workflowRegistryActions.test.ts` 7/7通过。
- 同一 target 的全量门（08:51:55–08:52:32 +0800）：257 test files / 1,625 passed / 1 skipped（Windows symlink setup `EPERM`）；build 2,167 modules；app/root TypeScript、i18n 1,417 keys、`git diff --check`通过；metrics 369 production files、258 test files、4,972 functions、>300 LOC 9、complexity >50 9。保留既有 Vite mixed import 与 >500kB chunk warnings。日志 `D:/Hermes/cache/scratch/r7-slice2-repair-20261015-{test,build,app-tsc,root-tsc,i18n,metrics,diff-check}.log`。
- 增量 immutable review `12c4d864e78b6456ecbf1ebceeae791cd9c7297e..3da19882e51a08a5606c1c871e833b7057537ec8`（2 commits）返回严格 JSON `passed=true`、security/logic/suggestions均空，确认快照独立并覆盖两项目列表；工作树 clean，reviewer未改仓库。
- 该测试 finding 已解决，但 R7 overall 仍 partial/unverified：Slice3 的 AgentPanel mounted-locale stale feedback 仍未修复，因此不创建 final tag pair、不更新 historical triage 为“被取代”。下一步如需修复该 UI 行为，需单独的有界授权窗口。

### 7.494 R7 AgentPanel mounted-locale feedback 修复（修复通过 / R7 overall partial）

- 用户授权的45分钟代码修复窗口由 start tag `checkpoint/r7-agentpanel-locale-state-repair-start-20261015-r7` 固定在 `c40665de74f5818bda49e58800f8b25f53e9f4dd`，tagger `2026-10-15 11:35:46 +0800`，cutoff `12:20:46 +0800`。代码 target `521cf0aafaa979088d52306f8c41a2f461af7328`，parent `c40665de74f5818bda49e58800f8b25f53e9f4dd`，commit time `12:01:31 +0800`；unverified tag `checkpoint/r7-agentpanel-locale-state-repair-unverified-20261015-r7` 指向该 target。
- 根因是 mounted `AgentPanel` 把已翻译的 model hint/probe feedback 字符串保存在 state，locale 切换后无法重新翻译。本轮在 `src/agents/agentManager.ts` 增加带 interpolation 与递归 nested descriptor 的 `ProbeMessageSpec`，保留兼容 `ProbeResult.message` 并增加 `messageSpec`；`src/components/AgentPanel.tsx` 改存 descriptor 并在 render 时使用当前 `t`，`probeStates` / `AgentCatalogList` 仅保存和消费 `ProbeStatus`。新增 `src/components/AgentPanel.localeSwitch.test.tsx`，并扩展 `src/agents/agentManager.test.ts`。
- RED/GREEN：mounted 回归切换 locale 后确认 model hint/probe feedback 重译，模型列表 fetch 与 probe 各调用一次；focused 3 files / 12 tests 通过。
- 验证结果：
  - `npm run test`：258 个测试文件、1,626 个测试通过、1 个 skipped（总1,627）；该 skip 是 `src/dev/readabilityMetricsJsonPath.test.ts` 的 Windows file-symlink setup `EPERM`，原测试保留，未声称通过；
  - `npm run build`：TypeScript/Vite 构建通过、2,167 modules；
  - `npx tsc -p tsconfig.app.json --noEmit` 与 `npx tsc --noEmit`：通过；
  - `npm run i18n:check`：中英文 1,417 个 key 对齐；
  - `git diff --check`：无空白错误。
- Metrics：369 production files、259 test files、4,975 production functions；9 个 >300 LOC、9 个 complexity >50。保留已有 mixed dynamic/static import 与 >500kB chunk warnings。质量门日志前缀：`D:/Hermes/cache/scratch/r7-agentpanel-repair-head-20261015-`。
- Browser mounted DOM readback 在 no-key 路径中验证 zh-CN→en-US 后两个 feedback 均显示英文、旧中文消失，且无模型/API 请求重发；Browser screenshot 未取得。Tauri `en-US` no-key 截图 `D:/Hermes/cache/scratch/r7-agentpanel-repair-evidence-20261015-521cf0a/tauri-agentpanel-en-feedback.png`，SHA-256 `f2f4e0a3e29b07b7c1362193cb74a1b1577275032113f3676d5b0c9e8b8ce2bb`；该 native 观察在原修复时间盒 cutoff 后取得，仅作为 post-cutoff observation，不作为计划门通过证据。无 ProjectSession、Worker 或真实模型/API 调用；Tauri/Vite 进程停止，端口 `1420/9231` 已释放。
- Incremental immutable exact review `3da19882e51a08a5606c1c871e833b7057537ec8..521cf0aafaa979088d52306f8c41a2f461af7328`（3 commits）通过：`passed=true`、clean worktree、`security_concerns=[]`、`logic_errors=[]`；reviewer 于 `12:39:11 +0800`（代码 cutoff 后）派发，只读 pinned Git objects，检查完整 provider descriptor mapping、nested details、Codex/no-key paths 与 consumers。非阻塞建议是补充 Codex、missing-key、provider nested-error 的 mounted-locale 覆盖，本轮未扩大范围。
- R7 overall 仍 partial/unverified：Slice1 symlink 覆盖受 `EPERM` 限制，Slice4 的实际 `baseRepo` 参数 Tauri readback 未完成；修复循环按计划重读受影响页面并做增量复核，没有重跑完整页面矩阵；不创建 final tag pair、不改 historical triage。历史数字与既有 Slice 状态保持原样。

### 7.495 R7 Slice1 文件 symlink 跨平台回归与 Slice4 baseRepo Tauri 读回（partial / unverified）

- 用户授权两项未决 closure；start tags `checkpoint/r7-slice1-file-symlink-coverage-start-20261015-r7` 与 `checkpoint/r7-slice4-baseRepo-readback-start-20261015-r7` 均固定在 `00a7e1c2006eb1001372495956b00c39e884a296`，tagger `16:08:13 +0800`。Slice1 原预算截止 `16:38:13 +0800`；Slice4 原预算截止 `17:08:13 +0800`。
- Slice1 Windows focused test 1 file / 3 passed / 1 skipped，skip 原因为 file-symlink 创建 `EPERM`。在独立 WSL/Linux archive 中用与 target `6f83af5` 相同的两个源 blob运行该 focused test，1 file / 4 passed / 0 skipped；Node `v24.21.0`，npm `11.19.0`。日志 `D:/Hermes/cache/scratch/r7-slice1-symlink-coverage-20261015-521cf0a/linux-test.log`，SHA-256 `640ef53d1d3b0dc9879bbd64daac30b130892da12960987932effdeb6cce3160`。这证明该分支在 Linux/WSL 实际执行；不代表 Windows host 的 `EPERM` skip 消失或 Windows symlink 创建成功。
- Slice1 immutable exact review `b09dc3bdb88b5149e7df69742b89fcfb4264ff2f..6f83af5cc2893769454157d2cd2f668ddae84edc`（3 commits；actual parent `43ecd1a496ba8db066e52a20c6d4e0551790d9f7`）返回 `passed=false`，报告 realpath preflight 与后续 `writeFileSync(jsonOut, ...)` 之间的潜在 symlink TOCTOU。另有两条非阻塞建议：收窄 `EINVAL` skip allowlist、收窄 symlink diagnostic regex。reviewer 的 `head` 字段为 docs HEAD `00a7e1c` 而非 Slice1 target；因此该 verdict 不构成 approval，security concern 保持 fail-closed。没有修改 Slice1 源码；其 30 分钟窗口结束后不再开展代码修复，需新授权。
- Slice4 以真实 Tauri identifier `com.slimemold.verify.r7.slice4.baserepo` 启动，WebView CDP `9232`。在实际 `window.__TAURI_INTERNALS__.invoke` 调用帧读回 `dev_init_session` 参数：`baseRepo=D:/Hermes/cache/scratch/r7-slice4-baseRepo-fixture-20261015`。空 non-Git fixture 的 Rust Git probe 返回预期 exit 128，`ensureGuiDevSession` 结果为 `unavailable`，CDP 观察到预期 `[H4] dev_init_session unavailable for non-Git project` warning；provider requests 0。未打开 ProjectFile、未创建 ProjectSession/Worker、未调用模型/API，也未做项目持久化验收。
- Slice4 证据 manifest `D:/Hermes/cache/scratch/r7-slice4-baseRepo-readback-20261015/manifest.json`（SHA-256 `2b7101ac0eb558587decf256a694ff837567c21068c80610b715b659c5920b73`）；原始 readback log `D:/Hermes/cache/scratch/r7-slice4-baseRepo-readback-20261015/tauri-baseRepo-readback.log`（SHA-256 `7ac93b0aef53d9ad3bc75ef04163b2a59e884fb798b36e470ea72b475855425e`）；Tauri window screenshot `tauri-window-before-readback.png`（SHA-256 `ec064ff16d303f1340ac491c2b8dd31136db793a47a638380e919cd9921c95bc`）。该针对性脚本未采集 `Runtime.exceptionThrown`/`Log.entryAdded`，不声称完整 console-clean。测试关闭后 Tauri/Vite 进程停止且端口 `1420/9232` 释放；fixture/evidence 均保留。
- Slice4 baseRepo 直接读回已完成但保持 unverified；Slice1 file-symlink 分支在 WSL 实际通过，但其 Windows 权限 skip 与 reviewer security concern 仍未闭合。R7 overall partial/unverified；不创建 final tag pair，不更新 historical triage；需新的有界代码授权处理 TOCTOU blocker。

### 7.496 R7 Slice1 TOCTOU repair follow-up（partial / unverified）

- 新授权 closeout tag `checkpoint/r7-slice1-toctou-closeout-start-20261015-r7` 固定在 `203ceedb46421bf4f42239fbf6c5307113b8debf`，tagger `18:20:03 +0800`，窗口截止 `18:50:03 +0800`。Exact repair range `8798cef554094e714f6e4b089d01202473d0e1d0..203ceedb46421bf4f42239fbf6c5307113b8debf` 共 2 commits：`38f23ac` RED regression 与 `203ceed` 实现；实际 parent `38f23ac6ad533042881c0437222abd3189725ca8`。Code checkpoint tag `checkpoint/r7-slice1-toctou-repair-unverified-20261015-r7` 固定 target。
- 回归先复现旧行为：child-process preload 在 `--json` 路径预检后将外部输出父目录切换为指向仓库的 junction；旧实现覆盖 repo sentinel。因 Windows 无法 rename 已打开目录（`EPERM`），只保留稳定的 pre-open path-swap 用例；新实现通过文件句柄校验后写入。最终 focused suite 在全量运行中为 1 file / 4 passed / 1 skipped，skip 为原有 Windows file-symlink setup `EPERM`。
- 同一 target gates：`npm run test -- --reporter=dot` 258 files，1,627 passed / 1 skipped；`npm run build` 通过、2,167 modules；`npm run i18n:check` 通过、1,417 keys；app/root TypeScript no-emit 均通过；`git diff --check` 通过。保留既有 mixed-import 与 >500kB chunk warnings。
- Metrics：369 production files、71,191 production lines、259 test files / 41,644 lines、4,975 production functions、9 个 >300 LOC、9 个 complexity >50。JSON `D:/Hermes/cache/scratch/r7-slice1-toctou-closeout-20261015/metrics.json` SHA-256 `26749885465309c63678c6e6fbc0247e353e0d61bac4ea07a5bb088716996791`；log `metrics.log` SHA-256 `d23ac006259428582d47d24f311756c09526b234ab20b0f171e3bdaa8cca8866`。
- Incremental immutable exact review 对上述 2-commit range 返回 `passed=false`；reviewer 发现外部 hard link 可绕过 `realpath`，新建目标被竞态切到仓库 junction 时可能留下空文件且 cleanup 仍有路径 TOCTOU，并报告 `r+` 相对旧 write-only 方式造成 writable-but-unreadable 文件兼容回归。严格 JSON 原文已保存在 `.hermes/reports/2026-10-15-r7.md`。按用户要求，本轮未继续改码；需新的有界代码授权修复这些 findings 并复审。
- Slice1/R7 仍 partial/unverified；无最终 R7 tag pair，无 historical triage 更新。本节由 docs-only closeout commit 归档；对应本地 unverified checkpoint tag 指向该 docs commit；未 push。

### 7.497 R7 Slice1 combined repair candidate remains blocked（partial / unverified）

- Repair start tag `checkpoint/r7-slice1-hardlink-cleanup-compat-repair-start-20261015-r7` 固定 `1b140e33cb16be184abf1dcf949a91abdc58d5f1`，窗口 `2026-10-15 19:23:05–20:08:05 +0800`。按 R7 计划，这是第二次且最后一次允许的修复循环。
- TDD commits：`ed779be34f99ab7bc29e06158926d58de20223a0` 为 RED tests；`f04f9580d99cf25a970fa36571ff0a2489b5ec03` 拒绝多 hard-link 输出、以 O_WRONLY 保持现存输出可写权限语义、改用 exclusive create，并以 captured path 做 cleanup；`b6962a85f7153fd49204afba19e1297099df37c0` 修正 Linux/Windows cleanup-race test hook。Exact review range start..candidate 共 3 commits，candidate actual parent `f04f9580d99cf25a970fa36571ff0a2489b5ec03`。
- RED focused run：8 tests 中 3 个新回归按预期失败，分别复现 hard-link alias 改写 repo sentinel、missing-output junction swap 留下 repo 文件、旧 `r+` 被模拟为 EACCES。GREEN focused Windows：7 passed / 1 skipped；唯一 skip 为 file-symlink setup `EPERM`。Node 22.23.3 Linux scratch copy：8/8 passed、无 skip。
- Candidate gates：`npm run test -- --reporter=dot` 258 files，1,630 passed / 1 skipped；`npm run build` passed、2,167 modules；`npm run i18n:check` 1,417 keys passed；`npx tsc -p tsconfig.app.json --noEmit`、`npx tsc --noEmit`、`git diff --check` 均 passed。Build 保留已有 mixed-import 与 >500kB chunk warnings。
- Metrics：369 production files / 71,191 lines；259 test files / 41,806 lines；4,975 production functions；9 functions >300 LOC、9 functions complexity >50。JSON `D:/Family/Hermes/cache/scratch/r7-slice1-final-repair-20261015/metrics-final.json` SHA-256 `92547a9a11968c3a1c324cd41cb59c6977112d9d877f6cd2df507f6f84b90c31`；log SHA-256 `839c5824763354734b15b935172d6e3378963d3c00991d7b7c3b5b42ede1f1f0`。
- Immutable exact review candidate `b6962a85f7153fd49204afba19e1297099df37c0`：HEAD/range/parent/clean worktree 均匹配，`passed=false`。Blocker：parent 在 O_EXCL 创建后、首次 realpath 前恢复时，`openedPath` 为空，cleanup 漏删 repo entry；测试只覆盖 realpath 成功后恢复。Captured cleanup path 仍非 inode-bound，替换可导致漏删或误删；并发 hard-link 在最终 fstat 后创建也无法由 nlink check 原子阻止。完整 verdict 保存在 `.hermes/reports/2026-10-15-r7.md`。Reviewer 按要求未重跑测试。
- 按计划在第二次失败后停止，不再做第三轮代码修改；Slice1/R7 仍 partial/unverified，不创建 final tag pair，不 push。本文由 docs-only closeout commit 归档，对应本地 unverified tag 固定该 commit。

### 7.498 用户授权继续后的 cleanup repair window 超时（partial / unverified）

- 新窗口 start tag `checkpoint/r7-slice1-final-cleanup-boundary-start-20261015-r7` 固定 `e5b622454ba0f0de7a7661424ac4a646866adf6d`，tagger `2026-10-15 20:46:01 +0800`，45 分钟 code cutoff `21:31:01 +0800`。这是用户“继续”后的一次整体有界尝试；到期后停止代码改动。
- RED test-only commit `875c1642ee907001e94f49cc5eacbe73994cdeb0`（parent `e5b622454ba0f0de7a7661424ac4a646866adf6d`）加入“成功 O_EXCL 后、首次 realpath 前恢复 parent”的 child-process 回归。Windows focused run：8 tests，1 failed / 1 skipped；失败正是 repo entry 未清除，skip 为 file-symlink `EPERM`。该 checkpoint tag 为 `checkpoint/r7-slice1-final-cleanup-red-20261015-r7`。
- 本窗口内只完成探索性原型：Scratch Win32 handle probe 在恢复 junction 后读回 repo final path、link count=1，并通过 handle disposition 删除刚创建的 repo entry；PowerShell helper race fixture 输出 `PASS: parent restored before final-path lookup; repo entry removed by handle`。未提交 CJS/PowerShell prototype 曾在 Windows 成功写 scratch metrics JSON，也曾在 Linux Node 22 scratch copy 成功写 JSON；这些是探索 smoke，不是质量门或 exact review。
- 截止后按边界恢复未提交 `scripts/readability-metrics.cjs`，移出 repo 的两个 untracked PowerShell prototype；patch/helper/test scripts 保留于 `D:/Family/Hermes/cache/scratch/r7-final-cleanup-expired-20261015-875c164/`，SHA-256 分别为 `078c9880cb331734f6d886f75355322dd9af1dfc40175b056e1192e93f44d1d0`、`5f67bf3893c733775efc4ca339e371778fed31b22a62c34e984cc1529b0fdff5`、`13fce839186193aa6154df992bf6852322a81f46f63bab62f850f5840305b927`；独立 Win32 probe 保留在 scratch。没有运行 `git clean`。
- 当前 HEAD `875c164` 是带有已观察到 RED 的 test-only commit；其生产代码仍未修复该 race。未在该 HEAD 重跑全量 gates、未派 exact reviewer；之前对 `b6962a8` 的 `passed=false` 不迁移至此。Slice1/R7 仍 partial/unverified，不创建 final tag pair、不 push。本文由 docs-only checkpoint commit 归档。

### 7.499 R7 Slice1 handle-bound cleanup repair exact-reviewed (completed / unverified)

- 用户再次授权整体有界修复窗口。Start tag `checkpoint/r7-slice1-final-handle-repair-start-20261015-r7` 固定 base `6b886b33b2e54e0af1faec1f3f3cfc6be7e4504f`，tagger `2026-10-15 23:58:39 +0800`，45 分钟 code cutoff `2026-10-16 00:43:39 +0800`。实现 commit `73250c1175343b90859ec3af3f532709c223e378`，parent 为 start base；test-fixture TypeScript narrowing 修正 commit `8f7e93601dc96efa6177c36b8ba113ae34568d82`，parent `73250c1`。Base..target 共2 commits，exact target parent 为 `73250c1`。代码 unverified tag `checkpoint/r7-slice1-final-handle-repair-typecheck-unverified-20261015-r7` 指向 target `8f7e936`。
- 保留先前 RED regression commit `875c164` 作为开发证据；当前 POSIX writer 在创建输出前 pin 父目录 descriptor、校验 descriptor/path identity，并通过 `/proc/self/fd`（Linux）或 `/dev/fd` 路径创建、验证及 cleanup；Windows 缺失输出使用 PowerShell/Win32 `CREATE_NEW`、handle final-path/link-count 检查和 `SetFileInformationByHandle` 按 handle 删除。已有 hard-link alias 拒绝与 existing external output 的 write-only `O_WRONLY` 兼容均保留。Windows race fixture 通过“创建后、final-path lookup 前恢复父 junction”验证 repo entry 经 handle 删除。
- 同一 target 全量门：`npm run test -- --reporter=dot` 258 files，1,630 passed / 1 skipped（1,631 total）；唯一 skip 仍为 Windows file-symlink 创建 `EPERM`，原因保留在测试输出。`npm run build` 通过、2,167 modules；既有 mixed dynamic/static import 与 >500kB chunk warnings 保留。`npm run i18n:check` 通过、1,417 keys；app/root `tsc --noEmit` 与 `git diff --check` 通过。Windows focused metrics test 7 passed / 1 `EPERM` skip；WSL Linux Node 22 focused 8/8、无 skip；CLI tests 2/2。Windows/Linux metrics JSON smoke 均成功，JSON 分别位于 `D:/Family/Hermes/cache/scratch/r7-slice1-final-handle-20261016/metrics.json`（SHA-256 `3eefc6170c90e7951b1f1d9a9f3a6cbc4a1647fdbcd069833816883d3d4b1e58`）及 `D:/Family/Hermes/cache/scratch/r7-slice1-linux-output-final-20261016.json`（SHA-256 `23e440d41870f2a27d001bff974df7f2832fde91d17c7ddbcd0e48b64c7d6c36`）。
- Read-only immutable exact review 对 `6b886b3..8f7e936`（2 commits；target actual parent `73250c1`）返回严格 JSON `passed=true`，head 精确匹配，worktree clean，`security_concerns=[]`、`logic_errors=[]`。Reviewer 未运行测试、未改文件/ref。非阻塞 suggestions：POSIX missing-output race test 当前证明目录 descriptor pinning 后仍写到外部目录，不实际触发 cleanup branch；建议改名或另补 cleanup 分支测试；另建议未来增加 macOS/BSD `/dev/fd` smoke 和“目录可写但不可读”权限测试。该建议未扩展本窗口；Windows handle-cleanup branch 有直接 race fixture 证据。
- R7/Slice1 仍以 unverified 状态收尾：Slice1 代码候选已过本地质量门及 exact review，但 Windows file-symlink 的 `EPERM` skip 只由 Linux 无 skip 覆盖补证；macOS/BSD 未实测。R7 其余切片/整体验收仍未全部闭合，未创建任何 final R7 tag pair，未 push，未修改 historical triage。Docs-only closeout commit 只提交本开发日志；代码 review/tag target 仍为 `8f7e936`。

Reviewer strict JSON（原样）：

```json
{"head":"8f7e93601dc96efa6177c36b8ba113ae34568d82","working_tree_clean":true,"passed":true,"security_concerns":[],"logic_errors":[],"suggestions":["The POSIX missing-output race test opens the parent directory before swapping and restoring its path. Since output creation then uses the pinned directory descriptor, this tests successful external output, not cleanup of a repository entry; consider renaming it or adding a separate test that exercises the cleanup branch.","Consider adding a macOS/BSD smoke test for the `/dev/fd` path and a permission test for output directories that allow writes but not directory reads."],"summary":"Reviewed the exact target and its parent using Git object reads; HEAD matches the requested target and the working tree is clean. No blocking security or logic findings. No tests were run and no files or refs were changed."}
```

### 7.500 R8 Slice5 whole-branch verification and metrics-json-stdout (completed / verified)

- R8 starts from user-specified clean baseline `d09b5267571a34381b2c5fd35f2cd9f4068ecff9` on `refactor/monolith-split-2`. Metrics stdout RED/test commit `d1ecb7aaec455e828acab1de69ca0e0fe4a366b2`; implementation/docs commit and exact code target `e1fa8f92f76c18be70da0b4fb83a80f38bc21619` (parent `d1ecb7aa`). Start tag `checkpoint/metrics-json-stdout-start-20261016-r8` remains at `d09b526`; code checkpoint `checkpoint/metrics-json-stdout-unverified-20261016-r8` remains at `e1fa8f9`.
- Metrics contract: `node scripts/readability-metrics.cjs --json` emits the complete JSON object to stdout and does not write files; legacy `--json <path>` ignores the path and does not create/overwrite it. Path/handle validation and the two PowerShell writer/race helpers were removed as explicitly directed. Header, CLI tests, stdout Vitest, and `docs/architecture/CODE_READABILITY_REVIEW.md` were updated. Focused and full tests plus a manual stdout parse passed; stderr was empty.
- Independent metrics-slice exact review against the immutable `d09b526..e1fa8f9` two-commit range returned `passed=true`, clean tree, empty security/logic findings. Non-blocking suggestions: assert all five JSON top-level keys and empty stderr, and strengthen the no-human-table/no-file assertions for flag-only `--json`; no repair was required by the plan.
- Independent branch-wide exact review against `1e2030983bbb606315e9d9a2f5b421f29c0b3855..e1fa8f92f76c18be70da0b4fb83a80f38bc21619` (278 commits, 226 files, +18,459/−8,240) returned `passed=true`, `working_tree_clean=true`, `security_concerns=[]`, `logic_errors=[]`. Reviewer inspected immutable Git objects only and did not run tests or alter the worktree/refs. Non-blocking suggestions remain: clarify the `gui.test.ts` near-miss test title/status, cross-reference the duplicated Rust probe text in the non-Git classifier, and later add the pending-picker cancel/open hook test plus a production Acceptance-store failure bridge test. They were outside this bounded verification slice and were not silently treated as blockers.
- Final quality gates on the code snapshot: `npm run test -- --reporter=dot` — 258 files, 1,625 passed, 0 skipped; `npm run build` — 2,167 modules, passed; existing mixed dynamic/static import and >500 kB chunk warnings remain; app and root `tsc --noEmit` passed; `npm run i18n:check` passed with 1,417 aligned keys; `git diff --check` passed. Final logs are under `.hermes/reports/assets/r8/final-logs/`.
- Final stdout metrics: all five keys (`generatedAt`, `fileStats`, `fnStats`, `hatches`, `fanIn`), empty stderr. 369 production files / 71,191 lines; 259 metrics-classified test files / 41,505 lines; 4,975 production functions; 9 functions >300 LOC and 9 with complexity >50. R6 comparison baseline: 369 / 254 / 4,971 / 9 / 9. Metrics JSON SHA-256 `3a4cf61d774bb2e8b523616a410514f41c1275047696c430270860f051e53f23`.
- Browser + real Tauri bilingual GUI matrix: 8 locale/mode runs (Browser/Tauri × en-US/zh-CN × advanced/simple), 104 page captures total; advanced 25 pages per run and simple 1 per run. All page screenshots exist and match their recorded SHA-256; 104/104 are unique within their run manifests; no missing file/hash mismatch; `document.lang` matched each requested locale. CDP `console.error`, `Log.entryAdded` error, and `Runtime.exceptionThrown` counts were 0 in every run. English canvas welcome screenshot visibly contained the starter cards; first-run modal overlay was dismissed before capture (`overlayAfter=0`); simple home was visible without a modal. Five fresh-reload `beforeunload` dialogs were accepted by the harness (one on each Browser advanced locale run, two on Tauri advanced and one Tauri zh-CN simple); these were recorded, not counted as console errors. Tauri identifier `com.slimemold.verify.r8`; no project/ProjectSession, Worker, workflow run, or provider call was started. Final manifest `.hermes/reports/r8-gui-readback-manifest.json`, SHA-256 `c329a7a1986f58770f2ea28ab82e607a99c316fedaaca8659fb9c14ae4fcf3fb`. A later redundant background rerun printed `stdin is not a tty`; its `node ... | tail` pipelines masked the Node failure with exit 0. No readback JSON timestamps changed; rebuilding the manifest revalidated all 104 screenshots (missing=0, hashMismatch=0, errors=0), so the failed rerun is not counted as new GUI evidence.
- With every Slice5 gate met, final tag pair `checkpoint/monolith-split-2-final-unverified-20261016-r8` and `checkpoint/monolith-split-2-final-verified-20261016-r8` both resolve to exact reviewed code commit `e1fa8f9`; refs were read back. They supersede the historical snapshots listed in the appended R8 section of `docs/HISTORICAL_UNVERIFIED_TRIAGE.md`; old refs were not moved/deleted. A later docs-only closeout commit does not migrate the code review/tag target. No push. No user decision is pending.
- Historical §7.499 remains unchanged as a record of the superseded handle-bound writer design; this §7.500 records the newer, user-ordered stdout-only contract. Final report: `.hermes/reports/2026-10-16-r8.md`.
- A second independent read-only review of the same `1e203098..e1fa8f9` target also returned `passed=true`, clean target, and empty security/logic lists. Additional non-blocking residuals: the Slice2 guard does not detect a standalone-to-standalone `workspaceDir` change while both `projectId`/`projectPath` remain null (no Tauri-path leak; this is narrower than a general workspace-generation fence); the `gui.test.ts` near-miss case checks only `getDevGuiError()`, not `devGuiStatus==='error'` or `console.error`; the short authorized-change summary is not exhaustive although the reviewer traced the additional R4/R5/R6/test-harness changes to plans/logs; old path-test/PowerShell helper names remain in historical logs only and are absent from target; the two stdout tests each spawn the full metrics script twice, adding several seconds. Reviewer did not execute gates; the local full gates above were rerun on final docs HEAD. No code repair was authorized/needed for these suggestions.
