import type { DomainEvent } from '../domain/contracts';
import type { EventStoreAdapter, EventStoreLock } from '../domain/eventStore';
import type { WorkerRunQueueState } from '../domain/workerQueue';

export const WORKER_RECOVERY_DECISION_RELATIVE_PATH = '.slimemold/runs/recovery-decisions.json';
export const WORKER_RECOVERY_DECISION_LOCK_RELATIVE_PATH = '.slimemold/runs/recovery-decisions.json.lock';

export type WorkerRecoveryDecisionAction = 'retry' | 'skip' | 'inspect';
type WorkerRecoveryDecisionStatus = 'admitted' | 'committed';

export interface WorkerRecoveryDecisionCandidate {
  state: WorkerRunQueueState;
  events: DomainEvent[];
}

export interface WorkerRecoveryDecisionInput {
  projectId: string;
  runId: string;
  requestIdentity: string;
  action: WorkerRecoveryDecisionAction;
  semanticPayloadVersion: 1;
  decisionId: string;
  factsFingerprint: string;
  candidate: WorkerRecoveryDecisionCandidate;
  now: string;
}

export interface WorkerRecoveryDecisionRecord {
  schemaVersion: 1;
  projectId: string;
  runId: string;
  requestIdentity: string;
  action: WorkerRecoveryDecisionAction;
  semanticPayloadVersion: 1;
  decisionId: string;
  factsFingerprint: string;
  status: WorkerRecoveryDecisionStatus;
  candidate: WorkerRecoveryDecisionCandidate;
  admittedAt: string;
  committedAt?: string;
}

export interface WorkerRecoveryDecisionReadOptions {
  readCurrentFactsFingerprint: () => Promise<string>;
  isCandidateApplied?: (candidate: WorkerRecoveryDecisionCandidate) => Promise<boolean>;
}

export interface WorkerRecoveryDecisionAdmission {
  kind: 'admitted' | 'resume' | 'replay';
  record: WorkerRecoveryDecisionRecord;
}

export type WorkerRecoveryDecisionCasErrorCode = 'stale' | 'conflict' | 'needs-repair';

export class WorkerRecoveryDecisionCasError extends Error {
  constructor(
    public readonly code: WorkerRecoveryDecisionCasErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerRecoveryDecisionCasError';
  }
}

interface DecisionJournal {
  schemaVersion: 1;
  entries: WorkerRecoveryDecisionRecord[];
}

