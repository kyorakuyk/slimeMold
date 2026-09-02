---
title: SlimeMold 原始日志
type: raw-log-index
status: archive
updated: 2026-09-02
---

# SlimeMold 原始日志

本目录保存 Codex 对话 Markdown 导出和 CodeBuddy/其他工具的原始 JSON 导出。原始日志只用于追溯，不是产品、架构或当前实现的事实来源。

## 敏感等级

- `raw/`：**SENSITIVE / DO NOT COMMIT**。原始 JSON 可能包含凭据形状字符串、项目路径、运行上下文和工具输出；已由根目录 `.gitignore` 排除。
- `codex-conversations/`：**SENSITIVE / DO NOT COMMIT**。即使没有检测到凭据，也包含项目对话和本地环境信息；整个目录已排除。

- `codex-conversations/`：可读的对话 Markdown 及其索引；
- `raw/`：原始 JSON 导出，可能很大，不应作为日常阅读入口；
- 原始日志提交或共享前必须先脱敏；不得保留 API key、token、密码、私钥、Bearer 值、连接字符串或个人敏感路径；
- 经过整理的结论进入 `DEVELOPMENT_LOG.md` 或相应的当前文档，不要让原始对话成为隐式规范。
