# 运行验证清单（Run Verification）

> 用途：每次涉及执行引擎 / Rust 后端 / LLM 通道的改动后，按本清单逐项确认。
> 无头（CI / 远程）环境只能完成「编译期 + 启动期」验证，端到端交互需人工在 GUI 内确认。

## 一、编译期（可自动化）

- [ ] 前端类型检查通过：`tsc --noEmit -p tsconfig.app.json`（无错误）
- [ ] Rust 检查通过：`cd src-tauri && cargo check`（无错误、零警告为目标）
- [ ] 前端生产构建通过（可选）：`npm run build`

## 二、启动期（半自动，需 GUI 环境）

- [ ] `npm run tauri dev` 能成功编译并启动窗口，日志出现 `Running target\...` 且无 panic
- [ ] 前端 vite 服务就绪（默认 `http://localhost:1420`）
- [ ] 窗口正常显示，无白屏（已用 `on_page_load` 显示 + `setup` 隐藏首屏优化）

## 三、端到端（需人工在 GUI 内）

### LLM 通道（路线 A）
- [ ] 设置面板「LLM 调用通道」可切换 后端 / 前端
- [ ] 默认通道为「后端」；配置有效 API Key 后，含 LLM 节点的工作流可运行
- [ ] 后端通道：流式输出逐 token 回传正常（观察节点 partial 进度）
- [ ] 前端通道：直接走 WebView 请求正常（用于对比 / 降级验证）
- [ ] 非 Tauri 环境（浏览器 `npm run dev`）自动降级到前端通道，不报错

### 协议兼容（SSE 解析）
- [ ] OpenAI 兼容 / Ollama：流式 `choices[].delta.content` 解析正确
- [ ] Anthropic：原生 `/v1/messages` SSE 解析已实现（`providers/anthropic.ts`，解析 `input_tokens`/`output_tokens`），流式输出与 token 用量统计正常

### 执行引擎既有能力（回归）
- [ ] 结果缓存命中：重复运行跳过已缓存节点（节点显示「缓存」徽标）
- [ ] 增量执行：单节点重跑只重算该节点及其下游
- [ ] 中断粒度：全局 Abort + 子图裁剪重跑 + 「重跑到此节点」
- [ ] 端口类型校验：不兼容端口连接被拦截或运行前告警

### API / Headless 验证
- [ ] `npm run headless -- examples/headless-demo.json` 可无窗口运行，输出各节点状态
- [ ] 分支剪枝生效：未激活分支的下游节点显示 `skipped`
- [ ] 纯本地节点（模板/表达式/流程控制）无需 API Key 即可运行
- [ ] LLM 节点 headless 运行走 `ctx.llm` 通道（默认 backend，需有效 Key 与 Tauri 环境）
- [ ] `--channel frontend|backend` 与 `--vars '{}'` 参数可用

## 四、已知缺口（本次未覆盖，记录待办）

- 路线 B（feature/backend-engine）：整图调度搬入 Rust，仅设计占位，未实现
- Tauri 命令触发 headless（`run_workflow` 供外部进程/服务端调用）尚未接入，当前仅 CLI 入口
