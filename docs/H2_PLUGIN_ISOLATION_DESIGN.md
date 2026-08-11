# H2 插件隔离 —— 设计方案（Web Worker 沙箱 PoC 阶段，非全量迁移）

> 状态：**设计稿 + PoC P0/P1**（2026-08-11）。经用户拍板：H2 不做全量插件进程隔离迁移，
> 先完成本设计方案 + 单个低权限插件的 PoC，验证「启动 / 通信 / 超时 / 取消 / 崩溃 / 结果回传」
> 六项指标后再决定逐类迁移策略。
>
> **术语澄清（Codex 审计）**：Web Worker 是**线程级隔离**（独立 JS 堆/全局/DOM 无共享、可隔离
> UI 卡死与崩溃），**不是独立操作系统进程**。本方案是「Worker 沙箱 PoC」，不宣称进程隔离。
>
> 当前代码基线：main @ `15de1d1`（PoC P0）→ 本修订（PoC P1：能力白名单 / executionId 路由 / nodeId）。

---

## 1. 背景与目标

### 1.1 现状（S5 安全短板）

插件当前在主 WebView 内通过 **Blob URL + 动态 `import()`** 加载执行（`src/plugins/loader.ts:134`），
与宿主共享同一个 JS 运行时、DOM 权限与 WebView 进程。框架只靠「能力分级」做约定式约束：

- `CapabilityLevel`（`src/types.ts:519`）：compute / io / sandbox_write / coordinator / system。
- `applyCapability`（`src/engine/executorHelpers.ts:47`）在节点执行前**裁剪注入的 ctx**——但这是
  **API 层约束**：插件若在 `execute` 内直接调用平台能力（如 `window.fetch`、`@tauri-apps/*`），
  仍可绕过裁剪越界（`loader.ts:26` 注释自认）。

现有信任模型（`loader.ts:21-30`）：插件 = 用户显式安装的本地可信代码，类比 ComfyUI custom nodes。
**本设计不改变该信任模型**，而是把「本地可信」升级为「即使插件写坏/被攻破，也出不了沙箱」——
为未来支持「网络下载的第三方插件」铺路（`loader.ts:29` 明确此前提）。

### 1.2 目标

1. **Worker 级隔离**：插件执行与主 WebView 分开（独立 JS 堆/全局），崩溃/卡死不带走主应用。
2. **能力由宿主代理且结构性强制**：插件拿不到 `window` / `document` / `@tauri-apps`（Worker 内无 DOM 与
   IPC），需要的能力经宿主桥转发；**能力白名单在 worker 侧（只挂白名单方法键）与宿主侧（RPC 拦截）
   双重执行**——`applyCapability` 从「约定式」升级为「结构性」。
   **注意：Worker 原生自带 `fetch`（Codex 审计 P1）**——本方案**不隔离网络**；插件在沙箱内仍可
   `fetch()` 直连外网（绕过宿主能力代理）。网络隔离需要独立进程或显式屏蔽策略，见 §5.2。
3. **可观测**：日志 / 成本 / 取消 / 超时 / 崩溃均有明确事件回传宿主，且按节点归属（nodeId）。
4. **向后兼容**：现有 `executors` 函数式节点与「类式继承职业」写法不变，沙箱只是可选执行后端。

### 1.3 非目标（本阶段明确不做）

- 不做「网络下载第三方插件」的完整供应链。
- 不做把内置节点也搬进沙箱（内置节点信任度高、依赖 ctx 闭包深，收益低风险高）。
- 不引入 Deno/Bun/独立 Node runtime 作为插件运行时（§2 选型）。
- **不是操作系统进程隔离**：Worker 无法隔离「宿主进程被系统级恶意利用」的场景；若未来出现
  不受信任网络插件，需升级到独立进程（Node/Bun sidecar），协议层可复用（§3）。

---

## 2. 运行形态选型（用户要求明确的决策点）

