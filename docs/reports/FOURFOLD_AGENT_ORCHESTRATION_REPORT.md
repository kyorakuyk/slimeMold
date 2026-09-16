# Fourfold Agent 编排验收—修复报告

> 回顾性报告，更新于 2026-09-16。本文依据 SlimeMold Git 提交、online disposable `.slimemold` 事件流、Worker Evidence、真实 worktree、命令输出和 Delivery receipt 编写。它不是把计划或截图当成成功证明的宣传稿。

## 1. 结论先行

本轮证明了两件不同的事实：

1. **SlimeMold 控制面修复真实通过质量门。** 最新主仓库质量门：`npm run build` 通过；`npm run i18n:check` 为 1011 keys 对齐；`npm run test` 为 126 个测试文件、1097 个测试通过；`git diff --check` 通过。相关 Rust dev-exec targeted 为 24/24。
2. **原始 parallel Worker Run 没有形成 verified 的产品交付。** Durable Run `run-7db0134c-0f0f-4e5f-b8de-050b8e4789c3` 最终仍为 `partial`：9 succeeded、2 failed、2 blocked。失败任务是 `task_unit_tests` 和 `task_integration_tests`，阻塞任务是 `task_browser_acceptance` 和 `task_docs`。没有把这个 Run 标为 `[verified]`。

为得到可运行的 disposable 产品，进行了**明确标注的 Manager Delivery Assembly**：在 `C:/Users/rnfmabj/Documents/SlimeMold/Fourfold-online-session` 中写入一个独立、纯浏览器、localStorage、本地 HTTP server 的 Fourfold 交付面，并提交：

```text
81ca600 feat: assemble runnable Fourfold delivery surface
002306f docs: record manager delivery receipt and limits
```

该 assembly 的 `npm test`、`npm run build` 和 HTTP `200` smoke 通过，但 Browser Use backend 无法启动 Chromium，现有 Chrome GUI 也没有形成已验证的 localhost 页面读回。因此 Manager Assembly 也没有被标为完整 browser-verified delivery。

Durable receipt：

```text
C:/Users/rnfmabj/Documents/SlimeMold/Fourfold-online-session/artifacts/online-master/manager-delivery-receipt.json
```

## 2. 目标闭环与实际边界

目标闭环是：

```text
Codex Master
→ Brief / Architecture / TaskGraph / Execution Plan
→ 用户确认
→ 一个 durable Worker Run
→ Worker worktree
→ 真实代码
→ Host Acceptance
→ Evidence / Acceptance
→ Delivery / Git
→ Restart / Recovery
```

本轮实际完成：

- Master planning 事实仍保留：Brief、Architecture、TaskGraph、Execution Plan 已确认；
- 一个 Run 内确实并行调度多个 task-level Worker worktree；
- Worker Run 进入过真实 `RunStarted`、`TaskStarted`、Host Acceptance 和 Evidence；
- 9 个 Task 曾真实通过 Host Acceptance；
- 多轮 Restart/Recovery 产生了 durable recovery events；
- Manager Assembly 产品具备真实文件、Git commit、Node test/build 和 HTTP server；
- 主仓库控制面修复通过完整测试。

尚未完成：

- 原始 parallel Worker Run 没有全绿；
- 没有对 Worker 成功 task 做最终统一 merge/Delivery lineage；
- Browser/Tauri 产品验收没有完成；
- `task_unit_tests` / `task_integration_tests` 的真实失败没有被伪造成成功；
- browser acceptance 与 docs 仍 blocked；
- 没有 Cleanup；所有 Worker worktree 保留；
- 没有 push，也没有合并到主 SlimeMold 分支。

## 3. 真实事件时间线

### 3.1 初次真实 Run

online disposable project：

```text
C:/Users/rnfmabj/Documents/SlimeMold/Fourfold-online-session
```

Run：

```text
run-7db0134c-0f0f-4e5f-b8de-050b8e4789c3
```

最初读回：

```text
RunCreated       sequence 230
TaskQueued       sequence 231–243
RunStarted       sequence 244
TaskStarted      sequence 245–247
```

当时是 `running: 3 / queued: 10`。这证明了真实 Worker 启动，不证明产品完成。

### 3.2 第一轮失败：宿主 policy 与锁

第一轮真实 acceptance 发现：

- scaffold/storage 的变更被主仓库 self-development policy 当成 protected/out-of-bounds；
- engine/random 在 side-effect journal 上遇到 stale lock timeout；
- blocked descendants 被正确阻塞。

修复：

