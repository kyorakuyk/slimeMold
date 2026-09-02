/** Validate user/plugin-provided paths before they reach the sandbox filesystem API. */
export function assertSandboxRelativePath(value: string, label = '沙箱路径'): string {
  const normalized = value.replace(/\\/g, '/').trim();
  if (
    !normalized ||
    normalized.includes('\u0000') ||
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    /^[A-Za-z]:($|\/)/.test(normalized)
  ) {
    throw new Error(`${label} 必须是沙箱内的相对路径：${value}`);
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
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part) ||
        part.includes('\u0000'),
    )
  ) {
    throw new Error(`${label}包含非法路径段：${value}`);
  }
  return parts.join('/');
}

/** Logical node/lane ids may contain punctuation, but never path separators. */
export function assertSandboxIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('\u0000') ||
    normalized.includes('/') ||
    normalized.includes('\\')
  ) {
    throw new Error(`${label}不能包含路径分隔符：${value}`);
  }
  return normalized;
}

/** Encode a logical id before using it as a cross-platform filesystem segment. */
export function encodeSandboxIdentifier(value: string, label: string): string {
  const normalized = assertSandboxIdentifier(value, label);
  return `id-${Array.from(normalized)
    .map((char) => (char.codePointAt(0) ?? 0).toString(16).padStart(6, '0'))
    .join('-')}`;
}

/** Only host-declared upstream lanes may be read or committed by a node. */
export function assertAllowedSandboxLane(
  laneId: string,
  allowedLaneIds: ReadonlySet<string>,
): string {
  const normalized = assertSandboxIdentifier(laneId, '沙箱车道 id');
  if (!allowedLaneIds.has(normalized)) {
    throw new Error(`沙箱车道未获宿主授权：${laneId}`);
  }
  return normalized;
}