| 维度 | A. Web Worker | B. Node 子进程 | C. Rust sidecar（内嵌 JS 引擎） |
|---|---|---|---|
| 隔离级别 | 线程级（独立 JS 栈/堆/全局，无 DOM/IPC） | 进程级（独立 PID/内存/崩溃域） | 进程级 |
| 是否已具备 | 浏览器/WebView 原生支持，零依赖 | 需打包 Node runtime（~30MB+，三平台） | 需集成 quickjs/deno_core |
| 主线程阻塞 | 阻塞可隔离（worker 卡死不影响 UI 渲染） | 完全隔离 | 完全隔离 |
| 打包体积影响 | 无 | 大（node.exe 或 Bun） | 中（wasm 引擎） |
| 能力代理复杂度 | 中（postMessage 双向） | 高（stdio/IPC + 序列化） | 高（Rust 侧桥 + JS 侧适配） |
| 崩溃恢复 | worker 可 `terminate()` + 重启 | 子进程可 kill + 重启 | 进程可重启 |
| 调试体验 | DevTools 原生支持 worker 面板 | 需额外工具 | 最差 |
| 浏览器端（无 Tauri）可用 | ✅ 天然可用 | ❌ | ❌ |

**结论：选 A. Web Worker（本阶段）**，理由：
1. 零依赖、零体积；桌面端（Tauri WebView）与浏览器预览行为一致。
2. worker 内无 `window`/`document`/`@tauri-apps` → 平台能力结构性不可达；**但标准 Worker 自带
   `fetch`**（Codex 审计 P1）——Worker 隔离 **DOM / JS 堆 / UI 卡死 / 平台 IPC**，**不隔离网络**。
3. 崩溃域：`onerror` + 宿主超时 → `terminate()` 重启，主应用不受影响（满足 PoC 崩溃隔离指标）。
4. 迁移成本最低：现有 `loader.ts` 把源码读成字符串 → 改为 `new Worker(url, {type:'module'})`。

> 若未来需真正进程级隔离，可基于同一份 RPC 协议（§3）把 worker 后端替换为 Node/Bun 子进程，
> 协议层保持不变——这是预留的升级路径。

---

## 3. 架构与 RPC 协议

### 3.1 总体结构

```
┌─────────────────────────── 主线程（宿主 / 现有引擎） ───────────────────────────┐
│  loader（扫描 manifest）→ 源码字符串                                            │
│  SandboxManager：按 pluginId 建立/复用 worker，注入能力代理（CapabilityProxy）     │
│  registryStore.defs[typeId].execute = 沙箱执行包装器                             │
│    （NodeDefinition 接口不变，内部转 postMessage）                               │
└───────────────▲───────────────────────────────────────────▲────────────────────┘
                │ ① execute { executionId, typeId, inputs, params, nodeId } │ ③ 能力请求（llm/storage/logger/…）
                │ ② result / error                            │ ④ 能力响应（含流式 onToken）
┌───────────────┴───────────────────────────────────────────┴────────────────────┐
│  Web Worker（沙箱内）                                                           │
│  sandbox-runtime.js（框架注入的引导脚本，非插件代码）                              │
│    - import() 插件入口（同 Blob URL 机制，但现在在 worker 作用域内）               │
│    - 收到 execute → 调用 def.execute(inputs, params, ctxProxy)                   │
│    - ctxProxy = 受限代理：只挂「当前 capability 白名单」内的方法键                   │
│      （越权方法 undefined → 插件调用即 TypeError，结构性越权不存在）                │
│    - signal = AbortSignal 由宿主 abort 消息驱动                                    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**关键点**：`NodeDefinition` 对外契约（`src/types.ts:521`）**完全不变**——引擎、画布、缓存、
增量执行逻辑零改动；只有 `loader.ts` 组装 `def.execute` 的环节换成「沙箱执行包装器」。

### 3.2 消息协议（JSON 序列化，双向）

所有消息带 `id`（请求-响应关联）。执行与能力请求均携带 `executionId`（每次 execute 唯一，
responder 路由键）与 `nodeId`（节点归属）。

```ts
// 宿主 → worker（HostToWorker）
type HostToWorker =
  | { kind: 'load-plugin'; pluginId: string; entryCode: string }
  | {
      kind: 'execute';
      id: string;                 // = executionId
      typeId: string;
      inputs: Record<string, unknown>;
      params: Record<string, unknown>;
      capability: CapabilityLevel;
      nodeId: string;             // owner ?? id
      vars: Record<string, unknown>;
      costLog: CostRecord[];
    }
  | { kind: 'capability:response'; id: string; ok: true; value: unknown }
  | { kind: 'capability:response'; id: string; ok: false; error: string }
  | { kind: 'abort'; runId: string }
  | { kind: 'terminate' };

