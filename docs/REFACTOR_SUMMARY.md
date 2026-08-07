# 上帝模块拆分工程 · 总结（for Codex Review）

> 本文档记录 slimeMold 项目在 2026-08 期间进行的一轮「上帝模块（God Module）拆分」重构。
> 目的：把体积庞大、职责混杂的核心模块（节点定义单体、workflowStore、executor）拆成
> 单一职责、可独立测试的纯函数/常量模块，以测试为安全网、极保守小步推进。
> 供 Codex 评审本轮改动、或接手后续拆分时参考。

---

## 0. 项目背景（一句话）

slimeMold 是类 ComfyUI 的**节点式 Agent 工作流**可视化编辑与执行工具，技术栈
Tauri 2 + React 18 + React Flow (@xyflow/react) + Zustand + TypeScript + Vite。
核心概念：节点（NodeDefinition）经画布连线组成工作流，引擎按拓扑分层并发执行。

---

## 1. 拆分原则（贯穿始终）

- **极保守、小步、以测试为安全网**：每次只抽一个低风险纯函数岛屿，抽完即跑
  `tsc -b` + `vitest` + `headless` 三示例 + （必要时）GUI 验收，零回归才 commit。
- **行为等价优先**：物理搬家，不改运行时语义；新模块对外 `export` 与旧位置一致，
  避免破坏既有 import 路径与单测。
- **纯函数可独立测试**：抽出的函数只依赖输入参数 + 类型，不触碰 store 单例 / IO /
  运行态，因而可在 jsdom 环境下桩入依赖后单测。
- **高风险区隔离**：含 `setState` 副作用、运行代次、abort、并发的 action 主体**不碰**，
  留作后续明确授权 + 分步 GUI 验收才动。

---

## 2. 已完成的拆分（5 批）

### 批次 1 — `src/nodes/builtin.ts` 物理拆分（单体 2741 行 → 聚合器 + 10 子文件）
- **内容**：37 个内置节点定义按 `category` 拆到 `src/nodes/builtin/`（input / media /
  ai / text / flow / tool / audit / dispatch / coord / worker）。
- **结果**：原文件删 2621 行，退化为 `CATEGORY_ORDER` + `builtinDefs` 聚合 + `registerBuiltins`。
- **测试**：无新增（节点定义本身由 registryStore 真实加载验证）。
- **Commit**：早期（main 上，无单独编号在此总结范围；属本工程前置）。

### 批次 2 — `workflowStore` 分组/默认参数/配色 → `src/store/groupProxy.ts`
- **抽离**：`recomputeProxyPorts`（分组折叠代理端口聚合）、`defaultParams`（节点默认参数）、
  `GROUP_COLORS`（组框配色常量）。
- **测试**：`src/store/groupProxy.test.ts`（6 用例）。
- **Commit**：`b29a21b`

### 批次 3 — `workflowStore` 快照/脏检测 → `src/store/workflowSerialize.ts`
- **抽离**：`projectSnapshot`（buildProjectFile 的稳定快照封装）、`DIRTY_KEYS`（脏检测白名单常量）。
- **注意**：`finalizeLoaded()` 含 `setState` 副作用 + `suppressDirty` 模块变量，**保持原位不动**。
- **测试**：`src/store/workflowSerialize.test.ts` 新增 3 用例。
- **Commit**：`d2c00cf`

### 批次 4 — `workflowStore` 几何布局 → `src/store/nodeLayout.ts`
- **抽离**：`alignNodes`（6 种对齐）、`distributeNodes`（x/y 等距分布）。
  关键设计：原内联逻辑耦合 `get().selectedIds`，抽离后改为**显式参数传入**，使纯函数不依赖 store。
- **测试**：`src/store/nodeLayout.test.ts`（10 用例）。
- **Commit**：`e0ad847`

### 批次 5 — `workflowStore` 运行态复位 → `src/store/nodeRuntime.ts`
- **抽离**：`resetNodeRuntime`（清节点 status/error/outputs/usage）、`resetEdgeRuntime`（剥离边 running class）。
- **测试**：`src/store/nodeRuntime.test.ts`（8 用例）。
- **Commit**：`49ff132`

