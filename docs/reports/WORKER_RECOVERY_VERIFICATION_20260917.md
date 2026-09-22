# Worker Restart/Recovery Read-back

日期：2026-09-17
执行源 checkpoint：`43fbcb6973e325df5195a9417d570a2e724faa10`（当前 HEAD；源代码来自其父提交 `f2b03db`）
状态：本地 disposable fixture；不 push、不 merge、不 Cleanup

## Fixture 前置事实

- fixture：`D:/Temp/sm-tauri2-recovery-v2-154444`
- fixture baseline：`3be065ee082a5c4c10c1c3f0c11226154485b1f5`
- Worker worktree：`D:/Temp/sm-recovery-wt-154444`
- branch：`worker/recovery-154444`
- task：`task-create-worker-marker`
- run：`run-141182f4-5590-444a-8987-4fd2f419bfeb`
- task execution：`task-execution:run-141182f4-5590-444a-8987-4fd2f419bfeb:task-create-worker-marker`
- attempt：`...:attempt-1`

fixture 在加载前经过 read-back：

- ProjectFile `workerRuns`：`0`
- `.slimemold/events/events.jsonl`：19 条合法 checksum 事件
- `.slimemold/runs/side-effects.json`：1 条 Worker receipt，`outcome=failed`、`recovery=skip`
- `.slimemold/evidence/host.jsonl`：空
- `.slimemold/acceptance/records.jsonl`：空
- worktree：真实存在，branch 和 base revision 与事件中的 Attempt 一致
- ProjectFile 保留批准且版本匹配的 TaskGraph

这些重启前字段来自执行前的只读工具 read-back；没有把它们伪造成产品 Evidence，原始前置 JSON 未单独归档。

另有失败 fixture `D:/Temp/sm-tauri2-recovery-v2-153618`：为替换路径而未重算 event checksum，当前 HEAD 正确将其按 corrupted event stream fail-closed，未恢复 `workerRuns`。该失败现场保留，不能当作产品成功或产品失败的替代证据。

## 真实重启 read-back

1. 通过真实 Tauri WebView 打开 v3 fixture；
2. 结束当前 Tauri 进程和 Vite 子进程；
3. 以同一 current HEAD 重新启动 `npm run tauri dev`；
4. 应用从 `sm.lastSession` 恢复同一 fixture；
5. 读取 UI、ProjectFile、事件流、side-effect journal 和 Git worktree。

重启后的事实：

- UI 显示 `Worker 等待恢复核对`；
- UI 显示“检测到项目重开时未闭合的 Worker lease；在核对副作用 Evidence 前不会自动重跑”；
- UI 暴露“重试：创建新的 attempt/worktree，不复用旧副作用 key”和“跳过：保留当前结果，不重复执行未知副作用”；
- ProjectFile `workerRuns` 从 `0` 重建为 `1`；
- Run 状态：`partial`；
- Task 状态：`failed`；
- Attempt 仍为 `1`，`currentAttemptId` 未改变；
- Worktree path、branch、base revision、`worktreeStatus=created` 均真实恢复；
- 原始事件仍为 19 条，没有自动创建新 Run/Attempt；
- `workerRuns` 不是空壳，包含原始失败 error、TaskGraph lineage 和 worktree binding。

## 明确 skip 决策 read-back

通过真实 recovery UI 点击“确认跳过任务”后：

- 事件数从 19 增至 20；
- 新事件：`WorkerRunRecoveryDecided`；
- `decision`：`skip`；
- `requiresNewAttempt`：`false`；
- `effectKeys`：`[]`；
- `taskIds`：[`task-create-worker-marker`];
- ProjectFile task error 更新为 `恢复决策 skip：用户在项目驾驶舱选择 skip`；
- Attempt 仍为 `1`，没有新 worktree、branch 或副作用 key；
- side-effect journal 仍为 1 条，`recovery=skip`；
- 原 Worker worktree 仍保留；没有 Cleanup、merge 或 push。

## 已验证范围

本轮证明了当前 HEAD 的：

- durable event stream + 空 `workerRuns` projection 的启动重建；
- failed Worker Attempt、worktree、branch、base revision 和 error 的 lineage 恢复；
- recovery UI 的 inspect/retry/skip 边界可见；
- skip 决策写入 DomainEvent、ProjectFile，并保持 attempt fence 不变；
- corrupted checksum stream 会 fail-closed，不会自动制造成功状态。

## 未验证范围

本轮没有宣称：

- retry 创建新 attempt/worktree 的真实 GUI E2E；
- 成功 Worker 的 Delivery、Cleanup proposal 或 CleanupReceipt；
- Antigravity Runtime E2E；
- Browser Use managed backend；
- 主仓库或 disposable worktree Cleanup；
- 历史 `(unverified)` commit 被重写或逐笔变成 verified。
