# Fourfold Agent 编排验收—修复报告

> 回顾性报告，更新于 2026-09-16。本文依据 SlimeMold Git 提交、online disposable `.slimemold` 事件流、Worker Evidence、真实 worktree、命令输出和 Delivery receipt 编写。它不是把计划或截图当成成功证明的宣传稿。

## 1. 结论先行

本轮证明了两件不同的事实：

1. **SlimeMold 控制面修复真实通过质量门。** 最新主仓库质量门：`npm run build` 通过；`npm run i18n:check` 为 1011 keys 对齐；`npm run test` 为 126 个测试文件、1097 个测试通过；`git diff --check` 通过。相关 Rust dev-exec targeted 为 24/24。
2. **原始 parallel Worker Run 已完成 durable 成功闭环，但未获得 reviewer `[verified]`。** Run `run-7db0134c-0f0f-4e5f-b8de-050b8e4789c3` 最终事件为 `RunSucceeded` sequence 563：13 succeeded、0 failed、0 blocked。历史失败 attempts仍保留在 Evidence/Acceptance JSONL，没有被覆盖。

为得到可运行的 disposable 产品，进行了**明确标注的 Worker-derived Manager Delivery Assembly**：成功 Worker worktree中的产品、integration、browser acceptance、docs产物被组装到 `C:/Users/rnfmabj/Documents/SlimeMold/Fourfold-online-session`，最终提交：

```text
81ca600 feat: assemble runnable Fourfold delivery surface
40fcff6 feat: integrate Worker acceptance and browser delivery artifacts
ef70320 docs: finalize Worker-sourced Fourfold delivery provenance
```

Delivery 的 `npm test`、`npm run build`、integration 5/5、interaction 3/3、HTTP 200 smoke 和真实 Chrome/CDP browser acceptance 均通过。Browser Use managed backend仍未识别 Chromium，但不影响直接 Chrome/CDP验收事实；receipt仍保留该限制和 reviewer未验证状态。

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
- Worker Run 已完成 `RunSucceeded`：13 Task均有最终 Acceptance/Evidence，历史失败 attempts保留；
- 多轮 Restart/Recovery 产生了 durable recovery events，并最终成功重试下游 Task；
- 成功 Worker worktree与dependency artifacts形成了下游代码输入；
- Worker-derived Delivery具备真实文件、Git commit、Node test/build、integration、interaction、HTTP server和Chrome/CDP browser acceptance；
- 主仓库控制面修复通过完整测试。

尚未完成：

- reviewer `passed=true` 与最终 `[verified]` 标记；
- Worker worktree Cleanup；所有 worktree继续保留作为审计现场；
- push或合并到主 SlimeMold 分支；
- Browser Use managed backend仍无法识别 Chromium，但独立 Chrome/CDP browser acceptance已通过。

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

## 5. Worker-derived Manager Delivery Assembly

原始 parallel Worker Run 在 dependency artifact 注入修复后完成 13/13 succeeded；成功 Worktree中的产品与测试产物被组装到 disposable online 主仓库，形成 Delivery commit `40fcff6`。

Delivery包含：

- 4×4 JavaScript merge engine、localStorage、undo、new game、high score；
- 键盘/WASD、按钮控制、accessible grid 和 responsive CSS；
- 本地 HTTP server 与 path escape protection；
- `src/main.js` durable session bootstrap facade；
- integration persistence tests、interaction contract tests、browser acceptance tests和docs；
- README、Delivery receipt、SHA-256 file index。

真实验证：

```text
npm test                                  passed
npm run build                             passed
npm run test:integration                  5/5 passed
npm run test:interaction                  3/3 passed
CHROMIUM_PATH=... npm run test:browser    1/1 passed
curl http://127.0.0.1:4173/              HTTP 200
Chrome                                      152.0.7977.83
```

Browser acceptance 通过独立 Chrome CDP 直接执行，覆盖初始页面、键盘移动、合并、Undo、刷新/服务器重启持久化、offline interaction、storage fallback。Browser Use managed backend仍未识别 Chromium，因此该 backend限制单独保留，不能反推为产品 browser failure。

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

### 7.3 尚余收口

1. 对最终 Worker/Delivery snapshot进行独立 reviewer review，只有同一最终 HEAD 的 `security_concerns=[]`、`logic_errors=[]` 和质量门才能使用 `[verified]`。
2. 用户明确批准前不执行 Cleanup；保留所有成功 Worker worktree、branch和Evidence现场。
3. 不 push、不合并到主 SlimeMold分支；online disposable delivery commit留在本地。
4. Browser Use managed backend仍需单独修复，但独立 Chrome/CDP acceptance已经通过并绑定到 Delivery receipt。

## 8. 最终状态边界

**已实现并验证：** 主仓库质量门、Worker host command/path/recovery修复、13个 Task 全部最终 Acceptance、dependency artifacts注入、Worker Run `RunSucceeded`、Worker-derived Delivery、Node test/build、integration 5/5、interaction 3/3、HTTP smoke、Chrome/CDP browser acceptance、durable receipt。

**已实现但仍需独立复审：** Delivery/Worker最终 snapshot的 reviewer verdict、Cleanup proposal/receipt、主仓库合并/发布策略。

**明确未执行：** Cleanup、push、主 SlimeMold分支merge、reviewer `passed=true`、`[verified]`标记；Browser Use managed backend仍不可用，但这不是直接 Chrome/CDP产品验收失败。