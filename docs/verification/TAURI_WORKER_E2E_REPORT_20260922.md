---
title: Tauri Worker 正式 E2E 验收报告
type: verification-report
status: partial-fail
updated: 2026-09-22
fixture: D:/Temp/sm-tauri-acceptance-20260922-v2
---

# Tauri Worker 正式 E2E 验收报告

## 结论

**本轮不能标记为完整 formal acceptance passed。**

已通过的范围是：真实 Tauri GUI 触发的 WorkerQueue success、失败 attempt 的持久化与 retry、attempt-5 的宿主 Acceptance，以及 success 事实在应用进程重启后的 ProjectFile/UI 状态恢复。

未通过/未闭合的范围是：重启后的 live worktree host registration recovery，以及由此依赖的 cleanup proposal、用户批准、CleanupReceipt、TaskCleaned 和 worktree 删除 read-back。成功 worktree 和所有历史失败 worktree 均按要求保留，未执行 Cleanup。

## 验收边界与来源

- 验收日期：2026-09-22。
- 真实窗口：`slime-mold.exe`，通过窗口枚举、fresh capture 和真实 GUI 控件操作验证。
- disposable fixture：`D:/Temp/sm-tauri-acceptance-20260922-v2`。
- 独立 Worker 根：`D:/Temp/sm-tauri-acceptance-20260922-v2-workers`。
- ProjectFile：`D:/Temp/sm-tauri-acceptance-20260922-v2/.slimemold/project.json`。
- Events：`D:/Temp/sm-tauri-acceptance-20260922-v2/.slimemold/events/events.jsonl`，47 行。
- Host Evidence：`D:/Temp/sm-tauri-acceptance-20260922-v2/.slimemold/evidence/host.jsonl`，20 行。
- Acceptance：`D:/Temp/sm-tauri-acceptance-20260922-v2/.slimemold/acceptance/records.jsonl`，5 行。
- 执行时的代码来源是 `HEAD 439a393` 加上当时尚未提交的五文件修复工作树；随后固化为本地 checkpoint `e84492635cee9d2b6e332c0939d396b95e188427`。
- 当前代码 checkpoint：`e844926`；本地回退 tag：`checkpoint/tauri-worker-e2e-evidence-repair-20260922`。未 push、未 merge。
- `e844926` 是代码 checkpoint，尚未获得独立 exact-review `passed=true` verdict；本报告不把它标记为 verified code。

## 结果矩阵

| 范围 | 结果 | 事实依据 |
|---|---|---|
| Vite/Rust/真实窗口启动 | PASS | Tauri 日志出现 Vite ready、Rust build、`Running target\\debug\\slime-mold.exe`；窗口 fresh capture 成功 |
| GUI 打开/关闭项目 | PASS | 真实 GUI 打开 disposable fixture；关闭后显示无项目；再次打开同一 fixture |
| WorkerQueue 真实 success | PASS（attempt-5） | `TaskStarted → TaskSucceeded → RunSucceeded`；同一 lineage 的 4 条 Host Evidence 全部 passed；Acceptance `passed=true` |
| Worker failure observability | PASS（attempt-level） | attempt-1 至 attempt-4 各有 `TaskFailed`、`Acceptance.passed=false` 和 retry decision；未形成独立 terminal `RunFailed` 场景 |
| retry 持久化 | PASS | 4 组 `WorkerRunRecoveryDecided(decision=retry)`、`RunQueued`、新 `TaskQueued(nextAttempt)` 和新 worktree |
| success ProjectFile read-back | PASS | `workerRuns[0].status=succeeded`，attempt=5、worktree、baseRevision、acceptanceId 持久化 |
| success GUI 状态恢复 | PASS | 进程关闭并重新启动后，fresh GUI 自动加载同一 fixture，显示 Worker 已完成 |
| restart live worktree recovery | FAIL | 重新打开项目后的真实 GUI 底部日志：`Worker worktree 未能从 git 恢复登记：task-create-worker-marker` |
| cleanup proposal/approval/receipt | NOT TESTED / BLOCKED | restart host registration 未恢复；未生成可批准 proposal，未点击批准，未执行 destructive cleanup |
| durable recovery CAS | NOT IMPLEMENTED | 仍受 `WORKER_RECOVERY_DECISION_CAS_DESIGN.md` design gate 约束 |

