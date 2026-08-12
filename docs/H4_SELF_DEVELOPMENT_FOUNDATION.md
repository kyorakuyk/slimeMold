# H4 Self-Development Foundation —— SlimeMold 开发 SlimeMold 的能力层

> 状态：**可执行设计稿**（2026-08-12）。Codex × CodeBuddy 共识：H4 是 H3d 的前提，
> 不是与 H3d 并列推进；H3 让 SlimeMold 能**编排任务**，H4 让它能在隔离环境中
> **修改代码并用独立证据验收结果**。
>
> 代码基线：main @ `c2f860c`（H3c 两项 P0 修复后）。
> **暂不实现 H4**——本文档完成审查后，先从低风险自举任务开始实现 Foundation。

---

## 1. 定位与目标

H4 是「开发能力 + 证据链」能力层，位于 Orchestrator 之下、节点之上：

- **DevCapabilityService**：受 `SelfDevelopmentPolicy` 控制的宿主服务（文件/进程/Git/Worktree）。
  工作流节点（`code.read`/`code.patch`/`shell.run`/`test.run`/`git.status`/`git.diff`）只是它的薄封装；
- **WorktreeManager**：自举任务的隔离工作区（Agent 可写区）；
- **EvidenceCollector / DevEvaluator**：宿主采集证据 + 确定性验收判定；
- **SelfDevelopmentPolicy**：路径白名单 / 保护路径 / 审批项 / 自动测试/提交/推送策略。

第一轮自举的验收标准是**整条链路跑通**：

```
目标 → 编排（模板化 Orchestrator）→ worktree 创建 → 开发节点执行
→ 测试 → 外部 EvidenceStore 采集 → 确定性验收 → 用户审查 diff → 人工合并
```

而不是「能修最难的 bug」。

## 2. 安全模型

### 2.1 三区隔离（必要条件）

| 区域 | 谁可写 | 内容 |
|---|---|---|
| **隔离 worktree** | Agent | 全部开发改动、测试产物 |
| **EvidenceStore / 主仓库 / 运行审计** | **Agent 不可写**（宿主独占） | 证据文件、基线代码、审计记录 |
| **宿主采集与判定** | 仅宿主进程 | 证据采集、证据落盘、验收判定 |

物理隔离要求：**EvidenceStore 必须位于 worktree 之外**，由运行在主实例的宿主进程独占写入。
Agent 在 worktree 内的一切输出（测试报告、日志文件）**不算证据**，只作为
`agentSummary`/`uncertainties` 辅助文本。

### 2.2 安全边界声明（重要）

- 「证据区在 worktree 外」是必要条件**但不是充分条件**：若 Agent 持任意 `shell.run`
  权限且知道 EvidenceStore 路径，仍可能直接修改证据文件。
- H4 当前解决的是：
  1. **防止正常 Agent 流程误改证据**（工具能力限制 + 宿主独占）；
  2. **限制工具能力**（路径/命令/超时/网络白名单）。
- H4 **不承诺**对恶意进程的完整安全保证——同 OS 用户下普通进程非绝对隔离；
  真正不可信的 Agent 未来仍需 sidecar / 独立进程（H2 设计文档 §5.2 已预留该路线）。

## 3. DevCapabilityService

底层服务（宿主实现，节点薄封装）。第一版能力与约束：

