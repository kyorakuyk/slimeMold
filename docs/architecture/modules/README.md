---
title: SlimeMold 专题架构设计
type: architecture-module-index
status: active
updated: 2026-09-02
---

# SlimeMold 专题架构设计

本目录保存 H2、H3、H4 三个专题的设计和阶段实现记录。它们不是互相独立的事实源，也不能覆盖项目控制面架构。

| 文档 | 主题 | 当前状态 |
|---|---|---|
| [H2 插件隔离](H2_PLUGIN_ISOLATION_DESIGN.md) | Web Worker sandbox PoC、RPC 和能力代理 | PoC；不是进程级不可信插件隔离 |
| [H3 Orchestrator](H3_ORCHESTRATOR_DESIGN.md) | 草案、确认门、阶段编排和恢复 | 部分实现；仍有事件/checkpoint 遗留 |
| [H4 Self-Development](H4_SELF_DEVELOPMENT_FOUNDATION.md) | worktree、宿主能力、Evidence 和 acceptance | Foundation 已实现；GUI/恢复等仍有边界 |

使用规则：

- 当前实体、事实源、命令入口和状态迁移以 [`PROJECT_CONTROL_PLANE_ARCHITECTURE.md`](../PROJECT_CONTROL_PLANE_ARCHITECTURE.md) 为准；
- 当前代码差距以 [`CODEBASE_ARCHITECTURE_REVIEW.md`](../CODEBASE_ARCHITECTURE_REVIEW.md) 为准；
- 本目录中的旧 commit、测试数字和阶段状态是专题文档的历史基线，不自动代表当前 HEAD；
- 不可信第三方模块启用前，必须额外完成宿主级隔离、lease、路径 no-follow 和完整 recovery 验证。
