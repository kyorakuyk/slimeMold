# slimeMold 产品路线图与能力缺口分析

> 战略定位：首发 **Community（普通用户）** 版，界面干净好懂、操作易于学习；
> 逐步扩充 **Professional（企业级）** 版（参考 PyCharm Community / Professional 双版本模式）。

---

## 0. 双轨总览

| 维度 | Community（首发） | Professional（后续） |
|------|------------------|---------------------|
| 目标人群 | 普通用户、个人创作者、学习者 | 企业团队、工程化/规模化使用 |
| 核心目标 | 上手快、看得懂、跑得通 | 可控、可集成、可审计、可扩展 |
| 界面基调 | 干净、引导式、人话提示 | 专业配置、批量、权限 |
| 已落地的专业能力 | 执行引擎核心（缓存/增量/端口校验/分支）隐藏在底层 | 后端 LLM 通道、Headless API、分支节点 |

**原则**：已做的专业能力（路线 A 后端通道、Headless、switch 等）**不回退**，
但在 Community 首发版中应「藏好 / 默认关 / 不喧宾夺主」。

---

## 1. Community 首发（P0 — 当前阶段）

### 1.1 界面打磨与新手引导
- [x] **内置节点友好分类**：`input / 文本 / AI / 逻辑 / 工具 / 流程 / 输出` 中文分组，面向普通用户语义（见 `src/nodes/builtin.ts` 的 `category` 字段）
- [x] **画布空状态引导**：零节点时显示欢迎卡片 + 一键「从模板开始」（`WorkflowEditor.tsx`）
- [x] **新手模板**：内置「把一句话变成正式邮件」等开箱即用模板（`src/data/starterTemplates.ts`）
- [ ] 运行过程提示人话化（如「AI 正在写…」「已跳过此分支，因为条件不成立」）
- [ ] 节点中文标题 / 说明 tooltip，避免术语门槛
- [ ] 端口连线时的友好校验提示（替代当前的硬校验报错）

### 1.2 易用性增强（P1 — Community 增强）
- [ ] **工作流分享**：导出/导入 JSON、分享链接
- [ ] 模板市场（内置更多场景模板）
- [ ] 一键示例库

---

## 2. Professional 后续（P2 — 企业级）

### 2.1 后端化与 API
- [x] **LLM 后端通道（路线 A）**：Rust `chat_completion`，密钥不出渲染层（`src/agents/llmChannel.ts` + `src-tauri/src/lib.rs`）
- [x] **Headless / API 运行**：无 UI runner + CLI（`src/engine/headless.ts` + `scripts/headless-run.ts`）
- [ ] Tauri 命令 `run_workflow` 触发 headless（让 Rust 也能跑整图）
- [ ] Anthropic 原生 SSE（目前仅 OpenAI 兼容）
- [ ] REST API 服务化

### 2.2 工程化执行引擎（已落地，Pro 复用）
- [x] 结果缓存 / 增量执行（`nodeCache`）
- [x] 端口兼容性校验（`arePortsCompatible`）
- [x] 中断粒度 / 重试（`withRetry` + `Semaphore` 并发）
- [x] 分支剪枝（`setBranches`，`flow.if` / `flow.switch` / `flow.merge`）
- [x] 分支 / 流程控制节点（`flow.switch` 新增）

### 2.3 扩展与企业能力
- [ ] 路线 B 实现：整图搬 Rust（`ExecutionBackend` 契约，占位见 `docs/BACKEND_ENGINE_DESIGN.md`，`feature/backend-engine` 分支）
- [ ] 插件市场 / 自定义节点发布
- [ ] 审计日志 / 操作追溯
- [ ] SSO / 团队权限 / 协作

---

## 3. 执行引擎能力回溯（已完成，底层支撑）

| 能力 | 状态 | 说明 |
|------|------|------|
| 拓扑分层 | ✅ | `topoLayers` |
| 节点缓存 | ✅ | `nodeCache`（增量执行） |
| 端口校验 | ✅ | `arePortsCompatible` |
| 重试 / 并发 | ✅ | `withRetry` + `Semaphore` |
| 分支剪枝 | ✅ | `setBranches` |
| 分支节点 | ✅ | `flow.if` / `flow.switch` / `flow.merge` |

---

## 4. 专业能力清单（已交付，Pro 向）

1. **LLM 后端通道（路线 A）** — 密钥安全、可切换前后端
2. **执行引擎核心** — 缓存/增量/端口校验/中断/重试/分支
3. **分支 / 流程控制节点** — if / switch / merge
4. **Headless / API 运行模式** — 无 UI runner + CLI，已实跑验证

## 5. 仍需补齐的缺口（按轨）

- Community：运行提示人话化、中文 tooltip、友好端口校验、工作流分享
- Professional：Tauri `run_workflow`、Anthropic SSE、路线 B 实现、插件市场、审计/SSO
