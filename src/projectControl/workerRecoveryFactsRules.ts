import type { WorkerQueueTask } from '../domain/workerQueue';

export function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}

export function assertKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) throw new Error(`${field} 包含未知字段：${key}`);
}

export function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  if (normalized !== value) throw new Error(`${field} 必须使用 canonical 形式，不能包含首尾空白`);
  return value;
}

export function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} 必须是 string`);
  return value;
}

export function safeInteger(value: number, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${field} 必须是合法 safe integer：${value}`);
  return value;
}

export function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

export function canonicalPath(value: string, field: string): string {
  const text = requiredText(value, field);
  if (text.includes('\\') || text.split('/').some((segment, index) => (index > 0 && segment === '') || segment === '.' || segment === '..')) {
    throw new Error(`${field} 不是 canonical path`);
  }
  if (text.endsWith('/') && !/^[A-Za-z]:\/$/.test(text) && !text.startsWith('//')) throw new Error(`${field} 不能以 / 结尾`);
  return text;
}

export function comparableWorkerPath(value: string): string {
  const normalized = canonicalPath(value, 'path');
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized;
}

export function canonicalRef(value: string, field: string): string {
  const text = requiredText(value, field);
  const components = text.split('/');
  if (!/^[A-Za-z0-9._/-]+$/.test(text)
    || text.includes('..')
    || text.includes('@{')
    || text.startsWith('/')
    || text.endsWith('/')
    || components.some((component) => !component || component.startsWith('.') || component.endsWith('.') || component.endsWith('.lock'))) {
    throw new Error(`${field} 不是 canonical Git ref`);
  }
  return text;
}

export function canonicalTimestamp(value: string, field: string): string {
  const text = requiredText(value, field);
  if (new Date(text).toISOString() !== text) throw new Error(`${field} 不是 canonical timestamp`);
  return text;
}

export function canonicalRevision(value: string, field: string): string {
  const text = requiredText(value, field);
  if (!/^[0-9a-f]{40}$/.test(text)) throw new Error(`${field} 不是 canonical revision`);
  return text;
}

export function uniqueStringsPreserveOrder(values: readonly string[], field: string): string[] {
  const normalized = values.map((value) => requiredText(value, field));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field} 不允许重复 reference`);
  return [...normalized];
}

export function sortedStrings(values: readonly string[]): string[] {
  const normalized = values.map((value) => requiredText(value, 'string'));
  if (new Set(normalized).size !== normalized.length) throw new Error('canonical facts 不允许重复 reference');
  return [...normalized].sort(compareUtf8);
}

export function assertTaskAttemptInvariant(status: WorkerQueueTask['status'], attempt: number, field: string): void {
  if (['running', 'waiting-feedback', 'succeeded', 'failed'].includes(status) && attempt < 1) {
    throw new Error(`${field} 的 attempt 无效：${attempt}`);
  }
}
