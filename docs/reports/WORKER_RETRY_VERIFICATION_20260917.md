# Worker Retry Attempt Verification

日期：2026-09-17
执行源 checkpoint：`79dae6c66132c65960b99397f44b835d83b6a66d`（当前 HEAD；生产源代码仍来自已验证 frontend checkpoint `f2b03db`）
状态：本地 disposable fixture；不 push、不 merge、不 Cleanup

## Fixture

- fixture：`D:/Temp/sm-tauri2-recovery-v2-174611`
- baseline：`3be065ee082a5c4c10c1c3f0c11226154485b1f5`
- task：`task-create-worker-marker`
- run：`run-141182f4-5590-444a-8987-4fd2f419bfeb`
- 初始 worker projection：`workerRuns=0`
- 初始事件：19 条合法 checksum 事件
- 初始 side-effect：attempt 1 为 `status=unknown`、`recovery=needs-user`、`unknownReason=worker-run-restarted`
- 初始 worktree：`D:/Temp/sm-recovery-wt-174611`

## Recovery UI

真实 Tauri 重启后，轻量工作台显示 recovery gate：

- `Worker 等待恢复核对`；
- 不自动重跑；
- retry：创建新的 attempt/worktree，不复用旧副作用 key；
- skip：保留当前结果，不重复执行未知副作用。

通过真实 UI 点击“确认重试新 attempt”。

## Attempt 2 read-back

- Run status：`succeeded`
- Task status：`succeeded`
- attempt：`2`
- attempt ID：`task-execution:run-141182f4-5590-444a-8987-4fd2f419bfeb:task-create-worker-marker:attempt-2`
- worktree：`D:/Temp/sm-tauri2-recovery-v2-174611-workers/w-92fbfecb4bff7a8f8aca59dd`
- branch：`worker/w-92fbfecb4bff7a8f8aca59dd`
- base revision：`3be065ee082a5c4c10c1c3f0c11226154485b1f5`
- attempt 1 的 unknown side-effect 仍保留；attempt 2 使用不同 idempotency key
- Git worktree 真实存在；marker 文件真实内容：`SlimeMold Tauri Worker E2E passed.`
- worktree Git status：`?? docs/WORKER_E2E_OK.txt`；该 marker 是未跟踪文件，因此 `git diff --check` 不会覆盖它；“1 个实际变更文件”和 path-policy 通过来自 Host Evidence `ev-db812867-58ad-4483-887b-755649f0483e`、`ev-61a60f86-51cd-49c7-a6d9-32482c03ffe7`；

Host Evidence：

| kind | result | id |
|---|---|---|
| compile test | exit code 0 | `ev-ae4d8fcd-2ee1-4863-a842-a14950dbf818` |
| test | exit code 0 | `ev-49f68415-ef51-4eb9-a100-952df647c424` |
| diff | 1 actual changed file | `ev-db812867-58ad-4483-887b-755649f0483e` |
| path-policy | 1 changed file passed | `ev-61a60f86-51cd-49c7-a6d9-32482c03ffe7` |

Acceptance：

- ID：`acc-mu5cm748-b24a9dda`
- `passed: true`
- `failedChecks: []`
- stage：`construction`
- attempt：2
- Evidence/Acceptance 均绑定当前 run、task、execution、attempt 和新 worktree。

事件流最终为 26 条，尾部顺序为：

```text
WorkerRunRecoveryDecided
RunQueued
TaskQueued
RunStarted
TaskStarted
TaskSucceeded
RunSucceeded
```

## 已验证范围

本轮真实证明：

- 重启后的 failed/unknown Worker 可以通过用户明确 retry 进入新 attempt；
- retry 会清除旧 worktree assignment，创建新 worktree/branch/attempt/idempotency key；
- 独立 Worker 在新 worktree 产生真实文件；
- Host build/test/diff/path-policy Evidence 和 Acceptance 绑定新 attempt；
- Run/Task 最终成功，不依赖旧 attempt 的结果或副作用 receipt。

## 未验证范围

本轮没有宣称：

- Delivery assembly 或用户批准后的 Cleanup/CleanupReceipt；
- Antigravity Runtime E2E；
- Browser Use managed backend；
- 主仓库 merge/push；
- 成功 worktree 已被 Cleanup；
- 历史 `(unverified)` commit 被重写或逐笔变成 verified。
