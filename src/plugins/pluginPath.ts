/** Validate an entry path before it is joined to a plugin package directory. */
export function assertPluginRelativePath(value: unknown, label = '插件入口路径'): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  const normalized = value.replace(/\\/g, '/').trim();
  if (
    !normalized ||
    normalized.includes('\u0000') ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:(?:$|\/)/.test(normalized)
  ) {
    throw new Error(`${label} 必须是插件包内的相对路径：${value}`);
  }
  const parts = normalized.split('/');
  if (
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        part.includes(':') ||
        part.endsWith('.') ||
        part.endsWith(' ') ||
        /[<>"|?*]/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part),
    )
  ) {
    throw new Error(`${label} 包含非法路径段：${value}`);
  }
  return parts.join('/');
}