interface ParsedDecisionJournal {
  status: 'empty' | 'ok' | 'needs-repair';
  journal: DecisionJournal;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 无效`);
  return value.trim();
}

function requiredIsoText(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (Number.isNaN(Date.parse(text))) throw new Error(`${field} 不是有效时间`);
  return text;
}

function cloneCandidate(candidate: WorkerRecoveryDecisionCandidate): WorkerRecoveryDecisionCandidate {
  return JSON.parse(JSON.stringify(candidate)) as WorkerRecoveryDecisionCandidate;
}

function validateCandidate(value: unknown): WorkerRecoveryDecisionCandidate {
  if (!isRecord(value)) throw new Error('decision candidate 必须是对象');
  if (!isRecord(value.state)) throw new Error('decision candidate.state 必须是对象');
  if (!Array.isArray(value.events)) throw new Error('decision candidate.events 必须是数组');
  const events = value.events.map((event) => {
    if (!isRecord(event)) throw new Error('decision candidate event 必须是对象');
    requiredText(event.eventId, 'decision eventId');
    requiredText(event.streamId, 'decision streamId');
    requiredText(event.eventType, 'decision eventType');
    return event as unknown as DomainEvent;
  });
  return {
    state: value.state as unknown as WorkerRunQueueState,
    events,
  };
}

function validateRecord(value: unknown): WorkerRecoveryDecisionRecord {
  if (!isRecord(value)) throw new Error('recovery decision record 必须是对象');
  if (value.schemaVersion !== 1) throw new Error('recovery decision schemaVersion 无效');
  const action = value.action;
  if (action !== 'retry' && action !== 'skip' && action !== 'inspect') {
    throw new Error('recovery decision action 无效');
  }
  if (value.semanticPayloadVersion !== 1) throw new Error('recovery decision semanticPayloadVersion 无效');
  const status = value.status;
  if (status !== 'admitted' && status !== 'committed') throw new Error('recovery decision status 无效');
  const committedAt = value.committedAt === undefined
    ? undefined
    : requiredIsoText(value.committedAt, 'recovery decision committedAt');
  if (status === 'committed' && !committedAt) throw new Error('committed decision 缺少 committedAt');
  return {
    schemaVersion: 1,
    projectId: requiredText(value.projectId, 'recovery decision projectId'),
    runId: requiredText(value.runId, 'recovery decision runId'),
    requestIdentity: requiredText(value.requestIdentity, 'recovery decision requestIdentity'),
    action,
    semanticPayloadVersion: 1,
    decisionId: requiredText(value.decisionId, 'recovery decision decisionId'),
    factsFingerprint: requiredText(value.factsFingerprint, 'recovery decision factsFingerprint'),
    status,
    candidate: validateCandidate(value.candidate),
    admittedAt: requiredIsoText(value.admittedAt, 'recovery decision admittedAt'),
    ...(committedAt ? { committedAt } : {}),
  };
}

function parseJournal(text: string | null | undefined): ParsedDecisionJournal {
  if (!text || !text.trim()) return { status: 'empty', journal: { schemaVersion: 1, entries: [] } };
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
      throw new Error('recovery decision journal schema 无效');
    }
    const entries: WorkerRecoveryDecisionRecord[] = [];
    for (const item of value.entries) {
      const record = validateRecord(item);
      if (entries.some((existing) => existing.requestIdentity === record.requestIdentity)) {
        throw new Error(`recovery decision requestIdentity 重复：${record.requestIdentity}`);
      }
      entries.push(record);
    }
    return { status: 'ok', journal: { schemaVersion: 1, entries } };
  } catch (error) {
    return {
      status: 'needs-repair',
      journal: { schemaVersion: 1, entries: [] },
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function serializeJournal(journal: DecisionJournal): string {
  return JSON.stringify(journal);
}

function sameIdentity(record: WorkerRecoveryDecisionRecord, input: WorkerRecoveryDecisionInput): boolean {
  return record.projectId === input.projectId
    && record.runId === input.runId
    && record.requestIdentity === input.requestIdentity
    && record.action === input.action
    && record.semanticPayloadVersion === input.semanticPayloadVersion
    && record.decisionId === input.decisionId
    && record.factsFingerprint === input.factsFingerprint;
}

export class WorkerRecoveryDecisionPersistence {
  public readonly path: string;
  private readonly lockPath: string;

  constructor(
    private readonly adapter: EventStoreAdapter,
    root: string,
  ) {
    const normalizedRoot = root.replace(/[\\/]+$/, '');
    this.path = `${normalizedRoot}/${WORKER_RECOVERY_DECISION_RELATIVE_PATH}`;
    this.lockPath = `${normalizedRoot}/${WORKER_RECOVERY_DECISION_LOCK_RELATIVE_PATH}`;
  }

  async read(): Promise<ParsedDecisionJournal> {
    return parseJournal(await this.adapter.readText(this.path));
  }

  private async persistAndReadBack(journal: DecisionJournal): Promise<DecisionJournal> {
    const serialized = serializeJournal(journal);
    await this.adapter.writeTextAtomic(this.path, serialized);
    const parsed = parseJournal(await this.adapter.readText(this.path));
    if (parsed.status !== 'ok' || serializeJournal(parsed.journal) !== serialized) {
      throw new WorkerRecoveryDecisionCasError(
        'needs-repair',
        `recovery decision 写入后 read-back 不一致：${this.path}`,
      );
    }
    return parsed.journal;
  }

  async admit(
    input: WorkerRecoveryDecisionInput,
    options: WorkerRecoveryDecisionReadOptions,
  ): Promise<WorkerRecoveryDecisionAdmission> {
    const lock: EventStoreLock = await this.adapter.acquireLock(this.lockPath);
    try {
      const parsed = parseJournal(await this.adapter.readText(this.path));
      if (parsed.status === 'needs-repair') {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery decision journal 需要修复：${parsed.reason ?? '未知格式错误'}`,
        );
      }
      const semanticConflict = parsed.journal.entries.find((record) => record.projectId === input.projectId
        && record.runId === input.runId
        && record.factsFingerprint === input.factsFingerprint
        && record.action === input.action
        && record.semanticPayloadVersion === input.semanticPayloadVersion
        && record.requestIdentity !== input.requestIdentity);
      if (semanticConflict) {
        throw new WorkerRecoveryDecisionCasError(
          'conflict',
          `recovery facts/action 已绑定其它 requestIdentity：${semanticConflict.requestIdentity}`,
        );
      }
      const existing = parsed.journal.entries.find((record) => record.requestIdentity === input.requestIdentity);
      if (existing) {
        if (!sameIdentity(existing, input)) {
          throw new WorkerRecoveryDecisionCasError(
            'conflict',
            `recovery requestIdentity 已绑定其它 decision：${input.requestIdentity}`,
          );
        }
        if (existing.status === 'committed') return { kind: 'replay', record: existing };
        const currentFingerprint = await options.readCurrentFactsFingerprint();
        if (currentFingerprint !== existing.factsFingerprint) {
          const applied = options.isCandidateApplied
            ? await options.isCandidateApplied(existing.candidate)
            : false;
          if (!applied) {
            throw new WorkerRecoveryDecisionCasError(
              'needs-repair',
              `recovery decision 已 admitted 但当前 facts 已漂移：${input.requestIdentity}`,
            );
          }
        }
        return { kind: 'resume', record: existing };
      }

      const currentFingerprint = await options.readCurrentFactsFingerprint();
      if (currentFingerprint !== input.factsFingerprint) {
        throw new WorkerRecoveryDecisionCasError(
          'stale',
          `recovery decision facts 已过期：${input.requestIdentity}`,
        );
      }
      const record: WorkerRecoveryDecisionRecord = {
        schemaVersion: 1,
        projectId: requiredText(input.projectId, 'recovery decision projectId'),
        runId: requiredText(input.runId, 'recovery decision runId'),
        requestIdentity: requiredText(input.requestIdentity, 'recovery decision requestIdentity'),
        action: input.action,
        semanticPayloadVersion: 1,
        decisionId: requiredText(input.decisionId, 'recovery decision decisionId'),
        factsFingerprint: requiredText(input.factsFingerprint, 'recovery decision factsFingerprint'),
        status: 'admitted',
        candidate: cloneCandidate(input.candidate),
        admittedAt: requiredIsoText(input.now, 'recovery decision now'),
      };
      const journal = await this.persistAndReadBack({
        schemaVersion: 1,
        entries: [...parsed.journal.entries, record],
      });
      return {
        kind: 'admitted',
        record: journal.entries.find((item) => item.requestIdentity === input.requestIdentity) ?? record,
      };
    } finally {
      await lock.release();
    }
  }

  async commit(input: WorkerRecoveryDecisionInput): Promise<WorkerRecoveryDecisionRecord> {
    const lock: EventStoreLock = await this.adapter.acquireLock(this.lockPath);
    try {
      const parsed = parseJournal(await this.adapter.readText(this.path));
      if (parsed.status === 'needs-repair') {
        throw new WorkerRecoveryDecisionCasError(
          'needs-repair',
          `recovery decision journal 需要修复：${parsed.reason ?? '未知格式错误'}`,
        );
      }
      const index = parsed.journal.entries.findIndex((record) => record.requestIdentity === input.requestIdentity);
      if (index < 0) {
        throw new WorkerRecoveryDecisionCasError('conflict', `recovery decision 尚未 admitted：${input.requestIdentity}`);
      }
      const existing = parsed.journal.entries[index];
      if (!sameIdentity(existing, input)) {
        throw new WorkerRecoveryDecisionCasError('conflict', `recovery decision commit identity 冲突：${input.requestIdentity}`);
      }
      if (existing.status === 'committed') return existing;
      const committed: WorkerRecoveryDecisionRecord = {
        ...existing,
        status: 'committed',
        committedAt: requiredIsoText(input.now, 'recovery decision commit time'),
      };
      const entries = [...parsed.journal.entries];
      entries[index] = committed;
      const journal = await this.persistAndReadBack({ schemaVersion: 1, entries });
      return journal.entries[index];
    } finally {
      await lock.release();
    }
  }
}
