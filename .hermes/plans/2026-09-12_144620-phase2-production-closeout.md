# Phase 2 Production Closeout Implementation Plan

> **For Hermes:** Use the SlimeMold development workflow and test-driven-development skill to execute this plan task-by-task.

**Goal:** 在不触碰 `D:/Agents/SMtest`、不自动 push/merge 的前提下，用真实 disposable Tauri 验收闭合 TaskGraph → Issue → Worker → Evidence/Acceptance → DAG → Restart/Recovery，并把剩余生产化边界收敛到可审计的最终 checkpoint。

**Architecture:** Project Control Event Store、ProjectFile snapshot、WorkerRun Queue、Side-effect Journal 和 UI projection 继续共享稳定的 `Project/Session/TaskGraph/Task/Issue/TaskExecution/Attempt/Run/Evidence/Acceptance/Receipt` lineage。DAG 与 Issue 只通过 command/event 和 canonical projection 交互；普通 WorkflowEditor 仍是阶段执行实现，不把 workflow node 误当作 Task。所有高影响 cleanup 继续由 Rust native capability、branch CAS、session generation 和原生确认框共同保护。

**Tech Stack:** Tauri 2 + Rust 2021、React/TypeScript、Zustand、Vitest、Git worktree、JSONL/Event Store、`npm run test/build/i18n:check`、Cargo test/fmt。

---

## Current Context and Hard Constraints

- 当前分支：`phase2/taskgraph-issue-dag-projection`。
- 当前 HEAD：`2719b786b44827468e23d6e014df400c4f08bf04`。
- `main`：`11948df68bdbbeddf83ff09a1d3c71b9a83bf54a`；当前分支领先 7 个 commit。
- tracked 工作树当前干净；`.hermes/`、`.workbuddy/`、`IDEA.md` 和 `src-tauri/icons/**` 的 untracked 设计素材必须保留且不得用 `git add .` 纳入。
- 真实项目 `D:/Agents/SMtest` 必须保持不变，不在其上创建 fixture、worktree、Worker 或测试文件。
- 当前控制面仍为 `mvp-closed-unverified`；没有新的 reviewer `passed=true` 和真实 GUI E2E read-back 前，不得使用 `[verified]`。
- 成功 Worker worktree 未取得明确批准前不自动 Cleanup；未知/部分副作用只进入 `unknown/needs-user`，不可静默重试。
- Zod 只能在说明边界、收益和迁移风险后实施；优先 Evidence/Acceptance/Receipt、WorkerQueue/recovery、ProjectFile/TaskGraph/Event 外部数据边界，不进行全量 TypeScript 类型替换。

## Immediate Priority

下一步先不继续横向增加 UI 功能，先用真实 disposable fixture 证明当前 vertical slice 在 Tauri WebView、Rust host、磁盘持久化和重启之间成立。若真实验收暴露问题，先为 exact symptom 写 RED 回归，再修根因；不能用 headless 通过、窗口出现或 Agent 自报成功替代证据。

---

## Task 1: Establish the final local checkpoint and clean scope

**Objective:** 固定本轮验收输入，确保后续 reviewer 和 E2E 都针对同一明确 HEAD。

**Files:**
- Read: `docs/DEVELOPMENT_LOG.md`
- Read: `src/projectControl/taskGraphProjection.ts`
- Read: `src/projectControl/commands.ts`
- Read: `src/projectControl/projectControlConsistency.ts`
- Read: `src-tauri/src/lib.rs`

**Steps:**
1. 运行 `git status --short --branch`、`git rev-parse HEAD`、`git log --oneline -8`。
2. 将 tracked/untracked ownership 分开记录；不得暂存无关素材。
3. 若后续先修代码，先在当前工作树上做范围明确的本地 checkpoint；不得 push、merge 或改写历史。

**Acceptance:** reviewer 输入 HEAD、fixture 根目录和未跟踪素材边界都有明确记录。

---

## Task 2: Build an isolated disposable Tauri fixture

**Objective:** 在仓库和真实用户项目之外建立可删除的 Git fixture，并保留所有验收档案在专用 case/test 根目录。

**Files:**
- Create outside repository: `D:/Temp/slimemold-phase2-e2e-<timestamp>/`
- Create inside that root only: fixture project、`.slimemold/`、`case/`、`test/`、Evidence/receipt manifests
- Do not modify: `D:/Agents/SMtest`

**Steps:**
1. 创建带最小源码、测试和 Git baseline 的 fixture。
2. 为 fixture 建立独立 worker root 和可区分的 run/attempt 路径。
3. 记录 fixture baseline commit、worker path、branch、projectId、runId、taskGraphId；禁止把凭据写入 manifest 或日志。
4. 在启动前用 Git 和文件系统 read-back 确认真实项目没有变化。

**Acceptance:** fixture、worker root、档案根和真实项目路径互不相交；所有额外测试文件都在专有 case/test 根目录。