// worker → 宿主（WorkerToHost）
type WorkerToHost =
  | { kind: 'ready'; pluginId: string }
  | { kind: 'load-error'; pluginId: string; error: string }
  | { kind: 'execute:result'; id: string; outputs: Record<string, unknown> }
  | { kind: 'execute:error'; id: string; error: string; stack?: string }
  | {
      kind: 'capability:request';
      id: string;                 // 能力请求 id（worker 内生成）
      executionId: string;        // 所属 execute，宿主据此路由 responder
      method: CapabilityMethod;
      args: unknown[];
      nodeId: string;
    }
  | { kind: 'log'; level: 'info'|'warn'|'error'; message: string; nodeId: string }
  | { kind: 'cost'; record: CostRecord; nodeId: string }
  | { kind: 'partial'; key: string; value: unknown; nodeId: string }
  | { kind: 'heartbeat'; runId: string };
```

### 3.3 能力白名单（结构性强制，Codex P0 修复）

`CAPABILITY_WHITELIST`（`protocol.ts`）按 `CapabilityLevel` 定义允许的方法集合，与
`executorHelpers.applyCapability` 的裁剪语义对齐：

| 等级 | 允许能力 |
|---|---|
| compute | logger / reportCost / setPartial / setBranches（+ vars/costLog/signal 快照） |
| io | + llm / storage.get·set / addAsset / writeOutEdgeScope |
| sandbox_write | + sandbox.writeFile/readFrom/list（剥离 commitAll/commitLanes） |
| coordinator / system | + sandbox.commitAll/commitLanes / intervene |

**双重执行**：
1. **worker 侧**：`runtime.ts makeCtx()` 只挂白名单内的方法键；越权键 `undefined` →
   插件调用即 `TypeError`（越权通道不存在）。
2. **宿主侧**：`SandboxManager.onWorkerMessage` 收到 `capability:request` 时，先按当前 execute 的
   `capability` 校验方法是否在白名单，越权直接回错误回包（即使 worker 侧被绕过）。

### 3.4 Responder 路由（Codex P0 修复：并发竞态）

- responder **按 `executionId` 注册**（`registerResponder(executionId, responder)`），非 `pluginId`
  单例——同插件不同节点并发执行时互不覆盖。
- worker 的 `capability:request` 带 `executionId`，宿主据此路由到正确的 responder。
- `createSandboxedNodeExecute` 每次执行生成唯一 `executionId`，try/finally 注销。

### 3.5 流式（onToken / setPartial）

- `llm.onToken`：PoC 阶段非流式（`llm` 消息不传 onToken）；P1 规划 `llm:onToken` 流式消息。
- `setPartial`：`{ kind:'partial'; key; value; nodeId }` 直接转发节点实时输出。

---

## 4. 生命周期：超时 / 取消 / 崩溃隔离

### 4.1 超时

- 每个 `execute` 宿主侧挂超时（默认 `PLUGIN_TIMEOUT_MS = 60_000`，可经 `RunOptions` 覆写）。
- 超时后：`terminate()` 当前 worker（避免僵尸协程）→ 重新 `new Worker`（恢复就绪态）→
  该节点标记失败，错误信息「插件执行超时」。不中断整个运行（沿用 `skipFailed` 语义）。

### 4.2 取消（与现有 `currentRunId` 代次机制对齐）

- 宿主 `stopWorkflow()` 已递增 `gen.currentRunId`；沙箱包装器在代次过期时发 `{ kind:'abort'; runId }`。
- worker 内 `AbortController` 收到 abort → `controller.abort()` → 节点 `ctx.signal` 立即触发。

### 4.3 崩溃检测与恢复

- 三类崩溃源：① worker 抛未捕获异常 → `onerror`；② 死循环/卡死 → 心跳丢失；③ 宿主 terminate。
- 恢复：`SandboxManager` 按 pluginId 维护 worker 池，崩溃后自动重建；正在执行节点标记失败。

### 4.4 资源归属

- worker 按 `pluginId` 复用；`runId` 区分代次。应用卸载插件 / 关闭项目 → `terminateAll()`。

---

## 5. 权限模型（结构性强制）

Worker 沙箱内**无** `window`/`document`/`@tauri-apps` 全局（WebView2 worker 无 DOM 与 IPC），
`applyCapability` 的「裁剪」从「替换为拒绝型实现」升级为**「根本不提供」**：

- worker 侧 ctx 代理只含该等级白名单内的方法键；越权方法 `undefined` → 调用即 TypeError。
- 宿主侧 `SandboxManager` 再按等级白名单拦截 RPC——**即使 worker 侧被绕过，宿主仍拒绝**。
- **`fetch` 例外（Codex 审计 P1）**：标准 Web Worker 原生自带 `fetch`，本方案**默认不屏蔽**——
  见 §5.2 网络权限产品决策。

### 5.2 网络权限产品决策（Codex 审计 P1）

**事实**：Web Worker 原生提供 `fetch`。恶意插件可在沙箱内直接联网（绕过宿主能力代理），
因此本方案**不提供网络能力隔离**，不应宣称「完整安全沙箱」。

产品决策（当前信任模型=本地可信插件，沿用 §1.1）：

| 方案 | 适用场景 | 代价 |
|---|---|---|
| **A. 接受网络直连**（当前默认） | 插件是用户显式安装的本地可信代码；`io` 级插件本身就需要联网（http 节点等） | 无网络隔离承诺；文档/UI 明确提示 |
| **B. Worker 内屏蔽 fetch** | 仅要求「UI/DOM/Tauri IPC 隔离 + 插件不许直连外网」 | 合法网络节点（http/LLM 直连）也会失效——必须全部改走宿主 `ctx.llm`/`httpFetch` 代理 |
| **C. 独立进程/sidecar** | 必须「不可信插件不可直接联网」 | 引入 Node/Bun 运行时（~30MB+ 三平台）、打包/调试成本高 |

**当前实施**：方案 A。`runtime.ts` 不屏蔽 `self.fetch`；`ctx` 能力白名单不含 `httpFetch`（插件网络能力走
原生 fetch 或宿主 `llm` 代理）。若未来要求「不可信插件」，切方案 B（worker 引导脚本置 `self.fetch=undefined`，
合法网络节点改走宿主代理）或方案 C（协议层 §3.2 复用，更换 worker 后端为独立进程）。

manifest 无需改动（`minCapability`/`extends` 语义沿用），预留可选字段（PoC 阶段不做）：

```jsonc
// manifest.json（预留，不强制）
"sandbox": {
  "timeoutMs": 30000,       // 覆盖默认超时
  "heartbeatMs": 5000,      // 覆盖默认心跳
  "requireSandbox": true,   // 强制该插件必须沙箱运行，禁止回退主线程
  "noNetwork": true         // 方案 B 预留：屏蔽 worker 内 fetch（需合法网络节点走宿主代理）
}
```

---

## 6. PoC 方案

### 6.1 选型

**`plugin-examples/word-counter`**（纯文本统计：字符/词/行 + `prefix` 参数 → `report` 输出）。
选它理由：
- 低权限（默认 compute，无 llm/storage/sandbox），符合「低权限纯文本转换节点」要求。
- 覆盖三类数据通道：`inputs`（text）、`params`（prefix）、`outputs`（report）——可完整验证 RPC 序列化。
- 无副作用，可确定性断言结果（「统计结果：共 N 个字符…」）。

### 6.2 PoC 里程碑与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 最小沙箱加载器** ✅ | `SandboxManager` + `sandbox-runtime`；协议消息封装 execute | 单测：加载/执行/结果/错误/超时/崩溃/取消/并发限制/terminateAll |
| **P1 能力代理 + 白名单** ✅ | `execContextResponder` 接 logger/llm/storage；`CAPABILITY_WHITELIST` worker+宿主双侧强制；responder 按 executionId 路由；nodeId 全链路传入 | 单测：能力代理/白名单拦截（compute 拒 llm、io 拒 sandbox）/并发 responder 不覆盖/execute 携带 nodeId |
| **P2 韧性注入** ⏳ | 死循环插件 + 抛错插件 + 永不返回插件 | 超时→terminate→失败标记；崩溃→onerror→重建；取消→abort→静默退出 |
| **P3 GUI 集成** ⏳ | loader 接入沙箱分支；插件面板「沙箱运行」开关（viewStore）；word-counter 端到端 | GUI：加载 word-counter 沙箱节点→拖入→运行→结果正确 |

### 6.3 迁移策略（PoC 通过后）

- 低风险先迁：全部 `compute`/`io` 级函数式插件（word-counter、math-sum、常见工具类）。
- 暂缓迁移：依赖深 ctx 闭包的类式继承节点（`sandbox_write`/`coordinator`/`system`）——
  需先验证 sandbox/intervene 两条能力代理链路，再逐类放行。
- 内置节点：不迁（§1.3）。

---

## 7. 风险与回退

| 风险 | 影响 | 缓解 |
|---|---|---|
| WebView2 worker 对 Blob URL `import()` 的限制 | 插件入口可能在 worker 内无法动态 import | PoC P0 先行验证；若受限改用 `importScripts`（需插件非 ESM）或宿主拼接单文件 |
| 序列化边界（`inputs` 含函数/循环引用） | postMessage 结构化克隆抛错 | 沿用现有 `collectInputs` 产出（引擎侧已是可序列化值）；出错即节点失败并提示 |
| 流式/接管在沙箱下的时延 | onToken 每条消息往返 | PoC 阶段接受；若慢再合并 chunk |
| 行为回归 | 现有主线程加载路径仍保留 | 沙箱开关默认**关**，仅当启用时走新后端；两后端单测并行 |

**回退**：`SandboxManager` 开关置 false 即完全回到现有 Blob URL import 路径（`loader.ts` 原逻辑
保留，沙箱只是可选执行后端）。

---

## 8. 文件落点（PoC 现状）

```
src/plugins/sandbox/
  SandboxManager.ts     # worker 池 + 生命周期 + 超时/崩溃/取消 + 能力代理（白名单拦截 + executionId 路由）
  sandbox-runtime.ts    # worker 内引导脚本（import 插件 + 白名单 ctx 代理 + 消息循环）
  protocol.ts           # §3.2 消息类型 + CAPABILITY_WHITELIST + isCapabilityAllowed
  SandboxManager.test.ts # 12 单测（P0 协议链路 + P1 白名单/responder 路由/nodeId）
