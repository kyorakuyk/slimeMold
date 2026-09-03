/** 浏览器端 node:path shim（仅 vite build 用），见 node-fs.ts 说明。 */
function normalize(parts: string[]): string {
  const joined = parts.join('/').replace(/\\/g, '/');
  const unc = joined.startsWith('//');
  const drive = /^[A-Za-z]:\//.test(joined);
  const absolute = joined.startsWith('/') || drive;
  const out: string[] = [];
  for (const segment of joined.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..' && !/^[A-Za-z]:$/.test(out[out.length - 1])) out.pop();
      else if (!absolute) out.push('..');
    } else {
      out.push(segment);
    }
  }
  let result = out.join('/');
  if (absolute && !drive) result = '/' + result;
  if (unc) result = '/' + result;
  return result || (absolute ? '/' : '.');
}
export function join(...parts: string[]): string {
  return normalize(parts);
}
export function resolve(...parts: string[]): string {
  return normalize(parts);
}
export function dirname(p: string): string {
  const normalized = normalize([p]);
  const i = normalized.lastIndexOf('/');
  return i > 0 ? normalized.slice(0, i) : (normalized.startsWith('/') ? '/' : '.');
}
