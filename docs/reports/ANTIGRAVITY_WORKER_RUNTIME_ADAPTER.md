# Antigravity Worker Runtime Adapter

更新时间：2026-09-16

## 结论

SlimeMold 现在可以把一个 queued TaskGraph Worker Run 显式选择为 `antigravity` Runtime。默认仍是 Codex；普通 Workflow Engine 仍是另一条执行路径。

```text
ProjectSessionPanel
  → workerRuntime: codex | antigravity
  → Project Worker Coordinator
  → registered Worker Worktree
  → Antigravity CLI chat --mode <mode>
  → workspace .agents/mcp_config.json
  → slimemold-worker MCP server
  → Attempt result
  → Host Acceptance
  → Evidence / Receipt / Task projection
```

Antigravity 的聊天界面、进程退出或 Agent 自报完成都不会直接产生 `TaskSucceeded`。只有 MCP `submit_attempt_result` 的 `completed` 回报进入现有 Host Acceptance；Acceptance 通过后才由 Control Plane 投影成功。

## 已实现

- `src/agents/providers/antigravity.ts`
  - Runtime invoker；默认 `agent` mode；支持 CLI 已确认的 `ask`、`edit`、`agent`、`custom` 模式值，以及可选的 Antigravity workspace `profile`。
  - `profile` 只是 CLI workspace profile，不代表模型或 thinking 配置。
  - 取消信号调用受控的 `antigravity_worker_cancel`。
- `src/dev/antigravityWorkerExecutor.ts`
  - 使用与 Codex 相同的 Worker lease、ContextPack、dependency artifact、Worktree 和 Host Acceptance 边界。
  - `completed` 只提交 Host Acceptance。
  - `blocked` 创建绑定当前 project/task/attempt 的 `FeedbackRequest`。
- `src-tauri/src/antigravity.rs`
  - 只接受当前 session generation 和已登记 Worktree。
  - 为每个 Attempt 创建 `.agents/slimemold-worker/<operationId>/`。
  - 原子写入 `context.json` 和 launch metadata。
  - 只在缺少冲突配置时写入 Worktree 内 `.agents/mcp_config.json`；已有不同的 `slimemold-worker` 配置会 fail-closed，不覆盖。
  - 只接受 basename 为 `antigravity-ide.cmd`、`antigravity-ide.exe` 或 `antigravity-ide` 的 CLI；可通过 `ANTIGRAVITY_CLI`、PATH 或显式 `cliPath` 提供路径。
  - Windows `.cmd` 通过 `cmd.exe /D /C` 启动，但传给命令行的 prompt 是固定安全启动词；实际任务指令写入 Attempt context，避免把任意任务文本拼入 shell command。
  - 最长等待 30 分钟；无 `result.json` 不返回成功。
- `scripts/slimemold-antigravity-mcp.mjs`
  - `slimemold_get_task_context`
  - `slimemold_report_progress`
  - `slimemold_request_feedback`
  - `slimemold_submit_attempt_result`
  - MCP server 只读/写当前 Attempt 目录，不直接写 ProjectFile、TaskGraph、Acceptance 或 Receipt。
- `ProjectSessionPanel`
  - queued Run 显示 Runtime selector。
  - 默认 `Codex subscription (headless)`；显式选择 `Antigravity (interactive)` 后才切换 Runtime。
- `SettingsCenter → AgentPanel`
  - `Antigravity CLI (interactive)` 是独立 protocol，可保存 mode、workspace profile 和 CLI path。
  - 这些字段只作为 Worker Runtime 配置；不提供虚假的 model/thinking/reasoning 选择。

## 尚未宣称的能力

- 没有把 Antigravity UI 中出现的模型名称当作稳定 API 契约。
- `--profile` 只作为 Antigravity workspace profile 传递；没有把它解释为模型、thinking level 或 Gemini API profile。
- 没有把 thinking/reasoning 强度映射为 CLI 参数；当前没有足够的官方 CLI/MCP 契约证明该参数可编程控制。
- 没有把 Antigravity 账户订阅伪装成 Gemini API/Vertex AI Provider，也没有记录虚构 token/cost。
- 没有修改用户的全局 `~/.gemini/config/mcp_config.json`；配置只写入 Worker Worktree。
- 当前 Runtime selector 的选择是本次 queued Run 的内存选择，不是持久化 ProjectFile ExecutionProfile。
- 模型、thinking profile、usage provenance 仍应在未来分别设计 Codex Profile Adapter 和 Gemini API/Vertex Adapter；不能由 Antigravity IDE Runtime 猜测补齐。

## 验证

- `cargo check`：通过。
- `cargo test --lib`：50/50 通过，包含 Antigravity mode、operation id 和 Windows command 构造测试。
- `npm run build`：通过。
- `npm run i18n:check`：通过，en-US/zh-CN 1026 keys 对齐。
- `npm run test`：127 test files / 1099 tests passed。
- Antigravity executor focused tests：completed → Host Acceptance、blocked → FeedbackRequest 均通过。
- MCP stdio read-back：initialize/tools/list/get_context 真实通过；Windows native fixture 读取 `context.json` 成功。

## 使用前提

1. Antigravity CLI 必须在 PATH 中，或设置不含凭据的环境变量 `ANTIGRAVITY_CLI` 指向合法 `antigravity-ide` executable。
2. 选择 Antigravity 后，Agent 必须调用 `slimemold_get_task_context`，在当前 Worktree 修改，并最终调用 `slimemold_submit_attempt_result`。
3. 运行结束后仍需检查 Host Evidence、Acceptance、Receipt 和 changed-file scope；不要依据 IDE 窗口或 Agent 文本单独交付。
4. Worker Worktree 不自动 Cleanup；不 push、不 merge，除非用户另行授权。
