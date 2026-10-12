import type { OrchestrationStatus } from '../types/orchestration';

/** Presentation tokens shared by the list and detail views. */
export const statusCls: Record<string, string> = {
  draft: 'text-ink-faint',
  'awaiting-confirm': 'text-warn',
  ready: 'text-accent',
  running: 'text-accent',
  paused: 'text-warn',
  done: 'text-ok',
  cancelled: 'text-ink-faint',
  failed: 'text-err',
};

export const logStatusCls: Record<string, string> = {
  pending: 'text-ink-faint',
  running: 'text-accent',
  success: 'text-ok',
  failed: 'text-err',
  skipped: 'text-ink-faint',
  cancelled: 'text-warn',
};

export const workerStatusCls: Record<string, string> = {
  queued: 'text-ink-faint',
  running: 'text-accent',
  succeeded: 'text-ok',
  failed: 'text-err',
  partial: 'text-warn',
  blocked: 'text-warn',
  cancelled: 'text-ink-faint',
};

export const roleLabel: Record<string, string> = {
  builder: 'builder',
  constructor: 'constructor',
  ops: 'ops',
};

export const BINDABLE_STATUSES: ReadonlySet<OrchestrationStatus> = new Set([
  'awaiting-confirm',
  'ready',
]);