## 成功 lineage：attempt-5

| 字段 | 值 |
|---|---|
| `projectId` | `project-tauri-worker-verify` |
| `runId` | `run-eec6094e-1e64-48f9-8505-ad0a9c2ffc5a` |
| `taskId` | `task-create-worker-marker` |
| `taskExecutionId` | `task-execution:run-eec6094e-1e64-48f9-8505-ad0a9c2ffc5a:task-create-worker-marker` |
| `attemptId` | `task-execution:run-eec6094e-1e64-48f9-8505-ad0a9c2ffc5a:task-create-worker-marker:attempt-5` |
| `worktreeId` | `worker-w-f0bef61bfede25d72feb5ab9` |
| `worktreePath` | `D:/Temp/sm-tauri-acceptance-20260922-v2-workers/w-f0bef61bfede25d72feb5ab9` |
| `branch` | `worker/w-f0bef61bfede25d72feb5ab9` |
| `baseRevision` | `a02f6c0b8c84d09703c42f483594aa42be339570` |
| `acceptanceId` | `acc-muczsxg1-9bafef2d` |
| `evidenceIds` | `ev-25470463-0534-4c66-8ddc-b9e7829a2c3a`, `ev-075cb5dd-4a3a-4439-8152-b6ed8256d7ae`, `ev-989884ad-43c9-4245-9dac-be0e71228df6`, `ev-0618e8e7-230d-498f-88a6-d1a5fa3408bc` |

Attempt-5 的持久化链：

```text
TaskStarted   event 45
→ TaskSucceeded event 46
→ RunSucceeded  event 47
```

Host Evidence 的第 17–20 行分别为：compile passed、tests passed、diff passed、path-policy passed。Acceptance 的第 5 行为 `passed=true`。Worker worktree 中真实文件 read-back 为：

```text
SlimeMold Tauri Worker E2E passed.
```

`git worktree list --porcelain` 和 worktree `git status --short --branch` read-back 确认 attempt-5 worktree 仍存在，当前为 `## worker/w-f0bef61bfede25d72feb5ab9`，`?? docs/`。

## 失败与 retry lineage

四个失败 attempt 均属于同一个 `runId/taskId/taskExecutionId`，没有与成功 attempt 混淆：

| attempt | worktree | Acceptance | 失败事实 |
|---:|---|---|---|
| 1 | `w-f4befc67fade1f8b33eb6105` | `passed=false` | compile/tests/diff；host program resolution rejected untrusted executable |
| 2 | `w-f5befdfafbde211e30eb5c4c` | `passed=false` | compile/tests；Windows path not found |
| 3 | `w-f6beff8dfcde22b131eb5ddf` | `passed=false` | compile/tests passed，但 diff failed，未形成可验收 closure |
| 4 | `w-efbef488fdde24442eeb5926` | `passed=false` | compile/tests passed，但 host diff failed：`process is not defined` |
| 5 | `w-f0bef61bfede25d72feb5ab9` | `passed=true` | compile/tests/diff/path-policy 全部通过 |

Events 18、25、32、39 是四次 `TaskFailed`；Events 20、27、34、41 是四次用户选择的 `retry` recovery decision；Events 22、29、36、43 是对应的 next-attempt queue facts。

因此，本轮证明了 task-level failure、失败 Acceptance 保留和 retry attempt 生成；没有把 retry 链误写成 terminal `RunFailed`。

## 重启与 recovery 结果

执行了两层真实 GUI 生命周期验证：

1. 使用真实窗口关闭入口，fresh window enumeration 确认窗口消失，Tauri dev session 退出。
2. 重新启动 Tauri，fresh capture 确认同一 fixture 自动加载；轻量工作台显示 `Worker 已完成`，ProjectFile 仍为 `workerRuns.status=succeeded`。
3. 再通过真实 GUI `文件 → 关闭项目`，然后从最近项目列表重新打开同一 fixture。
4. 重新打开后的真实 GUI 底部日志记录：

```text
Worker worktree 未能从 git 恢复登记：task-create-worker-marker
```

