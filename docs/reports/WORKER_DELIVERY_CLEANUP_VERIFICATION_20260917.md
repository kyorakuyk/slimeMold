# Worker Delivery 与 Cleanup Proposal Verification

日期：2026-09-17

## Provenance

- Delivery execution source checkpoint：`ab74d13b443ea270a9fc0b0613ac8022c2ededc6`。
- 本轮控制面修复起点 checkpoint：`5b874dea4e4226005f5f19c503d44681c9517f9e`。
- Delivery/Proposal 使用同一 disposable fixture；没有写入 SlimeMold 生产项目，没有 push、merge 或 Cleanup。

## 真实 DeliveryReceipt

Fixture：`D:/Temp/sm-tauri2-recovery-v2-174611`

- source Worktree：`D:/Temp/sm-tauri2-recovery-v2-174611-workers/w-92fbfecb4bff7a8f8aca59dd`
- destination：`D:/Temp/slimemold-delivery-dest-20260917-181500`
- Run：`run-141182f4-5590-444a-8987-4fd2f419bfeb`
- Task：`task-create-worker-marker`
- attempt：`task-execution:run-141182f4-5590-444a-8987-4fd2f419bfeb:task-create-worker-marker:attempt-2`
- Acceptance：`acc-mu5cm748-b24a9dda`，`passed=true`，`failedChecks=[]`
- Candidate：`candidate-tauri-worker-attempt-2-20260917`
- Approval：`approval-tauri-worker-attempt-2-20260917`
- Receipt：`artifact-delivery:candidate-tauri-worker-attempt-2-20260917:receipt`
- Delivery file：`docs/WORKER_E2E_OK.txt`
- source/content hash：`h16fxepq`
- delivery output hash：`h8tva18`
- outcome：`succeeded`

真实 read-back：destination 文件存在，内容为 `SlimeMold Tauri Worker E2E passed.\n`；side-effect journal status 为 `ok`，artifact-delivery entry 为 `status=receipt`、`recovery=skip`。对同一 candidate/approval 的第二次调用返回完全相同的 receipt（`receiptsEqual=true`），没有覆盖已有文件。

原始执行摘要保存在仓库外 disposable 记录：`D:/Temp/slimemold-delivery-e2e-20260917.json`。该记录不含凭据。

## 本轮发现并修复的控制面问题

1. `artifact-delivery` side-effect 原先被 `auditWorkerRunConsistency` 当成 `worker-execution` 校验，合法 DeliveryReceipt 会让启动审计失败并清空 Cleanup proposals。现在单独校验 Delivery receipt identity、Acceptance lineage、receipt id、candidate/approval、outputHash 和 files；伪造 Acceptance 仍 fail-closed。
2. 重启后的 live Worktree 原先只恢复 JS `WorktreeManager`，Rust host registry 没有合法的恢复入口；新增 `dev_restore_worktree`，只接受受控 `worker/<basename>`、Git list 中精确匹配的现存 worktree，不复用“本次 host 创建 pending lease”的创建命令。
3. Rust 主仓库只读 Git gate 补充安全的 `worker/<safe-name>^{commit}` branch-tip probe，支持重启后 Cleanup proposal 捕获 branch revision；仍拒绝 `main`、路径穿越和写操作。
4. 独立 reviewer 复审发现两项 fail-closed 问题并已修复：DeliveryReceipt 现在共享严格 shape validator，要求当前 passed 且 `failedChecks=[]` 的 Acceptance、由 idempotency key 派生的 candidate ID、非空 approval/output hash、safe unique files 和可重算 outputHash；Rust 主仓库所有特殊 allowlist 分支显式要求 `args[0] == git`，阻断 node/tsx 命令混淆。

## Tauri Cleanup proposal read-back

重新启动 Tauri、通过产品的项目入口加载同一 fixture、进入“编排”并打开已完成 Run 后，真实 WebView 文本为：

```text
清理提案: 已通过绑定检查，等待宿主批准 · acc-mu5cm748-b24a9dda
批准清理
```

同时显示 attempt 2 的 Worktree、4 条 Host Evidence、Worker execution receipt 和 artifact-delivery receipt。当前 proposal 已绑定：Run/Task/Execution/Attempt、worktree/branch/baseRevision、Acceptance、stage、live branch revision 和 worktree state signature。

## 明确未完成的破坏性动作

- 没有点击“批准清理”；
- 没有执行 `CleanupReceipt`；
- 没有删除 Worktree 或 branch；
- 没有 merge、push 或自动 Cleanup。

因此本报告验证的是 **DeliveryReceipt + restart 后 Cleanup proposal ready**，不是 CleanupReceipt 或删除成功。

## 质量门

- `npx tsc --noEmit`：通过；
- `npm run build`：通过；既有 Vite chunk/dynamic-import warning 保留；
- `npm run i18n:check`：1026 keys，en-US/zh-CN 对齐；
- `npm run test`：127 test files / 1101 tests passed；
- `git diff --check`：通过；
- `cargo check --manifest-path src-tauri/Cargo.toml`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：51 passed / 0 failed；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：未通过，仍报告 `src-tauri/src/lib.rs` 的既有格式漂移；本轮没有对无关 Rust 代码做全文件重排。

## Remaining boundary

下一步若要闭合 Cleanup debt，需要用户明确批准当前 proposal 的破坏性 Cleanup；批准后仍需 read-back Worktree、branch ref、CleanupReceipt、side-effect journal、ProjectFile/TaskCleaned 和目标 Delivery 文件。Antigravity E2E、Browser Use managed backend、历史 commit 标题重写仍未验证。