- Worker Acceptance 使用 approved Task scope 生成 disposable target 的 task policy；保留 `.slimemold/**` 与 `artifacts/**` 控制面保护；
- Tauri EventStore 增加进程内 per-lock FIFO，避免同一 Tauri command 线程上 `event_lock_acquire` 阻塞 release IPC；
- Rust 与 TypeScript 两侧保留独立 command enforcement。

### 3.3 Restart/recovery：发现并修复 durable 漂移

在 recovery 后重启，先后发现：

1. `workerRunRecoveries` 只恢复 unfinished side-effect，不暴露无 journal 的 failed/running Task retry；
2. `WorkerRunRecoveryDecided` 并发 flush 造成同一 eventId 内容冲突；
3. `TaskQueued(nextAttempt=1)` 首次 retry fence 被误判为不连续；
4. 事件重放没有正确处理 `RunQueued`；
5. 重复 recovery click 产生相同 pending retry fence，projection仍保持 blocked；
6. ProjectFile 中 terminal Task 保留 `pendingAttempt`，导致 `Worker Task pendingAttempt 无效`。

修复后：

- recovery plan 支持 failed/running Task 无 side-effect journal 的显式 retry；
- TaskGraph blocked descendants 递归释放；
- event buffer 按 project 串行 flush，并把 sequence/aggregateVersion/appendGeneration/checksum/occurredAt作为 persistence metadata处理；
- duplicate retry fence幂等重放为 queued state；
- ProjectFile startup reconciliation覆盖 stale retry snapshot；
- terminal Task 和 `TaskBlocked` 清除 pending fence。

这些修复都添加了 targeted regression tests，并多次 checkpoint commit。

### 3.4 Windows Host Acceptance：从 `-1` 到真实 `exitCode=0`

Host Evidence 多轮暴露 Windows 执行链问题：

1. Rust 只读 main-repo gate 缺少 `git show-ref --verify refs/heads/worker/w-*`；
2. JS capability 层增加 scoped `node --check` / `tsc --noEmit --target es2020` 后，Rust 顶层 `DEV_ALLOWED_CMDS`仍没有 `node`；
3. Rust `Command::new(.cmd)`不能直接执行 Windows command shim；
4. Tauri disposable baseRepo没有 node_modules，工具 resolver找不到 `tsc.cmd`；
5. `.cmd` `/C` command line 多包了一层引号；
6. task-scoped path policy没有传递给 `testRun`，导致 changed-files通过而命令路径越权；
7. 混合 JS+CSS Task 被误选为 npm build/test，缺少 package.json 的独立 worktree必然失败。

修复后真实 Evidence 出现：

```text
node --check src/main.js                     exitCode=0
tsc --noEmit --target es2020 src/game/random.ts exitCode=0
tsc --noEmit --target es2020 src/game/engine.ts ... exitCode=0
tsc --noEmit --target es2020 src/storage/...     exitCode=0
tsc --noEmit --target es2020 src/app/...         exitCode=0
```

这是本轮最重要的从“统一 -1 假失败/不可诊断”到“宿主真实执行结果”的收口。

## 4. Worker Run 的最终事实

### 4.1 成功部分

在最终 durable read-back 中：

```text
succeeded: 9
failed:    2
blocked:   2
```

成功 task 包括：

```text
task_scaffold
task_engine
task_random
task_storage
task_session
task_view
task_input
task_dialogs
task_bootstrap_restore
```

`task_scaffold` 的真实 Host Acceptance 包括：

```text
node --check src/main.js      exitCode=0
node --check server.mjs       exitCode=0
```

`task_view` 最终也通过了：

```text
node --check src/ui/game-view.js exitCode=0
```

### 4.2 失败与阻塞

```text
task_unit_tests        failed
task_integration_tests failed
task_browser_acceptance blocked
task_docs              blocked
```

失败原因不是统一的一个问题：

- unit test task 的独立 worktree只有测试文件，缺少 `vitest`、源模块和 package manifest；早期 tsc 直接报模块缺失/语法错误，后续 Worker多次没有实际写入文件；
- integration task 多次保持空 worktree，通用 npm build/test 返回 Windows `ENOENT package.json`；
- 因上游失败，browser acceptance/docs 按依赖图正确 blocked。

结论：这暴露了当前 execution model 的结构性边界——Task worktree从共同 baseline 创建，但成功 Worker 的代码没有在下游 Task 前合并或作为 ContextPack/依赖 artifact 注入。TaskGraph 的依赖关系存在，代码谱系没有自动汇合。

