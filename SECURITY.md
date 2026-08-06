# 安全模型与已知缺口（SECURITY）

> 维护说明：本文件记录 SlimeMold 的安全边界设计、已落地的防护机制，以及经外部评审（Codex 架构评审，2026-08-07）确认、尚未实施的缺口。
> 配套工程进度见 `TODO.md`（步骤 13 为插件能力分级主体，步骤 15 为编译债务清理）。

---

## 〇、信任模型（核心定位）

SlimeMold 是**本地桌面 Agent 工作流编辑器**（Tauri 2 + React + Vite）。它的「用户自己安装的插件 / 自定义节点」与 ComfyUI 的 custom nodes 同一性质：

- **插件 = 用户显式安装、本地运行的代码**，不是从网络下载的不可信第三方。
- 因此当前架构**不把插件当敌人**，而是「可信本地代码」——但必须明确边界，避免后续误把不可信来源当可信加载。

**铁律**：
1. API Key 永不明文进工作流文件 / 永不入 git / 永不明文睡在 config。
2. 桌面端只认 `credentialKey`，运行时由 Rust 从系统密钥库取回内存喂给 provider。
3. 插件运行于主 WebView 进程，视为可信本地代码；一旦引入「从网络下载插件」能力，必须升级为进程级沙箱（见 §四 P1）。

---

## 一、已落地的防护机制

### 1.1 凭据分层（已实现）
- 工作流文件仅持久化 `credentialKey`（`src/io/workflowIO.ts:40` 导出时剥离 `apiKey`）。
- 接入点（Endpoint，含 baseUrl + apiKey）落 `AppData/com.slimemold/endpoints.json`，其中 apiKey 用 **AES-GCM** 加密（主密钥存系统密钥库 `___sm_master_key___`），磁盘无明文。
- 桌面端凭据经系统密钥库（Windows Credential Manager / macOS Keychain / Linux secret-service）。
- headless 场景允许明文 `apiKey`（与桌面密钥库链路区分，用于无 UI 调试）。

### 1.2 插件能力分级 + 继承式提权（已实现，见 TODO 步骤 13）
- `CapabilityLevel = compute | io | sandbox_write | coordinator | system`（`src/types.ts`）。
- `executor.applyCapability(ctx, def, opts)`（`src/engine/executor.ts:124`）按等级裁剪注入：`compute` 禁 llm/storage/sandbox；`io` 禁 sandbox；`sandbox_write` 剥离 `commitAll/commitLanes`；`coordinator/system` 全权限。
- 提权走「继承职业父类」（`src/nodes/sdk.ts`）：写 `executors` 函数 = 裸 `Node`（基础能力，无法越权）；继承 `SandboxWriteNode`/`CoordinatorNode`/`SystemNode` 才获得对应能力。
- `loader.validateManifest` 硬校验：`extends` 只可引用框架职业或本包 `occupations`；仅靠 `minCapability` 声明越权但缺 `extends` 会被拒绝加载（杜绝「配置文件后门」，阶段 C 修复过一处条件写反的真实 bug）。
- 插件节点默认 `io` 级（`loader` 注入，避免第三方越权拿落地权）。

> **结论**：插件能力裁剪是「API 层约束」，不是进程级沙箱。对可信本地代码足够；对不可信代码不够（见 §四）。

---

## 二、已核实的安全缺口（外部评审 2026-08-07）

以下事实均已用 `grep` / 读文件核实，非推测：

| # | 缺口 | 位置 | 风险 |
|---|---|---|---|
| S1 | `csp: null`（未配置内容安全策略） | `src-tauri/tauri.conf.json:24` | 动态插件 + 网络请求下，缺少基线 CSP 防护 |
| S2 | capabilities `path: "**"` 偏宽 | `src-tauri/capabilities/default.json:32,38` | 插件/节点可读写任意路径 |
| S3 | HTTP 允许 `http://*` / `https://*` 全放开 | `src-tauri/capabilities/default.json:11-18` | 任意外联，含非预期域名 |
| S4 | `run_git(args: Vec<String>, cwd: Option<String>)` 收任意参数 + 任意 cwd | `src-tauri/src/lib.rs:226` | 缺 cwd 边界与子命令白名单，破坏性 git 命令可被调 |
| S5 | 插件经 Blob URL + `dynamic import()` 跑在主 WebView | `src/plugins/loader.ts` | 非进程级沙箱，capability 仅为 API 层约束；恶意插件可触 WebView 全局对象 / 读 localStorage / 读运行时解密后的 key。✅ 已声明信任模型（2026-08-07）：`loader.ts` 注释 + `README.md`「插件安全与信任模型」，明确仅加载本机来源、网络插件需隔离 |
| S6 | 凭据运行期仍出现在 WebView JS 内存 | `AgentConfig.apiKey` → provider | 普通本地应用可接受；但与插件同进程，须把插件当可信。✅ 已文档化分层模型（2026-08-07）：`docs/credentials.md` 写明桌面端走密钥库+`endpoints.json`(AES-GCM)、headless 走环境变量、工作流文件仅存 `credentialKey` |
| S7 | pipeline 定义为模块级 `Map` | `src/engine/pipeline.ts` | ✅ 已持久化（2026-08-07）：`pipelineDefs` 模块级 Map 改为存于 `workflowStore.pipelines`（项目态），随 `.slimemold` 序列化进 `ProjectFile.pipelines` + partialize 白名单 + DIRTY_KEYS，重启不丢；`types.ts` 加 `ProjectFile.pipelines?: PipelineDef[]` |
| S8 | 文档漂移：RUN_VERIFICATION.md 曾称 Anthropic 为缺口 | `docs/RUN_VERIFICATION.md` | ✅ 已修复（2026-08-07）：`providers/anthropic.ts` 实现 `/v1/messages`+SSE，`RUN_VERIFICATION.md` 已更正 |
| S9 | `llmChannel.ts` 的 `BackendChannel` 误导注释 | `src/agents/llmChannel.ts` | ✅ 已清理（2026-08-07）：路线 A 下 backend/frontend 均走前端 provider，已合并实现并修正注释；路线 B 搁置 |

