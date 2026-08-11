# H2 插件进程隔离 —— 设计方案（设计与 PoC 阶段，非全量迁移）

> 状态：**设计稿**（2026-08-11）。经用户拍板：H2 不做全量插件进程隔离迁移，先完成
> 本设计方案 + 单个低权限插件的 PoC，验证「启动 / 通信 / 超时 / 取消 / 崩溃 / 结果回传」
> 六项指标后再决定逐类迁移策略。当前代码基线：main @ `daf4b40`。

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

1. **进程/线程级隔离**：插件执行不再与主 WebView 同栈，崩溃不带走主应用。
2. **能力由宿主代理**：插件拿不到 `window` / `@tauri-apps` / `fetch`，一切能力经宿主桥转发，
   `applyCapability` 从「约定式」升级为「结构性」——沙箱内根本不存在越权通道。
3. **可观测**：日志 / 成本 / 取消 / 超时 / 崩溃均有明确事件回传宿主。
4. **向后兼容**：现有 `executors` 函数式节点与「类式继承职业」写法不变，只是执行后端可切换。

### 1.3 非目标（本阶段明确不做）

- 不做「网络下载第三方插件」的完整供应链。
- 不做把内置节点也搬进沙箱（内置节点信任度高、依赖 ctx 闭包深，收益低风险高）。
- 不引入 Deno/Bun/独立 Node runtime 作为插件运行时（见 §2 选型）。

---

## 2. 运行形态选型（用户要求明确的决策点）

| 维度 | A. Web Worker | B. Node 子进程 | C. Rust sidecar（内嵌 JS 引擎） |
|---|---|---|---|
| 隔离级别 | 线程级（同一 WebView 进程，独立 JS 栈/堆/全局） | 进程级（独立 PID/内存/崩溃域） | 进程级 |
| 是否已具备 | 浏览器/WebView 原生支持，零依赖 | 需打包 Node runtime（~30MB+，三平台） | 需集成 quickjs/deno_core |
| 主线程阻塞 | 阻塞可隔离（worker 卡死不影响 UI 渲染） | 完全隔离 | 完全隔离 |
| 打包体积影响 | 无 | 大（node.exe 或 Bun） | 中（wasm 引擎） |
| 能力代理复杂度 | 中（postMessage 双向） | 高（stdio/IPC + 序列化） | 高（Rust 侧桥 + JS 侧适配） |
| 崩溃恢复 | worker 可 `terminate()` + 重启 | 子进程可 kill + 重启 | 进程可重启 |
| 调试体验 | DevTools 原生支持 worker 面板 | 需额外工具 | 最差 |
| 浏览器端（无 Tauri）可用 | ✅ 天然可用 | ❌ | ❌ |

**结论：选 A. Web Worker。**

理由：
1. **零依赖、零体积**：不引入新运行时，桌面端（Tauri WebView）与浏览器预览（`npm run dev`）行为一致。
2. **隔离足够**：worker 与主线程共享进程但**不共享 JS 全局、DOM、内存**；worker 内 `window`/`document`
   `fetch`/`@tauri-apps` 均不可用（WebView2 的 worker 无 DOM 与 IPC），天然满足「结构性无越权通道」。
3. **崩溃域**：worker 抛未捕获异常/死循环 → `onerror` + 宿主心跳超时 → 宿主 `terminate()` 重启，
   主应用不受影响。这满足 PoC 六项指标里的「崩溃隔离」。
4. **迁移成本最低**：现有 `loader.ts` 把源码读成字符串 → 我们只需把「Blob URL 供 import」改为
   「Blob URL 供 `new Worker(url, {type:'module'})`」，加载链路的目录扫描/manifest 校验不变。

> 若未来某类插件需要真正进程级隔离（如不受信任的网络插件），可基于同一份协议把 worker 后端
> 替换为 Node/Bun 子进程——RPC 协议层保持不变（§3），这是本设计预留的升级路径。

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
                │ ① execute { id, typeId, inputs, params }    │ ③ 能力请求（llm/storage/logger/…）
                │ ② result / error                            │ ④ 能力响应（含流式 onToken）