## 5. Manager Delivery Assembly

由于 parallel Worker Run没有形成统一可运行产品，Manager在 disposable online主仓库进行了明确标注的 assembly：

- 新增纯 JavaScript 4×4 merge engine；
- 新增 localStorage save/restore、undo、new game、high score；
- 新增键盘/WASD和按钮控制；
- 新增 accessible grid labels 和 responsive CSS；
- 新增严格本地 HTTP server，不允许 path escape；
- 新增 Node标准库 build check/test；
- 写入 README 与 `manager-delivery-receipt.json`；
- 真实 Git commit `81ca600`，文档 commit `002306f`。

验证：

```text
npm test                         passed
npm run build                    passed
curl http://127.0.0.1:4173/     HTTP 200
```

Browser acceptance：

- Browser Use backend initially报告 Chromium missing；
- `npx agent-browser install --with-deps chromium`下载并安装成功；
- Browser Use独立 backend仍报告 Chromium missing；
- 现有 Chrome GUI导航没有形成已验证的 localhost 页面读回；
- 因此 browser acceptance明确为 blocked，不写成 passed。

## 6. 主仓库修复清单与 checkpoint

本轮主要 checkpoint 包括：

```text
bc2a9a9  task-scoped Worker acceptance
5636ebf  partial failed-run recovery
d5a6a69  serialized project event-buffer flush
0075333  first retry attempt fence replay
6e8cce4  serialized project snapshot saves
2e59c92  Tauri FIFO locks and scaffold validation
730658c  scoped code checks in Tauri host
9927fa1  duplicate pending retry fence replay
bdb8215  duplicate queue events as queued state
dccb1c6  stale recovery cannot mask queued Worker
3327f91  Windows command shim wrapper
bb39f5a  host executable tool resolver
f97ed78  host spawn diagnostics
76a0336  main-repo worker branch probe gate
417a5a0  event metadata idempotency
af354c6  task-scope path policy in testRun
2517ce7  clear terminal pending retry fences
e27b260  clear retry fences on TaskBlocked
a350042  mixed static/code validation
b1f4ac8  deferred isolated test-only validation
```

> 上述 commit 均是本地 unverified checkpoint，未 push；它们证明修复落盘和测试执行，不代表外部 Worker Run 已 verified。

## 7. 面试向工程判断

### 7.1 最有价值的失败

最初的 `exitCode=-1` 看起来像 Worker失败，但真实根因分散在：

- cwd所属 gate；
- command allowlist；
- Windows `.cmd` spawn；
- Node工具 resolver；
- task-scoped path policy；
- deterministic event id metadata；
- retry fence与projection；
- 下游 worktree没有上游代码。

如果只看 UI 的“Worker失败”，会错过真正的系统问题。只有把 Host Evidence保存为带 command、cwd、exitCode、stderr/stdout 的 durable record，才能从症状进入根因。

### 7.2 为什么没有把所有失败标绿

因为这会破坏系统最核心的可信边界：

- Worker文本不是验收事实；
- 截图不是产品存在证明；
- TaskSucceeded不是 Delivery；
- Worktree存在不是代码写入；
- 单元测试通过不是浏览器可用；
- Manager assembly不是原始 Worker成功。

### 7.3 下一步真正应该做什么

1. 为下游 Task提供明确的 artifact dependency：成功 Worker commit/patch必须进入依赖 Task 的 base revision或受控 ContextPack。
2. 增加统一 Delivery Worker/merge gate，而不是由 Manager手动拼装多个 worktree。
3. 为 test-only/integration/browser Task建立真实的 disposable product baseline，避免在空 baseline上运行 package scripts。
4. Browser backend可用后重新执行 localhost browser acceptance，并把截图、DOM read-back、Acceptance和Delivery receipt绑定到同一 lineage。
5. 只在 fresh verified run 完成后更新 Evidence index 为 Worker/Delivery complete；保留本轮历史失败现场。

## 8. 最终状态边界

**已实现并验证：** 主仓库质量门、Worker host command/path/recovery修复、9个Task Host Acceptance、Manager assembly Node test/build、HTTP smoke、durable receipt。

**已实现但验证不完整：** Manager assembly的真实浏览器行为、单元测试与integration downstream、Restart后完整产品恢复、Delivery merge lineage。

**未验证/未完成：** 原始 Worker Run完整成功、browser acceptance、docs task、Cleanup、push、主分支merge、reviewer `passed=true`。

报告中的所有成功结论都遵守上述边界。