src/types.ts            # ExecContext 新增 nodeId? 字段
src/engine/executor.ts  # ctx 构造注入 nodeId: owner ?? id
src/plugins/loader.ts   # 沙箱分支（P3 接入，未做）
src/store/viewStore.ts  # pluginSandbox: boolean 偏好（P3）
src/components/PluginPanel.tsx  # 沙箱开关（P3）
```

---

## 9. Codex 审计记录（2026-08-11）

### 9.1 P0 不可作为安全基线，须修三点（已全部修复）

1. **能力白名单未真正执行** → 新增 `CAPABILITY_WHITELIST`（protocol.ts）；worker 侧 `makeCtx`
   只挂白名单方法键（越权 `undefined`）；宿主侧 `onWorkerMessage` 按等级拦截越权 RPC。
2. **同插件并发 responder 竞态** → responder 从 `pluginId` 单例改为按 `executionId` 注册/路由；
   新增测试验证「同插件两 executionId 并发互不覆盖」。
3. **nodeId 未真正传入 execute** → `ExecContext` 加 `nodeId`（executor 填 `owner ?? id`）；
   execute 消息与 capability:request/log/cost/partial 均携带 nodeId；测试断言 execute 消息含 nodeId。

### 9.2 术语澄清

- Web Worker 是**线程级隔离**，非操作系统进程隔离。文档标题/内容已明确为「Worker 沙箱 PoC」。
- 若未来需要真实进程隔离（不受信任网络插件），协议层（§3.2）可复用，仅更换 worker 后端。

### 9.3 第二轮审计（2026-08-11，commit 4718ff2 之后）

Codex 结论：P0 质量从「存在明显缺口」提升为「PoC 基础可靠」，但安全承诺须降级表述。
已处理：

1. **P1：Worker 可用 fetch，非网络隔离** → 修正 §1.2/§2/§5 三处错误声明（「fetch 不存在」→
   「fetch 存在但不代理」）；新增 §5.2 网络权限产品决策（当前=方案 A 接受直连，文档/UI 明示；
   未来不可信插件切方案 B 屏蔽 fetch 或方案 C 独立进程）。
2. **P1：未接入真实插件加载链路** → `loadPluginFromSource` 新增 `options.sandbox`；沙箱开启时用
   `createSandboxedNodeExecute` 包装 execute；`viewStore` 新增 `pluginSandbox` 偏好；`pluginManager`
   三处扫描/导入调用透传开关。word-counter 等真实插件可在 GUI 验证 Worker 加载执行。
3. **P2：白名单双份复制漂移** → 删除 runtime 内 WHITELIST 复制；宿主 `allowedMethodsFor(level)`
   生成列表随 execute 消息下发，worker 只消费 `execMsg.allowedMethods`。单一真相源=protocol.ts。

### 9.4 第三轮审计（2026-08-11，commit ec0058f 之后）——P0 阻断项修复

Codex 结论：发现**新的 P0 阻断**——`sandbox: true` 时 loader 仍先在主 WebView 经 Blob `import()`
执行完整 entryCode（读取 executors/类导出），之后才把同一源码交给 Worker 再 import 一次。
**恶意插件顶层代码已在宿主线程（DOM/Tauri IPC 权限）运行过一次**，Worker 只隔离 execute()，
不构成「插件加载隔离」。

**修复（commit 待发）**：
- `sandbox: true` 时**禁止主线程 import(entryCode)**：不解析 executors/类导出；节点定义完全由
  manifest 构造；execute 直接是 Worker 包装器；fallback（无 Worker 环境）改为**报错**而非回退
  主线程——保持「不预执行」承诺。
- Worker 内自行 `import()` 入口并验证 `executors[typeId]` 存在；缺失经 RPC `execute:error` 报错。
- **类式插件（extends 声明）沙箱模式明确拒绝**（顶层类定义/原型链校验需主线程解析，与
  「不预执行」冲突），报「类式插件暂不支持沙箱模式，后续单独设计」。
- 新增 `loader.sandbox.test.ts` 3 用例：① 函数式插件沙箱加载成功且不预执行（若误走主线程
  import，jsdom 下 Blob import 会抛错，测试即失败）；② 类式插件沙箱拒绝；③ 默认（非沙箱）路径
  与沙箱路径行为差异。

### 9.5 P2 韧性注入 + P3 GUI 端到端（已完成）

- **P2 韧性注入 ✅**：新增心跳探针机制（`ping`/`heartbeat` 消息 + `HEARTBEAT_INTERVAL_MS`/
  `HEARTBEAT_MISS_THRESHOLD` 可配置）——execute 期间周期 ping，连续丢失心跳判死
  terminate + 重建（死循环/卡死检测，不再只靠 60s execute 超时兜底）。测试 +2：
  ① worker 不回复心跳 → 判死 reject + 重建；② 健康 worker 自动回心跳不被误杀。
  此前已覆盖：execute 超时→terminate+重建、worker onerror 崩溃→重建、signal abort 取消、
  并发限制、terminateAll。
- **P3 GUI 端到端 ✅**：word-counter 复制至 AppData/plugins，GUI 验收通过（扫描→加载→拖入→
  执行→结果回传；勾选沙箱后重新扫描同样正常，logger.info 转发显示）。
- **已知限制**：pluginSandbox 开关只影响「重新扫描/重新导入」后的插件，不迁移已加载插件；
  权限声明仍来自插件 manifest（未来「不可信插件」需改为宿主侧授权策略，见 §5.2）。

---

*生成日期：2026-08-11 · 基线 main @ 15de1d1（P0）→ 4718ff2（P1 三项）→ ec0058f（P1 两项+P2 一项）→
本修订（第三轮 P0 主线程预执行修复）· 本文档为设计稿，PoC 验证后按实际修正*
