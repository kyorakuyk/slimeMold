---
title: SlimeMold 开发记录：从 ComfyUI 式 Agent 工作流到本地优先的多 Agent 工作站
type: development-history
status: active-history
updated: 2026-09-18
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
