---
title: SlimeMold 文档地图
type: documentation-index
status: active
updated: 2026-09-02
---

# SlimeMold 文档地图

本文档是 `docs/` 的导航入口，负责说明文档职责、权威层级和历史资料位置。它不是产品原则、架构契约或开发计划的事实来源。

## 推荐阅读顺序

1. [产品哲学](principles/SLIMEMOLD_PRODUCT_PHILOSOPHY.md) —— 为什么这样设计，以及必须遵守的规范性原则。
2. [全局产品与系统审视](strategy/SLIMEMOLD_GLOBAL_PRODUCT_SYSTEM_REVIEW.md) —— 产品定位、系统风险和战略取舍。
3. [项目控制面架构](architecture/PROJECT_CONTROL_PLANE_ARCHITECTURE.md) —— 当前项目实体、事实源、状态、权限和恢复契约。
4. [代码结构审查](architecture/CODEBASE_ARCHITECTURE_REVIEW.md) —— 当前代码与目标架构的差距、阻塞项和迁移顺序。
5. [专题架构设计](architecture/modules/) —— 插件隔离、Orchestrator 和自我开发能力的专题设计。
6. [轻量界面设计](product/BEGINNER_UI_DESIGN.md) —— 将产品原则和控制面转译为用户界面。
7. [下一阶段计划](plans/NEXT_PHASE_PLAN.md) —— 近期开发顺序和完成门槛。
8. [Professional 路线](plans/PROFESSIONAL_ROADMAP.md) —— 暂不进入 MVP 的长期能力储备。
9. [当前验证入口](verification/README.md) —— 自动质量门和人工验收矩阵。
10. [开发记录](DEVELOPMENT_LOG.md) —— 已发生变化的回顾性时间线。

## 权威层级

```text
原则（Why）
  → 战略审视（What / Trade-offs）
  → 控制面架构契约（Model / State / Authority）
  → 专题设计与 UI 转译（How）
  → 近期计划（When）
  → 验证清单（Proof）
```

- **规范性原则**：`principles/`。产品哲学定义用户、Agent、项目事实、权限和可视化投影之间的上位关系。
- **架构契约**：`architecture/PROJECT_CONTROL_PLANE_ARCHITECTURE.md`。定义当前应采用的数据模型和事实源；代码结构审查用于校验实现，不取代契约。
- **战略参考**：`strategy/`。用于判断产品方向和取舍，不把建议写成已实现能力。
- **专题设计**：`architecture/modules/`。说明某个能力的设计、边界和实现状态；与当前代码冲突时，以代码、测试和控制面契约为准。
- **验证证据**：`verification/` 和 `reference/`。前者描述如何验证，后者保存外部研究及其证据边界。
- **历史记录**：`DEVELOPMENT_LOG.md` 和 `history/`。用于追溯，不覆盖当前架构契约，也不作为当前状态的唯一来源。
- **原始资料**：`log/` 和 `design/`。只保存对话导出或探索素材，不具有产品、架构或安全权威。

## 敏感资料标记（SENSITIVE / DO NOT COMMIT）

以下资料保留在本地用于追溯，但明确排除在 Git 提交之外：

| 路径 | 敏感原因 | 处理规则 |
|---|---|---|
| `log/raw/` | 原始 JSON 导出，可能含 API-key 形状字符串、运行上下文和临时路径 | 已加入 `.gitignore`，不得提交或共享 |
| `log/codex-conversations/` | 原始对话导出，含项目上下文、文件路径和操作记录 | 已加入 `.gitignore`，不得提交或共享 |

敏感资料只保留在本地。需要对外提供诊断或研究材料时，必须先建立脱敏副本，并重新扫描确认没有凭据、个人路径或其他私密上下文。

## 目录职责