---

## 三、待实施（优先级）

### P0 —— 低成本、高收益（✅ 已全部完成，2026-08-07，commit d48401e）
- [x] **S1 CSP**：`tauri.conf.json` 已配 CSP（self-only + 允许的 LLM/asset 域），替代 `null`。
- [x] **S2 capabilities 收窄**：`path: "**"` → 限定 `$APPDATA/$HOME/$DOCUMENT/$RESOURCE` + 项目目录 `D:/Agent proj/**`；fs 权限按实际所需最小集。
- [x] **S3 HTTP 收窄**：收敛到 `https://*/*` + 本地 Ollama（`http://127.0.0.1:11434/*`）。
- [x] **S4 run_git 约束**：校验 `cwd` 必填 + 存在性 + `..` 逃逸；子命令白名单；拒绝破坏性命令（reset/clean/rm/push）与危险 flag（--hard/--force/-f/--delete/-D）。

### P1 —— 信任模型与文档
- [x] **S5 信任声明**：✅ 已在 `loader.ts` 注释 + `README.md`「插件安全与信任模型」明确「插件运行于主 WebView，视为可信本地代码；仅加载本机来源；网络插件需升级进程级沙箱」（2026-08-07）。
- [x] **S6 凭据分层文档化**：✅ 已创建 `docs/credentials.md`，写明「桌面端走系统密钥库+`endpoints.json`(AES-GCM 加密)；headless 走环境变量/明文（与桌面链路隔离）；工作流文件导出剥离明文 apiKey、仅存 `credentialKey`」（2026-08-07）。
- [x] **S8 修文档漂移**：`RUN_VERIFICATION.md` 删 Anthropic 缺口描述，补 `anthropic.ts` 已实现 `/v1/messages`+SSE 的事实（2026-08-07）。
- [x] **S9 清理** `BackendChannel`：路线 A 下 backend/frontend 均走前端 provider，已合并实现并修正注释；路线 B 搁置（2026-08-07）。

### P2 —— 工程化（长期，不影响功能）
- [x] **S7 Pipeline 持久化**：✅ 已完成（2026-08-07，commit 5506b19）：`pipelineDefs` 模块级 Map 改为存 `workflowStore.pipelines`（项目态），随 `.slimemold` 序列化进 `ProjectFile.pipelines` + partialize 白名单 + DIRTY_KEYS，重启不丢。
- [x] **测试体系（地基已立，2026-08-07）**：新增 `vitest.config.ts`(jsdom 环境) + `vitest.setup.ts`(polyfill matchMedia/ResizeObserver/structuredClone) + `@types/node`/`jsdom` devDependency + `package.json` 的 `test`/`test:watch` 脚本。已覆盖纯/近纯模块单测 **162 项全通过**：`topoSort`、`expr`、`rateLimiter`、`nodeCache`、`subgraph`(展开/端口推断/跨边界连线重定向/循环引用)、`pipeline`(定义/黑板/advance 正向传播/rework 回流)、`executor`(collectInputs 汇集/resolveCapability 分级/applyCapability 裁剪/getActiveRunId 代次)、`graphAlgo`(纯图算法内核)、`runtime`(执行引擎与 store 的解耦接缝 ExecutionRuntime 接口契约)。`npm run test` 可回归运行。
- [x] **CI（GitHub Actions，2026-08-07）**：`.github/workflows/ci.yml` 在 push/PR 到 main 时跑 `tsc -b --noEmit` + `npm run test`(Vitest) + `npm run headless examples/headless-demo.json`(纯本地节点冒烟，免 API Key)。修复了 headless 在纯 node 下跑不通的两处缺陷：`src/i18n/index.ts` 的 `import.meta.glob` 非 Vite 环境安全降级为空对象；根 `tsconfig.json` 补 `@/*` 别名让 `tsx` 能解析路径。
- [ ] 测试体系（扩面）：executor 的 `runWorkflow` 调度内核（增量 dirtySet 计算 / 分支剪枝 / scope 串行化并查集）高度耦合运行态，需先从 `runWorkflow` 拆出纯调度函数再补单测；headless 可加更多纯本地示例（loop-closure、scope-serialization）进 CI 矩阵。
- [ ] 上帝模块拆分：`executor.ts` / `builtin.ts` / `workflowStore.ts` 过大，建议渐进拆子模块（高风险低收益，功能稳定后做；拆分前先以测试网为安全网）。

---

## 四、设计权衡（为什么不全做）

- **不重做进程级沙箱**：对「用户自己装的本地插件」收益低于成本；正确做法是明确信任边界 + 收窄 Tauri 权限（P0）。仅当引入「网络下载插件」时才需升级。
- **key 进 WebView 内存**：本地桌面应用常态可接受；Rust 代理转发（TODO §4.3 方案 Y）可彻底规避，但属长期演进，不阻塞当前。
- **capability 仅为 API 层约束**：这是 OMO / ComfyUI 同类工具的共性取舍；真隔离靠 Git Worktree（已实现，`sandboxMode: 'gitworktree'`）在文件系统层做，而非在 JS 层做权限沙箱。

---

*创建：2026-08-07（基于 Codex 外部架构评审 + 项目代码核实）*