┌───────────────┴───────────────────────────────────────────┴────────────────────┐
│  Web Worker（沙箱内）                                                           │
│  sandbox-runtime.js（框架注入的引导脚本，非插件代码）                              │
│    - import() 插件入口（同 Blob URL 机制，但现在在 worker 作用域内）               │
│    - 收到 execute → 调用 def.execute(inputs, params, ctxProxy)                   │
│    - ctxProxy = 一个「把每个能力调用转成 postMessage 并 await 响应」的代理对象       │
│    - signal = AbortSignal 由宿主 abort 消息驱动                                    │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**关键点**：`NodeDefinition` 对外契约（`src/types.ts:521`）**完全不变**——引擎、画布、缓存、
增量执行逻辑零改动；只有 `loader.ts` 组装 `def.execute` 的环节换成「沙箱执行包装器」。

### 3.2 消息协议（JSON 序列化，双向）

所有消息带 `id`（请求-响应关联）与 `pluginId`/`runId`（资源归属）。

```ts
// 宿主 → worker
type HostToWorker =
  | { kind: 'execute'; id: string; typeId: string; inputs: Record<string, unknown>; params: Record<string, unknown>; capability: CapabilityLevel }
  | { kind: 'capability:response'; id: string; ok: true; value: unknown }
  | { kind: 'capability:response'; id: string; ok: false; error: string }
  | { kind: 'abort'; runId: string }        // 取消本次运行：worker 内部 signal.abort()
  | { kind: 'terminate' };                  // 强制销毁 worker（崩溃/超时兜底）

// worker → 宿主
type WorkerToHost =
  | { kind: 'ready'; pluginId: string }
  | { kind: 'execute:result'; id: string; outputs: Record<string, unknown> }
  | { kind: 'execute:error'; id: string; error: string; stack?: string }
  | { kind: 'capability:request'; id: string; method: CapabilityMethod; args: unknown[] }
  | { kind: 'log'; level: 'info'|'warn'|'error'; message: string }
  | { kind: 'cost'; record: CostRecord }    // reportCost 转发
  | { kind: 'partial'; key: string; value: unknown }  // setPartial 转发
  | { kind: 'heartbeat'; runId: string };   // 心跳（可配置间隔，超时判死）
```

`CapabilityMethod` 枚举（对应 `ExecContext` 13 项，逐项映射）：

| 方法 | 参数 | 宿主实现 | 沙箱内可见性 |
|---|---|---|---|
| `logger.info/warn/error` | `(message)` | 直接 `addLog` | 始终 |
| `vars` | 读 | 宿主读 `useWorkflowStore.getState().variables` | 始终 |
| `signal` | 读 | 见 §4 取消 | 始终 |
| `costLog` | 读 | 宿主传入快照 | 始终 |
| `reportCost` | `(record)` | 转发 `useWorkflowStore` 成本账本 | 始终 |
| `setPartial` | `(key, value)` | 转发节点实时预览 | 始终 |
| `setBranches` | `(handles)` | 转发分支登记 | 始终 |
| `llm` | `(agentId, messages, onToken?, modelOverride?, toolNames?)` | 宿主 `chatWithAgent`；onToken 用流式消息回传 | io+ |
| `storage.get/set` | `(key, value)` | 宿主 credential/storage 层 | io+ |
| `assets` / `addAsset` | — | 宿主资产库 | io+ |
| `writeOutEdgeScope` | `(handle, scope)` | 宿主边写回 | io+ |
| `sandbox.*` | — | 宿主沙箱句柄代理 | sandbox_write+ |
| `intervene` | `(request)` | 宿主接管面板 | 显式调用 |

### 3.3 流式（onToken / setPartial）

- `llm.onToken`：宿主侧 `chatWithAgent` 每次 token 回调 → `capability:response` 变体
  `{ kind:'stream'; id; chunk }` → worker 内 `onToken(chunk)`。
- `setPartial`：`{ kind:'partial' }` 直接转发节点实时输出。

---

## 4. 生命周期：超时 / 取消 / 崩溃隔离

### 4.1 超时

- 每个 `execute` 请求宿主侧挂超时（默认 `PLUGIN_TIMEOUT_MS = 60_000`，可经 `RunOptions` 覆写）。
- 超时后：`terminate()` 当前 worker（避免僵尸协程）→ 重新 `new Worker`（恢复就绪态）→
  把该节点标记失败，错误信息「插件执行超时（60s）」。不中断整个运行（沿用 `skipFailed` 语义）。

### 4.2 取消（与现有 `currentRunId` 代次机制对齐）