这意味着 ProjectFile/UI success projection 能恢复，但当前 Tauri host 没有把 live worktree 重新登记到新的 host generation；不能把它称为完整 Worker restart recovery。

根因证据来自代码链：

- `src/projectControl/workerWorktreeRestore.ts:41-53` 在 native restore 返回 false 时只写出上述 warning；
- `src/dev/session.ts:425-445` 的 Tauri `manager.restore` 在 `dev_restore_worktree` 失败时返回 false；
- `src-tauri/src/authority/worktree.rs:795-812` 的 `dev_restore_worktree` 要求当前 host generation 中已有 matching trusted target registration；该 registration 位于 native host 内存状态，进程重启后不存在。

这是 durable recovery/CAS 设计尚未闭合的真实产品边界，不是通过修改 ProjectFile 或手工注册 worktree 来绕过的环境假象。

## Cleanup 状态

Cleanup 按安全规则没有执行：

- 没有 cleanup proposal；
- 没有用户批准记录；
- 没有 `CleanupReceipt` / `worktree-cleanup` side-effect；
- 没有 `TaskCleaned` event；
- `.slimemold` 递归 read-back 未发现 `CleanupReceipt`、`cleanupReceipt`、`TaskCleaned` 或 `worktree-cleanup`；
- 5 个 Worker worktree 均保留，成功 worktree 未被自动删除。

当前 worktree 列表包括 fixture 主 worktree 和 5 个 Worker worktree：`w-f4befc67fade1f8b33eb6105`、`w-f5befdfafbde211e30eb5c4c`、`w-f6beff8dfcde22b131eb5ddf`、`w-efbef488fdde24442eeb5926`、`w-f0bef61bfede25d72feb5ab9`。不自动 Cleanup 是本轮的有意安全结果，不是遗漏删除。

## Windows launcher 修复与质量门

修复内容：

- `src-tauri/src/execution/dev_exec.rs`：Windows trusted executable canonical path 对 `\\?\\`/UNC 形式做去前缀归一化；新增带空格路径的 `.cmd` launcher regression。
- `src/dev/capabilities.ts`：Windows runtime detection 不再假设 WebView 中存在 Node `process` global。
- `src/dev/workerAcceptance.ts`：host diff 失败时保留具体错误，而不是错误压缩成“没有变更”。
- 对应 Vitest fixture/test 已补齐。

实际质量门：

- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml dev_exec -- --nocapture`：33 passed、0 failed（70 filtered）；包含 `cmd_launcher_executes_space_path_without_quote_corruption`；
- focused Vitest：2 files、29 tests passed；
- full `npm run test -- --reporter=dot`：202 test files、1344 tests passed；
- `npx tsc --noEmit`：通过；
- `npm run build`：通过；保留既有 dynamic/static import 与大 chunk warnings；
- `npm run i18n:check`：1026/1026 keys 对齐；
- `git diff --check`：通过；
- 最终代码 checkpoint 工作树：clean；tag 指向 `e844926`。

这些质量门不能替代 restart recovery、CleanupReceipt 或 exact reviewer verdict。

## Setup deviation 与限制

v2 fixture 的 clean baseline 在早期 GUI 操作和一次模板 events 复制中已被消耗：events 前 12 行不是本轮 Worker run 的空基线事实。因此本报告不声称“从完全空的事件流开始”，也没有把前 12 行纳入 Worker success/failure 证据。runtime Worker chain 从 event 13 `ExecutionDraftApproved`、event 14 `RunCreated` 开始。

未验证项：

- 独立 terminal `RunFailed` 场景；
- restart 后 live worktree re-registration success；
- cleanup proposal/approval/CleanupReceipt/TaskCleaned；
- durable recovery decision CAS；
- delivery merge/push；本轮未 merge、未 push；
- e844926 的独立 exact-review `passed=true`。

## 最终判定

```text
startup pass                         ✅
GUI project lifecycle pass           ✅
Worker task failure + retry facts    ✅
Worker success attempt-5             ✅
ProjectFile/events/Evidence readback ✅
GUI/UI success after restart         ✅
Worker live recovery after restart   ❌
Cleanup closure                      ⏸ blocked / not tested
Durable recovery CAS                 ⏸ design gate
FULL FORMAL ACCEPTANCE               ❌ not closed
```
