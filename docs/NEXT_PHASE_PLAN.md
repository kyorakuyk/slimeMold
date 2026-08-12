# SlimeMold 下一阶段开发计划

> 版本：2026-08-13
> 依据：远端 `origin/main` H4 审计收口状态
> 目标：从「headless 安全能力已成型」推进到「GUI 可验收、可恢复、可受控自举」

## 一、当前状态

### 已完成

- H2 插件 Worker/UI/IPC 隔离基础已完成。
- H3a/H3b/H3c 主控编排最小闭环已完成：草案、确认门、阶段绑定、执行、失败、取消和进度展示。
- H4 Foundation 已完成：
  - worktree 隔离；
  - 受控代码读取与 unified diff 修改；
  - shell/test 白名单；
  - 宿主真实结果登记；
  - 证据作用域隔离与 JSONL 持久化；
  - 确定性验收；
  - cleanup 三重绑定、互斥锁、状态签名和强制清理审计。
- headless 自举样例已跑通。

### 当前边界

- H4 开发节点尚未接入 Tauri GUI 执行层。
- 动态输入创建的 worktree 尚不能自动获得对应 EvidenceStore。
- `resultStore`、`acceptanceStore`、cleanup approval 仍是内存态。
- H3 遗留：`orch.*` 事件、阶段级 checkpoint、结构化 `runIds`。
- 主控 Agent 尚未进入自由生成 DAG 阶段。

## 二、总体原则

1. 先完成真实 GUI 验收，再扩大自主能力。
2. 所有能删除数据、修改代码或运行命令的动作都必须经过宿主确认门。
3. 每一阶段必须有自动化验证和人工验收记录，未验收不继续堆功能。
4. 先补边界和恢复能力，再考虑 `workflowStore` 的物理拆分。
5. 不把 H4 当作“任意代码执行器”；H4 仍是受限开发能力和宿主证据链。

## 三、阶段计划

### Phase 0：基线冻结与验收准备

目标：建立可重复的验收基线。

工作项：

- 将远端最新主线同步到本地验收分支。
- 固定 `tsc -b`、`vitest`、`vite build` 和 headless 样例命令。
- 检查 `.slimemold/evidence`、worktree 临时目录和日志清理策略。
- 建立本阶段问题记录：环境问题、功能问题、安全问题分开记录。

完成门槛：

- 自动化测试全绿；
- build 全绿；
- headless 自举样例成功且无残留 worktree；
- 不修改生产代码即可开始 GUI 验收。

### Phase 1：H4 GUI 宿主接入

