import type { AcceptanceRecord } from '../dev/session';
import type { EvidenceKind, EvidenceRecord, EvidenceStatus } from '../dev/evidence';

export type EvidenceIndexEntryKind = EvidenceKind | 'acceptance';

export interface EvidenceIndexEntry {
  projectId: string;
  id: string;
  kind: EvidenceIndexEntryKind;
  status: EvidenceStatus;
  orchestrationId: string;
  stageId: string;
  runId?: string;
  taskId?: string;
  taskExecutionId?: string;
  attemptId?: string;
  terms: readonly string[];
  createdAt: string;
  sourceVersion: number;
}

export interface EvidenceIndex {
  projectId: string;
  sourceVersion: number;
  entries: readonly EvidenceIndexEntry[];
}

export interface BuildEvidenceIndexInput {
  projectId: string;
  sourceVersion: number;
  evidence: readonly EvidenceRecord[];
  acceptances: readonly AcceptanceRecord[];
}

export interface EvidenceIndexQuery {
  projectId?: string;
  exactIds?: readonly string[];
  kind?: EvidenceIndexEntryKind;
  status?: EvidenceStatus;
  orchestrationId?: string;
  stageId?: string;
  runId?: string;
  taskId?: string;
  taskExecutionId?: string;
  attemptId?: string;
  keywords?: readonly string[];
  limit: number;
}

export type EvidenceQueryStatus = 'ok' | 'empty' | 'truncated' | 'out-of-scope' | 'not-found';

