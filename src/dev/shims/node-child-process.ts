/**
 * 浏览器/WebView 构建占位：node:child_process 仅 headless/Node 环境可用。
 * vite 构建时由 alias 指向本文件，避免 rollup 解析 node 内置模块报错。
 * 实际运行（浏览器/WebView）时调用即抛错，保证 H4 开发节点不会在 GUI 里执行任意命令。
 */
export function execFile(
  _cmd: string,
  _args: readonly string[],
  _options?: unknown,
  _cb?: unknown,
): never {
  throw new Error('node:child_process 在浏览器/WebView 环境不可用（H4 开发节点需 headless/Node 环境）');
}

export function spawn(): never {
  throw new Error('node:child_process 在浏览器/WebView 环境不可用（H4 开发节点需 headless/Node 环境）');
}
