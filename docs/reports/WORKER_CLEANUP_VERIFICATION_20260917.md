# Worker Cleanup Receipt Verification

日期：2026-09-17

## 结论

当前已批准的 disposable fixture Cleanup 已完成。本次操作通过真实 Tauri WebView 触发；native host confirmation 的 UI 观察未单独归档，属于 manual observation，最终 Cleanup closure 以 durable side-effect、event、ProjectFile、Filesystem/Git 和 Delivery read-back 为准。清理范围仅为 attempt 2 的 Worker Worktree 及其对应 branch；没有删除主仓库、Delivery destination、其他审计 fixture，没有 push 或 merge。

本报告是 `docs/reports/WORKER_DELIVERY_CLEANUP_VERIFICATION_20260917.md` 之后的后续闭合记录。前一份报告中“proposal 已生成但尚未执行”的描述保留为当时的历史事实，不作改写。

## Scope 与授权边界

- execution source checkpoint：`991639481db46375cc0995a140c4da9a456258dd`（`9916394 [verified] fix: close delivery and restart cleanup gates`）。
- 文档记录前的本地 checkpoint：`f111d68 chore: checkpoint before cleanup closure record`。
- disposable fixture：`D:/Temp/sm-tauri2-recovery-v2-174611`。
- 仅允许的 Worktree：`D:/Temp/sm-tauri2-recovery-v2-174611-workers/w-92fbfecb4bff7a8f8aca59dd`。
- 仅允许的 branch：`worker/w-92fbfecb4bff7a8f8aca59dd`。
- 用户批准覆盖：当前已审查的 attempt 2 Cleanup proposal；不扩展到生产目录、主仓库、其他 Worktree、push、merge、Antigravity 或历史 commit 重写。

## 执行前绑定

Acceptance durable read-back：

- `acceptanceId`：`acc-mu5cm748-b24a9dda`。
- `passed`：`true`。
- `failedChecks`：`[]`。
- `runId`：`run-141182f4-5590-444a-8987-4fd2f419bfeb`。
- `taskId`：`task-create-worker-marker`。
- `taskExecutionId`：`task-execution:run-141182f4-5590-444a-8987-4fd2f419bfeb:task-create-worker-marker`。
- `attemptId`：`task-execution:run-141182f4-5590-444a-8987-4fd2f419bfeb:task-create-worker-marker:attempt-2`。
- `baseRevision` / approved branch revision：`3be065ee082a5c4c10c1c3f0c11226154485b1f5`。
- 4 条 Host Evidence 均为 `passed`：`npm run build`、`npm run test`、diff、path-policy。

执行时通过产品编排页面依次触发“批准清理”和“执行清理”。Tauri native confirmation dialog 的 path、branch 和 revision UI read-back 与获批目标一致；该对话框观察未单独归档，属于 manual observation，确认后才继续执行。最终结果由 durable side-effect、event、ProjectFile、Filesystem/Git 和 Delivery read-back 交叉核对。

## CleanupReceipt durable read-back

fixture：`D:/Temp/sm-tauri2-recovery-v2-174611/.slimemold/runs/side-effects.json`

```text
kind: worktree-cleanup
idempotencyKey: cleanup:task-execution:run-141182f4-5590-444a-8987-4fd2f419bfeb:task-create-worker-marker:attempt-2
target: D:/Temp/sm-tauri2-recovery-v2-174611-workers/w-92fbfecb4bff7a8f8aca59dd
inputHash: 3be065ee082a5c4c10c1c3f0c11226154485b1f5:hxymq3c
runId: run-141182f4-5590-444a-8987-4fd2f419bfeb
taskId: task-create-worker-marker
taskExecutionId: task-execution:run-141182f4-5590-444a-8987-4fd2f419bfeb:task-create-worker-marker
attemptId: task-execution:run-141182f4-5590-444a-8987-4fd2f419bfeb:task-create-worker-marker:attempt-2
status: receipt
recovery: skip
receiptId: cleanup:task-execution:run-141182f4-5590-444a-8987-4fd2f419bfeb:task-create-worker-marker:attempt-2:receipt
observedAt: 2026-09-17T13:50:36.322Z
outputHash: hxymq3c
outcome: succeeded
```

Receipt 的 execution/attempt、target、inputHash 和 idempotency key 均与当前 Task/Attempt 绑定。Acceptance 绑定同时由 Acceptance record、`TaskCleaned` event 和 ProjectFile projection 保存并交叉核对。