> 状态：**代码已完成（2026-08-13，本地待提交），待 Windows + Tauri dev 人工验收**。
> 实现内容：
> - Rust 新增 H4 受控命令通道：`dev_exec`（命令名白名单 + cwd 必须属于主仓库根/已登记 worktree + 剥离凭据 env + 30s 超时）、`dev_read_file`/`dev_write_file`（路径必须属于已登记 worktree）、`dev_init_session`/`dev_register_worktree`/`dev_unregister_worktree`（宿主登记态，支持相对路径基于主仓库根解析）。
> - 前端 Tauri 通道 `src/dev/tauri-run.ts`：`createTauriDeps`（runCommand/readFile/writeFile/resolveInside/relativePath 全部走 Rust）、`createTauriGitRunner`、`createTauriEvidenceStore`（plugin-fs JSONL）；纯前端路径工具 `resolveWeb`/`relativeWeb`（GUI 下 node:path 被 vite shim 掉的替代）。
> - `createNodeDevService` 支持 `env` 参数（'node' | 'tauri'）+ `createTauriDevService`。
> - `session.initDevSession` 支持 `env: 'tauri'`：worktree 创建/清理自动同步 Rust 登记态；动态 worktree 创建时惰性绑定宿主固定路径 EvidenceStore（`<项目根>/.slimemold/evidence`，位于 worktree 外）。
> - GUI 生命周期 `src/dev/gui.ts`：打开项目时 `ensureGuiDevSession`（初始化 DevSession + 注册 dev.* 节点定义 + 同步 Rust 登记）；切换/关闭项目时 `teardownGuiDevSession`（卸载定义 + 重置单例，防污染其它项目）。
> - GUI 验收面板 `DevSessionPanel`（StatusBar 新增「开发（H4）」Tab）：worktree 状态 / 证据绑定状态 / 验收记录展示；「批准并清理」（绑定本 worktree 最新通过验收 + 状态签名 + 基线，confirmAndCleanup 原子确认）与「强制清理」（必须填 reason，无宿主持久化拒绝，审计落盘失败拒绝，二次确认）确认入口。
> - vite.config 增加 `node:fs/promises` alias（避免前缀替换拼出 ENOENT 路径）。
> 验证：tsc 0 / vitest 587（50 文件，+7 tauri-run）/ build ✓ / cargo check ✓ / headless 样例 6/6 + worktree 无残留。
>
> **审计 P1 修复（2026-08-13，二次提交）**：
> - **Rust dev_exec 主仓库根 cwd 权限收紧**：主仓库根不再放行完整命令白名单——仅允许严格只读
>   git 管理命令（`git rev-parse`/`git worktree list/add/remove/prune/lock/unlock`/
>   `git branch -D/-d/--list/-a`/`git status/diff/log/show/ls-files/rev-list`）。
>   `npm`/`tsx`/`tsc`/`vitest`/`cat` 等及**写入型 git**（apply/commit/push/reset/checkout/add）
>   在主仓库根**一律拒绝**（fail-closed）；完整白名单仅限已登记 worktree cwd。
>   新增 Rust 单测 `dev_exec_tests`（8 用例全过）：主仓库 npm/tsx/git apply/commit/push/reset 必须拒绝。
> - **GUI 生命周期竞态修复**：`ensureGuiDevSession` 改为 **await `dev_init_session` 成功后才注册
>   dev.* 节点定义**；失败标记 `devGuiStatus='unavailable'`（面板显示「H4 开发能力不可用」，
>   不静默吞异常）；`teardownGuiDevSession` 先 `await dev_clear_session`（新增 Rust 命令）清空旧登记态，
>   避免切换项目后旧登记泄漏到新项目。
> 验证（二次）：tsc 0 / vitest 587 / build ✓ / cargo check ✓ / cargo test 8 ✓ / headless 6/6。

目标：让 GUI 能安全运行 H4 开发节点，并让人工确认真正经过宿主层。

工作项：

- 在 Tauri/Rust 通道接入受控 git、文件读写和测试执行。
- GUI 创建 DevSession，并通过宿主注入动态 worktree 的 EvidenceStore。
- 增加 GUI 的验收结果面板：结果、证据、失败原因、diff 和保护路径变更。
- 增加 `approveCleanup` 和 `forceCleanup` 的 GUI 确认入口。
- 明确 GUI 下失败时保留 worktree，禁止静默清理。

验收场景：

1. 创建 worktree → 读取文件 → 应用小型补丁。
2. 执行白名单测试并登记真实结果。
3. 添加证据 → 验收通过。
4. 修改后验收失败，worktree 保留。
5. 人工查看 diff 后确认 cleanup，审批被消费。
6. 强制 cleanup 必须填写 reason，证据落盘失败时不得清理。

完成门槛：

- Windows + Tauri dev 人工验收全部通过；
- GUI 不允许通过节点参数伪造 cleanup 或证据；
- 动态 worktree 能正确绑定 EvidenceStore；
- 失败路径无数据丢失、无错误删除。

### Phase 2：H4 状态持久化与恢复

目标：支持应用重启后恢复开发任务的证据和审批上下文。

工作项：

- 将 `HostResultRecord` 持久化到宿主专用 JSONL/项目运行目录。
- 将 `AcceptanceRecord` 持久化，并按 orchestration/stage/worktree 建立索引。
- 将 cleanup approval 持久化，但恢复后默认标记为待重新确认，不自动获得删除权限。
- 启动时恢复证据、结果和验收记录；校验 schema、路径和 scope。
- 增加版本号和失效策略，避免旧记录被新 worktree 复用。

完成门槛：

