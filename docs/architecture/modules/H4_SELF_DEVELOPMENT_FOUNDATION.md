---
title: H4 Self-Development Foundation
type: architecture-design
status: foundation-implemented-with-open-gaps
reviewed_date: 2026-08-13
authority: design-reference
---

# H4 Self-Development Foundation —— SlimeMold 开发 SlimeMold 的能力层

> 状态：**核心已实现并通过多轮安全审计**（2026-08-13，main @ `00738ff`）。
> Codex × CodeBuddy 共识：H4 是 H3d 的前提，不是与 H3d 并列推进；H3 让 SlimeMold 能**编排任务**，
> H4 让它能在隔离环境中**修改代码并用独立证据验收结果**。
>
> 实现路线：设计稿（c2f860c）→ H4 Foundation 实现（f253856 起）→ 12+ 轮 Codex 安全审计
> （证据引用制/作用域隔离/cleanup 三重确认门/原子确认/互斥锁/审计落盘强制）→ 自举样例
> headless 闭环跑通（e719e47 起，持续维护）。
> 剩余均为 P2（文档整理 / GUI 执行层接入 / 内存态恢复），见文末「审计收口结论与遗留清单」。

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
① 人工 H3c 验收（含 failed retry / readonly / stageWfIds 三检查）   ✅ 完成（2026-08-12）
② 固化本 H4 设计文档并审查                                       ✅ 完成（f2bfd40）
③ 实现 H4 Foundation（DevCapabilityService + WorktreeManager + Evidence + Policy）
                                                                ✅ 完成（f253856 起 + 12+ 轮审计）
④ 低风险任务第一次自举（闭环验证 + 成本报告）                    ✅ headless 闭环跑通（e719e47 起）；
                                                                    GUI 执行层接入后做真实代码修复验收
⑤ 受限主控 Agent（模板填充式 LLM 草案）→ 再逐步放开至 H3d         ← 未开始（H3d 延后）
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
  *.test.ts            # ✅ 各模块单测
  session.ts           # ✅ DevSession（resultStore/acceptanceStore/approvedCleanups/confirmAndCleanup/forceCleanup）
src/nodes/dev/         # ✅ 11 个开发节点薄封装（worktree.*/code.*/shell/test/git.*/evidence/accept）——headless 已跑通
src/platform/env.ts    # ⏳ Tauri GUI 执行层分支（headless/CI 已可用；GUI 编排里的 dev 节点暂禁用，走 GUI 接入）
docs/architecture/modules/H4_SELF_DEVELOPMENT_FOUNDATION.md  # ✅ 本设计文档（随实现修订）
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

待落地（GUI 接入）：
- **Tauri GUI 执行层**：dev 节点 GUI 可用（当前 WebView 下经 shim 抛错禁用）；
  approveCleanup / forceCleanup 走 GUI 确认框；证据 JSONL 持久化扩展恢复验收链。
- **真实代码修复自举验收**：第一轮低风险自举任务已在 headless 闭环跑通（worktree → code.patch →
  test.run → Evidence → evaluate → 宿主收尾清理），GUI 接入后对真实代码做一次完整验收。

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

### 第一轮自举闭环（2026-08-12，✅ headless 真实跑通）

`examples/self-dev-demo.workflow.json`：8 节点闭环
（worktree.create → code.read → code.patch → git.status → git.diff → evidence.add → accept → worktree.cleanup），
`npm run headless examples/self-dev-demo.workflow.json` 全部成功：
- 真实 git worktree 创建（`.codebuddy/dev-wt-demo`）→ 读 docs → 受控 diff 创建新文档 →
  git 校验 → 证据采集 → 确定性验收（diff 证据满足）→ 人工确认后清理（无残留）。
- dev 节点支持「params 兜底输入」（ParamType：text/textarea/number/boolean，JSON 数组/对象用
  textarea 字符串 + parseJson/strList 解析），工作流节点可用旧格式（顶层 type/params）独立运行。
- 关键语义修正：evaluator 的 diff 规则改为「宿主采集的 diff 证据存在即满足」（worktree 未提交
  修改不依赖 base/head commit）；codePatch 支持新增文件（read ENOENT → 空串）。

**第一轮自举验证结论**：目标 → worktree → 修改 → 测试/证据 → 验收 → 清理 的受限执行链
已在真实 git 环境下跑通（后续样例收敛为 6 节点，宿主收尾清理绑定验收，持续维护）。
剩余为 GUI 执行层接入（dev 节点 GUI 可用 + approveCleanup/forceCleanup 走 GUI 确认框）与
真实低风险代码修复验收。

### P0 宿主信任边界修复（2026-08-12，✅ 已落地）