| 目录 | 职责 | 是否作为当前权威 |
|---|---|---|
| `principles/` | 产品哲学和规范性原则 | 是，限于产品原则 |
| `strategy/` | 产品定位、系统风险和战略判断 | 是，限于战略判断 |
| `architecture/` | 控制面契约和代码现实审查 | 是，限于架构/实现边界 |
| `product/` | UI 与用户认知层级转译 | 是，限于产品交互设计 |
| `plans/` | 近期计划与长期路线 | 只对开发顺序有效 |
| `verification/` | 当前质量门和验收入口 | 是，限于验证方法 |
| `security/` | 凭据和安全模型 | 是，限于安全说明 |
| `reference/` | 外部研究和引用证据 | 不是产品规范 |
| `history/` | 已完成设计、早期审查和旧清单 | 否 |
| `design/` | 视觉探索稿 | 否，除非另有明确决策 |
| `log/` | 原始对话和导出资料 | 否 |

## 迁移表

本次只移动文件，没有删除内容：

| 原路径 | 新路径 |
|---|---|
| `SLIMEMOLD_PRODUCT_PHILOSOPHY.md` | `principles/SLIMEMOLD_PRODUCT_PHILOSOPHY.md` |
| `SLIMEMOLD_GLOBAL_PRODUCT_SYSTEM_REVIEW.md` | `strategy/SLIMEMOLD_GLOBAL_PRODUCT_SYSTEM_REVIEW.md` |
| `PROJECT_CONTROL_PLANE_ARCHITECTURE.md` | `architecture/PROJECT_CONTROL_PLANE_ARCHITECTURE.md` |
| `CODEBASE_ARCHITECTURE_REVIEW.md` | `architecture/CODEBASE_ARCHITECTURE_REVIEW.md` |
| `H2_PLUGIN_ISOLATION_DESIGN.md` | `architecture/modules/H2_PLUGIN_ISOLATION_DESIGN.md` |
| `H3_ORCHESTRATOR_DESIGN.md` | `architecture/modules/H3_ORCHESTRATOR_DESIGN.md` |
| `H4_SELF_DEVELOPMENT_FOUNDATION.md` | `architecture/modules/H4_SELF_DEVELOPMENT_FOUNDATION.md` |
| `BEGINNER_UI_DESIGN.md` | `product/BEGINNER_UI_DESIGN.md` |
| `NEXT_PHASE_PLAN.md` | `plans/NEXT_PHASE_PLAN.md` |
| `PROFESSIONAL_ROADMAP.md` | `plans/PROFESSIONAL_ROADMAP.md` |
| `credentials.md` | `security/CREDENTIALS_MODEL.md` |
| `PROJECT_ANALYSIS_REVIEW.md` | `history/reviews/PROJECT_ANALYSIS_REVIEW.md` |
| `CODEX_DESIGN_REVIEW.md` | `history/reviews/CODEX_DESIGN_REVIEW.md` |
| `REFACTOR_SUMMARY.md` | `history/refactors/REFACTOR_SUMMARY.md` |
| `SLIMEMOLD_ARCHITECTURE_DIRECTION_REVIEW.md` | `history/decision-reviews/SLIMEMOLD_ARCHITECTURE_DIRECTION_REVIEW.md` |
| `RUN_VERIFICATION.md` | `history/verification/RUN_VERIFICATION.md` |
| `EXECUTION_PHASES_VERIFICATION.md` | `history/verification/EXECUTION_PHASES_VERIFICATION.md` |
| `reference/2.md` | `reference/archive/AI_ECOSYSTEM_GAPS_NOTES.md` |

历史日志中的旧路径保留为当时的记录，不回写；需要查当前文档时按本表跳转。

## 维护规则

- `docs/` 根目录不再新增没有分类的设计、评审或计划文档；新的内容先判断所属目录。
- 当前文档必须声明 `type`、`status`、`updated`；专题设计还应声明 `reviewed_commit` 或当前实现基线。
- 任何“已实现”结论必须能指向源码、测试、宿主证据或开发日志中的真实验证；战略建议不能写成实现事实。
- 外部调研进入 `reference/`，原始聊天进入 `log/`，视觉试稿进入 `design/`，历史文档进入 `history/`。
- 不删除历史资料；如果文档被替代，保留原文并注明 `superseded_by`，或在索引中保留迁移关系。
- 原始日志提交前必须脱敏。不得保留 API key、token、密码、私钥、Bearer 值、连接字符串或个人敏感路径。
