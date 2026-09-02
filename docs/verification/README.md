---
title: SlimeMold 当前验证入口
type: verification
status: active
updated: 2026-09-02
---

# SlimeMold 当前验证入口

这是当前开发的验证导航，不代表所有人工验收项都已经完成。自动命令的实际结果以最近一次开发日志为准。

## 自动质量门

```bash
npm run test
npm run build
npm run i18n:check
git diff --check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
```

最近一次已记录的 checkpoint 基线（`509e070`）：

- `npm run test`：99 个测试文件、806 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；保留既有 dynamic/static import 与大 chunk warning；
- `npm run i18n:check`：991 个 key 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- `git diff --check`：通过。

本轮 working tree 实测（2026-09-02，尚未 commit）：

- `npm run test`：100 个测试文件、818 个测试通过；
- `npm run build`：TypeScript/Vite 构建通过；保留既有 dynamic/static import 与大 chunk warning；
- `npm run i18n:check`：991 个 key 对齐；
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`：通过；
- `cargo test --manifest-path src-tauri/Cargo.toml`：23 个 Rust 测试通过；
- `git diff --check`：通过；
- 隔离 Tauri fixture 已生成/清理，但当前 GUI 驱动未能枚举新启动窗口，真实 Worker E2E 未通过也未宣称通过。

## 人工验收范围

- Tauri/Windows 启动、项目打开、项目切换和关闭；
- Worker queued/running/succeeded/failed/recovery-required 生命周期；
- 失败现场保留、Evidence 查看、skip、retry、cleanup 和 Receipt；
- 插件加载、项目作用域、sandbox worker 终止和路径边界；
- 用户查看 diff 后批准交付，不允许模型自报替代宿主证据。

## 历史清单

以下文件保留为旧阶段的详细检查记录，不再作为当前测试数字的唯一来源：

- [早期运行验证清单](../history/verification/RUN_VERIFICATION.md)
- [执行内核六阶段验证清单](../history/verification/EXECUTION_PHASES_VERIFICATION.md)

新增功能时，应在本入口补充验证范围，并在 `DEVELOPMENT_LOG.md` 记录实际命令结果。
