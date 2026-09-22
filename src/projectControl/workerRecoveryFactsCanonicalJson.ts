import { compareUtf8 } from './workerRecoveryFactsRules';

export function canonicalizeJsonValue(value: unknown, inArray = false): string {
  if (value === undefined) {
    if (inArray) throw new Error('canonical facts 不允许 array 中出现 undefined');
    return '';
  }
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical facts 只允许 safe integer 数字');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeJsonValue(item, true)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareUtf8(left, right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeJsonValue(item)}`).join(',')}}`;
  }
  throw new Error(`canonical facts 类型不支持：${typeof value}`);
}