---

## Task 3: Exercise the real GUI control-plane path

**Objective:** 在真实 Tauri WebView 中验证用户目标到 TaskGraph、Issue、Orchestration 和 WorkerRun 的完整入口。

**Files:**
- Inspect only: `src/components/ProjectSessionPanel.tsx`
- Inspect only: `src/components/IssueBoard.tsx`
- Inspect only: `src/components/OrchestratorPanel.tsx`
- Inspect only: `src-tauri/src/lib.rs`

**Steps:**
1. 启动当前分支的 Tauri dev app，并同时确认 Vite、Rust binary、实际窗口标题和 CDP 页面属于当前项目。
2. 使用 disposable fixture 的项目上下文，不加载或保存真实用户项目。
3. 在 GUI 中输入最小目标，观察主控澄清；只在用户确认后批准 Brief/Architecture/TaskGraph。
4. read-back ProjectFile 和 event stream，确认同一 `sessionId/taskGraphId/taskId/issueId`。
5. 在 IssueBoard 检查 Task link、Issue status、execution lineage。
6. 在 OrchestratorPanel 检查 DAG nodes/edges、Worker state、Evidence/Acceptance 字段。

**Failure rule:** 如果 provider/API/GUI 依赖不可用，不伪造成功 Evidence；记录明确 blocker，保留失败现场并标为未验证。

**Acceptance:** GUI 文案、ProjectFile、event stream 和 projection 的 lineage 完全一致，且没有对 `D:/Agents/SMtest` 的写入。

---

## Task 4: Exercise Worker execution and host authority

**Objective:** 证明 Worker 在独立 worktree 中真实执行，Rust host gate 与 TypeScript proposal gate 使用同一身份。

**Files:**
- Inspect/possibly modify after RED: `src/dev/session.ts`
- Inspect/possibly modify after RED: `src/dev/tauri-run.ts`
- Inspect/possibly modify after RED: `src/dev/worktree.ts`
- Inspect/possibly modify after RED: `src-tauri/src/lib.rs`
- Test: `src/dev/session.test.ts`, `src/dev/session.tauri.test.ts`, Rust tests in `src-tauri/src/lib.rs`

**Steps:**
1. read-back `WorkerRunQueueState`、TaskExecution、Attempt、worktree path、branch、baseRevision。
2. 验证 Worker 真实文件写入只发生在 disposable worktree。
3. 验证 Evidence/Acceptance 绑定 `runId/taskId/taskExecutionId/attemptId/worktreePath/baseRevision`。
4. 验证 direct `dev_exec` 不能执行 destructive worktree/branch mutation。
5. 验证正常 registration 必须消费 pending lease；path/branch/generation drift fail-closed。
6. 在没有用户批准时保留成功 worktree，不执行 cleanup。

**Acceptance:** 真实文件、Git worktree、Host Evidence 和 queue state 四方一致；任何越权或 lineage 漂移均阻断且留有可读错误。

---

## Task 5: Restart and recovery read-back matrix

**Objective:** 证明重启后从磁盘重新恢复 Project Control、Issue/DAG projection、Worker recovery 和 side-effect journal，而不是依赖内存状态。

**Files:**
- Inspect/possibly modify after RED: `src/projectControl/persistence.ts`
- Inspect/possibly modify after RED: `src/projectControl/eventSourceBootstrap.ts`
- Inspect/possibly modify after RED: `src/projectControl/workerSideEffects.ts`
- Inspect/possibly modify after RED: `src/projectControl/workerRecoveryCommand.ts`
- Test: persistence, event source, worker recovery and side-effect tests

**Steps:**
1. 在第一次 GUI run 后保存 ProjectFile、events、Evidence、Acceptance、side-effects、WorkerRun state。
2. 完全退出并重新启动 Tauri；从空内存状态恢复。
3. read-back `taskGraphId/taskId/issueId/taskExecutionId/attemptId`，确认 IssueBoard 和 DAG 显示相同 projection。
4. 故意构造/保留 `started`、`unknown/needs-user` 和 stale attempt 现场；确认 startup audit 生成 recovery、清空旧 cleanup proposals、禁止自动 destructive retry。
5. 对 retry/skip/inspect 分别验证：retry 创建新 attempt/worktree，skip 不伪造成功，inspect 不改变执行事实。

**Acceptance:** restart read-back 与首次事实一致；未知副作用和审计异常都 fail-closed；无 receipt 的副作用不被宣称完成。

---

## Task 6: Close the remaining Workflow ↔ Task boundary explicitly

**Objective:** 明确普通 WorkflowEditor 与项目 TaskGraph 的边界，补齐实际需要的 `workflowId/stageId` lineage，而不把两套图合并成第二套事实源。

