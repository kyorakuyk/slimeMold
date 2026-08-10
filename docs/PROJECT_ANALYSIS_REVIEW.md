# 08-07 项目分析对话 · 对照复核（2026-08-10）

> 依据：2026-08-07 的「帮我分析一下这个项目」对话（早期分析）。
> 本文档逐条对照**当前 main 代码现状**（2026-08-10），标注每条结论是「已落地 / 已过时 / 仍待办」。
> 复核方式：源码 + 测试 + capabilities + tauri.conf 实读，非猜测。

## 一、已收口（分析当时是「建议 / 缺口」，现已完成）

| 分析结论 | 当时状态 | 当前状态（2026-08-10） |
|---|---|---|
| P0 收紧 Tauri fs scope（`path: "**"`） | 过宽 | ✅ `capabilities/default.json` 收窄为 `$APPDATA/$HOME/$DOCUMENT/$RESOURCE`；非默认目录经动态 `grant_project_access` 注入（幂等 `FsExt::allow_directory`，见 §五） |
| P0 限制 HTTP 任意域名（`http://*` `https://*`） | 过宽 | ✅ 收窄为 `https://*/*` + 本地 Ollama `11434` |
| P0 限制 `run_git` 参数与 cwd | 任意参数 | ✅ cwd 必填且校验存在/目录；`validate_worktree_path` 防越界；沙箱分支名白名单；仅允许 worktree/branch 白名单子命令 |
| P0 配置 CSP（当时 `csp: null`） | 无 | ✅ `tauri.conf.json` 已配 `default-src 'self'` + connect-src 白名单 |
| P1 拆分 `builtin.ts`（当时约 2700 行） | 上帝模块 | ✅ 已拆到 `nodes/builtin/`，`builtin.ts` 现仅 50 行 |
| P1 补自动化测试（当时无测试脚本） | 无 | ✅ 37 个测试文件、437 tests（engine 全模块 + agents 路由/评分 + store 序列化 + nodes 辅助） |
| P1 Pipeline 持久化（当时模块级 `Map`，重启丢失） | 内存态 | ✅ `getPipeline` 读 store，`pipelines` 已进 `ProjectFile` 落盘 |
| 凭据批量解密返回 WebView | 全量明文 | ✅ `list_endpoints_raw` 用 `strip_endpoint_api_key` 剥离明文，单条按需 `load_endpoint` |

## 二、产品愿景 → 已落地（分析时是设想，现已实现）

| 分析设想 | 现状 |
|---|---|
| 统一事件模型（建议「尽早引入 TaskEvent」） | ✅ `runEvents` 总线：`run.created/started/progress/completed/failed/aborted` + `node.started/progress/completed/failed/skipped/intervene`；JobBoard 已改消费事件流 |
| Agent Router + 成本感知调度（「便宜模型批量、贵模型关键」） | ✅ `agentRouter.ts` + `routerScoring.ts`：cost/success/tierFit 评分、heavy 否决 light、category 硬路由、失败按 `chain` fallback |
| 经验驱动自我学习（记录 token/成功率 → 下次优化） | ✅ `experienceStore.ts`：`recordAgentOutcome` 无条件统计 + `summarizeExperience` 教训沉淀 + 命中经验注入 system prompt |
| 实时接管（「暂停后接管，再交还 Agent」） | ✅ `intervention.ts`：`ctx.intervene` 挂起节点 + 模态框提交/取消 + 复合键防并行冲突 |
| 检查点 / 断点续传（「失败局部重跑」） | ✅ `checkpoint.ts`：运行收尾自动原子落盘 + RunHistoryPanel「恢复」+ 增量续跑 |
| 节点缓存隔离 | ✅ 缓存按 `wfId + nodeId + workspaceDir` 细粒度隔离 |

## 三、仍未解决（分析判断正确，至今成立）

| 待办 | 现状与风险 |
|---|---|
| **executor.ts 大函数拆分**（1514 行） | ✅ **已解决（H1a–g，2026-08-11）**：`runWorkflow`/`executeNode` 主路径拆出 7 个纯逻辑模块（runFinalizer 313 / runScheduler 104 / runLoop 69 / agentDecision ~98 / nodeExecutionPolicy 155 / runLlmCall 175 / nodeResultHandler 120），executor 降至 **1233 行**，各模块补直接单测。H1v 八项 GUI 验收 + 437 自动化测试全绿 |
| **workflowStore 2151 行** | ⚠️ 未拆（Codex 评审确认「物理拆分暂缓」，留门面 G5；H1v 验收已通过，G5 可重新评估） |
| **插件进程级隔离**（Blob URL 动态 `import()`，无进程沙箱） | ⚠️ `applyCapability` 仍是 API 层约束，非代码隔离；分析文档判断为「当前架构最大安全短板」，**至今成立**（H2 待做） |
| **Orchestrator / 主控 Agent**（动态生成、修改、执行、验收工作流） | ⚠️ 未做。当前仍是「用户预设 DAG + 节点内 Agent」，动态重规划未实现（H3 待做） |

## 四、文档自身已修正 / 过时的观点

- **「Anthropic 原生支持不完整」**：分析文档第 198 行自己已纠正（`providers/anthropic.ts` 实现 `/v1/messages`）。当前更进一步：模型拉取 `fetchAnthropicModels`（`/v1/models` + `x-api-key`）与探测均已按协议分流。
- **「API Key 进前端内存」**：判断正确但已降低暴露面（批量→按需单条）。无法根除（provider 必须在前端发请求），除非路线 B Rust 后端落地。
- **「executor 依赖 Zustand」**：已部分缓解（`runContext`/`runEvents`/`checkpoint` 等纯函数模块零 store 依赖），但 executor 主体仍直接 `getState()`。

## 五、本轮复核顺带修复的真实 Bug（2026-08-10）

复核时发现运行中 UI 全冻结：`grant_project_access` 每次调用 `app.add_capability()` 新增 capability（Tauri 不去重），高频调用使列表无限膨胀、Rust 主线程 busy loop（CPU 669%）、WebView 输入事件冻结。
修复（commit `2c56e38`）：
- 弃用 `add_capability`，改用 `FsExt::fs_scope().allow_directory(path, true)`（底层 `HashSet` 幂等）
- `canonicalize` 归一化真实路径
- 1 秒同路径去重缓存

## 附：与本项目其他文档的关系

- 待办拆解见 Codex 设计评审 `CODEX_DESIGN_REVIEW.md` + 本文档 §三；执行顺序见 todo。
- 验证清单见 `EXECUTION_PHASES_VERIFICATION.md`；架构重构历史见 `REFACTOR_SUMMARY.md`。

*生成日期：2026-08-10 · 基于 main @ `c9e25e6`；2026-08-11 更新至 main @ `917e13d`（executor 拆分完成，H1a–g + H1v）*