审计发现 dev.evidence.add 可伪造通过证据（自填 status）、dev.accept 接受外部证据/保护路径覆盖、
dev.worktree.cleanup 的 confirm 可由节点参数伪造。修复：

- **宿主结果登记表**：DevSession 新增 `resultStore`（HostResultRecord：kind/status/exitCode/command/
  summary/contentHash）。dev.code.patch / shell.run / test.run / git.status / git.diff 执行后**登记真实结果**
  并输出 `resultId`（status 由真实 exitCode/补丁结果决定）。
- **dev.evidence.add 只引用 resultId**：不再接受 kind/summary/exitCode 自填；引用的 resultId 不在
  登记表 → 拒绝（伪造证据不可行）。
- **dev.accept 只读宿主证据**：证据固定取 `collector.toJSON()`（capturedBy 恒 host），不接受输入
  evidence；`changedProtectedPaths` 由宿主根据 `gitChangedFiles()` × policy 真实计算，不接受输入覆盖。
- **cleanup 宿主审批**：节点移除 `confirm` 参数；清理需 `session.isCleanupApproved(path)`（仅宿主
  `approveCleanup()` 可设置）。headless 场景宿主审批入口 = CLI `--dev-approve-cleanup=<path>`；
  示例运行：`npm run headless examples/self-dev-demo.workflow.json -- --dev-approve-cleanup .codebuddy/dev-wt-demo`。
- 单测更新：伪造 resultId 拒、test.run 登记→evidence 引用→accept 通过、params confirm 无效仅宿主审批有效。
  验证：tsc 0 / vitest 570 / build ✓ / headless 样例 7/7 ✓（worktree 清理无残留）。

### P1 证据作用域 / 空 diff / 审批一次性（2026-08-12，✅ 已落地）

- **resultId 绑定 worktree**：HostResultRecord 增加 `worktreePath`（执行节点登记时带 cwd）；
  evidence.add 新增 worktreePath 输入并校验与结果一致（normalize 比较）——跨 worktree/跨任务引用
  宿主结果 → 拒绝（防另一编排拿 resultId 当自己证据）。
- **git.diff 空改动不通过**：登记 status 改为 `hasChange ? 'passed' : 'failed'`（git diff 无改动时
  exitCode 也是 0，仅凭退出码会误判）；空 diff 证据 status=failed → evaluator diff 规则不满足 → 验收失败。
- **cleanup 审批一次性 + 绑定版本**：approvedCleanups 由 Set 改 Map<string, CleanupApproval>
  （worktreePath/baseRevision/acceptanceId/approvedAt/consumed）；清理成功后 consumeCleanup 置
  consumed=true，不可重复清理；批准可带 baseRevision/acceptanceId 绑定基线。
- 单测 +3（跨 worktree 拒 / 缺 worktreePath 拒 / 空 diff 登记 failed / 审批消费后不可重复清理）。
  验证：tsc 0 / vitest 571（49 文件，+1）/ build ✓ / headless 样例 7/7 ✓（worktree 无残留）。

### P1 任务/阶段级证据隔离（2026-08-12，✅ 已落地）

- **resultId 绑定 orchestrationId/stageId**：HostResultRecord 增加 orchestrationId/stageId；
  执行节点登记时经 scopeOf 读取输入/参数携带任务与阶段身份；evidence.add 三重作用域校验
  （worktree + orchestrationId + stageId 全须一致）——**同 worktree 跨编排/跨阶段借用 resultId 也拒绝**。
- **accept 按作用域过滤证据**：改为 collector.flushAndByScope({ orchestrationId, stageId,
  worktreePath })——验收前强制 flush（落盘失败 throw），且只采纳当前任务+阶段+工作区的宿主证据，
  **旧任务/其他阶段的通过证据不满足当前验收规则**（跨任务串证据被杜绝）。
- **cleanup 审批基线约束**：isCleanupApprovedForRevision 校验审批绑定的 baseRevision 与当前
  worktree 基线一致（防 worktree 被再次修改后清理）；manager.get(path).baseRevision 提供当前基线。
- 单测 +4：跨编排引用拒 / 跨阶段引用拒 / 不同阶段无证据验收失败（不串旧证据）/ 审批基线不匹配拒。
  验证：tsc 0 / vitest 571（49 文件）/ build ✓ / headless 样例 7/7 ✓（worktree 无残留）。

### P1 作用域必填 + acceptance 绑定（2026-08-13，✅ 已落地）

- **结果作用域必填**：HostResultRecord 的 worktreePath/orchestrationId/stageId 改为必填；
  registerResult 缺失即拒绝；执行节点（code.patch/shell/test/git.status/git.diff）登记前 scopeOf
  校验必填并带 SCOPE_INPUTS/SCOPE_PARAMS 端口。evidence.add 校验改**非条件式**（三项直接比较，
  无「可选字段跳过」路径）——无作用域结果不存在，不可被任意编排/阶段引用。
