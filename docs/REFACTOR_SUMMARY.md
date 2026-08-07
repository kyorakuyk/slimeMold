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

## 2. 已完成的拆分（6 批）

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
- **抽离**：`projectSnapshot`（buildProjectFile 的快照封装）、`DIRTY_KEYS`（脏检测白名单常量）。
- **注意**：`finalizeLoaded()` 含 `setState` 副作用 + `suppressDirty` 模块变量，**保持原位不动**。
- **测试**：`src/store/workflowSerialize.test.ts` 11 用例（含新增 3）。
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
| `src/store/groupProxy.ts` | 分组折叠代理端口 + 默认参数 + 配色 | registryStore（非完全纯函数） |
| `src/store/workflowSerialize.ts` | 序列化/反序列化 + 快照 + 脏检测白名单 | types |
| `src/store/nodeLayout.ts` | 节点几何对齐/分布（纯） | types |
| `src/store/nodeRuntime.ts` | 运行态复位映射（纯） | types |
| `src/engine/executorHelpers.ts` | 能力/输入/用量/瞬时错误（纯） | types |
| `src/engine/graphAlgo.ts` | 图算法（reachable / downstream / executionSet / 剪枝） | types |
| `src/engine/topoSort.ts` | 拓扑分层 | types |
| `src/engine/runtime.ts` | 运行时状态（store runtime） | — |

> 除 `groupProxy.ts` 依赖 `registryStore` 单例外，抽出的计算模块不依赖
> workflowStore / executor 主流程，可被独立单测。

---

## 4. 验证基线（拆后全绿）

- `npx tsc -b`：**0 错误**
- `npx vitest run`：**222 / 222 通过**（14 个测试文件）
  - 其中本轮新增/复用：groupProxy 6 · workflowSerialize 11（含新增 3）· nodeLayout 10 ·
    nodeRuntime 8 · executor 15
- `npm run headless` 三示例全成功：`examples/loop-closure-test.json` ·
  `examples/test-dispatch-plan.workflow.json` · `examples/test-conflict-council.workflow.json`
- GUI 验收：分组折叠/代理端口、默认参数、组框配色、对齐分布、运行态复位均通过。
  > **注**：GUI 验收为**人工验收记录**（非 CI 自动可复现项），验收环境为 Windows + Tauri dev。

---

## 5. 剩余未拆的高风险区（供 Codex 接手评估）

以下**尚未动**，均属动作型/耦合运行态，需明确授权 + 分步 GUI 验收：

1. **`workflowStore.ts` 的项目/画布/运行态 actions 内核**（文件约 2051 行，其中 actions
   约占 1900 行，口径：main @ `2c9fcbb` 之后含方案 P 的 workflows 内存态改造）：
   - `openProject` / `saveProject` / `switchWorkflow` / `closeProject` 等项目生命周期；
   - `onConnect` / `addNode` / `removeNode` / 复制粘贴 / 撤销重做 / `markDirty` 等画布编辑；
   - `finalizeLoaded()`：含 `setState` + `suppressDirty` 模块变量。
2. **`executor.ts` 的 `runWorkflow` 主循环**（`src/engine/executor.ts:231-680`，约 450 行）：
   - 分层并发执行、缓存命中、增量执行、失败续跑、stop 代次过期逻辑。
   - 这是「上帝模块」最顽固的部分；纯函数已抽干净，但**编排本身**仍是单点大函数。
3. **`runtime.ts` 的运行时状态管理**（可进一步评估是否还能拆）。

> 注：`runWorkflow` 位于 `src/engine/executor.ts`，**不在** `workflowStore.ts`。
> workflowStore 仅通过 store 方法调用引擎，引擎内部直接 import `executor`。

---

## 6. Codex 评审后续（2026-08-07 已落地）

Codex 评审后，以下修复已随 `ae0652d`（codex审议完成）进入 main，后续又有
`eb37926`（工作区信任 + openProject 修复）与 `00194ec`（序列化往返修复）：

- **运行资源按 `wfId + runId` 隔离**（新增 `src/engine/runResources.ts`），
  根治旧运行清理新运行资源的竞态。
- **执行计划抽离**（新增 `src/engine/runPlan.ts`）：子图展开、data/control 边分类、
  拓扑分层、环检测、loopGate 识别。
- **主流程 `try/finally` 统一收尾**：空图/展开失败/环检测/异常/中止均进入资源清理。
- **`force` 重启主动 abort 旧运行**；节点 `await` 返回后补代次守卫。
- **非激活工作流不再误读 `activeWfId`**（workspace/变量/资产/输出按目标工作流区分）。
- **Tauri/Git 安全边界收窄**：`run_git` 收敛为沙箱协议，移除开发机硬编码目录权限。
- **工作区信任（动态 capability 注入）**：`grant_project_access` 在打开项目时把
  `<项目根>/**` 动态注入 `main` 窗口 `fs:scope`，替代静态写死绝对路径白名单。
- **序列化往返修复**：`flowEdgesFrom` 恢复 `data.kind/scope`，补 round-trip 测试。

当前验证基线（main @ `00194ec`）：`vitest` 231/231、`tsc` 0 错误、`cargo check` 通过。

### 仍未了结的课题

- **真实 `runWorkflow` 生命周期集成测试**仍不足（stop/force/restart 竞态、
  非激活工作流并发等未见测试证明）。
- **`nodeCache` 全局缓存未按 `wfId/run scope` 隔离**：跨工作流可能复用错误结果，
  需确认是否刻意设计。
- **旧运行退出后仍可能写日志/历史/self-improve**：生命周期语义未完全收口。
- **`workflowStore` 与 `runWorkflow` 主循环**仍是大函数，建议先建
  `RunContext` / `StoreCommandContext` 显式边界后再拆，暂缓物理拆分。

---

## 7. 给接手者的提示

- 本工程采用 `feature` 分支 + 显式 `git add <具体文件>`（不用 `git add -A`）。
- 测试框架为 vitest（jsdom 环境、setupFiles 桩、globals）。
- 新增节点/分组/执行相关纯逻辑时，优先放进对应 `*-Helpers` / `*-Runtime` 类模块，
  而非塞回主模块。
- 若你要动第 5 节的「高风险区」，建议：先抽纯调度决策为单测覆盖的纯函数，
  再改主流程调用，每步保留 `tsc`/`vitest`/`headless` 全绿。

---

*生成日期：2026-08-07 · 初版基于 main @ `2c9fcbb`；评审后续章节基于 main @ `00194ec`*