### 批次 6 — `executor` 纯辅助 → `src/engine/executorHelpers.ts`
- **抽离**：`resolveCapability`、`applyCapability`（能力等级推导与上下文裁剪）、
  `isTransient`（瞬时错误判断）、`collectInputs`（上游输入汇集）、`accumulateUsage`（用量累加）。
- **做法**：executor.ts 改为 `import` 供内部使用 + `export` 再导出，保持 `executor.test.ts` 兼容。
- **测试**：复用既有 `src/engine/executor.test.ts`（15 用例全过）。
- **Commit**：`2c9fcbb`

---

## 3. 模块边界现状（拆后）

| 新模块 | 职责 | 依赖 |
|---|---|---|
| `src/nodes/builtin/*.ts` | 内置节点定义（按 category） | registry / types |
| `src/store/groupProxy.ts` | 分组折叠代理端口 + 默认参数 + 配色 | registryStore |
| `src/store/workflowSerialize.ts` | 序列化/反序列化 + 快照 + 脏检测白名单 | types |
| `src/store/nodeLayout.ts` | 节点几何对齐/分布（纯） | types |
| `src/store/nodeRuntime.ts` | 运行态复位映射（纯） | types |
| `src/engine/executorHelpers.ts` | 能力/输入/用量/瞬时错误（纯） | types |
| `src/engine/graphAlgo.ts` | 图算法（reachable / downstream / executionSet / 剪枝） | types |
| `src/engine/topoSort.ts` | 拓扑分层 | types |
| `src/engine/runtime.ts` | 运行时状态（store runtime） | — |

> 所有抽出的纯函数模块**不反向依赖** workflowStore / executor 主流程，可被独立单测。

---

## 4. 验证基线（拆后全绿）

- `npx tsc -b`：**0 错误**
- `npx vitest run`：**222 / 222 通过**（14 个测试文件）
  - 其中本轮新增/复用：groupProxy 6 · workflowSerialize 11（含新增 3）· nodeLayout 10 ·
    nodeRuntime 8 · executor 15
- `npm run headless` 三示例全成功：`loop-closure-test` · `test-dispatch-plan` · `test-conflict-council`
- GUI 验收：分组折叠/代理端口、默认参数、组框配色、对齐分布、运行态复位均通过。

---

## 5. 剩余未拆的高风险区（供 Codex 接手评估）

以下**尚未动**，均属动作型/耦合运行态，需明确授权 + 分步 GUI 验收：

1. **`workflowStore.ts` 的 store actions 内核**（约 1900 行）：
   - `runWorkflow` 入口的调度决策（分层 / 剪枝 / `stopAfterNodes` 截断 / `cutSet` 计算）
     深嵌在主流程，耦合 store/abort/cache/并发。若要抽纯，需改为
     "接收运行状态参数 → 返回下一层待跑集合" 的纯函数，改动大。
   - `finalizeLoaded()`：含 `setState` + `suppressDirty` 模块变量。
   - `onConnect` / `addNode` / `removeNode` / 复制粘贴 / 撤销重做 / `markDirty` 等。
2. **`executor.ts` 的 `runWorkflow` 主循环**（约 450 行）：
   - 分层并发执行、缓存命中、增量执行、失败续跑、stop 代次过期逻辑。
   - 这是「上帝模块」最顽固的部分；纯函数已抽干净，但**编排本身**仍是单点大函数。
3. **`runtime.ts` 的运行时状态管理**（可进一步评估是否还能拆）。

---

## 6. 给 Codex 的提示

- 本工程采用 `feature` 分支 + 显式 `git add <具体文件>`（不用 `git add -A`）。
- 测试框架为 vitest（jsdom 环境、setupFiles 桩、globals）。
- 新增节点/分组/执行相关纯逻辑时，优先放进对应 `*-Helpers` / `*-Runtime` 类模块，
  而非塞回主模块。
- 若你（Codex）要动第 5 节的「高风险区」，建议：先抽纯调度决策为单测覆盖的纯函数，
  再改主流程调用，每步保留 `tsc`/`vitest`/`headless` 全绿。

---

*生成日期：2026-08-07 · 基于 main @ `2c9fcbb`*