- **acceptance 绑定**：新增 DevSession.acceptanceStore + recordAcceptance/getAcceptance；dev.accept
  执行后登记确定性验收记录（acceptanceId 参数，缺省自动 acc-<orch>-<stage>）。cleanup 确认门：
  审批存在未消费 +（若绑定 baseRevision 须一致）+（若绑定 stateSignature 须一致——worktree 被再次
  修改则签名变化拒绝）+（若绑定 acceptanceId 须对应记录 passed 且 worktreePath 一致）。
- **byScope 规范化**：EvidenceCollector.byScope 的 worktreePath 比较统一 normalizeAbsolutePath
  （防 . / .. / Windows 分隔符差异误判）。
- 样例：worktree 路径改用根目录 `dev-wt-demo`（`.codebuddy` 在 .gitignore 导致 git diff 看不到
  新文件，会使 git-diff 空 diff 误判）；执行节点带 orchestrationId/stageId；accept 绑定
  acceptanceId；headless CLI 新增 `--dev-acceptance-id` 绑定审批。
- 单测 +5（缺失 scope 登记拒 / cleanup 绑定 acceptanceId 四态 / stateSignature 不一致拒 / 基线不匹配拒）。
  验证：tsc 0 / vitest 573（49 文件）/ build ✓ / headless 样例 7/7 ✓（worktree 无残留）。

### P1 严格证据作用域 + acceptance 绑定 + 清理确认门补强（2026-08-13，✅ 已落地）

- **byScope 严格匹配**：scope 指定某项时证据必须存在该字段且严格匹配，缺字段历史证据直接排除
  （不得「没写就不校验」混入）；worktreePath 统一 normalizeAbsolutePath。
- **acceptanceId 宿主生成唯一 + 禁覆盖**：dev.accept 移除 acceptanceId 输入/参数，改由
  session.nextAcceptanceId()（时间戳+随机）生成；recordAcceptance 对已有 ID 抛错（禁覆盖，
  重复执行产生新记录）；cleanup 校验 acceptance 时同时校验 orchestrationId/stageId/worktreePath。
- **cleanup 正常清理必须三绑定**：acceptanceId + stateSignature + baseRevision 缺一不可；
  仅 approve 无绑定 → 拒绝（防验收前强制删除未提交改动）。强制清理走宿主 `forceCleanup(path, reason)`
  高风险 API（须人工 reason，节点不可触达）。
- **状态签名纳入 untracked 内容**：computeWorktreeSignature 增加 untracked 文件内容 hash
  （gitUntrackedFiles + readTextFile），审批后改同一 untracked 文件内容签名变化 → 拒绝清理。
- **git.status 按 exitCode 判定**：失败登记 failed（不再无条件 passed）。
- **headless CLI**：支持 `--dev-approve-cleanup=<path>` 等号与空格两种形式；审批改为**运行后**
  宿主收尾（绑定通过验收 + 状态签名 + 基线），未找到通过验收的 worktree 拒绝清理并保留。
- 单测 +4（无绑定审批拒 / accept 二次执行不覆盖 / git.status 失败登记 failed / byScope 缺字段排除）。
  验证：tsc 0 / vitest 575（49 文件，+2）/ build ✓ / headless 样例 6/6 ✓（等号参数 + 宿主收尾清理，
  worktree 无残留）。

### cleanup 原子确认 API + crypto 凭证（2026-08-13，✅ 已落地）

- **P1 TOCTOU 收口**：新增 `DevSession.confirmAndCleanup(path)` 原子 API——单入口内
  取审批 → 校验验收三元组 + **重新计算状态签名** + 校验基线 → 全部通过立即 cleanup → 成功后
  消费审批。dev.worktree.cleanup 节点与 headless 宿主收尾均改走它，不再「外部先算签名再删除」，
  消除签名计算与实际删除之间的窗口。
- **P2 acceptanceId 用 crypto.randomUUID**：作为安全审计凭证（Math.random 仅普通唯一性），
  Node/WebView 下优先 crypto.randomUUID（8 字符前缀），无则回退。
- 验证：tsc 0 / vitest 575（49 文件）/ build ✓ / headless 样例 6/6 ✓
  （`--dev-approve-cleanup=dev-wt-demo` 等号形式 + confirmAndCleanup 原子确认，worktree 无残留）。
- 遗留（次要）：resultStore/acceptanceStore 仍内存态，进程重启后 cleanup 审批链不可恢复——
  GUI 接入时用证据 JSONL 持久化扩展。GUI 执行层接入（dev 节点 GUI 可用 + approveCleanup/
  forceCleanup 走 GUI 确认框）仍是下一步——**注意：宿主侧 forceCleanup 已实现**
  （见下文「宿主级清理互斥锁 + forceCleanup 审计落盘」「forceCleanup 强制宿主持久化」），
  尚未实现的是「GUI 人工触发入口」，不等同于 forceCleanup 未落地。