## 删除结果与控制面 read-back

真实 host/UI 和磁盘/Git read-back 结果：

- Worktree 目录不存在：`worktree_exists=false`。
- Worktree 内的未跟踪 marker 随源 Worktree 一并消失；这正是本次获批删除范围内的内容。
- `worker/w-92fbfecb4bff7a8f8aca59dd` branch ref 不存在。
- 主仓库 `git worktree list --porcelain` 不再列出该 Worktree。
- ProjectFile 中该 Task 为 `status=succeeded`、`worktreeStatus=cleaned`、`cleanupStatus=cleaned`，并保存上述 `cleanupReceiptId`。
- Event stream 共 27 条；末尾事件为 `TaskCleaned`，`sequence=27`，`cleanupStatus=cleaned`，receipt ID 与 side-effect journal 一致。
- `TaskCleaned` 事件数量为 1；`worktree-cleanup` side-effect entry 数量为 1，没有重复 Cleanup 事实。
- UI read-back 为：`清理提案: 已清理 · cleanup:task-execution:run-141182f4-5590-444a-8987-4fd2f419bfeb:task-create-worker-marker:attempt-2:receipt`；页面没有再次显示 Cleanup 按钮。
- Delivery destination 仍存在，`D:/Temp/slimemold-delivery-dest-20260917-181500/docs/WORKER_E2E_OK.txt` 仍可读，内容为 `SlimeMold Tauri Worker E2E passed.`。
- attempt 1 的 `unknown/needs-user` worker-execution side-effect、失败事件和失败 provenance 均保留；attempt 2 的 4 条 Host Evidence 与唯一的 `passed=true` Acceptance 记录保留。
- 其他审计/失败 fixture 仍存在：`D:/Temp/sm-tauri2-recovery-v2-153618`、`D:/Temp/sm-tauri2-recovery-v2-154444`、`D:/Temp/slimemold-verified-closure-20260917-142509`。

## 重复 Cleanup 安全性

重复 Cleanup 没有产生新的破坏性事实：

1. 清理后的真实 UI 将 proposal 投影为 terminal `已清理` 状态，没有再次执行入口。
2. 当前 `buildWorkerCleanupProposal` 对已清理 Task 只返回 `status=cleaned`，不会重新生成 ready proposal；对应定向测试为 `projects a cleaned task as a terminal proposal instead of asking to clean it again`。
3. `executeWorkerCleanupWithReceipt` 对 `proposal.status === 'cleaned'` 直接拒绝重复执行；对已有 canonical receipt 只接受完全匹配的 key、lineage、target、inputHash、receipt ID、`recovery=skip`、`outcome=succeeded` 和 outputHash。旧版 legacy cleanup key 可在 receipt envelope 未携带显式 `taskExecutionId`/`attemptId` 时兼容迁移；若这两个字段存在则必须与当前 proposal 匹配，同时仍须满足 kind、run/task、target、inputHash、legacy receipt ID、`recovery=skip`、成功 outcome 和 state-signature outputHash，迁移时补写 canonical lineage/key/receipt ID；其他状态和绑定不一致均 fail-closed。
4. 真实 durable read-back 中 CleanupReceipt 和 `TaskCleaned` 各只有一条；没有第二个 branch deletion、第二个 receipt 或第二个 `TaskCleaned` event。

## 未扩展的范围

- 未删除主仓库或任何非获批 Worktree。
- 未执行 push 或 merge。
- 未清理 Delivery destination。
- 未将失败 fixture 改写为成功。
- Antigravity 真实 Agent Worker E2E、Browser Use managed backend 和历史 commit 标题重写仍未闭合。

## 质量门

本报告写入后运行并在此更新真实结果：

- `npx tsc --noEmit`：通过；
- `npm run build`：通过；本轮仍有多处 dynamic/static import warning，主 bundle `index-CIus0AVq.js` 为 `1,145.37 kB`，保留 Vite 大 chunk warning；
- `npm run i18n:check`：`1026 keys`，en-US/zh-CN 对齐；
- `npm run test`：`127 test files / 1101 tests passed`；包含 Cleanup proposal/receipt 定向测试；
- `git diff --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：`51 passed / 0 failed`；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：未通过，仍报告 `src-tauri/src/lib.rs` 的既有格式漂移；本轮没有全文件重排；

本报告不把 staged 文档状态写成已提交；只有最终 reviewer 通过并完成本地 commit/read-back 后，commit message 才使用 `[verified]`，且仍不代表已 push 或 merge。