**Files:**
- Inspect: `src/canvas/WorkflowEditor.tsx`
- Inspect: `src/projectControl/executionPlan.ts`
- Inspect: `src/projectControl/taskGraphProjection.ts`
- Modify only if E2E finds a gap: relevant projection/command files
- Test: projection, execution plan, IssueBoard and OrchestratorPanel tests

**Steps:**
1. 列出每个 Task 到 orchestration stage、stage workflow、WorkerRun 的 canonical mapping。
2. 对缺少 graph/version、stage drift、workflow missing 和 execution lineage drift 写 RED tests。
3. 若需要补 wiring，所有修改必须通过 command/event 或 canonical projection，不能由 WorkflowEditor 直接写 Project Control。
4. 验证 TaskGraph revision 后旧 workflow/run 不被错误复用；新 revision 需重新审批/执行。

**Acceptance:** 用户能从 Task/DAG 追到 stage/workflow/run，但 Workflow node 不会伪装成 Task；所有 drift 在 UI 中可见且不自动修复。

---

## Task 7: Propose and then implement narrow Zod runtime schemas

**Objective:** 在协议稳定、真实 E2E 暴露边界后，再为不可信输入增加 runtime validation，不拖慢核心 MVP。

**Files:**
- Review manifest: `package.json`
- Candidate boundaries: `src/projectControl/persistence.ts`, `src/projectControl/taskGraphProjection.ts`, `src/domain/workerQueue.ts`, `src/domain/sideEffects.ts`, Evidence/Acceptance/Receipt persistence modules
- Tests: each affected boundary's existing test file

**Steps:**
1. 先提交/记录范围说明：Evidence/Acceptance/Receipt、WorkerQueue/recovery、ProjectFile/TaskGraph/Event 的收益、包体积和迁移风险。
2. 只选择一个外部 JSON boundary 做 RED→GREEN，例如 side-effect journal 或 ProjectTaskGraph parser。
3. 保留内部 TypeScript 类型；Zod 负责 untrusted decode、safe integer、enum、lineage and unknown-field policy。
4. 验证 legacy migration 是显式的，不以宽松 schema 掩盖旧数据 drift。

**Acceptance:** schema failure 进入 needs-repair/recovery，不把 malformed input 转成空成功状态；未批准的全量迁移不执行。

---

## Task 8: Final reviewer and delivery gate

**Objective:** 让独立 reviewer 针对最终 exact HEAD 返回严格 JSON，并把 verified、unverified、source checkpoint 和 final checkpoint 分开。

**Files:**
- Review all tracked diff from final HEAD against `main`
- Read: `docs/DEVELOPMENT_LOG.md`
- Read/validate: disposable fixture dossier

**Steps:**
1. 先完成所有 E2E 修复和最终 checkpoint。
2. 运行完整质量门：
   - `npm run test`
   - `npm run build`
   - `npm run i18n:check`
   - `cargo test --manifest-path src-tauri/Cargo.toml`
   - `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
   - `git diff --check`
3. 运行敏感模式扫描，所有凭据统一 `[REDACTED]`，不读取或提交秘密文件。
4. 对 exact final HEAD 请求 reviewer 严格 JSON；`interrupted`、截断、解析失败、snapshot drift、API failure、`passed=false` 一律 fail-closed。
5. dossier 同时记录 `executionSourceCheckpoint`、`finalControlPlaneCheckpoint`、E2E receipt、restart read-back、reviewer verdict 和未完成边界。
6. 只有用户明确批准后，才选择 push、开 PR 或合并到 `main`；否则保持本地分支。

**Acceptance:** reviewer 的 snapshot 与最终 HEAD 一致，`security_concerns=[]`、`logic_errors=[]`、质量门和真实 E2E 来自同一工作树；否则保持 `mvp-closed-unverified`。

---

## Risks and Tradeoffs

- 真实 Tauri GUI 依赖 provider、窗口和 host 环境；不可用时必须诚实标记 blocker，不用模拟输出冒充验收。
- Native confirmation 会让 headless 测试不能代表真实 destructive path；需要把“无 UI 的拒绝”和“真实用户确认后的成功”分开记录。
- TaskGraph revision 使用新 graph/Issue ID 会保留旧历史但增加 Issue 数量；后续可再设计 superseded Issue 的视图压缩，不能在本轮删除历史事实。
- Zod 过早全量迁移会增加 legacy compatibility 和包体积风险；只在稳定 boundary 做小范围引入。
- 当前分支未 push/merge；任何合并都必须在最终 reviewer 和用户授权之后进行。

## Final Deliverables

- 可运行的当前分支代码；
- disposable fixture 的 ProjectFile、event stream、Evidence、Acceptance、side-effect、WorkerRun、restart 和 cleanup/recovery read-back；
- `docs/DEVELOPMENT_LOG.md` 新编号条目，记录本轮真实命令结果；
- exact final HEAD 的 reviewer JSON 和明确的 verified/unverified 结论；
- 用户批准后才可能产生的 push/PR/merge 记录。