export interface EvidenceQueryResult {
  status: EvidenceQueryStatus;
  entries: readonly EvidenceIndexEntry[];
  matchedCount: number;
  sourceVersion: number;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function requiredPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} 必须是大于 0 的安全整数`);
  return value;
}

function termsOf(values: readonly (string | undefined)[]): string[] {
  const terms = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const term of value.toLocaleLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
      if (term) terms.add(term);
    }
  }
  return [...terms];
}

function baseEntry(input: {
  projectId: string;
  id: string;
  kind: EvidenceIndexEntryKind;
  status: EvidenceStatus;
  orchestrationId: string;
  stageId: string;
  runId?: string;
  taskId?: string;
  taskExecutionId?: string;
  attemptId?: string;
  terms: readonly string[];
  createdAt: string;
  sourceVersion: number;
}): EvidenceIndexEntry {
  return {
    projectId: requiredText(input.projectId, 'projectId'),
    id: requiredText(input.id, 'evidence id'),
    kind: input.kind,
    status: input.status,
    orchestrationId: requiredText(input.orchestrationId, 'orchestrationId'),
    stageId: requiredText(input.stageId, 'stageId'),
    ...(input.runId !== undefined ? { runId: requiredText(input.runId, 'runId') } : {}),
    ...(input.taskId !== undefined ? { taskId: requiredText(input.taskId, 'taskId') } : {}),
    ...(input.taskExecutionId !== undefined
      ? { taskExecutionId: requiredText(input.taskExecutionId, 'taskExecutionId') }
      : {}),
    ...(input.attemptId !== undefined ? { attemptId: requiredText(input.attemptId, 'attemptId') } : {}),
    terms: [...input.terms],
    createdAt: requiredText(input.createdAt, 'createdAt'),
    sourceVersion: requiredPositiveInteger(input.sourceVersion, 'sourceVersion'),
  };
}

export function buildEvidenceIndex(input: BuildEvidenceIndexInput): EvidenceIndex {
  const projectId = requiredText(input.projectId, 'projectId');
  const sourceVersion = requiredPositiveInteger(input.sourceVersion, 'sourceVersion');
  const entries: EvidenceIndexEntry[] = [];
  const ids = new Set<string>();

  for (const record of input.evidence) {
    if (ids.has(record.id)) throw new Error(`Evidence index id 重复：${record.id}`);
    ids.add(record.id);
    entries.push(baseEntry({
      projectId,
      id: record.id,
      kind: record.kind,
      status: record.status,
      orchestrationId: record.orchestrationId,
      stageId: record.stageId,
      runId: record.runId,
      taskId: record.taskId,
      taskExecutionId: record.taskExecutionId,
      attemptId: record.attemptId,
      terms: termsOf([record.id, record.kind, record.status, record.stageId, record.command, record.summary]),
      createdAt: record.createdAt,
      sourceVersion,
    }));
  }

  for (const record of input.acceptances) {
    if (ids.has(record.acceptanceId)) throw new Error(`Evidence index id 重复：${record.acceptanceId}`);
    ids.add(record.acceptanceId);
    entries.push(baseEntry({
      projectId,
      id: record.acceptanceId,
      kind: 'acceptance',
      status: record.passed ? 'passed' : 'failed',
      orchestrationId: record.orchestrationId,
      stageId: record.stageId,
      runId: record.runId,
      taskId: record.taskId,
      taskExecutionId: record.taskExecutionId,
      attemptId: record.attemptId,
      terms: termsOf([
        record.acceptanceId,
        'acceptance',
        record.stageId,
        record.passed ? 'passed' : 'failed',
        ...record.failedChecks,
      ]),
      createdAt: record.at,
      sourceVersion,
    }));
  }

  return { projectId, sourceVersion, entries };
}

function matchesKeywords(entry: EvidenceIndexEntry, keywords: readonly string[]): boolean {
  return keywords.every((keyword) => {
    const normalized = requiredText(keyword, 'keyword').toLocaleLowerCase();
    return entry.terms.some((term) => term.includes(normalized));
  });
}

export function queryEvidenceIndex(
  index: EvidenceIndex,
  query: EvidenceIndexQuery,
): EvidenceQueryResult {
  const limit = requiredPositiveInteger(query.limit, 'limit');
  if (query.projectId !== undefined && query.projectId !== index.projectId) {
    return {
      status: 'out-of-scope',
      entries: [],
      matchedCount: 0,
      sourceVersion: index.sourceVersion,
    };
  }

  const exactIds = query.exactIds?.map((id) => requiredText(id, 'exact id'));
  let candidates = [...index.entries];
  if (exactIds !== undefined) {
    const exactSet = new Set(exactIds);
    candidates = candidates.filter((entry) => exactSet.has(entry.id));
  }
  if (query.kind !== undefined) candidates = candidates.filter((entry) => entry.kind === query.kind);
  if (query.status !== undefined) candidates = candidates.filter((entry) => entry.status === query.status);
  if (query.orchestrationId !== undefined) {
    const value = requiredText(query.orchestrationId, 'orchestrationId');
    candidates = candidates.filter((entry) => entry.orchestrationId === value);
  }
  if (query.stageId !== undefined) {
    const value = requiredText(query.stageId, 'stageId');
    candidates = candidates.filter((entry) => entry.stageId === value);
  }
  if (query.runId !== undefined) {
    const value = requiredText(query.runId, 'runId');
    candidates = candidates.filter((entry) => entry.runId === value);
  }
  if (query.taskId !== undefined) {
    const value = requiredText(query.taskId, 'taskId');
    candidates = candidates.filter((entry) => entry.taskId === value);
  }
  if (query.taskExecutionId !== undefined) {
    const value = requiredText(query.taskExecutionId, 'taskExecutionId');
    candidates = candidates.filter((entry) => entry.taskExecutionId === value);
  }
  if (query.attemptId !== undefined) {
    const value = requiredText(query.attemptId, 'attemptId');
    candidates = candidates.filter((entry) => entry.attemptId === value);
  }
  if (query.keywords !== undefined) candidates = candidates.filter((entry) => matchesKeywords(entry, query.keywords ?? []));

  const matchedCount = candidates.length;
  const entries = candidates.slice(0, limit);
  const status: EvidenceQueryStatus = matchedCount === 0
    ? (exactIds !== undefined ? 'not-found' : 'empty')
    : matchedCount > limit
      ? 'truncated'
      : 'ok';
  return { status, entries, matchedCount, sourceVersion: index.sourceVersion };
}