- 宿主 `stopWorkflow()` 已递增 `gen.currentRunId`；沙箱包装器在收到代次过期信号时，
  向 worker 发 `{ kind:'abort'; runId }`。
- worker 内 `sandbox-runtime.js` 维护 `AbortController`，收到 abort → `controller.abort()` →
  节点 `ctx.signal` 立即触发（与现有节点 `signal.aborted` 检查一致，见 executor 代次守卫）。

### 4.3 崩溃检测与恢复

- 三类崩溃源：
  1. worker 抛未捕获异常 → `worker.onerror`（错误堆栈回传宿主日志）。
  2. worker 内部死循环 / 卡死 → 心跳丢失（heartbeat 间隔 5s，3 连丢判死）。
  3. worker 被宿主 terminate（超时/停止兜底）。
- 恢复策略：`SandboxManager` 维护「每 pluginId 一个 worker」的池，崩溃后自动重建；
  正在执行的节点标记失败（错误含崩溃原因），其余等待该 worker 的节点重排/标记失败。

### 4.4 资源归属

- worker 按 `pluginId` 复用（同一插件多次运行不重复 spawn）；`runId` 用于区分代次。
- 应用卸载插件 / 关闭项目：`SandboxManager.terminateAll()`（配合现有 `unloadProjectCustomNodes`）。

---

## 5. 权限模型（结构性强制）

沙箱内**不存在** `window`/`document`/`fetch`/`@tauri-apps` 全局（WebView2 worker 无 DOM 与 IPC），
因此 `applyCapability` 的「裁剪」从「替换为拒绝型实现」升级为**「根本不提供」**：

- 宿主侧 `CapabilityProxy` 仍按 `CapabilityLevel` 决定**哪些能力方法可被转发**（对齐
  `applyCapability` 的等级语义：compute 不发 llm/storage/sandbox 请求）。
- worker 侧 ctx 代理只含该等级白名单内的方法键；越权方法 `undefined`，节点调用即
  `TypeError`——这是「结构性」而非「约定式」的（越权通道不存在）。

manifest 无需改动（`minCapability`/`extends` 语义沿用），但新增可选字段（PoC 阶段不做，
设计预留）：

```jsonc
// manifest.json（预留，不强制）
"sandbox": {
  "timeoutMs": 30000,       // 覆盖默认超时
  "heartbeatMs": 5000,      // 覆盖默认心跳
  "requireSandbox": true    // 强制该插件必须沙箱运行，禁止回退主线程
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
| **P0 最小沙箱加载器** | `src/plugins/sandbox/` 新建：`SandboxManager.ts` + `sandbox-runtime.ts`；把 `loadPluginFromSource` 的执行段替换为「new Worker + execute 消息」；`registryStore` 注册沙箱节点 | headless 或单测：word-counter 沙箱执行返回正确 report |
| **P1 能力代理** | `CapabilityProxy` 接通 logger / llm / storage / setPartial（至少 llm 一条走宿主转发） | 单测：mock 宿主 llm 返回，节点拿到正确文本 |
| **P2 韧性注入** | 造一个死循环插件 + 一个抛错插件 + 一个永不返回插件 | 超时→terminate→节点失败标记；崩溃→onerror→worker 重建；取消→abort→节点静默退出 |
| **P3 GUI 集成** | 插件面板新增「沙箱运行」开关（`viewStore` 偏好）；沙箱插件与主线程插件可切换 | GUI：加载 word-counter 沙箱节点→拖入→运行→结果正确 |

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

## 8. 文件落点（PoC 规划）

```
src/plugins/sandbox/
  SandboxManager.ts     # worker 池 + 生命周期 + 超时/崩溃/取消 + 能力代理
  sandbox-runtime.ts    # worker 内引导脚本（import 插件 + ctx 代理 + 消息循环）
  protocol.ts           # §3.2 消息类型定义 + CapabilityMethod 枚举
src/plugins/loader.ts   # 增加 sandbox 分支（保留原 import 路径）
src/store/viewStore.ts  # pluginSandbox: boolean 偏好（P3）
src/components/PluginPanel.tsx  # 沙箱开关（P3）
src/plugins/sandbox/*.test.ts   # P0-P2 单测
```

---

*生成日期：2026-08-11 · 基线 main @ daf4b40 · 本文档为设计稿，PoC 验证后按实际修正*
