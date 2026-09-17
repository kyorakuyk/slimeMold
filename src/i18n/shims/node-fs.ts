/**
 * 浏览器端 node:fs shim（仅 vite build 用）：
 * i18n 的 Node 兜底 loader 只在 tsx/headless 环境使用；浏览器构建时这些 API 不存在。
 * 此 shim 让 rollup 能解析 `node:fs`/`node:path`/`node:url` 的静态 import，但函数体永不执行
 * （Vite 环境走 import.meta.glob 分支）。若意外执行则抛错提示。
 */
export function readdirSync(): never {
  throw new Error('[i18n] node:fs 在浏览器环境不可用（应走 Vite import.meta.glob 分支）');
}
export function readFileSync(): never {
  throw new Error('[i18n] node:fs 在浏览器环境不可用（应走 Vite import.meta.glob 分支）');
}
export function existsSync(): never {
  throw new Error('[i18n] node:fs 在浏览器环境不可用（应走 Vite import.meta.glob 分支）');
}
export function lstatSync(): never {
  throw new Error('[i18n] node:fs 在浏览器环境不可用（应走 Vite import.meta.glob 分支）');
}
export function realpathSync(): never {
  throw new Error('[i18n] node:fs 在浏览器环境不可用（应走 Vite import.meta.glob 分支）');
}