### 宿主级清理互斥锁 + forceCleanup 审计落盘（2026-08-13，✅ 已落地）

- **P1 宿主级 mutex**：DevSession.confirmCleanupInFlight（per-worktree Set）——同一 worktree 的
  confirmAndCleanup/forceCleanup 串行执行（并发确认直接拒绝）；确认链收口到锁内
  （取审批 → 校验验收三元组 → 重算签名 → 校验基线 → **cleanup 前二次重算签名** → 删除 → 消费），
  签名计算与删除窗口最小化（非严格事务，同 OS 用户外部进程物理不可防，文档明确）。
- **P2 forceCleanup 审计落盘**：reason 必须提供且写入宿主证据（collector.addAsync，
  kind=path-policy/status=failed，capturedBy=host，summary 含 reason）——跨会话可追溯；
  与正常确认门共用互斥锁。
- **P1 forceCleanup 审计落盘失败 → 拒绝清理**（2026-08-13 补充）：移除 `.catch(() => {})`——
  addAsync 落盘失败（磁盘满等）直接 throw，**不删除 worktree**（高风险操作必须有可靠审计记录）。
- 单测 +2：confirmCleanupInFlight 锁占用拒 / forceCleanup 审计证据落盘（含 reason）。
  验证：tsc 0 / vitest 577（49 文件，+2）/ build ✓ / headless 样例 6/6 ✓
  （confirmAndCleanup 原子确认 + 互斥，worktree 无残留）。

### forceCleanup 强制宿主持久化（2026-08-13，✅ 已落地）

- **P1 forceCleanup 依赖可选 persistence 的边界**：审计落盘本依赖 `opts.persistence`——未注入时
  `EvidenceCollector.addAsync()` 只写内存仍会继续强制清理，内存审计进程退出即丢，等同无审计强制删除。
- **修复（宿主前提）**：
  - `EvidenceCollector.hasPersistence()`（是否配置宿主持久化 EvidenceStore）；
  - `DevSession.forceCleanup` 开头强制检查——无宿主持久化**直接拒绝（throw）**，不删除 worktree；
  - headless `initDevSession` 注入宿主固定路径 EvidenceStore（`<项目根>/.slimemold/evidence/host.jsonl`，
    经 `createHostEvidenceStore` 宿主构造，位于 worktree 外；无 `dev.worktree.create` 声明时不注入）——
    证据与 forceCleanup 审计真实落盘，跨会话可追溯。
- 单测 +2：EvidenceCollector.hasPersistence / forceCleanup 无宿主持久化 → 拒绝（worktree 保留）。
  验证：tsc 0 / vitest 580（49 文件，+2）/ build ✓ / headless 样例 6/6 ✓
  （EvidenceStore 落盘 + confirmAndCleanup 原子确认 + 互斥，worktree 无残留）。

## 审计收口结论与遗留清单（2026-08-13，Codex × CodeBuddy 共识）

**结论**：H4 核心安全边界已基本收口（远端 @ `00738ff` 复核通过）。当前无新的明显 P0/P1
安全绕过；forceCleanup 无持久化拒绝、审计落盘失败拒绝、宿主互斥锁、cleanup 三重绑定
（验收/基线/状态签名）均有效。**可进入 GUI 验收与产品流程整合；暂不再对 cleanup 做高风险改造。**

剩余 P2（按优先级）：

1. **headless EvidenceStore 路径静态推断**：headless 仅从 `dev.worktree.create` 的静态
   `params.path` 推断 EvidenceStore 路径（`<项目根>/.slimemold/evidence/host.jsonl`）。
   若工作流通过输入/变量**动态创建 worktree**，则安全失败（forceCleanup 拒绝、不误删），
   但无法使用强制清理。→ 归属 GUI 接入时按实际 worktree 校验。
2. **文档一致性**：本文档早期章节已同步为「核心已实现 + 剩余 GUI 接入」，消除
   「forceCleanup 仍是下一步」类过时表述。✅ 本提交完成。
3. **resultStore / acceptanceStore / cleanup approval 内存态**：进程重启后验收链
   （resultId 引用、验收记录、审批）无法恢复。→ GUI 接入时用证据 JSONL 持久化扩展
   （复用 EvidenceCollector persistence / createHostEvidenceStore，宿主独占路径 + 加载恢复）。

---

*生成日期：2026-08-12 · 代码基线 c2f860c（H3c P0 修复后）· 本文档为设计稿，按实现修正。
最新实现基线：main @ 00738ff（2026-08-13，forceCleanup 强制宿主持久化）。*
