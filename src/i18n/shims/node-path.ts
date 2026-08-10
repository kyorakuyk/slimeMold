/** 浏览器端 node:path shim（仅 vite build 用），见 node-fs.ts 说明。 */
export function join(...parts: string[]): string {
  return parts.join('/');
}
export function resolve(...parts: string[]): string {
  return parts.join('/');
}
export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '.';
}