- 重启后可查看历史证据和验收结论；
- 重启后不能无人工确认直接 cleanup；
- 损坏或缺失记录会安全失败，不影响主仓库；
- 跨任务、跨阶段、跨 worktree 的记录仍严格隔离。

### Phase 3：H3 遗留收口

目标：补齐编排可观测性和阶段恢复能力。

工作项：

- 接入 `orch.*` 事件到统一 runEvents。
- 为每个阶段写入 checkpoint。
- 将 `runIds` 统一为 `{ wfId, runId }` 结构。
- 验证取消、失败重试和恢复时不会重复执行已完成阶段。
- GUI 展示阶段事件、checkpoint 和恢复点。

完成门槛：

- 中途关闭应用后可恢复到正确阶段；
- 已完成阶段不重复执行；
- 取消、失败和重试状态可从事件与 checkpoint 解释；
- H3 编排与 H4 DevSession 的 scope 能够稳定关联。

### Phase 4：受限主控 Agent

目标：在安全边界内实现第一个可用的主控 Agent。

第一版只允许：

- 根据用户目标选择已有编排模板；
- 填充阶段参数、验收规则和推荐 Agent；
- 生成工作流草案；
- 展示预计成本、风险和所需权限；
- 等待用户确认后执行。

第一版禁止：

- 静默修改用户工作流；
- 自动批准 cleanup；
- 绕过 Agent Router 和成本限制；
- 自由生成未经过 schema 校验的 DAG；
- 在主仓库直接写入代码。

完成门槛：

- 草案可编辑、可丢弃、可审查；
- 用户确认是执行唯一入口；
- 每个阶段都有工作流、Agent、验收规则和权限说明；
- 失败时能回到人工接管，而不是无限自动重试。

## 四、`workflowStore` 与 `executor` 的处理策略

当前不进行大规模物理拆分。

只有在 Phase 1–3 完成、真实 GUI 验收稳定后，才根据新增职责做小步拆分：

- 先抽离纯函数和持久化适配器；
- 再抽离 orchestration 状态操作；
- 最后评估是否需要拆出运行时 facade；
- 每次拆分必须保持旧 API 和行为兼容，并通过自动化 + GUI 回归。

暂不触碰：

- `workflowStore` 的核心 actions 大块重排；
- executor 主循环的结构性改写；
- 将 H4 开发节点直接嵌入 executor 内部。

## 五、建议优先级

| 优先级 | 项目 | 原因 |
|---|---|---|
| P0 | H4 GUI 宿主接入 | 当前最大产品缺口，headless 不能替代真实桌面验收 |
| P0 | 动态 worktree EvidenceStore 绑定 | 防止 GUI 场景出现“能运行但无法可靠审计” |
| P1 | H4 结果/验收/审批恢复 | 支撑长期任务和跨会话恢复 |
| P1 | H3 事件与阶段 checkpoint | 支撑可观测性和断点续传 |
| P1 | 受限主控 Agent | 让产品从能力层进入工作站闭环 |
| P2 | workflowStore 小步拆分 | 以实际职责增长为依据，避免提前重构 |
| P2 | executor 深度重构 | 只有出现明确维护或扩展瓶颈时再做 |

## 六、最终产品闭环

```text
用户目标
  → 主控 Agent 生成可编辑草案
  → 用户确认
  → Agent Router 分配阶段 Agent
  → Orchestrator 执行阶段工作流
  → DevSession 在隔离 worktree 中修改
  → 宿主采集证据并确定性验收
  → GUI 展示进度、diff、失败点和恢复点
  → 用户审查并批准合并/清理
  → 经验库记录结果，优化下一次路由与流程
```

## 七、计划完成判定

当以下条件全部满足，才认为进入“可持续开发”阶段：

- GUI H4 六类核心场景验收通过；
- 动态 worktree、EvidenceStore 和 cleanup 权限链闭环；
- 重启后可恢复编排、证据和验收上下文；
- H3 checkpoint/event 遗留收口；
- 主控 Agent 仍保留用户确认门；
- 连续两轮回归无 P0/P1 安全问题；
- workflowStore/executor 的拆分由实际痛点驱动，而不是由文件行数驱动。