| 方法 | 约束 |
|---|---|
| `code.read(path)` | 只读；路径必须落在 `allowedPaths` 内；返回内容 + 行数摘要 |
| `code.patch(unifiedDiff)` | **仅接受受控 unified diff**，禁止整文件覆盖；自动验证 context 匹配 |
| `shell.run({ cwd, cmd, env, timeoutMs })` | 限定 `cwd`（worktree 内）、命令白名单模式、`timeoutMs`、**禁网络**（Tauri 走网络时须经 `httpFetch` 且无凭据注入） |
| `test.run({ cwd, cmd })` | 统一捕获 stdout/stderr/**exitCode/durationMs**，返回结构化摘要 |
| `git.status(worktree)` | 只读；返回 changed paths / staged |
| `git.diff(worktree, baseRef)` | 只读；返回 unified diff + diffStat |
| `worktree.create(baseRef)` / `worktree.cleanup()` | worktree 生命周期（复用 `src/platform/git.ts addWorktree`） |
| `git.commit(...)` | **需人工确认**（第一版可选） |
| `git.push` | **暂不提供自动节点** |

平台适配（收敛到 `src/platform/env.ts` 既有模式）：
- **Tauri**：文件经 `fs:scope` 动态授权（复用 `grant_project_access` 先例）；进程经宿主命令；
- **headless / CI**：直接本地实现（复用 `npm run headless` 入口，`shell.run`/`test.run` 原生可跑）；
- **浏览器**：只读演示（`code.read`/`git.diff` 可看，`shell.run`/`code.patch` 禁用）。

## 4. 证据模型（独立实体）

`StageLog` 回答「阶段运行到什么状态」，`EvidenceLog` 回答「系统有什么**客观证据**证明阶段完成」——两者职责分离，不合并。

```ts
interface EvidenceRecord {
  id: string;
  orchestrationId: string;
  stageId: string;
  kind: 'command' | 'test' | 'diff' | 'path-policy' | 'artifact';
  status: 'passed' | 'failed' | 'unknown';
  exitCode?: number;
  summary: string;                 // 宿主生成的一句话摘要
  capturedBy: 'host';              // 强制：仅宿主采集，Agent 不可自报
  worktreePath?: string;
  baseRevision?: string;
  headRevision?: string;
  contentHash?: string;
  createdAt: string;
}

interface DevAcceptance {
  passed: boolean;
  requiredChecks: string[];
  failedChecks: string[];
  changedProtectedPaths: string[]; // 负向证据：证明未触碰保护路径
  uncertainties: string[];         // 模型只能写这里，不能写事实证据
}
```

关键规则：
- **宿主采集**：`test.run` 的真实退出码、`git diff` 的真实 diff、`path-policy` 检查结果、成本均由宿主写入；
- **模型输出**最多作为 `uncertainties` / `agentSummary`，**不得作为事实证据来源**；
- **确定性验收**：`DevAcceptance` 由 Evaluator 依据「针对任务的验收规则」判定，而非固定公式——
  `exitCode === 0` 不等于任务完成（可能 typecheck 过了但功能没接入 UI、测试过了但碰了保护路径等）。

## 5. SelfDevelopmentPolicy

```ts
interface SelfDevelopmentPolicy {
  allowedPaths: string[];    // 允许开发节点读写
  protectedPaths: string[];  // 触碰即要求人工 diff 审查（且计入 changedProtectedPaths）
  requireApprovalFor: Array<'architecture' | 'security' | 'store' | 'executor' | 'git-push' | 'orchestrator'>;
  autoTest: boolean;         // 允许自动运行测试（默认 true）
  autoCommit: boolean;       // 允许自动 commit（默认 false）
  autoPush: boolean;         // 禁止（固定 false）
}
```

初期配置建议：

```ts
allowedPaths: ['src/components', 'src/nodes', 'tests', 'docs'],
protectedPaths: [
  'src/store/workflowStore.ts',
  'src/engine/executor.ts',
  'src/plugins/sandbox/**',
  'src-tauri/capabilities/**',
  'src/orchestrator/**',   // 修改编排器可能改变确认门/权限边界，一并保护
],
requireApprovalFor: ['store', 'executor', 'security', 'orchestrator', 'git-push'],
autoTest: true,
autoCommit: false,
autoPush: false,
```

> **第一轮自举任务不得触碰 protectedPaths**。等链路验证成功后，再逐步允许
> 「触碰保护路径 + 人工 diff 审查」的场景（如 H3c failed retry）。

## 6. Worktree 生命周期

1. **创建**：`worktree.create(baseRef)`（复用 `git.ts addWorktree`；Tauri 需对 worktree 路径动态注入 fs:scope）；
2. **修改**：Agent 经开发节点在 worktree 内修改 + 测试；
3. **证据**：宿主在 worktree **外**采集（`git diff <worktree>`、worktree 外重跑 `tsc`/`vitest`）；
4. **保留**：worktree 保留到验收结束（便于回放），`cleanup()` 在人工确认后调用。

硬约束：
- 自举任务必须运行在独立 worktree；
- **当前主进程不加载被修改中的代码**（证据与判定跑在主实例，但代码不 reload）；
- 测试失败不能自动合并；禁止自动 push。

## 7. 第一轮自举任务（方案 A：低风险）

候选（选一个即可验证全链路，**不碰核心**）：
- 更新 H3/H4 设计文档；
- 补充纯函数单测；
- 修复低风险 UI 文案 / 状态展示问题；
- 运行 typecheck + 定向测试；
- 生成 diff、测试证据、成本报告。

**不建议第一轮**：修改 `executor` / `workflowStore` / `sandbox` / `orchestrator`。
第一轮目标不是「证明能修最难的 bug」，而是验证「目标 → 编排 → worktree → 开发节点 →
测试 → 外部 EvidenceStore → 验收 → 人工审查」链路。

## 8. 落地顺序（用户决策）

```
① 人工 H3c 验收（含 failed retry / readonly / stageWfIds 三检查）  ← 进行中
② 固化本 H4 设计文档并审查
③ 实现 H4 Foundation（DevCapabilityService + WorktreeManager + Evidence + Policy）
④ 低风险任务第一次自举（闭环验证 + 成本报告）
⑤ 受限主控 Agent（模板填充式 LLM 草案）→ 再逐步放开至 H3d
```

## 9. 复用清单（降低落地成本）

| H4 组件 | 项目已有基座 |
|---|---|
| 能力等级语义 | `applyCapability` / `CAPABILITY_WHITELIST`（compute/io 分级，H2） |
| worktree | `src/platform/git.ts addWorktree`（executor sandbox 模式已用） |
| 目录授权 | `grant_project_access`（Tauri fs:scope 动态注入先例） |
| 成本分级 | `AgentEconomics`/`resolveModelPrice`（四级优先级对齐 `cost.source`） |
| 落盘路径 | eventLog 的 `.slimemold/runs/{wfId}/{runId}/` 机制可复用给 EvidenceStore |
| 平台差异 | `platform/env.ts` 适配层（Tauri/浏览器/headless 三态） |
| 编排容器 | 模板化 Orchestrator（H3c）承载自举任务 DAG |

## 10. 非目标（本阶段明确不做）

- 不做 `git.push` 自动节点；
- 不提供对恶意进程的完整隔离（sidecar 留待未来）；
- 不重写 executor / topoSort / runWorkflow；
- 不实现完整 H3d（LLM 自由生成 DAG）——主控 Agent 第一版只做「模板填充 + 验收条件 + 推荐 Agent」。

## 11. 文件落点

```
src/dev/
  policy.ts            # ✅ SelfDevelopmentPolicy + 路径白名单/保护路径判定（matchesGlob/assertPathAllowed）
  evidence.ts          # ✅ EvidenceRecord / DevAcceptance 类型 + EvidenceCollector（capturedBy 恒 'host'）
  evaluator.ts         # ✅ DevEvaluator（规则+证据→DevAcceptance，确定性判定）
  capabilities.ts      # ✅ DevCapabilityService 接口 + applyUnifiedPatch 纯函数 + createNodeDevService
  node-run.ts          # ✅ Node 执行层（execFile 命令执行 + 动态 import fs/path）
  worktree.ts          # ✅ WorktreeManager（创建/保留/清理，git runner 可注入）
  shims/node-child-process.ts  # ✅ 浏览器构建占位（GUI 下开发节点禁止执行命令）
  *.test.ts            # ✅ 各模块单测（23 例）
src/nodes/dev/         # ⏳ 开发节点薄封装（code.read / code.patch / shell.run / test.run / git.status / git.diff）——下一步
src/platform/env.ts    # ⏳ Tauri/浏览器执行层分支（MVP 仅 Node/headless；Tauri 复用 run_git，shell 走 Rust 命令待补）
docs/H4_*              # ✅ 本设计文档（随实现修订）
```

### 实现状态（2026-08-12，H4 Foundation 第一刀 + 审计加固 f47c3c0/f4ed3a8）

已落地（纯函数 + 策略 + 证据 + 验收 + worktree + Node 执行层，全部可单测）：
- `policy.ts`：`defaultDevPolicy`（allowedPaths=components/nodes/tests/docs；protectedPaths 含
  workflowStore/executor/sandbox/capabilities/orchestrator；autoPush 固定 false）；`assertPathAllowed`
  拒绝受保护/越界路径；`collectChangedProtectedPaths` 产出负向证据。
- `evidence.ts`：`EvidenceCollector.add` 强制 `capturedBy='host'`（伪造输入也被覆盖）；
  `byStage/toJSON/clear/restore`。
- `evaluator.ts`：`evaluateDevAcceptance`——test/command 看真实 exitCode、path-policy 看负向证据、
  diff 看 headRevision≠baseRevision、**无证据一律视为未满足**；uncertainties 只记录不直接置失败。
- `capabilities.ts`：`applyUnifiedPatch`（上下文精确匹配、禁整文件覆盖）；`createNodeDevService`
  （命令/文件/路径均可注入便于单测；shell/test 白名单；`resolveInside` 防 ../ 逃逸；
  gitChangedFiles 合并 tracked+untracked）。
- `node-run.ts`：`runCommand`（execFile 包装，非零码不抛错返回结构）+ 动态 import fs/path。
- `worktree.ts`：`WorktreeManager`（rev-parse 校验、worktree add/remove/分支清理、清理失败保留现场）。
- vite alias `node:child_process` → shim（浏览器构建不炸；GUI 调用即抛错）。

待落地（下一步）：
- Tauri/浏览器执行层分支（MVP 仅 Node/headless 可真实执行；GUI 编排里的开发节点需显式
  降级/禁用并提示走 headless）；
- 第一轮低风险自举任务（worktree → code.patch → test.run → Evidence → evaluate → 用户审查 diff）。

### 开发节点薄封装（2026-08-12，✅ 已落地）

`src/dev/session.ts` + `src/nodes/dev/index.ts`：
- **DevSession 单例**：manager（WorktreeManager，兼作 service 的 WorktreeRegistry）+
  service（DevCapabilityService，cwd fail-closed）+ collector（EvidenceCollector，可注入宿主持久化）+
  defs（开发节点定义）。headless 启动时 `initDevSession()`；GUI 不初始化 → dev 节点 execute 抛错
  （shim + fail-closed 双兜底）。
- **11 个 dev.* 节点**（分类「开发」）：worktree.create/status/cleanup（cleanup 需 confirm）、
  code.read、code.patch、shell.run、test.run、git.status、git.diff、evidence.add（capturedBy 恒 host）、
  accept（确定性验收，protected 硬失败）。全部只是能力薄封装，安全检查下沉 service。
- **headless 集成**：`headless.ts` buildDefs 合并 DevSession defs；`headless-run.ts` 检测到 `dev.*`
  节点时自动 `initDevSession({ baseRepoPath: process.cwd() })`。
- 单测 7 例（fake session：worktree 登记 → code.read/patch → shell/test 白名单 → evidence→accept →
  cleanup 确认门）。验证：tsc 0 / vitest 570（49 文件，+7）/ build ✓。

---

*生成日期：2026-08-12 · 代码基线 c2f860c（H3c P0 修复后）· 本文档为设计稿，按实现修正。*
