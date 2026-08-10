/** 浏览器端 node:url shim（仅 vite build 用），见 node-fs.ts 说明。 */
export function fileURLToPath(url: string): string {
  return decodeURIComponent(url.replace(/^file:\/\//, '').replace(/\//g, '/'));
}
