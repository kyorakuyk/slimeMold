# 路线 B：后端执行引擎（feature/backend-engine）

> 状态：**设计草案 / 占位**，未实现。本分支仅定义契约与演进路径，待路线 A 在 main 稳定后再实施。

## 目标

把整张 DAG 的调度从前端 JS（WebView）搬进 Rust 进程，获得：

- UI 渲染与执行解耦：长任务不阻塞画布交互。
- 断点续跑 / 服务端持久化：运行态可落库，崩溃后可恢复。
- 多前端共享同一执行内核：未来可挂 Web / CLI / 服务化部署。
- 企业级可扩展性：执行策略（并发、重试、审计、配额）集中在后端，便于治理。

## 与路线 A 的关系

路线 A 已在 main 落地 `LLMChannel` 抽象（frontend / backend 两种实现），
并把 `ExecContext.llm` 收敛到该抽象。路线 B 复用同一抽象，但把**调度主体**也移入 Rust：

- 路线 A：前端 `runWorkflow()` 调度，`ctx.llm` 可走后端通道。
- 路线 B：前端调用 `ExecutionBackend.runGraph(snapshot, opts)`，由 Rust 完成拓扑排序、
  并发调度、缓存、分支剪枝，并通过 Channel 把节点状态/流式输出回传前端 store。

关键约束：**节点侧 `ExecContext` 接口不变**。Rust 端需为节点执行提供等价的
`llm / setPartial / setBranches / storage / logger / vars` 实现（见 `src/agents/llmChannel.ts`
中的 `ExecutionBackend` 占位接口）。

## 抽象契约（锚点）

```ts
// src/agents/llmChannel.ts
export interface ExecutionBackend {
  readonly id: 'frontend' | 'rust-engine';
  runGraph(snapshot: unknown, opts: unknown): Promise<void>;
}
```

## 待解决（实施前需确认）

1. 节点执行函数的跨边界表示：前端节点是 TS 闭包，Rust 无法直调。
   方案：内置节点在 Rust 侧用 Rust 重写一份等价实现；插件节点通过
   WASM 或「前端受托执行 + 后端编排」混合模式。
2. 插件机制重设计：需把 `NodeDefinition` 序列化为跨 FFI 的协议描述。
3. 状态回传：节点 running/success/partial/branches 经 `Channel<ExecutionEvent>` 流回前端。
4. 与现有缓存（`nodeCache`）、增量执行、子图裁剪的对齐。

## 预计工作量

中—高（数天级），建议在路线 A 经过一轮真实使用、确认瓶颈确实在前端调度后再启动。
